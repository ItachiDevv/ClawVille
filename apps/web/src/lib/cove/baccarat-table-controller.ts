'use client';

/**
 * Shared-table baccarat room controller (spec
 * ~/.clawville-brain/plans/baccarat-shared-table-port-2026-10-22.md §3.5 + §7.2).
 *
 * The server owns the round: phase, countdown, cards, payouts and balances all
 * come from `GET /api/cove/baccarat/tables/:id`. This store only:
 *   - polls that state (1500 ms seated, 3000 ms spectator), plus one extra GET
 *     1200 ms after the local countdown reaches 0, and pauses on a hidden tab;
 *   - keeps a client clock offset (`serverNow - now()` at receipt) for the
 *     countdown;
 *   - steps the card reveal once per new `lastRound.roundSeq`;
 *   - sends sit / bet / cancel / leave, with one refetch + retry on
 *     409 `stale_round`.
 * No client money math: balance, stake on the felt, payout and net are server
 * values only.
 *
 * The poll loop and timers run through injected deps (`TableControllerDeps`)
 * so the unit tests drive them with a fake clock.
 */

import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type {
  BaccaratTableBetSide,
  BaccaratTablePublicState,
  BaccaratTableRoundResult,
  BaccaratTableSeatResult,
  SerializedBaccaratCoup,
} from '@clawville/shared';
import {
  buildDealSteps,
  type BaccaratDealStep,
  type BaccaratRoomPhase,
} from '@/lib/cove/baccarat-room-controller';
import {
  baccaratTableApi,
  CoveApiError,
  describeBaccaratTableError,
  errorBodyField,
  isTableErrorCode,
  type BaccaratTableApi,
} from '@/lib/cove/baccarat-table-api';
import type { BaccaratFeltView } from '@/lib/three/baccarat-table-room';

export const SEATED_POLL_MS = 1500;
export const SPECTATOR_POLL_MS = 3000;
/** Extra GET after the local countdown hits 0 (tick <= 1 s + settle). */
export const CLOSE_REFETCH_DELAY_MS = 1200;
/** Same cadence as the solo room (`baccarat-room-controller.ts` REVEAL_STEP_MS). */
export const SHARED_REVEAL_STEP_MS = 240;
/** Same final-card stage as the solo room (BACCARAT_FINAL_REVEAL_STAGE_MS). */
export const SHARED_FINAL_REVEAL_STAGE_MS = 120;

export type TableActionKind = 'sit' | 'bet' | 'cancel' | 'leave';

export interface TableControllerDeps {
  api: Pick<BaccaratTableApi, 'getTable' | 'sit' | 'leave' | 'placeBet' | 'cancelBet'>;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  isHidden(): boolean;
}

export interface TableToast {
  message: string;
  tone: 'info' | 'warn' | 'error';
  id: number;
}

export interface BaccaratTableControllerState {
  tableId: string | null;
  table: BaccaratTablePublicState | null;
  clockOffsetMs: number;
  pollNotice: string | null;
  notFound: boolean;
  selectedBet: BaccaratTableBetSide;
  selectedStake: number | null;
  inFlight: TableActionKind | null;
  toast: TableToast | null;
  /** Set by a 409 already_seated_elsewhere: the table that holds my seat. */
  elsewhereTableId: string | null;
  /** The round on the felt (display copy of `lastRound`), or null. */
  revealCoup: SerializedBaccaratCoup | null;
  revealCoupId: string | null;
  revealedRoundSeq: number | null;
  dealSteps: readonly BaccaratDealStep[];
  revealedStep: number;
  revealDone: boolean;
  setSelectedBet(bet: BaccaratTableBetSide): void;
  setSelectedStake(stake: number): void;
  clearToast(id: number): void;
  sit(): Promise<void>;
  bet(side?: BaccaratTableBetSide, stake?: number): Promise<void>;
  cancelBet(): Promise<void>;
  leave(): Promise<void>;
}

interface Runtime {
  tableId: string;
  deps: TableControllerDeps;
  pollTimer: unknown;
  closeTimer: unknown;
  revealTimer: unknown;
  closeFiredForRound: number | null;
  fetchSeq: number;
  appliedSeq: number;
  pausedHidden: boolean;
}

let runtime: Runtime | null = null;
let toastSequence = 0;

function nextToast(message: string, tone: TableToast['tone']): TableToast {
  toastSequence += 1;
  return { message, tone, id: toastSequence };
}

function initialData() {
  return {
    tableId: null as string | null,
    table: null as BaccaratTablePublicState | null,
    clockOffsetMs: 0,
    pollNotice: null as string | null,
    notFound: false,
    selectedBet: 'player' as BaccaratTableBetSide,
    selectedStake: null as number | null,
    inFlight: null as TableActionKind | null,
    toast: null as TableToast | null,
    elsewhereTableId: null as string | null,
    ...clearedReveal(),
    revealedRoundSeq: null as number | null,
  };
}

function clearedReveal() {
  return {
    revealCoup: null as SerializedBaccaratCoup | null,
    revealCoupId: null as string | null,
    dealSteps: [] as readonly BaccaratDealStep[],
    revealedStep: 0,
    revealDone: true,
  };
}

/** Milliseconds left in the betting window, from the server clock. 0 when closed. */
export function bettingMsLeft(
  table: Pick<BaccaratTablePublicState, 'phase' | 'bettingClosesAt'> | null,
  clockOffsetMs: number,
  nowMs: number,
): number {
  if (!table || table.phase !== 'betting' || table.bettingClosesAt == null) return 0;
  return Math.max(0, table.bettingClosesAt - (nowMs + clockOffsetMs));
}

/** Milliseconds until the next betting window opens (phase `reveal`), else 0. */
export function nextWindowMsLeft(
  table: Pick<BaccaratTablePublicState, 'phase' | 'nextBettingOpensAt'> | null,
  clockOffsetMs: number,
  nowMs: number,
): number {
  if (!table || table.phase !== 'reveal' || table.nextBettingOpensAt == null) return 0;
  return Math.max(0, table.nextBettingOpensAt - (nowMs + clockOffsetMs));
}

/** Seated viewers poll faster than spectators (§3.5). */
export function pollIntervalFor(table: BaccaratTablePublicState | null): number {
  return table?.me?.seated ? SEATED_POLL_MS : SPECTATOR_POLL_MS;
}

/**
 * Display-only coup for the 3D felt and the deal steps. Cards, totals, winner
 * and dealt count are the server's. bet / stake / payout / net are MY server
 * row when I played the round, else zeros. `commission` is not on the wire and
 * is never computed here, so it stays '0' and the HUD does not show it.
 */
export function feltCoupFromRound(
  round: BaccaratTableRoundResult,
  mine: BaccaratTableSeatResult | null,
): SerializedBaccaratCoup {
  const dealtThisCoup = round.player.cards.length + round.banker.cards.length;
  return {
    kind: 'baccarat',
    bet: mine?.bet ?? 'player',
    stake: String(mine?.stake ?? 0),
    player: round.player,
    banker: round.banker,
    winner: round.winner,
    payout: String(mine?.payout ?? 0),
    net: String(mine?.net ?? 0),
    commission: '0',
    cursorBefore: 0,
    cursorAfter: 0,
    dealtBefore: Math.max(0, round.dealtAfter - dealtThisCoup),
    dealtAfter: round.dealtAfter,
    nonce: round.coupIndex,
    engineVersion: '',
  };
}

function winnerLabel(winner: BaccaratTableRoundResult['winner']): string {
  return winner === 'player' ? 'PLAYER WINS' : winner === 'banker' ? 'BANKER WINS' : 'TIE';
}

function isCurrent(rt: Runtime): boolean {
  return runtime === rt;
}

function clearTimer(rt: Runtime, key: 'pollTimer' | 'closeTimer' | 'revealTimer'): void {
  if (rt[key] != null) {
    rt.deps.clearTimeout(rt[key]);
    rt[key] = null;
  }
}

function scheduleRevealStep(rt: Runtime, roundSeq: number): void {
  clearTimer(rt, 'revealTimer');
  rt.revealTimer = rt.deps.setTimeout(() => {
    rt.revealTimer = null;
    if (!isCurrent(rt)) return;
    const state = useBaccaratTableController.getState();
    if (state.revealedRoundSeq !== roundSeq || state.revealDone || !state.revealCoup) return;
    const next = Math.min(state.revealedStep + 1, state.dealSteps.length);
    useBaccaratTableController.setState({ revealedStep: next });
    if (next < state.dealSteps.length) {
      scheduleRevealStep(rt, roundSeq);
      return;
    }
    // Publish the final card as its own revision before the settled frame
    // (same reason as the solo room: R3F must see the last card first).
    rt.revealTimer = rt.deps.setTimeout(() => {
      rt.revealTimer = null;
      if (!isCurrent(rt)) return;
      const current = useBaccaratTableController.getState();
      if (current.revealedRoundSeq !== roundSeq) return;
      useBaccaratTableController.setState({ revealDone: true });
    }, SHARED_FINAL_REVEAL_STAGE_MS);
  }, SHARED_REVEAL_STEP_MS);
}

function applyReveal(rt: Runtime, table: BaccaratTablePublicState): void {
  const state = useBaccaratTableController.getState();
  const round = table.lastRound;
  if (round && round.roundSeq !== state.revealedRoundSeq) {
    if (table.phase === 'reveal') {
      const coup = feltCoupFromRound(round, table.me?.lastResult ?? null);
      useBaccaratTableController.setState({
        revealCoup: coup,
        revealCoupId: round.coupId,
        revealedRoundSeq: round.roundSeq,
        dealSteps: buildDealSteps(coup),
        revealedStep: 0,
        revealDone: false,
      });
      scheduleRevealStep(rt, round.roundSeq);
      return;
    }
    // A result that is already past its reveal window (first load during
    // betting): remember it so it never animates, keep the felt clear.
    clearTimer(rt, 'revealTimer');
    useBaccaratTableController.setState({
      ...clearedReveal(),
      revealedRoundSeq: round.roundSeq,
    });
    return;
  }
  // The reveal window ended and the animation finished: clear the felt for
  // the next betting window.
  if (table.phase !== 'reveal' && state.revealCoup && state.revealDone) {
    useBaccaratTableController.setState(clearedReveal());
  }
}

function armCloseRefetch(rt: Runtime, table: BaccaratTablePublicState, offset: number): void {
  clearTimer(rt, 'closeTimer');
  if (table.phase !== 'betting' || table.bettingClosesAt == null) return;
  if (rt.closeFiredForRound === table.roundSeq) return;
  const roundSeq = table.roundSeq;
  const delay = bettingMsLeft(table, offset, rt.deps.now()) + CLOSE_REFETCH_DELAY_MS;
  rt.closeTimer = rt.deps.setTimeout(() => {
    rt.closeTimer = null;
    if (!isCurrent(rt) || rt.pausedHidden) return;
    rt.closeFiredForRound = roundSeq;
    void pollNow(rt);
  }, delay);
}

function applyTable(rt: Runtime, table: BaccaratTablePublicState): void {
  const offset = table.serverNow - rt.deps.now();
  const state = useBaccaratTableController.getState();
  const stakeInBounds = state.selectedStake != null
    && state.selectedStake >= table.minBet
    && state.selectedStake <= table.maxBet;
  useBaccaratTableController.setState({
    table,
    clockOffsetMs: offset,
    pollNotice: null,
    notFound: false,
    selectedStake: stakeInBounds ? state.selectedStake : table.minBet,
  });
  applyReveal(rt, table);
  armCloseRefetch(rt, table, offset);
}

function schedulePoll(rt: Runtime): void {
  clearTimer(rt, 'pollTimer');
  if (!isCurrent(rt) || rt.pausedHidden) return;
  const delay = pollIntervalFor(useBaccaratTableController.getState().table);
  rt.pollTimer = rt.deps.setTimeout(() => {
    rt.pollTimer = null;
    void pollNow(rt);
  }, delay);
}

async function pollNow(rt: Runtime): Promise<void> {
  if (!isCurrent(rt)) return;
  clearTimer(rt, 'pollTimer');
  if (rt.deps.isHidden()) {
    rt.pausedHidden = true;
    clearTimer(rt, 'closeTimer');
    return;
  }
  rt.fetchSeq += 1;
  const seq = rt.fetchSeq;
  let stopPolling = false;
  try {
    const response = await rt.deps.api.getTable(rt.tableId);
    if (!isCurrent(rt)) return;
    if (seq > rt.appliedSeq) {
      rt.appliedSeq = seq;
      applyTable(rt, response.table);
    }
  } catch (error) {
    if (!isCurrent(rt)) return;
    if (isTableErrorCode(error, 404, 'table_not_found') || isTableErrorCode(error, 400, 'invalid_table_id')) {
      stopPolling = true;
      useBaccaratTableController.setState({
        notFound: true,
        pollNotice: describeBaccaratTableError(error),
      });
    } else {
      useBaccaratTableController.setState({
        pollNotice: `${describeBaccaratTableError(error)} Retrying.`,
      });
    }
  } finally {
    // Only the newest fetch owns the next poll, so an extra GET never doubles
    // the loop.
    if (isCurrent(rt) && seq === rt.fetchSeq && !stopPolling) schedulePoll(rt);
  }
}

function browserDeps(): TableControllerDeps {
  return {
    api: baccaratTableApi,
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  };
}

/** Start (or restart) the poll loop for one table. Resets the store. */
export function startBaccaratTablePolling(
  tableId: string,
  deps: TableControllerDeps = browserDeps(),
): void {
  stopBaccaratTablePolling();
  const rt: Runtime = {
    tableId,
    deps,
    pollTimer: null,
    closeTimer: null,
    revealTimer: null,
    closeFiredForRound: null,
    fetchSeq: 0,
    appliedSeq: 0,
    pausedHidden: false,
  };
  runtime = rt;
  useBaccaratTableController.setState({ ...initialData(), tableId });
  void pollNow(rt);
}

/** Stop every timer. In-flight responses are dropped. */
export function stopBaccaratTablePolling(): void {
  const rt = runtime;
  if (!rt) return;
  clearTimer(rt, 'pollTimer');
  clearTimer(rt, 'closeTimer');
  clearTimer(rt, 'revealTimer');
  runtime = null;
}

/** Call on `visibilitychange`: hidden pauses the loop, visible fetches now. */
export function handleBaccaratTableVisibility(): void {
  const rt = runtime;
  if (!rt) return;
  if (rt.deps.isHidden()) {
    rt.pausedHidden = true;
    clearTimer(rt, 'pollTimer');
    clearTimer(rt, 'closeTimer');
    return;
  }
  if (!rt.pausedHidden) return;
  rt.pausedHidden = false;
  void pollNow(rt);
}

/** One GET now; resolves after the state is applied. */
export function refreshBaccaratTable(): Promise<void> {
  const rt = runtime;
  if (!rt) return Promise.resolve();
  rt.pausedHidden = false;
  return pollNow(rt);
}

function actionGuard(kind: TableActionKind): Runtime | null {
  const rt = runtime;
  const state = useBaccaratTableController.getState();
  if (!rt || !state.table || state.inFlight) return null;
  useBaccaratTableController.setState({ inFlight: kind });
  return rt;
}

function finishAction(rt: Runtime, patch: Partial<BaccaratTableControllerState> = {}): void {
  if (!isCurrent(rt)) return;
  useBaccaratTableController.setState({ inFlight: null, ...patch });
}

function failAction(rt: Runtime, error: unknown): void {
  if (!isCurrent(rt)) return;
  const elsewhere = isTableErrorCode(error, 409, 'already_seated_elsewhere')
    ? errorBodyField(error, 'tableId')
    : undefined;
  useBaccaratTableController.setState({
    inFlight: null,
    toast: nextToast(
      describeBaccaratTableError(error),
      error instanceof CoveApiError && error.status >= 500 ? 'error' : 'warn',
    ),
    ...(typeof elsewhere === 'string' ? { elsewhereTableId: elsewhere } : {}),
  });
}

function sideLabel(side: BaccaratTableBetSide): string {
  return side === 'player' ? 'PLAYER' : side === 'banker' ? 'BANKER' : 'TIE';
}

export const useBaccaratTableController = create<BaccaratTableControllerState>((set, get) => ({
  ...initialData(),

  setSelectedBet: (bet) => set({ selectedBet: bet }),

  setSelectedStake: (stake) => {
    const table = get().table;
    if (table && (stake < table.minBet || stake > table.maxBet)) return;
    set({ selectedStake: stake });
  },

  clearToast: (id) => {
    if (get().toast?.id === id) set({ toast: null });
  },

  sit: async () => {
    const rt = actionGuard('sit');
    if (!rt) return;
    try {
      const result = await rt.deps.api.sit(rt.tableId);
      if (!isCurrent(rt)) return;
      await pollNow(rt);
      finishAction(rt, {
        elsewhereTableId: null,
        toast: nextToast(
          result.alreadySeated ? 'You already sit at this table.' : `You sit in seat ${result.seatIndex + 1}.`,
          'info',
        ),
      });
    } catch (error) {
      failAction(rt, error);
    }
  },

  bet: async (sideArg, stakeArg) => {
    const initial = get();
    const table = initial.table;
    const side = sideArg ?? initial.selectedBet;
    const stake = stakeArg ?? initial.selectedStake;
    if (!table?.me?.seated || stake == null) return;
    if (!runtime || bettingMsLeft(table, initial.clockOffsetMs, runtime.deps.now()) <= 0) return;
    const rt = actionGuard('bet');
    if (!rt) return;
    const send = (roundSeq: number) => rt.deps.api.placeBet(rt.tableId, { roundSeq, bet: side, stake });
    try {
      let result;
      try {
        result = await send(table.roundSeq);
      } catch (error) {
        if (!isTableErrorCode(error, 409, 'stale_round')) throw error;
        // The round moved between my poll and my bet: read the table once and
        // retry once with the new round. A second failure goes to the toast.
        await pollNow(rt);
        if (!isCurrent(rt)) return;
        const fresh = get().table;
        if (!fresh?.me?.seated || fresh.phase !== 'betting') throw error;
        result = await send(fresh.roundSeq);
      }
      if (!isCurrent(rt)) return;
      const current = get().table;
      // Server echo only: show my placed bet before the next poll lands.
      if (current?.me && current.roundSeq === result.roundSeq) {
        // A GET that started before the bet still holds the old state. Mark
        // every fetch started so far as applied, so that GET cannot overwrite
        // the echo; only the GET sent after the bet (below) applies.
        rt.appliedSeq = rt.fetchSeq;
        set({
          table: {
            ...current,
            me: {
              ...current.me,
              currentBet: { roundSeq: result.roundSeq, bet: result.bet, stake: result.stake },
            },
          },
        });
      }
      finishAction(rt, {
        selectedBet: result.bet,
        toast: nextToast(`Bet placed: ${result.stake} vCLAW on ${sideLabel(result.bet)}.`, 'info'),
      });
      void pollNow(rt);
    } catch (error) {
      failAction(rt, error);
    }
  },

  cancelBet: async () => {
    const rt = actionGuard('cancel');
    if (!rt) return;
    try {
      const result = await rt.deps.api.cancelBet(rt.tableId);
      if (!isCurrent(rt)) return;
      await pollNow(rt);
      finishAction(rt, {
        toast: nextToast(result.cancelled ? 'Bet cancelled. No vCLAW moved.' : 'No open bet to cancel.', 'info'),
      });
    } catch (error) {
      failAction(rt, error);
    }
  },

  leave: async () => {
    const rt = actionGuard('leave');
    if (!rt) return;
    try {
      const result = await rt.deps.api.leave(rt.tableId);
      if (!isCurrent(rt)) return;
      await pollNow(rt);
      finishAction(rt, {
        toast: nextToast(
          result.lockedBet
            ? `You left your seat. Your locked bet of ${result.lockedBet.stake} vCLAW on ${sideLabel(result.lockedBet.bet)} still plays this round.`
            : 'You left your seat. No bet was open.',
          'info',
        ),
      });
    } catch (error) {
      failAction(rt, error);
    }
  },
}));

/** Build the 3D felt view from the controller state (§7.4 BaccaratFeltView). */
export function sharedFeltView(
  state: Pick<
    BaccaratTableControllerState,
    | 'table'
    | 'selectedBet'
    | 'selectedStake'
    | 'revealCoup'
    | 'revealCoupId'
    | 'dealSteps'
    | 'revealedStep'
    | 'revealDone'
  >,
): BaccaratFeltView {
  const table = state.table;
  const myBet = table?.me?.currentBet ?? null;
  const seated = Boolean(table?.me?.seated);
  let phase: BaccaratRoomPhase = 'idle';
  if (state.revealCoup) phase = state.revealDone ? 'settled' : 'revealing';
  else if (table?.phase === 'dealing') phase = 'requesting';
  const bet = myBet?.bet ?? state.selectedBet;
  return {
    coup: state.revealCoup,
    revealedStep: state.revealCoup ? state.revealedStep : 0,
    dealSteps: state.revealCoup ? state.dealSteps : [],
    phase,
    betType: bet,
    stake: myBet?.stake ?? state.selectedStake ?? 0,
    correlation: state.revealCoupId ? { hand: state.revealCoupId } : null,
    shoeId: table?.shoe?.id ?? null,
    bannerText: state.revealCoup && state.revealDone ? winnerLabel(state.revealCoup.winner) : null,
    betzoneSelected: seated ? bet : null,
  };
}

/** Memoized felt view for the canvas (a new object only when an input changes). */
export function useBaccaratTableFeltView(): BaccaratFeltView {
  const table = useBaccaratTableController((s) => s.table);
  const selectedBet = useBaccaratTableController((s) => s.selectedBet);
  const selectedStake = useBaccaratTableController((s) => s.selectedStake);
  const revealCoup = useBaccaratTableController((s) => s.revealCoup);
  const revealCoupId = useBaccaratTableController((s) => s.revealCoupId);
  const dealSteps = useBaccaratTableController((s) => s.dealSteps);
  const revealedStep = useBaccaratTableController((s) => s.revealedStep);
  const revealDone = useBaccaratTableController((s) => s.revealDone);
  const tablePhase = table?.phase ?? null;
  // `table` itself changes on every poll; the memo keys on the fields the
  // felt reads, and recomputes from the current `table` when one changes.
  const shoeId = table?.shoe?.id ?? null;
  const seated = Boolean(table?.me?.seated);
  const myBetSide = table?.me?.currentBet?.bet ?? null;
  const myBetStake = table?.me?.currentBet?.stake ?? null;
  return useMemo(
    () => sharedFeltView({
      table,
      selectedBet,
      selectedStake,
      revealCoup,
      revealCoupId,
      dealSteps,
      revealedStep,
      revealDone,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tablePhase, shoeId, seated, myBetSide, myBetStake, selectedBet, selectedStake, revealCoup, revealCoupId, dealSteps, revealedStep, revealDone],
  );
}

/** Mount once per shared room: runs the poll loop and the visibility pause. */
export function BaccaratTableControllerRuntime({ tableId }: { tableId: string }) {
  useEffect(() => {
    startBaccaratTablePolling(tableId);
    const onVisibility = () => handleBaccaratTableVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stopBaccaratTablePolling();
      useBaccaratTableController.setState(initialData());
    };
  }, [tableId]);
  return null;
}
