'use client';

/**
 * ReefRaceStreakCounter — Phase 4 (C-IMPL-3 fix 2026-04-25).
 *
 * Small chip that surfaces the consecutive-clean-checkpoint streak the
 * server tracks per body. Without this surface, the +25 perfect-lap bonus
 * (credited at streak ≥ 24) is a black-box reward — players don't see the
 * counter climb so they can't tell why they got the bonus.
 *
 * Subscribes to a single primitive store field (`s.selfStreak`) so the
 * per-tick `EntityDelta.changed.streak` updates don't fan out a Map
 * subscription. Tier kind comes from the SHARED helper
 * `streakMilestoneKind` (server + client both import it from
 * `@clawville/shared/activities/reef-race-streak`) so glow tiers stay in
 * sync with the server's `event.streak_milestone` edge-trigger broadcasts.
 *
 * Reset flash (200ms) — when the streak drops to 0 (a "dirty" hairpin
 * crossing), a brief amber flash gives the player kinaesthetic feedback
 * that they just lost the streak. Without the flash, the reset is silent
 * and the player may not connect the cause to the consequence.
 *
 * Spec: `.claude/plans/reef-race-phase4-detailed.md` §3.5.
 */

import { useEffect, useRef, useState } from 'react';
import { useActivityStore } from '@/stores/activity';
import {
  STREAK_MILESTONES,
  TOTAL_CHECKPOINTS_PER_RACE,
  streakMilestoneKind,
  type StreakMilestoneKind,
} from '@clawville/shared';

// ─── Tier-keyed style table ────────────────────────────────────────────────
//
// Indexed by `streakMilestoneKind(streak)` — keep in sync if the shared
// enum gains tiers. Each tier carries (border, color, glow, label).

interface TierStyle {
  border: string;
  color: string;
  glow: string;
  label: string;
}

const TIER_STYLES: Record<StreakMilestoneKind, TierStyle> = {
  'tier-1': {
    border: '#fbbf2455',
    color: '#fbbf24',
    glow: '0 0 8px #fbbf2433',
    label: 'Streak warming up',
  },
  'tier-2': {
    border: '#fb923c88',
    color: '#fb923c',
    glow: '0 0 12px #fb923c66',
    label: 'Streak heating',
  },
  'tier-3': {
    border: '#f87171aa',
    color: '#fca5a5',
    glow: '0 0 16px #f8717188',
    label: 'Streak hot',
  },
  'tier-4': {
    border: '#a78bfaaa',
    color: '#c4b5fd',
    glow: '0 0 20px #a78bfaaa',
    label: 'Streak elite',
  },
  perfect: {
    border: '#67e8f9',
    color: '#67e8f9',
    glow: '0 0 24px #67e8f9, 0 0 48px #c084fc88',
    label: 'PERFECT — perfect-lap bonus locked',
  },
};

// ─── Component ─────────────────────────────────────────────────────────────

export default function ReefRaceStreakCounter() {
  // Single primitive subscription — no Map, no per-tick fanout.
  const streak = useActivityStore((s) => s.selfStreak);
  const matchPhase = useActivityStore((s) => s.matchPhase);

  // Reset flash — fires for 200ms when streak drops to 0 from > 0.
  const prevStreakRef = useRef<number>(streak);
  const [resetFlash, setResetFlash] = useState(false);
  useEffect(() => {
    const prev = prevStreakRef.current;
    prevStreakRef.current = streak;
    if (prev > 0 && streak === 0) {
      setResetFlash(true);
      const id = setTimeout(() => setResetFlash(false), 200);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [streak]);

  // Don't render outside a live match — the chip is racing-only.
  if (matchPhase !== 'live') return null;
  // First checkpoint hasn't been crossed yet — keep the HUD clean.
  if (streak <= 0) {
    if (!resetFlash) return null;
  }

  const tier = streakMilestoneKind(streak);
  const style = TIER_STYLES[tier];
  const isMilestone = (STREAK_MILESTONES as readonly number[]).includes(streak);
  const isPerfect = streak >= TOTAL_CHECKPOINTS_PER_RACE;

  return (
    <div
      title={style.label}
      aria-label={`Clean checkpoint streak: ${streak}`}
      data-streak-tier={tier}
      data-streak-milestone={isMilestone ? '1' : '0'}
      style={{
        background: resetFlash
          ? 'rgba(252, 165, 165, 0.18)'
          : 'rgba(0, 0, 0, 0.65)',
        border: `1px solid ${resetFlash ? '#fca5a5aa' : style.border}`,
        borderRadius: 6,
        padding: '5px 10px',
        textAlign: 'center',
        minWidth: 80,
        boxShadow: resetFlash ? '0 0 12px #fca5a566' : style.glow,
        transition: 'box-shadow 180ms ease-out, border-color 180ms ease-out',
        animation: isMilestone && !resetFlash ? 'reefStreakPulse 480ms ease-out' : undefined,
      }}
    >
      <div
        style={{
          fontSize: 9,
          letterSpacing: '0.15em',
          color: resetFlash ? '#fca5a5cc' : `${style.color}99`,
        }}
      >
        STREAK
      </div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 700,
          fontVariantNumeric: 'tabular-nums',
          color: resetFlash ? '#fca5a5' : style.color,
          textShadow: isPerfect ? '0 0 8px #67e8f9aa' : undefined,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          lineHeight: 1.1,
        }}
      >
        <span aria-hidden style={{ fontSize: 12 }}>{isPerfect ? '✨' : '⚡'}</span>
        {streak}
      </div>
      <style jsx>{`
        @keyframes reefStreakPulse {
          0%   { transform: scale(1); }
          40%  { transform: scale(1.18); }
          100% { transform: scale(1); }
        }
      `}</style>
    </div>
  );
}
