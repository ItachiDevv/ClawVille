'use client';

/**
 * RarityBadge — small pill shown inline next to item names. Colour-coded by
 * rarity with a pulsing dot on legendary+ tiers.
 *
 * Usage
 * -----
 *   <RarityBadge tier="epic" />
 *   <RarityBadge tier="legendary" size="md" showDot />
 */

import type { CSSProperties } from 'react';
import { getRarity, type RarityId } from './rarity';

export interface RarityBadgeProps {
  tier?: RarityId | string | null;
  size?: 'sm' | 'md';
  showDot?: boolean;
  className?: string;
  label?: string;
}

export function RarityBadge({
  tier,
  size = 'sm',
  showDot = false,
  className,
  label,
}: RarityBadgeProps) {
  const rarity = getRarity(tier ?? null);
  const vars: CSSProperties = {
    ['--rpg-base' as string]: rarity.base,
    ['--rpg-glow' as string]: rarity.glow,
  };
  const sizeClass = size === 'md' ? 'rpg-rarity-badge--md' : '';

  return (
    <span
      className={['rpg-rarity-badge', sizeClass, className]
        .filter(Boolean)
        .join(' ')}
      style={vars}
      data-rarity={rarity.id}
    >
      {showDot && <span className="rpg-rarity-badge--dot" aria-hidden />}
      {label ?? rarity.label}
    </span>
  );
}
