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
} from '@clawville/shared';
import { db, activityLog } from '@clawville/database';

import { findPath } from './pathfinding';
import { creditNeoTokens, debitNeoTokens } from './neo-token-ledger';

// Single source of truth — agent-runtime re-exports NpcActivity from shared,
// so these constants type-check without casting.
const VISIT_CHAT_COOLDOWN_MS = 30_000;
const IDLE_UNREGISTER_MS = 30 * 60 * 1000; // 30 min — auto-cleanup abandoned pets

export class PetSimulationBridge {
  private stateStore: PetStateStore;
  private runtime: SimulationRuntime | null = null;
  private runtimeReady = false;

  constructor() {
    this.stateStore = new PetStateStore();
  }

  /** Lazy-init the SimulationRuntime on first pet registration */
  private ensureRuntime(): void {
    if (this.runtime) return;

    this.runtime = new SimulationRuntime({
      stateStore: this.stateStore,
      buildingCenters: NPC_BUILDING_CENTERS,
      buildingActivities: BUILDING_ACTIVITIES,
      activityEmojis: ACTIVITY_EMOJIS,
      pathfind: findPath,
      dbHooks: {
        awardToken: async (petId: string) => {
          // Credit via ledger — atomic + audited (source: 'simulation')
          await creditNeoTokens({
            petId,
            amount: 1,
            reason: 'autonomous_visit',
            source: 'simulation',
          });
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
        gemini: process.env.GEMINI_API_KEY,
      },
      // Phase 3: inject services so economic actions (BUY_ITEM, LEARN_SKILL) can execute
      services: { db, creditNeoTokens, debitNeoTokens },
    });

    // Fire-and-forget startup; tick() guards on runtimeReady before touching
    // the runtime. On failure, we clear everything so the next register()
    // triggers a fresh cold-start.
    this.runtime
      .start()
      .then(() => {
        this.runtimeReady = true;
      })
      .catch((err) => {
        console.error('[PetSimBridge] SimulationRuntime start failed:', err);
        this.runtime = null;
        this.runtimeReady = false;
        // Clear state store so SSE doesn't show stale pets during a degraded state
        for (const pet of this.stateStore.all()) {
          this.stateStore.unregister(pet.userId);
        }
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
   *   1. Unregister abandoned pets (no heartbeat for IDLE_UNREGISTER_MS)
   *   2. Pure movement step if walking
   *   3. Check activity transitions (arrival / expiration)
   *   4. On arrival: dispatch PET_VISIT_BUILDING via runtime
   *   5. On idle + cooldown elapsed: plan next action via runtime LLM
   */
  tick(): void {
    if (!this.runtime || !this.runtimeReady) return;

    const now = Date.now();

    // 0. Sweep abandoned pets — prevents unbounded growth of the state store
    for (const pet of this.stateStore.all()) {
      if (now - pet.lastUserInputAt > IDLE_UNREGISTER_MS) {
        console.log(`[PetSimBridge] Unregistering abandoned pet ${pet.name} (${pet.userId})`);
        this.stateStore.unregister(pet.userId);
      }
    }

    // 1. Activate any pets that just crossed the idle threshold
    activateIdlePets(this.stateStore, now);

    for (const pet of this.stateStore.all()) {
      if (!pet.isAutonomous) continue;

      // 1. Move
      stepMovement(pet);

      // 2. Check transitions
      const transition = handleActivityTransition(pet, now, ACTIVITY_EMOJIS);

      if (transition === 'arrived') {
        // Clear arrival state IMMEDIATELY so the next tick doesn't see the
        // same "arrived" condition and fire PET_VISIT_BUILDING twice while
        // the first dispatch is still in flight (fire-and-forget).
        const destinationId = pet.destinationBuildingId;
        pet.path = [];
        pet.pathIndex = 0;

        // Dispatch PET_VISIT_BUILDING (the action will set activity to a
        // building-themed one and pick an activityEndsAt timer)
        this.runtime
          .dispatchAction({ action: 'PET_VISIT_BUILDING', userId: pet.userId })
          .catch((err) => console.error('[PetSimBridge] PET_VISIT_BUILDING dispatch failed:', err));

        // Generate a visit chat line (throttled) via runtime
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
        // Clear arrival state before dispatch (same reason as above)
        pet.path = [];
        pet.pathIndex = 0;
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
