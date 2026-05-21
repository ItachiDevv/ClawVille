'use client';

/**
 * useFX — single source of truth for slot-machine reaction state
 *
 * One hook consumed by SlotScreenModal + WinCelebration + SlotReels.
 * Returns a small state surface and two callbacks:
 *
 *   onSpinStart()                       — call when the player hits spin
 *   onSpinResolved(result, predict)     — call after reels settle
 *
 * Derives a `WinTier` from `(winAmount, predict)` using bigint-safe math
 * (winAmount * 100n / predict → integer hundredths of a multiplier).
 *
 * Tier dispatch:
 *   loss   (mult < 0)    — no reaction, just clears any lingering state
 *   micro  (mult < 2)    — 4 coins, no overlay, no shake
 *   small  (mult < 10)   — 8 confetti, soft shake
 *   medium (mult < 50)   — 18 coins + 14 confetti + soft shake
 *   big    (mult < 500)  — 24 coins + 18 confetti + hard shake + banner
 *   mega   (mult >= 500) — 42 coins + 30 confetti + hard shake + flash + 3s lockout
 *
 * `prefers-reduced-motion`: particle counts halved, screen flash skipped,
 * shake stays at "soft" max. The hook reads the media-query once on
 * mount and reacts to runtime changes.
 *
 * All timers are tracked in a ref and cleaned up on unmount or when
 * a new spin starts mid-celebration.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SpinResult } from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type WinTier = 'loss' | 'micro' | 'small' | 'medium' | 'big' | 'mega';

export type ShakeLevel = 'none' | 'soft' | 'hard';

export interface FXParticle {
  /** Stable key for React reconciliation. */
  id: string;
  /** 'coin' = gold disc, 'confetti' = colored shard. */
  kind: 'coin' | 'confetti';
  /** Index used by the CSS keyframe to spread the particle horizontally. */
  idx: number;
  /** Total count in this burst — used by the spread formula. */
  count: number;
  /** Optional color override (confetti uses random brand color, coin ignores). */
  color?: string;
}

export interface FXState {
  /** Most recent tier — `'loss'` when there's no active celebration. */
  tier: WinTier;
  /** Active win amount in CT (mirrors the result for the banner). */
  winAmount: number;
  /** Predict that produced this win (passed through for display). */
  predict: number;
  /** Reels container shake intensity. */
  shakeLevel: ShakeLevel;
  /** Whether the global saturation/brightness glow is active. */
  isGlowActive: boolean;
  /** Whether the symbols on winning paylines should pulse the gold ring. */
  isSnapActive: boolean;
  /** Whether the full-screen mega flash is currently rendering. */
  isHugeWinFlashActive: boolean;
  /** Currently flying particles. */
  particles: FXParticle[];
  /** Whether spin input should be blocked (mega-tier 3 s lockout). */
  isLockedOut: boolean;
}

export interface UseFXReturn {
  state: FXState;
  onSpinStart: () => void;
  onSpinResolved: (result: SpinResult, predict: number) => void;
  /** Manual reset — used by the modal's close handler. */
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Tier derivation (bigint-safe)
// ---------------------------------------------------------------------------

const TIER_THRESHOLDS: Array<{ tier: Exclude<WinTier, 'loss'>; max100: number }> = [
  { tier: 'micro',  max100: 200    }, // < 2.00×
  { tier: 'small',  max100: 1000   }, // < 10.00×
  { tier: 'medium', max100: 5000   }, // < 50.00×
  { tier: 'big',    max100: 50000  }, // < 500.00×
  { tier: 'mega',   max100: Infinity },
];

export function deriveWinTier(winAmount: bigint, predict: bigint): WinTier {
  if (winAmount <= 0n)  return 'loss';
  if (predict <= 0n)    return 'micro'; // defensive — predict should never be 0
  // mult * 100 as an integer (hundredths of a multiplier)
  const mult100 = Number((winAmount * 100n) / predict);
  for (const { tier, max100 } of TIER_THRESHOLDS) {
    if (mult100 < max100) return tier;
  }
  return 'mega';
}

// ---------------------------------------------------------------------------
// Tier presentation config
// ---------------------------------------------------------------------------

interface TierFXConfig {
  shakeLevel: ShakeLevel;
  coinCount: number;
  confettiCount: number;
  banner: boolean;
  screenFlash: boolean;
  /** Total ms the celebration stays mounted before auto-clear. */
  durationMs: number;
  /** Lockout in ms during which the spin button stays disabled. */
  lockoutMs: number;
}

const TIER_CONFIGS: Record<Exclude<WinTier, 'loss'>, TierFXConfig> = {
  micro:  { shakeLevel: 'none', coinCount: 4,  confettiCount: 0,  banner: false, screenFlash: false, durationMs: 900,  lockoutMs: 0    },
  small:  { shakeLevel: 'soft', coinCount: 0,  confettiCount: 8,  banner: false, screenFlash: false, durationMs: 1400, lockoutMs: 0    },
  medium: { shakeLevel: 'soft', coinCount: 18, confettiCount: 14, banner: false, screenFlash: false, durationMs: 2000, lockoutMs: 0    },
  big:    { shakeLevel: 'hard', coinCount: 24, confettiCount: 18, banner: true,  screenFlash: false, durationMs: 2800, lockoutMs: 0    },
  mega:   { shakeLevel: 'hard', coinCount: 42, confettiCount: 30, banner: true,  screenFlash: true,  durationMs: 3800, lockoutMs: 3000 },
};

// Brand colors used to tint confetti shards.
const CONFETTI_COLORS = ['#00ffe0', '#ff00cc', '#ffc857', '#7b2ff7', '#5cffae', '#ff5470'];

// ---------------------------------------------------------------------------
// Default state (reused at unmount + reset)
// ---------------------------------------------------------------------------

const DEFAULT_STATE: FXState = {
  tier: 'loss',
  winAmount: 0,
  predict: 0,
  shakeLevel: 'none',
  isGlowActive: false,
  isSnapActive: false,
  isHugeWinFlashActive: false,
  particles: [],
  isLockedOut: false,
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useFX(): UseFXReturn {
  const [state, setState] = useState<FXState>(DEFAULT_STATE);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const reduceMotionRef = useRef<boolean>(false);
  const particleSeqRef = useRef<number>(0);

  // Track prefers-reduced-motion. The ref is read at decision time so
  // a runtime toggle (rare but possible) takes effect for the next spin.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduceMotionRef.current = mql.matches;
    const onChange = (e: MediaQueryListEvent) => {
      reduceMotionRef.current = e.matches;
    };
    // Older Safari uses addListener / removeListener.
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else if ('addListener' in mql) (mql as MediaQueryList).addListener(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange);
      else if ('removeListener' in mql) (mql as MediaQueryList).removeListener(onChange);
    };
  }, []);

  // Universal timer cleanup on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(clearTimeout);
    };
  }, []);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  const schedule = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      // Drop self from the array so the cleanup loop stays tight.
      timersRef.current = timersRef.current.filter(x => x !== t);
      fn();
    }, ms);
    timersRef.current.push(t);
    return t;
  }, []);

  const reset = useCallback(() => {
    clearTimers();
    setState(DEFAULT_STATE);
  }, [clearTimers]);

  const onSpinStart = useCallback(() => {
    // Spin during an active celebration — clear it out so the new
    // result can fire fresh. Lockout stays in place if a mega is mid-flight.
    clearTimers();
    setState(prev => ({
      ...DEFAULT_STATE,
      isLockedOut: prev.isLockedOut,
      isGlowActive: true,
    }));
  }, [clearTimers]);

  const onSpinResolved = useCallback((result: SpinResult, predict: number) => {
    const predictBn = BigInt(Math.max(0, Math.floor(predict)));
    const tier = deriveWinTier(result.winAmount, predictBn);

    if (tier === 'loss') {
      // Drop the spin-start glow, no celebration.
      setState({ ...DEFAULT_STATE });
      return;
    }

    const reduceMotion = reduceMotionRef.current;
    const cfg = TIER_CONFIGS[tier];

    const coinCount     = reduceMotion ? Math.ceil(cfg.coinCount     / 2) : cfg.coinCount;
    const confettiCount = reduceMotion ? Math.ceil(cfg.confettiCount / 2) : cfg.confettiCount;
    const screenFlash   = reduceMotion ? false : cfg.screenFlash;
    const shakeLevel: ShakeLevel = reduceMotion && cfg.shakeLevel === 'hard' ? 'soft' : cfg.shakeLevel;

    const total = coinCount + confettiCount;
    const particles: FXParticle[] = [];
    for (let i = 0; i < coinCount; i++) {
      particleSeqRef.current += 1;
      particles.push({
        id: `coin-${particleSeqRef.current}`,
        kind: 'coin',
        idx: i,
        count: total,
      });
    }
    for (let i = 0; i < confettiCount; i++) {
      particleSeqRef.current += 1;
      particles.push({
        id: `conf-${particleSeqRef.current}`,
        kind: 'confetti',
        idx: coinCount + i,
        count: total,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      });
    }

    clearTimers();
    setState({
      tier,
      winAmount: Number(result.winAmount),
      predict,
      shakeLevel,
      isGlowActive: true,
      isSnapActive: true,
      isHugeWinFlashActive: screenFlash,
      particles,
      isLockedOut: cfg.lockoutMs > 0,
    });

    // Drop the flash early (it's a short stab).
    if (screenFlash) {
      schedule(() => {
        setState(prev => ({ ...prev, isHugeWinFlashActive: false }));
      }, 600);
    }

    // Lift lockout after the configured window.
    if (cfg.lockoutMs > 0) {
      schedule(() => {
        setState(prev => ({ ...prev, isLockedOut: false }));
      }, cfg.lockoutMs);
    }

    // Particles self-clear at end of celebration so we don't keep
    // mounted DOM nodes after their keyframe finishes.
    schedule(() => {
      setState(prev => ({
        ...prev,
        particles: [],
      }));
    }, Math.max(1200, cfg.durationMs - 400));

    // Full reset (back to idle) at end of duration.
    schedule(() => {
      setState({ ...DEFAULT_STATE });
    }, cfg.durationMs);
  }, [clearTimers, schedule]);

  return { state, onSpinStart, onSpinResolved, reset };
}

// ---------------------------------------------------------------------------
// Internal exports for testing — not part of the public API surface
// ---------------------------------------------------------------------------

export const __internal = {
  TIER_CONFIGS,
  TIER_THRESHOLDS,
  CONFETTI_COLORS,
  DEFAULT_STATE,
};
