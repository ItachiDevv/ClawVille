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
  TOTAL_CHECKPOINTS_PER_RACE,
  type GhostFrame,
  type ServerFrame,
} from '@clawville/shared';
import type { Room, RoomParticipant, SubjectType } from './types';
import {
  maybeUpdatePersonalBest,
  type PbWriteResult,
} from './reef-race-personal-best-service';
import { reefRaceSim } from './sim/reef-race-sim';
import { alertError } from '../alert-error';

/**
 * Phase 4 (S7 fix) — per-recipient match-end delivery callback registered
 * by the WS hub at boot (`apps/api/src/index.ts` calls
 * `setMatchEndDeliveryFn(activityWsHub.sendToAvatar)`). Avoids a hard
 * import of `activity-ws-hub` from this module — that import would pull
 * `activity-room-manager` and the `activityLog` schema chain into every
 * reward-pipeline test that mocks `@clawville/database`. When unset
 * (e.g. tests that don't register), per-recipient delivery is silently
 * skipped — the base sim's broadcast generic match-end frame still fires.
 */
type MatchEndDeliveryFn = (
  roomId: string,
  avatarId: string,
  frame: ServerFrame,
) => void;
let matchEndDeliveryFn: MatchEndDeliveryFn = () => {
  /* no-op until WS hub registers in index.ts boot */
};
export function setMatchEndDeliveryFn(fn: MatchEndDeliveryFn): void {
  matchEndDeliveryFn = fn;
}

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
  /**
   * Reef Race Phase 4 (C3 fix) — per-avatar best lap + ghost frames + best
   * streak embedded by `reefRaceSim.computeResults()` BEFORE sim
   * teardown. The reward pipeline reads from THIS object — never from a
   * live `state.bodies` accessor that could race `endRound()`.
   *
   * `bestLapMs` is null when the avatar never completed a clean lap (DNF
   * before the first lap-up). `ghostReplayFrames` mirrors `bestLapMs`
   * nullity. `bestStreakThisMatch` is the high-water mark across the
   * entire match.
   */
  reefRace?: {
    bestLapMs: number | null;
    ghostReplayFrames: GhostFrame[] | null;
    bestStreakThisMatch: number;
    currentStreakAtMatchEnd: number;
  };
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
  /** True when this participant is an un-authed guest (carve-out flag) */
  isGuest: boolean;
  /**
   * Reef Race Phase 4 — match-end PB delta data plumbed back into the
   * per-recipient `event.match_ended` frame. Set when this avatar's just-
   * completed match LOWERED their PB lap (improved=true from the awaited
   * `maybeUpdatePersonalBest`). `newGhostFrames` is included for the
   * PB-setter — the WS hub gates further per-recipient (S7 fix).
   */
  pbDelta?: {
    newMs: number;
    oldMs: number | null;
    dailyRank: number | null;
    newGhostFrames?: GhostFrame[];
  };
  /**
   * Reef Race Phase 4 — best consecutive clean checkpoint crosses this
   * match. Always present for Reef Race; undefined for other activities.
   */
  streakBest?: number;
  /** Reef Race Phase 4 — perfect-race tokens credited (0 when not earned). */
  perfectLapBonus?: number;
}

export interface RewardBreakdown {
  base: number;
  participationFloor: boolean;
  firstPlayOfDayBonus: number;
  personalBestBonus: number;
  /**
   * Reef Race Phase 4 — perfect-race bonus credited when bestStreakThisMatch
   * reached TOTAL_CHECKPOINTS_PER_RACE (= 36). 0 otherwise. Sums into the
   * same tokens_awarded total as the other lines.
   */
  perfectStreakBonus: number;
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
  avatarFlags: Record<string, unknown> | null | undefined,
  activityId: string,
): boolean {
  const def = getActivityDefinition(activityId);
  if (!def?.skillBuildingMatches?.length) return false;
  const focus = avatarFlags?.learningFocus;
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

interface AvatarContext {
  flags: Record<string, unknown> | null;
  /** Earliest `created_at` for this avatar+activity scoped to today (UTC) */
  todayCount: number;
  /** Best (lowest) score_ms recorded for this avatar on this activity prior */
  priorBestMs: number | null;
  /**
   * True when this avatar belongs to a guest user (un-authed visitor who
   * auto-created via POST /api/auth/guest). Guest all-demo economy (founder
   * ruling 2026-07-06): guests earn NEITHER real ClawTokens NOR leaderboard
   * points — `tokensAwarded` AND `leaderboardPoints` are both forced to 0,
   * exactly like the `subjectType='bot'` carve-out (different trigger). A real
   * account is required to earn to the real CT ledger.
   */
  isGuest: boolean;
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
  const avatarContexts = await loadAvatarContexts(avatarIds, room.activityId, participants);

  const issued: IssuedResult[] = [];

  // ── Phase 4 (C2 fix) — PB writes happen OUTSIDE the rewards transaction.
  // Rationale: PB-write failure must NOT roll back the actual reward credit
  // (token ledger). Awaiting per-avatar (Promise.all bounded by ≤8) keeps
  // total wall-clock <50 ms even when every avatar improves.
  //
  // Anti-cheat skip (§4.4): avatars with ≥1 anti-cheat flag this match have
  // their PB write skipped — trades a small honest-mistake recall for
  // ironclad cheater exclusion (there's always tomorrow's PB).
  //
  // Bot skip: `subjectType === 'bot'` short-circuits — bots never set PBs
  // by design.
  const pbWritesByAvatar = new Map<string, PbWriteResult>();
  if (room.activityId === 'reef-race') {
    const pbCandidates = simResults.filter((s) => {
      const participant = participants.get(s.avatarId);
      if (!participant || participant.subjectType === 'bot') return false;
      const reef = s.reefRace;
      if (!reef || reef.bestLapMs == null) return false;
      // Anti-cheat skip — flagged matches don't set PBs.
      const flags = reefRaceSim.getFlagCount(room.id, s.avatarId);
      if (flags > 0) return false;
      return true;
    });
    const pbResults = await Promise.allSettled(
      pbCandidates.map(async (s) => {
        const reef = s.reefRace!;
        const result = await maybeUpdatePersonalBest({
          avatarId: s.avatarId,
          activityId: 'reef-race',
          newBestLapMs: reef.bestLapMs!,
          ghostReplayData: { frames: reef.ghostReplayFrames ?? [] },
          sourceRoomId: room.id,
        });
        return { avatarId: s.avatarId, result };
      }),
    );
    for (const settled of pbResults) {
      if (settled.status === 'fulfilled') {
        pbWritesByAvatar.set(settled.value.avatarId, settled.value.result);
      } else {
        // Per spec: PB write failure logs + alerts but doesn't block
        // reward credit. The match-end frame omits pbDelta for the
        // affected avatar so the modal doesn't show a half-truth.
        console.error(
          '[reward-pipeline] PB write failed:',
          settled.reason,
        );
        void alertError({
          severity: 'warning',
          source: 'reward-pipeline',
          message: 'Reef Race PB write failed (non-blocking)',
          context: { roomId: room.id, error: String(settled.reason) },
        });
      }
    }
  }

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

      const ctx = avatarContexts.get(sim.avatarId) ?? {
        flags: null,
        todayCount: 0,
        priorBestMs: null,
        isGuest: false,
      };

      const isBot = participant.subjectType === 'bot';
      const bestStreakThisMatch = sim.reefRace?.bestStreakThisMatch ?? 0;
      const breakdown = computeBreakdown({
        rewardConfig,
        placement: sim.placement,
        scoreMs: sim.scoreMs ?? null,
        priorBestMs: ctx.priorBestMs,
        todayCount: ctx.todayCount,
        flags: ctx.flags,
        activityId: room.activityId,
        isBot,
        // C3 fix — read from the embedded SimResultRow.reefRace block,
        // NEVER from a live sim accessor.
        bestStreakThisMatch,
      });

      const isPersonalBest =
        sim.scoreMs != null &&
        (ctx.priorBestMs == null || sim.scoreMs < ctx.priorBestMs);

      // Guest all-demo economy (founder ruling 2026-07-06): guests earn NO
      // real CT — a real account is required to earn to the real ledger. So
      // `tokensAwarded` is 0 for guests (same as bots), the credit block below
      // then naturally skips them (no ledger row → no mint), and
      // `activity_results.tokensAwarded` equals what was actually credited (0)
      // — no phantom tokens. Guests already had 0 leaderboardPoints.
      const tokensAwarded = (isBot || ctx.isGuest)
        ? 0
        : breakdown.base +
          breakdown.firstPlayOfDayBonus +
          breakdown.personalBestBonus +
          breakdown.perfectStreakBonus +
          breakdown.focusBonus;
      const leaderboardPoints = isBot || ctx.isGuest
        ? 0
        : computeLeaderboardPoints(rewardConfig, sim.placement);

      const pbWrite = pbWritesByAvatar.get(sim.avatarId);

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
          // Phase 4 — embed best-streak + PB-rank on the per-match row so
          // the /results endpoint can return them without a JOIN. C2 fix:
          // dailyRank sourced from the awaited PB-write result.
          matchBestStreak:
            room.activityId === 'reef-race' ? bestStreakThisMatch : null,
          matchPbDailyRank: pbWrite?.dailyRank ?? null,
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
                perfectStreakBonus: breakdown.perfectStreakBonus,
                focusBonus: breakdown.focusBonus,
              },
            },
          },
          tx,
        );
      }

      // Phase 4 — pbDelta block when the awaited PB write improved.
      // newGhostFrames is included here for the PB-setter; the WS hub
      // strips it for non-self recipients in the per-recipient match-end
      // dispatch (S7 fix — see emitPerRecipientMatchEnd below).
      const pbDelta =
        pbWrite && pbWrite.improved && sim.reefRace?.bestLapMs != null
          ? {
              newMs: sim.reefRace.bestLapMs,
              oldMs: pbWrite.previousMs,
              dailyRank: pbWrite.dailyRank,
              newGhostFrames: pbWrite.newGhostFrames,
            }
          : undefined;

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
        isGuest: ctx.isGuest,
        pbDelta,
        streakBest:
          room.activityId === 'reef-race' ? bestStreakThisMatch : undefined,
        perfectLapBonus:
          room.activityId === 'reef-race'
            ? breakdown.perfectStreakBonus
            : undefined,
      });
    }
  });

  // Phase 4 (S7 fix) — per-recipient `event.match_ended` dispatch. The
  // PB-setter receives their own `newGhostFrames` (~5 KB); rivals receive
  // pbDelta WITHOUT newGhostFrames (~50 bytes). Bandwidth-bounded.
  if (room.activityId === 'reef-race') {
    emitPerRecipientMatchEnd(room, issued);
  }

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
        isGuest: r.isGuest,
      } satisfies ActivityMatchPlacedPayload,
    });
  }

  // Phase 3 (§6, §10) — bot-winrate-by-level-bucket telemetry. Single
  // event per finished reef-race room. Powers the Phase 3.5 graduation
  // gate ("if bots lose 95%+ to level 26-49 / 50 humans, level-match
  // bots"). Without this hook the Phase 3.5 deferral is open-loop —
  // violates the no-scaffolding-theater rule.
  if (room.activityId === 'reef-race' && issued.length > 0) {
    void emitReefRaceBotWinrateEvent(room, issued);
  }

  return issued;
}

/**
 * Phase 3 — race-end telemetry. Bucket the highest-level human in the
 * room and report whether a human took first vs how many bots finished
 * ahead. Fire-and-forget — fetch failure is logged + swallowed.
 *
 * Event payload schema mirrors `.claude/plans/reef-race-phase3-detailed.md`
 * §6: `{ roomId, humanLevelBucket, humanFinished, humanFinishedFirst,
 * botCount, botFinishedAhead }`.
 */
async function emitReefRaceBotWinrateEvent(
  room: Room,
  issued: IssuedResult[],
): Promise<void> {
  try {
    const humanResults = issued.filter((r) => r.subjectType !== 'bot');
    const botResults = issued.filter((r) => r.subjectType === 'bot');
    if (humanResults.length === 0) return; // bot-only room, no signal
    // Pull levels for human avatarIds — bots are skipped (always L1).
    const humanAvatarIds = humanResults.map((r) => r.avatarId);
    const levelRows = await db
      .select({ id: avatars.id, level: avatars.level })
      .from(avatars)
      .where(inArrayWhitelist(avatars.id, humanAvatarIds));
    let highestLevel = 1;
    for (const row of levelRows) {
      const lvl = typeof row.level === 'number' ? row.level : 1;
      if (lvl > highestLevel) highestLevel = lvl;
    }
    const bucket = bucketLevelForBotWinrate(highestLevel);
    // Top placement (lowest placement number) among humans.
    const humanTopPlacement = humanResults.reduce(
      (lo, r) => (r.placement < lo ? r.placement : lo),
      Number.POSITIVE_INFINITY,
    );
    const humanFinishedFirst = humanTopPlacement === 1;
    const botFinishedAhead = botResults.filter(
      (r) => r.placement < humanTopPlacement,
    ).length;
    void logEvent({
      eventType: 'reef_race.bot_winrate.by_level_bucket',
      payload: {
        roomId: room.id,
        humanLevelBucket: bucket,
        humanFinished: humanResults.length,
        humanFinishedFirst,
        botCount: botResults.length,
        botFinishedAhead,
      },
    });
  } catch (err) {
    console.error(
      '[reward-pipeline] reef_race.bot_winrate emit failed:',
      err,
    );
  }
}

function bucketLevelForBotWinrate(
  level: number,
): '1-10' | '11-25' | '26-49' | '50' {
  const lvl = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;
  if (lvl >= 50) return '50';
  if (lvl >= 26) return '26-49';
  if (lvl >= 11) return '11-25';
  return '1-10';
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
  /**
   * Phase 4 — best consecutive clean checkpoint crosses this match. Reef
   * Race only; defaults to 0 for other activities (no behaviour change).
   * C3 fix: read from `SimResultRow.reefRace.bestStreakThisMatch`, NOT
   * from a live sim accessor.
   */
  bestStreakThisMatch?: number;
}): RewardBreakdown {
  if (input.isBot) {
    return {
      base: 0,
      participationFloor: false,
      firstPlayOfDayBonus: 0,
      personalBestBonus: 0,
      perfectStreakBonus: 0,
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

  // Phase 4 — perfect-race bonus. Reef Race only; non-Reef-Race callers
  // pass `bestStreakThisMatch=undefined` and the predicate fails-closed.
  const bestStreak = input.bestStreakThisMatch ?? 0;
  const perfectStreakBonus =
    bestStreak >= TOTAL_CHECKPOINTS_PER_RACE
      ? rewardConfig?.perfectStreakBonusTokens ?? 0
      : 0;

  const subtotal =
    base + firstPlayOfDayBonus + personalBestBonus + perfectStreakBonus;
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
    perfectStreakBonus,
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
): Promise<Map<string, AvatarContext>> {
  if (avatarIds.length === 0) return new Map();

  // Filter out bots — their flags don't drive any reward branching.
  const nonBotAvatarIds = avatarIds.filter((id) => {
    const p = participants.get(id);
    return p?.subjectType !== 'bot';
  });

  const flagsByAvatar = new Map<string, Record<string, unknown> | null>();
  const guestByAvatar = new Map<string, boolean>();
  if (nonBotAvatarIds.length > 0) {
    const flagRows = await db
      .select({ id: avatars.id, flags: avatars.flags, isGuest: avatars.isGuest })
      .from(avatars)
      .where(inArrayWhitelist(avatars.id, nonBotAvatarIds));
    for (const row of flagRows) {
      flagsByAvatar.set(
        row.id,
        (row.flags as Record<string, unknown> | null) ?? null,
      );
      guestByAvatar.set(row.id, !!row.isGuest);
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

  const todayByAvatar = new Map<string, number>();
  for (const row of todayRows) {
    todayByAvatar.set(row.avatarId, Number(row.cnt) || 0);
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

  const bestByAvatar = new Map<string, number | null>();
  for (const row of bestRows) {
    bestByAvatar.set(row.avatarId, row.best ?? null);
  }

  const out = new Map<string, AvatarContext>();
  for (const id of avatarIds) {
    out.set(id, {
      flags: flagsByAvatar.get(id) ?? null,
      todayCount: todayByAvatar.get(id) ?? 0,
      priorBestMs: bestByAvatar.get(id) ?? null,
      isGuest: guestByAvatar.get(id) ?? false,
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

// ─── Phase 4 — per-recipient match-end emit (S7 fix) ─────────────────────

/**
 * Emit `event.match_ended` per recipient WS so each avatar's `pbDelta` can
 * carry their OWN `newGhostFrames` (~5 KB) without broadcasting all
 * recipients' frames to all subscribers (N²-style bandwidth blow-up).
 *
 * For each WS in the room: build a frame with rewardPreview that includes
 * THIS avatar's pbDelta + streakBest + perfectLapBonus, with newGhostFrames
 * stripped for non-self avatar rows. Frames go out via the WS hub's
 * `sendToAvatar` per-recipient path, NOT `broadcastEvent`.
 *
 * The base sim already broadcasts a generic `event.match_ended` at
 * `endRound()` with empty rewardPreview; this Phase-4 emission lands
 * AFTER the reward pipeline writes finish, with authoritative numbers.
 */
function emitPerRecipientMatchEnd(room: Room, issued: IssuedResult[]): void {
  // winners list is the same for every recipient — derived from issued
  // ordered by placement asc.
  const winners = issued
    .slice()
    .sort((a, b) => a.placement - b.placement)
    .map((r) => ({ avatarId: r.avatarId, placement: r.placement }));

  for (const r of issued) {
    // Build the per-recipient pbDelta (strip newGhostFrames for the
    // recipient view — this IS the recipient's own row, so they keep
    // their own frames; rivals would receive nothing here because
    // `r.pbDelta` is undefined for rivals not setting a PB).
    const pbDelta = r.pbDelta
      ? {
          newMs: r.pbDelta.newMs,
          oldMs: r.pbDelta.oldMs,
          dailyRank: r.pbDelta.dailyRank,
          newGhostFrames: r.pbDelta.newGhostFrames,
        }
      : undefined;

    matchEndDeliveryFn(room.id, r.avatarId, {
      type: 'event.match_ended',
      reason: 'complete',
      winners,
      rewardPreview: {
        placement: r.placement,
        tokens: r.tokensAwarded,
        leaderboardPoints: r.leaderboardPoints,
        isPersonalBest: r.isPersonalBest,
        firstPlayOfDayBonus: r.breakdown.firstPlayOfDayBonus > 0,
        focusBonus: r.breakdown.focusBonus > 0,
        pbDelta,
        streakBest: r.streakBest,
        perfectLapBonus: r.perfectLapBonus,
      },
    });
  }
}

// ─── Re-exported registry helpers (for the routes that need them) ─────────

export { ACTIVITY_REGISTRY, getActivityDefinition };
