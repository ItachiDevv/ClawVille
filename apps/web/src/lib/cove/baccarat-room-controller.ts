'use client';

import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type {
  BaccaratBet,
  BaccaratCoupResponse,
  BaccaratLastCoupSnapshot,
  BaccaratShoeWire,
  CloseBaccaratShoeResponse,
  CurrentBaccaratSessionResponse,
  OpenBaccaratShoeResponse,
  RotatedBaccaratShoeResponse,
  SerializedBaccaratCoup,
} from '@clawville/shared';
import { COVE_BACCARAT_GUEST_STACK } from '@clawville/shared';
import { useAuthMe } from '@/hooks/use-auth-me';
import { useAvatar } from '@/hooks/use-avatar';
import {
  CoveApiError,
  describeBaccaratError,
  fetchCurrentBaccaratShoe,
  reshuffledBody,
} from '@/lib/cove/baccarat-api-client';
import {
  buildBaccaratParity,
  clearFeltParity,
  type CardParityPayload,
  type CardParityRoot,
} from '@/lib/cove/card-parity-mirror';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const REVEAL_STEP_MS = 240;
export const BACCARAT_FINAL_REVEAL_STAGE_MS = 120;
const LEAVE_AFTER_REVEAL_MS = 900;

export type BaccaratRoomPhase =
  | 'idle'
  | 'requesting'
  | 'revealing'
  | 'settled'
  | 'leaving';

export interface BaccaratDealStep {
  side: 'player' | 'banker';
  handCardIndex: number;
  token: string;
}

export interface PendingCoup {
  shoeId: string;
  bet: BaccaratBet;
  stake: number;
  idempotencyKey: string;
}

export interface BaccaratRoomState {
  shoe: BaccaratShoeWire | null;
  walletBalance: number;
  isDemo: boolean;
  settled: BaccaratCoupResponse | null;
  restored: BaccaratLastCoupSnapshot | null;
  revealedSeed: string | null;
  betType: BaccaratBet;
  stake: number;
  phase: BaccaratRoomPhase;
  revealedStep: number;
  dealSteps: readonly BaccaratDealStep[];
  correlation: { hand: string } | null;
  bannerText: string | null;
  betzoneSelected: string | null;
  opEpoch: number;
  pending: PendingCoup | null;
  inFlight: boolean;
  walkAwayQueued: boolean;
  toast: {
    message: string;
    tone: 'info' | 'warn' | 'error';
    id: number;
  } | null;
  setBetType(bet: BaccaratBet): void;
  setStake(stake: number): void;
  handleDeal(): Promise<void>;
  handleNextCoup(): void;
  handleWalkAway(): Promise<void>;
  hydrate(a: {
    shoe: BaccaratShoeWire | null;
    lastCoup: BaccaratLastCoupSnapshot | null;
    isDemo: boolean;
    walletBalance: number;
  }): Promise<void>;
  reset(): void;
}

export interface BaccaratRuntimeToken {
  valid: boolean;
  instanceId: string;
}

let runtimeToken: BaccaratRuntimeToken | null = null;
let toastSequence = 0;
let leaveTimer: number | null = null;
let finalRevealTimer: number | null = null;

class SeedIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedIntegrityError';
  }
}

function cancelLeaveTimer(): void {
  if (leaveTimer === null) return;
  window.clearTimeout(leaveTimer);
  leaveTimer = null;
}

function cancelFinalRevealTimer(): void {
  if (finalRevealTimer === null) return;
  window.clearTimeout(finalRevealTimer);
  finalRevealTimer = null;
}

function activeCoup(state: Pick<BaccaratRoomState, 'settled' | 'restored'>) {
  return state.settled?.outcome ?? state.restored?.outcome ?? null;
}

function bannerFor(coup: SerializedBaccaratCoup): string {
  const winner = coup.winner === 'player'
    ? 'PLAYER WINS'
    : coup.winner === 'banker'
      ? 'BANKER WINS'
      : 'TIE';
  const net = Number(coup.net);
  const result = net > 0 ? 'YOU WIN' : net === 0 ? 'PUSH' : 'YOU LOSE';
  return `${winner} · ${result}`;
}

function nextToast(message: string, tone: 'info' | 'warn' | 'error') {
  toastSequence += 1;
  return { message, tone, id: toastSequence };
}

function isCurrent(epoch: number, token: BaccaratRuntimeToken | null): boolean {
  return Boolean(
    token
    && token.valid
    && runtimeToken === token
    && useBaccaratRoomController.getState().opEpoch === epoch,
  );
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!response.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = await response.json() as Record<string, unknown>;
    } catch {
      // Keep the HTTP fallback below.
    }
    const serverMessage = typeof body.message === 'string'
      ? body.message
      : typeof body.error === 'string'
        ? body.error
        : `HTTP ${response.status}`;
    const code = serverMessage.split(/[\s:]/)[0] || null;
    const error = new CoveApiError(response.status, serverMessage, code);
    (error as CoveApiError & { body?: unknown }).body = body;
    throw error;
  }
  return await response.json() as T;
}

function openShoe(): Promise<OpenBaccaratShoeResponse | RotatedBaccaratShoeResponse> {
  return requestJson('/api/cove/baccarat/session/open', {
    method: 'POST',
    body: JSON.stringify({ currency: 'clawtoken' }),
  });
}

function playCoup(pending: PendingCoup): Promise<BaccaratCoupResponse> {
  return requestJson('/api/cove/baccarat/coup', {
    method: 'POST',
    headers: { 'Idempotency-Key': pending.idempotencyKey },
    body: JSON.stringify({
      shoeId: pending.shoeId,
      bet: pending.bet,
      stake: pending.stake,
    }),
  });
}

function closeShoe(shoeId: string): Promise<CloseBaccaratShoeResponse> {
  return requestJson('/api/cove/baccarat/session/close', {
    method: 'POST',
    body: JSON.stringify({ shoeId }),
  });
}

async function fetchClosedShoe(shoeId: string): Promise<BaccaratShoeWire> {
  const detail = await requestJson<{ shoe: BaccaratShoeWire }>(
    `/api/cove/baccarat/session/${encodeURIComponent(shoeId)}`,
    { method: 'GET' },
  );
  return detail.shoe;
}

async function verifySeed(seed: string, expectedHash: string): Promise<boolean> {
  const bytes = new TextEncoder().encode(seed);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return actual === expectedHash.toLowerCase();
}

async function closeAndVerifyShoe(
  shoe: BaccaratShoeWire,
): Promise<{ serverSeed: string; serverSeedHash: string }> {
  let serverSeed: string;
  let serverSeedHash: string;
  try {
    const closed = await closeShoe(shoe.id);
    serverSeed = closed.serverSeed;
    serverSeedHash = closed.serverSeedHash;
  } catch (error) {
    if (error instanceof CoveApiError) throw error;
    // A lost close response is ambiguous: recover the now-public seed from
    // the landed owner detail endpoint. Never open a new shoe until verified.
    let recovered: BaccaratShoeWire;
    try {
      recovered = await fetchClosedShoe(shoe.id);
    } catch {
      throw new SeedIntegrityError(
        'The close response was lost and the retired seed could not be recovered. The operation was halted.',
      );
    }
    if (recovered.status !== 'closed' || !recovered.serverSeed) {
      throw new SeedIntegrityError(
        'The retired shoe seed is unavailable. The operation was halted.',
      );
    }
    serverSeed = recovered.serverSeed;
    serverSeedHash = recovered.serverSeedHash;
  }
  if (!(await verifySeed(serverSeed, serverSeedHash))) {
    throw new SeedIntegrityError(
      'Shoe seed verification failed. The operation was halted.',
    );
  }
  return { serverSeed, serverSeedHash };
}

async function ensureOpenShoe(
  epoch: number,
  token: BaccaratRuntimeToken | null,
): Promise<BaccaratShoeWire | null> {
  const existing = useBaccaratRoomController.getState().shoe;
  if (existing?.status === 'open') return existing;
  const opened = await openShoe();
  if (!isCurrent(epoch, token)) return null;
  if (
    'rotatedFrom' in opened
    && !(await verifySeed(
      opened.rotatedFrom.serverSeed,
      opened.rotatedFrom.serverSeedHash,
    ))
  ) {
    throw new SeedIntegrityError(
      'The retired shoe seed did not match its commitment.',
    );
  }
  if (!isCurrent(epoch, token)) return null;
  useBaccaratRoomController.setState({
    shoe: opened.shoe,
    walletBalance: opened.walletBalance,
  });
  return opened.shoe;
}

function clearCoupState() {
  return {
    settled: null,
    restored: null,
    revealedStep: 0,
    dealSteps: [] as readonly BaccaratDealStep[],
    correlation: null,
    bannerText: null,
    betzoneSelected: null,
    walkAwayQueued: false,
  };
}

function applyHydration(
  payload: {
    shoe: BaccaratShoeWire | null;
    lastCoup: BaccaratLastCoupSnapshot | null;
    isDemo: boolean;
    walletBalance: number;
  },
  epoch: number,
  token: BaccaratRuntimeToken | null,
): void {
  if (!isCurrent(epoch, token)) return;
  if (payload.lastCoup) {
    const steps = buildDealSteps(payload.lastCoup.outcome);
    useBaccaratRoomController.setState({
      shoe: payload.shoe,
      walletBalance: payload.walletBalance,
      isDemo: payload.isDemo,
      settled: null,
      restored: payload.lastCoup,
      revealedSeed: null,
      betType: payload.lastCoup.outcome.bet,
      stake: Number(payload.lastCoup.outcome.stake),
      phase: 'settled',
      revealedStep: steps.length,
      dealSteps: steps,
      correlation: { hand: payload.lastCoup.coupId },
      bannerText: bannerFor(payload.lastCoup.outcome),
      betzoneSelected: payload.lastCoup.outcome.bet,
      pending: null,
      inFlight: false,
      walkAwayQueued: false,
    });
    return;
  }
  useBaccaratRoomController.setState({
    ...clearCoupState(),
    shoe: payload.shoe,
    walletBalance: payload.walletBalance,
    isDemo: payload.isDemo,
    revealedSeed: null,
    betType: 'player',
    stake: 25,
    betzoneSelected: 'player',
    phase: 'idle',
    pending: null,
    inFlight: false,
  });
}

export function buildDealSteps(
  coup: SerializedBaccaratCoup,
): BaccaratDealStep[] {
  const steps: BaccaratDealStep[] = [
    { side: 'player', handCardIndex: 0, token: 'player-1' },
    { side: 'banker', handCardIndex: 0, token: 'banker-1' },
    { side: 'player', handCardIndex: 1, token: 'player-2' },
    { side: 'banker', handCardIndex: 1, token: 'banker-2' },
  ];
  if (coup.player.cards.length === 3) {
    steps.push({ side: 'player', handCardIndex: 2, token: 'player-3' });
  }
  if (coup.banker.cards.length === 3) {
    steps.push({ side: 'banker', handCardIndex: 2, token: 'banker-3' });
  }
  return steps;
}

/**
 * The one reveal derivation. Both visible quads and parity consume this exact
 * returned object, so neither can expose a final card before its reveal step.
 */
export function maskOutcomeToStep(
  coup: SerializedBaccaratCoup,
  revealedStep: number,
): SerializedBaccaratCoup {
  const steps = buildDealSteps(coup);
  const visible = new Set(
    steps
      .slice(0, Math.max(0, Math.min(revealedStep, steps.length)))
      .map((step) => `${step.side}:${step.handCardIndex}`),
  );
  return {
    ...coup,
    player: {
      ...coup.player,
      cards: coup.player.cards.filter((_, index) => visible.has(`player:${index}`)),
    },
    banker: {
      ...coup.banker,
      cards: coup.banker.cards.filter((_, index) => visible.has(`banker:${index}`)),
    },
  };
}

export function buildBaccaratRoomParityRevision(input: {
  maskedOutcome: SerializedBaccaratCoup | null;
  bet: BaccaratBet;
  stake: number;
  correlation: CardParityRoot['correlation'];
  dealStep: string;
  phase: BaccaratRoomPhase;
  transition: Extract<CardParityPayload['transition'], 'idle' | 'revealing'>;
  bannerText?: string;
  betzoneSelected?: string;
}): CardParityPayload {
  const finalFrame = input.phase === 'settled' || input.phase === 'leaving';
  const payload = buildBaccaratParity({
    outcome: input.maskedOutcome,
    bet: input.bet,
    stake: input.stake,
    surface: 'baccarat-3d',
    correlation: input.correlation,
    dealStep: input.dealStep,
    phase: input.phase,
    transition: input.transition,
    ...(finalFrame && input.bannerText !== undefined
      ? { bannerText: input.bannerText }
      : {}),
    ...(input.betzoneSelected !== undefined
      ? { betzoneSelected: input.betzoneSelected }
      : {}),
  });
  if (!finalFrame) {
    for (const key of [
      'player-total',
      'player-natural',
      'banker-total',
      'banker-natural',
      'winner',
      'commission',
      'net',
      'banner-text',
    ]) {
      delete payload.meta[key];
    }
  }
  return payload;
}

export const useBaccaratRoomController = create<BaccaratRoomState>((set, get) => ({
  shoe: null,
  walletBalance: COVE_BACCARAT_GUEST_STACK,
  isDemo: true,
  settled: null,
  restored: null,
  revealedSeed: null,
  betType: 'player',
  stake: 25,
  phase: 'idle',
  revealedStep: 0,
  dealSteps: [],
  correlation: null,
  bannerText: null,
  betzoneSelected: 'player',
  opEpoch: 0,
  pending: null,
  inFlight: false,
  walkAwayQueued: false,
  toast: null,

  setBetType: (bet) => {
    const state = get();
    if (state.phase !== 'idle' || state.inFlight || state.pending) return;
    set({ betType: bet, betzoneSelected: bet });
  },

  setStake: (stake) => {
    const state = get();
    if (state.phase !== 'idle' || state.inFlight || state.pending) return;
    set({ stake });
  },

  handleDeal: async () => {
    const initial = get();
    if (initial.phase !== 'idle' || initial.inFlight) return;
    const token = runtimeToken;
    const epoch = initial.opEpoch + 1;
    let operationEpoch = epoch;
    set({
      opEpoch: epoch,
      phase: 'requesting',
      inFlight: true,
      toast: null,
    });

    let pending = initial.pending;
    try {
      let shoe = await ensureOpenShoe(epoch, token);
      if (!shoe || !isCurrent(epoch, token)) return;
      if (!pending || pending.shoeId !== shoe.id) {
        pending = {
          shoeId: shoe.id,
          bet: initial.betType,
          stake: initial.stake,
          idempotencyKey: crypto.randomUUID(),
        };
        set({ pending });
      }

      let response: BaccaratCoupResponse;
      try {
        response = await playCoup(pending);
      } catch (error) {
        if (!reshuffledBody(error)) throw error;
        if (!isCurrent(epoch, token)) return;

        const recoveryEpoch = get().opEpoch + 1;
        operationEpoch = recoveryEpoch;
        set({
          opEpoch: recoveryEpoch,
          pending: null,
          shoe: null,
          toast: nextToast('Shoe spent · preparing a fresh shoe.', 'info'),
        });

        if (!initial.isDemo && shoe.status === 'open') {
          const closed = await closeAndVerifyShoe(shoe);
          if (!isCurrent(recoveryEpoch, token)) return;
        }
        if (!isCurrent(recoveryEpoch, token)) return;
        shoe = await ensureOpenShoe(recoveryEpoch, token);
        if (!shoe || !isCurrent(recoveryEpoch, token)) return;
        pending = {
          shoeId: shoe.id,
          bet: initial.betType,
          stake: initial.stake,
          idempotencyKey: crypto.randomUUID(),
        };
        set({ pending });
        response = await playCoup(pending);
        if (!isCurrent(recoveryEpoch, token)) return;
      }

      if (!isCurrent(operationEpoch, token)) return;
      const steps = buildDealSteps(response.outcome);
      set((state) => ({
        shoe: state.shoe
          ? { ...state.shoe, dealtCount: response.dealtCount }
          : state.shoe,
        walletBalance: response.balance,
        settled: response,
        restored: null,
        phase: 'revealing',
        revealedStep: 0,
        dealSteps: steps,
        correlation: { hand: response.coupId },
        bannerText: bannerFor(response.outcome),
        betzoneSelected: response.outcome.bet,
        inFlight: false,
      }));
    } catch (error) {
      if (!isCurrent(operationEpoch, token)) return;
      const retryable = (
        !(error instanceof CoveApiError)
        && !(error instanceof SeedIntegrityError)
      ) || (
        error instanceof CoveApiError
        && (error.status === 408 || error.status === 429)
      );
      const payloadMismatch = error instanceof CoveApiError
        && error.status === 409
        && (
          error.code === 'idempotency_key_payload_mismatch'
          || error.serverMessage.includes('idempotency_key_payload_mismatch')
        );
      set({
        phase: 'idle',
        inFlight: false,
        pending: retryable && !payloadMismatch ? pending : null,
        toast: nextToast(
          describeBaccaratError(error),
          error instanceof CoveApiError && error.status >= 500 ? 'error' : 'warn',
        ),
      });
    }
  },

  handleNextCoup: () => {
    const state = get();
    if (state.phase !== 'settled') return;
    set({
      ...clearCoupState(),
      phase: 'idle',
      betzoneSelected: state.betType,
      pending: null,
      inFlight: false,
      opEpoch: state.opEpoch + 1,
    });
  },

  handleWalkAway: async () => {
    const initial = get();
    if (initial.phase === 'requesting') {
      set({ toast: nextToast('Finishing your deal before leaving.', 'info') });
      return;
    }
    if (initial.phase === 'revealing') {
      set({
        walkAwayQueued: true,
        toast: nextToast('Walk Away queued after the reveal.', 'info'),
      });
      return;
    }
    if (initial.phase === 'leaving') return;

    const token = runtimeToken;
    const epoch = initial.opEpoch + 1;
    cancelLeaveTimer();
    set({ opEpoch: epoch, phase: 'leaving', inFlight: true });
    try {
      if (!initial.isDemo && initial.shoe?.status === 'open') {
        const closed = await closeAndVerifyShoe(initial.shoe);
        if (!isCurrent(epoch, token)) return;
        set({
          revealedSeed: closed.serverSeed,
          shoe: {
            ...initial.shoe,
            status: 'closed',
            serverSeed: closed.serverSeed,
          },
          toast: nextToast('Shoe verified · leaving the table.', 'info'),
        });
        leaveTimer = window.setTimeout(() => {
          leaveTimer = null;
          if (!isCurrent(epoch, token)) return;
          window.location.assign('/cove');
        }, LEAVE_AFTER_REVEAL_MS);
        return;
      }
      if (isCurrent(epoch, token)) window.location.assign('/cove');
    } catch (error) {
      if (!isCurrent(epoch, token)) return;
      set({
        phase: initial.settled || initial.restored ? 'settled' : 'idle',
        inFlight: false,
        toast: nextToast(describeBaccaratError(error), 'warn'),
      });
    }
  },

  hydrate: async ({ shoe, lastCoup, isDemo, walletBalance }) => {
    const state = get();
    const epoch = state.opEpoch + 1;
    set({ opEpoch: epoch, inFlight: true });
    const token = runtimeToken;
    await Promise.resolve();
    applyHydration(
      { shoe, lastCoup, isDemo, walletBalance },
      epoch,
      token,
    );
  },

  reset: () => {
    const state = get();
    cancelLeaveTimer();
    cancelFinalRevealTimer();
    set({
      ...clearCoupState(),
      shoe: null,
      walletBalance: state.isDemo ? COVE_BACCARAT_GUEST_STACK : 0,
      revealedSeed: null,
      isDemo: true,
      betType: 'player',
      stake: 25,
      betzoneSelected: 'player',
      phase: 'idle',
      pending: null,
      inFlight: false,
      toast: null,
      opEpoch: state.opEpoch + 1,
    });
  },
}));

export function mountBaccaratRuntime(
  instanceId: string,
): BaccaratRuntimeToken {
  cancelLeaveTimer();
  cancelFinalRevealTimer();
  const token: BaccaratRuntimeToken = { valid: true, instanceId };
  runtimeToken = token;
  useBaccaratRoomController.getState().reset();
  return token;
}

export function unmountBaccaratRuntime(
  token: BaccaratRuntimeToken,
): void {
  cancelLeaveTimer();
  cancelFinalRevealTimer();
  token.valid = false;
  if (runtimeToken === token) runtimeToken = null;
  const state = useBaccaratRoomController.getState();
  useBaccaratRoomController.setState({
    ...clearCoupState(),
    shoe: null,
    walletBalance: COVE_BACCARAT_GUEST_STACK,
    isDemo: true,
    revealedSeed: null,
    betType: 'player',
    stake: 25,
    betzoneSelected: 'player',
    phase: 'idle',
    pending: null,
    inFlight: false,
    toast: null,
    opEpoch: state.opEpoch + 1,
  });
  clearFeltParity(token.instanceId);
}

export function advanceBaccaratReveal(
  capturedEpoch: number,
  token: BaccaratRuntimeToken,
): void {
  if (!isCurrent(capturedEpoch, token)) return;
  const state = useBaccaratRoomController.getState();
  if (state.phase !== 'revealing') return;
  if (state.revealedStep >= state.dealSteps.length) return;
  const nextStep = Math.min(state.revealedStep + 1, state.dealSteps.length);
  if (nextStep < state.dealSteps.length) {
    useBaccaratRoomController.setState({ revealedStep: nextStep });
    return;
  }
  // Publish the terminal card as its own controller revision. The explicit
  // delay is load-bearing: a zero-delay settle coalesces before R3F can
  // propagate the final reveal to the response-local parity mirror.
  useBaccaratRoomController.setState({ revealedStep: nextStep });
  cancelFinalRevealTimer();
  finalRevealTimer = window.setTimeout(() => {
    finalRevealTimer = null;
    if (!isCurrent(capturedEpoch, token)) return;
    const current = useBaccaratRoomController.getState();
    if (
      current.phase !== 'revealing'
      || current.revealedStep !== current.dealSteps.length
    ) {
      return;
    }
    useBaccaratRoomController.setState({
      phase: 'settled',
      pending: null,
      inFlight: false,
    });
    if (current.walkAwayQueued) {
      void useBaccaratRoomController.getState().handleWalkAway();
    }
  }, BACCARAT_FINAL_REVEAL_STAGE_MS);
}

export function BaccaratControllerRuntime({
  instanceId,
}: {
  instanceId: string;
}) {
  const { data: authData, isLoading: authLoading } = useAuthMe();
  const { data: avatar, isLoading: avatarLoading } = useAvatar();
  const phase = useBaccaratRoomController((state) => state.phase);
  const opEpoch = useBaccaratRoomController((state) => state.opEpoch);
  const revealedStep = useBaccaratRoomController((state) => state.revealedStep);
  const dealStepCount = useBaccaratRoomController((state) => state.dealSteps.length);
  const hydratedRef = useRef(false);

  useEffect(() => {
    hydratedRef.current = false;
    const token = mountBaccaratRuntime(instanceId);
    return () => {
      hydratedRef.current = false;
      unmountBaccaratRuntime(token);
    };
  }, [instanceId]);

  useEffect(() => {
    if (hydratedRef.current || authLoading || avatarLoading) return;
    hydratedRef.current = true;
    const token = runtimeToken;
    const hydrationEpoch = useBaccaratRoomController.getState().opEpoch + 1;
    useBaccaratRoomController.setState({
      opEpoch: hydrationEpoch,
      inFlight: true,
    });
    const isDemo = !authData?.user || Boolean(authData.user.isGuest);
    const fallbackBalance = isDemo
      ? COVE_BACCARAT_GUEST_STACK
      : avatar?.clawTokens ?? 0;
    void (async () => {
      try {
        const current = await fetchCurrentBaccaratShoe() as
          | CurrentBaccaratSessionResponse
          | null;
        if (!isCurrent(hydrationEpoch, token)) return;
        applyHydration({
          shoe: current?.shoe ?? null,
          lastCoup: current?.lastCoup ?? null,
          isDemo,
          walletBalance: current?.walletBalance ?? fallbackBalance,
        }, hydrationEpoch, token);
      } catch {
        if (!isCurrent(hydrationEpoch, token)) return;
        applyHydration({
          shoe: null,
          lastCoup: null,
          isDemo,
          walletBalance: fallbackBalance,
        }, hydrationEpoch, token);
      }
    })();
  }, [authData, authLoading, avatar?.clawTokens, avatarLoading]);

  useEffect(() => {
    if (phase !== 'revealing') return;
    const token = runtimeToken;
    const capturedEpoch = opEpoch;
    const timer = window.setTimeout(() => {
      if (!token) return;
      advanceBaccaratReveal(capturedEpoch, token);
    }, REVEAL_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [dealStepCount, opEpoch, phase, revealedStep]);

  return null;
}

export function getBaccaratVisibleCoup(): SerializedBaccaratCoup | null {
  const state = useBaccaratRoomController.getState();
  const coup = activeCoup(state);
  return coup ? maskOutcomeToStep(coup, state.revealedStep) : null;
}
