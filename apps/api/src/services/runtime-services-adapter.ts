/**
 * Runtime Services Adapter (concern 1c, audit fix #4)
 *
 * The agent-runtime package's action handlers call ledger services with the
 * legacy `{ avatarId, ... }` shape — the runtime types still use `avatarId` because
 * concern 1h hasn't flipped agent-runtime yet. apps/api's `creditClawTokens`
 * / `debitClawTokens` impls expect `{ avatarId, ... }` (post-1b schema).
 *
 * Pre-fix, every call site cast its services bag with
 * `as unknown as ClawvilleServices`, which silenced the type mismatch but
 * caused a real runtime failure: every economic action threw
 * `avatar undefined not found` because `params.avatarId` was undefined.
 *
 * This adapter does the literal field translation at the boundary so the
 * action handlers see their expected shape and the ledger sees its expected
 * shape, with full type safety on both ends.
 *
 * Once concern 1h renames AvatarStateStore→AvatarStateStore + the action types
 * avatarId→avatarId, this adapter becomes a no-op pass-through and can be
 * inlined back to a plain object literal.
 */

import type { ClawvilleServices } from '@clawville/agent-runtime';
import {
  creditClawTokens as ledgerCreditClawTokens,
  debitClawTokens as ledgerDebitClawTokens,
  type ClawTokenSource,
} from './claw-token-ledger';

// Drizzle db handle is `any` on the runtime side (intentional — see
// SimulationServices in agent-runtime/src/simulation/simulation-runtime.ts).
// We keep the type at the call boundary as `any` to avoid forcing every
// caller through a specific Drizzle generic.
//
// The adapter only translates the function parameters — `db` passes through
// unchanged.
export function buildRuntimeServices(db: any): ClawvilleServices {
  return {
    db,
    creditClawTokens: async (params) => {
      // The runtime spec has `metadata: Record<string, any>` (always present
      // and required); the ledger has `metadata?: Record<string, unknown>`
      // (optional). Either shape works at the ledger; pass through verbatim.
      return ledgerCreditClawTokens({
        avatarId: params.avatarId,
        amount: params.amount,
        reason: params.reason,
          // Runtime emits source values that aren't in the ledger's enum
        // (e.g. 'shop' from BUY_ITEM action, 'bazaar' from BUY_BAZAAR_LISTING).
        // Map runtime-only values to 'simulation' since these are all driven
        // by the autonomous-avatar simulator. ClawTokenSource enum is enforced
        // at the Postgres level (claw_token_source pgEnum) — passing 'shop'
        // would throw `invalid input value for enum`. The semantic is correct:
        // from the ledger's perspective these are simulation-originated tx.
        source: mapRuntimeSourceToLedger(params.source),
        metadata: params.metadata,
      });
    },
    debitClawTokens: async (params) => {
      return ledgerDebitClawTokens({
        avatarId: params.avatarId,
        amount: params.amount,
        reason: params.reason,
        source: mapRuntimeSourceToLedger(params.source),
        metadata: params.metadata,
      });
    },
  };
}

/**
 * Translate runtime-emitted source strings to the ledger's enforced enum.
 * Runtime actions (e.g. BUY_ITEM, BUY_BAZAAR_LISTING) emit free-form labels
 * like 'shop', 'bazaar'. Postgres claw_token_source enum only knows the
 * values listed in ClawTokenSource. Anything originating from the autonomous
 * planner is conceptually 'simulation' for ledger-attribution purposes.
 */
function mapRuntimeSourceToLedger(source: string): ClawTokenSource {
  const known: readonly ClawTokenSource[] = [
    'api', 'simulation', 'quest', 'bounty',
    'daily_login', 'admin', 'x402', 'system',
  ];
  if ((known as readonly string[]).includes(source)) {
    return source as ClawTokenSource;
  }
  // 'shop', 'bazaar', or any other runtime-action label → 'simulation'
  return 'simulation';
}
