import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOUSE_TRADER_OBJECTIVES } from '@clawville/shared';

import { identityFingerprint } from '../../services/identity-service';
import { CLAWPUMP_OBSERVED_IDENTITY_TYPE } from '../../services/trading-provisioning';
import type { HouseTraderCandidate, HouseTraderDeps } from '../../services/house-traders';
import { createHouseTradersHandler } from '../trading-floor';

/**
 * Driven through the handler's dependency seam, so it runs with NO database in
 * the shared routes lane process. No `mock.module` anywhere: that lane runs
 * every file in one bun process and a mocker poisons its siblings.
 */

const AGENT_ID = '0f600d73-05a0-4c2e-8215-ab2a770ba192';
const WALLET = '4FMiFU1Dv4qwfMHn3YukvaonhwrPt1T7VZ3yGuNRyY9n';
const AVATAR_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const CLAWVILLE_AGENT_ID = 'clawville-agent-genesis';

function genesis(): HouseTraderCandidate {
  return {
    avatarId: AVATAR_ID,
    avatarName: 'Genesis',
    objective: 'momentum-board',
    clawpumpAgentId: AGENT_ID,
    clawvilleAgentId: CLAWVILLE_AGENT_ID,
    linkWalletPubkey: WALLET,
    wallet: { pubkey: WALLET, source: 'clawpump' },
    ownerIdentityFingerprint: identityFingerprint(CLAWPUMP_OBSERVED_IDENTITY_TYPE, AGENT_ID),
    createdAt: new Date('2026-09-18T00:00:00.000Z'),
  };
}

function deps(overrides: Partial<HouseTraderDeps> = {}): HouseTraderDeps {
  return {
    loadCandidates: async () => [],
    loadCounts: async () => new Map(),
    loadRecent: async () => new Map(),
    onDuplicate: () => {},
    ...overrides,
  };
}

/** Fresh app per case so the handler's 15s cache never leaks between tests. */
async function callWith(
  handlerDeps: HouseTraderDeps,
  headers: Record<string, string> = {},
): Promise<Response> {
  const app = new Hono();
  app.get('/house-traders', createHouseTradersHandler(handlerDeps) as never);
  return await app.request('/house-traders', { headers });
}

describe('GET /api/floor/house-traders', () => {
  it('returns exactly the two lineup slots on an empty database', async () => {
    const response = await callWith(deps());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      generatedAt: string;
      slots: Array<{ objective: string; status: string; subject: unknown; counts: unknown }>;
    };
    expect(body.slots).toHaveLength(2);
    expect(body.slots.map((slot) => slot.objective)).toEqual([...HOUSE_TRADER_OBJECTIVES]);
    expect(typeof body.generatedAt).toBe('string');
    for (const slot of body.slots) {
      expect(slot.status).toBe('not-yet-running');
      expect(slot.subject).toBeNull();
      expect(slot.counts).toEqual({ verified: 0, scored: 0, lastTradeAt: null });
    }
  });

  it('marks a qualifying link live-observed with its counts', async () => {
    const response = await callWith(
      deps({
        loadCandidates: async () => [genesis()],
        loadCounts: async () =>
          new Map([[AVATAR_ID, { verified: 3, scored: 2, lastTradeAt: '2026-09-19T09:00:00.000Z' }]]),
      }),
    );
    const body = (await response.json()) as {
      slots: Array<{ objective: string; status: string; subject: { avatarName: string; id: string } | null }>;
    };
    const momentum = body.slots.find((slot) => slot.objective === 'momentum-board')!;
    expect(momentum.status).toBe('live-observed');
    expect(momentum.subject?.avatarName).toBe('Genesis');
    // The public tape's identifier, never the avatar UUID.
    expect(momentum.subject?.id).toBe(CLAWVILLE_AGENT_ID);
    expect(body.slots.filter((slot) => slot.status === 'not-yet-running')).toHaveLength(1);
  });

  it('exposes no wallet, user id or identity fingerprint in the response', async () => {
    // The discriminator query has to join `users` for the fingerprint, so the
    // row in hand carries it on a PUBLIC route. Leaking it would hand over the
    // very gate this surface is built on.
    const candidate = genesis();
    const response = await callWith(deps({ loadCandidates: async () => [candidate] }));
    const raw = await response.text();
    for (const secret of [WALLET, candidate.ownerIdentityFingerprint!, AVATAR_ID, AGENT_ID]) {
      expect(raw).not.toContain(secret);
    }
    for (const key of ['pubkey', 'wallet', 'fingerprint', 'identity', 'userId', 'user_id', 'avatarId', 'email']) {
      expect(raw).not.toContain(key);
    }
  });

  it('is publicly cacheable', async () => {
    const response = await callWith(deps());
    expect(response.headers.get('cache-control')).toBe('public, max-age=15');
  });

  it('gives a quiet slot its own recent trades, never a global top-N', async () => {
    // Regression pin for the starvation shape: a GLOBAL
    // `limit(avatarIds.length * perAvatar)` ordered by time can be filled
    // entirely by one busy trader, leaving a quiet slot rendering zero rows
    // while its own counts read "12 verified, last trade 20 minutes ago". The
    // query must partition per avatar. Asserted at SOURCE because the shape
    // lives in SQL and proving it at runtime needs Postgres.
    const observer = readFileSync(
      resolve(import.meta.dir, '../../services/trade-observer.ts'),
      'utf8',
    );
    const fn = observer.slice(
      observer.indexOf('export async function listPublicVerifiedTradesForAvatars'),
      observer.indexOf('export async function listPublicVerifiedTrades('),
    );
    expect(fn).toContain('row_number() over');
    expect(fn).toContain('partition by');
    expect(fn).toContain('lte(ranked.rowNumber, perAvatar)');
    // The starving shape must not come back.
    expect(fn).not.toMatch(/\.limit\(/);

    // And the slot builder keeps each avatar's rows on its own slot.
    const busy = genesis();
    const quiet = { ...genesis(), avatarId: 'quiet-avatar', objective: 'sol-usdc-mean-reversion' };
    const response = await callWith(
      deps({
        loadCandidates: async () => [busy, quiet],
        loadCounts: async () =>
          new Map([[quiet.avatarId, { verified: 12, scored: 8, lastTradeAt: '2026-09-19T10:00:00.000Z' }]]),
        loadRecent: async (ids, perAvatar) => {
          // A per-avatar reader hands back a bucket per avatar; a global top-N
          // would hand back only the busy one.
          expect(perAvatar).toBeGreaterThan(0);
          return new Map(ids.map((id) => [id, []]));
        },
      }),
    );
    const body = (await response.json()) as { slots: Array<{ objective: string; counts: { verified: number } }> };
    const quietSlot = body.slots.find((slot) => slot.objective === 'sol-usdc-mean-reversion')!;
    expect(quietSlot.counts.verified).toBe(12);
  });

  it('registers the public GET before the session middleware', () => {
    // LOAD BEARING, and asserted at source because proving it at runtime needs
    // a database: `sessionMiddleware` appends Set-Cookie on a fresh or blanked
    // session, and this response is `Cache-Control: public`, so a shared cache
    // could hand one visitor's session cookie to the next. The equivalent
    // RUNTIME proof for the sibling public route lives in
    // floor-templates.test.ts, which sends a cookie and asserts no Set-Cookie.
    const source = readFileSync(resolve(import.meta.dir, '../trading-floor.ts'), 'utf8');
    const publicGet = source.indexOf("tradingFloorRoutes.get('/house-traders'");
    const templatesGet = source.indexOf("tradingFloorRoutes.get('/templates'");
    const sessionUse = source.indexOf("tradingFloorRoutes.use('*', sessionMiddleware)");
    expect(publicGet).toBeGreaterThan(-1);
    expect(sessionUse).toBeGreaterThan(-1);
    expect(publicGet).toBeLessThan(sessionUse);
    expect(templatesGet).toBeLessThan(sessionUse);
  });

  it('serves the cached body inside the window without re-reading', async () => {
    let reads = 0;
    const app = new Hono();
    app.get(
      '/house-traders',
      createHouseTradersHandler(
        deps({
          loadCandidates: async () => {
            reads += 1;
            return [];
          },
        }),
      ) as never,
    );
    await app.request('/house-traders');
    await app.request('/house-traders');
    expect(reads).toBe(1);
  });

  // LAST in the file on purpose: the limiter bucket is module level and shared
  it('sets no public cache header when the read throws', async () => {
    // Staging 2026-09-19: the first live read threw, and the 500 still carried
    // `Cache-Control: public, max-age=15`, so an edge could have cached it.
    const app = new Hono();
    app.onError((_error, c) => c.json({ error: 'Internal server error', code: 500 }, 500));
    app.get('/house-traders', createHouseTradersHandler(deps({
      loadCandidates: async () => { throw new Error('read failed'); },
    })) as never);
    const response = await app.request('/house-traders', {
      headers: { 'cf-connecting-ip': '203.0.113.77' },
    });
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBeNull();
  });

  it('formats the newest trade time in SQL, never with a JS Date method', () => {
    // A raw `sql` aggregate bypasses the column mapper: the driver returns the
    // Postgres TEXT form, so `.toISOString()` on it threw on staging. The seam
    // tests above never touch the driver, so pin the source.
    const source = readFileSync(resolve(import.meta.dir, '../../services/house-traders.ts'), 'utf8');
    expect(source).toContain(`to_char(max(`);
    expect(source).not.toContain('lastTradeAt.toISOString');
    expect(source).not.toContain('sql<Date');
  });

  it('types every raw sql value in both services as the driver really returns it', () => {
    // `sql<T>` is a compile-time claim only. A raw expression has no column
    // mapper, so the driver returns TEXT for bigint, numeric and timestamptz.
    // Rule: a raw `sql<...>` is typed `string` (or `string | null`), or it
    // carries `.mapWith(` before the statement ends.
    for (const file of ['house-traders.ts', 'trade-observer.ts']) {
      const source = readFileSync(resolve(import.meta.dir, '../../services', file), 'utf8');
      expect(source).not.toContain('sql<Date');
      const pattern = /sql<([^>]+)>`[^`]*`([^,;\n]*)/g;
      for (const match of source.matchAll(pattern)) {
        const typed = match[1].replace(/\s+/g, '');
        const honest = typed === 'string' || typed === 'string|null' || match[2].includes('.mapWith(');
        expect({ file, expression: match[0].slice(0, 60), honest }).toEqual({
          file, expression: match[0].slice(0, 60), honest: true,
        });
      }
    }
  });

  // with every other file in the routes lane process, so exhausting it earlier
  // would starve the sibling cases above.
  it('rate limits one address after 60 calls in the window', async () => {
    // Driven through the seam, but the limiter it checks is the REAL
    // module-level `houseTradersLimiter` the mounted route uses.
    const headers = { 'cf-connecting-ip': '203.0.113.44' };
    const app = new Hono();
    app.get('/house-traders', createHouseTradersHandler(deps()) as never);
    let last = await app.request('/house-traders', { headers });
    for (let call = 1; call < 60; call += 1) {
      last = await app.request('/house-traders', { headers });
    }
    expect(last.status).toBe(200);
    const limited = await app.request('/house-traders', { headers });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({
      error: 'Too many house trader requests.',
      code: 'rate_limited',
    });
  });
});
