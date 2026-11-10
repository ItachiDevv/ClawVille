import { sql } from 'drizzle-orm';
import { bigint, check, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar, unique} from 'drizzle-orm/pg-core';
import { brainchainTaskAttempts, brainchainWorkerTasks } from './brainchain';

/** Internal budget authority only. No human/agent route can approve an envelope. */
export const brainchainComputeBudgets = pgTable('brainchain_compute_budgets', {
  id: uuid('id').primaryKey().defaultRandom(), jobId: uuid('job_id').notNull(), provider: varchar('provider', { length: 12 }).notNull(),
  capMicros: bigint('cap_micros', { mode: 'bigint' }).notNull(), allocatedMicros: bigint('allocated_micros', { mode: 'bigint' }).notNull().default(sql`0`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({ owner: uniqueIndex('brainchain_compute_budget_owner').on(t.jobId, t.provider),
  values: check('brainchain_compute_budget_values', sql`${t.provider} IN ('openai','openrouter') AND ${t.capMicros}=10000000 AND ${t.allocatedMicros} BETWEEN 0 AND ${t.capMicros}`) }));

export const brainchainComputeEnvelopes = pgTable('brainchain_compute_envelopes', {
  id: uuid('id').primaryKey().defaultRandom(), budgetId: uuid('budget_id').notNull().references(() => brainchainComputeBudgets.id, { onDelete: 'restrict' }),
  rootReservationId: varchar('root_reservation_id', { length: 128 }).notNull(), approvalRef: varchar('approval_ref', { length: 128 }).notNull(),
  limitMicros: bigint('limit_micros', { mode: 'bigint' }).notNull(), reservedMicros: bigint('reserved_micros', { mode: 'bigint' }).notNull().default(sql`0`),
  uncertainMicros: bigint('uncertain_micros', { mode: 'bigint' }).notNull().default(sql`0`), settledMicros: bigint('settled_micros', { mode: 'bigint' }).notNull().default(sql`0`),
  state: varchar('state', { length: 12 }).notNull().default('open'), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }), reconciliationId: uuid('reconciliation_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({ rootOnce: uniqueIndex('brainchain_compute_root_reservation').on(t.rootReservationId),
  values: check('brainchain_compute_envelope_values', sql`${t.limitMicros}>0 AND ${t.limitMicros}<=10000000 AND ${t.reservedMicros}>=0 AND ${t.uncertainMicros}>=0 AND ${t.settledMicros}>=0 AND ${t.reservedMicros}+${t.uncertainMicros}+${t.settledMicros}<=${t.limitMicros} AND ${t.state} IN ('open','closed') AND (${t.state}='open' OR (${t.closedAt} IS NOT NULL AND ${t.reconciliationId} IS NOT NULL AND ${t.reservedMicros}=0 AND ${t.uncertainMicros}=0))`) }));

export const brainchainComputeCalls = pgTable('brainchain_compute_calls', {
  id: uuid('id').primaryKey(), reservationId: uuid('reservation_id').notNull(), envelopeId: uuid('envelope_id').notNull().references(() => brainchainComputeEnvelopes.id, { onDelete: 'restrict' }),
  avatarId: uuid('avatar_id').notNull(), taskId: uuid('task_id').notNull().references(() => brainchainWorkerTasks.id, { onDelete: 'restrict' }),
  attemptId: uuid('attempt_id').notNull().references(() => brainchainTaskAttempts.id, { onDelete: 'restrict' }), generation: integer('generation').notNull(), leaseOwner: uuid('lease_owner').notNull(),
  model: varchar('model', { length: 128 }).notNull(), pricingVersion: varchar('pricing_version', { length: 96 }).notNull(),
  promptHash: varchar('prompt_hash', { length: 64 }).notNull(), prompt: text('prompt').notNull(),
  maxInputTokens: integer('max_input_tokens').notNull(), maxOutputTokens: integer('max_output_tokens').notNull(),
  inputOverheadTokens: integer('input_overhead_tokens').notNull(),
  inputRate: bigint('input_rate', { mode: 'bigint' }).notNull(), outputRate: bigint('output_rate', { mode: 'bigint' }).notNull(), requestMicros: bigint('request_micros', { mode: 'bigint' }).notNull(),
  maximumMicros: bigint('maximum_micros', { mode: 'bigint' }).notNull(), chargedMicros: bigint('charged_micros', { mode: 'bigint' }),
  capabilityHash: varchar('capability_hash', { length: 64 }).notNull(), deadline: timestamp('deadline', { withTimezone: true }).notNull(),
  state: varchar('state', { length: 12 }).notNull().default('reserved'), dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  output: text('output'), inputTokens: integer('input_tokens'), outputTokens: integer('output_tokens'),
  failureCode: varchar('failure_code', { length: 32 }), reconciliationRef: varchar('reconciliation_ref', { length: 128 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({ reservation: uniqueIndex('brainchain_compute_call_reservation').on(t.reservationId),
  deliveryOwner: unique('brainchain_compute_call_owner_tuple').on(t.id,t.taskId,t.attemptId,t.avatarId,t.generation,t.leaseOwner,t.promptHash),
  attemptOnce: uniqueIndex('brainchain_compute_attempt_once').on(t.attemptId), capability: uniqueIndex('brainchain_compute_capability_once').on(t.capabilityHash),
  values: check('brainchain_compute_call_values', sql`${t.generation}>0 AND ${t.promptHash} ~ '^[a-f0-9]{64}$' AND ${t.capabilityHash} ~ '^[a-f0-9]{64}$' AND octet_length(${t.prompt}) BETWEEN 1 AND 32768 AND ${t.maxInputTokens} BETWEEN octet_length(${t.prompt}) AND 131072 AND ${t.maxOutputTokens} BETWEEN 1 AND 8192 AND ${t.inputRate}>=0 AND ${t.outputRate}>=0 AND ${t.requestMicros}>=0 AND ${t.maximumMicros}>0 AND ${t.maximumMicros}<=10000000 AND (${t.chargedMicros} IS NULL OR ${t.chargedMicros} BETWEEN 0 AND ${t.maximumMicros}) AND ${t.state} IN ('reserved','dispatched','uncertain','settled','canceled') AND (${t.output} IS NULL OR octet_length(${t.output}) BETWEEN 1 AND 32768)`),
  lifecycle: check('brainchain_compute_call_lifecycle', sql`(${t.state}='reserved' AND ${t.dispatchedAt} IS NULL AND ${t.chargedMicros} IS NULL) OR (${t.state}='canceled' AND ${t.dispatchedAt} IS NULL AND ${t.chargedMicros} IS NOT NULL AND ${t.chargedMicros}=0) OR (${t.state} IN ('dispatched','uncertain') AND ${t.dispatchedAt} IS NOT NULL AND ${t.chargedMicros} IS NULL) OR (${t.state}='settled' AND ${t.dispatchedAt} IS NOT NULL AND ${t.chargedMicros} IS NOT NULL)`),
  usage: check('brainchain_compute_call_usage', sql`(${t.inputTokens} IS NULL OR ${t.inputTokens} BETWEEN 0 AND ${t.maxInputTokens}) AND (${t.outputTokens} IS NULL OR ${t.outputTokens} BETWEEN 1 AND ${t.maxOutputTokens}) AND (${t.output} IS NULL OR (${t.state}='settled' AND ${t.inputTokens} IS NOT NULL AND ${t.outputTokens} IS NOT NULL))`),
  framing: check('brainchain_compute_call_framing', sql`${t.inputOverheadTokens} BETWEEN 0 AND 8192 AND ${t.maxInputTokens}>=octet_length(${t.prompt})+${t.inputOverheadTokens}`),
}));
