/**
 * One-off genesis backfill for avatars created BEFORE the covenant stream
 * shipped (2026-07-13). Without it, supply reconciliation
 * (sum(genesis) + sum(credits) - sum(debits) == sum(avatars.claw_tokens))
 * only holds for post-deploy avatars.
 *
 * Per avatar with NO genesis record yet, appends ONE `economy.genesis` record
 * whose amount is derived, not guessed:
 *
 *   amount = claw_tokens - SUM(signed claw_token_transactions amounts)
 *
 * i.e. exactly the balance the ledger does NOT explain — the original
 * starting grant plus any pre-ledger legacy drift. Labeled
 * `avatar_genesis_backfill` so a verifier can distinguish derived anchors
 * from creation-time records. A negative amount is possible in principle
 * (legacy drift the other way) and is recorded honestly.
 *
 * IDEMPOTENT: dedupe key `avatar:<id>:genesis` — re-runs and races with the
 * creation-time recorder are no-ops. Uses `recordCovenantAction` itself so
 * payload hashing is byte-identical to production (a hand-rolled SQL hash
 * that drifted would HALT the fail-closed sealer).
 *
 * Usage (explicit URL — never auto-loaded from .env.local):
 *   DATABASE_URL=<url> bun apps/api/scripts/covenant/backfill-genesis.ts [--dry-run]
 */

import { db, avatars, covenantActionRecords, sql } from '@clawville/database';
import { recordCovenantAction } from '../../src/services/covenant-action-recorder';

const dryRun = process.argv.includes('--dry-run');

type Row = {
  id: string;
  claw_tokens: number;
  ledger_sum: string | number | null;
};

const rows = await db.execute<Row>(sql`
  SELECT a.id, a.claw_tokens,
         (SELECT COALESCE(SUM(t.amount), 0) FROM claw_token_transactions t
          WHERE t.avatar_id = a.id) AS ledger_sum
  FROM avatars a
  WHERE NOT EXISTS (
    SELECT 1 FROM covenant_action_records r
    WHERE r.dedupe_key = 'avatar:' || a.id || ':genesis'
  )
  ORDER BY a.created_at ASC
`);

console.log(`avatars missing a genesis record: ${rows.length}${dryRun ? ' (dry-run)' : ''}`);

let written = 0;
let deduped = 0;
for (const row of rows) {
  const amount = Number(row.claw_tokens) - Number(row.ledger_sum ?? 0);
  if (dryRun) {
    console.log(`  would record ${row.id}: amount=${amount}`);
    continue;
  }
  const res = await recordCovenantAction({
    action: 'economy.genesis',
    subjectType: 'avatar',
    subjectId: row.id,
    actorKind: 'system',
    dedupeKey: `avatar:${row.id}:genesis`,
    payload: { amount, provenance: 'soft', reason: 'avatar_genesis_backfill' },
  });
  if (res.deduped) deduped += 1;
  else written += 1;
}

if (!dryRun) {
  console.log(`written=${written} deduped=${deduped}`);
  // Reconciliation proof: unexplained balance must now be zero across ALL
  // avatars (genesis + ledger fully explains the column).
  const [check] = await db.execute<{ unexplained: string }>(sql`
    SELECT COALESCE(SUM(a.claw_tokens), 0)
         - COALESCE((SELECT SUM(t.amount) FROM claw_token_transactions t), 0)
         - COALESCE((SELECT SUM((r.payload->>'amount')::bigint)
                     FROM covenant_action_records r
                     WHERE r.action = 'economy.genesis'), 0) AS unexplained
    FROM avatars a
  `);
  console.log(`post-backfill unexplained balance (must be 0): ${check.unexplained}`);
}
process.exit(0);
