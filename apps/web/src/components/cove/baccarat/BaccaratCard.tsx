'use client';

/**
 * BaccaratCard — renders one playing card with suit + rank.
 *
 * Phase 6.6.1: SVG/Unicode glyph faces, no bitmaps. Mirrors BlackjackCard's
 * look. Baccarat coups are dealt + resolved server-side in one shot, so cards
 * are always revealed face-up (there is no hidden hole card like blackjack).
 *
 * Iris Xe safe: pure CSS, no Canvas, no InstancedMesh.
 */

import type { BaccaratCard as BaccaratCardType } from '@clawville/shared';

const SUIT_SYMBOL: Record<string, string> = {
  clubs:    '♣',
  diamonds: '♦',
  hearts:   '♥',
  spades:   '♠',
};

const SUIT_COLOR: Record<string, string> = {
  clubs:    '#111111',
  diamonds: '#c0202c',
  hearts:   '#c0202c',
  spades:   '#111111',
};

interface BaccaratCardProps {
  card: BaccaratCardType;
  /** Animate slide-in from top */
  slideIn?: boolean;
  delay?: number;
}

export default function BaccaratCard({ card, slideIn, delay = 0 }: BaccaratCardProps) {
  const suitSymbol = SUIT_SYMBOL[card.suit] ?? card.suit[0];
  const suitColor  = SUIT_COLOR[card.suit]   ?? 'var(--pt-cream)';

  const slideStyle = slideIn
    ? {
        animation: `bac-card-slide-in 220ms cubic-bezier(0.22,1,0.36,1) ${delay}ms both`,
      }
    : {};

  return (
    <>
      <style>{`
        @keyframes bac-card-slide-in {
          from { opacity: 0; transform: translateY(-18px) scale(0.92); }
          to   { opacity: 1; transform: translateY(0)     scale(1);    }
        }
      `}</style>
      <div
        aria-label={`${card.rank} of ${card.suit}`}
        style={{
          width: 46,
          height: 68,
          borderRadius: 6,
          background: 'linear-gradient(160deg, #f0ead4 0%, #e8e0c8 100%)',
          border: '2px solid #b0b8c4',
          boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          userSelect: 'none',
          flexShrink: 0,
          ...slideStyle,
        }}
      >
        {/* Top-left rank + suit */}
        <div
          style={{
            position: 'absolute',
            top: 3,
            left: 4,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            lineHeight: 1,
            color: suitColor,
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 800, fontFamily: 'monospace', color: suitColor, lineHeight: 1 }}>
            {card.rank}
          </span>
          <span style={{ fontSize: 13, color: suitColor, lineHeight: 1 }}>{suitSymbol}</span>
        </div>

        {/* Center suit */}
        <span style={{ fontSize: 28, color: suitColor, lineHeight: 1 }}>{suitSymbol}</span>

        {/* Bottom-right rank + suit (rotated) */}
        <div
          style={{
            position: 'absolute',
            bottom: 3,
            right: 4,
            transform: 'rotate(180deg)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            lineHeight: 1,
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 800, fontFamily: 'monospace', color: suitColor, lineHeight: 1 }}>
            {card.rank}
          </span>
          <span style={{ fontSize: 13, color: suitColor, lineHeight: 1 }}>{suitSymbol}</span>
        </div>
      </div>
    </>
  );
}
