import { getBrainchainFixtureSettings } from './test-fixtures/database';
/** Opt-in real PostgreSQL fixture. Never reads a configured application DATABASE_URL. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { buildWorkerBindingMessage, proofHash } from './binding-proof';

const enabled = process.env.BRAINCHAIN_DB_FIXTURE === '1';
async function refusal(operation: () => PromiseLike<unknown>): Promise<string> {
  try { await operation(); return 'unexpected_success'; } catch (error) { return error instanceof Error ? error.message : 'error'; }
}
describe.skipIf(!enabled)('BrainChain real isolated PostgreSQL constraints and races', () => {
  let fixture: ReturnType<typeof postgres>;
  let service: typeof import('./bindings');
  const avatarA = randomUUID();
  const avatarB = randomUUID();
  const root = resolve(import.meta.dir, '../../../../..');
  const priorUrl = process.env.DATABASE_URL;
  const priorEnvironment = process.env.CLAWVILLE_ENV;
  beforeAll(async () => {
    const settings = await getBrainchainFixtureSettings();
    fixture = postgres({ ...settings.options, max: 10, onnotice: () => {} });
    await fixture.unsafe('CREATE TABLE IF NOT EXISTS avatars (id uuid PRIMARY KEY)');
    const migration = await readFile(resolve(root, 'packages/database/migrations/0100_brainchain_worker_bindings.sql'), 'utf8');
    await fixture.unsafe(migration);
    await fixture.unsafe(migration); // CI rerun safety is real, not a string assertion.
    await fixture.unsafe(`CREATE TABLE IF NOT EXISTS building_skills (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), building_id varchar(64) NOT NULL UNIQUE,
      name varchar(64) NOT NULL, description text NOT NULL, content text NOT NULL,
      source_article_ids jsonb NOT NULL DEFAULT '[]', generator_version integer NOT NULL DEFAULT 1,
      content_hash varchar(64), generated_at timestamp NOT NULL DEFAULT now(),
      created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
    )`);
    await fixture`INSERT INTO avatars(id) VALUES (${avatarA}),(${avatarB})`;
    process.env.DATABASE_URL = settings.url;
    process.env.CLAWVILLE_ENV = 'staging';
    service = await import('./bindings');
  });
  afterAll(async () => {
    await fixture?.end();
    if (priorUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorUrl;
    if (priorEnvironment === undefined) delete process.env.CLAWVILLE_ENV; else process.env.CLAWVILLE_ENV = priorEnvironment;
  });

  test('concurrent proof consumption creates exactly one binding and preserves ownership', async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const challenge = await service.issueWorkerBindingChallenge(avatarA, { environment: 'testnet', address: wallet.address });
    const signature = await wallet.signMessage({ message: challenge.messageToSign });
    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => service.bindBrainChainWorker(avatarA, { nonce: challenge.nonce, signature })));
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const workers = await service.listBrainChainWorkers(avatarA);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.requestedState).toBe('paused');
    expect(await service.listBrainChainWorkers(avatarB)).toHaveLength(0);
    const foreignChallenge = await service.issueWorkerBindingChallenge(avatarB, { environment: 'testnet', address: wallet.address });
    const foreignSignature = await wallet.signMessage({ message: foreignChallenge.messageToSign });
    expect(await refusal(() => service.bindBrainChainWorker(avatarB, { nonce: foreignChallenge.nonce, signature: foreignSignature }))).toBe('binding_conflict');
    expect(await refusal(() => service.requestBrainChainWorkerControl(avatarB, workers[0]!.id, { requestedState: 'draining' }))).toBe('worker_not_found');
    const drained = await service.requestBrainChainWorkerControl(avatarA, workers[0]!.id, { requestedState: 'draining' });
    expect(drained.observedEligibility).toBeNull();
  });

  test('wrong avatar and database-expired proofs cannot consume a challenge', async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const challenge = await service.issueWorkerBindingChallenge(avatarB, { environment: 'mainnet', address: wallet.address });
    const signature = await wallet.signMessage({ message: challenge.messageToSign });
    expect(await refusal(() => service.bindBrainChainWorker(avatarA, { nonce: challenge.nonce, signature }))).toBe('invalid_proof');
    await fixture`UPDATE brainchain_binding_challenges SET created_at=now()-interval '3 minutes', expires_at=now()-interval '1 minute' WHERE avatar_id=${avatarB} AND environment='mainnet'`;
    expect(await refusal(() => service.bindBrainChainWorker(avatarB, { nonce: challenge.nonce, signature }))).toBe('invalid_proof');
  });

  test('database rejects inconsistent network, malformed address, and unsupported control state', async () => {
    const worker = (await service.listBrainChainWorkers(avatarA))[0]!;
    expect(await refusal(() => fixture`UPDATE brainchain_worker_bindings SET chain_id=1 WHERE id=${worker.id}`)).toMatch(/brainchain_binding_network|brainchain_binding_owner_is_immutable/);
    expect(await refusal(() => fixture`UPDATE brainchain_worker_bindings SET address='0x0000000000000000000000000000000000000000' WHERE id=${worker.id}`)).toMatch(/brainchain_binding_address_format|brainchain_binding_owner_is_immutable/);
    expect(await refusal(() => fixture`UPDATE brainchain_worker_bindings SET requested_state='invalid' WHERE id=${worker.id}`)).toContain('brainchain_binding_local_state');
    expect(await refusal(() => fixture`UPDATE brainchain_worker_bindings SET avatar_id=${randomUUID()} WHERE id=${worker.id}`)).toMatch(/foreign key|brainchain_binding_owner_is_immutable/);
  });

  test('database issuance lock bounds concurrent requests across connections', async () => {
    const avatar = randomUUID();
    await fixture`INSERT INTO avatars(id) VALUES (${avatar})`;
    const wallet = privateKeyToAccount(generatePrivateKey());
    const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => service.issueWorkerBindingChallenge(avatar, { environment: 'testnet', address: wallet.address })));
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    const rows = await fixture`SELECT count(*)::integer AS count FROM brainchain_binding_challenges WHERE avatar_id=${avatar}`;
    expect(rows[0]!.count).toBe(5);
  });

  test('proof expiry uses wall-clock time after waiting for the binding lock', async () => {
    const avatar = randomUUID();
    const wallet = privateKeyToAccount(generatePrivateKey());
    await fixture`INSERT INTO avatars(id) VALUES (${avatar})`;
    const nonce = `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 600);
    const message = buildWorkerBindingMessage({ avatarId: avatar, environment: 'testnet',
      address: wallet.address.toLowerCase(), domain: 'api-staging.clawville.world', nonce, issuedAt, expiresAt });
    await fixture`INSERT INTO brainchain_binding_challenges
      (nonce_hash,avatar_id,environment,chain_id,address,domain,message,message_hash,created_at,expires_at)
      VALUES (${proofHash(nonce)},${avatar},'testnet',274630,${wallet.address.toLowerCase()},
        'api-staging.clawville.world',${message},${proofHash(message)},${issuedAt},${expiresAt})`;
    let announceLock!: () => void;
    const locked = new Promise<void>((resolve) => { announceLock = resolve; });
    const blocker = fixture.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`brainchain-binding:${avatar}`},0))`;
      announceLock();
      await tx`SELECT pg_sleep(1)`;
    });
    await locked;
    const signature = await wallet.signMessage({ message });
    const attempt = refusal(() => service.bindBrainChainWorker(avatar, { nonce, signature }));
    await blocker;
    expect(await attempt).toBe('invalid_proof');
    expect(await service.listBrainChainWorkers(avatar)).toHaveLength(0);
    const rows = await fixture`SELECT consumed_at FROM brainchain_binding_challenges WHERE nonce_hash=${proofHash(nonce)}`;
    expect(rows[0]!.consumed_at).toBeNull();
  });

  test('curriculum upsert is idempotent and cannot downgrade a newer deployment', async () => {
    const { seedBrainChainCurriculum } = await import('./install');
    // This isolated fixture owns this one curriculum row, never application rows.
    await fixture`DELETE FROM building_skills WHERE building_id='brainchain-office'`;
    await seedBrainChainCurriculum();
    await seedBrainChainCurriculum();
    const initial = await fixture`SELECT generator_version,content_hash FROM building_skills WHERE building_id='brainchain-office'`;
    expect(initial).toHaveLength(1);
    await fixture`UPDATE building_skills SET generator_version=999 WHERE building_id='brainchain-office'`;
    expect(await refusal(() => seedBrainChainCurriculum())).toContain('conflicts');
    const newer = await fixture`SELECT generator_version FROM building_skills WHERE building_id='brainchain-office'`;
    expect(newer[0]!.generator_version).toBe(999);
    await fixture`UPDATE building_skills SET generator_version=1,content_hash=${'ab'.repeat(32)} WHERE building_id='brainchain-office'`;
    expect(await refusal(() => seedBrainChainCurriculum())).toContain('conflicts');
  });
});
