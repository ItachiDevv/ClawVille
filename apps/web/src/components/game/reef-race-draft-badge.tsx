'use client';

/**
 * reef-race-draft-badge.tsx
 *
 * Shows a "DRAFT" badge near the top-center of the screen when the self
 * pet is actively in another player's slipstream.
 *
 * Subscribes to:
 *   - `s.slipstreamActive` — primitive boolean (Phase 2 store field)
 *   - `s.matchPhase` — primitive string (only show during 'live')
 *
 * These are primitive selectors so this component re-renders ONLY on
 * slipstreamActive / matchPhase transitions — NOT on every entity tick.
 *
 * Design:
 *   - Positioned top-center (below the countdown overlay area).
 *   - Cyan glow border; smooth fade-in/out via CSS transition.
 *   - pointerEvents: none — click-through to 3D canvas.
 *
 * Constraints:
 *   - NO drei Text/Billboard — DOM-only overlay (Iris Xe ban).
 *   - No internal timer — server emits event.slipstream_end to clear the
 *     flag (audit S4 fix). Component has zero timer state.
 */

import { useActivityStore } from '@/stores/activity';

export default function ReefRaceDraftBadge() {
  const slipstreamActive = useActivityStore((s) => s.slipstreamActive);
  const matchPhase       = useActivityStore((s) => s.matchPhase);

  // Only show during active race.
  if (matchPhase !== 'live') return null;

  return (
    <div
      aria-label="Slipstream draft active"
      style={{
        position: 'absolute',
        top: 20,
        left: '50%',
        transform: 'translateX(-50%)',
        pointerEvents: 'none',
        // Smooth fade — CSS transition on opacity.
        opacity: slipstreamActive ? 1 : 0,
        transition: 'opacity 100ms ease-in-out',
        // Badge styling.
        background: 'rgba(0, 229, 255, 0.12)',
        border: '1.5px solid #00e5ff',
        borderRadius: 6,
        padding: '5px 14px',
        boxShadow: '0 0 12px #00e5ff66, inset 0 0 8px #00e5ff22',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        userSelect: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {/* Animated pulse dot */}
      <span
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: '#00e5ff',
          boxShadow: '0 0 6px #00e5ff',
          animation: slipstreamActive ? 'reefDraftPulse 0.8s ease-in-out infinite' : 'none',
        }}
      />
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.18em',
          color: '#00e5ff',
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
        }}
      >
        DRAFT
      </span>
      <style jsx>{`
        @keyframes reefDraftPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.5; transform: scale(1.3); }
        }
      `}</style>
    </div>
  );
}
