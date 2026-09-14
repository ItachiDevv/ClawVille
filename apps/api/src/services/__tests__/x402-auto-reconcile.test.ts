import { afterEach, describe, expect, it } from 'bun:test';
import {
  isX402AutoReconcileEnabled,
  resetX402AutoReconcileAlertDedupeForTests,
  resolveX402AutoReconcileConfig,
  runX402AutoReconcilePass,
  stopX402AutoReconcile,
} from '../x402-auto-reconcile';
import type {
  BulkReconcileResult,
  BulkReconcileVerdict,
} from '../x402-bulk-reconcile';
import type { ReconcileRow } from '../x402-reconcile';

function row(id: string, createdAt = '2026-07-23T10:00:00.000Z'): ReconcileRow {
  return {
    table: 'agent_payments',
    id,
    usdCents: 125,
    createdAt,
    settlingStartedAt: createdAt,
    metadata: {
      reconcileReason: 'stale_settling',
      expectedPayer: '11111111111111111111111111111111',
      settleNetwork: 'devnet',
    },
  };
}

function result(verdicts: BulkReconcileVerdict[]): BulkReconcileResult {
  const captured = verdicts.filter((verdict) =>
    verdict.action === 'applied_capture_fulfill'
    || verdict.action === 'applied_capture_pending');
  return {
    apply: true,
    window: null,
    verdicts,
    summary: {
      selected: verdicts.length,
      matched: verdicts.filter((verdict) => verdict.bucket === 'matched').length,
      noMoney: verdicts.filter((verdict) => verdict.bucket === 'no_money').length,
      waiting: verdicts.filter((verdict) => verdict.bucket === 'waiting').length,
      manual: verdicts.filter((verdict) => verdict.bucket === 'manual').length,
      indeterminate: verdicts.filter((verdict) =>
        verdict.bucket === 'indeterminate').length,
      captured: captured.length,
      closedNoMoney: verdicts.filter((verdict) =>
        verdict.action === 'applied_no_money').length,
      capturedUsdCents: captured.reduce((sum, verdict) =>
        sum + verdict.row.usdCents, 0),
      manualRowIds: verdicts.filter((verdict) =>
        verdict.bucket === 'manual').map((verdict) =>
        `${verdict.row.table}:${verdict.row.id}`),
    },
  };
}

afterEach(() => {
  stopX402AutoReconcile();
  resetX402AutoReconcileAlertDedupeForTests();
  delete process.env.X402_AUTO_RECONCILE;
  delete process.env.X402_AUTO_RECONCILE_INTERVAL_MS;
  delete process.env.X402_AUTO_RECONCILE_MAX_ROWS;
});

describe('x402 recurring auto-reconcile', () => {
  it('does not touch the sweep or stores when explicitly disabled', async () => {
    process.env.X402_AUTO_RECONCILE = 'false';
    const unexpected = async (): Promise<never> => { throw new Error('disabled worker ran'); };
    const pass = await runX402AutoReconcilePass({
      runSweep: unexpected,
      withAdvisoryLock: unexpected,
      stampVerdict: unexpected,
    });
    expect(pass.enabled).toBe(false);
    expect(pass.sweep).toBeNull();
  });

  it('annotates every swept verdict after auto apply and continues after a failed stamp', async () => {
    delete process.env.X402_AUTO_RECONCILE;
    const sweep = result([
      { row: row('captured'), bucket: 'matched', detail: 'captured', action: 'applied_capture_fulfill' },
      { row: row('failed-stamp'), bucket: 'indeterminate', detail: 'RPC incomplete' },
      { row: row('still-reconcile'), bucket: 'manual', detail: 'no unique proof' },
    ]);
    const stamps: unknown[] = [];
    const errors: string[] = [];
    let swept = false;
    const pass = await runX402AutoReconcilePass({
      runSweep: async () => { swept = true; return sweep; },
      withAdvisoryLock: async (run) => ({ acquired: true, sweep: await run() }),
      now: () => new Date('2026-09-13T12:00:00.000Z'),
      send: async () => {},
      logError: (message) => { errors.push(message); },
      stampVerdict: async (candidate, annotation) => {
        expect(swept).toBe(true);
        stamps.push({ id: candidate.id, ...annotation });
        if (candidate.id === 'failed-stamp') throw new Error('storage unavailable');
      },
    });
    expect(pass.sweep).toBe(sweep);
    expect(stamps).toEqual([
      { id: 'captured', bucket: 'matched', detail: 'captured', action: 'applied_capture_fulfill', at: '2026-09-13T12:00:00.000Z' },
      { id: 'failed-stamp', bucket: 'indeterminate', detail: 'RPC incomplete', action: null, at: '2026-09-13T12:00:00.000Z' },
      { id: 'still-reconcile', bucket: 'manual', detail: 'no unique proof', action: null, at: '2026-09-13T12:00:00.000Z' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('failed-stamp');
  });

  it('is default-on and applies interval floor plus bounded row cap', () => {
    delete process.env.X402_AUTO_RECONCILE;
    expect(isX402AutoReconcileEnabled()).toBe(true);
    expect(resolveX402AutoReconcileConfig()).toEqual({
      enabled: true,
      intervalMs: 15 * 60_000,
      maxRows: 50,
    });
    process.env.X402_AUTO_RECONCILE = 'false';
    expect(isX402AutoReconcileEnabled()).toBe(false);
    expect(resolveX402AutoReconcileConfig().enabled).toBe(false);
    process.env.X402_AUTO_RECONCILE = 'true';
    expect(isX402AutoReconcileEnabled()).toBe(true);
    process.env.X402_AUTO_RECONCILE_INTERVAL_MS = '1000';
    process.env.X402_AUTO_RECONCILE_MAX_ROWS = '75';
    expect(resolveX402AutoReconcileConfig()).toEqual({
      enabled: true,
      intervalMs: 15 * 60_000,
      maxRows: 75,
    });
    process.env.X402_AUTO_RECONCILE_INTERVAL_MS = String(5 * 60_000);
    expect(resolveX402AutoReconcileConfig().intervalMs).toBe(5 * 60_000);
  });

  it('runs the shared sweep in auto-apply mode under the advisory lock', async () => {
    process.env.X402_AUTO_RECONCILE = 'true';
    process.env.X402_AUTO_RECONCILE_MAX_ROWS = '12';
    const calls: unknown[] = [];
    const sweep = result([
      {
        row: row('captured'),
        bucket: 'matched',
        action: 'applied_capture_fulfill',
        detail: 'captured',
      },
      {
        row: row('closed'),
        bucket: 'no_money',
        action: 'applied_no_money',
        detail: 'closed',
      },
    ]);
    const messages: string[] = [];
    const pass = await runX402AutoReconcilePass({
      stampVerdict: async () => {},
      runSweep: async (options) => {
        calls.push(options);
        return sweep;
      },
      withAdvisoryLock: async (run) => ({ acquired: true, sweep: await run() }),
      send: async (message) => { messages.push(message); },
    });
    expect(calls).toEqual([{
      apply: true,
      consent: 'auto',
      limit: 12,
    }]);
    expect(pass.sweep).toBe(sweep);
    expect(messages).toEqual([
      'auto-reconcile: captured 1 ($1.25), closed 1 no-money, 0 manual',
    ]);
  });

  it('does not alert on quiet ticks and deduplicates an unchanged manual set', async () => {
    process.env.X402_AUTO_RECONCILE = 'true';
    const messages: string[] = [];
    let current = result([]);
    const deps = {
      stampVerdict: async () => {},
      runSweep: async () => current,
      withAdvisoryLock: async (run: () => Promise<BulkReconcileResult>) => ({
        acquired: true,
        sweep: await run(),
      }),
      send: async (message: string) => { messages.push(message); },
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    };
    await runX402AutoReconcilePass(deps);
    current = result([{
      row: row('manual'),
      bucket: 'manual',
      detail: 'ambiguous pairing',
    }]);
    await runX402AutoReconcilePass(deps);
    await runX402AutoReconcilePass(deps);
    expect(messages).toEqual([
      'auto-reconcile: captured 0 ($0.00), closed 0 no-money, 1 manual',
    ]);
  });

  it('alerts an indeterminate row only after it survives 24 hours', async () => {
    process.env.X402_AUTO_RECONCILE = 'true';
    const messages: string[] = [];
    let current = result([{
      row: row('young-indeterminate', '2026-07-23T11:00:00.000Z'),
      bucket: 'indeterminate',
      detail: 'RPC window incomplete',
    }]);
    const deps = {
      stampVerdict: async () => {},
      runSweep: async () => current,
      withAdvisoryLock: async (run: () => Promise<BulkReconcileResult>) => ({
        acquired: true,
        sweep: await run(),
      }),
      send: async (message: string) => { messages.push(message); },
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    };
    await runX402AutoReconcilePass(deps);
    current = result([{
      row: row('old-indeterminate', '2026-07-21T11:00:00.000Z'),
      bucket: 'indeterminate',
      detail: 'RPC window incomplete',
    }]);
    await runX402AutoReconcilePass(deps);
    expect(messages).toEqual([
      'auto-reconcile: captured 0 ($0.00), closed 0 no-money, 1 manual',
    ]);
  });

  it('skips cleanly when another replica owns the advisory lock', async () => {
    process.env.X402_AUTO_RECONCILE = 'true';
    let swept = false;
    const pass = await runX402AutoReconcilePass({
      stampVerdict: async () => {},
      runSweep: async () => {
        swept = true;
        return result([]);
      },
      withAdvisoryLock: async () => ({ acquired: false }),
    });
    expect(pass.skippedLock).toBe(true);
    expect(pass.sweep).toBeNull();
    expect(swept).toBe(false);
  });
});
