/**
 * Phase 6 economy fix (2026-05-29) — Cove CT-economy MONITOR.
 *
 * Mount: `app.route('/api/cove/economy', coveEconomyRouter)` from index.ts.
 *
 * One admin-gated read endpoint that aggregates `cove_game_events` by gameType
 * over a window and reports, per game, the house P&L in ClawTokens:
 *
 *   minted   = SUM(payout)      — CT credited back to players (engine credits)
 *   burned   = SUM(bet_amount)  — CT players staked (debited)
 *   houseNet = burned - minted  — POSITIVE = house-positive (sink); NEGATIVE = a
 *                                 FAUCET (players net-minted CT — alarm).
 *
 * "The house is implicit" IN THIS MONITOR: the cove never writes a treasury
 * row INTO `cove_game_events`. Net CT minted/burned across all events IS the
 * house's P&L. The baccarat commission fix + the hold'em pot-rake + the
 * blackjack net-winnings rake all show up here as extra `burned` (the raked CT
 * is recorded in `payout` AFTER the rake, so the gap widens in the house's
 * favor). This monitor is the detector the economy plan §3 demands: if any
 * gameType trends houseNet < 0, a game has gone net-positive to players and
 * must be retuned BEFORE the real-money tier.
 *
 * T0 NOTE (2026-07-07): fee routing now ALSO credits those rakes/commissions to
 * the named house-treasury avatar via `claw_token_transactions` ONLY (reasons
 * `house_fee_*`, in the same settle tx) — it writes NO `cove_game_events` row
 * and changes NO bet/payout value, so THIS monitor's math is untouched and
 * nothing double-counts. The treasury's own view is `GET /api/treasury/summary`.
 *
 * NOTE: `bet_amount` / `payout` are TEXT-stringified bigints (lamport/µUSDC
 * seam). Today every cove row is fun-money CT that fits an int8, so we sum them
 * server-side with `::numeric` and return decimal strings — never lossy JS
 * floats. Guest rows (guest_fp_hash set) are INCLUDED by default (they move the
 * same demo-CT accounting); pass `?subjects=users` to exclude them.
 *
 * FEATURE_GATE: cove_ct_economy_monitor
 * Status: read-only admin monitor; aggregates cove_game_events. Not in any
 *         player flow. Used to confirm the 2026-05-29 economy fixes hold post-deploy.
 * Metric to graduate: houseNet ≥ 0 per gameType over a 7d window for two
 *         consecutive weeks once the cove is promoted to prod (plan §3 gate).
 * Current reading: to fill (no prod cove traffic yet — engines are staging-only).
 * Review deadline: 2026-07-01
 * On deadline: if the cove has shipped to prod and any gameType shows a
 *         sustained faucet (houseNet < 0), retune that game's edge/rake before
 *         the SOL/USDC tier; if the cove has NOT shipped, renew with a new
 *         metric reading (do not silently extend).
 * Reference: .claude/plans/cove-casino-economy.md §3-§4 + CLAUDE.md priority #3/#4.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import { adminOnly } from '../middleware/admin-only';
import type { AppContext } from '../types';

export const coveEconomyRouter = new Hono<AppContext>();
coveEconomyRouter.use('*', sessionMiddleware);

/** Allowed lookback windows → Postgres interval literals. */
const WINDOWS = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  all: null,
} as const;
type WindowKey = keyof typeof WINDOWS;

const querySchema = z
  .object({
    window: z.enum(['24h', '7d', '30d', 'all']).default('7d'),
    /** 'all' (default) | 'users' (exclude guest_fp_hash rows). */
    subjects: z.enum(['all', 'users']).default('all'),
  })
  .strict();

interface GameRow {
  game_type: string;
  events: number | string;
  burned: string | null;
  minted: string | null;
  // Index signature so the row type satisfies Drizzle's
  // `db.execute<T extends Record<string, unknown>>` constraint.
  [key: string]: unknown;
}

interface GameSummary {
  gameType: string;
  events: number;
  /** SUM(bet_amount) — CT staked (debited). Stringified bigint. */
  burned: string;
  /** SUM(payout) — CT credited back. Stringified bigint. */
  minted: string;
  /** burned - minted. Positive = house-positive (sink); negative = faucet. */
  houseNet: string;
  /** houseNet / burned as a fraction (house edge). Null when burned = 0. */
  houseEdge: number | null;
}

/**
 * GET /api/cove/economy/summary?window=7d&subjects=all
 *
 * Admin-only. Returns per-gameType minted/burned/houseNet aggregates from
 * cove_game_events over the window, plus a grand total. The single source of
 * truth for "is any cove game a faucet?".
 */
coveEconomyRouter.get('/summary', adminOnly, async (c) => {
  const parsed = querySchema.safeParse({
    window: c.req.query('window') ?? undefined,
    subjects: c.req.query('subjects') ?? undefined,
  });
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_input: ' + parsed.error.message });
  }
  const { window, subjects } = parsed.data;
  const interval = WINDOWS[window as WindowKey];

  // Build the WHERE clause from parameterized fragments (never string-concat the
  // interval — it comes from the closed WINDOWS map, but we still bind it safely).
  const sinceClause =
    interval === null ? sql`TRUE` : sql`created_at > now() - ${interval}::interval`;
  const subjectClause =
    subjects === 'users' ? sql`user_id IS NOT NULL` : sql`TRUE`;

  // bet_amount / payout are TEXT bigints — cast to numeric for an exact sum,
  // return as text so no precision is lost crossing the wire.
  const rows = await db.execute<GameRow>(sql`
    SELECT
      game_type,
      COUNT(*)::int                       AS events,
      COALESCE(SUM(bet_amount::numeric), 0)::text AS burned,
      COALESCE(SUM(payout::numeric), 0)::text     AS minted
    FROM cove_game_events
    WHERE ${sinceClause} AND ${subjectClause}
    GROUP BY game_type
    ORDER BY game_type
  `);

  const games: GameSummary[] = rows.map((r) => {
    const burned = BigInt(r.burned ?? '0');
    const minted = BigInt(r.minted ?? '0');
    const houseNet = burned - minted;
    const houseEdge = burned > 0n ? Number(houseNet) / Number(burned) : null;
    return {
      gameType: r.game_type,
      events: Number(r.events),
      burned: burned.toString(),
      minted: minted.toString(),
      houseNet: houseNet.toString(),
      houseEdge,
    };
  });

  // Grand total across all games.
  let totalBurned = 0n;
  let totalMinted = 0n;
  let totalEvents = 0;
  for (const g of games) {
    totalBurned += BigInt(g.burned);
    totalMinted += BigInt(g.minted);
    totalEvents += g.events;
  }
  const totalHouseNet = totalBurned - totalMinted;

  // Flag any faucet (a game where players net-minted CT) for the on-call eye.
  const faucets = games.filter((g) => BigInt(g.houseNet) < 0n).map((g) => g.gameType);

  return c.json(
    {
      window,
      subjects,
      measuredAt: new Date().toISOString(),
      games,
      total: {
        events: totalEvents,
        burned: totalBurned.toString(),
        minted: totalMinted.toString(),
        houseNet: totalHouseNet.toString(),
        houseEdge: totalBurned > 0n ? Number(totalHouseNet) / Number(totalBurned) : null,
      },
      /** Non-empty = ALARM: these games are net-positive to players. */
      faucets,
      ok: faucets.length === 0,
    },
    200,
  );
});

export default coveEconomyRouter;
