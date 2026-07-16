'use client';

import { useCallback, useMemo, useState } from 'react';
import { useCoveStore } from '@/stores/cove';
import { useAvatar } from '@/hooks/use-avatar';
import '@/styles/cove-tokens.css';
import type { RaiseConfig } from '@/lib/cove/holdem-types';
import {
  computeAllIn,
  computeRaiseOpen,
  useHoldemController,
} from '@/lib/cove/holdem-controller';
import { RaiseSlider } from './RaiseSlider';

/** P3 — seated in-world action HUD (2026-07-15). While the player is seated
 * at T1 the 2D modal is suppressed (founder contract: the entire session
 * renders on the felt), so this DOM overlay is the ONLY action surface. It is
 * a pure consumer of the shared Hold'em controller — the SAME handleDeal /
 * runAction / handleWalkAway mutation path the modal uses; it never issues
 * its own requests. Cards render on the felt via TableCards3D; this bar only
 * carries the buttons + the minimal numbers (pot, stack, to-call, outcome). */
export function SeatedHoldemHud() {
  const seatedTable = useCoveStore((state) => state.seatedTable);
  const holdemModalOpen = useCoveStore((state) => state.holdemModalOpen);
  const { data: avatar } = useAvatar();

  const {
    table, live, settled, revealedSeed, toast, phase, agentMode, inFlight,
    walkAwayLocked, pot, toCallNum, facingBet, canCheck,
    resetHand, handleDeal, runAction, handleWalkAway,
  } = useHoldemController();

  const [showRaise, setShowRaise] = useState(false);
  const [raiseConfig, setRaiseConfig] = useState<RaiseConfig>({ min: 0, max: 0, value: 0, verb: 'bet' });

  const isAuthed = Boolean(avatar);
  const actionsDisabled = inFlight || agentMode === 'autonomous';

  const handleOpenRaise = useCallback(() => {
    if (!live || phase !== 'player-turn') return;
    const open = computeRaiseOpen(live);
    if (open.kind === 'call') {
      void runAction('call');
      return;
    }
    setRaiseConfig({ min: open.min, max: open.max, value: open.min, verb: open.verb });
    setShowRaise(true);
  }, [live, phase, runAction]);

  const handleConfirmRaise = useCallback(() => {
    setShowRaise(false);
    void runAction(raiseConfig.verb, raiseConfig.value);
  }, [raiseConfig, runAction]);

  const handleAllIn = useCallback(() => {
    if (!live || phase !== 'player-turn') return;
    const shove = computeAllIn(live);
    setShowRaise(false);
    void runAction(shove.action, shove.amount);
  }, [live, phase, runAction]);

  const handleNextHand = useCallback(() => {
    setShowRaise(false);
    resetHand();
  }, [resetHand]);

  const outcomeLabel = useMemo(() => {
    const outcome = settled?.outcome ?? null;
    if (!outcome) return null;
    const winners = outcome.seats.filter((s) => s.isWinner);
    const net = settled ? Number(settled.net) : 0;
    const netText = `${net >= 0 ? '+' : ''}${net} vCLAW`;
    if (winners.some((w) => w.isHuman)) {
      return winners.length > 1 ? `SPLIT POT (you share) ${netText}` : `YOU WIN ${netText}`;
    }
    return `Hand over ${netText}`;
  }, [settled]);

  // Seated-only surface: T1 with the modal closed (the hotspot suppresses the
  // modal while seated, but a hand resumed IN the modal then carried to the
  // seat keeps this gate correct in both orders).
  if (seatedTable?.tableId !== 'T1' || holdemModalOpen) return null;

  return (
    <div
      style={{
        position: 'fixed', left: '50%', bottom: 'max(16px, env(safe-area-inset-bottom))',
        transform: 'translateX(-50%)', zIndex: 40,
        display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center',
        width: 'min(560px, calc(100vw - 24px))', pointerEvents: 'auto',
      }}
      data-testid="seated-holdem-hud"
    >
      {toast && (
        <div style={{
          fontSize: 12, fontFamily: 'var(--pt-data)', padding: '6px 12px', borderRadius: 6,
          background: 'rgba(8,14,18,0.92)', border: '1px solid rgba(60,180,100,0.25)',
          color: toast.tone === 'error' ? '#f87171' : toast.tone === 'warn' ? '#f59e0b' : '#d8e8dc',
        }}>
          {toast.message}
        </div>
      )}

      <div style={{
        display: 'flex', flexDirection: 'column', gap: 8, width: '100%',
        background: 'rgba(8,14,18,0.88)', border: '1px solid rgba(60,180,100,0.22)',
        borderRadius: 10, padding: '10px 14px', backdropFilter: 'blur(6px)',
      }}>
        <div style={{
          display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap',
          fontSize: 11, fontFamily: 'var(--pt-data)', color: '#a8c0ae', letterSpacing: '0.08em',
        }}>
          {phase !== 'idle' && <span>POT <b style={{ color: 'var(--pt-amber)' }}>{pot}</b></span>}
          {table && <span>STACK <b style={{ color: '#d8e8dc' }}>{Number(table.playerStack).toLocaleString()}</b></span>}
          {phase === 'player-turn' && facingBet && toCallNum > 0 && (
            <span>TO CALL <b style={{ color: 'var(--pt-amber)' }}>{toCallNum}</b></span>
          )}
          {phase === 'settled' && outcomeLabel && (
            <span style={{ color: '#d8e8dc', fontWeight: 700 }}>{outcomeLabel}</span>
          )}
        </div>

        {showRaise && phase === 'player-turn' && (
          <RaiseSlider
            config={raiseConfig}
            onChange={(v) => setRaiseConfig((c) => ({ ...c, value: v }))}
            onConfirm={handleConfirmRaise}
            onCancel={() => setShowRaise(false)}
          />
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          {phase === 'idle' && (
            <button
              type="button"
              onClick={() => { void handleDeal(); }}
              disabled={actionsDisabled}
              className="pt-btn pt-btn-primary"
              style={{ height: 44, fontSize: 13, fontWeight: 700, minWidth: 120 }}
            >
              {inFlight ? 'Dealing…' : 'Deal'}
            </button>
          )}

          {phase === 'player-turn' && !showRaise && (
            <>
              <button
                type="button" onClick={() => { void runAction('fold'); }}
                disabled={actionsDisabled}
                className="pt-btn pt-btn-ghost"
                style={{ height: 44, fontSize: 12, minWidth: 64 }}
              >
                Fold
              </button>
              {canCheck ? (
                <button
                  type="button" onClick={() => { void runAction('check'); }}
                  disabled={actionsDisabled}
                  className="pt-btn pt-btn-primary"
                  style={{ height: 44, fontSize: 13, fontWeight: 700, minWidth: 76 }}
                >
                  Check
                </button>
              ) : (
                <button
                  type="button" onClick={() => { void runAction('call'); }}
                  disabled={actionsDisabled}
                  className="pt-btn pt-btn-primary"
                  style={{ height: 44, fontSize: 13, fontWeight: 700, minWidth: 96 }}
                >
                  Call {toCallNum > 0 ? `${toCallNum} vCLAW` : ''}
                </button>
              )}
              <button
                type="button" onClick={handleOpenRaise}
                disabled={actionsDisabled}
                className="pt-btn pt-btn-ghost"
                style={{ height: 44, fontSize: 12, minWidth: 76 }}
              >
                {facingBet ? 'Raise' : 'Bet'}
              </button>
              <button
                type="button" onClick={handleAllIn}
                disabled={actionsDisabled}
                className="pt-btn pt-btn-ghost"
                style={{ height: 44, fontSize: 12, minWidth: 76, color: '#f59e0b' }}
              >
                All In
              </button>
            </>
          )}

          {phase === 'settled' && (
            <>
              {/* revealedSeed gate mirrors the modal: after Walk Away cashes
                  out, Next Hand inside the auto-close window would orphan a
                  fresh buy-in. */}
              <button
                type="button" onClick={handleNextHand}
                disabled={inFlight || Boolean(revealedSeed)}
                className="pt-btn pt-btn-primary"
                style={{ height: 44, fontSize: 13, minWidth: 110 }}
              >
                Next Hand
              </button>
              {isAuthed && (
                <button
                  type="button" onClick={() => { void handleWalkAway(); }}
                  disabled={walkAwayLocked}
                  style={{
                    height: 44, fontSize: 12, fontWeight: 600,
                    fontFamily: 'var(--pt-data)', letterSpacing: '0.06em',
                    paddingLeft: 16, paddingRight: 16, borderRadius: 6,
                    border: 'none', background: '#dc2626', color: '#ffffff',
                    cursor: walkAwayLocked ? 'not-allowed' : 'pointer',
                    opacity: walkAwayLocked ? 0.6 : 1,
                  }}
                >
                  Walk Away
                </button>
              )}
            </>
          )}
        </div>

        <div style={{
          textAlign: 'center', fontSize: 10, fontFamily: 'var(--pt-data)',
          color: '#6f8a76', letterSpacing: '0.1em',
        }}>
          PRESS E TO STAND
        </div>
      </div>
    </div>
  );
}
