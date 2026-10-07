import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FLOOR_ARENA_TEMPLATES } from '@clawville/shared';

/**
 * Research recording (task AR-1, migration 0080; docs/trading-floor-arena.md §6 "Research recording"): first-sight
 * snapshot, trough + mark path, post-exit tail, pass/skip archive, and the guarantees that recording never changes
 * or delays trading. Real Postgres only, same opt-in as floor-arena-queries.db.test.ts (CI === 'true' or
 * ARENA_DB_TEST=1, plus DATABASE_URL). The exit-tick checks run the real engine tick, which reads EVERY open
 * position, so run this file against a test database of its own.
 */
const optedIn = process.env.CI === 'true' || process.env.ARENA_DB_TEST === '1';
const describeIfDb = process.env.DATABASE_URL && optedIn ? describe : describe.skip;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function fakeMint(): string {
  let out = '';
  for (let i = 0; i < 44; i += 1) out += B58[Math.floor(Math.random() * B58.length)];
  return out;
}

describe('markPathSlot (pure)', () => {
  test('hold buckets: 10 s to 30 min, 60 s to 6 h, 600 s to 24 h, then dropped; tail 10 s for 30 min', async () => {
    const { markPathSlot } = await import('../floor-arena/engine');
    const t0 = Date.UTC(2026, 9, 7, 12, 0, 0);
    expect(markPathSlot('hold', t0 + 17_000, t0)?.bucketAtMs).toBe(t0 + 10_000);
    expect(markPathSlot('hold', t0 + 29 * 60_000 + 59_000, t0)?.bucketAtMs).toBe(t0 + 29 * 60_000 + 50_000);
    expect(markPathSlot('hold', t0 + 31 * 60_000 + 59_000, t0)?.bucketAtMs).toBe(t0 + 31 * 60_000);
    expect(markPathSlot('hold', t0 + 7 * 3_600_000 + 599_000, t0)?.bucketAtMs).toBe(t0 + 7 * 3_600_000);
    expect(markPathSlot('hold', t0 + 86_400_000, t0)).not.toBeNull();
    expect(markPathSlot('hold', t0 + 86_400_000 + 600_000, t0)).toBeNull();
    // Every mark before the entry shares one bucket.
    expect(markPathSlot('hold', t0 - 3_000, t0)?.bucketAtMs).toBe(t0 - 10_000);
    expect(markPathSlot('hold', t0 - 55_000, t0)?.bucketAtMs).toBe(t0 - 10_000);
    expect(markPathSlot('tail', t0 + 25 * 60_000 + 9_000, t0)?.bucketAtMs).toBe(t0 + 25 * 60_000);
    expect(markPathSlot('tail', t0 - 1, t0)).toBeNull();
    expect(markPathSlot('tail', t0 + 30 * 60_000, t0)).toBeNull();
  });

  test('hard cap: at most 620 hold rows and 180 tail rows (800) per position, whatever the hold time', async () => {
    const { markPathSlot, MARK_PATH_MAX_ROWS } = await import('../floor-arena/engine');
    const t0 = Date.UTC(2026, 9, 7, 12, 0, 0);
    const hold = new Set<number>();
    for (let age = -60_000; age <= 72 * 3_600_000; age += 5_000) {
      const slot = markPathSlot('hold', t0 + age, t0);
      if (slot) hold.add(slot.bucketAtMs);
    }
    const tail = new Set<number>();
    for (let age = -60_000; age <= 3 * 3_600_000; age += 1_000) {
      const slot = markPathSlot('tail', t0 + age, t0);
      if (slot) tail.add(slot.bucketAtMs);
    }
    expect(hold.size).toBe(620);
    expect(tail.size).toBe(180);
    expect(hold.size + tail.size).toBe(MARK_PATH_MAX_ROWS);
  });
});

describeIfDb('floor arena research recording on Postgres', () => {
  const userId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const params = FLOOR_ARENA_TEMPLATES[0]!.params;
  const pairAddress = fakeMint();
  let dbm: typeof import('@clawville/database');
  let insertedHouse = false;

  function pair(mint: string, priceUsd: number, nowMs: number, pairAddr = pairAddress) {
    return {
      chainId: 'solana', dexId: 'pumpswap', pairAddress: pairAddr,
      baseToken: { address: mint, symbol: 'TST', name: 'Test' },
      quoteToken: { address: 'So11111111111111111111111111111111111111112' },
      priceUsd: String(priceUsd), marketCap: 50_000, liquidity: { usd: 20_000, base: 1, quote: 1 },
      pairCreatedAt: nowMs - 3_600_000, priceChange: { m5: 1, h1: 2, h6: 3, h24: 4 },
      txns: { h1: { buys: 10, sells: 5 } }, volume: { h1: 5_000 },
    };
  }

  async function snapshotOf(mint: string, priceUsd: number, nowMs: number) {
    const { buildSnapshot } = await import('../floor-arena/discovery-hub');
    return buildSnapshot(pair(mint, priceUsd, nowMs), nowMs);
  }

  async function addDiscoveryRow(mint: string, at: Date, expiresAt?: Date) {
    const { sql, db } = dbm;
    await db.execute(sql`
      INSERT INTO floor_discovery_mints (mint, first_seen_at, first_source, sources, last_seen_at, expires_at, source_first_seen)
      VALUES (${mint}, ${at.toISOString()}::timestamptz, 'ds:token-profiles', ARRAY['ds:token-profiles'],
        ${at.toISOString()}::timestamptz, ${(expiresAt ?? new Date(at.getTime() + 86_400_000)).toISOString()}::timestamptz,
        jsonb_build_object('ds:token-profiles', ${at.toISOString()}::text))
    `);
  }

  async function setSnapshot(mint: string, priceUsd: number, atMs: number) {
    const { sql, db } = dbm;
    const snap = await snapshotOf(mint, priceUsd, atMs);
    await db.execute(sql`
      UPDATE floor_discovery_mints SET snapshot = ${JSON.stringify(snap)}::jsonb, snapshot_at = ${new Date(atMs).toISOString()}::timestamptz
      WHERE mint = ${mint}
    `);
  }

  async function addPosition(input: {
    mint: string; openedAtMs: number; entryPriceUsd: number; maxHoldS: number; tp?: Array<[number, number]>;
    closedAtMs?: number; agent?: string; firstSight?: boolean;
  }): Promise<string> {
    const { sql, db } = dbm;
    const features: Record<string, unknown> = {
      exits: { tp: input.tp ?? [[10, 1]], stop_mult: null, trail_from_peak: null, trail_arm_mult: null, max_hold_s: input.maxHoldS },
      decimals: 6, dsEntryPriceUsd: input.entryPriceUsd, mcap: 50_000,
    };
    if (input.firstSight) features.firstSight = { at: new Date().toISOString(), priceUsd: 0.001, mcap: 40_000 };
    const closed = input.closedAtMs !== undefined;
    const rows = await db.execute(sql`
      INSERT INTO floor_arena_positions (agent_id, mint, symbol, source, opened_at, size_usd, tokens, entry_price_usd,
        entry_fill_source, entry_features, params_version, status, closed_at, exit_reason, exit_fill_source, pnl_usd, pnl_mult,
        remaining_fraction, realised_usd, trough_mult, trough_at)
      VALUES (${input.agent ?? agentId}, ${input.mint}, 'TST', 'ds:token-profiles', ${new Date(input.openedAtMs).toISOString()}::timestamptz,
        20, ${20 / input.entryPriceUsd}, ${input.entryPriceUsd}, 'quote', ${JSON.stringify(features)}::jsonb, 1,
        ${closed ? 'closed' : 'open'}, ${closed ? new Date(input.closedAtMs!).toISOString() : null}::timestamptz,
        ${closed ? 'time' : null}, ${closed ? 'quote' : null}, ${closed ? -1 : null}, ${closed ? 0.95 : null},
        ${closed ? 0 : 1}, ${closed ? 19 : 0}, ${input.firstSight ? 0.9 : null},
        ${input.firstSight ? new Date().toISOString() : null}::timestamptz)
      RETURNING id
    `);
    return String((rows as unknown as Array<{ id: string }>)[0]!.id);
  }

  async function pathOf(positionId: string) {
    const { sql, db } = dbm;
    return (await db.execute(sql`
      SELECT phase, bucket_at, mark_at, mark_mult, quote_at, quote_mult FROM floor_arena_position_marks
      WHERE position_id = ${positionId}::uuid ORDER BY phase, bucket_at
    `)) as unknown as Array<{ phase: string; bucket_at: Date; mark_at: Date | null; mark_mult: number | null; quote_at: Date | null; quote_mult: number | null }>;
  }

  async function positionOf(positionId: string) {
    const { sql, db } = dbm;
    return ((await db.execute(sql`
      SELECT status, trough_mult, trough_at, exit_reason FROM floor_arena_positions WHERE id = ${positionId}::uuid
    `)) as unknown as Array<{ status: string; trough_mult: string | null; trough_at: Date | null; exit_reason: string | null }>)[0]!;
  }

  /** One exit tick plus its deferred recording (the tick itself never waits for it). */
  async function tick(at: Date, deps: Parameters<typeof import('../floor-arena/engine').runExitTick>[1]) {
    const { runExitTick, arenaRecordingSettled } = await import('../floor-arena/engine');
    const result = await runExitTick(at, deps);
    await arenaRecordingSettled();
    return result;
  }

  const noQuote = async () => { throw new Error('no sell quote expected'); };
  const okQuote = (priceUsd: number) => async () => ({
    ok: true as const, tokens: 20_000, quotedUsd: 19.4, proceedsUsd: 19.2, priceUsd, venue: 'test',
  });

  beforeAll(async () => {
    dbm = await import('@clawville/database');
    const { db, sql } = dbm;
    await db.execute(sql`
      INSERT INTO users (id, email, password_hash, name)
      VALUES (${userId}::uuid, ${`arena-rec-${userId}@clawville-test.invalid`}, ${`disabled-${userId}`}, 'Arena Recording Test')
    `);
    await db.execute(sql`
      INSERT INTO floor_arena_agents (id, kind, owner_user_id, name, template_id, params, seated)
      VALUES (${agentId}, 'user', ${userId}::uuid, 'Rec', 'genesis', ${JSON.stringify(params)}::jsonb, true)
    `);
  });

  afterAll(async () => {
    const { db, sql } = dbm;
    const { arenaRecordingSettled } = await import('../floor-arena/engine');
    await arenaRecordingSettled();
    // No foreign keys on the research tables (B2): remove this file's rows explicitly.
    await db.execute(sql`
      DELETE FROM floor_arena_position_marks WHERE position_id IN (
        SELECT id FROM floor_arena_positions WHERE agent_id = ${agentId} OR (agent_id = 'house:genesis' AND ${insertedHouse}))
    `);
    await db.execute(sql`DELETE FROM floor_arena_events_archive WHERE agent_id = ${agentId}`);
    if (insertedHouse) await db.execute(sql`DELETE FROM floor_arena_agents WHERE id = 'house:genesis'`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}::uuid`);
  });

  test('1a: the first snapshot is stored once on the shared and the private row', async () => {
    const { db, sql } = dbm;
    const { storeSnapshots } = await import('../floor-arena/discovery-hub');
    const mint = fakeMint();
    const t1 = new Date(Date.now() - 60_000);
    const t2 = new Date(Date.now() - 20_000);
    await addDiscoveryRow(mint, new Date(t1.getTime() - 15_000));
    await db.execute(sql`INSERT INTO floor_arena_private_mints (agent_id, mint, source) VALUES (${agentId}, ${mint}, 'test-addon')`);
    const s1 = await snapshotOf(mint, 0.001, t1.getTime());
    const s2 = await snapshotOf(mint, 0.002, t2.getTime());
    await storeSnapshots([{ mint, snapshot: s1, symbol: 'TST', name: 'Test' }], t1);
    await storeSnapshots([{ mint, snapshot: s2, symbol: 'TST', name: 'Test' }], t2);
    const shared = (await db.execute(sql`
      SELECT snapshot, first_snapshot, first_snapshot_at FROM floor_discovery_mints WHERE mint = ${mint}
    `)) as unknown as Array<Record<string, any>>;
    expect(shared[0]!.snapshot.priceUsd).toBe(0.002);
    expect(shared[0]!.first_snapshot.priceUsd).toBe(0.001);
    expect(new Date(shared[0]!.first_snapshot_at).getTime()).toBe(t1.getTime());
    const priv = (await db.execute(sql`
      SELECT snapshot, first_snapshot, first_snapshot_at FROM floor_arena_private_mints WHERE agent_id = ${agentId} AND mint = ${mint}
    `)) as unknown as Array<Record<string, any>>;
    expect(priv[0]!.snapshot.priceUsd).toBe(0.002);
    expect(priv[0]!.first_snapshot.priceUsd).toBe(0.001);
    expect(new Date(priv[0]!.first_snapshot_at).getTime()).toBe(t1.getTime());
  });

  test('1a B3: a row priced before migration 0080 never gets a first snapshot', async () => {
    const { db, sql } = dbm;
    const { storeSnapshots } = await import('../floor-arena/discovery-hub');
    const mint = fakeMint();
    const old = Date.now() - 3_600_000;
    await addDiscoveryRow(mint, new Date(old - 60_000));
    await db.execute(sql`INSERT INTO floor_arena_private_mints (agent_id, mint, source) VALUES (${agentId}, ${mint}, 'test-addon')`);
    // The pre-0080 state: a snapshot already stored, first_snapshot NULL.
    const before = JSON.stringify(await snapshotOf(mint, 0.0005, old));
    await db.execute(sql`UPDATE floor_discovery_mints SET snapshot = ${before}::jsonb, snapshot_at = ${new Date(old).toISOString()}::timestamptz WHERE mint = ${mint}`);
    await db.execute(sql`UPDATE floor_arena_private_mints SET snapshot = ${before}::jsonb, snapshot_at = ${new Date(old).toISOString()}::timestamptz WHERE mint = ${mint}`);
    for (const price of [0.001, 0.002]) {
      await storeSnapshots([{ mint, snapshot: await snapshotOf(mint, price, Date.now()), symbol: 'TST', name: 'Test' }], new Date());
    }
    const rows = (await db.execute(sql`
      SELECT snapshot, first_snapshot, first_snapshot_at FROM floor_discovery_mints WHERE mint = ${mint}
      UNION ALL
      SELECT snapshot, first_snapshot, first_snapshot_at FROM floor_arena_private_mints WHERE mint = ${mint}
    `)) as unknown as Array<Record<string, any>>;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.snapshot.priceUsd).toBe(0.002);
      expect(row.first_snapshot).toBeNull();
      expect(row.first_snapshot_at).toBeNull();
    }
  });

  test('1b: an entry copies the first sight into entry_features.firstSight', async () => {
    const { db, sql, floorArenaAgents, eq } = dbm;
    const { storeSnapshots } = await import('../floor-arena/discovery-hub');
    const { openPosition } = await import('../floor-arena/engine');
    const mint = fakeMint();
    const nowMs = Date.now();
    const firstSeen = new Date(nowMs - 120_000);
    await addDiscoveryRow(mint, firstSeen);
    const first = await snapshotOf(mint, 0.001, nowMs - 100_000);
    const current = await snapshotOf(mint, 0.0012, nowMs - 5_000);
    await storeSnapshots([{ mint, snapshot: first, symbol: 'TST', name: 'Test' }], new Date(nowMs - 100_000));
    await storeSnapshots([{ mint, snapshot: current, symbol: 'TST', name: 'Test' }], new Date(nowMs - 5_000));
    const checkedAt = new Date(nowMs - 60_000).toISOString();
    await db.execute(sql`
      UPDATE floor_discovery_mints SET chain_verdict = ${JSON.stringify({ pass: true, fails: [], checkedAt, pairAddress })}::jsonb,
        chain_checked_at = ${checkedAt}::timestamptz WHERE mint = ${mint}
    `);
    const agent = (await db.select().from(floorArenaAgents).where(eq(floorArenaAgents.id, agentId)))[0]!;
    const outcome = await openPosition(agent, params, {
      mint, source: 'ds:token-profiles', symbol: 'TST', firstSeenAtMs: firstSeen.getTime(),
      features: { ...current, top10Pct: null }, verdict: 'pass', chainCheckedAtMs: Date.parse(checkedAt), isPrivate: false,
      tradeable: true, tradeableFirstSeenAtMs: firstSeen.getTime(), tradeableSource: 'ds:token-profiles',
    }, {
      ok: true, usd: 20, tokens: 16_000, entryPriceUsd: 0.00125, decimals: 6, quotedTokens: 16_400, impactPct: 0.5,
      driftPct: 1, venue: 'test', route: [],
    }, new Date(nowMs), () => nowMs);
    expect(outcome).toBe('opened');
    const rows = (await db.execute(sql`
      SELECT * FROM floor_arena_positions WHERE agent_id = ${agentId} AND mint = ${mint}
    `)) as unknown as Array<Record<string, any>>;
    const fs = rows[0]!.entry_features.firstSight;
    expect(fs).toMatchObject({
      source: 'ds:token-profiles', firstSeenAt: firstSeen.toISOString(), at: new Date(nowMs - 100_000).toISOString(),
      priceUsd: 0.001, mcap: 50_000, liqUsd: 20_000, chg5m: 1, chg1h: 2, chg6h: 3,
    });
    expect(typeof fs.ageS).toBe('number');
    await db.execute(sql`DELETE FROM floor_arena_positions WHERE id = ${rows[0]!.id}::uuid`);
  });

  test('2: the exit tick records the trough and a mark path without a quote', async () => {
    const mint = fakeMint();
    const base = Date.now();
    await addDiscoveryRow(mint, new Date(base - 300_000));
    const id = await addPosition({ mint, openedAtMs: base - 120_000, entryPriceUsd: 0.001, maxHoldS: 86_400 });
    await setSnapshot(mint, 0.0008, base - 50_000);
    await tick(new Date(base - 45_000), { quoteSell: noQuote });
    await tick(new Date(base - 40_000), { quoteSell: noQuote }); // same snapshot: no second point
    await setSnapshot(mint, 0.0009, base - 30_000);
    await tick(new Date(base - 25_000), { quoteSell: noQuote });
    let row = await positionOf(id);
    expect(Number(row.trough_mult)).toBeCloseTo(0.8, 9);
    expect(new Date(row.trough_at!).getTime()).toBe(base - 50_000);
    await setSnapshot(mint, 0.0007, base - 10_000);
    await tick(new Date(base - 5_000), { quoteSell: noQuote });
    row = await positionOf(id);
    expect(Number(row.trough_mult)).toBeCloseTo(0.7, 9);
    expect(new Date(row.trough_at!).getTime()).toBe(base - 10_000);
    const path = await pathOf(id);
    expect(path.map((p) => p.phase)).toEqual(['hold', 'hold', 'hold']);
    expect(path.map((p) => Number(p.mark_mult!.toFixed(6)))).toEqual([0.8, 0.9, 0.7]);
    expect(path.every((p) => p.quote_mult === null)).toBe(true);
  });

  test('2b: an exit quote is recorded at its own time and bucket; the closing tick mark counts for the trough', async () => {
    const mint = fakeMint();
    const base = Date.now();
    await addDiscoveryRow(mint, new Date(base - 600_000));
    const openedAtMs = base - 120_000;
    const id = await addPosition({ mint, openedAtMs, entryPriceUsd: 0.001, maxHoldS: 60 });
    await setSnapshot(mint, 0.00095, base - 3_000);
    const quoteAt = base + 500;
    const result = await tick(new Date(base), { quoteSell: okQuote(0.00097), clock: () => quoteAt });
    expect(result.closed).toBe(1);
    const row = await positionOf(id);
    expect(row.status).toBe('closed');
    expect(Number(row.trough_mult)).toBeCloseTo(0.95, 9);
    const path = await pathOf(id);
    expect(path.length).toBe(2);
    expect(new Date(path[0]!.bucket_at).getTime()).toBe(openedAtMs + 110_000);
    expect(path[0]!.mark_mult!).toBeCloseTo(0.95, 9);
    expect(path[0]!.quote_mult).toBeNull();
    expect(new Date(path[1]!.bucket_at).getTime()).toBe(openedAtMs + 120_000);
    expect(new Date(path[1]!.quote_at!).getTime()).toBe(quoteAt);
    expect(path[1]!.quote_mult!).toBeCloseTo(0.97, 9);
    expect(path[1]!.mark_mult).toBeNull();
  });

  test('3: a closed position gets tail points from stored snapshots only, for 30 minutes', async () => {
    const base = Date.now();
    const recent = fakeMint();
    const old = fakeMint();
    await addDiscoveryRow(recent, new Date(base - 3_600_000));
    await addDiscoveryRow(old, new Date(base - 3_600_000));
    const recentId = await addPosition({ mint: recent, openedAtMs: base - 1_200_000, entryPriceUsd: 0.001, maxHoldS: 900, closedAtMs: base - 300_000 });
    const oldId = await addPosition({ mint: old, openedAtMs: base - 3_000_000, entryPriceUsd: 0.001, maxHoldS: 900, closedAtMs: base - 31 * 60_000 });
    // A snapshot from before the close is not a tail point.
    await setSnapshot(recent, 0.0011, base - 310_000);
    await setSnapshot(old, 0.0011, base - 20_000);
    await tick(new Date(base - 15_000), { quoteSell: noQuote });
    expect(await pathOf(recentId)).toEqual([]);
    await setSnapshot(recent, 0.0012, base - 10_000);
    await tick(new Date(base - 5_000), { quoteSell: noQuote });
    await tick(new Date(base), { quoteSell: noQuote });
    const tail = await pathOf(recentId);
    expect(tail.length).toBe(1);
    expect(tail[0]!.phase).toBe('tail');
    expect(tail[0]!.mark_mult!).toBeCloseTo(1.2, 9);
    expect(await pathOf(oldId)).toEqual([]);
    expect((await positionOf(recentId)).trough_mult).toBeNull();
  });

  test('B1: the tail adds no DexScreener call and keeps no expired row', async () => {
    const { db, sql } = dbm;
    const { runEnrichmentTick, runDiscoveryExpiryTick, resetDiscoveryStateForTest } = await import('../floor-arena/discovery-hub');
    resetDiscoveryStateForTest();
    const base = Date.now();
    const mint = fakeMint();
    await addDiscoveryRow(mint, new Date(base - 2 * 86_400_000), new Date(base - 60_000));
    await addPosition({ mint, openedAtMs: base - 1_200_000, entryPriceUsd: 0.001, maxHoldS: 900, closedAtMs: base - 120_000 });
    const requested: string[] = [];
    const fakeFetch = (async (input: URL | string) => {
      requested.push(String(input));
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await runEnrichmentTick(new Date(base), fakeFetch);
    expect(requested.some((u) => u.includes(mint))).toBe(false);
    await runDiscoveryExpiryTick(new Date(base));
    const left = (await db.execute(sql`SELECT mint FROM floor_discovery_mints WHERE mint = ${mint}`)) as unknown as unknown[];
    expect(left.length).toBe(0);
  });

  test('B2: a failing recording write changes no trade and never reaches the tick', async () => {
    const mint = fakeMint();
    const base = Date.now();
    await addDiscoveryRow(mint, new Date(base - 600_000));
    const id = await addPosition({ mint, openedAtMs: base - 120_000, entryPriceUsd: 0.001, maxHoldS: 60 });
    await setSnapshot(mint, 0.00095, base - 3_000);
    let calls = 0;
    const result = await tick(new Date(base), {
      quoteSell: okQuote(0.00097),
      recordingWriter: async () => { calls += 1; throw new Error('injected recording failure'); },
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ exits: 1, closed: 1, errors: 0 });
    const row = await positionOf(id);
    expect(row.status).toBe('closed');
    expect(row.exit_reason).toBe('time');
    expect(row.trough_mult).toBeNull(); // the closing-tick trough was in the dropped job
    expect(await pathOf(id)).toEqual([]);
  });

  test('B2: a held lock on the marks table neither delays the tick nor holds the recording past its lock timeout', async () => {
    const postgres = (await import('postgres')).default;
    const { runExitTick, arenaRecordingSettled, ARENA_RECORDING_LOCK_TIMEOUT_MS } = await import('../floor-arena/engine');
    const mint = fakeMint();
    const base = Date.now();
    await addDiscoveryRow(mint, new Date(base - 600_000));
    const id = await addPosition({ mint, openedAtMs: base - 120_000, entryPriceUsd: 0.001, maxHoldS: 60 });
    await setSnapshot(mint, 0.00095, base - 3_000);
    const other = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await other.begin(async (t) => {
        await t`LOCK TABLE floor_arena_position_marks IN ACCESS EXCLUSIVE MODE`;
        const t0 = Date.now();
        const result = await runExitTick(new Date(base), { quoteSell: okQuote(0.00097) });
        const tickMs = Date.now() - t0;
        expect(result).toMatchObject({ exits: 1, closed: 1, errors: 0 });
        expect((await positionOf(id)).status).toBe('closed');
        await arenaRecordingSettled(); // fails on lock_timeout while the lock is still held
        const settledMs = Date.now() - t0;
        expect(tickMs).toBeLessThan(2_000);
        expect(settledMs).toBeLessThan(tickMs + ARENA_RECORDING_LOCK_TIMEOUT_MS + 1_500);
      });
    } finally {
      await other.end({ timeout: 5 });
    }
    expect(await pathOf(id)).toEqual([]);
  });

  test('privacy: no route that returns positions carries firstSight or trough fields (human and agent paths)', async () => {
    const { db, sql } = dbm;
    const { createFloorArenaRoutes } = await import('../../routes/floor-arena');
    const { createFloorArenaHouseBoardRoutes } = await import('../../routes/floor-arena-house-board');
    const { createRateLimiter } = await import('../../middleware/rate-limit');
    const { FLOOR_ARENA_HOUSE_AGENTS } = await import('@clawville/shared');
    const house = FLOOR_ARENA_HOUSE_AGENTS.find((h) => h.id === 'house:genesis')!;
    const added = (await db.execute(sql`
      INSERT INTO floor_arena_agents (id, kind, name, template_id, params, seated)
      VALUES ('house:genesis', 'house', ${house.name}, 'genesis', ${JSON.stringify(params)}::jsonb, true)
      ON CONFLICT (id) DO NOTHING RETURNING id
    `)) as unknown as unknown[];
    insertedHouse = added.length > 0;
    const base = Date.now();
    // An open and a closed position each, with the research fields set.
    for (const agent of ['house:genesis', agentId]) {
      await addPosition({ agent, mint: fakeMint(), openedAtMs: base - 60_000, entryPriceUsd: 0.001, maxHoldS: 86_400, tp: [[50, 1]], firstSight: true });
      await addPosition({ agent, mint: fakeMint(), openedAtMs: base - 600_000, entryPriceUsd: 0.001, maxHoldS: 900, closedAtMs: base - 60_000, firstSight: true });
    }
    const limiters = { public: () => createRateLimiter({ maxPerWindow: 1_000 }) };
    const arena = createFloorArenaRoutes(undefined, { auth: [], limiters });
    const board = createFloorArenaHouseBoardRoutes(undefined, { limiter: () => createRateLimiter({ maxPerWindow: 1_000 }) });
    // Human: no header (public). Agent: the same public routes with an agent session header (tools
    // clawville_arena_agent and the house-board line of clawville_arena_templates).
    const headerSets: Array<Record<string, string>> = [{}, { 'X-Clawville-Agent-Session': 'oc-test-session' }];
    const bodies: string[] = [];
    for (const headers of headerSets) {
      for (const path of ['/agents/house:genesis', `/agents/${agentId}`]) {
        const response = await arena.request(path, { headers });
        expect(response.status).toBe(200);
        bodies.push(await response.text());
      }
      const response = await board.request('/house-board', { headers });
      expect(response.status).toBe(200);
      bodies.push(await response.text());
    }
    const houseBody = JSON.parse(bodies[0]!) as { openPositions: Array<{ entryFeatures: Record<string, unknown> }>; closedPositions: unknown[] };
    expect(houseBody.openPositions.length).toBeGreaterThan(0);
    expect(houseBody.closedPositions.length).toBeGreaterThan(0);
    expect(houseBody.openPositions[0]!.entryFeatures.mcap).toBe(50_000); // house features are still served
    for (const body of bodies) {
      expect(body).not.toContain('firstSight');
      expect(body.toLowerCase()).not.toContain('trough');
    }
  });

  test('4: the prune archives old pass and skip events, still deletes other prunable types, keeps the record types', async () => {
    const { db, sql } = dbm;
    const { pruneArenaEvents } = await import('../floor-arena/events');
    const now = new Date();
    const old = new Date(now.getTime() - 8 * 86_400_000).toISOString();
    const fresh = new Date(now.getTime() - 86_400_000).toISOString();
    const inserted = (await db.execute(sql`
      INSERT INTO floor_arena_events (agent_id, at, type, mint, summary, data) VALUES
        (${agentId}, ${old}::timestamptz, 'pass', 'M1', 'old pass', '{"rank":1}'::jsonb),
        (${agentId}, ${old}::timestamptz, 'skip', 'M2', 'old skip', '{"reason":"cooldown"}'::jsonb),
        (${agentId}, ${old}::timestamptz, 'scan', NULL, 'old scan', NULL),
        (${agentId}, ${old}::timestamptz, 'entry', 'M3', 'old entry', NULL),
        (${agentId}, ${fresh}::timestamptz, 'pass', 'M4', 'new pass', NULL)
      RETURNING id, type, summary
    `)) as unknown as Array<{ id: number; type: string; summary: string }>;
    const idOf = (summary: string) => Number(inserted.find((r) => r.summary === summary)!.id);
    await pruneArenaEvents(now);
    // Only this test's rows (the earlier tests wrote entry and exit events for the same agent).
    const ids = JSON.stringify(inserted.map((r) => Number(r.id)));
    const live = ((await db.execute(sql`
      SELECT summary FROM floor_arena_events
      WHERE id IN (SELECT (jsonb_array_elements_text(${ids}::jsonb))::bigint) ORDER BY id
    `)) as unknown as Array<{ summary: string }>).map((r) => r.summary);
    expect(live).toEqual(['old entry', 'new pass']);
    const archived = (await db.execute(sql`
      SELECT id, type, mint, summary, data, at FROM floor_arena_events_archive WHERE agent_id = ${agentId} ORDER BY id
    `)) as unknown as Array<Record<string, any>>;
    expect(archived.map((r) => [Number(r.id), r.type, r.mint, r.summary])).toEqual([
      [idOf('old pass'), 'pass', 'M1', 'old pass'],
      [idOf('old skip'), 'skip', 'M2', 'old skip'],
    ]);
    expect(archived[1]!.data).toEqual({ reason: 'cooldown' });
    expect(new Date(archived[0]!.at).toISOString()).toBe(old);
  });

  test('4b: a second prune (a retry) archives nothing twice', async () => {
    const { db, sql } = dbm;
    const { pruneArenaEvents } = await import('../floor-arena/events');
    const now = new Date();
    const old = new Date(now.getTime() - 9 * 86_400_000).toISOString();
    const inserted = (await db.execute(sql`
      INSERT INTO floor_arena_events (agent_id, at, type, mint, summary) VALUES
        (${agentId}, ${old}::timestamptz, 'pass', 'R1', 'retry pass'),
        (${agentId}, ${old}::timestamptz, 'skip', 'R2', 'retry skip')
      RETURNING id
    `)) as unknown as Array<{ id: number }>;
    const ids = JSON.stringify(inserted.map((r) => Number(r.id)));
    await pruneArenaEvents(now);
    await pruneArenaEvents(now);
    const counts = (await db.execute(sql`
      SELECT id, count(*)::int AS n FROM floor_arena_events_archive
      WHERE id IN (SELECT (jsonb_array_elements_text(${ids}::jsonb))::bigint) GROUP BY id ORDER BY id
    `)) as unknown as Array<{ id: number; n: number }>;
    expect(counts.map((r) => r.n)).toEqual([1, 1]);
    const live = (await db.execute(sql`
      SELECT id FROM floor_arena_events WHERE id IN (SELECT (jsonb_array_elements_text(${ids}::jsonb))::bigint)
    `)) as unknown as unknown[];
    expect(live.length).toBe(0);
  });
});
