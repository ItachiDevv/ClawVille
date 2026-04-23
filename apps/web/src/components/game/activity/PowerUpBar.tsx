'use client';

/**
 * PowerUpBar — bottom-center horizontal slot strip showing the player's
 * inventory + cooldown rings. Spec: frontend-spec.md §3.4. Bumper Shells
 * caps at 2 slots (§5.1 "Max 2 items held total"); we render 2 slots so
 * empty ones still appear as placeholders (clearer mental model than the
 * bar shrinking).
 */

import type { PowerUpSlot } from '@/stores/activity';
import PowerUpIcon, { rarityForPowerUp } from './PowerUpIcon';

export interface PowerUpBarProps {
  slots: PowerUpSlot[];
  onUse?: (slotIndex: number) => void;
  /** Number of placeholder slots to render when inventory is short. */
  capacity?: number;
}

export default function PowerUpBar({ slots, onUse, capacity = 2 }: PowerUpBarProps) {
  const padded: (PowerUpSlot | null)[] = [];
  for (let i = 0; i < capacity; i++) padded.push(slots[i] ?? null);

  return (
    <div
      data-hud-interactive="true"
      className="claw-panel"
      style={{
        padding: '8px 12px',
        display: 'inline-flex',
        gap: 10,
        alignItems: 'center',
        pointerEvents: 'auto',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
          fontSize: 9,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: 'rgba(0, 229, 255, 0.7)',
          fontWeight: 700,
        }}
      >
        Items
      </span>
      {padded.map((slot, i) => {
        const cooldownRatio = slot?.cooldownUntil
          ? Math.max(0, Math.min(1, (slot.cooldownUntil - Date.now()) / 5000))
          : 0;
        return (
          <button
            key={i}
            type="button"
            disabled={!slot || cooldownRatio > 0}
            onClick={() => onUse?.(i)}
            aria-label={
              slot ? `Use ${slot.kind} (slot ${i + 1})` : `Empty slot ${i + 1}`
            }
            style={{
              all: 'unset',
              cursor: slot && cooldownRatio === 0 ? 'pointer' : 'default',
              borderRadius: 8,
              padding: 1,
            }}
          >
            {slot ? (
              <PowerUpIcon
                powerUpId={slot.kind}
                cooldownRatio={cooldownRatio}
                rarity={rarityForPowerUp(slot.kind)}
                charges={slot.charges}
              />
            ) : (
              <EmptySlot />
            )}
          </button>
        );
      })}
    </div>
  );
}

function EmptySlot() {
  return (
    <div
      style={{
        width: 38,
        height: 38,
        borderRadius: 8,
        background: 'rgba(15, 31, 58, 0.55)',
        border: '1.5px dashed rgba(148, 163, 184, 0.3)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'rgba(148, 163, 184, 0.4)',
        fontSize: 18,
        flexShrink: 0,
      }}
      aria-hidden
    >
      ·
    </div>
  );
}
