import { readFile } from 'node:fs/promises';

/** Test-only credentials. Never infer a fixture from the application's DATABASE_URL. */
export function validateBrainchainFixtureUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid BrainChain fixture URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
    || !url.port || Number(url.port) < 1024 || Number(url.port) > 65535
    || url.username !== 'brainchain_fixture' || !url.password || url.pathname !== '/brainchain_fixture'
    || url.search || url.hash) throw new Error('BrainChain requires an explicit loopback fixture role and database');
  return { host: '127.0.0.1', port: Number(url.port), username: 'brainchain_fixture',
    password: decodeURIComponent(url.password), database: 'brainchain_fixture' };
}

export async function getBrainchainFixtureSettings() {
  if (process.env.BRAINCHAIN_DB_FIXTURE !== '1') throw new Error('BrainChain database fixture opt-in is required');
  let url = process.env.BRAINCHAIN_TEST_DATABASE_URL;
  if (!url) {
    if (process.env.BRAINCHAIN_LOCAL_FIXTURE !== '1' || process.env.CI) throw new Error('Explicit BrainChain test database URL is required');
    const password = (await readFile(new URL('../../../../../../.brainchain-work/postgres-password', import.meta.url), 'utf8')).trim();
    url = `postgres://brainchain_fixture:${encodeURIComponent(password)}@127.0.0.1:55439/brainchain_fixture`;
  }
  const options = validateBrainchainFixtureUrl(url);
  if (process.env.DATABASE_URL && process.env.DATABASE_URL !== url) throw new Error('Application database configuration conflicts with the isolated fixture');
  return { url, options };
}
