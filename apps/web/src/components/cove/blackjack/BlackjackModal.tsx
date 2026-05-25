'use client';

/**
 * BlackjackModal — Phase 6.4.0 display shell.
 *
 * Layout: felt background → dealer seat → single player seat →
 * bet slider (ClawTokens display only) → action buttons → outcome.
 *
 * Phase 6.4.0 constraints:
 *   - NO ledger writes (no transferClawTokens / no real CT debit).
 *   - NO real engine. Calls POST /api/cove/blackjack/play-mock-hand.
 *   - Bankroll display is a stub from openBlackjackTable(displayBalance).
 *   - hit / double / split / surrender buttons rendered-but-disabled.
 *     Only "Deal" (play mock hand) and "Stand" (close after outcome) are
 *     active in 6.4.0. Real per-card decisions land in Phase 6.4.1.
 *   - Win/push celebration reuses WinCelebration particle + banner pattern.
 *
 * Iris Xe safe: no drei Text/Billboard, no InstancedMesh+ShaderMaterial,
 * no per-frame new Vector3. Pure React/CSS, zero Three.js import.
 *
 * Import cove-tokens.css for CSS variables (pt-velvet, pt-cream, etc).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCoveStore } from '@/stores/cove';
import { playMockHand } from '@/lib/cove/blackjack-api-client';
import { useAvatar } from '@/hooks/use-avatar';
import BlackjackCard from './BlackjackCard';
import '@/styles/cove-tokens.css';

// ---------------------------------------------------------------------------
// Bet slider config (ClawTokens, display-only in 6.4.0)
// ---------------------------------------------------------------------------
const BET_STEPS = [10, 25, 50, 100, 250, 500] as const;
type BetStep = typeof BET_STEPS[number];

function BetChip({ value, selected, onClick }: { value: BetStep; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      style={{
        padding: '5px 12px',
        borderRadius: 6,
        border: selected
          ? '1.5px solid var(--pt-amber)'
          : '1.5px solid rgba(160,140,100,0.35)',
        background: selected
          ? 'rgba(200,150,50,0.18)'
          : 'rgba(10,30,20,0.6)',
        color: selected ? 'var(--pt-amber)' : 'var(--pt-cream-soft)',
        fontFamily: 'var(--pt-data)',
        fontWeight: selected ? 700 : 400,
        fontSize: 12,
        cursor: 'pointer',
        transition: 'border-color 0.15s, background 0.15s',
        letterSpacing: '0.04em',
        flexShrink: 0,
      }}
    >
      {value}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Outcome banner — reuses the WinCelebration banner shape but is
// DOM-only (no particles in 6.4.0; particle integration in 6.4.1).
// ---------------------------------------------------------------------------
function OutcomeBanner({ outcome, payout, label }: {
  outcome: string;
  payout: number;
  label: string;
}) {
  const isWin       = outcome === 'win' || outcome === 'blackjack';
  const isPush      = outcome === 'push';
  const accent      = isWin ? 'var(--pt-amber-glow)' : isPush ? 'var(--pt-cream-soft)' : '#e85555';
  const bannerLabel = outcome === 'blackjack' ? 'BLACKJACK!' : isWin ? 'YOU WIN' : isPush ? 'PUSH' : 'BUST';

  return (
    <div
      role="status"
      aria-live="assertive"
      style={{
        position: 'absolute',
        left: '50%',
        top: '38%',
        transform: 'translate(-50%, -50%)',
        zIndex: 10,
        pointerEvents: 'none',
        animation: 'bj-banner-in 450ms cubic-bezier(0.22,1,0.36,1)',
        textAlign: 'center',
      }}
    >
      <style>{`
        @keyframes bj-banner-in {
          from { opacity: 0; transform: translate(-50%, -50%) scale(0.85); }
          to   { opacity: 1; transform: translate(-50%, -50%) scale(1);    }
        }
      `}</style>
      <div
        style={{
          background: 'var(--pt-velvet)',
          border: `2px solid ${accent}`,
          padding: '14px 32px',
          boxShadow: `0 0 28px ${accent}55, 0 0 56px ${accent}22`,
          minWidth: 180,
        }}
      >
        <div style={{
          color: accent,
          fontSize: 11,
          fontFamily: 'var(--pt-data)',
          letterSpacing: '0.2em',
          fontWeight: 700,
          marginBottom: 4,
        }}>
          {bannerLabel}
        </div>
        {payout !== 0 && (
          <div style={{
            color: isWin ? 'var(--pt-cream)' : '#e85555',
            fontSize: 28,
            fontWeight: 700,
            fontFamily: 'var(--pt-display)',
            lineHeight: 1,
          }}>
            {isWin ? `+${payout}` : payout} CT
          </div>
        )}
        <div style={{
          color: 'var(--pt-mute)',
          fontSize: 10,
          fontFamily: 'var(--pt-data)',
          marginTop: 4,
          letterSpacing: '0.06em',
        }}>
          {label}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hand display
// ---------------------------------------------------------------------------
function HandRow({ label, cards, totalLabel }: {
  label: string;
  cards: import('@/lib/cove/blackjack-types').BlackjackCard[];
  totalLabel?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{
        fontSize: 10,
        fontFamily: 'var(--pt-data)',
        color: 'var(--pt-mute)',
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span>{label}</span>
        {totalLabel && (
          <span style={{ color: 'var(--pt-cream-soft)', fontSize: 11, fontWeight: 600 }}>
            {totalLabel}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {cards.map((card, i) => (
          <BlackjackCard key={i} card={card} slideIn delay={i * 80} />
        ))}
        {cards.length === 0 && (
          <div style={{
            width: 52,
            height: 76,
            borderRadius: 6,
            border: '1.5px dashed rgba(120,200,180,0.2)',
            opacity: 0.4,
          }} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hand total calculation (visible-cards only)
// ---------------------------------------------------------------------------
function handTotal(cards: import('@/lib/cove/blackjack-types').BlackjackCard[]): number {
  let total = 0;
  let aces  = 0;
  for (const card of cards) {
    if (card.hidden) continue;
    if (card.rank === 'A') {
      aces++;
      total += 11;
    } else if (['J', 'Q', 'K'].includes(card.rank)) {
      total += 10;
    } else {
      total += parseInt(card.rank, 10);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------
export default function BlackjackModal() {
  const {
    blackjackOpen,
    blackjackBet,
    blackjackOutcome,
    blackjackPayout,
    blackjackPlayerHand,
    blackjackDealerHand,
    blackjackOutcomeLabel,
    blackjackIsDealing,
    blackjackDisplayBalance,
    closeBlackjackTable,
    setBlackjackBet,
    setBlackjackResult,
    setBlackjackIsDealing,
  } = useCoveStore();

  const { data: avatar } = useAvatar();

  const [localBalance, setLocalBalance] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (blackjackOpen) {
      setLocalBalance(blackjackDisplayBalance || avatar?.clawTokens || 0);
      setError(null);
    }
  }, [blackjackOpen, blackjackDisplayBalance, avatar?.clawTokens]);

  const isBusy = blackjackIsDealing;
  const hasOutcome = blackjackOutcome !== null;

  const handleDeal = useCallback(async () => {
    if (isBusy) return;
    setError(null);
    setBlackjackIsDealing(true);
    try {
      const result = await playMockHand(blackjackBet);
      setBlackjackResult(
        result.outcome,
        result.payout,
        result.playerHand,
        result.dealerHand,
        result.outcomeLabel,
      );
      // Adjust local display balance (no ledger write)
      const isWin = result.outcome === 'win' || result.outcome === 'blackjack';
      const isPush = result.outcome === 'push';
      if (isWin) setLocalBalance(prev => prev + result.payout);
      else if (!isPush) setLocalBalance(prev => Math.max(0, prev - blackjackBet));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBlackjackIsDealing(false);
    }
  }, [isBusy, blackjackBet, setBlackjackIsDealing, setBlackjackResult]);

  const handleNextHand = useCallback(() => {
    useCoveStore.getState().openBlackjackTable(localBalance);
  }, [localBalance]);

  const handleClose = useCallback(() => {
    closeBlackjackTable();
  }, [closeBlackjackTable]);

  useEffect(() => {
    if (!blackjackOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [blackjackOpen, handleClose]);

  if (!blackjackOpen) return null;

  const playerTotal  = handTotal(blackjackPlayerHand);
  const dealerTotal  = handTotal(blackjackDealerHand);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Blackjack table"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9990,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        background: 'rgba(2, 16, 24, 0.82)',
        backdropFilter: 'blur(6px)',
        animation: 'cv-modal-bg-in var(--cv-motion-base) var(--cv-ease-standard)',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 600,
          maxHeight: 'min(92vh, 700px)',
          borderRadius: 14,
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(60,180,120,0.4)',
          background: 'var(--pt-velvet)',
          animation: 'cv-modal-in var(--cv-motion-base) var(--cv-ease-bounce)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* ── Header ────────────────────────────────────────────────── */}
        <header style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          background: 'rgba(0,0,0,0.3)',
          borderBottom: '1px solid rgba(60,180,120,0.25)',
          flexShrink: 0,
        }}>
          <div style={{ fontSize: 12, fontFamily: 'var(--pt-data)', color: 'var(--pt-mute)', letterSpacing: '0.12em' }}>
            BLACKJACK · FUN MONEY
          </div>
          <div style={{
            fontSize: 13,
            fontFamily: 'var(--pt-data)',
            fontWeight: 700,
            color: 'var(--pt-amber)',
            letterSpacing: '0.06em',
            background: 'rgba(150,110,30,0.15)',
            border: '1px solid rgba(150,110,30,0.3)',
            borderRadius: 6,
            padding: '3px 10px',
          }}>
            {localBalance.toLocaleString()} CT
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close blackjack table"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--pt-mute)',
              cursor: 'pointer',
              padding: 4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </header>

        {/* ── Felt ──────────────────────────────────────────────────── */}
        <div style={{
          flex: 1,
          position: 'relative',
          background: 'linear-gradient(180deg, #0d3a1e 0%, #0a2e18 50%, #0d3a1e 100%)',
          padding: '20px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          minHeight: 0,
          overflowY: 'auto',
        }}>
          {/* Felt texture lines (CSS, no Canvas) */}
          <div aria-hidden style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 19px, rgba(60,160,80,0.06) 20px)',
            pointerEvents: 'none',
          }} />

          {/* Dealer area */}
          <div style={{
            background: 'rgba(0,0,0,0.25)',
            border: '1px solid rgba(60,180,100,0.18)',
            borderRadius: 10,
            padding: '14px 16px',
            position: 'relative',
            zIndex: 1,
          }}>
            <div style={{
              fontSize: 9,
              fontFamily: 'var(--pt-data)',
              color: 'rgba(60,180,100,0.55)',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              marginBottom: 10,
            }}>
              DEALER MUST STAND ON 17
            </div>
            <HandRow
              label="Dealer"
              cards={blackjackDealerHand}
              totalLabel={blackjackDealerHand.length > 0 ? `${dealerTotal}` : undefined}
            />
          </div>

          {/* Divider */}
          <div aria-hidden style={{
            borderTop: '1px dashed rgba(60,180,100,0.2)',
            position: 'relative',
            zIndex: 1,
          }} />

          {/* Player area */}
          <div style={{ position: 'relative', zIndex: 1 }}>
            <HandRow
              label="You"
              cards={blackjackPlayerHand}
              totalLabel={blackjackPlayerHand.length > 0 ? `${playerTotal}` : undefined}
            />
          </div>

          {/* Outcome banner — overlays the felt */}
          {hasOutcome && blackjackOutcome && blackjackOutcomeLabel && (
            <OutcomeBanner
              outcome={blackjackOutcome}
              payout={blackjackPayout}
              label={blackjackOutcomeLabel}
            />
          )}
        </div>

        {/* ── Action strip ──────────────────────────────────────────── */}
        <div style={{
          flexShrink: 0,
          background: 'rgba(0,0,0,0.35)',
          borderTop: '1px solid rgba(60,180,120,0.2)',
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}>
          {/* Bet selector (display-only, no ledger) */}
          {!hasOutcome && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{
                fontSize: 10,
                fontFamily: 'var(--pt-data)',
                color: 'var(--pt-mute)',
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                flexShrink: 0,
              }}>
                BET
              </span>
              {BET_STEPS.map((step) => (
                <BetChip
                  key={step}
                  value={step}
                  selected={blackjackBet === step}
                  onClick={() => setBlackjackBet(step)}
                />
              ))}
            </div>
          )}

          {/* Error */}
          {error && (
            <div style={{
              fontSize: 11,
              color: '#e85555',
              fontFamily: 'var(--pt-data)',
              letterSpacing: '0.06em',
            }}>
              {error}
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!hasOutcome ? (
              <>
                {/* DEAL — primary action */}
                <button
                  type="button"
                  onClick={() => { void handleDeal(); }}
                  disabled={isBusy}
                  className="pt-btn pt-btn-primary"
                  style={{ minWidth: 90, height: 40, fontSize: 13, fontWeight: 700 }}
                >
                  {isBusy ? 'Dealing…' : `Deal (${blackjackBet} CT)`}
                </button>

                {/* HIT — disabled in 6.4.0, real engine in 6.4.1 */}
                <button
                  type="button"
                  disabled
                  className="pt-btn pt-btn-ghost"
                  title="Available in Phase 6.4.1"
                  style={{ height: 40, fontSize: 12, opacity: 0.45 }}
                >
                  Hit
                </button>

                {/* STAND — disabled pre-deal */}
                <button
                  type="button"
                  disabled
                  className="pt-btn pt-btn-ghost"
                  title="Available in Phase 6.4.1"
                  style={{ height: 40, fontSize: 12, opacity: 0.45 }}
                >
                  Stand
                </button>

                {/* DOUBLE — disabled in 6.4.0 */}
                <button
                  type="button"
                  disabled
                  className="pt-btn pt-btn-ghost"
                  title="Available in Phase 6.4.1"
                  style={{ height: 40, fontSize: 12, opacity: 0.45 }}
                >
                  Double
                </button>

                {/* SPLIT — disabled in 6.4.0 */}
                <button
                  type="button"
                  disabled
                  className="pt-btn pt-btn-ghost"
                  title="Available in Phase 6.4.1"
                  style={{ height: 40, fontSize: 12, opacity: 0.45 }}
                >
                  Split
                </button>

                {/* SURRENDER — disabled in 6.4.0 */}
                <button
                  type="button"
                  disabled
                  className="pt-btn pt-btn-ghost"
                  title="Available in Phase 6.4.1"
                  style={{ height: 40, fontSize: 12, opacity: 0.45 }}
                >
                  Surrender
                </button>
              </>
            ) : (
              <>
                {/* Next hand */}
                <button
                  type="button"
                  onClick={handleNextHand}
                  className="pt-btn pt-btn-primary"
                  style={{ minWidth: 110, height: 40, fontSize: 13 }}
                >
                  Next Hand
                </button>

                {/* Walk away */}
                <button
                  type="button"
                  onClick={handleClose}
                  className="pt-btn pt-btn-danger"
                  style={{ height: 40, fontSize: 12 }}
                >
                  Walk Away
                </button>
              </>
            )}
          </div>

          {/* Phase label */}
          <div style={{
            fontSize: 9,
            color: 'rgba(100,180,130,0.4)',
            fontFamily: 'var(--pt-data)',
            letterSpacing: '0.12em',
            textAlign: 'right',
          }}>
            DISPLAY SHELL · PHASE 6.4.0 · REAL ENGINE IN 6.4.1
          </div>
        </div>
      </div>
    </div>
  );
}
