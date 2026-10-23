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
const SKU_3 = '3b241101-e2bb-4255-8caf-4136c566a962';
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
  buyWindow: npcSimulation.autonomousCosmeticBuyWindow,
};
let body: any;
let resolved: any;
const calls: { resolve: string[]; buy: any[]; equip: any[]; balances: string[]; record: any[]; house: string[]; buyWindow: string[] } = {
  resolve: [], buy: [], equip: [], balances: [], record: [], house: [], buyWindow: [],
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
  sim.autonomousCosmeticBuyBlockedUntil.clear();
  sim.autonomousCosmeticBuyInFlight.clear();
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
  npcSimulation.autonomousCosmeticBuyWindow = async (avatarId) => { calls.buyWindow.push(avatarId); return { allowed: true, nextBuyAt: null }; };
});

afterEach(() => {
  npcSimulation.autonomousCosmeticAgentResolve = originals.resolve;
  npcSimulation.autonomousCosmeticBuy = originals.buy;
  npcSimulation.autonomousCosmeticEquip = originals.equip;
  npcSimulation.autonomousWalletBalances = originals.balances;
  npcSimulation.autonomousWalletViewRecord = originals.record;
  npcSimulation.autonomousHouseActorCheck = originals.house;
  npcSimulation.autonomousCosmeticBuyWindow = originals.buyWindow;
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

  test('a grammar or unknown-verb drop tells the model why (one line per reply), and moves nothing', async () => {
    const results: string[] = [];
    const originalResult = npcSimulation.autonomousActionResult;
    npcSimulation.autonomousActionResult = async (agentId, avatarId, text) => {
      results.push(text);
      await originalResult(agentId, avatarId, text);
    };
    const shopLine = 'Shop: that buy_cosmetic tag was not valid, so nothing was bought. Copy skuId=<id> exactly from the Cosmetics list. If the list shows nothing to buy, no buy is open now; pick a different action.';
    const cases: Array<[string, string]> = [
      ['[ACTION: buy_cosmetic(skuId=emote-wave)]', shopLine],
      [`[ACTION: buy_cosmetic(skuId=${SKU}, userId=other)]`, shopLine],
      ['[ACTION: equip_cosmetic(sku=x)]', 'Wardrobe: that equip_cosmetic tag was not valid, so nothing changed. Copy skuId=<id> exactly from the cosmetics you own.'],
      ['[ACTION: view_wallet(x=1)]', 'Wallet: view_wallet takes no parameters, so nothing happened. Write it with empty parentheses.'],
      ['[ACTION: update_appearance(color=red, color=blue)]', 'Appearance: that update_appearance tag was not valid, so nothing changed. Use only modelKey, color and gender, each once.'],
      ['[ACTION: complete_quest(questId=style-statement)]', '"complete_quest" is not an action; nothing happened. Use only verbs from your action list. To claim a quest, copy a call from the Claimable quests list.'],
    ];
    try {
      for (const [tag, line] of cases) {
        results.length = 0;
        expect(dispatch(tag)).toBe('');
        await settle();
        expect(results).toEqual([line]);
        // The driver's 200-char slot keeps the whole line.
        expect(prompt()).toContain(`- (latest) ${line}`);
      }
      // Several drops in one reply send ONE line (the driver keeps one slot).
      results.length = 0;
      dispatch('[ACTION: claim_quest(questId=a)] [ACTION: buy_cosmetic(skuId=bad)] [ACTION: chat_with_teacher()]');
      await settle();
      expect(results).toEqual(['"claim_quest" is not an action; nothing happened. Use only verbs from your action list. To claim a quest, copy a call from the Claimable quests list.']);
      // A valid tag sends no drop line of its own kind.
      results.length = 0;
      dispatch('[ACTION: emote(name=wave)]');
      await settle();
      expect(results).toEqual([]);
    } finally {
      npcSimulation.autonomousActionResult = originalResult;
    }
    expect(calls.house).toEqual([]);
    expect(calls.resolve).toEqual([]);
    expect(calls.buy).toEqual([]);
    expect(calls.equip).toEqual([]);
    expect(calls.balances).toEqual([]);
  });

  test('unknown verbs still use slots of the 4-action cap, so a later buy tag is not run', async () => {
    const results: string[] = [];
    const originalResult = npcSimulation.autonomousActionResult;
    npcSimulation.autonomousActionResult = async (_agentId, _avatarId, text) => { results.push(text); };
    try {
      dispatch(`[ACTION: a()] [ACTION: b()] [ACTION: c()] [ACTION: d()] [ACTION: buy_cosmetic(skuId=${SKU})]`);
      await settle();
      expect(calls.resolve).toEqual([]);
      expect(calls.buy).toEqual([]);
      expect(results).toEqual(['"a" is not an action; nothing happened. Use only verbs from your action list. To claim a quest, copy a call from the Claimable quests list.']);
    } finally {
      npcSimulation.autonomousActionResult = originalResult;
    }
  });

  test('a human-controlled or quarantined body runs nothing and gets no drop line', async () => {
    const results: string[] = [];
    const originalResult = npcSimulation.autonomousActionResult;
    const originalHuman = sim.isHumanControlledOpenClawNpc;
    const originalQuarantine = sim.isQuarantinedAgentNpc;
    npcSimulation.autonomousActionResult = async (_agentId, _avatarId, text) => { results.push(text); };
    try {
      sim.isHumanControlledOpenClawNpc = () => true;
      expect(dispatch('[ACTION: complete_quest(questId=x)] [ACTION: buy_cosmetic(skuId=bad)]')).toBe('');
      sim.isHumanControlledOpenClawNpc = originalHuman;
      sim.isQuarantinedAgentNpc = () => true;
      expect(dispatch('[ACTION: complete_quest(questId=x)] [ACTION: buy_cosmetic(skuId=bad)]')).toBe('');
      await settle();
      expect(results).toEqual([]);
      expect(calls.resolve).toEqual([]);
    } finally {
      npcSimulation.autonomousActionResult = originalResult;
      sim.isHumanControlledOpenClawNpc = originalHuman;
      sim.isQuarantinedAgentNpc = originalQuarantine;
    }
  });

  test('a drop with no agent attribution sends no result line', async () => {
    const results: string[] = [];
    const originalResult = npcSimulation.autonomousActionResult;
    npcSimulation.autonomousActionResult = async (_agentId, _avatarId, text) => { results.push(text); };
    sim.npcOverrides.delete(body.id);
    try {
      dispatch('[ACTION: complete_quest(questId=x)] [ACTION: buy_cosmetic(skuId=bad)]');
      await settle();
      expect(results).toEqual([]);
    } finally {
      npcSimulation.autonomousActionResult = originalResult;
    }
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
    // A new day: the DB stub allows, and the 24-hour reservation is gone.
    sim.autonomousCosmeticBuyBlockedUntil.clear();
    dispatch(`[ACTION: buy_cosmetic(skuId=${SKU_2})]`);
    await settle();
    expect(prompt()).toContain(`Shop: buy ${SKU_2} refused (insufficient_vclaw): Not enough vCLAW. Need 200, have 5.`);
  });

  test('reservation: a repeat of the same avatar, verb and sku inside 60 seconds is dropped (equip, view_wallet)', async () => {
    dispatch(`[ACTION: equip_cosmetic(skuId=${SKU})] [ACTION: equip_cosmetic(skuId=${SKU})] [ACTION: equip_cosmetic(skuId=${SKU_2})]`);
    await settle();
    expect(calls.equip.map((call) => call.skuId)).toEqual([SKU, SKU_2]);
    // The window elapses: the same intent is admitted again.
    sim.autonomousCosmeticWalletLastAdmittedAt.set(`${AVATAR}:equip_cosmetic:${SKU}`, Date.now() - 60_001);
    dispatch(`[ACTION: equip_cosmetic(skuId=${SKU})]`);
    await settle();
    expect(calls.equip).toHaveLength(3);
    // Repeated view_wallet tags fan out into one chain read, not four.
    dispatch('[ACTION: view_wallet()] [ACTION: view_wallet()] [ACTION: view_wallet()] [ACTION: view_wallet()]');
    await settle();
    expect(calls.balances).toEqual([AVATAR]);
  });

  test('a dropped duplicate still tells the model, so it stops repeating the tag', async () => {
    const results: string[] = [];
    const originalResult = npcSimulation.autonomousActionResult;
    npcSimulation.autonomousActionResult = async (agentId, avatarId, text) => {
      results.push(text);
      await originalResult(agentId, avatarId, text);
    };
    try {
      dispatch('[ACTION: view_wallet()]');
      await settle();
      const viewedAt = sim.autonomousCosmeticWalletLastAdmittedAt.get(`${AVATAR}:view_wallet:`);
      expect(viewedAt).toBeNumber();
      results.length = 0;
      dispatch('[ACTION: view_wallet()]');
      await settle();
      expect(calls.balances).toEqual([AVATAR]);
      const nextCheck = new Date(viewedAt + 10 * 60_000).toISOString();
      expect(results).toEqual([
        `Wallet: already checked; next check after ${nextCheck}. Do something else (a quest, a teacher, equip).`,
      ]);
      expect(prompt()).toContain(`Wallet: already checked; next check after ${nextCheck}.`);

      dispatch(`[ACTION: equip_cosmetic(skuId=${SKU})]`);
      await settle();
      results.length = 0;
      dispatch(`[ACTION: equip_cosmetic(skuId=${SKU})]`);
      await settle();
      expect(calls.equip).toHaveLength(1);
      expect(results).toEqual([`Wardrobe: ${SKU} was just handled; pick a different action.`]);
      expect(prompt()).toContain(`Wardrobe: ${SKU} was just handled; pick a different action.`);
    } finally {
      npcSimulation.autonomousActionResult = originalResult;
    }
  });

  describe('buy_cosmetic daily cap (one purchase per avatar per 24 hours)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    test('one reply with three different buy tags makes exactly one buy call', async () => {
      dispatch(`[ACTION: buy_cosmetic(skuId=${SKU})] [ACTION: buy_cosmetic(skuId=${SKU_2})] [ACTION: buy_cosmetic(skuId=${SKU_3})]`);
      await settle();
      expect(calls.buy).toHaveLength(1);
      expect(calls.buy[0]).toEqual({ actor: expectedActor, skuId: SKU });
      expect(calls.buyWindow).toEqual([AVATAR]);
      // The settled buy wrote the last result line, not a refusal.
      expect(prompt()).toContain(`Shop: bought ${SKU}`);
      const blockedUntil = sim.autonomousCosmeticBuyBlockedUntil.get(`${AVATAR}:buy_cosmetic`);
      expect(blockedUntil).toBeGreaterThan(Date.now() + DAY_MS - 60_000);
    });

    test('a second buy with a different sku after the first is refused with daily_limit', async () => {
      dispatch(`[ACTION: buy_cosmetic(skuId=${SKU})]`);
      await settle();
      expect(calls.buy).toHaveLength(1);
      dispatch(`[ACTION: buy_cosmetic(skuId=${SKU_2})]`);
      await settle();
      expect(calls.buy).toHaveLength(1);
      const text = prompt();
      expect(text).toContain(`Shop: buy ${SKU_2} refused (daily_limit): one cosmetic purchase per 24 hours; next buy after `);
      expect(text).toContain('Equip what you own instead.');
    });

    const KEY = `${AVATAR}:buy_cosmetic`;
    /** Simulate the 60-second retry wait elapsing (61 s later). */
    const elapseRetryWait = () => sim.autonomousCosmeticBuyBlockedUntil.set(KEY, Date.now() - 1);

    test('an ok new purchase keeps the 24-hour reservation', async () => {
      dispatch(`[ACTION: buy_cosmetic(skuId=${SKU})]`);
      await settle();
      expect(calls.buy).toHaveLength(1);
      expect(sim.autonomousCosmeticBuyBlockedUntil.get(KEY)).toBeGreaterThan(Date.now() + DAY_MS - 60_000);
      expect(sim.autonomousCosmeticBuyInFlight.has(KEY)).toBe(false);
    });

    test('insufficient_tokens holds only the 60 s retry; a buy 61 s later re-reads the DB and is admitted', async () => {
      npcSimulation.autonomousCosmeticBuy = async (actor, skuId) => {
        calls.buy.push({ actor, skuId });
        return { ok: false, status: 400, code: 'insufficient_tokens', message: 'Not enough vCLAW. Need 200, have 5.' };
      };
      dispatch(`[ACTION: buy_cosmetic(skuId=${SKU})]`);
      await settle();
      const blockedUntil = sim.autonomousCosmeticBuyBlockedUntil.get(KEY);
      expect(blockedUntil).toBeLessThanOrEqual(Date.now() + 60_000);
      expect(blockedUntil).toBeGreaterThan(Date.now() + 50_000);
      // Inside the retry wait: refused in memory, no DB read, no buy call.
      dispatch(`[ACTION: buy_cosmetic(skuId=${SKU})]`);
      await settle();
      expect(calls.buy).toHaveLength(1);
      expect(calls.buyWindow).toEqual([AVATAR]);
      // 61 s later the DB window is open: re-read and admitted.
      elapseRetryWait();
      dispatch(`[ACTION: buy_cosmetic(skuId=${SKU_2})]`);
      await settle();
      expect(calls.buyWindow).toEqual([AVATAR, AVATAR]);
      expect(calls.buy.map((call) => call.skuId)).toEqual([SKU, SKU_2]);
    });

    test('ok + alreadyOwned (no new row) holds only the 60 s retry', async () => {
      npcSimulation.autonomousCosmeticBuy = async (actor, skuId) => {
        calls.buy.push({ actor, skuId });
        return { ok: true, body: { ok: true, alreadyOwned: true, clawTokens: 940 } };
      };
      dispatch(`[ACTION: buy_cosmetic(skuId=${SKU})]`);
      await settle();
      expect(prompt()).toContain(`Shop: you already own ${SKU}; nothing was charged.`);
      expect(sim.autonomousCosmeticBuyBlockedUntil.get(KEY)).toBeLessThanOrEqual(Date.now() + 60_000);
      elapseRetryWait();
      dispatch(`[ACTION: buy_cosmetic(skuId=${SKU_2})]`);
      await settle();
      expect(calls.buy).toHaveLength(2);
    });

    test('an in-flight buy still refuses a second buy for the avatar after map pressure evicts its time reservation', async () => {
      let release: () => void = () => undefined;
      npcSimulation.autonomousCosmeticBuy = (actor, skuId) => {
        calls.buy.push({ actor, skuId });
        return new Promise((resolve) => {
          release = () => resolve({ ok: true, body: { ok: true, alreadyOwned: false, clawTokens: 740, bonusApplied: 0 } });
        });
      };
      dispatch(`[ACTION: buy_cosmetic(skuId=${SKU})]`);
      await settle();
      expect(calls.buy).toHaveLength(1);
      expect(sim.autonomousCosmeticBuyInFlight.has(KEY)).toBe(true);
      // 5,001 other avatars push the time map past its cap: the oldest write,
      // the reservation of this avatar, is evicted while its buy still runs.
      const now = Date.now();
      for (let i = 0; i <= 5_000; i += 1) {
        sim.setAutonomousCosmeticBuyBlockedUntil(`pressure-${i}:buy_cosmetic`, now + DAY_MS, now);
      }
      expect(sim.autonomousCosmeticBuyBlockedUntil.has(KEY)).toBe(false);
      dispatch(`[ACTION: buy_cosmetic(skuId=${SKU_2})]`);
      await settle();
      expect(calls.buy).toHaveLength(1);
      expect(calls.buyWindow).toEqual([AVATAR]);
      expect(prompt()).toContain(`Shop: buy ${SKU_2} refused (daily_limit)`);
      release();
      await settle();
      expect(sim.autonomousCosmeticBuyInFlight.has(KEY)).toBe(false);
      expect(prompt()).toContain(`Shop: bought ${SKU}`);
    });

    test('DB window closed: no buy call, a daily_limit line with the DB open time, and the reservation holds until then', async () => {
      const nextBuyAt = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
      npcSimulation.autonomousCosmeticBuyWindow = async (avatarId) => { calls.buyWindow.push(avatarId); return { allowed: false, nextBuyAt }; };
      dispatch(`[ACTION: buy_cosmetic(skuId=${SKU})]`);
      await settle();
      expect(calls.buyWindow).toEqual([AVATAR]);
      expect(calls.buy).toEqual([]);
      expect(prompt()).toContain(`Shop: buy ${SKU} refused (daily_limit): one cosmetic purchase per 24 hours; next buy after ${nextBuyAt}.`);
      expect(sim.autonomousCosmeticBuyBlockedUntil.get(`${AVATAR}:buy_cosmetic`)).toBe(Date.parse(nextBuyAt));
      // A later tag is refused in memory, without another DB read.
      dispatch(`[ACTION: buy_cosmetic(skuId=${SKU_2})]`);
      await settle();
      expect(calls.buyWindow).toHaveLength(1);
      expect(calls.buy).toEqual([]);
    });

    test('DB window read throws: no buy call (fail closed), and a retry re-reads the DB', async () => {
      npcSimulation.autonomousCosmeticBuyWindow = async (avatarId) => { calls.buyWindow.push(avatarId); throw new Error('db down'); };
      dispatch(`[ACTION: buy_cosmetic(skuId=${SKU})]`);
      await settle();
      expect(calls.buy).toEqual([]);
      expect(prompt()).toContain(`Shop: buy ${SKU} refused (limit_check_unavailable)`);
      const blockedUntil = sim.autonomousCosmeticBuyBlockedUntil.get(`${AVATAR}:buy_cosmetic`);
      expect(blockedUntil).toBeLessThanOrEqual(Date.now() + 60_000);
      // The short retry wait elapses; the DB still fails, so still no buy.
      sim.autonomousCosmeticBuyBlockedUntil.set(`${AVATAR}:buy_cosmetic`, Date.now() - 1);
      dispatch(`[ACTION: buy_cosmetic(skuId=${SKU})]`);
      await settle();
      expect(calls.buyWindow).toEqual([AVATAR, AVATAR]);
      expect(calls.buy).toEqual([]);
    });

    test('a guard drop releases the reservation; equip still works while buys are capped', async () => {
      resolved = null;
      dispatch(`[ACTION: buy_cosmetic(skuId=${SKU})]`);
      await settle();
      expect(sim.autonomousCosmeticBuyBlockedUntil.has(`${AVATAR}:buy_cosmetic`)).toBe(false);
      resolved = { userId: 'owner', avatarId: AVATAR, agentId: AGENT, ledgerCapable: true };
      dispatch(`[ACTION: buy_cosmetic(skuId=${SKU})]`);
      await settle();
      expect(calls.buy).toHaveLength(1);
      dispatch(`[ACTION: buy_cosmetic(skuId=${SKU_2})] [ACTION: equip_cosmetic(skuId=${SKU})]`);
      await settle();
      expect(calls.buy).toHaveLength(1);
      expect(calls.equip).toEqual([{ actor: expectedActor, skuId: SKU }]);
    });

    test('the reservation map stays bounded', () => {
      const now = Date.now();
      for (let i = 0; i < 5_010; i += 1) {
        sim.setAutonomousCosmeticBuyBlockedUntil(`avatar-${i}:buy_cosmetic`, now + DAY_MS, now);
      }
      expect(sim.autonomousCosmeticBuyBlockedUntil.size).toBeLessThanOrEqual(5_000);
      // The newest write survives; the oldest went first.
      expect(sim.autonomousCosmeticBuyBlockedUntil.has('avatar-5009:buy_cosmetic')).toBe(true);
      expect(sim.autonomousCosmeticBuyBlockedUntil.has('avatar-0:buy_cosmetic')).toBe(false);
    });
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
      buyLockedUntil: null,
    };
    const args = (isHouse: boolean) => [perception, { ...driver.userAgents.get(AGENT), isHouse }, [], null, [], undefined, undefined, undefined, undefined, undefined, targets] as const;
    const userPrompt = (agentAutonomyDriver.buildDecisionPrompt as any)(...args(false));
    expect(userPrompt).toContain(`[ACTION: equip_cosmetic(skuId=${SKU})] "Pixel Shades" (glasses)`);
    expect(userPrompt).toContain(`[ACTION: buy_cosmetic(skuId=${SKU_2})] "Kelp Crown" (hat) costs 200 vCLAW — your credit covers it`);
    expect(userPrompt).toContain('You hold 120 vCLAW and 500 cosmetic credit');
    const housePrompt = (agentAutonomyDriver.buildDecisionPrompt as any)(...args(true));
    expect(housePrompt).not.toContain('Cosmetics (server-derived');
    expect(housePrompt).not.toContain('buy_cosmetic(');
    expect(userPrompt).not.toContain('the next buy opens after');
    // Empty targets: no block.
    expect(prompt()).not.toContain('Cosmetics (server-derived');
  });

  test('decide prompt: a closed buy window lists no buys, names the open time, and keeps the equip lines', () => {
    const perception = npcSimulation.buildPerception(body.id)!;
    const lockedUntil = '2026-10-23T06:44:16.000Z';
    const locked = {
      vclawBalance: 120,
      cosmeticCredit: 0,
      ownedUnequipped: [{ skuId: SKU, displayName: 'Pixel Shades', category: 'glasses' }],
      purchasable: [],
      buyLockedUntil: lockedUntil,
    };
    const build = (targets: unknown, isHouse = false) => (agentAutonomyDriver.buildDecisionPrompt as any)(
      perception, { ...driver.userAgents.get(AGENT), isHouse }, [], null, [], undefined, undefined, undefined, undefined, undefined, targets,
    );
    const text = build(locked);
    expect(text).toContain(`the next buy opens after ${lockedUntil}. Equip a cosmetic you own instead.`);
    expect(text).toContain(`[ACTION: equip_cosmetic(skuId=${SKU})] "Pixel Shades" (glasses)`);
    expect(text).not.toContain('Buyable (cheapest first)');
    // Locked with nothing to equip: the block still says why there is no buy.
    expect(build({ ...locked, ownedUnequipped: [] })).toContain('the next buy opens after');
    // House agents never see the block.
    expect(build(locked, true)).not.toContain('Cosmetics (server-derived');
  });
});

describe('decide prompt quest block', () => {
  const build = (quests: unknown[]) => (agentAutonomyDriver.buildDecisionPrompt as any)(
    npcSimulation.buildPerception(body.id)!, driver.userAgents.get(AGENT), [], null, [], undefined, quests,
  );

  test('a READY quest carries the exact call (and it parses); an unfinished one has no call', async () => {
    const text = build([
      { questId: 'style-statement', title: 'Style Statement', rail: 'vclaw', reward: 30, requirement: 'buy and equip a cosmetic', ready: true },
      { questId: 'say-hi-nori', title: 'Say Hi', rail: 'vclaw', reward: 5, requirement: 'chat with Nori once', ready: false },
    ]);
    expect(text).toContain('Claimable quests (server-derived; READY ones have their proof; copy one exact call):');
    const readyLine = '- [ACTION: claim_tutorial_quest(questId=style-statement)] READY "Style Statement" pays 30 vCLAW';
    expect(text).toContain(readyLine);
    expect(text).toContain('- say-hi-nori: "Say Hi" pays 5 vCLAW — not done yet: chat with Nori once');
    expect(text).not.toContain('claim_tutorial_quest(questId=say-hi-nori)');
    expect(text).not.toContain('none ready yet');
    // The printed call reaches the claim settle unchanged.
    const claimed: string[] = [];
    const originalClaim = sim.settleAutonomousQuestClaim;
    sim.settleAutonomousQuestClaim = async (_npcId: string, _attribution: unknown, questId: string) => { claimed.push(questId); };
    try {
      dispatch(readyLine);
      await settle();
    } finally {
      sim.settleAutonomousQuestClaim = originalClaim;
    }
    expect(claimed).toEqual(['style-statement']);
  });

  test('no READY quest: no call at all, plus the "none ready yet" line', () => {
    const text = build([
      { questId: 'say-hi-nori', title: 'Say Hi', rail: 'vclaw', reward: 5, requirement: 'chat with Nori once', ready: false },
    ]);
    expect(text).not.toContain('[ACTION: claim_tutorial_quest(questId=');
    expect(text).toContain('- say-hi-nori: "Say Hi" pays 5 vCLAW — not done yet: chat with Nori once\n- none ready yet; do the step a quest requires first.');
    expect(build([])).toContain('- none claimable right now');
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
