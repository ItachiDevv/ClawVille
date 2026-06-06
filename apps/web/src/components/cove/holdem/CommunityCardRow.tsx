'use client';

/**
 * CommunityCardRow — polished community card row for Hold'em felt.
 *
 * Phase 6.5.0: prop shape matches holdem-types.ts CommunityCardRowProps —
 * drop-in replacement for the inline stub in HoldemModal.tsx (6.5.1).
 *
 * Props: { cards: (HoldemCard | null)[] }
 *   null entries render empty dashed slot placeholders.
 *   card.hidden renders a teal card-back (preflop bot cards).
 *
 * Iris Xe safe: pure React/CSS, no drei.
 */

import type { CommunityCardRowProps } from '@/lib/cove/holdem-types';
import PokerCard from './PokerCard';

export default function CommunityCardRow({ cards }: CommunityCardRowProps) {
  return (
    <div
      role="group"
      aria-label="Community cards"
      style={{
        display: 'flex',
        gap: 6,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      {cards.map((card, i) =>
        card ? (
          <PokerCard key={i} card={card} delay={i * 60} compact={false} />
        ) : (
          <div
            key={i}
            aria-hidden
            style={{
              width: 48,
              height: 70,
              borderRadius: 5,
              border: '1.5px dashed rgba(60,180,100,0.18)',
              opacity: 0.35,
              flexShrink: 0,
            }}
          />
        )
      )}
    </div>
  );
}
