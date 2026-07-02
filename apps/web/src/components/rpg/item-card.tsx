'use client';

/**
 * ItemCard — the canonical tile component for any Gameify list (quest board
 * rows, bounty cards, land parcels, agent roster entries). Sits inside a
 * RuneFrame so the rarity edge + corners are free.
 *
 * Deliberately data-shape-agnostic: downstream agents wire their own API
 * fields into the props. Only `rarity` + `name` are required.
 *
 * Usage
 * -----
 *   <ItemCard
 *     rarity="epic"
 *     name="Webhook Gateway Mastery"
 *     subtitle="by Clawdius"
 *     icon={<span>⚓</span>}
 *     description="Teaches an agent to route webhooks..."
 *     stats={[
 *       { label: 'Category', value: 'APIs' },
 *       { label: 'Reviews', value: '12' },
 *     ]}
 *     price={250}
 *     priceUnit="NT"
 *     footer={<RpgButton onClick={buy}>Buy</RpgButton>}
 *     onClick={openDetail}
 *   />
 */

import type { CSSProperties, ReactNode, MouseEventHandler } from 'react';
import { RuneFrame, type RuneFrameGlow } from './rune-frame';
import { RarityBadge } from './rarity-badge';
import type { RarityId } from './rarity';

export interface ItemCardStat {
  label: string;
  value: ReactNode;
}

export interface ItemCardProps {
  rarity?: RarityId;
  name: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  description?: ReactNode;
  stats?: ItemCardStat[];
  price?: ReactNode;
  priceUnit?: ReactNode;
  badge?: ReactNode;
  footer?: ReactNode;
  glow?: RuneFrameGlow;
  interactive?: boolean;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLDivElement>;
  className?: string;
  style?: CSSProperties;
  showRarityBadge?: boolean;
}

export function ItemCard({
  rarity = 'common',
  name,
  subtitle,
  icon,
  description,
  stats,
  price,
  priceUnit,
  badge,
  footer,
  glow,
  interactive = true,
  disabled = false,
  onClick,
  className,
  style,
  showRarityBadge = true,
}: ItemCardProps) {
  const opacityStyle: CSSProperties = disabled
    ? { opacity: 0.55, pointerEvents: 'none', ...style }
    : style ?? {};

  return (
    <RuneFrame
      tier={rarity}
      glow={glow}
      interactive={interactive && !disabled}
      onClick={disabled ? undefined : (onClick as MouseEventHandler<HTMLElement>)}
      className={className}
      style={opacityStyle}
    >
      <div className="rpg-item-card">
        <div className="rpg-item-card__header">
          {icon && <div className="rpg-item-card__icon">{icon}</div>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <span className="rpg-item-card__title">{name}</span>
              {showRarityBadge && <RarityBadge tier={rarity} />}
              {badge}
            </div>
            {subtitle && <div className="rpg-item-card__subtitle">{subtitle}</div>}
          </div>
          {price !== undefined && price !== null && (
            <div className="rpg-item-card__price">
              {price}
              {priceUnit && (
                <span className="rpg-item-card__price-unit">{priceUnit}</span>
              )}
            </div>
          )}
        </div>

        {description && <div className="rpg-item-card__body">{description}</div>}

        {stats && stats.length > 0 && (
          <div className="rpg-item-card__stats">
            {stats.map((s, i) => (
              <div key={i} className="rpg-item-card__stat">
                <span className="rpg-item-card__stat-label">{s.label}</span>
                <span className="rpg-item-card__stat-value">{s.value}</span>
              </div>
            ))}
          </div>
        )}

        {footer && <div className="rpg-item-card__footer">{footer}</div>}
      </div>
    </RuneFrame>
  );
}
