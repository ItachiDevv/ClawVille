'use client';

/**
 * RuneSpinner — loading sigil used inside RpgModal bodies and ItemCards.
 *
 * Replaces the generic `animate-spin` rounded ring. Pure CSS, sized via the
 * `--rpg-spinner-size` custom property so it scales to any container.
 *
 * Usage
 * -----
 *   <RuneSpinner />             // default 32px cyan
 *   <RuneSpinner size={48} />   // larger
 *   <RuneSpinner tier="epic" /> // matches a rarity colour
 */

import type { CSSProperties } from 'react';
import { getRarity, type RarityId } from './rarity';

export interface RuneSpinnerProps {
  size?: number;
  tier?: RarityId;
  className?: string;
  label?: string;
}

export function RuneSpinner({
  size = 32,
  tier,
  className,
  label = 'Loading',
}: RuneSpinnerProps) {
  const rarity = tier ? getRarity(tier) : null;
  const vars: CSSProperties = {
    ['--rpg-spinner-size' as string]: `${size}px`,
    ...(rarity && {
      ['--rpg-base' as string]: rarity.base,
      ['--rpg-glow' as string]: rarity.glow,
    }),
  };

  return (
    <span
      className={['rpg-rune-spinner', className].filter(Boolean).join(' ')}
      style={vars}
      role="status"
      aria-label={label}
    >
      <span className="rpg-rune-spinner__ring" aria-hidden />
      <span className="rpg-rune-spinner__core" aria-hidden />
    </span>
  );
}
