'use client';

/**
 * TerminalButton (legacy export: NeonButton) — Predict Terminal CTA primitive
 *
 * Visual system: brass + tobacco + amber. No cyan/magenta glow.
 *
 * Variants:
 *   primary — amber fill, velvet text (the "act now" CTA)
 *   ghost   — brass-bordered transparent (utility actions)
 *   danger  — loss-red bordered transparent (walk-away, destructive)
 *
 * Back-compat: legacy `secondary` is mapped to `ghost` so existing call
 * sites continue to work without a sweep. New code should use `ghost`.
 *
 * Sizes:
 *   sm — 32px tall
 *   md — 40px tall
 *   lg — 48px tall
 *
 * All visuals come from `.pt-btn*` classes in casino-tokens.css.
 */

import { forwardRef } from 'react';
import type { CSSProperties, ButtonHTMLAttributes, ReactNode } from 'react';

export type NeonButtonVariant = 'primary' | 'ghost' | 'danger' | 'secondary';
export type NeonButtonSize = 'sm' | 'md' | 'lg';

export interface NeonButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: NeonButtonVariant;
  size?: NeonButtonSize;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** When true, the button fills its container width. */
  block?: boolean;
}

const SIZE_STYLES: Record<NeonButtonSize, CSSProperties> = {
  sm: { padding: '0 12px', fontSize: 11, height: 32 },
  md: { padding: '0 18px', fontSize: 13, height: 40 },
  lg: { padding: '0 26px', fontSize: 15, height: 48 },
};

function variantClass(variant: NeonButtonVariant): string {
  switch (variant) {
    case 'primary': return 'pt-btn pt-btn-primary';
    case 'danger':  return 'pt-btn pt-btn-danger';
    case 'ghost':
    case 'secondary':
    default:        return 'pt-btn pt-btn-ghost';
  }
}

export const NeonButton = forwardRef<HTMLButtonElement, NeonButtonProps>(function NeonButton(
  {
    variant = 'primary',
    size = 'md',
    leading,
    trailing,
    block,
    style,
    children,
    disabled,
    className,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || rest['aria-disabled'] === true;
  const cls = `${variantClass(variant)}${className ? ' ' + className : ''}`;

  return (
    <button
      ref={ref}
      disabled={isDisabled}
      className={cls}
      style={{
        width: block ? '100%' : undefined,
        ...SIZE_STYLES[size],
        ...style,
      }}
      {...rest}
    >
      {leading && <span aria-hidden style={{ display: 'inline-flex' }}>{leading}</span>}
      <span>{children}</span>
      {trailing && <span aria-hidden style={{ display: 'inline-flex' }}>{trailing}</span>}
    </button>
  );
});
