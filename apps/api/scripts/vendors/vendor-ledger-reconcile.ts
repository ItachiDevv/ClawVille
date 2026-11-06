#!/usr/bin/env bun
/**
 * Operator run of the vendor ledger reconcile (the API also runs it every 15
 * minutes; see `src/services/vendor-ledger-reconcile.ts`). Read-only unless
 * --apply.
 *
 * Usage (inside the api container, from /app/apps/api):
 *   bun scripts/vendors/vendor-ledger-reconcile.ts [--older-than-minutes 15] [--include-exhausted] [--apply]
 *
 * --include-exhausted also checks rows that the automatic pass dropped after
 * MAX_RECONCILE_ATTEMPTS, or that are still backing off (for example after an
 * RPC outage).
 *
 * Prints ids, statuses and transaction signatures only.
 */

import { MIN_RECONCILE_AGE_MINUTES, reconcileVendorLedger } from '../../src/services/vendor-ledger-reconcile';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main(): Promise<number> {
  const olderThan = Number(arg('--older-than-minutes') ?? '15');
  if (!Number.isFinite(olderThan) || olderThan < MIN_RECONCILE_AGE_MINUTES) {
    console.error(`refused: --older-than-minutes must be at least ${MIN_RECONCILE_AGE_MINUTES} (the payment window)`);
    return 2;
  }
  const apply = process.argv.includes('--apply');
  const includeExhausted = process.argv.includes('--include-exhausted');
  const decisions = await reconcileVendorLedger({ apply, olderThanMinutes: olderThan, limit: 100, includeExhausted });
  console.log(`rows checked: ${decisions.length}${apply ? ' (apply)' : ' (dry run)'}`);
  for (const d of decisions) console.log(JSON.stringify(d));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('reconcile crashed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
