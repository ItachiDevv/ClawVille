'use client';

/**
 * HudPlacement — large rank chip ("PLACEMENT #3") in the top-right corner.
 * Spec: frontend-spec.md §3.4 + §3.2 wireframe.
 */

export interface HudPlacementProps {
  /** 1-indexed rank, or null if not yet known. */
  rank: number | null;
  total: number;
  highlight?: boolean;
}

function getMedalEmoji(rank: number): string {
  switch (rank) {
    case 1:
      return '🥇';
    case 2:
      return '🥈';
    case 3:
      return '🥉';
    default:
      return '';
  }
}

export default function HudPlacement({ rank, total, highlight = false }: HudPlacementProps) {
  const display = rank ?? '–';
  const medal = rank ? getMedalEmoji(rank) : '';
  const isPodium = rank !== null && rank <= 3;
  const accent = isPodium ? '#facc15' : '#00E5FF';
  const glow = isPodium ? 'rgba(250, 204, 21, 0.45)' : 'rgba(0, 229, 255, 0.35)';

  return (
    <div
      className={`claw-panel ${highlight ? 'animate-pulse' : ''}`}
      style={{
        padding: '10px 16px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        minWidth: 140,
        borderColor: accent,
        boxShadow: `0 0 24px ${glow}, inset 0 1px 0 rgba(255, 255, 255, 0.08)`,
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
          fontSize: 10,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: 'rgba(148, 163, 184, 0.85)',
          fontWeight: 700,
        }}
      >
        Placement
      </span>
      <span
        style={{
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
          fontSize: 32,
          fontWeight: 900,
          lineHeight: 1,
          color: accent,
          textShadow: `0 0 14px ${glow}`,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {medal && <span style={{ fontSize: 24 }}>{medal}</span>}
        #{display}
      </span>
      <span
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 10,
          color: 'rgba(148, 163, 184, 0.85)',
          letterSpacing: '0.08em',
        }}
      >
        of {total}
      </span>
    </div>
  );
}
