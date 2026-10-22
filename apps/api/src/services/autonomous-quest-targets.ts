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
 *   1. quests the agent can act on (HOSTED_ACTIONABLE_QUEST_IDS) come first,
 *      then the rest;
 *   2. inside each group, round-robin by tier: the first unclaimed quest of
 *      each tier (lowest tier first), then the second of each tier, and so on.
 * So six slots span up to six tiers, and an easy quest in a low tier still
 * comes before a harder one in the same tier. Still one query plus an
 * in-memory sort of 33 rows.
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
}

/**
 * Quests this avatar has NOT claimed, restricted to `status: 'live'`.
 *
 * Deliberately does NOT run the full engagement validator: that is one query
 * bundle per quest, and the prompt is built every decide cycle. The executor
 * re-runs the real gate at settlement, so an unqualified suggestion is refused
 * server-side — the cost of being permissive here is one wasted action, and the
 * cost of being strict would be a per-tick query storm.
 */
export async function readAutonomousQuestTargets(input: {
  avatarId: string;
}): Promise<AutonomousQuestTarget[]> {
  const claimed = await db.execute<{ quest_id: string }>(
    sql`SELECT quest_id FROM tutorial_quest_claims WHERE avatar_id = ${input.avatarId}`,
  );
  return selectQuestTargets(new Set(Array.from(claimed).map((row) => row.quest_id)));
}

/** Pure ordering step of {@link readAutonomousQuestTargets} (rule above). */
export function selectQuestTargets(claimedIds: ReadonlySet<string>): AutonomousQuestTarget[] {
  const open = TUTORIAL_QUESTS.filter(
    (quest) => quest.status === 'live' && !claimedIds.has(quest.id),
  );
  const ordered = [
    ...roundRobinByTier(open.filter((quest) => HOSTED_ACTIONABLE_QUEST_IDS.has(quest.id))),
    ...roundRobinByTier(open.filter((quest) => !HOSTED_ACTIONABLE_QUEST_IDS.has(quest.id))),
  ];
  return ordered.slice(0, TARGET_LIMIT).map((quest) => ({
    questId: quest.id,
    title: quest.title,
    rail: TUTORIAL_QUEST_RAILS[quest.id as TutorialQuestId],
    reward: quest.reward,
    requirement: quest.description,
  }));
}
