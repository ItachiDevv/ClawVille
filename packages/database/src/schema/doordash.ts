import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * DoorDash Phase 2 order ledger. Operator-only: the single enabled account is
 * the founder's, and the CLI beta terms cap it there.
 *
 * This table is the source of truth for the spend caps and for the confirm
 * protocol. Reading caps from the database rather than memory is deliberate —
 * a container restart must not hand back a fresh daily allowance.
 *
 * Column-level privacy rules live in migrations/0066_doordash_orders.sql.
 */
export const doordashOrders = pgTable(
  'doordash_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Lucia user id of the operator. Text to match the users table key type. */
    userId: text('user_id').notNull(),
    avatarId: uuid('avatar_id'),
    /** 'human' | 'agent' — which path prepared the order. Only 'human' may submit. */
    subjectKind: text('subject_kind').notNull(),
    cartUuid: text('cart_uuid').notNull(),
    /** Present only once DoorDash has accepted the order. */
    orderUuid: text('order_uuid'),
    /** previewed | submitting | submitted | failed | refused */
    status: text('status').notNull(),
    /** Priced total BEFORE tip, in cents, as quoted by `order preview`. */
    totalCents: integer('total_cents').notNull(),
    /** Tip the HUMAN gave at confirm time. Never defaulted, never model-chosen. */
    tipCents: integer('tip_cents').notNull().default(0),
    /** sha256 hex of the uppercased confirm code. Never the code itself. */
    confirmCodeHash: text('confirm_code_hash').notNull(),
    previewedAt: timestamp('previewed_at', { withTimezone: true }).defaultNow().notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    failureCode: text('failure_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orderUuidKey: uniqueIndex('doordash_orders_order_uuid_key')
      .on(t.orderUuid)
      .where(sql`${t.orderUuid} IS NOT NULL`),
    userDayIdx: index('doordash_orders_user_day_idx').on(t.userId, t.confirmedAt),
    userPreviewedIdx: index('doordash_orders_user_previewed_idx')
      .on(t.userId, t.previewedAt)
      .where(sql`${t.status} = 'previewed'`),
  }),
);

export type DoordashOrderRow = typeof doordashOrders.$inferSelect;
