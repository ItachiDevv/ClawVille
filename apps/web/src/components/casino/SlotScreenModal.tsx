'use client';

/**
 * SlotScreenModal — full-viewport 2D slot machine UI
 *
 * Polish pass (Concern 6.0.4):
 *   - Imports `casino-tokens.css` once at module level so every child
 *     component can reach the CSS variables.
 *   - Hosts the `useFX` hook and drives the FX state into SlotReels +
 *     WinCelebration.
 *   - SpinResult contract untouched. Mock engine still authoritative.
 *
 * Iris Xe safe: pure DOM/CSS overlay — zero extra draw calls on the 3D
 * canvas underneath. Modal is DOM only.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useCasinoStore } from '@/stores/casino';
import { mockSpin } from '@/lib/casino/mock-engine';
import type { SpinResult } from '@/lib/casino/types';
import { useFX } from '@/lib/casino/useFX';
import SlotHUD from './SlotHUD';
import WinCelebration from './WinCelebration';
import PaytableModal from './PaytableModal';
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

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------
export default function SlotScreenModal() {
  const {
    slotScreenOpen,
    paytableId,
    sessionBalance,
    sessionPnl,
    spinCount,
    isSpinning,
    closeSlotScreen,
    setIsSpinning,
    recordSpin,
  } = useCasinoStore();

  // ── Local UI state ─────────────────────────────────────────────────────
  const [bet, setBet] = useState(10);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [paytableOpen, setPaytableOpen] = useState(false);
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem('casino-muted') === '1'; } catch { return false; }
  });
  const [autoplay, setAutoplay] = useState<AutoplayState>({ count: 0, remaining: 0, active: false });

  // ── FX hook (5-tier dispatcher) ────────────────────────────────────────
  const fx = useFX();

  // Current reel window to display
  const [displayWindow, setDisplayWindow] = useState<number[][] | null>(null);
  const [pendingWinLines, setPendingWinLines] = useState<SpinResult['winningLines']>([]);

  const spinLockRef = useRef(false);
  const autoplayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingResultRef = useRef<SpinResult | null>(null);

  // ── Close handler ───────────────────────────────────────────────────────
  const handleClose = useCallback(() => {
    if (autoplayTimerRef.current) clearTimeout(autoplayTimerRef.current);
    setAutoplay({ count: 0, remaining: 0, active: false });
    setPendingWinLines([]);
    fx.reset();
    closeSlotScreen();
  }, [closeSlotScreen, fx]);

  // ── Mute persistence ────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    setMuted(prev => {
      const next = !prev;
      try { localStorage.setItem('casino-muted', next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);

  // ── Core spin trigger ───────────────────────────────────────────────────
  const doSpin = useCallback(() => {
    if (spinLockRef.current) return;
    if (fx.state.isLockedOut) return;
    if (sessionBalance < bet) return;
    if (!paytableId) return;

    spinLockRef.current = true;
    setPendingWinLines([]);
    fx.onSpinStart();
    setIsSpinning(true);
  }, [bet, fx, paytableId, sessionBalance, setIsSpinning]);

  // ── Keyboard handler ────────────────────────────────────────────────────
  useEffect(() => {
    if (!slotScreenOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Don't close while paytable modal is open — let it handle ESC.
        if (paytableOpen) return;
        handleClose();
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (!isSpinning && !isEvaluating && !fx.state.isLockedOut && sessionBalance >= bet) {
          doSpin();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [slotScreenOpen, isSpinning, isEvaluating, sessionBalance, bet, paytableOpen, doSpin, fx.state.isLockedOut, handleClose]);

  // When isSpinning flips true, compute the result immediately
  useEffect(() => {
    if (!isSpinning || !paytableId) return;
    const result = mockSpin({ bet, paytableId });
    pendingResultRef.current = result;
    recordSpin(result, bet);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSpinning]);

  // ── Reel settled callback ───────────────────────────────────────────────
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
      // Drive FX dispatch for this spin
      fx.onSpinResolved(result, bet);
      spinLockRef.current = false;

      // Continue autoplay if active
      if (autoplay.active) {
        const shouldStop = checkAutoplayStop(autoplay, result);
        if (!shouldStop) {
          const remaining = typeof autoplay.count === 'number' ? autoplay.remaining - 1 : Infinity;
          if (remaining > 0) {
            setAutoplay(prev => ({ ...prev, remaining }));
            // Wait long enough for any celebration to clear OR the lockout to lift.
            const delay = Math.max(700, fx.state.isLockedOut ? 3200 : 700);
            autoplayTimerRef.current = setTimeout(doSpin, delay);
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
  }, [autoplay, bet, fx]);

  function checkAutoplayStop(ap: AutoplayState, result: SpinResult): boolean {
    if (ap.count === 'until-cashout') return false;
    if (ap.count === 'until-big-win') {
      // bigint-safe: stop when winAmount >= 10 × bet
      const betBn = BigInt(Math.max(0, Math.floor(bet)));
      if (betBn === 0n) return false;
      return result.winAmount >= betBn * 10n;
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
    if (!isSpinning && !isEvaluating && !fx.state.isLockedOut && sessionBalance >= bet) {
      doSpin();
    }
  }, [isSpinning, isEvaluating, sessionBalance, bet, doSpin, fx.state.isLockedOut]);

  // ── Fairness placeholder ────────────────────────────────────────────────
  const handleFairness = useCallback(() => {
    alert('Provably-fair verifier coming in Phase 6.1.\nYour seed commitment will be shown here.');
  }, []);

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
                  20 Paylines · 96% RTP
                </div>
              </div>
            </div>

            <NeonButton
              variant="ghost"
              size="sm"
              onClick={handleClose}
              aria-label="Close slot machine"
              style={{ width: 38, padding: 0, fontSize: 18 }}
            >✕</NeonButton>
          </div>

          {/* ── HUD top strip + bottom controls ─────────────────────── */}
          <SlotHUD
            balance={sessionBalance}
            sessionPnl={sessionPnl}
            spinCount={spinCount}
            bet={bet}
            minBet={1}
            maxBet={100}
            isSpinning={isSpinning}
            isEvaluating={isEvaluating}
            isLockedOut={fx.state.isLockedOut}
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

            {/* Reel grid */}
            <SlotReels
              targetWindow={displayWindow}
              isSpinning={isSpinning}
              winningLines={pendingWinLines}
              onReelsSettled={handleReelsSettled}
              shakeLevel={fx.state.shakeLevel}
            />
          </div>
        </div>
      </div>

      {/* Win celebration overlay (5-tier dispatcher reads from useFX) */}
      <WinCelebration fx={fx.state} />

      {/* Paytable modal — stacks on top of slot modal */}
      <PaytableModal
        isOpen={paytableOpen}
        onClose={() => setPaytableOpen(false)}
      />
    </>
  );
}
