'use client';

/**
 * PredictChips — Predict Terminal chip-style stake selector.
 *
 * Renders a row of selectable predict values as small tobacco-on-brass
 * rectangular tabs. Active chip uses amber border + glow accent. Hover
 * lightens border to brass. Keyboard-navigable via arrow keys.
 *
 * Used inside the SlotActionStrip center column.
 */

import { useCallback, useRef } from 'react';
import type { KeyboardEvent } from 'react';

export interface PredictChipsProps {
  options: number[];
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  /** Accessible group label, e.g. "Predict size in ClawTokens". */
  ariaLabel: string;
}

export default function PredictChips({
  options,
  value,
  onChange,
  disabled,
  ariaLabel,
}: PredictChipsProps) {
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
      className="pt-chip-row"
    >
      {options.map((opt, idx) => {
        const isActive = opt === value;
        const cls = [
          'pt-chip',
          isActive ? 'pt-chip-active' : '',
          disabled ? 'pt-chip-disabled' : '',
        ].filter(Boolean).join(' ');
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
            className={cls}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
