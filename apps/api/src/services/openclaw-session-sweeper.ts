/**
 * Phase 6 — openclaw_bots session liveness sweeper.
 *
 * Every external agent session carries a 24h sliding TTL on
 * `openclaw_bots.session_expires_at`. Each activity-bearing request
 * (location chat, heartbeat, building visit, activity match)
 * `extendSessionTtl()` pushes the expiry forward another 24h. An agent
 * that stops acting for 24h gets swept:
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

import { and, eq, lt } from 'drizzle-orm';
import { db, openclawBots, agents, sql } from '@clawville/database';
import { agentOrchestrator } from './agent-orchestrator';
import { logEvent } from './event-logger';

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
    .set({ sessionExpiresAt: next, lastSeenAt: new Date(), updatedAt: new Date() })
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
  const rows = await db
    .update(openclawBots)
    .set({ sessionExpiresAt: now, updatedAt: now })
    .where(eq(openclawBots.agentId, agentId))
    .returning({ userId: openclawBots.userId });

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
  const expired = await db
    .select({ id: openclawBots.id, agentId: openclawBots.agentId, userId: openclawBots.userId })
    .from(openclawBots)
    .where(
      and(
        // `session_expires_at IS NOT NULL` — legacy rows pre-dating the
        // column have null and are skipped until they reconnect (which
        // populates the column). The sweep is conservative by design.
        sql`${openclawBots.sessionExpiresAt} IS NOT NULL`,
        lt(openclawBots.sessionExpiresAt, now),
      ),
    );

  if (expired.length === 0) return 0;

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
