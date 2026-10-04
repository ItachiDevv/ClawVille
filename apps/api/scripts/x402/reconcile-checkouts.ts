/**
 * x402 settle reconciler operator CLI.
 *
 * Default: read-only scan.
 * Apply:   RECONCILE_APPLY=true bun scripts/x402/reconcile-checkouts.ts --apply
 * Single:  append --row <x402_checkouts|ct_topups|agent_payments>:<id>
 */

import {
  parseReconcileCliArgs,
  runReconcileScan,
} from '../../src/services/x402-reconcile';

export { parseReconcileCliArgs };

async function main(): Promise<void> {
  const options = parseReconcileCliArgs(process.argv.slice(2));
  const result = await runReconcileScan(options);
  console.table(result.verdicts.map((verdict) => ({
    table: verdict.table,
    id: verdict.id,
    reason: verdict.reason,
    resolution: verdict.resolution.kind,
    action: verdict.action,
    detail: verdict.detail,
  })));
  console.log(
    `[reconcile] done — scanned=${result.scanned} applied=${result.summary.applied} ` +
      `skipped=${result.summary.skipped} manual=${result.summary.manual}`,
  );
}

// `bun run <file>` on Windows can lower-case the path in Bun.main, so import.meta.main is
// false and the script silently exits 0 without running (2026-10-04). Also accept a
// direct run whose argv[1] is this file, compared case-insensitively.
const invokedDirectly =
  import.meta.main ||
  (process.argv[1] ?? '').replace(/\\/g, '/').toLowerCase() === import.meta.path.replace(/\\/g, '/').toLowerCase();
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[reconcile] scan failed:', err);
    process.exit(1);
  });
}
