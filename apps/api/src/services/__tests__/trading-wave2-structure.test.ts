import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { TRADE_REFUSAL_CODES, TRADE_REFUSAL_COPY } from '@clawville/shared';

const apiSrc = resolve(import.meta.dir, '../..');
const repoRoot = resolve(apiSrc, '../../..');
const serviceNames = [
  'autonomous-trading-targets.ts',
  'trading-decision-feed.ts',
  'trading-execution.ts',
  'trading-fleet-equity.ts',
  'trading-guardrails.ts',
  'trading-jupiter.ts',
  'trading-links.ts',
  'trading-mint-info.ts',
  'trading-signer.ts',
  'trading-swap-validator.ts',
];
const serviceText = new Map(serviceNames.map((name) => [
  name,
  readFileSync(resolve(apiSrc, 'services', name), 'utf8'),
]));

describe('Trading Floor Wave 2 structural boundaries', () => {
  test('only execution imports the fleet signer', () => {
    const importers = [...serviceText].filter(([, text]) => /from ['"]\.\/trading-signer['"]/.test(text)).map(([name]) => name);
    expect(importers).toEqual(['trading-execution.ts']);
  });

  test('only the signer imports the key vault inside the Wave 2 service set', () => {
    const importers = [...serviceText].filter(([, text]) => /from ['"]\.\/keypair-vault['"]/.test(text)).map(([name]) => name);
    expect(importers).toEqual(['trading-signer.ts']);
  });

  test('Wave 2 services never access the verified_trades table directly', () => {
    for (const [name, text] of serviceText) {
      expect(text.includes('verifiedTrades'), name).toBe(false);
      expect(text.includes('verified_trades'), name).toBe(false);
    }
  });

  test('the executed decision CAS has one publisher', () => {
    const writers = [...serviceText].flatMap(([name, text]) =>
      text.includes("status: 'executed', verdict: 'executed'") ? [name] : [],
    );
    expect(writers).toEqual(['trading-execution.ts']);
  });

  test('refusal copy covers every refusal code exactly', () => {
    expect(Object.keys(TRADE_REFUSAL_COPY).sort()).toEqual([...TRADE_REFUSAL_CODES].sort());
    for (const copy of Object.values(TRADE_REFUSAL_COPY)) {
      expect(copy).not.toMatch(/[0-9]/);
      expect(copy).not.toContain('-');
      expect(copy.toLowerCase()).not.toContain('casino');
    }
  });

  test('compiled ceiling and reserve directions stay distinct', () => {
    const shared = readFileSync(resolve(repoRoot, 'packages/shared/src/constants/trading-fleet.ts'), 'utf8');
    expect(shared).toContain('value > ceiling');
    expect(shared).toContain('minSolReserveLamports <');
    expect(shared).toContain('minUsdcReserveMicros <');
  });

  test('no scoring or ingest module imports fleet tables', () => {
    for (const name of ['trade-observer.ts', 'trade-verifier.ts']) {
      const text = readFileSync(resolve(apiSrc, 'services', name), 'utf8');
      expect(text.includes('clawpumpAgentLinks'), name).toBe(false);
      expect(text.includes('tradingDecisions'), name).toBe(false);
    }
  });

  test('fleet arming has one true writer and schema defaults are unarmed and killed', () => {
    const allServices = readdirSync(resolve(apiSrc, 'services'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => [name, readFileSync(resolve(apiSrc, 'services', name), 'utf8')] as const);
    const writers = allServices.filter(([, text]) => /armed:\s*true/.test(text)).map(([name]) => name);
    expect(writers).toEqual(['trading-links.ts']);
    const schema = readFileSync(resolve(repoRoot, 'packages/database/src/schema/trading-fleet.ts'), 'utf8');
    expect(schema).toContain("armed: boolean('armed').default(false)");
    expect(schema).toContain("killed: boolean('killed').default(true)");
  });

  test('migration holds ambiguous reservations and has 0061-style checks', () => {
    const migration = readFileSync(resolve(repoRoot, 'packages/database/migrations/0064_clawpump_trading_floor.sql'), 'utf8');
    expect(migration).toContain("\"status\" IN ('open','reconcile')");
    expect(migration).toContain('trading_usdc_reservations_status_valid');
    expect(migration).toContain('trading_usdc_reservations_release_stamp');
  });

  test('every migration constraint and partial index is mirrored in the Drizzle schema', () => {
    const migration = readFileSync(resolve(repoRoot, 'packages/database/migrations/0064_clawpump_trading_floor.sql'), 'utf8');
    const schema = readFileSync(resolve(repoRoot, 'packages/database/src/schema/trading-fleet.ts'), 'utf8');
    const names = [...migration.matchAll(/(?:CONSTRAINT|INDEX(?: IF NOT EXISTS)?)\s+"?([a-z0-9_]+)"?/gi)]
      .map((match) => match[1]!)
      .filter((name) => name.startsWith('clawpump_') || name.startsWith('trading_'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(schema, name).toContain(name);
  });

  test('the admin trading router has no dashboard-only auth bypass', () => {
    const route = readFileSync(resolve(apiSrc, 'routes/admin-trading.ts'), 'utf8');
    expect(route).not.toContain('adminOnly');
    expect(route).toContain("adminTradingRoutes.use('*', moneyOperatorOnly)");
  });

  test('the locked admission preserves the required lock order and contains no provider work', () => {
    const guardrails = serviceText.get('trading-guardrails.ts')!;
    const start = guardrails.indexOf("withKeyedMutex('trading:fleet'");
    const fleetAdvisory = guardrails.indexOf("pg_advisory_xact_lock(hashtextextended('trading:fleet'", start);
    const avatarMutex = guardrails.indexOf('withKeyedMutex(`trading:${intent.avatarId}`', start);
    const avatarAdvisory = guardrails.indexOf("pg_advisory_xact_lock(hashtextextended(${`trading:${intent.avatarId}`}", start);
    const spendAdmission = guardrails.indexOf('admitPosterUsdcSpend(tx', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThan(avatarMutex);
    expect(avatarMutex).toBeLessThan(fleetAdvisory);
    expect(fleetAdvisory).toBeLessThan(avatarAdvisory);
    expect(avatarAdvisory).toBeLessThan(spendAdmission);
    const locked = guardrails.slice(start, guardrails.indexOf('\nexport async function recordTradeOutcome', start));
    expect((locked.match(/admitPosterUsdcSpend\(tx/g) ?? []).length).toBe(1);
    for (const forbidden of ['fetchTradingQuote', 'buildTradingSwapTransaction', 'resolveLookups', 'simulateTransaction']) {
      expect(locked, forbidden).not.toContain(forbidden);
    }
  });

  test('floor services do not touch CT balances or treat trading wallet row ids as addresses', () => {
    for (const [name, source] of serviceText) {
      expect(source, name).not.toContain('avatars.clawTokens');
      expect(source, name).not.toContain('claw-token-ledger');
      if (source.includes('tradingWalletId')) {
        expect(source, name).not.toMatch(/new PublicKey\([^\n]*tradingWalletId/);
        expect(source, name).not.toMatch(/tradingWalletId[^\n]*(?:frame|pubkey|walletPubkey)/i);
      }
    }
  });

  test('the observer callback is registered exactly once', () => {
    const files = [
      readFileSync(resolve(apiSrc, 'index.ts'), 'utf8'),
      ...readdirSync(resolve(apiSrc, 'services')).filter((name) => name.endsWith('.ts')).map((name) => readFileSync(resolve(apiSrc, 'services', name), 'utf8')),
    ];
    const registrations = files.reduce((count, source) => count + (source.match(/registerTradeVerifiedCallback\s*\(async\b/g) ?? []).length, 0);
    expect(registrations).toBe(1);
  });

  test('fleet labels stay outside the leaderboard scoring CTE', () => {
    const leaderboard = readFileSync(resolve(apiSrc, 'routes/leaderboard.ts'), 'utf8');
    const withAt = leaderboard.indexOf('WITH');
    const selectAt = leaderboard.indexOf('SELECT * FROM (', withAt);
    expect(withAt).toBeGreaterThanOrEqual(0);
    expect(selectAt).toBeGreaterThan(withAt);
    expect((leaderboard.match(/SELECT \* FROM \(/g) ?? []).length).toBe(1);
    expect(leaderboard.slice(withAt, selectAt)).not.toContain('operated_by_clawville');
  });

  test('reservation terminal states use the database vocabulary', () => {
    const guardrails = serviceText.get('trading-guardrails.ts')!;
    expect(guardrails).toContain("input.status === 'expired' ? 'expired' : 'failed'");
    expect(guardrails).not.toContain("status: input.status === 'executed' ? 'settled' : input.status as");
  });
});
