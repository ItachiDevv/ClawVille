'use client';

/**
 * RpgTooltip — pure-CSS hover/focus tooltip. Uses `:hover` and `:focus-within`
 * on the wrapper so keyboard users get the same reveal as mouse users, no
 * JavaScript state, no portal.
 *
 * Downstream agents should use this instead of `@radix-ui/react-tooltip` for
 * consistency inside RPG modals. The radix version is still available for
 * non-game parts of the app.
 *
 * Usage
 * -----
 *   <RpgTooltip content="Auto-calculated from knowledge entries">
 *     <RarityBadge tier="epic" />
 *   </RpgTooltip>
 */

import { useId } from 'react';
import type { ReactNode } from 'react';

export type RpgTooltipSide = 'top' | 'bottom';

export interface RpgTooltipProps {
  content: ReactNode;
  side?: RpgTooltipSide;
  className?: string;
  children: ReactNode;
}

export function RpgTooltip({
  content,
  side = 'top',
  className,
  children,
}: RpgTooltipProps) {
  // The wrapper is a tab stop (that is how keyboard users reveal the tooltip),
  // so the explanation MUST be exposed to assistive tech. It used to be
  // `aria-hidden`, which made the stop announce nothing at all. `describedby`
  // + an id is the additive fix: sighted behaviour is untouched (the CSS
  // reveal is still driven by :hover / :focus-within) and every existing call
  // site keeps working, since neither prop is anything a caller passes.
  const tooltipId = useId();

  return (
    <span
      className={['rpg-tooltip-root', className].filter(Boolean).join(' ')}
      tabIndex={0}
      aria-describedby={tooltipId}
    >
      {children}
      <span
        id={tooltipId}
        role="tooltip"
        className={`rpg-tooltip rpg-tooltip--${side}`}
      >
        {content}
      </span>
    </span>
  );
}
