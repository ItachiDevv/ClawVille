'use client';

/**
 * Reef Race read-then-race instructions.
 *
 * `lobby` is the prominent, full how-to shown while matchmaking has time to
 * breathe. `countdown` is intentionally only a one-line control reminder so
 * the authoritative 3-2-1-GO and staged track remain the focus.
 */

import { useIsMobile } from '@/hooks/use-is-mobile';

interface ReefRaceInstructionsProps {
  variant: 'lobby' | 'countdown';
}

export default function ReefRaceInstructions({
  variant,
}: ReefRaceInstructionsProps) {
  const isMobile = useIsMobile();

  if (variant === 'countdown') {
    return (
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: isMobile ? '18%' : '20%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: isMobile ? 10 : 16,
          maxWidth: '92vw',
          padding: isMobile ? '7px 10px' : '8px 14px',
          border: '1px solid rgba(110, 231, 183, 0.42)',
          borderRadius: 999,
          background: 'rgba(6, 28, 22, 0.72)',
          boxShadow: '0 6px 22px rgba(0, 0, 0, 0.35)',
          color: '#ecfdf5',
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
          fontSize: isMobile ? 9 : 10,
          fontWeight: 800,
          letterSpacing: '0.08em',
          whiteSpace: 'nowrap',
          zIndex: 30,
          pointerEvents: 'none',
          backdropFilter: 'blur(5px)',
        }}
        role="note"
        aria-label="Reef Race controls"
      >
        <ControlHint glyph={isMobile ? '◉' : 'WASD'} label="STEER" />
        <ControlHint glyph={isMobile ? 'A' : 'SPACE'} label="BOOST" />
        <ControlHint glyph={isMobile ? 'B' : 'Q'} label="ITEM" />
      </div>
    );
  }

  return (
    <section
      style={{
        width: '100%',
        boxSizing: 'border-box',
        background: 'rgba(6, 28, 22, 0.78)',
        border: '1px solid rgba(110, 231, 183, 0.45)',
        borderRadius: 10,
        padding: isMobile ? '13px 14px' : '16px 18px',
        color: '#dcfce7',
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.3), 0 0 20px rgba(34, 197, 94, 0.12)',
      }}
      aria-label="How to play Reef Race"
    >
      <div
        style={{
          marginBottom: 10,
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
          fontSize: isMobile ? 12 : 13,
          letterSpacing: '0.16em',
          color: '#6ee7b7',
          fontWeight: 800,
        }}
      >
        HOW TO RACE
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
          lineHeight: 1.4,
          color: '#ecfdf5',
        }}
      >
        <Row
          glyph={isMobile ? '◉' : '⌨'}
          label={isMobile ? 'Left joystick' : 'WASD or Arrows'}
          desc="Steer your kart"
        />
        <Row
          glyph={isMobile ? 'A' : '⎵'}
          label={isMobile ? 'Right A button' : 'Space'}
          desc="Boost when held with input"
        />
        <Row
          glyph={isMobile ? 'B' : 'Q'}
          label={isMobile ? 'Right B button' : 'Q (or click)'}
          desc="Use a power-up from your slots"
        />
        <Row glyph="🏁" label="Goal" desc="2 laps. First past the line wins." />
        <Row glyph="📦" label="Pickups" desc="Hit the boxes for boosts and power-ups." />
      </ul>
    </section>
  );
}

function ControlHint({ glyph, label }: { glyph: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <b style={{ color: '#6ee7b7', letterSpacing: '0.04em' }}>{glyph}</b>
      <span style={{ color: '#ffffffcc' }}>{label}</span>
    </span>
  );
}

function Row({ glyph, label, desc }: { glyph: string; label: string; desc: string }) {
  return (
    <li style={{ display: 'grid', gridTemplateColumns: '34px 1fr', alignItems: 'center', gap: 10 }}>
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderRadius: 7,
          background: 'rgba(110, 231, 183, 0.14)',
          border: '1px solid rgba(110, 231, 183, 0.32)',
          color: '#6ee7b7',
          fontSize: 13,
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
