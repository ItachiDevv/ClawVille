/**
 * One-off genesis backfill for avatars created BEFORE the covenant stream
 * shipped (2026-07-13).
 *
 * STREAM-OPENING SEMANTICS (Codex round 5 HIGH #1 — v2, supersedes the
 * ledger-derived v1): the stream must be SELF-CONTAINED — a consumer summing
 * genesis + streamed credits − streamed debits must reproduce the balance
 * exactly, without access to our internal pre-stream ledger. So a backfilled
 * avatar's genesis is its OPENING BALANCE at stream entry:
 *
 *   amount = claw_tokens − Σ(already-streamed economy.credit)
 *                        + Σ(already-streamed economy.debit)
 *
 * (the subtraction removes post-deploy actions that are ALREADY in the
 * stream, so deploy→backfill activity is never double-counted). Pre-stream
 * ledger history stays queryable internally but is deliberately NOT
 * streamed — the stream opens here. Labeled `avatar_opening_balance`.
 * Creation-time genesis for NEW avatars has identical semantics (opening
 * balance == the initial grant).
 *
 * GUESTS EXCLUDED (Codex round 5 HIGH #2): guest CT is off-ledger demo money
 * whose later mutations produce no stream records — a guest anchor would
 * inflate real supply and immediately diverge. Canonical flag: users.is_guest.
 *
 * RACE-SAFE FOR LIVE PROMOTION (Codex round 4 HIGH #4): fixed cohort
 * (created_at < script start); per-avatar dedupe-race tolerance (the
 * creation-time record is authoritative); PER-AVATAR bigint reconciliation
 * over STREAM RECORDS ONLY; exits nonzero on any failure/mismatch.
 *
 * IDEMPOTENT: dedupe key `avatar:<id>:genesis`. Uses `recordCovenantAction`
 * itself so payload hashing is byte-identical to production.
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
  streamed_net: string | number | null;
};

// Signed net of the avatar's ALREADY-STREAMED economy records (credits minus
// debits) — genesis must exclude what the stream already explains.
const STREAMED_NET_SQL = sql`
  (SELECT COALESCE(SUM(CASE
      WHEN r.action = 'economy.credit' THEN (r.payload->>'amount')::bigint
      WHEN r.action = 'economy.debit' THEN -((r.payload->>'amount')::bigint)
      ELSE 0 END), 0)
   FROM covenant_action_records r
   WHERE r.subject_id = a.id::text
     AND r.action IN ('economy.credit', 'economy.debit'))`;

const rows = await db.execute<Row>(sql`
  SELECT a.id, a.claw_tokens, ${STREAMED_NET_SQL} AS streamed_net
  FROM avatars a
  JOIN users u ON u.id = a.user_id
  WHERE a.created_at < ${cohortCutoff}::timestamptz
    AND NOT u.is_guest
    AND NOT EXISTS (
      SELECT 1 FROM covenant_action_records r
      WHERE r.dedupe_key = 'avatar:' || a.id || ':genesis'
    )
  ORDER BY a.created_at ASC
`);

console.log(
  `non-guest cohort (created < ${cohortCutoff}) missing a genesis record: ${rows.length}${dryRun ? ' (dry-run)' : ''}`,
);

let written = 0;
let deduped = 0;
let raceSkipped = 0;
const failures: Array<{ avatarId: string; error: string }> = [];

for (const row of rows) {
  const amount = Number(row.claw_tokens) - Number(row.streamed_net ?? 0);
  if (dryRun) {
    console.log(`  would record ${row.id}: openingBalance=${amount}`);
    continue;
  }
  try {
    const res = await recordCovenantAction({
      action: 'economy.genesis',
      subjectType: 'avatar',
      subjectId: row.id,
      actorKind: 'system',
      dedupeKey: `avatar:${row.id}:genesis`,
      payload: { amount, provenance: 'soft', reason: 'avatar_opening_balance' },
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

// PER-AVATAR reconciliation over STREAM RECORDS ONLY (the partner's view):
// genesis + streamed credits − streamed debits must equal the live balance
// exactly, for every non-guest cohort avatar. Bigint SQL — never JS floats.
const mismatches = await db.execute<{ id: string; unexplained: string }>(sql`
  SELECT a.id,
         (a.claw_tokens::bigint
          - COALESCE((SELECT SUM(CASE
                WHEN r.action IN ('economy.genesis', 'economy.credit')
                  THEN (r.payload->>'amount')::bigint
                WHEN r.action = 'economy.debit'
                  THEN -((r.payload->>'amount')::bigint)
                ELSE 0 END)
              FROM covenant_action_records r
              WHERE r.subject_id = a.id::text
                AND r.action IN ('economy.genesis', 'economy.credit', 'economy.debit')), 0)
         ) AS unexplained
  FROM avatars a
  JOIN users u ON u.id = a.user_id
  WHERE a.created_at < ${cohortCutoff}::timestamptz
    AND NOT u.is_guest
`);
const bad = mismatches.filter((m) => BigInt(m.unexplained) !== 0n);
console.log(`per-avatar STREAM reconciliation: ${mismatches.length} checked, ${bad.length} mismatched`);
for (const m of bad.slice(0, 10)) console.error(`  MISMATCH ${m.id}: unexplained=${m.unexplained}`);

if (failures.length > 0 || bad.length > 0) {
  console.error('BACKFILL FAILED — do not enable the partner read surface until resolved.');
  process.exit(1);
}
console.log('BACKFILL OK — every non-guest cohort avatar exactly explained by the STREAM alone.');
process.exit(0);
