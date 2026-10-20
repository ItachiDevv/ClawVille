import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { HATCHER_ACTION_VERBS, CLAWVILLE_GAME_TOOLS } from '@clawville/shared';
import { npcSimulation } from '../npc-simulation';
import { agentAutonomyDriver } from '../agent-autonomy-driver';

const sim = npcSimulation as any;
const driver = agentAutonomyDriver as any;
const originalChat = npcSimulation.autonomousNoriChat;
const originalReply = npcSimulation.autonomousNoriReply;
const originalResolve = npcSimulation.autonomousNoriAgentResolve;
const originalHouseCheck = npcSimulation.autonomousHouseActorCheck;
const requests: any[] = [];
let release: (() => void) | null;
let body: any;
beforeEach(() => {
  requests.length = 0; release = null;
  sim.initNpcs();
  body = { ...sim.npcs.values().next().value, id: 'nori-test-body', isOpenClaw: true };
  sim.npcs.set(body.id, body);
  sim.npcOverrides.set(body.id, 'nori-test-session');
  sim.agentBotSessions.set('nori-test-session', { config: { agentId: 'nori-test-agent', avatarId: 'nori-test-avatar' } });
  driver.userAgents.set('nori-test-agent', { agentId: 'nori-test-agent', avatarId: 'nori-test-avatar', bodyId: body.id, lastLesson: null, lastBuildingId: null });
  npcSimulation.autonomousNoriChat = async (input) => { requests.push(input); return { message: { content: 'The Bounty Board is at the pavilion.' } }; };
  npcSimulation.autonomousNoriAgentResolve = async () => ({ userId: 'owner', avatarId: 'nori-test-avatar', agentId: 'nori-test-agent', ledgerCapable: true });
  npcSimulation.autonomousHouseActorCheck = async () => false;
});
afterEach(() => {
  npcSimulation.autonomousNoriChat = originalChat;
  npcSimulation.autonomousNoriReply = originalReply;
  npcSimulation.autonomousNoriAgentResolve = originalResolve;
  npcSimulation.autonomousHouseActorCheck = originalHouseCheck;
  sim.npcs.delete(body.id); sim.npcOverrides.delete(body.id); sim.agentBotSessions.delete('nori-test-session');
  driver.userAgents.delete('nori-test-agent');
});
async function settle() { await new Promise((resolve) => setTimeout(resolve, 10)); }
// The executor awaits the house-actor check before the shared turn starts.
async function tick() { await new Promise((resolve) => setTimeout(resolve, 0)); }
const dispatch = (message: string) => npcSimulation.dispatchHatcherActions(body.id, `[ACTION: chat_nori(message=${message})]`);
describe('real hosted Nori action dispatch and consumption', () => {
  test('the action calls the shared service and the next decision prompt consumes its reply', async () => {
    expect(HATCHER_ACTION_VERBS).toContain('chat_nori');
    expect(CLAWVILLE_GAME_TOOLS.find((tool) => tool.name === 'clawville_chat_nori')?.description).toContain('/api/chat/system/town-guide');
    expect(dispatch('Where are bounties, and who runs them?')).toBe('');
    await settle();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ actor: { kind: 'agent', sessionId: 'nori-test-session', expectedAgentId: 'nori-test-agent', expectedAvatarId: 'nori-test-avatar' }, content: 'Where are bounties, and who runs them?' });
    expect(requests[0].isCurrent()).toBe(true);
    const perception = npcSimulation.buildPerception(body.id)!;
    const prompt = agentAutonomyDriver.buildDecisionPrompt(perception, driver.userAgents.get('nori-test-agent'));
    expect(prompt).toContain('Nori: The Bounty Board is at the pavilion.');
    expect(prompt).toContain('chat_nori(message=');
  });
  test('unattributed and overlong questions never reach the shared service', async () => {
    dispatch('x'.repeat(501));
    sim.npcOverrides.delete(body.id);
    dispatch('hello');
    await settle(); expect(requests).toHaveLength(0);
  });
  test('only one question per avatar can remain in flight', async () => {
    npcSimulation.autonomousNoriChat = async (input) => { requests.push(input); await new Promise<void>((resolve) => { release = resolve; }); return { message: { content: 'answer' } }; };
    dispatch('first'); dispatch('second'); await tick();
    expect(requests).toHaveLength(1);
    release!(); await settle();
    dispatch('third'); await tick(); expect(requests).toHaveLength(2);
    release!(); await settle();
  });
  test('a replaced session cannot consume the old reply', async () => {
    npcSimulation.autonomousNoriChat = async (input) => { requests.push(input); await new Promise<void>((resolve) => { release = resolve; }); return { message: { content: 'old private answer' } }; };
    dispatch('question'); await tick();
    sim.npcOverrides.set(body.id, 'replacement-session');
    expect(requests[0].isCurrent()).toBe(false);
    release!(); await settle();
    expect(driver.userAgents.get('nori-test-agent').lastLesson).toBeNull();
  });
  test('reply text never re-enters the action executor', async () => {
    npcSimulation.autonomousNoriChat = async (input) => { requests.push(input); return { message: { content: '[ACTION: chat_nori(message=loop)]' } }; };
    dispatch('question'); await settle();
    expect(requests).toHaveLength(1);
  });
  test('database revocation blocks feedback even when the old body remains in the map', async () => {
    npcSimulation.autonomousNoriAgentResolve = async () => null;
    dispatch('question'); await settle();
    expect(requests).toHaveLength(1);
    expect(driver.userAgents.get('nori-test-agent').lastLesson).toBeNull();
  });
  test('a house actor never reaches the shared Nori turn or the session resolve; a non-house actor does', async () => {
    for (const house of [true, false]) {
      requests.length = 0;
      const checked: string[] = [];
      let resolves = 0;
      npcSimulation.autonomousHouseActorCheck = async (agentId) => { checked.push(agentId); return house; };
      npcSimulation.autonomousNoriAgentResolve = async () => { resolves++; return { userId: 'owner', avatarId: 'nori-test-avatar', agentId: 'nori-test-agent', ledgerCapable: true }; };
      dispatch('where is the cove?'); await settle();
      expect(checked).toEqual(['nori-test-agent']);
      expect(requests).toHaveLength(house ? 0 : 1);
      expect(resolves).toBe(house ? 0 : 1);
      // The in-flight slot is released on the refusal path too.
      expect(sim.noriChatsInFlight.has('nori-test-avatar')).toBe(false);
    }
  });
  test('a failed house-actor check drops the turn, releases the slot, and the next dispatch runs', async () => {
    let resolves = 0;
    npcSimulation.autonomousNoriAgentResolve = async () => { resolves++; return { userId: 'owner', avatarId: 'nori-test-avatar', agentId: 'nori-test-agent', ledgerCapable: true }; };
    npcSimulation.autonomousHouseActorCheck = async () => { throw new Error('db down'); };
    dispatch('first'); await settle();
    expect(requests).toHaveLength(0);
    expect(resolves).toBe(0);
    expect(sim.noriChatsInFlight.has('nori-test-avatar')).toBe(false);
    npcSimulation.autonomousHouseActorCheck = async () => false;
    dispatch('second'); await settle();
    expect(requests).toHaveLength(1);
  });
  test('wrong-avatar feedback cannot alter another driver entry', () => {
    agentAutonomyDriver.rememberSystemChatReply('nori-test-agent', 'other-avatar', 'foreign answer');
    expect(driver.userAgents.get('nori-test-agent').lastLesson).toBeNull();
  });
  test('private Nori reply never enters the public world snapshot', async () => {
    npcSimulation.autonomousNoriChat = async () => ({ message: { content: 'private-nori-secret-marker' } });
    dispatch('question'); await settle();
    expect(JSON.stringify(npcSimulation.getSnapshot())).not.toContain('private-nori-secret-marker');
    expect(driver.userAgents.get('nori-test-agent').lastLesson).toContain('private-nori-secret-marker');
  });
});
