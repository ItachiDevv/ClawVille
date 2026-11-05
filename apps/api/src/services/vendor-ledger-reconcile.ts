/**
 * Resolve vendor_spend_ledger rows that stay 'pending' or 'ambiguous'
 * (MCP hub step 2). Runs in the API every 15 minutes and from
 * `scripts/vendors/vendor-ledger-reconcile.ts` (dry run unless --apply).
 *
 * For each row older than the window:
 *   - no payer_signature: the paid request was never sent (the signature is
 *     stored before sending) -> 'failed' (never_sent);
 *   - our payer_signature found in a transaction of the payer wallet on chain:
 *     no error -> 'paid' with that transaction; error -> 'failed';
 *   - not found once the scan reaches transactions older than the row -> 'failed'
 *     (not_landed; the seller's quote allows at most 300 s and a blockhash
 *     expires sooner, so a later landing is impossible);
 *   - anything unclear (RPC error, scan limit) -> unchanged.
 * Only chain evidence moves a row. Nothing is ever paid or retried here.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { db, sql } from '@clawville/database';

export type ReconcileDecision =
  | { id: string; to: 'paid'; tx: string }
  | { id: string; to: 'failed'; reason: 'never_sent' | 'landed_with_error' | 'not_landed'; tx?: string }
  | { id: string; to: 'unchanged'; reason: string };

type Row = {
  id: string;
  status: 'pending' | 'ambiguous';
  payer_wallet: string;
  payer_signature: string | null;
  created_at: string;
};

const MAX_PAGES = 5;
const SLACK_SECONDS = 120;
export const MIN_RECONCILE_AGE_MINUTES = 10;

export interface ChainReader {
  signaturesFor(wallet: string, before: string | undefined): Promise<Array<{ signature: string; blockTime: number | null }>>;
  /** Signatures and error of one transaction, or null when unknown. */
  transaction(signature: string): Promise<{ signatures: string[]; failed: boolean } | null>;
}

export function connectionChainReader(rpcUrl: string): ChainReader {
  const connection = new Connection(rpcUrl, 'confirmed');
  return {
    signaturesFor: async (wallet, before) => (await connection.getSignaturesForAddress(new PublicKey(wallet), { before, limit: 100 }, 'confirmed'))
      .map((s) => ({ signature: s.signature, blockTime: s.blockTime ?? null })),
    transaction: async (signature) => {
      const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      return tx ? { signatures: tx.transaction.signatures, failed: tx.meta?.err != null } : null;
    },
  };
}

export async function decideRow(chain: ChainReader, row: Row): Promise<ReconcileDecision> {
  if (!row.payer_signature) {
    return row.status === 'pending'
      ? { id: row.id, to: 'failed', reason: 'never_sent' }
      : { id: row.id, to: 'unchanged', reason: 'ambiguous_without_payer_signature' };
  }
  const createdSec = Math.floor(new Date(row.created_at).getTime() / 1000);
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const sigs = await chain.signaturesFor(row.payer_wallet, before);
    if (sigs.length === 0) return { id: row.id, to: 'failed', reason: 'not_landed' };
    for (const info of sigs) {
      if (info.blockTime !== null && info.blockTime < createdSec - SLACK_SECONDS) {
        return { id: row.id, to: 'failed', reason: 'not_landed' };
      }
      const tx = await chain.transaction(info.signature);
      if (tx?.signatures.includes(row.payer_signature)) {
        return tx.failed
          ? { id: row.id, to: 'failed', reason: 'landed_with_error', tx: info.signature }
          : { id: row.id, to: 'paid', tx: info.signature };
      }
    }
    before = sigs[sigs.length - 1]!.signature;
  }
  return { id: row.id, to: 'unchanged', reason: 'scan_limit' };
}

export async function reconcileVendorLedger(options: {
  apply: boolean;
  olderThanMinutes?: number;
  limit?: number;
  chain?: ChainReader;
}): Promise<ReconcileDecision[]> {
  const olderThan = Math.max(options.olderThanMinutes ?? 15, MIN_RECONCILE_AGE_MINUTES);
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const chain = options.chain
    ?? connectionChainReader(process.env.SOLANA_MAINNET_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com');
  const rows = Array.from(await db.execute<Row>(sql`
    SELECT id, status, payer_wallet, payer_signature, created_at::text
    FROM vendor_spend_ledger
    WHERE status IN ('pending', 'ambiguous')
      AND created_at < now() - make_interval(mins => ${olderThan})
    ORDER BY created_at
    LIMIT ${limit}`));
  const decisions: ReconcileDecision[] = [];
  for (const row of rows) {
    let decision: ReconcileDecision;
    try {
      decision = await decideRow(chain, row);
    } catch {
      decision = { id: row.id, to: 'unchanged', reason: 'rpc_error' };
    }
    decisions.push(decision);
    if (!options.apply || decision.to === 'unchanged') continue;
    try {
      if (decision.to === 'paid') {
        await db.execute(sql`UPDATE vendor_spend_ledger
          SET status = 'paid', tx_signature = ${decision.tx}, failure_reason = 'reconciled_on_chain', updated_at = now()
          WHERE id = ${row.id} AND status IN ('pending', 'ambiguous')`);
      } else {
        await db.execute(sql`UPDATE vendor_spend_ledger
          SET status = 'failed', tx_signature = ${decision.tx ?? null}, failure_reason = ${`reconciled_${decision.reason}`}, updated_at = now()
          WHERE id = ${row.id} AND status IN ('pending', 'ambiguous')`);
      }
    } catch (err) {
      console.error(`[vendor-ledger-reconcile] update failed for ${row.id}:`, err instanceof Error ? err.message : 'unknown');
    }
  }
  return decisions;
}

let worker: ReturnType<typeof setInterval> | null = null;

/** Every 15 minutes, resolve old pending/ambiguous rows from chain evidence. */
export function startVendorLedgerReconcile(intervalMs = 15 * 60_000): void {
  if (worker) return;
  const run = () => {
    void reconcileVendorLedger({ apply: true })
      .then((decisions) => {
        const changed = decisions.filter((d) => d.to !== 'unchanged');
        if (changed.length) console.log(`[vendor-ledger-reconcile] resolved ${changed.length} row(s)`);
      })
      .catch((err) => console.error('[vendor-ledger-reconcile] pass failed:', err instanceof Error ? err.message : 'unknown'));
  };
  worker = setInterval(run, intervalMs);
  worker.unref?.();
  console.log(`[vendor-ledger-reconcile] worker started - every ${Math.round(intervalMs / 60_000)}min`);
}

export function stopVendorLedgerReconcile(): void {
  if (worker) clearInterval(worker);
  worker = null;
}
