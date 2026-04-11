'use client';

import type { CSSProperties, ReactNode } from 'react';

/**
 * StatusChip — small inline pill for non-rarity workflow tones.
 *
 * `RarityBadge` covers the 6 rarity tiers (common/uncommon/rare/epic/
 * legendary/mythic). This primitive fills the gap for workflow / state
 * labels that don't map onto rarity — e.g. "Open", "In Progress",
 * "Submitted", "Approved", "Rejected", "Expired", "Disputed".
 *
 * Five tones: neutral (slate grey), positive (green), warning (amber),
 * danger (red), info (cyan). Sizes: sm (8px font) and md (9px font,
 * default — matches the bounty board inline original).
 *
 * Pure CSS, no dependencies. The colours are WCAG-AAA on the ClawVille
 * dark-navy HUD background (#0a1626-ish) and AA on lighter backgrounds.
 */

export type StatusChipTone = 'neutral' | 'positive' | 'warning' | 'danger' | 'info';

export type StatusChipSize = 'sm' | 'md';

export interface StatusChipProps {
  /** Label text. Shown uppercase with wide letter-spacing. */
  label: string;
  /** @default 'neutral' */
  tone?: StatusChipTone;
  /** @default 'md' */
  size?: StatusChipSize;
  /** Inline style override on the outer pill. */
  style?: CSSProperties;
  /** Optional className on the outer pill. */
  className?: string;
}

interface TonePalette {
  bg: string;
  border: string;
  color: string;
}

const TONE_PALETTE: Record<StatusChipTone, TonePalette> = {
  neutral: {
    bg: 'rgba(30, 41, 59, 0.6)',
    border: 'rgba(148, 163, 184, 0.3)',
    color: '#94a3b8',
  },
  positive: {
    bg: 'rgba(34, 197, 94, 0.12)',
    border: 'rgba(34, 197, 94, 0.45)',
    color: '#4ade80',
  },
  warning: {
    bg: 'rgba(250, 204, 21, 0.12)',
    border: 'rgba(250, 204, 21, 0.45)',
    color: '#facc15',
  },
  danger: {
    bg: 'rgba(220, 38, 38, 0.14)',
    border: 'rgba(220, 38, 38, 0.5)',
    color: '#f87171',
  },
  info: {
    bg: 'rgba(56, 189, 248, 0.12)',
    border: 'rgba(56, 189, 248, 0.4)',
    color: '#7dd3fc',
  },
};

const SIZE_STYLES: Record<
  StatusChipSize,
  { padding: string; fontSize: number; letterSpacing: string }
> = {
  sm: { padding: '1px 6px', fontSize: 8, letterSpacing: '0.1em' },
  md: { padding: '2px 8px', fontSize: 9, letterSpacing: '0.12em' },
};

export function StatusChip({
  label,
  tone = 'neutral',
  size = 'md',
  style,
  className,
}: StatusChipProps): ReactNode {
  const palette = TONE_PALETTE[tone];
  const sizing = SIZE_STYLES[size];

  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: sizing.padding,
        borderRadius: 999,
        fontSize: sizing.fontSize,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: sizing.letterSpacing,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        color: palette.color,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {label}
    </span>
  );
}
