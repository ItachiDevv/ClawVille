/**
 * Staging-only root operator for the BrainChain runtime probe. Runs in a one-off container from the
 * deployed API image (host network, loopback DB), never inside the API container. The signing key
 * lives only under /signer (host /root/brainchain-probe-signer), which the API container cannot see.
 *
 *   bun apps/api/scripts/brainchain/probe-root-op.ts genesis | reserve <config> | status
 *
 *   genesis           create signer key (once), pin, signed revision 1 (no reservations, 0 spent)
 *   reserve <config>  signed next revision adding the probe reservation from the protected config
 *   status            print head, document summary (no key material)
 *
 * Output: ids, hashes, revisions and micros only.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { ProtectedRootComputeStore, createRootComputeStoreDatabase, readRootTrialRecord, writeRootTrialRecord } from '../../src/services/brainchain/root-compute-store';
import { rootComputeDocumentBytes, rootComputeDocumentHash, type RootComputeDocument } from '../../src/services/brainchain/root-compute-budget';
import { probeBootstrapConfigSchema } from '../../src/services/brainchain/probe-bootstrap';
import { probeManifestHash } from '../../src/services/brainchain/probe-embedding-budget';

const JOB_ID = '2482562a-c3fd-4684-b3a8-963224c4f479';
const KEY = '/signer/root-ed25519.json';
const STORE = { pinPath: '/var/lib/brainchain-probe/root/pin.json', headPath: '/var/lib/brainchain-probe/root/head.json', historyDirectory: '/var/lib/brainchain-probe/history', expectedUid: 0 };
const WINDOW_MS = 600_000;

async function exists(path: string) { try { await lstat(path); return true; } catch { return false; } }
async function signer() {
  const { pem } = JSON.parse(await readRootTrialRecord(KEY, 0)) as { pem: string };
  const privateKey = createPrivateKey(pem);
  const publicKeyHex = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  return { privateKey, publicKeyHex };
}
function signed(document: RootComputeDocument, privateKey: ReturnType<typeof createPrivateKey>) {
  const text = rootComputeDocumentBytes(document);
  return { document: text, signatureHex: sign(null, Buffer.from(text, 'utf8'), privateKey).toString('hex') };
}
function database() {
  const url = process.env.ROOT_DATABASE_URL; if (!url) throw new Error('ROOT_DATABASE_URL missing');
  return createRootComputeStoreDatabase(url);
}

async function genesis() {
  if (process.env.CLAWVILLE_ENV !== 'staging') throw new Error('staging only');
  if (await exists(STORE.headPath)) throw new Error('head exists: genesis already published');
  if (!await exists(KEY)) {
    const { privateKey } = generateKeyPairSync('ed25519');
    await writeRootTrialRecord(KEY, 0, { pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() });
  }
  const { privateKey, publicKeyHex } = await signer();
  const sql = database();
  try {
    // Preflight before any pin write: the DB is reachable and holds no budget for this job.
    const [prior] = await sql`SELECT count(*)::int AS n FROM brainchain_compute_budgets WHERE job_id=${JOB_ID}`;
    if (prior!.n !== 0) throw new Error('job budget rows already exist');
    if (await exists(`${STORE.headPath}.lock`)) throw new Error('head lock exists');
    let doc: { document: string; signatureHex: string };
    if (await exists(STORE.pinPath)) {
      // Retry: reuse the exact signed genesis that the existing pin names, while it is unexpired.
      const pin = JSON.parse(await readRootTrialRecord(STORE.pinPath, 0)) as { jobId: string; publicKeyHex: string; genesisDocumentHash: string };
      const saved = `/signer/genesis-${pin.genesisDocumentHash}.json`;
      if (pin.jobId !== JOB_ID || pin.publicKeyHex !== publicKeyHex || !await exists(saved)) throw new Error('pin exists without its saved genesis; remove pin.json');
      doc = JSON.parse(await readRootTrialRecord(saved, 0));
      if (rootComputeDocumentHash(doc.document) !== pin.genesisDocumentHash || (JSON.parse(doc.document) as RootComputeDocument).expiresAtMs <= Date.now() + 5_000)
        throw new Error('saved genesis expired; remove pin.json and the saved genesis');
    } else {
      const now = Date.now();
      const document: RootComputeDocument = { kind: 'clawville-root-compute-v1', jobId: JOB_ID, revision: 1, previousDocumentHash: null, issuedAtMs: now, expiresAtMs: now + WINDOW_MS,
        providers: { openai: { capMicros: '10000000', spentMicros: '0' }, openrouter: { capMicros: '10000000', spentMicros: '0' } }, reservations: [] };
      doc = signed(document, privateKey);
      const genesisDocumentHash = rootComputeDocumentHash(doc.document);
      await writeRootTrialRecord(`/signer/genesis-${genesisDocumentHash}.json`, 0, doc);
      await writeRootTrialRecord(STORE.pinPath, 0, { jobId: JOB_ID, publicKeyHex, genesisDocumentHash });
    }
    const store = await ProtectedRootComputeStore.open({ ...STORE, database: sql });
    const head = await store.publish(doc, null);
    console.log(JSON.stringify({ ok: true, head, publicKeyHex }));
  } finally { await sql.end(); }
}

async function reserve(configPath: string) {
  if (process.env.CLAWVILLE_ENV !== 'staging') throw new Error('staging only');
  const config = probeBootstrapConfigSchema.parse(JSON.parse(await readRootTrialRecord(configPath, 0)));
  if (probeManifestHash(config.manifest) !== config.manifestHash) throw new Error('manifest hash mismatch');
  if (config.manifest.jobId !== JOB_ID) throw new Error('manifest job mismatch');
  const { privateKey } = await signer();
  const sql = database();
  try {
    const store = await ProtectedRootComputeStore.open({ ...STORE, database: sql });
    const head = await store.currentHead();
    const history = await store.loadHistory();
    const previous = JSON.parse(history.at(-1)!.document) as RootComputeDocument;
    const now = Date.now();
    if (config.manifest.expiresAtMs > now + WINDOW_MS || config.manifest.expiresAtMs <= now + 60_000) throw new Error('manifest window outside document window');
    const limitMicros = (BigInt(config.manifest.maxCalls) * 200n).toString();
    const document: RootComputeDocument = { ...previous, revision: previous.revision + 1, previousDocumentHash: head.documentHash, issuedAtMs: now, expiresAtMs: now + WINDOW_MS,
      reservations: [...previous.reservations, { rootReservationId: config.rootReservationId, provider: 'openai', approvalRef: `brainchain-probe:${config.manifestHash}`,
        limitMicros, expiresAtMs: config.manifest.expiresAtMs, state: 'reserved', revoked: false, chargedMicros: null, reconciliationRef: null }] };
    const next = await store.publish(signed(document, privateKey), { jobId: head.jobId, revision: head.revision, documentHash: head.documentHash });
    console.log(JSON.stringify({ ok: true, head: next, limitMicros, reservation: config.rootReservationId, expiresAtMs: config.manifest.expiresAtMs }));
  } finally { await sql.end(); }
}

async function status() {
  const store = await ProtectedRootComputeStore.open(STORE);
  const head = await store.currentHead();
  const history = await store.loadHistory();
  const current = JSON.parse(history.at(-1)!.document) as RootComputeDocument;
  console.log(JSON.stringify({ head, expiresAtMs: current.expiresAtMs, providers: current.providers,
    reservations: current.reservations.map(r => ({ id: r.rootReservationId, provider: r.provider, limitMicros: r.limitMicros, state: r.state, chargedMicros: r.chargedMicros })) }));
}

const [action, arg] = process.argv.slice(2);
try {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('linux root only');
  if (action === 'genesis') await genesis();
  else if (action === 'reserve' && arg) await reserve(arg);
  else if (action === 'status') await status();
  else throw new Error('usage: genesis | reserve <config> | status');
} catch (error) {
  const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : '';
  console.error(`root-op refused: ${error instanceof Error ? error.constructor.name : 'error'} ${code} ${error instanceof Error && !/postgres|url/i.test(error.message) ? error.message.slice(0, 200) : ''}`);
  process.exitCode = 1;
}
