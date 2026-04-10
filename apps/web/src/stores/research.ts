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
  /** Sticky flag — once the user closes the log, don't auto-reopen */
  userClosedLog: boolean;
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
  /** Clear only the thought entries — does NOT reset research progress state */
  clearThoughtEntries: () => void;
  /** Full research state reset — only call from "cancel research" UX */
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
  userClosedLog: false,
  toggleThoughtLog: () =>
    set((s) => ({
      thoughtLogOpen: !s.thoughtLogOpen,
      // Mark user-closed when toggling off
      userClosedLog: s.thoughtLogOpen ? true : s.userClosedLog,
    })),
  setThoughtLogOpen: (v) =>
    set({
      thoughtLogOpen: v,
      // Mark user-closed when explicitly closing
      userClosedLog: !v,
    }),
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
        id:
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
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
        // Respect user close — only auto-open if they haven't closed it
        thoughtLogOpen: s.thoughtLogOpen || !s.userClosedLog,
        thoughtLogMinimized: false,
        lastResult:
          event.phase === 'complete' && event.synthesizedKnowledge
            ? { synthesizedKnowledge: event.synthesizedKnowledge, skillMd: event.skillMd ?? '' }
            : s.lastResult,
      };
    }),

  addCollaborationEntries: (entries) =>
    set((s) => {
      if (!entries || entries.length === 0) return s;
      // Dedupe by id against the existing slice (guards against SSE replay)
      const existingIds = new Set(s.collaborationEntries.map((e) => e.id));
      const fresh = entries.filter((e) => !existingIds.has(e.id));
      if (fresh.length === 0) return s;

      const merged = s.collaborationEntries.concat(fresh);
      if (merged.length > MAX_COLLABORATION) {
        merged.splice(0, merged.length - MAX_COLLABORATION);
      }
      // Auto-open only on first-ever collab activity AND only if user hasn't
      // explicitly closed the log
      const firstEver = s.collaborationEntries.length === 0;
      return {
        collaborationEntries: merged,
        thoughtLogOpen: s.thoughtLogOpen || (firstEver && !s.userClosedLog),
      };
    }),

  /** Clear just the thought entries array — preserves research run state */
  clearThoughtEntries: () => set({ thoughts: [] }),

  /** Full research state reset — use for "cancel research" UX only */
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
