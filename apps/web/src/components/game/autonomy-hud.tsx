'use client';

import { useEffect, useRef } from 'react';
import { useAutonomyStore, type AgentThought } from '@/stores/autonomy';
import { useGameStore, type GameState } from '@/stores/game';

const THOUGHT_ICONS: Record<AgentThought['type'], string> = {
  decision: '>',
  observation: '~',
  arrival: '*',
  reward: '+',
  idle: '.',
};

const THOUGHT_COLORS: Record<AgentThought['type'], string> = {
  decision: 'text-cyan-300',
  observation: 'text-white/60',
  arrival: 'text-green-400',
  reward: 'text-yellow-300',
  idle: 'text-white/30',
};

export default function AutonomyHUD() {
  const controlMode = useGameStore((s: GameState) => s.controlMode);
  const isActive = useAutonomyStore((s) => s.isActive);
  const thoughts = useAutonomyStore((s) => s.thoughts);
  const currentGoal = useAutonomyStore((s) => s.currentGoal);
  const tickState = useAutonomyStore((s) => s.tickState);
  const buildingsVisited = useAutonomyStore((s) => s.buildingsVisitedThisSession);
  const sessionStartedAt = useAutonomyStore((s) => s.sessionStartedAt);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new thoughts
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [thoughts.length]);

  // Only show when autonomous mode is active
  if (controlMode !== 'autonomous' || !isActive) return null;

  const elapsed = sessionStartedAt ? Math.floor((Date.now() - sessionStartedAt) / 1000) : 0;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  return (
    <div className="fixed bottom-[17rem] left-4 z-50 pointer-events-auto w-80 max-w-[calc(100vw-2rem)]">
      <div className="rounded-lg bg-[rgba(10,22,40,0.92)] backdrop-blur-md border border-cyan-500/20 shadow-[0_0_20px_rgba(0,229,255,0.08)] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-cyan-500/10">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.6)] animate-pulse" />
            <span className="text-cyan-300 text-xs font-bold tracking-wide uppercase">
              Autonomous
            </span>
          </div>
          <div className="text-white/30 text-[10px] font-mono">
            {mins}:{secs.toString().padStart(2, '0')}
          </div>
        </div>

        {/* Current Goal */}
        {currentGoal && (
          <div className="px-3 py-2 border-b border-cyan-500/10">
            <div className="text-[10px] text-white/40 uppercase tracking-wider mb-0.5">
              {tickState === 'traveling' ? 'Traveling' : tickState === 'inside' ? 'Studying' : tickState}
            </div>
            <div className="text-xs text-white/80 truncate">
              {currentGoal.description}
            </div>
          </div>
        )}

        {/* Thought Feed */}
        <div
          ref={scrollRef}
          className="max-h-40 overflow-y-auto px-3 py-2 space-y-1 scrollbar-thin scrollbar-thumb-cyan-500/20"
        >
          {thoughts.length === 0 && (
            <div className="text-white/20 text-xs font-mono">Initializing...</div>
          )}
          {thoughts.slice(-20).map((t) => (
            <div key={t.id} className="flex gap-1.5 text-[11px] font-mono leading-tight">
              <span className={`${THOUGHT_COLORS[t.type]} shrink-0`}>
                {THOUGHT_ICONS[t.type]}
              </span>
              <span className={THOUGHT_COLORS[t.type]}>{t.text}</span>
            </div>
          ))}
        </div>

        {/* Session Stats */}
        <div className="flex items-center gap-3 px-3 py-1.5 border-t border-cyan-500/10 text-[10px] text-white/40 font-mono">
          <span>Buildings: {buildingsVisited.length}/10</span>
          <span>State: {tickState}</span>
        </div>
      </div>
    </div>
  );
}
