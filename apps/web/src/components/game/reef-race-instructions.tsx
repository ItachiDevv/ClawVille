'use client';

/**
 * ReefRaceInstructions — pre-match overlay for the Reef Race activity.
 * Sibling of `bumper-shells-instructions.tsx`. Renders during the
 * `pregame-countdown` phase so first-time racers know the controls
 * before the gantry lights drop.
 *
 * Auto-dismisses on:
 *   - matchPhase transitioning to 'live' (parent conditional)
 *   - first WASD/arrow/joystick input
 *   - GOT IT button tap
 */

import { useEffect, useState } from 'react';
import { useIsMobile } from '@/hooks/use-is-mobile';

interface ReefRaceInstructionsProps {
  /** Seconds remaining in the countdown — drives the urgency text. */
  countdownSecondsRemaining: number;
}

export default function ReefRaceInstructions({
  countdownSecondsRemaining,
}: ReefRaceInstructionsProps) {
  const isMobile = useIsMobile();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (dismissed) return;
    function onAnyInput(e: KeyboardEvent | TouchEvent | MouseEvent) {
      if (e.type === 'keydown') {
        const code = (e as KeyboardEvent).code;
        if (
          code !== 'KeyW' &&
          code !== 'KeyA' &&
          code !== 'KeyS' &&
          code !== 'KeyD' &&
          code !== 'ArrowUp' &&
          code !== 'ArrowDown' &&
          code !== 'ArrowLeft' &&
          code !== 'ArrowRight' &&
          code !== 'Space'
        ) {
          return;
        }
      }
      setDismissed(true);
    }
    window.addEventListener('keydown', onAnyInput);
    window.addEventListener('touchstart', onAnyInput, { passive: true });
    return () => {
      window.removeEventListener('keydown', onAnyInput);
      window.removeEventListener('touchstart', onAnyInput);
    };
  }, [dismissed]);

  if (dismissed) return null;

  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        top: isMobile ? '18%' : '24%',
        transform: 'translateX(-50%)',
        width: 'min(560px, 92vw)',
        background: 'rgba(6, 28, 22, 0.88)',
        border: '1px solid rgba(110, 231, 183, 0.45)',
        borderRadius: 12,
        padding: isMobile ? '14px 16px' : '20px 24px',
        color: '#dcfce7',
        fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.5), 0 0 28px rgba(34, 197, 94, 0.18)',
        zIndex: 30,
        pointerEvents: 'auto',
        backdropFilter: 'blur(6px)',
      }}
      role="dialog"
      aria-label="How to play Reef Race"
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 10,
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: isMobile ? 13 : 15,
            letterSpacing: '0.18em',
            color: '#6ee7b7',
            fontWeight: 800,
          }}
        >
          REEF RACE
        </h2>
        <span
          style={{
            fontSize: 11,
            letterSpacing: '0.14em',
            color: '#fbbf24',
            fontWeight: 700,
          }}
        >
          STARTS IN {countdownSecondsRemaining}s
        </span>
      </div>

      <ul
        style={{
          margin: 0,
          padding: 0,
          listStyle: 'none',
          display: 'grid',
          gap: isMobile ? 6 : 8,
          fontSize: isMobile ? 12 : 13,
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          letterSpacing: 0,
          lineHeight: 1.45,
          color: '#ecfdf5',
        }}
      >
        <Row
          glyph={isMobile ? '🕹' : '⌨'}
          label={isMobile ? 'Left joystick' : 'WASD or Arrows'}
          desc="Steer your kart"
        />
        <Row
          glyph={isMobile ? 'A' : '⎵'}
          label={isMobile ? 'Right A button' : 'Space'}
          desc="Boost (when held with input)"
        />
        <Row
          glyph={isMobile ? 'B' : 'Q'}
          label={isMobile ? 'Right B button' : 'Q (or click)'}
          desc="Use a power-up from your slots"
        />
        <Row
          glyph="🏁"
          label="Goal"
          desc="2 laps. First past the line wins."
        />
        <Row
          glyph="📦"
          label="Pickups"
          desc="Hit the boxes for boosts and power-ups."
        />
      </ul>

      <button
        type="button"
        onClick={() => setDismissed(true)}
        data-hud-interactive="true"
        style={{
          marginTop: 14,
          width: '100%',
          padding: '10px 12px',
          background: 'rgba(34, 197, 94, 0.18)',
          border: '1px solid rgba(110, 231, 183, 0.55)',
          borderRadius: 8,
          color: '#6ee7b7',
          fontFamily: 'inherit',
          fontWeight: 700,
          fontSize: 11,
          letterSpacing: '0.16em',
          cursor: 'pointer',
        }}
        aria-label="Dismiss instructions"
      >
        GOT IT
      </button>
    </div>
  );
}

function Row({ glyph, label, desc }: { glyph: string; label: string; desc: string }) {
  return (
    <li style={{ display: 'grid', gridTemplateColumns: '36px 1fr', alignItems: 'center', gap: 12 }}>
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 30,
          height: 30,
          borderRadius: 7,
          background: 'rgba(110, 231, 183, 0.14)',
          border: '1px solid rgba(110, 231, 183, 0.32)',
          color: '#6ee7b7',
          fontSize: 14,
          fontWeight: 800,
        }}
      >
        {glyph}
      </span>
      <span>
        <strong style={{ color: '#fff', fontWeight: 700 }}>{label}</strong>
        <span style={{ opacity: 0.85 }}> — {desc}</span>
      </span>
    </li>
  );
}
