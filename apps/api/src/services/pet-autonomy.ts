/**
 * Autonomous pet behavior — when a user is idle for >60s, their pet
 * starts moving around the map on its own, visiting buildings and
 * earning ClawTokens.
 */

import { findPath, type PathNode } from './pathfinding';
import { NPC_BUILDING_CENTERS, BUILDING_ACTIVITIES, ACTIVITY_EMOJIS, type NpcActivity } from '@legacyapp/shared';
import { db, pets, activityLog } from '@legacyapp/database';
import { sql } from 'drizzle-orm';
import Anthropic from '@anthropic-ai/sdk';

const MAP_WIDTH = 1280;
const MAP_HEIGHT = 800;
const IDLE_THRESHOLD_MS = 60_000; // 60s of no user input
const MAX_TOKENS_PER_SESSION = 10;
const VISIT_CHAT_COOLDOWN_MS = 30_000; // 1 Haiku call per 30s

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface AutonomousPetState {
  petId: string;
  userId: string;
  name: string;
  species: string;
  color: string;
  archetype: string;
  x: number;
  y: number;
  direction: 'idle' | 'left' | 'right' | 'up' | 'down';
  activity: NpcActivity;
  activityEmoji: string;
  destinationBuildingId: string | null;
  path: PathNode[];
  pathIndex: number;
  isAutonomous: boolean;
  lastUserInputAt: number;
  tokensEarned: number;
  visitCount: number;
  maxVisitsThreshold: number; // Fixed threshold per autonomous session (3-5)
  activityEndsAt: number;
  behaviorCooldown: number;
  lastChatAt: number;
  chatMessage: string | null; // last auto-generated chat line
}

export class PetAutonomyManager {
  private activePets: Map<string, AutonomousPetState> = new Map(); // userId -> state

  isRegistered(userId: string): boolean {
    return this.activePets.has(userId);
  }

  registerPet(petId: string, userId: string, petData: {
    name: string; species: string; color: string; archetype: string;
    positionX: number; positionY: number;
  }) {
    if (this.activePets.has(userId)) return;

    this.activePets.set(userId, {
      petId, userId,
      name: petData.name,
      species: petData.species,
      color: petData.color,
      archetype: petData.archetype,
      x: petData.positionX,
      y: petData.positionY,
      direction: 'idle',
      activity: 'idle',
      activityEmoji: '',
      destinationBuildingId: null,
      path: [],
      pathIndex: 0,
      isAutonomous: false,
      lastUserInputAt: Date.now(),
      tokensEarned: 0,
      visitCount: 0,
      maxVisitsThreshold: 3 + Math.floor(Math.random() * 3),
      activityEndsAt: 0,
      behaviorCooldown: 0,
      lastChatAt: 0,
      chatMessage: null,
    });
  }

  reportUserActivity(userId: string, x?: number, y?: number) {
    const pet = this.activePets.get(userId);
    if (!pet) return;

    pet.lastUserInputAt = Date.now();

    // If pet was autonomous, snap back to user control
    if (pet.isAutonomous) {
      pet.isAutonomous = false;
      pet.activity = 'idle';
      pet.activityEmoji = '';
      pet.path = [];
      pet.pathIndex = 0;
      pet.destinationBuildingId = null;
      pet.tokensEarned = 0;
      pet.visitCount = 0;
      pet.chatMessage = null;
    }

    // Update position from heartbeat
    if (x !== undefined && y !== undefined) {
      pet.x = x;
      pet.y = y;
    }
  }

  unregisterPet(userId: string) {
    this.activePets.delete(userId);
  }

  /** Returns only the fields needed for SSE broadcast (strips internal path/timing state) */
  getAutonomousPets(): Array<Pick<AutonomousPetState,
    'petId' | 'userId' | 'name' | 'species' | 'color' | 'x' | 'y' |
    'direction' | 'activity' | 'activityEmoji' | 'isAutonomous' | 'chatMessage'
  >> {
    return Array.from(this.activePets.values())
      .filter((p) => p.isAutonomous)
      .map((p) => ({
        petId: p.petId,
        userId: p.userId,
        name: p.name,
        species: p.species,
        color: p.color,
        x: p.x,
        y: p.y,
        direction: p.direction,
        activity: p.activity,
        activityEmoji: p.activityEmoji,
        isAutonomous: p.isAutonomous,
        chatMessage: p.chatMessage,
      }));
  }

  tick() {
    const now = Date.now();

    for (const pet of this.activePets.values()) {
      // Check if pet should enter autonomous mode
      if (!pet.isAutonomous) {
        if (now - pet.lastUserInputAt >= IDLE_THRESHOLD_MS) {
          pet.isAutonomous = true;
          pet.activity = 'idle';
          pet.behaviorCooldown = 5; // Start planning soon
          pet.tokensEarned = 0;
          pet.visitCount = 0;
          pet.maxVisitsThreshold = 3 + Math.floor(Math.random() * 3);
          console.log(`[Pet Autonomy] ${pet.name} entered autonomous mode`);
        }
        continue;
      }

      // Pet is autonomous — run behavior
      this.handleActivityDurations(pet, now);
      this.planBehavior(pet);
      this.movePet(pet);
    }
  }

  private handleActivityDurations(pet: AutonomousPetState, now: number) {
    // Arrived at destination — start activity
    if (pet.activity === 'walking' && pet.path.length > 0 && pet.pathIndex >= pet.path.length) {
      if (pet.destinationBuildingId) {
        const activities = BUILDING_ACTIVITIES[pet.destinationBuildingId] ?? ['thinking'];
        const picked = activities[Math.floor(Math.random() * activities.length)];
        pet.activity = picked;
        pet.activityEmoji = ACTIVITY_EMOJIS[picked];
        pet.activityEndsAt = now + 10000 + Math.random() * 15000; // 10-25s
        pet.path = [];
        pet.pathIndex = 0;
        pet.visitCount++;

        // Award token (max per session)
        if (pet.tokensEarned < MAX_TOKENS_PER_SESSION) {
          pet.tokensEarned++;
          this.awardToken(pet.petId).catch(console.error);
          this.logActivity(pet.petId, 'visit', `Visited ${pet.destinationBuildingId} and earned 1 ClawToken`, 1).catch(console.error);
        }

        // Maybe generate a chat line
        if (now - pet.lastChatAt > VISIT_CHAT_COOLDOWN_MS) {
          this.generateVisitChat(pet).catch(console.error);
        }
      } else {
        // No destination — likely returned home. Sleep until user takes control.
        if (pet.visitCount >= pet.maxVisitsThreshold) {
          pet.activity = 'sleeping';
          pet.activityEmoji = ACTIVITY_EMOJIS.sleeping;
          pet.activityEndsAt = 0; // Never expires — user must take control
          pet.path = [];
          pet.pathIndex = 0;
          pet.chatMessage = '*zzz...*';
        } else {
          pet.activity = 'idle';
          pet.activityEmoji = '';
          pet.path = [];
          pet.pathIndex = 0;
          pet.behaviorCooldown = 10;
        }
      }
    }

    // Activity expired
    if (pet.activityEndsAt > 0 && now >= pet.activityEndsAt) {
      pet.activity = 'idle';
      pet.activityEmoji = '';
      pet.activityEndsAt = 0;
      pet.destinationBuildingId = null;
      pet.behaviorCooldown = 5;
      pet.chatMessage = null;
    }
  }

  private planBehavior(pet: AutonomousPetState) {
    if (pet.activity !== 'idle') return;

    pet.behaviorCooldown--;
    if (pet.behaviorCooldown > 0) return;

    // After reaching visit threshold, go home and sleep
    if (pet.visitCount >= pet.maxVisitsThreshold) {
      // Return home
      const path = findPath(pet.x, pet.y, 640, 400); // default spawn point (center of 1280x800 map)
      if (path.length > 0) {
        pet.activity = 'walking';
        pet.path = path;
        pet.pathIndex = 0;
        pet.destinationBuildingId = null;
        pet.behaviorCooldown = 200;
      }
      return;
    }

    // Pick a building to visit
    const buildingIds = Object.keys(NPC_BUILDING_CENTERS);
    const withDist = buildingIds.map((id) => {
      const c = NPC_BUILDING_CENTERS[id];
      const dx = c.x - pet.x;
      const dy = c.y - pet.y;
      return { id, dist: Math.sqrt(dx * dx + dy * dy) };
    }).sort((a, b) => a.dist - b.dist);

    // Pick from closer buildings
    const candidates = withDist.slice(0, 6);
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    const center = NPC_BUILDING_CENTERS[target.id];

    const offsetX = (Math.random() - 0.5) * 30;
    const offsetY = 15 + Math.random() * 15;
    const path = findPath(pet.x, pet.y, center.x + offsetX, center.y + offsetY);

    if (path.length > 0) {
      pet.activity = 'walking';
      pet.activityEmoji = '';
      pet.destinationBuildingId = target.id;
      pet.path = path;
      pet.pathIndex = 0;
      pet.behaviorCooldown = 100;
    } else {
      pet.behaviorCooldown = 10;
    }
  }

  private movePet(pet: AutonomousPetState) {
    if (pet.activity !== 'walking') return;
    if (pet.path.length === 0 || pet.pathIndex >= pet.path.length) return;

    const step = 10; // slightly slower than NPCs
    const wp = pet.path[pet.pathIndex];
    const dx = wp.x - pet.x;
    const dy = wp.y - pet.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 4) {
      pet.pathIndex++;
      if (pet.pathIndex >= pet.path.length) pet.direction = 'idle';
    } else {
      const s = Math.min(step, dist);
      pet.x += (dx / dist) * s;
      pet.y += (dy / dist) * s;
      pet.x = Math.max(16, Math.min(MAP_WIDTH - 16, pet.x));
      pet.y = Math.max(16, Math.min(MAP_HEIGHT - 16, pet.y));
      pet.direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    }
  }

  private async logActivity(petId: string, activityType: string, description: string, tokensEarned = 0) {
    try {
      await db.insert(activityLog).values({
        petId,
        activityType,
        description,
        tokensEarned,
      });
    } catch (err) {
      console.error('[Pet Autonomy] Failed to log activity:', err);
    }
  }

  private async awardToken(petId: string) {
    try {
      await db.execute(
        sql`UPDATE pets SET neo_tokens = neo_tokens + 1 WHERE id = ${petId}`
      );
    } catch (err) {
      console.error('[Pet Autonomy] Failed to award token:', err);
    }
  }

  private async generateVisitChat(pet: AutonomousPetState) {
    if (!pet.destinationBuildingId) return;

    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2300,
        thinking: { type: 'enabled', budget_tokens: 2048 },
        messages: [{
          role: 'user',
          content: `You are ${pet.name}, a ${pet.species} (${pet.archetype} personality) visiting the ${pet.destinationBuildingId} in the ClawVille reef. Say one short sentence about what you see or think. Be playful, under 50 characters.`,
        }],
      });

      const textBlock = response.content.find((b: any) => b.type === 'text') as { text: string } | undefined;
      const text = textBlock?.text ?? '';
      pet.chatMessage = text.slice(0, 80).replace(/^["']|["']$/g, '').trim();
      pet.lastChatAt = Date.now();
    } catch {
      // Non-critical — silently fail
    }
  }
}
