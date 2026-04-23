'use client';

/**
 * PingIndicator — colored dot + ms latency. Spec: frontend-spec.md §3.4.
 * Wraps `<HudTile>` so it inherits the same chrome.
 */

import HudTile, { type HudTileTone } from './HudTile';

export interface PingIndicatorProps {
  ms: number;
}

function toneFor(ms: number): HudTileTone {
  if (ms <= 0) return 'neutral'; // not yet measured
  if (ms < 60) return 'success';
  if (ms < 120) return 'neutral';
  if (ms < 200) return 'warning';
  return 'danger';
}

function dotColor(tone: HudTileTone): string {
  switch (tone) {
    case 'success':
      return '#86efac';
    case 'warning':
      return '#fde68a';
    case 'danger':
      return '#fca5a5';
    case 'gold':
      return '#facc15';
    default:
      return '#00E5FF';
  }
}

export default function PingIndicator({ ms }: PingIndicatorProps) {
  const tone = toneFor(ms);
  const display = ms <= 0 ? '—' : `${Math.round(ms)}ms`;
  return (
    <HudTile
      label="Ping"
      value={display}
      tone={tone}
      icon={
        <span
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: dotColor(tone),
            boxShadow: `0 0 6px ${dotColor(tone)}`,
          }}
        />
      }
    />
  );
}
