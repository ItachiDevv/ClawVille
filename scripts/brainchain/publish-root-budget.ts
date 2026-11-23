/** Root-only publisher. JSON stdin supplies explicit configuration and an already signed document. */
import { ProtectedRootComputeStore, RootComputeStoreError, createRootComputeStoreDatabase } from '../../apps/api/src/services/brainchain/root-compute-store';
import type { ProtectedRootHead } from '../../apps/api/src/services/brainchain/root-compute-store';
import type { SignedRootComputeDocument } from '../../apps/api/src/services/brainchain/root-compute-budget';

if (import.meta.main) {
  const timer = setTimeout(() => { process.stderr.write('Root compute publication interrupted; inspect protected head before recovery.\n'); process.exit(1); }, 10_000);
  let database: { end(): Promise<void> } | undefined;
  try {
    if (process.platform !== 'linux') throw new RootComputeStoreError('platform_refused');
    const chunks: Uint8Array[] = []; let bytes = 0;
    for await (const chunk of Bun.stdin.stream()) { bytes += chunk.byteLength; if (bytes > 150_000) throw new RootComputeStoreError('store_refused'); chunks.push(chunk); }
    const text = Buffer.concat(chunks).toString('utf8');
    const value = JSON.parse(text) as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'databaseUrl,expectedHead,signed,store' || typeof value.databaseUrl !== 'string') throw new RootComputeStoreError('store_refused');
    const url = new URL(value.databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new RootComputeStoreError('store_refused');
    const storeInput = value.store as { pinPath: string; headPath: string; historyDirectory: string; expectedUid: number };
    if (!storeInput || Object.keys(storeInput).sort().join(',') !== 'expectedUid,headPath,historyDirectory,pinPath') throw new RootComputeStoreError('store_refused');
    const sql = createRootComputeStoreDatabase(value.databaseUrl); database = sql;
    const store = await ProtectedRootComputeStore.open({ ...storeInput, database: sql });
    const head = await store.publish(value.signed as SignedRootComputeDocument, value.expectedHead as ProtectedRootHead | null);
    process.stdout.write(`${JSON.stringify({ ok: true, head })}\n`);
  } catch {
    process.stderr.write('Root compute publication refused.\n'); process.exitCode = 1;
  } finally { clearTimeout(timer); await database?.end(); }
}
