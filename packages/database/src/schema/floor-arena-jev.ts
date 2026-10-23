/**
 * Jev ENTRY SHADOW ledger for the Trading Floor arena paper bots (founder 2026-10-14; migration 0082).
 *
 * One row per Jev call (or cap refusal) for a coin that reached the buy-quote step. SHADOW ONLY: no trade path read
 * this table. The writer (floor-arena/jev-entry.ts) and its report were DELETED 2026-10-23 (founder: delete at the
 * gate review; the v0 veto was no better than a random skip of the same count per bot, p=0.22). The table stays
 * declared only until a separate DROP migration lands after the prod code flip. No FK.
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
