'use client';

import type { RaiseConfig } from '@/lib/cove/holdem-types';

/** Bet/raise amount slider shared by the 2D modal and the seated 3D HUD.
 * Extracted verbatim from HoldemModal (P3, 2026-07-15). */
export function RaiseSlider({ config, onChange, onConfirm, onCancel }: {
  config: RaiseConfig;
  onChange: (v: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const label = config.verb === 'bet' ? 'Bet' : 'Raise to';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      background: 'rgba(0,0,0,0.35)',
      border: '1px solid rgba(60,180,100,0.2)',
      borderRadius: 6, padding: '6px 10px',
    }}>
      <input
        type="range"
        min={config.min}
        max={config.max}
        step={1}
        value={config.value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor: 'var(--pt-amber)' }}
        aria-label={`${label} amount`}
      />
      <span style={{
        fontSize: 12, fontFamily: 'var(--pt-data)', color: 'var(--pt-amber)',
        fontWeight: 700, minWidth: 56, textAlign: 'right',
      }}>
        {config.value} vCLAW
      </span>
      <button
        type="button"
        onClick={onConfirm}
        className="pt-btn pt-btn-primary"
        style={{ height: 32, padding: '0 12px', fontSize: 11, fontWeight: 700, minWidth: 64 }}
      >
        {label}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="pt-btn pt-btn-ghost"
        style={{ height: 32, padding: '0 8px', fontSize: 11 }}
      >
        Cancel
      </button>
    </div>
  );
}
