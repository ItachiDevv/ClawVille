'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AutonomyStatusThought } from '@clawville/shared';
import { api } from '@/lib/api';
import { useGameStore, type GameState } from '@/stores/game';
import {
  countAutonomyArrivals,
  formatAutonomyPhase,
  selectCurrentAutonomyStatus,
  shouldStartAutonomyElapsed,
} from './autonomy-hud-state';

const THOUGHT_ICONS: Record<AutonomyStatusThought['type'], string> = {
  decision: '>',
  observation: '~',
  arrival: '*',
  directive: '+',
};

const THOUGHT_COLORS: Record<AutonomyStatusThought['type'], string> = {
  decision: 'text-cyan-300',
  observation: 'text-white/60',
  arrival: 'text-green-400',
  directive: 'text-yellow-300',
};

const EMPTY_THOUGHTS: AutonomyStatusThought[] = [];

export default function AutonomyHUD() {
  const controlMode = useGameStore((s: GameState) => s.controlMode);
  const statusQuery = useQuery({
    queryKey: ['autonomy-status'],
    queryFn: api.getAutonomyStatus,
    enabled: controlMode === 'autonomous',
    refetchInterval: 4_000,
    retry: false,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const previousModeRef = useRef(controlMode);
  const [modeStartedAt, setModeStartedAt] = useState<number | null>(() =>
    controlMode === 'autonomous' ? Date.now() : null,
  );
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Do not narrate a prior Autonomous session from TanStack's cache while the
  // first status poll for this mode session is in flight.
  useEffect(() => {
    if (previousModeRef.current === controlMode) return;
    previousModeRef.current = controlMode;
    setModeStartedAt(controlMode === 'autonomous' ? Date.now() : null);
    setSessionStartedAt(null);
  }, [controlMode]);

  const status = selectCurrentAutonomyStatus(
    statusQuery.data,
    statusQuery.dataUpdatedAt,
    modeStartedAt,
  );
  // A failed background poll may retain the last data object. Treat that as a
  // visible connection interruption, not as current server truth.
  const isEnrolled = status?.enrolled === true && !statusQuery.isError;
  const thoughts = isEnrolled ? status.thoughts : EMPTY_THOUGHTS;
  const wallet = isEnrolled ? status.wallet : null;

  // Session elapsed starts only once the server confirms enrollment; a cached
  // response from an earlier toggle never starts this clock.
  useEffect(() => {
    if (shouldStartAutonomyElapsed(status, statusQuery.isError, sessionStartedAt)) {
      const startedAt = Date.now();
      setSessionStartedAt(startedAt);
      setNow(startedAt);
    }
  }, [sessionStartedAt, status, statusQuery.isError]);

  useEffect(() => {
    if (controlMode !== 'autonomous' || sessionStartedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [controlMode, sessionStartedAt]);

  // Auto-scroll on new server thoughts.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [thoughts.length]);

  // Polling and rendering both stop outside Autonomous mode.
  if (controlMode !== 'autonomous') return null;

  const elapsed = sessionStartedAt ? Math.max(0, Math.floor((now - sessionStartedAt) / 1_000)) : 0;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const phaseText = formatAutonomyPhase(status, statusQuery.isError);
  const arrivals = countAutonomyArrivals(thoughts);

  return (
    <div className="fixed bottom-[17rem] left-4 z-50 pointer-events-auto w-80 max-w-[calc(100vw-2rem)]">
      <div className="rounded-lg bg-[rgba(10,22,40,0.92)] backdrop-blur-md border border-cyan-500/20 shadow-[0_0_20px_rgba(0,229,255,0.08)] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-cyan-500/10">
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full animate-pulse ${
                isEnrolled
                  ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.6)]'
                  : 'bg-yellow-300/70 shadow-[0_0_6px_rgba(253,224,71,0.35)]'
              }`}
            />
            <span className="text-cyan-300 text-xs font-bold tracking-wide uppercase">
              Autonomous
            </span>
          </div>
          <div className="text-white/30 text-[10px] font-mono">
            {mins}:{secs.toString().padStart(2, '0')}
          </div>
        </div>

        {/* Current server state */}
        <div className="px-3 py-2 border-b border-cyan-500/10">
          <div className="text-[10px] text-white/40 uppercase tracking-wider mb-0.5">
            Current state
          </div>
          <div className="text-xs text-white/80 truncate">{phaseText}</div>
        </div>

        {wallet && (
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-cyan-500/10 text-[10px] font-mono">
            <span className="text-white/80 whitespace-nowrap">
              Balance: {wallet.balance.toLocaleString()} vCLAW
            </span>
            <span className="whitespace-nowrap">
              <span className="text-green-400">Today: +{wallet.earnedToday}</span>
              <span className="text-white/40"> / </span>
              <span className="text-red-300">−{wallet.spentToday}</span>
              <span className="text-white/40"> vCLAW</span>
            </span>
          </div>
        )}

        {/* Thought Feed */}
        <div
          ref={scrollRef}
          className="max-h-40 overflow-y-auto px-3 py-2 space-y-1 scrollbar-thin scrollbar-thumb-cyan-500/20"
        >
          {thoughts.length === 0 && (
            <div className="text-white/20 text-xs font-mono">
              {isEnrolled ? 'Waiting for first decision…' : phaseText}
            </div>
          )}
          {thoughts.slice(-20).map((thought, index) => (
            <div
              key={`${thought.at}-${thought.type}-${index}`}
              className="flex gap-1.5 text-[11px] font-mono leading-tight"
            >
              <span className={`${THOUGHT_COLORS[thought.type]} shrink-0`}>
                {THOUGHT_ICONS[thought.type]}
              </span>
              <span className={THOUGHT_COLORS[thought.type]}>{thought.text}</span>
            </div>
          ))}
        </div>

        {/* Session Stats */}
        <div className="flex items-center gap-3 px-3 py-1.5 border-t border-cyan-500/10 text-[10px] text-white/40 font-mono">
          <span>Arrivals: {arrivals}</span>
          <span>State: {isEnrolled ? status.phase : 'reconnecting'}</span>
        </div>
      </div>
    </div>
  );
}
