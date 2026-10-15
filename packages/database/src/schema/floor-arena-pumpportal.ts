/**
 * PumpPortal flow facts for the Trading Floor arena (job arena-pipeline T4, 2026-10-15; migration 0084).
 *
 * One row per mint the PumpPortal feed watches (`apps/api/src/services/floor-arena/pumpportal-feed.ts`), flushed by
 * the leader every ~15 s and pruned after 24 h. DATA ONLY: no filter threshold reads it. The `w1m` / `w5m` / `w15m`
 * windows are `{ buys, sells, buySol, sellSol, uniqueBuyers, uniqueSellers, topBuyerShare }` and stay null while the
 * feed has no PumpPortal trade subscription (`trade_flow` false). No FK.
 */

import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const floorPumpportalFlow = pgTable(
  'floor_pumpportal_flow',
  {
    mint: text('mint').primaryKey(),
    /** PumpPortal `pool`: pump | bonk | pump-amm | ... */
    pool: text('pool'),
    /** traderPublicKey of the create event. */
    creator: text('creator'),
    tokenCreatedAt: timestamp('token_created_at', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    tradeFlow: boolean('trade_flow').notNull().default(false),
    w1m: jsonb('w1m'),
    w5m: jsonb('w5m'),
    w15m: jsonb('w15m'),
    creatorBuySol: doublePrecision('creator_buy_sol'),
    creatorSellSol: doublePrecision('creator_sell_sol'),
    creatorSold: boolean('creator_sold'),
    earlyBuyers: integer('early_buyers'),
    earlyHeldPct: doublePrecision('early_held_pct'),
    lastMarketCapSol: doublePrecision('last_market_cap_sol'),
    lastVSol: doublePrecision('last_v_sol'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    updatedAtIdx: index('floor_pumpportal_flow_updated_at_idx').on(t.updatedAt),
  }),
);

export type FloorPumpportalFlowRow = typeof floorPumpportalFlow.$inferSelect;
