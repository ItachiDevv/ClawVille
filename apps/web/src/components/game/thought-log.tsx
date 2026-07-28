'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useResearchStore, type ThoughtLogTab } from '@/stores/research';
import { BUILDING_OPENCLAW_THEMES } from '@clawville/shared';
import type { ResearchPhase } from '@clawville/shared';

const PHASE_CONFIG: Record<ResearchPhase, { label: string; color: string }> = {
  idle: { label: 'IDLE', color: 'text-gray-500' },
  fetching_articles: { label: 'FETCH', color: 'text-cyan-400' },
  reading: { label: 'READ', color: 'text-green-400' },
  synthesizing: { label: 'SYNTH', color: 'text-yellow-400' },
  creating_skill: { label: 'SKILL', color: 'text-purple-400' },
  complete: { label: 'DONE', color: 'text-green-300' },
  error: { label: 'ERROR', color: 'text-red-400' },
};

// Collaboration entry type labels + colors (cyan palette to distinguish
// from research's green palette)
const COLLAB_TYPE_CONFIG: Record<
  'request' | 'response' | 'merged' | 'error',
  { label: string; color: string }
> = {
  request: { label: 'ASK', color: 'text-cyan-400' },
  response: { label: 'REPLY', color: 'text-blue-300' },
  merged: { label: 'MERGE', color: 'text-purple-300' },
  error: { label: 'ERR', color: 'text-red-400' },
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

interface UnifiedEntry {
  id: string;
  kind: 'research' | 'collaboration';
  timestamp: string;
  sortKey: number;
  // Research fields
  phase?: ResearchPhase;
  message?: string;
  // Collaboration fields
  collabType?: 'request' | 'response' | 'merged' | 'error';
  sourceBuildingId?: string;
  targetBuildingId?: string;
  question?: string;
  response?: string;
  durationMs?: number;
}

export default function ThoughtLog() {
  const {
    thoughtLogOpen,
    thoughtLogMinimized,
    thoughtLogExpanded,
    activeTab,
    setActiveTab,
    thoughts,
    collaborationEntries,
    isResearching,
    currentPhase,
    currentLocationId,
    progress,
    toggleMinimize,
    toggleThoughtLogExpanded,
    setThoughtLogOpen,
    clearThoughtEntries,
    clearCollaborationEntries,
  } = useResearchStore();

  const scrollRef = useRef<HTMLDivElement>(null);

  // Build unified list based on active tab.
  // Each slice is already append-order chronological, so we can skip sort
  // on single-tab views. For 'all', we do a stable merge with insertion-order
  // tiebreaker to preserve causal ordering when timestamps tie at ms precision.
  const unified = useMemo<UnifiedEntry[]>(() => {
    const entries: UnifiedEntry[] = [];

    if (activeTab === 'all' || activeTab === 'research') {
      thoughts.forEach((t, idx) => {
        entries.push({
          id: `r-${t.id}`,
          kind: 'research',
          timestamp: t.timestamp,
          // Multiply by 2 + 0 so research and collab share an interleaved
          // secondary key when timestamps tie: research ties break research-first.
          sortKey: new Date(t.timestamp).getTime() * 1000 + idx,
          phase: t.phase,
          message: t.message,
        });
      });
    }

    if (activeTab === 'all' || activeTab === 'collaboration') {
      collaborationEntries.forEach((c, idx) => {
        entries.push({
          id: `c-${c.id}`,
          kind: 'collaboration',
          timestamp: c.timestamp,
          sortKey: new Date(c.timestamp).getTime() * 1000 + idx + 500,
          collabType: c.type,
          sourceBuildingId: c.sourceBuildingId,
          targetBuildingId: c.targetBuildingId,
          question: c.question,
          response: c.response,
          durationMs: c.durationMs,
        });
      });
    }

    // Skip the full sort when we're showing a single pre-sorted slice
    if (activeTab === 'all') {
      entries.sort((a, b) => a.sortKey - b.sortKey);
    }
    return entries;
  }, [thoughts, collaborationEntries, activeTab]);

  // Auto-scroll to bottom only when the number of entries actually grows.
  // Depending on [unified] directly would also fire on tab switches because
  // the memo returns a fresh reference — this preserves user scroll position
  // when switching tabs.
  const unifiedLength = unified.length;
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [unifiedLength]);

  if (!thoughtLogOpen) return null;

  const themeName = currentLocationId
    ? BUILDING_OPENCLAW_THEMES[currentLocationId]?.label ?? currentLocationId
    : 'Agent Activity';

  // Minimized: single-line bar
  if (thoughtLogMinimized) {
    const totalEntries = thoughts.length + collaborationEntries.length;
    return (
      <div
        className="fixed bottom-0 left-0 right-0 z-40 h-8 bg-gray-900/95 backdrop-blur-sm border-t border-green-500/30 flex items-center px-4 cursor-pointer hover:bg-gray-800/95 transition-colors"
        onClick={toggleMinimize}
      >
        <span className="text-green-400 font-mono text-xs font-bold mr-2">&gt;</span>
        <span className="text-green-300/80 font-mono text-xs">
          AGENT LOG — {themeName}
        </span>
        {isResearching && (
          <span className="ml-2 text-yellow-400 font-mono text-xs animate-pulse">
            [{PHASE_CONFIG[currentPhase]?.label}] {progress}%
          </span>
        )}
        {totalEntries > 0 && (
          <span className="ml-2 text-gray-500 font-mono text-xs tabular-nums">
            ({thoughts.length}R / {collaborationEntries.length}C)
          </span>
        )}
        <span className="ml-auto text-gray-500 font-mono text-xs">[click to expand]</span>
      </div>
    );
  }

  const tabs: Array<{ id: ThoughtLogTab; label: string; count: number; accent: string }> = [
    { id: 'all', label: 'ALL', count: thoughts.length + collaborationEntries.length, accent: 'text-green-300' },
    { id: 'research', label: 'RESEARCH', count: thoughts.length, accent: 'text-green-400' },
    { id: 'collaboration', label: 'COLLAB', count: collaborationEntries.length, accent: 'text-cyan-400' },
  ];

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-40 bg-gray-900/95 backdrop-blur-sm border-t border-green-500/30 flex flex-col"
      style={{ maxHeight: thoughtLogExpanded ? 'min(50vh, 460px)' : '260px' }}
    >
      {/* Header + Tabs */}
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-green-500/20 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-green-400 font-mono text-xs font-bold">&gt;</span>
          <span className="text-green-300 font-mono text-xs font-bold">
            AGENT LOG — {themeName}
          </span>
          {isResearching && (
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          )}

          {/* Tab switcher */}
          <div className="flex items-center gap-1 ml-3">
            {tabs.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-2 py-0.5 font-mono text-[10px] font-bold rounded transition-colors ${
                    active
                      ? `${tab.accent} bg-gray-800 border border-current`
                      : 'text-gray-500 hover:text-gray-300 border border-transparent'
                  }`}
                  title={`Show ${tab.label.toLowerCase()} entries`}
                >
                  {tab.label} {tab.count > 0 && <span className="opacity-60">{tab.count}</span>}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {/* Maximize / restore — grows the panel so long logs aren't cut off */}
          <button
            onClick={toggleThoughtLogExpanded}
            className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-gray-300 font-mono text-xs transition-colors"
            title={thoughtLogExpanded ? 'Restore size' : 'Expand'}
            aria-label={thoughtLogExpanded ? 'Restore log size' : 'Expand log'}
          >
            {thoughtLogExpanded ? '⤡' : '⤢'}
          </button>
          {/* Minimize */}
          <button
            onClick={toggleMinimize}
            className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-gray-300 font-mono text-xs transition-colors"
            title="Minimize"
          >
            _
          </button>
          {/* Clear — only clears entries, never cancels an active research run */}
          <button
            onClick={() => {
              if (activeTab === 'research') clearThoughtEntries();
              else if (activeTab === 'collaboration') clearCollaborationEntries();
              else {
                clearThoughtEntries();
                clearCollaborationEntries();
              }
            }}
            className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-gray-300 font-mono text-xs transition-colors"
            title="Clear log (current tab)"
          >
            C
          </button>
          {/* Close */}
          <button
            onClick={() => setThoughtLogOpen(false)}
            className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-red-400 font-mono text-xs font-bold transition-colors"
            title="Close"
          >
            X
          </button>
        </div>
      </div>

      {/* Log entries */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-1 font-mono text-xs leading-relaxed min-h-0"
      >
        {unified.length === 0 ? (
          <div className="text-gray-600 py-2">
            <div>
              {activeTab === 'collaboration'
                ? 'No collaboration activity yet...'
                : activeTab === 'research'
                  ? 'No research activity yet...'
                  : 'No agent activity yet...'}
            </div>
            <div className="text-gray-600/80 mt-1">
              Visit a building and your agent starts researching. Everything it learns lands here and stays in its memory.
            </div>
          </div>
        ) : (
          unified.map((entry) => {
            if (entry.kind === 'research') {
              const config = PHASE_CONFIG[entry.phase ?? 'idle'] ?? PHASE_CONFIG.idle;
              return (
                <div key={entry.id} className="flex gap-2 py-0.5">
                  <span className="text-gray-600 shrink-0 tabular-nums">[{formatTime(entry.timestamp)}]</span>
                  <span className={`${config.color} shrink-0 w-14 text-right font-bold`}>
                    {config.label}
                  </span>
                  <span className="text-gray-300 min-w-0 break-words">{entry.message}</span>
                </div>
              );
            }

            // Collaboration entry
            const cfg = COLLAB_TYPE_CONFIG[entry.collabType ?? 'request'];
            const source = entry.sourceBuildingId ?? '';
            const target = entry.targetBuildingId ?? '';
            const duration = entry.durationMs ? ` (${entry.durationMs}ms)` : '';
            let body = '';
            if (entry.collabType === 'request') {
              body = `${source} → ${target}: "${entry.question ?? ''}"`;
            } else if (entry.collabType === 'response') {
              body = `${target}${duration}: ${entry.response ?? ''}`;
            } else if (entry.collabType === 'merged') {
              body = `${source}: ${entry.response ?? ''}${duration}`;
            } else {
              body = `${source} → ${target}: ${entry.response ?? 'unknown error'}`;
            }

            return (
              <div key={entry.id} className="flex gap-2 py-0.5">
                <span className="text-gray-600 shrink-0 tabular-nums">[{formatTime(entry.timestamp)}]</span>
                <span className={`${cfg.color} shrink-0 w-14 text-right font-bold`}>
                  {cfg.label}
                </span>
                <span className="text-gray-300 min-w-0 break-words">{body}</span>
              </div>
            );
          })
        )}
      </div>

      {/* Persistent hint: the log is the agent's memory, askable once it's running */}
      <div className="px-4 py-1 border-t border-green-500/10 shrink-0 flex items-start gap-2">
        <span aria-hidden className="text-green-400/70 text-xs shrink-0">🧠</span>
        <span className="text-green-300/50 font-mono text-[10px] leading-snug">
          Your agent saves everything it researches here to its memory. Once it is connected and running, you can ask it about anything in this log.
        </span>
      </div>

      {/* Progress bar (research only) */}
      {isResearching && progress > 0 && (
        <div className="px-4 py-1 shrink-0">
          <div className="w-full bg-gray-800 rounded-full h-1.5">
            <div
              className="bg-green-500 h-1.5 rounded-full transition-all duration-500"
              style={{ width: `${Math.min(progress, 100)}%` }}
            />
          </div>
          <div className="text-gray-500 font-mono text-[10px] mt-0.5 text-right">
            {progress}%
          </div>
        </div>
      )}
    </div>
  );
}
