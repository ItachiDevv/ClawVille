import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useGameStore } from '@/stores/game';
import { useNpcStore } from '@/stores/npc';
import { api } from '@/lib/api';
import {
  type QuestId,
  type QuestStatus,
  type CounterKey,
  type QuestDefinition,
  QUEST_DEFINITIONS,
} from '@/lib/quests';

export interface QuestProgress {
  status: QuestStatus;
  completedAt?: number;
}

interface QuestCounters {
  totalDistanceMoved: number;
  npcMessagesSent: number;
  petMessagesSent: number;
  booksBought: number;
  knowledgeLearned: number;
  /** Q2 chunk #9 — incremented in ActivityResultsModal for the first-match quest */
  activityMatchesPlayed: number;
  /** Q2 chunk #9 — incremented when player placement === 1 */
  activityMatchesWon: number;
}

interface QuestStoreState {
  progress: Record<QuestId, QuestProgress>;
  counters: QuestCounters;
  /**
   * Q3 plan §2.6 + audit-fix 2026-04-29 — set of quest ids whose
   * server-side reward credit has been confirmed (200 or 409 from the
   * /tutorial/:id/claim endpoint). Locally-completed quests not in this
   * set are retried on subsequent loads via `retryUnclaimedRewards()`,
   * so a one-time network failure during completion doesn't permanently
   * lose the player's tokens. Stored as object-of-bools (not Set) so it
   * survives zustand persist's JSON serialization.
   */
  serverClaimed: Partial<Record<QuestId, boolean>>;

  incrementCounter: (key: CounterKey, amount?: number) => void;
  checkAndCompleteQuests: () => QuestId[];
  markServerClaimed: (id: QuestId) => void;
  getActiveQuests: () => QuestId[];
  isCompleted: (id: QuestId) => boolean;
  getStatus: (id: QuestId) => QuestStatus;
  getProgress: (id: QuestId) => number; // 0-1
}

function getDefaultProgress(): Record<QuestId, QuestProgress> {
  const progress: Record<string, QuestProgress> = {};
  for (const q of QUEST_DEFINITIONS) {
    progress[q.id] = {
      status: q.prerequisites.length === 0 ? 'active' : 'locked',
    };
  }
  return progress as Record<QuestId, QuestProgress>;
}

export const useQuestStore = create<QuestStoreState>()(
  persist(
    (set, get) => ({
      progress: getDefaultProgress(),
      counters: {
        totalDistanceMoved: 0,
        npcMessagesSent: 0,
        petMessagesSent: 0,
        booksBought: 0,
        knowledgeLearned: 0,
        activityMatchesPlayed: 0,
        activityMatchesWon: 0,
      },
      serverClaimed: {},

      markServerClaimed: (id) =>
        set((s) => ({ serverClaimed: { ...s.serverClaimed, [id]: true } })),

      incrementCounter: (key, amount = 1) => {
        set((s) => ({
          counters: { ...s.counters, [key]: s.counters[key] + amount },
        }));
      },

      checkAndCompleteQuests: () => {
        const state = get();
        const completed: QuestId[] = [];
        const updatedProgress = { ...state.progress };
        let changed = false;

        for (const quest of QUEST_DEFINITIONS) {
          const current = updatedProgress[quest.id];
          if (current.status === 'completed') continue;

          // Check prerequisites — unlock if all prereqs completed
          if (current.status === 'locked') {
            const allPrereqsMet = quest.prerequisites.every(
              (pid) => updatedProgress[pid]?.status === 'completed'
            );
            if (allPrereqsMet) {
              updatedProgress[quest.id] = { status: 'active' };
              changed = true;
            } else {
              continue;
            }
          }

          // Check condition
          let met = false;
          const { condition } = quest;

          if (condition.type === 'counter' && condition.counterKey && condition.threshold) {
            met = state.counters[condition.counterKey] >= condition.threshold;
          } else if (condition.type === 'visitedBuildings' && condition.threshold) {
            const visited = useGameStore.getState().visitedBuildings;
            met = visited.size >= condition.threshold;
          } else if (condition.type === 'openClaw') {
            const npcs = useNpcStore.getState().npcs;
            met = npcs.some((npc) => npc.isOpenClaw);
          }

          if (met) {
            updatedProgress[quest.id] = {
              status: 'completed',
              completedAt: Date.now(),
            };
            completed.push(quest.id);
            changed = true;
          }
        }

        // Unlock newly available quests after completions
        if (completed.length > 0) {
          for (const quest of QUEST_DEFINITIONS) {
            if (updatedProgress[quest.id].status !== 'locked') continue;
            const allPrereqsMet = quest.prerequisites.every(
              (pid) => updatedProgress[pid]?.status === 'completed'
            );
            if (allPrereqsMet) {
              updatedProgress[quest.id] = { status: 'active' };
              changed = true;
            }
          }
        }

        if (changed) {
          set({ progress: updatedProgress });
        }

        return completed;
      },

      getActiveQuests: () => {
        const { progress } = get();
        return QUEST_DEFINITIONS.filter((q) => progress[q.id]?.status === 'active').map(
          (q) => q.id
        );
      },

      isCompleted: (id) => get().progress[id]?.status === 'completed',

      getStatus: (id) => {
        return get().progress[id]?.status ?? 'locked';
      },

      getProgress: (id) => {
        const state = get();
        const quest = QUEST_DEFINITIONS.find((q) => q.id === id);
        if (!quest) return 0;
        if (state.progress[id]?.status === 'completed') return 1;
        if (state.progress[id]?.status === 'locked') return 0;

        const { condition } = quest;
        if (condition.type === 'counter' && condition.counterKey && condition.threshold) {
          return Math.min(1, state.counters[condition.counterKey] / condition.threshold);
        }
        if (condition.type === 'visitedBuildings' && condition.threshold) {
          const visited = useGameStore.getState().visitedBuildings;
          return Math.min(1, visited.size / condition.threshold);
        }
        if (condition.type === 'openClaw') {
          const npcs = useNpcStore.getState().npcs;
          return npcs.some((npc) => npc.isOpenClaw) ? 1 : 0;
        }
        return 0;
      },
    }),
    {
      name: 'clawville-quest-progress',
      // Bump version when adding counters/quests so the merge fn below can
      // backfill missing fields without nuking returning users' progress.
      version: 2,
      partialize: (state) => ({
        progress: state.progress,
        counters: state.counters,
        serverClaimed: state.serverClaimed,
      }),
      // Forward-compatible merge: backfill any new counter keys + the
      // serverClaimed map that older persisted state is missing. Returning
      // users with Phase 1 quests already marked complete will have an empty
      // serverClaimed{} after this load and retryUnclaimedRewards() will
      // settle the credits server-side on next page mount.
      merge: (persisted, current) => {
        const safe = persisted as Partial<{
          progress: Record<QuestId, QuestProgress>;
          counters: Partial<QuestCounters>;
          serverClaimed: Partial<Record<QuestId, boolean>>;
        }> | undefined;
        return {
          ...current,
          progress: { ...current.progress, ...(safe?.progress ?? {}) },
          counters: { ...current.counters, ...(safe?.counters ?? {}) },
          serverClaimed: { ...current.serverClaimed, ...(safe?.serverClaimed ?? {}) },
        };
      },
    }
  )
);

/**
 * Q3 plan §2.6 — fire the server-side reward claim for a completed
 * tutorial quest. Fire-and-forget: completion toast lands immediately
 * (synchronous), token-credit toast lands when the server responds.
 *
 * Idempotency: server returns 409 `already_claimed` for repeat calls;
 * we silence those because the store's local "completed" status means
 * the user was already credited on first completion.
 */
async function claimTutorialQuestReward(def: QuestDefinition, opts?: { silent?: boolean }) {
  try {
    const res = await api.claimTutorialQuest(def.id);
    if (res.ok) {
      // Server credited the reward. Mark locally so we don't retry, and
      // toast unless this is a silent retry replay.
      useQuestStore.getState().markServerClaimed(def.id);
      if (!opts?.silent) {
        useGameStore
          .getState()
          .addToast('💰', `+${res.credited} ClawTokens (balance: ${res.balance})`, 3500);
      }
    } else if (res.error === 'already_claimed') {
      // Server has the reward, we just didn't know — sync local state.
      useQuestStore.getState().markServerClaimed(def.id);
    } else if (res.error === 'guest_not_eligible') {
      // Guest accounts can't claim tutorial rewards. Mark as "claimed" so
      // we stop retrying; if the user signs up later the server will allow
      // the claim on the new account (which has its own fresh state).
      useQuestStore.getState().markServerClaimed(def.id);
      if (!opts?.silent) {
        useGameStore
          .getState()
          .addToast('🔒', 'Sign up to claim tutorial rewards', 4000);
      }
    } else if (res.error === 'engagement_required') {
      // Server doesn't see the engagement events yet (eventual consistency
      // window or events.ts emitter gap). Leave serverClaimed[] unset so a
      // later mount retries.
      console.warn('[quest] server engagement gate failed for', def.id, res.reason);
    }
  } catch (err) {
    // honoRequest throws on !res.ok. Detect known-409 ('already_claimed')
    // path from the message and silently mark claimed; everything else is
    // genuine network failure that retryUnclaimedRewards() will pick up.
    const msg = String((err as Error)?.message ?? '');
    if (msg.includes('already_claimed')) {
      useQuestStore.getState().markServerClaimed(def.id);
    } else if (msg.includes('guest_not_eligible')) {
      useQuestStore.getState().markServerClaimed(def.id);
    } else {
      console.warn('[quest] claim network failure for', def.id, err);
    }
  }
}

/**
 * Retry server-side claims for any tutorial quests that the local store
 * marks completed but `serverClaimed` doesn't acknowledge. Call once on
 * app mount. Network failures during the original completion no longer
 * lose the user's reward forever.
 */
export async function retryUnclaimedRewards() {
  const state = useQuestStore.getState();
  const claimed = state.serverClaimed;
  for (const def of QUEST_DEFINITIONS) {
    if (state.progress[def.id]?.status === 'completed' && !claimed[def.id]) {
      // Run silently — no completion toast, just settle the credit.
      // claimTutorialQuestReward will toast for newly-credited rewards
      // even with silent:true is false; the silent flag here suppresses
      // the +CT toast since the user already saw the original completion
      // toast on first attempt.
      await claimTutorialQuestReward(def, { silent: true });
    }
  }
}

/**
 * Check all quests and fire toasts + server reward claims for any newly
 * completed ones. Call after incrementing a counter or changing game state.
 */
export function triggerQuestCheck() {
  const completed = useQuestStore.getState().checkAndCompleteQuests();
  for (const questId of completed) {
    const def = QUEST_DEFINITIONS.find((q) => q.id === questId);
    if (def) {
      useGameStore.getState().addToast(def.icon, `Quest complete: ${def.title}!`, 4000);
      // Fire-and-forget server-side ClawToken credit.
      void claimTutorialQuestReward(def);
    }
  }
}
