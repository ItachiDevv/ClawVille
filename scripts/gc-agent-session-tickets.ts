/**
 * Phase 5 — agent_session_tickets garbage collection.
 *
 * Deletes rows that expired more than 24 hours ago. The 1-day buffer
 * preserves recently-expired tickets for debugging (e.g. "why did my
 * link not work?" support requests) while keeping the table bounded.
 *
 * Run via cron hourly:
 *   0 * * * * cd /app && bun run scripts/gc-agent-session-tickets.ts
 *
 * Or on-demand for a one-shot cleanup:
 *   bun run scripts/gc-agent-session-tickets.ts
 *
 * Safe to run repeatedly — the DELETE is idempotent and cheap thanks
 * to the partial index on `(expires_at) WHERE consumed_at IS NULL`.
 * Consumed rows are also swept here because they serve no further
 * purpose once the Lucia session they minted has long since been
 * created (and its own row in `sessions` is what keeps the user logged
 * in, not this ticket row).
 */

import { db, agentSessionTickets, sql, lt } from '@clawville/database';

async function main() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const before = new Date();

  // Delete any ticket whose expires_at is more than 24h in the past.
  // This captures both unredeemed (idle leftovers) and consumed rows
  // (since `consumed_at IS NOT NULL` implies `expires_at` passed the
  // creation + TTL window days ago).
  const deleted = await db
    .delete(agentSessionTickets)
    .where(lt(agentSessionTickets.expiresAt, cutoff))
    .returning({ ticket: agentSessionTickets.ticket });

  const elapsedMs = Date.now() - before.getTime();
  console.log(
    `[gc-agent-session-tickets] Deleted ${deleted.length} row(s) older than ${cutoff.toISOString()} in ${elapsedMs}ms`,
  );

  // Close the postgres pool cleanly so the script exits instead of
  // hanging on the idle connection.
  try {
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  } catch {
    // best-effort — some drivers don't expose $client
  }
  // Use sql reference to keep the import load-bearing (drizzle-kit
  // tree-shakes unused imports in some setups).
  void sql;
}

main().catch((err) => {
  console.error('[gc-agent-session-tickets] fatal:', err);
  process.exit(1);
});
