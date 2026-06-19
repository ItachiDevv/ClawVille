/**
 * Agent body idle-despawn sweeper (2026-06-12) — the compute-fairness lever.
 *
 * A connected agent that stops acting keeps a live in-world body (an NPC the
 * shared single-threaded sim ticks every frame: pathfinding, neighbour scans,
 * combat checks). Dormant bodies cost sim CPU for nothing. This sweeper removes
 * the BODY of any agent that EITHER:
 *   (a) has not had a TTL-sliding activity (chat, heartbeat, building visit —
 *       anything that writes `last_seen_at`) within AGENT_BODY_IDLE_DESPAWN_MS
 *       (the original compute-fairness lever for an abandoned body), OR
 *   (b) whose SESSION has EXPIRED (`session_expires_at <= now`) — added 2026-06-19
 *       for the connection-lifecycle policy: a disconnected SERVER-MANAGED agent
 *       plays autonomously and the sim keeps its `last_seen_at` fresh via
 *       body-keepalive, so (a) never fires for it; (b) is the hard cap that ends
 *       autonomous play ~24h after the owner's last action. The session-sweeper
 *       (5-min) flips the DB row to expired; this (1-min) sweep reaps the body.
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

  let despawned = 0;
  for (const { sessionId, agentId } of pairs) {
    const rec = info.get(agentId);
    if (!rec) continue; // no row read — don't strand the agent
    // Despawn when EITHER:
    //   (a) idle > 30 min (last_seen_at stale) — the original compute-fairness
    //       lever for an abandoned non-autonomous body; OR
    //   (b) the session has EXPIRED (connection-lifecycle, 2026-06-19) — the hard
    //       cap on a disconnected SERVER-MANAGED agent's autonomous run. Its
    //       last_seen_at is kept fresh by the sim's body-keepalive while it
    //       plays, so (a) never fires for it; (b) is what ends autonomous play
    //       ~24h after the owner's last action. The session-sweeper (5-min)
    //       expires the DB row; this (1-min) sweep reaps the in-world body.
    const sessionExpired = rec.expiresAt != null && rec.expiresAt <= now;
    const idle = rec.lastSeen < cutoff;
    if (!sessionExpired && !idle) continue; // still active + session live

    // Persist the live body's current position so restore re-spawns it where it
    // was (avatar bodies only — override bodies take over a fixed NPC, no
    // position to persist). Best-effort: a persist failure just means restore
    // falls back to the last stored / home position.
    try {
      const config = npcSimulation.getOpenClawBotConfig(sessionId);
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
    console.log(`[BodyIdleSweeper] despawned ${despawned} idle agent ${despawned === 1 ? 'body' : 'bodies'} (idle > ${Math.round(idleMs / 60000)}min) — sessions stay restorable`);
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
