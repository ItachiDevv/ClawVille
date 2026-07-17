'use client';

/**
 * RoundCountdown — full-screen "3 · 2 · 1 · GO!" overlay during the
 * pregame phase. Spec: frontend-spec.md §3.4. Its caller supplies a
 * locally ticking server-deadline projection, clamped at 1 until the
 * authoritative match phase becomes live and supplies 0 for GO.
 *
 * Chunk #12 — fires `countdown-tick` SFX on every integer change while
 * counting down (3 / 2 / 1) and `round-start` on the GO! transition.
 * `playActivitySound` is a best-effort no-op when the AudioContext is
 * suspended (caller forgot `primeActivitySounds()`) or when the user
 * prefers reduced motion, so this stays safe.
 */

import { useEffect, useRef, useState } from 'react';
import { playActivitySound } from '@/lib/activity-audio';

export interface RoundCountdownProps {
  /** Seconds remaining. 0 → render "GO!". */
  secondsRemaining: number;
  /** Fires once when secondsRemaining transitions through 0. */
  onComplete?: () => void;
}

export default function RoundCountdown({ secondsRemaining, onComplete }: RoundCountdownProps) {
  const [goDismissed, setGoDismissed] = useState(false);
  const [pulseKey, setPulseKey] = useState(0);
  const lastTickRef = useRef<number | null>(null);

  // Bump pulse key when integer seconds change so CSS animation re-fires.
  useEffect(() => {
    setPulseKey((k) => k + 1);
  }, [secondsRemaining]);

  // SFX — tick on each integer change (3, 2, 1) while counting down.
  useEffect(() => {
    if (secondsRemaining > 0 && secondsRemaining <= 3) {
      const intSec = Math.max(1, secondsRemaining);
      if (lastTickRef.current !== intSec) {
        lastTickRef.current = intSec;
        playActivitySound('countdown-tick');
      }
    } else if (secondsRemaining > 3) {
      // Reset ticker so a new countdown starts cleanly.
      lastTickRef.current = null;
    }
  }, [secondsRemaining]);

  // GO splash on transition to 0.
  useEffect(() => {
    if (secondsRemaining === 0) {
      setGoDismissed(false);
      playActivitySound('round-start');
      onComplete?.();
      const t = setTimeout(() => setGoDismissed(true), 800);
      return () => clearTimeout(t);
    }
    setGoDismissed(false);
  }, [secondsRemaining, onComplete]);

  if (secondsRemaining > 3 || (secondsRemaining === 0 && goDismissed)) return null;
  const showGo = secondsRemaining === 0;

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
