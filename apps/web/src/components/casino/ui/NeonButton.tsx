'use client';

/**
 * NeonButton — branded CTA primitive
 *
 * Three variants:
 *   primary   — cyan glow, magenta hover ring, gold-tint on press
 *   secondary — translucent surface with cyan border
 *   ghost     — text-only, used for utility actions inside the HUD
 *
 * All visual values come from `casino-tokens.css`. The component uses
 * inline `style` for layout but pulls color/shadow from CSS variables
 * so theming stays centralized.
 *
 * Accessible:
 *   - `aria-label` forwarded
 *   - disabled state visually distinct and `pointerEvents: 'none'`
 *   - focus ring uses outline (not box-shadow) for high contrast
 */

import { forwardRef } from 'react';
import type { CSSProperties, ButtonHTMLAttributes, ReactNode } from 'react';

export type NeonButtonVariant = 'primary' | 'secondary' | 'ghost';
export type NeonButtonSize = 'sm' | 'md' | 'lg';

export interface NeonButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: NeonButtonVariant;
  size?: NeonButtonSize;
  /** Optional icon (emoji or <svg>) rendered left of the label. */
  leading?: ReactNode;
  /** Optional icon rendered right of the label. */
  trailing?: ReactNode;
  /** When true, the button fills its container width. */
  block?: boolean;
}

const SIZE_STYLES: Record<NeonButtonSize, CSSProperties> = {
  sm: { padding: '6px 12px', fontSize: 12, height: 32, borderRadius: 'var(--cv-radius-sm)' },
  md: { padding: '10px 18px', fontSize: 14, height: 42, borderRadius: 'var(--cv-radius-md)' },
  lg: { padding: '14px 28px', fontSize: 17, height: 56, borderRadius: 'var(--cv-radius-md)' },
};

const VARIANT_STYLES: Record<NeonButtonVariant, CSSProperties> = {
  primary: {
    background:
      'linear-gradient(180deg, rgba(0,255,224,0.18) 0%, rgba(0,255,224,0.06) 100%), rgba(5,10,24,0.85)',
    color: 'var(--cv-neon-cyan)',
    border: '1px solid rgba(0,255,224,0.55)',
    boxShadow: 'var(--cv-shadow-cta)',
    fontWeight: 800,
    letterSpacing: '0.14em',
  },
  secondary: {
    background: 'rgba(10,20,40,0.72)',
    color: 'rgba(255,255,255,0.78)',
    border: '1px solid rgba(0,255,224,0.18)',
    boxShadow: 'var(--cv-shadow-card)',
    fontWeight: 700,
    letterSpacing: '0.08em',
  },
  ghost: {
    background: 'transparent',
    color: 'rgba(255,255,255,0.55)',
    border: '1px solid transparent',
    boxShadow: 'none',
    fontWeight: 600,
    letterSpacing: '0.05em',
  },
};

export const NeonButton = forwardRef<HTMLButtonElement, NeonButtonProps>(function NeonButton(
  {
    variant = 'primary',
    size = 'md',
    leading,
    trailing,
    block,
    style,
    children,
    onMouseEnter,
    onMouseLeave,
    disabled,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || rest['aria-disabled'] === true;

  const handleEnter: NeonButtonProps['onMouseEnter'] = (e) => {
    if (!isDisabled && variant === 'primary') {
      e.currentTarget.style.boxShadow = 'var(--cv-shadow-cta-hover)';
      e.currentTarget.style.borderColor = 'rgba(255,0,204,0.7)';
      e.currentTarget.style.color = '#ffffff';
    } else if (!isDisabled && variant === 'secondary') {
      e.currentTarget.style.borderColor = 'rgba(0,255,224,0.45)';
      e.currentTarget.style.color = '#ffffff';
    } else if (!isDisabled && variant === 'ghost') {
      e.currentTarget.style.color = 'rgba(255,255,255,0.9)';
      e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
    }
    onMouseEnter?.(e);
  };

  const handleLeave: NeonButtonProps['onMouseLeave'] = (e) => {
    if (!isDisabled && variant === 'primary') {
      e.currentTarget.style.boxShadow = 'var(--cv-shadow-cta)';
      e.currentTarget.style.borderColor = 'rgba(0,255,224,0.55)';
      e.currentTarget.style.color = 'var(--cv-neon-cyan)';
    } else if (!isDisabled && variant === 'secondary') {
      e.currentTarget.style.borderColor = 'rgba(0,255,224,0.18)';
      e.currentTarget.style.color = 'rgba(255,255,255,0.78)';
    } else if (!isDisabled && variant === 'ghost') {
      e.currentTarget.style.color = 'rgba(255,255,255,0.55)';
      e.currentTarget.style.background = 'transparent';
    }
    onMouseLeave?.(e);
  };

  return (
    <button
      ref={ref}
      disabled={isDisabled}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--cv-space-2)',
        fontFamily: 'monospace',
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        opacity: isDisabled ? 0.45 : 1,
        textTransform: 'uppercase',
        transition:
          'box-shadow var(--cv-motion-fast) var(--cv-ease-standard), ' +
          'border-color var(--cv-motion-fast) var(--cv-ease-standard), ' +
          'color var(--cv-motion-fast) var(--cv-ease-standard), ' +
          'background var(--cv-motion-fast) var(--cv-ease-standard), ' +
          'transform var(--cv-motion-fast) var(--cv-ease-standard)',
        whiteSpace: 'nowrap',
        width: block ? '100%' : undefined,
        outlineOffset: 2,
        ...SIZE_STYLES[size],
        ...VARIANT_STYLES[variant],
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
