'use client';

import { useEffect } from 'react';
import type {
  BaccaratBet,
  BaccaratCard,
  BaccaratCoupResponse,
  SerializedBaccaratCoup,
} from '@clawville/shared';
import {
  buildBaccaratParity,
  clearFeltParity,
  publishFeltParity,
  type CardParityPayload,
} from '@/lib/cove/card-parity-mirror';

export type Baccarat2dPhase = 'idle' | 'revealing' | 'settled';

export interface Baccarat2dDealStep {
  side: 'player' | 'banker';
  handCardIndex: number;
  token: string;
}

export interface Baccarat2dDisplaySnapshot {
  pendingSettlement: BaccaratCoupResponse | null;
  revealedStep: number;
  phase: Baccarat2dPhase;
  selectedBet: BaccaratBet;
  selectedStake: number;
  bannerText: string | null;
}

const CARD_STEP_MS = 240;
export const BACCARAT_2D_FINAL_REVEAL_MS = 120;

export function buildBaccarat2dDealSteps(
  coup: SerializedBaccaratCoup,
): Baccarat2dDealStep[] {
  const steps: Baccarat2dDealStep[] = [
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

function baccaratCardValue(card: BaccaratCard): number {
  if (card.rank === 'A') return 1;
  if (card.rank === '10' || card.rank === 'J' || card.rank === 'Q' || card.rank === 'K') {
    return 0;
  }
  return Number(card.rank);
}

function partialTotal(cards: readonly BaccaratCard[]): number {
  return cards.reduce((sum, card) => sum + baccaratCardValue(card), 0) % 10;
}

/**
 * Derives the one visible coup from the stored settlement response. The wire
 * alone determines whether either third-card slot exists.
 */
export function maskBaccarat2dOutcome(
  coup: SerializedBaccaratCoup,
  revealedStep: number,
  settled: boolean,
): SerializedBaccaratCoup {
  if (settled) return coup;
  const visible = new Set(
    buildBaccarat2dDealSteps(coup)
      .slice(0, Math.max(0, revealedStep))
      .map((step) => `${step.side}:${step.handCardIndex}`),
  );
  const playerCards = coup.player.cards.filter((_, index) =>
    visible.has(`player:${index}`));
  const bankerCards = coup.banker.cards.filter((_, index) =>
    visible.has(`banker:${index}`));
  return {
    ...coup,
    player: {
      cards: playerCards,
      total: partialTotal(playerCards),
      isNatural: false,
    },
    banker: {
      cards: bankerCards,
      total: partialTotal(bankerCards),
      isNatural: false,
    },
  };
}

export function buildBaccarat2dBannerText(
  coup: SerializedBaccaratCoup,
): string {
  const winner =
    coup.winner === 'player'
      ? 'PLAYER WINS'
      : coup.winner === 'banker'
        ? 'BANKER WINS'
        : 'TIE';
  const net = Number(coup.net);
  const result = net > 0 ? 'YOU WIN' : net === 0 ? 'PUSH' : 'YOU LOSE';
  return `${winner} · ${result}`;
}

export function buildBaccarat2dParityRevision(
  snapshot: Baccarat2dDisplaySnapshot,
): CardParityPayload | null {
  const response = snapshot.pendingSettlement;
  if (!response || snapshot.phase === 'idle') return null;
  const steps = buildBaccarat2dDealSteps(response.outcome);
  const finalFrame = snapshot.phase === 'settled';
  const stepIndex = Math.max(1, Math.min(snapshot.revealedStep, steps.length));
  const masked = maskBaccarat2dOutcome(
    response.outcome,
    stepIndex,
    finalFrame,
  );
  const payload = buildBaccaratParity({
    outcome: masked,
    bet: response.outcome.bet,
    stake: Number(response.outcome.stake),
    surface: 'baccarat-2d',
    correlation: {
      hand: response.coupId,
      handNumber: response.coupIndex,
      shoe: response.shoeId,
    },
    dealStep: finalFrame ? 'settled' : steps[stepIndex - 1]!.token,
    phase: snapshot.phase,
    transition: finalFrame ? 'idle' : 'revealing',
    betzoneSelected: response.outcome.bet,
    ...(finalFrame && snapshot.bannerText
      ? { bannerText: snapshot.bannerText }
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

export function useBaccarat2dPublisher({
  open,
  instanceId,
  snapshot,
}: {
  open: boolean;
  instanceId: string;
  snapshot: Baccarat2dDisplaySnapshot;
}): void {
  useEffect(() => () => {
    clearFeltParity(instanceId);
  }, [instanceId]);

  useEffect(() => {
    const payload = buildBaccarat2dParityRevision(snapshot);
    if (!open || !payload) {
      clearFeltParity(instanceId);
      return;
    }
    publishFeltParity(instanceId, payload);
  }, [instanceId, open, snapshot]);
}

type TimerHandle = ReturnType<typeof setTimeout>;
type SetTimer = (callback: () => void, delayMs: number) => TimerHandle;
type ClearTimer = (handle: TimerHandle) => void;

export class Baccarat2dRevealEpoch {
  private epoch = 0;
  private correlation: string | null = null;
  private committedStepKey: string | null = null;
  private readonly timers = new Set<TimerHandle>();

  constructor(
    private readonly setTimer: SetTimer = setTimeout,
    private readonly clearTimer: ClearTimer = clearTimeout,
  ) {}

  begin(correlation: string): void {
    this.cancel();
    this.correlation = correlation;
  }

  scheduleCoup(
    response: BaccaratCoupResponse,
    reveal: (step: number) => void,
    settle: () => void,
  ): void {
    const steps = buildBaccarat2dDealSteps(response.outcome);
    for (let step = 2; step <= steps.length; step += 1) {
      this.schedule(CARD_STEP_MS * (step - 1), () => reveal(step));
    }
    this.schedule(
      CARD_STEP_MS * Math.max(0, steps.length - 1) + BACCARAT_2D_FINAL_REVEAL_MS,
      settle,
    );
  }

  scheduleCommittedStep(
    response: BaccaratCoupResponse,
    revealedStep: number,
    reveal: (step: number) => void,
    settle: () => void,
  ): void {
    if (this.correlation !== response.coupId) return;
    const key = `${response.coupId}:${revealedStep}`;
    if (this.committedStepKey === key) return;
    this.committedStepKey = key;
    const steps = buildBaccarat2dDealSteps(response.outcome);
    const commit = (callback: () => void) => {
      if (this.committedStepKey !== key) return;
      this.committedStepKey = null;
      callback();
    };
    if (revealedStep < steps.length) {
      this.schedule(CARD_STEP_MS, () => commit(() => reveal(revealedStep + 1)));
      return;
    }
    this.schedule(BACCARAT_2D_FINAL_REVEAL_MS, () => commit(settle));
  }

  cancel(): void {
    this.epoch += 1;
    this.correlation = null;
    this.committedStepKey = null;
    for (const timer of this.timers) this.clearTimer(timer);
    this.timers.clear();
  }

  private schedule(delayMs: number, callback: () => void): void {
    const scheduledEpoch = this.epoch;
    const scheduledCorrelation = this.correlation;
    const handle = this.setTimer(() => {
      this.timers.delete(handle);
      if (
        scheduledEpoch !== this.epoch ||
        scheduledCorrelation === null ||
        scheduledCorrelation !== this.correlation
      ) {
        return;
      }
      callback();
    }, delayMs);
    this.timers.add(handle);
  }
}
