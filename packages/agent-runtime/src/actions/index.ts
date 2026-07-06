/**
 * ClawVille ElizaOS Actions — Phase 1B
 *
 * These actions let agents DO things during conversation: visit buildings,
 * buy items, learn skills, check balances, accept quests, and claim
 * bounties.
 *
 * All actions receive their DB handle and ClawToken ledger functions via
 * `state.services` (injected by the API layer) to avoid circular deps
 * between packages/agent-runtime and apps/api.
 */

export * from './types';
export { visitBuildingAction } from './visit-building';
export { buyItemAction } from './buy-item';
export { learnSkillAction } from './learn-skill';
export { checkBalanceAction } from './check-balance';
export { listBuildingsAction } from './list-buildings';
export { acceptQuestAction } from './accept-quest';
export { claimBountyAction } from './claim-bounty';

import { visitBuildingAction } from './visit-building';
import { buyItemAction } from './buy-item';
import { learnSkillAction } from './learn-skill';
import { checkBalanceAction } from './check-balance';
import { listBuildingsAction } from './list-buildings';
import { acceptQuestAction } from './accept-quest';
import { claimBountyAction } from './claim-bounty';
import type { Action } from './types';

/** All 7 ClawVille actions, ready to register with the ElizaOS runtime. */
export const allActions: Action[] = [
  visitBuildingAction,
  buyItemAction,
  learnSkillAction,
  checkBalanceAction,
  listBuildingsAction,
  acceptQuestAction,
  claimBountyAction,
];
