import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOUSE_TRADER_OBJECTIVES, HOUSE_TRADER_STATUS_MAX_AGE_MS } from '@clawville/shared';

import { identityFingerprint } from '../../services/identity-service';
import { CLAWPUMP_OBSERVED_IDENTITY_TYPE } from '../../services/trading-provisioning';
import type { HouseTraderCandidate, HouseTraderDeps } from '../../services/house-traders';
import { clearHouseTraderStatuses } from '../../services/house-trader-status';
import { createHouseTraderStatusHandler, createHouseTradersHandler } from '../trading-floor';

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
    loadRealised: async () => new Map(),
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
  it('returns exactly the lineup slots on an empty database', async () => {
    const response = await callWith(deps());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      generatedAt: string;
      slots: Array<{ objective: string; status: string; subject: unknown; counts: unknown }>;
    };
    // Derived from the lineup, never a literal: the count went 2 -> 1 on
    // 2026-09-19 when Dip Hunter was dropped.
    expect(body.slots).toHaveLength(HOUSE_TRADER_OBJECTIVES.length);
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
    // Every OTHER lineup slot stays unpaired. Since 2026-09-19 the lineup is
    // Genesis alone, so that set is empty; derived from the lineup so the next
    // lineup change moves this with it instead of silently passing.
    expect(body.slots.filter((slot) => slot.status === 'not-yet-running')).toHaveLength(
      HOUSE_TRADER_OBJECTIVES.length - 1,
    );
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

  it('is publicly cacheable for FIVE seconds, not fifteen', async () => {
    // Shorter than the 15 s in-process cache on purpose, and the two bound
    // different things. The in-process cache bounds how stale the slot data is;
    // this header bounds how long a shared cache may replay the whole response
    // including `risk`. At 15 s an edge could serve "Paused by risk limit" for
    // 15 s after the trader recovered, which undoes the reason the risk merge
    // sits outside the cache, and could serve a report 15 s past its 150 s life.
    const response = await callWith(deps());
    expect(response.headers.get('cache-control')).toBe('public, max-age=5');
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

    // And the slot builder keeps each avatar's rows and counts on its OWN slot.
    // Proved across the TWO live lineup slots (Genesis on `momentum-board`,
    // ClawVille Runner on `intel-signal-follower`), plus the invariant the Dip
    // Hunter removal introduced: a candidate on a non-lineup objective is
    // filtered out BEFORE selection (`readHouseTraderSlots`), so it must never
    // resurrect a slot, reach the readers, or leak its counts into a live one.
    const busy = genesis();
    const quiet = { ...genesis(), avatarId: 'runner-avatar', objective: 'intel-signal-follower' };
    const dropped = { ...genesis(), avatarId: 'dropped-avatar', objective: 'sol-usdc-mean-reversion' };
    const response = await callWith(
      deps({
        loadCandidates: async () => [busy, quiet, dropped],
        loadCounts: async () =>
          new Map([
            [busy.avatarId, { verified: 12, scored: 8, lastTradeAt: '2026-09-19T10:00:00.000Z' }],
            [quiet.avatarId, { verified: 3, scored: 1, lastTradeAt: '2026-09-19T11:00:00.000Z' }],
            [dropped.avatarId, { verified: 99, scored: 99, lastTradeAt: '2026-09-19T12:00:00.000Z' }],
          ]),
        loadRecent: async (ids, perAvatar) => {
          // A per-avatar reader hands back a bucket per avatar; a global top-N
          // would hand back only the busiest one.
          expect(perAvatar).toBeGreaterThan(0);
          expect(ids).toContain(busy.avatarId);
          expect(ids).toContain(quiet.avatarId);
          // The dropped objective never reaches the readers at all.
          expect(ids).not.toContain(dropped.avatarId);
          return new Map(ids.map((id) => [id, []]));
        },
      }),
    );
    const body = (await response.json()) as { slots: Array<{ objective: string; counts: { verified: number } }> };
    expect(body.slots.map((slot) => slot.objective)).toEqual([...HOUSE_TRADER_OBJECTIVES]);
    expect(body.slots.some((slot) => slot.objective === 'sol-usdc-mean-reversion')).toBe(false);
    // Each slot carries its OWN avatar's count: not the other slot's, not the
    // dropped candidate's 99, and not a sum of any of them.
    const busySlot = body.slots.find((slot) => slot.objective === 'momentum-board')!;
    const quietSlot = body.slots.find((slot) => slot.objective === 'intel-signal-follower')!;
    expect(busySlot.counts.verified).toBe(12);
    expect(quietSlot.counts.verified).toBe(3);
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
    // a `public` cache header, so an edge could have cached it.
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
      const raw = readFileSync(resolve(import.meta.dir, '../../services', file), 'utf8');
      // Scan CODE, not prose. The doc comments in these files quote the bad
      // form (a raw aggregate typed as a number) to explain the staging 500
      // that caused this rule, and a comment cannot execute a query. Stripping
      // block and line comments first cannot weaken the guard: commented-out
      // code does not run either. Without this, documenting the rule trips it.
      const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
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

/**
 * The reported-pause feed (founder decision, 2026-09-20).
 *
 * The board must be able to say "Paused by risk limit". The rule loop runs
 * outside this repo, so it POSTS its state and the board reads it back; nothing
 * here infers a pause from trade silence.
 *
 * Every case pins its own client IP, because the two limiters are module level
 * and shared with every other file in the routes lane process.
 */
describe('POST /api/floor/house-traders/status', () => {
  const TOKEN = 'status-feed-token-for-tests';
  const OTHER_WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const START = Date.parse('2026-09-20T12:00:00.000Z');

  /** One app carrying BOTH handlers on one clock, because the contract that
   *  matters is "a POST changes what the next GET says". */
  function feed() {
    const clock = { ms: START };
    const now = () => clock.ms;
    let slotReads = 0;
    // `loadCounts` counts GET reads only: `readHouseTraderWallets` (the POST
    // path) reads `loadCandidates`, so counting that one would conflate them.
    const shared = deps({
      loadCandidates: async () => [genesis()],
      loadCounts: async () => {
        slotReads += 1;
        return new Map([[AVATAR_ID, { verified: 3, scored: 2, lastTradeAt: null }]]);
      },
    });
    const app = new Hono();
    app.get('/house-traders', createHouseTradersHandler(shared, 15_000, { now }) as never);
    app.post('/house-traders/status', createHouseTraderStatusHandler(shared, { now }) as never);
    return { app, clock, slotReads: () => slotReads };
  }

  function body(clock: { ms: number }, overrides: Record<string, unknown> = {}) {
    return {
      wallet: WALLET,
      canEnter: false,
      reason: 'daily_loss_floor',
      detail: 'lifetime loss 14.95 of the 25.00 floor',
      dayLossUsd: 14.95,
      dayLossCapUsd: 25,
      roomNeededUsd: 10.25,
      at: new Date(clock.ms).toISOString(),
      ...overrides,
    };
  }

  async function post(
    app: Hono,
    ip: string,
    payload: unknown,
    token: string | null = TOKEN,
    contentType: string | null = 'application/json',
  ): Promise<Response> {
    const headers: Record<string, string> = { 'cf-connecting-ip': ip };
    if (contentType !== null) headers['content-type'] = contentType;
    if (token !== null) headers.authorization = `Bearer ${token}`;
    return await app.request('/house-traders/status', {
      method: 'POST',
      headers,
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
  }

  async function riskFor(app: Hono, ip: string): Promise<Record<string, unknown> | null> {
    const response = await app.request('/house-traders', { headers: { 'cf-connecting-ip': ip } });
    const parsed = (await response.json()) as {
      slots: Array<{ objective: string; risk: Record<string, unknown> | null }>;
    };
    return parsed.slots.find((slot) => slot.objective === 'momentum-board')!.risk;
  }

  beforeEach(() => {
    clearHouseTraderStatuses();
    process.env.HOUSE_TRADER_STATUS_TOKEN = TOKEN;
  });

  afterEach(() => {
    clearHouseTraderStatuses();
    delete process.env.HOUSE_TRADER_STATUS_TOKEN;
  });

  it('refuses 503 when the secret is not configured', async () => {
    // An unconfigured deployment must refuse, not accept anything. The check
    // runs BEFORE the token compare, because there is nothing to compare with.
    delete process.env.HOUSE_TRADER_STATUS_TOKEN;
    const { app, clock } = feed();
    const response = await post(app, '198.51.100.1', body(clock));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'not_configured' });
  });

  it('refuses 401 for a missing, malformed or wrong token, and never echoes it', async () => {
    const { app, clock } = feed();
    for (const token of [null, '', 'wrong-token', `${TOKEN}x`, TOKEN.slice(0, -1)]) {
      const response = await post(app, '198.51.100.2', body(clock), token);
      expect({ token, status: response.status }).toEqual({ token, status: 401 });
      const raw = await response.text();
      expect(raw).toBe(JSON.stringify({ error: 'unauthorized' }));
      // The configured secret must never appear in an error body.
      expect(raw).not.toContain(TOKEN);
    }
  });

  it('refuses 415 for a body that is not declared JSON', async () => {
    // The same convention the two operator middlewares apply to a write.
    // Checked AFTER the bearer, so an unauthenticated caller learns nothing.
    const { app, clock } = feed();
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', null]) {
      const response = await post(app, '198.51.100.14', body(clock), TOKEN, contentType);
      expect({ contentType, status: response.status }).toEqual({ contentType, status: 415 });
      expect(await response.json()).toEqual({ error: 'unsupported_media_type' });
    }
  });

  it('accepts a charset parameter on the content type', async () => {
    // Several HTTP clients send `application/json; charset=utf-8` by default.
    // Matching the whole header instead of the media type would 415 our own
    // runner for a header it did not choose.
    const { app, clock } = feed();
    const response = await post(
      app, '198.51.100.15', body(clock), TOKEN, 'application/json; charset=utf-8',
    );
    expect(response.status).toBe(200);
  });

  it('refuses 400 invalid_body for a non-contract body, including an undateable at', async () => {
    const { app, clock } = feed();
    const rejected: unknown[] = [
      'not json at all',
      // `.strict()`: a field the server would ignore is a refusal, because a
      // silently dropped field makes a runner believe it reported something.
      body(clock, { positions: 3 }),
      body(clock, { reason: 'made_up' }),
      body(clock, { wallet: 'not-base58-0OIl' }),
      body(clock, { canEnter: 'false' }),
      body(clock, { dayLossCapUsd: 0 }),
      body(clock, { dayLossUsd: -1 }),
      body(clock, { roomNeededUsd: -1 }),
      body(clock, { detail: 'x'.repeat(121) }),
      // "I cannot enter and nothing is wrong" is a contradiction, not a state.
      // Mapped it would fall through to `live` and print a working trader over
      // a report that says the opposite.
      body(clock, { canEnter: false, reason: 'ok' }),
      // A string that is not a timestamp is a malformed field like any other.
      // It is NOT `stale_timestamp`: that code means "fix your clock", and this
      // caller's bug is in its serialiser.
      body(clock, { at: 'yesterday' }),
      body(clock, { at: 'not a date' }),
    ];
    for (const payload of rejected) {
      const response = await post(app, '198.51.100.3', payload);
      expect({ payload, status: response.status }).toEqual({ payload, status: 400 });
      expect(await response.json()).toEqual({ error: 'invalid_body' });
    }
  });

  it('refuses 400 stale_timestamp ONLY for a real time outside the window', async () => {
    const { app, clock } = feed();
    for (const at of [
      new Date(clock.ms - 11 * 60_000).toISOString(),
      // A future `at` is refused too: it is the shape a replay takes and it
      // would drive a negative age downstream.
      new Date(clock.ms + 11 * 60_000).toISOString(),
    ]) {
      const response = await post(app, '198.51.100.4', body(clock, { at }));
      expect({ at, status: response.status }).toEqual({ at, status: 400 });
      expect(await response.json()).toEqual({ error: 'stale_timestamp' });
    }
  });

  it('accepts the recovering-runner report rather than dropping it', async () => {
    // `canEnter: true` still carrying the reason that held it back is the tick
    // a runner recovers on. The frozen contract classifies it `live`.
    const { app, clock } = feed();
    const response = await post(
      app, '198.51.100.16', body(clock, { canEnter: true, reason: 'daily_loss_floor' }),
    );
    expect(response.status).toBe(200);
    expect(await riskFor(app, '198.51.100.16'))
      .toMatchObject({ state: 'live', reason: 'daily_loss_floor' });
  });

  it('refuses 404 for a wallet that is not a current lineup slot', async () => {
    // Holding the token is not enough: only a wallet bound to a slot we publish
    // may write, which is also what bounds the store to the lineup size.
    const { app, clock } = feed();
    const response = await post(app, '198.51.100.5', body(clock, { wallet: OTHER_WALLET }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'unknown_wallet' });
    expect(await riskFor(app, '198.51.100.5')).toBeNull();
  });

  it('accepts a risk-limit block and the next GET reads PAUSED', async () => {
    const { app, clock } = feed();
    const accepted = await post(app, '198.51.100.6', body(clock));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      ok: true,
      wallet: WALLET,
      receivedAt: new Date(START).toISOString(),
    });
    clock.ms = START + 5_000;
    expect(await riskFor(app, '198.51.100.6')).toEqual({
      state: 'paused',
      reason: 'daily_loss_floor',
      detail: 'lifetime loss 14.95 of the 25.00 floor',
      dayLossUsd: 14.95,
      dayLossCapUsd: 25,
      roomNeededUsd: 10.25,
      at: new Date(START).toISOString(),
      ageSeconds: 5,
    });
  });

  it('reads LIVE for a fully deployed trader, even with canEnter false', async () => {
    // `at_max_positions` means the trader is working, not held back. Badging it
    // as paused would put a red badge on a healthy trader several times a day.
    const { app, clock } = feed();
    const response = await post(
      app,
      '198.51.100.7',
      body(clock, { reason: 'at_max_positions', detail: undefined }),
    );
    expect(response.status).toBe(200);
    const risk = await riskFor(app, '198.51.100.7');
    expect(risk).toMatchObject({ state: 'live', reason: 'at_max_positions', detail: null });
  });

  it('reads FAULT for a blind runner, even with canEnter true', async () => {
    // A dead price feed is a broken trader, never a deliberate risk decision.
    const { app, clock } = feed();
    await post(app, '198.51.100.8', body(clock, { reason: 'price_feed_down', canEnter: true }));
    expect(await riskFor(app, '198.51.100.8')).toMatchObject({
      state: 'fault',
      reason: 'price_feed_down',
    });
  });

  it('drops a report to null once it ages out, so a dead feed never looks current', async () => {
    const { app, clock } = feed();
    await post(app, '198.51.100.9', body(clock));
    expect(await riskFor(app, '198.51.100.9')).toMatchObject({ state: 'paused' });
    // One tick INSIDE the window still reads, so the ageout is not off by one.
    clock.ms = START + HOUSE_TRADER_STATUS_MAX_AGE_MS;
    expect(await riskFor(app, '198.51.100.9')).toMatchObject({ state: 'paused' });
    clock.ms = START + HOUSE_TRADER_STATUS_MAX_AGE_MS + 1;
    expect(await riskFor(app, '198.51.100.9')).toBeNull();
  });

  it('merges risk OUTSIDE the 15 second slot cache', async () => {
    // The pin that matters most: a pause, and just as importantly a RECOVERY,
    // must show on the very next poll. A board still reading "Paused by risk
    // limit" after the trader resumed is a false statement about a live trader.
    const { app, clock, slotReads } = feed();
    expect(await riskFor(app, '198.51.100.10')).toBeNull();
    expect(slotReads()).toBe(1);
    await post(app, '198.51.100.10', body(clock));
    // Same clock throughout, so the slot cache stays warm and no second read
    // happens. The recovery below carries the SAME `at` and must still take
    // effect: equal stores, and a pin that needed a clock nudge to pass would
    // be hiding the ageout bug rather than catching it.
    expect(await riskFor(app, '198.51.100.10')).toMatchObject({ state: 'paused' });
    expect(slotReads()).toBe(1);
    await post(app, '198.51.100.10', body(clock, { canEnter: true, reason: 'ok' }));
    expect(await riskFor(app, '198.51.100.10')).toMatchObject({ state: 'live', reason: 'ok' });
    expect(slotReads()).toBe(1);
  });

  it('never writes the merge back into the cached slot', async () => {
    // The cache holds BINDINGS and the merge clones each slot, so `ageSeconds`
    // recomputes on every request. Mutating a cached slot instead would freeze
    // the first age it ever rendered, and a pause would then outlive its own
    // 150 s freshness for as long as the slot cache happened to live.
    const { app, clock, slotReads } = feed();
    await post(app, '198.51.100.17', body(clock));
    clock.ms = START + 2_000;
    expect(await riskFor(app, '198.51.100.17')).toMatchObject({ ageSeconds: 2 });
    clock.ms = START + 9_000;
    expect(await riskFor(app, '198.51.100.17')).toMatchObject({ ageSeconds: 9 });
    // Both reads came from the same cached bindings, so this really did prove
    // the merge and not a cache refill.
    expect(slotReads()).toBe(1);
  });

  it('leaves an unpaired slot at risk null', async () => {
    // Only Genesis is paired in this fixture. ClawVille Runner has no bound
    // wallet, so it has nothing to join on and must read `null` rather than
    // borrowing the other desk's state.
    const { app, clock } = feed();
    await post(app, '198.51.100.18', body(clock));
    const response = await app.request('/house-traders', {
      headers: { 'cf-connecting-ip': '198.51.100.18' },
    });
    const parsed = (await response.json()) as {
      slots: Array<{ objective: string; risk: unknown }>;
    };
    expect(parsed.slots.find((slot) => slot.objective === 'momentum-board')!.risk)
      .toMatchObject({ state: 'paused' });
    expect(parsed.slots.find((slot) => slot.objective === 'intel-signal-follower')!.risk)
      .toBeNull();
  });

  it('ignores a reordered OLDER report instead of pinning a stale pause', async () => {
    // HTTP does not promise delivery order. A delayed `canEnter: false` landing
    // behind the newer `canEnter: true` would put "Paused by risk limit" on the
    // board for a trader that has already recovered, and it would stay wrong
    // for a full heartbeat.
    const { app, clock } = feed();
    const recoveredAt = new Date(START).toISOString();
    const pausedAt = new Date(START - 30_000).toISOString();
    await post(app, '198.51.100.20', body(clock, { canEnter: true, reason: 'ok', at: recoveredAt }));
    expect(await riskFor(app, '198.51.100.20')).toMatchObject({ state: 'live', reason: 'ok' });
    const late = await post(app, '198.51.100.20', body(clock, { at: pausedAt }));
    // 200, because the runner did nothing wrong and must not retry.
    expect(late.status).toBe(200);
    expect(await late.json()).toEqual({ ok: true, ignored: 'older_report' });
    // The store was not touched: the recovery still stands.
    expect(await riskFor(app, '198.51.100.20')).toMatchObject({ state: 'live', reason: 'ok' });
  });

  it('keeps an UNCHANGED pause on the board across heartbeats, past the ageout', async () => {
    // THE REGRESSION THIS FEATURE EXISTS FOR. A desk paused for ten minutes
    // heartbeats every 60 s reporting the same state. If those heartbeats do
    // not refresh the receipt time, the report ages out at 150 s and the board
    // drops the PAUSED badge off a desk that is still paused and still
    // reporting correctly: the Genesis failure reproduced in three minutes,
    // while the feed is healthy, which is worse because the surface looks fine.
    const { app, clock } = feed();
    await post(app, '198.51.100.21', body(clock));
    for (const offset of [60_000, 120_000, 180_000]) {
      clock.ms = START + offset;
      // Same state, fresh `at`: `at` is the SEND time of the post, not the time
      // the state began.
      const beat = await post(app, '198.51.100.21', body(clock));
      expect({ offset, status: beat.status }).toEqual({ offset, status: 200 });
      expect(await beat.json()).toMatchObject({ ok: true, wallet: WALLET });
    }
    // Well past 150 s from the FIRST post, and still on the board.
    expect(clock.ms - START).toBeGreaterThan(HOUSE_TRADER_STATUS_MAX_AGE_MS);
    expect(await riskFor(app, '198.51.100.21')).toMatchObject({ state: 'paused', ageSeconds: 0 });
    // And it still ages out once the heartbeats STOP, which is the fact the
    // ageout is actually for: "we have heard nothing recently".
    clock.ms = START + 180_000 + HOUSE_TRADER_STATUS_MAX_AGE_MS + 1;
    expect(await riskFor(app, '198.51.100.21')).toBeNull();
  });

  it('refreshes on an IDENTICAL at, so a resend-last-payload heartbeat still works', async () => {
    // A naive runner that re-posts its last body verbatim is the case this
    // protects. Equal STORES and refreshes the receipt time, so such a
    // heartbeat keeps a live pause on the board instead of letting it age off
    // silently, which is the failure this whole feature exists to end.
    //
    // Not a replay hole: the plus or minus ten minute `at` window bounds a
    // replayed body to re-asserting a state at most ten minutes old, and the
    // next heartbeat corrects it within 60 s.
    const { app, clock } = feed();
    const at = new Date(START).toISOString();
    await post(app, '198.51.100.22', body(clock, { at }));
    clock.ms = START + 40_000;
    const repeat = await post(app, '198.51.100.22', body(clock, { at }));
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ ok: true, wallet: WALLET });
    // Age resets to 0 on the resend, which is the whole point.
    expect(await riskFor(app, '198.51.100.22')).toMatchObject({ state: 'paused', ageSeconds: 0 });
    // One millisecond past where the ORIGINAL post would have aged out, and the
    // block is still there, because the deadline now runs from the resend.
    clock.ms = START + HOUSE_TRADER_STATUS_MAX_AGE_MS + 1;
    expect(await riskFor(app, '198.51.100.22')).toMatchObject({ state: 'paused' });
    // It still dies once the resends stop: the ageout measures "we have heard
    // nothing recently", and that fact must survive this change.
    clock.ms = START + 40_000 + HOUSE_TRADER_STATUS_MAX_AGE_MS + 1;
    expect(await riskFor(app, '198.51.100.22')).toBeNull();
  });

  it('accepts a STOPPED slot report but never publishes it', async () => {
    // Reachable, not theoretical: an operator revokes the trading wallet while
    // the Python runner keeps heartbeating, because it does not know it was
    // unpaired. The POST must still succeed, so a re-pairing has current state
    // the instant it lands. But both human surfaces show STOPPED and suppress
    // the pause, so the wire must too, or an agent reading the JSON says
    // "paused by a risk limit" about a desk the board calls stopped.
    const clock = { ms: START };
    const app = new Hono();
    const stopped = { ...genesis(), wallet: null };
    const shared = deps({ loadCandidates: async () => [stopped] });
    app.get('/house-traders', createHouseTradersHandler(shared, 15_000, { now: () => clock.ms }) as never);
    app.post('/house-traders/status', createHouseTraderStatusHandler(shared, { now: () => clock.ms }) as never);
    const accepted = await post(app, '198.51.100.19', body(clock));
    expect(accepted.status).toBe(200);
    const response = await app.request('/house-traders', {
      headers: { 'cf-connecting-ip': '198.51.100.19' },
    });
    const parsed = (await response.json()) as {
      slots: Array<{ objective: string; status: string; risk: unknown }>;
    };
    const slot = parsed.slots.find((row) => row.objective === 'momentum-board')!;
    expect(slot.status).toBe('stopped');
    expect(slot.risk).toBeNull();
  });

  it('keeps the wallet out of the public body even while a risk block is live', async () => {
    const { app, clock } = feed();
    await post(app, '198.51.100.11', body(clock));
    const response = await app.request('/house-traders', {
      headers: { 'cf-connecting-ip': '198.51.100.11' },
    });
    const raw = await response.text();
    expect(raw).toContain('"state":"paused"');
    for (const secret of [WALLET, AVATAR_ID, AGENT_ID]) expect(raw).not.toContain(secret);
    for (const key of ['pubkey', 'wallet', 'fingerprint', 'identity', 'userId', 'avatarId']) {
      expect(raw).not.toContain(key);
    }
  });

  it('sanitises a detail to printable ASCII before it reaches the board', async () => {
    const { app, clock } = feed();
    const sent = await post(app, '198.51.100.12', body(clock, { detail: 'floor\u0000hit\nby  14.95 \u{1F600}' }));
    // Nothing address-like, so the note survives and no redaction is reported.
    expect(await sent.json()).not.toHaveProperty('detailRedacted');
    const risk = await riskFor(app, '198.51.100.12');
    expect(risk?.detail).toBe('floor hit by 14.95');
  });

  it('drops a note carrying an address and SAYS SO on the 200', async () => {
    // Fails safe AND fails visible. A note that vanishes with no signal leaves
    // the runner author believing their text is on the board. The status itself
    // still lands, because the pause is the load-bearing part and must never be
    // refused over an operator's formatting.
    const { app, clock } = feed();
    const sent = await post(app, '198.51.100.23', body(clock, {
      // A newline between the halves: not an attack, just a traceback.
      detail: 'blocked at\n7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    }));
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ ok: true, wallet: WALLET, detailRedacted: true });
    const risk = await riskFor(app, '198.51.100.23');
    // The state is published; only the note is gone.
    expect(risk).toMatchObject({ state: 'paused', reason: 'daily_loss_floor', detail: null });
    const raw = await (await app.request('/house-traders', {
      headers: { 'cf-connecting-ip': '198.51.100.23' },
    })).text();
    expect(raw).not.toContain('7xKXtg2CW87d97TXJSDp');
  });

  // LAST for this address: the limiter bucket is module level and shared with
  // every other file in the routes lane process.
  it('rate limits one address after 30 posts in the window', async () => {
    // Exercised on the unconfigured branch, which returns BEFORE any auth or
    // database work, so the case proves the limiter runs first and costs
    // nothing else.
    delete process.env.HOUSE_TRADER_STATUS_TOKEN;
    const { app, clock } = feed();
    let last = await post(app, '198.51.100.13', body(clock));
    for (let call = 1; call < 30; call += 1) {
      last = await post(app, '198.51.100.13', body(clock));
    }
    expect(last.status).toBe(503);
    const limited = await post(app, '198.51.100.13', body(clock));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
  });

  it('registers the status POST before the session middleware, behind noStorePrivate', () => {
    // Same load-bearing reason as the two public GETs: the runner presents a
    // bearer token and no cookie, so there is no session to refresh. Asserted
    // at source because proving it at runtime would need a database.
    //
    // `noStorePrivate` on the mount rather than a hand-set header inside the
    // handler: it sets the headers AFTER the handler runs, so no later edit can
    // leave a `public` header on a 401 or a 404 for an edge to remember.
    const source = readFileSync(resolve(import.meta.dir, '../trading-floor.ts'), 'utf8');
    const statusPost = source.indexOf("tradingFloorRoutes.post('/house-traders/status'");
    const sessionUse = source.indexOf("tradingFloorRoutes.use('*', sessionMiddleware)");
    expect(statusPost).toBeGreaterThan(-1);
    expect(statusPost).toBeLessThan(sessionUse);
    expect(source.slice(statusPost, sessionUse)).toContain('noStorePrivate');
  });

  it('never infers a pause from trade silence', () => {
    // The invariant this whole feed exists to protect, pinned at source. A slot
    // with recent trades and no report reads `risk: null`, and no code path may
    // turn quiet counts into a reason.
    const route = readFileSync(resolve(import.meta.dir, '../trading-floor.ts'), 'utf8');
    const service = readFileSync(
      resolve(import.meta.dir, '../../services/house-trader-status.ts'),
      'utf8',
    );
    for (const source of [route, service]) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // The classifier takes only what the runner REPORTED. If any of these
      // ever appear in the risk path, something started deriving a state.
      for (const inferred of ['lastTradeAt', 'recentTrades.length', 'counts.verified']) {
        expect({ inferred, present: code.includes(inferred) }).toEqual({ inferred, present: false });
      }
    }
  });
});
