export const FLOOR_TEXT = {
  primary: '#e2e8f0',
  accent: '#7dd3fc',
  value: '#ffffff',
  muted: 'rgba(255,255,255,0.55)',
  faint: 'rgba(255,255,255,0.40)',
  warning: '#fbbf24',
  danger: '#fca5a5',
  /** Positive realised P&L. Paired with `danger` for a loss and `muted` for
   *  exactly zero, so a break-even figure is never coloured as a gain. */
  positive: '#4ade80',
  link: '#7dd3fc',
  disabled: 'rgba(255,255,255,0.35)',
} as const;
