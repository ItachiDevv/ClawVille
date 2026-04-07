// Quest/Objective system — types, definitions, and helpers

export type QuestId =
  | 'first-steps'
  | 'building-explorer'
  | 'npc-chatter'
  | 'book-worm'
  | 'pet-whisperer'
  | 'agent-scholar'
  | 'deep-explorer'
  | 'bot-master';

export type QuestStatus = 'locked' | 'active' | 'completed';

export type CounterKey =
  | 'totalDistanceMoved'
  | 'npcMessagesSent'
  | 'petMessagesSent'
  | 'booksBought'
  | 'knowledgeLearned';

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
    hint: 'Use WASD or arrow keys to move your pet around the map',
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
    description: 'Send 2 messages to any NPC',
    hint: 'Enter a building and type a message to chat with the NPC inside',
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
    id: 'pet-whisperer',
    title: 'Pet Whisperer',
    icon: '💜',
    description: 'Send 3 messages to your pet',
    hint: 'Click the chat pill at the bottom to talk to your pet',
    condition: { type: 'counter', counterKey: 'petMessagesSent', threshold: 3 },
    prerequisites: ['npc-chatter'],
  },
  {
    id: 'agent-scholar',
    title: 'AI Agent Scholar',
    icon: '🎓',
    description: 'Learn 3 agent knowledge topics',
    hint: 'Open Inventory (gear menu) and click Read to Pet on a book',
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
];
