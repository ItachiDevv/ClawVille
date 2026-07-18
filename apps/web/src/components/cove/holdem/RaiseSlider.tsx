'use client';

import type { RaiseConfig } from '@/lib/cove/holdem-types';
import { computeRaisePresets } from '@/lib/cove/holdem-bet-math';

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
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 8,
      background: 'rgba(0,0,0,0.35)',
      border: '1px solid rgba(60,180,100,0.2)',
      borderRadius: 6, padding: '8px 10px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 120 }}>
          <input
            type="range"
            min={config.min}
            max={config.max}
            step={1}
            value={config.value}
            onChange={(e) => onChange(Number(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--pt-amber)' }}
            aria-label={`${label} amount`}
          />
          <div style={{
            display: 'flex', justifyContent: 'space-between', marginTop: 1,
            color: '#8ba391', fontFamily: 'var(--pt-data)', fontSize: 9,
          }}>
            <span>MIN {config.min}</span>
            <span>MAX {config.max}</span>
          </div>
        </div>
        <span style={{
          fontSize: 12, fontFamily: 'var(--pt-data)', color: 'var(--pt-amber)',
          fontWeight: 700, minWidth: 72, textAlign: 'right',
        }}>
          {config.value} vCLAW
        </span>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} aria-label="Quick raise sizes">
        {presets.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => onChange(preset.value)}
            className="pt-btn pt-btn-ghost"
            style={{ minHeight: 44, padding: '0 10px', fontSize: 10, flex: '1 1 64px' }}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          onClick={onConfirm}
          className="pt-btn pt-btn-primary"
          style={{ minHeight: 44, padding: '0 12px', fontSize: 11, fontWeight: 700, flex: '1 1 78px' }}
        >
          {label}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="pt-btn pt-btn-ghost"
          style={{ minHeight: 44, padding: '0 10px', fontSize: 11, flex: '1 1 70px' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
