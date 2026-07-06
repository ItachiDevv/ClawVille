/**
 * Building-reward settle helpers (agent-metaverse P1 slice 4).
 *
 * Extracted VERBATIM (behavior-identical) from the module-local helpers in
 * `routes/agent-gateway.ts` so the autonomous settle path (`world-teacher-chat.ts`,
 * driven by `agent-autonomy-driver.ts`) can share the EXACT once-per-day credit
 * gate the connected-agent gateway uses — identical economics = human/agent/house
 * parity, and one probe means double-dipping across the two paths is impossible
 * (same `claw_token_transactions` key: avatarId + buildingId + reason + UTC-day).
 *
 * DEPENDENCY-LIGHT ON PURPOSE: this module imports NO route modules and NOTHING
 * that transitively pulls the fingerprint middleware — `routes/agent-gateway.ts`
 * throws at module load without `FINGERPRINT_SECRET`, so services the autonomy
 * driver imports must never reach it (same rule as `building-center.ts`).
 */

import { db, avatars, eq, sql } from '@clawville/database';
import { creditClawTokens } from './claw-token-ledger';

// ---------------------------------------------------------------------------
// resolveAvatarIdForBot — map an openclaw_bots.userId to that user's avatars.id
// ---------------------------------------------------------------------------
// CT credits MUST target an `avatars.id` (the ledger row-locks the avatars
// row). A connected agent's `openclaw_bots.id` is NOT an avatars PK — crediting
// it threw "avatar not found" (swallowed), so connected agents never earned CT
// for building visits / teacher chats. This resolves the human's avatar via the
// bot's bound userId. Returns null when the bot is anonymous (no userId) or the
// user has no avatar yet — callers then skip the credit honestly (tokenAwarded
// stays 0) rather than throwing. (2026-06-01, Hatcher Phase A bug fix.)
export async function resolveAvatarIdForBot(botUserId: string | null): Promise<string | null> {
  if (!botUserId) return null;
  const avatar = await db.query.avatars.findFirst({
    where: eq(avatars.userId, botUserId),
    columns: { id: true },
  });
  return avatar?.id ?? null;
}

/**
 * Injectable seams for the once-per-day credit — PRODUCTION callers never pass
 * this (defaults are the real `db.transaction` + `creditClawTokens`); it exists
 * so the unit test can drive the REAL probe→credit gating logic against an
 * in-memory tx without a live DB (the same reason claw-token-ledger's test stubs
 * the db). Behavior with the default deps is byte-identical to the pre-extraction
 * module-local helper in agent-gateway.ts.
 */
export interface BuildingRewardDeps {
  transaction: <T>(fn: (tx: BuildingRewardTx) => Promise<T>) => Promise<T>;
  credit: typeof creditClawTokens;
}

/** The minimal tx surface the helper touches (drizzle tx is a superset). */
export type BuildingRewardTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const defaultDeps: BuildingRewardDeps = {
  transaction: (fn) => db.transaction(fn),
  credit: creditClawTokens,
};

// ---------------------------------------------------------------------------
// creditBuildingRewardOncePerDay — idempotent per-(avatar, building, reason,
// UTC-day) 1-CT building reward (M2 anti-faucet).
// ---------------------------------------------------------------------------
// Both `/visit-building` and `/building/:buildingId/chat` credited 1 CT
// UNCONDITIONALLY, so a ledger-bound agent parked within `BUILDING_INTERACTION_
// RADIUS` could loop the endpoint and farm CT. This gates ONLY the ledger credit
// (NOT `logEventFromContext` — the leaderboard keeps its own daily caps and must
// still record every event). Concurrency-safe: the tx row-locks the SAME
// `avatars` row `creditClawTokens` locks BEFORE the existence check, so two
// simultaneous requests for the same key serialize — the first inserts + commits,
// the second then observes the committed row and returns false (NO double-credit).
// NO legit-visit regression: a DIFFERENT building or a NEW UTC day is a fresh key,
// so distinct visits/chats still each pay once. Returns true iff it credited 1 CT.
export async function creditBuildingRewardOncePerDay(
  opts: {
    avatarId: string;
    buildingId: string;
    reason: 'building_visit' | 'building_chat_teaching';
    metadata: Record<string, unknown>;
  },
  deps: BuildingRewardDeps = defaultDeps,
): Promise<boolean> {
  const startOfUtcDay = new Date();
  startOfUtcDay.setUTCHours(0, 0, 0, 0);
  // ISO string, NOT the Date object: this raw `sql` runs through the postgres-js
  // driver, whose generic param serializer calls `str()` → `Buffer.byteLength()`
  // on the value and THROWS `ERR_INVALID_ARG_TYPE` for a Date ("Received an
  // instance of Date"). Passing the ISO text (postgres casts it to timestamptz in
  // the `created_at >=` comparison) is the driver-safe binding. This threw on
  // EVERY building-visit/chat credit since M2 shipped — a connected agent earned
  // 0 CT for building visits (caught by the OpenClaw e2e harness, 2026-07-02).
  const startOfUtcDayIso = startOfUtcDay.toISOString();
  return deps.transaction(async (tx) => {
    // Row-lock the avatar FIRST (the exact row `creditClawTokens` FOR UPDATEs) so
    // the check-then-credit below is serialized against a concurrent duplicate.
    await tx.execute(sql`SELECT 1 FROM avatars WHERE id = ${opts.avatarId} FOR UPDATE`);
    // Existence probe for today's reward on this (avatar, reason, building). Mirror
    // the `const [row] = await tx.execute<T>(…)` access shape used by the ledger
    // (postgres-js `.execute()` returns a RowList; the first element is the row or
    // undefined). `metadata->>'buildingId'` reads the jsonb text value both credit
    // sites already store.
    const [existing] = await tx.execute<{ present: number }>(sql`
      SELECT 1 AS present FROM claw_token_transactions
      WHERE avatar_id = ${opts.avatarId}
        AND reason = ${opts.reason}
        AND metadata->>'buildingId' = ${opts.buildingId}
        AND created_at >= ${startOfUtcDayIso}
      LIMIT 1`);
    if (existing) return false; // already rewarded for this (avatar, building, reason) today
    await deps.credit(
      {
        avatarId: opts.avatarId,
        amount: 1,
        reason: opts.reason,
        source: 'api',
        metadata: opts.metadata,
      },
      tx,
    );
    return true;
  });
}
