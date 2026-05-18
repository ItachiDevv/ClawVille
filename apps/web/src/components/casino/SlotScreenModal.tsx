'use client';

/**
 * SlotScreenModal — full-viewport 2D slot machine UI
 *
 * Opens on top of the casino 3D interior (z-index 9990).
 * Interior 3D scene stays mounted underneath — no route change.
 *
 * Architecture:
 *   - Reads open/close state from useCasinoStore
 *   - Delegates spin to mockSpin() (Phase 6.0); Phase 6.1 swaps to API call
 *   - Contains SlotReels, SlotHUD, WinCelebration, PaytableModal
 *   - ClawToken balance: from useCasinoStore.sessionBalance (in-memory, no API)
 *
 * Iris Xe safe: pure DOM/CSS overlay — zero extra draw calls on the 3D canvas.
 * The 3D canvas renders underneath at normal rate; this modal is DOM only.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useCasinoStore } from '@/stores/casino';
import { mockSpin } from '@/lib/casino/mock-engine';
import type { SpinResult } from '@/lib/casino/types';
import SlotHUD from './SlotHUD';
import WinCelebration from './WinCelebration';
import PaytableModal from './PaytableModal';

// SlotReels has complex CSS animation — dynamic import avoids SSR issues
const SlotReels = dynamic(() => import('./SlotReels'), { ssr: false });

// ---------------------------------------------------------------------------
// Autoplay state machine
// ---------------------------------------------------------------------------
type AutoplayValue = number | 'until-cashout' | 'until-big-win';

interface AutoplayState {
  count: AutoplayValue;
  remaining: number;  // only meaningful when count is a number
  active: boolean;
}

function initAutoplay(count: AutoplayValue): AutoplayState {
  return {
    count,
    remaining: typeof count === 'number' ? count : Infinity,
    active: count !== 0,
  };
}

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------
export default function SlotScreenModal() {
  const {
    slotScreenOpen,
    machineSlug,
    paytableId,
    sessionBalance,
    sessionPnl,
    spinCount,
    isSpinning,
    lastSpinResult,
    closeSlotScreen,
    setIsSpinning,
    recordSpin,
  } = useCasinoStore();

  // ── Local UI state ─────────────────────────────────────────────────────
  const [bet, setBet] = useState(10);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [paytableOpen, setPaytableOpen] = useState(false);
  const [winAmount, setWinAmount] = useState(0);
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem('casino-muted') === '1'; } catch { return false; }
  });
  const [autoplay, setAutoplay] = useState<AutoplayState>({ count: 0, remaining: 0, active: false });

  // Current reel window to display
  const [displayWindow, setDisplayWindow] = useState<number[][] | null>(null);
  const [pendingWinLines, setPendingWinLines] = useState<SpinResult['winningLines']>([]);

  const spinLockRef = useRef(false); // prevent double-spin
  const autoplayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Keyboard handler ────────────────────────────────────────────────────
  useEffect(() => {
    if (!slotScreenOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (!isSpinning && !isEvaluating && sessionBalance >= bet) {
          doSpin();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotScreenOpen, isSpinning, isEvaluating, sessionBalance, bet]);

  // ── Close handler ───────────────────────────────────────────────────────
  const handleClose = useCallback(() => {
    if (autoplayTimerRef.current) clearTimeout(autoplayTimerRef.current);
    setAutoplay({ count: 0, remaining: 0, active: false });
    setWinAmount(0);
    setPendingWinLines([]);
    closeSlotScreen();
  }, [closeSlotScreen]);

  // ── Mute persistence ────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    setMuted(prev => {
      const next = !prev;
      try { localStorage.setItem('casino-muted', next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);

  // ── Core spin logic ─────────────────────────────────────────────────────
  const doSpin = useCallback(() => {
    if (spinLockRef.current) return;
    if (sessionBalance < bet) return;
    if (!paytableId) return;

    spinLockRef.current = true;
    setWinAmount(0);
    setPendingWinLines([]);
    setIsSpinning(true);
  }, [bet, paytableId, sessionBalance, setIsSpinning]);

  // When isSpinning flips true, compute the result immediately
  // The result is held until reels settle (onReelsSettled callback)
  const pendingResultRef = useRef<SpinResult | null>(null);

  useEffect(() => {
    if (!isSpinning || !paytableId) return;

    // Compute result now (decouple from animation)
    const result = mockSpin({ bet, paytableId });
    pendingResultRef.current = result;

    // Debit bet immediately in balance
    recordSpin(result, bet);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSpinning]);

  // ── Reel settled callback (called by SlotReels after last reel stops) ────
  const handleReelsSettled = useCallback(() => {
    const result = pendingResultRef.current;
    if (!result) {
      setIsSpinning(false);
      spinLockRef.current = false;
      return;
    }

    setDisplayWindow(result.reels);
    setPendingWinLines(result.winningLines);

    // Show evaluating state briefly
    setIsEvaluating(true);
    setIsSpinning(false);

    const evalDelay = setTimeout(() => {
      setIsEvaluating(false);
      const win = Number(result.winAmount);
      if (win > 0) {
        setWinAmount(win);
      }
      spinLockRef.current = false;

      // Continue autoplay if active
      if (autoplay.active) {
        const shouldStop = checkAutoplayStop(autoplay, result);
        if (!shouldStop) {
          const remaining = typeof autoplay.count === 'number' ? autoplay.remaining - 1 : Infinity;
          if (remaining > 0) {
            setAutoplay(prev => ({ ...prev, remaining }));
            autoplayTimerRef.current = setTimeout(doSpin, 600);
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
  }, [autoplay]);

  function checkAutoplayStop(ap: AutoplayState, result: SpinResult): boolean {
    if (ap.count === 'until-cashout') return false; // cashout is manual
    if (ap.count === 'until-big-win') {
      const mult = Number(result.winAmount) / bet;
      return mult >= 10;
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
    if (!isSpinning && !isEvaluating && sessionBalance >= bet) {
      doSpin();
    }
  }, [isSpinning, isEvaluating, sessionBalance, bet, doSpin]);

  // ── Fairness placeholder ────────────────────────────────────────────────
  const handleFairness = useCallback(() => {
    // Phase 6.1 will wire this to /casino/verify
    alert('Provably-fair verifier coming in Phase 6.1.\nYour seed commitment will be shown here.');
  }, []);

  if (!slotScreenOpen) return null;

  return (
    <>
      <style>{`
        @keyframes slotModalIn {
          from { opacity: 0; transform: scale(0.96); }
          to   { opacity: 1; transform: scale(1); }
        }
        @keyframes slotModalBg {
          from { opacity: 0; }
          to   { opacity: 1; }
        }

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
          background: 'rgba(0,0,5,0.93)',
          backdropFilter: 'blur(2px)',
          animation: 'slotModalBg 0.25s ease',
        }}
      >
        {/* Modal card */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            maxWidth: 680,
            width: '100%',
            margin: '0 auto',
            position: 'relative',
            animation: 'slotModalIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
          }}
        >
          {/* ── Header ─────────────────────────────────────────────── */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '14px 20px',
              background: 'rgba(0,0,21,0.9)',
              borderBottom: '1px solid rgba(0,255,224,0.15)',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 20 }}>🎰</span>
              <div>
                <div style={{ color: '#00ffe0', fontFamily: 'monospace', fontSize: 14, fontWeight: 800, letterSpacing: '0.1em' }}>
                  CLASSIC 3×5
                </div>
                <div style={{ color: 'rgba(255,255,255,0.35)', fontFamily: 'monospace', fontSize: 10, letterSpacing: '0.06em' }}>
                  20 PAYLINES · 96% RTP
                </div>
              </div>
            </div>

            {/* Close X */}
            <button
              onClick={handleClose}
              aria-label="Close slot machine"
              style={{
                background: 'none',
                border: 'none',
                color: 'rgba(255,255,255,0.45)',
                fontSize: 22,
                cursor: 'pointer',
                padding: '4px 8px',
                lineHeight: 1,
                transition: 'color 0.15s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#ff4488'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.45)'; }}
            >
              ✕
            </button>
          </div>

          {/* ── Top HUD strip ──────────────────────────────────────── */}
          <SlotHUD
            balance={sessionBalance}
            sessionPnl={sessionPnl}
            spinCount={spinCount}
            bet={bet}
            minBet={1}
            maxBet={100}
            isSpinning={isSpinning}
            isEvaluating={isEvaluating}
            autoplayCount={autoplay.count}
            isMuted={muted}
            onBetChange={setBet}
            onSpin={doSpin}
            onAutoplayChange={handleAutoplayChange}
            onMuteToggle={toggleMute}
            onPaytableOpen={() => setPaytableOpen(true)}
            onFairnessOpen={handleFairness}
            onWalkAway={handleClose}
          />

          {/* ── Reel area ───────────────────────────────────────────── */}
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: `
                radial-gradient(ellipse at 50% 30%, rgba(0,255,224,0.06) 0%, transparent 70%),
                linear-gradient(180deg, rgba(0,0,21,0.98) 0%, rgba(5,0,30,0.98) 100%)
              `,
              padding: '24px 16px',
              position: 'relative',
              minHeight: 0,
            }}
          >
            {/* Decorative corner lights */}
            {['topleft','topright','botleft','botright'].map((pos) => (
              <div
                key={pos}
                style={{
                  position: 'absolute',
                  width: 8, height: 8,
                  borderRadius: '50%',
                  background: '#00ffe0',
                  boxShadow: '0 0 12px #00ffe0',
                  ...(pos === 'topleft'  ? { top: 12, left: 12  } : {}),
                  ...(pos === 'topright' ? { top: 12, right: 12 } : {}),
                  ...(pos === 'botleft'  ? { bottom: 12, left: 12  } : {}),
                  ...(pos === 'botright' ? { bottom: 12, right: 12 } : {}),
                  opacity: isSpinning ? 1 : 0.4,
                  transition: 'opacity 0.3s',
                  pointerEvents: 'none',
                }}
              />
            ))}

            {/* Machine title */}
            <div
              style={{
                position: 'absolute',
                top: 12,
                left: '50%',
                transform: 'translateX(-50%)',
                color: 'rgba(0,255,224,0.3)',
                fontFamily: 'monospace',
                fontSize: 11,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              PREDICTIVE GAMING COVE
            </div>

            {/* Reel grid */}
            <SlotReels
              targetWindow={displayWindow}
              isSpinning={isSpinning}
              winningLines={pendingWinLines}
              onReelsSettled={handleReelsSettled}
            />
          </div>

          {/* ── Bottom HUD controls already rendered inside SlotHUD ─ */}
          {/* (SlotHUD renders both top strip and bottom bar) */}
        </div>
      </div>

      {/* Win celebration — absolutely positioned, renders on top of modal */}
      <WinCelebration
        winAmount={winAmount}
        bet={bet}
        onComplete={() => setWinAmount(0)}
      />

      {/* Paytable modal — stacks on top of slot modal */}
      <PaytableModal
        isOpen={paytableOpen}
        onClose={() => setPaytableOpen(false)}
      />
    </>
  );
}
