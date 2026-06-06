'use client';

/**
 * PotDisplay — polished pot display for Hold'em felt.
 *
 * Phase 6.5.0: prop shape matches holdem-types.ts PotDisplayProps — drop-in
 * replacement for the inline stub in HoldemModal.tsx (6.5.1).
 *
 * Props: { pot: number }
 *   6.5.0 shows main pot only. Side-pot breakdown arrives in 6.5.5.
 *
 * Iris Xe safe: pure React/CSS.
 */

import type { PotDisplayProps } from '@/lib/cove/holdem-types';

function formatPot(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M CT`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k CT`;
  return `${n.toLocaleString()} CT`;
}

export default function PotDisplay({ pot }: PotDisplayProps) {
  return (
    <div
      role="status"
      aria-label={`Pot: ${pot} ClawTokens`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        userSelect: 'none',
      }}
    >
      <div style={{
        fontSize: 9,
        fontFamily: 'monospace',
        letterSpacing: '0.15em',
        color: 'rgba(60,180,100,0.55)',
        textTransform: 'uppercase',
      }}>
        POT
      </div>
      <div style={{
        fontSize: 18,
        fontWeight: 700,
        fontFamily: 'monospace',
        color: '#f59e0b',
        letterSpacing: '-0.5px',
      }}>
        {formatPot(pot)}
      </div>
    </div>
  );
}
