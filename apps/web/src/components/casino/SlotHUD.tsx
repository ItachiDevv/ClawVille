'use client';

/**
 * SlotHUD — Top balance strip + bottom controls
 *
 * Top strip: balance, session P&L, spin count
 * Bottom bar: bet −/+/slider, SPIN button, autoplay dropdown,
 *             Walk Away button, mute toggle, paytable trigger, fairness
 *
 * SPIN button states:
 *   ready      → neon-cyan
 *   spinning   → dimmed shimmer
 *   evaluating → brief pulse
 *   insufficient_balance → greyed
 *
 * Mobile: slider hidden on small screens, only −/+ buttons
 * Iris Xe safe: pure DOM/CSS, zero Three.js
 */

import { useState, useCallback } from 'react';

export interface SlotHUDProps {
  balance: number;
  sessionPnl: number;
  spinCount: number;
  bet: number;
  minBet?: number;
  maxBet?: number;
  isSpinning: boolean;
  isEvaluating: boolean;
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

// ---------------------------------------------------------------------------
// Spin button state
// ---------------------------------------------------------------------------
type SpinButtonState = 'ready' | 'spinning' | 'evaluating' | 'insufficient';

function getSpinState(isSpinning: boolean, isEvaluating: boolean, balance: number, bet: number): SpinButtonState {
  if (isSpinning)    return 'spinning';
  if (isEvaluating)  return 'evaluating';
  if (balance < bet) return 'insufficient';
  return 'ready';
}

const SPIN_BTN_COLORS: Record<SpinButtonState, { bg: string; border: string; text: string; shadow: string }> = {
  ready:        { bg: '#00ffe0', border: '#00ffe0', text: '#000',        shadow: '0 0 24px #00ffe099' },
  spinning:     { bg: '#0a2020', border: '#00443a', text: '#00998c',     shadow: 'none' },
  evaluating:   { bg: '#003366', border: '#0055aa', text: '#66aaff',     shadow: '0 0 12px #0055aa66' },
  insufficient: { bg: '#1a1a1a', border: '#333',    text: '#555',        shadow: 'none' },
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
  const spinState = getSpinState(isSpinning, isEvaluating, balance, bet);
  const colors = SPIN_BTN_COLORS[spinState];
  const disabled = spinState !== 'ready';

  const handleBetDown = useCallback(() => {
    onBetChange(Math.max(minBet, bet - (bet >= 10 ? 5 : 1)));
  }, [bet, minBet, onBetChange]);

  const handleBetUp = useCallback(() => {
    onBetChange(Math.min(maxBet, bet + (bet >= 10 ? 5 : 1)));
  }, [bet, maxBet, onBetChange]);

  const handleBetSlider = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onBetChange(Number(e.target.value));
  }, [onBetChange]);

  const handleAutoplay = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (val === 'until-cashout' || val === 'until-big-win') {
      onAutoplayChange(val);
    } else {
      onAutoplayChange(Number(val));
    }
  }, [onAutoplayChange]);

  const pnlColor = sessionPnl > 0 ? '#00ff88' : sessionPnl < 0 ? '#ff4444' : 'rgba(255,255,255,0.5)';
  const pnlSign  = sessionPnl > 0 ? '+' : '';

  return (
    <>
      <style>{`
        @keyframes spinButtonShimmer {
          0%   { opacity: 0.6; }
          50%  { opacity: 0.85; }
          100% { opacity: 0.6; }
        }
        @keyframes spinButtonPulse {
          0%   { box-shadow: 0 0 12px #0055aa66; }
          50%  { box-shadow: 0 0 28px #0055aacc; }
          100% { box-shadow: 0 0 12px #0055aa66; }
        }

        /* Slider styling */
        .slot-bet-slider {
          -webkit-appearance: none;
          appearance: none;
          height: 4px;
          border-radius: 2px;
          background: linear-gradient(to right, #00ffe0 0%, #00ffe0 var(--pct), rgba(255,255,255,0.15) var(--pct));
          outline: none;
          cursor: pointer;
        }
        .slot-bet-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: #00ffe0;
          border: 2px solid #000;
          cursor: pointer;
          box-shadow: 0 0 6px #00ffe066;
        }
        .slot-bet-slider::-moz-range-thumb {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: #00ffe0;
          border: 2px solid #000;
          cursor: pointer;
        }

        /* Hide slider on mobile */
        @media (max-width: 640px) {
          .slot-bet-slider-wrap { display: none !important; }
        }

        /* Stack HUD on mobile portrait */
        @media (max-width: 640px) {
          .slot-hud-bottom { flex-direction: column !important; gap: 10px !important; }
          .slot-hud-spin-btn { width: 100% !important; height: 60px !important; font-size: 20px !important; }
        }
      `}</style>

      {/* ── Top strip ────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '8px 16px',
        background: 'rgba(0,0,0,0.65)',
        borderBottom: '1px solid rgba(0,255,224,0.12)',
        fontFamily: 'monospace',
        flexWrap: 'wrap',
        gap: 8,
      }}>
        {/* Balance */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Balance</span>
          <span style={{ color: '#00ffe0', fontSize: 20, fontWeight: 800 }}>{balance.toLocaleString()}</span>
          <span style={{ color: 'rgba(0,255,224,0.45)', fontSize: 11 }}>CT</span>
        </div>

        {/* Session P&L */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11 }}>Session</span>
          <span style={{ color: pnlColor, fontSize: 15, fontWeight: 700 }}>
            {pnlSign}{sessionPnl.toLocaleString()} CT
          </span>
        </div>

        {/* Spin count */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
          <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11 }}>Spins</span>
          <span style={{ color: 'rgba(255,255,255,0.65)', fontSize: 14, fontWeight: 600 }}>{spinCount}</span>
        </div>
      </div>

      {/* ── Bottom control bar ───────────────────────────────────────────── */}
      <div
        className="slot-hud-bottom"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          background: 'rgba(0,0,0,0.65)',
          borderTop: '1px solid rgba(0,255,224,0.12)',
          flexWrap: 'wrap',
        }}
      >
        {/* Bet size controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
          <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, fontFamily: 'monospace', letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>BET</span>

          <button
            onClick={handleBetDown}
            disabled={isSpinning || bet <= minBet}
            aria-label="Decrease bet"
            style={{
              width: 32, height: 32,
              background: 'rgba(0,255,224,0.08)',
              border: '1px solid rgba(0,255,224,0.25)',
              borderRadius: 6,
              color: '#00ffe0',
              fontSize: 18,
              cursor: isSpinning || bet <= minBet ? 'not-allowed' : 'pointer',
              opacity: isSpinning || bet <= minBet ? 0.4 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'monospace',
            }}
          >−</button>

          <span style={{
            color: '#fff',
            fontSize: 18,
            fontWeight: 700,
            fontFamily: 'monospace',
            minWidth: 36,
            textAlign: 'center',
          }}>
            {bet}
          </span>

          <button
            onClick={handleBetUp}
            disabled={isSpinning || bet >= maxBet}
            aria-label="Increase bet"
            style={{
              width: 32, height: 32,
              background: 'rgba(0,255,224,0.08)',
              border: '1px solid rgba(0,255,224,0.25)',
              borderRadius: 6,
              color: '#00ffe0',
              fontSize: 18,
              cursor: isSpinning || bet >= maxBet ? 'not-allowed' : 'pointer',
              opacity: isSpinning || bet >= maxBet ? 0.4 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'monospace',
            }}
          >+</button>

          {/* Slider — hidden on mobile */}
          <div className="slot-bet-slider-wrap" style={{ display: 'flex', alignItems: 'center', marginLeft: 4 }}>
            <input
              type="range"
              className="slot-bet-slider"
              min={minBet}
              max={maxBet}
              value={bet}
              disabled={isSpinning}
              onChange={handleBetSlider}
              style={{'--pct': `${((bet - minBet) / (maxBet - minBet)) * 100}%`} as React.CSSProperties}
              aria-label={`Bet amount: ${bet} ClawTokens`}
            />
          </div>
        </div>

        {/* SPIN button */}
        <button
          className="slot-hud-spin-btn"
          onClick={disabled ? undefined : onSpin}
          disabled={disabled}
          aria-label={spinState === 'spinning' ? 'Spinning...' : spinState === 'insufficient' ? 'Insufficient balance' : 'Spin'}
          style={{
            flex: '1 0 120px',
            minWidth: 120,
            maxWidth: 220,
            height: 48,
            background: colors.bg,
            border: `2px solid ${colors.border}`,
            borderRadius: 10,
            color: colors.text,
            fontSize: 17,
            fontWeight: 900,
            fontFamily: 'monospace',
            letterSpacing: '0.12em',
            cursor: disabled ? 'not-allowed' : 'pointer',
            boxShadow: colors.shadow,
            transition: 'all 0.15s',
            animation: spinState === 'spinning'
              ? 'spinButtonShimmer 0.8s ease-in-out infinite'
              : spinState === 'evaluating'
              ? 'spinButtonPulse 0.4s ease-in-out 2'
              : 'none',
            textTransform: 'uppercase',
          }}
        >
          {spinState === 'spinning'     ? 'SPINNING...'
           : spinState === 'insufficient' ? 'NO FUNDS'
           : 'SPIN'}
        </button>

        {/* Autoplay */}
        <select
          value={String(autoplayCount)}
          onChange={handleAutoplay}
          disabled={isSpinning}
          aria-label="Autoplay settings"
          style={{
            background: 'rgba(0,0,0,0.7)',
            border: '1px solid rgba(0,255,224,0.2)',
            borderRadius: 7,
            color: 'rgba(255,255,255,0.65)',
            fontSize: 12,
            fontFamily: 'monospace',
            padding: '6px 10px',
            cursor: isSpinning ? 'not-allowed' : 'pointer',
            flex: '0 0 auto',
          }}
        >
          {AUTOPLAY_OPTIONS.map((opt) => (
            <option key={String(opt.value)} value={String(opt.value)}>
              {opt.label}
            </option>
          ))}
        </select>

        {/* Icon buttons */}
        <div style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
          {/* Mute */}
          <button
            onClick={onMuteToggle}
            title={isMuted ? 'Unmute' : 'Mute'}
            style={iconBtnStyle}
            aria-label={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? '🔇' : '🔊'}
          </button>

          {/* Paytable */}
          <button
            onClick={onPaytableOpen}
            title="View paytable"
            style={iconBtnStyle}
            aria-label="View paytable"
          >
            📊
          </button>

          {/* Fairness / verifier (placeholder until 6.1) */}
          <button
            onClick={onFairnessOpen}
            title="Provably fair verifier (coming 6.1)"
            style={{ ...iconBtnStyle, opacity: 0.5, cursor: 'default' }}
            aria-label="Provably fair (coming soon)"
          >
            🔐
          </button>
        </div>

        {/* Walk Away */}
        <button
          onClick={onWalkAway}
          style={{
            flex: '0 0 auto',
            padding: '8px 14px',
            background: 'rgba(255,0,100,0.08)',
            border: '1px solid rgba(255,0,100,0.25)',
            borderRadius: 8,
            color: 'rgba(255,80,120,0.9)',
            fontSize: 12,
            fontFamily: 'monospace',
            letterSpacing: '0.06em',
            cursor: 'pointer',
            fontWeight: 600,
            transition: 'background 0.15s, border-color 0.15s',
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,0,100,0.18)';
            (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,0,100,0.5)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,0,100,0.08)';
            (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,0,100,0.25)';
          }}
        >
          Walk Away
        </button>
      </div>
    </>
  );
}

const iconBtnStyle: React.CSSProperties = {
  width: 34,
  height: 34,
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8,
  fontSize: 16,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background 0.15s',
};
