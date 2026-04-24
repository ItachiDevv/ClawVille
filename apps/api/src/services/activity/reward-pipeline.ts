/**
 * Q2 Activity Portals — reward issuance pipeline (chunk #7).
 *
 * The LIVE→RESULTS FSM transition lands here. Per backend §5.1, this
 * module:
 *
 *   1. Pulls the placement list from the activity sim (dependency-injected
 *      via `setComputeResultsFn` in `activity-room-manager` — no hard
 *      import of the sim from here).
 *   2. For each non-bot participant, computes:
 *        base = placement tier OR participation floor
 *        + first-play-of-day bonus (if no prior result row today)
 *        + personal-best bonus (Reef Race only, when `score_ms < min`)
 *        + focus-aligned bonus (+pct% when avatar matches activity's
 *          `skillBuildingMatches[]` — looks at `avatars.flags.learningFocus`)
 *      All four steps execute inside ONE composed DB transaction so a
 *      crash leaves no half-credited rows.
 *   3. Inserts the `activity_results` row + credits via `creditClawTokens`
 *      composed in the same `tx`.
 *   4. Bots: insert `activity_results` with `tokensAwarded=0` +
 *      `leaderboardPoints=0` and DO NOT call `creditClawTokens` — bot
 *      avatarIds belong to the system user; crediting them inflates the
 *      system balance and pollutes the leaderboard. Per chunk #10 carve-
 *      out + backend §8.4.
 *   5. Emits one `activity.match.placed` event per participant (including
 *      bots, with `subjectType='bot'` so leaderboard SQL can filter).
 *
 * The pure-logic helpers (`computePlacementBase`, `computeBonuses`,
 * `applyFocusBonus`) are exported so the test suite can drive them with
 * fixtures without going through the DB.
 */

import { and, eq, gte, lt, sql } from 'drizzle-orm';
import {
  db,
  activityResults,
  avatars,
  type ActivityRewardConfig,
} from '@clawville/database';
import { creditClawTokens } from '../claw-token-ledger';
import { logEvent, ACTIVITY_EVENT_TYPES } from '../event-logger';
import type { ActivityMatchPlacedPayload } from '../event-logger';
import {
  ACTIVITY_REGISTRY,
  getActivityDefinition,
} from '@clawville/shared';
import type { Room, RoomParticipant, SubjectType } from './types';

/**
 * Per-participant placement returned by an activity sim.
 *
 * `score` semantics are activity-specific (Bumper: kills; Reef: -finishMs
 * so DESC sort puts winners first). `scoreMs` is Reef-only and drives the
 * "Fastest" leaderboard tab + personal-best bonus check.
 */
export interface SimResultRow {
  avatarId: string;
  placement: number;
  score: number;
  scoreMs?: number | null;
}

/**
 * Per-result row written + the breakdown surfaced to the WS hub /
 * results route. Mirrors `activity_results` columns plus the bonus
 * breakdown so clients can render "you got X tokens because Y".
 */
export interface IssuedResult {
  resultId: string;
  avatarId: string;
  agentId: string | null;
  subjectType: SubjectType;
  placement: number;
  score: number;
  scoreMs: number | null;
  tokensAwarded: number;
  leaderboardPoints: number;
  isPersonalBest: boolean;
  /** Bonus breakdown for UX — sums to `tokensAwarded` for non-bots */
  breakdown: RewardBreakdown;
}

export interface RewardBreakdown {
  base: number;
  participationFloor: boolean;
  firstPlayOfDayBonus: number;
  personalBestBonus: number;
  focusBonus: number;
  /** Set true when the participant is a bot (no credit, no breakdown line) */
  bot: boolean;
}

// ─── Pure-logic helpers (test-friendly, no DB access) ──────────────────────

/**
 * Pick the placement tier from the reward config. Returns the
 * participation floor when the placement isn't covered by an explicit
 * tier (e.g. 9th in an 8-player game — defensive only).
 */
export function computePlacementBase(
  rewardConfig: ActivityRewardConfig | undefined,
  placement: number,
): { base: number; participationFloor: boolean } {
  const cfg = rewardConfig ?? {};
  const tier = cfg.placements?.find((p) => p.rank === placement);
  if (tier) {
    return { base: tier.tokens, participationFloor: false };
  }
  // Fall through to participation floor (or 0 if no floor configured).
  return {
    base: cfg.participationTokens ?? 0,
    participationFloor: true,
  };
}

/**
 * Apply the focus-aligned multiplier on top of the base + bonus subtotal.
 * Returns just the bonus delta (so it can be summed into the breakdown).
 */
export function computeFocusBonus(
  subtotal: number,
  focusBonusPct: number | undefined,
  isFocusAligned: boolean,
): number {
  if (!isFocusAligned) return 0;
  if (!focusBonusPct || focusBonusPct <= 0) return 0;
  return Math.round((subtotal * focusBonusPct) / 100);
}

/**
 * Map placement → leaderboard points using the activity's
 * `leaderboardPoints` rubric (string keys per the JSONB shape). Falls
 * through to `default` for unranked placements.
 */
export function computeLeaderboardPoints(
  rewardConfig: ActivityRewardConfig | undefined,
  placement: number,
): number {
  const map = rewardConfig?.leaderboardPoints;
  if (!map) return 0;
  const exact = map[String(placement)];
  if (typeof exact === 'number') return exact;
  return typeof map.default === 'number' ? map.default : 0;
}

/**
 * Returns true when the avatar's stored learning focus aligns with the
 * activity's `skillBuildingMatches[]`. Storage convention (forward-
 * compatible): `avatars.flags.learningFocus` (string buildingId). When the
 * column doesn't exist or the flag is missing, returns false — focus
 * bonus simply doesn't fire and tokens stay at the base.
 */
export function isFocusAligned(
  petFlags: Record<string, unknown> | null | undefined,
  activityId: string,
): boolean {
  const def = getActivityDefinition(activityId);
  if (!def?.skillBuildingMatches?.length) return false;
  const focus = petFlags?.learningFocus;
  if (typeof focus !== 'string' || focus.length === 0) return false;
  return def.skillBuildingMatches.includes(focus);
}

// ─── DB-bound side effects ─────────────────────────────────────────────────

type LedgerTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface IssueRewardsInput {
  room: Room;
  /** Sim-derived placement list, sorted by placement ASC */
  simResults: SimResultRow[];
}

interface PetContext {
  flags: Record<string, unknown> | null;
  /** Earliest `created_at` for this avatar+activity scoped to today (UTC) */
  todayCount: number;
  /** Best (lowest) score_ms recorded for this avatar on this activity prior */
  priorBestMs: number | null;
}

/**
 * Issue rewards for a completed room. Writes:
 *   - one `activity_results` row per participant (bots included; tokens=0)
 *   - one `creditClawTokens` ledger entry per non-bot participant whose
 *     reward > 0
 *   - one `activity.match.placed` event per participant
 *
 * Returns the typed breakdown so the room manager / WS hub can broadcast
 * accurate `event.match_ended.rewardPreview` values.
 *
 * Throws on transaction failure — the caller (room manager
 * `persistResultsTransition`) catches + rolls back the FSM transition so
 * the room re-attempts on the next sweeper cycle (no half-credit).
 */
export async function issueRewardsForRoom(
  input: IssueRewardsInput,
): Promise<IssuedResult[]> {
  const { room, simResults } = input;
  const def = getActivityDefinition(room.activityId);
  const rewardConfig = def?.rewardConfig;

  // Pre-fetch per-avatar context so the inner transaction is one round-trip
  // for context + writes. Bots skip the context fetch (no flags lookup
  // needed — their avatar rows belong to the system user).
  const avatarIds = simResults.map((r) => r.avatarId);
  const participants = room.participants;
  const petContexts = await loadAvatarContexts(avatarIds, room.activityId, participants);

  const issued: IssuedResult[] = [];

  // One transaction per match — all credit + result inserts atomic.
  await db.transaction(async (tx) => {
    for (const sim of simResults) {
      const participant = participants.get(sim.avatarId);
      if (!participant) {
        // Sim returned a avatarId not in the room — defensive skip + warn.
        console.warn(
          `[reward-pipeline] sim returned unknown avatarId ${sim.avatarId} for room ${room.id}`,
        );
        continue;
      }

      const ctx = petContexts.get(sim.avatarId) ?? {
        flags: null,
        todayCount: 0,
        priorBestMs: null,
      };

      const isBot = participant.subjectType === 'bot';
      const breakdown = computeBreakdown({
        rewardConfig,
        placement: sim.placement,
        scoreMs: sim.scoreMs ?? null,
        priorBestMs: ctx.priorBestMs,
        todayCount: ctx.todayCount,
        flags: ctx.flags,
        activityId: room.activityId,
        isBot,
      });

      const isPersonalBest =
        sim.scoreMs != null &&
        (ctx.priorBestMs == null || sim.scoreMs < ctx.priorBestMs);

      const tokensAwarded = isBot
        ? 0
        : breakdown.base +
          breakdown.firstPlayOfDayBonus +
          breakdown.personalBestBonus +
          breakdown.focusBonus;
      const leaderboardPoints = isBot
        ? 0
        : computeLeaderboardPoints(rewardConfig, sim.placement);

      // Insert the result row first so we have an id for the breakdown
      // return + the event payload. `returning()` in the same tx avoids
      // a second round-trip.
      const [resultRow] = await tx
        .insert(activityResults)
        .values({
          roomId: room.id,
          activityId: room.activityId,
          avatarId: sim.avatarId,
          agentId: participant.agentId,
          subjectType: participant.subjectType,
          placement: sim.placement,
          score: sim.score,
          scoreMs: sim.scoreMs ?? null,
          tokensAwarded,
          leaderboardPoints,
          isPersonalBest,
        })
        .returning({ id: activityResults.id });

      // Credit tokens for non-bots only. Compose into the same tx so a
      // ledger failure rolls back the result row too.
      if (!isBot && tokensAwarded > 0) {
        await creditClawTokens(
          {
            avatarId: sim.avatarId,
            amount: tokensAwarded,
            reason: 'activity_match_placed',
            source: 'simulation',
            metadata: {
              roomId: room.id,
              activityId: room.activityId,
              placement: sim.placement,
              breakdown: {
                base: breakdown.base,
                firstPlayOfDayBonus: breakdown.firstPlayOfDayBonus,
                personalBestBonus: breakdown.personalBestBonus,
                focusBonus: breakdown.focusBonus,
              },
            },
          },
          tx,
        );
      }

      issued.push({
        resultId: resultRow.id,
        avatarId: sim.avatarId,
        agentId: participant.agentId,
        subjectType: participant.subjectType,
        placement: sim.placement,
        score: sim.score,
        scoreMs: sim.scoreMs ?? null,
        tokensAwarded,
        leaderboardPoints,
        isPersonalBest,
        breakdown,
      });
    }
  });

  // Event emission AFTER the transaction commits so we never log credit
  // for rows that rolled back. logEvent is fire-and-forget.
  for (const r of issued) {
    void logEvent({
      eventType: ACTIVITY_EVENT_TYPES.MATCH_PLACED,
      avatarId: r.avatarId,
      agentId: r.agentId,
      payload: {
        activityId: room.activityId,
        roomId: room.id,
        placement: r.placement,
        score: r.score,
        tokensAwarded: r.tokensAwarded,
        leaderboardPoints: r.leaderboardPoints,
        subjectType: r.subjectType,
      } satisfies ActivityMatchPlacedPayload,
    });
  }

  return issued;
}

/**
 * Centralised breakdown computation used by the issuance loop AND by
 * tests. Returns the additive components — caller sums them for the final
 * tokens value.
 *
 * For bots, every line is forced to 0/false so the same return shape is
 * usable downstream without per-call branching.
 */
export function computeBreakdown(input: {
  rewardConfig: ActivityRewardConfig | undefined;
  placement: number;
  scoreMs: number | null;
  priorBestMs: number | null;
  todayCount: number;
  flags: Record<string, unknown> | null;
  activityId: string;
  isBot: boolean;
}): RewardBreakdown {
  if (input.isBot) {
    return {
      base: 0,
      participationFloor: false,
      firstPlayOfDayBonus: 0,
      personalBestBonus: 0,
      focusBonus: 0,
      bot: true,
    };
  }

  const { rewardConfig } = input;
  const { base, participationFloor } = computePlacementBase(
    rewardConfig,
    input.placement,
  );

  const firstPlayOfDayBonus =
    input.todayCount === 0 ? rewardConfig?.firstPlayOfDayBonusTokens ?? 0 : 0;

  const personalBestBonus =
    input.scoreMs != null &&
    (input.priorBestMs == null || input.scoreMs < input.priorBestMs)
      ? rewardConfig?.personalBestBonusTokens ?? 0
      : 0;

  const subtotal = base + firstPlayOfDayBonus + personalBestBonus;
  const focusBonus = computeFocusBonus(
    subtotal,
    rewardConfig?.focusBonusPct,
    isFocusAligned(input.flags, input.activityId),
  );

  return {
    base,
    participationFloor,
    firstPlayOfDayBonus,
    personalBestBonus,
    focusBonus,
    bot: false,
  };
}

// ─── DB context loaders ────────────────────────────────────────────────────

/**
 * Batch-load per-avatar context for the issuance pass. One pass each for:
 *   - `avatars.flags` (used by focus-bonus check)
 *   - `activity_results.created_at` for "first match today" check
 *   - min(score_ms) for personal-best bonus
 *
 * All lookups are scoped to the room's activityId to keep the working
 * set small. Bot avatars are excluded from the flag fetch (their flags are
 * irrelevant — they don't earn rewards).
 */
async function loadAvatarContexts(
  avatarIds: string[],
  activityId: string,
  participants: Map<string, RoomParticipant>,
): Promise<Map<string, PetContext>> {
  if (avatarIds.length === 0) return new Map();

  // Filter out bots — their flags don't drive any reward branching.
  const nonBotAvatarIds = avatarIds.filter((id) => {
    const p = participants.get(id);
    return p?.subjectType !== 'bot';
  });

  const flagsByPet = new Map<string, Record<string, unknown> | null>();
  if (nonBotAvatarIds.length > 0) {
    const flagRows = await db
      .select({ id: avatars.id, flags: avatars.flags })
      .from(avatars)
      .where(inArrayWhitelist(avatars.id, nonBotAvatarIds));
    for (const row of flagRows) {
      flagsByPet.set(
        row.id,
        (row.flags as Record<string, unknown> | null) ?? null,
      );
    }
  }

  // Today (UTC) bounds for the first-play-of-day check.
  const now = new Date();
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const todayEnd = new Date(todayStart.getTime() + 86_400_000);

  const todayRows = await db
    .select({
      avatarId: activityResults.avatarId,
      cnt: sql<number>`count(*)::int`,
    })
    .from(activityResults)
    .where(
      and(
        eq(activityResults.activityId, activityId),
        inArrayWhitelist(activityResults.avatarId, avatarIds),
        gte(activityResults.createdAt, todayStart),
        lt(activityResults.createdAt, todayEnd),
      ),
    )
    .groupBy(activityResults.avatarId);

  const todayByPet = new Map<string, number>();
  for (const row of todayRows) {
    todayByPet.set(row.avatarId, Number(row.cnt) || 0);
  }

  // Best (lowest non-null) score_ms for personal-best detection. Reef
  // Race only — we still query for any activity since score_ms is null
  // for non-Reef rows, so the min() naturally skips them.
  const bestRows = await db
    .select({
      avatarId: activityResults.avatarId,
      best: sql<number | null>`min(${activityResults.scoreMs})`,
    })
    .from(activityResults)
    .where(
      and(
        eq(activityResults.activityId, activityId),
        inArrayWhitelist(activityResults.avatarId, avatarIds),
      ),
    )
    .groupBy(activityResults.avatarId);

  const bestByPet = new Map<string, number | null>();
  for (const row of bestRows) {
    bestByPet.set(row.avatarId, row.best ?? null);
  }

  const out = new Map<string, PetContext>();
  for (const id of avatarIds) {
    out.set(id, {
      flags: flagsByPet.get(id) ?? null,
      todayCount: todayByPet.get(id) ?? 0,
      priorBestMs: bestByPet.get(id) ?? null,
    });
  }
  return out;
}

/**
 * Tiny indirection so the call sites read with intent and we don't import
 * `inArray` at module top (keeps the import tree small + cleaner test
 * mocks). Identical semantics to drizzle's `inArray`.
 */
function inArrayWhitelist<T>(
  column: T,
  values: readonly string[],
): ReturnType<typeof sql> {
  if (values.length === 0) {
    // Always-false predicate so the SELECT returns 0 rows — never
    // dispatched in practice (caller short-circuits on empty input).
    return sql`false`;
  }
  return sql`${column as unknown as { name: string }} in (${sql.join(
    values.map((v) => sql`${v}`),
    sql.raw(', '),
  )})`;
}

// ─── Re-exported registry helpers (for the routes that need them) ─────────

export { ACTIVITY_REGISTRY, getActivityDefinition };
