import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../../../../..');

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      out.push(...sourceFiles(path));
    } else if (/\.(?:ts|tsx|js|mjs)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('wallet unification source gates', () => {
  test('no executable agent-subject wallet mint caller exists', () => {
    const files = [
      ...sourceFiles(join(REPO_ROOT, 'apps')),
      ...sourceFiles(join(REPO_ROOT, 'scripts')),
      ...sourceFiles(join(REPO_ROOT, 'packages')),
    ];
    const offenders = files.filter((file) => {
      const source = withoutComments(readFileSync(file, 'utf8'));
      return /ensureWallet(?:WithFirstTimeSecret)?\s*\(\s*['"]agent['"]/.test(source);
    });
    expect(offenders).toEqual([]);
  });

  test('the v2 insert round-trips ciphertext before the canonical insert', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'apps/api/src/services/wallet-service.ts'),
      'utf8',
    );
    const decryptAt = source.indexOf('decryptSecretKeyEnveloped(encrypted)');
    const compareAt = source.indexOf('reproduced.publicKey.toBase58() !== publicKey');
    const insertAt = source.indexOf('.insert(wallets)', decryptAt);
    expect(decryptAt).toBeGreaterThan(-1);
    expect(compareAt).toBeGreaterThan(decryptAt);
    expect(insertAt).toBeGreaterThan(compareAt);
  });

  test('the settlement resolver is a canonical-only read with no decrypt or mutation', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'apps/api/src/services/wallet-service.ts'),
      'utf8',
    );
    const resolverAt = source.indexOf('export async function resolveAvatarSettlementAddress(');
    const resolverReturnAt = source.indexOf(
      'return resolveAvatarSettlementAddressFromCanonical(row);',
      resolverAt,
    );
    const resolverEnd = source.indexOf('}', resolverReturnAt) + 1;
    const resolver = source.slice(resolverAt, resolverEnd);
    expect(resolverAt).toBeGreaterThan(-1);
    expect(resolverReturnAt).toBeGreaterThan(resolverAt);
    expect(resolverEnd).toBeGreaterThan(resolverAt);
    expect(resolver).toContain("eq(wallets.subjectType, 'avatar')");
    expect(resolver).toContain('columns: { publicKey: true, custodyVerified: true }');
    expect(resolver).not.toMatch(/\.(?:insert|update|delete)\s*\(/);
    expect(resolver).not.toContain('decrypt');
    expect(resolver).not.toContain('avatars.');
  });

  test('no GET route directly calls a wallet provisioner', () => {
    const routeFiles = sourceFiles(join(REPO_ROOT, 'apps/api/src/routes'));
    const offenders: string[] = [];
    for (const file of routeFiles) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      const registrations = [
        ...source.matchAll(/\b\w+Routes\.(get|post|put|patch|delete)\s*\(/g),
      ].map((match) => ({ method: match[1], index: match.index }));
      for (const call of source.matchAll(
        /\b(?:ensureWallet|ensureWalletWithFirstTimeSecret|provisionAvatarWallet)\s*\(/g,
      )) {
        const route = [...registrations].reverse().find((entry) => entry.index < call.index);
        if (route?.method === 'get') offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('Hatcher resolves the current binding before every stats cache hit', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'apps/api/src/routes/partner-hatcher.ts'),
      'utf8',
    );
    const statsAt = source.indexOf("partnerHatcherRoutes.get('/agents/:agentId/stats'");
    const currentBindingAt = source.indexOf(
      'resolveBoundAvatarSettlement(row.userId ?? null)',
      statsAt,
    );
    const cacheHitAt = source.indexOf('statsCache.get(namespacedAgentId)', statsAt);
    expect(currentBindingAt).toBeGreaterThan(statsAt);
    expect(cacheHitAt).toBeGreaterThan(currentBindingAt);
  });

  test('Hatcher public records never advertise the bot mirror', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'apps/api/src/routes/partner-hatcher.ts'),
      'utf8',
    );
    const publicRecordAt = source.indexOf('export function publicAgentRecord');
    const publicRecordEnd = source.indexOf('// ---------------------------------------------------------------------------', publicRecordAt);
    const publicRecord = source.slice(publicRecordAt, publicRecordEnd);
    expect(publicRecord).toContain('avatarSettlementAddressFields(settlement)');
    expect(publicRecord).not.toContain('row.walletAddress');
  });

  test('connect binds first and advertises only resolver-approved wallet fields', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'apps/api/src/routes/agent-gateway.ts'),
      'utf8',
    );
    const connectAt = source.indexOf("agentGatewayRoutes.post('/connect'");
    const persistedBindAt = source.indexOf('.returning({ userId: agentBots.userId })', connectAt);
    const conflictAt = source.indexOf("code: 'OWNER_BIND_CONFLICT'", connectAt);
    const provisionAt = source.indexOf('provisionAvatarWallet(avatar.id', connectAt);
    const advertiseAt = source.indexOf('avatarSettlementAddressFields(walletResolution)', connectAt);
    expect(persistedBindAt).toBeGreaterThan(connectAt);
    expect(conflictAt).toBeGreaterThan(persistedBindAt);
    expect(provisionAt).toBeGreaterThan(persistedBindAt);
    expect(provisionAt).toBeGreaterThan(conflictAt);
    expect(advertiseAt).toBeGreaterThan(provisionAt);
    expect(source.slice(connectAt, source.indexOf('// Phase 5.1', advertiseAt))).toContain(
      '...(walletBlock ? { wallet: walletBlock } : {})',
    );
  });

  test('controlled backfill never references the bot mirror table', () => {
    const source = readFileSync(
      join(
        REPO_ROOT,
        'apps/api/scripts/wallet-unification/promote-avatar-wallets.ts',
      ),
      'utf8',
    );
    expect(source).not.toContain('agentBots');
    expect(source).not.toContain('openclawBots');
    expect(source).not.toContain("ensureWallet('agent'");
  });
});
