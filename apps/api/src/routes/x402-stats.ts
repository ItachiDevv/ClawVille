import { db, sql, x402SettlementReceipts } from '@clawville/database';
import { Hono } from 'hono';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';

interface X402StatsSnapshot {
  totalUsd: number;
  totalUsdcAtomic: string;
  payments: number;
  updatedAt: string;
}

interface AggregateRow {
  total: string | bigint | number | null;
  payments: string | bigint | number;
}

const CACHE_TTL_MS = 60_000;

let cache: { snapshot: X402StatsSnapshot; expiresAt: number } | null = null;

const limiter = createRateLimiter({
  maxPerWindow: 60,
  windowMs: 60_000,
});

export const x402StatsRoutes = new Hono();

x402StatsRoutes.get('/', async (c) => {
  const ip = getClientIp(c.req.raw.headers);
  if (!limiter.check(ip)) {
    return c.json(
      { error: 'rate_limited', message: 'Too many requests. Try again shortly.' },
      429,
    );
  }

  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    c.header('Cache-Control', 'public, max-age=60');
    return c.json(cache.snapshot);
  }

  try {
    const [row] = await db
      .select({
        total: sql<AggregateRow['total']>`COALESCE(SUM(${x402SettlementReceipts.amountUsdcAtomic}), 0)`,
        payments: sql<AggregateRow['payments']>`COUNT(*)::int`,
      })
      .from(x402SettlementReceipts);

    const totalAtomic = BigInt(row?.total ?? 0);
    const snapshot: X402StatsSnapshot = {
      totalUsd: Number(totalAtomic) / 1_000_000,
      totalUsdcAtomic: totalAtomic.toString(),
      payments: Number(row?.payments ?? 0),
      updatedAt: new Date(now).toISOString(),
    };

    cache = { snapshot, expiresAt: now + CACHE_TTL_MS };
    c.header('Cache-Control', 'public, max-age=60');
    return c.json(snapshot);
  } catch (error) {
    console.error('[x402/stats] aggregate failed:', error);
    if (cache) {
      c.header('Cache-Control', 'public, max-age=60');
      return c.json(cache.snapshot);
    }
    return c.json({ error: 'stats_unavailable' }, 503);
  }
});
