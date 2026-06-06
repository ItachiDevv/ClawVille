'use client';

/**
 * ChipStack — polished chip stack for Hold'em felt.
 *
 * Phase 6.5.0: prop shape matches holdem-types.ts ChipStackProps — drop-in
 * replacement for the inline stub in HoldemModal.tsx (6.5.1).
 *
 * Props: { amount: number; inline?: boolean }
 *   inline=true → compact single-line display (used inside seat label panels)
 *   inline=false → stacked disc layout (used for bet-out amounts)
 *
 * Iris Xe safe: pure React/CSS.
 */

import type { ChipStackProps } from '@/lib/cove/holdem-types';

function formatAmount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function chipColor(amount: number): { bg: string; border: string } {
  if (amount < 50)   return { bg: '#c0202c', border: '#8a1520' };
  if (amount < 500)  return { bg: '#1a7a3a', border: '#115228' };
  if (amount < 5000) return { bg: '#1a4a9a', border: '#0f3070' };
  return { bg: '#1a1a1a', border: '#444' };
}

function discCount(amount: number): number {
  if (amount <= 0)    return 0;
  if (amount < 20)    return 1;
  if (amount < 100)   return 2;
  if (amount < 500)   return 3;
  if (amount < 2000)  return 4;
  return 5;
}

export default function ChipStack({ amount, inline = false }: ChipStackProps) {
  if (inline) {
    return (
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 11,
        fontFamily: 'monospace',
        color: '#f59e0b',
        fontWeight: 700,
      }}>
        <span style={{ fontSize: 10, opacity: 0.7 }}>⬡</span>
        {formatAmount(amount)}
      </span>
    );
  }

  const count = discCount(amount);
  if (count === 0) return null;

  const { bg, border } = chipColor(amount);
  const DISC_H = 6;
  const DISC_W = 28;

  return (
    <div
      aria-label={`${formatAmount(amount)} chips`}
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0,
        userSelect: 'none',
      }}
    >
      <div style={{ position: 'relative', width: DISC_W, height: DISC_H * count + 2 }}>
        {Array.from({ length: count }, (_, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              top: (count - 1 - i) * DISC_H,
              left: 0,
              width: DISC_W,
              height: DISC_H + 4,
              borderRadius: '50%',
              background: bg,
              border: `1.5px solid ${border}`,
              boxShadow: '0 1px 3px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.15)',
            }}
          />
        ))}
      </div>
      <span style={{
        fontSize: 10, fontWeight: 700, fontFamily: 'monospace',
        color: '#f8fafc',
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 3,
        padding: '0 3px',
        marginTop: 2,
        lineHeight: 1.4,
      }}>
        {formatAmount(amount)}
      </span>
    </div>
  );
}
