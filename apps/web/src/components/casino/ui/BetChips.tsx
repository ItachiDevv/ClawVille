'use client';

/**
 * BetChips — chip-style bet selector.
 *
 * Renders a row of selectable bet values as poker-style chips. Active
 * chip pulses with the gold-accent ring; inactive chips show the
 * theme-color rim at low opacity. Keyboard-navigable via arrow keys.
 *
 * Used inside the SlotHUD bottom bar in place of the legacy `+/−`
 * stepper. The stepper still ships as a fallback on screens that
 * can't fit all chips (the chip row hides under 380px).
 */

import { useCallback, useRef } from 'react';
import type { KeyboardEvent } from 'react';

export interface BetChipsProps {
  options: number[];
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  /** Accessible group label, e.g. "Bet size in ClawTokens". */
  ariaLabel: string;
}

const CHIP_THEMES: Record<number, { ring: string; ink: string }> = {
  0: { ring: 'rgba(255,255,255,0.4)', ink: 'rgba(255,255,255,0.85)' }, // fallback
};

function chipTheme(value: number, index: number) {
  // Vary the rim color so the row feels alive — cycle a palette.
  const palette = [
    { ring: '#00ffe0', ink: '#9ffff2' },
    { ring: '#7b2ff7', ink: '#cba8ff' },
    { ring: '#ff00cc', ink: '#ffa6e8' },
    { ring: '#ffc857', ink: '#ffe089' },
    { ring: '#5cffae', ink: '#a8ffce' },
  ];
  return palette[index % palette.length] ?? CHIP_THEMES[0];
}

export default function BetChips({
  options,
  value,
  onChange,
  disabled,
  ariaLabel,
}: BetChipsProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleKey = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
      if (disabled) return;
      let next = idx;
      if (e.key === 'ArrowRight') next = Math.min(options.length - 1, idx + 1);
      else if (e.key === 'ArrowLeft') next = Math.max(0, idx - 1);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = options.length - 1;
      else return;
      e.preventDefault();
      onChange(options[next]);
      const buttons = containerRef.current?.querySelectorAll<HTMLButtonElement>('[data-chip]');
      buttons?.[next]?.focus();
    },
    [disabled, onChange, options],
  );

  return (
    <div
      ref={containerRef}
      role="radiogroup"
      aria-label={ariaLabel}
      style={{
        display: 'flex',
        gap: 'var(--cv-space-2)',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      {options.map((opt, idx) => {
        const isActive = opt === value;
        const theme = chipTheme(opt, idx);
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={isActive}
            data-chip
            disabled={disabled}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(opt)}
            onKeyDown={(e) => handleKey(e, idx)}
            style={{
              minWidth: 44,
              height: 38,
              padding: '0 12px',
              borderRadius: 'var(--cv-radius-pill)',
              fontFamily: 'monospace',
              fontWeight: 800,
              fontSize: 13,
              letterSpacing: '0.04em',
              color: isActive ? '#0a1428' : theme.ink,
              background: isActive
                ? `radial-gradient(circle at 50% 35%, ${theme.ring} 0%, ${theme.ring}cc 100%)`
                : 'rgba(10,20,40,0.7)',
              border: `1px solid ${isActive ? theme.ring : `${theme.ring}55`}`,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.4 : 1,
              boxShadow: isActive
                ? `0 0 14px ${theme.ring}aa, inset 0 1px 0 rgba(255,255,255,0.35)`
                : 'inset 0 1px 0 rgba(255,255,255,0.05)',
              transition:
                'background var(--cv-motion-fast) var(--cv-ease-standard), ' +
                'border-color var(--cv-motion-fast) var(--cv-ease-standard), ' +
                'color var(--cv-motion-fast) var(--cv-ease-standard), ' +
                'box-shadow var(--cv-motion-fast) var(--cv-ease-standard)',
            }}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
