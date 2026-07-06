import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useGameStore } from '@/stores/game';
import { useNpcStore } from '@/stores/npc';
import { api } from '@/lib/api';
import {
  type QuestId,
  type QuestStatus,
  type CounterKey,
  type DistinctSetKey,
  type QuestCondition,
  type QuestDefinition,
  QUEST_DEFINITIONS,
} from '@/lib/quests';

export interface QuestProgress {
  status: QuestStatus;
  completedAt?: number;
}

interface QuestCounters {
  systemAgentMessagesSent: number;
  avatarMessagesSent: number;
  characterMessagesSent: number;
  booksBought: number;
  itemsBought: number;
  knowledgeLearned: number;
  cosmeticsEquipped: number;
  activityMatchesPlayed: number;
  activityMatchesWon: number;
}

type DistinctSets = Record<DistinctSetKey, Record<string, true>>;

interface QuestStoreState {
  progress: Record<QuestId, QuestProgress>;
  counters: QuestCounters;
  distinct: DistinctSets;
  serverClaimed: Partial<Record<QuestId, boolean>>;

  incrementCounter: (key: CounterKey, amount?: number) => void;
  recordDistinct: (setKey: DistinctSetKey, value: string) => void;
  checkAndCompleteQuests: () => QuestId[];
  markServerClaimed: (id: QuestId) => void;
  getActiveQuests: () => QuestId[];
  isCompleted: (id: QuestId) => boolean;
  getStatus: (id: QuestId) => QuestStatus;
  getProgress: (id: QuestId) => number;
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

const DEFAULT_COUNTERS: QuestCounters = {
  systemAgentMessagesSent: 0,
  avatarMessagesSent: 0,
  characterMessagesSent: 0,
  booksBought: 0,
  itemsBought: 0,
  knowledgeLearned: 0,
  cosmeticsEquipped: 0,
  activityMatchesPlayed: 0,
  activityMatchesWon: 0,
};

const DEFAULT_DISTINCT: DistinctSets = {
  distinctTeachersChatted: {},
  distinctActivityTypes: {},
  distinctBookBuildings: {},
};

interface CondEvalContext {
  counters: QuestCounters;
  distinct: DistinctSets;
  visitedBuildingsSize: number;
  hasAgentBot: boolean;
}

function evalCondition(
  cond: QuestCondition,
  ctx: CondEvalContext,
): { met: boolean; ratio: number } {
  switch (cond.type) {
    case 'counter': {
      const v = ctx.counters[cond.counterKey] ?? 0;
      return { met: v >= cond.threshold, ratio: Math.min(1, v / cond.threshold) };
    }
    case 'visitedBuildings': {
      const v = ctx.visitedBuildingsSize;
      return { met: v >= cond.threshold, ratio: Math.min(1, v / cond.threshold) };
    }
    case 'distinctSet': {
      const v = Object.keys(ctx.distinct[cond.setKey] ?? {}).length;
      return { met: v >= cond.threshold, ratio: Math.min(1, v / cond.threshold) };
    }
    case 'openClaw':
      return { met: ctx.hasAgentBot, ratio: ctx.hasAgentBot ? 1 : 0 };
    case 'compound': {
      const sub = cond.predicates.map((p) => evalCondition(p, ctx));
      const met = sub.every((s) => s.met);
      const ratio = sub.reduce((s, r) => s + r.ratio, 0) / Math.max(1, sub.length);
      return { met, ratio };
    }
    case 'pending':
    case 'serverOnly':
      return { met: false, ratio: 0 };
  }
}

function buildEvalContext(state: QuestStoreState): CondEvalContext {
  return {
    counters: state.counters,
    distinct: state.distinct,
    visitedBuildingsSize: useGameStore.getState().visitedBuildings.size,
    hasAgentBot: useNpcStore.getState().npcs.some((npc) => npc.isOpenClaw),
  };
}

export const useQuestStore = create<QuestStoreState>()(
  persist(
    (set, get) => ({
      progress: getDefaultProgress(),
      counters: { ...DEFAULT_COUNTERS },
      distinct: { ...DEFAULT_DISTINCT },
      serverClaimed: {},

      markServerClaimed: (id) =>
        set((s) => ({ serverClaimed: { ...s.serverClaimed, [id]: true } })),

      incrementCounter: (key, amount = 1) => {
        set((s) => ({
          counters: { ...s.counters, [key]: (s.counters[key] ?? 0) + amount },
        }));
      },

      recordDistinct: (setKey, value) => {
        set((s) => {
          const existing = s.distinct[setKey] ?? {};
          if (existing[value]) return s;
          return {
            distinct: {
              ...s.distinct,
              [setKey]: { ...existing, [value]: true as const },
            },
          };
        });
      },

      checkAndCompleteQuests: () => {
        const state = get();
        const ctx = buildEvalContext(state);
        const completed: QuestId[] = [];
        const updatedProgress = { ...state.progress };
        let changed = false;

        for (const quest of QUEST_DEFINITIONS) {
          const current = updatedProgress[quest.id];
          if (!current || current.status === 'completed') continue;

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

          const { met } = evalCondition(quest.condition, ctx);
          if (met) {
            updatedProgress[quest.id] = {
              status: 'completed',
              completedAt: Date.now(),
            };
            completed.push(quest.id);
            changed = true;
          }
        }

        if (completed.length > 0) {
          for (const quest of QUEST_DEFINITIONS) {
            if (updatedProgress[quest.id]?.status !== 'locked') continue;
            const allPrereqsMet = quest.prerequisites.every(
              (pid) => updatedProgress[pid]?.status === 'completed'
            );
            if (allPrereqsMet) {
              updatedProgress[quest.id] = { status: 'active' };
              changed = true;
            }
          }
        }

        if (changed) set({ progress: updatedProgress });
        return completed;
      },

      getActiveQuests: () => {
        const { progress } = get();
        return QUEST_DEFINITIONS.filter((q) => progress[q.id]?.status === 'active').map(
          (q) => q.id
        );
      },

      isCompleted: (id) => get().progress[id]?.status === 'completed',

      getStatus: (id) => get().progress[id]?.status ?? 'locked',

      getProgress: (id) => {
        const state = get();
        const quest = QUEST_DEFINITIONS.find((q) => q.id === id);
        if (!quest) return 0;
        if (state.progress[id]?.status === 'completed') return 1;
        if (state.progress[id]?.status === 'locked') return 0;
        const ctx = buildEvalContext(state);
        return evalCondition(quest.condition, ctx).ratio;
      },
    }),
    {
      name: 'clawville-quest-progress',
      // Bumped to v3 for the 30-quest redesign (new counter keys, new
      // distinct sets, new quest IDs).
      version: 3,
      // skipHydration: true defers the localStorage read until a top-level
      // component explicitly calls useQuestStore.persist.rehydrate() inside
      // a useEffect. Without this, persist reads localStorage during the
      // first client render — server-rendered HTML (initial state) does not
      // match the now-hydrated client HTML → React #418 hydration mismatch
      // fires every page load. See game/page.tsx for the rehydrate trigger.
      skipHydration: true,
      partialize: (state) => ({
        progress: state.progress,
        counters: state.counters,
        distinct: state.distinct,
        serverClaimed: state.serverClaimed,
      }),
      merge: (persisted, current) => {
        const safe = persisted as Partial<{
          progress: Record<QuestId, QuestProgress>;
          counters: Partial<QuestCounters>;
          distinct: Partial<DistinctSets>;
          serverClaimed: Partial<Record<QuestId, boolean>>;
        }> | undefined;
        return {
          ...current,
          progress: { ...current.progress, ...(safe?.progress ?? {}) },
          counters: { ...current.counters, ...(safe?.counters ?? {}) },
          distinct: {
            distinctTeachersChatted: { ...current.distinct.distinctTeachersChatted, ...(safe?.distinct?.distinctTeachersChatted ?? {}) },
            distinctActivityTypes: { ...current.distinct.distinctActivityTypes, ...(safe?.distinct?.distinctActivityTypes ?? {}) },
            distinctBookBuildings: { ...current.distinct.distinctBookBuildings, ...(safe?.distinct?.distinctBookBuildings ?? {}) },
          },
          serverClaimed: { ...current.serverClaimed, ...(safe?.serverClaimed ?? {}) },
        };
      },
    }
  )
);

async function claimTutorialQuestReward(def: QuestDefinition, opts?: { silent?: boolean }) {
  try {
    const res = await api.claimTutorialQuest(def.id);
    if (res.ok) {
      useQuestStore.getState().markServerClaimed(def.id);
      if (!opts?.silent) {
        useGameStore
          .getState()
          .addToast('💰', `+${res.credited} ClawTokens (balance: ${res.balance})`, 3500);
      }
    } else if (res.error === 'already_claimed') {
      useQuestStore.getState().markServerClaimed(def.id);
    } else if (res.error === 'guest_not_eligible') {
      useQuestStore.getState().markServerClaimed(def.id);
      if (!opts?.silent) {
        useGameStore
          .getState()
          .addToast('🔒', 'Sign up to claim tutorial rewards', 4000);
      }
    } else if (res.error === 'engagement_required' || res.error === 'pending_feature') {
      console.warn('[quest] server engagement gate failed for', def.id, res.reason ?? res.error);
    }
  } catch (err) {
    const msg = String((err as Error)?.message ?? '');
    if (msg.includes('already_claimed')) {
      useQuestStore.getState().markServerClaimed(def.id);
    } else if (msg.includes('guest_not_eligible')) {
      useQuestStore.getState().markServerClaimed(def.id);
    } else if (msg.includes('pending_feature') || msg.includes('engagement_required')) {
      // Quiet — feature not shipped or events haven't landed yet.
    } else {
      console.warn('[quest] claim network failure for', def.id, err);
    }
  }
}

/**
 * Retry server-side claims for any tutorial quests that the local store
 * marks completed but `serverClaimed` doesn't acknowledge. Also probes
 * `serverOnly` quests whose prerequisites are met — the server validator
 * is the only authority for those, so we ask periodically.
 */
export async function retryUnclaimedRewards() {
  const state = useQuestStore.getState();
  const claimed = state.serverClaimed;
  for (const def of QUEST_DEFINITIONS) {
    if (claimed[def.id]) continue;
    if (state.progress[def.id]?.status === 'completed') {
      await claimTutorialQuestReward(def, { silent: true });
      continue;
    }
    if (def.condition.type === 'serverOnly') {
      const allPrereqsMet = def.prerequisites.every(
        (pid) => state.progress[pid]?.status === 'completed'
      );
      if (allPrereqsMet) {
        await claimTutorialQuestReward(def, { silent: true });
      }
    }
  }
}

export function triggerQuestCheck() {
  const completed = useQuestStore.getState().checkAndCompleteQuests();
  for (const questId of completed) {
    const def = QUEST_DEFINITIONS.find((q) => q.id === questId);
    if (def) {
      useGameStore.getState().addToast(def.icon, `Quest complete: ${def.title}!`, 4000);
      void claimTutorialQuestReward(def);
    }
  }
}
