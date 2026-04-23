'use client';

/**
 * HudTile — small top-corner status pill for ping / fps / round timer.
 * Spec: frontend-spec.md §3.4. RPG style (claw-panel + Orbitron).
 */

import type { ReactNode } from 'react';

export type HudTileTone = 'neutral' | 'success' | 'warning' | 'danger' | 'gold';

export interface HudTileProps {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  tone?: HudTileTone;
}

const TONE_TO_CSS: Record<HudTileTone, { border: string; glow: string; valueColor: string }> = {
  neutral: {
    border: 'rgba(0, 229, 255, 0.4)',
    glow: 'rgba(0, 229, 255, 0.18)',
    valueColor: '#e0f2fe',
  },
  success: {
    border: 'rgba(0, 230, 118, 0.45)',
    glow: 'rgba(0, 230, 118, 0.22)',
    valueColor: '#86efac',
  },
  warning: {
    border: 'rgba(255, 215, 0, 0.5)',
    glow: 'rgba(255, 215, 0, 0.22)',
    valueColor: '#fde68a',
  },
  danger: {
    border: 'rgba(255, 82, 82, 0.5)',
    glow: 'rgba(255, 82, 82, 0.22)',
    valueColor: '#fca5a5',
  },
  gold: {
    border: 'rgba(255, 215, 0, 0.6)',
    glow: 'rgba(255, 215, 0, 0.28)',
    valueColor: '#facc15',
  },
};

export default function HudTile({ label, value, icon, tone = 'neutral' }: HudTileProps) {
  const t = TONE_TO_CSS[tone];
  return (
    <div
      className="claw-panel"
      style={{
        padding: '8px 12px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        borderColor: t.border,
        boxShadow: `0 0 14px ${t.glow}, inset 0 1px 0 rgba(255, 255, 255, 0.05)`,
        pointerEvents: 'none',
      }}
    >
      {icon ? (
        <span aria-hidden style={{ fontSize: 14, lineHeight: 1, color: t.valueColor }}>
          {icon}
        </span>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, lineHeight: 1.05 }}>
        <span
          style={{
            fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
            fontSize: 9,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'rgba(148, 163, 184, 0.85)',
            fontWeight: 700,
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
            fontSize: 14,
            fontWeight: 700,
            color: t.valueColor,
            textShadow: `0 0 10px ${t.glow}`,
          }}
        >
          {value}
        </span>
      </div>
    </div>
  );
}
