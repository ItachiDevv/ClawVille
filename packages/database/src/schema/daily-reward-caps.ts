/**
 * Durable per-avatar daily faucet counters (security pass, founder decision
 * 2026-10-04; migration 0077). One row per (avatar, UTC day, kind). `used` is
 * the vCLAW (or paid turns) already granted today; `last_granted` is the amount
 * the most recent claim granted, which lets one INSERT ... ON CONFLICT DO UPDATE
 * statement return the granted amount atomically (Postgres 17 RETURNING cannot
 * read the pre-update row). Written ONLY by
 * `apps/api/src/services/daily-reward-cap.ts`, inside the same transaction as
 * the ledger credit. Caps live in `@clawville/shared` DAILY_REWARD_CAPS.
 */

import {
  check,
  date,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { avatars } from './avatars';

export const dailyRewardCaps = pgTable(
  'daily_reward_caps',
  {
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    rewardDay: date('reward_day', { mode: 'string' }).notNull(),
    kind: text('kind').notNull(),
    used: integer('used').notNull().default(0),
    lastGranted: integer('last_granted').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({
      name: 'daily_reward_caps_pkey',
      columns: [t.avatarId, t.rewardDay, t.kind],
    }),
    kindCheck: check(
      'daily_reward_caps_kind_check',
      sql`${t.kind} IN ('building_visit', 'nori_chat', 'activity')`,
    ),
    amountsCheck: check(
      'daily_reward_caps_amounts_check',
      sql`${t.used} >= 0 AND ${t.lastGranted} >= 0`,
    ),
  }),
);

export type DailyRewardCap = typeof dailyRewardCaps.$inferSelect;
export type NewDailyRewardCap = typeof dailyRewardCaps.$inferInsert;
