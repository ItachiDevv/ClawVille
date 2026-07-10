'use client';

/**
 * SlotActionStrip (legacy default export: SlotHUD) — Predict Terminal
 * action strip rendered once at the bottom of the slot modal.
 *
 * Three-column layout:
 *   LEFT   — BALANCE display + session PnL chip
 *   CENTER — PredictChips
 *   RIGHT  — SPIN hero button + small icon row (walkaway, autoplay, mute, paytable)
 *
 * Iris Xe safe: pure DOM/CSS, zero Three.js. Animates `transform`/opacity only.
 *
 * The legacy `section` prop is accepted but ignored — the action strip is
 * now rendered ONCE at the bottom of the modal.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PredictChips } from './ui';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
export interface SlotHUDProps {
  balance: number;
  sessionPnl: number;
  spinCount: number;
  predict: number;
  minPredict?: number;
  maxPredict?: number;
  isSpinning: boolean;
  isEvaluating: boolean;
  isLockedOut?: boolean;
  autoplayCount: number | 'until-cashout' | 'until-big-win';
  isMuted: boolean;
  /**
   * Legacy section prop — ignored. Action strip renders once.
   * Kept in the type for back-compat with parent call sites.
   */
  section?: 'top' | 'bottom';
  inFreeSpin?: boolean;
  freeSpinsRemaining?: number;
  onPredictChange: (predict: number) => void;
  onSpin: () => void;
  onAutoplayChange: (count: number | 'until-cashout' | 'until-big-win') => void;
  onMuteToggle: () => void;
  onPaytableOpen: () => void;
  onFairnessOpen: () => void;
  onWalkAway: () => void;
}

const AUTOPLAY_OPTIONS: Array<{ label: string; value: number | 'until-cashout' | 'until-big-win' }> = [
  { label: 'Off',                value: 0              },
  { label: '10 spins',           value: 10             },
  { label: '25 spins',           value: 25             },
  { label: '100 spins',          value: 100            },
  { label: 'Until cash-out',     value: 'until-cashout' },
  { label: 'Win > 10× predict',  value: 'until-big-win' },
];

// Phase 6.1 — predict must be divisible by CLASSIC_LINES.length=20.
const PREDICT_CHIPS = [20, 40, 100, 200, 500, 1000];

// ---------------------------------------------------------------------------
// Spin button state machine
// ---------------------------------------------------------------------------
type SpinButtonState = 'ready' | 'spinning' | 'evaluating' | 'insufficient' | 'locked';

function getSpinState(
  isSpinning: boolean,
  isEvaluating: boolean,
  isLockedOut: boolean,
  balance: number,
  predict: number,
): SpinButtonState {
  if (isSpinning)        return 'spinning';
  if (isEvaluating)      return 'evaluating';
  if (isLockedOut)       return 'locked';
  if (balance < predict) return 'insufficient';
  return 'ready';
}

const SPIN_LABEL: Record<SpinButtonState, string> = {
  ready:        'SPIN',
  spinning:     '…',
  evaluating:   '…',
  insufficient: 'NO FUNDS',
  locked:       'WIN!',
};

// ---------------------------------------------------------------------------
// Inline-SVG icons (brass stroke, 18px nominal)
// ---------------------------------------------------------------------------
function IconWalkAway() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}
function IconAutoplay({ active }: { active?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  );
}
function IconMuted() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  );
}
function IconAudio() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}
function IconPaytable() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="1" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="3" y1="15" x2="21" y2="15" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function SlotHUD({
  balance,
  sessionPnl,
  spinCount,
  predict,
  minPredict = 1,
  maxPredict = 100,
  isSpinning,
  isEvaluating,
  isLockedOut = false,
  autoplayCount,
  isMuted,
  section,
  inFreeSpin = false,
  freeSpinsRemaining = 0,
  onPredictChange,
  onSpin,
  onAutoplayChange,
  onMuteToggle,
  onPaytableOpen,
  onFairnessOpen,
  onWalkAway,
}: SlotHUDProps) {
  void minPredict;
  void maxPredict;
  void spinCount;
  void onFairnessOpen;

  // ── Balance pulse on change ──────────────────────────────────────────────
  // Triggers cv-balance-bump keyframe whenever the balance number changes
  // (e.g. post-spin credit). Gives the BALANCE display a satisfying tick
  // instead of a silent re-render.
  const [balancePulseKey, setBalancePulseKey] = useState(0);
  const prevBalanceRef = useRef(balance);
  useEffect(() => {
    if (prevBalanceRef.current !== balance) {
      prevBalanceRef.current = balance;
      setBalancePulseKey(k => k + 1);
    }
  }, [balance]);

  const handleAutoplayClick = useCallback(() => {
    // Cycle through Off → 10 → 25 → 100 → until-cashout → until-big-win → Off
    const idx = AUTOPLAY_OPTIONS.findIndex(o => o.value === autoplayCount);
    const next = AUTOPLAY_OPTIONS[(idx + 1) % AUTOPLAY_OPTIONS.length];
    onAutoplayChange(next.value);
  }, [autoplayCount, onAutoplayChange]);

  // Legacy `top`-section render: produce nothing (action strip is unified).
  if (section === 'top') return null;

  const spinState = getSpinState(isSpinning, isEvaluating, isLockedOut, balance, predict);
  const spinDisabled = spinState !== 'ready';

  const pnlClass =
    sessionPnl > 0 ? 'pt-pnl pt-pnl-up'
    : sessionPnl < 0 ? 'pt-pnl pt-pnl-down'
    : 'pt-pnl pt-pnl-flat';
  const pnlGlyph = sessionPnl > 0 ? '▲' : sessionPnl < 0 ? '▼' : '·';

  const spinLabel = spinState === 'ready' && inFreeSpin ? 'FREE' : SPIN_LABEL[spinState];

  const autoplayActive = autoplayCount !== 0;
  const autoplayLabel =
    autoplayCount === 0 ? 'AUTO'
    : autoplayCount === 'until-cashout' ? 'AUTO ∞'
    : autoplayCount === 'until-big-win' ? 'AUTO 10×'
    : `AUTO ${autoplayCount}`;

  return (
    <div className="pt-action-strip">
      {/* ── LEFT: balance + PnL ───────────────────────────────────────── */}
      <div className="pt-action-col-left">
        <span className="pt-label">Balance</span>
        <div className="pt-balance">
          <div>
            <span
              key={balancePulseKey}
              className="pt-balance-value"
              style={{
                display: 'inline-block',
                animation: balancePulseKey > 0
                  ? 'cv-balance-bump 480ms var(--cv-ease-bounce)'
                  : undefined,
              }}
            >
              {balance.toLocaleString()}
            </span>
            <span className="pt-balance-suffix">vCLAW</span>
          </div>
          <div className={pnlClass} aria-label={`Session profit and loss: ${sessionPnl}`}>
            <span aria-hidden>{pnlGlyph}</span>
            <span>{sessionPnl === 0 ? '0' : `${sessionPnl > 0 ? '+' : ''}${sessionPnl.toLocaleString()}`} vCLAW</span>
          </div>
        </div>
        {freeSpinsRemaining > 0 && (
          <div
            role="status"
            aria-label={`${freeSpinsRemaining} free spins remaining`}
            style={{
              marginTop: 4,
              padding: '3px 9px',
              background: 'var(--cv-anemone)',
              border: '1px solid #5a0418',
              /* deep wine on anemone — ~5.78:1, AA normal pass; keeps the pink brand signal */
              color: '#5a0418',
              fontFamily: 'var(--cv-data)',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
            }}
          >
            FS × {freeSpinsRemaining}
          </div>
        )}
      </div>

      {/* ── CENTER: predict chips ────────────────────────────────────── */}
      <div className="pt-action-col-center">
        <span className="pt-label">Predict</span>
        <PredictChips
          options={PREDICT_CHIPS}
          value={predict}
          onChange={onPredictChange}
          disabled={isSpinning}
          ariaLabel="Predict size in vCLAW"
        />
      </div>

      {/* ── RIGHT: icon row only — SPIN moved to 3D lever in SlotReels3D
           Phase 6.1.15. Kept `onSpin` prop typed for autoplay + keyboard
           shortcuts; the visible SPIN button is gone. ──────────────────── */}
      <div className="pt-action-col-right">
        {/* Hidden — preserves keyboard SPIN focusability for accessibility */}
        <button
          type="button"
          className="pt-spin-btn-hidden"
          onClick={spinDisabled ? undefined : onSpin}
          disabled={spinDisabled}
          aria-label={spinState === 'ready' && inFreeSpin ? 'FREE SPIN' : `SPIN, ${SPIN_LABEL[spinState]}`}
          style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden', opacity: 0, pointerEvents: 'none' }}
        >
          {spinLabel}
        </button>

        <div className="pt-icon-row">
          <button
            type="button"
            className="pt-icon-btn"
            onClick={onWalkAway}
            aria-label="Walk away — leave the slot screen"
            title="Walk away"
          >
            <IconWalkAway />
            <span>WALK</span>
          </button>
          <button
            type="button"
            className={`pt-icon-btn${autoplayActive ? ' pt-icon-btn-active' : ''}`}
            onClick={handleAutoplayClick}
            disabled={isSpinning}
            aria-label={`Autoplay: ${autoplayLabel}`}
            title={autoplayLabel}
          >
            <IconAutoplay active={autoplayActive} />
            <span>{autoplayLabel}</span>
          </button>
          <button
            type="button"
            className={`pt-icon-btn${isMuted ? ' pt-icon-btn-active' : ''}`}
            onClick={onMuteToggle}
            aria-label={isMuted ? 'Unmute audio' : 'Mute audio'}
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? <IconMuted /> : <IconAudio />}
            <span>{isMuted ? 'MUTED' : 'AUDIO'}</span>
          </button>
          <button
            type="button"
            className="pt-icon-btn"
            onClick={onPaytableOpen}
            aria-label="View paytable"
            title="Paytable"
          >
            <IconPaytable />
            <span>TABLE</span>
          </button>
        </div>
      </div>

    </div>
  );
}
