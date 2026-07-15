import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('cosmetic supply rolling-deploy guard', () => {
  const route = readFileSync(join(import.meta.dir, '..', 'cosmetics.ts'), 'utf8');
  const migration = readFileSync(
    join(import.meta.dir, '..', '..', '..', '..', '..', 'packages', 'database', 'migrations', '0032_cosmetic_sold_count.sql'),
    'utf8',
  );

  test('claims stock at the avatar_skins insertion boundary for old and new pods', () => {
    expect(migration).toContain('AFTER INSERT ON avatar_skins');
    expect(migration).toContain('SET sold_count = sold_count + 1');
    expect(migration).toContain('sold_count < supply_cap');
    expect(migration).toContain("CONSTRAINT = 'cosmetic_skus_supply_cap_enforced'");
  });

  test('ON CONFLICT idempotent retries cannot consume stock', () => {
    expect(migration).toContain('AFTER INSERT means ON CONFLICT DO NOTHING');
    const grantStart = route.indexOf('export async function grantSkinInTx');
    const grantEnd = route.indexOf('// Helpers', grantStart);
    const grant = route.slice(grantStart, grantEnd);
    expect(grant).toContain('.onConflictDoNothing');
    expect(grant).not.toContain('.update(cosmeticSkus)');
  });
});
