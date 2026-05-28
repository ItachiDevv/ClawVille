'use client';

/**
 * HoldemModal — Phase 6.5.0 Texas Hold'em interactive shell.
 *
 * State machine phases (useReducer):
 *   idle        → buy-in display (default 1000 CT) + DEAL button.
 *   dealing     → animate 2-card deal to all 6 seats (~800ms), post blinds.
 *   player-turn → action panel: Fold | Check/Call | Raise (slider) | AllIn.
 *   bot-turn    → each bot auto-calls sequentially, 400ms cadence.
 *   flop-deal   → deal 3 community cards, one every 200ms.
 *   turn-deal   → deal 1 community card.
 *   river-deal  → deal 1 community card.
 *   showdown    → reveal all hole cards, mock winner, 2s pause.
 *   resolved    → NEXT HAND + WALK AWAY buttons.
 *
 * Phase 6.5.0 constraints:
 *   - NO ledger writes (no transferClawTokens). Bankroll is local state.
 *   - Bot personalities = always-call (full TAG/LAG/TP in 6.5.1).
 *   - Mock winner = highest sum of best-2 cards by rank value.
 *
 * Primitive components (PokerCard, SeatPosition, CommunityCardRow, PotDisplay,
 * ChipStack) are imported from impl-card's polished files in this directory.
 * Their prop shapes are defined in holdem-types.ts.
 *
 * Iris Xe safe: no drei Text/Billboard, no InstancedMesh+ShaderMaterial,
 * no per-frame new Vector3. Pure React/CSS, zero Three.js import.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useCoveStore } from '@/stores/cove';
import { useAvatar } from '@/hooks/use-avatar';
import '@/styles/cove-tokens.css';
import {
  createMockDeck,
  dealHand,
  mockBotAction,
  mockWinner,
  buildInitialSeats,
} from '@/lib/cove/holdem-mock-engine';
import type {
  HoldemGameState,
  HoldemAction,
  HoldemCard,
  SeatState,
  RaiseConfig,
} from '@/lib/cove/holdem-types';
import {
  HOLDEM_DEFAULT_BUY_IN,
  HOLDEM_BIG_BLIND,
  HOLDEM_BOT_ACTION_DELAY_MS,
  HOLDEM_DEAL_DELAY_MS,
  HOLDEM_FLOP_CARD_DELAY_MS,
  HOLDEM_SHOWDOWN_PAUSE_MS,
} from '@/lib/cove/holdem-types';

// impl-card polished primitives — prop shapes match holdem-types.ts exactly
import SeatPosition from './SeatPosition';
import CommunityCardRow from './CommunityCardRow';
import PotDisplay from './PotDisplay';
import ChipStack from './ChipStack';

// ---------------------------------------------------------------------------
// State machine reducer
// ---------------------------------------------------------------------------
const EMPTY_COMMUNITY: (HoldemCard | null)[] = [null, null, null, null, null];

function buildInitialState(localBalance: number): HoldemGameState {
  return {
    phase: 'idle',
    street: 'preflop',
    seats: [],
    communityCards: [...EMPTY_COMMUNITY],
    pot: 0,
    currentBet: HOLDEM_BIG_BLIND,
    actingSeatIndex: 0,
    botQueue: [],
    deck: [],
    winnerSeatIndex: null,
    potWon: 0,
    localBalance,
  };
}

function calcPotFromSeats(seats: SeatState[]): number {
  return seats.reduce((sum, s) => sum + s.streetBet, 0);
}

function gameReducer(state: HoldemGameState, action: HoldemAction): HoldemGameState {
  switch (action.type) {

    case 'INIT_DEAL': {
      return {
        ...state,
        phase: 'dealing',
        street: 'preflop',
        seats: action.seats,
        communityCards: [...EMPTY_COMMUNITY],
        deck: action.deck,
        pot: 0,
        currentBet: HOLDEM_BIG_BLIND,
        actingSeatIndex: 0,
        botQueue: [],
        winnerSeatIndex: null,
        potWon: 0,
        localBalance: action.localBalance,
      };
    }

    case 'DEALING_DONE': {
      const pot = calcPotFromSeats(state.seats);
      return { ...state, phase: 'player-turn', pot, actingSeatIndex: 0 };
    }

    case 'PLAYER_FOLD': {
      const seats = state.seats.map(s =>
        s.seatIndex === 0 ? { ...s, status: 'folded' as const, isActing: false } : s
      );
      return { ...state, seats, phase: 'bot-turn', botQueue: [1, 2, 3, 4, 5], actingSeatIndex: 1 };
    }

    case 'PLAYER_CHECK': {
      const seats = state.seats.map(s =>
        s.seatIndex === 0 ? { ...s, isActing: false } : s
      );
      return { ...state, seats, phase: 'bot-turn', botQueue: [1, 2, 3, 4, 5], actingSeatIndex: 1 };
    }

    case 'PLAYER_CALL': {
      const callAmt = Math.min(
        state.currentBet - (state.seats[0]?.streetBet ?? 0),
        state.seats[0]?.stack ?? 0,
      );
      const seats = state.seats.map(s => {
        if (s.seatIndex !== 0) return s;
        return {
          ...s,
          stack: s.stack - callAmt,
          streetBet: s.streetBet + callAmt,
          status: s.stack - callAmt <= 0 ? ('allin' as const) : s.status,
          isActing: false,
        };
      });
      return {
        ...state, seats, pot: state.pot + callAmt,
        phase: 'bot-turn', botQueue: [1, 2, 3, 4, 5], actingSeatIndex: 1,
      };
    }

    case 'PLAYER_RAISE': {
      const raiseAmt = Math.min(action.amount, state.seats[0]?.stack ?? 0);
      const seats = state.seats.map(s => {
        if (s.seatIndex !== 0) return s;
        return {
          ...s,
          stack: s.stack - raiseAmt,
          streetBet: s.streetBet + raiseAmt,
          status: s.stack - raiseAmt <= 0 ? ('allin' as const) : s.status,
          isActing: false,
        };
      });
      return {
        ...state, seats, pot: state.pot + raiseAmt,
        currentBet: Math.max(state.currentBet, seats[0]?.streetBet ?? 0),
        phase: 'bot-turn', botQueue: [1, 2, 3, 4, 5], actingSeatIndex: 1,
      };
    }

    case 'PLAYER_ALLIN': {
      const allInAmt = state.seats[0]?.stack ?? 0;
      const seats = state.seats.map(s => {
        if (s.seatIndex !== 0) return s;
        return {
          ...s,
          stack: 0,
          streetBet: s.streetBet + allInAmt,
          status: 'allin' as const,
          isActing: false,
        };
      });
      return {
        ...state, seats, pot: state.pot + allInAmt,
        currentBet: Math.max(state.currentBet, seats[0]?.streetBet ?? 0),
        phase: 'bot-turn', botQueue: [1, 2, 3, 4, 5], actingSeatIndex: 1,
      };
    }

    case 'BOT_ACT': {
      const { seatIndex, action: botAction, amount } = action;
      const seats = state.seats.map(s => {
        if (s.seatIndex !== seatIndex) return s;
        if (botAction === 'fold') return { ...s, status: 'folded' as const, isActing: false };
        if (botAction === 'allin') return { ...s, stack: 0, streetBet: s.streetBet + s.stack, status: 'allin' as const, isActing: false };
        return { ...s, stack: s.stack - amount, streetBet: s.streetBet + amount, isActing: false };
      });
      const remainingQueue = state.botQueue.slice(1);
      const nextBot = remainingQueue[0] ?? -1;
      const nextSeats = nextBot >= 0
        ? seats.map(s => ({ ...s, isActing: s.seatIndex === nextBot }))
        : seats;
      return {
        ...state, seats: nextSeats, pot: state.pot + amount,
        botQueue: remainingQueue, actingSeatIndex: nextBot,
      };
    }

    case 'BOT_QUEUE_DONE': {
      const streetSeats = state.seats.map(s => ({ ...s, streetBet: 0, isActing: false }));
      switch (state.street) {
        case 'preflop': return { ...state, seats: streetSeats, phase: 'flop-deal', currentBet: 0 };
        case 'flop':    return { ...state, seats: streetSeats, phase: 'turn-deal', currentBet: 0 };
        case 'turn':    return { ...state, seats: streetSeats, phase: 'river-deal', currentBet: 0 };
        case 'river':   return { ...state, seats: streetSeats, phase: 'showdown' };
        default:        return state;
      }
    }

    case 'DEAL_FLOP': {
      const community = [...state.communityCards];
      community[0] = action.cards[0];
      community[1] = action.cards[1];
      community[2] = action.cards[2];
      return { ...state, communityCards: community, street: 'flop', phase: 'player-turn', actingSeatIndex: 0, currentBet: 0 };
    }

    case 'DEAL_TURN': {
      const community = [...state.communityCards];
      community[3] = action.card;
      return { ...state, communityCards: community, street: 'turn', phase: 'player-turn', actingSeatIndex: 0, currentBet: 0 };
    }

    case 'DEAL_RIVER': {
      const community = [...state.communityCards];
      community[4] = action.card;
      return { ...state, communityCards: community, street: 'river', phase: 'player-turn', actingSeatIndex: 0, currentBet: 0 };
    }

    case 'BEGIN_SHOWDOWN': {
      const seats = state.seats.map(s => {
        if (s.status === 'folded' || !s.holeCards) return s;
        return {
          ...s,
          holeCards: [
            { ...s.holeCards[0], hidden: false },
            { ...s.holeCards[1], hidden: false },
          ] as [HoldemCard, HoldemCard],
        };
      });
      return { ...state, phase: 'showdown', seats };
    }

    case 'RESOLVE': {
      const { winnerSeatIndex, potWon } = action;
      const isPlayerWinner = winnerSeatIndex === 0;
      const newBalance = isPlayerWinner
        ? state.localBalance + potWon
        : Math.max(0, state.localBalance - (state.seats[0]?.streetBet ?? 0));
      const seats = state.seats.map(s =>
        s.seatIndex === winnerSeatIndex ? { ...s, stack: s.stack + potWon } : s
      );
      return { ...state, phase: 'resolved', winnerSeatIndex, potWon, seats, localBalance: newBalance };
    }

    case 'RESET': {
      return buildInitialState(action.localBalance);
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Raise slider
// ---------------------------------------------------------------------------
function RaiseSlider({
  config,
  onChange,
  onConfirm,
  onCancel,
}: {
  config: RaiseConfig;
  onChange: (v: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      background: 'rgba(0,0,0,0.35)',
      border: '1px solid rgba(60,180,100,0.2)',
      borderRadius: 6, padding: '6px 10px',
    }}>
      <input
        type="range"
        min={config.min}
        max={config.max}
        step={HOLDEM_BIG_BLIND}
        value={config.value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor: 'var(--pt-amber)' }}
        aria-label="Raise amount"
      />
      <span style={{
        fontSize: 12, fontFamily: 'var(--pt-data)', color: 'var(--pt-amber)',
        fontWeight: 700, minWidth: 48, textAlign: 'right',
      }}>
        {config.value} CT
      </span>
      <button
        type="button"
        onClick={onConfirm}
        style={{
          height: 32, padding: '0 12px', borderRadius: 6, border: 'none',
          background: 'rgba(200,150,30,0.85)', color: '#fff',
          fontFamily: 'var(--pt-data)', fontWeight: 700, fontSize: 11, cursor: 'pointer',
        }}
      >
        Raise
      </button>
      <button
        type="button"
        onClick={onCancel}
        style={{
          height: 32, padding: '0 8px', borderRadius: 6,
          border: '1px solid rgba(120,120,120,0.4)',
          background: 'transparent', color: 'var(--pt-mute)',
          fontFamily: 'var(--pt-data)', fontSize: 11, cursor: 'pointer',
        }}
      >
        Cancel
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Seat oval layout positions — absolute within the felt area
// ---------------------------------------------------------------------------
const SEAT_POSITIONS: Array<{ top: string; left: string }> = [
  { top: 'calc(100% - 80px)', left: '50%'         }, // 0 = player (bottom-center)
  { top: 'calc(100% - 60px)', left: 'calc(20%)'   }, // 1 = SB (bottom-left)
  { top: '50%',               left: 'calc(2%)'    }, // 2 = BB (mid-left)
  { top: 'calc(10%)',         left: 'calc(15%)'   }, // 3 (top-left)
  { top: 'calc(10%)',         left: 'calc(70%)'   }, // 4 (top-right)
  { top: '50%',               left: 'calc(90%)'   }, // 5 (mid-right)
];

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------
export default function HoldemModal() {
  const { holdemModalOpen, holdemBuyIn, closeHoldemTable } = useCoveStore();
  const { data: avatar } = useAvatar();

  // holdemBuyIn is already capped at min(balance, COVE_HOLDEM_DEFAULT_BUYIN) by the store
  const startingBalance = holdemBuyIn || avatar?.clawTokens || HOLDEM_DEFAULT_BUY_IN;
  const [gs, dispatch] = useReducer(gameReducer, buildInitialState(startingBalance));

  const [showRaise, setShowRaise] = useState(false);
  const [raiseConfig, setRaiseConfig] = useState<RaiseConfig>({ min: 0, max: 0, value: 0 });

  // Refs so async callbacks see live state without stale closures
  const deckRef = useRef<HoldemCard[]>([]);
  deckRef.current = gs.deck;
  const phaseRef = useRef(gs.phase);
  phaseRef.current = gs.phase;
  const seatsRef = useRef(gs.seats);
  seatsRef.current = gs.seats;
  const communityRef = useRef(gs.communityCards);
  communityRef.current = gs.communityCards;
  const potRef = useRef(gs.pot);
  potRef.current = gs.pot;

  // Reset on open
  useEffect(() => {
    if (holdemModalOpen) {
      dispatch({ type: 'RESET', localBalance: startingBalance });
    }
  }, [holdemModalOpen, startingBalance]);

  // Escape key
  const handleClose = useCallback(() => closeHoldemTable(), [closeHoldemTable]);
  useEffect(() => {
    if (!holdemModalOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [holdemModalOpen, handleClose]);

  // ── DEAL ──────────────────────────────────────────────────────────────────
  const handleDeal = useCallback(async () => {
    if (gs.phase !== 'idle') return;
    setShowRaise(false);

    const seed = (gs.localBalance * 31 + Date.now()) | 0;
    const deck = createMockDeck(seed);
    const { holeCards, communityDeck, remainingDeck } = dealHand(deck);

    const initialSeats = buildInitialSeats(gs.localBalance);

    const seatsWithCards = initialSeats.map((seat, i) => {
      const cards = holeCards[i];
      if (!cards) return seat;
      const isPlayer = i === 0;
      return {
        ...seat,
        holeCards: [
          { ...cards[0], hidden: !isPlayer },
          { ...cards[1], hidden: !isPlayer },
        ] as [HoldemCard, HoldemCard],
      };
    });

    dispatch({
      type: 'INIT_DEAL',
      deck: [...communityDeck, ...remainingDeck],
      seats: seatsWithCards,
      localBalance: gs.localBalance,
    });

    await new Promise(r => setTimeout(r, HOLDEM_DEAL_DELAY_MS));
    dispatch({ type: 'DEALING_DONE' });
  }, [gs.phase, gs.localBalance]);

  // ── BOT QUEUE ─────────────────────────────────────────────────────────────
  const botQueueRunning = useRef(false);

  useEffect(() => {
    if (gs.phase !== 'bot-turn') { botQueueRunning.current = false; return; }
    if (botQueueRunning.current) return;
    botQueueRunning.current = true;

    void (async () => {
      const queue = [...gs.botQueue];
      let currentSeats = seatsRef.current;
      const currentBet = gs.currentBet;

      for (const seatIdx of queue) {
        await new Promise(r => setTimeout(r, HOLDEM_BOT_ACTION_DELAY_MS));
        if (phaseRef.current !== 'bot-turn') break;

        const seat = currentSeats.find(s => s.seatIndex === seatIdx);
        if (!seat || seat.status === 'folded' || seat.status === 'allin' || seat.status === 'out') {
          dispatch({ type: 'BOT_ACT', seatIndex: seatIdx, action: 'fold', amount: 0 });
          continue;
        }

        const callAmt = Math.max(0, currentBet - seat.streetBet);
        const result = mockBotAction(seat.stack, callAmt);
        dispatch({ type: 'BOT_ACT', seatIndex: seatIdx, action: result.action, amount: result.amount });
        currentSeats = seatsRef.current;
      }

      await new Promise(r => setTimeout(r, 120));
      dispatch({ type: 'BOT_QUEUE_DONE' });
      botQueueRunning.current = false;
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gs.phase]);

  // ── Community card deal ───────────────────────────────────────────────────
  const communityDealing = useRef(false);

  useEffect(() => {
    if (gs.phase !== 'flop-deal' && gs.phase !== 'turn-deal' && gs.phase !== 'river-deal') {
      communityDealing.current = false;
      return;
    }
    if (communityDealing.current) return;
    communityDealing.current = true;

    void (async () => {
      const deck = deckRef.current;
      if (gs.phase === 'flop-deal') {
        await new Promise(r => setTimeout(r, HOLDEM_FLOP_CARD_DELAY_MS));
        const c0 = deck[0]!;
        await new Promise(r => setTimeout(r, HOLDEM_FLOP_CARD_DELAY_MS));
        const c1 = deck[1]!;
        await new Promise(r => setTimeout(r, HOLDEM_FLOP_CARD_DELAY_MS));
        const c2 = deck[2]!;
        dispatch({ type: 'DEAL_FLOP', cards: [c0, c1, c2] });
      } else if (gs.phase === 'turn-deal') {
        await new Promise(r => setTimeout(r, HOLDEM_FLOP_CARD_DELAY_MS));
        dispatch({ type: 'DEAL_TURN', card: deck[3]! });
      } else if (gs.phase === 'river-deal') {
        await new Promise(r => setTimeout(r, HOLDEM_FLOP_CARD_DELAY_MS));
        dispatch({ type: 'DEAL_RIVER', card: deck[4]! });
      }
      communityDealing.current = false;
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gs.phase]);

  // ── SHOWDOWN ──────────────────────────────────────────────────────────────
  const showdownRan = useRef(false);

  useEffect(() => {
    if (gs.phase !== 'showdown') { showdownRan.current = false; return; }
    if (showdownRan.current) return;
    showdownRan.current = true;

    void (async () => {
      dispatch({ type: 'BEGIN_SHOWDOWN' });
      await new Promise(r => setTimeout(r, HOLDEM_SHOWDOWN_PAUSE_MS));
      const winnerIdx = mockWinner(seatsRef.current, communityRef.current);
      dispatch({ type: 'RESOLVE', winnerSeatIndex: winnerIdx, potWon: potRef.current });
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gs.phase]);

  // ── Player actions ────────────────────────────────────────────────────────
  const handleFold = useCallback(() => {
    if (gs.phase !== 'player-turn') return;
    setShowRaise(false);
    dispatch({ type: 'PLAYER_FOLD' });
  }, [gs.phase]);

  const handleCheck = useCallback(() => {
    if (gs.phase !== 'player-turn') return;
    setShowRaise(false);
    dispatch({ type: 'PLAYER_CHECK' });
  }, [gs.phase]);

  const handleCall = useCallback(() => {
    if (gs.phase !== 'player-turn') return;
    setShowRaise(false);
    dispatch({ type: 'PLAYER_CALL' });
  }, [gs.phase]);

  const handleOpenRaise = useCallback(() => {
    if (gs.phase !== 'player-turn') return;
    const playerStack = gs.seats[0]?.stack ?? 0;
    const minRaise = gs.currentBet * 2 || HOLDEM_BIG_BLIND * 2;
    setRaiseConfig({ min: minRaise, max: playerStack, value: minRaise });
    setShowRaise(true);
  }, [gs.phase, gs.seats, gs.currentBet]);

  const handleConfirmRaise = useCallback(() => {
    dispatch({ type: 'PLAYER_RAISE', amount: raiseConfig.value });
    setShowRaise(false);
  }, [raiseConfig.value]);

  const handleAllIn = useCallback(() => {
    if (gs.phase !== 'player-turn') return;
    setShowRaise(false);
    dispatch({ type: 'PLAYER_ALLIN' });
  }, [gs.phase]);

  const handleNextHand = useCallback(() => {
    setShowRaise(false);
    dispatch({ type: 'RESET', localBalance: gs.localBalance });
  }, [gs.localBalance]);

  // ── Derived display values ────────────────────────────────────────────────
  const playerSeat = gs.seats[0];
  const playerStack = playerSeat?.stack ?? gs.localBalance;
  const facingBet = gs.currentBet > (playerSeat?.streetBet ?? 0);
  const canCheck = !facingBet && gs.phase === 'player-turn';
  const callAmount = facingBet
    ? Math.min(gs.currentBet - (playerSeat?.streetBet ?? 0), playerStack)
    : 0;

  const isResolved      = gs.phase === 'resolved';
  const isIdle          = gs.phase === 'idle';
  const isPlayerTurn    = gs.phase === 'player-turn';
  const isBotTurn       = gs.phase === 'bot-turn';
  const isDealing       = gs.phase === 'dealing';
  const inCommunityDeal = gs.phase === 'flop-deal' || gs.phase === 'turn-deal' || gs.phase === 'river-deal';

  const winnerName = useMemo(() => {
    if (gs.winnerSeatIndex === null) return null;
    return gs.seats[gs.winnerSeatIndex]?.name ?? `Seat ${gs.winnerSeatIndex}`;
  }, [gs.winnerSeatIndex, gs.seats]);

  if (!holdemModalOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Texas Hold'em table"
      style={{
        position: 'fixed', inset: 0, zIndex: 9990,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
        background: 'rgba(2, 16, 24, 0.88)',
        backdropFilter: 'blur(6px)',
        animation: 'cv-modal-bg-in var(--cv-motion-base) var(--cv-ease-standard)',
      }}
    >
      <div
        style={{
          position: 'relative', width: '100%',
          maxWidth: 780,
          maxHeight: 'min(94vh, 760px)',
          borderRadius: 14, overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.65), 0 0 0 1px rgba(60,180,120,0.35)',
          background: 'var(--pt-velvet)',
          animation: 'cv-modal-in var(--cv-motion-base) var(--cv-ease-bounce)',
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* ── Header ───────────────────────────────────────────────────── */}
        <header style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '11px 16px',
          background: 'rgba(0,0,0,0.3)',
          borderBottom: '1px solid rgba(60,180,120,0.2)',
          flexShrink: 0,
        }}>
          <div style={{
            fontSize: 11, fontFamily: 'var(--pt-data)',
            color: 'var(--pt-mute)', letterSpacing: '0.14em',
          }}>
            TEXAS HOLD&apos;EM · FUN MONEY · 6-MAX
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'rgba(150,110,30,0.15)',
            border: '1px solid rgba(150,110,30,0.3)',
            borderRadius: 6, padding: '3px 10px',
          }}>
            <ChipStack amount={gs.localBalance} inline />
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close Hold'em table"
            style={{
              background: 'none', border: 'none',
              color: 'var(--pt-mute)', cursor: 'pointer',
              padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </header>

        {/* ── Felt + seat oval ─────────────────────────────────────────── */}
        <div style={{
          flex: 1, position: 'relative', minHeight: 340,
          background: 'linear-gradient(180deg, #0d3a1e 0%, #0a2e18 50%, #0d3a1e 100%)',
          overflow: 'hidden',
        }}>
          {/* Felt texture */}
          <div aria-hidden style={{
            position: 'absolute', inset: 0,
            backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 19px, rgba(60,160,80,0.05) 20px)',
            pointerEvents: 'none',
          }} />

          {/* Oval table rim */}
          <div aria-hidden style={{
            position: 'absolute',
            top: '12%', left: '8%', right: '8%', bottom: '18%',
            borderRadius: '50%',
            border: '2px solid rgba(60,180,80,0.18)',
            background: 'rgba(0,0,0,0.1)',
            pointerEvents: 'none',
          }} />

          {/* Community cards + pot — table center */}
          <div style={{
            position: 'absolute', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', gap: 10, zIndex: 3,
          }}>
            <CommunityCardRow cards={gs.communityCards} />
            {gs.pot > 0 && <PotDisplay pot={gs.pot} />}
          </div>

          {/* Seat positions — absolute layout, SeatPosition is position-agnostic */}
          {gs.seats.map(seat => {
            const pos = SEAT_POSITIONS[seat.seatIndex] ?? SEAT_POSITIONS[0]!;
            const isPlayer = seat.seatIndex === 0;
            const revealCards = isPlayer || gs.phase === 'showdown' || gs.phase === 'resolved';
            return (
              <div
                key={seat.seatIndex}
                style={{
                  position: 'absolute',
                  top: pos.top,
                  left: pos.left,
                  transform: 'translate(-50%, -50%)',
                  zIndex: isPlayer ? 2 : 1,
                }}
              >
                <SeatPosition seat={seat} isPlayer={isPlayer} revealCards={revealCards} />
              </div>
            );
          })}

          {/* Outcome overlay */}
          {isResolved && gs.winnerSeatIndex !== null && (
            <div style={{
              position: 'absolute', top: '30%', left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 10, pointerEvents: 'none',
              animation: 'bj-banner-in 450ms cubic-bezier(0.22,1,0.36,1)',
              textAlign: 'center',
            }}>
              <div style={{
                background: 'var(--pt-velvet)',
                border: `2px solid ${gs.winnerSeatIndex === 0 ? 'var(--pt-amber-glow)' : '#e85555'}`,
                padding: '14px 32px',
                boxShadow: `0 0 28px ${gs.winnerSeatIndex === 0 ? 'var(--pt-amber-glow)' : '#e85555'}55`,
              }}>
                <div style={{
                  color: gs.winnerSeatIndex === 0 ? 'var(--pt-amber)' : '#e85555',
                  fontSize: 11, fontFamily: 'var(--pt-data)',
                  letterSpacing: '0.2em', fontWeight: 700, marginBottom: 4,
                }}>
                  {gs.winnerSeatIndex === 0 ? 'YOU WIN' : `${winnerName} WINS`}
                </div>
                <div style={{
                  color: gs.winnerSeatIndex === 0 ? 'var(--pt-cream)' : '#e85555',
                  fontSize: 28, fontWeight: 700,
                  fontFamily: 'var(--pt-display)', lineHeight: 1,
                }}>
                  {gs.winnerSeatIndex === 0 ? `+${gs.potWon}` : `-${callAmount || 0}`} CT
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Action strip ─────────────────────────────────────────────── */}
        <div style={{
          flexShrink: 0,
          background: 'rgba(0,0,0,0.38)',
          borderTop: '1px solid rgba(60,180,120,0.18)',
          padding: '10px 16px',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>

          {showRaise && isPlayerTurn && (
            <RaiseSlider
              config={raiseConfig}
              onChange={v => setRaiseConfig(c => ({ ...c, value: v }))}
              onConfirm={handleConfirmRaise}
              onCancel={() => setShowRaise(false)}
            />
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>

            {isIdle && (
              <>
                <div style={{
                  fontSize: 11, fontFamily: 'var(--pt-data)', color: 'var(--pt-mute)',
                  letterSpacing: '0.1em',
                }}>
                  Buy-in: {Math.min(gs.localBalance, HOLDEM_DEFAULT_BUY_IN).toLocaleString()} CT · Blinds: 10/20
                </div>
                <button
                  type="button"
                  onClick={() => { void handleDeal(); }}
                  className="pt-btn pt-btn-primary"
                  style={{ height: 40, fontSize: 13, fontWeight: 700, minWidth: 90 }}
                >
                  Deal
                </button>
              </>
            )}

            {(isDealing || inCommunityDeal) && (
              <button type="button" disabled className="pt-btn pt-btn-primary"
                style={{ height: 40, fontSize: 13, fontWeight: 700, opacity: 0.7, minWidth: 90 }}
              >
                {isDealing ? 'Dealing…' : 'Dealing board…'}
              </button>
            )}

            {isBotTurn && (
              <button type="button" disabled className="pt-btn pt-btn-ghost"
                style={{ height: 40, fontSize: 12, opacity: 0.6, minWidth: 140 }}
              >
                Opponents acting…
              </button>
            )}

            {isPlayerTurn && !showRaise && (
              <>
                <button
                  type="button" onClick={handleFold}
                  className="pt-btn pt-btn-ghost"
                  style={{ height: 40, fontSize: 12, minWidth: 60 }}
                >
                  Fold
                </button>

                {canCheck ? (
                  <button
                    type="button" onClick={handleCheck}
                    className="pt-btn pt-btn-primary"
                    style={{ height: 40, fontSize: 13, fontWeight: 700, minWidth: 70 }}
                  >
                    Check
                  </button>
                ) : (
                  <button
                    type="button" onClick={handleCall}
                    className="pt-btn pt-btn-primary"
                    style={{ height: 40, fontSize: 13, fontWeight: 700, minWidth: 90 }}
                  >
                    Call {callAmount > 0 ? `${callAmount} CT` : ''}
                  </button>
                )}

                <button
                  type="button" onClick={handleOpenRaise}
                  className="pt-btn pt-btn-ghost"
                  style={{ height: 40, fontSize: 12, minWidth: 70 }}
                >
                  Raise
                </button>

                <button
                  type="button" onClick={handleAllIn}
                  className="pt-btn pt-btn-ghost"
                  style={{ height: 40, fontSize: 12, minWidth: 70, color: '#f59e0b' }}
                >
                  All In
                </button>
              </>
            )}

            {gs.phase === 'showdown' && (
              <button type="button" disabled className="pt-btn pt-btn-ghost"
                style={{ height: 40, fontSize: 12, opacity: 0.6, minWidth: 100 }}
              >
                Showdown…
              </button>
            )}

            {isResolved && (
              <>
                <button
                  type="button" onClick={handleNextHand}
                  className="pt-btn pt-btn-primary"
                  style={{ height: 40, fontSize: 13, minWidth: 110 }}
                >
                  Next Hand
                </button>
                {/* Crimson WALK AWAY — explicit bg+fg, never dark-on-dark (No-Dark-Text-On-Dark-Panel rule) */}
                <button
                  type="button" onClick={handleClose}
                  style={{
                    height: 40, fontSize: 12, fontWeight: 600,
                    fontFamily: 'var(--pt-data)', letterSpacing: '0.06em',
                    paddingLeft: 16, paddingRight: 16, borderRadius: 6,
                    border: 'none', background: '#dc2626', color: '#ffffff',
                    cursor: 'pointer', transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#b91c1c'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#dc2626'; }}
                >
                  Walk Away
                </button>
              </>
            )}
          </div>

          <div style={{
            fontSize: 9, color: 'rgba(100,180,130,0.35)',
            fontFamily: 'var(--pt-data)', letterSpacing: '0.12em',
            textAlign: 'right',
          }}>
            PHASE 6.5.0 · 6-MAX · MOCK BOTS · BLINDS 10/20 · {gs.phase.toUpperCase()}
          </div>
        </div>
      </div>
    </div>
  );
}
