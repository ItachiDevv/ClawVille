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
 * (never guessed). The one exception is the treasury credit inside
 * `chargeBookPurchase`: a T0 house fee is always attributed to 'system', exactly
 * like the REST fee sites (the buyer debit in the same op keeps the surface's).
 */

import type { ClawvilleServices } from '@clawville/agent-runtime';
import { getBookById } from '@clawville/shared';
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
import { getHouseTreasuryAvatarId } from './house-treasury-seeder';

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
    chargeBookPurchase: async (params, tx) => {
      // ONE book-purchase charge for runtime BUY_ITEM (security batch 2,
      // 2026-10-02): the buyer debit and the T0 treasury credit are written
      // together, so no runtime code can credit the treasury without the
      // matching debit. A charge outside the caller's tx could survive a
      // rolled-back inventory grant, so the tx is mandatory.
      if (!tx) {
        throw new Error('book_purchase_charge: the charge must run in the caller transaction');
      }
      // An invalid amount THROWS (never a silent skip): a fractional amount would
      // debit the buyer but fail the treasury credit, and a string amount is not
      // a price at all.
      const amount: unknown = params.amount;
      if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
        throw new Error(`book_purchase_charge: invalid amount ${String(amount)} (must be a positive safe integer)`);
      }
      const book = getBookById(params.bookId);
      if (!book) {
        throw new Error(`book_purchase_charge: unknown book ${params.bookId}`);
      }
      if (book.price !== amount) {
        throw new Error(`book_purchase_charge: amount ${amount} is not the catalog price ${book.price} of ${book.id}`);
      }
      // Demo money never moves through the ledger (same guard the generic
      // debit applies, on the tx connection).
      await refuseGuestLedgerSubject(tx, params.avatarId);
      // Buyer debit: the SAME row the runtime BUY_ITEM debit wrote before this op
      // existed (reason, runtime source 'shop' -> ledger enum, metadata, and the
      // surface's actor kind).
      const debit = await ledgerDebitClawTokens(
        {
          avatarId: params.avatarId,
          amount,
          reason: `Purchased book: ${book.name}`,
          source: mapRuntimeSourceToLedger('shop'),
          metadata: { bookId: book.id, buildingId: book.building },
          actorKind,
        },
        tx,
      );
      // Treasury credit: the SAME row the REST shop writes (`routes/items.ts`
      // step 1b). A null treasury degrades to the logged pre-T0 burn, like REST.
      const treasuryId = await getHouseTreasuryAvatarId();
      if (!treasuryId) {
        console.error(
          `[runtime BUY_ITEM] house treasury unavailable — ${amount} CT book purchase burned (pre-T0 behavior) for book ${book.id}`,
        );
        return { balanceAfter: debit.balanceAfter, treasuryAvatarId: null };
      }
      // Attribution is 'system' like every T0 fee site, not the surface's
      // actor: the house, not the buyer, receives the fee.
      await ledgerCreditClawTokens(
        {
          avatarId: treasuryId,
          amount,
          reason: 'house_fee_book_purchase',
          source: 'system',
          metadata: { bookId: book.id, buyerAvatarId: params.avatarId },
          actorKind: 'system',
        },
        tx,
      );
      return { balanceAfter: debit.balanceAfter, treasuryAvatarId: treasuryId };
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
 *
 * The INNER JOIN drops no avatar: `avatars.user_id` is NOT NULL with a foreign
 * key to `users(id)` (`packages/database/src/schema/avatars.ts`), so every avatar
 * has exactly one users row and its `is_guest` flag is always read.
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
