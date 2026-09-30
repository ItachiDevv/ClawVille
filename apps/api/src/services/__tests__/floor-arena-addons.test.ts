import { beforeEach, describe, expect, test } from 'bun:test';
import { FLOOR_ARENA_ADDONS, FLOOR_ARENA_TEMPLATES, type FloorArenaAddon } from '@clawville/shared';
import { ClawPumpWriterError, type ClawPumpX402Result, type X402PayInput } from '../clawpump-writer';
import {
  _resetArenaAddonsForTest,
  addonPaymentsEnabled,
  buildAddonRequest,
  extractAddonMints,
  extractMintsAtPath,
  extractResponseRef,
  mayHaveCharged,
  checkAddonCall,
  isDocumentedNoChargeFailure,
  runArenaAddonAgent,
  runArenaAddonsTick,
  utcDayStart,
  type ArenaAddonDeps,
} from '../floor-arena/addons';
import type { ArenaAddonCallStat, ArenaAgentAddon, ArenaAgentRecord } from '../floor-arena/queries';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WSOL = 'So11111111111111111111111111111111111111112';
const NOW = new Date('2026-10-01T12:00:00Z');
const CP_ID = '99999999-8888-4777-8666-555555555555';

const FEED: FloorArenaAddon = {
  id: 'feed-a', vendor: 'vendor', name: 'Feed A', url: 'https://api.nansen.ai/api/v1/test', method: 'GET',
  query: { chain: 'solana' }, body: null, dedupeVary: null, priceUsd: 0.1, minIntervalS: 600, mintPath: 'data[].mint',
  symbolPath: null, note: '',
};
const FEED_B: FloorArenaAddon = { ...FEED, id: 'feed-b', name: 'Feed B', query: {}, mintPath: 'tokens[].address' };

function agent(addons: ArenaAgentAddon[], overrides: Partial<ArenaAgentRecord> = {}): ArenaAgentRecord {
  return {
    id: 'agent-1', kind: 'user', ownerUserId: 'owner', avatarId: 'avatar', name: 'Bob', templateId: 'genesis',
    params: FLOOR_ARENA_TEMPLATES[0]!.params, paramsVersion: 1, mode: 'paper', status: 'active', seated: true,
    seatIndex: 0, seatedAt: NOW, clawpumpAgentId: CP_ID, clawpumpWallet: 'W', provisionState: 'ready',
    provisionError: null, provisionAttempts: 0, provisionNextAt: null, addons, autoApplySuggestions: false,
    contestId: 'arena-week-1', createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}

interface LedgerRow {
  id: number;
  agentId: string;
  addonId: string;
  at: Date;
  priceUsd: number;
  ok: boolean;
  error: string | null;
  mints: number;
  responseRef: string | null;
  state: 'reserved' | 'done';
}

interface Harness {
  deps: ArenaAddonDeps;
  pays: Array<{ clawpumpAgentId: string; input: X402PayInput }>;
  /** The fake ledger (floor_arena_addon_calls), reservations included. */
  calls: LedgerRow[];
  mints: string[];
  symbols: Array<string | null>;
  events: string[];
  skillSyncs: number;
}

/**
 * The fake ledger behaves like the SQL: stats = seeded stats + ledger rows
 * (reservations counted at their price), and `reserveCall` runs the check and
 * appends the row with no await in between, which is what the advisory lock
 * guarantees in Postgres.
 */
function harness(options: {
  catalog?: FloorArenaAddon[];
  agents?: ArenaAgentRecord[];
  stats?: ArenaAddonCallStat[];
  balance?: number | null;
  pay?: (input: X402PayInput) => Promise<ClawPumpX402Result>;
  enabled?: boolean;
  skill?: boolean | undefined;
  ensureSkill?: () => Promise<boolean>;
  finalize?: () => Promise<void>;
  ledger?: LedgerRow[];
  /** The agent row as the reservation transaction re-reads it (Codex r3 #10). */
  current?: () => ArenaAgentRecord;
} = {}): Harness {
  let skill = 'skill' in options ? options.skill : true;
  const ledger: LedgerRow[] = options.ledger ?? [];
  const statsFrom = (agentId: string, dayStart: Date): ArenaAddonCallStat[] => {
    const byAddon = new Map<string, ArenaAddonCallStat>((options.stats ?? []).map((row) => [row.addonId, { ...row }]));
    for (const row of ledger.filter((entry) => entry.agentId === agentId)) {
      const stat = byAddon.get(row.addonId)
        ?? { addonId: row.addonId, spentTodayUsd: 0, lastAt: null, lastOk: null, lastError: null, callsTotal: 0 };
      if (row.at >= dayStart) stat.spentTodayUsd += row.priceUsd;
      stat.callsTotal += 1;
      if (!stat.lastAt || row.at >= stat.lastAt) {
        stat.lastAt = row.at;
        stat.lastOk = row.ok;
        stat.lastError = row.error;
      }
      byAddon.set(row.addonId, stat);
    }
    return [...byAddon.values()];
  };
  const h: Harness = {
    pays: [], calls: ledger, mints: [], symbols: [], events: [], skillSyncs: 0,
    deps: {
      catalog: () => options.catalog ?? [FEED],
      paymentsEnabled: () => options.enabled ?? true,
      listAgents: async () => options.agents ?? [agent([{ id: 'feed-a', enabled: true, dailyCapUsd: 1 }])],
      readStats: async (agentId, dayStart) => statsFrom(agentId, dayStart),
      reserveCall: async (input) => {
        const now = options.current ? options.current() : (options.agents ?? [agent([{ id: 'feed-a', enabled: true, dailyCapUsd: 1 }])])[0]!;
        const entry = now.addons.find((addon) => addon.id === input.addonId);
        if (now.status !== 'active' || now.provisionState !== 'ready' || now.clawpumpAgentId !== input.clawpumpAgentId || !entry?.enabled) {
          return { reserved: false, check: { ok: false, reason: 'agent_changed', spentUsd: 0, capUsd: 0 } };
        }
        const stats = statsFrom(input.agentId, input.dayStart);
        const verdict = input.check(stats, entry.dailyCapUsd);
        if (!verdict.ok) return { reserved: false, check: verdict };
        const id = ledger.length + 1;
        ledger.push({
          id, agentId: input.agentId, addonId: input.addonId, at: input.at, priceUsd: input.priceUsd,
          ok: false, error: null, mints: 0, responseRef: null, state: 'reserved',
        });
        return { reserved: true, id, callNumber: stats.find((row) => row.addonId === input.addonId)?.callsTotal ?? 0 };
      },
      finalizeCall: async (id, result) => {
        if (options.finalize) return options.finalize();
        const row = ledger.find((entry) => entry.id === id && entry.state === 'reserved');
        if (row) Object.assign(row, result, { state: 'done' });
      },
      insertPrivateMints: async (_agentId, _addonId, tokens) => {
        h.mints.push(...tokens.map((token) => token.mint));
        h.symbols.push(...tokens.map((token) => token.symbol));
        return tokens.length;
      },
      insertEvent: async (_agentId, event) => { h.events.push(event.summary); },
      walletUsdc: async () => ('balance' in options ? options.balance ?? null : 10),
      skillSynced: () => skill,
      ensureSkill: async () => {
        h.skillSyncs += 1;
        const result = options.ensureSkill ? await options.ensureSkill() : true;
        skill = true;
        return result;
      },
      pay: async (clawpumpAgentId, input) => {
        h.pays.push({ clawpumpAgentId, input });
        return options.pay ? options.pay(input) : { ok: true, error: null, payload: { data: [{ mint: USDC }, { mint: BONK }] } };
      },
    },
  };
  return h;
}

beforeEach(() => _resetArenaAddonsForTest());

describe('runArenaAddonsTick', () => {
  test('pays the catalog price as the cap, stores private mints, and books one ledger row', async () => {
    const h = harness();
    await runArenaAddonsTick(NOW, h.deps);
    expect(h.pays).toEqual([{
      clawpumpAgentId: CP_ID,
      input: { url: FEED.url, method: 'GET', query: { chain: 'solana' }, maxAmountUsd: 0.1 },
    }]);
    expect(h.mints).toEqual([USDC, BONK]);
    expect(h.calls).toEqual([{
      id: 1, agentId: 'agent-1', addonId: 'feed-a', at: NOW, priceUsd: 0.1, ok: true, error: null, mints: 2, responseRef: null,
      state: 'done',
    }]);
    expect(h.events[0]).toContain('Feed A: paid $0.10, 2 tokens (2 new');
  });

  test('the kill switch and an empty catalog stop everything', async () => {
    const off = harness({ enabled: false });
    await runArenaAddonsTick(NOW, off.deps);
    expect(off.pays).toHaveLength(0);
    _resetArenaAddonsForTest();
    const empty = harness({ catalog: [] });
    await runArenaAddonsTick(NOW, empty.deps);
    expect(empty.pays).toHaveLength(0);
    expect(addonPaymentsEnabled({})).toBe(true);
    expect(addonPaymentsEnabled({ FLOOR_ARENA_ADDON_PAYMENTS_ENABLED: 'false' })).toBe(false);
    expect(addonPaymentsEnabled({ FLOOR_ARENA_ADDON_PAYMENTS_ENABLED: ' FALSE ' })).toBe(false);
    expect(addonPaymentsEnabled({ FLOOR_ARENA_ADDON_PAYMENTS_ENABLED: 'true' })).toBe(true);
  });

  test('respects a catalog interval above the 600 s floor, measured from the last attempt', async () => {
    const slow = { ...FEED, minIntervalS: 900 };
    const at = (minutesAgo: number) => [{
      addonId: 'feed-a', spentTodayUsd: 0.1, lastAt: new Date(NOW.getTime() - minutesAgo * 60_000),
      lastOk: false, lastError: 'x', callsTotal: 3,
    }];
    const recent = harness({ catalog: [slow], stats: at(10) });
    await runArenaAddonsTick(NOW, recent.deps);
    expect(recent.pays).toHaveLength(0);
    _resetArenaAddonsForTest();
    const old = harness({ catalog: [slow], stats: at(16) });
    await runArenaAddonsTick(NOW, old.deps);
    expect(old.pays).toHaveLength(1);
  });

  test('D15: a catalog interval below 600 s is floored at 600 s', async () => {
    const fast = { ...FEED, minIntervalS: 300 };
    const at = (minutesAgo: number) => [{
      addonId: 'feed-a', spentTodayUsd: 0.1, lastAt: new Date(NOW.getTime() - minutesAgo * 60_000),
      lastOk: true, lastError: null, callsTotal: 1,
    }];
    const recent = harness({ catalog: [fast], stats: at(6) });
    await runArenaAddonsTick(NOW, recent.deps);
    expect(recent.pays).toHaveLength(0);
    _resetArenaAddonsForTest();
    const old = harness({ catalog: [fast], stats: at(11) });
    await runArenaAddonsTick(NOW, old.deps);
    expect(old.pays).toHaveLength(1);
  });

  test('never pays a host outside the vetted list, whatever the catalog says', async () => {
    const h = harness({ catalog: [{ ...FEED, url: 'https://evil.example/feed' }] });
    await runArenaAddonsTick(NOW, h.deps);
    expect(h.pays).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
    expect(h.events[0]).toContain('not on the vetted add-on list');
  });

  test('stops at the per add-on daily cap and says so once per day', async () => {
    const stats = [{ addonId: 'feed-a', spentTodayUsd: 0.95, lastAt: new Date(NOW.getTime() - 3_600_000), lastOk: true, lastError: null, callsTotal: 3 }];
    const h = harness({ stats });
    await runArenaAddonsTick(NOW, h.deps);
    await runArenaAddonsTick(new Date(NOW.getTime() + 3_600_000), h.deps);
    expect(h.pays).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
    expect(h.events.filter((line) => line.includes('daily cap reached'))).toHaveLength(1);
  });

  test('stops at the agent-wide $5 cap across add-ons, counting disabled ones', async () => {
    const h = harness({
      catalog: [FEED, FEED_B],
      agents: [agent([
        { id: 'feed-a', enabled: true, dailyCapUsd: 5 },
        { id: 'feed-b', enabled: false, dailyCapUsd: 5 },
      ])],
      stats: [{ addonId: 'feed-b', spentTodayUsd: 4.95, lastAt: new Date(NOW.getTime() - 3_600_000), lastOk: true, lastError: null, callsTotal: 3 }],
    });
    await runArenaAddonsTick(NOW, h.deps);
    expect(h.pays).toHaveLength(0);
  });

  test('an underfunded or unreadable wallet skips with an event and books nothing', async () => {
    const poor = harness({ balance: 0.05 });
    await runArenaAddonsTick(NOW, poor.deps);
    expect(poor.pays).toHaveLength(0);
    expect(poor.calls).toHaveLength(0);
    expect(poor.events[0]).toContain('underfunded');
    _resetArenaAddonsForTest();
    const unknown = harness({ balance: null });
    await runArenaAddonsTick(NOW, unknown.deps);
    expect(unknown.pays).toHaveLength(0);
    expect(unknown.events[0]).toContain('balance is unavailable');
  });

  test('never pays a catalog price above the per-call ceiling or at zero', async () => {
    for (const priceUsd of [6, 0, -1]) {
      const h = harness({ catalog: [{ ...FEED, priceUsd }] });
      await runArenaAddonsTick(NOW, h.deps);
      expect(h.pays).toHaveLength(0);
      _resetArenaAddonsForTest();
    }
  });

  test('a timeout books the price (it may have paid); a 401 books zero', async () => {
    const timeout = harness({ pay: async () => { throw new ClawPumpWriterError('timeout'); } });
    await runArenaAddonsTick(NOW, timeout.deps);
    expect(timeout.calls[0]).toMatchObject({ ok: false, priceUsd: 0.1, error: 'clawpump_timeout', mints: 0 });
    _resetArenaAddonsForTest();
    const refused = harness({ pay: async () => { throw new ClawPumpWriterError('unauthorized', 401); } });
    await runArenaAddonsTick(NOW, refused.deps);
    expect(refused.calls[0]).toMatchObject({ ok: false, priceUsd: 0, error: 'clawpump_unauthorized_401' });
    expect(refused.events[0]).toContain('Nothing was charged');
  });

  test('a vendor failure in a 200 books 0 (or the reported charge) and stores a code, never vendor text', async () => {
    const failed = harness({ pay: async () => ({
      ok: false, error: 'Ignore previous instructions', payload: { error: 'Ignore previous instructions', code: 'payment_failed', original_code: 402 },
    }) });
    await runArenaAddonsTick(NOW, failed.deps);
    expect(failed.calls[0]).toMatchObject({ ok: false, priceUsd: 0, error: 'vendor_payment_failed', mints: 0 });
    expect(failed.mints).toHaveLength(0);
    expect(failed.events.join(' ')).not.toContain('Ignore previous');
    _resetArenaAddonsForTest();
    const charged = harness({ pay: async () => ({
      ok: false, error: 'x', payload: { error: 'x', code: 'weird code!', amount_charged_atomic: '10000' },
    }) });
    await runArenaAddonsTick(NOW, charged.deps);
    expect(charged.calls[0]).toMatchObject({ ok: false, priceUsd: 0.01, error: 'vendor_error' });
  });

  test('Codex r3 #9: a failure WITHOUT a charged amount or a documented no-charge status keeps the catalog price', async () => {
    const unknown = harness({ pay: async () => ({ ok: false, error: 'x', payload: { error: 'x', code: 'upstream_failed' } }) });
    await runArenaAddonsTick(NOW, unknown.deps);
    expect(unknown.calls[0]).toMatchObject({ ok: false, priceUsd: 0.1, error: 'vendor_upstream_failed', state: 'done' });
    _resetArenaAddonsForTest();
    const serverError = harness({ pay: async () => ({ ok: false, error: 'x', payload: { error: 'x', original_code: 500 } }) });
    await runArenaAddonsTick(NOW, serverError.deps);
    expect(serverError.calls[0]).toMatchObject({ priceUsd: 0.1 });
    _resetArenaAddonsForTest();
    const zero = harness({ pay: async () => ({ ok: false, error: 'x', payload: { error: 'x', amount_charged_atomic: '0' } }) });
    await runArenaAddonsTick(NOW, zero.deps);
    expect(zero.calls[0]).toMatchObject({ priceUsd: 0 });
    _resetArenaAddonsForTest();
    for (const status of [400, '402', 422]) {
      const refused = harness({ pay: async () => ({ ok: false, error: 'x', payload: { error: 'x', original_code: status } }) });
      await runArenaAddonsTick(NOW, refused.deps);
      expect(refused.calls[0]).toMatchObject({ priceUsd: 0 });
      _resetArenaAddonsForTest();
    }
    expect(isDocumentedNoChargeFailure({ original_code: 402 })).toBe(true);
    expect(isDocumentedNoChargeFailure({ original_code: 503 })).toBe(false);
    expect(isDocumentedNoChargeFailure({})).toBe(false);
  });

  test('Codex r3 #10: the reservation re-reads the agent: disabled, lower cap, paused or re-pointed means no payment', async () => {
    const cases: Array<[string, (bob: ArenaAgentRecord) => ArenaAgentRecord]> = [
      ['disabled', (bob) => ({ ...bob, addons: [{ id: 'feed-a', enabled: false, dailyCapUsd: 1 }] })],
      ['cap lowered below today', (bob) => ({ ...bob, addons: [{ id: 'feed-a', enabled: true, dailyCapUsd: 0.05 }] })],
      ['paused', (bob) => ({ ...bob, status: 'paused' })],
      ['new ClawPump agent', (bob) => ({ ...bob, clawpumpAgentId: 'another-agent' })],
    ];
    for (const [, change] of cases) {
      const bob = agent([{ id: 'feed-a', enabled: true, dailyCapUsd: 1 }]);
      let current = bob;
      // The player changes settings between the tick's read and the reservation.
      const h = harness({ agents: [bob], current: () => current, balance: 10 });
      const walletUsdc = h.deps.walletUsdc;
      h.deps.walletUsdc = async (id) => { current = change(bob); return walletUsdc(id); };
      await runArenaAddonsTick(NOW, h.deps);
      expect(h.pays).toHaveLength(0);
      expect(h.calls).toHaveLength(0);
      _resetArenaAddonsForTest();
    }
  });

  test('ok: books the reported charge, else the catalog price; takes the tx from settlement', async () => {
    const sig = '5VxKqT7h9eYbZzN3q2mJcA8sLpR6wDfGu4HtXoBn1CkEi5VxKqT7h9eYbZzN3q2mJ';
    const reported = harness({ pay: async () => ({
      ok: true, error: null,
      payload: { paid: true, duplicate: false, amount_charged_atomic: '5000', settlement: { success: true, transaction: sig }, data: { data: [{ mint: USDC }] } },
    }) });
    await runArenaAddonsTick(NOW, reported.deps);
    expect(reported.calls[0]).toMatchObject({ ok: true, priceUsd: 0.005, mints: 1, responseRef: sig });
    expect(reported.mints).toEqual([USDC]);
  });

  test('duplicate:true books 0, ok, and parses nothing (cached old data)', async () => {
    const h = harness({ pay: async () => ({
      ok: true, error: null,
      payload: { paid: false, duplicate: true, settlement: { transaction: 'old' }, data: { data: [{ mint: USDC }] } },
    }) });
    await runArenaAddonsTick(NOW, h.deps);
    expect(h.calls[0]).toMatchObject({ ok: true, priceUsd: 0, mints: 0, responseRef: null, error: null });
    expect(h.mints).toHaveLength(0);
    expect(h.events[0]).toContain('cached duplicate');
  });

  test('stores a sanitised symbol next to each mint (Nansen shape)', async () => {
    const nansen: FloorArenaAddon = { ...FEED, mintPath: 'data[].token_address', symbolPath: 'data[].token_symbol' };
    const h = harness({
      catalog: [nansen],
      pay: async () => ({ ok: true, error: null, payload: { data: { data: [
        { token_address: USDC, token_symbol: '\u{1F680}USDC\u200B' },
        { token_address: BONK, token_symbol: 'BONK <script>' },
        { token_address: USDC, token_symbol: 'DUP' },
      ] } } }),
    });
    await runArenaAddonsTick(NOW, h.deps);
    expect(h.mints).toEqual([USDC, BONK]);
    expect(h.symbols).toEqual(['USDC', 'BONKscript']);
  });

  test('a crash after paying (finalize fails) leaves the reservation counted at the catalog price', async () => {
    const h = harness({ finalize: async () => { throw new Error('db down'); } });
    await runArenaAddonsTick(NOW, h.deps);
    expect(h.calls).toEqual([expect.objectContaining({ state: 'reserved', priceUsd: 0.1 })]);
    // Inside the interval: no second payment.
    await runArenaAddonsTick(new Date(NOW.getTime() + 60_000), h.deps);
    expect(h.pays).toHaveLength(1);
  });

  test('Codex r2 #3: two containers at once pay ONCE (the reservation serialises them)', async () => {
    const ledger: LedgerRow[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowPay = async () => { await gate; return { ok: true, error: null, payload: { data: [] } }; };
    const bob = agent([{ id: 'feed-a', enabled: true, dailyCapUsd: 1 }]);
    const a = harness({ ledger, pay: slowPay, current: () => bob });
    const b = harness({ ledger, pay: slowPay, current: () => bob });
    const catalog = new Map([[FEED.id, FEED]]);
    const both = Promise.all([runArenaAddonAgent(a.deps, bob, catalog, NOW), runArenaAddonAgent(b.deps, bob, catalog, NOW)]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await both;
    expect(a.pays.length + b.pays.length).toBe(1);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.state).toBe('done');
  });

  test('Codex r2 #3: two containers near the agent cap cannot both pay past it', async () => {
    const ledger: LedgerRow[] = [{
      id: 1, agentId: 'agent-1', addonId: 'feed-b', at: new Date(NOW.getTime() - 3_600_000), priceUsd: 4.85,
      ok: true, error: null, mints: 0, responseRef: null, state: 'done',
    }];
    const bob = agent([{ id: 'feed-a', enabled: true, dailyCapUsd: 5 }, { id: 'feed-c', enabled: true, dailyCapUsd: 5 }]);
    const feedC = { ...FEED, id: 'feed-c', name: 'Feed C' };
    const catalog = new Map([[FEED.id, FEED], [feedC.id, feedC]]);
    const a = harness({ ledger, current: () => bob });
    const b = harness({ ledger, current: () => bob });
    // Each pass alone fits ($4.85 + $0.10 <= $5); together they would not ($5.05).
    await Promise.all([runArenaAddonAgent(a.deps, bob, catalog, NOW), runArenaAddonAgent(b.deps, bob, catalog, NOW)]);
    const spent = ledger.filter((row) => row.at >= utcDayStart(NOW)).reduce((sum, row) => sum + row.priceUsd, 0);
    expect(spent).toBeLessThanOrEqual(5 + 1e-9);
    expect(a.pays.length + b.pays.length).toBe(1);
  });

  test('syncs the x402 skill before the first payment, and skips when that fails', async () => {
    const ok = harness({ skill: undefined });
    await runArenaAddonsTick(NOW, ok.deps);
    expect(ok.skillSyncs).toBe(1);
    expect(ok.pays).toHaveLength(1);
    _resetArenaAddonsForTest();
    const broken = harness({ skill: undefined, ensureSkill: async () => { throw new ClawPumpWriterError('http_error', 500); } });
    await runArenaAddonsTick(NOW, broken.deps);
    expect(broken.pays).toHaveLength(0);
    expect(broken.events[0]).toContain('could not enable x402');
  });

  test('skips an add-on that is not in the catalog', async () => {
    const h = harness({ agents: [agent([{ id: 'unknown-feed', enabled: true, dailyCapUsd: 1 }])] });
    await runArenaAddonsTick(NOW, h.deps);
    expect(h.pays).toHaveLength(0);
  });
});

describe('checkAddonCall (the cap rule used before and under the lock)', () => {
  const base = { addonId: 'feed-a', priceUsd: 0.1, addonCapUsd: 1, intervalMs: 600_000, nowMs: NOW.getTime() };
  const stat = (overrides: Partial<ArenaAddonCallStat>): ArenaAddonCallStat => ({
    addonId: 'feed-a', spentTodayUsd: 0, lastAt: null, lastOk: null, lastError: null, callsTotal: 0, ...overrides,
  });
  test('interval, add-on cap, agent cap, ok', () => {
    expect(checkAddonCall({ ...base, stats: [] })).toEqual({ ok: true });
    expect(checkAddonCall({ ...base, stats: [stat({ lastAt: new Date(NOW.getTime() - 599_000) })] }))
      .toMatchObject({ ok: false, reason: 'interval' });
    expect(checkAddonCall({ ...base, stats: [stat({ spentTodayUsd: 0.95, lastAt: new Date(NOW.getTime() - 3_600_000) })] }))
      .toMatchObject({ ok: false, reason: 'addon_cap', spentUsd: 0.95, capUsd: 1 });
    expect(checkAddonCall({ ...base, addonCapUsd: 5, stats: [stat({ addonId: 'other', spentTodayUsd: 4.95 })] }))
      .toMatchObject({ ok: false, reason: 'agent_cap', capUsd: 5 });
    // A player cap above $5 is clamped to $5.
    expect(checkAddonCall({ ...base, addonCapUsd: 50, stats: [stat({ spentTodayUsd: 4.95 })] }))
      .toMatchObject({ ok: false, reason: 'addon_cap', capUsd: 5 });
  });
});

describe('mint parsing', () => {
  test('walks simple paths and keeps only valid base58 32-44 strings, deduplicated', () => {
    expect(extractMintsAtPath({ data: [{ mint: USDC }, { mint: 'not-a-mint' }, { mint: USDC }, { mint: 42 }] }, 'data[].mint')).toEqual([USDC]);
    expect(extractMintsAtPath({ tokens: [{ address: BONK }, { address: WSOL }] }, 'tokens[].address')).toEqual([BONK, WSOL]);
    expect(extractMintsAtPath([{ mint: USDC }], '[].mint')).toEqual([USDC]);
    expect(extractMintsAtPath({ result: { mints: [USDC, BONK] } }, 'result.mints[]')).toEqual([USDC, BONK]);
    expect(extractMintsAtPath({ mint: USDC }, 'mint')).toEqual([USDC]);
    // 0, O, I and l are not base58.
    expect(extractMintsAtPath({ data: [{ mint: `0${USDC.slice(1)}` }] }, 'data[].mint')).toEqual([]);
    expect(extractMintsAtPath({ data: 'nope' }, 'data[].mint')).toEqual([]);
  });

  test('caps at 100 mints per call', () => {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const many = Array.from({ length: 150 }, (_, index) => ({
      mint: `${USDC.slice(0, 40)}${alphabet[index % 58]}${alphabet[Math.floor(index / 58)]}a`,
    }));
    expect(new Set(many.map((row) => row.mint)).size).toBe(150);
    expect(extractMintsAtPath({ data: many }, 'data[].mint')).toHaveLength(100);
  });

  test('unwraps the ClawPump wrapper and JSON-string bodies', () => {
    expect(extractAddonMints({ data: { data: [{ mint: USDC }] } }, 'data[].mint')).toEqual([USDC]);
    expect(extractAddonMints({ response: { body: JSON.stringify({ tokens: [{ address: BONK }] }) } }, 'tokens[].address')).toEqual([BONK]);
    expect(extractAddonMints({ result: JSON.stringify([{ mint: WSOL }]) }, '[].mint')).toEqual([WSOL]);
    expect(extractAddonMints({ status: 'ok' }, 'data[].mint')).toEqual([]);
  });

  test('finds a payment signature when one is present', () => {
    const sig = '5'.repeat(20) + 'VxKqT7h9eYbZzN3q2mJcA8sLpR6wDfGu4HtXoBn1CkEi';
    expect(extractResponseRef({ payment: { txSignature: sig } })).toBe(sig);
    expect(extractResponseRef({ payment: { note: sig } })).toBeNull();
    expect(extractResponseRef('x')).toBeNull();
  });
});

describe('dedupe rotation', () => {
  test('GET: rotates a query key through the values on successive calls', () => {
    const item: FloorArenaAddon = { ...FEED, dedupeVary: { path: 'limit', values: [50, 49] } };
    expect(buildAddonRequest(item, 0)).toEqual({ query: { chain: 'solana', limit: '50' }, body: null });
    expect(buildAddonRequest(item, 1)).toEqual({ query: { chain: 'solana', limit: '49' }, body: null });
    expect(buildAddonRequest(item, 2).query).toEqual({ chain: 'solana', limit: '50' });
    expect(FEED.query).toEqual({ chain: 'solana' });
  });

  test('POST: sets a dot path in a COPY of the body', () => {
    const item: FloorArenaAddon = {
      ...FEED, method: 'POST', query: {}, body: { filters: { chain: 'solana' }, pagination: { page: 1 } },
      dedupeVary: { path: 'pagination.per_page', values: [50, 49] },
    };
    expect(buildAddonRequest(item, 1)).toEqual({
      query: null, body: { filters: { chain: 'solana' }, pagination: { page: 1, per_page: 49 } },
    });
    expect(item.body).toEqual({ filters: { chain: 'solana' }, pagination: { page: 1 } });
    expect(buildAddonRequest({ ...item, dedupeVary: null }, 5)).toEqual({ query: null, body: item.body });
  });

  test('the real catalog: every feed is POST, alternates per_page, parses, and stays frozen', () => {
    expect(FLOOR_ARENA_ADDONS.length).toBeGreaterThan(0);
    for (const item of FLOOR_ARENA_ADDONS) {
      expect(item.priceUsd).toBeGreaterThan(0);
      expect(item.priceUsd).toBeLessThanOrEqual(5);
      const even = buildAddonRequest(item, 0).body as { pagination: { per_page: number } };
      const odd = buildAddonRequest(item, 1).body as { pagination: { per_page: number } };
      expect(even.pagination.per_page).not.toBe(odd.pagination.per_page);
      expect(Object.isFrozen(item.body)).toBe(true);
      const field = item.mintPath.split('.').at(-1)!;
      expect(extractAddonMints({ data: { data: [{ [field]: USDC }] } }, item.mintPath)).toEqual([USDC]);
    }
  });

  test('the tick sends the POST body and uses the all-time call count', async () => {
    const post: FloorArenaAddon = {
      ...FEED, method: 'POST', query: {}, body: { per_page: 50 }, dedupeVary: { path: 'per_page', values: [50, 49] },
    };
    const h = harness({
      catalog: [post],
      stats: [{ addonId: 'feed-a', spentTodayUsd: 0, lastAt: new Date(NOW.getTime() - 3_600_000), lastOk: true, lastError: null, callsTotal: 7 }],
    });
    await runArenaAddonsTick(NOW, h.deps);
    expect(h.pays[0]!.input).toEqual({ url: FEED.url, method: 'POST', body: { per_page: 49 }, maxAmountUsd: 0.1 });
  });
});

describe('helpers', () => {
  test('ambiguous errors count as charged; refusals do not', () => {
    expect(mayHaveCharged(new ClawPumpWriterError('timeout'))).toBe(true);
    expect(mayHaveCharged(new ClawPumpWriterError('http_error', 503))).toBe(true);
    expect(mayHaveCharged(new ClawPumpWriterError('http_error', 400))).toBe(false);
    expect(mayHaveCharged(new ClawPumpWriterError('payment_required', 402))).toBe(false);
    expect(mayHaveCharged(new ClawPumpWriterError('invalid_input'))).toBe(false);
    expect(mayHaveCharged(new Error('unknown'))).toBe(true);
  });

  test('the cap day starts at 00:00 UTC', () => {
    expect(utcDayStart(new Date('2026-10-01T03:59:59Z')).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});
