/**
 * scripts/casino/backfill-slot-history.ts — Phase 6.7.0 one-shot backfill.
 *
 * Projects every existing `slot_spins` row into the unified
 * `cove_game_events` table so /cove/history can render historical slot
 * spins at launch (instead of "no events yet" until a fresh spin lands).
 *
 * Idempotent: relies on the unique key (game_type, session_id, nonce)
 * via `ON CONFLICT DO NOTHING`. Safe to re-run after a partial run.
 *
 * Per plan §0 decision 2 + §9 risk register:
 *   - serverSeedHash, clientSeed, nonce are sourced from the parent
 *     slot_sessions row (the commit-reveal pair lives at session-scope).
 *   - revealedServerSeed is populated for slot_sessions whose status is
 *     'closed' OR 'expired' — both states mean the session is no longer
 *     active, so the seed is safe to reveal. Open-session spins land
 *     with NULL revealed seed, respecting the "no pre-reveal exposure"
 *     invariant (plan §0 decision 3). They become verifiable when their
 *     parent session closes — the live close-handler in cove-slots.ts
 *     (~line 1245) runs the back-fill UPDATE in the same transaction
 *     that flips slot_sessions.status to 'closed', covering every
 *     coveGameEvents row for the session in one shot.
 *   - engineVersion is `slot-engine-${slot_spins.paytable_version}`
 *     (e.g. `slot-engine-v2`) — matches the live-writer convention in
 *     cove-slots.ts POST /spin so backfilled rows and freshly-written
 *     rows land in the same engineVersion bucket. The verifier loads
 *     the correct payout table from this string. Rows missing
 *     paytable_version fall back to `slot-engine-v1`.
 *   - outcomeJson captures the discriminated-union 'slots' payload —
 *     reels, winningLines, wildMultipliers, scatterPayout, predict,
 *     winAmount, isFreeSpin — everything the verifier needs alongside
 *     the commit-reveal triple to byte-replay the spin.
 *
 * Run AFTER `bun run db:push` (or the manual SQL fallback in
 * packages/database/migrations-manual/2026-05-27_add_cove_game_events.sql)
 * has created `cove_game_events`.
 *
 *   cd packages/database && bun run build   # only if running outside the api container
 *   bun run scripts/casino/backfill-slot-history.ts
 *
 * Output:
 *   - progress every 500 rows
 *   - final summary: { scanned, inserted, skipped }
 */

import { db, slotSpins, slotSessions, sql } from '@clawville/database';

interface SlotJoinRow {
  spinId: string;
  userId: string;
  sessionId: string;
  nonce: number;
  predict: string;
  winAmount: string;
  reels: unknown;
  winningLines: unknown;
  wildMultipliers: unknown;
  scatterPayout: string;
  isFreeSpin: boolean;
  cursorBefore: number;
  cursorAfter: number;
  paytableVersion: string;
  paytableId: string;
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  sessionStatus: string;
  createdAt: Date;
}

interface OutcomeJsonSlots {
  kind: 'slots';
  paytableId: string;
  predict: string;
  winAmount: string;
  isFreeSpin: boolean;
  reels: unknown;
  winningLines: unknown;
  wildMultipliers: unknown;
  scatterPayout: string;
  cursorBefore: number;
  cursorAfter: number;
  /**
   * Required by the UI verifier's `isSlotsOutcome` type guard
   * (apps/web/src/components/cove/history/SlotsEventVerifier.tsx) and by
   * `replaySpin` (apps/web/src/lib/cove/verifier.ts). Duplicates the
   * top-level `cove_game_events.nonce` column on purpose — the
   * outcomeJson payload must be self-contained for the per-event
   * verifier to replay without re-fetching the row.
   */
  nonce: number;
  /**
   * Pins the payout table the verifier loads — pre-retune rows need
   * 'v1' so the browser doesn't silently mis-verify against the
   * current 'v2' payouts. Mirrors `slot_spins.paytable_version`.
   */
  paytableVersion: string;
}

const BATCH_SIZE = 500;

async function main() {
  console.log('[backfill-slot-history] scanning slot_spins…');

  // Drizzle's typed select doesn't easily project joined sub-fields with
  // mixed bigint/number columns; raw SQL is clearer here and matches the
  // shape we care about exactly. `db.execute(sql\`…\`)` returns
  // postgres.js's row array directly.
  const rows = (await db.execute(sql`
    SELECT
      sp.id              AS spin_id,
      ss.user_id         AS user_id,
      sp.session_id      AS session_id,
      sp.nonce           AS nonce,
      sp.predict         AS predict,
      sp.win_amount      AS win_amount,
      sp.reels           AS reels,
      sp.winning_lines   AS winning_lines,
      sp.wild_multipliers AS wild_multipliers,
      sp.scatter_payout  AS scatter_payout,
      sp.is_free_spin    AS is_free_spin,
      sp.cursor_before   AS cursor_before,
      sp.cursor_after    AS cursor_after,
      sp.paytable_version AS paytable_version,
      ss.paytable_id     AS paytable_id,
      ss.server_seed     AS server_seed,
      ss.server_seed_hash AS server_seed_hash,
      ss.client_seed     AS client_seed,
      ss.status          AS session_status,
      sp.created_at      AS created_at
    FROM slot_spins sp
    JOIN slot_sessions ss ON ss.id = sp.session_id
    ORDER BY sp.created_at ASC
  `)) as unknown as Array<{
    spin_id: string;
    user_id: string;
    session_id: string;
    nonce: string | number;
    predict: string;
    win_amount: string;
    reels: unknown;
    winning_lines: unknown;
    wild_multipliers: unknown;
    scatter_payout: string;
    is_free_spin: boolean;
    cursor_before: string | number;
    cursor_after: string | number;
    paytable_version: string;
    paytable_id: string;
    server_seed: string;
    server_seed_hash: string;
    client_seed: string;
    session_status: string;
    created_at: Date;
  }>;

  console.log(`[backfill-slot-history] found ${rows.length} slot_spins to project.`);

  let inserted = 0;
  let skipped = 0;
  let batchStart = 0;

  while (batchStart < rows.length) {
    const batch = rows.slice(batchStart, batchStart + BATCH_SIZE);
    batchStart += BATCH_SIZE;

    // Build a multi-row INSERT with ON CONFLICT DO NOTHING. Using raw
    // SQL with sql.json() for the outcomeJson keeps Drizzle's JSONB
    // serializer in the loop without surprising us with double-encoding.
    for (const row of batch) {
      const outcomeJson: OutcomeJsonSlots = {
        kind: 'slots',
        paytableId: row.paytable_id,
        predict: row.predict,
        winAmount: row.win_amount,
        isFreeSpin: row.is_free_spin,
        reels: row.reels,
        winningLines: row.winning_lines,
        wildMultipliers: row.wild_multipliers,
        scatterPayout: row.scatter_payout,
        cursorBefore: Number(row.cursor_before),
        cursorAfter: Number(row.cursor_after),
        nonce: Number(row.nonce),
        paytableVersion: row.paytable_version,
      };

      // revealedServerSeed only when parent session is no longer
      // active. 'closed' = explicit cash-out (live close-handler at
      // cove-slots.ts:1245 back-fills the same column on every event
      // row in the status-flip txn). 'expired' = TTL'd session, also
      // no longer active so seed is safe to reveal. Open sessions stay
      // pre-reveal — verifier UI shows the locked hash badge per plan
      // §0 decision 3.
      const revealedServerSeed =
        row.session_status === 'closed' || row.session_status === 'expired'
          ? row.server_seed
          : null;

      // ON CONFLICT (game_type, session_id, nonce) DO NOTHING — re-runs
      // are no-ops on already-projected rows. The unique index on those
      // three columns is created by the schema migration.
      const result = await db.execute(sql`
        INSERT INTO cove_game_events (
          user_id, game_type, session_id, shoe_id,
          bet_amount, payout, outcome_json,
          server_seed_hash, revealed_server_seed, client_seed, nonce,
          tx_signature, engine_version, created_at
        ) VALUES (
          ${row.user_id}, 'slots', ${row.session_id}, ${row.session_id},
          ${row.predict}, ${row.win_amount}, ${JSON.stringify(outcomeJson)}::jsonb,
          ${row.server_seed_hash}, ${revealedServerSeed}, ${row.client_seed}, ${Number(row.nonce)},
          NULL, ${`slot-engine-${row.paytable_version || 'v1'}`}, ${row.created_at.toISOString()}
        )
        ON CONFLICT (game_type, session_id, nonce) DO NOTHING
        RETURNING id
      `);

      const inserts = result as unknown as Array<{ id: string }>;
      if (inserts.length > 0) {
        inserted += 1;
      } else {
        skipped += 1;
      }
    }

    console.log(
      `[backfill-slot-history] processed ${Math.min(batchStart, rows.length)}/${rows.length} (inserted=${inserted}, skipped=${skipped})`,
    );
  }

  console.log(
    `[backfill-slot-history] done. scanned=${rows.length}, inserted=${inserted}, skipped=${skipped}`,
  );
  console.log(
    '[backfill-slot-history] NOTE: spins from currently-OPEN slot_sessions were inserted with revealed_server_seed=NULL — they become verifiable when their parent session closes. The close-handler in apps/api/src/routes/cove-slots.ts (~line 1245) already runs the back-fill UPDATE inside the same transaction that flips slot_sessions.status to closed, so no follow-up action is required for the close path.',
  );
  console.log(
    "[backfill-slot-history] FUTURE-WRITER WARNING: this script back-fills revealed_server_seed for slot_sessions where status IN ('closed','expired'). There is currently NO live writer that transitions a session to 'expired' — when an expiry-sweeper ships (Phase 6.1.X+), it MUST also run the same `UPDATE cove_game_events SET revealed_server_seed = ? WHERE session_id = ? AND game_type = 'slots'` in the same transaction that flips slot_sessions.status to 'expired'. Mirror the close handler at cove-slots.ts:1245 exactly. Without this update, expired sessions created post-backfill will leave their event rows permanently unverifiable, breaking the provably-fair guarantee.",
  );

  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill-slot-history] failed:', err);
  process.exit(1);
});
