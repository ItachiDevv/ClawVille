/**
 * Avatar Simulation Bridge (Phase 2)
 *
 * Replaces the old hand-rolled AvatarAutonomyManager with a thin adapter
 * over the v2 SimulationRuntime + AvatarStateStore in @clawville/agent-runtime.
 *
 * Responsibilities:
 *   1. Own the AvatarStateStore singleton
 *   2. Own a single SimulationRuntime instance (Option B: one runtime, all avatars)
 *   3. Expose register()/unregister()/reportUserActivity() for API routes
 *   4. Run the 500ms tick from npc-simulation: movement + activity transitions
 *      + LLM planning at decision points
 *   5. Route AVATAR_VISIT_BUILDING arrivals through the runtime so the
 *      action's DB writes + runtime-driven visit chat fire
 *   6. Provide getAutonomousAvatars() for the SSE snapshot
 *
 * Lazy startup: the SimulationRuntime is only initialized on first avatar
 * registration to avoid paying the ElizaRuntime startup cost when no
 * users are logged in.
 */

import {
  AvatarStateStore,
  SimulationRuntime,
  activateIdleAvatars,
  stepMovement,
  handleActivityTransition,
  type AvatarRegistrationInput,
  type AvatarSimBroadcast,
} from '@clawville/agent-runtime';

// Re-export so route + service consumers can import these from the bridge
// rather than reaching into the runtime package directly.
export type { AvatarRegistrationInput, AvatarSimBroadcast };

import {
  NPC_BUILDING_CENTERS,
  BUILDING_ACTIVITIES,
  ACTIVITY_EMOJIS,
} from '@clawville/shared';
import { db, activityLog } from '@clawville/database';

import { findPath } from './pathfinding';
import { creditClawTokens } from './claw-token-ledger';
import { buildRuntimeServices } from './runtime-services-adapter';

const VISIT_CHAT_COOLDOWN_MS = 30_000;
const IDLE_UNREGISTER_MS = 30 * 60 * 1000; // 30 min — auto-cleanup abandoned avatars

export class AvatarSimulationBridge {
  private stateStore: AvatarStateStore;
  private runtime: SimulationRuntime | null = null;
  private runtimeReady = false;
  /** Phase 3: tracks which avatars have an in-flight planner call to prevent double-dispatch */
  private inFlightPlanners = new Set<string>();

  constructor() {
    this.stateStore = new AvatarStateStore();
  }

  /** Lazy-init the SimulationRuntime on first avatar registration */
  private ensureRuntime(): void {
    if (this.runtime) return;

    this.runtime = new SimulationRuntime({
      stateStore: this.stateStore,
      buildingCenters: NPC_BUILDING_CENTERS,
      buildingActivities: BUILDING_ACTIVITIES,
      activityEmojis: ACTIVITY_EMOJIS,
      pathfind: findPath,
      dbHooks: {
        awardToken: async (avatarId: string) => {
          // Credit via ledger — atomic + audited (source: 'simulation')
          await creditClawTokens({
            avatarId,
            amount: 1,
            reason: 'autonomous_visit',
            source: 'simulation',
          });
        },
        logActivity: async (
          avatarId: string,
          activityType: string,
          description: string,
          tokensEarned: number,
        ) => {
          await db.insert(activityLog).values({
            avatarId,
            activityType,
            description,
            tokensEarned,
          });
        },
      },
      databaseUrl: process.env.DATABASE_URL,
      apiKeys: {
        // OpenAI backs BOTH text generation (openai-text-provider) and
        // embeddings (openai-embedding-provider, text-embedding-3-small, 1536-dim).
        openai: process.env.OPENAI_API_KEY,
      },
      // Phase 3: inject services so economic actions (BUY_ITEM, LEARN_SKILL) can execute.
      // buildRuntimeServices passes the avatar-keyed params straight through to
      // the ledger; the only translation it does now is mapping runtime-emitted
      // source labels (e.g. 'shop', 'bazaar') to the ledger's enum values.
      services: buildRuntimeServices(db),
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
        console.error('[AvatarSimBridge] SimulationRuntime start failed:', err);
        this.runtime = null;
        this.runtimeReady = false;
        // Clear state store so SSE doesn't show stale avatars during a degraded state
        for (const avatar of this.stateStore.all()) {
          this.stateStore.unregister(avatar.userId);
        }
      });
  }

  isRegistered(userId: string): boolean {
    return this.stateStore.has(userId);
  }

  register(input: AvatarRegistrationInput): void {
    this.ensureRuntime();
    this.stateStore.register(input);
  }

  unregister(userId: string): void {
    this.stateStore.unregister(userId);
  }

  reportUserActivity(userId: string, x?: number, y?: number): void {
    this.stateStore.reportUserActivity(userId, x, y);
  }

  getAutonomousAvatars(): AvatarSimBroadcast[] {
    return this.stateStore.getBroadcast();
  }

  /**
   * Called every 500ms from npc-simulation.tick().
   *
   * Per-avatar flow:
   *   1. Unregister abandoned avatars (no heartbeat for IDLE_UNREGISTER_MS)
   *   2. Pure movement step if walking
   *   3. Check activity transitions (arrival / expiration)
   *   4. On arrival: dispatch AVATAR_VISIT_BUILDING via runtime
   *   5. On idle + cooldown elapsed: plan next action via runtime LLM
   */
  tick(): void {
    if (!this.runtime || !this.runtimeReady) return;

    const now = Date.now();

    // 0. Sweep abandoned avatars — prevents unbounded growth of the state store
    for (const avatar of this.stateStore.all()) {
      if (now - avatar.lastUserInputAt > IDLE_UNREGISTER_MS) {
        console.log(`[AvatarSimBridge] Unregistering abandoned avatar ${avatar.name} (${avatar.userId})`);
        this.stateStore.unregister(avatar.userId);
      }
    }

    // 1. Activate any avatars that just crossed the idle threshold
    activateIdleAvatars(this.stateStore, now);

    for (const avatar of this.stateStore.all()) {
      if (!avatar.isAutonomous) continue;

      // 1. Move
      stepMovement(avatar);

      // 2. Check transitions
      const transition = handleActivityTransition(avatar, now, ACTIVITY_EMOJIS);

      if (transition === 'arrived') {
        // Clear arrival state IMMEDIATELY so the next tick doesn't see the
        // same "arrived" condition and fire AVATAR_VISIT_BUILDING twice while
        // the first dispatch is still in flight (fire-and-forget).
        const destinationId = avatar.destinationBuildingId;
        avatar.path = [];
        avatar.pathIndex = 0;

        // Dispatch AVATAR_VISIT_BUILDING (the action will set activity to a
        // building-themed one and pick an activityEndsAt timer).
        this.runtime
          .dispatchAction({ action: 'AVATAR_VISIT_BUILDING', userId: avatar.userId })
          .catch((err) => console.error('[AvatarSimBridge] AVATAR_VISIT_BUILDING dispatch failed:', err));

        // Generate a visit chat line (throttled) via runtime
        if (destinationId && now - avatar.lastChatAt > VISIT_CHAT_COOLDOWN_MS) {
          avatar.lastChatAt = now;
          this.runtime
            .generateAvatarChat(avatar.userId, destinationId)
            .then((text) => {
              if (text) {
                const current = this.stateStore.get(avatar.userId);
                if (current) current.chatMessage = text;
              }
            })
            .catch((err) => console.error('[AvatarSimBridge] generateAvatarChat failed:', err));
        }
        continue;
      }

      if (transition === 'home') {
        // Clear arrival state before dispatch (same reason as above)
        avatar.path = [];
        avatar.pathIndex = 0;
        // Arrived home — go to sleep.
        this.runtime
          .dispatchAction({ action: 'AVATAR_SLEEP', userId: avatar.userId })
          .catch((err) => console.error('[AvatarSimBridge] AVATAR_SLEEP dispatch failed:', err));
        continue;
      }

      // 3. Plan next action when idle + cooldown elapsed (with in-flight guard)
      if (avatar.activity === 'idle') {
        avatar.behaviorCooldown--;
        if (avatar.behaviorCooldown <= 0 && !this.inFlightPlanners.has(avatar.userId)) {
          avatar.behaviorCooldown = 100;
          this.inFlightPlanners.add(avatar.userId);
          this.runtime
            .planAvatarNextAction(avatar.userId)
            .catch((err) => console.error('[AvatarSimBridge] planAvatarNextAction failed:', err))
            .finally(() => this.inFlightPlanners.delete(avatar.userId));
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
