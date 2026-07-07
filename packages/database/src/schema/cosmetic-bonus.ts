/**
 * Cosmetics-scoped signup bonus (Tokenomics Phase A / Slice A2, 2026-07-07).
 *
 * ── WHY A SEPARATE TABLE, NOT avatars.clawTokens ─────────────────────────────
 * The founder's one-time signup bonus must be spendable ONLY in the cosmetic
 * shop. If it were credited to the normal CT balance (`avatars.clawTokens` /
 * `soft_balance`) it would be spendable EVERYWHERE (cove, land, …) — not
 * cosmetics-scoped. And the F1 provenance CHECK
 * (`claw_tokens = soft + bought + earned`) means any real-CT credit must land in
 * one of those three tag buckets. So the bonus lives in its OWN scoped ledger,
 * entirely OUTSIDE `avatars.clawTokens`: the F1 CHECK is TRIVIALLY intact (this
 * table is never referenced by it), and the "never write avatars.clawTokens
 * directly" rule is honoured because the grant never touches that column at all.
 * It is SOFT-class semantics (non-cashable promo the house eats) but tracked
 * here, not in the provenance sum. This is the "scoped-grant table consulted by
 * the cosmetics buy path" option the founder offered.
 *
 * ── IDEMPOTENCY ──────────────────────────────────────────────────────────────
 * `user_id` is UNIQUE — the one-time grant is idempotent BY CONSTRUCTION
 * (INSERT … ON CONFLICT (user_id) DO NOTHING). Not best-effort.
 *
 * ── SPEND ────────────────────────────────────────────────────────────────────
 * The cosmetics buy path row-locks (FOR UPDATE) this grant, draws
 * `min(amount_remaining, price_ct)` toward the purchase, and decrements
 * `amount_remaining`. Only the REAL-CT remainder is debited from the buyer and
 * routed to the treasury (conservation: the grant portion is a house-eaten promo
 * that mints nothing into the treasury). The CHECK keeps `amount_remaining` in
 * `[0, amount_granted]` as defense-in-depth against a buggy decrement.
 */

import { pgTable, uuid, integer, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { avatars } from './avatars';

export const cosmeticBonusGrants = pgTable(
  'cosmetic_bonus_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** One grant per user — UNIQUE is the idempotency guard. */
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The avatar the cosmetics are bought on (the shop is avatar-scoped). */
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** Original grant amount (audit; never mutated after creation except the ×10 redenomination). */
    amountGranted: integer('amount_granted').notNull(),
    /** Unspent balance — decremented by the cosmetics buy path. */
    amountRemaining: integer('amount_remaining').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Defense-in-depth: remaining can never go negative or exceed the grant.
    remainingValid: check(
      'cosmetic_bonus_remaining_valid',
      sql`${t.amountRemaining} >= 0 AND ${t.amountRemaining} <= ${t.amountGranted}`,
    ),
  }),
);
