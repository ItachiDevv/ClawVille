/**
 * Verification script for the agent.connected session-farm fix (2026-06-03).
 *
 * Proves FIX A (leaderboard-side per-day distinct-session cap, the authoritative
 * backstop) does the right arithmetic, and that the MODIFIED buildAgentSnapshot
 * query still parses + runs on the real DB after the agent_sessions /
 * avatar_sessions CTEs were removed.
 *
 * What it does:
 *   1. A-cap arithmetic (synthetic, DB-parsed): runs a SELF-CONTAINED query
 *      against the real Postgres using a VALUES list as a fake events source —
 *      it does NOT read the real `events` table and does NOT write anything. It
 *      reproduces the exact agent_daily sessions_c (LEAST(COUNT(DISTINCT
 *      session_id) FILTER (WHERE event_type='agent.connected'), cap)) + the
 *      SUM(sessions_c) roll-up and asserts:
 *        (i)   15 connects day1 + 10 connects day2 (25 distinct sessions) => 20
 *              (per-day capped at 10, summed: 10 + 10), NOT 25 and NOT 10.
 *        (ii)  3 connects on one day => 3 (under cap, unchanged behavior).
 *        (iii) a single session_id with one connect row => exactly 1
 *              (midnight-safe sanity for the POINT event).
 *   2. Regression (real query, READ-ONLY): calls the ACTUAL modified
 *      buildAgentSnapshot('24h', ...) against the real DB and confirms it runs
 *      with no SQL error and returns well-formed rows (sessions present + int).
 *      This proves the CTE still parses + runs after the session-CTE removal.
 *      SELECT-only — no writes.
 *
 * Run:  bun run scripts/leaderboard/verify-session-cap.ts   (from apps/api)
 * Exit: 0 on all-pass, 1 on any FAIL.
 *
 * SAFETY: the synthetic query uses an inline VALUES table (never `FROM events`).
 * The regression calls buildAgentSnapshot which is read-only (CTE + SELECT). No
 * INSERT/UPDATE/DELETE is issued by this script. `bun run dev` is never invoked.
 */

import { sql } from 'drizzle-orm';
import { db } from '@clawville/database';
import { buildAgentSnapshot } from '../../src/routes/leaderboard';

// The cap under test — mirrors DAILY_CAPS.session in leaderboard.ts.
const SESSION_CAP = 10;

interface Assertion {
  name: string;
  pass: boolean;
  detail: string;
}
const results: Assertion[] = [];
function assert(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
}

async function main() {
  console.log('=== Leaderboard session-cap verification (Fix A) ===');
  console.log('');

  // ---------------------------------------------------------------------------
  // 1. A-cap arithmetic — synthetic VALUES source, DB-parsed.
  //
  // Fake events: three subjects.
  //   agent-A : 15 connects on day1 + 10 connects on day2 (25 distinct sessions)
  //   agent-B : 3 connects on a single day
  //   agent-C : 1 connect, single session_id (midnight-safe sanity)
  // Each row is (subject, event_type, session_id, day). We reproduce the EXACT
  // agent_daily.sessions_c expression then SUM across days per subject.
  // ---------------------------------------------------------------------------
  console.log('1. A-cap arithmetic (synthetic VALUES, no real table read, no writes)');

  // Build the VALUES list programmatically so the counts are unambiguous.
  type FakeRow = { subj: string; sid: string; day: string };
  const fake: FakeRow[] = [];
  for (let i = 0; i < 15; i++) fake.push({ subj: 'agent-A', sid: `A-d1-${i}`, day: '2026-06-01' });
  for (let i = 0; i < 10; i++) fake.push({ subj: 'agent-A', sid: `A-d2-${i}`, day: '2026-06-02' });
  for (let i = 0; i < 3; i++) fake.push({ subj: 'agent-B', sid: `B-d1-${i}`, day: '2026-06-01' });
  fake.push({ subj: 'agent-C', sid: 'C-d1-0', day: '2026-06-01' });

  // Compose the VALUES fragment with bound parameters (no injection surface).
  const valuesFrag = sql.join(
    fake.map(
      (r) => sql`(${r.subj}, 'agent.connected', ${r.sid}, ${r.day}::date)`,
    ),
    sql`, `,
  );

  const rows = await db.execute<{ subject_id: string; sessions: number }>(sql`
    WITH fake_events(subject_id, event_type, session_id, day) AS (
      VALUES ${valuesFrag}
    ),
    -- EXACT replica of agent_daily.sessions_c (per-(subject, day) capped).
    daily AS (
      SELECT
        subject_id,
        day,
        LEAST(
          COUNT(DISTINCT session_id) FILTER (WHERE event_type = 'agent.connected'),
          ${SESSION_CAP}
        )::int AS sessions_c
      FROM fake_events
      GROUP BY subject_id, day
    )
    -- EXACT replica of the agent_scores roll-up: SUM(sessions_c) across days.
    SELECT subject_id, SUM(sessions_c)::int AS sessions
    FROM daily
    GROUP BY subject_id
    ORDER BY subject_id
  `);

  const bySubject = new Map<string, number>();
  for (const r of rows) bySubject.set(r.subject_id, Number(r.sessions));

  const a = bySubject.get('agent-A');
  const b = bySubject.get('agent-B');
  const cc = bySubject.get('agent-C');

  assert(
    'A(i) 15 connects day1 + 10 connects day2 (25 distinct) => 20 (per-day capped at 10, summed)',
    a === 20,
    `got sessions=${a} (expect 20; NOT 25 uncapped, NOT 10 single-day)`,
  );
  assert(
    'A(ii) 3 connects one day => 3 (under cap, unchanged)',
    b === 3,
    `got sessions=${b} (expect 3)`,
  );
  assert(
    'A(iii) single session_id, one connect row => exactly 1 (midnight-safe sanity)',
    cc === 1,
    `got sessions=${cc} (expect 1)`,
  );

  console.log('');

  // ---------------------------------------------------------------------------
  // 2. Regression — the ACTUAL modified buildAgentSnapshot, real DB, READ-ONLY.
  //    Proves the CTE still parses + runs after removing agent_sessions /
  //    avatar_sessions, and that the `sessions` column is present + integer.
  // ---------------------------------------------------------------------------
  console.log('2. Regression — modified buildAgentSnapshot(\'24h\') on real DB (READ-ONLY)');
  let snapshotOk = false;
  let regDetail = '';
  try {
    const snap = await buildAgentSnapshot('24h', 100);
    const wellFormed =
      snap != null &&
      typeof snap.totalRanked === 'number' &&
      Array.isArray(snap.agents) &&
      // Every returned row must carry an integer `sessions` in its breakdown.
      snap.agents.every(
        (e) =>
          typeof e.breakdown.sessions === 'number' &&
          Number.isInteger(e.breakdown.sessions),
      );
    snapshotOk = wellFormed;
    regDetail = `executed OK; totalRanked=${snap.totalRanked}, rows=${snap.agents.length}, all sessions integer=${wellFormed}`;
  } catch (err) {
    snapshotOk = false;
    regDetail = `THREW: ${err instanceof Error ? err.message : String(err)}`;
  }
  assert(
    'Regression: modified buildAgentSnapshot runs read-only with no SQL error + well-formed rows',
    snapshotOk,
    regDetail,
  );

  // SUMMARY
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log('');
  console.log('========================================================');
  console.log(`SUMMARY: ${passed} PASS / ${failed} FAIL  (total ${results.length})`);
  console.log('========================================================');

  // Close the postgres-js connection so the process can exit cleanly.
  try {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  } catch {
    // best-effort — ignore close errors
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('VERIFY CRASHED:', err);
  process.exit(2);
});
