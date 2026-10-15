/**
 * Codex DECIDER SHADOW ledger for the Trading Floor arena paper bots (founder 2026-10-15; migration 0085).
 *
 * One row per call (or hourly-cap refusal) made by `apps/api/src/services/floor-arena/codex-entry.ts` for a coin
 * that reached the buy-quote step; the host sidecar `infra/codex-decider` runs the Codex CLI on the founder's
 * ChatGPT plan. SHADOW ONLY: no trade path reads this table; the report `apps/api/scripts/floor-arena-codex-report.ts`
 * joins it to `floor_arena_positions`. No prompt text and no credential is stored. No FK (the ledger must outlive
 * agent rows).
 */

import { index, integer, pgTable, real, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const floorArenaCodexEntry = pgTable(
  'floor_arena_codex_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    agentId: text('agent_id').notNull(),
    mint: text('mint').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    /** ok | timeout | error | dropped | capped */
    status: varchar('status', { length: 16 }).notNull(),
    model: text('model'),
    /** enter | skip */
    decision: varchar('decision', { length: 8 }),
    confidence: real('confidence'),
    /** yes | no */
    exitRoom: varchar('exit_room', { length: 4 }),
    /** low | med | high */
    rugRisk: varchar('rug_risk', { length: 8 }),
    reasons: text('reasons').array(),
    /** Round-trip ms seen by the API (null for a capped row). */
    ms: integer('ms'),
    error: text('error'),
  },
  (t) => ({
    agentMintDecidedIdx: index('floor_arena_codex_entry_agent_mint_decided_idx').on(t.agentId, t.mint, t.decidedAt),
    createdAtIdx: index('floor_arena_codex_entry_created_at_idx').on(t.createdAt),
  }),
);

export type FloorArenaCodexEntryRow = typeof floorArenaCodexEntry.$inferSelect;
export type NewFloorArenaCodexEntryRow = typeof floorArenaCodexEntry.$inferInsert;
