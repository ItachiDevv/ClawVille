/**
 * CLV SWAP EXECUTOR (Tokenomics C3) — unit tests.
 *
 * Proves the three safety-load-bearing pieces WITHOUT a real Postgres:
 *
 *   1. `planClips` price-impact math — per-clip cap = (bps/10k) × oneSideDepth,
 *      µUSD-floored DOWN (house-favorable); clip sum == queued amount exactly;
 *      degenerate inputs (no liquidity / dust pool / invalid amount / absurd
 *      clip counts) REFUSE rather than emit an unsafe plan.
 *   2. `enqueueClvBuy` input guards — non-positive/NaN/malformed amounts and
 *      empty reason/sourceRef throw BEFORE any DB touch; the happy path stamps
 *      the oracle quote and composes into a provided tx (or opens its own).
 *   3. The HARD GATE — `CLV_SWAP_EXECUTE=true` throws the exact
 *      Codex-review-gated refusal from both the assert and the worker start.
 *
 * The DB is a stubbed @clawville/database (insert/transaction chains recorded;
 * every other named export spread from the real module — bun shares ONE module
 * registry). The oracle is stubbed at its resolved module path so quotes are
 * deterministic.
 */

// Crash-loud module-load env the transitive import chain needs (mirrors
// partner-storefront.test.ts). DATABASE_URL is SCOPED to module init (deleted
// again after the executor import below) so DB-gated suites loading later in
// the shared bun process keep their skip-when-no-DB behavior.
const HEX32 = '0'.repeat(64);
function ensureEnv(k: string, v: string) {
  if (!process.env[k]) process.env[k] = v;
}
const DB_URL_WAS_SET = !!process.env.DATABASE_URL;
ensureEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/db');
ensureEnv('VANITY_ENCRYPTION_KEY', HEX32);

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import * as realDatabase from '@clawville/database';
import * as realOracle from '../clv-price-oracle';

// Captured BEFORE mock.module patches the namespace in place (the
// x402-checkout.test.ts leak-guard convention). The oracle mock below MUST
// spread these so every non-stubbed export survives for later test files in
// bun's shared module registry — CLV_MINT in particular is imported at module
// load by linked-wallet-clv-balance (pulled by the C4 market suite); without
// the spread, any later suite whose import graph touches those exports dies
// at load with "Export named 'CLV_MINT' not found".
const REAL_ORACLE_EXPORTS = { ...realOracle };

// ── @clawville/database stub ────────────────────────────────────────────────
type InsertedValues = Record<string, unknown>;
const ownTxInserts: InsertedValues[] = [];
let insertReturnRows: Array<{ id: string; amountUsdc?: string }> = [{ id: 'queue-row-1' }];
let dbTransactionCalls = 0;
/** Recorded onConflictDoUpdate configs (the GoLive upsert — one per insert). */
const conflictConfigs: Array<Record<string, unknown>> = [];

function makeInsertChain(sink: InsertedValues[]) {
  return (_table: unknown) => ({
    values: (v: InsertedValues) => {
      sink.push(v);
      return {
        // GoLive executors: enqueueClvBuy upserts via onConflictDoUpdate(...)
        // then .returning(...). The config is recorded so tests can assert the
        // conflict target is the (reason, source_ref) partial UNIQUE.
        onConflictDoUpdate: (cfg: Record<string, unknown>) => {
          conflictConfigs.push(cfg);
          return { returning: async (_sel: unknown) => insertReturnRows };
        },
        returning: async (_sel: unknown) => insertReturnRows,
      };
    },
  });
}

const fakeTxForOwn = { insert: makeInsertChain(ownTxInserts) };
const fakeDb = {
  ...(realDatabase as unknown as { db: Record<string, unknown> }).db,
  insert: makeInsertChain(ownTxInserts),
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    dbTransactionCalls += 1;
    return fn(fakeTxForOwn);
  },
};

mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: fakeDb,
}));

// ── oracle stub (resolved to the SAME path the executor imports) ────────────
let stubQuote: { quoteUsd: number | null; poolLiquidityUsd: number | null } = {
  quoteUsd: 0.00007,
  poolLiquidityUsd: 22_000,
};
mock.module('../clv-price-oracle', () => ({
  ...REAL_ORACLE_EXPORTS,
  getClvPrice: () => ({
    spotUsd: stubQuote.quoteUsd,
    twap30mUsd: stubQuote.quoteUsd,
    quoteUsd: stubQuote.quoteUsd,
    asOf: new Date().toISOString(),
    source: 'dexscreener',
    stale: false,
    available: stubQuote.quoteUsd !== null,
    poolLiquidityUsd: stubQuote.poolLiquidityUsd,
    liquidityAsOf: new Date().toISOString(),
  }),
}));

// Import AFTER mocks. CLV_SWAP_EXECUTE must be unset here or the module-load
// gate (the thing test #3 proves) would fail THIS import.
delete process.env.CLV_SWAP_EXECUTE;
const {
  planClips,
  enqueueClvBuy,
  assertNoLiveClvSwapExecution,
  startClvSwapWorker,
  stopClvSwapWorker,
  resolveClvSwapMaxImpactBps,
  DEFAULT_CLIP_SPACING_MS,
  MAX_ENQUEUE_NOTIONAL_MICRO_USD,
} = await import('../clv-swap-executor');

// Executor loaded — drop the module-init DATABASE_URL placeholder so later
// files in the shared process keep their skip-when-no-DB behavior.
if (!DB_URL_WAS_SET) {
  delete process.env.DATABASE_URL;
}

const sumMicro = (clips: Array<{ amountUsdc: string }>) =>
  clips.reduce((acc, c) => {
    const [i, f = ''] = c.amountUsdc.split('.');
    return acc + BigInt(i) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
  }, 0n);

beforeEach(() => {
  ownTxInserts.length = 0;
  conflictConfigs.length = 0;
  dbTransactionCalls = 0;
  insertReturnRows = [{ id: 'queue-row-1' }];
  stubQuote = { quoteUsd: 0.00007, poolLiquidityUsd: 22_000 };
  delete process.env.CLV_SWAP_EXECUTE;
  delete process.env.CLV_SWAP_MAX_IMPACT_BPS;
});

// ─────────────────────────────────────────────────────────────────────────────
describe('planClips — price-impact caps', () => {
  it('splits $1000 against a $22k pool (1% cap) into 10 clips ≤ $110, sum exact', () => {
    const plan = planClips({ amountUsdc: '1000', poolLiquidityUsd: 22_000, maxImpactBps: 100 });
    expect(plan.ok).toBe(true);
    expect(plan.oneSideDepthUsd).toBe(11_000);
    expect(plan.maxClipUsdc).toBe('110.000000');
    expect(plan.clipCount).toBe(10);
    // 9 full clips + the exact remainder.
    expect(plan.clips.slice(0, 9).every((c) => c.amountUsdc === '110.000000')).toBe(true);
    expect(plan.clips[9].amountUsdc).toBe('10.000000');
    // Every clip ≤ the cap; µUSD sum equals the queued amount EXACTLY.
    for (const c of plan.clips) {
      expect(Number(c.amountUsdc)).toBeLessThanOrEqual(110);
    }
    expect(sumMicro(plan.clips)).toBe(1_000_000_000n);
    expect(plan.totalUsdc).toBe('1000.000000');
  });

  it('an amount under the cap is a single clip', () => {
    const plan = planClips({ amountUsdc: '50', poolLiquidityUsd: 22_000, maxImpactBps: 100 });
    expect(plan.ok).toBe(true);
    expect(plan.clipCount).toBe(1);
    expect(plan.clips[0].amountUsdc).toBe('50.000000');
  });

  it('floors the per-clip cap DOWN to µUSD (house-favorable)', () => {
    // oneSide = 10_999.999999 → cap 109.99999999 → µUSD-floored 109.999999.
    const plan = planClips({
      amountUsdc: '100',
      poolLiquidityUsd: 21_999.999998,
      maxImpactBps: 100,
    });
    expect(plan.ok).toBe(true);
    expect(plan.maxClipUsdc).toBe('109.999999');
  });

  it('REFUSES on null / zero / negative / NaN pool liquidity', () => {
    for (const liq of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const plan = planClips({ amountUsdc: '100', poolLiquidityUsd: liq as number | null });
      expect(plan.ok).toBe(false);
      expect(plan.refusedReason).toBe('no_liquidity');
      expect(plan.clips).toEqual([]);
    }
  });

  it('REFUSES a dust pool whose cap floors to 0 µUSD', () => {
    // oneSide ≈ $9.5e-7 → 1% cap ≈ $9.5e-9 → 0 µUSD → no safe buy size.
    const plan = planClips({ amountUsdc: '10', poolLiquidityUsd: 0.0000019, maxImpactBps: 100 });
    expect(plan.ok).toBe(false);
    expect(plan.refusedReason).toBe('no_liquidity');
  });

  it('REFUSES malformed / non-positive amounts', () => {
    for (const amount of ['0', '00.0', '-3', 'abc', '1e5', '1.1234567', '', '0.000000']) {
      const plan = planClips({ amountUsdc: amount, poolLiquidityUsd: 22_000 });
      expect(plan.ok).toBe(false);
      expect(plan.refusedReason).toBe('invalid_amount');
    }
  });

  it('REFUSES absurd clip counts (total-function guard)', () => {
    // oneSide $1, 1 bp → cap $0.0001 → $10k = 100M clips ≫ 10k → refuse.
    const plan = planClips({ amountUsdc: '10000', poolLiquidityUsd: 2, maxImpactBps: 1 });
    expect(plan.ok).toBe(false);
    expect(plan.refusedReason).toBe('clip_count_excessive');
  });

  it('sanitizes the bps cap: floor 1, non-finite → default, spacing default', () => {
    // bps 0 → floored to 1 → cap = oneSide(10_000) × 1/10_000 = $1.
    const plan = planClips({ amountUsdc: '2', poolLiquidityUsd: 20_000, maxImpactBps: 0 });
    expect(plan.ok).toBe(true);
    expect(plan.maxImpactBps).toBe(1);
    expect(plan.maxClipUsdc).toBe('1.000000');
    expect(plan.spacingMs).toBe(DEFAULT_CLIP_SPACING_MS);

    const plan2 = planClips({
      amountUsdc: '2',
      poolLiquidityUsd: 20_000,
      maxImpactBps: Number.NaN,
    });
    expect(plan2.maxImpactBps).toBe(100); // default
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('enqueueClvBuy — input guards + insert composition', () => {
  it('throws on non-positive / NaN / malformed amounts BEFORE any DB touch', async () => {
    for (const amountUsdc of ['0', '-1', 'abc', 'NaN', '1e3', '', '1.1234567']) {
      await expect(
        enqueueClvBuy({ amountUsdc, reason: 'r', sourceRef: 's' }),
      ).rejects.toThrow(/amountUsdc must be a positive decimal string/);
    }
    // Non-string smuggled through the type system.
    await expect(
      enqueueClvBuy({ amountUsdc: 12 as unknown as string, reason: 'r', sourceRef: 's' }),
    ).rejects.toThrow(/amountUsdc/);
    expect(ownTxInserts.length).toBe(0);
    expect(dbTransactionCalls).toBe(0);
  });

  it('throws on empty reason / sourceRef BEFORE any DB touch', async () => {
    await expect(
      enqueueClvBuy({ amountUsdc: '10', reason: '  ', sourceRef: 's' }),
    ).rejects.toThrow(/reason is required/);
    await expect(
      enqueueClvBuy({ amountUsdc: '10', reason: 'r', sourceRef: '' }),
    ).rejects.toThrow(/sourceRef is required/);
    expect(ownTxInserts.length).toBe(0);
  });

  it('happy path (no tx): opens its OWN transaction, stamps the oracle quote', async () => {
    const out = await enqueueClvBuy({
      amountUsdc: '12.500000',
      reason: 'checkout_clv_leg',
      sourceRef: 'topup-123',
      metadata: { k: 'v' },
    });
    expect(out.queueId).toBe('queue-row-1');
    expect(dbTransactionCalls).toBe(1);
    expect(ownTxInserts.length).toBe(1);
    expect(ownTxInserts[0]).toMatchObject({
      amountUsdc: '12.500000',
      quotedPrice: (0.00007).toFixed(12),
      reason: 'checkout_clv_leg',
      sourceRef: 'topup-123',
      metadata: { k: 'v' },
    });
  });

  it('oracle-down: records the intent with quotedPrice NULL', async () => {
    stubQuote = { quoteUsd: null, poolLiquidityUsd: null };
    await enqueueClvBuy({ amountUsdc: '5', reason: 'r', sourceRef: 's' });
    expect(ownTxInserts[0].quotedPrice).toBeNull();
  });

  it('composes into a PROVIDED tx (no own transaction opened)', async () => {
    const providedInserts: InsertedValues[] = [];
    const providedTx = { insert: makeInsertChain(providedInserts) };
    const out = await enqueueClvBuy(
      { amountUsdc: '7', reason: 'r', sourceRef: 's' },
      providedTx as unknown as Parameters<typeof enqueueClvBuy>[1],
    );
    expect(out.queueId).toBe('queue-row-1');
    expect(providedInserts.length).toBe(1);
    expect(dbTransactionCalls).toBe(0);
    expect(ownTxInserts.length).toBe(0);
  });

  // ── GoLive executors (2026-07-07): hard cap + idempotent upsert ──────────
  it('HARD MAX-NOTIONAL CAP: > $10,000 throws BEFORE any DB touch; == passes', async () => {
    expect(MAX_ENQUEUE_NOTIONAL_MICRO_USD).toBe(10_000n * 1_000_000n);
    await expect(
      enqueueClvBuy({ amountUsdc: '10000.000001', reason: 'r', sourceRef: 's' }),
    ).rejects.toThrow(/max-notional cap/);
    await expect(
      enqueueClvBuy({ amountUsdc: '99999', reason: 'r', sourceRef: 's' }),
    ).rejects.toThrow(/max-notional cap/);
    expect(ownTxInserts.length).toBe(0);
    expect(dbTransactionCalls).toBe(0);
    // Exactly at the cap is allowed (== the largest possible settled checkout).
    const out = await enqueueClvBuy({ amountUsdc: '10000', reason: 'r', sourceRef: 's' });
    expect(out.queueId).toBe('queue-row-1');
    expect(ownTxInserts.length).toBe(1);
  });

  it('UPSERTS on (reason, source_ref): the insert carries an onConflictDoUpdate', async () => {
    await enqueueClvBuy({ amountUsdc: '5', reason: 'checkout_clv_leg', sourceRef: 'chk-1' });
    expect(conflictConfigs.length).toBe(1);
    const cfg = conflictConfigs[0];
    // Conflict target is the two-column partial UNIQUE; a set-merge exists
    // (drizzle needs DO UPDATE for RETURNING to yield the existing row).
    expect(Array.isArray(cfg.target)).toBe(true);
    expect((cfg.target as unknown[]).length).toBe(2);
    expect(cfg.targetWhere).toBeDefined();
    expect(cfg.set).toBeDefined();
  });

  it('DOUBLE-ENQUEUE same source_ref: replay returns the EXISTING queueId (never a throw)', async () => {
    // The stub models the DB's conflict path: RETURNING yields the
    // pre-existing row (different id + the FIRST-recorded amount).
    insertReturnRows = [{ id: 'existing-queue-7', amountUsdc: '5.000000' }];
    const out = await enqueueClvBuy({
      amountUsdc: '5.000000',
      reason: 'checkout_clv_leg',
      sourceRef: 'chk-replayed',
    });
    expect(out.queueId).toBe('existing-queue-7');
  });

  it('REPLAY AMOUNT MISMATCH: still returns the existing id, logs LOUD, never mutates', async () => {
    insertReturnRows = [{ id: 'existing-queue-8', amountUsdc: '5.000000' }];
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    try {
      const out = await enqueueClvBuy({
        amountUsdc: '9.000000', // replay carrying the WRONG money
        reason: 'checkout_clv_leg',
        sourceRef: 'chk-replayed-bad',
      });
      expect(out.queueId).toBe('existing-queue-8');
      expect(errors.some((e) => e.includes('REPLAY AMOUNT MISMATCH'))).toBe(true);
    } finally {
      console.error = realError;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('HARD GATE — CLV_SWAP_EXECUTE=true refuses the dry-run path', () => {
  const GATE_MSG =
    'CLV_SWAP_EXECUTE=true selects live mode — refusing to run the CLV dry-run worker';

  it('assertNoLiveClvSwapExecution throws the EXACT refusal', () => {
    process.env.CLV_SWAP_EXECUTE = 'true';
    expect(() => assertNoLiveClvSwapExecution()).toThrow(GATE_MSG);
    delete process.env.CLV_SWAP_EXECUTE;
    expect(() => assertNoLiveClvSwapExecution()).not.toThrow();
  });

  it('startClvSwapWorker refuses to start under the flag', () => {
    process.env.CLV_SWAP_EXECUTE = 'true';
    expect(() => startClvSwapWorker()).toThrow(GATE_MSG);
    delete process.env.CLV_SWAP_EXECUTE;
    stopClvSwapWorker(); // idempotent — nothing should have started
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('resolveClvSwapMaxImpactBps — env sanitation', () => {
  it('default 100; floor 1; cap 10_000; garbage → default', () => {
    delete process.env.CLV_SWAP_MAX_IMPACT_BPS;
    expect(resolveClvSwapMaxImpactBps()).toBe(100);
    process.env.CLV_SWAP_MAX_IMPACT_BPS = '0';
    expect(resolveClvSwapMaxImpactBps()).toBe(1);
    process.env.CLV_SWAP_MAX_IMPACT_BPS = '250';
    expect(resolveClvSwapMaxImpactBps()).toBe(250);
    process.env.CLV_SWAP_MAX_IMPACT_BPS = '99999';
    expect(resolveClvSwapMaxImpactBps()).toBe(10_000);
    process.env.CLV_SWAP_MAX_IMPACT_BPS = 'garbage';
    expect(resolveClvSwapMaxImpactBps()).toBe(100);
    delete process.env.CLV_SWAP_MAX_IMPACT_BPS;
  });
});
