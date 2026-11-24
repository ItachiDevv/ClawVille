import { afterEach, describe, expect, it } from 'bun:test';
import type { AlertErrorParams } from '../alert-error';
import {
  classifyPayAiCredit,
  parsePayAiCreditReading,
  runPayAiCreditCheck,
  stopPayAiCreditMonitor,
  type PayAiCreditMonitorDeps,
} from '../payai-credit-monitor';

const HOUR = 60 * 60 * 1_000;

/** Shapes captured from the live prod merchant API on 2026-11-24 (values changed). */
function account(minorUnits: string | number) {
  return {
    account: { id: 'acct', wallet: 'wallet', addressType: 'svm', createdAt: '2026-01-01T00:00:00.000Z', kind: 'portal' },
    credits: { balance: Math.floor(Number(minorUnits) / 1_000_000), minorUnits: String(minorUnits) },
    keys: [],
    recoveryEmail: null,
  };
}
const usage = (settlements: number) => ({ period: { days: 7, from: '2026-11-17T00:00:00.000Z' }, settlements, successes: settlements, byNetwork: [] });
const transactions = (costMinor: number, count = 5) => ({
  transactions: Array.from({ length: count }, (_, i) => ({
    id: `t${i}`, type: 'usage', amount: String(-costMinor), createdAt: '2026-11-24T00:00:00.000Z', credits: 0,
  })),
  total: count, hasMore: false,
});

function harness(responses: () => [unknown, unknown, unknown] | Error, startMs = 0) {
  let nowMs = startMs;
  const alerts: AlertErrorParams[] = [];
  const deps: PayAiCreditMonitorDeps = {
    fetchJson: async (path) => {
      const result = responses();
      if (result instanceof Error) throw result;
      if (path.startsWith('/api/v1/account/usage')) return result[1];
      if (path.startsWith('/api/v1/account/transactions')) return result[2];
      return result[0];
    },
    alert: async (params) => { alerts.push(params); },
    now: () => nowMs,
    log: () => {},
  };
  return { deps, alerts, advance: (ms: number) => { nowMs += ms; } };
}

afterEach(() => stopPayAiCreditMonitor());

describe('PayAI credit reading', () => {
  it('reads the prod balance and burn: 8,537.82 credits, 299 settles a week at 0.95 credits', () => {
    const reading = parsePayAiCreditReading(account('8537820000'), usage(299), transactions(950_000));
    expect(reading.balanceCredits).toBeCloseTo(8_537.82, 2);
    expect(reading.dailyBurnCredits).toBeCloseTo((299 / 7) * 0.95, 6);
    expect(Math.floor(reading.runwayDays!)).toBe(210);
    expect(classifyPayAiCredit(reading)).toBe('ok');
  });

  it('falls back to the whole-credit balance and tolerates missing usage data', () => {
    const reading = parsePayAiCreditReading({ credits: { balance: 500 } }, null, { transactions: [] });
    expect(reading).toEqual({ balanceCredits: 500, dailyBurnCredits: null, runwayDays: null });
    expect(classifyPayAiCredit(reading)).toBe('low');
  });

  it('throws when the account response has no balance', () => {
    expect(() => parsePayAiCreditReading({ credits: {} }, usage(1), transactions(1))).toThrow('no credit balance');
  });

  it('classifies low by runway even when the balance is above the floor', () => {
    expect(classifyPayAiCredit({ balanceCredits: 5_000, dailyBurnCredits: 500, runwayDays: 10 })).toBe('low');
    expect(classifyPayAiCredit({ balanceCredits: 0, dailyBurnCredits: 1, runwayDays: 0 })).toBe('empty');
    expect(classifyPayAiCredit({ balanceCredits: -3, dailyBurnCredits: null, runwayDays: null })).toBe('empty');
  });
});

describe('PayAI credit alerts', () => {
  it('stays silent while the balance is healthy', async () => {
    const h = harness(() => [account('8537820000'), usage(299), transactions(950_000)]);
    expect(await runPayAiCreditCheck(h.deps)).toBe('ok');
    expect(h.alerts).toHaveLength(0);
  });

  it('pages a low balance once per 24 h and escalates to critical at empty', async () => {
    let minor = 800_000_000; // 800 credits
    const h = harness(() => [account(minor), usage(70), transactions(1_000_000)]);
    expect(await runPayAiCreditCheck(h.deps)).toBe('low');
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ severity: 'warning', source: 'payai-credit-monitor' });
    expect(h.alerts[0]!.context).toMatchObject({ balanceCredits: 800, balanceUsd: '0.80', dailyBurnCredits: 10, runwayDays: 80 });

    h.advance(HOUR);
    await runPayAiCreditCheck(h.deps);
    expect(h.alerts).toHaveLength(1);

    minor = 0;
    h.advance(HOUR);
    expect(await runPayAiCreditCheck(h.deps)).toBe('empty');
    expect(h.alerts).toHaveLength(2);
    expect(h.alerts[1]).toMatchObject({ severity: 'critical' });
    expect(h.alerts[1]!.message).toContain('EMPTY');

    h.advance(23 * HOUR);
    await runPayAiCreditCheck(h.deps);
    expect(h.alerts).toHaveLength(2);
    h.advance(HOUR);
    await runPayAiCreditCheck(h.deps);
    expect(h.alerts).toHaveLength(3);
  });

  it('pages again at once when a topped-up balance drops low again', async () => {
    let minor = 500_000_000;
    const h = harness(() => [account(minor), usage(7), transactions(1_000_000)]);
    await runPayAiCreditCheck(h.deps);
    minor = 9_000_000_000;
    h.advance(HOUR);
    expect(await runPayAiCreditCheck(h.deps)).toBe('ok');
    minor = 500_000_000;
    h.advance(HOUR);
    await runPayAiCreditCheck(h.deps);
    expect(h.alerts).toHaveLength(2);
  });

  it('pages after three failed reads in a row, then at most once per 24 h', async () => {
    const h = harness(() => new Error('PayAI merchant API /api/v1/account returned 401'));
    expect(await runPayAiCreditCheck(h.deps)).toBe('unreadable');
    await runPayAiCreditCheck(h.deps);
    expect(h.alerts).toHaveLength(0);
    await runPayAiCreditCheck(h.deps);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]!.message).toContain('Cannot read the PayAI credit balance');
    h.advance(HOUR);
    await runPayAiCreditCheck(h.deps);
    expect(h.alerts).toHaveLength(1);
  });

  it('never throws when the alert channel fails', async () => {
    const h = harness(() => [account(0), usage(0), transactions(0, 0)]);
    h.deps.alert = async () => { throw new Error('telegram down'); };
    expect(await runPayAiCreditCheck(h.deps)).toBe('empty');
  });
});
