/**
 * x402 settle reconciler — runnable entry (Codex round-2 MEDIUM, DRY-RUN).
 *
 * Thin wrapper over `apps/api/src/services/x402-reconcile.ts` (the testable
 * logic). Enumerates every `reconcile` row across x402_checkouts + ct_topups,
 * classifies each into a resolution recommendation, and logs it. NEVER mutates a
 * row or touches the chain-write path — `RECONCILE_APPLY=true` makes it refuse.
 *
 * Run: `bun apps/api/scripts/x402/reconcile-checkouts.ts` (reads DATABASE_URL).
 */

import { runReconcileScan } from '../../src/services/x402-reconcile';

runReconcileScan()
  .then((r) => {
    console.log(`[reconcile] done — ${r.scanned} row(s) classified`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('[reconcile] scan failed:', err);
    process.exit(1);
  });
