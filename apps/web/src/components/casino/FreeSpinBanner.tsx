'use client';

/**
 * FreeSpinBanner — Phase 6.1.5 full-viewport overlay shown when a spin
 * awards (or retriggers) free spins. Renders nothing when `freeSpinsAwarded`
 * is 0 or when the modal isn't `slotScreenOpen`.
 *
 * Lifecycle, given a non-zero `awardKey` change:
 *   1. fade-in over 300ms (`cv-modal-bg-in`)
 *   2. hold 1500ms
 *   3. fade-out over 300ms (`cv-banner-fade-out`)
 *
 * The driver passes a `triggerId` that flips every time a new award fires
 * (e.g. spinCount). This lets us re-show the banner on a retrigger inside
 * a free-spin chain without unmount/remount churn from the caller.
 *
 * Honors `prefers-reduced-motion`: collapses the fade-in/out durations to
 * effectively-instant and shortens the hold to 800ms, matching the
 * casino-tokens.css convention (`--cv-motion-base` → 0ms under the same
 * media query, so the existing tokens already do most of the work).
 *
 * Iris Xe safe: pure DOM/CSS, no Three.js, no per-frame allocations.
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { FREE_SPIN_RULES } from '@clawville/shared';

export interface FreeSpinBannerProps {
  /** Free spins awarded by the spin that just landed. 0 = no banner. */
  freeSpinsAwarded: number;
  /**
   * Increments every time a new award fires (typically `spinCount`).
   * The banner restarts its show/fade cycle whenever this changes AND
   * `freeSpinsAwarded > 0`.
   */
  triggerId: number;
  /**
   * Whether the spin that awarded the free spins was itself a free spin —
   * drives the "RETRIGGER" copy vs the first-trigger copy.
   */
  isRetrigger: boolean;
}

type Phase = 'idle' | 'in' | 'hold' | 'out';

const FADE_IN_MS = 300;
const HOLD_MS = 1500;
const FADE_OUT_MS = 300;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    // Safari pre-14 lacks addEventListener on MediaQueryList.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', update);
      return () => mq.removeEventListener('change', update);
    }
    mq.addListener(update);
    return () => mq.removeListener(update);
  }, []);
  return reduced;
}

export default function FreeSpinBanner({
  freeSpinsAwarded,
  triggerId,
  isRetrigger,
}: FreeSpinBannerProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const lastTriggerRef = useRef<number | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const reduced = useReducedMotion();

  useEffect(() => {
    // Only kick off a banner cycle when the trigger flips with a real award.
    if (freeSpinsAwarded <= 0) return;
    if (lastTriggerRef.current === triggerId) return;
    lastTriggerRef.current = triggerId;

    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];

    const fadeIn = reduced ? 1 : FADE_IN_MS;
    const hold = reduced ? 800 : HOLD_MS;
    const fadeOut = reduced ? 1 : FADE_OUT_MS;

    setPhase('in');
    timersRef.current.push(setTimeout(() => setPhase('hold'), fadeIn));
    timersRef.current.push(setTimeout(() => setPhase('out'), fadeIn + hold));
    timersRef.current.push(
      setTimeout(() => setPhase('idle'), fadeIn + hold + fadeOut),
    );
  }, [freeSpinsAwarded, triggerId, reduced]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(clearTimeout);
    };
  }, []);

  if (phase === 'idle') return null;

  const fadeIn = reduced ? 1 : FADE_IN_MS;
  const fadeOut = reduced ? 1 : FADE_OUT_MS;

  const headline = isRetrigger
    ? `+${freeSpinsAwarded} FREE SPINS!`
    : `${freeSpinsAwarded} FREE SPINS!`;

  // FS benefit copy is DERIVED from the shipped rules so a future tune
  // (e.g. flipping `FS_LINE_WIN_MULTIPLIER` back to 2) updates the
  // banner's wording in the same PR as the math.
  //   • Option (a) shipped 2026-05-19: FS_LINE_WIN_MULTIPLIER=1,
  //     FS_WILD_MULTIPLIER_DOUBLE=false. Wilds emit raw 2/3/5; only the
  //     "wild multipliers APPLY in FS" carve-out is the real FS benefit.
  //   • If a future tune flips FS_LINE_WIN_MULTIPLIER to N>1, the copy
  //     becomes "N× Multiplier Active" automatically.
  const fsLineMult = FREE_SPIN_RULES.FS_LINE_WIN_MULTIPLIER;
  const fsBenefitLabel =
    fsLineMult > 1 ? `${fsLineMult}× Multiplier Active` : 'Wild Multipliers Active';

  const opacity = phase === 'out' ? 0 : 1;
  const fadeMs = phase === 'in' ? fadeIn : phase === 'out' ? fadeOut : 0;

  const containerStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 10002,
    pointerEvents: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    opacity,
    transition: `opacity ${fadeMs}ms var(--cv-ease-standard)`,
    background:
      'radial-gradient(ellipse at 50% 50%, rgba(255, 174, 0, 0.18) 0%, rgba(21,9,14,0.55) 45%, rgba(2,1,3,0.85) 100%)',
    backdropFilter: 'blur(2px)',
    WebkitBackdropFilter: 'blur(2px)',
  };

  const cardStyle: CSSProperties = {
    background: 'linear-gradient(180deg, var(--pt-velvet-soft) 0%, var(--pt-velvet) 100%)',
    border: '2px solid var(--pt-amber)',
    padding: '28px 56px',
    textAlign: 'center',
    minWidth: 320,
    boxShadow:
      '0 0 36px var(--pt-amber), 0 0 80px rgba(255,174,0,0.35), inset 0 1px 0 rgba(244,233,212,0.1)',
    animation: reduced
      ? 'none'
      : phase === 'in'
        ? 'cv-mega-banner-in 700ms var(--cv-ease-bounce)'
        : 'none',
  };

  return (
    <div role="status" aria-live="assertive" aria-atomic="true" style={containerStyle}>
      <div style={cardStyle}>
        <div
          style={{
            color: 'var(--pt-amber)',
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: 'var(--pt-label-letter)',
            fontFamily: 'var(--pt-data)',
            marginBottom: 10,
            textTransform: 'uppercase',
          }}
        >
          {isRetrigger ? 'Retrigger' : 'Bonus Round'}
        </div>
        <div
          style={{
            color: 'var(--pt-cream)',
            fontSize: 44,
            fontWeight: 600,
            fontFamily: 'var(--pt-display)',
            letterSpacing: '0.04em',
            lineHeight: 1.05,
            textShadow: '0 0 24px var(--pt-amber-glow)',
            marginBottom: 12,
            whiteSpace: 'nowrap',
          }}
        >
          {headline}
        </div>
        <div
          style={{
            color: 'var(--pt-amber-glow)',
            fontSize: 12,
            fontFamily: 'var(--pt-data)',
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            fontWeight: 500,
          }}
        >
          {fsBenefitLabel}
        </div>
      </div>
    </div>
  );
}
