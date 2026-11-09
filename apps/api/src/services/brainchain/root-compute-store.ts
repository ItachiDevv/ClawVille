import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { z } from 'zod';
import { rootComputeDocumentHash, SignedRootComputeBudgetAuthority, type RootComputeDocument, type RootComputeHead, type SignedRootComputeDocument } from './root-compute-budget';

export class RootComputeStoreError extends Error {
  constructor(readonly code: 'platform_refused' | 'store_refused' | 'stale_head' | 'reconciliation_refused' | 'busy') { super(`Root compute store refused: ${code}`); }
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const pinSchema = z.object({ jobId: z.string().uuid(), publicKeyHex: hash, genesisDocumentHash: hash }).strict();
const headSchema = z.object({ jobId: z.string().uuid(), revision: z.number().int().positive().max(64), documentHash: hash }).strict();
export type ProtectedRootHead = z.infer<typeof headSchema>;
export interface RootComputeStoreOptions {
  readonly pinPath: string; readonly headPath: string; readonly historyDirectory: string; readonly expectedUid: number;
  /** Required for publication. Runtime readers do not need database write authority. */
  readonly database?: Sql;
}
function fail(): never { throw new RootComputeStoreError('store_refused'); }
async function bounded<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RootComputeStoreError('store_refused')), 1000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function directory(path: string, uid: number): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) fail();
  let current = parse(path).root;
  for (const part of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part); const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== uid && info.uid !== 0) || (info.mode & 0o022) !== 0) fail();
  }
}
async function readProtected(path: string, uid: number, maximum: number): Promise<string> {
  await directory(dirname(path), uid);
  const before = await lstat(path); if (!before.isFile() || before.isSymbolicLink()) fail();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (info.ino !== before.ino || info.dev !== before.dev || !info.isFile() || info.uid !== uid || (info.mode & 0o077) !== 0 || info.nlink !== 1 || info.size < 1 || info.size > maximum) fail();
    const bytes = Buffer.alloc(maximum + 1); const result = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (result.bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.uid !== info.uid || after.mode !== info.mode || after.nlink !== 1) fail();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, result.bytesRead));
  } finally { await file.close(); }
}
async function syncDirectory(path: string): Promise<void> { const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY); try { await file.sync(); } finally { await file.close(); } }
async function writeExclusive(path: string, text: string): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(text, 'utf8'); await file.sync(); } finally { await file.close(); }
}
function sameHead(a: ProtectedRootHead, b: ProtectedRootHead): boolean { return a.jobId === b.jobId && a.revision === b.revision && a.documentHash === b.documentHash; }

/** Uses actual durable envelope/call rows. Caller assertions never replace accounting. */
export async function reconcileRootComputeDocument(tx: TransactionSql, document: RootComputeDocument): Promise<void> {
  const budgets = await tx`SELECT * FROM brainchain_compute_budgets WHERE job_id=${document.jobId} ORDER BY provider FOR UPDATE`;
  const envelopes = await tx`SELECT e.*,b.provider FROM brainchain_compute_envelopes e JOIN brainchain_compute_budgets b ON b.id=e.budget_id WHERE b.job_id=${document.jobId} ORDER BY e.id FOR UPDATE OF e`;
  const calls = await tx`SELECT c.* FROM brainchain_compute_calls c JOIN brainchain_compute_envelopes e ON e.id=c.envelope_id JOIN brainchain_compute_budgets b ON b.id=e.budget_id WHERE b.job_id=${document.jobId} ORDER BY c.id FOR UPDATE OF c`;
  for (const envelope of envelopes) {
    const reservation = document.reservations.find(item => item.rootReservationId === envelope.root_reservation_id);
    if (!reservation || reservation.provider !== envelope.provider || reservation.approvalRef !== envelope.approval_ref
      || reservation.limitMicros !== envelope.limit_micros || reservation.expiresAtMs !== envelope.expires_at.getTime()) throw new RootComputeStoreError('reconciliation_refused');
    const entries = calls.filter(item => item.envelope_id === envelope.id);
    const reserved = entries.filter(item => item.state === 'reserved').reduce((sum, item) => sum + BigInt(item.maximum_micros), 0n);
    const uncertain = entries.filter(item => item.state === 'dispatched' || item.state === 'uncertain').reduce((sum, item) => sum + BigInt(item.maximum_micros), 0n);
    const settled = entries.filter(item => item.state === 'settled').reduce((sum, item) => sum + BigInt(item.charged_micros), 0n);
    if (reserved !== BigInt(envelope.reserved_micros) || uncertain !== BigInt(envelope.uncertain_micros) || settled !== BigInt(envelope.settled_micros)) throw new RootComputeStoreError('reconciliation_refused');
    if (reservation.state === 'settled' || reservation.state === 'released') {
      if (envelope.state !== 'closed' || !envelope.reconciliation_id || reserved !== 0n || uncertain !== 0n
        || reservation.reconciliationRef !== envelope.reconciliation_id || reservation.chargedMicros !== settled.toString()
        || (reservation.state === 'released' && settled !== 0n)) throw new RootComputeStoreError('reconciliation_refused');
    } else if (envelope.state !== 'open') throw new RootComputeStoreError('reconciliation_refused');
  }
  for (const reservation of document.reservations) {
    if ((reservation.state === 'settled' || reservation.state === 'released') && !envelopes.some(item => item.root_reservation_id === reservation.rootReservationId)) throw new RootComputeStoreError('reconciliation_refused');
  }
  for (const provider of ['openai', 'openrouter'] as const) {
    const settled = envelopes.filter(item => item.provider === provider).reduce((sum, item) => sum + BigInt(item.settled_micros), 0n);
    const allocated = envelopes.filter(item => item.provider === provider).reduce((sum, item) => sum + BigInt(item.state === 'open' ? item.limit_micros : item.settled_micros), 0n);
    const budget = budgets.find(item => item.provider === provider);
    if ((budget && BigInt(budget.allocated_micros) !== allocated) || (!budget && allocated !== 0n)
      || BigInt(document.providers[provider].spentMicros) < settled || budgets.filter(item => item.provider === provider).length > 1) throw new RootComputeStoreError('reconciliation_refused');
  }
}

/** Linux host only. Task containers receive neither paths nor credentials. */
export class ProtectedRootComputeStore {
  private constructor(private readonly options: Readonly<RootComputeStoreOptions>, private readonly pins: z.infer<typeof pinSchema>) {}
  static async open(options: RootComputeStoreOptions): Promise<ProtectedRootComputeStore> {
    if (process.platform !== 'linux') throw new RootComputeStoreError('platform_refused');
    try {
      if (!Number.isSafeInteger(options.expectedUid) || options.expectedUid < 0 || process.getuid?.() !== options.expectedUid) fail();
      const captured = Object.freeze({ ...options });
      for (const path of [captured.pinPath, captured.headPath, captured.historyDirectory]) if (!isAbsolute(path) || resolve(path) !== path) fail();
      if (captured.pinPath === captured.headPath || [captured.pinPath, captured.headPath].some(path => path.startsWith(`${captured.historyDirectory}/`))) fail();
      await bounded(async () => { await directory(captured.historyDirectory, captured.expectedUid); await directory(dirname(captured.headPath), captured.expectedUid); });
      const pins = pinSchema.parse(JSON.parse(await bounded(() => readProtected(captured.pinPath, captured.expectedUid, 1024))));
      return new ProtectedRootComputeStore(captured, Object.freeze(pins));
    } catch (error) { if (error instanceof RootComputeStoreError) throw error; fail(); }
  }
  async currentHead(): Promise<RootComputeHead> {
    try { return await bounded(async () => {
      const head = headSchema.parse(JSON.parse(await readProtected(this.options.headPath, this.options.expectedUid, 1024)));
      if (head.jobId !== this.pins.jobId) fail();
      return { ...head, observedAtMs: Date.now() };
    }); } catch { fail(); }
  }
  async loadHistory(): Promise<readonly SignedRootComputeDocument[]> {
    try { return await bounded(async () => {
      const head = await this.currentHead();
      await directory(this.options.historyDirectory, this.options.expectedUid);
      const names = await readdir(this.options.historyDirectory); if (names.length > 128) fail();
      const history: SignedRootComputeDocument[] = [];
      for (let revision = 1; revision <= head.revision; revision++) {
        const matches = names.filter(name => new RegExp(`^${revision}-[a-f0-9]{64}\\.json$`).test(name));
        if (matches.length !== 1) fail();
        const signed = JSON.parse(await readProtected(join(this.options.historyDirectory, matches[0]!), this.options.expectedUid, 132_000)) as SignedRootComputeDocument;
        if (typeof signed?.document !== 'string' || matches[0] !== `${revision}-${rootComputeDocumentHash(signed.document)}.json`) fail();
        history.push(signed);
      }
      return history;
    }); } catch { fail(); }
  }
  authority(): SignedRootComputeBudgetAuthority {
    return new SignedRootComputeBudgetAuthority({ ...this.pins, currentHead: () => this.currentHead(), loadHistory: () => this.loadHistory() });
  }
  /** Root invokes this explicitly with an already signed next revision. No signing occurs here. */
  async publish(signed: SignedRootComputeDocument, expectedHead: ProtectedRootHead | null): Promise<ProtectedRootHead> {
    if (!signed || Object.keys(signed).sort().join(',') !== 'document,signatureHex' || typeof signed.document !== 'string'
      || Buffer.byteLength(signed.document) > 65536 || !/^[a-f0-9]{128}$/.test(signed.signatureHex)) fail();
    signed = Object.freeze({ ...signed }); expectedHead = expectedHead === null ? null : Object.freeze(headSchema.parse(expectedHead));
    const database = this.options.database;
    if (!database) throw new RootComputeStoreError('reconciliation_refused');
    const lockPath = `${this.options.headPath}.lock`; let locked = false;
    try {
      await directory(dirname(this.options.headPath), this.options.expectedUid);
      try { await writeExclusive(lockPath, JSON.stringify({ pid: process.pid, token: randomUUID() })); locked = true; } catch { throw new RootComputeStoreError('busy'); }
      let history: readonly SignedRootComputeDocument[] = [];
      if (expectedHead) {
        if (!sameHead(headSchema.parse(expectedHead), await this.currentHead())) throw new RootComputeStoreError('stale_head');
        history = await this.loadHistory();
      } else {
        try { await lstat(this.options.headPath); throw new RootComputeStoreError('stale_head'); }
        catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
      }
      const raw = JSON.parse(signed.document) as RootComputeDocument;
      const head = headSchema.parse({ jobId: raw.jobId, revision: raw.revision, documentHash: rootComputeDocumentHash(signed.document) });
      const candidate = [...history, signed];
      const authority = new SignedRootComputeBudgetAuthority({ ...this.pins,
        currentHead: async () => ({ ...head, observedAtMs: Date.now() }), loadHistory: async () => candidate });
      const document = await bounded(() => authority.verifyCurrentDocument());
      if (!expectedHead && (document.reservations.length || Object.values(document.providers).some(provider => provider.spentMicros !== '0'))) fail();
      await database.begin(async tx => {
        await tx`SET LOCAL lock_timeout='1000ms'`; await tx`SET LOCAL statement_timeout='2000ms'`;
        if (!expectedHead) {
          const prior = await tx`SELECT id FROM brainchain_compute_budgets WHERE job_id=${document.jobId} FOR UPDATE`;
          if (prior.length) throw new RootComputeStoreError('reconciliation_refused');
        }
        await reconcileRootComputeDocument(tx, document);
        if (expectedHead && !sameHead(expectedHead, await this.currentHead())) throw new RootComputeStoreError('stale_head');
        const path = join(this.options.historyDirectory, `${head.revision}-${head.documentHash}.json`);
        await directory(this.options.historyDirectory, this.options.expectedUid);
        const names = await readdir(this.options.historyDirectory);
        if (names.some(name => name.startsWith(`${head.revision}-`) && name !== `${head.revision}-${head.documentHash}.json`)) fail();
        try { await writeExclusive(path, JSON.stringify(signed)); }
        catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST'
            || await readProtected(path, this.options.expectedUid, 132_000) !== JSON.stringify(signed)) throw error;
        }
        await syncDirectory(this.options.historyDirectory);
        const temporary = `${this.options.headPath}.${randomUUID()}.tmp`;
        await writeExclusive(temporary, JSON.stringify(head));
        if (document.expiresAtMs <= Date.now()) fail();
        await rename(temporary, this.options.headPath); await syncDirectory(dirname(this.options.headPath));
      });
      return head;
    } catch (error) { if (error instanceof RootComputeStoreError) throw error; throw new RootComputeStoreError('store_refused'); }
    finally { if (locked) { await unlink(lockPath); await syncDirectory(dirname(lockPath)); } }
  }
}

/** Root-owned journal helpers share the store's Linux permission policy. */
export async function readRootTrialRecord(path: string, uid: number): Promise<string> {
  if (process.platform !== 'linux' || process.getuid?.() !== uid) throw new RootComputeStoreError('platform_refused');
  try { return await bounded(() => readProtected(path, uid, 16384)); } catch { fail(); }
}
export async function writeRootTrialRecord(path: string, uid: number, value: unknown): Promise<void> {
  if (process.platform !== 'linux' || process.getuid?.() !== uid) throw new RootComputeStoreError('platform_refused');
  try {
    const text = JSON.stringify(value); if (Buffer.byteLength(text) > 16384) fail();
    await directory(dirname(path), uid); await writeExclusive(path, text); await syncDirectory(dirname(path));
  } catch { fail(); }
}

/** Root supplies the explicit local connection through protected stdin; no discovery occurs. */
export function createRootComputeStoreDatabase(databaseUrl: string): Sql {
  if (process.platform !== 'linux') throw new RootComputeStoreError('platform_refused');
  try {
    const url = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) fail();
    return postgres(databaseUrl, { max: 1, connect_timeout: 2, idle_timeout: 2, onnotice: () => {},
      connection: { statement_timeout: 2000, lock_timeout: 1000 } });
  } catch { fail(); }
}
