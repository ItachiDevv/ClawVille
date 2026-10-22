/**
 * Bounded, server-derived "which quests can I claim right now" projection for
 * hosted cognition.
 *
 * WHY THIS EXISTS. The decide prompt already renders the full action menu, so
 * `claim_tutorial_quest(questId=<listed claimable quest id>)` reaches the
 * deciding LLM — but nothing told it which ids are VALID. The manual names only
 * the four land quests, leaving 29 of 33 to guesswork. Under the world-scope
 * consumption mandate an action whose parameter space is invisible is the same
 * defect class as an action missing from the menu: the verb is reachable and
 * unusable.
 *
 * Closed field list, no player prose, hard row cap. Mirrors
 * `autonomous-land-targets.ts` deliberately — same shape, same fail-soft
 * contract at the caller.
 */

import { db, sql } from '@clawville/database';
import {
  TUTORIAL_QUESTS,
  TUTORIAL_QUEST_RAILS,
  type TutorialQuestId,
} from '@clawville/shared';

/** Keep the prompt block small; the agent claims one quest per decision anyway. */
const TARGET_LIMIT = 6;

/**
 * Quests whose proof a hosted agent can produce with its own [ACTION:] verbs
 * (the verb that does it is in the comment). Closed list, checked against the
 * validators in `tutorial-quest-settlement.ts`. The others need a human-only
 * surface (book shop, activity matches, connecting a bot, the 'scape portal,
 * placing a structure) or are passive (leaderboard rank).
 */
const HOSTED_ACTIONABLE_QUEST_IDS: ReadonlySet<string> = new Set([
  'say-hi-nori', // chat_nori
  'town-briefing', // chat_nori x3
  'first-steps', // enter_building (arrival records building.visited)
  'door-knocker', // enter_building + teacher talk on arrival
  'town-tour', // enter_building + teacher talk
  'star-pupil', // teacher talk at 5 buildings
  'cartographer', // enter_building x10
  'style-statement', // buy_cosmetic + equip_cosmetic
  'big-spender', // buy_cosmetic / claim_parcel rent / place_kit_piece (ledger debits)
  'wallet-aware', // view_wallet
  'homesteader', // claim_parcel
  'yard-work', // place_kit_piece x6
]);

/**
 * ORDERING RULE (why not array order): TUTORIAL_QUESTS is tier-sorted and tier
 * 4 alone has six live quests, so "first 6 unclaimed" filled the whole block
 * with tier 4 once tiers 1-3 were claimed, and wallet-aware (tier 8) or the
 * land quests never showed. Now:
 *   0. READY quests (proof already met, readiness cache below) come first;
 *   1. then the not-ready quests the agent can act on
 *      (HOSTED_ACTIONABLE_QUEST_IDS), then the rest;
 *   2. inside each group, round-robin by tier: the first unclaimed quest of
 *      each tier (lowest tier first), then the second of each tier, and so on.
 * So six slots span up to six tiers, and an easy quest in a low tier still
 * comes before a harder one in the same tier. One claims query, at most one
 * readiness pass per avatar per 60 s, and an in-memory sort of 33 rows.
 */
function roundRobinByTier<T extends { tier: number }>(items: readonly T[]): T[] {
  const byTier = new Map<number, T[]>();
  for (const item of items) {
    const bucket = byTier.get(item.tier);
    if (bucket) bucket.push(item);
    else byTier.set(item.tier, [item]);
  }
  const tiers = [...byTier.keys()].sort((a, b) => a - b);
  const ordered: T[] = [];
  for (let round = 0; ordered.length < items.length; round++) {
    for (const tier of tiers) {
      const item = byTier.get(tier)![round];
      if (item) ordered.push(item);
    }
  }
  return ordered;
}

export interface AutonomousQuestTarget {
  questId: string;
  title: string;
  rail: 'vclaw' | 'materials';
  reward: number;
  /** What the server still needs to see before it will settle this one. */
  requirement: string;
  /**
   * True when the real settlement gate (`validateTutorialQuestEngagement`)
   * already passes for this avatar, so a claim now should settle. Checked only
   * for HOSTED_ACTIONABLE_QUEST_IDS; up to 60 s stale (cache below).
   */
  ready: boolean;
}

/** Same shape as `validateTutorialQuestEngagement`; injectable for tests. */
export type QuestReadinessValidator = (
  userId: string,
  avatarId: string,
  questId: TutorialQuestId,
) => Promise<{ ok: boolean }>;

/**
 * READINESS CACHE (2026-10-22). Staging: the hosted model claimed unfinished
 * quests five times in three minutes (`not_qualified`) while two quests whose
 * proof it already had sat unclaimed, because this list carried no readiness.
 * The prompt is rebuilt every decide (~30 s) for each user agent, and one
 * readiness pass is up to 12 validator calls, so the result is cached per
 * avatar for 60 s in a bounded Map. A stale READY flag costs one refused claim
 * (the executor re-runs the same gate); a stale not-ready flag delays a claim
 * by at most 60 s.
 */
const READINESS_TTL_MS = 60_000;
const READINESS_CACHE_MAX = 500;
const readinessCache = new Map<string, { userId: string; atMs: number; readyIds: ReadonlySet<string> }>();

/** Test hook: forget every cached readiness result. */
export function clearAutonomousQuestReadinessCache(): void {
  readinessCache.clear();
}

const defaultReadinessValidator: QuestReadinessValidator = async (userId, avatarId, questId) => {
  // Lazy: the settlement module pulls the ledgers; this reader stays light.
  const { validateTutorialQuestEngagement } = await import('./tutorial-quest-settlement');
  return validateTutorialQuestEngagement(userId, avatarId, questId);
};

/**
 * The unclaimed hosted-actionable quests whose real gate passes. Fail soft:
 * a validator error makes that quest not ready and never throws out.
 */
async function readQuestReadiness(input: {
  avatarId: string;
  userId: string;
  claimedIds: ReadonlySet<string>;
  validate: QuestReadinessValidator;
  nowMs: number;
}): Promise<ReadonlySet<string>> {
  const cached = readinessCache.get(input.avatarId);
  if (cached && cached.userId === input.userId && input.nowMs - cached.atMs < READINESS_TTL_MS) {
    return cached.readyIds;
  }
  const candidates = TUTORIAL_QUESTS.filter(
    (quest) => quest.status === 'live'
      && HOSTED_ACTIONABLE_QUEST_IDS.has(quest.id)
      && !input.claimedIds.has(quest.id),
  );
  // SEQUENTIAL on purpose: the DB pool (DB_POOL_MAX=30 on prod) is shared by
  // everything, and up to 12 user agents can miss the cache in one tick. Twelve
  // small checks in a row, once per avatar per 60 s, hold one connection at a
  // time instead of twelve.
  const ready = new Set<string>();
  for (const quest of candidates) {
    try {
      const result = await input.validate(input.userId, input.avatarId, quest.id as TutorialQuestId);
      if (result.ok === true) ready.add(quest.id);
    } catch {
      // A failed check is "not ready"; never throws out of the reader.
    }
  }
  const readyIds: ReadonlySet<string> = ready;
  // Bounded: re-set moves the key to the end, so the first key is the oldest.
  readinessCache.delete(input.avatarId);
  while (readinessCache.size >= READINESS_CACHE_MAX) {
    const oldest = readinessCache.keys().next().value;
    if (oldest === undefined) break;
    readinessCache.delete(oldest);
  }
  readinessCache.set(input.avatarId, { userId: input.userId, atMs: input.nowMs, readyIds });
  return readyIds;
}

/**
 * Quests this avatar has NOT claimed, restricted to `status: 'live'`, with
 * READY ones (proof already met) first.
 *
 * Readiness runs the real engagement validator, but only for the unclaimed
 * HOSTED_ACTIONABLE_QUEST_IDS (at most 12) and at most once per avatar per
 * 60 s. The executor still re-runs the gate at settlement. Without a `userId`
 * no readiness is read and every quest is not ready.
 */
export async function readAutonomousQuestTargets(input: {
  avatarId: string;
  userId?: string | null;
  validate?: QuestReadinessValidator;
  nowMs?: number;
}): Promise<AutonomousQuestTarget[]> {
  const claimed = await db.execute<{ quest_id: string }>(
    sql`SELECT quest_id FROM tutorial_quest_claims WHERE avatar_id = ${input.avatarId}`,
  );
  const claimedIds = new Set(Array.from(claimed).map((row) => row.quest_id));
  const readyIds = input.userId
    ? await readQuestReadiness({
        avatarId: input.avatarId,
        userId: input.userId,
        claimedIds,
        validate: input.validate ?? defaultReadinessValidator,
        nowMs: input.nowMs ?? Date.now(),
      }).catch((): ReadonlySet<string> => new Set())
    : new Set<string>();
  return selectQuestTargets(claimedIds, readyIds);
}

/**
 * Pure ordering step of {@link readAutonomousQuestTargets} (rule above), with
 * READY quests (in `readyIds`) placed before everything else, round-robin by
 * tier inside. Default: none ready, which is the old order exactly.
 */
export function selectQuestTargets(
  claimedIds: ReadonlySet<string>,
  readyIds: ReadonlySet<string> = new Set(),
): AutonomousQuestTarget[] {
  const open = TUTORIAL_QUESTS.filter(
    (quest) => quest.status === 'live' && !claimedIds.has(quest.id),
  );
  const notReady = open.filter((quest) => !readyIds.has(quest.id));
  const ordered = [
    ...roundRobinByTier(open.filter((quest) => readyIds.has(quest.id))),
    ...roundRobinByTier(notReady.filter((quest) => HOSTED_ACTIONABLE_QUEST_IDS.has(quest.id))),
    ...roundRobinByTier(notReady.filter((quest) => !HOSTED_ACTIONABLE_QUEST_IDS.has(quest.id))),
  ];
  return ordered.slice(0, TARGET_LIMIT).map((quest) => ({
    questId: quest.id,
    title: quest.title,
    rail: TUTORIAL_QUEST_RAILS[quest.id as TutorialQuestId],
    reward: quest.reward,
    requirement: quest.description,
    ready: readyIds.has(quest.id),
  }));
}
