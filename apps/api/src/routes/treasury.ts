/**
 * Tokenomics T0 (2026-07-07) — HOUSE-TREASURY read surface.
 *
 * Mount: `app.route('/api/treasury', treasuryRouter)` from index.ts.
 *
 * One admin-gated read endpoint over the T0 fee-sink subject (see
 * `services/house-treasury-seeder.ts` + `treasury_subjects`):
 *
 *   GET /api/treasury/summary[?byReason=true]
 *     → { avatarId, purpose: 'house-fees',
 *         balance: { total, soft, bought, earned },
 *         byReason?: [{ reason, total, count }...], asOf }
 *
 * Reads the REGISTRY row (`treasury_subjects.purpose='house-fees'`) — the
 * durable name for the subject — then the avatar's balance columns. In T0 the
 * balance is 100% SOFT (every routed fee credits SOFT); bought/earned are
 * reported anyway so a future drift is visible. `byReason` aggregates
 * SUM(amount)/COUNT grouped by `claw_token_transactions.reason` for the
 * treasury avatar, so revenue splits by fee site (house_fee_blackjack_rake,
 * house_fee_land_rent, …) without any new bookkeeping.
 *
 * Admin gate mirrors cove-economy.ts exactly: `sessionMiddleware` on the
 * router + `adminOnly` on the route (ADMIN_USER_IDS allowlist OR the shared
 * `cv_dash` cookie). Read-only — this router NEVER writes the ledger.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db, avatars, treasurySubjects } from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import { adminOnly } from '../middleware/admin-only';
import { noStorePrivate } from '../middleware/no-store';
import { HOUSE_TREASURY_PURPOSE } from '../services/house-treasury-seeder';
import type { AppContext } from '../types';

export const treasuryRouter = new Hono<AppContext>();
treasuryRouter.use('*', sessionMiddleware);

const querySchema = z
  .object({
    /** 'true' → include the per-reason revenue breakdown. */
    byReason: z.enum(['true', 'false']).default('false'),
  })
  .strict();

interface ReasonRow {
  reason: string;
  total: number | string;
  count: number | string;
  [key: string]: unknown;
}

/**
 * GET /api/treasury/summary?byReason=true
 *
 * Admin-only. The single source of truth for "how much fee revenue has the
 * house accumulated, and from which sites".
 */
treasuryRouter.get('/summary', adminOnly, noStorePrivate, async (c) => {
  const parsed = querySchema.safeParse({
    byReason: c.req.query('byReason') ?? undefined,
  });
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_input: ' + parsed.error.message });
  }

  // The registry row is authoritative for WHICH avatar is the treasury (it
  // survives process restarts / a failed boot seed on this pod).
  const subjectRow = await db.query.treasurySubjects.findFirst({
    where: eq(treasurySubjects.purpose, HOUSE_TREASURY_PURPOSE),
  });
  if (!subjectRow) {
    throw new HTTPException(503, {
      message: 'treasury_not_provisioned: house-treasury seeder has not run (migration 0007 applied?)',
    });
  }

  const avatarRow = await db.query.avatars.findFirst({
    where: eq(avatars.id, subjectRow.avatarId),
    columns: {
      id: true,
      clawTokens: true,
      softBalance: true,
      boughtBalance: true,
      earnedBalance: true,
    },
  });
  if (!avatarRow) {
    // Impossible while the FK (ON DELETE RESTRICT) holds — fail loud, not soft.
    throw new HTTPException(500, { message: 'treasury_avatar_missing' });
  }

  let byReason:
    | Array<{ reason: string; total: string; count: number }>
    | undefined;
  if (parsed.data.byReason === 'true') {
    // amount is a signed integer column; SUM as ::numeric → text so nothing is
    // lossy on the wire (mirrors cove-economy's convention).
    const rows = await db.execute<ReasonRow>(sql`
      SELECT reason,
             COALESCE(SUM(amount)::numeric, 0)::text AS total,
             COUNT(*)::int AS count
      FROM claw_token_transactions
      WHERE avatar_id = ${subjectRow.avatarId}
      GROUP BY reason
      ORDER BY reason
    `);
    byReason = rows.map((r) => ({
      reason: r.reason,
      total: String(r.total),
      count: Number(r.count),
    }));
  }

  return c.json(
    {
      avatarId: avatarRow.id,
      purpose: HOUSE_TREASURY_PURPOSE,
      balance: {
        total: avatarRow.clawTokens,
        soft: avatarRow.softBalance,
        bought: avatarRow.boughtBalance,
        earned: avatarRow.earnedBalance,
      },
      ...(byReason !== undefined ? { byReason } : {}),
      asOf: new Date().toISOString(),
    },
    200,
  );
});

export default treasuryRouter;
