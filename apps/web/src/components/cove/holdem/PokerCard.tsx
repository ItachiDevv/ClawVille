'use client';

/**
 * PokerCard — polished playing card for Hold'em felt.
 *
 * Phase 6.5.0: prop shape matches holdem-types.ts PokerCardProps — drop-in
 * replacement for the inline stub in HoldemModal.tsx (swapped in 6.5.1).
 *
 * Props: { card: HoldemCard; delay?: number; compact?: boolean }
 *   compact=true → 36×52 (bot seats), false → 48×70 (player / community).
 *   card.hidden → teal card-back, same as stub.
 *
 * Readability baseline from BlackjackCard: bold mono corner rank,
 * suit pip at corner + center, deep saturated colors (#111 black suits,
 * #c0202c red suits), cream face, 2px slate border, slide-in keyed by delay.
 *
 * Iris Xe safe: pure CSS, no Canvas, no drei Text/Billboard.
 */

import type { PokerCardProps } from '@/lib/cove/holdem-types';

const SUIT_SYMBOL: Record<string, string> = {
  clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠',
};
const SUIT_COLOR: Record<string, string> = {
  clubs: '#111111', diamonds: '#c0202c', hearts: '#c0202c', spades: '#111111',
};

const ANIM = `
  @keyframes hm-card-in {
    from { opacity: 0; transform: translateY(-14px) scale(0.9); }
    to   { opacity: 1; transform: translateY(0)      scale(1);  }
  }
`;

export default function PokerCard({ card, delay = 0, compact = false }: PokerCardProps) {
  const w = compact ? 36 : 48;
  const h = compact ? 52 : 70;
  const centerFont = compact ? 18 : 26;
  const cornerRank = compact ? 11 : 14;
  const cornerSuit = compact ?  9 : 11;

  const animStyle = {
    animation: `hm-card-in 220ms cubic-bezier(0.22,1,0.36,1) ${delay}ms both`,
  };

  if (card.hidden) {
    return (
      <>
        <style>{ANIM}</style>
        <div
          aria-label="Hidden card"
          style={{
            width: w, height: h, borderRadius: 5,
            background: 'linear-gradient(135deg, #0d3a4a 25%, #0a2d3a 100%)',
            border: '2px solid rgba(0,200,180,0.25)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: compact ? 14 : 20,
            color: 'rgba(0,200,180,0.18)',
            userSelect: 'none', flexShrink: 0,
            ...animStyle,
          }}
        >
          ?
        </div>
      </>
    );
  }

  const sym = SUIT_SYMBOL[card.suit] ?? card.suit[0];
  const col = SUIT_COLOR[card.suit]  ?? '#111111';

  return (
    <>
      <style>{ANIM}</style>
      <div
        aria-label={`${card.rank} of ${card.suit}`}
        style={{
          width: w, height: h, borderRadius: 5,
          background: 'linear-gradient(160deg, #f0ead4 0%, #e8e0c8 100%)',
          border: '2px solid #b0b8c4',
          boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
          position: 'relative',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          userSelect: 'none', flexShrink: 0,
          ...animStyle,
        }}
      >
        {/* Top-left corner */}
        <div style={{
          position: 'absolute', top: 3, left: 4,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', lineHeight: 1,
        }}>
          <span style={{ fontSize: cornerRank, fontWeight: 800, fontFamily: 'monospace', color: col, lineHeight: 1 }}>
            {card.rank}
          </span>
          <span style={{ fontSize: cornerSuit, color: col, lineHeight: 1 }}>{sym}</span>
        </div>

        {/* Center suit */}
        <span style={{ fontSize: centerFont, color: col, lineHeight: 1 }}>{sym}</span>

        {/* Bottom-right corner (rotated) */}
        <div style={{
          position: 'absolute', bottom: 3, right: 4,
          transform: 'rotate(180deg)',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', lineHeight: 1,
        }}>
          <span style={{ fontSize: cornerRank, fontWeight: 800, fontFamily: 'monospace', color: col, lineHeight: 1 }}>
            {card.rank}
          </span>
          <span style={{ fontSize: cornerSuit, color: col, lineHeight: 1 }}>{sym}</span>
        </div>
      </div>
    </>
  );
}
