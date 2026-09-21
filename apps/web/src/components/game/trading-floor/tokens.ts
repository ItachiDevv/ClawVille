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

// Founder order, 2026-09-20: "users in game right now to allow them to trade or launch a trading agent is coming soon. they still get to monitor our house agents which is genesis and runner".
export const TRADING_SELF_SERVE_ENABLED = false;
export const TRADING_SELF_SERVE_COMING_SOON = 'Coming soon';
export const TRADING_SELF_SERVE_WALLET_EXPLANATION =
  'Trading from your own wallet opens soon. The house traders below are live now.';
export const TRADING_SELF_SERVE_AGENT_EXPLANATION =
  'Launching your own trader opens soon. You can watch Genesis and ClawVille Runner below.';
