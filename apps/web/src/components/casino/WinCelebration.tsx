'use client';

/**
 * WinCelebration — Phase 6.0 MVP (single tier)
 *
 * Shows a center-screen count-up toast on any win > 0.
 * Multi-tier system (Concern 6.0.5) will expand this to 5 distinct tiers;
 * the component API is designed to accept the full SpinResult already.
 *
 * Sound: silent in 6.0.4 (Concern 6.0.6).
 * Iris Xe safe: pure CSS, no canvas, no WebGL.
 */

import { useEffect, useRef, useState } from 'react';

export interface WinCelebrationProps {
  /** Win amount in ClawTokens (0 = no celebration) */
  winAmount: number;
  /** Bet size (used to compute multiplier tier) */
  bet: number;
  /** Called when the celebration animation completes */
  onComplete?: () => void;
}

// ---------------------------------------------------------------------------
// Tier detection
// ---------------------------------------------------------------------------
type WinTier = 'none' | 'micro' | 'small' | 'medium' | 'big' | 'mega';

function detectTier(winAmount: number, bet: number): WinTier {
  if (winAmount <= 0) return 'none';
  const mult = bet > 0 ? winAmount / bet : 0;
  if (mult < 2)   return 'micro';
  if (mult < 10)  return 'small';
  if (mult < 50)  return 'medium';
  if (mult < 500) return 'big';
  return 'mega';
}

// ---------------------------------------------------------------------------
// Tier configs
// ---------------------------------------------------------------------------
interface TierConfig {
  duration: number;      // ms for the count-up
  displayMs: number;     // total display duration
  scale: number;         // max scale of toast
  color: string;
  label: string;
}

const TIER_CONFIGS: Record<Exclude<WinTier, 'none'>, TierConfig> = {
  micro:  { duration: 400,  displayMs: 1200, scale: 1.0,  color: '#00ffe0', label: 'WIN' },
  small:  { duration: 600,  displayMs: 1600, scale: 1.1,  color: '#ffe600', label: 'WIN!' },
  medium: { duration: 700,  displayMs: 2200, scale: 1.2,  color: '#ff9900', label: 'BIG WIN!' },
  big:    { duration: 800,  displayMs: 3000, scale: 1.35, color: '#ff4400', label: 'SUPER WIN!' },
  mega:   { duration: 1000, displayMs: 4000, scale: 1.5,  color: '#ff00cc', label: 'MEGA WIN!!!' },
};

// ---------------------------------------------------------------------------
// Count-up hook
// ---------------------------------------------------------------------------
function useCountUp(target: number, duration: number, active: boolean): number {
  const [current, setCurrent] = useState(0);
  const rafRef = useRef<number>(0);
  const startRef = useRef<number>(0);

  useEffect(() => {
    if (!active || target <= 0) {
      setCurrent(0);
      return;
    }
    startRef.current = performance.now();
    const tick = (now: number) => {
      const elapsed = now - startRef.current;
      const t = Math.min(elapsed / duration, 1);
      // Ease-out quad
      const eased = 1 - (1 - t) * (1 - t);
      setCurrent(Math.round(eased * target));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active, target, duration]);

  return current;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function WinCelebration({ winAmount, bet, onComplete }: WinCelebrationProps) {
  const tier = detectTier(winAmount, bet);
  const [visible, setVisible] = useState(false);
  const [animIn, setAnimIn] = useState(false);

  const config = tier !== 'none' ? TIER_CONFIGS[tier] : null;
  const countedValue = useCountUp(winAmount, config?.duration ?? 600, visible);

  useEffect(() => {
    if (tier === 'none' || !config) {
      setVisible(false);
      setAnimIn(false);
      return;
    }

    setVisible(true);
    const t1 = setTimeout(() => setAnimIn(true), 16); // next frame
    const t2 = setTimeout(() => {
      setAnimIn(false);
    }, config.displayMs - 300);
    const t3 = setTimeout(() => {
      setVisible(false);
      onComplete?.();
    }, config.displayMs);

    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [winAmount, tier, config, onComplete]);

  if (!visible || !config || tier === 'none') return null;

  return (
    <>
      <style>{`
        @keyframes winPop {
          0%   { transform: translate(-50%, -50%) scale(0.3); opacity: 0; }
          40%  { transform: translate(-50%, -50%) scale(${config.scale + 0.1}); opacity: 1; }
          60%  { transform: translate(-50%, -50%) scale(${config.scale - 0.05}); opacity: 1; }
          80%  { transform: translate(-50%, -50%) scale(${config.scale}); opacity: 1; }
          100% { transform: translate(-50%, -50%) scale(${config.scale}); opacity: 1; }
        }
        @keyframes winFadeOut {
          from { opacity: 1; transform: translate(-50%, -50%) scale(${config.scale}); }
          to   { opacity: 0; transform: translate(-50%, -50%) scale(${config.scale * 0.8}); }
        }
        @keyframes winShake {
          0%,100% { transform: translate(-50%, -50%) scale(${config.scale}); }
          25%  { transform: translate(-50%, calc(-50% - 6px)) scale(${config.scale}); }
          75%  { transform: translate(-50%, calc(-50% + 6px)) scale(${config.scale}); }
        }
        @keyframes sparkle {
          0%,100% { opacity: 0; transform: scale(0); }
          50%      { opacity: 1; transform: scale(1); }
        }
      `}</style>

      {/* Dark vignette for big/mega wins */}
      {(tier === 'big' || tier === 'mega') && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            zIndex: 9995,
            pointerEvents: 'none',
            animation: animIn ? 'none' : 'winFadeOut 0.3s ease forwards',
          }}
        />
      )}

      {/* Win toast */}
      <div
        role="status"
        aria-live="assertive"
        style={{
          position: 'fixed',
          left: '50%',
          top: '42%',
          zIndex: 9996,
          pointerEvents: 'none',
          animation: animIn
            ? `winPop 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) forwards`
            : `winFadeOut 0.3s ease forwards`,
          transformOrigin: 'center',
        }}
      >
        <div
          style={{
            background: `radial-gradient(circle at 50% 40%, ${config.color}22 0%, rgba(0,0,0,0.92) 100%)`,
            border: `2px solid ${config.color}`,
            borderRadius: 18,
            padding: '22px 44px',
            textAlign: 'center',
            boxShadow: `0 0 40px ${config.color}66, 0 0 80px ${config.color}33, inset 0 1px 0 ${config.color}44`,
            minWidth: 220,
            backdropFilter: 'blur(8px)',
          }}
        >
          {/* Tier label */}
          <div
            style={{
              color: config.color,
              fontSize: 13,
              fontWeight: 800,
              letterSpacing: '0.18em',
              fontFamily: 'monospace',
              textShadow: `0 0 12px ${config.color}`,
              marginBottom: 8,
              textTransform: 'uppercase',
            }}
          >
            {config.label}
          </div>

          {/* Count-up amount */}
          <div
            style={{
              color: '#fff',
              fontSize: tier === 'mega' ? 52 : tier === 'big' ? 44 : tier === 'medium' ? 38 : 30,
              fontWeight: 900,
              fontFamily: 'monospace',
              letterSpacing: '0.04em',
              lineHeight: 1,
              textShadow: `0 0 20px ${config.color}`,
              marginBottom: 6,
            }}
          >
            +{countedValue.toLocaleString()}
          </div>

          {/* CT label */}
          <div
            style={{
              color: 'rgba(255,255,255,0.55)',
              fontSize: 11,
              fontFamily: 'monospace',
              letterSpacing: '0.1em',
            }}
          >
            CLAW TOKENS
          </div>
        </div>
      </div>
    </>
  );
}
