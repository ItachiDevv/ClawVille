import { create } from 'zustand';
import type { ResearchPhase, ResearchThoughtEvent } from '@clawville/shared';
import type { CollaborationLogEntry } from '@clawville/agent-runtime';

export interface ThoughtLogEntry {
  id: string;
  phase: ResearchPhase;
  message: string;
  timestamp: string;
  progress?: number;
}

/** Which tab is active in the thought log UI */
export type ThoughtLogTab = 'all' | 'research' | 'collaboration';

interface ResearchState {
  // Panel visibility
  thoughtLogOpen: boolean;
  thoughtLogMinimized: boolean;
  activeTab: ThoughtLogTab;
  toggleThoughtLog: () => void;
  setThoughtLogOpen: (v: boolean) => void;
  toggleMinimize: () => void;
  setActiveTab: (tab: ThoughtLogTab) => void;

  // Research state
  isResearching: boolean;
  currentPhase: ResearchPhase;
  currentLocationId: string | null;
  progress: number;

  // Thought log entries
  thoughts: ThoughtLogEntry[];

  // Collaboration entries (Phase 3)
  collaborationEntries: CollaborationLogEntry[];

  // Actions
  addThought: (event: ResearchThoughtEvent) => void;
  addCollaborationEntries: (entries: CollaborationLogEntry[]) => void;
  clearThoughts: () => void;
  clearCollaborationEntries: () => void;

  // Result
  lastResult: {
    synthesizedKnowledge: string[];
    skillMd: string;
  } | null;
}

const MAX_THOUGHTS = 200;
const MAX_COLLABORATION = 200;

export const useResearchStore = create<ResearchState>((set) => ({
  thoughtLogOpen: false,
  thoughtLogMinimized: false,
  activeTab: 'all',
  toggleThoughtLog: () => set((s) => ({ thoughtLogOpen: !s.thoughtLogOpen })),
  setThoughtLogOpen: (v) => set({ thoughtLogOpen: v }),
  toggleMinimize: () => set((s) => ({ thoughtLogMinimized: !s.thoughtLogMinimized })),
  setActiveTab: (tab) => set({ activeTab: tab }),

  isResearching: false,
  currentPhase: 'idle',
  currentLocationId: null,
  progress: 0,

  thoughts: [],
  collaborationEntries: [],

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

  addCollaborationEntries: (entries) =>
    set((s) => {
      if (!entries || entries.length === 0) return {};
      const merged = [...s.collaborationEntries, ...entries].slice(-MAX_COLLABORATION);
      return {
        collaborationEntries: merged,
        // Auto-open the log on first collaboration activity
        thoughtLogOpen: s.thoughtLogOpen || entries.length > 0,
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

  clearCollaborationEntries: () => set({ collaborationEntries: [] }),

  lastResult: null,
}));
