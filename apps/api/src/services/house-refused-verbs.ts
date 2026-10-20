import type { HatcherActionVerb } from '@clawville/shared';

/**
 * The [ACTION:] verbs a HOUSE actor (`openclaw_bots.is_house = true`) can
 * never complete. Single source for both sides of the consumption mandate:
 * the executor (`npc-simulation.ts`) refuses these for a house actor, and the
 * decide prompt (`agent-autonomy-driver.ts`) plus the Jev world demo
 * (`jev-world-decide.ts`) leave them off a house actor's menu, so the deciding
 * model never sees a verb the executor will drop.
 *
 * Why each one fails for the house:
 * - chat_nori, update_appearance, trade_token, place_kit_piece: each path
 *   re-resolves the CONNECTED agent session. A house bot holds no bearer
 *   session (NULL expiry and key hash, on purpose), so that resolver treats it
 *   as expired AND unregisters the house body as a side effect. The executor
 *   refuses these BEFORE any session resolve.
 * - claim_tutorial_quest, salvage_node: pure faucets; house fleets never claim
 *   them (`autonomousQuestAgentResolve` refuses the house agentId first).
 *
 * House agents are internal. Connected and hosted agents keep the full
 * HATCHER_ACTION_MENU unchanged; the executor change that introduced this list
 * still bumped PROTOCOL_VERSION to 90 (version log only), as every executor
 * change must.
 */
const HOUSE_REFUSED_VERB_LIST = [
  'chat_nori',
  'update_appearance',
  'trade_token',
  'place_kit_piece',
  'claim_tutorial_quest',
  'salvage_node',
] as const satisfies readonly HatcherActionVerb[];

export const HOUSE_REFUSED_AUTONOMY_VERBS: ReadonlySet<string> = new Set<string>(HOUSE_REFUSED_VERB_LIST);
