/**
 * Tutorial quest qualification + settlement (Land gamification P6).
 *
 * WHY THIS IS A SERVICE AND NOT ROUTE CODE
 * ----------------------------------------
 * The tutorial ladder is claimable from THREE subject paths — a logged-in
 * human, a connected agent bearing `X-Clawville-Agent-Session`, and a
 * user-hosted agent acting autonomously through the `[ACTION:]` executor. The
 * executor is not a Hono context (`dispatchHatcherActions` has no request), so
 * it cannot reuse a route body. Putting BOTH the qualification gate and the
 * settlement here is what makes the three paths provably identical instead of
 * three drifting copies. This mirrors `land-tenure-settlement.ts`.
 *
 * The service is deliberately CONTEXT-FREE: it returns a result and never
 * touches caches, analytics, or broadcasts. Each adapter fires its own
 * post-commit effects, and only on a fresh settlement.
 *
 * TWO RAILS, ONE TRANSACTION
 * --------------------------
 * A quest declares its rail in shared constants. `settleTutorialQuestClaim`
 * dispatches to `creditClawTokens` (legacy corpus) or `creditMaterials` (land
 * quests) and inserts the claim row with the matching column populated and the
 * other left at zero, all in ONE transaction. The DB CHECK
 * `tutorial_claim_single_rail` makes a rewardless or double-railed row
 * unrepresentable, so a future dispatch bug fails loudly rather than paying
 * twice or not at all.
 *
 * IDEMPOTENCY is the unique index on `(avatar_id, quest_id)` (migration 0054),
 * not an application check. The pre-check below is a cheap fast path; the
 * index is the barrier, so a concurrent double-claim still rolls back at
 * INSERT time and is reported as an already-claimed replay.
 */

import { db, sql, tutorialQuestClaims } from '@clawville/database';
import {
  TUTORIAL_QUEST_STATUS,
  getTutorialQuestRewardDetail,
  type TutorialQuestId,
  type TutorialQuestReward,
} from '@clawville/shared';
import { creditClawTokens } from './claw-token-ledger';
import { creditMaterials, readMaterialBalance } from './material-ledger';

/**
 * `big-spender` counts ONLY these `claw_token_transactions.reason` debits: CT
 * that the payer's own avatar spent on goods or services and that left the
 * player economy to the house treasury (each one is paired with a
 * `house_fee_*` treasury credit, or burns when the treasury is unavailable).
 * None of them has a refund path, and none re-debits money already counted
 * under another reason. A split-provenance debit writes one row per tag, each
 * with the same reason, so `SUM(-amount)` recovers the full spend.
 *
 *   buy_book               knowledge book (routes/items.ts)
 *   buy_cosmetic           cosmetic shop, real-CT part only (routes/cosmetics.ts)
 *   land_kit_piece_fee     yard kit piece on the CT rail (land-kit-settlement.ts)
 *   land_structure_upgrade structure level-up (routes/land.ts)
 *   land_parcel_rent       first-week rent, weekly rent, hold upkeep. Rent the
 *                          sweeper draws from a deposit escrow writes NO tenant
 *                          row, so escrow-funded rent is never counted twice.
 *
 * EXCLUDED ON PURPOSE:
 *   - Every wager, stake, or buy-in (cove_*, poker_*, special_event_entry). A
 *     stake can be won back, so counting it would turn a near-free action
 *     into a 50 vCLAW faucet.
 *   - land_service_purchase. It is a peer transfer: the seller gets the full
 *     price back as `land_service_sale` (no rake), so two accounts that buy
 *     each other's listings keep the vCLAW and both qualify. Same faucet as a
 *     wager.
 *   - Refundable escrows and deposits (land_deposit_escrow, land_deposit_topup,
 *     exchange_escrow_*, bounty_escrow, salvage_bounty_funding), redemptions
 *     and clawbacks (earned_redemption, earned_clawback), and house rows.
 *
 * A positive allowlist also excludes every reason built at runtime
 * (`cove_blackjack_stake_delta`, `poker_cash_buy_in`, ...) by construction.
 */
export const BIG_SPENDER_REASONS = [
  'buy_book',
  'buy_cosmetic',
  'land_kit_piece_fee',
  'land_structure_upgrade',
  'land_parcel_rent',
] as const;

/** vCLAW the avatar must spend on {@link BIG_SPENDER_REASONS} to qualify. */
export const BIG_SPENDER_THRESHOLD_CT = 200;

/**
 * Per-quest server-side proof-of-engagement check.
 *
 * Returns:
 *   - { ok: true }                                  → user has met the bar
 *   - { ok: false, pending: true,  reason: '...' }  → feature isn't shipped
 *   - { ok: false, pending: false, reason: '...' }  → user hasn't done it yet
 *
 * The route maps `pending` to error code `pending_feature` (so the client
 * knows to render "coming soon" rather than retry forever) vs the standard
 * `engagement_required` for not-yet-completed live quests.
 *
 * Q3 plan §2.6 + 2026-04-29 redesign — extended for the tutorial ladder (33 quests since 2026-10-22).
 */
export type EngagementResult = { ok: true } | { ok: false; pending: boolean; reason: string };

export async function validateTutorialQuestEngagement(
  userId: string,
  avatarId: string,
  questId: TutorialQuestId,
): Promise<EngagementResult> {
  // Hard-block pending quests — their server emitter doesn't exist yet.
  if (TUTORIAL_QUEST_STATUS[questId] === 'pending') {
    return { ok: false, pending: true, reason: 'feature_not_shipped' };
  }

  async function countEvents(predicate: ReturnType<typeof sql>): Promise<number> {
    const rows = await db.execute<{ c: number }>(sql`
      SELECT COUNT(*)::int AS c FROM events
      WHERE (user_id = ${userId} OR avatar_id = ${avatarId})
        AND ${predicate}
    `);
    return Number(rows[0]?.c ?? 0);
  }

  async function distinctTeacherChats(): Promise<number> {
    const rows = await db.execute<{ c: number }>(sql`
      SELECT COUNT(DISTINCT building_id)::int AS c FROM events
      WHERE event_type = 'agent.chat.turn'
        AND payload->>'chatType' IN ('character','building','location')
        AND (user_id = ${userId} OR avatar_id = ${avatarId})
        AND building_id IS NOT NULL
    `);
    return Number(rows[0]?.c ?? 0);
  }

  async function distinctBuildingsVisited(): Promise<number> {
    const rows = await db.execute<{ c: number }>(sql`
      SELECT COUNT(DISTINCT building_id)::int AS c FROM events
      WHERE event_type = 'building.visited'
        AND (user_id = ${userId} OR avatar_id = ${avatarId})
        AND building_id IS NOT NULL
    `);
    return Number(rows[0]?.c ?? 0);
  }

  async function distinctBookBuildings(): Promise<number> {
    const rows = await db.execute<{ c: number }>(sql`
      SELECT COUNT(DISTINCT payload->>'buildingId')::int AS c FROM events
      WHERE event_type = 'item.purchased'
        AND coalesce(payload->>'isBook','') = 'true'
        AND (user_id = ${userId} OR avatar_id = ${avatarId})
        AND payload->>'buildingId' IS NOT NULL
    `);
    return Number(rows[0]?.c ?? 0);
  }

  async function distinctActivityTypes(): Promise<number> {
    const rows = await db.execute<{ c: number }>(sql`
      SELECT COUNT(DISTINCT payload->>'activityType')::int AS c FROM events
      WHERE event_type = 'activity.match.placed'
        AND (user_id = ${userId} OR avatar_id = ${avatarId})
        AND coalesce(payload->>'subjectType','') <> 'bot'
        AND payload->>'activityType' IS NOT NULL
    `);
    return Number(rows[0]?.c ?? 0);
  }

  const ok = (): EngagementResult => ({ ok: true });
  const fail = (reason: string): EngagementResult => ({ ok: false, pending: false, reason });

  switch (questId) {
    // ── TIER 1 ────────────────────────────────────────────────────────
    case 'say-hi-nori':
      return (await countEvents(
        sql`event_type = 'agent.chat.turn' AND payload->>'chatType' = 'system-agent'`,
      )) >= 1 ? ok() : fail('no_system_chats');

    case 'meet-your-agent':
      return (await countEvents(
        sql`event_type = 'agent.chat.turn' AND payload->>'chatType' = 'avatar'`,
      )) >= 1 ? ok() : fail('no_avatar_chats');

    case 'first-steps':
      return (await countEvents(sql`event_type = 'building.visited'`)) >= 1
        ? ok()
        : fail('no_building_visits');

    // ── TIER 2 ────────────────────────────────────────────────────────
    case 'town-briefing':
      return (await countEvents(
        sql`event_type = 'agent.chat.turn' AND payload->>'chatType' = 'system-agent'`,
      )) >= 3 ? ok() : fail('insufficient_system_chats');

    case 'bonded':
      return (await countEvents(
        sql`event_type = 'agent.chat.turn' AND payload->>'chatType' = 'avatar'`,
      )) >= 5 ? ok() : fail('insufficient_avatar_chats');

    case 'door-knocker': {
      const visits = await countEvents(sql`event_type = 'building.visited'`);
      const teacherChats = await countEvents(
        sql`event_type = 'agent.chat.turn'
            AND payload->>'chatType' IN ('character','building','location')`,
      );
      return visits >= 1 && teacherChats >= 1 ? ok() : fail('compound_unmet');
    }

    // ── TIER 3 ────────────────────────────────────────────────────────
    case 'town-tour': {
      const distinctVisits = await distinctBuildingsVisited();
      const distinctTeachers = await distinctTeacherChats();
      return distinctVisits >= 3 && distinctTeachers >= 2 ? ok() : fail('compound_unmet');
    }

    case 'star-pupil':
      return (await distinctTeacherChats()) >= 5 ? ok() : fail('insufficient_distinct_teachers');

    case 'cartographer':
      return (await distinctBuildingsVisited()) >= 10
        ? ok()
        : fail('insufficient_distinct_buildings');

    // ── TIER 4 ────────────────────────────────────────────────────────
    case 'shop-and-study': {
      const bought = await countEvents(
        sql`event_type = 'item.purchased' AND coalesce(payload->>'isBook','') = 'true'`,
      );
      const learned = await countEvents(sql`event_type = 'book.read'`);
      return bought >= 1 && learned >= 1 ? ok() : fail('compound_unmet');
    }

    case 'inventory-in-action': {
      const bought = await countEvents(sql`event_type = 'item.purchased'`);
      const used = await countEvents(
        sql`event_type IN ('book.read','cosmetic.equipped')`,
      );
      return bought >= 1 && used >= 1 ? ok() : fail('compound_unmet');
    }

    case 'library-card': {
      const buildings = await distinctBookBuildings();
      const learned = await countEvents(sql`event_type = 'book.read'`);
      return buildings >= 3 && learned >= 3 ? ok() : fail('compound_unmet');
    }

    case 'polymath':
      return (await countEvents(sql`event_type = 'book.read'`)) >= 10
        ? ok()
        : fail('insufficient_knowledge');

    // ── TIER 5 ────────────────────────────────────────────────────────
    case 'first-match':
      return (await countEvents(
        sql`event_type = 'activity.match.placed'
            AND coalesce(payload->>'subjectType','') <> 'bot'`,
      )) >= 1 ? ok() : fail('no_matches');

    case 'game-day': {
      const distinctTeachers = await distinctTeacherChats();
      const matches = await countEvents(
        sql`event_type = 'activity.match.placed'
            AND coalesce(payload->>'subjectType','') <> 'bot'`,
      );
      return distinctTeachers >= 2 && matches >= 1 ? ok() : fail('compound_unmet');
    }

    case 'reef-veteran':
      return (await distinctActivityTypes()) >= 2 ? ok() : fail('insufficient_activity_types');

    case 'first-victory':
      return (await countEvents(
        sql`event_type = 'activity.match.placed'
            AND payload->>'placement' = '1'
            AND coalesce(payload->>'subjectType','') <> 'bot'`,
      )) >= 1 ? ok() : fail('no_wins');

    case 'match-maker': {
      const matches = await countEvents(
        sql`event_type = 'activity.match.placed'
            AND coalesce(payload->>'subjectType','') <> 'bot'`,
      );
      const wins = await countEvents(
        sql`event_type = 'activity.match.placed'
            AND payload->>'placement' = '1'
            AND coalesce(payload->>'subjectType','') <> 'bot'`,
      );
      return matches >= 5 && wins >= 1 ? ok() : fail('compound_unmet');
    }

    // ── TIER 6 ────────────────────────────────────────────────────────
    case 'bot-master':
      return (await countEvents(sql`event_type = 'agent.connected'`)) >= 1
        ? ok()
        : fail('no_bot_connection');

    case 'open-house': {
      const connected = await countEvents(sql`event_type = 'agent.connected'`);
      // Bot teacher chats: chatType in (character/building/location)
      // emitted by the agent gateway when an OpenClaw bot speaks. We
      // count distinct buildings here.
      const botChatRows = await db.execute<{ c: number }>(sql`
        SELECT COUNT(DISTINCT building_id)::int AS c FROM events
        WHERE event_type IN ('agent.chat.turn','agent.collaboration.turn')
          AND payload->>'chatType' IN ('character','building','location')
          AND (user_id = ${userId} OR avatar_id = ${avatarId})
          AND building_id IS NOT NULL
      `);
      const distinctBotTeachers = Number(botChatRows[0]?.c ?? 0);
      const matches = await countEvents(
        sql`event_type = 'activity.match.placed'`,
      );
      return connected >= 1 && distinctBotTeachers >= 2 && matches >= 1
        ? ok()
        : fail('compound_unmet');
    }

    // ── TIER 7 ────────────────────────────────────────────────────────
    case 'on-the-board':
      // "Has any leaderboard-scoring event" — any chat / match / building
      // visit / skill_md fetch counts.
      return (await countEvents(
        sql`event_type IN ('agent.chat.turn','agent.collaboration.turn',
                           'building.visited','skill_md.fetched',
                           'activity.match.placed')`,
      )) >= 1 ? ok() : fail('no_scoring_events');

    case 'top-100': {
      // Compute the avatar's current rank in the agents leaderboard (24h
      // window) and check against threshold 100. This is a heavy SQL
      // path — leaderboard.ts already snapshot-caches similar; for
      // tutorial gating we recompute on-demand (per claim, infrequent).
      const rankRows = await db.execute<{ rank: number }>(sql`
        WITH events_window AS (
          SELECT avatar_id FROM events
          WHERE ts > NOW() - INTERVAL '24 hours'
            AND avatar_id IS NOT NULL
        ),
        ranked AS (
          SELECT avatar_id,
                 ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) AS rank
          FROM events_window
          GROUP BY avatar_id
        )
        SELECT rank::int FROM ranked WHERE avatar_id = ${avatarId}
      `);
      const rank = Number(rankRows[0]?.rank ?? 9999);
      return rank > 0 && rank <= 100 ? ok() : fail('rank_too_low');
    }

    case 'building-champion': {
      // Avatar is the top-visited subject for any single building (24h).
      const rows = await db.execute<{ matched: number }>(sql`
        WITH per_building AS (
          SELECT building_id, avatar_id, COUNT(*) AS visits
          FROM events
          WHERE event_type = 'building.visited'
            AND ts > NOW() - INTERVAL '24 hours'
            AND building_id IS NOT NULL
            AND avatar_id IS NOT NULL
          GROUP BY building_id, avatar_id
        ),
        winners AS (
          SELECT building_id, avatar_id,
                 ROW_NUMBER() OVER (PARTITION BY building_id ORDER BY visits DESC) AS rk
          FROM per_building
        )
        SELECT COUNT(*)::int AS matched FROM winners
        WHERE rk = 1 AND avatar_id = ${avatarId}
      `);
      return Number(rows[0]?.matched ?? 0) >= 1 ? ok() : fail('not_top_visitor');
    }

    // ── TIER 8 ────────────────────────────────────────────────────────
    case 'crossover':
      return (await countEvents(
        sql`event_type IN ('portal.scape.crossed','portal.scape.linked')`,
      )) >= 1 ? ok() : fail('no_portal_cross');

    // ── TIER 9 ────────────────────────────────────────────────────────
    case 'full-house': {
      const distinctVisits = await distinctBuildingsVisited();
      const distinctTeachers = await distinctTeacherChats();
      const booksBought = await countEvents(
        sql`event_type = 'item.purchased' AND coalesce(payload->>'isBook','') = 'true'`,
      );
      const learned = await countEvents(sql`event_type = 'book.read'`);
      return distinctVisits >= 10 &&
        distinctTeachers >= 10 &&
        booksBought >= 5 &&
        learned >= 5
        ? ok()
        : fail('compound_unmet');
    }

    case 'elite-trainer': {
      const connected = await countEvents(sql`event_type = 'agent.connected'`);
      const wins = await countEvents(
        sql`event_type = 'activity.match.placed'
            AND payload->>'placement' = '1'
            AND coalesce(payload->>'subjectType','') <> 'bot'`,
      );
      const learned = await countEvents(sql`event_type = 'book.read'`);
      // Reuse top-100 rank check.
      const rankRows = await db.execute<{ rank: number }>(sql`
        WITH events_window AS (
          SELECT avatar_id FROM events
          WHERE ts > NOW() - INTERVAL '24 hours'
            AND avatar_id IS NOT NULL
        ),
        ranked AS (
          SELECT avatar_id,
                 ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) AS rank
          FROM events_window
          GROUP BY avatar_id
        )
        SELECT rank::int FROM ranked WHERE avatar_id = ${avatarId}
      `);
      const rank = Number(rankRows[0]?.rank ?? 9999);
      return connected >= 1 && wins >= 3 && learned >= 10 && rank > 0 && rank <= 100
        ? ok()
        : fail('compound_unmet');
    }

    // ── TIER 10 — HOMESTEAD (land) ─────────────────────────────────────
    // These read canonical land STATE, not event counts. "Do you own a parcel
    // RIGHT NOW", not "did a purchase event ever fire" — so a claim cannot be
    // farmed by buying and releasing, and a lapsed tenancy correctly stops
    // qualifying. Ownership is by AVATAR, which is what makes these identical
    // for a human and for an agent playing as itself.
    case 'homesteader': {
      const rows = await db.execute<{ n: number | string }>(sql`
        SELECT count(*)::int AS n FROM land_parcels WHERE owner_avatar_id = ${avatarId}
      `);
      return Number(rows[0]?.n ?? 0) >= 1 ? ok() : fail('no_parcel_held');
    }
    case 'first-nail': {
      const rows = await db.execute<{ n: number | string }>(sql`
        SELECT count(*)::int AS n FROM land_structures
        WHERE owner_avatar_id = ${avatarId} AND status = 'active'
      `);
      return Number(rows[0]?.n ?? 0) >= 1 ? ok() : fail('no_structure_placed');
    }
    case 'yard-work': {
      // Six pieces standing at once, not six placements ever made. Removing a
      // piece un-qualifies you, which is the point: the reward is for the yard
      // existing, and removal is free.
      const rows = await db.execute<{ n: number | string }>(sql`
        SELECT count(*)::int AS n FROM land_structure_pieces
        WHERE owner_avatar_id = ${avatarId}
      `);
      return Number(rows[0]?.n ?? 0) >= 6 ? ok() : fail('yard_under_six_pieces');
    }
    case 'curb-appeal': {
      const rows = await db.execute<{ lvl: number | string | null }>(sql`
        SELECT max(level)::int AS lvl FROM land_structures
        WHERE owner_avatar_id = ${avatarId} AND status = 'active'
      `);
      return Number(rows[0]?.lvl ?? 0) >= 2 ? ok() : fail('no_structure_at_level_2');
    }

    // ── 2026-10-22 quests wire (founder decision) ──────────────────────
    case 'style-statement': {
      // Emitters: cosmetic.purchased (POST /api/cosmetics/:skuId/buy) and
      // cosmetic.equipped (POST /api/cosmetics/:skuId/equip). Both run under
      // requireAuthOrAgentSession, so a human and an agent both qualify. A buy
      // paid fully from the cosmetic-only signup credit counts on purpose:
      // that is the new player's intended first purchase (Codex review
      // 2026-10-22, kept; the reward is once per avatar like every quest).
      const bought = await countEvents(sql`event_type = 'cosmetic.purchased'`);
      if (bought < 1) return fail('no_cosmetic_purchase');
      const equippedCount = await countEvents(sql`event_type = 'cosmetic.equipped'`);
      return equippedCount >= 1 ? ok() : fail('no_cosmetic_equipped');
    }

    case 'big-spender': {
      // Ledger state, not events: the debit row is the proof of spend. Keyed
      // by avatar, which is the settlement subject for both humans and agents.
      // Compared in SQL: SUM(integer) is bigint, and narrowing it to int would
      // throw for a lifetime spend above 2^31 instead of qualifying.
      const rows = await db.execute<{ qualified: boolean }>(sql`
        SELECT COALESCE(SUM(-amount::bigint), 0) >= ${BIG_SPENDER_THRESHOLD_CT} AS qualified
        FROM claw_token_transactions
        WHERE avatar_id = ${avatarId}
          AND amount < 0
          AND reason IN (${sql.join(
            BIG_SPENDER_REASONS.map((reason) => sql`${reason}`),
            sql`, `,
          )})
      `);
      return rows[0]?.qualified === true ? ok() : fail('insufficient_goods_spend');
    }

    case 'wallet-aware':
      // Emitter: GET /api/wallet/balances, once per avatar.
      return (await countEvents(sql`event_type = 'wallet.viewed'`)) >= 1
        ? ok()
        : fail('no_wallet_view');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Settlement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHO is claiming. Resolved by the caller — `requireAuthOrAgentSession` on the
 * REST path, the live agent-session resolver on the executor path. Both land on
 * ONE bound avatar, which is the settlement subject.
 */
export interface TutorialClaimActor {
  readonly kind: 'user' | 'agent';
  /** Always present in practice; the claim row keeps it for cross-reference. */
  readonly userId: string;
  readonly avatarId: string;
}

export interface TutorialClaimSettled {
  readonly kind: 'settled';
  readonly fresh: true;
  readonly questId: string;
  readonly reward: TutorialQuestReward;
  /** Balance OF THE CREDITED RAIL — vCLAW or materials, never a mix. */
  readonly balanceAfter: number;
  /** vCLAW only. Always null on the materials rail. */
  readonly ledgerId: string | null;
}

export interface TutorialClaimAlreadyClaimed {
  readonly kind: 'already_claimed';
  readonly fresh: false;
  readonly questId: string;
  readonly reward: TutorialQuestReward;
  readonly balanceAfter: number;
}

export interface TutorialClaimUnknownQuest {
  readonly kind: 'unknown_quest';
  readonly questId: string;
}

export interface TutorialClaimNotQualified {
  readonly kind: 'not_qualified';
  readonly questId: string;
  /** True when the quest gates an unshipped feature rather than unmet effort. */
  readonly pending: boolean;
  readonly reason: string;
}

/**
 * Discriminated on `kind` with ONE literal per member, so a caller that handles
 * three of the four outcomes fails to compile rather than silently falling
 * through on the fourth.
 */
export type TutorialClaimOutcome =
  | TutorialClaimSettled
  | TutorialClaimAlreadyClaimed
  | TutorialClaimUnknownQuest
  | TutorialClaimNotQualified;

/** Current balance of a rail, for reporting an already-claimed replay. */
async function readRailBalance(
  avatarId: string,
  rail: TutorialQuestReward['kind'],
): Promise<number> {
  if (rail === 'materials') return readMaterialBalance(avatarId);
  const rows = await db.execute<{ claw_tokens: number | string }>(
    sql`SELECT claw_tokens FROM avatars WHERE id = ${avatarId}`,
  );
  return Number(rows[0]?.claw_tokens ?? 0);
}

/** Postgres error code off a driver error, including a wrapped `cause`. */
function pgErrorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (err as { cause?: { code?: unknown } }).cause;
  if (cause && typeof cause.code === 'string') return cause.code;
  return null;
}

/**
 * Qualify and settle one tutorial quest for one avatar.
 *
 * Identical for every subject path. `validateEngagement` defaults to the real
 * gate above; it is a parameter only so a test can drive settlement without
 * fabricating a full engagement history.
 */
export async function settleTutorialQuestClaim(input: {
  readonly actor: TutorialClaimActor;
  readonly questId: string;
  readonly validateEngagement?: (
    userId: string,
    avatarId: string,
    questId: TutorialQuestId,
  ) => Promise<EngagementResult>;
}): Promise<TutorialClaimOutcome> {
  const { actor, questId } = input;
  const reward = getTutorialQuestRewardDetail(questId);
  if (!reward) return { kind: 'unknown_quest', questId };
  // A zero (or negative, or fractional) reward would write 0/0 and violate
  // `tutorial_claim_single_rail` as SQLSTATE 23514 — an uncaught 500 rather
  // than a refusal. Every shipping reward is >= 5, so this is latent; refuse it
  // here as a malformed catalog entry instead of discovering it in production.
  if (!Number.isInteger(reward.amount) || reward.amount <= 0) {
    console.error(
      `[tutorial-quest] quest "${questId}" declares a non-positive reward (${reward.amount}) — refusing`,
    );
    return { kind: 'unknown_quest', questId };
  }

  // Cheap pre-check. The unique index is the authority; this only avoids
  // running the full validator and transaction when we know they will fail.
  const priorRows = await db.execute<{
    tokens_credited: number | string;
    materials_credited: number | string;
  }>(
    sql`SELECT tokens_credited, materials_credited FROM tutorial_quest_claims
        WHERE avatar_id = ${actor.avatarId} AND quest_id = ${questId}
        LIMIT 1`,
  );
  if (priorRows[0]) {
    return {
      kind: 'already_claimed',
      fresh: false,
      questId,
      reward,
      balanceAfter: await readRailBalance(actor.avatarId, reward.kind),
    };
  }

  const validate = input.validateEngagement ?? validateTutorialQuestEngagement;
  const engagement = await validate(
    actor.userId,
    actor.avatarId,
    questId as TutorialQuestId,
  );
  if (!engagement.ok) {
    return {
      kind: 'not_qualified',
      questId,
      pending: engagement.pending,
      reason: engagement.reason,
    };
  }

  try {
    return await db.transaction(async (tx) => {
      let balanceAfter: number;
      let ledgerId: string | null = null;

      if (reward.kind === 'vclaw') {
        const ledger = await creditClawTokens(
          {
            avatarId: actor.avatarId,
            amount: reward.amount,
            reason: 'tutorial_quest', // Q3 plan §0 L6 locked decision
            source: 'quest',
            metadata: { questId, tutorial: true },
            actorKind: actor.kind === 'user' ? 'human' : 'agent',
          },
          tx,
        );
        balanceAfter = ledger.balanceAfter;
        ledgerId = ledger.ledgerId;
      } else {
        const credit = await creditMaterials(
          {
            avatarId: actor.avatarId,
            amount: reward.amount,
            reason: 'tutorial_quest_land',
            source: 'quest',
          },
          tx,
        );
        balanceAfter = credit.balanceAfter;
      }

      await tx.insert(tutorialQuestClaims).values({
        userId: actor.userId,
        avatarId: actor.avatarId,
        questId,
        tokensCredited: reward.kind === 'vclaw' ? reward.amount : 0,
        materialsCredited: reward.kind === 'materials' ? reward.amount : 0,
        ledgerId,
      });

      return {
        kind: 'settled' as const,
        fresh: true as const,
        questId,
        reward,
        balanceAfter,
        ledgerId,
      };
    });
  } catch (err) {
    // The unique index fired: a concurrent claim won. Report the replay rather
    // than the raw conflict — the caller's contract is "one effect, ever".
    // 23514 = check_violation. Reaching it means the catalog and the DB
    // disagree about what a valid reward is; surface it loudly rather than as
    // an opaque 500, but do NOT treat it as a replay — nothing was written.
    if (pgErrorCode(err) === '23514') {
      console.error(
        `[tutorial-quest] claim for "${questId}" violated a reward CHECK constraint`,
      );
      return { kind: 'unknown_quest', questId };
    }
    if (pgErrorCode(err) === '23505') {
      return {
        kind: 'already_claimed',
        fresh: false,
        questId,
        reward,
        balanceAfter: await readRailBalance(actor.avatarId, reward.kind),
      };
    }
    throw err;
  }
}