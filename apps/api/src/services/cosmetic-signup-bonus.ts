/**
 * Cosmetics-scoped signup bonus (Tokenomics Phase A / Slice A2, 2026-07-07).
 *
 * One-time, per-user, spendable ONLY in the cosmetic shop. See
 * `schema/cosmetic-bonus.ts` for the WHY-a-separate-table rationale.
 *
 * ── DESIGN DECISION (founder: "pick the design that keeps the F1 CHECK intact
 *    and document why") ────────────────────────────────────────────────────────
 * The grant is NOT credited through `claw-token-ledger`'s credit API, even though
 * the founder's default is "provenance SOFT via the ledger's credit API". Reason:
 * a ledger SOFT credit lands in `avatars.soft_balance` (part of `claw_tokens`),
 * which is spendable EVERYWHERE — that directly contradicts "spendable ONLY in the
 * cosmetic shop". The two requirements are mutually exclusive, so the scoping
 * requirement wins: the grant lives in its OWN table (`cosmetic_bonus_grants`),
 * entirely outside `avatars.clawTokens`. Consequences:
 *   - the F1 provenance CHECK (`claw_tokens = soft + bought + earned`) is
 *     TRIVIALLY intact — this table is never in that sum;
 *   - "never write avatars.clawTokens directly" is honoured — we never touch it;
 *   - it is SOFT-class semantics (non-cashable promo the house eats), tracked
 *     here, not in the provenance sum.
 *
 * ── CONSERVATION on spend ────────────────────────────────────────────────────
 * The cosmetics buy path draws the grant FIRST, then debits only the REAL-CT
 * remainder from the buyer and routes only that remainder to the treasury. The
 * grant portion mints NOTHING into the treasury — it is a marketing expense the
 * house absorbs (exactly what a signup bonus is). Supply is conserved: real CT
 * debited == real CT credited to the treasury; the grant is a separate scoped
 * decrement that never enters CT supply.
 */

import { db, cosmeticBonusGrants, sql } from '@clawville/database';

/**
 * The one-time signup bonus, in vCLAW units. Founder-set 2026-07-07: $5 of
 * cosmetics-only promo credit. Value is 50 in the PRE-redenomination ($0.10/CT)
 * era this slice ships into; the A3 ¢-peg ×10 redenomination BUMPS this constant
 * to 500 AND multiplies existing grant rows ×10, so the final state is 500
 * post-redenomination units (= $5 at the $0.01 peg). See migration
 * 0011_redenominate_ct_x10.sql.
 */
export const SIGNUP_BONUS_COSMETIC_CT = 50;

/** Drizzle transaction type — lets callers compose into a larger atomic block. */
type LedgerTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Grant the one-time cosmetics signup bonus to a user. Idempotent BY CONSTRUCTION
 * — the UNIQUE(user_id) index + `ON CONFLICT DO NOTHING` means a second call (or a
 * concurrent race) is a silent no-op, never a double grant. Returns whether THIS
 * call created the grant. NEVER touches `avatars.clawTokens`.
 *
 * Guests get nothing (demo stays demo): callers only invoke this on real
 * (non-guest) account creation. Non-fatal at the call site — a failure here must
 * never abort account creation.
 */
export async function ensureCosmeticSignupBonus(
  input: { userId: string; avatarId: string },
  tx?: LedgerTx,
): Promise<{ granted: boolean }> {
  const runner = tx ?? db;
  const inserted = await runner
    .insert(cosmeticBonusGrants)
    .values({
      userId: input.userId,
      avatarId: input.avatarId,
      amountGranted: SIGNUP_BONUS_COSMETIC_CT,
      amountRemaining: SIGNUP_BONUS_COSMETIC_CT,
    })
    .onConflictDoNothing({ target: cosmeticBonusGrants.userId })
    .returning({ id: cosmeticBonusGrants.id });
  return { granted: inserted.length > 0 };
}

/**
 * Pure spend allocator: how much of a `priceCt` purchase the grant covers, and
 * the real-CT remainder the buyer pays. `grantUsed = min(priceCt, grantRemaining)`
 * (clamped non-negative). Extracted for unit-testing the money split.
 */
export function allocateCosmeticSpend(
  priceCt: number,
  grantRemaining: number,
): { grantUsed: number; realCt: number } {
  const grantUsed = Math.max(0, Math.min(priceCt, Math.max(0, grantRemaining)));
  return { grantUsed, realCt: priceCt - grantUsed };
}

/**
 * Draw up to `maxSpend` from the user's cosmetic-bonus grant, under a row lock
 * (FOR UPDATE), decrementing `amount_remaining`. Returns the amount actually
 * drawn (0 when the user has no grant / it's empty / maxSpend ≤ 0). MUST run
 * inside the same transaction as the cosmetics purchase so the draw and the
 * avatar_skins insert commit together.
 */
export async function spendCosmeticBonusInTx(
  tx: LedgerTx,
  userId: string,
  maxSpend: number,
): Promise<number> {
  if (!Number.isInteger(maxSpend) || maxSpend <= 0) return 0;

  const rows = await tx.execute<{ id: string; amount_remaining: number }>(
    sql`SELECT id, amount_remaining FROM cosmetic_bonus_grants
        WHERE user_id = ${userId} FOR UPDATE`,
  );
  const row = rows[0];
  if (!row) return 0;

  const { grantUsed } = allocateCosmeticSpend(maxSpend, Number(row.amount_remaining));
  if (grantUsed <= 0) return 0;

  await tx.execute(
    sql`UPDATE cosmetic_bonus_grants
        SET amount_remaining = amount_remaining - ${grantUsed}, updated_at = now()
        WHERE id = ${row.id}`,
  );
  return grantUsed;
}

/** Read a user's remaining cosmetic-bonus balance (0 when no grant). Pure read. */
export async function getCosmeticBonusRemaining(userId: string): Promise<number> {
  const rows = await db.execute<{ amount_remaining: number }>(
    sql`SELECT amount_remaining FROM cosmetic_bonus_grants WHERE user_id = ${userId}`,
  );
  return rows[0] ? Number(rows[0].amount_remaining) : 0;
}
