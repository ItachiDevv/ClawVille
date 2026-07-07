/**
 * Tokenomics T0 (2026-07-07) — CLV PRICE ORACLE read surface.
 *
 * Mount: `app.route('/api/oracle', oracleRouter)` from index.ts.
 *
 * One admin-gated read endpoint over the READ-ONLY CLV price oracle
 * (`services/clv-price-oracle.ts`):
 *
 *   GET /api/oracle/clv[?history=N]
 *     → { mint, quote: { spotUsd, twap30mUsd, quoteUsd, asOf, source, stale,
 *         available }, history?: [{ id, priceUsd, source, createdAt }...], asOf }
 *
 * `quote` is the current in-memory house-favorable quote (min(spot, 30-min
 * TWAP); `available:false` + `quoteUsd:null` when there is no data yet or the
 * latest snapshot is older than the max-stale window). `history` (optional,
 * 1..500) returns the newest N stored `clv_price_snapshots` rows.
 *
 * Admin gate mirrors cove-economy.ts / treasury.ts exactly: `sessionMiddleware`
 * on the router + `adminOnly` on the route (ADMIN_USER_IDS allowlist OR the
 * shared `cv_dash` cookie). Read-only — this router NEVER writes anything, and
 * the oracle it reads NEVER touches `avatars.clawTokens` or the ledger (every
 * value is a USD decimal, never CT).
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { sessionMiddleware } from '../middleware/auth';
import { adminOnly } from '../middleware/admin-only';
import { getClvPrice, getRecentSnapshots, CLV_MINT } from '../services/clv-price-oracle';
import type { AppContext } from '../types';

export const oracleRouter = new Hono<AppContext>();
oracleRouter.use('*', sessionMiddleware);

const querySchema = z
  .object({
    /** Optional: include the newest N stored snapshots (1..500). */
    history: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

/**
 * GET /api/oracle/clv?history=50
 *
 * Admin-only. The single read surface for the CLV price feed the pricing paths
 * consume: the live quote + (optionally) the raw snapshot history.
 */
oracleRouter.get('/clv', adminOnly, async (c) => {
  const parsed = querySchema.safeParse({
    history: c.req.query('history') ?? undefined,
  });
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_input: ' + parsed.error.message });
  }

  const quote = getClvPrice();
  const history =
    parsed.data.history !== undefined ? await getRecentSnapshots(parsed.data.history) : undefined;

  return c.json(
    {
      mint: CLV_MINT,
      quote,
      ...(history !== undefined ? { history } : {}),
      asOf: new Date().toISOString(),
    },
    200,
  );
});

export default oracleRouter;
