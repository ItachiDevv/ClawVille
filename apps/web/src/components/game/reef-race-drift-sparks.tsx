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

  const label = sparks > 0 ? 'RELEASE SHIFT: BOOST' : 'HOLD SHIFT + TURN';
  const hint = sparks > 0
    ? `${sparks}/3 boost charge`
    : 'build sparks, then release';

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 82,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        alignItems: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          borderRadius: 999,
          border: `1px solid ${sparks > 0 ? '#ff980088' : '#ffffff22'}`,
          background: 'rgba(0, 0, 0, 0.5)',
          padding: '5px 9px',
          boxShadow: sparks > 0 ? '0 0 16px #ff980033' : 'none',
        }}
      >
        <div
          style={{
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: '0.12em',
            color: sparks > 0 ? '#ffd166' : '#ffffff99',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
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
                boxShadow: lit ? `0 0 8px ${SPARK_FILL[i]}` : 'none',
                transition: 'background 0.1s, box-shadow 0.1s, border-color 0.1s',
              }}
            />
          );
        })}
      </div>
      <div style={{ fontSize: 8, color: '#ffffff66', letterSpacing: '0.08em' }}>
        {hint}
      </div>
    </div>
  );
}
