'use client';

/**
 * PowerUpIcon — 32×32 icon with rarity tint + cooldown ring overlay.
 * Spec: frontend-spec.md §3.4. Symbols mapped from §5.1 catalog.
 */

export type PowerUpRarity = 'common' | 'uncommon' | 'rare' | 'legendary';

export interface PowerUpIconProps {
  /** Catalog id like `bs-speed-boost` OR a normalized kind. */
  powerUpId: string;
  /** 0 = ready, 1 = just used. Renders sweep ring. */
  cooldownRatio?: number;
  rarity?: PowerUpRarity;
  /** Show "× N" badge for stackable items. */
  charges?: number;
}

const RARITY_TO_COLOR: Record<PowerUpRarity, { border: string; glow: string }> = {
  common: { border: 'rgba(148, 163, 184, 0.7)', glow: 'rgba(148, 163, 184, 0.4)' },
  uncommon: { border: 'rgba(0, 230, 118, 0.7)', glow: 'rgba(0, 230, 118, 0.4)' },
  rare: { border: 'rgba(66, 165, 245, 0.85)', glow: 'rgba(66, 165, 245, 0.55)' },
  legendary: { border: 'rgba(255, 215, 0, 0.9)', glow: 'rgba(255, 215, 0, 0.65)' },
};

function symbolFor(id: string): string {
  if (id.includes('speed') || id.includes('turbo')) return '⚡';
  if (id.includes('shield')) return '🛡️';
  if (id.includes('bomb') || id.includes('mine')) return '💣';
  if (id.includes('aura') || id.includes('whirlpool')) return '🌀';
  if (id.includes('ghost') || id.includes('phantom')) return '👻';
  if (id.includes('tractor') || id.includes('siren')) return '🧲';
  if (id.includes('ink')) return '🦑';
  if (id.includes('jelly')) return '🪼';
  if (id.includes('wave') || id.includes('tide')) return '🌊';
  return '✨';
}

export default function PowerUpIcon({
  powerUpId,
  cooldownRatio = 0,
  rarity = 'common',
  charges,
}: PowerUpIconProps) {
  const r = RARITY_TO_COLOR[rarity];
  const ratio = Math.max(0, Math.min(1, cooldownRatio));
  // SVG arc — cooldown sweep clockwise. circumference of r=14 stroke=3 → 87.96.
  const C = 2 * Math.PI * 14;
  const dashOffset = C * (1 - ratio);

  return (
    <div
      role="img"
      aria-label={powerUpId}
      style={{
        position: 'relative',
        width: 38,
        height: 38,
        borderRadius: 8,
        background: 'linear-gradient(160deg, rgba(15, 31, 58, 0.95) 0%, rgba(6, 13, 23, 0.95) 100%)',
        border: `1.5px solid ${r.border}`,
        boxShadow: `0 0 12px ${r.glow}, inset 0 0 6px rgba(0, 229, 255, 0.08)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 18, lineHeight: 1, filter: ratio > 0 ? 'grayscale(70%)' : undefined }}>
        {symbolFor(powerUpId)}
      </span>
      {ratio > 0 && (
        <svg
          aria-hidden
          viewBox="0 0 32 32"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            transform: 'rotate(-90deg)',
            pointerEvents: 'none',
          }}
        >
          <circle
            cx={16}
            cy={16}
            r={14}
            fill="none"
            stroke={r.border}
            strokeWidth={2}
            strokeDasharray={C}
            strokeDashoffset={dashOffset}
            opacity={0.85}
          />
        </svg>
      )}
      {typeof charges === 'number' && charges > 1 && (
        <span
          style={{
            position: 'absolute',
            bottom: -4,
            right: -4,
            background: '#0A1628',
            border: `1px solid ${r.border}`,
            borderRadius: 8,
            fontSize: 9,
            fontWeight: 700,
            padding: '1px 4px',
            color: '#facc15',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            lineHeight: 1.1,
          }}
        >
          ×{charges}
        </span>
      )}
    </div>
  );
}

/** Internal helper — derive rarity from a catalog id via the locked Q2
 *  rarity table (frontend-spec.md §5.1). Re-exported so PowerUpBar can map
 *  inventory rows to icons without re-implementing the lookup. */
export function rarityForPowerUp(id: string): PowerUpRarity {
  if (id.includes('tractor') || id.includes('tide-wave')) return 'legendary';
  if (id.includes('aura') || id.includes('ghost') || id.includes('seeker') || id.includes('whirlpool'))
    return 'rare';
  if (id.includes('shield') || id.includes('bomb') || id.includes('mine')) return 'uncommon';
  return 'common';
}
