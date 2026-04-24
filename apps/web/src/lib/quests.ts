// Quest/Objective system — types, definitions, and helpers

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
  },
  {
    id: 'building-explorer',
    title: 'Explorer',
    icon: '🧭',
    description: 'Visit your first building',
    hint: 'Walk near a building and press E to enter',
    condition: { type: 'visitedBuildings', threshold: 1 },
    prerequisites: ['first-steps'],
  },
  {
    id: 'npc-chatter',
    title: 'Small Talk',
    icon: '💬',
    description: 'Send 2 messages to any building character',
    hint: 'Enter a building and type a message to chat with the character inside',
    condition: { type: 'counter', counterKey: 'npcMessagesSent', threshold: 2 },
    prerequisites: ['building-explorer'],
  },
  {
    id: 'book-worm',
    title: 'Book Worm',
    icon: '📖',
    description: 'Buy your first knowledge book',
    hint: 'Enter a shop and click Buy on a book',
    condition: { type: 'counter', counterKey: 'booksBought', threshold: 1 },
    prerequisites: ['building-explorer'],
  },
  {
    id: 'avatar-whisperer',
    title: 'Agent Whisperer',
    icon: '💜',
    description: 'Send 3 messages to your agent',
    hint: 'Click the chat pill at the bottom to talk to your agent',
    condition: { type: 'counter', counterKey: 'avatarMessagesSent', threshold: 3 },
    prerequisites: ['npc-chatter'],
  },
  {
    id: 'agent-scholar',
    title: 'AI Agent Scholar',
    icon: '🎓',
    description: 'Learn 3 agent knowledge topics',
    hint: 'Open Inventory (gear menu) and click Read to Agent on a book',
    condition: { type: 'counter', counterKey: 'knowledgeLearned', threshold: 3 },
    prerequisites: ['book-worm'],
  },
  {
    id: 'deep-explorer',
    title: 'Cartographer',
    icon: '🗺️',
    description: 'Visit 5 unique buildings in the reef',
    hint: 'Explore the reef — walk near buildings and press E to enter each one',
    condition: { type: 'visitedBuildings', threshold: 5 },
    prerequisites: ['building-explorer'],
  },
  {
    id: 'bot-master',
    title: 'Bot Master',
    icon: '🤖',
    description: 'Connect an OpenClaw bot',
    hint: 'Set up an OpenClaw bot to join the reef',
    condition: { type: 'openClaw' },
    prerequisites: ['deep-explorer'],
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
  },
  {
    id: 'first-win',
    title: 'First Victory',
    icon: '🏆',
    description: 'Place first in any activity.',
    hint: 'Ram opponents off the edge in Bumper Shells — last shell standing wins.',
    condition: { type: 'counter', counterKey: 'activityMatchesWon', threshold: 1 },
    prerequisites: ['first-match'],
  },
];
