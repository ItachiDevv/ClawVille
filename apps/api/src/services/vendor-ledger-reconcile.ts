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
 *   - not found once the scan reaches transactions older than the row, with
 *     every transaction in the landing window read -> 'failed' (not_landed;
 *     the seller's quote allows at most 300 s and a blockhash expires sooner,
 *     so a later landing is impossible);
 *   - anything unclear (RPC error, a transaction the RPC cannot return, an
 *     empty or short history, scan limit) -> unchanged.
 * Only transactions inside the landing window (from created_at to signed_at +
 * 420 s; the transaction's blockhash is fetched before signed_at and expires
 * within about 90 s) are fetched, so a busy wallet costs a few signature
 * pages, not hundreds of transaction reads. A row without signed_at (written
 * before migration 0091) reads every newer transaction. A row left
 * unchanged backs off (15 min doubling, at most 24 h) and is dropped from the
 * automatic pass after MAX_RECONCILE_ATTEMPTS (manual review; it still counts
 * toward that day's cap).
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
  signed_at: string | null;
  reconcile_attempts: number;
};

const MAX_PAGES = 5;
const SLACK_SECONDS = 120;
/** The quote allows at most 300 s; anything later cannot be our payment. */
const LANDING_WINDOW_SECONDS = 300 + SLACK_SECONDS;
export const MIN_RECONCILE_AGE_MINUTES = 10;
export const MAX_RECONCILE_ATTEMPTS = 8;

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
  const windowEndSec = row.signed_at
    ? Math.floor(new Date(row.signed_at).getTime() / 1000) + LANDING_WINDOW_SECONDS
    : Number.POSITIVE_INFINITY;
  let unreadInWindow = false;
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const sigs = await chain.signaturesFor(row.payer_wallet, before);
    // An empty page before the scan reaches the row's time proves nothing
    // (a lagging RPC, or a history that starts after the row).
    if (sigs.length === 0) return { id: row.id, to: 'unchanged', reason: 'history_incomplete' };
    for (const info of sigs) {
      if (info.blockTime !== null && info.blockTime < createdSec - SLACK_SECONDS) {
        return unreadInWindow
          ? { id: row.id, to: 'unchanged', reason: 'chain_unavailable' }
          : { id: row.id, to: 'failed', reason: 'not_landed' };
      }
      // Newer than the landing window: cannot be our payment; skip unread.
      if (info.blockTime !== null && info.blockTime > windowEndSec) continue;
      const tx = await chain.transaction(info.signature);
      if (!tx) {
        unreadInWindow = true;
        continue;
      }
      if (tx.signatures.includes(row.payer_signature)) {
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
  /** Operator run only: also rows past MAX_RECONCILE_ATTEMPTS or still backing off. */
  includeExhausted?: boolean;
}): Promise<ReconcileDecision[]> {
  const scheduled = options.includeExhausted
    ? sql`TRUE`
    : sql`reconcile_attempts < ${MAX_RECONCILE_ATTEMPTS} AND (reconcile_next_at IS NULL OR reconcile_next_at <= now())`;
  const olderThan = Math.max(options.olderThanMinutes ?? 15, MIN_RECONCILE_AGE_MINUTES);
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const chain = options.chain
    ?? connectionChainReader(process.env.SOLANA_MAINNET_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com');
  const rows = Array.from(await db.execute<Row>(sql`
    SELECT id, status, payer_wallet, payer_signature, created_at::text, signed_at::text, reconcile_attempts
    FROM vendor_spend_ledger
    WHERE vendor <> 'usepod' AND status IN ('pending', 'ambiguous')
      AND created_at < now() - make_interval(mins => ${olderThan})
      AND ${scheduled}
    ORDER BY COALESCE(reconcile_next_at, created_at)
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
    if (!options.apply) continue;
    if (decision.to === 'unchanged') {
      try {
        // Back off: 15 min, 30, 60, ... at most 24 h; then manual review.
        await db.execute(sql`UPDATE vendor_spend_ledger
          SET reconcile_attempts = reconcile_attempts + 1,
              reconcile_next_at = now() + LEAST(make_interval(mins => 15 * power(2, reconcile_attempts)::int), interval '24 hours'),
              updated_at = now()
          WHERE id = ${row.id} AND status IN ('pending', 'ambiguous')`);
        if (row.reconcile_attempts + 1 >= MAX_RECONCILE_ATTEMPTS) {
          console.warn(`[vendor-ledger-reconcile] row ${row.id} needs manual review (${decision.reason})`);
        }
      } catch (err) {
        console.error(`[vendor-ledger-reconcile] back-off failed for ${row.id}:`, err instanceof Error ? err.message : 'unknown');
      }
      continue;
    }
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
    void import('./usepod-deposit').then(({ reconcileUsepodDeposits }) => reconcileUsepodDeposits({ apply: true }))
      .then(rows => { const unknown = rows.filter(row => row.operatorReview).map(row => row.id); if (unknown.length) console.warn('[usepod-deposit] credit unknown after 10 minutes; ledger ids:', unknown); })
      .catch(() => console.error('[usepod-deposit] reconcile pass failed'));
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
