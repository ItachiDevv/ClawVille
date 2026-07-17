/**
 * Durable-autonomy RECONCILE (§B.1, 2026-07-08) — server-side re-enrollment.
 *
 * THE HOLE THIS CLOSES: a browser-closed persisting Autonomous agent (D6, 24h
 * TTL) was re-enrolled into the autonomy driver ONLY by the CLIENT keepalive
 * after an API restart. No browser → no keepalive → every production deploy
 * silently killed away-users' agents until they returned. Deploys must be
 * invisible to running agents.
 *
 * THE FIX: `activateAutonomyForOwner` persists a durable `autonomy_enrolled`
 * flag on the hosted-avatar session row (cleared on every teardown — explicit
 * deactivate, the logout route, and the 24h TTL sweep). This module reconciles
 * that persisted intent against the in-memory driver registry: on driver start
 * AND on a low-frequency periodic tick (so it also heals a crash mid-teardown),
 * it re-enrolls every session that is flag=true AND has a LIVE TTL but is not
 * currently driven — by calling the SAME idempotent `activateAutonomyForOwner`
 * the client toggle uses (re-mints the §B.2 session, respells the deterministic
 * `ocb-` body, enrolls). NO client involvement.
 *
 * WHY THIS CANNOT REPRODUCE THE OLD BOOT-REHYDRATE DOUBLE-BODY / OVERRIDE-LOCKOUT:
 *   - It re-enrolls ONLY hosted-avatar (milady identity, self-managed, AVATAR-mode)
 *     §B.2 sessions — never override-mode bodies, never the partner/Hatcher path.
 *   - The body id is the DETERMINISTIC `ocb-<base64url(agentId)>`; re-registering
 *     it is idempotent (same id, overwrites in place) — it cannot spawn a second
 *     copy. (The old rehydrate rebuilt arbitrary bodies incl. override, which
 *     could collide + lock out.)
 *   - `activateAutonomyForOwner` runs `releaseHumanControlledOpenClaw`, so a
 *     re-enrolled body is never left frozen by a stale suppression window.
 *   - The human-present case is arbitrated: an owner CURRENTLY human-driving
 *     (a live suppression window) is SKIPPED — their in-world body is the
 *     suppressed proxy, and their next Autonomous flip re-enrolls normally.
 *
 * COST: bounded by `MAX_AUTONOMOUS_USER_AGENTS` — `activateAutonomyForOwner`
 * enforces the cap, so an over-cap reconcile leaves the row FLAGGED (retry next
 * reconcile as slots free) rather than silently dropping it. Runs at most once
 * per in-flight window (module guard) on a low frequency.
 */

import { and, eq, gt, sql } from 'drizzle-orm';
import { db, agentBots } from '@clawville/database';
import { agentAutonomyDriver } from './agent-autonomy-driver';
import { npcSimulation } from './npc-simulation';
import { activateAutonomyForOwner } from './agent-autonomy-activation';
import { sessionDigest } from './session-digest';

export interface ReconcileResult {
  /** Flagged+live rows considered this pass. */
  candidates: number;
  /** Newly (re-)enrolled this pass. */
  enrolled: number;
  /** Already enrolled OR currently human-driving — left as-is. */
  skipped: number;
  /** Rejected by the user-agent cap — STAYS flagged, retried next reconcile. */
  capacity: number;
  /** Terminally ineligible (guest/no-agent/etc.) — left flagged; self-heals at TTL expiry. */
  ineligible: number;
}

/**
 * Injectable seams (DB-free unit tests). Production `listFlaggedLiveOwners` reads
 * the durable flag + live TTL; `activate` is the real idempotent activation.
 */
export const reconcileSeams = {
  /**
   * Every hosted-avatar session that PERSISTED an autonomy intent AND still has a
   * live TTL. Non-house only (house agents never carry the flag + never expire).
   * A null/absent TTL is treated as NOT live (fail-closed — never resurrect a row
   * whose liveness we can't confirm). Rows with a null userId are unroutable and
   * skipped.
   */
  listFlaggedLiveOwners: async (): Promise<Array<{ agentId: string; userId: string }>> => {
    const rows = await db
      .select({ agentId: agentBots.agentId, userId: agentBots.userId })
      .from(agentBots)
      .where(
        and(
          eq(agentBots.autonomyEnrolled, true),
          eq(agentBots.isHouse, false),
          sql`${agentBots.sessionExpiresAt} IS NOT NULL`,
          gt(agentBots.sessionExpiresAt, new Date()),
        ),
      );
    return rows
      .filter((r): r is { agentId: string; userId: string } => !!r.userId)
      .map((r) => ({ agentId: r.agentId, userId: r.userId }));
  },
  activate: activateAutonomyForOwner,
};

let reconcileInFlight = false;

/**
 * One reconcile pass. Idempotent + guarded against overlap (a slow pass never
 * stacks). Returns a tally for observability. Fail-soft per-row: one owner's
 * activation error never aborts the pass.
 */
export async function reconcileDurableAutonomy(): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    candidates: 0,
    enrolled: 0,
    skipped: 0,
    capacity: 0,
    ineligible: 0,
  };
  if (reconcileInFlight) return result; // an earlier pass is still running
  reconcileInFlight = true;
  try {
    const owners = await reconcileSeams.listFlaggedLiveOwners();
    result.candidates = owners.length;
    for (const { agentId, userId } of owners) {
      // Already driving in THIS process — nothing to re-enroll.
      if (agentAutonomyDriver.isOwnerEnrolled(userId)) {
        result.skipped++;
        continue;
      }
      // The human is CURRENTLY driving this body (a live suppression window) —
      // do not fight them; their next Autonomous flip re-enrolls normally.
      if (npcSimulation.isAgentHumanControlled(agentId)) {
        result.skipped++;
        continue;
      }
      try {
        const r = await reconcileSeams.activate(userId);
        if (r.ok) {
          result.enrolled++;
        } else if (r.code === 'autonomy_capacity') {
          // Over cap — leave the row FLAGGED (do NOT clear) so it retries next
          // reconcile as a slot frees. Loud, never silent.
          result.capacity++;
        } else {
          // Terminally ineligible (guest / no-agent / no-avatar / not_eligible):
          // leave flagged — it self-heals when the 24h TTL sweep clears the flag.
          result.ineligible++;
        }
      } catch (err) {
        result.ineligible++;
        console.warn(
          `[AutonomyReconcile] activate failed for ${sessionDigest(userId)} (non-fatal):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (result.enrolled || result.capacity || result.ineligible) {
      console.log(
        `[AutonomyReconcile] candidates=${result.candidates} enrolled=${result.enrolled} skipped=${result.skipped} capacity=${result.capacity} ineligible=${result.ineligible}`,
      );
    }
    return result;
  } finally {
    reconcileInFlight = false;
  }
}

/** Test-only: reset the overlap guard. */
export function _resetReconcileGuard(): void {
  reconcileInFlight = false;
}
