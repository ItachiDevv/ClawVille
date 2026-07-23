/**
 * One-shot bulk x402 outage reconciler.
 *
 * Dry-run:
 *   bun scripts/x402/bulk-reconcile-sweep.ts --limit 10000
 *
 * Apply (double consent):
 *   RECONCILE_APPLY=true bun scripts/x402/bulk-reconcile-sweep.ts --apply --limit 10000
 */

import {
  parseBulkReconcileCliArgs,
  runBulkReconcileSweep,
} from '../../src/services/x402-bulk-reconcile';

export { parseBulkReconcileCliArgs };

async function main(): Promise<void> {
  const options = parseBulkReconcileCliArgs(process.argv.slice(2));
  const result = await runBulkReconcileSweep(options);
  console.table(result.verdicts.map((verdict) => ({
    table: verdict.row.table,
    id: verdict.row.id,
    bucket: verdict.bucket,
    action: verdict.action ?? (result.apply ? 'none' : 'dry_run'),
    signature: verdict.transfer?.signature ?? '',
    detail: verdict.detail,
  })));
  console.log('[bulk-reconcile] bucket counts', {
    matched: result.summary.matched,
    noMoney: result.summary.noMoney,
    waiting: result.summary.waiting,
    manual: result.summary.manual,
    indeterminate: result.summary.indeterminate,
  });
  console.log(
    `[bulk-reconcile] captured=${result.summary.captured} ` +
      `volume=$${(result.summary.capturedUsdCents / 100).toFixed(2)} ` +
      `closedNoMoney=${result.summary.closedNoMoney}`,
  );
  if (result.summary.manualRowIds.length > 0) {
    console.log('[bulk-reconcile] manual row ids');
    for (const rowId of result.summary.manualRowIds) console.log(rowId);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[bulk-reconcile] sweep failed:', error);
    process.exit(1);
  });
}
