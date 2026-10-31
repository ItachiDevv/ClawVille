import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { db, sql } from '@clawville/database';
import { bearerToken, statusTokenMatches } from '../services/house-trader-status';
import {
  CHAIN_FEED_SECRET_MIN_LENGTH, chainFeedSecret, FEED_ROWS_PER_TICK, recordChainFeedDemand,
} from '../services/floor-arena/chain-checks';

/**
 * Chain-verdict feed (founder order 2026-10-31: "one shared Helius service that calls Helius and feeds both
 * environments"). Prod and staging share ONE Helius account quota. Prod is the only Helius caller: it serves the
 * arena chain verdicts it already holds, and staging (no Helius key) fills its own verdicts from this feed
 * (`fetchChainFeed` in `services/floor-arena/chain-checks.ts`).
 *
 *   GET /api/internal/chain-feed/verdicts?mints=<comma list>
 *
 * - Off (404, empty body) unless `CHAIN_FEED_SECRET` is set with >= 32 characters. Read per request, so an
 *   un-provisioned box is off rather than open.
 * - `Authorization: Bearer <CHAIN_FEED_SECRET>`, constant-time digest compare; a missing or wrong token is 401. The
 *   token is never logged and never echoed.
 * - 1..200 distinct base58 mints (32-44 characters); anything else is 400.
 * - Read only: ONE SELECT from `floor_discovery_mints` (the shared discovery table). No RPC, no DB write. Player add-on
 *   mints (`floor_arena_private_mints`) are never read here.
 * - Demand (Codex 2026-10-31): the mints of an authenticated, valid request are recorded in memory
 *   (`recordChainFeedDemand`), so prod's chain-check selector also checks them for 5 minutes, inside its normal coarse
 *   universe. Nothing is recorded for a 404, 401 or 400. Assumes the route and the arena leader share one process
 *   (prod runs one api container); otherwise the demand is ignored.
 * - `Cache-Control: no-store` on every answer.
 *
 * PARITY (E5): not a player feature. It moves no money, touches no avatar, and no human or agent action reaches it; an
 * internal server-to-server read between our own two boxes.
 */

export const CHAIN_FEED_MAX_MINTS = FEED_ROWS_PER_TICK;
const BASE58_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface ChainFeedRow { mint: string; verdict: unknown; checkedAt: string }

export interface ChainFeedDeps {
  /** The configured secret, or null when the feed is off. */
  readSecret: () => string | null;
  loadVerdicts: (mints: readonly string[]) => Promise<ChainFeedRow[]>;
  /** Records the asked mints as chain-check demand (default: recordChainFeedDemand). */
  recordDemand?: (mints: readonly string[]) => void;
}

/** Split, trim, drop empties, dedupe; then 1..200 base58 mints. The raw string is capped before the split. */
export const chainFeedMintsSchema = z
  .string()
  .max(CHAIN_FEED_MAX_MINTS * 46)
  .transform((raw) => [...new Set(raw.split(',').map((m) => m.trim()).filter((m) => m.length > 0))])
  .pipe(z.array(z.string().regex(BASE58_MINT)).min(1).max(CHAIN_FEED_MAX_MINTS));

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? result as Array<Record<string, unknown>> : ((result as { rows?: Array<Record<string, unknown>> })?.rows ?? []);
}

function isoOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

type FeedDatabase = Pick<typeof db, 'execute'>;

/** The one read: shared discovery rows with a verdict, for the asked mints. */
export async function loadChainFeedVerdicts(mints: readonly string[], database: FeedDatabase = db): Promise<ChainFeedRow[]> {
  const wanted = JSON.stringify(mints);
  const rows = rowsOf(await database.execute(sql`
    SELECT mint, chain_verdict, chain_checked_at
    FROM floor_discovery_mints
    WHERE mint IN (SELECT jsonb_array_elements_text(${wanted}::jsonb))
      AND chain_verdict IS NOT NULL
      AND chain_checked_at IS NOT NULL
  `));
  const out: ChainFeedRow[] = [];
  for (const row of rows) {
    const checkedAt = isoOf(row.chain_checked_at);
    if (checkedAt === null) continue;
    out.push({ mint: String(row.mint), verdict: row.chain_verdict, checkedAt });
  }
  return out;
}

export const defaultChainFeedDeps: ChainFeedDeps = {
  readSecret: chainFeedSecret,
  loadVerdicts: (mints) => loadChainFeedVerdicts(mints),
  recordDemand: (mints) => recordChainFeedDemand(mints),
};

export function createChainFeedHandler(deps: ChainFeedDeps = defaultChainFeedDeps) {
  return async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    const expected = deps.readSecret();
    if (!expected || expected.length < CHAIN_FEED_SECRET_MIN_LENGTH) return c.body(null, 404);
    const presented = bearerToken(c.req.header('Authorization'));
    if (!presented || !statusTokenMatches(presented, expected)) return c.json({ error: 'unauthorized' }, 401);
    const parsed = chainFeedMintsSchema.safeParse(c.req.query('mints') ?? '');
    if (!parsed.success) return c.json({ error: 'invalid_mints' }, 400);
    (deps.recordDemand ?? recordChainFeedDemand)(parsed.data);
    const rows = await deps.loadVerdicts(parsed.data);
    return c.json({ verdicts: rows.map((row) => ({ mint: row.mint, verdict: row.verdict, checkedAt: row.checkedAt })) });
  };
}

export const chainFeedRoutes = new Hono();
chainFeedRoutes.get('/verdicts', createChainFeedHandler());
