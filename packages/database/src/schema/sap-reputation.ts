/** Durable house-signed SAP reputation jobs for verified composed bounties. */

import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { avatars } from './avatars';
import { bounties } from './bounties';

export const SAP_REPUTATION_JOB_STATUSES = [
  'waiting_identity',
  'writing',
  'written',
  'skipped',
  'failed',
] as const;
export type SapReputationJobStatus = (typeof SAP_REPUTATION_JOB_STATUSES)[number];

export const sapReputationJobs = pgTable(
  'sap_reputation_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bountyId: uuid('bounty_id')
      .notNull()
      .references(() => bounties.id, { onDelete: 'cascade' }),
    hunterAvatarId: uuid('hunter_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    status: text('status')
      .$type<SapReputationJobStatus>()
      .notNull()
      .default('waiting_identity'),
    attestationTxSig: text('attestation_tx_sig'),
    feedbackTxSig: text('feedback_tx_sig'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bountyUnique: uniqueIndex('sap_reputation_jobs_bounty_id_unique').on(t.bountyId),
    hunterStatusUpdatedIdx: index('sap_reputation_jobs_hunter_status_updated_idx').on(
      t.hunterAvatarId,
      t.status,
      t.updatedAt,
    ),
    statusValid: check(
      'sap_reputation_jobs_status_valid',
      sql`${t.status} IN ('waiting_identity', 'writing', 'written', 'skipped', 'failed')`,
    ),
    attemptsNonnegative: check('sap_reputation_jobs_attempts_nonnegative', sql`${t.attempts} >= 0`),
  }),
);

export type SapReputationJob = typeof sapReputationJobs.$inferSelect;
export type NewSapReputationJob = typeof sapReputationJobs.$inferInsert;
