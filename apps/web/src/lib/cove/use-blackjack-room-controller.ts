'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAvatar } from '@/hooks/use-avatar';
import { useIsGuest } from '@/hooks/use-is-guest';
import { useGameStore } from '@/stores/game';
import type {
  BlackjackCard,
  BlackjackOutcome,
  SerializedBlackjackHandResult,
} from '@/lib/cove/blackjack-types';
import {
  AgentDriverUnavailableError,
  AgentUndecidedError,
  CoveApiError,
  describeBlackjackError,
  fetchAgentBlackjackDecision,
  fetchCurrentBlackjackHand,
  fetchCurrentBlackjackShoe,
  isActionInProgress,
  isCurrentHandLive,
  isSettled,
  reshuffledBody,
  useBlackjackAction,
  useCloseBlackjackShoe,
  useDealHand,
  useOpenBlackjackShoe,
  type ActionResponse,
  type AgentDecisionAction,
  type AgentDecisionResponse,
  type BlackjackShoeWire,
  type CurrentHandLive,
  type CurrentHandResponse,
  type DealResponse,
  type SettledHandResponse,
} from '@/lib/cove/blackjack-api-client';
import type { CardParityPayload } from '@/lib/cove/card-parity-mirror';

const BET_STEPS = [5, 25, 50, 100, 250, 500] as const;
const AGENT_WAIT_MS = 8_000;
const AGENT_KEYBOARD_WAIT_MS = 15_000;
const KEYBOARD_ACTIVE_MS = 5_000;
const NEXT_HAND_PAUSE_MS = 2_200;
const SETTLE_REVEAL_MS = 280;
const ACTION_SETTLED_STAGE_MS = 120;
const HOLE_REVEAL_MS = 120;
const MOVEMENT_KEYS = new Set([
  'w', 'a', 's', 'd', 'W', 'A', 'S', 'D',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

export type BlackjackPhase = 'idle' | 'player-turn' | 'settled';
export type BlackjackDealStep =
  | 'idle'
  | 'hole'
  | 'player-turn'
  | 'split'
  | 'dealer-reveal'
  | 'settled';
export type CardParityTransition = CardParityPayload['transition'];

export interface SubHandView {
  cards: BlackjackCard[];
  total: number;
  isSoft: boolean;
  isBust: boolean;
  isResolved: boolean;
  outcome?: BlackjackOutcome;
  payout?: string;
  bet?: string;
  isBlackjack?: boolean;
  isDoubled?: boolean;
}

export interface RoomSettledView {
  outcome: SerializedBlackjackHandResult;
  net: string;
  balance: number;
  handId: string;
}

export interface BlackjackRoomState {
  phase: BlackjackPhase;
  dealerCards: BlackjackCard[];
  dealerTotalLabel?: string;
  playerHands: SubHandView[];
  activeSlot: 0 | 1;
  didSplit: boolean;
  insuranceOffered: boolean;
  tookInsurance: boolean;
  dealStep: BlackjackDealStep;
  transition: CardParityTransition;
  publishSeq: number;
  bannerVisible: boolean;
  handId: string | null;
  handIndex: number | null;
  bannerText: string | null;
  balance: number;
  isRealTier: boolean;
  bet: number;
  shoe: BlackjackShoeWire | null;
  revealedSeed: string | null;
  settled: RoomSettledView | null;
  toast: { message: string; tone: 'info' | 'warn' | 'error'; id: number } | null;
  inFlight: boolean;
  canDouble: boolean;
  canSplit: boolean;
  canSurrender: boolean;
  activeResolved: boolean;
  agentMode: 'control' | 'autonomous';
  agentConnected: boolean;
  agentDriverUnavailable: boolean;
  agentPendingAction: AgentDecisionAction | null;
  advisorMessages: { id: number; text: string }[];
  fairnessSummary: string;
}

export interface BlackjackRoomHandlers {
  setBet(bet: number): void;
  handleDeal(): Promise<void>;
  runAction(act: 'hit' | 'stand' | 'double' | 'split' | 'surrender'): Promise<void>;
  handleNextHand(): void;
  handleWalkAway(): Promise<void>;
  setActiveSlot(slot: 0 | 1): void;
  setAgentMode(m: 'control' | 'autonomous'): void;
  requestClose(): void;
  reportCardOverflow(): void;
}

interface HandView {
  handId: string;
  shoeId: string;
  handIndex: number;
  playerHands: SubHandView[];
  dealerUpcard: BlackjackCard | null;
  insuranceOffered: boolean;
  tookInsurance: boolean;
  didSplit: boolean;
  bet: number;
}

interface AgentPending extends AgentDecisionResponse {
  deadline: number;
}

export function displayTotal(cards: BlackjackCard[]): { total: number; isSoft: boolean } {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.hidden) continue;
    if (card.rank === 'A') {
      aces += 1;
      total += 1;
    } else if (['10', 'J', 'Q', 'K'].includes(card.rank)) {
      total += 10;
    } else {
      total += Number(card.rank);
    }
  }
  const isSoft = aces > 0 && total + 10 <= 21;
  return { total: total + (isSoft ? 10 : 0), isSoft };
}

export function deriveDealerRenderView(
  dealerUpcard: BlackjackCard | null | undefined,
  settledOutcome: Pick<SerializedBlackjackHandResult, 'dealer'> | null,
  dealStep: BlackjackDealStep,
): Pick<BlackjackRoomState, 'dealerCards' | 'dealerTotalLabel'> {
  const dealerRevealed = dealStep === 'dealer-reveal' || dealStep === 'settled';
  if (settledOutcome && dealerRevealed) {
    return {
      dealerCards: settledOutcome.dealer.cards,
      dealerTotalLabel:
        `${settledOutcome.dealer.total}${settledOutcome.dealer.isBust ? ' BUST' : ''}`,
    };
  }
  const upcard = dealerUpcard ?? settledOutcome?.dealer.cards[0] ?? null;
  return upcard
    ? {
        dealerCards: [upcard, { suit: 'spades', rank: 'A', hidden: true }],
        dealerTotalLabel: `${displayTotal([upcard]).total}+?`,
      }
    : { dealerCards: [], dealerTotalLabel: undefined };
}

export function cardValuePair(cards: BlackjackCard[]): boolean {
  if (cards.length !== 2) return false;
  const value = (rank: string) => (
    ['10', 'J', 'Q', 'K'].includes(rank) ? 10 : rank === 'A' ? 11 : Number(rank)
  );
  return value(cards[0]!.rank) === value(cards[1]!.rank);
}

export function firstUnresolvedSlot(hands: readonly Pick<SubHandView, 'isResolved'>[]): 0 | 1 {
  return hands.findIndex((hand) => !hand.isResolved) === 1 ? 1 : 0;
}

export function expireInsuranceOffer(
  current: { offered: boolean; took: boolean },
): { offered: boolean; took: boolean } {
  return { ...current, offered: false };
}

export function buildBannerLabel(outcome: SerializedBlackjackHandResult): string {
  if (outcome.playerHands.length > 1) {
    return outcome.playerHands
      .map((hand, index) => `Hand ${index + 1}: ${outcomeLabel(hand.outcome)}`)
      .join(' · ');
  }
  return outcomeLabel(outcome.playerHands[0]?.outcome ?? 'loss');
}

function outcomeLabel(outcome: BlackjackOutcome): string {
  switch (outcome) {
    case 'blackjack': return 'BLACKJACK!';
    case 'win': return 'YOU WIN';
    case 'push': return 'PUSH';
    case 'surrender': return 'SURRENDER';
    case 'loss': return 'YOU LOSE';
  }
}

export function isAmbiguousMutationError(error: unknown): boolean {
  return !(error instanceof CoveApiError) || error.status >= 500;
}

export function insureLatchKey(handId: string, handVersion: number): string {
  return `${handId}:${handVersion}`;
}

export function restoreDisposition(
  response: CurrentHandResponse | null,
  options: { allowClear: boolean; settledHandIds: ReadonlySet<string> },
): 'ignore' | 'clear' | 'restore-live' {
  if (!response) return 'ignore';
  if (!isCurrentHandLive(response)) return options.allowClear ? 'clear' : 'ignore';
  return options.settledHandIds.has(response.handId) ? 'ignore' : 'restore-live';
}

export type DealErrorPolicy =
  | 'stale-agent-reconcile'
  | 'hand-in-progress-reconcile'
  | 'ambiguous-reconcile'
  | 'guest-uncertain'
  | 'toast';

export function dealErrorPolicy(
  error: unknown,
  options: { agentDriven: boolean; isRealTier: boolean },
): DealErrorPolicy {
  if (
    options.agentDriven && error instanceof CoveApiError &&
    error.status === 409 && error.code === 'stale_agent_deal'
  ) return 'stale-agent-reconcile';
  if (
    error instanceof CoveApiError && error.status === 409 &&
    error.code?.startsWith('hand_in_progress')
  ) return options.isRealTier ? 'hand-in-progress-reconcile' : 'guest-uncertain';
  if (isAmbiguousMutationError(error)) {
    return options.isRealTier ? 'ambiguous-reconcile' : 'guest-uncertain';
  }
  return 'toast';
}

export type ActionErrorPolicy =
  | 'stale-agent-reconcile'
  | 'terminal-slot-reconcile'
  | 'ambiguous-reconcile'
  | 'guest-uncertain'
  | 'toast';

export function actionErrorPolicy(
  error: unknown,
  options: { agentDriven: boolean; isRealTier: boolean },
): ActionErrorPolicy {
  if (
    options.agentDriven && error instanceof CoveApiError &&
    error.status === 409 && error.code === 'stale_agent_decision'
  ) return 'stale-agent-reconcile';
  if (
    error instanceof CoveApiError && error.status === 400 &&
    error.code === 'sub_hand_already_terminal'
  ) return options.isRealTier ? 'terminal-slot-reconcile' : 'guest-uncertain';
  if (isAmbiguousMutationError(error)) {
    return options.isRealTier ? 'ambiguous-reconcile' : 'guest-uncertain';
  }
  return 'toast';
}

export function prepareReshuffleRetry(mintKey: () => string): {
  idempotencyKey: string;
  expectedHandsPlayed: undefined;
} {
  return { idempotencyKey: mintKey(), expectedHandsPlayed: undefined };
}

export function canApplyPendingAgentDecision(input: {
  expectedRun: number;
  currentRun: number;
  humanBusy: boolean;
  agentBusy: boolean;
}): boolean {
  return input.expectedRun === input.currentRun && !input.humanBusy && !input.agentBusy;
}

export function keyAfterActionError(
  currentKey: string,
  policy: ActionErrorPolicy,
  terminal: boolean,
): string | null {
  if (policy === 'stale-agent-reconcile' || policy === 'terminal-slot-reconcile') return null;
  if (
    policy === 'ambiguous-reconcile' || policy === 'guest-uncertain'
  ) return terminal ? currentKey : null;
  return null;
}

type TimerHandle = ReturnType<typeof setTimeout>;
type ScheduleTimer = (callback: () => void, delayMs: number) => TimerHandle;
type ClearTimer = (handle: TimerHandle) => void;

/**
 * Mutable concurrency kernel shared by the production hook and its mocked-wire
 * characterization suite. It deliberately owns no React state and no money
 * decisions; it owns only locks, epochs, idempotency keys, recovery guards,
 * insurance suppression, and cancellable timers.
 */
export class BlackjackControllerRuntime {
  readonly busyRef = { current: false };
  readonly agentBusyRef = { current: false };
  readonly agentRunRef = { current: 0 };
  readonly settledHandIdsRef = { current: new Set<string>() };
  readonly healedHandIdRef = { current: null as string | null };
  readonly dealKeyRef = { current: null as string | null };
  readonly actionKeyRef = { current: null as string | null };
  readonly lastKeyMoveRef = { current: 0 };
  readonly insureLatchRef = { current: new Set<string>() };
  readonly closeTimerRef = { current: null as TimerHandle | null };

  private agentTimer: TimerHandle | null = null;

  constructor(
    private readonly scheduleTimer: ScheduleTimer = (callback, delayMs) =>
      setTimeout(callback, delayMs),
    private readonly clearScheduledTimer: ClearTimer = (handle) => clearTimeout(handle),
  ) {}

  bumpDecisionContext(): number {
    this.cancelAgentApply();
    this.agentRunRef.current += 1;
    return this.agentRunRef.current;
  }

  markSettled(handId: string): void {
    this.settledHandIdsRef.current.add(handId);
  }

  restoredHandDisposition(
    response: CurrentHandResponse | null,
    allowClear: boolean,
  ): 'ignore' | 'clear' | 'restore-live' {
    return restoreDisposition(response, {
      allowClear,
      settledHandIds: this.settledHandIdsRef.current,
    });
  }

  claimTerminalSelfHeal(
    handId: string,
    hands: readonly Pick<SubHandView, 'isResolved'>[],
  ): boolean {
    if (hands.length === 0 || !hands.every((hand) => hand.isResolved)) return false;
    if (this.healedHandIdRef.current === handId) return false;
    this.healedHandIdRef.current = handId;
    return true;
  }

  ensureDealKey(mintKey: () => string): string {
    if (!this.dealKeyRef.current) this.dealKeyRef.current = mintKey();
    return this.dealKeyRef.current;
  }

  prepareFreshShoeRetry(mintKey: () => string): {
    idempotencyKey: string;
    expectedHandsPlayed: undefined;
  } {
    const retry = prepareReshuffleRetry(mintKey);
    this.dealKeyRef.current = retry.idempotencyKey;
    return retry;
  }

  ensureActionKey(mintKey: () => string): string {
    if (!this.actionKeyRef.current) this.actionKeyRef.current = mintKey();
    return this.actionKeyRef.current;
  }

  retainActionKeyAfterError(
    currentKey: string,
    policy: ActionErrorPolicy,
    terminal: boolean,
  ): string | null {
    const next = keyAfterActionError(currentKey, policy, terminal);
    this.actionKeyRef.current = next;
    return next;
  }

  relayTarget(
    decision: Pick<AgentDecisionResponse, 'handId' | 'handSlot' | 'handVersion'>,
  ): {
    handId: string | null;
    slot: 0 | 1;
    version: number | null;
  } {
    return {
    handId: decision.handId ?? null,
    slot: decision.handSlot ?? 0,
    version: decision.handVersion ?? null,
    };
  }

  latchInsurance(handId: string, handVersion: number): boolean {
    const key = insureLatchKey(handId, handVersion);
    if (this.insureLatchRef.current.has(key)) return false;
    this.insureLatchRef.current.add(key);
    return true;
  }

  suppressInsuranceQuery(handId: string): boolean {
    return [...this.insureLatchRef.current]
      .some((key) => key.startsWith(`${handId}:`));
  }

  clearInsuranceForHand(handId: string): void {
    for (const key of this.insureLatchRef.current) {
      if (key.startsWith(`${handId}:`)) this.insureLatchRef.current.delete(key);
    }
  }

  scheduleAgentApply(
    delayMs: number,
    apply: () => void | Promise<void>,
  ): () => void {
    this.cancelAgentApply();
    const expectedRun = this.agentRunRef.current;
    this.agentTimer = this.scheduleTimer(() => {
      this.agentTimer = null;
      if (!canApplyPendingAgentDecision({
        expectedRun,
        currentRun: this.agentRunRef.current,
        humanBusy: this.busyRef.current,
        agentBusy: this.agentBusyRef.current,
      })) return;
      this.agentBusyRef.current = true;
      void Promise.resolve(apply()).finally(() => {
        this.agentBusyRef.current = false;
      });
    }, Math.max(0, delayMs));
    return () => this.cancelAgentApply();
  }

  cancelAgentApply(): void {
    if (this.agentTimer !== null) this.clearScheduledTimer(this.agentTimer);
    this.agentTimer = null;
  }

  scheduleClose(delayMs: number, close: () => void): void {
    if (this.closeTimerRef.current !== null) {
      this.clearScheduledTimer(this.closeTimerRef.current);
    }
    this.closeTimerRef.current = this.scheduleTimer(() => {
      this.closeTimerRef.current = null;
      close();
    }, delayMs);
  }

  dispose(): void {
    this.cancelAgentApply();
    if (this.closeTimerRef.current !== null) {
      this.clearScheduledTimer(this.closeTimerRef.current);
      this.closeTimerRef.current = null;
    }
    this.bumpDecisionContext();
  }
}

export function useBlackjackRoomController(): BlackjackRoomState & {
  handlers: BlackjackRoomHandlers;
} {
  const router = useRouter();
  const { data: avatar } = useAvatar();
  const isGuest = useIsGuest();
  const isRealTier = Boolean(avatar) && !isGuest;
  const agentConnected = useGameStore((state) => state.agentConnected);
  const openShoe = useOpenBlackjackShoe();
  const dealHand = useDealHand();
  const action = useBlackjackAction();
  const closeShoe = useCloseBlackjackShoe();

  const [phase, setPhase] = useState<BlackjackPhase>('idle');
  const [dealStep, setDealStep] = useState<BlackjackDealStep>('idle');
  const [transition, setTransition] = useState<CardParityTransition>('idle');
  const [publishSeq, setPublishSeq] = useState(0);
  const [bannerVisible, setBannerVisible] = useState(false);
  const [shoe, setShoe] = useState<BlackjackShoeWire | null>(null);
  const [balance, setBalance] = useState(avatar?.clawTokens ?? 0);
  const [hand, setHand] = useState<HandView | null>(null);
  const [settledResponse, setSettledResponse] = useState<SettledHandResponse | null>(null);
  const [insuranceState, setInsuranceState] = useState({ offered: false, took: false });
  const [activeSlot, setActiveSlotState] = useState<0 | 1>(0);
  const [bet, setBetState] = useState(50);
  const [revealedSeed, setRevealedSeed] = useState<string | null>(null);
  const [toast, setToast] = useState<BlackjackRoomState['toast']>(null);
  const [agentMode, setAgentModeState] = useState<'control' | 'autonomous'>('control');
  const [agentPending, setAgentPending] = useState<AgentPending | null>(null);
  const [agentDriverUnavailable, setAgentDriverUnavailable] = useState(false);
  const [advisorMessages, setAdvisorMessages] = useState<{ id: number; text: string }[]>([]);

  const shoeRef = useRef<BlackjackShoeWire | null>(null);
  const handRef = useRef<HandView | null>(null);
  const phaseRef = useRef<BlackjackPhase>('idle');
  const concurrencyRef = useRef<BlackjackControllerRuntime | null>(null);
  if (concurrencyRef.current === null) {
    concurrencyRef.current = new BlackjackControllerRuntime();
  }
  const concurrency = concurrencyRef.current;
  const busyRef = concurrency.busyRef;
  const agentBusyRef = concurrency.agentBusyRef;
  const agentRunRef = concurrency.agentRunRef;
  const dealKeyRef = concurrency.dealKeyRef;
  const actionKeyRef = concurrency.actionKeyRef;
  const lastKeyMoveRef = concurrency.lastKeyMoveRef;
  const insureLatchRef = concurrency.insureLatchRef;
  const toastSeqRef = useRef(0);
  const advisorSeqRef = useRef(0);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  shoeRef.current = shoe;
  handRef.current = hand;
  phaseRef.current = phase;

  const bumpPublish = useCallback(() => setPublishSeq((value) => value + 1), []);
  const showToast = useCallback((
    message: string,
    tone: 'info' | 'warn' | 'error' = 'info',
  ) => {
    toastSeqRef.current += 1;
    setToast({ message, tone, id: toastSeqRef.current });
  }, []);
  const pushAdvisor = useCallback((text: string) => {
    advisorSeqRef.current += 1;
    setAdvisorMessages((current) => [
      ...current.slice(-19),
      { id: advisorSeqRef.current, text },
    ]);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(
      () => setToast((current) => current?.id === toast.id ? null : current),
      4_200,
    );
    return () => clearTimeout(timer);
  }, [toast]);

  const resetHand = useCallback(() => {
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    if (holeTimerRef.current) clearTimeout(holeTimerRef.current);
    revealTimerRef.current = null;
    holeTimerRef.current = null;
    concurrency.bumpDecisionContext();
    setAgentPending(null);
    setHand(null);
    setSettledResponse(null);
    setInsuranceState({ offered: false, took: false });
    setActiveSlotState(0);
    setPhase('idle');
    setDealStep('idle');
    setTransition('idle');
    setBannerVisible(false);
    dealKeyRef.current = null;
    actionKeyRef.current = null;
    bumpPublish();
  }, [bumpPublish]);

  const restoreHandFromServer = useCallback((
    response: CurrentHandResponse | null,
    allowClear = true,
  ) => {
    const disposition = concurrency.restoredHandDisposition(response, allowClear);
    if (disposition === 'ignore') return;
    if (disposition === 'clear') {
        setHand(null);
        setSettledResponse(null);
        setInsuranceState({ offered: false, took: false });
        setPhase('idle');
        setDealStep('idle');
        setBannerVisible(false);
        bumpPublish();
      return;
    }
    if (!response || !isCurrentHandLive(response)) return;
    const live: CurrentHandLive = response;
    const playerHands = live.playerHands.map((playerHand) => ({ ...playerHand }));
    setHand({
      handId: live.handId,
      shoeId: live.shoeId,
      handIndex: live.handIndex,
      playerHands,
      dealerUpcard: live.dealerUpcard,
      insuranceOffered: live.insuranceOffered,
      tookInsurance: live.tookInsurance,
      didSplit: live.didSplit,
      bet: Number(live.bet),
    });
    setInsuranceState({
      offered: live.insuranceOffered,
      took: live.tookInsurance,
    });
    setSettledResponse(null);
    setActiveSlotState(live.didSplit ? firstUnresolvedSlot(playerHands) : 0);
    setPhase('player-turn');
    setDealStep(live.didSplit ? 'split' : 'player-turn');
    setTransition('idle');
    setBannerVisible(false);
    bumpPublish();
  }, [bumpPublish]);

  const reconcile = useCallback(async () => {
    if (!isRealTier) {
      setShoe(null);
      shoeRef.current = null;
      setHand(null);
      setSettledResponse(null);
      setInsuranceState({ offered: false, took: false });
      setPhase('idle');
      setDealStep('idle');
      setTransition('idle');
      setBannerVisible(false);
      dealKeyRef.current = null;
      actionKeyRef.current = null;
      bumpPublish();
      showToast("Couldn't confirm — your next hand reflects the server.", 'warn');
      return;
    }
    try {
      const [shoeResponse, handResponse] = await Promise.all([
        fetchCurrentBlackjackShoe(),
        fetchCurrentBlackjackHand(),
      ]);
      if (shoeResponse?.shoe.status === 'open') {
        setShoe(shoeResponse.shoe);
        setBalance(shoeResponse.walletBalance);
      }
      restoreHandFromServer(handResponse);
    } catch {
      showToast("Couldn't restore your hand — refresh to retry.", 'warn');
    }
  }, [bumpPublish, isRealTier, restoreHandFromServer, showToast]);

  useEffect(() => {
    setBalance(avatar?.clawTokens ?? 0);
  }, [avatar?.clawTokens]);

  useEffect(() => {
    if (!isRealTier) return;
    let cancelled = false;
    void (async () => {
      try {
        const current = await fetchCurrentBlackjackShoe();
        if (cancelled || !current || current.shoe.status !== 'open') return;
        setShoe(current.shoe);
        setBalance(current.walletBalance);
        try {
          const currentHand = await fetchCurrentBlackjackHand();
          if (!cancelled) restoreHandFromServer(currentHand, false);
        } catch (error) {
          if (error instanceof CoveApiError && error.status >= 500) {
            showToast("Couldn't restore your hand — refresh to retry.", 'warn');
          }
        }
      } catch {
        // Lazy open on Deal remains available.
      }
    })();
    return () => { cancelled = true; };
  }, [isRealTier, restoreHandFromServer, showToast]);

  useEffect(() => () => {
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    if (holeTimerRef.current) clearTimeout(holeTimerRef.current);
    concurrency.dispose();
  }, [concurrency]);

  useEffect(() => {
    if (agentMode !== 'autonomous') return;
    const listener = (event: KeyboardEvent) => {
      if (MOVEMENT_KEYS.has(event.key)) lastKeyMoveRef.current = Date.now();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [agentMode]);

  const ensureShoe = useCallback(async (): Promise<BlackjackShoeWire | null> => {
    const current = shoeRef.current;
    if (current?.status === 'open') return current;
    try {
      const opened = await openShoe.mutateAsync({ currency: 'clawtoken' });
      setShoe(opened.shoe);
      setBalance(opened.walletBalance);
      return opened.shoe;
    } catch (error) {
      showToast(
        describeBlackjackError(error),
        error instanceof CoveApiError && error.status >= 500 ? 'error' : 'warn',
      );
      return null;
    }
  }, [openShoe, showToast]);

  const applySettled = useCallback((
    response: SettledHandResponse,
    source: 'deal' | 'action',
  ) => {
    concurrency.markSettled(response.handId);
    setSettledResponse(response);
    setInsuranceState({
      offered: response.outcome.dealer.cards[0]?.rank === 'A',
      took: response.outcome.insurance !== null,
    });
    setBalance(response.balance);
    setHand(null);
    setActiveSlotState(0);
    setShoe((current) => current ? { ...current, dealtCount: response.dealtCount } : current);
    setPhase('player-turn');
    setBannerVisible(false);
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    const revealDealer = () => {
      setDealStep('dealer-reveal');
      setTransition('revealing');
      bumpPublish();
      revealTimerRef.current = setTimeout(() => {
        setDealStep('settled');
        setBannerVisible(true);
        setPhase('settled');
        bumpPublish();
        revealTimerRef.current = setTimeout(() => {
          setTransition('idle');
          revealTimerRef.current = null;
        }, 0);
      }, SETTLE_REVEAL_MS);
    };
    if (source === 'action') {
      // Publish the terminal player result in its own render before dealer
      // entitlement advances. This preserves the action-response cadence for
      // bust/stand while naturals continue directly into dealer reveal.
      setDealStep('player-turn');
      setTransition('idle');
      bumpPublish();
      revealTimerRef.current = setTimeout(revealDealer, ACTION_SETTLED_STAGE_MS);
    } else {
      revealDealer();
    }
  }, [bumpPublish]);

  const handFromDeal = useCallback((
    response: Extract<DealResponse, { status: 'in_progress' }>,
  ): HandView => {
    const total = displayTotal(response.playerHand);
    return {
      handId: response.handId,
      shoeId: response.shoeId,
      handIndex: response.handIndex,
      playerHands: [{
        cards: response.playerHand,
        total: total.total,
        isSoft: total.isSoft,
        isBust: false,
        isResolved: false,
      }],
      dealerUpcard: response.dealerUpcard,
      insuranceOffered: response.insuranceOffered,
      tookInsurance: response.tookInsurance,
      didSplit: false,
      bet: Number(response.bet),
    };
  }, []);

  const mergeAction = useCallback((
    response: Extract<ActionResponse, { status: 'in_progress'; playerHands: unknown }>,
  ) => {
    const justSplit = response.didSplit && !handRef.current?.didSplit;
    setHand((current) => current ? {
      ...current,
      handId: response.handId,
      playerHands: response.playerHands.map((playerHand) => ({ ...playerHand })),
      dealerUpcard: response.dealerUpcard ?? current.dealerUpcard,
      didSplit: response.didSplit,
    } : current);
    setInsuranceState(expireInsuranceOffer);
    setActiveSlotState(response.didSplit ? firstUnresolvedSlot(response.playerHands) : 0);
    setDealStep(justSplit ? 'split' : 'player-turn');
    bumpPublish();
    if (justSplit) {
      if (holeTimerRef.current) clearTimeout(holeTimerRef.current);
      holeTimerRef.current = setTimeout(() => {
        setDealStep('player-turn');
        bumpPublish();
        holeTimerRef.current = null;
      }, HOLE_REVEAL_MS);
    }
  }, [bumpPublish]);

  const deal = useCallback(async (
    agentDriven: boolean,
    betOverride?: number,
    expectedHandsPlayed?: number,
  ) => {
    if (busyRef.current || phaseRef.current !== 'idle') return;
    if (!agentDriven && agentMode === 'autonomous') {
      agentRunRef.current += 1;
      setAgentPending(null);
    }
    busyRef.current = true;
    let succeeded = false;
    try {
      const activeShoe = await ensureShoe();
      if (!activeShoe) return;
      const initialDealKey = concurrency.ensureDealKey(() => crypto.randomUUID());
      const wager = Math.max(5, Math.min(500, Math.round(betOverride ?? bet)));
      let response: DealResponse;
      try {
        response = await dealHand.mutateAsync({
          shoeId: activeShoe.id,
          bet: wager,
          insurance: false,
          idempotencyKey: initialDealKey,
          ...(agentDriven && expectedHandsPlayed !== undefined
            ? { expectedHandsPlayed }
            : {}),
        });
      } catch (error) {
        if (!reshuffledBody(error)) throw error;
        setShoe(null);
        shoeRef.current = null;
        const fresh = await ensureShoe();
        if (!fresh) return;
        const retry = concurrency.prepareFreshShoeRetry(() => crypto.randomUUID());
        response = await dealHand.mutateAsync({
          shoeId: fresh.id,
          bet: wager,
          insurance: false,
          idempotencyKey: retry.idempotencyKey,
        });
      }
      succeeded = true;
      insureLatchRef.current.clear();
      setSettledResponse(null);
      if (isSettled(response)) {
        applySettled(response, 'deal');
      } else {
        setHand(handFromDeal(response));
        setInsuranceState({
          offered: response.insuranceOffered,
          took: response.tookInsurance,
        });
        setActiveSlotState(0);
        setPhase('player-turn');
        setDealStep('hole');
        setTransition('idle');
        setBannerVisible(false);
        bumpPublish();
        if (holeTimerRef.current) clearTimeout(holeTimerRef.current);
        holeTimerRef.current = setTimeout(() => {
          setDealStep('player-turn');
          bumpPublish();
          holeTimerRef.current = null;
        }, HOLE_REVEAL_MS);
        if (typeof response.balance === 'number') setBalance(response.balance);
      }
    } catch (error) {
      const policy = dealErrorPolicy(error, { agentDriven, isRealTier });
      if (policy === 'stale-agent-reconcile') {
        dealKeyRef.current = null;
        await reconcile();
        pushAdvisor('You dealt this hand — the agent stood down. Still in Autonomous.');
      } else if (
        policy === 'hand-in-progress-reconcile' ||
        policy === 'ambiguous-reconcile' ||
        policy === 'guest-uncertain'
      ) {
        await reconcile();
      } else {
        showToast(describeBlackjackError(error), 'warn');
      }
    } finally {
      if (succeeded) dealKeyRef.current = null;
      busyRef.current = false;
    }
  }, [
    agentMode, applySettled, bet, bumpPublish, dealHand, ensureShoe,
    handFromDeal, isRealTier, pushAdvisor, reconcile, showToast,
  ]);

  const run = useCallback(async (
    act: 'hit' | 'stand' | 'double' | 'split' | 'surrender',
    agentDriven: boolean,
    decision?: Pick<AgentDecisionResponse, 'handId' | 'handSlot' | 'handVersion'>,
  ) => {
    const currentHand = handRef.current;
    if (busyRef.current || !currentHand) return;
    if (!agentDriven && agentMode === 'autonomous') {
      agentRunRef.current += 1;
      setAgentPending(null);
    }
    const relayTarget = decision ? concurrency.relayTarget(decision) : null;
    const targetHandId = relayTarget?.handId ?? currentHand.handId;
    const targetSlot = relayTarget?.slot ?? activeSlot;
    const terminal = act === 'stand' || act === 'double' || act === 'surrender';
    const actionKey = concurrency.ensureActionKey(() => crypto.randomUUID());
    busyRef.current = true;
    try {
      const response = await action.mutateAsync({
        handId: targetHandId,
        action: act,
        handSlot: targetSlot,
        idempotencyKey: actionKey,
        ...(agentDriven && relayTarget?.version != null
          ? { expectedHandVersion: relayTarget.version }
          : {}),
      });
      actionKeyRef.current = null;
      concurrency.clearInsuranceForHand(currentHand.handId);
      if (isSettled(response)) applySettled(response, 'action');
      else if (isActionInProgress(response)) mergeAction(response);
    } catch (error) {
      const policy = actionErrorPolicy(error, { agentDriven, isRealTier });
      concurrency.retainActionKeyAfterError(actionKey, policy, terminal);
      if (policy === 'stale-agent-reconcile') {
        await reconcile();
        pushAdvisor('You took over this hand — the agent stood down. Still in Autonomous.');
      } else if (
        policy === 'terminal-slot-reconcile' ||
        policy === 'ambiguous-reconcile' ||
        policy === 'guest-uncertain'
      ) {
        await reconcile();
      } else {
        showToast(describeBlackjackError(error), 'warn');
      }
    } finally {
      busyRef.current = false;
    }
  }, [
    action, activeSlot, agentMode, applySettled, mergeAction,
    isRealTier, pushAdvisor, reconcile, showToast,
  ]);

  const requestClose = useCallback(() => {
    agentRunRef.current += 1;
    setAgentPending(null);
    const currentShoe = shoeRef.current;
    if (
      currentShoe?.status === 'open' && isRealTier && !handRef.current &&
      !busyRef.current && !revealedSeed
    ) {
      closeShoe.mutate({ shoeId: currentShoe.id });
    }
    router.push('/cove');
  }, [closeShoe, isRealTier, revealedSeed, router]);

  const handleWalkAway = useCallback(async () => {
    const currentShoe = shoeRef.current;
    if (!currentShoe || !isRealTier) {
      requestClose();
      return;
    }
    if (handRef.current) {
      showToast('Finish the current hand first.', 'warn');
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const response = await closeShoe.mutateAsync({ shoeId: currentShoe.id });
      setRevealedSeed(response.serverSeed);
      setShoe((current) => current ? {
        ...current,
        status: 'closed',
        serverSeed: response.serverSeed,
      } : current);
      showToast(`Seed ${response.serverSeed.slice(0, 10)}… revealed.`, 'info');
      concurrency.scheduleClose(1_400, requestClose);
    } catch (error) {
      showToast(describeBlackjackError(error), 'warn');
    } finally {
      busyRef.current = false;
    }
  }, [closeShoe, isRealTier, requestClose, showToast]);

  const decisionContextKey = `${phase}:${hand?.handId ?? 'none'}:${activeSlot}:${settledResponse?.handId ?? 'none'}:${agentMode}`;
  useEffect(() => {
    agentRunRef.current += 1;
    setAgentPending(null);
  }, [decisionContextKey]);

  useEffect(() => {
    if (!agentConnected && agentMode === 'autonomous') {
      setAgentModeState('control');
      setAgentPending(null);
      agentRunRef.current += 1;
      showToast('Agent disconnected — back to Control mode.', 'warn');
    }
  }, [agentConnected, agentMode, showToast]);

  const inFlight = openShoe.isPending || dealHand.isPending || action.isPending || closeShoe.isPending;

  const applyAgentDecision = useCallback(async (decision: AgentPending) => {
    if (decision.action === 'deal') {
      if (typeof decision.amount === 'number') setBetState(Math.max(5, Math.min(500, decision.amount)));
      await deal(true, decision.amount, decision.expectedHandsPlayed ?? undefined);
      return;
    }
    if (decision.action === 'insure') return;
    await run(decision.action, true, decision);
  }, [deal, run]);

  useEffect(() => {
    if (
      agentMode !== 'autonomous' || !agentConnected || agentDriverUnavailable ||
      inFlight || busyRef.current || agentBusyRef.current || agentPending || revealedSeed
    ) return;
    if (
      hand?.handId &&
      concurrency.suppressInsuranceQuery(hand.handId)
    ) return;
    if (phase === 'settled') {
      const timer = setTimeout(resetHand, NEXT_HAND_PAUSE_MS);
      return () => clearTimeout(timer);
    }
    if (phase !== 'idle' && phase !== 'player-turn') return;
    const runToken = ++agentRunRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const activeShoe = shoeRef.current ?? await ensureShoe();
        if (!activeShoe || cancelled || runToken !== agentRunRef.current) return;
        const decision = await fetchAgentBlackjackDecision({ shoeId: activeShoe.id });
        if (cancelled || runToken !== agentRunRef.current) return;
        if (decision.rationale) pushAdvisor(decision.rationale);
        if (decision.action === 'insure') {
          if (decision.handId && decision.handVersion != null) {
            if (concurrency.latchInsurance(decision.handId, decision.handVersion)) {
              pushAdvisor('Insurance is not available in this room. Choose a main-hand action.');
            }
          }
          return;
        }
        const keyboardActive = Date.now() - lastKeyMoveRef.current < KEYBOARD_ACTIVE_MS;
        const wait = keyboardActive ? AGENT_KEYBOARD_WAIT_MS : AGENT_WAIT_MS;
        setAgentPending({ ...decision, deadline: Date.now() + wait });
      } catch (error) {
        if (cancelled || runToken !== agentRunRef.current) return;
        if (error instanceof AgentUndecidedError) {
          pushAdvisor('Agent could not decide this hand — your call. Still in Autonomous.');
        } else if (error instanceof AgentDriverUnavailableError) {
          setAgentDriverUnavailable(true);
          setAgentModeState('control');
          showToast('Could not reach your agent for this table. Switched to Control.', 'warn');
        } else {
          showToast(describeBlackjackError(error), 'warn');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [
    agentConnected, agentDriverUnavailable, agentMode, agentPending, ensureShoe,
    activeSlot, hand?.handId, inFlight, phase, pushAdvisor, resetHand, revealedSeed, showToast,
  ]);

  useEffect(() => {
    if (!agentPending || agentMode !== 'autonomous') return;
    return concurrency.scheduleAgentApply(
      agentPending.deadline - Date.now(),
      async () => {
        try {
          await applyAgentDecision(agentPending);
        } finally {
        setAgentPending(null);
        }
      },
    );
  }, [agentMode, agentPending, applyAgentDecision, concurrency]);

  useEffect(() => {
    if (
      phase !== 'player-turn' || !hand || inFlight ||
      busyRef.current || agentBusyRef.current ||
      !concurrency.claimTerminalSelfHeal(hand.handId, hand.playerHands)
    ) return;
    showToast('Hand resolved — syncing the table…', 'info');
    void reconcile();
  }, [concurrency, hand, inFlight, phase, reconcile, showToast]);

  const settledOutcome = settledResponse?.outcome ?? null;
  const playerHands = useMemo<SubHandView[]>(() => settledOutcome
    ? settledOutcome.playerHands.map((playerHand) => ({
        cards: playerHand.cards,
        total: playerHand.total,
        isSoft: playerHand.isSoft,
        isBust: playerHand.isBust,
        isResolved: true,
        outcome: playerHand.outcome,
        payout: playerHand.payout,
        bet: playerHand.bet,
        isBlackjack: playerHand.isBlackjack,
        isDoubled: playerHand.isDoubled,
      }))
    : hand?.playerHands ?? [], [hand?.playerHands, settledOutcome]);
  const { dealerCards, dealerTotalLabel } = deriveDealerRenderView(
    hand?.dealerUpcard,
    settledOutcome,
    dealStep,
  );
  const activeHand = playerHands[activeSlot] ?? playerHands[0] ?? null;
  const activeResolved = Boolean(activeHand?.isResolved);
  const canDouble = Boolean(activeHand && activeHand.cards.length === 2 && !activeResolved);
  const canSplit = Boolean(
    hand && !hand.didSplit && activeHand && activeHand.cards.length === 2 &&
    !activeResolved && cardValuePair(activeHand.cards),
  );
  const canSurrender = Boolean(
    hand && !hand.didSplit && activeHand && activeHand.cards.length === 2 && !activeResolved,
  );
  const fairnessSummary = !shoe
    ? 'Open a hand to commit the shoe seed'
    : revealedSeed
      ? `Seed revealed: ${revealedSeed.slice(0, 6)}…${revealedSeed.slice(-4)}`
      : `Committed: ${shoe.serverSeedHash.slice(0, 8)}…${shoe.serverSeedHash.slice(-6)}`;
  const settled: RoomSettledView | null = settledResponse ? {
    outcome: settledResponse.outcome,
    net: settledResponse.net,
    balance: settledResponse.balance,
    handId: settledResponse.handId,
  } : null;

  const handlers = useMemo<BlackjackRoomHandlers>(() => ({
    setBet: (value) => {
      if (!BET_STEPS.includes(value as (typeof BET_STEPS)[number])) return;
      setBetState(Math.max(5, Math.min(500, value)));
    },
    handleDeal: () => deal(false),
    runAction: (act) => run(act, false),
    handleNextHand: resetHand,
    handleWalkAway,
    setActiveSlot: (slot) => {
      agentRunRef.current += 1;
      setAgentPending(null);
      setActiveSlotState(slot);
    },
    setAgentMode: (mode) => {
      if (mode === 'autonomous' && (!agentConnected || agentDriverUnavailable)) return;
      agentRunRef.current += 1;
      setAgentPending(null);
      setAgentModeState(mode);
    },
    requestClose,
    reportCardOverflow: () => showToast('Too many cards to render — the hand was preserved.', 'error'),
  }), [
    agentConnected, agentDriverUnavailable, deal, handleWalkAway,
    requestClose, resetHand, run, showToast,
  ]);

  return {
    phase,
    dealerCards,
    dealerTotalLabel,
    playerHands,
    activeSlot,
    didSplit: hand?.didSplit ?? settledOutcome?.playerHands.length === 2,
    insuranceOffered: insuranceState.offered,
    tookInsurance: insuranceState.took,
    dealStep,
    transition,
    publishSeq,
    bannerVisible,
    handId: hand?.handId ?? settledResponse?.handId ?? null,
    handIndex: hand?.handIndex ?? settledResponse?.handIndex ?? null,
    bannerText: settledOutcome ? buildBannerLabel(settledOutcome) : null,
    balance,
    isRealTier,
    bet,
    shoe,
    revealedSeed,
    settled,
    toast,
    inFlight,
    canDouble,
    canSplit,
    canSurrender,
    activeResolved,
    agentMode,
    agentConnected,
    agentDriverUnavailable,
    agentPendingAction: agentPending?.action ?? null,
    advisorMessages,
    fairnessSummary,
    handlers,
  };
}
