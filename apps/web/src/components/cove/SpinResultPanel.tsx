'use client';

/**
 * SpinResultPanel — persistent post-spin readout (Phase 6.1.11).
 *
 * Mounts as an absolute-positioned overlay strip at the bottom of the reel
 * frame. Shows the most recent spin outcome until the next spin starts:
 *   - WIN     →  big animated count-up, line count, multiplier ribbon
 *   - SCATTER →  "SCATTER PAY +N CT" highlight
 *   - BONUS   →  "BONUS UNLOCKED · N FREE SPINS"
 *   - LOSS    →  subtle "no match this round"
 *
 * Persistence matters: the per-tier WinCelebration overlay is ephemeral
 * (2-3s animations) and disappears mid-result before the player can read
 * the win amount. This panel stays put until the player presses SPIN
 * again — closes the "what did I just win?" gap.
 *
 * Iris Xe safe: pure DOM + CSS, zero canvas / three.js. Count-up uses one
 * requestAnimationFrame chain that auto-cleans on unmount or new result.
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { SpinResult } from '@/lib/cove/types';

export interface SpinResultPanelProps {
  /** Most recent server-resolved spin, or null if none yet this session. */
  lastSpin:         SpinResult | null;
  /** Predict at the time the spin landed (used for line-multiplier display). */
  predict:          number;
  /** True while reels are animating — panel hides during this window. */
  isSpinning:       boolean;
  /** True while modal is resolving (post-settle, pre-celebration). */
  isEvaluating:     boolean;
  /** Whether the session is currently mid-free-spin run. */
  inFreeSpin:       boolean;
  /** Unspent free-spin balance. */
  freeSpinsRemaining: number;
}

// ---------------------------------------------------------------------------
// Count-up — eases from 0 → target over durationMs (60fps RAF chain).
// ---------------------------------------------------------------------------
function useCountUp(target: number, durationMs: number, key: number): number {
  const [current, setCurrent] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (target <= 0) { setCurrent(0); return; }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / durationMs, 1);
      const eased = 1 - (1 - t) * (1 - t); // ease-out quad
      setCurrent(Math.round(eased * target));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs, key]);

  return current;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function bigToNumber(n: bigint): number {
  if (n <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(n);
  return Number.MAX_SAFE_INTEGER;
}

interface ResultBreakdown {
  winNumber:        number;
  scatterNumber:    number;
  lineCount:        number;
  multiplier:       number;          // winAmount / predict (0 if predict=0)
  highestLineMult:  number;
  hasWin:           boolean;
  hasScatter:       boolean;
  fsAwarded:        number;
  isFreeSpin:       boolean;
}

function breakdown(result: SpinResult, predict: number): ResultBreakdown {
  const winNumber     = bigToNumber(result.winAmount);
  const scatterNumber = bigToNumber(result.scatterPayout);
  const lineCount     = result.winningLines.length;
  const multiplier    = predict > 0 ? winNumber / predict : 0;
  const highestLineMult = result.winningLines.reduce(
    (max, l) => Math.max(max, l.multiplier),
    0,
  );
  return {
    winNumber,
    scatterNumber,
    lineCount,
    multiplier,
    highestLineMult,
    hasWin:    winNumber > 0,
    hasScatter: scatterNumber > 0,
    fsAwarded: result.freeSpinsAwarded ?? 0,
    isFreeSpin: result.isFreeSpin,
  };
}

function tierLabel(multiplier: number): { label: string; accent: string; key: string } {
  if (multiplier >= 500) return { label: 'EPIC WIN',  accent: 'var(--cv-pearl-shine)', key: 'epic'  };
  if (multiplier >= 50)  return { label: 'SUPER WIN', accent: 'var(--cv-pearl-shine)', key: 'super' };
  if (multiplier >= 10)  return { label: 'BIG WIN',   accent: 'var(--cv-pearl)',       key: 'big'   };
  if (multiplier >= 2)   return { label: 'NICE WIN',  accent: 'var(--cv-anemone)',     key: 'nice'  };
  return                       { label: 'WIN',       accent: 'var(--cv-coral)',       key: 'win'   };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function SpinResultPanel({
  lastSpin,
  predict,
  isSpinning,
  isEvaluating,
  inFreeSpin,
  freeSpinsRemaining,
}: SpinResultPanelProps) {
  // Count-up key changes whenever we get a new spin result — restarts the RAF.
  const [resultSeq, setResultSeq] = useState(0);
  useEffect(() => { setResultSeq(s => s + 1); }, [lastSpin]);

  // All hooks must be called every render — derive both result + count-up
  // up-front, then branch in the JSX. (Hooks-rules violation if we early-
  // return between them.)
  const b = lastSpin ? breakdown(lastSpin, predict) : null;
  const winNumber = b?.winNumber ?? 0;
  const counted = useCountUp(winNumber, winNumber > 1000 ? 1200 : 700, resultSeq);

  // Hide while spinning or before any result has been recorded — show idle
  // prompt instead so the area isn't empty.
  if (isSpinning || !lastSpin || !b) {
    return (
      <PromptStrip
        isSpinning={isSpinning}
        isEvaluating={isEvaluating}
        inFreeSpin={inFreeSpin}
        freeSpinsRemaining={freeSpinsRemaining}
      />
    );
  }

  // BONUS — scatters triggered free spins
  if (b.fsAwarded > 0) {
    return (
      <ResultStrip
        accent="var(--cv-anemone)"
        label={b.isFreeSpin ? 'FREE-SPIN RETRIGGER' : 'BONUS UNLOCKED'}
        primary={`+${b.fsAwarded} FREE SPIN${b.fsAwarded === 1 ? '' : 'S'}`}
        secondary={
          b.hasWin
            ? `+${counted.toLocaleString()} vCLAW this spin · scatter ${b.scatterNumber.toLocaleString()} vCLAW`
            : b.hasScatter
              ? `scatter pay +${b.scatterNumber.toLocaleString()} vCLAW`
              : 'no line win — but the chest is yours'
        }
        glow
      />
    );
  }

  // SCATTER-ONLY pay (3+ scatters but didn't trigger free spins — shouldn't
  // happen with current rules but the fallback is clean).
  if (!b.hasWin && b.hasScatter) {
    return (
      <ResultStrip
        accent="var(--cv-sand)"
        label="SCATTER PAY"
        primary={`+${b.scatterNumber.toLocaleString()} vCLAW`}
        secondary="treasure chest triple"
      />
    );
  }

  // WIN
  if (b.hasWin) {
    const tier = tierLabel(b.multiplier);
    return (
      <ResultStrip
        accent={tier.accent}
        label={tier.label}
        primary={`+${counted.toLocaleString()} vCLAW`}
        secondary={
          b.lineCount > 1
            ? `${b.lineCount} winning lines · top ${b.highestLineMult}× line${b.hasScatter ? ` · scatter +${b.scatterNumber.toLocaleString()}` : ''}`
            : `1 line · ${b.highestLineMult}× multiplier${b.hasScatter ? ` · scatter +${b.scatterNumber.toLocaleString()}` : ''}`
        }
        glow={b.multiplier >= 10}
        biggerNumber={b.multiplier >= 50}
      />
    );
  }

  // LOSS — subtle, never punishing
  return (
    <ResultStrip
      accent="var(--cv-kelp)"
      label="NO MATCH"
      primary="—"
      secondary={
        inFreeSpin && freeSpinsRemaining > 0
          ? `the tide turns soon · ${freeSpinsRemaining} free spin${freeSpinsRemaining === 1 ? '' : 's'} left`
          : 'spin again to catch the next wave'
      }
      muted
    />
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ResultStripProps {
  accent:        string;
  label:         string;
  primary:       string;
  secondary?:    string;
  glow?:         boolean;
  biggerNumber?: boolean;
  muted?:        boolean;
}

function ResultStrip({ accent, label, primary, secondary, glow, biggerNumber, muted }: ResultStripProps) {
  const wrapStyle: CSSProperties = {
    position:       'absolute',
    left:           '50%',
    bottom:         '10px',
    transform:      'translateX(-50%)',
    zIndex:         5,
    pointerEvents:  'none',
    minWidth:       260,
    maxWidth:       '92%',
    padding:        '10px 24px',
    background:     muted
      ? 'linear-gradient(180deg, rgba(10,58,74,0.78) 0%, rgba(6,46,59,0.92) 100%)'
      : 'linear-gradient(180deg, rgba(15,72,88,0.92) 0%, rgba(6,46,59,0.98) 100%)',
    borderTop:      `2px solid ${accent}`,
    borderRadius:   'var(--cv-radius-lg)',
    boxShadow: glow
      ? `0 0 28px ${accent}88, 0 0 60px ${accent}44, inset 0 1px 0 rgba(244,233,212,0.10)`
      : `0 6px 18px rgba(0,0,0,0.5), inset 0 1px 0 rgba(244,233,212,0.06)`,
    textAlign:      'center',
    animation:      'cv-result-strip-in 360ms cubic-bezier(0.34,1.56,0.64,1)',
    fontFamily:     'var(--cv-data)',
  };

  return (
    <div role="status" aria-live="polite" style={wrapStyle}>
      <div
        style={{
          color:         accent,
          fontSize:      10,
          fontWeight:    500,
          letterSpacing: 'var(--cv-label-letter)',
          marginBottom:  4,
          textShadow:    glow ? `0 0 8px ${accent}` : 'none',
        }}
      >
        {label}
      </div>
      <div
        style={{
          color:         muted ? 'var(--cv-foam-soft)' : 'var(--cv-foam)',
          fontFamily:    'var(--cv-display)',
          fontSize:      biggerNumber ? 38 : 28,
          fontWeight:    600,
          lineHeight:    1.05,
          letterSpacing: '0.02em',
          textShadow:    glow
            ? `0 0 18px ${accent}, 0 0 36px ${accent}88`
            : `0 1px 0 rgba(0,0,0,0.6)`,
        }}
      >
        {primary}
      </div>
      {secondary && (
        <div
          style={{
            color:         'var(--cv-kelp)',
            fontSize:      10,
            letterSpacing: '0.06em',
            marginTop:     4,
          }}
        >
          {secondary}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Idle / pre-spin coaching strip — keeps the area from being empty
// ---------------------------------------------------------------------------

interface PromptStripProps {
  isSpinning:        boolean;
  isEvaluating:      boolean;
  inFreeSpin:        boolean;
  freeSpinsRemaining: number;
}

function PromptStrip({ isSpinning, isEvaluating, inFreeSpin, freeSpinsRemaining }: PromptStripProps) {
  if (isSpinning || isEvaluating) {
    return null; // Reels are doing the heavy lifting; don't compete.
  }
  if (inFreeSpin && freeSpinsRemaining > 0) {
    return (
      <ResultStrip
        accent="var(--cv-anemone)"
        label="FREE-SPIN RUN ACTIVE"
        primary={`${freeSpinsRemaining} FREE SPIN${freeSpinsRemaining === 1 ? '' : 'S'} READY`}
        secondary="press spin — no chips charged"
        glow
      />
    );
  }
  return (
    <ResultStrip
      accent="var(--cv-coral)"
      label="READY"
      primary="PRESS SPIN"
      secondary="match 3+ from the left to win"
      muted
    />
  );
}
