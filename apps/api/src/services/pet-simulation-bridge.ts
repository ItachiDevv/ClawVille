/**
 * Pet Simulation Bridge (Phase 2)
 *
 * Replaces the old hand-rolled PetAutonomyManager with a thin adapter
 * over the v2 SimulationRuntime + PetStateStore in @clawville/agent-runtime.
 *
 * Responsibilities:
 *   1. Own the PetStateStore singleton
 *   2. Own a single SimulationRuntime instance (Option B: one runtime, all pets)
 *   3. Expose register()/unregister()/reportUserActivity() for API routes
 *   4. Run the 500ms tick from npc-simulation: movement + activity transitions
 *      + LLM planning at decision points
 *   5. Route PET_VISIT_BUILDING arrivals through the runtime so the
 *      action's DB writes + runtime-driven visit chat fire
 *   6. Provide getAutonomousPets() for the SSE snapshot
 *
 * Lazy startup: the SimulationRuntime is only initialized on first pet
 * registration to avoid paying the ElizaRuntime startup cost when no
 * users are logged in.
 */

import {
  PetStateStore,
  SimulationRuntime,
  activateIdlePets,
  stepMovement,
  handleActivityTransition,
  type PetRegistrationInput,
  type PetSimBroadcast,
} from '@clawville/agent-runtime';

import {
  NPC_BUILDING_CENTERS,
  BUILDING_ACTIVITIES,
  ACTIVITY_EMOJIS,
  type NpcActivity,
} from '@clawville/shared';
import { db, pets, activityLog } from '@clawville/database';
import { sql } from 'drizzle-orm';

import { findPath } from './pathfinding';

/**
 * Convert shared's NpcActivity union into the ActivityEmojis map shape
 * expected by SimulationRuntime. Both types are structurally identical
 * — we just re-key to satisfy the strict agent-runtime type (which
 * mirrors the same union locally to avoid cross-package runtime deps).
 */
const ACTIVITY_EMOJIS_TYPED: Record<NpcActivity, string> = ACTIVITY_EMOJIS;
const BUILDING_ACTIVITIES_TYPED: Record<string, NpcActivity[]> = BUILDING_ACTIVITIES;

const VISIT_CHAT_COOLDOWN_MS = 30_000;

export class PetSimulationBridge {
  private stateStore: PetStateStore;
  private runtime: SimulationRuntime | null = null;
  private runtimeStartPromise: Promise<void> | null = null;

  constructor() {
    this.stateStore = new PetStateStore();
  }

  /** Lazy-init the SimulationRuntime on first pet registration */
  private ensureRuntime(): void {
    if (this.runtime) return;

    this.runtime = new SimulationRuntime({
      stateStore: this.stateStore,
      buildingCenters: NPC_BUILDING_CENTERS,
      buildingActivities: BUILDING_ACTIVITIES_TYPED as any,
      activityEmojis: ACTIVITY_EMOJIS_TYPED as any,
      pathfind: findPath,
      dbHooks: {
        awardToken: async (petId: string) => {
          await db.execute(sql`UPDATE pets SET neo_tokens = neo_tokens + 1 WHERE id = ${petId}`);
        },
        logActivity: async (
          petId: string,
          activityType: string,
          description: string,
          tokensEarned: number,
        ) => {
          await db.insert(activityLog).values({
            petId,
            activityType,
            description,
            tokensEarned,
          });
        },
      },
      databaseUrl: process.env.DATABASE_URL,
      apiKeys: {
        anthropic: process.env.ANTHROPIC_API_KEY,
        openai: process.env.OPENAI_API_KEY,
      },
    });

    // Fire-and-forget startup; tick() will wait for this via runtimeStartPromise
    this.runtimeStartPromise = this.runtime.start().catch((err) => {
      console.error('[PetSimBridge] SimulationRuntime start failed:', err);
      this.runtime = null;
      this.runtimeStartPromise = null;
    });
  }

  isRegistered(userId: string): boolean {
    return this.stateStore.has(userId);
  }

  register(input: PetRegistrationInput): void {
    this.ensureRuntime();
    this.stateStore.register(input);
  }

  unregister(userId: string): void {
    this.stateStore.unregister(userId);
  }

  reportUserActivity(userId: string, x?: number, y?: number): void {
    this.stateStore.reportUserActivity(userId, x, y);
  }

  getAutonomousPets(): PetSimBroadcast[] {
    return this.stateStore.getBroadcast();
  }

  /**
   * Called every 500ms from npc-simulation.tick().
   *
   * Per-pet flow:
   *   1. Pure movement step if walking
   *   2. Check activity transitions (arrival / expiration)
   *   3. On arrival: dispatch PET_VISIT_BUILDING via runtime
   *   4. On idle + cooldown elapsed: plan next action via runtime LLM
   */
  tick(): void {
    if (!this.runtime) return;

    const now = Date.now();

    // Activate any pets that just crossed the idle threshold
    activateIdlePets(this.stateStore, now);

    for (const pet of this.stateStore.all()) {
      if (!pet.isAutonomous) continue;

      // 1. Move
      stepMovement(pet);

      // 2. Check transitions
      const transition = handleActivityTransition(pet, now, ACTIVITY_EMOJIS_TYPED as any);

      if (transition === 'arrived') {
        // Arrived at destination building — dispatch PET_VISIT_BUILDING
        this.runtime
          .dispatchAction({ action: 'PET_VISIT_BUILDING', userId: pet.userId })
          .catch((err) => console.error('[PetSimBridge] PET_VISIT_BUILDING dispatch failed:', err));

        // Generate a visit chat line (throttled) via runtime
        const destinationId = pet.destinationBuildingId;
        if (destinationId && now - pet.lastChatAt > VISIT_CHAT_COOLDOWN_MS) {
          pet.lastChatAt = now;
          this.runtime
            .generatePetChat(pet.userId, destinationId)
            .then((text) => {
              if (text) {
                const current = this.stateStore.get(pet.userId);
                if (current) current.chatMessage = text;
              }
            })
            .catch((err) => console.error('[PetSimBridge] generatePetChat failed:', err));
        }
        continue;
      }

      if (transition === 'home') {
        // Arrived home — go to sleep
        this.runtime
          .dispatchAction({ action: 'PET_SLEEP', userId: pet.userId })
          .catch((err) => console.error('[PetSimBridge] PET_SLEEP dispatch failed:', err));
        continue;
      }

      // 3. Plan next action when idle + cooldown elapsed
      if (pet.activity === 'idle') {
        pet.behaviorCooldown--;
        if (pet.behaviorCooldown <= 0) {
          pet.behaviorCooldown = 100; // prevent re-planning on next tick while LLM runs
          this.runtime
            .planPetNextAction(pet.userId)
            .catch((err) => console.error('[PetSimBridge] planPetNextAction failed:', err));
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.runtime) {
      await this.runtime.stop().catch(() => {});
      this.runtime = null;
    }
  }
}
