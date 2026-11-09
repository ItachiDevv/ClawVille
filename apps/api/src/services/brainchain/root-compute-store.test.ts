import { getBrainchainFixtureSettings } from './test-fixtures/database';
import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { chmod, link, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import type { Sql } from 'postgres';
import { ProtectedRootComputeStore, reconcileRootComputeDocument } from './root-compute-store';
import { rootComputeDocumentBytes, rootComputeDocumentHash, type RootComputeDocument } from './root-compute-budget';

const childMode = process.env.ROOT_STORE_TEST_CHILD;
const linux = process.platform === 'linux';
/** Controlled empty-accounting unit fixture. It does not represent a chain hire or paid request. */
function emptyDatabase(before?: () => Promise<void>): Sql {
  const tx = async () => [];
  return { begin: async (action: (tx: unknown) => Promise<unknown>) => { await before?.(); return action(tx); } } as unknown as Sql;
}
async function fixture() {
  const path = `/fixture/root-store-${randomUUID()}`; await mkdir(`${path}/protected`, { recursive: true, mode: 0o700 }); await mkdir(`${path}/history`, { mode: 0o700 });
  const keys = generateKeyPairSync('ed25519'); const now = Date.now();
  const first: RootComputeDocument = { kind: 'clawville-root-compute-v1', jobId: randomUUID(), revision: 1, previousDocumentHash: null,
    issuedAtMs: now - 2000, expiresAtMs: now + 300_000,
    providers: { openai: { capMicros: '10000000', spentMicros: '0' }, openrouter: { capMicros: '10000000', spentMicros: '0' } }, reservations: [] };
  const seal = (value: RootComputeDocument) => { const document = rootComputeDocumentBytes(value); return { document, signatureHex: sign(null, Buffer.from(document), keys.privateKey).toString('hex') }; };
  const signed = seal(first);
  const pins = { jobId: first.jobId, publicKeyHex: (keys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), genesisDocumentHash: rootComputeDocumentHash(signed.document) };
  const options = { pinPath: `${path}/protected/pins.json`, headPath: `${path}/protected/head.json`, historyDirectory: `${path}/history`, expectedUid: process.getuid!(), database: emptyDatabase() };
  await writeFile(options.pinPath, JSON.stringify(pins), { mode: 0o600 });
  const store = await ProtectedRootComputeStore.open(options); const head = await store.publish(signed, null);
  const second = { ...structuredClone(first), revision: 2, issuedAtMs: now - 1000, previousDocumentHash: head.documentHash };
  return { path, options, store, head, signed, first, second, seal };
}

test.skipIf(linux || !!childMode)('Windows direct store use refuses without any file access', async () => {
  await expect(ProtectedRootComputeStore.open({ pinPath: '/absent', headPath: '/absent', historyDirectory: '/absent', expectedUid: 0 })).rejects.toMatchObject({ code: 'platform_refused' });
});
test.skipIf(!linux || !!childMode)('Linux publication retains history, restarts and verifies an empty pinned genesis', async () => {
  const f = await fixture(); expect((await f.store.authority().verifyCurrentDocument()).reservations).toEqual([]);
  await f.store.publish(f.seal(f.second), f.head);
  const restarted = await ProtectedRootComputeStore.open(f.options);
  expect((await restarted.currentHead()).revision).toBe(2); expect((await restarted.loadHistory()).length).toBe(2);
  await expect(restarted.publish(f.signed, null)).rejects.toMatchObject({ code: 'stale_head' });
  await expect(restarted.publish(f.seal(f.second), f.head)).rejects.toMatchObject({ code: 'stale_head' });
});
test.skipIf(!linux || !!childMode)('unsafe modes, symlinks, hardlinks, owners and alternate history refuse', async () => {
  const f = await fixture();
  await chmod(f.options.pinPath, 0o644); await expect(ProtectedRootComputeStore.open(f.options)).rejects.toMatchObject({ code: 'store_refused' }); await chmod(f.options.pinPath, 0o600);
  await expect(ProtectedRootComputeStore.open({ ...f.options, expectedUid: f.options.expectedUid + 1 })).rejects.toMatchObject({ code: 'store_refused' });
  const pin = await readFile(f.options.pinPath, 'utf8'); await unlink(f.options.pinPath); await writeFile(`${f.path}/protected/other.json`, pin, { mode: 0o600 });
  await symlink(`${f.path}/protected/other.json`, f.options.pinPath); await expect(ProtectedRootComputeStore.open(f.options)).rejects.toMatchObject({ code: 'store_refused' });
  await unlink(f.options.pinPath); await link(`${f.path}/protected/other.json`, f.options.pinPath); await expect(ProtectedRootComputeStore.open(f.options)).rejects.toMatchObject({ code: 'store_refused' });
  await unlink(f.options.pinPath); await writeFile(f.options.pinPath, pin, { mode: 0o600 });
  await chmod(f.options.historyDirectory, 0o777); await expect(ProtectedRootComputeStore.open(f.options)).rejects.toMatchObject({ code: 'store_refused' }); await chmod(f.options.historyDirectory, 0o700);
  await f.store.publish(f.seal(f.second), f.head);
  await unlink(`${f.options.historyDirectory}/2-${rootComputeDocumentHash(f.seal(f.second).document)}.json`);
  await expect(f.store.authority().verifyCurrentDocument()).rejects.toMatchObject({ code: 'budget_refused' });
});
test.skipIf(!linux || !!childMode)('concurrent publication refuses and oversized input cannot advance the protected head', async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const held = await ProtectedRootComputeStore.open({ ...f.options, database: emptyDatabase(async () => { entered(); await wait; }) });
  const pending = held.publish(f.seal(f.second), f.head); await ready;
  let refused: unknown; try { await f.store.publish(f.seal(f.second), f.head); } catch (error) { refused = error; }
  expect(refused).toMatchObject({ code: 'busy' }); release(); await pending;
  expect((await f.store.currentHead()).revision).toBe(2);
  await writeFile(f.options.headPath, ' '.repeat(1025), { mode: 0o600 });
  await expect(f.store.currentHead()).rejects.toMatchObject({ code: 'store_refused' });
});
test.skipIf(!linux || !!childMode)('actual child crashes before and after publication preserve a verifiable restart head', async () => {
  for (const phase of ['before', 'after'] as const) {
    const f = await fixture(); await writeFile(`${f.path}/next.json`, JSON.stringify(f.seal(f.second)), { mode: 0o600 });
    const child = Bun.spawn([process.execPath, 'test', import.meta.path, '--test-name-pattern', 'root store crash child only'], {
      env: { ROOT_STORE_TEST_CHILD: phase, ROOT_STORE_TEST_DIR: f.path }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const reader = child.stdout.getReader(); let text = ''; const expiry = Date.now()+3000;
    while (!text.includes('ROOT_STORE_CRASH_READY') && Date.now() < expiry) {
      const part = await Promise.race([reader.read(), Bun.sleep(3000).then(() => ({ done: true, value: undefined }))]);
      if (part.done) break; text += new TextDecoder().decode(part.value);
    }
    child.kill('SIGKILL'); await child.exited;
    if (!text.includes('ROOT_STORE_CRASH_READY')) console.error(await new Response(child.stderr).text());
    expect(text.includes('ROOT_STORE_CRASH_READY')).toBe(true);
    const restarted = await ProtectedRootComputeStore.open(f.options);
    expect((await restarted.currentHead()).revision).toBe(phase === 'before' ? 1 : 2);
    await expect(restarted.authority().verifyCurrentDocument()).resolves.toBeDefined();
    if (phase === 'before') {
      await expect(restarted.publish(f.seal(f.second), f.head)).rejects.toMatchObject({ code: 'busy' });
      // Test removes only its own stale lock after observing its child exit. Production needs root review.
      await unlink(`${f.options.headPath}.lock`); await restarted.publish(f.seal(f.second), f.head);
      expect((await restarted.currentHead()).revision).toBe(2);
    }
  }
}, 10000);
test.skipIf(!linux || !childMode)('root store crash child only', async () => {
  const path = process.env.ROOT_STORE_TEST_DIR!;
  const database = emptyDatabase(childMode === 'before' ? async () => { console.log('ROOT_STORE_CRASH_READY'); await new Promise(() => {}); } : undefined);
  const store = await ProtectedRootComputeStore.open({ pinPath: `${path}/protected/pins.json`, headPath: `${path}/protected/head.json`, historyDirectory: `${path}/history`, expectedUid: process.getuid!(), database });
  const next = JSON.parse(await readFile(`${path}/next.json`, 'utf8'));
  const { observedAtMs: _time, ...head } = await store.currentHead();
  await store.publish(next, head); console.log('ROOT_STORE_CRASH_READY'); await new Promise(() => {});
}, 5000);

test.skipIf(process.env.BRAINCHAIN_DB_FIXTURE !== '1' || !!childMode)('actual PostgreSQL reconciliation refuses unresolved holds and requires matching local closure', async () => {
  const postgres = (await import('postgres')).default;
  const settings=await getBrainchainFixtureSettings();
  const database = postgres({...settings.options, max: 1, onnotice: () => {} });
  try {
    const jobId = randomUUID(), budgetId = randomUUID(), envelopeId = randomUUID(), reservationId = randomUUID(), reconciliation = randomUUID();
    const expiry = new Date(Date.now()+60_000);
    await database`INSERT INTO brainchain_compute_budgets(id,job_id,provider,cap_micros,allocated_micros) VALUES(${budgetId},${jobId},'openai',10000000,1000)`;
    await database`INSERT INTO brainchain_compute_envelopes(id,budget_id,root_reservation_id,approval_ref,limit_micros,expires_at) VALUES(${envelopeId},${budgetId},${reservationId},'controlled-store-fixture',1000,${expiry})`;
    const document: RootComputeDocument = { kind: 'clawville-root-compute-v1', jobId, revision: 1, previousDocumentHash: null, issuedAtMs: Date.now()-1000, expiresAtMs: expiry.getTime(),
      providers: { openai: { capMicros: '10000000', spentMicros: '0' }, openrouter: { capMicros: '10000000', spentMicros: '0' } },
      reservations: [{ rootReservationId: reservationId, provider: 'openai', approvalRef: 'controlled-store-fixture', limitMicros: '1000', expiresAtMs: expiry.getTime(), state: 'reserved', revoked: false, chargedMicros: null, reconciliationRef: null }] };
    await database.begin(tx => reconcileRootComputeDocument(tx, document));
    document.reservations[0]!.state = 'released'; document.reservations[0]!.chargedMicros = '0'; document.reservations[0]!.reconciliationRef = reconciliation;
    let refused: unknown;
    try { await database.begin(tx => reconcileRootComputeDocument(tx, document)); } catch (error) { refused = error; }
    expect(refused).toMatchObject({ code: 'reconciliation_refused' });
    await database`UPDATE brainchain_compute_envelopes SET reserved_micros=1000 WHERE id=${envelopeId}`;
    refused = undefined; try { await database.begin(tx => reconcileRootComputeDocument(tx, document)); } catch (error) { refused = error; }
    expect(refused).toMatchObject({ code: 'reconciliation_refused' });
    await database`UPDATE brainchain_compute_envelopes SET reserved_micros=0,state='closed',closed_at=clock_timestamp(),reconciliation_id=${reconciliation} WHERE id=${envelopeId}`;
    await database`UPDATE brainchain_compute_budgets SET allocated_micros=0 WHERE id=${budgetId}`;
    await database.begin(tx => reconcileRootComputeDocument(tx, document));
    document.reservations[0]!.reconciliationRef = randomUUID();
    refused = undefined; try { await database.begin(tx => reconcileRootComputeDocument(tx, document)); } catch (error) { refused = error; }
    expect(refused).toMatchObject({ code: 'reconciliation_refused' });
    const [held] = await database`SELECT e.*,b.job_id,b.provider FROM brainchain_compute_calls c JOIN brainchain_compute_envelopes e ON e.id=c.envelope_id JOIN brainchain_compute_budgets b ON b.id=e.budget_id WHERE c.state='uncertain' AND e.root_reservation_id ~ '^[a-f0-9-]{36}$' ORDER BY c.created_at DESC LIMIT 1`;
    if (!held) throw new Error('Run the controlled inference proxy fixture before this reconciliation test');
    document.jobId = held.job_id;
    document.reservations = [{ rootReservationId: held.root_reservation_id, provider: held.provider, approvalRef: held.approval_ref, limitMicros: held.limit_micros,
      expiresAtMs: held.expires_at.getTime(), state: 'released', revoked: false, chargedMicros: '0', reconciliationRef: randomUUID() }];
    refused = undefined; try { await database.begin(tx => reconcileRootComputeDocument(tx, document)); } catch (error) { refused = error; }
    expect(refused).toMatchObject({ code: 'reconciliation_refused' });
  } finally { await database.end(); }
});
