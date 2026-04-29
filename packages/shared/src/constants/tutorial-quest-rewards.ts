/**
 * Q3 plan §2.6 — server-credited token rewards for the 8+ tutorial quests
 * defined client-side in `apps/web/src/lib/quests.ts`.
 *
 * Single source of truth for amounts so the client toast and the server
 * `creditClawTokens` call agree. Values are starting points (~175 CT total
 * for fully completing the tutorial path); tune from Phase 1 data.
 *
 * Keep keys in sync with `QuestId` in apps/web/src/lib/quests.ts.
 */

export const TUTORIAL_QUEST_REWARDS = {
  'first-steps': 5,         // walk 200u — entry-level proof of life
  'building-explorer': 10,   // visit first building
  'npc-chatter': 5,         // 2 building-character messages
  'book-worm': 10,          // first knowledge book purchase
  'pet-whisperer': 10,      // 3 messages to your agent
  'agent-scholar': 25,      // learn 3 knowledge topics
  'deep-explorer': 25,      // visit 5 unique buildings
  'bot-master': 50,         // connect a real OpenClaw bot — biggest single reward
  'first-match': 10,        // first activity match played
  'first-win': 25,          // first 1st-place finish
} as const;

export type TutorialQuestId = keyof typeof TUTORIAL_QUEST_REWARDS;

export const TUTORIAL_QUEST_TOTAL_REWARD = Object.values(TUTORIAL_QUEST_REWARDS).reduce(
  (sum, n) => sum + n,
  0,
);

/**
 * Tightens the type for runtime checks: returns the reward if the id is a
 * known tutorial quest, otherwise null. Use this in the server route to
 * reject unknown quest ids cleanly.
 */
export function getTutorialQuestReward(id: string): number | null {
  return id in TUTORIAL_QUEST_REWARDS
    ? TUTORIAL_QUEST_REWARDS[id as TutorialQuestId]
    : null;
}
