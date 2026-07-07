/**
 * Runtime Services Adapter
 *
 * Wraps the apps/api ledger functions so they can be injected into
 * agent-runtime's `ClawvilleServices` slot. After concern 1h, the
 * runtime now uses `avatarId` natively, so the only translation
 * remaining at this boundary is mapping runtime-emitted source labels
 * (e.g. `'shop'` from BUY_ITEM) to the ledger's enforced
 * `ClawTokenSource` enum — those values are NOT in the Postgres
 * `claw_token_source` enum and would throw `invalid input value for
 * enum` if passed through unchanged.
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
// The adapter only translates the function `source` field — `db` passes
// through unchanged.
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
 * Runtime actions (e.g. BUY_ITEM) emit free-form labels like 'shop'.
 * Postgres claw_token_source enum only knows the values listed in
 * ClawTokenSource. Anything originating from the autonomous planner is
 * conceptually 'simulation' for ledger-attribution purposes.
 */
function mapRuntimeSourceToLedger(source: string): ClawTokenSource {
  const known: readonly ClawTokenSource[] = [
    'api', 'simulation', 'quest', 'bounty',
    'daily_login', 'admin', 'x402', 'system',
  ];
  if ((known as readonly string[]).includes(source)) {
    return source as ClawTokenSource;
  }
  // 'shop', or any other runtime-action label → 'simulation'
  return 'simulation';
}
