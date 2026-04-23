'use client';

/**
 * RoundCountdown — full-screen "3 · 2 · 1 · GO!" overlay during the
 * pregame phase. Spec: frontend-spec.md §3.4. Driven by the store's
 * `countdownSecondsRemaining` (server-authoritative; we just animate the
 * value as it changes).
 */

import { useEffect, useState } from 'react';

export interface RoundCountdownProps {
  /** Seconds remaining (server-driven). 0 → render "GO!". */
  secondsRemaining: number;
  /** Fires once when secondsRemaining transitions through 0. */
  onComplete?: () => void;
}

export default function RoundCountdown({ secondsRemaining, onComplete }: RoundCountdownProps) {
  const [showGo, setShowGo] = useState(false);
  const [pulseKey, setPulseKey] = useState(0);

  // Bump pulse key when integer seconds change so CSS animation re-fires.
  useEffect(() => {
    setPulseKey((k) => k + 1);
  }, [secondsRemaining]);

  // GO splash on transition to 0.
  useEffect(() => {
    if (secondsRemaining === 0) {
      setShowGo(true);
      onComplete?.();
      const t = setTimeout(() => setShowGo(false), 800);
      return () => clearTimeout(t);
    }
  }, [secondsRemaining, onComplete]);

  if (secondsRemaining > 3 && !showGo) return null;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        zIndex: 30,
      }}
    >
      <div
        key={pulseKey}
        style={{
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
          fontSize: showGo ? 120 : 96,
          fontWeight: 900,
          color: showGo ? '#00E676' : '#00E5FF',
          textShadow:
            '0 0 28px currentColor, 0 0 56px currentColor, 0 4px 24px rgba(0, 0, 0, 0.65)',
          animation: 'rpg-countdown-pop 0.55s ease-out',
          letterSpacing: '0.05em',
        }}
      >
        {showGo ? 'GO!' : Math.max(1, secondsRemaining)}
      </div>
      <style>{`
        @keyframes rpg-countdown-pop {
          0%   { transform: scale(0.4); opacity: 0; }
          40%  { transform: scale(1.15); opacity: 1; }
          100% { transform: scale(1.0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
