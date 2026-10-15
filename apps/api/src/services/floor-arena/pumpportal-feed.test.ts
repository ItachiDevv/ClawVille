import { describe, expect, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  applyCreate, applyTrade, earlyFacts, expireWatches, flowFacts, LEADER_LEASE_MS, newFlowState, parsePumpMessage,
  PUMPPORTAL_WS_URL, PumpPortalFeed, pumpPortalEnabled, pumpPortalUrl, reconnectDelayMs, redactPumpPortalText,
  STALE_SOCKET_MS, toFlowRow, watchMint, windowFacts, type FeedSocket, type FlowTrade, type PumpEvent, type WatchEntry,
} from './pumpportal-feed';

const MINT = 'DUspkcdu8Z9EttBLz6Lp87HaNbE4Hn93BdrgZfUvpump';
const CREATOR = 'HT9e1ZuEmTupYQjk4mRWu37EFYKB5ENFH82Zyi1YUp8i';
const A = '4xuZxUnpVA6yw5x1SJGDjbQpCybupRVsL4XJTvoy2FBV';
const B = '7rBNFq9ssADTaRdnkoD5V5c9FYwaL34XYSoaHz1kB3yL';
const T0 = Date.parse('2026-10-15T12:00:00Z');

// Frames as observed on wss://pumpportal.fun/api/data on 2026-10-15 (create / migrate / message).
const CREATE_FRAME = {
  signature: 'sig', mint: MINT, traderPublicKey: CREATOR, txType: 'create', initialBuy: 60735849.056603, solAmount: 1.8,
  bondingCurveKey: '6KtR3n3PdnbspY1ngSJt1CJPjbBZEGuEeKFWW2TrLA9a', vTokensInBondingCurve: 1012264150.943397,
  vSolInBondingCurve: 31.8, marketCapSol: 31.414725069897433, name: 'alux gubney', symbol: 'GUBNEY',
  uri: 'https://example.invalid/x.json', is_mayhem_mode: false, pool: 'pump',
};
const MIGRATE_FRAME = { signature: 'sig', mint: 'ahj9cQ4uVfromvTx9ZxANPCgF7giczQjZFdqiKbpump', txType: 'migrate', pool: 'pump-amm' };
const REFUSAL = { message: "'subscribeTokenTrade' and 'subscribeAccountTrade' methods are only available when connecting with an API key funded with at least 0.02 SOL." };

function trade(side: 'buy' | 'sell', trader: string, sol: number, newTokenBalance: number | null = null): Extract<PumpEvent, { kind: 'trade' }> {
  return { kind: 'trade', mint: MINT, side, trader, solAmount: sol, tokenAmount: 1, newTokenBalance, vSol: 40, marketCapSol: 50, pool: 'pump' };
}

describe('parsePumpMessage', () => {
  test('create, migrate, message and trade frames', () => {
    const create = parsePumpMessage(CREATE_FRAME);
    expect(create).toMatchObject({ kind: 'create', mint: MINT, creator: CREATOR, pool: 'pump', symbol: 'GUBNEY', solAmount: 1.8, vSol: 31.8 });
    expect(parsePumpMessage(MIGRATE_FRAME)).toEqual({ kind: 'migrate', mint: MIGRATE_FRAME.mint, pool: 'pump-amm' });
    expect(parsePumpMessage(REFUSAL)).toMatchObject({ kind: 'message' });
    expect(parsePumpMessage({ ...CREATE_FRAME, txType: 'sell', tokenAmount: 5, newTokenBalance: 0 }))
      .toMatchObject({ kind: 'trade', side: 'sell', trader: CREATOR, solAmount: 1.8, newTokenBalance: 0 });
  });

  test('rejects bad shapes, quote mints, bad numbers and bad pools', () => {
    expect(parsePumpMessage(null)).toBeNull();
    expect(parsePumpMessage([CREATE_FRAME])).toBeNull();
    expect(parsePumpMessage({ ...CREATE_FRAME, txType: 'swap' })).toBeNull();
    expect(parsePumpMessage({ ...CREATE_FRAME, mint: 'So11111111111111111111111111111111111111112' })).toBeNull();
    expect(parsePumpMessage({ ...CREATE_FRAME, mint: 'not a mint' })).toBeNull();
    const odd = parsePumpMessage({ ...CREATE_FRAME, solAmount: -1, marketCapSol: 'x', pool: 'Bad Pool!', traderPublicKey: 'x' });
    expect(odd).toMatchObject({ solAmount: null, marketCapSol: null, pool: null, creator: null });
  });
});

describe('flow aggregation', () => {
  test('windowFacts: counts, SOL, unique traders, largest buyer share, coverage', () => {
    const trades: FlowTrade[] = [
      { atMs: T0 - 10 * 60_000, side: 'buy', trader: A, sol: 5 },
      { atMs: T0 - 2 * 60_000, side: 'buy', trader: A, sol: 1 },
      { atMs: T0 - 30_000, side: 'buy', trader: A, sol: 3 },
      { atMs: T0 - 20_000, side: 'buy', trader: B, sol: 1 },
      { atMs: T0 - 10_000, side: 'sell', trader: B, sol: 0.5 },
      { atMs: T0 - 5_000, side: 'sell', trader: null, sol: 0.25 },
    ];
    expect(windowFacts(trades, T0, 60_000, T0 - 20 * 60_000)).toEqual({
      coveredS: 60, buys: 2, sells: 2, buySol: 4, sellSol: 0.75, uniqueBuyers: 2, uniqueSellers: 1, topBuyerShare: 0.75,
    });
    expect(windowFacts(trades, T0, 5 * 60_000, T0 - 20 * 60_000)).toMatchObject({ buys: 3, buySol: 5, topBuyerShare: 0.8 });
    expect(windowFacts(trades, T0, 15 * 60_000, T0 - 20 * 60_000)).toMatchObject({ buys: 4, buySol: 10, topBuyerShare: 0.9 });
    // A subscription that began 3 min ago covers 180 s of the 5-min window and ignores older trades.
    expect(windowFacts(trades, T0, 5 * 60_000, T0 - 3 * 60_000)).toMatchObject({ coveredS: 180, buys: 3 });
    expect(windowFacts(trades, T0, 60_000, null)).toBeNull();
    expect(windowFacts([], T0, 60_000, T0 - 60_000)).toMatchObject({ buys: 0, topBuyerShare: null });
  });

  test('creator buy and sell, creator sold, early buyers and their held share', () => {
    const s = newFlowState(MINT, T0);
    s.tradeSince = T0 + 500;
    applyCreate(s, parsePumpMessage(CREATE_FRAME) as Extract<PumpEvent, { kind: 'create' }>, T0);
    applyTrade(s, trade('buy', A, 2, 50_000_000), T0 + 10_000);
    applyTrade(s, trade('buy', B, 1, 20_000_000), T0 + 59_000);
    applyTrade(s, trade('buy', 'So1aBuyerAfterTheFirstMinuteXXXXXXXXXXXXXX', 1, 10_000_000), T0 + 61_000);
    applyTrade(s, trade('sell', A, 1.5, 10_000_000), T0 + 70_000);
    applyTrade(s, trade('sell', CREATOR, 2.1, 0), T0 + 80_000);
    const f = flowFacts(s, T0 + 90_000);
    expect(f.creator).toBe(CREATOR);
    expect(f.creatorBuySol).toBe(1.8);
    expect(f.creatorSellSol).toBe(2.1);
    expect(f.creatorSold).toBe(true);
    // Creator (dev buy) + A + B; held = 0 + 10M + 20M of 1e9 = 3 %.
    expect(f.earlyBuyers).toBe(3);
    expect(f.earlyHeldPct).toBe(3);
    expect(f.tradeFlow).toBe(true);
    // 1-min window (T0+30 s, T0+90 s]: the buys at 59 s and 61 s, both sells.
    expect(f.w1m).toMatchObject({ buys: 2, buySol: 2, topBuyerShare: 0.5, sells: 2, sellSol: 3.6, uniqueSellers: 2 });
    expect(f.lastMarketCapSol).toBe(50);
    expect(toFlowRow(f)).toMatchObject({ mint: MINT, creator_sold: true, early_held_pct: 3, trade_flow: true });
  });

  test('without trade flow: windows, creator sell and early facts are unknown (null), never zero', () => {
    const s = newFlowState(MINT, T0);
    applyCreate(s, parsePumpMessage(CREATE_FRAME) as Extract<PumpEvent, { kind: 'create' }>, T0);
    const f = flowFacts(s, T0 + 1_000);
    expect(f).toMatchObject({
      tradeFlow: false, w1m: null, w5m: null, w15m: null, creatorBuySol: 1.8, creatorSellSol: null, creatorSold: null,
      earlyBuyers: null, earlyHeldPct: null, lastMarketCapSol: 31.414725, lastVSol: 31.8, pool: 'pump',
    });
  });

  test('early facts need a subscription that began within 5 s of the create, known balances and a fixed supply', () => {
    const s = newFlowState(MINT, T0);
    applyCreate(s, parsePumpMessage(CREATE_FRAME) as Extract<PumpEvent, { kind: 'create' }>, T0);
    s.tradeSince = T0 + 6_000;
    expect(earlyFacts(s)).toEqual({ earlyBuyers: null, earlyHeldPct: null });
    s.tradeSince = T0 + 1_000;
    applyTrade(s, trade('buy', A, 1, null), T0 + 2_000);
    expect(earlyFacts(s)).toEqual({ earlyBuyers: 2, earlyHeldPct: null });
    s.early.set(A, 1_000_000);
    s.pool = 'pump-amm';
    expect(earlyFacts(s).earlyHeldPct).toBeNull();
  });

  test('trades older than 15 min are pruned', () => {
    const s = newFlowState(MINT, T0);
    s.tradeSince = T0;
    applyTrade(s, trade('buy', A, 1), T0);
    applyTrade(s, trade('buy', B, 1), T0 + 16 * 60_000);
    expect(s.trades).toHaveLength(1);
    expect(flowFacts(s, T0 + 16 * 60_000).w15m).toMatchObject({ buys: 1 });
  });
});

describe('watch set', () => {
  test('cap evicts the oldest non-position watch; extensions stop at 2 h from the start', () => {
    const watch = new Map<string, WatchEntry>();
    watchMint(watch, 'p', 'position', 60_000, T0, 3);
    watchMint(watch, 'a', 'new', 60_000, T0 + 1, 3);
    watchMint(watch, 'b', 'new', 60_000, T0 + 2, 3);
    const r = watchMint(watch, 'c', 'migration', 60_000, T0 + 3, 3);
    expect(r).toEqual({ added: true, evicted: ['a'] });
    expect([...watch.keys()]).toEqual(['p', 'b', 'c']);
    expect(watchMint(watch, 'b', 'migration', 10 * 3_600_000, T0 + 4, 3)).toEqual({ added: false, evicted: [] });
    expect(watch.get('b')).toMatchObject({ untilMs: T0 + 2 + 2 * 3_600_000, reason: 'migration' });
    expect(expireWatches(watch, T0 + 60_004)).toEqual(['p', 'c']);
    expect([...watch.keys()]).toEqual(['b']);
  });
});

describe('env, URL and redaction', () => {
  test('kill switch defaults on', () => {
    expect(pumpPortalEnabled({})).toBe(true);
    expect(pumpPortalEnabled({ FLOOR_ARENA_PUMPPORTAL_ENABLED: 'FALSE ' })).toBe(false);
    expect(pumpPortalEnabled({ FLOOR_ARENA_PUMPPORTAL_ENABLED: 'true' })).toBe(true);
  });

  test('the key only rides the socket URL and never survives redaction', () => {
    const key = 'abc123+/=secretKEY';
    expect(pumpPortalUrl(null)).toBe(PUMPPORTAL_WS_URL);
    const url = pumpPortalUrl(key);
    expect(url).toContain('api-key=');
    const logged = redactPumpPortalText(`connect failed: ${url} (raw ${key})`, key);
    expect(logged).not.toContain(key);
    expect(logged).not.toContain(encodeURIComponent(key));
    expect(logged).toContain('api-key=<redacted>');
  });

  test('reconnect backoff doubles from 2 s and caps at 5 min', () => {
    expect([1, 2, 3, 4].map(reconnectDelayMs)).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(reconnectDelayMs(30)).toBe(300_000);
  });
});

// ---------------------------------------------------------------- the feed with a fake socket

class FakeSocket implements FeedSocket {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  onopen: FeedSocket['onopen'] = null;
  onmessage: FeedSocket['onmessage'] = null;
  onclose: FeedSocket['onclose'] = null;
  onerror: FeedSocket['onerror'] = null;
  constructor(readonly url: string) {}
  send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close() { this.closed = true; }
  frame(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
}

function harness(env: Record<string, string | undefined> = {}) {
  let now = T0;
  const sockets: FakeSocket[] = [];
  const upserts: Array<Array<{ mint: string; source: string }>> = [];
  const statements: SQL[] = [];
  const feed = new PumpPortalFeed({
    env,
    clock: () => now,
    random: () => 0.5,
    watchdog: false,
    createSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    upsert: async (sightings) => { upserts.push(sightings.map((s) => ({ mint: s.mint, source: s.source }))); },
    openPositionMints: async () => [],
    database: { execute: (async (statement: SQL) => { statements.push(statement); return []; }) as never },
  });
  return { feed, sockets, upserts, statements, setNow: (ms: number) => { now = ms; }, at: () => now };
}

describe('PumpPortalFeed', () => {
  test('one socket; subscribes new tokens + migrations on open; upserts sightings and flow rows on the tick', async () => {
    const h = harness();
    await h.feed.tick(new Date(T0));
    await h.feed.tick(new Date(T0 + 1));
    expect(h.sockets).toHaveLength(1);
    const sock = h.sockets[0]!;
    expect(sock.url).toBe(PUMPPORTAL_WS_URL);
    sock.onopen?.({});
    expect(sock.sent).toEqual([{ method: 'subscribeNewToken' }, { method: 'subscribeMigration' }]);
    sock.frame(CREATE_FRAME);
    sock.frame(MIGRATE_FRAME);
    sock.frame('not json');
    const status = await h.feed.tick(new Date(T0 + 15_000));
    expect(h.upserts).toEqual([[{ mint: MINT, source: 'pumpportal:new' }, { mint: MIGRATE_FRAME.mint, source: 'pumpportal:migration' }]]);
    expect(status).toMatchObject({ connected: true, keyConfigured: false, tradeFlow: false, watched: 2, creates: 1, migrations: 1, sightingsFlushed: 2, flowRowsFlushed: 2 });
    // Without a key no trade subscription is ever sent.
    expect(sock.sent.some((m) => m.method === 'subscribeTokenTrade')).toBe(false);
    const flush = new PgDialect().sqlToQuery(h.statements.at(-1)!);
    expect(flush.sql).toContain('INSERT INTO floor_pumpportal_flow');
    const rows = JSON.parse(String(flush.params.find((p) => typeof p === 'string' && p.startsWith('[')))) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.mint)).toEqual([MINT, MIGRATE_FRAME.mint].sort());
    expect(rows.find((r) => r.mint === MINT)).toMatchObject({ creator: CREATOR, trade_flow: false, w1m: null });
    expect(h.feed.facts(MINT, T0 + 15_000)).toMatchObject({ creatorBuySol: 1.8 });
  });

  test('with a key: trade subscriptions, trade facts, refusal turns trade flow off, evict unsubscribes', async () => {
    const key = 'k3y-for-test';
    const h = harness({ PUMPPORTAL_API_KEY: key });
    await h.feed.tick(new Date(T0));
    const sock = h.sockets[0]!;
    expect(sock.url).toBe(`${PUMPPORTAL_WS_URL}?api-key=${key}`);
    sock.onopen?.({});
    sock.frame(CREATE_FRAME);
    expect(sock.sent.at(-1)).toEqual({ method: 'subscribeTokenTrade', keys: [MINT] });
    h.setNow(T0 + 5_000);
    sock.frame({ ...CREATE_FRAME, txType: 'buy', traderPublicKey: A, solAmount: 2, tokenAmount: 1, newTokenBalance: 5 });
    expect(h.feed.facts(MINT, T0 + 5_000)).toMatchObject({ tradeFlow: true, w1m: { buys: 1, buySol: 2 } });
    sock.frame(REFUSAL);
    const status = h.feed.status();
    expect(status).toMatchObject({ tradeRefused: true, tradeFlow: false });
    expect(status.lastNotice).not.toContain(key);
    expect(h.feed.facts(MINT, T0 + 5_000)?.w1m).toBeNull();
    // Expiry after 30 min unsubscribes only while trade flow is live; refused -> nothing sent.
    const before = sock.sent.length;
    await h.feed.tick(new Date(T0 + 31 * 60_000));
    expect(h.feed.watch.size).toBe(0);
    expect(sock.sent.length).toBe(before);
  });

  test('stale socket, close and error reconnect with backoff; a missing leader tick closes the socket', async () => {
    const h = harness();
    await h.feed.tick(new Date(T0));
    h.sockets[0]!.onopen?.({});
    h.setNow(T0 + STALE_SOCKET_MS + 1);
    await h.feed.tick(new Date(T0 + STALE_SOCKET_MS + 1));
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.feed.connected).toBe(false);
    // Backoff 2 s (x1.0 jitter at random 0.5): not before, then a new socket.
    await h.feed.tick(new Date(T0 + STALE_SOCKET_MS + 1_000));
    expect(h.sockets).toHaveLength(1);
    await h.feed.tick(new Date(T0 + STALE_SOCKET_MS + 2_001));
    expect(h.sockets).toHaveLength(2);
    // A late event from the dead socket is ignored.
    h.sockets[0]!.frame(CREATE_FRAME);
    expect(h.feed.watch.size).toBe(0);
    h.sockets[1]!.onopen?.({});
    h.sockets[1]!.onerror?.({});
    h.sockets[1]!.onclose?.({});
    expect(h.feed.connected).toBe(false);
    expect(h.feed.status().reconnects).toBe(2);
    // Lease: no tick for 45 s -> the socket closes and the watch set is cleared.
    await h.feed.tick(new Date(h.at() + 60_000));
    h.sockets[2]!.onopen?.({});
    h.sockets[2]!.frame(CREATE_FRAME);
    expect(h.feed.checkLease(h.at() + 60_000 + LEADER_LEASE_MS - 1)).toBe(true);
    expect(h.feed.checkLease(h.at() + 60_000 + LEADER_LEASE_MS + 1)).toBe(false);
    expect(h.sockets[2]!.closed).toBe(true);
    expect(h.feed.watch.size).toBe(0);
  });

  test('kill switch: no socket, and an open one closes', async () => {
    const env: Record<string, string | undefined> = {};
    const h = harness(env);
    await h.feed.tick(new Date(T0));
    h.sockets[0]!.onopen?.({});
    env.FLOOR_ARENA_PUMPPORTAL_ENABLED = 'false';
    const status = await h.feed.tick(new Date(T0 + 15_000));
    expect(status.enabled).toBe(false);
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.sockets).toHaveLength(1);
  });
});
