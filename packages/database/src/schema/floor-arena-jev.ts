/**
 * Jev ENTRY SHADOW ledger for the Trading Floor arena paper bots (founder 2026-10-14; migration 0082).
 *
 * One row per Jev call (or cap refusal) made by `apps/api/src/services/floor-arena/jev-entry.ts` for a coin that
 * reached the buy-quote step. SHADOW ONLY: no trade path reads this table; the report
 * `apps/api/scripts/floor-arena-jev-report.ts` joins it to `floor_arena_positions`. `usd` is both the spend record
 * and the spend-cap ledger. No prompt text is stored. No FK (agent rows may be deleted; the ledger must stay).
 */

import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const floorArenaJevEntry = pgTable(
  'floor_arena_jev_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    agentId: text('agent_id').notNull(),
    mint: text('mint').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    /** reserved | ok | error | timeout | skipped_cap */
    status: varchar('status', { length: 16 }).notNull(),
    model: text('model'),
    /** sha256 of the state string, first 16 hex. */
    stateHash: text('state_hash'),
    /** Per question: {p} / {choice, probs} / {score, probs}; null = invalid answer. */
    answers: jsonb('answers'),
    hitsTp: real('hits_tp'),
    dumps: real('dumps'),
    exitRoom: smallint('exit_room'),
    demand: smallint('demand'),
    momentum: text('momentum'),
    holderRisk: smallint('holder_risk'),
    /** pass | veto (verdict v0, stored only). */
    verdict: varchar('verdict', { length: 8 }),
    vetoReasons: text('veto_reasons').array(),
    jevMs: integer('jev_ms'),
    inputTokens: integer('input_tokens'),
    usd: numeric('usd', { precision: 12, scale: 8 }).notNull().default('0'),
    error: text('error'),
  },
  (t) => ({
    agentMintDecidedIdx: index('floor_arena_jev_entry_agent_mint_decided_idx').on(t.agentId, t.mint, t.decidedAt),
    createdAtIdx: index('floor_arena_jev_entry_created_at_idx').on(t.createdAt),
  }),
);

export type FloorArenaJevEntryRow = typeof floorArenaJevEntry.$inferSelect;
export type NewFloorArenaJevEntryRow = typeof floorArenaJevEntry.$inferInsert;
