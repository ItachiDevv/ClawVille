import { afterEach, beforeEach, expect, test } from 'bun:test';
import { AVATAR_COLORS, DECISION_SCOPE, HATCHER_ACTION_MENU, HATCHER_ACTION_VERBS, HOUSE_PLAY_COVE_GAME_MENU_ITEM, CLAWVILLE_GAME_TOOLS } from '@clawville/shared';
import { npcSimulation } from '../npc-simulation';
import { agentAutonomyDriver } from '../agent-autonomy-driver';
import { HOUSE_REFUSED_AUTONOMY_VERBS } from '../house-refused-verbs';
const sim = npcSimulation as any;
const original = npcSimulation.autonomousAppearanceUpdate;
const originalHouseCheck = npcSimulation.autonomousHouseActorCheck;
const requests: any[] = [];
let body: any;
let session: any;
beforeEach(() => {
  requests.length = 0;
  sim.initNpcs();
  body = { ...sim.npcs.values().next().value, id: 'appearance-test-body', isOpenClaw: true };
  session = { config: { mode: 'avatar', agentId: 'external-appearance-agent', avatarId: 'appearance-avatar', boundUserId: 'appearance-owner', ledgerCapable: true } };
  sim.npcs.set(body.id, body);
  sim.npcOverrides.set(body.id, 'appearance-session');
  sim.agentBotSessions.set('appearance-session', session);
  // The body lookup normally derives from external agent ID.
  body.id = sim.avatarBodyId(session.config.agentId);
  sim.npcs.delete('appearance-test-body'); sim.npcOverrides.delete('appearance-test-body');
  sim.npcs.set(body.id, body); sim.npcOverrides.set(body.id, 'appearance-session');
  npcSimulation.autonomousAppearanceUpdate = async (input) => { requests.push(input); };
  npcSimulation.autonomousHouseActorCheck = async () => false;
});
afterEach(() => {
  npcSimulation.autonomousAppearanceUpdate = original;
  npcSimulation.autonomousHouseActorCheck = originalHouseCheck;
  sim.npcs.delete(body.id); sim.npcOverrides.delete(body.id); sim.agentBotSessions.delete('appearance-session');
});
const dispatch = (params: string) => npcSimulation.dispatchHatcherActions(body.id, `[ACTION: update_appearance(${params})]`);
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
test('actual parser calls shared service with exact actor and full decision menu', async () => {
  dispatch('color=red, gender=female'); await settle();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ actor: { kind: 'agent', sessionId: 'appearance-session', expectedAgentId: 'external-appearance-agent', expectedAvatarId: 'appearance-avatar' }, patch: { color: 'red', gender: 'female' } });
  expect(requests[0].isCurrent()).toBe(true);
  expect(HATCHER_ACTION_VERBS).toHaveLength(18);
  const prompt = agentAutonomyDriver.buildDecisionPrompt(npcSimulation.buildPerception(body.id)!, { agentId: session.config.agentId, avatarId: session.config.avatarId, bodyId: body.id, lastLesson: null, lastBuildingId: null } as any);
  for (const verb of HATCHER_ACTION_VERBS) expect(prompt).toContain(`${verb}(`);
  expect(CLAWVILLE_GAME_TOOLS.find((tool) => tool.name === 'clawville_update_appearance')?.description).toContain('PATCH /api/avatars/me/appearance');
});
test('a house actor never reaches the shared appearance write; a non-house actor does', async () => {
  for (const house of [true, false]) {
    requests.length = 0;
    const checked: string[] = [];
    npcSimulation.autonomousHouseActorCheck = async (agentId) => { checked.push(agentId); return house; };
    dispatch('color=blue'); await settle();
    expect(checked).toEqual(['external-appearance-agent']);
    expect(requests).toHaveLength(house ? 0 : 1);
    expect(sim.appearanceUpdatesInFlight.has('appearance-avatar')).toBe(false);
  }
});
test('a failed house-actor check drops the write, releases the slot, and the next dispatch runs', async () => {
  npcSimulation.autonomousHouseActorCheck = async () => { throw new Error('db down'); };
  dispatch('color=blue'); await settle();
  expect(requests).toHaveLength(0);
  expect(sim.appearanceUpdatesInFlight.has('appearance-avatar')).toBe(false);
  npcSimulation.autonomousHouseActorCheck = async () => false;
  dispatch('color=red'); await settle();
  expect(requests).toHaveLength(1);
});
test('decision menu: a house entry omits every house-refused verb; a non-house entry keeps the full menu', () => {
  const perception = npcSimulation.buildPerception(body.id)!;
  const entry = { agentId: session.config.agentId, avatarId: session.config.avatarId, bodyId: body.id, lastLesson: null, lastBuildingId: null };
  const userPrompt = agentAutonomyDriver.buildDecisionPrompt(perception, { ...entry, isHouse: false } as any);
  const housePrompt = agentAutonomyDriver.buildDecisionPrompt(perception, { ...entry, isHouse: true } as any);
  for (const action of HATCHER_ACTION_MENU) expect(userPrompt).toContain(action.syntax);
  for (const line of DECISION_SCOPE) expect(userPrompt).toContain(line);
  expect(HOUSE_REFUSED_AUTONOMY_VERBS.size).toBe(6);
  for (const action of HATCHER_ACTION_MENU) {
    if (HOUSE_REFUSED_AUTONOMY_VERBS.has(action.verb)) {
      expect(housePrompt).not.toContain(action.syntax);
      expect(housePrompt).not.toContain(`[ACTION: ${action.verb}(`);
    } else if (action.verb === 'play_cove_game') {
      // The executor refuses a house actor for game=baccarat only.
      expect(housePrompt).not.toContain(action.syntax);
      expect(housePrompt).toContain(HOUSE_PLAY_COVE_GAME_MENU_ITEM.syntax);
    } else {
      expect(housePrompt).toContain(action.syntax);
    }
  }
});
test('strict grammar rejects empty, unknown authority, malformed, duplicate and invalid edits', async () => {
  for (const params of ['', 'color=red,userId=other', 'avatarId=other', 'color=red,garbage', 'color=red,color=blue', 'color=purple', 'gender=unknown', 'modelKey=', 'color=red,']) dispatch(params);
  await settle(); expect(requests).toHaveLength(0);
  sim.npcOverrides.delete(body.id); dispatch('color=red'); await settle(); expect(requests).toHaveLength(0);
});
test('one mutation stays in flight and exact same-ID session replacement invalidates the captured fence', async () => {
  let release!: () => void;
  npcSimulation.autonomousAppearanceUpdate = async (input) => { requests.push(input); await new Promise<void>((resolve) => { release = resolve; }); };
  // The executor awaits the house-actor check before the shared write starts.
  dispatch('color=red'); dispatch('color=blue'); await new Promise((resolve) => setTimeout(resolve, 0));
  expect(requests).toHaveLength(1);
  sim.agentBotSessions.set('appearance-session', { config: { ...session.config } });
  expect(requests[0].isCurrent()).toBe(false);
  release(); await settle();
});
test('projection changes only the captured authorized bound body and current config', () => {
  const projection = npcSimulation.captureBoundAppearanceProjection('appearance-avatar', 'appearance-owner');
  expect(projection.agentIds).toEqual(['external-appearance-agent']);
  const oldColor = body.color;
  projection.project({ modelKey: 'lobster', color: 'red' }, []);
  expect(body.color).toBe(oldColor);
  projection.project({ modelKey: 'lobster', color: 'red' }, projection.agentIds);
  expect(body.color).toBe(Number.parseInt(AVATAR_COLORS.find((color) => color.id === 'red')!.hex.slice(1), 16));
  expect(session.config.color).toBe(body.color);
  expect(body.species).toBe('lobster');
  expect(npcSimulation.captureBoundAppearanceProjection('other-avatar', 'appearance-owner').agentIds).toEqual([]);
  expect(npcSimulation.captureBoundAppearanceProjection('appearance-avatar', 'other-owner').agentIds).toEqual([]);
});
test('replaced body, config, revoked authorization and changed binding reject projection', () => {
  for (const change of ['body', 'config', 'ledger', 'binding']) {
    const projection = npcSimulation.captureBoundAppearanceProjection('appearance-avatar', 'appearance-owner');
    const oldColor = body.color;
    const oldConfig = session.config;
    if (change === 'body') sim.npcs.set(body.id, { ...body });
    if (change === 'config') session.config = { ...session.config };
    if (change === 'ledger') session.config.ledgerCapable = false;
    if (change === 'binding') session.config.avatarId = 'replacement-avatar';
    projection.project({ modelKey: 'lobster', color: 'red' }, projection.agentIds);
    expect(body.color).toBe(oldColor);
    sim.npcs.set(body.id, body); session.config = oldConfig;
    session.config.ledgerCapable = true; session.config.avatarId = 'appearance-avatar';
  }
});
