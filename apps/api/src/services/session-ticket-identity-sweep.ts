/**
 * Automatic post-flip re-run of migration 0073 (connect-sec round 4, Codex C4,
 * 2026-10-01).
 *
 * WHY: the CI `migrate` job applies
 * `packages/database/migrations/0073_session_ticket_identity_hash.sql` BEFORE
 * the code flip. Until the old API container stops, it can still write a RAW
 * `agent_session_tickets.identity_key` (an account credential). This module
 * runs the same UPDATE once at API boot and once 15 minutes later. The second
 * run covers a graceful-flip overlap with an old container that is still
 * serving after the new one booted.
 *
 * RULES:
 * - SQL: the 0073 UPDATE statement, character for character. A unit test
 *   compares this constant with the migration file. The digest form is
 *   'sha256:' + lowercase hex sha256(identity_type || ':' || identity_key) in
 *   UTF-8, the form of `ticketIdentityKeyDigest` (session-ticket-service.ts).
 *   The opt-in PostgreSQL test `session-ticket-identity-hash.db.test.ts` proves
 *   that the SQL and the app digest match byte for byte.
 * - Idempotent: rows already in the 'sha256:<64 hex>' shape are skipped, so a
 *   re-run changes 0 rows.
 * - Pool: ONE autocommit statement on the shared `db` client, with no
 *   transaction, so the run holds a pool connection only for that statement.
 * - Fail-soft: an error is logged and never thrown into the boot path. The
 *   next run, or a manual re-run of the 0073 UPDATE, covers the gap.
 */

import { db, sql } from '@clawville/database';

/** The 0073 UPDATE statement, unchanged (the test compares it with the file). */
export const SESSION_TICKET_IDENTITY_SWEEP_SQL = `UPDATE "agent_session_tickets"
SET "identity_key" = 'sha256:' || encode(sha256(convert_to("identity_type" || ':' || "identity_key", 'UTF8')), 'hex')
WHERE "identity_key" IS NOT NULL
  AND "identity_key" !~ '^sha256:[0-9a-f]{64}$';`;

/** Delay of the second run after boot (graceful-flip overlap). */
export const SESSION_TICKET_IDENTITY_SWEEP_DELAY_MS = 15 * 60 * 1000;

/** Narrow seams keep the run unit-testable without PostgreSQL or real timers. */
export const sessionTicketIdentitySweepSeams = {
  /** Run one statement on the shared pool; resolve to the changed row count. */
  execute: async (statement: string): Promise<number> => {
    const result = await db.execute(sql.raw(statement));
    const metadata = result as unknown as { count?: number; rowCount?: number };
    return metadata.count ?? metadata.rowCount ?? 0;
  },
  /** One-shot timer. Unref'd, so it never keeps a stopping process alive. */
  schedule: (run: () => void, delayMs: number): void => {
    const timer = setTimeout(run, delayMs);
    (timer as { unref?: () => void }).unref?.();
  },
};

/**
 * Run the 0073 UPDATE once. Resolves to the number of rows it hashed, or null
 * when the statement failed. Never throws.
 */
export async function runSessionTicketIdentitySweep(label: string): Promise<number | null> {
  const startedAt = Date.now();
  try {
    const hashed = await sessionTicketIdentitySweepSeams.execute(SESSION_TICKET_IDENTITY_SWEEP_SQL);
    console.log(
      `[SessionTicketIdentitySweep] ${label}: hashed ${hashed} raw agent_session_tickets.identity_key row(s) (0073 re-run, ${Date.now() - startedAt}ms)`,
    );
    return hashed;
  } catch (err) {
    // Message only: the statement has no parameters, and a full error object
    // can be large. The run never throws into the caller.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[SessionTicketIdentitySweep] ${label}: 0073 re-run failed (non-fatal; if the 15-minute run also fails, re-run the 0073 UPDATE by hand): ${message}`,
    );
    return null;
  }
}

let started = false;

/**
 * Start the two runs: one now (the boot IIFE calls this after the database is
 * reachable), one SESSION_TICKET_IDENTITY_SWEEP_DELAY_MS later. Idempotent.
 */
export function startSessionTicketIdentitySweep(): void {
  if (started) return;
  started = true;
  void runSessionTicketIdentitySweep('boot run');
  sessionTicketIdentitySweepSeams.schedule(() => {
    void runSessionTicketIdentitySweep('15-minute run');
  }, SESSION_TICKET_IDENTITY_SWEEP_DELAY_MS);
}

/** Test seam: allow `startSessionTicketIdentitySweep` to start again. */
export function __resetSessionTicketIdentitySweepForTests(): void {
  started = false;
}
