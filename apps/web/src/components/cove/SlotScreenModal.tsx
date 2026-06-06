'use client';

/**
 * SlotScreenModal — full-viewport slot machine UI with R3F 3D reel rig.
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
 * Phase 6.1.6: 2D SlotReels grid replaced with SlotReelsCanvas (R3F 3D
 *   cylinder drums). `spinTrigger` counter increments on each spin press to
 *   drive the 3D reel animation independently of React re-render cycles.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { CLASSIC_LINES } from '@clawville/shared';
import { useCoveStore } from '@/stores/cove';
import type { SpinResult } from '@/lib/cove/types';
import { useFX } from '@/lib/cove/useFX';
import {
  CoveApiError,
  describeCoveError,
  fetchCurrentSlotSession,
  spinResponseToSpinResult,
  useCloseSlotSession,
  useOpenSlotSession,
  useSpin,
  type SpinResponse,
} from '@/lib/cove/slot-api-client';
import SlotHUD from './SlotHUD';
import WinCelebration from './WinCelebration';
import PaytableModal from './PaytableModal';
import FreeSpinBanner from './FreeSpinBanner';
import WildMultiplierBadge from './WildMultiplierBadge';
import ScatterCelebration, { type ScatterCell } from './ScatterCelebration';
import SpinResultPanel from './SpinResultPanel';
import { NeonButton } from './ui';

// Import design tokens once at the module level.
import '@/styles/cove-tokens.css';

// SlotReelsCanvas — R3F 3D reel rig (dynamic import: canvas APIs are browser-only)
const SlotReelsCanvas = dynamic(() => import('./SlotReelsCanvas'), { ssr: false });

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
    lastSpinResult,
    closeSlotScreen,
    setIsSpinning,
    recordSpin,
    setSessionMeta,
    clearSessionMeta,
    setRevealedServerSeed,
  } = useCoveStore();

  // ── Local UI state ─────────────────────────────────────────────────────
  // Default predict = 20 (matches CLASSIC_LINES.length, smallest legal total-stake).
  const [predict, setPredict] = useState(20);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [paytableOpen, setPaytableOpen] = useState(false);
  const [fairnessTooltipOpen, setFairnessTooltipOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem('cove-muted') === '1'; } catch { return false; }
  });
  const [autoplay, setAutoplay] = useState<AutoplayState>({ count: 0, remaining: 0, active: false });

  // ── API hooks ──────────────────────────────────────────────────────────
  const openSession = useOpenSlotSession();
  const spin = useSpin();
  const closeSession = useCloseSlotSession();

  // ── FX hook (5-tier dispatcher) ────────────────────────────────────────
  const fx = useFX();

  // Phase 6.1.19 — showcase reel windows that match EXACT strip positions so
  // `findStripPosition` lands deterministically. Each [top, mid, bot] triplet
  // below is a real (p-1, p, p+1) slice of CLASSIC_REEL_STRIPS / BONUS_REEL_
  // STRIPS — verified against packages/shared/.../slot-paytables.ts.
  //
  // Classic — all 10 symbols (id 0-9) appear at least once across the 15 cells:
  //   middle row = BAR, BAR×3, Seven, BAR×2, WILD (all 5 high-pay)
  //   top/bot rows = Robot, Claw, Squirrel, Eliza, Milady (low-pay roster)
  const CLASSIC_SHOWCASE: number[][] = [
    [1, 5, 2],  // reel 0 @ p=8   — Robot,    BAR,    Eliza
    [0, 9, 4],  // reel 1 @ p=58  — Claw,     BAR×3,  Milady
    [1, 6, 3],  // reel 2 @ p=75  — Robot,    Seven,  Squirrel
    [3, 8, 2],  // reel 3 @ p=8   — Squirrel, BAR×2,  Eliza
    [1, 7, 1],  // reel 4 @ p=58  — Robot,    WILD,   Robot
  ];

  // Bonus — middle row showcases scatter mechanics: 3 scatters spread across
  // reels 0/2/4 (the bonus-trigger threshold) + WILD on reel 1 + Seven on reel 3.
  // Hits id 10 scatter and id 7 wild to advertise the paytable's exclusive
  // mechanics at a glance.
  const BONUS_SHOWCASE: number[][] = [
    [3,  10, 2],  // reel 0 @ p=12  — Squirrel, Scatter, Eliza
    [3,  7,  0],  // reel 1 @ p=25  — Squirrel, WILD,    Claw
    [2,  10, 4],  // reel 2 @ p=62  — Eliza,    Scatter, Milady
    [0,  6,  0],  // reel 3 @ p=58  — Claw,     Seven,   Claw
    [2,  10, 4],  // reel 4 @ p=11  — Eliza,    Scatter, Milady
  ];

  // Current reel window to display.
  // Initial value is paytable-aware showcase so the open modal advertises the
  // roster without forcing a spin. First /spin call replaces it with server result.
  const [displayWindow, setDisplayWindow] = useState<number[][] | null>(
    paytableId === 'classic-3x5-bonus' ? BONUS_SHOWCASE : CLASSIC_SHOWCASE,
  );
  const [pendingWinLines, setPendingWinLines] = useState<SpinResult['winningLines']>([]);

  // Increments each spin press to trigger the 3D reel animation
  const [spinTrigger, setSpinTrigger] = useState(0);

  // Deduplicated winning cells for the 3D reel highlight cascade
  const winningCells3D = useMemo(() => {
    const seen  = new Set<string>();
    const cells: { reel: number; row: number }[] = [];
    for (const wl of pendingWinLines) {
      const lineDef = CLASSIC_LINES.find(l => l.id === wl.lineIndex);
      if (!lineDef) continue;
      for (let r = 0; r < 5; r++) {
        const key = `${r}:${lineDef.rows[r]}`;
        if (!seen.has(key)) {
          seen.add(key);
          cells.push({ reel: r, row: lineDef.rows[r] });
        }
      }
    }
    return cells;
  }, [pendingWinLines]);

  // ── Phase 6.1.5 bonus-mechanic display state ─────────────────────────────
  const [lastWildMultipliers, setLastWildMultipliers] = useState<SpinResult['wildMultipliers']>([]);
  const [lastScatterCells, setLastScatterCells] = useState<ScatterCell[]>([]);
  const [lastScatterPayout, setLastScatterPayout] = useState<bigint>(0n);
  const [lastFreeSpinsAwarded, setLastFreeSpinsAwarded] = useState(0);
  const [lastIsFreeSpin, setLastIsFreeSpin] = useState(false);
  const [bonusTriggerId, setBonusTriggerId] = useState(0);
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
    // Fire-and-forget close any open server-side session — prevents the
    // 409 "You already have an open slot session" trap on next re-open.
    // Skipped when revealedServerSeed is set (cash-out already closed it).
    // Also gated on "no spin in flight" to prevent racing the spin's
    // FOR UPDATE lock — see Phase 6.1.7 adversary audit, 2026-05-19.
    if (
      sessionId &&
      !revealedServerSeed &&
      !spinLockRef.current &&
      !isSpinning &&
      !isEvaluating
    ) {
      closeSession.mutate({ sessionId });
    }
    closeSlotScreen();
  }, [sessionId, revealedServerSeed, isSpinning, isEvaluating, closeSession, closeSlotScreen, fx]);

  const handleCashOut = useCallback(async () => {
    // Stop autoplay BEFORE the await so the 700ms reschedule in
    // handleReelsSettled cannot fire a /spin into a session that's
    // about to close (race produces a "session_not_open" toast in the
    // 1200ms gap between closeSession resolving and handleClose firing).
    if (autoplayTimerRef.current) clearTimeout(autoplayTimerRef.current);
    setAutoplay({ count: 0, remaining: 0, active: false });
    if (!sessionId) {
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
      setTimeout(() => handleClose(), 1200);
    } catch (err) {
      showToast(describeCoveError(err), 'error');
    }
  }, [sessionId, closeSession, setRevealedServerSeed, handleClose, showToast]);

  // ── Mute persistence ────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    setMuted(prev => {
      const next = !prev;
      try { localStorage.setItem('cove-muted', next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);

  const doSpin = useCallback(async () => {
    // Belt-and-suspenders against double-fire on a single press:
    // (1) `spinLockRef` is the synchronous guard — set inside this fn
    //     before the first await, so a re-entrant call from React's
    //     same micro-task lane is a hard no-op.
    // (2) `spin.isPending` / `openSession.isPending` catch the case
    //     where Zustand's `isSpinning` hasn't propagated yet but a
    //     mutation is already on the wire — TanStack's pending state
    //     flips synchronously inside `mutate()` / `mutateAsync()`.
    // (3) `closeSession.isPending` catches the rare path where a
    //     fire-and-forget close from a prior `handleClose` is still on
    //     the wire — issuing a /spin against a sessionId the server is
    //     about to close races into a counter-changed 409.
    if (spinLockRef.current) return;
    if (spin.isPending || openSession.isPending || closeSession.isPending) return;
    if (fx.state.isLockedOut) return;
    // Balance gate — but bypass when the player is mid-free-spin. Free spins
    // cost zero predict server-side; gating on `sessionBalance < predict`
    // would lock out a player who hit the bonus then refreshed back into a
    // low-CT state.
    if (!(inFreeSpin && freeSpinsRemaining > 0) && sessionBalance < predict) return;
    if (!paytableId) return;
    spinLockRef.current = true;
    setPendingWinLines([]);
    fx.onSpinStart();
    setIsSpinning(true);
    // Increment trigger so the 3D reel rig starts its animation
    setSpinTrigger(prev => prev + 1);

    try {
      let activeSessionId = sessionId;
      // `effectivePredict` is what this spin will actually wager. If we
      // adopt an existing server session, its `startingBalance` is the
      // authoritative pinned predict and supersedes the local chip — using
      // the React-state `predict` here would lose the chip-snap to the
      // very spin that triggered it, hitting 400
      // predict_must_equal_session_reserved_predict on the wire.
      let effectivePredict = predict;
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
          walletBalance: opened.walletBalance,
        });
        const sessionPredict = Number(opened.startingBalance);
        if (Number.isFinite(sessionPredict) && sessionPredict > 0 && sessionPredict !== predict) {
          setPredict(sessionPredict);
          showToast(`Resumed session — predict locked to ${sessionPredict}`, 'info');
          effectivePredict = sessionPredict;
        }
      }

      if (!spinIdemKeyRef.current) {
        spinIdemKeyRef.current = crypto.randomUUID();
      }
      const idemKey = spinIdemKeyRef.current;

      const res: SpinResponse = await spin.mutateAsync({
        sessionId: activeSessionId,
        predict: effectivePredict.toString(),
        idempotencyKey: idemKey,
      });

      const spinResult = spinResponseToSpinResult(res);
      pendingResultRef.current = spinResult;
      recordSpin(spinResult, res.balance, res.spinCount);
      setInFreeSpin(res.mode === 'free-spin');
      setFreeSpinsRemaining(res.freeSpinsRemaining);
      // Feed reels to 3D rig immediately so it can compute decel targets while
      // still animating. Without this, reels=null until handleReelsSettled fires,
      // which itself waits for the animation — a deadlock.
      setDisplayWindow(spinResult.reels);
    } catch (err) {
      pendingResultRef.current = null;
      setIsSpinning(false);
      fx.reset();
      spinLockRef.current = false;
      spinIdemKeyRef.current = null;
      if (autoplayTimerRef.current) clearTimeout(autoplayTimerRef.current);
      setAutoplay({ count: 0, remaining: 0, active: false });
      // Stale-session recovery: 404 / session_not_open from /spin means our
      // local sessionId no longer maps to a server-open session (closed by
      // operator, expired, or never replicated). Clear the local pointer so
      // the next spin press triggers a fresh /session/open.
      //
      // `session_already_open` is no longer surfaced from /session/open —
      // the route is idempotent now (Task #7) and returns the existing
      // session as a 200. Only /session/close can still 409 with that code
      // if the session was closed concurrently; treat that as terminal
      // stale-session too.
      if (err instanceof CoveApiError && (
        err.status === 404 ||
        err.code === 'session_already_open' ||
        err.code === 'session_not_open'
      )) {
        clearSessionMeta();
      }
      // Auto-recover from "different paytable already open" — close the
      // stranded session (revealing its seed for verifier-replay) then
      // surface a single toast. Player can repress SPIN to open the new
      // paytable cleanly.
      if (err instanceof CoveApiError && err.code?.startsWith('session_already_open_different_paytable')) {
        const idMatch = err.serverMessage.match(/existingSessionId=([a-f0-9-]+)/);
        const ptMatch = err.serverMessage.match(/open=([\w-]+)/);
        if (idMatch) {
          const oldSessionId = idMatch[1];
          const oldPaytable  = ptMatch ? ptMatch[1] : 'previous session';
          closeSession.mutateAsync({ sessionId: oldSessionId }).then((closed) => {
            showToast(
              `Auto-closed ${oldPaytable} (seed ${closed.serverSeed.slice(0, 8)}…${closed.serverSeed.slice(-6)} revealed). Press SPIN again to start ${paytableId}.`,
              'info',
            );
            clearSessionMeta();
          }).catch(() => {
            showToast('Could not auto-close the previous session. Refresh the page and try again.', 'error');
          });
        }
      }
      // Diagnostic: when the server reports a counter-changed race, log
      // the full client-side state at the moment of the 409 so we can
      // bisect frontend vs backend causation in browser-live. Dev-only —
      // d90d160 close-gate should drive prod 409 rate to ~zero.
      if (
        process.env.NODE_ENV !== 'production' &&
        err instanceof CoveApiError &&
        err.code === 'session_counter_changed_retry'
      ) {
        // eslint-disable-next-line no-console
        console.warn('[cove-slots] 409 session_counter_changed_retry', {
          sessionId,
          spinIsPending: spin.isPending,
          openIsPending: openSession.isPending,
          closeIsPending: closeSession.isPending,
          isSpinningStore: isSpinning,
          spinLockBefore: 'set-true-before-throw',
          predict,
          serverMessage: err.serverMessage,
        });
      }
      const message = describeCoveError(err);
      const tone: ToastTone =
        err instanceof CoveApiError && err.status === 429
          ? 'warn'
          : err instanceof CoveApiError && err.status >= 500
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
    closeSession,
    setSessionMeta,
    clearSessionMeta,
    recordSpin,
    showToast,
    isSpinning,
  ]);

  // ── Eager session restore on modal mount ─────────────────────────────────
  //
  // After a page refresh, Zustand state is empty but the server may still
  // have an open session for this user. Discover it via GET /session/current
  // and adopt its sessionId + seed + pinned predict BEFORE the player presses
  // SPIN. This eliminates the "first SPIN fails with predict mismatch + reel
  // animation hangs" trap that the previous lazy-on-first-press flow could
  // hit when local chip != session.startingBalance.
  //
  // Runs ONCE per modal open (slotScreenOpen 0→1 edge). Idempotent: if we
  // already have a local sessionId set, no-op (e.g. the user just clicked
  // a fresh cabinet in the same tab).
  useEffect(() => {
    if (!slotScreenOpen) return;
    if (sessionId) return;            // already populated this session
    let cancelled = false;
    void (async () => {
      try {
        const current = await fetchCurrentSlotSession();
        if (cancelled || !current) return;
        if (current.session.status !== 'open') return;
        // Adopt the server session into local state.
        setSessionMeta({
          sessionId:      current.session.id,
          serverSeedHash: current.session.serverSeedHash,
          clientSeed:     current.session.clientSeed,
          walletBalance:  current.walletBalance,
        });
        // Free-spin restore — preserve unspent free spins across refresh.
        // Without this, a player who earned 8 free spins, refreshed mid-bonus,
        // and re-entered the modal would see their free-spin balance
        // disappear from the HUD (server still has it, just invisible).
        const fs = current.session.freeSpinsRemaining;
        if (current.session.mode === 'free-spin' && fs > 0) {
          setInFreeSpin(true);
          setFreeSpinsRemaining(fs);
        }
        const sessionPredict = Number(current.session.startingBalance);
        if (Number.isFinite(sessionPredict) && sessionPredict > 0) {
          setPredict(sessionPredict);
          const fsSuffix = current.session.mode === 'free-spin' && fs > 0
            ? `, ${fs} free spin${fs === 1 ? '' : 's'} unspent`
            : '';
          showToast(
            `Resumed previous session — predict locked to ${sessionPredict}, ${current.session.spinCount} spin${current.session.spinCount === 1 ? '' : 's'} so far${fsSuffix}.`,
            'info',
          );
        }
      } catch {
        // Network blip or non-404 error — fall through to lazy-on-first-spin path.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotScreenOpen]);

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

  // Fairness tooltip Escape handler — independent of the modal-level
  // handler above (which bails when the tooltip is open). Without this,
  // Escape inside the open fairness tooltip is inert.
  useEffect(() => {
    if (!fairnessTooltipOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setFairnessTooltipOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fairnessTooltipOpen]);

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

    setIsEvaluating(true);
    setIsSpinning(false);

    const evalDelay = setTimeout(() => {
      setIsEvaluating(false);
      fx.onSpinResolved(result, predict);
      spinLockRef.current = false;
      spinIdemKeyRef.current = null;
      pendingResultRef.current = null;

      if (autoplay.active) {
        const shouldStop = checkAutoplayStop(autoplay, result);
        if (!shouldStop) {
          const remaining = typeof autoplay.count === 'number' ? autoplay.remaining - 1 : Infinity;
          if (remaining > 0) {
            setAutoplay(prev => ({ ...prev, remaining }));
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

  const handleFairness = useCallback(() => {
    setFairnessTooltipOpen(true);
  }, []);

  const handlePredictChange = useCallback((next: number) => {
    if (next <= 0) return;
    if (next % 20 !== 0) {
      const rounded = Math.max(20, Math.round(next / 20) * 20);
      setPredict(rounded);
      return;
    }
    setPredict(next);
  }, []);

  // ── Reset state when the modal closes externally ─────────────────────────
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

  // Phase 6.1.19 — re-seed the showcase reels whenever the modal opens or
  // the paytable changes. Without this, the reset-on-close effect above
  // would clear displayWindow to null on first mount (before openSlotScreen
  // fires) and the curated showcase would never appear.
  useEffect(() => {
    if (!slotScreenOpen) return;
    if (spinCount > 0) return;          // real spin result wins
    setDisplayWindow(paytableId === 'classic-3x5-bonus' ? BONUS_SHOWCASE : CLASSIC_SHOWCASE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotScreenOpen, paytableId]);

  const fairnessSummary = useMemo(() => {
    if (!serverSeedHash) return 'Fairness: open a spin to commit seed';
    const short = `${serverSeedHash.slice(0, 8)}…${serverSeedHash.slice(-6)}`;
    return revealedServerSeed
      ? `Seed revealed: ${revealedServerSeed.slice(0, 6)}…${revealedServerSeed.slice(-4)}`
      : `Committed: ${short}`;
  }, [serverSeedHash, revealedServerSeed]);

  if (!slotScreenOpen) return null;

  const toastClass = toast
    ? `pt-toast${toast.tone === 'warn' ? ' pt-toast-warn' : toast.tone === 'error' ? ' pt-toast-error' : ''}`
    : '';

  // Phase 6.1.17 — paytable-aware theming tokens for header gradient + accent
  // strip. Drives the only DOM-side visual difference between classic + bonus
  // outside the cabinet itself.
  const isBonusPaytable = paytableId === 'classic-3x5-bonus';
  const themeAccent     = isBonusPaytable ? '#ffd54f' : '#00d4ff';        // marquee strip color
  const themeAccentDeep = isBonusPaytable ? '#c8420e' : '#0066a8';        // gradient inner stop
  const themeName       = isBonusPaytable ? 'BONUS · scatters + free spins' : 'CLASSIC · 10 lines';

  return (
    <>
      <style>{`
        @media (max-width: 480px) { :root { --slot-cell-size: 52px; } }
        @media (min-width: 481px) and (max-width: 640px) { :root { --slot-cell-size: 60px; } }
        @media (min-width: 641px) and (max-width: 900px) { :root { --slot-cell-size: 70px; } }
        @media (min-width: 901px) { :root { --slot-cell-size: 80px; } }
        @keyframes pt-marquee-pulse {
          0%, 100% { opacity: 0.85; }
          50%      { opacity: 1; }
        }
      `}</style>

      {/* Backdrop — dims the cove behind the centered modal card */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Slot Machine"
        className="pt-modal-shell"
        data-paytable={paytableId ?? 'classic-3x5'}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9990,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 20,
          background: 'rgba(2, 16, 24, 0.78)',
          backdropFilter: 'blur(6px)',
          animation: 'cv-modal-bg-in var(--cv-motion-base) var(--cv-ease-standard)',
        }}
      >
        {/* Phase 6.1.18b — explicit grid: header / accent / reels(1fr) / chips.
            Action strip pinned at bottom via `auto` row; reel-frame fills
            residual space via `1fr min-height:0`. Aspect lock removed — the
            inner canvas adapts its ortho to the available aspect so cells
            stay square at any modal size. */}
        <div
          style={{
            display: 'grid',
            gridTemplateRows: 'auto auto minmax(0, 1fr) auto',
            minWidth: 0,
            minHeight: 0,
            width: '100%',
            maxWidth: 1080,
            maxHeight: 'min(90vh, 760px)',
            position: 'relative',
            borderRadius: 14,
            overflow: 'hidden',
            boxShadow: `0 24px 64px rgba(0, 0, 0, 0.55), 0 0 0 1px ${themeAccent}55`,
            background: 'var(--pt-velvet, #062e3b)',
            animation: 'cv-modal-in var(--cv-motion-base) var(--cv-ease-bounce)',
          }}
        >
          {/* ── Header (≤ 48px) — lock · name · close ──────────────── */}
          <header className="pt-header">
            <div className="pt-header-side">
              <button
                type="button"
                className="pt-icon-stroke"
                onClick={handleFairness}
                aria-label={`Fairness commitment: ${fairnessSummary}`}
                title={fairnessSummary}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="3" y="11" width="18" height="11" rx="1" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </button>
            </div>

            <div
              className="pt-header-title"
              style={{
                background: `linear-gradient(90deg, ${themeAccent} 0%, ${themeAccentDeep} 100%)`,
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                fontWeight: 800,
                letterSpacing: '0.08em',
              }}
            >
              Tide Pool Cove · {isBonusPaytable ? 'Bonus 3×5' : 'Classic 3×5'}
            </div>

            <div className="pt-header-side">
              <button
                type="button"
                className="pt-icon-stroke"
                onClick={handleCashOut}
                aria-label="Close slot machine"
                title="Close"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="18" y1="6" x2="6" y2="18" />
                </svg>
              </button>
            </div>
          </header>

          {/* Paytable accent strip — thin themed bar between header + reels.
              Cyan for classic, gold for bonus. Phase 6.1.17. */}
          <div
            style={{
              height: 26,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: `linear-gradient(90deg, transparent 0%, ${themeAccent}44 25%, ${themeAccent}88 50%, ${themeAccent}44 75%, transparent 100%)`,
              borderBottom: `1px solid ${themeAccent}66`,
              color: themeAccent,
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              animation: 'pt-marquee-pulse 3.2s ease-in-out infinite',
              userSelect: 'none',
            }}
          >
            {themeName}
          </div>

          {/* ── Reel hero — fills the grid 1fr row. Canvas's ortho follows
                 the resulting aspect at runtime so cells stay square. */}
          <div
            className={`pt-reel-frame${fx.state.isGlowActive ? ' pt-reel-frame-active' : ''}`}
            style={{ width: '100%', height: '100%', minHeight: 0 }}
          >
            {/* 3D reel canvas + bonus overlays — fills full reel area */}
            <div style={{ position: 'relative', width: '100%', height: '100%' }}>
              <SlotReelsCanvas
                reels={displayWindow}
                isSpinning={isSpinning}
                spinTrigger={spinTrigger}
                winningCells={winningCells3D}
                wildMultipliers={lastWildMultipliers}
                scatterCells={lastScatterCells.map(c => ({ reelIndex: c.reelIndex, rowIndex: c.rowIndex }))}
                onReelsSettled={handleReelsSettled}
                paytableId={paytableId ?? undefined}
                onSpinClick={() => { void doSpin(); }}
                spinDisabled={isSpinning || isEvaluating || openSession.isPending || spin.isPending || fx.state.isLockedOut}
              />

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

              <ScatterCelebration
                cells={lastScatterCells}
                scatterCount={lastScatterCells.length}
                scatterPayout={lastScatterPayout}
                triggerId={bonusTriggerId}
              />

              {/* Persistent result readout — replaces "what just happened?"
                  silence with a themed strip that lingers until the next spin. */}
              <SpinResultPanel
                lastSpin={lastSpinResult}
                predict={predict}
                isSpinning={isSpinning}
                isEvaluating={isEvaluating}
                inFreeSpin={inFreeSpin}
                freeSpinsRemaining={freeSpinsRemaining}
              />
            </div>
          </div>

          {/* ── Unified action strip (balance · chips · spin) ───────── */}
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
        </div>

        {/* Toast */}
        {toast && (
          <div role="status" aria-live="polite" className={toastClass}>
            {toast.message}
          </div>
        )}

        {/* Fairness tooltip */}
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
              background: 'rgba(6, 46, 59, 0.78)',
              padding: 20,
            }}
          >
            <div onClick={(e) => e.stopPropagation()} className="pt-fairness-modal">
              <div className="pt-fairness-eyebrow">Provably Fair</div>
              <div className="pt-fairness-title">Commitment & Reveal</div>
              <p style={{ margin: '0 0 14px 0', color: 'var(--pt-cream-soft)' }}>
                Before any spin, the server publishes <code>sha256(serverSeed)</code> as a
                commitment. It cannot change the seed after seeing your clientSeed + nonce.
              </p>
              <div style={{ display: 'grid', gap: 8, fontSize: 12, fontFamily: 'var(--pt-data)' }}>
                <div>
                  <span style={{ color: 'var(--pt-brass)' }}>Server seed hash: </span>
                  <span style={{ wordBreak: 'break-all', color: 'var(--pt-cream)' }}>
                    {serverSeedHash ?? '— (no session open yet)'}
                  </span>
                </div>
                <div>
                  <span style={{ color: 'var(--pt-brass)' }}>Client seed: </span>
                  <span style={{ wordBreak: 'break-all', color: 'var(--pt-cream)' }}>
                    {useCoveStore.getState().clientSeed ?? '—'}
                  </span>
                </div>
                {revealedServerSeed ? (
                  <div>
                    <span style={{ color: 'var(--pt-amber)' }}>Revealed server seed: </span>
                    <span style={{ wordBreak: 'break-all', color: 'var(--pt-cream)' }}>{revealedServerSeed}</span>
                  </div>
                ) : (
                  <div style={{ color: 'var(--pt-mute)' }}>
                    Server seed will be revealed when you cash out — use the verifier below to replay your spins.
                  </div>
                )}
              </div>
              <div style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {sessionId ? (
                  <Link
                    href={`/cove/verify/session/${sessionId}`}
                    target="_blank"
                    className="pt-btn pt-btn-ghost"
                    style={{ padding: '0 14px', height: 36, fontSize: 11, textDecoration: 'none' }}
                  >
                    Verify this session →
                  </Link>
                ) : null}
                <Link
                  href="/cove/verify"
                  target="_blank"
                  className="pt-btn pt-btn-ghost"
                  style={{ padding: '0 14px', height: 36, fontSize: 11, textDecoration: 'none' }}
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

      {/* Win celebration overlay */}
      <WinCelebration fx={fx.state} />

      <FreeSpinBanner
        freeSpinsAwarded={lastFreeSpinsAwarded}
        triggerId={bonusTriggerId}
        isRetrigger={lastIsFreeSpin}
      />

      <PaytableModal
        isOpen={paytableOpen}
        onClose={() => setPaytableOpen(false)}
      />
    </>
  );
}
