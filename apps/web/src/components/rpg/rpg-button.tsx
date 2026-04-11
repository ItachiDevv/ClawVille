'use client';

/**
 * RpgButton — the unified CTA primitive for every Gameify modal.
 *
 * Variants
 * --------
 *   primary   — gold (default)       — confirms, buys, submits
 *   secondary — silver              — neutral actions, cancel-ish
 *   danger    — blood red           — destructive (cancel listing, reject, etc.)
 *   ghost     — transparent cyan    — in-row secondary actions
 *
 * Pass `rarity` to override the palette with a tier colour — useful for
 * "claim legendary reward" buttons where we want the button to match the
 * rarity of the reward item.
 *
 * Supports `loading` (replaces children with spinner) and `disabled`.
 *
 * Usage
 * -----
 *   <RpgButton variant="primary" onClick={handleBuy} loading={buying}>
 *     Buy
 *   </RpgButton>
 *
 *   <RpgButton variant="danger" size="sm" onClick={handleCancel}>
 *     Cancel Listing
 *   </RpgButton>
 */

import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { getRarity, type RarityId } from './rarity';

export type RpgButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type RpgButtonSize = 'sm' | 'md' | 'lg';

export interface RpgButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: RpgButtonVariant;
  size?: RpgButtonSize;
  rarity?: RarityId;
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  children?: ReactNode;
}

export function RpgButton({
  variant = 'primary',
  size = 'md',
  rarity,
  loading = false,
  leadingIcon,
  trailingIcon,
  disabled,
  className,
  style,
  children,
  type = 'button',
  ...rest
}: RpgButtonProps) {
  const tier = rarity ? getRarity(rarity) : null;
  const rarityStyle: CSSProperties | undefined = tier
    ? {
        ['--rpg-btn-base' as string]: tier.base,
        ['--rpg-btn-glow' as string]: tier.glow,
        ['--rpg-btn-shadow' as string]: tier.shadow,
        color: '#0a1628',
      }
    : undefined;

  const variantClass = `rpg-button--${variant}`;
  const sizeClass = `rpg-button--${size}`;

  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={['rpg-button', variantClass, sizeClass, className]
        .filter(Boolean)
        .join(' ')}
      style={{ ...rarityStyle, ...style }}
      {...rest}
    >
      {loading ? (
        <>
          <span className="rpg-button__spinner" aria-hidden />
          <span>Loading</span>
        </>
      ) : (
        <>
          {leadingIcon}
          {children}
          {trailingIcon}
        </>
      )}
    </button>
  );
}
