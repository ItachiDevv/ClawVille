import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useGameStore } from '@/stores/game';
import { useNpcStore } from '@/stores/npc';
import {
  type QuestId,
  type QuestStatus,
  type CounterKey,
  QUEST_DEFINITIONS,
} from '@/lib/quests';

export interface QuestProgress {
  status: QuestStatus;
  completedAt?: number;
}

interface QuestCounters {
  totalDistanceMoved: number;
  npcMessagesSent: number;
  avatarMessagesSent: number;
  booksBought: number;
  knowledgeLearned: number;
}

interface QuestStoreState {
  progress: Record<QuestId, QuestProgress>;
  counters: QuestCounters;

  incrementCounter: (key: CounterKey, amount?: number) => void;
  checkAndCompleteQuests: () => QuestId[];
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
        avatarMessagesSent: 0,
        booksBought: 0,
        knowledgeLearned: 0,
      },

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
      partialize: (state) => ({
        progress: state.progress,
        counters: state.counters,
      }),
    }
  )
);

/**
 * Check all quests and fire toasts for any newly completed ones.
 * Call after incrementing a counter or changing game state.
 */
export function triggerQuestCheck() {
  const completed = useQuestStore.getState().checkAndCompleteQuests();
  for (const questId of completed) {
    const def = QUEST_DEFINITIONS.find((q) => q.id === questId);
    if (def) {
      useGameStore.getState().addToast(def.icon, `Quest complete: ${def.title}!`, 4000);
    }
  }
}
