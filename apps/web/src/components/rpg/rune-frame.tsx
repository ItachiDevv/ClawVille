'use client';

/**
 * RuneFrame — the decorative wrapper that every RPG card/modal/panel sits
 * inside. Renders a dark-navy background + gradient border + four rune corner
 * ornaments, with optional hover lift and pulsing outer glow keyed to a
 * rarity tier.
 *
 * This is the only primitive that actually touches the rune-corner DOM, so
 * downstream components never have to think about positioning them.
 *
 * Usage
 * -----
 *   <RuneFrame tier="epic" glow interactive onClick={...}>
 *     <ItemCard ... />
 *   </RuneFrame>
 *
 * Props
 * -----
 *   tier          — rarity id (defaults to 'common'); drives colour + glow.
 *   glow          — true | 'subtle' | 'strong' — enable the pulse animation.
 *                   Legendary+ tiers default to glow=true automatically.
 *   interactive   — enables the hover-lift + shimmer sweep.
 *   as            — override the root element (defaults to `div`).
 *   className     — merged onto the root.
 *   style         — merged with the CSS variable overrides.
 */

import { createElement } from 'react';
import type { CSSProperties, ElementType, ReactNode, MouseEventHandler } from 'react';
import { getRarity, type RarityId } from './rarity';

export type RuneFrameGlow = boolean | 'subtle' | 'strong';

export interface RuneFrameProps {
  tier?: RarityId;
  glow?: RuneFrameGlow;
  interactive?: boolean;
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  onClick?: MouseEventHandler<HTMLElement>;
  role?: string;
  ariaLabel?: string;
}

export function RuneFrame({
  tier = 'common',
  glow,
  interactive,
  as = 'div',
  className,
  style,
  children,
  onClick,
  role,
  ariaLabel,
}: RuneFrameProps) {
  const rarity = getRarity(tier);
  const shouldPulse = glow !== false && (glow || rarity.pulse);
  const glowClass =
    shouldPulse === 'strong'
      ? 'is-glowing-strong'
      : shouldPulse
        ? 'is-glowing'
        : '';
  const interactiveClass = interactive || onClick ? 'is-interactive' : '';

  const cssVars: CSSProperties = {
    // CSS custom properties consumed by `glow.css`.
    ['--rpg-bg' as string]: rarity.bgGradient,
    ['--rpg-border' as string]: rarity.borderGradient,
    ['--rpg-shadow' as string]: rarity.shadow,
    ['--rpg-glow' as string]: rarity.glow,
    ['--rpg-base' as string]: rarity.base,
    ['--rpg-corner' as string]: `color-mix(in srgb, ${rarity.glow} 80%, transparent)`,
    ['--rpg-corner-hover' as string]: rarity.glow,
    ...style,
  };

  // `as` is polymorphic so we render via React.createElement; JSX's generic
  // component inference resolves ElementType unions to `never` on the
  // children prop, which breaks strict mode. createElement is the escape hatch.
  return createElement(
    as as ElementType,
    {
      className: ['rpg-rune-frame', interactiveClass, glowClass, className]
        .filter(Boolean)
        .join(' '),
      style: cssVars,
      onClick,
      role,
      'aria-label': ariaLabel,
    },
    <span key="tl" className="rpg-rune-corner rpg-rune-corner--tl" aria-hidden />,
    <span key="tr" className="rpg-rune-corner rpg-rune-corner--tr" aria-hidden />,
    <span key="bl" className="rpg-rune-corner rpg-rune-corner--bl" aria-hidden />,
    <span key="br" className="rpg-rune-corner rpg-rune-corner--br" aria-hidden />,
    children
  );
}
