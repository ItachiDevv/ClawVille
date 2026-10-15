/**
 * Trading Floor Arena COIN LABELS (research, migration 0083).
 *
 * One row per mint EPISODE: every coin the shared floor sees from a tradeable source (ds: / clawpump:), traded or
 * skipped. The writer `apps/api/src/services/floor-arena/coin-labels.ts` anchors the row at the first tradeable
 * DexScreener snapshot, then follows the price for 24 h and stores markouts, the 24 h fate and the result of ONE fixed
 * reference exit. The reader `apps/api/scripts/floor-arena-label-report.ts` joins it to each house bot's decisions.
 * RESEARCH ONLY: no trade path, money path or public payload reads this table. No FK (discovery rows expire).
 */

import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const floorArenaCoinLabels = pgTable(
  'floor_arena_coin_labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mint: text('mint').notNull(),
    /** Episode key: the first sighting of the mint by a tradeable source (a re-discovered mint is a new episode). */
    episodeAt: timestamp('episode_at', { withTimezone: true }).notNull(),
    /** Time of the first DexScreener snapshot taken while the mint had a tradeable source. */
    anchorAt: timestamp('anchor_at', { withTimezone: true }).notNull(),
    anchorPriceUsd: doublePrecision('anchor_price_usd').notNull(),
    /** Same keys as floor_arena_positions.entry_features where they apply (snapshot fields + top10Pct + source...). */
    anchorFeatures: jsonb('anchor_features').notNull(),
    sources: text('sources').array().notNull(),
    /** First resolved chain verdict seen after the anchor: {verdict, top10Pct, at}; null = never resolved. */
    chainStatus: jsonb('chain_status'),
    /** Price path: [[seconds after anchor, price / anchor price], ...], ascending. */
    path: jsonb('path').notNull().default(sql`'[]'::jsonb`),
    mult5m: doublePrecision('mult_5m'),
    mult15m: doublePrecision('mult_15m'),
    mult30m: doublePrecision('mult_30m'),
    mult60m: doublePrecision('mult_60m'),
    maxMult60m: doublePrecision('max_mult_60m'),
    maxMult60mAt: timestamp('max_mult_60m_at', { withTimezone: true }),
    minMult60m: doublePrecision('min_mult_60m'),
    minMult60mAt: timestamp('min_mult_60m_at', { withTimezone: true }),
    mult6h: doublePrecision('mult_6h'),
    mult24h: doublePrecision('mult_24h'),
    maxMult24h: doublePrecision('max_mult_24h'),
    minMult24h: doublePrecision('min_mult_24h'),
    /** rug | runner | bleed | flat | unknown (definitions in coin-labels.ts classifyFate). */
    fate24h: text('fate_24h').notNull().default('unknown'),
    /** The fixed reference exit ($20, TP +20 %, stop -20 %, 60 min) in USD after paper costs; null = no exit sample. */
    commonExitPnlUsd: doublePrecision('common_exit_pnl_usd'),
    /** tp | stop | time */
    commonExitReason: text('common_exit_reason'),
    /** DexScreener calls this row caused (prices reused from the enrichment cost nothing). */
    ownSamples: integer('own_samples').notNull().default(0),
    /** open | done */
    state: text('state').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    mintEpisodeUniq: uniqueIndex('floor_arena_coin_labels_mint_episode_uniq').on(t.mint, t.episodeAt),
    stateIdx: index('floor_arena_coin_labels_state_idx').on(t.state),
    anchorIdx: index('floor_arena_coin_labels_anchor_idx').on(t.anchorAt),
    stateValid: check('floor_arena_coin_labels_state_valid', sql`${t.state} IN ('open','done')`),
    fateValid: check('floor_arena_coin_labels_fate_valid', sql`${t.fate24h} IN ('rug','runner','bleed','flat','unknown')`),
  }),
);

export type FloorArenaCoinLabelRow = typeof floorArenaCoinLabels.$inferSelect;
export type NewFloorArenaCoinLabelRow = typeof floorArenaCoinLabels.$inferInsert;
