/**
 * Background runner for long Studios jobs (MCP hub phase 3b): a video (the
 * vendor holds the call open up to 5 minutes) and a recast (start, then poll
 * every 15 s up to a 30-minute deadline). It runs inside the API process, so
 * no HTTP request waits: the route answers 202 `{ status: 'running', requestId }`
 * and the agent reads GET /api/vendors/studios/requests/:id.
 *
 * Lease: a running row carries `lease_until`; the job renews it every 30 s.
 * Every minute a recovery pass claims rows whose runner is gone (a 'running'
 * row with an expired lease after an API restart or a crash, or a one-call
 * 'pending' row older than 15 minutes) with FOR UPDATE SKIP LOCKED, so two API
 * processes never take the same row. Recovery never calls or pays again
 * (`recoverUnfinishedRequest`): a key-mode recast with a stored job id resumes
 * polling; a signed wallet payment becomes 'ambiguous' for the reconcile path.
 *
 * When a hosted agent's job ends, its next decide gets one short line.
 */

import { and, avatars, db, eq, sql, vendorCallRequests } from '@clawville/database';
import type { StudiosOperationId } from '@clawville/shared';
import {
  JOB_LEASE_MS,
  executeLongJob,
  recoverUnfinishedRequest,
  studiosRefusalFor,
  type StudiosOperationResult,
} from './studios-images';

const LEASE_RENEW_MS = 30_000;
const RECOVERY_INTERVAL_MS = 60_000;
const STALE_PENDING_MINUTES = 15;
const RECOVERY_BATCH = 20;

const active = new Map<string, Promise<void>>();

/** Test-only: the jobs this process runs now. */
export function activeStudiosJobs(): ReadonlyMap<string, Promise<void>> {
  return active;
}

/** Renew the lease while this owner still holds the row. False = taken over or finished. */
export async function renewLease(requestId: string, owner: string): Promise<boolean> {
  const renewed = await db.update(vendorCallRequests)
    .set({ leaseUntil: sql`now() + ${`${Math.round(JOB_LEASE_MS / 1000)} seconds`}::interval` })
    .where(and(
      eq(vendorCallRequests.id, requestId),
      eq(vendorCallRequests.leaseOwner, owner),
      eq(vendorCallRequests.status, 'running'),
    ))
    .returning({ id: vendorCallRequests.id });
  return renewed.length > 0;
}

/**
 * Tell a hosted agent how its job ended (one line in its next decide). Best
 * effort: the agent can also read the request route.
 */
async function notifyHosted(requestId: string, leaseOwner: string, result: StudiosOperationResult | null): Promise<void> {
  try {
    const [row] = await db.select({
      leaseOwner: vendorCallRequests.leaseOwner,
      surface: vendorCallRequests.surface,
      avatarId: vendorCallRequests.avatarId,
      operation: vendorCallRequests.operation,
      status: vendorCallRequests.status,
      failureCode: vendorCallRequests.failureCode,
    }).from(vendorCallRequests).where(eq(vendorCallRequests.id, requestId)).limit(1);
    // A runner that lost the row says nothing; the new holder reports the end.
    if (!row || row.surface !== 'hosted' || row.leaseOwner !== leaseOwner) return;
    const owner = await db.query.avatars.findFirst({ where: eq(avatars.id, row.avatarId), columns: { userId: true } });
    if (!owner?.userId) return;
    const { formatStudiosJobLine } = await import('./npc-simulation');
    const operation = row.operation as StudiosOperationId;
    // A recovered row has no in-memory result: rebuild our own refusal (with
    // its "do not retry" text) from the stored code.
    const code = row.failureCode ?? 'outcome_unknown';
    const line = formatStudiosJobLine(operation, result ?? studiosRefusalFor(code, operation) ?? { ok: false, code });
    const { agentAutonomyDriver } = await import('./agent-autonomy-driver');
    const agentId = agentAutonomyDriver.getEnrolledAgentForOwner(owner.userId);
    if (agentId) agentAutonomyDriver.rememberActionResult(agentId, row.avatarId, line);
  } catch {
    // The row holds the result; only the note to the agent is lost.
  }
}

/**
 * Run one 'running' row in the background with a renewed lease, as the
 * holder of `owner` (the row's `lease_owner`). `key` is the key the request
 * was made or approved with (undefined = load it again; it must still be the
 * key the row was made with). Every write matches the owner token, so after a
 * takeover this runner stores nothing. Every exit settles the row it still
 * holds: an unexpected error goes through recovery (never a second call or
 * payment).
 */
export function startStudiosJob(requestId: string, owner: string, key?: string | null): void {
  if (active.has(requestId)) return;
  const run = (async () => {
    const heartbeat = setInterval(() => {
      void renewLease(requestId, owner).then((held) => {
        if (!held) clearInterval(heartbeat);
      }).catch(() => undefined);
    }, LEASE_RENEW_MS);
    heartbeat.unref?.();
    let result: StudiosOperationResult | null = null;
    try {
      result = await executeLongJob(requestId, owner, key);
    } catch (err) {
      console.error(`[studios-job-runner] job ${requestId} failed:`, err instanceof Error ? err.message : 'unknown');
      await recoverUnfinishedRequest(requestId, owner, { resumeRecast: false }).catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
      active.delete(requestId);
    }
    await notifyHosted(requestId, owner, result);
  })();
  active.set(requestId, run);
}

/**
 * Claim the rows whose runner is gone and settle or resume them. Returns the
 * ids it claimed (for tests and logs).
 */
export async function recoverStudiosJobs(): Promise<string[]> {
  // Each claim gets a new owner token: the old runner, if it still lives,
  // can no longer renew, store or finish the row.
  const claimed = Array.from(await db.execute<{ id: string; lease_owner: string }>(sql`
    UPDATE vendor_call_requests
    SET lease_until = now() + ${`${Math.round(JOB_LEASE_MS / 1000)} seconds`}::interval,
        lease_owner = gen_random_uuid()::text
    WHERE id IN (
      SELECT id FROM vendor_call_requests
      WHERE (status = 'running' AND (lease_until IS NULL OR lease_until < now()))
         OR (status = 'pending' AND updated_at < now() - make_interval(mins => ${STALE_PENDING_MINUTES}))
      ORDER BY created_at
      LIMIT ${RECOVERY_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, lease_owner`));
  for (const { id, lease_owner: owner } of claimed) {
    // A job of this process whose lease ran out has lost it now: its writes no
    // longer match. The recovery below settles the row under the new token.
    try {
      const outcome = await recoverUnfinishedRequest(id, owner, { resumeRecast: true });
      if (outcome === 'resume') {
        if (!active.has(id)) startStudiosJob(id, owner);
        continue;
      }
      if (outcome !== 'skipped') await notifyHosted(id, owner, null);
    } catch (err) {
      console.error(`[studios-job-runner] recovery of ${id} failed:`, err instanceof Error ? err.message : 'unknown');
    }
  }
  if (claimed.length) console.log(`[studios-job-runner] recovered ${claimed.length} unfinished request(s)`);
  return claimed.map((r) => r.id);
}

let worker: ReturnType<typeof setInterval> | null = null;

/** Every minute, recover unfinished Studios requests (also the ones left by a restart). */
export function startStudiosJobRunner(intervalMs = RECOVERY_INTERVAL_MS): void {
  if (worker) return;
  const run = () => {
    void recoverStudiosJobs().catch((err) => console.error('[studios-job-runner] pass failed:', err instanceof Error ? err.message : 'unknown'));
  };
  worker = setInterval(run, intervalMs);
  worker.unref?.();
  console.log(`[studios-job-runner] worker started - every ${Math.round(intervalMs / 1000)}s`);
}

export function stopStudiosJobRunner(): void {
  if (worker) clearInterval(worker);
  worker = null;
}
