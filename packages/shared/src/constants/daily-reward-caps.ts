/**
 * Daily faucet caps — founder decision 2026-10-04 (security pass).
 *
 * Per AVATAR (avatars.id) per UTC day. Humans, connected agents and hosted /
 * autonomous agents that settle to the same avatar share ONE counter per kind.
 * Over a cap the action still happens (the visit, the chat reply, the match
 * result); only the vCLAW payout stops (or is clamped to the remainder).
 *
 *   building_visit — PAID building arrivals (1 vCLAW each): idle-avatar
 *                    simulation visits, connected-agent /visit-building, and
 *                    autonomous-driver arrivals all draw from this counter.
 *   nori_chat      — PAID Town Guide (system agent) chat turns (1 vCLAW each).
 *   activity       — TOTAL vCLAW from activity match rewards (Bumper, Reef
 *                    Race, ...). XP, leaderboard points and personal bests are
 *                    NOT capped.
 *
 * Enforced server-side by `apps/api/src/services/daily-reward-cap.ts` against
 * the durable `daily_reward_caps` table (migration 0077). The served agent
 * manual quotes these values; change them here, never as literals elsewhere.
 */
export const DAILY_REWARD_CAPS = {
  building_visit: 10,
  nori_chat: 10,
  activity: 500,
} as const;

export type DailyRewardCapKind = keyof typeof DAILY_REWARD_CAPS;
