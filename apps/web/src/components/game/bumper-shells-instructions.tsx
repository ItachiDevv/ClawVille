'use client';

/**
 * BumperShellsInstructions — pre-match overlay shown during the
 * `pregame-countdown` phase so first-time players know how to play
 * before the round starts. Mounts inside `BumperShellsHud`.
 *
 * Auto-dismisses when:
 *   - matchPhase transitions to 'live' (handled by parent conditional)
 *   - User taps DISMISS, hits any movement key, or moves the joystick
 *
 * Why a dedicated overlay (not a modal): we want zero clicks required
 * to start playing, and we want it visually subordinate to the
 * countdown numerals so it doesn't hide them.
 */

import { useEffect, useState } from 'react';
import { useIsMobile } from '@/hooks/use-is-mobile';

interface BumperShellsInstructionsProps {
  /** Seconds remaining in the countdown — drives the urgency text. */
  countdownSecondsRemaining: number;
}

export default function BumperShellsInstructions({
  countdownSecondsRemaining,
}: BumperShellsInstructionsProps) {
  const isMobile = useIsMobile();
  const [dismissed, setDismissed] = useState(false);

  // Dismiss on first input — don't fight the player who already knows.
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
        background: 'rgba(8, 18, 36, 0.88)',
        border: '1px solid rgba(125, 211, 252, 0.45)',
        borderRadius: 12,
        padding: isMobile ? '14px 16px' : '20px 24px',
        color: '#dbeafe',
        fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.5), 0 0 28px rgba(56, 189, 248, 0.18)',
        zIndex: 30,
        pointerEvents: 'auto',
        backdropFilter: 'blur(6px)',
      }}
      role="dialog"
      aria-label="How to play Bumper Shells"
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
            color: '#7dd3fc',
            fontWeight: 800,
          }}
        >
          BUMPER SHELLS
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
          color: '#e0f2fe',
        }}
      >
        <Row
          glyph={isMobile ? '🕹' : '⌨'}
          label={isMobile ? 'Left joystick' : 'WASD or Arrows'}
          desc="Move your shell"
        />
        <Row
          glyph={isMobile ? 'A' : '⎵'}
          label={isMobile ? 'Right A button' : 'Space'}
          desc="Boost (ram opponents harder)"
        />
        <Row
          glyph={isMobile ? 'B' : 'Q'}
          label={isMobile ? 'Right B button' : 'Q (or click)'}
          desc="Use a power-up from your slots"
        />
        <Row
          glyph="🥇"
          label="Goal"
          desc="Knock the others off the disc — last shell standing wins."
        />
        <Row
          glyph="⚠"
          label="Watch the red ring"
          desc="That's the danger zone. Cross the edge and you're out."
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
          background: 'rgba(56, 189, 248, 0.18)',
          border: '1px solid rgba(125, 211, 252, 0.55)',
          borderRadius: 8,
          color: '#7dd3fc',
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
          background: 'rgba(125, 211, 252, 0.14)',
          border: '1px solid rgba(125, 211, 252, 0.32)',
          color: '#7dd3fc',
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
