'use client';

/**
 * TurnClock — a wall-clock countdown to a server-stamped action deadline.
 *
 * The server sends `toActDeadlineMs` / `view.deadlineMs` as an ABSOLUTE
 * wall-clock millisecond timestamp (Date.now() space). We tick locally at
 * ~10 Hz, compute `remaining = deadlineMs - Date.now()`, and clamp at 0. When
 * it reaches 0 the server auto-acts (fold if facing a bet, else check), so the
 * action bar disables itself and the clock reads 0.0s.
 *
 * Two render modes:
 *   - `compact` — a thin ring/bar shown under the acting seat on the felt.
 *   - default   — a labelled bar shown in the action bar.
 *
 * Iris Xe safe: pure DOM + a single setInterval, no rAF, no Canvas.
 */

import { useEffect, useRef, useState } from 'react';

export interface TurnClockProps {
  /** Absolute wall-clock ms deadline (Date.now() space). */
  deadlineMs: number;
  /** Compact felt variant (thin bar, no label). */
  compact?: boolean;
  /** Optional callback fired once when the clock first hits zero. */
  onExpire?: () => void;
}

const TICK_MS = 100;

/** Returns ms remaining (clamped ≥ 0) for a given deadline. */
function msLeft(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

export function TurnClock({ deadlineMs, compact = false, onExpire }: TurnClockProps) {
  const [remaining, setRemaining] = useState(() => msLeft(deadlineMs));
  // Capture the budget (remaining when this deadline first mounted) so the bar
  // DEPLETES over time instead of always reading full. Re-seeded per deadline.
  const budgetRef = useRef(msLeft(deadlineMs));

  useEffect(() => {
    const start = msLeft(deadlineMs);
    budgetRef.current = Math.max(start, 1);
    setRemaining(start);
    let firedExpire = false;
    const id = setInterval(() => {
      const left = msLeft(deadlineMs);
      setRemaining(left);
      if (left <= 0 && !firedExpire) {
        firedExpire = true;
        onExpire?.();
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [deadlineMs, onExpire]);

  const seconds = remaining / 1000;
  const fill = Math.min(1, Math.max(0, remaining / budgetRef.current));
  const urgent = seconds <= 5;
  const color = urgent ? '#f87171' : seconds <= 10 ? '#fbbf24' : '#7cffcb';

  if (compact) {
    return (
      <div
        aria-hidden
        style={{
          width: 56,
          height: 4,
          borderRadius: 2,
          background: 'rgba(0,0,0,0.4)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${fill * 100}%`,
            height: '100%',
            background: color,
            transition: 'width 100ms linear, background 200ms',
          }}
        />
      </div>
    );
  }

  return (
    <div
      role="timer"
      aria-label={`${seconds.toFixed(1)} seconds to act`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        minWidth: 80,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 10,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          letterSpacing: '0.08em',
          color,
        }}
      >
        <span>TIME</span>
        <span>{seconds.toFixed(1)}s</span>
      </div>
      <div
        style={{
          width: '100%',
          height: 6,
          borderRadius: 3,
          background: 'rgba(0,0,0,0.5)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${fill * 100}%`,
            height: '100%',
            background: color,
            transition: 'width 100ms linear, background 200ms',
          }}
        />
      </div>
    </div>
  );
}
