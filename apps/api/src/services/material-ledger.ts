/**
 * Material ledger (Land gamification P4b).
 *
 * Materials are the land loop's build currency. Every write to
 * `avatar_material_balances.quantity` MUST go through `creditMaterials()` or
 * `debitMaterials()` — the same rule that makes `claw-token-ledger` the sole
 * writer of `avatars.clawTokens`, for the same reason.
 *
 * ── WHY MATERIALS ARE NOT vCLAW ──────────────────────────────────────────────
 * Materials deliberately share none of the ClawToken machinery:
 *   - ONE pooled balance per avatar (founder ruling Q4). There are no
 *     provenance tags because there is no cashability question to answer:
 *     materials have NO exit rail, are not transferable between avatars, and
 *     are sink-only BY DESIGN through HOME-yard kit-piece placement.
 *   - No leaderboard weight (founder ruling Q11), so no scoring emitter.
 *   - No generic transaction table. Each earn path owns its own durable audit
 *     row — the tutorial claim row for quests, `salvage_claim_receipts` for
 *     salvage — so provenance is reconstructible without a second ledger.
 *
 * ── SERIALIZATION ────────────────────────────────────────────────────────────
 * Two modes, matching `claw-token-ledger`:
 *   - STANDALONE (no `tx`): this module owns the critical section and takes the
 *     full per-subject stack — `withKeyedMutex` (in-process, closes the
 *     same-process window) OUTER, then `pg_advisory_xact_lock` (cross-process)
 *     INNER, inside its own transaction.
 *   - COMPOSED (caller passes `tx`): the CALLER already holds the per-subject
 *     locks in the repo's canonical order (mutex → advisory → row). Re-taking
 *     the in-process mutex here would be a second lock acquired while holding a
 *     DB transaction, so we do not. Correctness does not depend on it: both
 *     primitives below are single atomic statements (an upsert and a
 *     conditional decrement), so concurrent writers serialize on the row itself
 *     regardless of what the caller holds.
 *
 * The debit is a CONDITIONAL DECREMENT (`WHERE quantity >= amount`), not a
 * read-then-write: a spend at balance − 1 refuses without ever writing, and the
 * caller's transaction rolls the rest of the placement back.
 */

// FEATURE_GATE: land_materials_spend_rail — FULLY GRADUATED 2026-08-20 (P7c).
//
// All three player subject paths spend materials through one settlement service:
//   - humans call POST /api/land/parcels/:parcelId/pieces with
//     `paymentRail: 'materials'`;
//   - connected agents call the same authenticated route as their bound avatar;
//   - hosted agents use materials-only `[ACTION: place_kit_piece(...)]`.
// `land-kit-settlement.ts` owns the atomic HOME-only authority, geometry,
// material debit, placement, audit, and idempotency transaction for every path.
// The hosted executor never accepts a payment rail and fixes rotationStep=0
// and ground stackLevel=1. Current reading: 3 of 3 subject paths can earn and spend.
// EARN remains live through Tier-10 land quests and seabed salvage.
// Reference: gamification-pass-2026-08-09.md §2.4/§3.3, §7, Q4/Q11.
//

import { db, sql } from '@clawville/database';
import { withKeyedMutex } from './keyed-mutex';
import type { LedgerTx } from './claw-token-ledger';

/** Where a material movement came from. Recorded by the caller's audit row. */
export type MaterialSource = 'quest' | 'salvage' | 'build' | 'admin' | 'system';

export interface MaterialCreditInput {
  avatarId: string;
  /** Positive integer — materials to add. */
  amount: number;
  /** Short reason string, e.g. 'land_quest', 'salvage_claim'. */
  reason: string;
  source: MaterialSource;
}

export interface MaterialDebitInput {
  avatarId: string;
  /** Positive integer — materials to remove. */
  amount: number;
  reason: string;
  source: MaterialSource;
}

export interface MaterialResult {
  balanceAfter: number;
}

/** Thrown when a debit exceeds the pooled balance. Nothing was written. */
export class InsufficientMaterialsError extends Error {
  constructor(
    public readonly avatarId: string,
    public readonly available: number,
    public readonly requested: number,
  ) {
    super(
      `Insufficient materials: avatar ${avatarId} has ${available}, needs ${requested}`,
    );
    this.name = 'InsufficientMaterialsError';
  }
}

/**
 * Thrown when the avatar row does not exist (FK violation on the balance
 * upsert).
 *
 * CALLER CONSTRAINT — this error is NOT recoverable in COMPOSED mode. By the
 * time this JS catch runs, Postgres has already aborted the surrounding
 * transaction, so a caller that catches it and issues another statement on the
 * same `tx` gets `25P02 current transaction is aborted`. It reads like a
 * recoverable validation error, which is exactly the trap: in composed mode the
 * only correct responses are rethrow or roll back. Every current caller
 * rethrows.
 */
export class UnknownMaterialSubjectError extends Error {
  constructor(public readonly avatarId: string) {
    super(`Material subject not found: avatar ${avatarId}`);
    this.name = 'UnknownMaterialSubjectError';
  }
}

const MUTEX_PREFIX = 'materials:';

function assertPositiveInteger(amount: number, op: 'credit' | 'debit'): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`${op}Materials amount must be a positive integer`);
  }
}

/** Postgres error code off a driver error, including a wrapped `cause`. */
function pgErrorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (err as { cause?: { code?: unknown } }).cause;
  if (cause && typeof cause.code === 'string') return cause.code;
  return null;
}

async function creditInTx(
  tx: LedgerTx,
  input: MaterialCreditInput,
): Promise<MaterialResult> {
  try {
    const rows = await tx.execute<{ quantity: number | string }>(
      sql`INSERT INTO avatar_material_balances (avatar_id, quantity, updated_at)
          VALUES (${input.avatarId}, ${input.amount}, now())
          ON CONFLICT (avatar_id) DO UPDATE
            SET quantity = avatar_material_balances.quantity + ${input.amount},
                updated_at = now()
          RETURNING quantity`,
    );
    const row = Array.from(rows)[0];
    if (!row) {
      throw new Error(`creditMaterials: balance upsert returned no row for ${input.avatarId}`);
    }
    return { balanceAfter: Number(row.quantity) };
  } catch (err) {
    // 23503 = foreign_key_violation — the avatar does not exist. Surfaced as a
    // named error so callers never mistake it for a transient DB fault.
    if (pgErrorCode(err) === '23503') {
      throw new UnknownMaterialSubjectError(input.avatarId);
    }
    throw err;
  }
}

async function debitInTx(
  tx: LedgerTx,
  input: MaterialDebitInput,
): Promise<MaterialResult> {
  // Conditional decrement: the guard lives in the WHERE clause, so an
  // insufficient balance writes NOTHING and the caller's transaction is still
  // healthy enough to roll back the rest of the operation cleanly.
  const rows = await tx.execute<{ quantity: number | string }>(
    sql`UPDATE avatar_material_balances
        SET quantity = quantity - ${input.amount}, updated_at = now()
        WHERE avatar_id = ${input.avatarId} AND quantity >= ${input.amount}
        RETURNING quantity`,
  );
  const row = Array.from(rows)[0];
  if (row) return { balanceAfter: Number(row.quantity) };

  // Refused. Re-read to report the real available balance (a missing row is a
  // zero balance — the row is created lazily on first credit).
  const current = await readMaterialBalance(input.avatarId, tx);
  throw new InsufficientMaterialsError(input.avatarId, current, input.amount);
}

/**
 * Add materials to an avatar's pooled balance.
 *
 * Pass `tx` to compose into a larger atomic block (a quest claim credits
 * materials and inserts its claim row in ONE transaction). Without `tx` this
 * opens its own transaction under the full per-subject lock stack.
 */
export async function creditMaterials(
  input: MaterialCreditInput,
  tx?: LedgerTx,
): Promise<MaterialResult> {
  assertPositiveInteger(input.amount, 'credit');
  if (tx) return creditInTx(tx, input);
  return withKeyedMutex(`${MUTEX_PREFIX}${input.avatarId}`, () =>
    db.transaction(async (innerTx) => {
      await innerTx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.avatarId}, 0))`,
      );
      return creditInTx(innerTx, input);
    }),
  );
}

/**
 * Remove materials from an avatar's pooled balance.
 *
 * Throws `InsufficientMaterialsError` without writing when the balance is too
 * low. Pass `tx` to compose into the spending operation so a later failure
 * refunds by rollback rather than by a compensating credit.
 */
export async function debitMaterials(
  input: MaterialDebitInput,
  tx?: LedgerTx,
): Promise<MaterialResult> {
  assertPositiveInteger(input.amount, 'debit');
  if (tx) return debitInTx(tx, input);
  return withKeyedMutex(`${MUTEX_PREFIX}${input.avatarId}`, () =>
    db.transaction(async (innerTx) => {
      await innerTx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.avatarId}, 0))`,
      );
      return debitInTx(innerTx, input);
    }),
  );
}

/**
 * Read the pooled balance. An avatar with no row has never earned a material,
 * which is a balance of zero — not an error.
 */
export async function readMaterialBalance(
  avatarId: string,
  tx?: LedgerTx,
): Promise<number> {
  const runner = tx ?? db;
  const rows = await runner.execute<{ quantity: number | string }>(
    sql`SELECT quantity FROM avatar_material_balances WHERE avatar_id = ${avatarId}`,
  );
  const row = Array.from(rows)[0];
  return row ? Number(row.quantity) : 0;
}
