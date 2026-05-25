/**
 * Phase 6.4.0 — frontend re-export shim for blackjack types.
 *
 * Canonical home is `@clawville/shared` (`packages/shared/src/types/cove-blackjack.ts`).
 * Components/clients in `apps/web` import from here so existing import paths
 * keep working; this file is a thin alias to the shared package.
 */

export {
  BLACKJACK_SUITS,
  BLACKJACK_RANKS,
  COVE_BLACKJACK_MIN_BET,
  COVE_BLACKJACK_MAX_BET,
} from '@clawville/shared';
export type {
  BlackjackSuit,
  BlackjackRank,
  BlackjackCard,
  BlackjackOutcome,
  PlayMockHandResponse,
} from '@clawville/shared';
