'use client';

/**
 * SlotHUD — Top balance strip + bottom controls
 *
 * Polish pass (Concern 6.0.4):
 *   - Uses design tokens from `casino-tokens.css`
 *   - NeonButton for SPIN, Walk Away, and icon utility buttons
 *   - BetChips replace the legacy +/− stepper on screens wide enough
 *   - Bottom bar sticks to the safe area on mobile
 *
 * SPIN button states:
 *   ready      → cyan neon primary
 *   spinning   → dimmed shimmer
 *   evaluating → brief pulse
 *   insufficient → greyed
 *   locked     → mega-win 3s lockout (separate from insufficient)
 *
 * Iris Xe safe: pure DOM/CSS, zero Three.js
 */

import { useCallback } from 'react';
import { NeonButton, BetChips } from './ui';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
export interface SlotHUDProps {
  balance: number;
  sessionPnl: number;
  spinCount: number;
  bet: number;
  minBet?: number;
  maxBet?: number;
  isSpinning: boolean;
  isEvaluating: boolean;
  isLockedOut?: boolean;
  autoplayCount: number | 'until-cashout' | 'until-big-win';
  isMuted: boolean;
  onBetChange: (bet: number) => void;
  onSpin: () => void;
  onAutoplayChange: (count: number | 'until-cashout' | 'until-big-win') => void;
  onMuteToggle: () => void;
  onPaytableOpen: () => void;
  onFairnessOpen: () => void;
  onWalkAway: () => void;
}

const AUTOPLAY_OPTIONS: Array<{ label: string; value: number | 'until-cashout' | 'until-big-win' }> = [
  { label: 'Off',           value: 0              },
  { label: '10 spins',      value: 10             },
  { label: '25 spins',      value: 25             },
  { label: '100 spins',     value: 100            },
  { label: 'Until cash-out',value: 'until-cashout' },
  { label: 'Win > 10× bet', value: 'until-big-win' },
];

// Phase 6.1 slice 5: bet must be divisible by CLASSIC_LINES.length=20.
// The slot-engine rejects non-divisible bets to avoid silent value-truncation
// in `perLineBet = bet / lineCount`.
const BET_CHIPS = [20, 40, 100, 200, 500, 1000];

// ---------------------------------------------------------------------------
// Spin button state
// ---------------------------------------------------------------------------
type SpinButtonState = 'ready' | 'spinning' | 'evaluating' | 'insufficient' | 'locked';

function getSpinState(
  isSpinning: boolean,
  isEvaluating: boolean,
  isLockedOut: boolean,
  balance: number,
  bet: number,
): SpinButtonState {
  if (isSpinning)    return 'spinning';
  if (isEvaluating)  return 'evaluating';
  if (isLockedOut)   return 'locked';
  if (balance < bet) return 'insufficient';
  return 'ready';
}

const SPIN_LABEL: Record<SpinButtonState, string> = {
  ready:        'SPIN',
  spinning:     'SPINNING…',
  evaluating:   'CHECKING…',
  insufficient: 'NO FUNDS',
  locked:       'MEGA WIN!',
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function SlotHUD({
  balance,
  sessionPnl,
  spinCount,
  bet,
  minBet = 1,
  maxBet = 100,
  isSpinning,
  isEvaluating,
  isLockedOut = false,
  autoplayCount,
  isMuted,
  onBetChange,
  onSpin,
  onAutoplayChange,
  onMuteToggle,
  onPaytableOpen,
  onFairnessOpen,
  onWalkAway,
}: SlotHUDProps) {
  const spinState = getSpinState(isSpinning, isEvaluating, isLockedOut, balance, bet);
  const disabled = spinState !== 'ready';

  // Step in multiples of 20 — server requires `bet % lineCount === 0`.
  const handleBetDown = useCallback(() => {
    onBetChange(Math.max(minBet, bet - 20));
  }, [bet, minBet, onBetChange]);

  const handleBetUp = useCallback(() => {
    onBetChange(Math.min(maxBet, bet + 20));
  }, [bet, maxBet, onBetChange]);

  const handleAutoplay = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (val === 'until-cashout' || val === 'until-big-win') {
      onAutoplayChange(val);
    } else {
      onAutoplayChange(Number(val));
    }
  }, [onAutoplayChange]);

  const pnlColor = sessionPnl > 0 ? 'var(--cv-tier-small)' : sessionPnl < 0 ? '#ff4466' : 'rgba(255,255,255,0.5)';
  const pnlSign  = sessionPnl > 0 ? '+' : '';

  return (
    <>
      <style>{`
        @keyframes cv-spin-shimmer {
          0%   { opacity: 0.55; }
          50%  { opacity: 0.85; }
          100% { opacity: 0.55; }
        }
        @keyframes cv-spin-evaluate {
          0%   { box-shadow: 0 0 12px rgba(0,170,255,0.4); }
          50%  { box-shadow: 0 0 28px rgba(0,170,255,0.85); }
          100% { box-shadow: 0 0 12px rgba(0,170,255,0.4); }
        }
        @keyframes cv-spin-locked {
          0%, 100% { box-shadow: 0 0 18px rgba(255,200,87,0.6); }
          50%      { box-shadow: 0 0 36px rgba(255,200,87,1); }
        }

        /* Stack HUD on mobile portrait */
        @media (max-width: 640px) {
          .cv-hud-bottom { flex-direction: column !important; align-items: stretch !important; gap: var(--cv-space-3) !important; }
          .cv-hud-spin-row { width: 100%; }
        }

        /* Hide chips on very narrow screens — stepper still works */
        @media (max-width: 380px) {
          .cv-bet-chips-wrap { display: none !important; }
        }

        /* Sticky bottom bar on mobile to clear the safe-area inset */
        @media (max-width: 640px) {
          .cv-hud-bottom {
            position: sticky;
            bottom: 12px;
            padding-bottom: calc(var(--cv-space-3) + env(safe-area-inset-bottom, 0px)) !important;
          }
        }
      `}</style>

      {/* ── Top strip ────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: 'var(--cv-space-3) var(--cv-space-5)',
        background: 'var(--cv-surface-1)',
        borderBottom: '1px solid rgba(0,255,224,0.12)',
        fontFamily: 'monospace',
        flexWrap: 'wrap',
        gap: 'var(--cv-space-3)',
      }}>
        {/* Balance */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Balance</span>
          <span style={{ color: 'var(--cv-neon-cyan)', fontSize: 22, fontWeight: 900, textShadow: '0 0 14px rgba(0,255,224,0.4)' }}>
            {balance.toLocaleString()}
          </span>
          <span style={{ color: 'rgba(0,255,224,0.45)', fontSize: 11 }}>CT</span>
        </div>

        {/* Session P&L */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Session</span>
          <span style={{ color: pnlColor, fontSize: 15, fontWeight: 700 }}>
            {pnlSign}{sessionPnl.toLocaleString()} CT
          </span>
        </div>

        {/* Spin count */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
          <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Spins</span>
          <span style={{ color: 'rgba(255,255,255,0.65)', fontSize: 14, fontWeight: 600 }}>{spinCount}</span>
        </div>
      </div>

      {/* ── Bottom control bar ───────────────────────────────────────────── */}
      <div
        className="cv-hud-bottom"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--cv-space-3)',
          padding: 'var(--cv-space-3) var(--cv-space-5)',
          background: 'var(--cv-surface-1)',
          borderTop: '1px solid rgba(0,255,224,0.12)',
          flexWrap: 'wrap',
          zIndex: 5,
        }}
      >
        {/* Bet stepper + chips */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--cv-space-2)', flex: '1 1 auto', flexWrap: 'wrap' }}>
          <span style={{
            color: 'rgba(255,255,255,0.5)',
            fontSize: 11,
            fontFamily: 'monospace',
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
          }}>BET</span>

          <NeonButton
            variant="secondary"
            size="sm"
            onClick={handleBetDown}
            disabled={isSpinning || bet <= minBet}
            aria-label="Decrease bet"
            style={{ minWidth: 32, padding: '0 10px' }}
          >−</NeonButton>

          <span style={{
            color: '#fff',
            fontSize: 18,
            fontWeight: 900,
            fontFamily: 'monospace',
            minWidth: 44,
            textAlign: 'center',
            textShadow: '0 0 10px rgba(0,255,224,0.35)',
          }}>
            {bet}
          </span>

          <NeonButton
            variant="secondary"
            size="sm"
            onClick={handleBetUp}
            disabled={isSpinning || bet >= maxBet}
            aria-label="Increase bet"
            style={{ minWidth: 32, padding: '0 10px' }}
          >+</NeonButton>

          <div className="cv-bet-chips-wrap" style={{ marginLeft: 'var(--cv-space-2)' }}>
            <BetChips
              options={BET_CHIPS}
              value={bet}
              onChange={onBetChange}
              disabled={isSpinning}
              ariaLabel="Bet size in ClawTokens"
            />
          </div>
        </div>

        {/* SPIN button */}
        <div className="cv-hud-spin-row" style={{ display: 'flex', justifyContent: 'center', flex: '0 0 auto' }}>
          <NeonButton
            variant="primary"
            size="lg"
            onClick={disabled ? undefined : onSpin}
            disabled={disabled}
            aria-label={SPIN_LABEL[spinState]}
            style={{
              minWidth: 160,
              animation:
                spinState === 'spinning'   ? 'cv-spin-shimmer 0.8s ease-in-out infinite'
                : spinState === 'evaluating' ? 'cv-spin-evaluate 0.5s ease-in-out 2'
                : spinState === 'locked'     ? 'cv-spin-locked 0.6s ease-in-out infinite'
                : undefined,
              fontSize: 18,
              letterSpacing: '0.2em',
            }}
          >
            {SPIN_LABEL[spinState]}
          </NeonButton>
        </div>

        {/* Autoplay select */}
        <select
          value={String(autoplayCount)}
          onChange={handleAutoplay}
          disabled={isSpinning}
          aria-label="Autoplay settings"
          style={{
            background: 'rgba(5,10,24,0.85)',
            border: '1px solid rgba(0,255,224,0.2)',
            borderRadius: 'var(--cv-radius-sm)',
            color: 'rgba(255,255,255,0.75)',
            fontSize: 12,
            fontFamily: 'monospace',
            letterSpacing: '0.04em',
            padding: '8px 12px',
            cursor: isSpinning ? 'not-allowed' : 'pointer',
            flex: '0 0 auto',
            height: 42,
          }}
        >
          {AUTOPLAY_OPTIONS.map((opt) => (
            <option key={String(opt.value)} value={String(opt.value)}>
              {opt.label}
            </option>
          ))}
        </select>

        {/* Icon utility buttons */}
        <div style={{ display: 'flex', gap: 'var(--cv-space-1)', flex: '0 0 auto' }}>
          <NeonButton
            variant="ghost"
            size="sm"
            onClick={onMuteToggle}
            aria-label={isMuted ? 'Unmute' : 'Mute'}
            title={isMuted ? 'Unmute' : 'Mute'}
            style={{ width: 36, padding: 0 }}
          >
            {isMuted ? '🔇' : '🔊'}
          </NeonButton>
          <NeonButton
            variant="ghost"
            size="sm"
            onClick={onPaytableOpen}
            aria-label="View paytable"
            title="View paytable"
            style={{ width: 36, padding: 0 }}
          >📊</NeonButton>
          <NeonButton
            variant="ghost"
            size="sm"
            onClick={onFairnessOpen}
            aria-label="Provably fair (coming soon)"
            title="Provably fair verifier (coming 6.1)"
            style={{ width: 36, padding: 0, opacity: 0.55 }}
          >🔐</NeonButton>
        </div>

        {/* Walk Away */}
        <NeonButton
          variant="secondary"
          size="md"
          onClick={onWalkAway}
          aria-label="Walk away — leave the slot screen"
          style={{
            color: 'rgba(255,120,160,0.95)',
            borderColor: 'rgba(255,0,100,0.35)',
          }}
        >
          Walk Away
        </NeonButton>
      </div>
    </>
  );
}
