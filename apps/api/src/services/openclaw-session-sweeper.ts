/**
 * Phase 6 — openclaw_bots session liveness sweeper.
 *
 * Every external agent session carries a 24h sliding TTL on
 * `openclaw_bots.session_expires_at`. Each activity-bearing request calls
 * `extendSessionTtl()` to push the expiry forward another 24h: location chat
 * (openclaw.ts), heartbeat, building visit/activity match, AND — since FIX-4
 * (2026-06-13) — every mutating connected-agent gateway action, which all
 * route through `agent-gateway.ts resolveSession()`. An agent that stops
 * acting for 24h gets swept:
 *
 *   1. Any in-process Eliza runtime tied to the bot's `agents.id` is
 *      stopped (frees RAM).
 *   2. `openclaw_bots.session_expires_at` stays set to a past timestamp
 *      so `/api/agent/session-status` answers 410 Gone on the next poll.
 *      The row is NOT deleted — the agent reconnects idempotently via
 *      `/api/agent/reconnect` with the stored identity private key.
 *
 * Before this existed, sessionIds lived forever; the user's Hermes agent
 * could sit dormant for a week and still claim "I am connected" because
 * nothing ever invalidated the stored handle.
 */

import { and, eq, lt, or, isNull } from 'drizzle-orm';
import { db, openclawBots, agents, sql } from '@clawville/database';
import { agentOrchestrator } from './agent-orchestrator';
import { logEvent } from './event-logger';
import { notifyHatcherSessionEnded } from './hatcher-session-webhook';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Override the TTL via env for load tests or shorter-lived environments. */
function resolveTtlMs(): number {
  const raw = process.env.AGENT_SESSION_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 60_000) return DEFAULT_TTL_MS;
  return n;
}

/**
 * Compute the next expiry timestamp from the configured TTL. Callers
 * use this both for initial session creation and for the sliding
 * extension on activity — one source of truth keeps the sweep and the
 * extend path in lockstep.
 */
export function computeSessionExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + resolveTtlMs());
}

/**
 * Slide the session TTL forward on activity. Idempotent, fire-and-forget
 * safe — every call writes a fresh expiry regardless of prior state, so
 * a concurrent activity storm just settles on the last-write timestamp
 * without a read-modify-write race.
 *
 * Matches `openclaw_bots` on the bot's stable `agentId` (what the agent
 * knows), not `id` (internal UUID), so callers that only have the
 * session-issued handle can extend without a pre-lookup.
 */
export async function extendSessionTtl(agentId: string): Promise<void> {
  const next = computeSessionExpiresAt();
  await db
    .update(openclawBots)
    .set({
      sessionExpiresAt: next,
      // Clear sessionSweptAt so the next genuine expiration fires
      // exactly once. Without this, an agent that connects, expires
      // (sweepers logs the event), then reconnects, would never emit
      // `agent.session.expired` again because sessionSweptAt would
      // still be > old sessionExpiresAt for all subsequent cycles.
      sessionSweptAt: null,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(openclawBots.agentId, agentId))
    .catch((err) => {
      // Non-fatal: TTL extension failure logs but never blocks the
      // agent's primary request (chat, activity, heartbeat).
      console.warn(`[SessionSweeper] Failed to extend TTL for ${agentId}:`, err);
    });
}

/**
 * Flip a single session to expired-now. Called by `/api/agent/disconnect`
 * and by the sweep loop. Safe to call on a row that's already expired —
 * the UPDATE is a no-op on the in-memory runtime side if no runtime is
 * mounted for the associated `agents.id`.
 */
export async function expireSession(agentId: string): Promise<void> {
  const now = new Date();
  // Set BOTH `session_expires_at` and `session_swept_at` so the sweeper
  // doesn't pick this row up again to re-emit `agent.session.expired` —
  // the explicit /disconnect path emits its own
  // `agent.session.disconnected` event in the route handler, and we
  // don't want a duplicate "expired" event firing at the next sweep.
  const rows = await db
    .update(openclawBots)
    // Null the restorable session-bearer hash on this TERMINAL transition (#8,
    // 2026-06-12). Restore already fails closed on the expired TTL, so this is
    // defense-in-depth, not a live-bypass fix — a disconnected session must not
    // retain a bearer commitment a future change could re-honor. A subsequent
    // /connect/register mints a fresh sessionId and writes a new hash, so this
    // does not break legitimate reconnect.
    .set({ sessionExpiresAt: now, sessionSweptAt: now, sessionKeyHash: null, updatedAt: now })
    .where(eq(openclawBots.agentId, agentId))
    .returning({ userId: openclawBots.userId, identityType: openclawBots.identityType });

  // Notify the partner (Hatcher-only, env-gated, fail-open) that this session
  // ended. Fire-and-forget — never block the disconnect on a webhook. The
  // reason is `disconnected` because the only caller is the explicit /disconnect
  // path (the periodic sweep notifies with `ttl_expired` separately below).
  for (const row of rows) {
    void notifyHatcherSessionEnded({
      identityType: row.identityType,
      agentId,
      reason: 'disconnected',
      expiredAt: now,
    });
  }

  // Stop any in-process Eliza runtime. Match on `agents.userId` =
  // openclaw_bots.userId AND agents.type='openclaw-bot'; we don't
  // carry a direct FK from openclaw_bots → agents, so this is the
  // tightest join we can do without a schema change.
  for (const row of rows) {
    if (!row.userId) continue;
    const botAgent = await db.query.agents.findFirst({
      where: and(eq(agents.userId, row.userId), eq(agents.type, 'openclaw-bot')),
      columns: { id: true },
    });
    if (botAgent) {
      await agentOrchestrator.stopAgent(botAgent.id).catch((err) => {
        console.warn(`[SessionSweeper] stopAgent failed for ${botAgent.id}:`, err);
      });
    }
  }
}

/**
 * Sweep expired sessions. Intended to run on a 5-min interval from
 * `apps/api/src/index.ts`. Stops any in-process runtimes, emits an event
 * per expiration for `/dash`, and leaves `session_expires_at` in the
 * past so `/api/agent/session-status` answers 410 Gone.
 */
export async function sweepExpiredSessions(): Promise<number> {
  const now = new Date();

  // Pick up rows that:
  //   1. Have a populated `session_expires_at` (legacy rows pre-dating
  //      the column are NULL and skipped until /connect refreshes them).
  //   2. Have an expiry strictly in the past.
  //   3. Have NOT already been processed by a previous sweep — that's
  //      the `session_swept_at IS NULL OR session_swept_at <
  //      session_expires_at` check, which ensures the sweeper fires
  //      `agent.session.expired` exactly once per expiration cycle.
  //      A subsequent /connect resets `session_swept_at` to NULL via
  //      the upsert path, so the next expiration after a reconnect
  //      processes correctly.
  const expired = await db
    .select({
      id: openclawBots.id,
      agentId: openclawBots.agentId,
      userId: openclawBots.userId,
      identityType: openclawBots.identityType,
    })
    .from(openclawBots)
    .where(
      and(
        sql`${openclawBots.sessionExpiresAt} IS NOT NULL`,
        lt(openclawBots.sessionExpiresAt, now),
        or(
          isNull(openclawBots.sessionSweptAt),
          lt(openclawBots.sessionSweptAt, openclawBots.sessionExpiresAt),
        ),
      ),
    );

  if (expired.length === 0) return 0;

  // Mark the picked-up rows as swept BEFORE we emit events / stop
  // runtimes. If the boot crashes mid-sweep, the next tick won't
  // double-emit because session_swept_at is already advanced. Also null the
  // restorable session-bearer hash on this TERMINAL TTL-expiry (#8, 2026-06-12)
  // — restore already fails closed on the past TTL, so this is defense-in-depth
  // so an expired row retains no bearer commitment; a reconnect mints a fresh
  // hash.
  await db
    .update(openclawBots)
    .set({ sessionSweptAt: now, sessionKeyHash: null, updatedAt: now })
    .where(
      sql`${openclawBots.id} IN (${sql.join(expired.map((r) => sql`${r.id}`), sql`, `)})`,
    )
    .catch((err) => {
      console.warn('[SessionSweeper] mark-swept update failed (non-fatal):', err);
    });

  // Group runtime stops by user so we only look up `agents.id` once per
  // owner, not once per openclaw_bots row (a single user can have
  // multiple bots).
  const userIds = new Set<string>();
  for (const row of expired) {
    if (row.userId) userIds.add(row.userId);

    void logEvent({
      eventType: 'agent.session.expired',
      userId: row.userId ?? null,
      agentId: row.agentId,
      payload: { sweptAt: now.toISOString() },
    });

    // Notify the partner this session expired (Hatcher-only, env-gated,
    // fail-open). Fire-and-forget so a slow/unreachable webhook can never
    // stall the sweep — the lifecycle is already authoritative in our DB.
    void notifyHatcherSessionEnded({
      identityType: row.identityType,
      agentId: row.agentId,
      reason: 'ttl_expired',
      expiredAt: now,
    });
  }

  for (const userId of userIds) {
    const botAgent = await db.query.agents.findFirst({
      where: and(eq(agents.userId, userId), eq(agents.type, 'openclaw-bot')),
      columns: { id: true },
    });
    if (botAgent) {
      await agentOrchestrator.stopAgent(botAgent.id).catch((err) => {
        console.warn(`[SessionSweeper] stopAgent failed for ${botAgent.id}:`, err);
      });
    }
  }

  return expired.length;
}

let sweepInterval: ReturnType<typeof setInterval> | null = null;

/** Wire up the periodic sweep. Called once from apps/api/src/index.ts at boot. */
export function startSessionSweeper(): void {
  if (sweepInterval) return;
  const periodMs = 5 * 60 * 1000;
  sweepInterval = setInterval(() => {
    sweepExpiredSessions().catch((err) => {
      console.error('[SessionSweeper] sweep failed:', err);
    });
  }, periodMs);
  console.log(`[SessionSweeper] Started — TTL=${resolveTtlMs()}ms, sweep every ${periodMs}ms`);
}

export function stopSessionSweeper(): void {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
