'use client';

import { useEffect, useRef } from 'react';
import { useResearchStore } from '@/stores/research';
import { BUILDING_OPENCLAW_THEMES } from '@elizapets/shared';
import type { ResearchPhase } from '@elizapets/shared';

const PHASE_CONFIG: Record<ResearchPhase, { label: string; color: string }> = {
  idle: { label: 'IDLE', color: 'text-gray-500' },
  fetching_articles: { label: 'FETCH', color: 'text-cyan-400' },
  reading: { label: 'READ', color: 'text-green-400' },
  synthesizing: { label: 'SYNTH', color: 'text-yellow-400' },
  creating_skill: { label: 'SKILL', color: 'text-purple-400' },
  complete: { label: 'DONE', color: 'text-green-300' },
  error: { label: 'ERROR', color: 'text-red-400' },
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '--:--:--';
  }
}

export default function ThoughtLog() {
  const {
    thoughtLogOpen,
    thoughtLogMinimized,
    thoughts,
    isResearching,
    currentPhase,
    currentLocationId,
    progress,
    toggleMinimize,
    setThoughtLogOpen,
    clearThoughts,
  } = useResearchStore();

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new thoughts
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [thoughts]);

  if (!thoughtLogOpen) return null;

  const themeName = currentLocationId
    ? BUILDING_OPENCLAW_THEMES[currentLocationId]?.label ?? currentLocationId
    : 'Research';

  // Minimized: single-line bar
  if (thoughtLogMinimized) {
    return (
      <div
        className="fixed bottom-0 left-0 right-0 z-40 h-8 bg-gray-900/95 backdrop-blur-sm border-t border-green-500/30 flex items-center px-4 cursor-pointer hover:bg-gray-800/95 transition-colors"
        onClick={toggleMinimize}
      >
        <span className="text-green-400 font-mono text-xs font-bold mr-2">&gt;</span>
        <span className="text-green-300/80 font-mono text-xs">
          RESEARCH LOG — {themeName}
        </span>
        {isResearching && (
          <span className="ml-2 text-yellow-400 font-mono text-xs animate-pulse">
            [{PHASE_CONFIG[currentPhase]?.label}] {progress}%
          </span>
        )}
        <span className="ml-auto text-gray-500 font-mono text-xs">[click to expand]</span>
      </div>
    );
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 bg-gray-900/95 backdrop-blur-sm border-t border-green-500/30 flex flex-col" style={{ maxHeight: '220px' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-green-500/20 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-green-400 font-mono text-xs font-bold">&gt;</span>
          <span className="text-green-300 font-mono text-xs font-bold">
            RESEARCH LOG — {themeName}
          </span>
          {isResearching && (
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Minimize */}
          <button
            onClick={toggleMinimize}
            className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-gray-300 font-mono text-xs transition-colors"
            title="Minimize"
          >
            _
          </button>
          {/* Clear */}
          <button
            onClick={clearThoughts}
            className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-gray-300 font-mono text-xs transition-colors"
            title="Clear log"
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
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-1 font-mono text-xs leading-relaxed min-h-0">
        {thoughts.length === 0 ? (
          <div className="text-gray-600 py-2">No research activity yet...</div>
        ) : (
          thoughts.map((entry) => {
            const config = PHASE_CONFIG[entry.phase] ?? PHASE_CONFIG.idle;
            return (
              <div key={entry.id} className="flex gap-2 py-0.5">
                <span className="text-gray-600 shrink-0">[{formatTime(entry.timestamp)}]</span>
                <span className={`${config.color} shrink-0 w-12 text-right font-bold`}>
                  {config.label}
                </span>
                <span className="text-gray-300">{entry.message}</span>
              </div>
            );
          })
        )}
      </div>

      {/* Progress bar */}
      {isResearching && progress > 0 && (
        <div className="px-4 py-1 border-t border-green-500/10 shrink-0">
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
