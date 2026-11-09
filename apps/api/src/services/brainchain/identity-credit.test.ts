import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { toHex } from 'viem';
import { identityCreditQuerySchema, readWorkerIdentityCredit } from './identity-credit';
import { priorsRecordSchema, priorsRoutesSchema } from './priors-reader';
import { BRAINCHAIN_PARENT } from './parent-reader';
const now = Date.parse('2026-11-09T16:00:00Z');
const asOf = new Date(now - 30_000).toISOString();
const record = priorsRecordSchema.parse({ ...JSON.parse(readFileSync(new URL('../../../../../docs/research/brainchain-2026-11-09/priors-public-sponsor-record.json', import.meta.url), 'utf8')).result.structuredContent, asOf });
const routes = priorsRoutesSchema.parse({ ...JSON.parse(readFileSync(new URL('../../../../../docs/research/brainchain-2026-11-09/priors-public-line-options.json', import.meta.url), 'utf8')).response.result.structuredContent,
  asOf: { snapshot: asOf, stocks: asOf, directoryBlock: 1000 } });
const hash = `0x${'a'.repeat(64)}`;
const worker = { id: '11111111-1111-4111-8111-111111111111', environment: 'mainnet' as const, chainId: 274663, address: record.owner };
function fixture() {
  let clients = 0;
  const parent = { anchor: async () => ({ number: toHex(5000), hash, timestamp: toHex(BigInt(now / 1000) - 10n) }),
    block: async (number: bigint) => ({ number: toHex(number), hash, timestamp: toHex(BigInt(now / 1000) - 10n) }),
    association: async () => ({ owner: record.owner, registeredWallet: record.owner, kind: 'both' as 'owner' | 'registered_wallet' | 'both' }),
    reputation: async () => ({ issuer: BRAINCHAIN_PARENT.issuer, tag1: 'brainchain' as const, tag2: 'task' as const, count: '0', summaryValue: '0', summaryValueDecimals: 0 }) };
  const priors = { record: async () => record, routes: async () => routes };
  const deps = { now: () => now, parent: () => parent, priors: () => { clients++; return priors; } };
  return { deps, parent, priors, clients: () => clients };
}
test('exact Priors record fields remain separate from source quotes and worker balances', async () => {
  const f = fixture(); const result = await readWorkerIdentityCredit(worker, { agentId: '20423' }, f.deps);
  expect(result.identity).toMatchObject({ state: 'verified', association: 'both', chainId: 4663 });
  expect(result.record).toMatchObject({ state: 'observed', line: '951.899279', available: '726.607614', drawn: '0.00', premiumBps: 0,
    volumeRepaid: '0.00', feesPaid: '0.00', defaulted: false, frozen: false, openLoans: { state: 'none', count: 0 } });
  expect(result.routes).toMatchObject({ state: 'observed', snapshotAgeSeconds: 30, stocksAgeSeconds: 30 });
  expect(JSON.stringify(result)).not.toContain('next'); expect(JSON.stringify(result)).not.toContain('https://'); expect('balances' in result).toBe(false);
});
test('testnet, stale parent, unassociated and failed parent reads never construct a Priors client', async () => {
  for (const mode of ['testnet', 'stale', 'unassociated', 'unavailable']) {
    const f = fixture();
    if (mode === 'stale') f.parent.anchor = async () => ({ number: toHex(5000), hash, timestamp: toHex(BigInt(now / 1000) - 121n) });
    if (mode === 'unassociated') f.parent.association = async () => null as never;
    if (mode === 'unavailable') f.parent.anchor = async () => { throw Error('private transport details'); };
    const result = await readWorkerIdentityCredit({ ...worker, environment: mode === 'testnet' ? 'testnet' : 'mainnet' }, { agentId: '20423' }, f.deps);
    expect(result.identity.state).not.toBe('verified'); expect(f.clients()).toBe(0);
    expect(result.record.state).toBe('not_requested'); expect(result.routes.state).toBe('not_requested');
    expect(JSON.stringify(result)).not.toContain('private transport');
  }
});
test('a registered wallet remains distinct from the owner and does not gain consent authority', async () => {
  const f = fixture(); f.parent.association = async () => ({ owner: record.owner, registeredWallet: `0x${'1'.repeat(40)}`, kind: 'registered_wallet' });
  const result = await readWorkerIdentityCredit({ ...worker, address: `0x${'1'.repeat(40)}` }, { agentId: '20423' }, f.deps);
  expect(result.identity).toMatchObject({ state: 'verified', owner: record.owner, association: 'registered_wallet' });
  expect(result.record.state).toBe('observed'); expect('consent' in result).toBe(false);
});
test('owner or ID mismatches discard source fields; stale times remain explicit', async () => {
  for (const value of [{ ...record, owner: `0x${'1'.repeat(40)}` }, { ...record, agentId: 462 }, { ...record, asOf: new Date(now + 31_000).toISOString() }]) {
    const f = fixture(); f.priors.record = async () => value;
    expect((await readWorkerIdentityCredit(worker, { agentId: '20423' }, f.deps)).record.state).toBe('unavailable');
  }
  const f = fixture(); f.priors.record = async () => ({ ...record, asOf: new Date(now - 301_000).toISOString() });
  f.priors.routes = async () => ({ ...routes, asOf: { ...routes.asOf, stocks: new Date(now - 901_000).toISOString() } });
  const result = await readWorkerIdentityCredit(worker, { agentId: '20423' }, f.deps);
  expect(result.record.state).toBe('stale'); expect(result.routes.state).toBe('stale');
});
test('a changed final anchor discards all identity and credit observations', async () => {
  const f = fixture(); f.parent.block = async number => ({ number: toHex(number), hash: `0x${'b'.repeat(64)}`, timestamp: toHex(BigInt(now / 1000)) });
  const result = await readWorkerIdentityCredit(worker, { agentId: '20423' }, f.deps);
  expect(result.identity.state).toBe('unavailable'); expect(result.record.state).toBe('not_requested');
});
test('parent association that ages beyond the limit during Priors reads is discarded', async () => {
  const f = fixture(); let clock = now; f.deps.now = () => clock;
  f.priors.record = async () => { clock += 111_000; return record; };
  const result = await readWorkerIdentityCredit(worker, { agentId: '20423' }, f.deps);
  expect(result.identity.state).toBe('stale'); expect(result.record.state).toBe('not_requested');
});
test('final anchor wait updates record, snapshot, and stock freshness before no-record classification', async () => {
  for (const missingRecord of [false, true]) {
    const f = fixture(); let clock = now; f.deps.now = () => clock;
    const snapshotTime = new Date(now - 299_000).toISOString();
    f.priors.record = async () => { if (missingRecord) throw Error('missing'); return { ...record, asOf: snapshotTime }; };
    f.priors.routes = async () => ({ ...routes, record: missingRecord ? null : {}, asOf: { ...routes.asOf, snapshot: snapshotTime, stocks: new Date(now - 899_000).toISOString() } });
    f.parent.block = async number => { clock += 4000; return { number: toHex(number), hash, timestamp: toHex(BigInt(now / 1000) - 10n) }; };
    const result = await readWorkerIdentityCredit(worker, { agentId: '20423' }, f.deps);
    expect(result.identity).toMatchObject({ state: 'verified', blockAgeSeconds: 14 });
    expect(result.record).toMatchObject(missingRecord ? { state: 'unavailable' } : { state: 'stale', ageSeconds: 303 });
    expect(result.routes).toMatchObject({ state: 'stale', snapshotAgeSeconds: 303, stocksAgeSeconds: 903 });
  }
});
test('fractional clock time cannot extend the source freshness limit', async () => {
  const f = fixture(); f.deps.now = () => now + 500;
  f.priors.record = async () => ({ ...record, asOf: new Date(now - 300_000).toISOString() });
  const result = await readWorkerIdentityCredit(worker, { agentId: '20423' }, f.deps);
  expect(result.record).toMatchObject({ state: 'stale', ageSeconds: 300 });
});
test('safe-integer limit applies only to Priors, never rounds the selected identity', async () => {
  const f = fixture(); const result = await readWorkerIdentityCredit(worker, { agentId: '9007199254740992' }, f.deps);
  expect(result.agentId).toBe('9007199254740992'); expect(result.identity.state).toBe('verified'); expect(result.record.state).toBe('unsupported_id'); expect(f.clients()).toBe(0);
  for (const value of ['01', '-1', String(2n ** 256n)]) expect(identityCreditQuerySchema.safeParse({ agentId: value }).success).toBe(false);
  expect(identityCreditQuerySchema.safeParse({ agentId: '462', avatarId: 'foreign' }).success).toBe(false);
});
test('explicit no-record evidence differs from a failed record read and unknown loan terms', async () => {
  const f = fixture(); f.priors.record = async () => { throw Error('unavailable'); };
  expect((await readWorkerIdentityCredit(worker, { agentId: '20423' }, f.deps)).record.state).toBe('unavailable');
  f.priors.routes = async () => ({ ...routes, record: null });
  expect((await readWorkerIdentityCredit(worker, { agentId: '20423' }, f.deps)).record.state).toBe('no_record');
  f.priors.record = async () => ({ ...record, openLoans: [{ next: { tool: 'borrow' }, terms: 'unverified' }] });
  const result = await readWorkerIdentityCredit(worker, { agentId: '20423' }, f.deps);
  expect(result.record).toMatchObject({ openLoans: { state: 'terms_unavailable', count: 1 } }); expect(JSON.stringify(result)).not.toContain('borrow');
});
