import { create } from 'zustand';
import type { ResearchPhase, ResearchThoughtEvent } from '@clawville/shared';

export interface ThoughtLogEntry {
  id: string;
  phase: ResearchPhase;
  message: string;
  timestamp: string;
  progress?: number;
}

interface ResearchState {
  // Panel visibility
  thoughtLogOpen: boolean;
  thoughtLogMinimized: boolean;
  toggleThoughtLog: () => void;
  setThoughtLogOpen: (v: boolean) => void;
  toggleMinimize: () => void;

  // Research state
  isResearching: boolean;
  currentPhase: ResearchPhase;
  currentLocationId: string | null;
  progress: number;

  // Thought log entries
  thoughts: ThoughtLogEntry[];

  // Actions
  addThought: (event: ResearchThoughtEvent) => void;
  clearThoughts: () => void;

  // Result
  lastResult: {
    synthesizedKnowledge: string[];
    skillMd: string;
  } | null;
}

const MAX_THOUGHTS = 200;

export const useResearchStore = create<ResearchState>((set) => ({
  thoughtLogOpen: false,
  thoughtLogMinimized: false,
  toggleThoughtLog: () => set((s) => ({ thoughtLogOpen: !s.thoughtLogOpen })),
  setThoughtLogOpen: (v) => set({ thoughtLogOpen: v }),
  toggleMinimize: () => set((s) => ({ thoughtLogMinimized: !s.thoughtLogMinimized })),

  isResearching: false,
  currentPhase: 'idle',
  currentLocationId: null,
  progress: 0,

  thoughts: [],

  addThought: (event) =>
    set((s) => {
      const entry: ThoughtLogEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        phase: event.phase,
        message: event.message,
        timestamp: event.timestamp,
        progress: event.progress,
      };

      const isComplete = event.phase === 'complete' || event.phase === 'error';
      const thoughts = [...s.thoughts, entry].slice(-MAX_THOUGHTS);

      return {
        thoughts,
        isResearching: !isComplete,
        currentPhase: event.phase,
        currentLocationId: event.locationId,
        progress: event.progress ?? s.progress,
        thoughtLogOpen: true,
        thoughtLogMinimized: false,
        lastResult:
          event.phase === 'complete' && event.synthesizedKnowledge
            ? { synthesizedKnowledge: event.synthesizedKnowledge, skillMd: event.skillMd ?? '' }
            : s.lastResult,
      };
    }),

  clearThoughts: () =>
    set({
      thoughts: [],
      isResearching: false,
      currentPhase: 'idle',
      currentLocationId: null,
      progress: 0,
      lastResult: null,
    }),

  lastResult: null,
}));
