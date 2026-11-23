import { expect, test } from 'bun:test';
import { getBrainchainFixtureSettings, validateBrainchainFixtureUrl } from './database';
test('fixture URL permits only the explicit loopback test role and database', () => {
  const valid = 'postgres://brainchain_fixture:synthetic@127.0.0.1:55439/brainchain_fixture';
  expect(validateBrainchainFixtureUrl(valid)).toMatchObject({ host: '127.0.0.1', port: 55439, database: 'brainchain_fixture' });
  for (const bad of [valid.replace('127.0.0.1', 'staging.clawville.world'), valid.replace('127.0.0.1', 'localhost'),
    valid.replace('/brainchain_fixture', '/postgres'), valid.replace('brainchain_fixture:', 'postgres:'),
    valid + '?options=-csearch_path=public', valid + '#x', valid.replace(':55439', ''), valid.replace('synthetic', '')]) {
    expect(() => validateBrainchainFixtureUrl(bad)).toThrow();
  }
});
test('fixture setup requires opt-in and rejects application or implicit CI targets', async () => {
  const keys = ['BRAINCHAIN_DB_FIXTURE', 'BRAINCHAIN_TEST_DATABASE_URL', 'BRAINCHAIN_LOCAL_FIXTURE', 'DATABASE_URL', 'CI'] as const;
  const prior = keys.map(key => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    await expect(getBrainchainFixtureSettings()).rejects.toThrow('opt-in');
    process.env.BRAINCHAIN_DB_FIXTURE = '1';
    await expect(getBrainchainFixtureSettings()).rejects.toThrow('Explicit');
    process.env.BRAINCHAIN_LOCAL_FIXTURE = '1'; process.env.CI = 'true';
    await expect(getBrainchainFixtureSettings()).rejects.toThrow('Explicit');
    process.env.BRAINCHAIN_TEST_DATABASE_URL = 'postgres://brainchain_fixture:synthetic@127.0.0.1:55439/brainchain_fixture';
    process.env.DATABASE_URL = 'postgres://app:synthetic@127.0.0.1:5432/clawville';
    await expect(getBrainchainFixtureSettings()).rejects.toThrow('conflicts');
    delete process.env.DATABASE_URL;
    expect((await getBrainchainFixtureSettings()).options.database).toBe('brainchain_fixture');
  } finally { keys.forEach((key, index) => { if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index]; }); }
});
