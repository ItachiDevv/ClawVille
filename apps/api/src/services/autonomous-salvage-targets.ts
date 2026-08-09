/**
 * Bounded, server-derived salvage targets for the autonomous decide path (P7b).
 *
 * ── WHY THIS EXISTS AT ALL (the CONSUMPTION MANDATE) ────────────────────────
 * The 2026-07-15 autonomy audit found an agent told "go play cards" walking to
 * a teaching house, because `enter_cove` existed in the executor while the
 * decision prompt offered only the ten teachers. The rule that came out of it
 * is mechanical: any LLM path that CHOOSES actions must be fed the current
 * world scope and the full executor menu, and a prompt that offers a narrower
 * set than the server whitelist is a defect, not a scope cut.
 *
 * `salvage_node(nodeId)` is therefore useless without this block. There are 48
 * node ids in a frozen shared layout; a model cannot invent one, and one it
 * invents is dropped by the executor. This gives it the handful it can actually
 * reach, nearest first, with the cooldown state that decides whether going
 * there is worth the swim.
 *
 * ADVISORY, NOT AUTHORITATIVE. Everything here is a suggestion: the executor
 * re-checks proximity against the server-owned body and the settlement service
 * re-checks the cooldown and both caps under locks. A stale or over-optimistic
 * suggestion costs one refused action, never a wrong payout.
 */

import { db, sql } from '@clawville/database';
import {
  SALVAGE_AVATAR_DAILY_CLAIM_CAP,
  SALVAGE_NODES,
  SALVAGE_OWNER_DAILY_CLAIM_CAP,
} from '@clawville/shared';

/** Nodes offered per decision. Small on purpose — a 48-line block would crowd
 *  out the rest of the prompt for a choice that only needs a few options. */
const TARGET_LIMIT = 5;

export interface AutonomousSalvageTarget {
  readonly nodeId: string;
  readonly band: string;
  readonly distanceWu: number;
  readonly ready: boolean;
  /** ISO8601 when a cooling node becomes claimable; null if ready now. */
  readonly nextClaimAt: string | null;
}

export interface AutonomousSalvageTargets {
  readonly nodes: readonly AutonomousSalvageTarget[];
  readonly materialBalance: number;
  readonly claimsRemainingToday: number;
  readonly ownerClaimsRemainingToday: number;
}

/**
 * Closed-field projection. No player prose, no database UUIDs, no other
 * subject's state — the same discipline `readAutonomousLandTargets` follows.
 *
 * `x`/`y` arrive in GAME-PIXEL coords (the simulation frame) and node positions
 * are CENTERED, so the caller passes the same numbers it uses for land targets
 * and the conversion happens here, once.
 */
export async function readAutonomousSalvageTargets(input: {
  readonly avatarId: string;
  readonly userId: string;
  readonly x: number;
  readonly y: number;
  readonly mapHalfWu: number;
}): Promise<AutonomousSalvageTargets> {
  const { avatarId, userId, mapHalfWu } = input;
  const selfX = input.x - mapHalfWu;
  const selfZ = input.y - mapHalfWu;

  const [claimRows, dailyRows, ownerRows, balanceRows] = await Promise.all([
    db.execute<{ node_id: string; next_claim_at: string | Date; ready: boolean }>(
      sql`SELECT node_id, next_claim_at, next_claim_at <= now() AS ready
          FROM salvage_node_claims WHERE avatar_id = ${avatarId}`,
    ),
    db.execute<{ claims_admitted: number | string }>(
      sql`SELECT claims_admitted FROM salvage_daily_admissions
          WHERE avatar_id = ${avatarId} AND utc_day = (now() AT TIME ZONE 'UTC')::date`,
    ),
    db.execute<{ claims_admitted: number | string }>(
      sql`SELECT claims_admitted FROM salvage_owner_admissions
          WHERE owner_kind = 'user' AND owner_id = ${userId}
            AND utc_day = (now() AT TIME ZONE 'UTC')::date`,
    ),
    db.execute<{ quantity: number | string }>(
      sql`SELECT quantity FROM avatar_material_balances WHERE avatar_id = ${avatarId}`,
    ),
  ]);

  const byNode = new Map(Array.from(claimRows).map((row) => [row.node_id, row]));

  const scored = SALVAGE_NODES.map((node) => {
    const row = byNode.get(node.id);
    return {
      nodeId: node.id,
      band: node.band,
      distanceWu: Math.round(Math.hypot(node.x - selfX, node.z - selfZ)),
      ready: row ? row.ready === true : true,
      nextClaimAt: row ? new Date(row.next_claim_at).toISOString() : null,
    };
  });

  // READY nodes first, then nearest. A cooling node three steps away is worse
  // than a ready node across the shelf, and sorting by distance alone would
  // keep steering the agent back to the node it just emptied.
  scored.sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    return a.distanceWu - b.distanceWu;
  });

  const claimsUsedToday = Number(dailyRows[0]?.claims_admitted ?? 0);
  const ownerClaimsUsedToday = Number(ownerRows[0]?.claims_admitted ?? 0);

  return {
    nodes: scored.slice(0, TARGET_LIMIT),
    materialBalance: Number(balanceRows[0]?.quantity ?? 0),
    claimsRemainingToday: Math.max(0, SALVAGE_AVATAR_DAILY_CLAIM_CAP - claimsUsedToday),
    ownerClaimsRemainingToday: Math.max(
      0,
      SALVAGE_OWNER_DAILY_CLAIM_CAP - ownerClaimsUsedToday,
    ),
  };
}
