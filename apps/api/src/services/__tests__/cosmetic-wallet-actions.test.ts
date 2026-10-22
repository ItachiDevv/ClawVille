import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { HATCHER_ACTION_MENU, HATCHER_ACTION_VERBS } from '@clawville/shared';
import { npcSimulation } from '../npc-simulation';
import { agentAutonomyDriver } from '../agent-autonomy-driver';
import { HOUSE_REFUSED_AUTONOMY_VERBS } from '../house-refused-verbs';
import { selectQuestTargets } from '../autonomous-quest-targets';

const sim = npcSimulation as any;
const driver = agentAutonomyDriver as any;
const SKU = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SKU_2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const AGENT = 'cosmetic-test-agent';
const AVATAR = 'cosmetic-test-avatar';
const SESSION = 'cosmetic-test-session';
const originals = {
  resolve: npcSimulation.autonomousCosmeticAgentResolve,
  buy: npcSimulation.autonomousCosmeticBuy,
  equip: npcSimulation.autonomousCosmeticEquip,
  balances: npcSimulation.autonomousWalletBalances,
  record: npcSimulation.autonomousWalletViewRecord,
  house: npcSimulation.autonomousHouseActorCheck,
};
let body: any;
let resolved: any;
const calls: { resolve: string[]; buy: any[]; equip: any[]; balances: string[]; record: any[]; house: string[] } = {
  resolve: [], buy: [], equip: [], balances: [], record: [], house: [],
};
let balancesResult: any;

beforeEach(() => {
  for (const list of Object.values(calls)) list.length = 0;
  sim.initNpcs();
  const bodyId = sim.avatarBodyId(AGENT);
  body = { ...sim.npcs.values().next().value, id: bodyId, isOpenClaw: true };
  sim.npcs.set(bodyId, body);
  sim.npcOverrides.set(bodyId, SESSION);
  sim.agentBotSessions.set(SESSION, { config: { mode: 'avatar', agentId: AGENT, avatarId: AVATAR, boundUserId: 'owner', ledgerCapable: true } });
  sim.autonomousCosmeticWalletLastAdmittedAt.clear();
  driver.userAgents.set(AGENT, { agentId: AGENT, avatarId: AVATAR, bodyId, lastLesson: null, lastBuildingId: null, isHouse: false });
  resolved = { userId: 'owner', avatarId: AVATAR, agentId: AGENT, ledgerCapable: true };
  balancesResult = {
    ok: true,
    wallet: 'Wallet1111111111111111111111111111111111111',
    network: 'mainnet-beta',
    withdrawEnabled: false,
    balances: {
      SOL: { available: true, amountAtomic: '500000000', decimals: 9, uiAmount: 0.5 },
      USDC: { available: true, amountAtomic: '1250000', decimals: 6, uiAmount: 1.25 },
      CLV: { available: false, amountAtomic: null, decimals: 6, uiAmount: null },
    },
  };
  npcSimulation.autonomousHouseActorCheck = async (agentId) => { calls.house.push(agentId); return false; };
  npcSimulation.autonomousCosmeticAgentResolve = async (sessionId) => { calls.resolve.push(sessionId); return resolved; };
  npcSimulation.autonomousCosmeticBuy = async (actor, skuId) => {
    calls.buy.push({ actor, skuId });
    return { ok: true, body: { ok: true, alreadyOwned: false, clawTokens: 940, bonusApplied: 60 } };
  };
  npcSimulation.autonomousCosmeticEquip = async (actor, skuId) => { calls.equip.push({ actor, skuId }); return { ok: true, equipped: true }; };
  npcSimulation.autonomousWalletBalances = async (avatarId) => { calls.balances.push(avatarId); return balancesResult; };
  npcSimulation.autonomousWalletViewRecord = async (actor) => { calls.record.push(actor); };
});

afterEach(() => {
  npcSimulation.autonomousCosmeticAgentResolve = originals.resolve;
  npcSimulation.autonomousCosmeticBuy = originals.buy;
  npcSimulation.autonomousCosmeticEquip = originals.equip;
  npcSimulation.autonomousWalletBalances = originals.balances;
  npcSimulation.autonomousWalletViewRecord = originals.record;
  npcSimulation.autonomousHouseActorCheck = originals.house;
  sim.npcs.delete(body.id); sim.npcOverrides.delete(body.id); sim.agentBotSessions.delete(SESSION);
  driver.userAgents.delete(AGENT);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const dispatch = (reply: string) => npcSimulation.dispatchHatcherActions(body.id, reply);
const expectedActor = { kind: 'agent', userId: 'owner', avatarId: AVATAR, agentId: AGENT, ledgerCapable: true };
const prompt = () => agentAutonomyDriver.buildDecisionPrompt(npcSimulation.buildPerception(body.id)!, driver.userAgents.get(AGENT));

describe('view_wallet / equip_cosmetic / buy_cosmetic hosted actions', () => {
  test('the three verbs are on the executor whitelist, the decide menu, and the house refusal set', () => {
    for (const verb of ['view_wallet', 'equip_cosmetic', 'buy_cosmetic'] as const) {
      expect(HATCHER_ACTION_VERBS).toContain(verb);
      expect(HATCHER_ACTION_MENU.find((item) => item.verb === verb)).toBeDefined();
      expect(HOUSE_REFUSED_AUTONOMY_VERBS.has(verb)).toBe(true);
      expect(prompt()).toContain(`${verb}(`);
    }
  });

  test('strict grammar: unknown, extra, duplicate, empty, or malformed params drop the action before any resolve', async () => {
    for (const tag of [
      '[ACTION: view_wallet(x=1)]',
      '[ACTION: view_wallet(avatarId=other)]',
      '[ACTION: equip_cosmetic()]',
      '[ACTION: equip_cosmetic(skuId=not-a-uuid)]',
      `[ACTION: equip_cosmetic(sku=${SKU})]`,
      `[ACTION: buy_cosmetic(skuId=${SKU}, userId=other)]`,
      `[ACTION: buy_cosmetic(skuId=${SKU}, skuId=${SKU_2})]`,
      `[ACTION: buy_cosmetic(skuId=${SKU},)]`,
      `[ACTION: buy_cosmetic(skuId=${SKU}x)]`,
      `[ACTION: buy_cosmetic(variantId=${SKU})]`,
    ]) {
      expect(dispatch(tag)).toBe('');
    }
    await settle();
    expect(calls.house).toEqual([]);
    expect(calls.resolve).toEqual([]);
    expect(calls.buy).toEqual([]);
    expect(calls.equip).toEqual([]);
    expect(calls.balances).toEqual([]);
  });

  test('a house actor is refused before any session resolve; a failed house check fails closed', async () => {
    npcSimulation.autonomousHouseActorCheck = async (agentId) => { calls.house.push(agentId); return true; };
    dispatch(`[ACTION: view_wallet()] [ACTION: equip_cosmetic(skuId=${SKU})] [ACTION: buy_cosmetic(skuId=${SKU})]`);
    await settle();
    expect(calls.house).toEqual([AGENT, AGENT, AGENT]);
    expect(calls.resolve).toEqual([]);
    expect(calls.buy).toEqual([]);
    expect(calls.equip).toEqual([]);
    expect(calls.record).toEqual([]);

    npcSimulation.autonomousHouseActorCheck = async () => { throw new Error('db down'); };
    dispatch(`[ACTION: buy_cosmetic(skuId=${SKU})]`);
    await settle();
    expect(calls.resolve).toEqual([]);
    expect(calls.buy).toEqual([]);
  });

  test('guards: no session, non-ledger, unbound, and changed binding never reach a service', async () => {
    for (const next of [
      null,
      { ...resolved, ledgerCapable: false },
      { ...resolved, avatarId: null },
      { ...resolved, userId: null },
      { ...resolved, avatarId: 'replacement-avatar' },
    ]) {
      resolved = next;
      dispatch(`[ACTION: view_wallet()] [ACTION: equip_cosmetic(skuId=${SKU})] [ACTION: buy_cosmetic(skuId=${SKU})]`);
      await settle();
    }
    expect(calls.resolve.length).toBe(15);
    expect(calls.buy).toEqual([]);
    expect(calls.equip).toEqual([]);
    expect(calls.balances).toEqual([]);
    expect(calls.record).toEqual([]);
    // A resolver that throws drops the action too.
    npcSimulation.autonomousCosmeticAgentResolve = async () => { throw new Error('session store down'); };
    dispatch(`[ACTION: buy_cosmetic(skuId=${SKU})]`);
    await settle();
    expect(calls.buy).toEqual([]);
    // Unattributed body: dropped before any async work.
    sim.npcOverrides.delete(body.id);
    dispatch(`[ACTION: buy_cosmetic(skuId=${SKU})]`);
    await settle();
    expect(calls.house).toHaveLength(16);
  });

  test('success: services get the live bound avatar actor; buy and equip results reach the next decision', async () => {
    dispatch(`[ACTION: buy_cosmetic(skuId=${SKU.toUpperCase()})]`);
    await settle();
    expect(calls.buy).toEqual([{ actor: expectedActor, skuId: SKU }]);
    expect(prompt()).toContain(`Shop: bought ${SKU} (cosmetic credit used 60). Your vCLAW balance is 940.`);

    dispatch(`[ACTION: equip_cosmetic(skuId=${SKU})]`);
    await settle();
    expect(calls.equip).toEqual([{ actor: expectedActor, skuId: SKU }]);
    expect(prompt()).toContain(`Wardrobe: you now wear cosmetic ${SKU}.`);

    npcSimulation.autonomousCosmeticBuy = async () => ({ ok: false, status: 400, code: 'insufficient_vclaw', message: 'Not enough vCLAW. Need 200, have 5.' });
    dispatch(`[ACTION: buy_cosmetic(skuId=${SKU_2})]`);
    await settle();
    expect(prompt()).toContain(`Shop: buy ${SKU_2} refused (insufficient_vclaw): Not enough vCLAW. Need 200, have 5.`);
  });

  test('reservation: a repeat of the same avatar, verb and sku inside 60 seconds is dropped', async () => {
    dispatch(`[ACTION: buy_cosmetic(skuId=${SKU})] [ACTION: buy_cosmetic(skuId=${SKU})] [ACTION: buy_cosmetic(skuId=${SKU_2})]`);
    await settle();
    expect(calls.buy.map((call) => call.skuId)).toEqual([SKU, SKU_2]);
    dispatch(`[ACTION: buy_cosmetic(skuId=${SKU})]`);
    await settle();
    expect(calls.buy).toHaveLength(2);
    // The window elapses: the same intent is admitted again.
    const key = `${AVATAR}:buy_cosmetic:${SKU}`;
    sim.autonomousCosmeticWalletLastAdmittedAt.set(key, Date.now() - 60_001);
    dispatch(`[ACTION: buy_cosmetic(skuId=${SKU})]`);
    await settle();
    expect(calls.buy).toHaveLength(3);
    // Repeated view_wallet tags fan out into one chain read, not four.
    dispatch('[ACTION: view_wallet()] [ACTION: view_wallet()] [ACTION: view_wallet()] [ACTION: view_wallet()]');
    await settle();
    expect(calls.balances).toEqual([AVATAR]);
  });

  test('view_wallet records the view, reads the bound avatar, and the summary reaches the next decision', async () => {
    dispatch('[ACTION: view_wallet()]');
    await settle();
    expect(calls.record).toEqual([expectedActor]);
    expect(calls.balances).toEqual([AVATAR]);
    const text = prompt();
    expect(text).toContain('Wallet: custodial balances SOL 0.5, USDC 1.25, CLV unreadable now; withdrawals are off.');
    expect(text).not.toContain(balancesResult.wallet);

    // No custodial wallet: still recorded, still answered.
    sim.autonomousCosmeticWalletLastAdmittedAt.clear();
    balancesResult = { ok: false, code: 'wallet_missing' };
    npcSimulation.autonomousWalletViewRecord = async (actor) => { calls.record.push(actor); throw new Error('recorder broke'); };
    dispatch('[ACTION: view_wallet()]');
    await settle();
    expect(calls.record).toHaveLength(2);
    expect(prompt()).toContain('Wallet: you have no custodial wallet yet');
  });

  test('decide prompt lists valid sku ids for a user agent and never for a house agent', () => {
    const perception = npcSimulation.buildPerception(body.id)!;
    const targets = {
      vclawBalance: 120,
      cosmeticCredit: 500,
      ownedUnequipped: [{ skuId: SKU, displayName: 'Pixel Shades', category: 'glasses' }],
      purchasable: [{ skuId: SKU_2, displayName: 'Kelp Crown', category: 'hat', priceVclaw: 200, creditCovers: true, affordable: true }],
    };
    const args = (isHouse: boolean) => [perception, { ...driver.userAgents.get(AGENT), isHouse }, [], null, [], undefined, undefined, undefined, undefined, undefined, targets] as const;
    const userPrompt = (agentAutonomyDriver.buildDecisionPrompt as any)(...args(false));
    expect(userPrompt).toContain(`[ACTION: equip_cosmetic(skuId=${SKU})] "Pixel Shades" (glasses)`);
    expect(userPrompt).toContain(`[ACTION: buy_cosmetic(skuId=${SKU_2})] "Kelp Crown" (hat) costs 200 vCLAW — your credit covers it`);
    expect(userPrompt).toContain('You hold 120 vCLAW and 500 cosmetic credit');
    const housePrompt = (agentAutonomyDriver.buildDecisionPrompt as any)(...args(true));
    expect(housePrompt).not.toContain('Cosmetics (server-derived');
    expect(housePrompt).not.toContain('buy_cosmetic(');
    // Empty targets: no block.
    expect(prompt()).not.toContain('Cosmetics (server-derived');
  });
});

describe('autonomous quest target ordering', () => {
  test('actionable quests come first and the six slots span tiers', () => {
    const fresh = selectQuestTargets(new Set()).map((quest) => quest.questId);
    expect(fresh).toEqual(['say-hi-nori', 'town-briefing', 'town-tour', 'style-statement', 'wallet-aware', 'homesteader']);
  });

  test('once tiers 1-3 are claimed, tier 4 no longer crowds out wallet-aware and the land quests', () => {
    const claimed = new Set([
      'say-hi-nori', 'meet-your-agent', 'first-steps', 'town-briefing', 'bonded', 'door-knocker',
      'town-tour', 'star-pupil', 'cartographer',
    ]);
    const ids = selectQuestTargets(claimed).map((quest) => quest.questId);
    expect(ids).toHaveLength(6);
    expect(ids).toContain('wallet-aware');
    expect(ids).toContain('homesteader');
    expect(ids.slice(0, 5)).toEqual(['style-statement', 'wallet-aware', 'homesteader', 'big-spender', 'yard-work']);
    for (const id of ids) expect(claimed.has(id)).toBe(false);
  });
});
