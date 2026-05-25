'use client';

/**
 * BlackjackModal — Phase 6.4.0 interactive shell.
 *
 * State machine phases (useReducer):
 *   idle        → bet selector + DEAL button visible.
 *   dealing     → animated card deal (~800ms total). No player actions.
 *   player-turn → HIT + STAND active. DOUBLE/SPLIT/SURRENDER rendered-but-disabled.
 *   dealer-turn → dealer reveals hole card, draws to hard 17. No player actions.
 *   resolved    → outcome banner + NEXT HAND + WALK AWAY.
 *
 * Mock deck: client-side 52-card shuffle per hand via mulberry32 seeded RNG.
 * No API calls in 6.4.0. Bankroll display is local-only (no ledger writes).
 *
 * Phase 6.4.0 constraints:
 *   - NO ledger writes (no transferClawTokens / no real CT debit).
 *   - DOUBLE/SPLIT/SURRENDER rendered-but-disabled per plan §4.0.
 *   - Particle celebration deferred to 6.4.1.
 *
 * Iris Xe safe: no drei Text/Billboard, no InstancedMesh+ShaderMaterial,
 * no per-frame new Vector3. Pure React/CSS, zero Three.js import.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useCoveStore } from '@/stores/cove';
import { useAvatar } from '@/hooks/use-avatar';
import BlackjackCard from './BlackjackCard';
import '@/styles/cove-tokens.css';
import type {
  BlackjackCard as BJCard,
  BlackjackSuit,
  BlackjackRank,
  BlackjackOutcome,
} from '@/lib/cove/blackjack-types';

// ---------------------------------------------------------------------------
// Bet chips
// ---------------------------------------------------------------------------
const BET_STEPS = [10, 25, 50, 100, 250, 500] as const;
type BetStep = (typeof BET_STEPS)[number];

function BetChip({ value, selected, onClick }: {
  value: BetStep;
  selected: boolean;
  onClick: () => void;
}) {
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
// Outcome banner
// ---------------------------------------------------------------------------
function OutcomeBanner({ outcome, payout, label, isBust }: {
  outcome: BlackjackOutcome;
  payout: number;
  label: string;
  isBust?: boolean;
}) {
  const isWin  = outcome === 'win' || outcome === 'blackjack';
  const isPush = outcome === 'push';
  const accent =
    isWin  ? 'var(--pt-amber-glow)' :
    isPush ? 'var(--pt-cream-soft)' :
             '#e85555';
  const bannerLabel =
    outcome === 'blackjack' ? 'BLACKJACK!' :
    isWin                   ? 'YOU WIN'    :
    isPush                  ? 'PUSH'       :
    isBust                  ? 'BUST'       :
                              'YOU LOSE';

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
          to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }
      `}</style>
      <div style={{
        background: 'var(--pt-velvet)',
        border: `2px solid ${accent}`,
        padding: '14px 32px',
        boxShadow: `0 0 28px ${accent}55, 0 0 56px ${accent}22`,
        minWidth: 180,
      }}>
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
            {isWin ? `+${payout}` : `-${Math.abs(payout)}`} CT
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
  cards: BJCard[];
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
// Deck + RNG utilities
// ---------------------------------------------------------------------------
const SUITS: BlackjackSuit[] = ['clubs', 'diamonds', 'hearts', 'spades'];
const RANKS: BlackjackRank[] = [
  '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A',
];

/** mulberry32 — fast seedable 32-bit RNG. Returns [0, 1). */
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let z = Math.imul(s ^ (s >>> 15), 1 | s);
    z = z ^ z + Math.imul(z ^ (z >>> 7), 61 | z);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

function buildShuffledDeck(rand: () => number): BJCard[] {
  const deck: BJCard[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }
  // Fisher-Yates
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    // non-null assertion safe — i and j are always in bounds
    const tmp = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = tmp;
  }
  return deck;
}

function cardValue(rank: BlackjackRank): number {
  if (rank === 'A') return 11;
  if (['J', 'Q', 'K'].includes(rank)) return 10;
  return parseInt(rank, 10);
}

function handTotal(cards: BJCard[]): number {
  let total = 0;
  let aces  = 0;
  for (const card of cards) {
    if (card.hidden) continue;
    if (card.rank === 'A') { aces++; total += 11; }
    else total += cardValue(card.rank);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function isSoft17(cards: BJCard[]): boolean {
  let total = 0;
  let aces  = 0;
  for (const card of cards) {
    if (card.hidden) continue;
    if (card.rank === 'A') { aces++; total += 11; }
    else total += cardValue(card.rank);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total === 17 && aces > 0;
}

function isNaturalBlackjack(cards: BJCard[]): boolean {
  return cards.length === 2 && handTotal(cards) === 21;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
type Phase = 'idle' | 'dealing' | 'player-turn' | 'dealer-turn' | 'resolved';

type BJOutcomeExtended = BlackjackOutcome | 'bust';

interface GameState {
  phase:       Phase;
  deck:        BJCard[];
  playerHand:  BJCard[];
  dealerHand:  BJCard[];   // dealerHand[1] has hidden:true until dealer-turn
  outcome:     BJOutcomeExtended | null;
  payout:      number;
  outcomeLabel: string;
}

type GameAction =
  | { type: 'DEAL'; deck: BJCard[]; playerHand: BJCard[]; dealerHand: BJCard[] }
  | { type: 'DEALING_DONE' }
  | { type: 'HIT'; card: BJCard }
  | { type: 'BUST' }
  | { type: 'STAND' }
  | { type: 'DEALER_DRAW'; card: BJCard }
  | { type: 'DEALER_REVEAL_HOLE' }
  | { type: 'RESOLVE'; outcome: BJOutcomeExtended; payout: number; label: string }
  | { type: 'RESET' };

function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'DEAL':
      return {
        ...state,
        phase:       'dealing',
        deck:        action.deck,
        playerHand:  action.playerHand,
        dealerHand:  action.dealerHand,
        outcome:     null,
        payout:      0,
        outcomeLabel: '',
      };

    case 'DEALING_DONE':
      return { ...state, phase: 'player-turn' };

    case 'HIT':
      return {
        ...state,
        playerHand: [...state.playerHand, action.card],
        deck:       state.deck.slice(1),
      };

    case 'BUST':
      return { ...state, phase: 'dealer-turn' };

    case 'STAND':
      return { ...state, phase: 'dealer-turn' };

    case 'DEALER_REVEAL_HOLE':
      return {
        ...state,
        dealerHand: state.dealerHand.map((c, i) =>
          i === 1 ? { ...c, hidden: false } : c
        ),
      };

    case 'DEALER_DRAW':
      return {
        ...state,
        dealerHand: [...state.dealerHand, action.card],
        deck:       state.deck.slice(1),
      };

    case 'RESOLVE':
      return {
        ...state,
        phase:        'resolved',
        outcome:      action.outcome,
        payout:       action.payout,
        outcomeLabel: action.label,
      };

    case 'RESET':
      return {
        phase:        'idle',
        deck:         [],
        playerHand:   [],
        dealerHand:   [],
        outcome:      null,
        payout:       0,
        outcomeLabel: '',
      };

    default:
      return state;
  }
}

const INITIAL_STATE: GameState = {
  phase:        'idle',
  deck:         [],
  playerHand:   [],
  dealerHand:   [],
  outcome:      null,
  payout:       0,
  outcomeLabel: '',
};

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------
export default function BlackjackModal() {
  const {
    blackjackOpen,
    blackjackBet,
    blackjackDisplayBalance,
    closeBlackjackTable,
    setBlackjackBet,
    openBlackjackTable,
  } = useCoveStore();

  const { data: avatar } = useAvatar();
  const [localBalance, setLocalBalance] = useState(0);
  const [gs, dispatch] = useReducer(gameReducer, INITIAL_STATE);

  // Current deckRef so async timer callbacks can pop from live state
  const deckRef = useRef<BJCard[]>([]);
  deckRef.current = gs.deck;

  useEffect(() => {
    if (blackjackOpen) {
      setLocalBalance(blackjackDisplayBalance || avatar?.clawTokens || 0);
      dispatch({ type: 'RESET' });
    }
  }, [blackjackOpen, blackjackDisplayBalance, avatar?.clawTokens]);

  // ── Keyboard ─────────────────────────────────────────────────────────────
  const handleClose = useCallback(() => { closeBlackjackTable(); }, [closeBlackjackTable]);

  useEffect(() => {
    if (!blackjackOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [blackjackOpen, handleClose]);

  // ── Resolve outcome ───────────────────────────────────────────────────────
  const resolveOutcome = useCallback((
    playerHand: BJCard[],
    dealerHandFull: BJCard[],
    bet: number,
  ) => {
    const pTotal = handTotal(playerHand);
    const dTotal = handTotal(dealerHandFull);
    const playerBJ = isNaturalBlackjack(playerHand);
    const dealerBJ = isNaturalBlackjack(dealerHandFull);

    let outcome: BJOutcomeExtended;
    let payout: number;
    let label: string;

    if (pTotal > 21) {
      outcome = 'bust';
      payout  = bet;
      label   = `You busted with ${pTotal}`;
    } else if (playerBJ && dealerBJ) {
      outcome = 'push';
      payout  = 0;
      label   = 'Both have Blackjack — push';
    } else if (playerBJ) {
      outcome  = 'blackjack';
      payout   = Math.floor(bet * 1.5);
      label    = `Blackjack! +${Math.floor(bet * 1.5)} CT`;
    } else if (dTotal > 21) {
      outcome = 'win';
      payout  = bet;
      label   = `Dealer busted with ${dTotal}`;
    } else if (pTotal > dTotal) {
      outcome = 'win';
      payout  = bet;
      label   = `${pTotal} beats ${dTotal}`;
    } else if (pTotal === dTotal) {
      outcome = 'push';
      payout  = 0;
      label   = `Push — both ${pTotal}`;
    } else {
      outcome = 'loss';
      payout  = bet;
      label   = `${dTotal} beats ${pTotal}`;
    }

    dispatch({ type: 'RESOLVE', outcome, payout, label });

    // Adjust local display balance (no ledger write)
    setLocalBalance(prev => {
      if (outcome === 'bust' || outcome === 'loss') return Math.max(0, prev - bet);
      if (outcome === 'win') return prev + bet;
      if (outcome === 'blackjack') return prev + Math.floor(bet * 1.5);
      return prev; // push
    });
  }, []);

  // ── Dealer turn: sequential async draws ──────────────────────────────────
  const runDealerTurn = useCallback(async (
    playerHand: BJCard[],
    dealerHandAfterReveal: BJCard[],
    deck: BJCard[],
    bet: number,
  ) => {
    const playerBust = handTotal(playerHand) > 21;
    let dHand = [...dealerHandAfterReveal];
    let dDeck = [...deck];

    // Draw until hard 17+ (also hit soft 17)
    while (!playerBust && (handTotal(dHand) < 17 || isSoft17(dHand))) {
      await new Promise(r => setTimeout(r, 420));
      const card = dDeck[0];
      if (!card) break;
      dDeck = dDeck.slice(1);
      dHand = [...dHand, card];
      dispatch({ type: 'DEALER_DRAW', card });
    }

    resolveOutcome(playerHand, dHand, bet);
  }, [resolveOutcome]);

  // ── When phase enters dealer-turn, reveal hole card then run draws ────────
  const dealerTurnStarted = useRef(false);
  useEffect(() => {
    if (gs.phase !== 'dealer-turn') {
      dealerTurnStarted.current = false;
      return;
    }
    if (dealerTurnStarted.current) return;
    dealerTurnStarted.current = true;

    // Capture hand + deck snapshots at this moment
    const playerSnap = gs.playerHand;
    const dealerSnap = gs.dealerHand;
    const deckSnap   = gs.deck;
    const betSnap    = blackjackBet;

    // Reveal hole card first
    dispatch({ type: 'DEALER_REVEAL_HOLE' });
    const revealed = dealerSnap.map((c, i) => i === 1 ? { ...c, hidden: false } : c);

    setTimeout(() => {
      void runDealerTurn(playerSnap, revealed, deckSnap, betSnap);
    }, 420);
  }, [gs.phase, gs.playerHand, gs.dealerHand, gs.deck, blackjackBet, runDealerTurn]);

  // ── DEAL ──────────────────────────────────────────────────────────────────
  const handleDeal = useCallback(async () => {
    if (gs.phase !== 'idle') return;

    const seed = (blackjackBet * 31 + Date.now()) | 0;
    const rand = mulberry32(seed);
    const deck = buildShuffledDeck(rand);

    // Initial deal: player c0, dealer c1, player c2, dealer c3 (hidden)
    const p0 = deck[0]!;
    const d0 = deck[1]!;
    const p1 = deck[2]!;
    const d1 = { ...deck[3]!, hidden: true };
    const remainingDeck = deck.slice(4);

    const playerHand: BJCard[] = [p0, p1];
    const dealerHand: BJCard[] = [d0, d1];

    dispatch({ type: 'DEAL', deck: remainingDeck, playerHand, dealerHand });

    // After ~800ms dealing animation, transition to player-turn
    // (unless natural blackjack — auto-resolve)
    await new Promise(r => setTimeout(r, 820));

    if (isNaturalBlackjack(playerHand)) {
      // Still reveal dealer hole + check for push
      dispatch({ type: 'DEALER_REVEAL_HOLE' });
      const dealerFull: BJCard[] = [d0, { ...deck[3]!, hidden: false }];
      await new Promise(r => setTimeout(r, 300));
      resolveOutcome(playerHand, dealerFull, blackjackBet);
    } else {
      dispatch({ type: 'DEALING_DONE' });
    }
  }, [gs.phase, blackjackBet, resolveOutcome]);

  // ── HIT ───────────────────────────────────────────────────────────────────
  const handleHit = useCallback(() => {
    if (gs.phase !== 'player-turn') return;
    const card = deckRef.current[0];
    if (!card) return;
    dispatch({ type: 'HIT', card });

    // Check bust after adding card
    const newHand = [...gs.playerHand, card];
    if (handTotal(newHand) > 21) {
      dispatch({ type: 'BUST' });
    }
  }, [gs.phase, gs.playerHand]);

  // ── STAND ─────────────────────────────────────────────────────────────────
  const handleStand = useCallback(() => {
    if (gs.phase !== 'player-turn') return;
    dispatch({ type: 'STAND' });
  }, [gs.phase]);

  // ── NEXT HAND ─────────────────────────────────────────────────────────────
  const handleNextHand = useCallback(() => {
    openBlackjackTable(localBalance);
  }, [localBalance, openBlackjackTable]);

  if (!blackjackOpen) return null;

  const playerTotal = handTotal(gs.playerHand);
  const dealerTotal = handTotal(gs.dealerHand);
  const inProgress  = gs.phase === 'dealing' || gs.phase === 'dealer-turn';
  const isIdle      = gs.phase === 'idle';
  const isPlayerTurn = gs.phase === 'player-turn';
  const isResolved  = gs.phase === 'resolved';

  // Dealer total label: hide hole card contribution when it's hidden
  const dealerVisibleCards = gs.dealerHand.filter(c => !c.hidden);
  const dealerDisplayTotal = handTotal(dealerVisibleCards);

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
        {/* ── Header ─────────────────────────────────────────────────── */}
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

        {/* ── Felt ───────────────────────────────────────────────────── */}
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
          {/* Felt texture lines */}
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
              DEALER MUST STAND ON 17 · HITS SOFT 17
            </div>
            <HandRow
              label="Dealer"
              cards={gs.dealerHand}
              totalLabel={
                gs.dealerHand.length > 0
                  ? `${dealerDisplayTotal}${gs.dealerHand.some(c => c.hidden) ? '+?' : ''}`
                  : undefined
              }
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
              cards={gs.playerHand}
              totalLabel={gs.playerHand.length > 0 ? `${playerTotal}` : undefined}
            />
          </div>

          {/* Outcome banner */}
          {isResolved && gs.outcome && (
            <OutcomeBanner
              outcome={gs.outcome === 'bust' ? 'loss' : gs.outcome}
              payout={gs.payout}
              label={gs.outcomeLabel}
              isBust={gs.outcome === 'bust'}
            />
          )}
        </div>

        {/* ── Action strip ───────────────────────────────────────────── */}
        <div style={{
          flexShrink: 0,
          background: 'rgba(0,0,0,0.35)',
          borderTop: '1px solid rgba(60,180,120,0.2)',
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}>
          {/* Bet selector — only shown in idle */}
          {isIdle && (
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

          {/* Phase-driven action buttons */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>

            {/* ── idle: DEAL ────────────────────────────────────────── */}
            {isIdle && (
              <button
                type="button"
                onClick={() => { void handleDeal(); }}
                className="pt-btn pt-btn-primary"
                style={{ minWidth: 90, height: 40, fontSize: 13, fontWeight: 700 }}
              >
                Deal ({blackjackBet} CT)
              </button>
            )}

            {/* ── dealing: spinner ──────────────────────────────────── */}
            {gs.phase === 'dealing' && (
              <button
                type="button"
                disabled
                className="pt-btn pt-btn-primary"
                style={{ minWidth: 90, height: 40, fontSize: 13, fontWeight: 700, opacity: 0.7 }}
              >
                Dealing…
              </button>
            )}

            {/* ── player-turn: HIT / STAND / disabled extras ────────── */}
            {isPlayerTurn && (
              <>
                <button
                  type="button"
                  onClick={handleHit}
                  className="pt-btn pt-btn-primary"
                  style={{ height: 40, fontSize: 13, fontWeight: 700, minWidth: 70 }}
                >
                  Hit
                </button>
                <button
                  type="button"
                  onClick={handleStand}
                  className="pt-btn pt-btn-ghost"
                  style={{ height: 40, fontSize: 12, minWidth: 70 }}
                >
                  Stand
                </button>
                <button type="button" disabled className="pt-btn pt-btn-ghost"
                  title="Available in Phase 6.4.1"
                  style={{ height: 40, fontSize: 12, opacity: 0.35 }}>
                  Double
                </button>
                <button type="button" disabled className="pt-btn pt-btn-ghost"
                  title="Available in Phase 6.4.1"
                  style={{ height: 40, fontSize: 12, opacity: 0.35 }}>
                  Split
                </button>
                <button type="button" disabled className="pt-btn pt-btn-ghost"
                  title="Available in Phase 6.4.1"
                  style={{ height: 40, fontSize: 12, opacity: 0.35 }}>
                  Surrender
                </button>
              </>
            )}

            {/* ── dealer-turn: waiting label ────────────────────────── */}
            {gs.phase === 'dealer-turn' && (
              <button type="button" disabled className="pt-btn pt-btn-ghost"
                style={{ height: 40, fontSize: 12, opacity: 0.6, minWidth: 120 }}>
                Dealer drawing…
              </button>
            )}

            {/* ── resolved: NEXT HAND + WALK AWAY ──────────────────── */}
            {isResolved && (
              <>
                <button
                  type="button"
                  onClick={handleNextHand}
                  className="pt-btn pt-btn-primary"
                  style={{ minWidth: 110, height: 40, fontSize: 13 }}
                >
                  Next Hand
                </button>
                {/* Walk Away — filled crimson bg with white text for clear contrast on dark navy */}
                <button
                  type="button"
                  onClick={handleClose}
                  style={{
                    height: 40,
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: 'var(--pt-data)',
                    letterSpacing: '0.06em',
                    paddingLeft: 16,
                    paddingRight: 16,
                    borderRadius: 6,
                    border: 'none',
                    background: '#dc2626',
                    color: '#ffffff',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#b91c1c'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#dc2626'; }}
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
            INTERACTIVE SHELL · PHASE 6.4.0 · DOUBLE/SPLIT/SURRENDER IN 6.4.1
          </div>
        </div>
      </div>
    </div>
  );
}
