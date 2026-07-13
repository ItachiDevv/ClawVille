'use client';

/**
 * reef-race-miniturbo-meter.tsx
 *
 * v2 mechanics (2026-07-10) — self-only mini-turbo charge meter. The signature
 * "surf whip" verb: sustained hard carving CHARGES a meter over ticks; on
 * release it fires a tiered boost (see `event.mini_turbo_fire` handling in
 * `ReefRacePlayer.tsx` + the toast in `reef-race-event-toasts.tsx`).
 *
 * WORLD↔BACKEND↔UI parity: reads `entities.get(selfAvatarId)?.miniTurboCharge`
 * / `.miniTurboLevel` — the SAME server-forwarded fields `ReefRaceScene.tsx`
 * ORs into `boostActive` for the in-world trail FX. No client-side guessing.
 *
 * FEATURE_GATE-style honesty: renders NOTHING until the server actually sends
 * `miniTurboCharge` for the self avatar (checked via `typeof === 'number'`,
 * not just truthy — a real 0 must still render). This is deliberate: a bar
 * frozen at 0% forever (before the sim wires the per-tick broadcast) would be
 * scaffolding theater. The moment the sim's `broadcastDelta` includes
 * `miniTurboCharge` in `changed`, this activates with zero further client
 * changes.
 *
 * Constraints:
 *   - NO drei Text/Billboard (Iris Xe ban) — DOM-only overlay.
 *   - Primitive-shaped selector (single object read, only re-renders on
 *     actual charge/level change via the Map identity from applyEntityDelta).
 *   - pointerEvents: none — click-through to 3D canvas.
 */

import { useActivityStore } from '@/stores/activity';
import type { ReefRaceEntity } from '@/lib/three/activities/reef-race/reef-race-types';

// Tier color ramp — dim track → cyan (tier 1) → hot orange (tier 2, "READY").
const TRACK_COLOR = 'rgba(255,255,255,0.10)';
const TIER_COLORS: Record<0 | 1 | 2, { fill: string; glow: string; label: string }> = {
  0: { fill: '#5ce1ff88', glow: '#5ce1ff33', label: 'CHARGE' },
  1: { fill: '#5ce1ff', glow: '#5ce1ff88', label: 'MINI-TURBO' },
  2: { fill: '#ff5e2b', glow: '#ff5e2bcc', label: 'SUPER READY' },
};

export default function ReefRaceMiniTurboMeter() {
  const matchPhase   = useActivityStore((s) => s.matchPhase);
  const selfAvatarId = useActivityStore((s) => s.selfAvatarId);
  const self = useActivityStore((s) =>
    selfAvatarId ? (s.entities.get(selfAvatarId) as ReefRaceEntity | undefined) : undefined,
  );

  if (matchPhase !== 'live') return null;
  // Undefined = the server hasn't wired this field for this session yet —
  // hide rather than show a fake empty bar (no scaffolding theater).
  if (typeof self?.miniTurboCharge !== 'number') return null;

  const charge = Math.max(0, Math.min(1, self.miniTurboCharge));
  const level = (self.miniTurboLevel ?? 0) as 0 | 1 | 2;
  const tier = TIER_COLORS[level];
  const pct = Math.round(charge * 100);

  return (
    <div
      style={{
        position: 'relative',
        width: 180,
        height: 10,
        background: TRACK_COLOR,
        border: `1px solid ${tier.fill}55`,
        borderRadius: 6,
        overflow: 'hidden',
        boxShadow: charge > 0 ? `0 0 10px ${tier.glow}` : 'none',
        transition: 'box-shadow 150ms ease-out',
      }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={`Mini-turbo charge ${pct}%`}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          bottom: 0,
          width: `${pct}%`,
          background: tier.fill,
          transition: 'width 80ms linear, background 120ms ease-out',
        }}
      />
      {/* Tier label — only shown once charging has started, so idle HUD stays clean. */}
      {charge > 0 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 8,
            fontWeight: 800,
            letterSpacing: '0.14em',
            color: '#ffffff',
            textShadow: '0 1px 2px rgba(0,0,0,0.85)',
            fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
          }}
        >
          {tier.label}
        </div>
      )}
    </div>
  );
}
