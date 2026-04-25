'use client';

/**
 * Reef Race Phase 1 — drift-charge spark indicator.
 *
 * Three dots that fill orange → red → blue as the player holds drift in a
 * corner. Subscribes to `useActivityStore(s => s.driftSparks)` — primitive
 * number → Object.is equality means re-renders fire only on tier changes.
 *
 * Spec: `.claude/plans/reef-race-phase1-detailed.md` §5.2.
 *
 * Mounted by `<ReefRaceHud>` above the existing `<PowerUpBar>` (bottom: 80px)
 * so both bottom-center HUD elements stack cleanly without overlap.
 */

import { useActivityStore } from '@/stores/activity';

const SPARK_FILL   = ['#ff9800', '#f44336', '#2979ff'] as const; // orange · red · blue
const SPARK_BORDER = SPARK_FILL;

export default function ReefRaceDriftSparks() {
  const matchPhase = useActivityStore((s) => s.matchPhase);
  const sparks     = useActivityStore((s) => s.driftSparks);

  // Drift only matters mid-race. Pregame countdown + ended overlays own
  // the screen real estate — keep this hidden outside of LIVE.
  if (matchPhase !== 'live') return null;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 80,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          fontSize: 9,
          letterSpacing: '0.15em',
          color: '#ffffff66',
          marginRight: 4,
        }}
      >
        DRIFT
      </div>
      {[0, 1, 2].map((i) => {
        const lit = i < sparks;
        return (
          <div
            key={i}
            style={{
              width: 14,
              height: 14,
              borderRadius: '50%',
              border: `2px solid ${lit ? SPARK_BORDER[i] : '#ffffff33'}`,
              background: lit ? SPARK_FILL[i] : 'transparent',
              boxShadow: lit ? `0 0 6px ${SPARK_FILL[i]}` : 'none',
              transition: 'background 0.1s, box-shadow 0.1s, border-color 0.1s',
            }}
          />
        );
      })}
    </div>
  );
}
