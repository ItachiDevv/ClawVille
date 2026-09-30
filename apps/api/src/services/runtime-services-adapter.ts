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
 *
 * COVENANT ATTRIBUTION (2026-07-13): this adapter is also the actor-kind
 * seam for the covenant action-record stream. Each call site declares WHO
 * drives actions on the runtime it is building services for ('human' when a
 * Lucia-cookie user chats through a runtime, 'agent' for autonomous/hosted/
 * connected surfaces) and every ledger call + explicit action record flowing
 * through these services carries that attribution. Omitted → unattributed
 * (never guessed).
 */

import type { ClawvilleServices } from '@clawville/agent-runtime';
import { sql } from 'drizzle-orm';
import {
  creditClawTokens as ledgerCreditClawTokens,
  debitClawTokens as ledgerDebitClawTokens,
  type ClawTokenSource,
} from './claw-token-ledger';
import {
  recordCovenantAction,
  type CovenantAction,
  type CovenantActorKind,
} from './covenant-action-recorder';

// Drizzle db handle is `any` on the runtime side (intentional — see
// SimulationServices in agent-runtime/src/simulation/simulation-runtime.ts).
// We keep the type at the call boundary as `any` to avoid forcing every
// caller through a specific Drizzle generic.
//
// The adapter only translates the function `source` field — `db` passes
// through unchanged.
export function buildRuntimeServices(
  db: any,
  opts?: { actorKind?: CovenantActorKind | null; doordash?: unknown },
): ClawvilleServices {
  const actorKind = opts?.actorKind ?? null;
  return {
    db,
    doordash: opts?.doordash,
    creditClawTokens: async (params, tx) => {
      await refuseGuestLedgerSubject(tx ?? db, params.avatarId);
      // The runtime spec has `metadata: Record<string, any>` (always present
      // and required); the ledger has `metadata?: Record<string, unknown>`
      // (optional). Either shape works at the ledger; pass through verbatim.
      return ledgerCreditClawTokens(
        {
          avatarId: params.avatarId,
          amount: params.amount,
          reason: params.reason,
          source: mapRuntimeSourceToLedger(params.source),
          metadata: params.metadata,
          actorKind,
        },
        tx,
      );
    },
    debitClawTokens: async (params, tx) => {
      await refuseGuestLedgerSubject(tx ?? db, params.avatarId);
      return ledgerDebitClawTokens(
        {
          avatarId: params.avatarId,
          amount: params.amount,
          reason: params.reason,
          source: mapRuntimeSourceToLedger(params.source),
          metadata: params.metadata,
          actorKind,
        },
        tx,
      );
    },
    recordCovenantAction: async (params, tx) => {
      return recordCovenantAction(
        {
          // The runtime side types `action` as a plain string (it never
          // imports apps/api); the recorder's union is the authority.
          action: params.action as CovenantAction,
          subjectType: params.subjectType,
          subjectId: params.subjectId,
          // The surface's attribution wins; a handler may not re-attribute.
          actorKind,
          payload: params.payload,
        },
        tx,
      );
    },
  };
}

/**
 * GUEST BACKSTOP (security M9 + Codex round 2, 2026-09-30). A guest runs a DEMO
 * economy that settles off the ledger. The runtime ledger services refuse any
 * credit or debit whose avatar belongs to a guest (canonical `users.is_guest`),
 * decided HERE on every call, so no surface that builds these services can
 * forget the guard (callers: chat.ts, avatars.ts, agent-gateway.ts, openclaw.ts,
 * avatar-simulation-bridge.ts). An id that is not an avatar (e.g. an
 * openclaw_bots id) is left to the ledger, which refuses an unknown avatar.
 */
async function refuseGuestLedgerSubject(db: any, avatarId: string): Promise<void> {
  const rows = (await db.execute(
    sql`SELECT u.is_guest AS is_guest
        FROM avatars a JOIN users u ON u.id = a.user_id
        WHERE a.id = ${avatarId}`,
  )) as Array<{ is_guest: boolean | null }>;
  if (rows[0]?.is_guest === true) {
    throw new Error('guest_demo_economy: a guest account cannot move real vCLAW through the ledger');
  }
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
