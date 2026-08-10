/**
 * Land gamification P4b — the material ledger.
 *
 * Materials are the land loop's build currency. They are NOT vCLAW and share
 * none of its machinery:
 *   - ONE pooled balance per avatar (founder ruling Q4). Flavour names exist on
 *     the salvage receipt for display only and never split the balance.
 *   - Non-fungible with vCLAW, non-transferable between avatars, sink-only.
 *     There is no exit rail and no leaderboard weight (Q11).
 *   - Earned by land quests and (later) seabed salvage; spent only into home
 *     kit pieces.
 *
 * Every write goes through `creditMaterials` / `debitMaterials`
 * (`apps/api/src/services/material-ledger.ts`) — never a direct UPDATE — for the
 * same reason `avatars.clawTokens` is ledger-only.
 *
 * Migration: `0053_land_materials.sql`.
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
  date,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { avatars } from './avatars';

export const avatarMaterialBalances = pgTable(
  'avatar_material_balances',
  {
    avatarId: uuid('avatar_id')
      .primaryKey()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** The single pooled balance. Never negative (DB CHECK + conditional decrement). */
    quantity: integer('quantity').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    nonNeg: check('avatar_material_nonneg', sql`${t.quantity} >= 0`),
  }),
);

/**
 * Per-claim idempotency receipt for the seabed-salvage loop.
 *
 * Ships ahead of the salvage routes so the receipt contract is frozen before
 * any claim path writes to it. `fingerprint` is the STABLE canonical request
 * (`sha256(avatarId | nodeId | layoutVersion)`); a replayed idempotency key
 * whose fingerprint matches replays `response` verbatim, and a mismatch is a
 * conflict. `claimOrdinal` is server-derived after the cooldown check, so it is
 * recorded for audit and never compared.
 */
export const salvageClaimReceipts = pgTable(
  'salvage_claim_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    nodeId: text('node_id').notNull(),
    layoutVersion: integer('layout_version').notNull(),
    /** Recorded for audit, NEVER compared on replay. */
    claimOrdinal: integer('claim_ordinal').notNull(),
    materialsGranted: integer('materials_granted').notNull(),
    /** Display flavour only — one pooled balance (Q4). */
    flavour: text('flavour').notNull(),
    response: jsonb('response').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    uniq: uniqueIndex('salvage_receipt_uniq').on(t.avatarId, t.idempotencyKey),
    history: index('salvage_receipt_history').on(t.avatarId, t.createdAt.desc()),
    amount: check(
      'salvage_receipt_amount',
      sql`${t.materialsGranted} BETWEEN 1 AND 3`,
    ),
    flavourValid: check(
      'salvage_receipt_flavour',
      sql`${t.flavour} IN ('common', 'uncommon', 'rare')`,
    ),
  }),
);

export type AvatarMaterialBalance = typeof avatarMaterialBalances.$inferSelect;
export type SalvageClaimReceipt = typeof salvageClaimReceipts.$inferSelect;

// ---------------------------------------------------------------------------
// Land gamification P7a — the seabed-salvage claim core.
// Migration: `0056_salvage_nodes.sql`.
// ---------------------------------------------------------------------------

/**
 * Per-`(avatar, node)` cooldown state and the monotonic claim ordinal.
 *
 * `claimOrdinal` is an input to the HMAC yield, so it must never be reset or
 * reused — repeating an ordinal repeats a yield, which is how a deterministic
 * reward becomes a farmable one.
 */
export const salvageNodeClaims = pgTable(
  'salvage_node_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),
    layoutVersion: integer('layout_version').notNull(),
    claimOrdinal: integer('claim_ordinal').notNull().default(0),
    lastClaimedAt: timestamp('last_claimed_at', { withTimezone: true }).notNull(),
    nextClaimAt: timestamp('next_claim_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    uniq: uniqueIndex('salvage_node_claims_uniq').on(t.avatarId, t.nodeId),
    ready: index('salvage_node_claims_ready').on(t.avatarId, t.nextClaimAt),
    ordNonNeg: check('salvage_node_claims_ord_nonneg', sql`${t.claimOrdinal} >= 0`),
  }),
);

/** Per-avatar UTC-day admission counters. Both caps enforced by conditional upsert. */
export const salvageDailyAdmissions = pgTable(
  'salvage_daily_admissions',
  {
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    utcDay: date('utc_day').notNull(),
    claimsAdmitted: integer('claims_admitted').notNull().default(0),
    materialsIssued: integer('materials_issued').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ name: 'salvage_daily_pk', columns: [t.avatarId, t.utcDay] }),
    cap: check('salvage_daily_cap', sql`${t.claimsAdmitted} BETWEEN 0 AND 20`),
    matCap: check('salvage_daily_mat_cap', sql`${t.materialsIssued} BETWEEN 0 AND 60`),
  }),
);

/**
 * Per-OWNER UTC-day claim counter — the anti-fleet-farm bound.
 *
 * `ownerKind` is single-valued ('user') on purpose: `platform_agents.user_id` is
 * NOT NULL, so every admissible agent resolves to a user principal and shares
 * that principal's budget. An unbound session gets no bucket, it gets refused.
 */
export const salvageOwnerAdmissions = pgTable(
  'salvage_owner_admissions',
  {
    ownerKind: text('owner_kind').notNull(),
    ownerId: uuid('owner_id').notNull(),
    utcDay: date('utc_day').notNull(),
    claimsAdmitted: integer('claims_admitted').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({
      name: 'salvage_owner_pk',
      columns: [t.ownerKind, t.ownerId, t.utcDay],
    }),
    kind: check('salvage_owner_kind', sql`${t.ownerKind} = 'user'`),
    cap: check('salvage_owner_cap', sql`${t.claimsAdmitted} BETWEEN 0 AND 120`),
  }),
);

export type SalvageNodeClaim = typeof salvageNodeClaims.$inferSelect;
export type SalvageDailyAdmission = typeof salvageDailyAdmissions.$inferSelect;
export type SalvageOwnerAdmission = typeof salvageOwnerAdmissions.$inferSelect;
