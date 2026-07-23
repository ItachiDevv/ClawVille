import {
  beginTransition,
  buildBlackjackParity,
  clearFeltParity,
  completeTransition,
  getParitySnapshot,
  publishFeltParity,
} from './card-parity-mirror';
import type {
  BlackjackDealStep,
  BlackjackRoomState,
  CardParityTransition,
} from './use-blackjack-room-controller';

export function buildBlackjackRoomParity(
  view: BlackjackRoomState,
  dealStep: BlackjackDealStep = view.dealStep,
  transition: CardParityTransition = view.transition,
) {
  const settled = (dealStep === 'dealer-reveal' || dealStep === 'settled') && view.settled
    ? { outcome: view.settled.outcome }
    : null;
  const terminalActionTruth = dealStep === 'player-turn' && view.settled !== null;
  return buildBlackjackParity({
    hand: {
      playerHands: view.playerHands.map((hand) => ({
        cards: hand.cards,
        total: hand.total,
        isSoft: hand.isSoft,
        isBust: hand.isBust,
        isResolved: hand.isResolved,
      })),
      dealerUpcard: terminalActionTruth ? null : view.dealerCards[0] ?? null,
      insuranceOffered: view.insuranceOffered,
      tookInsurance: view.tookInsurance,
      didSplit: view.didSplit,
    },
    settled,
    activeSlot: view.activeSlot,
    surface: 'blackjack-3d',
    correlation: {
      hand: view.handId ?? '',
      handNumber: view.handIndex,
      ...(view.shoe ? { shoe: view.shoe.id } : {}),
    },
    dealStep,
    phase: view.phase,
    transition,
    ...(dealStep === 'settled' && view.bannerText !== null
      ? { bannerText: view.bannerText }
      : {}),
  });
}

/**
 * Publishes one controller revision and returns the reveal span that the next
 * revision must carry. The controller gives action-settled hands a distinct
 * terminal player-turn state; this coordinator then advances that response-local
 * parity projection through the existing dealer-reveal -> settled transition.
 */
export function advanceBlackjackRoomParity(
  instanceId: string,
  view: BlackjackRoomState,
  revealSpan: number | null,
): number | null {
  if (view.handId === null) {
    clearFeltParity(instanceId);
    return null;
  }

  if (view.dealStep === 'dealer-reveal') {
    let nextRevealSpan = revealSpan;
    if (nextRevealSpan === null) {
      const snapshot = getParitySnapshot('blackjack-3d');
      if (!snapshot || snapshot.instanceId !== instanceId) {
        // A natural may settle before this Canvas ever owned the surface.
        // Seed the entitlement-safe hole state so beginTransition() can bind.
        publishFeltParity(
          instanceId,
          buildBlackjackRoomParity(view, 'hole', 'idle'),
        );
      }
      nextRevealSpan = beginTransition(
        instanceId,
        'blackjack-3d',
        'revealing',
      );
    }
    publishFeltParity(
      instanceId,
      buildBlackjackRoomParity(view, 'dealer-reveal', 'revealing'),
    );
    return nextRevealSpan;
  }

  if (view.dealStep === 'settled') {
    let nextRevealSpan = revealSpan;
    if (nextRevealSpan === null) {
      const snapshot = getParitySnapshot('blackjack-3d');
      if (!snapshot || snapshot.instanceId !== instanceId) {
        publishFeltParity(
          instanceId,
          buildBlackjackRoomParity(view, 'hole', 'idle'),
        );
      }
      nextRevealSpan = beginTransition(
        instanceId,
        'blackjack-3d',
        'revealing',
      );
    }
    publishFeltParity(
      instanceId,
      buildBlackjackRoomParity(view, 'settled', 'revealing'),
    );
    completeTransition(instanceId, 'blackjack-3d', nextRevealSpan);
    return null;
  }

  publishFeltParity(instanceId, buildBlackjackRoomParity(view));
  return revealSpan;
}
