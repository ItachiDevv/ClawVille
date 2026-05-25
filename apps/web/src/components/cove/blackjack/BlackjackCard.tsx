'use client';

/**
 * BlackjackCard — renders one playing card with suit + rank.
 *
 * Phase 6.4.0: SVG-drawn faces via Unicode suit glyphs. No bitmaps.
 * Hidden cards render a blank back (no rank exposed).
 *
 * Iris Xe safe: pure CSS, no Canvas, no InstancedMesh.
 */

import type { BlackjackCard as BlackjackCardType } from '@/lib/cove/blackjack-types';

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

interface BlackjackCardProps {
  card: BlackjackCardType;
  /** Animate slide-in from top */
  slideIn?: boolean;
  delay?: number;
}

export default function BlackjackCard({ card, slideIn, delay = 0 }: BlackjackCardProps) {
  if (card.hidden) {
    return (
      <div
        aria-label="Hidden card"
        style={{
          width: 52,
          height: 76,
          borderRadius: 6,
          background: 'linear-gradient(135deg, #0d3a4a 25%, #0a2d3a 100%)',
          border: '1px solid rgba(0,200,180,0.25)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 22,
          color: 'rgba(0,200,180,0.18)',
          userSelect: 'none',
          flexShrink: 0,
        }}
      >
        ?
      </div>
    );
  }

  const suitSymbol = SUIT_SYMBOL[card.suit] ?? card.suit[0];
  const suitColor  = SUIT_COLOR[card.suit]   ?? 'var(--pt-cream)';

  const slideStyle = slideIn
    ? {
        animation: `bj-card-slide-in 220ms cubic-bezier(0.22,1,0.36,1) ${delay}ms both`,
      }
    : {};

  return (
    <>
      <style>{`
        @keyframes bj-card-slide-in {
          from { opacity: 0; transform: translateY(-18px) scale(0.92); }
          to   { opacity: 1; transform: translateY(0)     scale(1);    }
        }
      `}</style>
      <div
        aria-label={`${card.rank} of ${card.suit}`}
        style={{
          width: 52,
          height: 76,
          borderRadius: 6,
          background: 'linear-gradient(160deg, #f0ead4 0%, #e8e0c8 100%)',
          border: '2px solid #b0b8c4',
          boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          userSelect: 'none',
          flexShrink: 0,
          ...slideStyle,
        }}
      >
        {/* Top-left rank + suit */}
        <div
          style={{
            position: 'absolute',
            top: 4,
            left: 5,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            lineHeight: 1,
            color: suitColor,
          }}
        >
          <span style={{ fontSize: 18, fontWeight: 800, fontFamily: 'monospace', color: suitColor, lineHeight: 1 }}>
            {card.rank}
          </span>
          <span style={{ fontSize: 16, color: suitColor, lineHeight: 1 }}>{suitSymbol}</span>
        </div>

        {/* Center suit */}
        <span style={{ fontSize: 32, color: suitColor, lineHeight: 1 }}>{suitSymbol}</span>

        {/* Bottom-right rank + suit (rotated) */}
        <div
          style={{
            position: 'absolute',
            bottom: 4,
            right: 5,
            transform: 'rotate(180deg)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            lineHeight: 1,
          }}
        >
          <span style={{ fontSize: 18, fontWeight: 800, fontFamily: 'monospace', color: suitColor, lineHeight: 1 }}>
            {card.rank}
          </span>
          <span style={{ fontSize: 16, color: suitColor, lineHeight: 1 }}>{suitSymbol}</span>
        </div>
      </div>
    </>
  );
}
