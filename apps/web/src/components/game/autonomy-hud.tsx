'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AutonomyStatusThought } from '@clawville/shared';
import { api } from '@/lib/api';
import { useGameStore, type GameState } from '@/stores/game';
import { useShortTouchRow } from '@/hooks/use-short-touch-viewport';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { SHORT_TOUCH_AUTONOMY_MAX_HEIGHT_CSS } from '@/lib/hud-anchors';
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
  const shortTouch = useShortTouchRow() !== null;
  const isMobile = useIsMobile();
  const chatOpen = useGameStore((s: GameState) => s.chatOpen || s.guideChatOpen);
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
  // On a short touch screen the panel sits where an open chat panel draws;
  // the chat wins while it is open (Codex review 2026-09-18).
  if (shortTouch && chatOpen) return null;

  const elapsed = sessionStartedAt ? Math.max(0, Math.floor((now - sessionStartedAt) / 1_000)) : 0;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const phaseText = formatAutonomyPhase(status, statusQuery.isError);
  const arrivals = countAutonomyArrivals(thoughts);

  return (
    // On a short touch screen (a phone held sideways) `bottom-[17rem]` put the
    // panel's bottom at y ~118 of 390, so it ran off the top of the screen over
    // the minimap and the top-centre stack, and it would cover the utility row
    // at the left. There it sits at the RIGHT under Nori (Hold Jump is hidden in
    // Autonomous mode), narrow enough to clear the centred mode toggle and quest
    // card (up to ~220 px) and short enough to end 8 px above the camera joystick (top
    // vh - 220), scrolling inside (2026-09-18).
    <div
      className={shortTouch
        ? 'fixed z-50 pointer-events-auto overflow-y-auto rounded-lg'
        : isMobile
        // Other touch screens: the panel grows UP from bottom 17rem, and a full
        // wallet + thought feed reached y ~95 at 375x667 (over the phone Map
        // button, the mode toggle and the quest card, to y ~170) and covered
        // the full minimap card on iPads (to y 282). Cap it to end 8 px below
        // those (below `md`: y 180; from `md`, where the card shows: y 290)
        // and scroll inside (Codex review 2026-09-18).
        ? 'fixed bottom-[17rem] left-4 z-50 pointer-events-auto w-80 max-w-[calc(100vw-2rem)] overflow-y-auto max-h-[calc(100dvh-452px)] md:max-h-[calc(100dvh-562px)]'
        : 'fixed bottom-[17rem] left-4 z-50 pointer-events-auto w-80 max-w-[calc(100vw-2rem)]'}
      style={shortTouch
        ? {
            top: 70,
            right: 'calc(env(safe-area-inset-right, 0px) + 16px)',
            width: 'min(320px, calc(50vw - 134px - env(safe-area-inset-right, 0px)))',
            maxHeight: SHORT_TOUCH_AUTONOMY_MAX_HEIGHT_CSS,
          }
        : undefined}
    >
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
          // flex-wrap: on a short touch screen the panel is ~150-200 px wide and
          // the two no-wrap fields go on two lines instead of being clipped.
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 px-3 py-1.5 border-b border-cyan-500/10 text-[10px] font-mono">
            <span className="text-white/80 whitespace-nowrap">
              Balance: {wallet.balance.toLocaleString()} vCLAW
            </span>
            <span>
              <span className="text-green-400 whitespace-nowrap">Today: +{wallet.earnedToday}</span>
              <span className="text-white/40"> / </span>
              <span className="text-red-300 whitespace-nowrap">−{wallet.spentToday}</span>
              <span className="text-white/40 whitespace-nowrap"> vCLAW</span>
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
