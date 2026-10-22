import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  BUILDING_INTERACTION_RADIUS,
  HATCHER_ACTION_MENU,
  HOUSE_PLAY_COVE_GAME_MENU_ITEM,
  MAP_LOCATIONS,
} from '@clawville/shared';
import { npcSimulation } from '../npc-simulation';
import { agentAutonomyDriver, decisionThought } from '../agent-autonomy-driver';

// Shared-table baccarat through the hosted-agent [ACTION:] executor
// (spec baccarat-shared-table-port-2026-10-22 §6.3). The manager seam is
// injected, so this file needs no DB and no table manager.

interface TestNpc {
  id: string;
  name: string;
  x: number;
  y: number;
  path: Array<{ x: number; y: number }>;
  [key: string]: unknown;
}

type BaccaratSeamInput = Parameters<typeof npcSimulation.autonomousCoveBaccaratBet>[0];

interface SimInternals {
  npcs: Map<string, TestNpc>;
  agentBotSessions: Map<string, {
    config: { agentId: string; mode: 'avatar'; avatarId?: string };
    client: { getProtocol: () => string };
  }>;
  npcOverrides: Map<string, string>;
  pendingEvents: unknown[];
  missingActionAttributionWarned: Set<string>;
  autonomousCovePlayLastAdmittedAt: Map<string, number>;
  initNpcs: () => void;
}

const sim = npcSimulation as unknown as SimInternals;
const original = {
  slots: npcSimulation.autonomousCoveSlotsPlay,
  blackjack: npcSimulation.autonomousCoveBlackjackPlay,
  baccarat: npcSimulation.autonomousCoveBaccaratBet,
  resolve: npcSimulation.autonomousCoveAgentResolve,
  house: npcSimulation.autonomousHouseActorCheck,
};
const AVATAR = 'baccarat-executor-avatar';
const USER = 'baccarat-executor-user';
const cove = MAP_LOCATIONS.find((location) => location.id === 'cove')!;
const COVE_X = cove.positionX + cove.width / 2;
const COVE_Y = cove.positionY + cove.height / 2;

function body(id: string, x = COVE_X, y = COVE_Y): TestNpc {
  return {
    id,
    name: 'BaccaratAgent',
    x,
    y,
    targetX: x,
    targetY: y,
    homeX: x,
    homeY: y,
    patrolRadius: 100,
    direction: 'idle',
    species: 'milady_official_1',
    color: 0,
    inConversation: false,
    conversationCooldownUntil: 0,
    activity: 'idle',
    activityEmoji: '',
    destinationBuildingId: null,
    path: [],
    pathIndex: 0,
    activityEndsAt: 0,
    behaviorCooldown: 0,
    intentDescription: '',
    stuckTicks: 0,
    overlapTicks: 0,
    headingAngle: 0,
    hp: 100,
    maxHp: 100,
    attack: 10,
    defense: 10,
    speed: 10,
    inCombat: false,
    inventory: [],
    isDead: false,
    respawnAt: 0,
    hasSword: false,
    isOpenClaw: true,
    level: 1,
    kills: 0,
    xp: 0,
    baseAttack: 10,
    baseDefense: 10,
    baseSpeed: 10,
    baseMaxHp: 100,
    combatTargetId: null,
    lastAttackAt: 0,
    lastHitAt: 0,
    respawnedAt: 0,
    invulnerableUntil: 0,
    combatAction: null,
    combatActionAt: 0,
    autonomyMode: 'self-managed',
  };
}

/** Registers a bound hosted body at (x, y) and returns its npc id. */
function bindBody(id: string, x = COVE_X, y = COVE_Y): TestNpc {
  const npc = body(id, x, y);
  sim.npcs.set(npc.id, npc);
  sim.agentBotSessions.set(`${id}-session`, {
    config: { agentId: npc.id, mode: 'avatar', avatarId: AVATAR },
    client: { getProtocol: () => 'hatcher-proxy' },
  });
  sim.npcOverrides.set(npc.id, `${id}-session`);
  npcSimulation.autonomousCoveAgentResolve = async () => ({
    agentId: npc.id,
    userId: USER,
    avatarId: AVATAR,
    ledgerCapable: true,
  });
  return npc;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Each dispatch in its own clean limiter window, so a drop is never a rate-limit artifact. */
async function dispatchFresh(npcId: string, tag: string): Promise<void> {
  sim.autonomousCovePlayLastAdmittedAt.clear();
  npcSimulation.dispatchHatcherActions(npcId, tag);
  await flush();
}

let baccaratCalls: BaccaratSeamInput[];
let slotsCalls: number;
let blackjackCalls: number;

beforeEach(() => {
  npcSimulation.stop();
  sim.initNpcs();
  sim.agentBotSessions.clear();
  sim.npcOverrides.clear();
  sim.pendingEvents = [];
  sim.missingActionAttributionWarned.clear();
  sim.autonomousCovePlayLastAdmittedAt.clear();
  baccaratCalls = [];
  slotsCalls = 0;
  blackjackCalls = 0;
  npcSimulation.autonomousHouseActorCheck = async () => false;
  npcSimulation.autonomousCoveBaccaratBet = async (input) => {
    baccaratCalls.push(input);
    return { tableId: 'table-1', roundSeq: 4, seatIndex: 2, seated: true };
  };
  npcSimulation.autonomousCoveSlotsPlay = async () => { slotsCalls++; };
  npcSimulation.autonomousCoveBlackjackPlay = async () => { blackjackCalls++; };
});

afterEach(() => {
  npcSimulation.autonomousCoveSlotsPlay = original.slots;
  npcSimulation.autonomousCoveBlackjackPlay = original.blackjack;
  npcSimulation.autonomousCoveBaccaratBet = original.baccarat;
  npcSimulation.autonomousCoveAgentResolve = original.resolve;
  npcSimulation.autonomousHouseActorCheck = original.house;
});

describe('play_cove_game(game=baccarat) executor', () => {
  it('calls the shared-table seam once with the live binding, bet and wager', async () => {
    const npc = bindBody('bac-live');
    const speech = npcSimulation.dispatchHatcherActions(
      npc.id,
      'Banker it is. [ACTION: play_cove_game(game=baccarat, bet=banker, wager=20)]',
    );
    await flush();

    expect(speech).toBe('Banker it is.');
    expect(baccaratCalls).toEqual([
      {
        agentSessionId: 'bac-live-session',
        expectedAgentId: npc.id,
        expectedAvatarId: AVATAR,
        expectedUserId: USER,
        bet: 'banker',
        wager: 20,
      },
    ]);
    expect(slotsCalls).toBe(0);
    expect(blackjackCalls).toBe(0);
    expect(npc.destinationBuildingId).toBe('cove');
    expect(npc.intentDescription).toBe('betting 20 vCLAW on banker at a shared baccarat table');
  });

  it('shares the 30 s per-avatar cove interval with the other games', async () => {
    const npc = bindBody('bac-rate');
    npcSimulation.dispatchHatcherActions(npc.id, '[ACTION: play_cove_game(game=baccarat, bet=tie, wager=5)]');
    await flush();
    npcSimulation.dispatchHatcherActions(npc.id, '[ACTION: play_cove_game(game=baccarat, bet=tie, wager=5)]');
    npcSimulation.dispatchHatcherActions(npc.id, '[ACTION: play_cove_game(game=slots, wager=20)]');
    await flush();
    expect(baccaratCalls).toHaveLength(1);
    expect(slotsCalls).toBe(0);
  });

  it('requires bet for baccarat and accepts only player, banker or tie', async () => {
    const npc = bindBody('bac-bet');
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=baccarat, wager=20)]');
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=baccarat, bet=dragon, wager=20)]');
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=baccarat, bet=, wager=20)]');
    expect(baccaratCalls).toHaveLength(0);

    for (const side of ['player', 'banker', 'tie'] as const) {
      await dispatchFresh(npc.id, `[ACTION: play_cove_game(game=baccarat, bet=${side}, wager=50)]`);
    }
    expect(baccaratCalls.map((call) => call.bet)).toEqual(['player', 'banker', 'tie']);
  });

  it('drops an unknown parameter', async () => {
    const npc = bindBody('bac-unknown');
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=baccarat, bet=player, wager=20, tableId=abc)]');
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=baccarat, bet=player, wager=20, side=player)]');
    expect(baccaratCalls).toHaveLength(0);
  });

  it('refuses bet on slots and blackjack', async () => {
    const npc = bindBody('bac-other-games');
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=slots, wager=20, bet=banker)]');
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=blackjack, wager=5, bet=player)]');
    expect(slotsCalls).toBe(0);
    expect(blackjackCalls).toBe(0);
    expect(baccaratCalls).toHaveLength(0);

    // Without bet the other games still settle.
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=slots, wager=20)]');
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=blackjack, wager=5)]');
    expect(slotsCalls).toBe(1);
    expect(blackjackCalls).toBe(1);
  });

  it('enforces the baccarat wager bounds 5..500 (integer)', async () => {
    const npc = bindBody('bac-bounds');
    for (const wager of ['4', '501', '0', '-5', '20.5', '1e2', 'abc', '']) {
      await dispatchFresh(npc.id, `[ACTION: play_cove_game(game=baccarat, bet=player, wager=${wager})]`);
    }
    expect(baccaratCalls).toHaveLength(0);

    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=baccarat, bet=player, wager=5)]');
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=baccarat, bet=player, wager=500)]');
    // Not a slots step: baccarat takes any integer in bounds.
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=baccarat, bet=player, wager=37)]');
    expect(baccaratCalls.map((call) => call.wager)).toEqual([5, 500, 37]);
  });

  it('refuses a house actor for baccarat only, before any session resolve', async () => {
    const npc = bindBody('bac-house');
    npcSimulation.autonomousHouseActorCheck = async () => true;
    let resolves = 0;
    const resolve = npcSimulation.autonomousCoveAgentResolve;
    npcSimulation.autonomousCoveAgentResolve = async (sessionId, agentId) => {
      resolves++;
      return resolve(sessionId, agentId);
    };

    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=baccarat, bet=banker, wager=20)]');
    expect(baccaratCalls).toHaveLength(0);
    expect(resolves).toBe(0);
    // The refusal reserves no interval: the next play is not rate-limited.
    expect(sim.autonomousCovePlayLastAdmittedAt.size).toBe(0);

    // The house keeps slots (it is the counterparty there).
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=slots, wager=20)]');
    expect(slotsCalls).toBe(1);
  });

  it('fails closed when the house actor check throws', async () => {
    const npc = bindBody('bac-house-throw');
    npcSimulation.autonomousHouseActorCheck = async () => {
      throw new Error('db down');
    };
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=baccarat, bet=banker, wager=20)]');
    expect(baccaratCalls).toHaveLength(0);
  });

  it('drops a body outside the cove radius', async () => {
    const npc = bindBody('bac-far', COVE_X + BUILDING_INTERACTION_RADIUS + 1, COVE_Y);
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=baccarat, bet=player, wager=20)]');
    expect(baccaratCalls).toHaveLength(0);

    npc.x = COVE_X;
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=baccarat, bet=player, wager=20)]');
    expect(baccaratCalls).toHaveLength(1);
  });

  it('drops when the live binding changed, is not ledger-capable, or has no avatar', async () => {
    const npc = bindBody('bac-binding');
    npcSimulation.autonomousCoveAgentResolve = async () => ({
      agentId: npc.id, userId: USER, avatarId: 'some-other-avatar', ledgerCapable: true,
    });
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=baccarat, bet=player, wager=20)]');
    npcSimulation.autonomousCoveAgentResolve = async () => ({
      agentId: npc.id, userId: USER, avatarId: AVATAR, ledgerCapable: false,
    });
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=baccarat, bet=player, wager=20)]');
    npcSimulation.autonomousCoveAgentResolve = async () => ({
      agentId: npc.id, userId: null, avatarId: null, ledgerCapable: true,
    });
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=baccarat, bet=player, wager=20)]');
    npcSimulation.autonomousCoveAgentResolve = async () => null;
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=baccarat, bet=player, wager=20)]');
    expect(baccaratCalls).toHaveLength(0);
  });

  it('swallows a manager refusal (no throw out of the executor)', async () => {
    const npc = bindBody('bac-refused');
    npcSimulation.autonomousCoveBaccaratBet = async () => {
      throw new Error('already_seated_elsewhere');
    };
    await dispatchFresh(npc.id, '[ACTION: play_cove_game(game=baccarat, bet=player, wager=20)]');
    expect(npc.intentDescription).not.toContain('baccarat');
  });

  it('the decision thought names the baccarat wager and side, and falls back on bad params', () => {
    expect(decisionThought({ verb: 'play_cove_game', params: { game: 'baccarat', bet: 'banker', wager: '20' } }))
      .toBe('Playing baccarat at the Cove — 20 vCLAW on banker');
    expect(decisionThought({ verb: 'play_cove_game', params: { game: 'baccarat', wager: '20' } }))
      .toBe('Playing at the Cove');
    expect(decisionThought({ verb: 'play_cove_game', params: { game: 'baccarat', bet: 'dragon', wager: '20' } }))
      .toBe('Playing at the Cove');
  });

  it('the decide-menu syntax names baccarat, its bet param and its bounds', () => {
    const item = HATCHER_ACTION_MENU.find((action) => action.verb === 'play_cove_game')!;
    expect(item.syntax).toContain('game=<slots|blackjack|baccarat>');
    expect(item.syntax).toContain('baccarat 5..500 int');
    expect(item.syntax).toContain('bet=<player|banker|tie; baccarat only>');
    expect(item.whenToUse).toContain('baccarat places one bet at a shared table');
  });
});

// Consumption mandate: the executor refuses a HOUSE actor for game=baccarat,
// so the house decide prompt must not offer it; every other actor keeps it.
describe('play_cove_game decide menu per actor', () => {
  const HOUSE_ID = 'baccarat-menu-house';

  afterEach(() => {
    agentAutonomyDriver.unregisterHouseAgent(HOUSE_ID);
  });

  function prompts(): { house: string; user: string } {
    sim.npcs.set(HOUSE_ID, body(HOUSE_ID));
    agentAutonomyDriver.registerHouseAgent({
      agentId: HOUSE_ID,
      bodyId: HOUSE_ID,
      platformAgentId: `platform-${HOUSE_ID}`,
      systemUserId: `system-${HOUSE_ID}`,
      houseUserId: `house-${HOUSE_ID}`,
      avatarId: `avatar-${HOUSE_ID}`,
    });
    const entry = (agentAutonomyDriver as unknown as { houseAgents: Map<string, { isHouse: boolean }> })
      .houseAgents.get(HOUSE_ID)!;
    expect(entry.isHouse).toBe(true);
    const perception = npcSimulation.buildPerception(HOUSE_ID)!;
    return {
      house: agentAutonomyDriver.buildDecisionPrompt(perception, entry as never),
      user: agentAutonomyDriver.buildDecisionPrompt(perception, { ...entry, isHouse: false } as never),
    };
  }

  it('a house actor sees play_cove_game for slots and blackjack only, in the menu and the here-now line', () => {
    const { house } = prompts();
    expect(house).toContain(`- ${HOUSE_PLAY_COVE_GAME_MENU_ITEM.syntax} — ${HOUSE_PLAY_COVE_GAME_MENU_ITEM.whenToUse}`);
    expect(house).toContain(`you can play right now — [ACTION: ${HOUSE_PLAY_COVE_GAME_MENU_ITEM.syntax}]`);
    expect(house).not.toContain('game=<slots|blackjack|baccarat>');
    expect(house).not.toContain('game=baccarat');
    expect(house).not.toContain('bet=<player|banker|tie');
    expect(house).not.toContain('baccarat 5..500');
    expect(house).not.toContain('baccarat places one bet');
  });

  it('a non-house actor keeps the full play_cove_game item with baccarat', () => {
    const { user } = prompts();
    const full = HATCHER_ACTION_MENU.find((action) => action.verb === 'play_cove_game')!;
    expect(user).toContain(`- ${full.syntax} — ${full.whenToUse}`);
    expect(user).toContain(`you can play right now — [ACTION: ${full.syntax}]`);
    expect(user).toContain('game=<slots|blackjack|baccarat>');
    expect(user).toContain('bet=<player|banker|tie; baccarat only>');
  });
});
