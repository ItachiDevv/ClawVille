import {
  pgTable,
  uuid,
  varchar,
  numeric,
  integer,
  timestamp,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { avatars } from './avatars';
import { bounties } from './bounties';

/**
 * Tier-1 USDC bounty backing. This is a reservation against the poster's
 * custodial wallet, not custody and not an on-chain escrow.
 */
export const bountyUsdcHolds = pgTable(
  'bounty_usdc_holds',
  {
    bountyId: uuid('bounty_id')
      .primaryKey()
      .references(() => bounties.id, { onDelete: 'restrict' }),
    posterAvatarId: uuid('poster_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'restrict' }),
    /** Exact USDC base units (6 decimals). */
    amountBaseUnits: numeric('amount_base_units', { precision: 20, scale: 0 }).notNull(),
    /** Durable generation for bounded settlement attempts (1 is the original key). */
    settlementAttempt: integer('settlement_attempt').notNull().default(1),
    status: varchar('status', { length: 16 }).notNull().default('open'),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    posterOpenIdx: index('bounty_usdc_holds_poster_open_idx')
      .on(t.posterAvatarId, t.createdAt)
      .where(sql`${t.status} = 'open'`),
    amountPositive: check(
      'bounty_usdc_holds_amount_positive',
      sql`${t.amountBaseUnits} > 0`,
    ),
    settlementAttemptBounded: check(
      'bounty_usdc_holds_settlement_attempt_bounded',
      sql`${t.settlementAttempt} BETWEEN 1 AND 5`,
    ),
    statusValid: check(
      'bounty_usdc_holds_status_valid',
      sql`${t.status} IN ('open', 'settled', 'released')`,
    ),
    releaseStamp: check(
      'bounty_usdc_holds_release_stamp',
      sql`(${t.status} = 'open') = (${t.releasedAt} IS NULL)`,
    ),
  }),
);

export type BountyUsdcHold = typeof bountyUsdcHolds.$inferSelect;
export type NewBountyUsdcHold = typeof bountyUsdcHolds.$inferInsert;
