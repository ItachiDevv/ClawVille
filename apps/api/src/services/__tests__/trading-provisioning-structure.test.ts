import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const apiSrc = resolve(import.meta.dir, '../..');
const provisioning = readFileSync(resolve(apiSrc, 'services/trading-provisioning.ts'), 'utf8');
const avatarProvisioning = readFileSync(resolve(apiSrc, 'services/avatar-agent-provisioning.ts'), 'utf8');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    if (name === '__tests__') return [];
    return statSync(path).isDirectory() ? sourceFiles(path) : name.endsWith('.ts') ? [path] : [];
  });
}

describe('Trading Floor provisioning structure', () => {
  test('fleet creation has a fatal wallet and zero-economy provisioning mode', () => {
    expect(avatarProvisioning).toContain("wallet?: 'include-nonfatal' | 'include-fatal' | 'skip'");
    expect(avatarProvisioning).toContain("initialEconomy?: 'default' | 'zero'");
    expect(avatarProvisioning).toContain("? { clawTokens: 0, softBalance: 0, boughtBalance: 0, earnedBalance: 0 }");
    expect(provisioning).toContain("wallet: 'include-fatal'");
    expect(provisioning).toContain("initialEconomy: 'zero'");
  });

  test('one transaction proves custody, binds the wallet, and inserts a disabled link', () => {
    const slotRead = provisioning.indexOf('const boundSlot = await deps.readBindSlot();');
    const start = provisioning.indexOf('await deps.database.transaction(async (tx) => {');
    const end = provisioning.indexOf('\n  try {\n    const activation', start);
    const transaction = provisioning.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(slotRead).toBeGreaterThanOrEqual(0);
    expect(slotRead).toBeLessThan(start);
    expect(transaction).toContain('pg_advisory_xact_lock');
    expect(transaction).toContain("eq(wallets.subjectType, 'avatar')");
    expect(transaction).toContain('eq(wallets.subjectId, provisioned.avatar.id)');
    expect(transaction).toContain('eq(wallets.publicKey, walletPubkey)');
    expect(transaction).toContain('eq(wallets.custodyVerified, true)');
    expect(transaction).toContain('deps.bindCustodialWallet({');
    expect(transaction).toContain('tx,');
    expect(transaction).toContain('tx.insert(clawpumpAgentLinks).values({');
    expect(transaction).toContain('armed: false');
    expect(transaction).toContain('killed: true');
    expect(transaction).toContain("floatStartLamports: '0'");
    expect(transaction).toContain("floatStartUsdMicros: '0'");
    expect(transaction).toContain('baselineEvidence: null');
  });

  test('pairing stores only a trading-wallet binding and no fleet link', () => {
    const start = provisioning.indexOf('export async function pairFounderAgent');
    const pair = provisioning.slice(start);
    expect(pair).toContain("kind: 'agent'");
    expect(pair).toContain('deps.bindClawPumpWallet({');
    expect(pair).toContain("metadata}->>'clawpumpAgentId'");
    expect(pair).not.toContain('insert(clawpumpAgentLinks)');
  });

  test('pairing serializes each opaque ClawPump label before the avatar lock', () => {
    const pair = provisioning.slice(provisioning.indexOf('export async function pairFounderAgent'));
    const labelLock = pair.indexOf('trading-clawpump:${input.clawpumpAgentId}');
    const avatarLock = pair.indexOf('trading-bind:${input.avatarId}');
    const duplicateRead = pair.indexOf("metadata}->>'clawpumpAgentId'", avatarLock);
    const bind = pair.indexOf('deps.bindClawPumpWallet({', duplicateRead);
    expect(labelLock).toBeGreaterThanOrEqual(0);
    expect(avatarLock).toBeGreaterThan(labelLock);
    expect(duplicateRead).toBeGreaterThan(avatarLock);
    expect(bind).toBeGreaterThan(duplicateRead);
  });

  test('the bind-slot RPC uses a transport abort deadline', () => {
    const wallets = readFileSync(resolve(apiSrc, 'services/trading-wallets.ts'), 'utf8');
    const start = wallets.indexOf('export async function currentBindSlot');
    const end = wallets.indexOf('\nexport async function resolveBoundTradingWallets', start);
    const slotRead = wallets.slice(start, end);
    expect(slotRead).toContain('new AbortController()');
    expect(slotRead).toContain('controller.abort(), 4_000');
    expect(slotRead).toContain('signal: controller.signal');
    expect(slotRead).toContain("connection.getSlot('confirmed')");
  });

  test('only the provisioning service inserts a fleet link', () => {
    const writers = sourceFiles(apiSrc)
      .filter((path) => readFileSync(path, 'utf8').includes('insert(clawpumpAgentLinks)'))
      .map((path) => path.replaceAll('\\', '/').split('/apps/api/src/')[1]);
    expect(writers).toEqual(['services/trading-provisioning.ts']);
  });

  test('only the provisioning service writes leaderboard eligibility', () => {
    const writers = sourceFiles(apiSrc)
      .filter((path) => /\.set\(\{[^}]*leaderboardEligible:/s.test(readFileSync(path, 'utf8')))
      .map((path) => path.replaceAll('\\', '/').split('/apps/api/src/')[1]);
    expect(writers).toEqual(['services/trading-provisioning.ts']);
  });

  test('operator scripts use REST nonces, production guards, and public-address output', () => {
    const provisionScript = readFileSync(resolve(apiSrc, '../scripts/trading/provision-fleet.ts'), 'utf8');
    const pairScript = readFileSync(resolve(apiSrc, '../scripts/trading/pair-genesis.ts'), 'utf8');
    const loop = provisionScript.indexOf('for (const objective of TRADING_OBJECTIVES)');
    const nonce = provisionScript.indexOf("request('/api/admin/trading/nonce')", loop);
    const provision = provisionScript.indexOf("request('/api/admin/trading/fleet/provision'", nonce);
    expect(loop).toBeGreaterThanOrEqual(0);
    expect(nonce).toBeGreaterThan(loop);
    expect(provision).toBeGreaterThan(nonce);
    for (const script of [provisionScript, pairScript]) {
      expect(script).toContain("process.env.CLAWVILLE_ENV === 'production'");
      expect(script).toContain("process.argv.includes('--production')");
      expect(script).toContain('CLAWVILLE_OPERATOR_COOKIE');
      expect(script).toContain("request('/api/admin/trading/nonce')");
      expect(script).not.toContain('secretKey');
      expect(script).not.toContain('console.log(payload');
    }
    expect(provisionScript).toContain('console.log(String(provisioned.walletPubkey))');
    expect(pairScript).toContain('console.log(String(paired.walletPubkey))');
  });

});
