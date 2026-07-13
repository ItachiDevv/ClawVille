/**
 * One-off genesis backfill for avatars created BEFORE the covenant stream
 * shipped (2026-07-13). Without it, supply reconciliation
 * (sum(genesis) + sum(ledger) == sum(avatars.claw_tokens)) only holds for
 * post-deploy avatars.
 *
 * Per cohort avatar with NO genesis record yet, appends ONE `economy.genesis`
 * record whose amount is derived, not guessed:
 *
 *   amount = claw_tokens - SUM(signed claw_token_transactions amounts)
 *
 * i.e. exactly the balance the ledger does NOT explain — the original
 * starting grant plus any pre-ledger legacy drift. Labeled
 * `avatar_genesis_backfill` so a verifier can distinguish derived anchors
 * from creation-time records. A negative amount is possible in principle
 * (legacy drift the other way) and is recorded honestly.
 *
 * RACE-SAFE FOR LIVE PROMOTION (Codex round 4 HIGH #4):
 *   - FIXED COHORT: only avatars created BEFORE the script started are
 *     candidates — a registration racing the run is out of cohort and gets
 *     its genesis atomically at creation (the creation-time recorder).
 *   - Per-avatar collision tolerance: if the creation-time recorder wins a
 *     dedupe race mid-run, that avatar is SKIPPED (any existing record under
 *     `avatar:<id>:genesis` is authoritative); genuine failures are collected
 *     and fail the run.
 *   - PER-AVATAR reconciliation (bigint-safe): every avatar must satisfy
 *     claw_tokens == genesis + ledger EXACTLY; any mismatch prints and the
 *     script EXITS NONZERO (a global aggregate could hide offsetting errors).
 *
 * IDEMPOTENT: dedupe key `avatar:<id>:genesis`. Uses `recordCovenantAction`
 * itself so payload hashing is byte-identical to production (a hand-rolled
 * SQL hash that drifted would HALT the fail-closed sealer).
 *
 * Usage (explicit URL — never auto-loaded from .env.local):
 *   DATABASE_URL=<url> bun apps/api/scripts/covenant/backfill-genesis.ts [--dry-run]
 */

import { db, covenantActionRecords, sql, eq } from '@clawville/database';
import { recordCovenantAction } from '../../src/services/covenant-action-recorder';

const dryRun = process.argv.includes('--dry-run');
const cohortCutoff = new Date().toISOString();

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
  WHERE a.created_at < ${cohortCutoff}::timestamptz
    AND NOT EXISTS (
      SELECT 1 FROM covenant_action_records r
      WHERE r.dedupe_key = 'avatar:' || a.id || ':genesis'
    )
  ORDER BY a.created_at ASC
`);

console.log(
  `cohort (created < ${cohortCutoff}) missing a genesis record: ${rows.length}${dryRun ? ' (dry-run)' : ''}`,
);

let written = 0;
let deduped = 0;
let raceSkipped = 0;
const failures: Array<{ avatarId: string; error: string }> = [];

for (const row of rows) {
  const amount = Number(row.claw_tokens) - Number(row.ledger_sum ?? 0);
  if (dryRun) {
    console.log(`  would record ${row.id}: amount=${amount}`);
    continue;
  }
  try {
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
  } catch (err) {
    // A creation-time recorder may have won the dedupe race mid-run with a
    // DIFFERENT payload (reason avatar_genesis) — ANY existing record under
    // this key is authoritative; that avatar no longer needs a backfill.
    const [existing] = await db
      .select({ id: covenantActionRecords.id })
      .from(covenantActionRecords)
      .where(eq(covenantActionRecords.dedupeKey, `avatar:${row.id}:genesis`))
      .limit(1);
    if (existing) {
      raceSkipped += 1;
    } else {
      failures.push({ avatarId: row.id, error: String(err) });
    }
  }
}

if (dryRun) process.exit(0);

console.log(`written=${written} deduped=${deduped} raceSkipped=${raceSkipped} failures=${failures.length}`);
for (const f of failures.slice(0, 10)) console.error(`  FAILED ${f.avatarId}: ${f.error}`);

// PER-AVATAR reconciliation (bigint arithmetic in SQL — never JS floats):
// every avatar must be exactly explained by genesis + ledger.
const mismatches = await db.execute<{ id: string; unexplained: string }>(sql`
  SELECT a.id,
         (a.claw_tokens::bigint
          - COALESCE((SELECT SUM(t.amount)::bigint FROM claw_token_transactions t
                      WHERE t.avatar_id = a.id), 0)
          - COALESCE((SELECT SUM((r.payload->>'amount')::bigint)
                      FROM covenant_action_records r
                      WHERE r.action = 'economy.genesis'
                        AND r.subject_id = a.id::text), 0)) AS unexplained
  FROM avatars a
  WHERE a.created_at < ${cohortCutoff}::timestamptz
`);
const bad = mismatches.filter((m) => BigInt(m.unexplained) !== 0n);
console.log(`per-avatar reconciliation: ${mismatches.length} checked, ${bad.length} mismatched`);
for (const m of bad.slice(0, 10)) console.error(`  MISMATCH ${m.id}: unexplained=${m.unexplained}`);

if (failures.length > 0 || bad.length > 0) {
  console.error('BACKFILL FAILED — do not enable the partner read surface until resolved.');
  process.exit(1);
}
console.log('BACKFILL OK — every cohort avatar exactly explained by genesis + ledger.');
process.exit(0);
