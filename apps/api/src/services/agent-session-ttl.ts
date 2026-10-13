/**
 * Agent session TTL math + the PROTOCOL 85 header-authed slide.
 *
 * Split out of `agent-session-sweeper.ts` (which re-exports everything here)
 * so request-path modules (middleware, cove resolvers, Nori chat, world
 * presence, skills) can slide the TTL without importing the sweeper's
 * orchestrator / autonomy-driver / webhook graph.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db, agentBots, avatars, users } from '@clawville/database';
import { sha256Hex } from './session-digest';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Override the TTL via env for load tests or shorter-lived environments. */
export function resolveTtlMs(): number {
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
 * Throttle window for `slideAgentSessionTtl`. A polled header-authed route
 * (arena `/me/*`, activity status, wallet reads) can fire many times a minute;
 * one TTL write per bearer per minute is enough to keep a 24h window alive.
 */
export const SESSION_SLIDE_THROTTLE_MS = 60_000;

/** The throttle never reaches the TTL: a short test TTL (min 60 s) still renews. */
export function sessionSlideThrottleMs(): number {
  return Math.min(SESSION_SLIDE_THROTTLE_MS, Math.floor(resolveTtlMs() / 4));
}
const SESSION_SLIDE_MAX_ENTRIES = 10_000;
/** Key `${agentId}:${bearerHash}`; insertion order = recency (re-set on write). */
const lastSlideAtByBearer = new Map<string, number>();

function rememberSlide(key: string, now: number): void {
  if (lastSlideAtByBearer.size >= SESSION_SLIDE_MAX_ENTRIES) {
    for (const [k, at] of lastSlideAtByBearer) {
      if (now - at >= sessionSlideThrottleMs()) lastSlideAtByBearer.delete(k);
    }
    // Still full: drop the oldest entries only (Map iterates in insertion
    // order), so recent bearers keep their per-minute guarantee.
    for (const k of lastSlideAtByBearer.keys()) {
      if (lastSlideAtByBearer.size < SESSION_SLIDE_MAX_ENTRIES) break;
      lastSlideAtByBearer.delete(k);
    }
  }
  lastSlideAtByBearer.delete(key);
  lastSlideAtByBearer.set(key, now);
}

/**
 * The slide's own conditional UPDATE. Unlike `extendSessionTtl` (agentId-only,
 * clears `sessionSweptAt`), it writes ONLY when, at write time:
 *   - the row is still live (`session_expires_at > now`), so a request validated
 *     just before `/disconnect`, `expireSession` or the sweep can never revive
 *     the row; and
 *   - the row's `session_key_hash` equals the hash of the CALLER's bearer, so a
 *     request validated just before a bearer rotation (connect / reconnect /
 *     partner register) can never extend the replacement session; and
 *   - the row's owner is not a guest user (a guest-owned agent never slides).
 * A row with a NULL hash never matches (SQL `NULL = x` is not true). That is a
 * deliberate fail-closed choice: a null hash cannot be tied to this bearer, so
 * the slide cannot prove it extends the caller's own session. Null-hash sessions
 * (a partner register before its non-fatal hash persist) keep the gateway
 * `/:sessionId/*` slide. `sessionSweptAt` is left alone: a row with a future
 * expiry was either never swept or was reset by the connect/extend that made it
 * live, so this path has nothing to clear.
 * Returns the number of rows written (0 or 1).
 */
export async function slideLiveSessionTtl(agentId: string, bearerHash: string): Promise<number> {
  // Lock first, then check (Codex rounds 2-4). The row lock is taken BEFORE the
  // liveness predicate runs, so a wait behind another holder (a lock-only
  // transaction or a rolled-back UPDATE resumes without re-checking the WHERE)
  // can never let a pre-wait check pass for a row that expired during the wait.
  // `clock_timestamp()` is the database WRITE time, not helper-entry time and
  // not `now()` (transaction start).
  const ttlMs = resolveTtlMs();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select 1 from ${agentBots} where ${agentBots.agentId} = ${agentId} for update`,
    );
    const rows = await tx
      .update(agentBots)
      .set({
        sessionExpiresAt: sql`clock_timestamp() + (${ttlMs}::double precision * interval '1 millisecond')`,
        lastSeenAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(agentBots.agentId, agentId),
          eq(agentBots.sessionKeyHash, bearerHash),
          sql`${agentBots.sessionExpiresAt} > clock_timestamp()`,
          // The owner still has an active avatar (the skills-read and
          // world-presence callers do no avatar lookup of their own).
          sql`exists (select 1 from ${avatars} where ${avatars.userId} = ${agentBots.userId} and ${avatars.isActive} = true)`,
          // Backstop for callers that skip the per-request guest lookup (world
          // presence, skills reads): a guest-owned row never slides here.
          sql`not exists (select 1 from ${users} where ${users.id} = ${agentBots.userId} and ${users.isGuest} = true)`,
        ),
      )
      .returning({ id: agentBots.id });
    return rows.length;
  });
}

/**
 * Header-authed TTL slide (2026-10-13, PROTOCOL 85). Called AFTER the caller's
 * OWN `X-Clawville-Agent-Session` bearer passed `resolveAgentSession` and is a
 * ledger-capable (owner-proven, non-guest) session bound to a user + avatar:
 * `requireAuthOrAgentSession`, the self-resolving cove / special-events / wager
 * / support subject resolvers, and the other caller-own header paths. Never call
 * it from `resolveAgentSession` itself: that helper also looks up OTHER sessions
 * (appearance target lookups, binding revalidation), and a viewer must never
 * extend someone else's session.
 *
 * Fire-and-forget: returns void, never throws, never blocks the request.
 * Skips the DB write when the same bearer slid within the throttle window.
 */
export function slideAgentSessionTtl(
  agentId: string,
  sessionId: string,
  now: number = Date.now(),
): void {
  try {
    if (!agentId || !sessionId) return;
    const bearerHash = sha256Hex(sessionId);
    const key = `${agentId}:${bearerHash}`;
    const last = lastSlideAtByBearer.get(key);
    if (last !== undefined && now - last < sessionSlideThrottleMs()) return;
    rememberSlide(key, now);
    void slideLiveSessionTtl(agentId, bearerHash).catch((err) => {
      // A failed write must not hold the throttle window: free this bearer's
      // stamp (only if no newer attempt replaced it) so the next call retries.
      if (lastSlideAtByBearer.get(key) === now) lastSlideAtByBearer.delete(key);
      console.warn(`[SessionSweeper] Header-authed TTL slide failed for ${agentId}:`, err);
    });
  } catch (err) {
    console.warn(`[SessionSweeper] Header-authed TTL slide failed for ${agentId}:`, err);
  }
}

/** Test hook: forget every throttle entry. */
export function __resetSessionSlideThrottleForTests(): void {
  lastSlideAtByBearer.clear();
}

/**
 * PROTOCOL 85 slide for callers that validate the CALLER's own bearer with
 * `validateLiveAgentSession` directly (world presence, skills reads) instead of
 * `resolveAgentSession`. Applies the owner rule `resolveAgentSession` uses for a
 * ledger-capable owner: the session config is ledger-capable and its
 * `boundUserId` equals the row's CURRENT `userId` (both non-null). The guest
 * demotion is enforced inside the conditional UPDATE (`slideLiveSessionTtl`).
 * Fire-and-forget, throttled, never throws.
 */
export function slideOwnLiveAgentSession(
  live: {
    config: { agentId: string; ledgerCapable?: boolean | null; boundUserId?: string | null };
    bot: { userId: string | null };
  },
  sessionId: string,
): void {
  const rowUserId = live.bot.userId ?? null;
  if (live.config.ledgerCapable !== true) return;
  if (rowUserId === null || (live.config.boundUserId ?? null) !== rowUserId) return;
  slideAgentSessionTtl(live.config.agentId, sessionId);
}
