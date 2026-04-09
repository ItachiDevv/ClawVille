/**
 * Autonomous avatar behavior — when a user is idle for >60s, their avatar
 * starts moving around the map on its own, visiting buildings and
 * earning ClawTokens.
 */

import { findPath, type PathNode } from './pathfinding';
import { NPC_BUILDING_CENTERS, BUILDING_ACTIVITIES, ACTIVITY_EMOJIS, type NpcActivity } from '@legacyapp/shared';
import { db, avatars, activityLog } from '@legacyapp/database';
import { sql } from 'drizzle-orm';
import Anthropic from '@anthropic-ai/sdk';

const MAP_WIDTH = 1280;
const MAP_HEIGHT = 800;
const IDLE_THRESHOLD_MS = 60_000; // 60s of no user input
const MAX_TOKENS_PER_SESSION = 10;
const VISIT_CHAT_COOLDOWN_MS = 30_000; // 1 Haiku call per 30s

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface AutonomousPetState {
  avatarId: string;
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

  registerPet(avatarId: string, userId: string, petData: {
    name: string; species: string; color: string; archetype: string;
    positionX: number; positionY: number;
  }) {
    if (this.activePets.has(userId)) return;

    this.activePets.set(userId, {
      avatarId, userId,
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
    const avatar = this.activePets.get(userId);
    if (!avatar) return;

    avatar.lastUserInputAt = Date.now();

    // If avatar was autonomous, snap back to user control
    if (avatar.isAutonomous) {
      avatar.isAutonomous = false;
      avatar.activity = 'idle';
      avatar.activityEmoji = '';
      avatar.path = [];
      avatar.pathIndex = 0;
      avatar.destinationBuildingId = null;
      avatar.tokensEarned = 0;
      avatar.visitCount = 0;
      avatar.chatMessage = null;
    }

    // Update position from heartbeat
    if (x !== undefined && y !== undefined) {
      avatar.x = x;
      avatar.y = y;
    }
  }

  unregisterPet(userId: string) {
    this.activePets.delete(userId);
  }

  /** Returns only the fields needed for SSE broadcast (strips internal path/timing state) */
  getAutonomousAvatars(): Array<Pick<AutonomousPetState,
    'avatarId' | 'userId' | 'name' | 'species' | 'color' | 'x' | 'y' |
    'direction' | 'activity' | 'activityEmoji' | 'isAutonomous' | 'chatMessage'
  >> {
    return Array.from(this.activePets.values())
      .filter((p) => p.isAutonomous)
      .map((p) => ({
        avatarId: p.avatarId,
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

    for (const avatar of this.activePets.values()) {
      // Check if avatar should enter autonomous mode
      if (!avatar.isAutonomous) {
        if (now - avatar.lastUserInputAt >= IDLE_THRESHOLD_MS) {
          avatar.isAutonomous = true;
          avatar.activity = 'idle';
          avatar.behaviorCooldown = 5; // Start planning soon
          avatar.tokensEarned = 0;
          avatar.visitCount = 0;
          avatar.maxVisitsThreshold = 3 + Math.floor(Math.random() * 3);
          console.log(`[Avatar Autonomy] ${avatar.name} entered autonomous mode`);
        }
        continue;
      }

      // Avatar is autonomous — run behavior
      this.handleActivityDurations(avatar, now);
      this.planBehavior(avatar);
      this.movePet(avatar);
    }
  }

  private handleActivityDurations(avatar: AutonomousPetState, now: number) {
    // Arrived at destination — start activity
    if (avatar.activity === 'walking' && avatar.path.length > 0 && avatar.pathIndex >= avatar.path.length) {
      if (avatar.destinationBuildingId) {
        const activities = BUILDING_ACTIVITIES[avatar.destinationBuildingId] ?? ['thinking'];
        const picked = activities[Math.floor(Math.random() * activities.length)];
        avatar.activity = picked;
        avatar.activityEmoji = ACTIVITY_EMOJIS[picked];
        avatar.activityEndsAt = now + 10000 + Math.random() * 15000; // 10-25s
        avatar.path = [];
        avatar.pathIndex = 0;
        avatar.visitCount++;

        // Award token (max per session)
        if (avatar.tokensEarned < MAX_TOKENS_PER_SESSION) {
          avatar.tokensEarned++;
          this.awardToken(avatar.avatarId).catch(console.error);
          this.logActivity(avatar.avatarId, 'visit', `Visited ${avatar.destinationBuildingId} and earned 1 ClawToken`, 1).catch(console.error);
        }

        // Maybe generate a chat line
        if (now - avatar.lastChatAt > VISIT_CHAT_COOLDOWN_MS) {
          this.generateVisitChat(avatar).catch(console.error);
        }
      } else {
        // No destination — likely returned home. Sleep until user takes control.
        if (avatar.visitCount >= avatar.maxVisitsThreshold) {
          avatar.activity = 'sleeping';
          avatar.activityEmoji = ACTIVITY_EMOJIS.sleeping;
          avatar.activityEndsAt = 0; // Never expires — user must take control
          avatar.path = [];
          avatar.pathIndex = 0;
          avatar.chatMessage = '*zzz...*';
        } else {
          avatar.activity = 'idle';
          avatar.activityEmoji = '';
          avatar.path = [];
          avatar.pathIndex = 0;
          avatar.behaviorCooldown = 10;
        }
      }
    }

    // Activity expired
    if (avatar.activityEndsAt > 0 && now >= avatar.activityEndsAt) {
      avatar.activity = 'idle';
      avatar.activityEmoji = '';
      avatar.activityEndsAt = 0;
      avatar.destinationBuildingId = null;
      avatar.behaviorCooldown = 5;
      avatar.chatMessage = null;
    }
  }

  private planBehavior(avatar: AutonomousPetState) {
    if (avatar.activity !== 'idle') return;

    avatar.behaviorCooldown--;
    if (avatar.behaviorCooldown > 0) return;

    // After reaching visit threshold, go home and sleep
    if (avatar.visitCount >= avatar.maxVisitsThreshold) {
      // Return home
      const path = findPath(avatar.x, avatar.y, 640, 400); // default spawn point (center of 1280x800 map)
      if (path.length > 0) {
        avatar.activity = 'walking';
        avatar.path = path;
        avatar.pathIndex = 0;
        avatar.destinationBuildingId = null;
        avatar.behaviorCooldown = 200;
      }
      return;
    }

    // Pick a building to visit
    const buildingIds = Object.keys(NPC_BUILDING_CENTERS);
    const withDist = buildingIds.map((id) => {
      const c = NPC_BUILDING_CENTERS[id];
      const dx = c.x - avatar.x;
      const dy = c.y - avatar.y;
      return { id, dist: Math.sqrt(dx * dx + dy * dy) };
    }).sort((a, b) => a.dist - b.dist);

    // Pick from closer buildings
    const candidates = withDist.slice(0, 6);
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    const center = NPC_BUILDING_CENTERS[target.id];

    const offsetX = (Math.random() - 0.5) * 30;
    const offsetY = 15 + Math.random() * 15;
    const path = findPath(avatar.x, avatar.y, center.x + offsetX, center.y + offsetY);

    if (path.length > 0) {
      avatar.activity = 'walking';
      avatar.activityEmoji = '';
      avatar.destinationBuildingId = target.id;
      avatar.path = path;
      avatar.pathIndex = 0;
      avatar.behaviorCooldown = 100;
    } else {
      avatar.behaviorCooldown = 10;
    }
  }

  private movePet(avatar: AutonomousPetState) {
    if (avatar.activity !== 'walking') return;
    if (avatar.path.length === 0 || avatar.pathIndex >= avatar.path.length) return;

    const step = 10; // slightly slower than NPCs
    const wp = avatar.path[avatar.pathIndex];
    const dx = wp.x - avatar.x;
    const dy = wp.y - avatar.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 4) {
      avatar.pathIndex++;
      if (avatar.pathIndex >= avatar.path.length) avatar.direction = 'idle';
    } else {
      const s = Math.min(step, dist);
      avatar.x += (dx / dist) * s;
      avatar.y += (dy / dist) * s;
      avatar.x = Math.max(16, Math.min(MAP_WIDTH - 16, avatar.x));
      avatar.y = Math.max(16, Math.min(MAP_HEIGHT - 16, avatar.y));
      avatar.direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    }
  }

  private async logActivity(avatarId: string, activityType: string, description: string, tokensEarned = 0) {
    try {
      await db.insert(activityLog).values({
        avatarId,
        activityType,
        description,
        tokensEarned,
      });
    } catch (err) {
      console.error('[Avatar Autonomy] Failed to log activity:', err);
    }
  }

  private async awardToken(avatarId: string) {
    try {
      await db.execute(
        sql`UPDATE avatars SET neo_tokens = neo_tokens + 1 WHERE id = ${avatarId}`
      );
    } catch (err) {
      console.error('[Avatar Autonomy] Failed to award token:', err);
    }
  }

  private async generateVisitChat(avatar: AutonomousPetState) {
    if (!avatar.destinationBuildingId) return;

    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2300,
        thinking: { type: 'enabled', budget_tokens: 2048 },
        messages: [{
          role: 'user',
          content: `You are ${avatar.name}, a ${avatar.species} (${avatar.archetype} personality) visiting the ${avatar.destinationBuildingId} in the ClawVille reef. Say one short sentence about what you see or think. Be playful, under 50 characters.`,
        }],
      });

      const textBlock = response.content.find((b: any) => b.type === 'text') as { text: string } | undefined;
      const text = textBlock?.text ?? '';
      avatar.chatMessage = text.slice(0, 80).replace(/^["']|["']$/g, '').trim();
      avatar.lastChatAt = Date.now();
    } catch {
      // Non-critical — silently fail
    }
  }
}
