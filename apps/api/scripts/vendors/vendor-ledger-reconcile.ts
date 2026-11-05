#!/usr/bin/env bun
/**
 * Resolve vendor_spend_ledger rows that stay 'pending' or 'ambiguous'
 * (MCP hub step 2 phase 2a). Read-only unless --apply.
 *
 * Usage (inside the api container, from /app/apps/api):
 *   bun scripts/vendors/vendor-ledger-reconcile.ts [--older-than-minutes 15] [--apply]
 *
 * For each old row:
 *   - no payer_signature: the paid request was never sent (the signature is
 *     stored before sending) -> 'failed' (never_sent);
 *   - payer_signature found in a transaction of the payer wallet on chain:
 *     no error -> 'paid' with that transaction; error -> 'failed' (landed_with_error);
 *   - not found, and the row is older than the window (the seller's quote
 *     allows at most 300 s, and a blockhash expires sooner) -> 'failed' (not_landed);
 *   - anything unclear (RPC error, scan limit) -> left as is, reported.
 *
 * Prints ids, statuses and transaction signatures only.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { db, sql } from '@clawville/database';

type Row = {
  id: string;
  status: 'pending' | 'ambiguous';
  payer_wallet: string;
  payer_signature: string | null;
  tx_signature: string | null;
  created_at: string;
};

type Decision =
  | { id: string; to: 'paid'; tx: string }
  | { id: string; to: 'failed'; reason: 'never_sent' | 'landed_with_error' | 'not_landed'; tx?: string }
  | { id: string; to: 'unchanged'; reason: string };

const MAX_PAGES = 5;
const SLACK_SECONDS = 120;

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function findTransaction(connection: Connection, row: Row): Promise<Decision> {
  const createdSec = Math.floor(new Date(row.created_at).getTime() / 1000);
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const sigs = await connection.getSignaturesForAddress(new PublicKey(row.payer_wallet), { before, limit: 100 }, 'confirmed');
    if (sigs.length === 0) return { id: row.id, to: 'failed', reason: 'not_landed' };
    for (const info of sigs) {
      if (info.blockTime !== null && info.blockTime !== undefined && info.blockTime < createdSec - SLACK_SECONDS) {
        return { id: row.id, to: 'failed', reason: 'not_landed' };
      }
      const tx = await connection.getTransaction(info.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      const signatures = tx?.transaction.signatures ?? [];
      if (signatures.includes(row.payer_signature!)) {
        return tx?.meta?.err
          ? { id: row.id, to: 'failed', reason: 'landed_with_error', tx: info.signature }
          : { id: row.id, to: 'paid', tx: info.signature };
      }
    }
    before = sigs[sigs.length - 1]!.signature;
  }
  return { id: row.id, to: 'unchanged', reason: 'scan_limit' };
}

async function main(): Promise<number> {
  const olderThan = Number(arg('--older-than-minutes') ?? '15');
  if (!Number.isFinite(olderThan) || olderThan < 10) {
    console.error('refused: --older-than-minutes must be at least 10 (the payment window)');
    return 2;
  }
  const apply = process.argv.includes('--apply');
  const rpcUrl = process.env.SOLANA_MAINNET_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  const rows = Array.from(await db.execute<Row>(sql`
    SELECT id, status, payer_wallet, payer_signature, tx_signature, created_at::text
    FROM vendor_spend_ledger
    WHERE status IN ('pending', 'ambiguous')
      AND created_at < now() - make_interval(mins => ${olderThan})
    ORDER BY created_at
    LIMIT 100`));
  console.log(`rows to check: ${rows.length}${apply ? ' (apply)' : ' (dry run)'}`);

  for (const row of rows) {
    let decision: Decision;
    if (!row.payer_signature) {
      decision = row.status === 'pending'
        ? { id: row.id, to: 'failed', reason: 'never_sent' }
        : { id: row.id, to: 'unchanged', reason: 'ambiguous_without_payer_signature' };
    } else {
      try {
        decision = await findTransaction(connection, row);
      } catch {
        decision = { id: row.id, to: 'unchanged', reason: 'rpc_error' };
      }
    }
    console.log(JSON.stringify(decision));
    if (!apply || decision.to === 'unchanged') continue;
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
      console.error(`update failed for ${row.id}:`, err instanceof Error ? err.message : 'unknown');
    }
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('reconcile crashed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
