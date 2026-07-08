/**
 * Agent autonomy activation (§B.1, 2026-07-08) — the enrollment lifecycle that
 * wires a USER-OWNED hosted avatar-agent into the full autonomy driver
 * (`agent-autonomy-driver.ts`), giving a signup user's agent the SAME
 * perceive → decide → act loop the house fleet runs, settling REAL CT +
 * leaderboard credit to the OWNER's active avatar (Rule E5 agent-path parity).
 *
 * ACTIVATE (Autonomous mode on):
 *   1. Resolve the owner's ACTIVE avatar SERVER-SIDE (never trust a client
 *      agentId — deriving from the Lucia userId is what stops one user
 *      force-enrolling / force-spending another user's agent).
 *   2. Guard: guest (demo economy, never autonomous) / no avatar / no bound
 *      platform agent.
 *   3. CAPACITY PRE-CHECK (D1/D2): consult the driver BEFORE minting the §B.2
 *      session/body, so a full registry never leaves an orphan body in the sim.
 *      Idempotent re-activation of an already-enrolled agent always passes.
 *   4. Mint/reuse the §B.2 ledger-capable internal session + deterministic
 *      `ocb-` body (`ensureHostedAvatarAgentSession` — bearer stays server-side).
 *   5. Enroll in the driver's user registry (typed capacity rejection).
 *   6. BRIDGE MUTUAL EXCLUSION (C1): unregister the owner from the idle-avatar
 *      simulation bridge so the scripted wander sim can never double-drive the
 *      avatar or double-credit the `autonomous_visit` faucet alongside the
 *      driver. (The heartbeat's register path also skips driver-enrolled owners
 *      — see routes/avatars.ts — so the bridge can't sneak back in.)
 *   7. TWO-BODY HANDOFF (the freeze bug): release the Controlled-mode
 *      human-control binding + until-entry for this agent. Without this, the
 *      5 Hz /api/world/position refresh keeps wiping the driver body's A* path
 *      (markHumanControlledOpenClaw clears paths) and the body never moves.
 *
 * DEACTIVATE (back to Controlled): unregister from the driver, then RE-ESTABLISH
 * the launch binding + a 15s suppression window so the agent's `ocb-` body is
 * hidden + frozen while the human drives the shared avatar (no visible double
 * body). Idempotent — the §B.2 session/row is deliberately NOT torn down (D6):
 * the bearer registry + row survive so the next activation reuses instead of
 * re-minting, and the body idle-despawn sweeper reaps the dormant body on its
 * own schedule.
 *
 * RESTART GAP (B3): the driver registry is process memory. Activation is
 * IDEMPOTENT + cheap when already enrolled precisely so a client keepalive can
 * re-call it to re-arm autonomy after an API restart (the keepalive itself is
 * frontend work, out of §B.1 scope).
 *
 * MONEY: this module never touches the ledger. Settlement stays inside the
 * driver's arrivalSettle/teacherTurn (world-teacher-chat), keyed on the OWNER's
 * avatarId resolved here, with the existing once-per-day idempotency probes.
 */

import { and, eq } from 'drizzle-orm';
import { db, avatars } from '@clawville/database';
import { agentAutonomyDriver } from './agent-autonomy-driver';
import { ensureHostedAvatarAgentSession } from './hosted-avatar-agent-session';
import { npcSimulation } from './npc-simulation';
import { sessionDigest } from './session-digest';

/** Deactivate hands the body back suppressed for 15s — heartbeat cadence
 *  (Controlled mode marks every heartbeat) is well under this, so continuous
 *  driving keeps it suppressed; if the user just leaves, it lapses on its own.
 *  Mirrors the D3 heartbeat mark TTL in routes/avatars.ts. */
const HANDBACK_SUPPRESSION_TTL_MS = 15_000;

export type ActivationFailureCode =
  | 'no_avatar'
  | 'guest_forbidden'
  | 'no_agent'
  | 'not_eligible'
  | 'autonomy_capacity';

export type ActivateAutonomyResult =
  | { ok: true; reused: boolean; bodyId: string }
  | { ok: false; code: ActivationFailureCode };

/**
 * Injectable seams so the unit tests run DB-free (the same instance-seam pattern
 * the driver uses for teacherTurn/arrivalSettle). Production values are the real
 * DB read + the real §B.2 mint. Tests swap these; nothing else in this module
 * touches a database.
 */
export const activationSeams = {
  /** The owner's ACTIVE avatar — the ONLY avatar autonomy may bind to. */
  resolveActiveAvatar: (
    ownerUserId: string,
  ): Promise<{ id: string; platformAgentId: string | null; isGuest: boolean } | null> =>
    db.query.avatars
      .findFirst({
        where: and(eq(avatars.userId, ownerUserId), eq(avatars.isActive, true)),
        columns: { id: true, platformAgentId: true, isGuest: true },
      })
      .then((row) => row ?? null),
  ensureSession: ensureHostedAvatarAgentSession,
};

/**
 * Enroll the owner's hosted avatar-agent into the autonomy driver. Idempotent —
 * safe to call repeatedly (keepalive re-arm); a repeat call reports
 * `reused:true` and never consumes extra capacity. The `platformAgentId` is
 * derived SERVER-SIDE from the owner's active avatar; no caller-supplied agent
 * identity is ever accepted.
 */
export async function activateAutonomyForOwner(
  ownerUserId: string,
): Promise<ActivateAutonomyResult> {
  const avatar = await activationSeams.resolveActiveAvatar(ownerUserId);
  if (!avatar) return { ok: false, code: 'no_avatar' };
  // Guests run the demo economy — autonomy settles REAL CT, so a guest avatar
  // is refused here (and again inside ensureHostedAvatarAgentSession, which
  // also rejects guests — defense in depth, fail closed).
  if (avatar.isGuest) return { ok: false, code: 'guest_forbidden' };
  const platformAgentId = avatar.platformAgentId;
  if (!platformAgentId) return { ok: false, code: 'no_agent' };

  // D1/D2 — capacity pre-check BEFORE the §B.2 mint. A full registry for a
  // not-yet-enrolled agent must not mint a session/body it can never enroll
  // (orphan body). Already-enrolled agents always pass (idempotent re-arm).
  if (!agentAutonomyDriver.canEnrollUser(platformAgentId)) {
    console.warn(
      `[AutonomyActivation] capacity full (${agentAutonomyDriver.userAgentCount()}/${agentAutonomyDriver.getUserAgentCapacity()}) — rejecting owner enrollment for agent ${sessionDigest(platformAgentId)}`,
    );
    return { ok: false, code: 'autonomy_capacity' };
  }

  // §B.2 primitive: ledger-capable owner-bound internal session + `ocb-` body.
  // Null = guest / unprovisioned / not an avatar-agent → not eligible.
  const session = await activationSeams.ensureSession(platformAgentId);
  if (!session) return { ok: false, code: 'not_eligible' };

  const registered = agentAutonomyDriver.registerUserAgent({
    agentId: session.agentId,
    bodyId: session.bodyId,
    platformAgentId,
    systemUserId: ownerUserId,
    houseUserId: ownerUserId,
    avatarId: avatar.id,
  });
  if (!registered.ok) {
    // TOCTOU tail: capacity filled between the pre-check and here. The §B.2
    // session/row stays (reusable when a slot frees); the dormant body is
    // reaped by the idle-despawn sweeper. Loud + typed, never silent.
    return { ok: false, code: 'autonomy_capacity' };
  }

  // C1 — bridge mutual exclusion: the idle-avatar wander sim must never
  // double-drive (or double-credit `autonomous_visit`) while the driver owns
  // this owner's autonomy. Safe no-op when not registered.
  npcSimulation.avatarAutonomyManager.unregister(ownerUserId);

  // Freeze-bug fix — drop the Controlled-mode binding + until-entry so the 5 Hz
  // position refresh stops wiping the driver body's path. Runs on EVERY
  // activation (idempotent) so a Controlled→Autonomous toggle always lands
  // un-suppressed regardless of what state the binding was left in.
  npcSimulation.releaseHumanControlledOpenClaw(ownerUserId, session.agentId);

  console.log(
    `[AutonomyActivation] owner enrolled agent ${sessionDigest(session.agentId)} body:${session.bodyId} (reused=${registered.reused})`,
  );
  return { ok: true, reused: registered.reused, bodyId: session.bodyId };
}

/**
 * Hand autonomy back to Controlled mode. Idempotent: unenrolls the owner's
 * agent (if any) and re-establishes the two-body suppression (binding + 15s
 * window) so the agent's body is hidden + frozen while the human drives.
 * Re-applies the bind on EVERY call — a §B.2 re-mint's unregisterAgentBot
 * strips the binding (trap B2), so a repeated deactivate must be able to
 * restore it. Does NOT tear down the §B.2 session/row/body (D6).
 */
export async function deactivateAutonomyForOwner(ownerUserId: string): Promise<void> {
  const agentId = agentAutonomyDriver.getEnrolledAgentForOwner(ownerUserId);
  if (!agentId) return; // never enrolled / already deactivated — no-op
  agentAutonomyDriver.unregisterUserAgent(agentId);
  // Two-body handback: durable binding (so the 5 Hz position refresh keeps the
  // suppression alive while the human drives) + an immediate window (so the
  // body freezes/hides NOW, not on the next position upload).
  npcSimulation.bindHumanControlledOpenClawLaunch(ownerUserId, agentId);
  npcSimulation.markHumanControlledOpenClaw(agentId, HANDBACK_SUPPRESSION_TTL_MS);
  console.log(
    `[AutonomyActivation] owner deactivated agent ${sessionDigest(agentId)} — handed back to Controlled (suppressed)`,
  );
}
