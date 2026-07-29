'use client';

import type { RaiseConfig } from '@/lib/cove/holdem-types';
import { computeRaisePresets } from '@/lib/cove/holdem-bet-math';
import styles from './SeatedHoldemHud.module.css';

/** Bet/raise amount slider shared by the 2D modal and the seated 3D HUD.
 * Extracted verbatim from HoldemModal (P3, 2026-07-15). */
export function RaiseSlider({
  config,
  pot,
  bigBlind,
  humanCommitted,
  onChange,
  onConfirm,
  onCancel,
}: {
  config: RaiseConfig;
  pot: string;
  bigBlind: string;
  humanCommitted: string;
  onChange: (v: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const label = config.verb === 'bet' ? 'Bet' : 'Raise to';
  const presets = computeRaisePresets(config, pot, bigBlind, humanCommitted);
  return (
    <div className={styles.raisePanel}>
      <div className={styles.raiseAmountRow}>
        <div className={styles.raiseRangeWrap}>
          <input
            type="range"
            min={config.min}
            max={config.max}
            step={1}
            value={config.value}
            onChange={(e) => onChange(Number(e.target.value))}
            className={styles.raiseRange}
            aria-label={`${label} amount`}
          />
          <div className={styles.raiseLimits}>
            <span>MIN {config.min}</span>
            <span>MAX {config.max}</span>
          </div>
        </div>
        <span className={styles.raiseValue}>
          {config.value} vCLAW
        </span>
      </div>

      <div className={styles.presetRow} aria-label="Quick raise sizes">
        {presets.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => onChange(preset.value)}
            className={styles.actionButton + ' ' + styles.presetButton}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          onClick={onConfirm}
          className={styles.actionButton + ' ' + styles.primaryButton + ' ' + styles.confirmRaise}
        >
          {label}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={styles.actionButton + ' ' + styles.cancelRaise}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
