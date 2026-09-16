import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
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

function readTypeScriptTree(dir: string): Array<readonly [string, string]> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') return [];
      return readTypeScriptTree(path);
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [[relative(apiSrc, path).replaceAll('\\', '/'), readFileSync(path, 'utf8')] as const];
  });
}

const apiSourceTree = readTypeScriptTree(apiSrc);
const linkInsertPattern = /insert\(clawpumpAgentLinks\)|INSERT\s+INTO\s+"?clawpump_agent_links"?/i;
const linkUpdatePattern = /update\(clawpumpAgentLinks\)|UPDATE\s+"?clawpump_agent_links"?/i;
const linkDeletePattern = /delete\(clawpumpAgentLinks\)|DELETE\s+FROM\s+"?clawpump_agent_links"?/i;
const tradingStatusWriterPattern =
  /update\(tradingDecisions\)[\s\S]{0,800}\.set\(\{[\s\S]{0,300}\bstatus\s*:|UPDATE\s+"?trading_decisions"?[\s\S]{0,500}\bstatus\s*=/i;
const explicitExecutedWriterPattern =
  /\bstatus\s*:\s*['"]executed['"]|\bstatus\s*=\s*['"]executed['"]/i;
const leaderboardWriterPattern =
  /\.set\(\{[\s\S]{0,250}leaderboardEligible\s*:|\.values\(\{[\s\S]{0,500}leaderboardEligible\s*:|SET\s+leaderboard_eligible\s*=|INSERT\s+INTO\s+"?openclaw_bots"?[\s\S]{0,500}leaderboard_eligible/i;

describe('Trading Floor Wave 2 structural boundaries', () => {
  test('only execution imports the fleet signer', () => {
    const importers = apiSourceTree
      .filter(([, text]) => /from ['"][^'"]*trading-signer['"]/.test(text))
      .map(([name]) => name);
    expect(importers).toEqual(['services/trading-execution.ts']);
  });

  test('only the signer imports the key vault among every trading source file', () => {
    const importers = apiSourceTree
      .filter(([name, text]) => basename(name).startsWith('trading-') && /from ['"][^'"]*keypair-vault['"]/.test(text))
      .map(([name]) => name);
    expect(importers).toEqual(['services/trading-signer.ts']);
  });

  test('fleet files never access the verified_trades table directly', () => {
    const fleetFiles = apiSourceTree.filter(([name]) =>
      basename(name).includes('trading') || name === 'routes/admin-trading.ts');
    for (const [name, text] of fleetFiles) {
      expect(/\bverifiedTrades\b|verified_trades/.test(text), name).toBe(false);
    }
  });

  test('the executed decision CAS has one publisher', () => {
    const writers = apiSourceTree
      .filter(([, text]) => tradingStatusWriterPattern.test(text) && explicitExecutedWriterPattern.test(text))
      .map(([name]) => name);
    expect(writers).toEqual(['services/trading-execution.ts']);
    const allStatusMutators = apiSourceTree
      .filter(([, text]) => tradingStatusWriterPattern.test(text))
      .map(([name]) => name);
    expect(allStatusMutators).toEqual([
      'services/trading-execution.ts',
      'services/trading-guardrails.ts',
    ]);
    const guardrails = serviceText.get('trading-guardrails.ts')!;
    expect(guardrails).toContain("status: 'refused' | 'failed' | 'reconcile' | 'expired'");
    expect(guardrails).not.toContain("status: 'executed' | 'refused'");
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
    const scoringOrIngest = apiSourceTree.filter(([name]) => /(?:scor|ingest|leaderboard)/i.test(basename(name)));
    expect(scoringOrIngest.length).toBeGreaterThan(0);
    for (const [name, text] of scoringOrIngest) {
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

  test('kill is one-way and only arm can clear it', () => {
    const falseWriters = apiSourceTree
      .filter(([, text]) => /killed:\s*false/.test(text))
      .map(([name]) => name);
    expect(falseWriters).toEqual(['services/trading-links.ts']);
    expect(apiSourceTree.some(([, text]) => text.includes('setTradingLinkKilled'))).toBe(false);
    const links = serviceText.get('trading-links.ts')!;
    expect(links).toContain('export async function killTradingLink(avatarId: string)');
    expect(links).toContain('.set({ killed: true, updatedAt: new Date() })');
  });

  test('only provisioning inserts links and only provisioning, arm, or kill update them', () => {
    const linkInsertWriters = apiSourceTree
      .filter(([, text]) => linkInsertPattern.test(text))
      .map(([name]) => name);
    expect(linkInsertWriters).toEqual(['services/trading-provisioning.ts']);

    const linkUpdateWriters = apiSourceTree
      .filter(([, text]) => linkUpdatePattern.test(text))
      .map(([name]) => name);
    expect(linkUpdateWriters).toEqual([
      'services/trading-links.ts',
      'services/trading-provisioning.ts',
    ]);
    const links = serviceText.get('trading-links.ts')!;
    expect((links.match(/update\(clawpumpAgentLinks\)/g) ?? []).length).toBe(2);
    const provisioning = readFileSync(resolve(apiSrc, 'services/trading-provisioning.ts'), 'utf8');
    expect((provisioning.match(/update\(clawpumpAgentLinks\)/g) ?? []).length).toBe(1);
    expect(provisioning).toMatch(/update\(clawpumpAgentLinks\)[\s\S]{0,100}set\(\{ killed: true,/);

    const linkDeleteWriters = apiSourceTree
      .filter(([, text]) => linkDeletePattern.test(text))
      .map(([name]) => name);
    expect(linkDeleteWriters).toEqual([]);
  });

  test('provisioning is the only leaderboard eligibility writer', () => {

    const leaderboardWriters = apiSourceTree
      .filter(([, text]) => leaderboardWriterPattern.test(text))
      .map(([name]) => name);
    expect(leaderboardWriters).toEqual(['services/trading-provisioning.ts']);
  });

  test('structural scanners detect raw SQL and dynamic writer fixtures', () => {
    expect(linkInsertPattern.test('INSERT INTO "clawpump_agent_links" (avatar_id) VALUES ($1)')).toBe(true);
    expect(linkUpdatePattern.test('UPDATE clawpump_agent_links SET armed = true')).toBe(true);
    expect(linkDeletePattern.test('DELETE FROM clawpump_agent_links WHERE avatar_id=$1')).toBe(true);
    expect(tradingStatusWriterPattern.test("db.update(tradingDecisions).set({ status: nextStatus })")).toBe(true);
    expect(tradingStatusWriterPattern.test("UPDATE trading_decisions SET status = 'executed' WHERE id=$1")).toBe(true);
    expect(explicitExecutedWriterPattern.test("UPDATE trading_decisions SET status = 'executed' WHERE id=$1")).toBe(true);
    expect(leaderboardWriterPattern.test('UPDATE openclaw_bots SET leaderboard_eligible = false')).toBe(true);
  });

  test('fleet bind and unarmed link insert share one transaction', () => {
    const provisioning = readFileSync(resolve(apiSrc, 'services/trading-provisioning.ts'), 'utf8');
    const transactionAt = provisioning.indexOf('await deps.database.transaction(async (tx) => {');
    const bindAt = provisioning.indexOf('deps.bindCustodialWallet({', transactionAt);
    const insertAt = provisioning.indexOf('tx.insert(clawpumpAgentLinks).values({', bindAt);
    const transactionEnd = provisioning.indexOf('\n  });', insertAt);
    expect(transactionAt).toBeGreaterThanOrEqual(0);
    expect(bindAt).toBeGreaterThan(transactionAt);
    expect(insertAt).toBeGreaterThan(bindAt);
    expect(transactionEnd).toBeGreaterThan(insertAt);
    const insert = provisioning.slice(insertAt, transactionEnd);
    expect(insert).toContain('armed: false');
    expect(insert).toContain('killed: true');
    expect(insert).toContain("floatStartLamports: '0'");
    expect(insert).toContain("floatStartUsdMicros: '0'");
  });

  test('migration holds ambiguous reservations and has 0061-style checks', () => {
    const migration = readFileSync(resolve(repoRoot, 'packages/database/migrations/0064_clawpump_trading_floor.sql'), 'utf8');
    expect(migration).toContain("\"status\" IN ('open','reconcile')");
    expect(migration).toContain('trading_usdc_reservations_status_valid');
    expect(migration).toContain('trading_usdc_reservations_release_stamp');
  });

  test('every migration constraint and partial index is mirrored in the Drizzle schema', () => {
    const migration = [
      '0064_clawpump_trading_floor.sql',
      '0065_trading_baseline_evidence.sql',
    ].map((name) => readFileSync(resolve(repoRoot, 'packages/database/migrations', name), 'utf8')).join('\n');
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

  test('execution completes transaction preparation and simulation before its sole admission', () => {
    const execution = serviceText.get('trading-execution.ts')!;
    const start = execution.indexOf('export async function executeTrade(');
    const end = execution.indexOf('\nexport async function promoteDecisionToExecuted', start);
    const body = execution.slice(start, end);
    const quote = body.indexOf('fetchTradingQuote(');
    const build = body.indexOf('buildTradingSwapTransaction(');
    const lookups = body.indexOf('resolveLookups(');
    const inspect = body.indexOf('inspectTradingSwapTransaction({');
    const simulate = body.indexOf('validateTradingSwapSimulation({');
    const admit = body.indexOf('admitTrade(');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(quote).toBeLessThan(build);
    expect(build).toBeLessThan(lookups);
    expect(lookups).toBeLessThan(inspect);
    expect(inspect).toBeLessThan(simulate);
    expect(simulate).toBeLessThan(admit);
    expect((body.match(/admitTrade\(/g) ?? []).length).toBe(1);
  });

  test('stale admission release requires proof that no signature was captured', () => {
    const execution = serviceText.get('trading-execution.ts')!;
    const sweeper = execution.slice(execution.indexOf('async function sweepTradingDecisions()'));
    expect(sweeper).toContain('TRADING_STALE_SENDING_MS');
    expect(sweeper).toContain("eq(tradingDecisions.status, 'admitted')");
    expect(sweeper).toContain('isNull(tradingDecisions.signature)');
    expect(sweeper).toContain("releaseReason: 'never_signed'");
    expect(sweeper).toContain("expectedStatus: 'admitted'");
  });

  test('pre-sign locks re-read custody and the live trading binding', () => {
    const execution = serviceText.get('trading-execution.ts')!;
    const presign = execution.slice(
      execution.indexOf("withKeyedMutex('trading:fleet'"),
      execution.indexOf("if (signed.kind === 'refused_presign')"),
    );
    expect(presign).toContain("eq(wallets.subjectType, 'avatar')");
    expect(presign).toContain('eq(wallets.subjectId, intent.avatarId)');
    expect(presign).toContain('eq(wallets.custodyVerified, true)');
    expect(presign).toContain("eq(tradingWallets.subjectKind, 'agent')");
    expect(presign).toContain('eq(tradingWallets.userId, current[0].userId)');
    expect(presign).toContain('isNull(tradingWallets.revokedAt)');
    expect((presign.match(/\.for\('update'\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(presign).toContain("code: 'keypair_mismatch'");
  });

  test('every reservation terminal mutation takes the shared spend lock', () => {
    const guardrails = serviceText.get('trading-guardrails.ts')!;
    const record = guardrails.slice(
      guardrails.indexOf('export async function recordTradeOutcome'),
      guardrails.indexOf('\nexport async function evaluateFleetDrawdown'),
    );
    expect(record).toContain('await lockPosterUsdcSpend(tx, decision[0].avatarId)');
    expect(record).not.toContain("status: 'executed'");
    const execution = serviceText.get('trading-execution.ts')!;
    const promote = execution.slice(
      execution.indexOf('export async function promoteDecisionToExecuted'),
      execution.indexOf('\nasync function sweepTradingDecisions'),
    );
    expect(promote).toContain('await lockPosterUsdcSpend(tx, input.avatarId)');
  });

  test('prime ingest, sweeper, and feed catches alert with a decision id', () => {
    const execution = serviceText.get('trading-execution.ts')!;
    for (const source of ['trading-prime-ingest', 'trading-sweeper']) {
      const at = execution.indexOf(`source: '${source}'`);
      expect(at, source).toBeGreaterThanOrEqual(0);
      expect(execution.slice(at, at + 450), source).toContain('decisionId');
      expect(execution.slice(Math.max(0, at - 120), at + 450), source).toContain('alertError');
    }
    const feed = serviceText.get('trading-decision-feed.ts')!;
    expect(feed).toContain("source: 'trading-decision-feed'");
    expect(feed).toContain('decisionId: frame.decisionId');
    expect(feed).toContain('error instanceof Error ? error.message');
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
