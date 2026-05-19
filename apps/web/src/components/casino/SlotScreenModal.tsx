'use client';

/**
 * SlotScreenModal — full-viewport 2D slot machine UI
 *
 * Phase 6.1 slice 5: real backend wire.
 *   - Lazy-opens a slot session on first spin press (`useOpenSlotSession`).
 *   - Every spin calls `useSpin` with a freshly-minted `crypto.randomUUID()`
 *     Idempotency-Key; same key is reused on react-query auto-retry through
 *     the same button press.
 *   - "Cash out / Walk away" triggers `useCloseSlotSession`, which reveals
 *     the server seed for verifier replay.
 *   - All bigint-shaped wire fields stay as strings; only `recordSpin` /
 *     useFX promotes to bigint via `spinResponseToSpinResult`.
 *
 * Iris Xe safe: pure DOM/CSS overlay — zero extra draw calls on the 3D
 * canvas underneath. Modal is DOM only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCasinoStore } from '@/stores/casino';
import type { SpinResult } from '@/lib/casino/types';
import { useFX } from '@/lib/casino/useFX';
import {
  CasinoApiError,
  describeCasinoError,
  spinResponseToSpinResult,
  useCloseSlotSession,
  useOpenSlotSession,
  useSpin,
  type SpinResponse,
} from '@/lib/casino/slot-api-client';
import SlotHUD from './SlotHUD';
import WinCelebration from './WinCelebration';
import PaytableModal from './PaytableModal';
import FreeSpinBanner from './FreeSpinBanner';
import WildMultiplierBadge from './WildMultiplierBadge';
import ScatterCelebration, { type ScatterCell } from './ScatterCelebration';
import { NeonButton } from './ui';

// Import design tokens once at the module level.
import '@/styles/casino-tokens.css';

// SlotReels has complex CSS animation — dynamic import avoids SSR issues
const SlotReels = dynamic(() => import('./SlotReels'), { ssr: false });

// ---------------------------------------------------------------------------
// Autoplay state machine
// ---------------------------------------------------------------------------
type AutoplayValue = number | 'until-cashout' | 'until-big-win';

interface AutoplayState {
  count: AutoplayValue;
  remaining: number;
  active: boolean;
}

function initAutoplay(count: AutoplayValue): AutoplayState {
  return {
    count,
    remaining: typeof count === 'number' ? count : Infinity,
    active: count !== 0,
  };
}

/**
 * The slice-3 server requires `spin.predict === session.startingBalance`,
 * which is `predict * 1` (single line predict * 20-line stake). The
 * predict picker sets per-spin total stake in multiples of 20 (line
 * count). Multiplying here keeps the modal's "predict=10" UX while
 * shipping total-stake=200 etc.
 * Easier: just use the chip values as the *total* stake — the existing
 * PredictChips of 1/5/10/25/50/100 are NOT divisible by 20.
 *
 * Resolution: clamp the visible chip values to 20-divisible multiples
 * (20/40/100/200/500/1000). The chips array lives in SlotHUD and is the
 * single source of truth for legal predict values.
 */

// ---------------------------------------------------------------------------
// Toast (lightweight, slot-modal-local — no external dep)
// ---------------------------------------------------------------------------
type ToastTone = 'info' | 'warn' | 'error';
interface ToastState {
  message: string;
  tone: ToastTone;
  /** Unique id so consecutive identical messages still re-animate. */
  id: number;
}

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------
export default function SlotScreenModal() {
  const {
    slotScreenOpen,
    paytableId,
    sessionId,
    serverSeedHash,
    revealedServerSeed,
    sessionBalance,
    sessionPnl,
    spinCount,
    isSpinning,
    closeSlotScreen,
    setIsSpinning,
    recordSpin,
    setSessionMeta,
    clearSessionMeta,
    setRevealedServerSeed,
  } = useCasinoStore();

  // ── Local UI state ─────────────────────────────────────────────────────
  // Default predict = 20 (matches CLASSIC_LINES.length, smallest legal total-stake).
  const [predict, setPredict] = useState(20);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [paytableOpen, setPaytableOpen] = useState(false);
  const [fairnessTooltipOpen, setFairnessTooltipOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem('casino-muted') === '1'; } catch { return false; }
  });
  const [autoplay, setAutoplay] = useState<AutoplayState>({ count: 0, remaining: 0, active: false });

  // ── API hooks ──────────────────────────────────────────────────────────
  const openSession = useOpenSlotSession();
  const spin = useSpin();
  const closeSession = useCloseSlotSession();

  // ── FX hook (5-tier dispatcher) ────────────────────────────────────────
  const fx = useFX();

  // Current reel window to display
  const [displayWindow, setDisplayWindow] = useState<number[][] | null>(null);
  const [pendingWinLines, setPendingWinLines] = useState<SpinResult['winningLines']>([]);

  // ── Phase 6.1.5 bonus-mechanic display state ─────────────────────────────
  // Carries the LAST-LANDED spin's bonus fields into the overlay components.
  // Reset on modal close. `bonusTriggerId` flips per landed spin so the
  // banner + sparkle effects re-trigger on every fresh land (incl. retrigger
  // on a free-spin chain).
  const [lastWildMultipliers, setLastWildMultipliers] = useState<SpinResult['wildMultipliers']>([]);
  const [lastScatterCells, setLastScatterCells] = useState<ScatterCell[]>([]);
  const [lastScatterPayout, setLastScatterPayout] = useState<bigint>(0n);
  const [lastFreeSpinsAwarded, setLastFreeSpinsAwarded] = useState(0);
  const [lastIsFreeSpin, setLastIsFreeSpin] = useState(false);
  const [bonusTriggerId, setBonusTriggerId] = useState(0);
  // Phase 6.1.5 — session-level FS state from the most-recent
  // SpinResponse. `inFreeSpin` drives the SPIN button label swap;
  // `freeSpinsRemaining` drives the HUD counter chip. Optional fields
  // on SpinResponse so pre-bonus rows degrade gracefully.
  const [inFreeSpin, setInFreeSpin] = useState(false);
  const [freeSpinsRemaining, setFreeSpinsRemaining] = useState(0);

  const spinLockRef = useRef(false);
  const autoplayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingResultRef = useRef<SpinResult | null>(null);
  /** Per-spin idempotency key. Re-used inside one spin-press lifecycle. */
  const spinIdemKeyRef = useRef<string | null>(null);
  const toastSeqRef = useRef(0);

  // ── Toast helpers ──────────────────────────────────────────────────────
  const showToast = useCallback((message: string, tone: ToastTone = 'info') => {
    toastSeqRef.current += 1;
    setToast({ message, tone, id: toastSeqRef.current });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast((prev) => (prev?.id === toast.id ? null : prev)), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  // ── Close handler ───────────────────────────────────────────────────────
  const handleClose = useCallback(() => {
    if (autoplayTimerRef.current) clearTimeout(autoplayTimerRef.current);
    setAutoplay({ count: 0, remaining: 0, active: false });
    setPendingWinLines([]);
    fx.reset();
    closeSlotScreen();
  }, [closeSlotScreen, fx]);

  /**
   * Cash-out — close the active session, reveal seed, then close modal.
   * On API error we leave the modal open so the user can retry; the
   * server idempotently rejects double-close with 409 if the first call
   * actually landed (which the toast covers).
   */
  const handleCashOut = useCallback(async () => {
    if (!sessionId) {
      // No active session — just close (player never spun).
      handleClose();
      return;
    }
    try {
      const res = await closeSession.mutateAsync({ sessionId });
      setRevealedServerSeed(res.serverSeed);
      showToast(
        `Cashed out — seed ${res.serverSeed.slice(0, 12)}…${res.serverSeed.slice(-6)} revealed.`,
        'info',
      );
      // Brief delay so user sees the reveal before close.
      setTimeout(() => handleClose(), 1200);
    } catch (err) {
      showToast(describeCasinoError(err), 'error');
    }
  }, [sessionId, closeSession, setRevealedServerSeed, handleClose, showToast]);

  // ── Mute persistence ────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    setMuted(prev => {
      const next = !prev;
      try { localStorage.setItem('casino-muted', next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);

  /**
   * Single spin step. Ensures a session exists (lazy-open on first press),
   * mints an idempotency key, fires the spin mutation, and threads the
   * resolved SpinResult through the existing reel-animation pipeline.
   */
  const doSpin = useCallback(async () => {
    if (spinLockRef.current) return;
    if (fx.state.isLockedOut) return;
    if (sessionBalance < predict) return;
    if (!paytableId) return;
    spinLockRef.current = true;
    setPendingWinLines([]);
    fx.onSpinStart();
    setIsSpinning(true);

    try {
      // Lazy open: first spin in this modal lifecycle opens a session.
      let activeSessionId = sessionId;
      if (!activeSessionId) {
        const opened = await openSession.mutateAsync({
          paytableId,
          currency: 'clawtokens',
          predict: predict.toString(),
        });
        activeSessionId = opened.sessionId;
        setSessionMeta({
          sessionId: opened.sessionId,
          serverSeedHash: opened.serverSeedHash,
          clientSeed: opened.clientSeed,
        });
      }

      // Mint a per-spin idempotency key. Same key survives across this
      // mutation's react-query retry pass (which we disabled, but
      // defense-in-depth: identical key never hits the 409 predict-mismatch
      // guard because predict is identical too).
      if (!spinIdemKeyRef.current) {
        spinIdemKeyRef.current = crypto.randomUUID();
      }
      const idemKey = spinIdemKeyRef.current;

      const res: SpinResponse = await spin.mutateAsync({
        sessionId: activeSessionId,
        predict: predict.toString(),
        idempotencyKey: idemKey,
      });

      // SpinResult is the bigint-flavored shape the existing reel-anim
      // pipeline + useFX expect. Adapter promotes string → bigint exactly
      // once at the boundary.
      const spinResult = spinResponseToSpinResult(res);
      pendingResultRef.current = spinResult;
      recordSpin(spinResult, res.balance, res.spinCount);
      // Phase 6.1.5 — session-level FS state. Required on the locked
      // SpinResponse contract (server returns 'base' / 0 on classic-3x5
      // and on bonus paytable when no FS budget is active).
      setInFreeSpin(res.mode === 'free-spin');
      setFreeSpinsRemaining(res.freeSpinsRemaining);
      // Now we wait for SlotReels to call handleReelsSettled.
    } catch (err) {
      // Restore from the spinning state — the reel anim was never started.
      pendingResultRef.current = null;
      setIsSpinning(false);
      fx.reset();
      spinLockRef.current = false;
      spinIdemKeyRef.current = null;
      // Stop autoplay loop on error.
      if (autoplayTimerRef.current) clearTimeout(autoplayTimerRef.current);
      setAutoplay({ count: 0, remaining: 0, active: false });
      const message = describeCasinoError(err);
      const tone: ToastTone =
        err instanceof CasinoApiError && err.status === 429
          ? 'warn'
          : err instanceof CasinoApiError && err.status >= 500
            ? 'error'
            : 'warn';
      showToast(message, tone);
    }
  }, [
    predict,
    fx,
    paytableId,
    sessionBalance,
    sessionId,
    setIsSpinning,
    openSession,
    spin,
    setSessionMeta,
    recordSpin,
    showToast,
  ]);

  // ── Keyboard handler ────────────────────────────────────────────────────
  useEffect(() => {
    if (!slotScreenOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (paytableOpen || fairnessTooltipOpen) return;
        handleClose();
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (!isSpinning && !isEvaluating && !fx.state.isLockedOut && sessionBalance >= predict) {
          void doSpin();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [slotScreenOpen, isSpinning, isEvaluating, sessionBalance, predict, paytableOpen, fairnessTooltipOpen, doSpin, fx.state.isLockedOut, handleClose]);

  // ── Reel settled callback ───────────────────────────────────────────────
  const handleReelsSettled = useCallback(() => {
    const result = pendingResultRef.current;
    if (!result) {
      setIsSpinning(false);
      spinLockRef.current = false;
      spinIdemKeyRef.current = null;
      return;
    }

    setDisplayWindow(result.reels);
    setPendingWinLines(result.winningLines);

    // Phase 6.1.5 — surface bonus state to the overlay components. We
    // derive scatter cells from the grid here (id 10 on `classic-3x5-bonus`;
    // classic-3x5 never has id 10 so the loop is a no-op there). Bumping
    // `bonusTriggerId` per landed spin re-fires the banner + sparkle
    // animations even on consecutive retriggers.
    const SCATTER_ID = 10;
    const scatterCells: ScatterCell[] = [];
    for (let r = 0; r < result.reels.length; r++) {
      const reel = result.reels[r];
      if (!reel) continue;
      for (let row = 0; row < reel.length; row++) {
        if (reel[row] === SCATTER_ID) scatterCells.push({ reelIndex: r, rowIndex: row });
      }
    }
    setLastWildMultipliers(result.wildMultipliers);
    setLastScatterCells(scatterCells);
    setLastScatterPayout(result.scatterPayout);
    setLastFreeSpinsAwarded(result.freeSpinsAwarded);
    setLastIsFreeSpin(result.isFreeSpin);
    setBonusTriggerId((prev) => prev + 1);

    // Show evaluating state briefly
    setIsEvaluating(true);
    setIsSpinning(false);

    const evalDelay = setTimeout(() => {
      setIsEvaluating(false);
      // Drive FX dispatch for this spin
      fx.onSpinResolved(result, predict);
      // Now that the spin landed, mint a fresh idempotency key for the next press.
      spinLockRef.current = false;
      spinIdemKeyRef.current = null;
      pendingResultRef.current = null;

      // Continue autoplay if active
      if (autoplay.active) {
        const shouldStop = checkAutoplayStop(autoplay, result);
        if (!shouldStop) {
          const remaining = typeof autoplay.count === 'number' ? autoplay.remaining - 1 : Infinity;
          if (remaining > 0) {
            setAutoplay(prev => ({ ...prev, remaining }));
            // Wait long enough for any celebration to clear OR the lockout to lift.
            const delay = Math.max(700, fx.state.isLockedOut ? 3200 : 700);
            autoplayTimerRef.current = setTimeout(() => { void doSpin(); }, delay);
          } else {
            setAutoplay({ count: 0, remaining: 0, active: false });
          }
        } else {
          setAutoplay({ count: 0, remaining: 0, active: false });
        }
      }
    }, 350);

    return () => clearTimeout(evalDelay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoplay, predict, fx]);

  function checkAutoplayStop(ap: AutoplayState, result: SpinResult): boolean {
    if (ap.count === 'until-cashout') return false;
    if (ap.count === 'until-big-win') {
      // bigint-safe: stop when winAmount >= 10 × predict
      const predictBn = BigInt(Math.max(0, Math.floor(predict)));
      if (predictBn === 0n) return false;
      return result.winAmount >= predictBn * 10n;
    }
    return false;
  }

  // ── Autoplay toggle ─────────────────────────────────────────────────────
  const handleAutoplayChange = useCallback((count: AutoplayValue) => {
    if (count === 0) {
      setAutoplay({ count: 0, remaining: 0, active: false });
      if (autoplayTimerRef.current) clearTimeout(autoplayTimerRef.current);
      return;
    }
    const newState = initAutoplay(count);
    setAutoplay(newState);
    if (!isSpinning && !isEvaluating && !fx.state.isLockedOut && sessionBalance >= predict) {
      void doSpin();
    }
  }, [isSpinning, isEvaluating, sessionBalance, predict, doSpin, fx.state.isLockedOut]);

  // ── Fairness pop-over (lightweight; not a Modal) ────────────────────────
  const handleFairness = useCallback(() => {
    setFairnessTooltipOpen(true);
  }, []);

  // ── Predict validation — only multiples of CLASSIC_LINES.length=20 ──────
  const handlePredictChange = useCallback((next: number) => {
    if (next <= 0) return;
    if (next % 20 !== 0) {
      // Round to nearest valid stake.
      const rounded = Math.max(20, Math.round(next / 20) * 20);
      setPredict(rounded);
      return;
    }
    setPredict(next);
  }, []);

  // ── Reset state when the modal closes externally (e.g. /casino unmount) ─
  useEffect(() => {
    if (!slotScreenOpen) {
      pendingResultRef.current = null;
      spinLockRef.current = false;
      spinIdemKeyRef.current = null;
      setDisplayWindow(null);
      setPendingWinLines([]);
      setLastWildMultipliers([]);
      setLastScatterCells([]);
      setLastScatterPayout(0n);
      setLastFreeSpinsAwarded(0);
      setLastIsFreeSpin(false);
      setInFreeSpin(false);
      setFreeSpinsRemaining(0);
      setIsEvaluating(false);
      clearSessionMeta();
    }
  }, [slotScreenOpen, clearSessionMeta]);

  // ── Compact fairness HUD chip (placed below the title strip) ────────────
  const fairnessSummary = useMemo(() => {
    if (!serverSeedHash) return 'Fairness: open a spin to commit seed';
    const short = `${serverSeedHash.slice(0, 8)}…${serverSeedHash.slice(-6)}`;
    return revealedServerSeed
      ? `Seed revealed: ${revealedServerSeed.slice(0, 6)}…${revealedServerSeed.slice(-4)}`
      : `Committed: ${short}`;
  }, [serverSeedHash, revealedServerSeed]);

  if (!slotScreenOpen) return null;

  return (
    <>
      <style>{`
        /* Mobile: scale cell size */
        @media (max-width: 480px) {
          :root { --slot-cell-size: 52px; }
        }
        @media (min-width: 481px) and (max-width: 640px) {
          :root { --slot-cell-size: 60px; }
        }
        @media (min-width: 641px) and (max-width: 900px) {
          :root { --slot-cell-size: 70px; }
        }
        @media (min-width: 901px) {
          :root { --slot-cell-size: 80px; }
        }
      `}</style>

      {/* Full-viewport overlay */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Slot Machine"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9990,
          display: 'flex',
          flexDirection: 'column',
          background:
            'radial-gradient(ellipse at 50% 30%, rgba(123,47,247,0.08) 0%, transparent 60%), ' +
            'linear-gradient(180deg, rgba(5,10,24,0.94) 0%, rgba(2,4,10,0.97) 100%)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
          animation: 'cv-modal-bg-in var(--cv-motion-base) var(--cv-ease-standard)',
        }}
      >
        {/* Modal card */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            maxWidth: 720,
            width: '100%',
            margin: '0 auto',
            position: 'relative',
            animation: 'cv-modal-in var(--cv-motion-base) var(--cv-ease-bounce)',
          }}
        >
          {/* ── Header ─────────────────────────────────────────────── */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: 'var(--cv-space-4) var(--cv-space-5)',
              background: 'var(--cv-surface-1)',
              borderBottom: '1px solid rgba(0,255,224,0.15)',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--cv-space-3)' }}>
              <span style={{ fontSize: 24, filter: 'drop-shadow(0 0 6px rgba(0,255,224,0.4))' }}>🎰</span>
              <div>
                <div style={{
                  color: 'var(--cv-neon-cyan)',
                  fontFamily: 'monospace',
                  fontSize: 14,
                  fontWeight: 800,
                  letterSpacing: '0.12em',
                  textShadow: '0 0 10px rgba(0,255,224,0.4)',
                }}>
                  CLASSIC 3×5
                </div>
                <div style={{
                  color: 'rgba(255,255,255,0.4)',
                  fontFamily: 'monospace',
                  fontSize: 10,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                }}>
                  20 Paylines · 96% RTP · Provably Fair
                </div>
              </div>
            </div>

            <NeonButton
              variant="ghost"
              size="sm"
              onClick={handleCashOut}
              aria-label="Close slot machine"
              style={{ width: 38, padding: 0, fontSize: 18 }}
            >✕</NeonButton>
          </div>

          {/* ── Fairness chip ──────────────────────────────────────── */}
          <div
            onClick={handleFairness}
            role="button"
            aria-label="Show fairness commitment"
            style={{
              padding: '6px 14px',
              background: 'rgba(0, 255, 224, 0.06)',
              borderBottom: '1px solid rgba(0,255,224,0.08)',
              color: 'rgba(0,255,224,0.85)',
              fontFamily: 'monospace',
              fontSize: 11,
              letterSpacing: '0.05em',
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <span>🔐 {fairnessSummary}</span>
            <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10 }}>tap to verify</span>
          </div>

          {/* ── HUD top strip + bottom controls ─────────────────────── */}
          <SlotHUD
            balance={sessionBalance}
            sessionPnl={sessionPnl}
            spinCount={spinCount}
            predict={predict}
            minPredict={20}
            maxPredict={2000}
            isSpinning={isSpinning || openSession.isPending || spin.isPending}
            isEvaluating={isEvaluating}
            isLockedOut={fx.state.isLockedOut}
            autoplayCount={autoplay.count}
            isMuted={muted}
            inFreeSpin={inFreeSpin}
            freeSpinsRemaining={freeSpinsRemaining}
            onPredictChange={handlePredictChange}
            onSpin={() => { void doSpin(); }}
            onAutoplayChange={handleAutoplayChange}
            onMuteToggle={toggleMute}
            onPaytableOpen={() => setPaytableOpen(true)}
            onFairnessOpen={handleFairness}
            onWalkAway={() => { void handleCashOut(); }}
          />

          {/* ── Reel area ───────────────────────────────────────────── */}
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: `
                radial-gradient(ellipse at 50% 30%, rgba(0,255,224,0.07) 0%, transparent 65%),
                radial-gradient(ellipse at 50% 80%, rgba(255,0,204,0.04) 0%, transparent 60%),
                linear-gradient(180deg, rgba(5,10,24,0.98) 0%, rgba(2,4,10,0.99) 100%)
              `,
              padding: 'var(--cv-space-6) var(--cv-space-4)',
              position: 'relative',
              minHeight: 0,
              filter: fx.state.isGlowActive ? 'saturate(1.15)' : 'saturate(1)',
              transition: 'filter var(--cv-motion-base) var(--cv-ease-standard)',
            }}
          >
            {/* Decorative corner lights */}
            {(['topleft','topright','botleft','botright'] as const).map((pos) => (
              <div
                key={pos}
                style={{
                  position: 'absolute',
                  width: 10, height: 10,
                  borderRadius: '50%',
                  background: 'var(--cv-neon-cyan)',
                  boxShadow: '0 0 14px var(--cv-neon-cyan), 0 0 28px var(--cv-neon-cyan)',
                  ...(pos === 'topleft'  ? { top: 14, left: 14  } : {}),
                  ...(pos === 'topright' ? { top: 14, right: 14 } : {}),
                  ...(pos === 'botleft'  ? { bottom: 14, left: 14  } : {}),
                  ...(pos === 'botright' ? { bottom: 14, right: 14 } : {}),
                  opacity: isSpinning ? 1 : 0.55,
                  transition: 'opacity 0.3s var(--cv-ease-standard)',
                  pointerEvents: 'none',
                }}
              />
            ))}

            {/* Machine title */}
            <div
              style={{
                position: 'absolute',
                top: 14,
                left: '50%',
                transform: 'translateX(-50%)',
                color: 'rgba(0,255,224,0.45)',
                fontFamily: 'monospace',
                fontSize: 11,
                letterSpacing: '0.28em',
                textTransform: 'uppercase',
                textShadow: '0 0 10px rgba(0,255,224,0.45)',
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              Predictive Gaming Cove
            </div>

            {/*
              Reel grid wrapper — `position: relative` so the bonus
              overlays (WildMultiplierBadge / ScatterCelebration) can
              absolute-position themselves against the SAME origin the
              SlotReels grid uses (outer padding 8px + per-reel padding
              4px). Both overlays consume the result of the LAST landed
              spin and only render when there's content to show.
              See WildMultiplierBadge.tsx / ScatterCelebration.tsx
              header comments for the cell-coord math.
            */}
            <div
              style={{
                position: 'relative',
                /* Reel grid is intrinsically sized by SlotReels; this
                   wrapper is just an anchor for absolute overlays. */
              }}
            >
              <SlotReels
                targetWindow={displayWindow}
                isSpinning={isSpinning}
                winningLines={pendingWinLines}
                onReelsSettled={handleReelsSettled}
                shakeLevel={fx.state.shakeLevel}
              />

              {/* Phase 6.1.5 — wild multiplier chips. Empty array on
                  classic-3x5; non-empty only on bonus paytable spins
                  where at least one WILD landed in the visible window.
                  `dimmed={!lastIsFreeSpin}` reflects the RTP-shape
                  decision: in BASE mode the multiplier is recorded but
                  not applied to line wins (potential chip); in FS mode
                  it IS applied (active chip). */}
              {!isSpinning && lastWildMultipliers.map((wm) => (
                <WildMultiplierBadge
                  key={`wm-${bonusTriggerId}-${wm.reelIndex}-${wm.rowIndex}`}
                  reelIndex={wm.reelIndex}
                  rowIndex={wm.rowIndex}
                  multiplier={wm.multiplier}
                  triggerId={bonusTriggerId}
                  dimmed={!lastIsFreeSpin}
                />
              ))}

              {/* Phase 6.1.5 — scatter sparkle bursts + counter pill.
                  Fires only when 3+ scatters land AND the spin awarded
                  a scatter payout (the component itself gates on
                  `cells.length >= 3` internally). */}
              <ScatterCelebration
                cells={lastScatterCells}
                scatterCount={lastScatterCells.length}
                scatterPayout={lastScatterPayout}
                triggerId={bonusTriggerId}
              />
            </div>
          </div>
        </div>

        {/* Toast — bottom-center over the modal but below paytable */}
        {toast && (
          <div
            role="status"
            aria-live="polite"
            style={{
              position: 'fixed',
              bottom: 90,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 10000,
              padding: '10px 18px',
              borderRadius: 10,
              maxWidth: 460,
              textAlign: 'center',
              fontSize: 13,
              fontFamily: 'monospace',
              background:
                toast.tone === 'error'
                  ? 'rgba(255, 56, 96, 0.16)'
                  : toast.tone === 'warn'
                    ? 'rgba(255, 200, 87, 0.16)'
                    : 'rgba(0, 255, 224, 0.12)',
              border: `1px solid ${
                toast.tone === 'error'
                  ? 'rgba(255, 56, 96, 0.6)'
                  : toast.tone === 'warn'
                    ? 'rgba(255, 200, 87, 0.6)'
                    : 'rgba(0, 255, 224, 0.5)'
              }`,
              color:
                toast.tone === 'error'
                  ? '#ff8aa0'
                  : toast.tone === 'warn'
                    ? '#ffd684'
                    : '#9bfff0',
              boxShadow: '0 0 16px rgba(0,0,0,0.5)',
              animation: 'cv-modal-in var(--cv-motion-base) var(--cv-ease-standard)',
            }}
          >
            {toast.message}
          </div>
        )}

        {/* Fairness tooltip card */}
        {fairnessTooltipOpen && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Fairness commitment"
            onClick={() => setFairnessTooltipOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 10001,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(0,0,0,0.55)',
              padding: 20,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: 'rgba(5, 10, 24, 0.96)',
                border: '1px solid rgba(0,255,224,0.35)',
                borderRadius: 14,
                padding: 24,
                maxWidth: 540,
                width: '100%',
                color: '#e0fff8',
                fontFamily: 'monospace',
                fontSize: 13,
                lineHeight: 1.5,
                boxShadow: '0 0 32px rgba(0, 255, 224, 0.18)',
              }}
            >
              <div style={{ color: 'var(--cv-neon-cyan)', fontWeight: 800, fontSize: 15, letterSpacing: '0.08em', marginBottom: 12 }}>
                PROVABLY FAIR
              </div>
              <p style={{ margin: '0 0 12px 0', color: 'rgba(255,255,255,0.7)' }}>
                Before any spin, the server publishes <code>sha256(serverSeed)</code> as a commitment.
                It cannot change the seed after seeing your clientSeed + nonce.
              </p>
              <div style={{ display: 'grid', gap: 8, fontSize: 11 }}>
                <div>
                  <span style={{ color: 'rgba(0,255,224,0.6)' }}>Server seed hash: </span>
                  <span style={{ wordBreak: 'break-all' }}>
                    {serverSeedHash ?? '— (no session open yet)'}
                  </span>
                </div>
                <div>
                  <span style={{ color: 'rgba(0,255,224,0.6)' }}>Client seed: </span>
                  <span style={{ wordBreak: 'break-all' }}>
                    {useCasinoStore.getState().clientSeed ?? '—'}
                  </span>
                </div>
                {revealedServerSeed ? (
                  <div>
                    <span style={{ color: 'rgba(255,200,87,0.85)' }}>Revealed server seed: </span>
                    <span style={{ wordBreak: 'break-all' }}>{revealedServerSeed}</span>
                  </div>
                ) : (
                  <div style={{ color: 'rgba(255,255,255,0.45)' }}>
                    Server seed will be revealed when you cash out — use the verifier below to replay your spins.
                  </div>
                )}
              </div>
              <div style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {sessionId ? (
                  <Link
                    href={`/casino/verify/${sessionId}`}
                    target="_blank"
                    style={{
                      padding: '8px 14px',
                      borderRadius: 8,
                      background: 'rgba(0, 255, 224, 0.1)',
                      border: '1px solid rgba(0, 255, 224, 0.45)',
                      color: 'var(--cv-neon-cyan)',
                      textDecoration: 'none',
                      fontWeight: 700,
                      fontSize: 12,
                    }}
                  >
                    Verify this session →
                  </Link>
                ) : null}
                <Link
                  href="/casino/verify"
                  target="_blank"
                  style={{
                    padding: '8px 14px',
                    borderRadius: 8,
                    background: 'transparent',
                    border: '1px solid rgba(255,255,255,0.2)',
                    color: 'rgba(255,255,255,0.8)',
                    textDecoration: 'none',
                    fontWeight: 700,
                    fontSize: 12,
                  }}
                >
                  Manual verifier
                </Link>
                <NeonButton size="sm" variant="ghost" onClick={() => setFairnessTooltipOpen(false)}>
                  Close
                </NeonButton>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Win celebration overlay (5-tier dispatcher reads from useFX) */}
      <WinCelebration fx={fx.state} />

      {/* Phase 6.1.5 — free-spin trigger banner. Fires when the last
          spin awarded freeSpinsAwarded > 0 (`bonusTriggerId` flip drives
          the show/hide cycle). Component honors prefers-reduced-motion
          internally. */}
      <FreeSpinBanner
        freeSpinsAwarded={lastFreeSpinsAwarded}
        triggerId={bonusTriggerId}
        isRetrigger={lastIsFreeSpin}
      />

      {/* Paytable modal — stacks on top of slot modal */}
      <PaytableModal
        isOpen={paytableOpen}
        onClose={() => setPaytableOpen(false)}
      />
    </>
  );
}
