import { beforeEach, expect, mock, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getTableColumns } from 'drizzle-orm';
import * as database from '@clawville/database';

const avatarId = '00000000-0000-4000-8000-000000000001';
const queries: Array<{ text: string; params: unknown[] }> = [];
let linked = true;
let halt: Record<string, unknown> | null = null;
// Real Drizzle SQL and postgres-js adapter, with transport replaced. No DB opens.
const adapter = drizzle({
  options: { parsers: {}, serializers: {} },
  unsafe(text: string, params: unknown[]) {
    queries.push({ text, params });
    return { values: async () => text.includes('from "trading_halts"') && halt
      ? [Object.keys(getTableColumns(database.tradingHalts)).map((key) => halt![key])] : [] };
  },
} as any);
mock.module('@clawville/database', () => ({ ...database, db: {
  select: adapter.select.bind(adapter),
  query: { clawpumpAgentLinks: { findFirst: async () => linked ? {
    walletPubkey: 'transport-test-only', armed: false, killed: true,
    objective: 'conservative-rebalancer', floatStartUsdMicros: '0',
  } : null } },
} }));
mock.module('../trading-fleet-equity', () => ({ readTradingWalletEquity: async () => null }));
const { readAutonomousTradingTargets } = await import('../autonomous-trading-targets');
beforeEach(() => { queries.length = 0; linked = true; halt = null; });

test('the concurrent desk batch uses extended-protocol parameters for every SELECT', async () => {
  await readAutonomousTradingTargets({ avatarId });
  expect(queries).toHaveLength(4);
  for (const query of queries) expect(query.params.length).toBeGreaterThan(0);
  const haltQuery = queries.find((query) => query.text.includes('from "trading_halts"'))!;
  expect(haltQuery.params).toEqual(['fleet', avatarId]);
  expect(haltQuery.text).toContain('"trading_halts"."cleared_at" is null');
  expect(haltQuery.text).toContain('("trading_halts"."scope" = $1 or "trading_halts"."scope_id" = $2)');
});

for (const scope of ['fleet', 'agent']) {
  test(`${scope} halt still blocks the advertised trading desk`, async () => {
    halt = { id: avatarId, scope, scopeId: scope === 'fleet' ? null : avatarId,
      reason: 'test halt', engagedBy: 'test', haltedAt: new Date().toISOString(), clearedAt: null, clearedBy: null };
    const desk = await readAutonomousTradingTargets({ avatarId });
    expect(desk.halted).toBe(true);
    expect(desk.haltReason).toBe('test halt');
    expect(desk.allowedMints).toEqual([]);
  });
}

test('an unlinked avatar does not request trading tables', async () => {
  linked = false;
  expect((await readAutonomousTradingTargets({ avatarId })).linked).toBe(false);
  expect(queries).toHaveLength(0);
});

test('an unrelated avatar halt cannot suppress this desk even if a reader returns it', async () => {
  halt = { id: avatarId, scope: 'agent', scopeId: '00000000-0000-4000-8000-000000000002',
    reason: 'other avatar', engagedBy: 'test', haltedAt: new Date().toISOString(), clearedAt: null, clearedBy: null };
  const desk = await readAutonomousTradingTargets({ avatarId });
  expect(desk.halted).toBe(false);
  expect(desk.allowedMints.length).toBeGreaterThan(0);
});
