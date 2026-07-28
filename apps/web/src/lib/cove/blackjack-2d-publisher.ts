'use client';

import { useEffect } from 'react';
import type {
  BlackjackCard,
  BlackjackOutcome,
  SerializedBlackjackHandResult,
} from '@/lib/cove/blackjack-types';
import type {
  ActionInProgressResponse,
  SettledHandResponse,
} from '@/lib/cove/blackjack-api-client';
import {
  buildBlackjackParity,
  clearFeltParity,
  publishFeltParity,
  type CardParityPayload,
} from '@/lib/cove/card-parity-mirror';

export type Blackjack2dDisplayStep =
  | 'idle'
  | 'hole'
  | 'player-turn'
  | 'split'
  | 'dealer-reveal'
  | 'settled';

export interface Blackjack2dSubHandView {
  cards: BlackjackCard[];
  total: number;
  isSoft: boolean;
  isBust: boolean;
  isResolved: boolean;
}

export interface Blackjack2dHandView {
  handId: string;
  shoeId: string;
  handIndex: number | null;
  playerHands: Blackjack2dSubHandView[];
  dealerUpcard: BlackjackCard | null;
  insuranceOffered: boolean;
  tookInsurance: boolean;
  didSplit: boolean;
  bet: number;
}

export interface Blackjack2dDisplaySnapshot {
  liveHand: Blackjack2dHandView | null;
  pendingSettlement: SettledHandResponse | null;
  displayStep: Blackjack2dDisplayStep;
  activeSlot: 0 | 1;
  bannerText: string | null;
}

const OUTCOME_LABELS: Readonly<Record<BlackjackOutcome, string>> = Object.freeze({
  blackjack: 'BLACKJACK!',
  win: 'YOU WIN',
  push: 'PUSH',
  surrender: 'SURRENDER',
  loss: 'YOU LOSE',
});

export function buildBlackjack2dBannerText(
  outcome: SerializedBlackjackHandResult,
): string {
  if (outcome.playerHands.length === 1) {
    return OUTCOME_LABELS[outcome.playerHands[0]!.outcome];
  }
  return outcome.playerHands
    .map((hand, index) => `Hand ${index + 1}: ${OUTCOME_LABELS[hand.outcome]}`)
    .join(' · ');
}

export function buildNaturalHoleHand(
  response: SettledHandResponse,
): Blackjack2dHandView {
  const outcome = response.outcome;
  const dealerUpcard = outcome.dealer.cards[0] ?? null;
  return {
    handId: response.handId,
    shoeId: response.shoeId,
    handIndex: response.handIndex,
    playerHands: outcome.playerHands.map((hand) => ({
      cards: hand.cards,
      total: hand.total,
      isSoft: hand.isSoft,
      isBust: hand.isBust,
      isResolved: true,
    })),
    dealerUpcard,
    insuranceOffered: dealerUpcard?.rank === 'A',
    tookInsurance: outcome.insurance !== null,
    didSplit: outcome.playerHands.length > 1,
    bet: Number(outcome.playerHands[0]?.bet ?? response.totalBet),
  };
}

export function mergeBlackjack2dActionHand(
  current: Blackjack2dHandView,
  response: ActionInProgressResponse,
): Blackjack2dHandView {
  return {
    ...current,
    handId: response.handId,
    playerHands: response.playerHands.map((hand) => ({ ...hand })),
    dealerUpcard: response.dealerUpcard ?? current.dealerUpcard,
    // The server expires the offer on the first main decision. The action wire
    // omits the boolean, so the client mirrors that authoritative transition.
    insuranceOffered: false,
    didSplit: response.didSplit,
  };
}

export function buildBlackjack2dParityRevision(
  snapshot: Blackjack2dDisplaySnapshot,
): CardParityPayload | null {
  const correlationSource = snapshot.pendingSettlement ?? snapshot.liveHand;
  if (!correlationSource || snapshot.displayStep === 'idle') return null;

  const revealDealer =
    snapshot.displayStep === 'dealer-reveal' ||
    snapshot.displayStep === 'settled';
  const finalFrame = snapshot.displayStep === 'settled';

  return buildBlackjackParity({
    hand: snapshot.liveHand,
    settled: revealDealer && snapshot.pendingSettlement
      ? snapshot.pendingSettlement
      : null,
    activeSlot: finalFrame ? 0 : snapshot.activeSlot,
    surface: 'blackjack-2d',
    correlation: {
      hand: correlationSource.handId,
      handNumber: correlationSource.handIndex,
      shoe: correlationSource.shoeId,
    },
    dealStep: snapshot.displayStep,
    phase: finalFrame
      ? 'settled'
      : snapshot.displayStep === 'player-turn' || snapshot.displayStep === 'split'
        ? 'player-turn'
        : 'revealing',
    transition: finalFrame ? 'idle' : 'revealing',
    ...(finalFrame && snapshot.bannerText
      ? { bannerText: snapshot.bannerText }
      : {}),
  });
}

export function useBlackjack2dPublisher({
  open,
  instanceId,
  snapshot,
}: {
  open: boolean;
  instanceId: string;
  snapshot: Blackjack2dDisplaySnapshot;
}): void {
  useEffect(() => () => {
    clearFeltParity(instanceId);
  }, [instanceId]);

  useEffect(() => {
    const payload = buildBlackjack2dParityRevision(snapshot);
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
type BlackjackCommittedStep = 'player-turn' | 'dealer-reveal' | 'settled';

/**
 * Owns one reveal generation. Every callback captures both the epoch and the
 * correlation active when scheduled, then re-proves both before mutating state.
 */
export class BlackjackRevealEpoch {
  private epoch = 0;
  private correlation: string | null = null;
  private committedStepKey: string | null = null;
  private actionSettlement = false;
  private readonly timers = new Set<TimerHandle>();

  constructor(
    private readonly setTimer: SetTimer = (callback, delayMs) => (
      setTimeout(callback, delayMs)
    ),
    private readonly clearTimer: ClearTimer = (handle) => clearTimeout(handle),
  ) {}

  begin(correlation: string): void {
    this.cancel();
    this.correlation = correlation;
  }

  scheduleCommittedStep(
    correlation: string,
    displayStep: Blackjack2dDisplayStep,
    hasPendingSettlement: boolean,
    commit: (step: BlackjackCommittedStep) => void,
  ): (() => void) | undefined {
    if (this.correlation !== correlation) return;

    let delayMs: number;
    let nextStep: BlackjackCommittedStep;
    if (!hasPendingSettlement && (displayStep === 'hole' || displayStep === 'split')) {
      delayMs = 120;
      nextStep = 'player-turn';
    } else if (hasPendingSettlement && displayStep === 'hole') {
      delayMs = 420;
      nextStep = 'dealer-reveal';
    } else if (hasPendingSettlement && displayStep === 'player-turn') {
      this.actionSettlement = true;
      delayMs = 120;
      nextStep = 'dealer-reveal';
    } else if (hasPendingSettlement && displayStep === 'dealer-reveal') {
      delayMs = this.actionSettlement ? 420 : 550;
      nextStep = 'settled';
    } else {
      return;
    }

    const key = `${correlation}:${hasPendingSettlement ? 'settlement' : 'live'}:${displayStep}`;
    if (this.committedStepKey === key) return;
    this.committedStepKey = key;
    const cleanup = this.schedule(delayMs, () => {
      if (this.committedStepKey !== key) return;
      this.committedStepKey = null;
      commit(nextStep);
    });
    return () => {
      if (this.committedStepKey === key) this.committedStepKey = null;
      cleanup();
    };
  }

  private schedule(delayMs: number, callback: () => void): () => void {
    const scheduledEpoch = this.epoch;
    const scheduledCorrelation = this.correlation;
    let active = true;
    const handle = this.setTimer(() => {
      active = false;
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
    return () => {
      if (!active) return;
      active = false;
      this.timers.delete(handle);
      this.clearTimer(handle);
    };
  }

  isCurrent(correlation: string): boolean {
    return this.correlation === correlation;
  }

  cancel(): void {
    this.epoch += 1;
    this.correlation = null;
    this.committedStepKey = null;
    this.actionSettlement = false;
    for (const timer of this.timers) this.clearTimer(timer);
    this.timers.clear();
  }
}
