// Quest/Objective system — types, definitions, and helpers.
//
// Q3 plan §2.6 + 2026-04-29 redesign — 30 tutorial quests across 9 tiers.
// Single source of truth: TUTORIAL_QUESTS in @clawville/shared. This file
// pairs each entry with a `condition` describing how the client tracks
// progress + an optional list of prerequisites.
//
// Condition types:
//   - `counter`        — single int counter ≥ threshold
//   - `visitedBuildings` — useGameStore.visitedBuildings.size ≥ threshold
//   - `distinctSet`    — distinct value count from a Record ≥ threshold
//   - `openClaw`       — any connected OpenClaw bot in npc store
//   - `compound`       — every sub-predicate must pass
//   - `pending`        — feature not built; never auto-completes
//   - `serverOnly`     — only the server can verify; client retries claim
//
// Server is the source of truth for amounts. The client tracks just enough
// to render progress optimistically; the /api/quests/tutorial/:id/claim
// endpoint validates against the events table before crediting tokens.

import {
  TUTORIAL_QUESTS,
  type TutorialQuestId,
} from '@clawville/shared';

export type QuestId = TutorialQuestId;
export type QuestStatus = 'locked' | 'active' | 'completed';

export type CounterKey =
  | 'systemAgentMessagesSent'
  | 'avatarMessagesSent'
  | 'characterMessagesSent'
  | 'booksBought'
  | 'itemsBought'
  | 'knowledgeLearned'
  | 'cosmeticsEquipped'
  | 'activityMatchesPlayed'
  | 'activityMatchesWon';

export type DistinctSetKey =
  | 'distinctTeachersChatted'
  | 'distinctActivityTypes'
  | 'distinctBookBuildings';

export type QuestCondition =
  | { type: 'counter'; counterKey: CounterKey; threshold: number }
  | { type: 'visitedBuildings'; threshold: number }
  | { type: 'distinctSet'; setKey: DistinctSetKey; threshold: number }
  | { type: 'openClaw' }
  | { type: 'compound'; predicates: QuestCondition[] }
  | { type: 'pending' }
  | { type: 'serverOnly' };

export interface QuestDefinition {
  id: QuestId;
  title: string;
  icon: string;
  description: string;
  hint: string;
  condition: QuestCondition;
  prerequisites: QuestId[];
  rewardTokens: number;
  tier: number;
  isPending: boolean;
}

interface QuestExtras {
  hint: string;
  condition: QuestCondition;
  prerequisites: QuestId[];
}

const QUEST_EXTRAS: Record<TutorialQuestId, QuestExtras> = {
  // TIER 1
  'say-hi-nori': {
    hint: 'Click on Nori the Town Guide near the town center and say hi.',
    condition: { type: 'counter', counterKey: 'systemAgentMessagesSent', threshold: 1 },
    prerequisites: [],
  },
  'meet-your-agent': {
    hint: 'Open the chat pill at the bottom and message your avatar.',
    condition: { type: 'counter', counterKey: 'avatarMessagesSent', threshold: 1 },
    prerequisites: [],
  },
  'first-steps': {
    hint: 'Walk near a building and press E to enter.',
    condition: { type: 'visitedBuildings', threshold: 1 },
    prerequisites: [],
  },

  // TIER 2
  'town-briefing': {
    hint: 'Send 3 messages to Nori — ask her about the world.',
    condition: { type: 'counter', counterKey: 'systemAgentMessagesSent', threshold: 3 },
    prerequisites: ['say-hi-nori'],
  },
  bonded: {
    hint: 'Chat with your own avatar 5 times.',
    condition: { type: 'counter', counterKey: 'avatarMessagesSent', threshold: 5 },
    prerequisites: ['meet-your-agent'],
  },
  'door-knocker': {
    hint: 'Enter a building AND chat with the teacher inside.',
    condition: {
      type: 'compound',
      predicates: [
        { type: 'visitedBuildings', threshold: 1 },
        { type: 'counter', counterKey: 'characterMessagesSent', threshold: 1 },
      ],
    },
    prerequisites: ['first-steps'],
  },

  // TIER 3
  'town-tour': {
    hint: 'Visit 3 different buildings AND chat with 2 different teachers.',
    condition: {
      type: 'compound',
      predicates: [
        { type: 'visitedBuildings', threshold: 3 },
        { type: 'distinctSet', setKey: 'distinctTeachersChatted', threshold: 2 },
      ],
    },
    prerequisites: ['door-knocker'],
  },
  'star-pupil': {
    hint: 'Chat with 5 different building teachers.',
    condition: { type: 'distinctSet', setKey: 'distinctTeachersChatted', threshold: 5 },
    prerequisites: ['town-tour'],
  },
  cartographer: {
    hint: 'Visit all 10 buildings around the reef.',
    condition: { type: 'visitedBuildings', threshold: 10 },
    prerequisites: ['town-tour'],
  },

  // TIER 4
  'shop-and-study': {
    hint: 'Buy a knowledge book from a shop AND read it to your agent.',
    condition: {
      type: 'compound',
      predicates: [
        { type: 'counter', counterKey: 'booksBought', threshold: 1 },
        { type: 'counter', counterKey: 'knowledgeLearned', threshold: 1 },
      ],
    },
    prerequisites: ['door-knocker'],
  },
  'inventory-in-action': {
    hint: 'Buy any item AND use/equip it in game (read a book or equip a cosmetic).',
    condition: {
      type: 'compound',
      predicates: [
        { type: 'counter', counterKey: 'itemsBought', threshold: 1 },
        // Server validates the OR (knowledge OR cosmetic equipped); the
        // client uses the cheap knowledgeLearned path for the progress bar.
        { type: 'counter', counterKey: 'knowledgeLearned', threshold: 1 },
      ],
    },
    prerequisites: ['shop-and-study'],
  },
  'library-card': {
    hint: 'Buy 3 books from 3 different buildings AND read all 3.',
    condition: {
      type: 'compound',
      predicates: [
        { type: 'distinctSet', setKey: 'distinctBookBuildings', threshold: 3 },
        { type: 'counter', counterKey: 'knowledgeLearned', threshold: 3 },
      ],
    },
    prerequisites: ['shop-and-study'],
  },
  polymath: {
    hint: 'Have your agent learn 10 different knowledge topics.',
    condition: { type: 'counter', counterKey: 'knowledgeLearned', threshold: 10 },
    prerequisites: ['library-card'],
  },
  'style-statement': {
    hint: 'Coming soon — cosmetic shop opens in Phase 4.',
    condition: { type: 'pending' },
    prerequisites: [],
  },
  'big-spender': {
    hint: 'Coming soon — server-side spending tracker rolls out with the shop.',
    condition: { type: 'pending' },
    prerequisites: [],
  },

  // TIER 5
  'first-match': {
    hint: 'Use the sidebar Quick Queue → Bumper Shells or Reef Race.',
    condition: { type: 'counter', counterKey: 'activityMatchesPlayed', threshold: 1 },
    prerequisites: [],
  },
  'game-day': {
    hint: 'Chat with 2 different teachers AND finish 1 activity match.',
    condition: {
      type: 'compound',
      predicates: [
        { type: 'distinctSet', setKey: 'distinctTeachersChatted', threshold: 2 },
        { type: 'counter', counterKey: 'activityMatchesPlayed', threshold: 1 },
      ],
    },
    prerequisites: ['first-match'],
  },
  'reef-veteran': {
    hint: 'Finish 1 Bumper Shells AND 1 Reef Race match.',
    condition: { type: 'distinctSet', setKey: 'distinctActivityTypes', threshold: 2 },
    prerequisites: ['first-match'],
  },
  'first-victory': {
    hint: 'Place 1st in any activity match.',
    condition: { type: 'counter', counterKey: 'activityMatchesWon', threshold: 1 },
    prerequisites: ['first-match'],
  },
  'match-maker': {
    hint: 'Finish 5 matches AND win at least 1.',
    condition: {
      type: 'compound',
      predicates: [
        { type: 'counter', counterKey: 'activityMatchesPlayed', threshold: 5 },
        { type: 'counter', counterKey: 'activityMatchesWon', threshold: 1 },
      ],
    },
    prerequisites: ['first-victory'],
  },

  // TIER 6
  'bot-master': {
    hint: "Generate a connect link in the Agent Connect modal and paste it into your agent's chat.",
    condition: { type: 'openClaw' },
    prerequisites: [],
  },
  'open-house': {
    hint: 'Have your bot chat with 2 different teachers AND finish 1 match. Server-validated.',
    condition: { type: 'serverOnly' },
    prerequisites: ['bot-master'],
  },

  // TIER 7
  'on-the-board': {
    hint: 'Earn at least one leaderboard-scoring event. Server-validated.',
    condition: { type: 'serverOnly' },
    prerequisites: [],
  },
  'top-100': {
    hint: 'Climb into the top 100 on any leaderboard window. Server-validated.',
    condition: { type: 'serverOnly' },
    prerequisites: ['on-the-board'],
  },
  'building-champion': {
    hint: 'Be the most-visited subject for any single building (24h). Server-validated.',
    condition: { type: 'serverOnly' },
    prerequisites: ['cartographer'],
  },

  // TIER 8
  'wallet-aware': {
    hint: 'Coming soon — wallet view tracking ships with the wallet UI.',
    condition: { type: 'pending' },
    prerequisites: [],
  },
  crossover: {
    hint: "Use the 'scape portal to cross — or link your existing 'scape account.",
    condition: { type: 'serverOnly' },
    prerequisites: [],
  },

  // TIER 9
  'full-house': {
    hint: 'Visit + chat with all 10 buildings AND buy + read 5 books. Server-validated.',
    condition: { type: 'serverOnly' },
    prerequisites: ['cartographer', 'star-pupil', 'library-card'],
  },
  'elite-trainer': {
    hint: 'Connect a bot, win 3 matches, learn 10 books, hit top-100. Server-validated.',
    condition: { type: 'serverOnly' },
    prerequisites: ['bot-master', 'match-maker', 'polymath', 'top-100'],
  },
  'brand-ambassador': {
    hint: 'Coming soon — Milady install verification ships with the app store integration.',
    condition: { type: 'pending' },
    prerequisites: [],
  },

  // TIER 10 — the four land quests (materials rail).
  //
  // All `serverOnly`: each predicate is a row count the client cannot see —
  // owned parcels, placed structures, active distinct kit pieces, and structure
  // level — so there is no counter to mirror and no honest client-side
  // approximation. They deliberately carry NO prerequisites: land is reachable
  // without finishing the tutorial line, and gating it behind that would make
  // the flagship activity an endgame, which is the exact defect this pass
  // exists to fix.
  homesteader: {
    hint: 'Hold or rent your first parcel at the Land Office. Server-validated.',
    condition: { type: 'serverOnly' },
    prerequisites: [],
  },
  'first-nail': {
    hint: 'Place your first home or shop on a parcel you hold. Server-validated.',
    condition: { type: 'serverOnly' },
    prerequisites: ['homesteader'],
  },
  'yard-work': {
    hint: 'Have 6 kit pieces placed in your yard at once. Server-validated.',
    condition: { type: 'serverOnly' },
    prerequisites: ['first-nail'],
  },
  'curb-appeal': {
    hint: 'Upgrade a structure to level 2 or higher. Server-validated.',
    condition: { type: 'serverOnly' },
    prerequisites: ['first-nail'],
  },
};

export const QUEST_DEFINITIONS: QuestDefinition[] = TUTORIAL_QUESTS.map((entry) => {
  const extras = QUEST_EXTRAS[entry.id];
  return {
    id: entry.id,
    title: entry.title,
    icon: entry.icon,
    description: entry.description,
    hint: extras.hint,
    condition: extras.condition,
    prerequisites: extras.prerequisites,
    rewardTokens: entry.reward,
    tier: entry.tier,
    isPending: entry.status === 'pending',
  };
});

export const QUEST_DEFINITIONS_BY_ID: Record<QuestId, QuestDefinition> =
  Object.fromEntries(QUEST_DEFINITIONS.map((q) => [q.id, q])) as Record<QuestId, QuestDefinition>;
