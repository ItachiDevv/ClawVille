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
  return (
    <span
      className={['rpg-tooltip-root', className].filter(Boolean).join(' ')}
      tabIndex={0}
    >
      {children}
      <span
        role="tooltip"
        className={`rpg-tooltip rpg-tooltip--${side}`}
        aria-hidden
      >
        {content}
      </span>
    </span>
  );
}
