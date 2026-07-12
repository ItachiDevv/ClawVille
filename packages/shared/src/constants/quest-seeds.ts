import type { QuestSeed } from '../types/quest';

/** Seed quests across all tiers — inserted by the seed script */
export const QUEST_SEEDS: QuestSeed[] = [
  // ── Side Quests (10–50 tokens) ──
  {
    title: 'Fix the Reef Lights',
    description:
      'The bioluminescent lighting system in the reef is flickering. Find and fix the CSS animation bug causing the underwater glow effect to stutter on mobile devices.',
    tier: 'side_quest',
    tokenReward: 25,
    maxCompletions: 5,
    requirements:
      'Fix the CSS keyframe animation for the reef-glow class. Submit a PR with before/after screenshots.',
    verificationMethod: 'pr_review',
  },
  {
    title: 'Document the Tidal API',
    description:
      'The /api/locations endpoints are undocumented. Write OpenAPI/Swagger docs for all location-related routes so new developers can onboard faster.',
    tier: 'side_quest',
    tokenReward: 40,
    maxCompletions: 1,
    requirements:
      'Create an OpenAPI spec covering GET /api/locations, GET /api/locations/:id/agent, and POST /api/locations/:id/chat. Include request/response schemas.',
    verificationMethod: 'pr_review',
  },
  {
    title: 'Patch a Leaking Pipe',
    description:
      'A minor memory leak has been spotted near the Krusty Krab. The NPC event listener cleanup is missing in one of the useEffect hooks.',
    tier: 'side_quest',
    tokenReward: 15,
    maxCompletions: 3,
    requirements:
      'Identify the leaked event listener in the NPC rendering code. Submit a PR with the fix and a brief explanation.',
    verificationMethod: 'pr_review',
  },

  // ── Main Quests (100–500 tokens) ──
  {
    title: 'Build the Coral Garden',
    description:
      'Design and implement a new "Coral Garden" building zone where avatars can grow and trade procedurally generated corals. Requires Three.js scene work, a new API route, and database schema.',
    tier: 'main_quest',
    tokenReward: 300,
    titleReward: 'Coral Architect',
    maxCompletions: 1,
    requirements:
      'Implement the full feature: new map location, 3D coral rendering, growth mechanic with timers, and at least 3 coral varieties. Must include tests.',
    verificationMethod: 'pr_review',
  },
  {
    title: 'Agent Memory System',
    description:
      'Implement persistent long-term memory for avatar agents. Agents should remember past conversations, learn user preferences, and reference previous interactions naturally.',
    tier: 'main_quest',
    tokenReward: 250,
    maxCompletions: 1,
    requirements:
      'Add a memory retrieval system using vector embeddings. Agents must demonstrate recall of at least 5 previous conversation topics in testing.',
    verificationMethod: 'pr_review',
  },
  {
    title: 'Signal Relay Protocol',
    description:
      "Set up a multi-channel bridge at Sandy's Treedome. Route messages from Discord to Telegram seamlessly, proving your cross-platform channel mastery.",
    tier: 'main_quest',
    tokenReward: 350,
    titleReward: 'Bridge Commander',
    maxCompletions: 1,
    requirements:
      'Implement a Discord → Telegram relay with rate limiting and error recovery. Submit a working demo and PR.',
    verificationMethod: 'pr_review',
  },

  // ── Legendary Quests (1000+ tokens) ──
  {
    title: 'The Deep Protocol',
    description:
      'Design and implement the ClawVille SDK — a TypeScript package that lets external developers build plugins, custom buildings, and third-party agents that integrate with the reef ecosystem.',
    tier: 'legendary',
    tokenReward: 1500,
    titleReward: 'Protocol Architect',
    maxCompletions: 1,
    requirements:
      'Full SDK with plugin system, building registration API, agent integration protocol, documentation, and at least 2 example plugins. Published to npm.',
    verificationMethod: 'manual',
  },
  {
    title: 'Decentralize the Reef',
    description:
      'Integrate on-chain token mechanics so vCLAW has real value. Implement wallet connection, token minting via smart contract, and on-chain quest completion verification.',
    tier: 'legendary',
    tokenReward: 2000,
    titleReward: 'Chain Warden',
    maxCompletions: 1,
    requirements:
      'Solana or EVM smart contract for vCLAW, wallet adapter integration, on-chain quest verification, and a bridge between in-game and on-chain balances. Full audit-ready code.',
    verificationMethod: 'manual',
  },
];
