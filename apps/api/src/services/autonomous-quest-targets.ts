/**
 * Bounded, server-derived "which quests can I claim right now" projection for
 * hosted cognition.
 *
 * WHY THIS EXISTS. The decide prompt already renders the full action menu, so
 * `claim_tutorial_quest(questId=<listed claimable quest id>)` reaches the
 * deciding LLM — but nothing told it which ids are VALID. The manual names only
 * the four land quests, leaving 30 of 34 to guesswork. Under the world-scope
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
  const claimedIds = new Set(Array.from(claimed).map((row) => row.quest_id));

  const targets: AutonomousQuestTarget[] = [];
  for (const quest of TUTORIAL_QUESTS) {
    if (quest.status !== 'live') continue;
    if (claimedIds.has(quest.id)) continue;
    targets.push({
      questId: quest.id,
      title: quest.title,
      rail: TUTORIAL_QUEST_RAILS[quest.id as TutorialQuestId],
      reward: quest.reward,
      requirement: quest.description,
    });
    if (targets.length >= TARGET_LIMIT) break;
  }
  return targets;
}
