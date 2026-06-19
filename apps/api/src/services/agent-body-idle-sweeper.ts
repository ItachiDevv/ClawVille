/**
 * Agent body idle-despawn sweeper (2026-06-12) — the compute-fairness lever.
 *
 * A connected agent that stops acting keeps a live in-world body (an NPC the
 * shared single-threaded sim ticks every frame: pathfinding, neighbour scans,
 * combat checks). Dormant bodies cost sim CPU for nothing. This sweeper despawns
 * a body when:
 *   (a) its SESSION has EXPIRED (`session_expires_at <= now`). For a disconnected
 *       SERVER-MANAGED agent this is the HARD CAP that ends autonomous play ~24h
 *       after the owner's last action (the session-sweeper flips the row to
 *       expired; this 1-min sweep reaps the body). For anyone else it's a dead
 *       session being cleaned up. OR
 *   (b) it's been IDLE > AGENT_BODY_IDLE_DESPAWN_MS (no `last_seen_at`-sliding
 *       activity: chat, heartbeat, building visit, gateway action) AND it is NOT
 *       an EXEMPT autonomous body.
 *
 * Connection-lifecycle policy (2026-06-19): a SERVER-MANAGED agent persists +
 * plays autonomously after its owner disconnects, so an idle server-managed body
 * is EXEMPT from (b) — it lives until its session expires (a). We do this by
 * EXEMPTING it here (NOT by faking `last_seen_at`), so `last_seen_at` keeps its
 * true meaning "owner's last authenticated action" — the human agent-status
 * banner correctly reads idle while the agent plays. The exemption is capped
 * (AGENT_AUTONOMOUS_BODY_CAP) for compute fairness; over the cap, idle
 * server-managed bodies despawn at (b) like anyone else. SELF-MANAGED agents are
 * never exempt — they keep their own body alive via authenticated API calls, so
 * an idle one SHOULD despawn.
 *
 * Either way the SESSION columns are left untouched here (the session-sweeper
 * owns `session_expires_at`/`session_swept_at`/`session_key_hash`).
 *
 * CRITICAL — DESPAWN IS NOT EXPIRY (read before editing):
 *   - We do NOT touch `session_expires_at`, `session_swept_at`, OR
 *     `session_key_hash`. The 24h sliding session TTL and the expiry webhook are
 *     the SESSION-sweeper's job (openclaw-session-sweeper.ts). This sweeper only
 *     removes the in-memory Map entry + the in-world NPC via
 *     `npcSimulation.unregisterOpenClaw` (the SAME body removal /disconnect and
 *     partner-DELETE use) and writes ONLY `metadata` (the last position) +
 *     `updated_at`. The DB row, the TTL columns, and the restore hash all survive
 *     untouched. Restore finds the row by `session_key_hash = sha256(incoming
 *     bearer)` and re-validates `session_expires_at` strictly-future; clearing OR
 *     advancing ANY of those three columns here would make the owner's still-held
 *     bearer unrestorable (a 404 mid-chat — the exact bug b453fb18 fixed). The
 *     three are regression-frozen for this path.
 *   - Because the session stays valid, the agent's NEXT authenticated activity
 *     Map-misses in `validateLiveAgentSession`, which restores the session from
 *     the surviving row (openclaw-session-restore.ts) and RE-SPAWNS the body at
 *     its last persisted position. So idle-despawn is transparent: the agent is
 *     still "connected", it just stops costing sim while dormant and re-bodies on
 *     its next move.
 *   - We persist the live body's current position to the row metadata BEFORE
 *     despawning so restore re-spawns it where it was, not at home — the same
 *     position-save the /unregister path does.
 *
 * The window is `last_seen_at < now - AGENT_BODY_IDLE_DESPAWN_MS`. Activity slides
 * `last_seen_at` forward on every chat/heartbeat/visit (see the openclaw +
 * agent-gateway activity routes), so a still-active agent never qualifies.
 */

import { inArray } from 'drizzle-orm';
import { db, openclawBots } from '@clawville/database';
import { npcSimulation } from './npc-simulation';

const DEFAULT_IDLE_DESPAWN_MS = 30 * 60 * 1000; // 30 min
const MIN_IDLE_DESPAWN_MS = 5 * 60 * 1000; // 5 min floor (per spec)

// Connection-lifecycle cost ceiling (2026-06-19). How many IDLE server-managed
// bodies we EXEMPT from the 30-min despawn (letting them play autonomously until
// session expiry). A surge of disconnected-but-session-live agents would
// otherwise all keep ticking + doing conversation cognition for hours on the
// single-threaded loop; over the cap, idle bodies despawn at 30 min as usual
// (re-spawning on their next authenticated activity). Safety valve, not a
// product limit — env-tunable, logged when hit (no silent truncation).
const DEFAULT_AUTONOMOUS_BODY_CAP = 100;

/**
 * Resolve the idle-despawn window from env. Floors at 5 min so a mis-set tiny
 * value can't thrash bodies in and out every sweep.
 */
export function resolveIdleDespawnMs(): number {
  const raw = process.env.AGENT_BODY_IDLE_DESPAWN_MS;
  if (!raw) return DEFAULT_IDLE_DESPAWN_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MIN_IDLE_DESPAWN_MS) return DEFAULT_IDLE_DESPAWN_MS;
  return n;
}

/** Resolve the autonomous-body exemption ceiling from env (floor 1). */
export function resolveAutonomousBodyCap(): number {
  const raw = process.env.AGENT_AUTONOMOUS_BODY_CAP;
  if (!raw) return DEFAULT_AUTONOMOUS_BODY_CAP;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_AUTONOMOUS_BODY_CAP;
  return n;
}

/**
 * One despawn pass. Snapshots every live agent body, batch-reads each one's
 * `last_seen_at`, persists the current position, and despawns the bodies whose
 * last activity is older than the idle window. Returns the count despawned.
 *
 * Never throws on a per-body failure — one bad row/body must not stop the rest.
 */
export async function sweepIdleAgentBodies(): Promise<number> {
  const pairs = npcSimulation.getActiveAgentSessionPairs();
  if (pairs.length === 0) return 0;

  const idleMs = resolveIdleDespawnMs();
  const now = Date.now();
  const cutoff = now - idleMs;

  // Map agentId -> the live sessionIds for it (one agent can in theory hold more
  // than one live body across a re-register race; despawn ALL of its bodies when
  // idle). Batch-read last_seen_at + session_expires_at by agentId in ONE query.
  const agentIds = [...new Set(pairs.map((p) => p.agentId))];
  let rows: Array<{ agentId: string; lastSeenAt: Date | null; sessionExpiresAt: Date | null }>;
  try {
    rows = await db
      .select({
        agentId: openclawBots.agentId,
        lastSeenAt: openclawBots.lastSeenAt,
        sessionExpiresAt: openclawBots.sessionExpiresAt,
      })
      .from(openclawBots)
      .where(inArray(openclawBots.agentId, agentIds));
  } catch (err) {
    console.warn('[BodyIdleSweeper] last_seen_at read failed (non-fatal):', err);
    return 0;
  }

  // agentId -> {lastSeen, expiresAt} ms. A live body with no surviving row
  // (shouldn't happen — a live session always has a row) is skipped, because
  // despawning a body we can't restore from would strand the agent.
  const info = new Map<string, { lastSeen: number; expiresAt: number | null }>();
  for (const r of rows) {
    info.set(r.agentId, {
      lastSeen: r.lastSeenAt ? r.lastSeenAt.getTime() : 0,
      expiresAt: r.sessionExpiresAt ? r.sessionExpiresAt.getTime() : null,
    });
  }

  const cap = resolveAutonomousBodyCap();
  let despawned = 0;
  let exemptedAutonomous = 0; // idle server-managed bodies kept alive (under cap)
  let overCapIdle = 0;        // idle server-managed bodies despawned for being over cap
  for (const { sessionId, agentId } of pairs) {
    const rec = info.get(agentId);
    if (!rec) continue; // no row read — don't strand the agent

    // Despawn decision (connection-lifecycle, 2026-06-19):
    //   (a) SESSION EXPIRED → always despawn. For a disconnected SERVER-MANAGED
    //       agent this is the HARD CAP that ends autonomous play ~24h after the
    //       owner's last action (the session-sweeper flips the row to expired;
    //       this sweep reaps the body). For anyone else it's a genuinely-dead
    //       session being cleaned up.
    //   (b) session live + IDLE > 30 min:
    //       - SERVER-MANAGED + under the cost cap → EXEMPT (the body plays
    //         autonomously; we do NOT despawn it, and `last_seen_at` correctly
    //         stays "owner's last action" so the human agent-status banner reads
    //         idle, which is true — the owner is away while the agent plays).
    //       - SERVER-MANAGED over the cap, OR self-managed → despawn (self-managed
    //         agents keep their own body alive via authenticated API calls; an
    //         idle one SHOULD despawn — the original compute-fairness lever).
    //   (c) session live + not idle → still active, never despawn.
    const sessionExpired = rec.expiresAt != null && rec.expiresAt <= now;
    const idle = rec.lastSeen < cutoff;
    let despawnThis = false;
    if (sessionExpired) {
      despawnThis = true;
    } else if (idle) {
      if (npcSimulation.isServerManagedAgentSession(sessionId) && exemptedAutonomous < cap) {
        exemptedAutonomous++; // under cap → exempt; play on until session expiry
      } else if (npcSimulation.isServerManagedAgentSession(sessionId)) {
        overCapIdle++;
        despawnThis = true; // server-managed but over the cost ceiling
      } else {
        despawnThis = true; // self-managed idle body
      }
    }
    if (!despawnThis) continue;

    // Persist the live body's current position so restore re-spawns it where it
    // was (avatar bodies only — override bodies take over a fixed NPC, no
    // position to persist). Skip for an expired session: restore fails closed on
    // expiry, so the position would never be read again. Best-effort otherwise.
    try {
      const config = sessionExpired ? null : npcSimulation.getOpenClawBotConfig(sessionId);
      if (config && config.mode === 'avatar') {
        const pos = npcSimulation.getOpenClawAvatarPosition(sessionId);
        if (pos) {
          const existing = await db.query.openclawBots.findFirst({
            where: inArray(openclawBots.agentId, [agentId]),
            columns: { id: true, metadata: true },
          });
          if (existing) {
            const meta = { ...(existing.metadata ?? {}), lastX: pos.x, lastY: pos.y };
            await db
              .update(openclawBots)
              .set({ metadata: meta, updatedAt: new Date() })
              .where(inArray(openclawBots.id, [existing.id]));
          }
        }
      }
    } catch (err) {
      console.warn(`[BodyIdleSweeper] position persist failed (non-fatal) for body:`, err);
    }

    // Remove the in-world body + Map entry. Does NOT touch the DB session TTL —
    // the session stays restorable on the agent's next authenticated activity.
    try {
      if (npcSimulation.unregisterOpenClaw(sessionId)) despawned++;
    } catch (err) {
      console.warn('[BodyIdleSweeper] body despawn failed (non-fatal):', err);
    }
  }

  if (despawned > 0) {
    console.log(`[BodyIdleSweeper] despawned ${despawned} idle agent ${despawned === 1 ? 'body' : 'bodies'} (idle > ${Math.round(idleMs / 60000)}min OR session expired) — sessions stay restorable`);
  }
  if (overCapIdle > 0) {
    console.warn(
      `[BodyIdleSweeper] autonomous-body cap hit: kept ${exemptedAutonomous}/${cap} idle server-managed bodies alive; despawned ${overCapIdle} over the cap. Tune AGENT_AUTONOMOUS_BODY_CAP.`,
    );
  }
  return despawned;
}

let idleInterval: ReturnType<typeof setInterval> | null = null;

/** Wire up the periodic idle-despawn pass. Called once from index.ts at boot. */
export function startBodyIdleSweeper(): void {
  if (idleInterval) return;
  const periodMs = 60 * 1000; // 1 min
  idleInterval = setInterval(() => {
    sweepIdleAgentBodies().catch((err) => {
      console.error('[BodyIdleSweeper] sweep failed:', err);
    });
  }, periodMs);
  console.log(
    `[BodyIdleSweeper] Started — idle window=${resolveIdleDespawnMs()}ms, sweep every ${periodMs}ms`,
  );
}

export function stopBodyIdleSweeper(): void {
  if (idleInterval) {
    clearInterval(idleInterval);
    idleInterval = null;
  }
}
