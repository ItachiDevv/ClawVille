'use client';

import { useCallback, useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useAvatar } from '@/hooks/use-avatar';
import { useCoveStore } from '@/stores/cove';
import type { HoldemCard as ViewCard, SeatState, SeatStatus } from './holdem-types';
import { HOLDEM_SEATS } from './holdem-types';
import {
  COVE_HOLDEM_MIN_BUYIN,
  COVE_HOLDEM_MAX_BUYIN,
  HOLDEM_BOT_PERSONALITIES,
  deriveHoldemPublicSeats,
  type HoldemCard as WireCard,
  type HoldemTableWire,
  type HoldemDealResponse,
  type HoldemDealInProgressResponse,
  type HoldemActionInProgressResponse,
  type HoldemSettledResponse,
  type HoldemResyncHandView,
  type SerializedHoldemHand,
  type SerializedHoldemLogEntry,
} from '@clawville/shared';
import {
  CoveApiError,
  describeHoldemError,
  fetchCurrentHoldemTable,
  isHoldemSettled,
  useOpenHoldemTable,
  useDealHoldemHand,
  useHoldemAction,
  useCloseHoldemTable,
} from './holdem-api-client';

export interface LiveHoldemHand {
  handId: string;
  handIndex: number;
  buttonSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  humanHole: WireCard[];
  board: WireCard[];
  toCall: string;
  currentBet: string;
  humanStack: string;
  humanCommitted: string;
  smallBlind: string;
  bigBlind: string;
  publicActionLog: SerializedHoldemLogEntry[];
}

export type HoldemPhase = 'idle' | 'player-turn' | 'settled';
export type HoldemAgentMode = 'control' | 'autonomous';
export type HoldemAction = 'fold' | 'check' | 'call' | 'bet' | 'raise';
export type HoldemToastTone = 'info' | 'warn' | 'error';
export interface HoldemToastState { message: string; tone: HoldemToastTone; id: number; }

interface HoldemControllerState {
  table: HoldemTableWire | null;
  balance: number;
  live: LiveHoldemHand | null;
  settled: HoldemSettledResponse | null;
  revealedSeed: string | null;
  toast: HoldemToastState | null;
  phase: HoldemPhase;
  agentMode: HoldemAgentMode;
  inFlight: boolean;
  walkAwayLocked: boolean;
  seats: SeatState[];
  communityCards: (ViewCard | null)[];
  playerHoleCards: ViewCard[];
  pot: number;
  publicPot: string;
  toCall: string;
  currentBet: string;
  humanStack: string;
  humanCommitted: string;
  toCallNum: number;
  facingBet: boolean;
  canDeal: boolean;
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  canBet: boolean;
  canRaise: boolean;
  canAllIn: boolean;
  setAgentMode: (mode: HoldemAgentMode) => void;
  clearToast: (id?: number) => void;
  resetHand: () => void;
  handleDeal: () => Promise<void>;
  runAction: (action: HoldemAction, amount?: number) => Promise<void>;
  handleClose: () => void;
  handleWalkAway: () => Promise<void>;
}

const EMPTY_ACTIONS = {
  resetHand: () => {},
  handleDeal: async () => {},
  runAction: async (_action: HoldemAction, _amount?: number) => {},
  handleClose: () => {},
  handleWalkAway: async () => {},
};

export const useHoldemController = create<HoldemControllerState>(() => ({
  table: null,
  balance: 0,
  live: null,
  settled: null,
  revealedSeed: null,
  toast: null,
  phase: 'idle',
  agentMode: 'control',
  inFlight: false,
  walkAwayLocked: false,
  seats: [],
  communityCards: [null, null, null, null, null],
  playerHoleCards: [],
  pot: 0,
  publicPot: '0',
  toCall: '0',
  currentBet: '0',
  humanStack: '0',
  humanCommitted: '0',
  toCallNum: 0,
  facingBet: false,
  canDeal: true,
  canFold: false,
  canCheck: false,
  canCall: false,
  canBet: false,
  canRaise: false,
  canAllIn: false,
  setAgentMode: (agentMode) => useHoldemController.setState({ agentMode }),
  clearToast: (id) => useHoldemController.setState((state) => (
    id === undefined || state.toast?.id === id ? { toast: null } : state
  )),
  ...EMPTY_ACTIONS,
}));

function liveHandFromResync(hand: HoldemResyncHandView): LiveHoldemHand {
  return {
    handId: hand.handId,
    handIndex: hand.handIndex,
    buttonSeat: hand.buttonSeat,
    smallBlindSeat: hand.smallBlindSeat,
    bigBlindSeat: hand.bigBlindSeat,
    humanHole: hand.humanHole,
    board: hand.board,
    toCall: hand.toCall,
    currentBet: hand.currentBet,
    humanStack: hand.humanStack,
    humanCommitted: hand.humanCommitted,
    smallBlind: hand.smallBlind,
    bigBlind: hand.bigBlind,
    // Additive-wire rolling-deploy guard: an older API process may briefly
    // omit the new field while web has already deployed. Empty history keeps
    // play usable; the enriched server response restores narration next poll.
    publicActionLog: hand.publicActionLog ?? [],
  };
}

function viewCard(card: WireCard): ViewCard {
  return { suit: card.suit, rank: card.rank };
}

function bigToNum(value: string | null | undefined): number {
  if (value == null) return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** Bet/raise sizing lives in the pure module holdem-bet-math.ts (unit-tested);
 * re-exported here so the modal + seated HUD keep one import site. */
export {
  computeAllIn,
  computeRaiseOpen,
  type RaiseOpenResult,
} from './holdem-bet-math';

function botLabel(seat: number): string {
  const names: Record<number, string> = { 1: 'Tess', 2: 'Vex', 3: 'Pip', 4: 'Cal', 5: 'Nita' };
  const personality = HOLDEM_BOT_PERSONALITIES[seat];
  const name = names[seat] ?? `Bot ${seat}`;
  if (!personality) return name;
  const short = personality === 'tag' ? 'TAG'
    : personality === 'lag' ? 'LAG'
      : personality === 'tight-passive' ? 'TP'
        : personality === 'calling-station' ? 'CS'
          : 'NIT';
  return `${name} (${short})`;
}

function seatsForLiveHand(hand: LiveHoldemHand, humanIsActing: boolean): SeatState[] {
  const humanHole: [ViewCard, ViewCard] | null = hand.humanHole.length === 2
    ? [viewCard(hand.humanHole[0]!), viewCard(hand.humanHole[1]!)]
    : null;
  const publicSeats = deriveHoldemPublicSeats(hand.publicActionLog);

  return Array.from({ length: HOLDEM_SEATS }, (_, seatIndex): SeatState => {
    const isHuman = seatIndex === 0;
    const publicSeat = publicSeats[seatIndex];
    return {
      seatIndex,
      name: isHuman ? 'You' : botLabel(seatIndex),
      stack: isHuman ? bigToNum(hand.humanStack) : 0,
      streetBet: bigToNum(publicSeat?.streetCommitted),
      holeCards: isHuman
        ? humanHole
        : [
            { suit: 'spades', rank: 'A', hidden: true },
            { suit: 'spades', rank: 'A', hidden: true },
          ],
      status: publicSeat?.folded ? 'folded' : 'active',
      isSmallBlind: seatIndex === hand.smallBlindSeat,
      isBigBlind: seatIndex === hand.bigBlindSeat,
      isDealer: seatIndex === hand.buttonSeat,
      isActing: isHuman && humanIsActing,
    };
  });
}

function seatsForSettled(outcome: SerializedHoldemHand): SeatState[] {
  return outcome.seats.map((seat) => {
    const status: SeatStatus = seat.status === 'allin'
      ? 'allin'
      : seat.status === 'folded' ? 'folded' : 'active';
    const holeCards: [ViewCard, ViewCard] | null = seat.holeCards.length === 2
      ? [viewCard(seat.holeCards[0]!), viewCard(seat.holeCards[1]!)]
      : null;
    return {
      seatIndex: seat.seat,
      name: seat.isHuman ? 'You' : botLabel(seat.seat),
      stack: Number(seat.won),
      streetBet: 0,
      holeCards,
      status,
      isSmallBlind: seat.seat === outcome.smallBlindSeat,
      isBigBlind: seat.seat === outcome.bigBlindSeat,
      isDealer: seat.seat === outcome.buttonSeat,
      isActing: false,
    };
  });
}

function boardToRow(board: WireCard[]): (ViewCard | null)[] {
  const row: (ViewCard | null)[] = [null, null, null, null, null];
  for (let index = 0; index < board.length && index < 5; index += 1) {
    row[index] = viewCard(board[index]!);
  }
  return row;
}

function setControllerState(update: Partial<HoldemControllerState>): void {
  useHoldemController.setState(update);
}

function deriveControllerState(
  table: HoldemTableWire | null,
  live: LiveHoldemHand | null,
  settled: HoldemSettledResponse | null,
  inFlight: boolean,
  revealedSeed: string | null,
): Pick<HoldemControllerState,
  'phase' | 'walkAwayLocked' | 'seats' | 'communityCards' | 'playerHoleCards' |
  'pot' | 'publicPot' | 'toCall' | 'currentBet' | 'humanStack' | 'humanCommitted' | 'toCallNum' |
  'facingBet' | 'canDeal' | 'canFold' | 'canCheck' | 'canCall' | 'canBet' |
  'canRaise' | 'canAllIn'> {
  const phase: HoldemPhase = settled ? 'settled' : live ? 'player-turn' : 'idle';
  const outcome = settled?.outcome ?? null;
  const toCall = live?.toCall ?? '0';
  const currentBet = live?.currentBet ?? '0';
  const humanStack = live?.humanStack ?? table?.playerStack ?? '0';
  const humanCommitted = live?.humanCommitted ?? '0';
  const toCallNum = bigToNum(toCall);
  const facingBet = toCallNum > 0;
  const playerTurn = phase === 'player-turn';
  let publicPotBig = 0n;
  if (outcome) {
    for (const pot of outcome.pots) publicPotBig += BigInt(pot.amount);
  } else if (live) {
    for (const seat of Object.values(deriveHoldemPublicSeats(live.publicActionLog))) {
      publicPotBig += BigInt(seat.totalCommitted);
    }
  }
  return {
    phase,
    walkAwayLocked: inFlight || Boolean(revealedSeed),
    seats: outcome
      ? seatsForSettled(outcome)
      : live ? seatsForLiveHand(live, playerTurn && !inFlight) : [],
    communityCards: outcome
      ? boardToRow(outcome.board)
      : live ? boardToRow(live.board) : [null, null, null, null, null],
    playerHoleCards: live?.humanHole.map(viewCard)
      ?? outcome?.seats.find((seat) => seat.isHuman)?.holeCards.map(viewCard)
      ?? [],
    // Today's stack bounds make this display conversion safe; `publicPot`
    // remains the bigint-string source used by sizing presets.
    pot: Number(publicPotBig),
    publicPot: publicPotBig.toString(),
    toCall,
    currentBet,
    humanStack,
    humanCommitted,
    toCallNum,
    facingBet,
    canDeal: phase === 'idle',
    canFold: playerTurn,
    canCheck: playerTurn && !facingBet,
    canCall: playerTurn && facingBet,
    canBet: playerTurn && !facingBet,
    canRaise: playerTurn && facingBet,
    canAllIn: playerTurn && bigToNum(humanStack) > 0,
  };
}

function publishControllerState(update: Partial<HoldemControllerState>): void {
  const previous = useHoldemController.getState();
  const table = update.table === undefined ? previous.table : update.table;
  const live = update.live === undefined ? previous.live : update.live;
  const settled = update.settled === undefined ? previous.settled : update.settled;
  const inFlight = update.inFlight === undefined ? previous.inFlight : update.inFlight;
  const revealedSeed = update.revealedSeed === undefined ? previous.revealedSeed : update.revealedSeed;
  setControllerState({
    ...update,
    ...deriveControllerState(table, live, settled, inFlight, revealedSeed),
  });
}

/**
 * The sole runtime owner for Hold'em requests and idempotency state. Mount this
 * exactly once at the Cove page boundary. All visual consumers call
 * `useHoldemController`; consuming that hook never constructs refs, effects, or
 * mutation objects, so the modal, seated HUD, and 3D felt share one instance.
 */
export function HoldemControllerRuntime(): null {
  const { data: avatar } = useAvatar();
  const holdemModalOpen = useCoveStore((state) => state.holdemModalOpen);
  const holdemBuyIn = useCoveStore((state) => state.holdemBuyIn);
  const seatedTable = useCoveStore((state) => state.seatedTable);
  const closeHoldemModal = useCoveStore((state) => state.closeHoldemTable);
  const active = holdemModalOpen || seatedTable !== null;
  const isAuthed = Boolean(avatar);

  const openTable = useOpenHoldemTable();
  const dealHand = useDealHoldemHand();
  const action = useHoldemAction();
  const closeTable = useCloseHoldemTable();

  const busyRef = useRef(false);
  const dealKeyRef = useRef<string | null>(null);
  const closeKeyRef = useRef<string | null>(null);
  const pendingActionRef = useRef<{ act: string; amount?: number; key: string } | null>(null);
  const walkAwayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openEpochRef = useRef(0);
  const activeRef = useRef(active);
  const toastSeqRef = useRef(0);
  const tableRef = useRef<HoldemTableWire | null>(null);
  const resetMutationsRef = useRef<() => void>(() => {});

  activeRef.current = active;
  tableRef.current = useHoldemController.getState().table;
  resetMutationsRef.current = () => {
    openTable.reset();
    dealHand.reset();
    action.reset();
    closeTable.reset();
  };

  const showToast = useCallback((message: string, tone: HoldemToastTone = 'info') => {
    toastSeqRef.current += 1;
    setControllerState({ toast: { message, tone, id: toastSeqRef.current } });
  }, []);

  const resetHand = useCallback(() => {
    dealKeyRef.current = null;
    pendingActionRef.current = null;
    closeKeyRef.current = null;
    publishControllerState({ live: null, settled: null });
  }, []);

  const fullReset = useCallback(() => {
    openEpochRef.current += 1;
    tableRef.current = null;
    publishControllerState({
      table: null,
      live: null,
      settled: null,
      revealedSeed: null,
      toast: null,
      inFlight: false,
    });
    busyRef.current = false;
    dealKeyRef.current = null;
    pendingActionRef.current = null;
    closeKeyRef.current = null;
    resetMutationsRef.current();
    if (walkAwayTimerRef.current) {
      clearTimeout(walkAwayTimerRef.current);
      walkAwayTimerRef.current = null;
    }
  }, []);

  const applySettled = useCallback((response: HoldemSettledResponse) => {
    const table = useHoldemController.getState().table;
    publishControllerState({
      settled: response,
      live: null,
      balance: response.walletBalance,
      table: table ? { ...table, playerStack: response.playerStack } : table,
    });
  }, []);

  const applyDealInProgress = useCallback((response: HoldemDealInProgressResponse) => {
    publishControllerState({
      settled: null,
      live: liveHandFromResync(response),
    });
  }, []);

  const applyActionInProgress = useCallback((response: HoldemActionInProgressResponse) => {
    publishControllerState({ live: liveHandFromResync(response) });
  }, []);

  const toast = useHoldemController((state) => state.toast);
  const mutationInFlight = openTable.isPending || dealHand.isPending || action.isPending || closeTable.isPending;

  useEffect(() => useHoldemController.subscribe((state) => {
    tableRef.current = state.table;
  }), []);

  useEffect(() => {
    publishControllerState({ inFlight: mutationInFlight });
  }, [mutationInFlight]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      const current = useHoldemController.getState().toast;
      if (current?.id === toast.id) setControllerState({ toast: null });
    }, 4200);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!active) return;
    publishControllerState({ balance: avatar?.clawTokens ?? 0, revealedSeed: null });
    resetHand();
    let cancelled = false;
    void (async () => {
      try {
        const current = await fetchCurrentHoldemTable();
        if (cancelled || !current || current.table.status !== 'open') return;
        publishControllerState({
          table: current.table,
          balance: current.walletBalance,
          live: current.hand ? liveHandFromResync(current.hand) : null,
        });
        showToast(
          current.hand ? 'Resumed your table — a hand is in progress.' : 'Resumed your open table.',
          'info',
        );
      } catch {
        // A network blip is recovered by the lazy-open path on first Deal.
      }
    })();
    return () => { cancelled = true; };
    // Activation is intentionally transition-based. Avatar/buy-in changes do
    // not restart the authoritative session restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (active) return;
    fullReset();
  }, [active, fullReset]);

  useEffect(() => () => {
    activeRef.current = false;
    fullReset();
    setControllerState(EMPTY_ACTIONS);
  }, [fullReset]);

  const ensureTable = useCallback(async (): Promise<HoldemTableWire | null> => {
    const existing = tableRef.current;
    if (existing?.status === 'open') return existing;
    const myEpoch = openEpochRef.current;
    try {
      const buyIn = Math.max(
        COVE_HOLDEM_MIN_BUYIN,
        Math.min(COVE_HOLDEM_MAX_BUYIN, Math.floor(holdemBuyIn || COVE_HOLDEM_MIN_BUYIN)),
      );
      const opened = await openTable.mutateAsync({ currency: 'clawtoken', buyIn });
      if (openEpochRef.current !== myEpoch) return null;
      tableRef.current = opened.table;
      publishControllerState({ table: opened.table, balance: opened.walletBalance });
      return opened.table;
    } catch (error) {
      if (openEpochRef.current !== myEpoch) return null;
      showToast(
        describeHoldemError(error, 'open'),
        error instanceof CoveApiError && error.status >= 500 ? 'error' : 'warn',
      );
      return null;
    }
  }, [holdemBuyIn, openTable, showToast]);

  const tryResync = useCallback(async (myEpoch: number): Promise<boolean> => {
    try {
      const current = await fetchCurrentHoldemTable();
      if (openEpochRef.current !== myEpoch) return true;
      if (!current) return false;
      tableRef.current = current.table;
      publishControllerState({ table: current.table, balance: current.walletBalance });
      if (!current.hand) return false;
      publishControllerState({ live: liveHandFromResync(current.hand) });
      showToast('Reconnected — here’s the current hand.', 'info');
      return true;
    } catch {
      return openEpochRef.current !== myEpoch;
    }
  }, [showToast]);

  const handleDeal = useCallback(async () => {
    const state = useHoldemController.getState();
    if (busyRef.current || state.phase !== 'idle' || state.agentMode === 'autonomous') return;
    busyRef.current = true;
    const myEpoch = openEpochRef.current;
    try {
      const table = await ensureTable();
      if (openEpochRef.current !== myEpoch || !table) return;
      if (!dealKeyRef.current) dealKeyRef.current = crypto.randomUUID();
      const response: HoldemDealResponse = await dealHand.mutateAsync({
        tableId: table.id,
        idempotencyKey: dealKeyRef.current,
      });
      if (openEpochRef.current !== myEpoch) return;
      if (isHoldemSettled(response)) applySettled(response);
      else applyDealInProgress(response);
      dealKeyRef.current = null;
    } catch (error) {
      if (openEpochRef.current !== myEpoch) return;
      const ambiguous = error instanceof CoveApiError && (error.status === 0 || error.status === 408);
      if (ambiguous && await tryResync(myEpoch)) return;
      showToast(
        describeHoldemError(error, 'deal'),
        error instanceof CoveApiError && error.status >= 500 ? 'error' : 'warn',
      );
    } finally {
      if (openEpochRef.current === myEpoch) busyRef.current = false;
    }
  }, [applyDealInProgress, applySettled, dealHand, ensureTable, showToast, tryResync]);

  const runAction = useCallback(async (act: HoldemAction, amount?: number) => {
    const state = useHoldemController.getState();
    const live = state.live;
    if (busyRef.current || !live || state.agentMode === 'autonomous') return;
    busyRef.current = true;
    const myEpoch = openEpochRef.current;
    const pending = pendingActionRef.current;
    if (!pending || pending.act !== act || pending.amount !== amount) {
      pendingActionRef.current = { act, amount, key: crypto.randomUUID() };
    }
    const idempotencyKey = pendingActionRef.current!.key;
    try {
      const response = await action.mutateAsync({
        handId: live.handId,
        action: act,
        ...(amount !== undefined ? { amount } : {}),
        idempotencyKey,
      });
      if (openEpochRef.current !== myEpoch) return;
      if (isHoldemSettled(response)) applySettled(response);
      else applyActionInProgress(response);
      pendingActionRef.current = null;
    } catch (error) {
      if (openEpochRef.current !== myEpoch) return;
      const ambiguous = error instanceof CoveApiError && (error.status === 0 || error.status === 408);
      if (ambiguous && await tryResync(myEpoch)) return;
      showToast(
        describeHoldemError(error, 'action'),
        error instanceof CoveApiError && error.status >= 500 ? 'error' : 'warn',
      );
    } finally {
      if (openEpochRef.current === myEpoch) busyRef.current = false;
    }
  }, [action, applyActionInProgress, applySettled, showToast, tryResync]);

  const handleClose = useCallback(() => {
    const state = useHoldemController.getState();
    const table = tableRef.current;
    // Guests fire the close too (P4, 2026-07-16): the server now accepts an
    // owner-matched guest DEMO close (status flip + seed reveal, zero ledger
    // ops). Without it a guest's fingerprint-keyed table resumed forever —
    // bricked at stack 0 once the demo chips ran out.
    if (
      table?.status === 'open' && !state.live &&
      !busyRef.current && !state.revealedSeed
    ) {
      closeTable.mutate(
        { tableId: table.id, idempotencyKey: crypto.randomUUID() },
        {
          onSuccess: (response) => {
            if (!activeRef.current) return;
            const current = useHoldemController.getState().table;
            if (current?.id !== table.id) return;
            tableRef.current = {
              ...current,
              status: 'closed',
              serverSeed: response.serverSeed,
              playerStack: '0',
            };
            publishControllerState({
              table: tableRef.current,
              balance: response.walletBalance,
            });
          },
        },
      );
    }
    closeHoldemModal();
    if (useCoveStore.getState().seatedTable?.tableId === 'T1') {
      useCoveStore.getState().standFromTable();
    }
  }, [closeHoldemModal, closeTable]);

  const handleWalkAway = useCallback(async () => {
    if (busyRef.current) return;
    const state = useHoldemController.getState();
    const table = tableRef.current;
    if (!table || !isAuthed) {
      handleClose();
      return;
    }
    if (state.live) {
      showToast('Finish the current hand first.', 'warn');
      return;
    }
    busyRef.current = true;
    const myEpoch = openEpochRef.current;
    if (!closeKeyRef.current) closeKeyRef.current = crypto.randomUUID();
    const idempotencyKey = closeKeyRef.current;
    try {
      const response = await closeTable.mutateAsync({ tableId: table.id, idempotencyKey });
      if (openEpochRef.current !== myEpoch) return;
      closeKeyRef.current = null;
      tableRef.current = {
        ...table,
        status: 'closed',
        serverSeed: response.serverSeed,
        playerStack: '0',
      };
      publishControllerState({
        revealedSeed: response.serverSeed,
        balance: response.walletBalance,
        table: tableRef.current,
      });
      showToast(
        `Cashed out ${response.cashOut} vCLAW — seed ${response.serverSeed.slice(0, 10)}…${response.serverSeed.slice(-6)} revealed.`,
        'info',
      );
      if (walkAwayTimerRef.current) clearTimeout(walkAwayTimerRef.current);
      walkAwayTimerRef.current = setTimeout(() => {
        walkAwayTimerRef.current = null;
        handleClose();
        // Seated walk-away actually walks away: stand the avatar too, so the
        // cashed-out player isn't left on a locked settled HUD (P3.1 nit).
        useCoveStore.getState().standFromTable();
      }, 1500);
    } catch (error) {
      if (openEpochRef.current !== myEpoch) return;
      const ambiguousClose = error instanceof CoveApiError && (
        error.status === 0 || error.status === 408 || error.code?.startsWith('table_not_open') === true
      );
      if (ambiguousClose) {
        try {
          const current = await fetchCurrentHoldemTable();
          if (openEpochRef.current !== myEpoch) return;
          if (!current || current.table.id !== table.id || current.table.status !== 'open') {
            tableRef.current = { ...table, status: 'closed', playerStack: '0' };
            publishControllerState({
              table: tableRef.current,
              ...(current ? { balance: current.walletBalance } : {}),
            });
            showToast('Your cash-out went through — chips were credited.', 'info');
            return;
          }
        } catch {
          if (openEpochRef.current !== myEpoch) return;
        }
      }
      showToast(describeHoldemError(error, 'close'), 'warn');
    } finally {
      if (openEpochRef.current === myEpoch) busyRef.current = false;
    }
  }, [closeTable, handleClose, isAuthed, showToast]);

  useEffect(() => {
    setControllerState({ resetHand, handleDeal, runAction, handleClose, handleWalkAway });
  }, [handleClose, handleDeal, handleWalkAway, resetHand, runAction]);

  return null;
}
