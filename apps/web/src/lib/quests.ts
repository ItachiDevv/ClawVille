// Quest/Objective system — types, definitions, and helpers
//
// Q3 plan §2.6 — token rewards now credit server-side via the
// /api/quests/tutorial/:id/claim endpoint. Reward amounts are sourced from
// `TUTORIAL_QUEST_REWARDS` in @clawville/shared so client toast and server
// ledger agree.

import { TUTORIAL_QUEST_REWARDS } from '@clawville/shared';

export type QuestId =
  | 'first-steps'
  | 'building-explorer'
  | 'npc-chatter'
  | 'book-worm'
  | 'avatar-whisperer'
  | 'agent-scholar'
  | 'deep-explorer'
  | 'bot-master'
  | 'first-match'
  | 'first-win';

export type QuestStatus = 'locked' | 'active' | 'completed';

export type CounterKey =
  | 'totalDistanceMoved'
  | 'npcMessagesSent'
  | 'avatarMessagesSent'
  | 'booksBought'
  | 'knowledgeLearned'
  | 'activityMatchesPlayed'
  | 'activityMatchesWon';

export interface QuestCondition {
  type: 'counter' | 'visitedBuildings' | 'openClaw';
  counterKey?: CounterKey;
  threshold?: number;
}

export interface QuestDefinition {
  id: QuestId;
  title: string;
  icon: string;
  description: string;
  /** Concrete instruction shown as the active hint */
  hint: string;
  condition: QuestCondition;
  prerequisites: QuestId[];
  /**
   * Q3 plan §2.6 — reward in ClawTokens. Settled server-side on completion
   * via POST /api/quests/tutorial/:id/claim. Source of truth is
   * TUTORIAL_QUEST_REWARDS in @clawville/shared; the lookup happens at
   * QUEST_DEFINITIONS construction time below.
   */
  rewardTokens: number;
}

export const QUEST_DEFINITIONS: QuestDefinition[] = [
  {
    id: 'first-steps',
    title: 'First Steps',
    icon: '👣',
    description: 'Walk around and explore the reef',
    hint: 'Use WASD or arrow keys to move your agent around the map',
    condition: { type: 'counter', counterKey: 'totalDistanceMoved', threshold: 200 },
    prerequisites: [],
    rewardTokens: TUTORIAL_QUEST_REWARDS['first-steps'],
  },
  {
    id: 'building-explorer',
    title: 'Explorer',
    icon: '🧭',
    description: 'Visit your first building',
    hint: 'Walk near a building and press E to enter',
    condition: { type: 'visitedBuildings', threshold: 1 },
    prerequisites: ['first-steps'],
    rewardTokens: TUTORIAL_QUEST_REWARDS['building-explorer'],
  },
  {
    id: 'npc-chatter',
    title: 'Small Talk',
    icon: '💬',
    description: 'Send 2 messages to any building character',
    hint: 'Enter a building and type a message to chat with the character inside',
    condition: { type: 'counter', counterKey: 'npcMessagesSent', threshold: 2 },
    prerequisites: ['building-explorer'],
    rewardTokens: TUTORIAL_QUEST_REWARDS['npc-chatter'],
  },
  {
    id: 'book-worm',
    title: 'Book Worm',
    icon: '📖',
    description: 'Buy your first knowledge book',
    hint: 'Enter a shop and click Buy on a book',
    condition: { type: 'counter', counterKey: 'booksBought', threshold: 1 },
    prerequisites: ['building-explorer'],
    rewardTokens: TUTORIAL_QUEST_REWARDS['book-worm'],
  },
  {
    id: 'avatar-whisperer',
    title: 'Agent Whisperer',
    icon: '💜',
    description: 'Send 3 messages to your agent',
    hint: 'Click the chat pill at the bottom to talk to your agent',
    condition: { type: 'counter', counterKey: 'avatarMessagesSent', threshold: 3 },
    prerequisites: ['npc-chatter'],
    rewardTokens: TUTORIAL_QUEST_REWARDS['avatar-whisperer'],
  },
  {
    id: 'agent-scholar',
    title: 'AI Agent Scholar',
    icon: '🎓',
    description: 'Learn 3 agent knowledge topics',
    hint: 'Open Inventory (gear menu) and click Read to Agent on a book',
    condition: { type: 'counter', counterKey: 'knowledgeLearned', threshold: 3 },
    prerequisites: ['book-worm'],
    rewardTokens: TUTORIAL_QUEST_REWARDS['agent-scholar'],
  },
  {
    id: 'deep-explorer',
    title: 'Cartographer',
    icon: '🗺️',
    description: 'Visit 5 unique buildings in the reef',
    hint: 'Explore the reef — walk near buildings and press E to enter each one',
    condition: { type: 'visitedBuildings', threshold: 5 },
    prerequisites: ['building-explorer'],
    rewardTokens: TUTORIAL_QUEST_REWARDS['deep-explorer'],
  },
  {
    id: 'bot-master',
    title: 'Bot Master',
    icon: '🤖',
    description: 'Connect an OpenClaw bot',
    hint: 'Set up an OpenClaw bot to join the reef',
    condition: { type: 'openClaw' },
    prerequisites: ['deep-explorer'],
    rewardTokens: TUTORIAL_QUEST_REWARDS['bot-master'],
  },
  // ── Q2 Activity Portals tutorial quests (chunk #9) ────────────────────
  // Per `.claude/plans/q2-research/frontend-spec.md` §9.1 — drive players
  // into the activity loop and reward them for landing first place.
  {
    id: 'first-match',
    title: 'First Match',
    icon: '⚔️',
    description: 'Play your first activity match.',
    hint: 'Use the sidebar Quick Queue → Bumper Shells to find a match',
    condition: { type: 'counter', counterKey: 'activityMatchesPlayed', threshold: 1 },
    prerequisites: ['building-explorer'],
    rewardTokens: TUTORIAL_QUEST_REWARDS['first-match'],
  },
  {
    id: 'first-win',
    title: 'First Victory',
    icon: '🏆',
    description: 'Place first in any activity.',
    hint: 'Ram opponents off the edge in Bumper Shells — last shell standing wins.',
    condition: { type: 'counter', counterKey: 'activityMatchesWon', threshold: 1 },
    prerequisites: ['first-match'],
    rewardTokens: TUTORIAL_QUEST_REWARDS['first-win'],
  },
];
