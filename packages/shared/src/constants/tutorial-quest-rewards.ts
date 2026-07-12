/**
 * Q3 plan §2.6 + 2026-04-29 redesign — 30 tutorial quests across 9 tiers.
 *
 * Replaces the 10-quest single-condition list with a richer ladder of
 * single → compound → mega-compound capstones that exposes every demo
 * surface (built-or-not). Quests for not-yet-built features ship with
 * `status: 'pending'`; the client renders them as "Coming soon" and the
 * server validator returns `engagement_required: pending_feature` so
 * nobody can claim them until the underlying emitter ships.
 *
 * Single source of truth: this array. Derived everywhere:
 *  - `apps/web/src/lib/quests.ts` builds QUEST_DEFINITIONS by zipping
 *    each entry with a `condition` (the threshold-check shape).
 *  - `apps/web/src/app/dash/tabs/quests.tsx` renders the dashboard cards.
 *  - `apps/api/src/routes/quests.ts` validates engagement against the
 *    events table, gated by `status`.
 */

export type TutorialQuestStatus = 'live' | 'pending';

export interface TutorialQuestEntry {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly description: string;
  readonly reward: number;
  readonly status: TutorialQuestStatus;
  readonly tier: number;
}

export const TUTORIAL_QUESTS = [
  // ── TIER 1 — HELLO ────────────────────────────────────────────────────
  { id: 'say-hi-nori',     tier: 1, status: 'live',    icon: '👋', title: 'Say Hi to Nori',     reward: 5,   description: 'Send 1 message to the Town Guide' },
  { id: 'meet-your-agent', tier: 1, status: 'live',    icon: '💜', title: 'Meet Your Agent',    reward: 5,   description: 'Send 1 message to your own avatar/agent' },
  { id: 'first-steps',     tier: 1, status: 'live',    icon: '👣', title: 'First Steps',        reward: 10,  description: 'Visit your first building' },

  // ── TIER 2 — CONVERSATION ─────────────────────────────────────────────
  { id: 'town-briefing',   tier: 2, status: 'live',    icon: '🗣️', title: 'Town Briefing',      reward: 15,  description: 'Send 3 messages to Nori' },
  { id: 'bonded',          tier: 2, status: 'live',    icon: '💞', title: 'Bonded',             reward: 15,  description: 'Send 5 messages to your own agent' },
  { id: 'door-knocker',    tier: 2, status: 'live',    icon: '🚪', title: 'Door Knocker',       reward: 20,  description: 'Visit a building AND chat with its teacher' },

  // ── TIER 3 — THE TOWN ─────────────────────────────────────────────────
  { id: 'town-tour',       tier: 3, status: 'live',    icon: '🧭', title: 'Town Tour',          reward: 30,  description: 'Visit 3 different buildings AND chat with 2 different teachers' },
  { id: 'star-pupil',      tier: 3, status: 'live',    icon: '🎓', title: 'Star Pupil',         reward: 60,  description: 'Chat with 5 different building teachers' },
  { id: 'cartographer',    tier: 3, status: 'live',    icon: '🗺️', title: 'Cartographer',       reward: 50,  description: 'Visit all 10 buildings' },

  // ── TIER 4 — ECONOMY & LEARNING ───────────────────────────────────────
  { id: 'shop-and-study',  tier: 4, status: 'live',    icon: '📖', title: 'Shop & Study',       reward: 25,  description: 'Buy 1 knowledge book AND read it to your agent' },
  { id: 'inventory-in-action', tier: 4, status: 'live', icon: '🎒', title: 'Inventory in Action', reward: 30, description: 'Buy any item AND use/equip it in game' },
  { id: 'library-card',    tier: 4, status: 'live',    icon: '📚', title: 'Library Card',       reward: 50,  description: 'Buy 3 books from 3 different buildings AND read all 3' },
  { id: 'polymath',        tier: 4, status: 'live',    icon: '🧠', title: 'Polymath',           reward: 75,  description: 'Have your agent learn 10 knowledge topics' },
  { id: 'style-statement', tier: 4, status: 'pending', icon: '🪩', title: 'Style Statement',    reward: 30,  description: 'Buy a cosmetic AND equip it' },
  { id: 'big-spender',     tier: 4, status: 'pending', icon: '💸', title: 'Big Spender',        reward: 50,  description: 'Spend 200 vCLAW (any combo)' },

  // ── TIER 5 — ACTIVITIES ───────────────────────────────────────────────
  { id: 'first-match',     tier: 5, status: 'live',    icon: '⚔️', title: 'First Match',        reward: 15,  description: 'Finish 1 activity match' },
  { id: 'game-day',        tier: 5, status: 'live',    icon: '🎮', title: 'Game Day',           reward: 30,  description: 'Chat with 2 different teachers AND finish 1 activity match' },
  { id: 'reef-veteran',    tier: 5, status: 'live',    icon: '🌊', title: 'Reef Veteran',       reward: 40,  description: 'Finish 1 Bumper Shells AND 1 Reef Race' },
  { id: 'first-victory',   tier: 5, status: 'live',    icon: '🏆', title: 'First Victory',      reward: 60,  description: 'Place 1st in any activity match' },
  { id: 'match-maker',     tier: 5, status: 'live',    icon: '🥇', title: 'Match Maker',        reward: 75,  description: 'Finish 5 matches AND win at least 1' },

  // ── TIER 6 — CONNECT ──────────────────────────────────────────────────
  { id: 'bot-master',      tier: 6, status: 'live',    icon: '🤖', title: 'Bot Master',         reward: 75,  description: 'Connect 1 external OpenClaw / Hermes / Milady agent' },
  { id: 'open-house',      tier: 6, status: 'live',    icon: '🏠', title: 'Open House',         reward: 100, description: 'Connect a bot AND have it chat 2 teachers AND finish 1 match' },

  // ── TIER 7 — CLIMB ────────────────────────────────────────────────────
  { id: 'on-the-board',    tier: 7, status: 'live',    icon: '📋', title: 'On the Board',       reward: 25,  description: 'Show on the leaderboard for the first time' },
  { id: 'top-100',         tier: 7, status: 'live',    icon: '💯', title: 'Top 100',            reward: 75,  description: 'Reach top 100 on any leaderboard window' },
  { id: 'building-champion', tier: 7, status: 'live',  icon: '👑', title: 'Building Champion',  reward: 100, description: 'Be the top-visited subject for any single building (24h)' },

  // ── TIER 8 — CROSS-WORLD (Phase 5.1) ──────────────────────────────────
  { id: 'wallet-aware',    tier: 8, status: 'pending', icon: '💰', title: 'Wallet Aware',       reward: 15,  description: 'View your avatar wallet for the first time' },
  { id: 'crossover',       tier: 8, status: 'live',    icon: '🌉', title: 'Crossover',          reward: 100, description: "Cross via the 'scape portal (or link existing 'scape account)" },

  // ── TIER 9 — CAPSTONES ────────────────────────────────────────────────
  { id: 'full-house',      tier: 9, status: 'live',    icon: '🏘️', title: 'Full House',         reward: 200, description: 'All 10 buildings visited + all 10 teachers chatted + 5 books bought + read' },
  { id: 'elite-trainer',   tier: 9, status: 'live',    icon: '🥋', title: 'Elite Trainer',      reward: 300, description: 'Bot connected + 3 match wins + 10 knowledge topics learned + top-100 reached' },
  { id: 'brand-ambassador', tier: 9, status: 'pending', icon: '🌟', title: 'Brand Ambassador', reward: 500, description: 'Top-10 leaderboard + 2+ bots connected + Milady install verified + scape portal crossed' },
] as const satisfies readonly TutorialQuestEntry[];

export type TutorialQuestId = (typeof TUTORIAL_QUESTS)[number]['id'];

export const TUTORIAL_QUEST_REWARDS: Readonly<Record<TutorialQuestId, number>> =
  Object.fromEntries(TUTORIAL_QUESTS.map((q) => [q.id, q.reward])) as Record<
    TutorialQuestId,
    number
  >;

export const TUTORIAL_QUEST_STATUS: Readonly<Record<TutorialQuestId, TutorialQuestStatus>> =
  Object.fromEntries(TUTORIAL_QUESTS.map((q) => [q.id, q.status])) as Record<
    TutorialQuestId,
    TutorialQuestStatus
  >;

export const TUTORIAL_QUEST_TOTAL_REWARD = TUTORIAL_QUESTS.reduce(
  (sum, q) => sum + q.reward,
  0,
);

export const TUTORIAL_QUEST_LIVE_REWARD = TUTORIAL_QUESTS
  .filter((q) => q.status === 'live')
  .reduce((sum, q) => sum + q.reward, 0);

export function getTutorialQuestReward(id: string): number | null {
  return id in TUTORIAL_QUEST_REWARDS
    ? TUTORIAL_QUEST_REWARDS[id as TutorialQuestId]
    : null;
}

export function isLiveTutorialQuest(id: string): id is TutorialQuestId {
  return id in TUTORIAL_QUEST_STATUS && TUTORIAL_QUEST_STATUS[id as TutorialQuestId] === 'live';
}
