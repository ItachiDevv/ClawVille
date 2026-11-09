import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// The executor's seams lazy-import './studios-images'; mock it so no test
// reaches the database, a wallet or Studios.
mock.module('../studios-images', () => ({
  generateStudiosImage: async () => ({ ok: true, mode: 'account', mediaId: 'm', mediaPath: '/api/media/m', ledgerId: null, paidUsdCents: null, txSignature: null }),
  requestStudiosOperation: async () => { throw new Error('the seam is replaced in these tests'); },
}));

import { HATCHER_ACTION_MENU, HATCHER_ACTION_VERBS } from '@clawville/shared';
import { npcSimulation } from '../npc-simulation';
import { agentAutonomyDriver } from '../agent-autonomy-driver';

const sim = npcSimulation as any;
const driver = agentAutonomyDriver as any;
const AGENT = 'studios-verbs-agent';
const AVATAR = '7a1c2d3e-aaaa-4bbb-8ccc-0123456789ab';
const SESSION = 'studios-verbs-session';
const MEDIA = '11111111-2222-4333-8444-555555555555';
const originals = {
  resolve: npcSimulation.autonomousImageAgentResolve,
  house: npcSimulation.autonomousHouseActorCheck,
  result: npcSimulation.autonomousActionResult,
  op: npcSimulation.autonomousStudiosOperation,
  url: npcSimulation.autonomousOwnImageUrl,
};
let body: any;
let resolved: any;
let isHouse = false;
const calls: { ops: any[]; results: string[]; urls: string[] } = { ops: [], results: [], urls: [] };
let opImpl: (input: any) => Promise<any>;

beforeEach(() => {
  calls.ops.length = 0; calls.results.length = 0; calls.urls.length = 0;
  isHouse = false;
  opImpl = async (input) => ({ ok: false, code: 'running', httpStatus: 202, message: 'vendor text', ledgerId: null, requestId: `req-${input.operation}` });
  sim.initNpcs();
  const bodyId = sim.avatarBodyId(AGENT);
  body = { ...sim.npcs.values().next().value, id: bodyId, isOpenClaw: true };
  sim.npcs.set(bodyId, body);
  sim.npcOverrides.set(bodyId, SESSION);
  sim.agentBotSessions.set(SESSION, { config: { mode: 'avatar', agentId: AGENT, avatarId: AVATAR, boundUserId: 'owner', ledgerCapable: true } });
  sim.autonomousImageInFlight.clear();
  driver.userAgents.set(AGENT, { agentId: AGENT, avatarId: AVATAR, bodyId, lastLesson: null, lastBuildingId: null, isHouse: false });
  resolved = { userId: 'owner', avatarId: AVATAR, agentId: AGENT, ledgerCapable: true };
  npcSimulation.autonomousHouseActorCheck = async () => isHouse;
  npcSimulation.autonomousImageAgentResolve = async () => resolved;
  npcSimulation.autonomousActionResult = async (_a, _v, text) => { calls.results.push(text); };
  npcSimulation.autonomousStudiosOperation = async (input) => { calls.ops.push(input); return opImpl(input); };
  npcSimulation.autonomousOwnImageUrl = async (avatarId, mediaId) => {
    calls.urls.push(`${avatarId}:${mediaId}`);
    return avatarId === AVATAR && mediaId === MEDIA ? `https://api.clawville.world/api/media/${mediaId}` : null;
  };
});

afterEach(() => {
  npcSimulation.autonomousImageAgentResolve = originals.resolve;
  npcSimulation.autonomousHouseActorCheck = originals.house;
  npcSimulation.autonomousActionResult = originals.result;
  npcSimulation.autonomousStudiosOperation = originals.op;
  npcSimulation.autonomousOwnImageUrl = originals.url;
  sim.npcs.delete(body.id); sim.npcOverrides.delete(body.id); sim.agentBotSessions.delete(SESSION);
  driver.userAgents.delete(AGENT);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const dispatch = (reply: string) => npcSimulation.dispatchHatcherActions(body.id, reply);
const prompt = () => agentAutonomyDriver.buildDecisionPrompt(npcSimulation.buildPerception(body.id)!, driver.userAgents.get(AGENT));

describe('hosted Studios verbs (phase 3b)', () => {
  test('each verb is whitelisted, in the shared menu the deciding model sees, and refused for house bots', async () => {
    const { HOUSE_REFUSED_AUTONOMY_VERBS } = await import('../house-refused-verbs');
    const decide = prompt();
    for (const verb of ['generate_video', 'make_character', 'recast_character'] as const) {
      expect(HATCHER_ACTION_VERBS).toContain(verb);
      const item = HATCHER_ACTION_MENU.find((entry) => entry.verb === verb);
      expect(item?.whenToUse).toContain('per UTC day');
      expect(item?.whenToUse).not.toContain('—');
      expect(decide).toContain(`${verb}(`);
      expect(HOUSE_REFUSED_AUTONOMY_VERBS.has(verb)).toBe(true);
    }
  });

  test('generate_video runs the operation service as the agent, hosted surface, prompt only; the line says it runs', async () => {
    expect(dispatch('Filming. [ACTION: generate_video(prompt="a paper boat, at dusk")]')).toBe('Filming.');
    await settle();
    expect(calls.ops).toHaveLength(1);
    expect(calls.ops[0]).toMatchObject({ avatarId: AVATAR, actor: 'agent', operation: 'video', params: { prompt: 'a paper boat, at dusk' }, surface: 'hosted' });
    expect(Object.keys(calls.ops[0].params)).toEqual(['prompt']);
    expect(calls.ops[0].idempotencyKey).toMatch(/^[A-Za-z0-9._:-]{8,64}$/);
    expect(calls.results).toEqual(['Studio: your video is being made; it can take several minutes. Your next decision gets the result. Do not send it again.']);
  });

  test('make_character asks for one headshot; recast_character sends only the URL of the avatar\'s own stored image, at 480p', async () => {
    dispatch('[ACTION: make_character(prompt="a fox streamer")]');
    await settle();
    expect(calls.ops[0]).toMatchObject({ operation: 'character_shots', params: { prompt: 'a fox streamer', shots: ['headshot'] } });
    dispatch(`[ACTION: recast_character(preset=recast-x-wan, mediaId=${MEDIA})]`);
    await settle();
    expect(calls.urls).toEqual([`${AVATAR}:${MEDIA}`]);
    expect(calls.ops[1]).toMatchObject({ operation: 'recast', params: { preset: 'recast-x-wan', imageUrls: [`https://api.clawville.world/api/media/${MEDIA}`], resolution: '480p' } });
    // Another avatar's media (or none) never reaches the service.
    dispatch('[ACTION: recast_character(preset=recast-x-wan, mediaId=99999999-2222-4333-8444-555555555555)]');
    await settle();
    expect(calls.ops).toHaveLength(2);
    expect(calls.results.at(-1)).toContain('media_not_found');
  });

  test('bad tags drop before any guard or call, and tell the model once', async () => {
    for (const tag of [
      '[ACTION: generate_video()]',
      '[ACTION: generate_video(prompt=cat)]',
      '[ACTION: make_character(prompt="a", model="x")]',
      '[ACTION: recast_character(preset=recast-x-wan)]',
      `[ACTION: recast_character(preset=recast-x-wan, mediaId=${MEDIA}, imageUrl=https://evil.example/x.png)]`,
      '[ACTION: recast_character(preset=recast-x-wan, mediaId=not-a-uuid)]',
    ]) {
      calls.results.length = 0;
      dispatch(tag);
      await settle();
      expect(calls.results).toHaveLength(1);
      expect(calls.results[0]).toContain('was not valid, so nothing was made or paid');
    }
    expect(calls.ops).toEqual([]);
  });

  test('one Studios action per reply across all four verbs, and one in flight per avatar', async () => {
    dispatch('[ACTION: generate_video(prompt="one")] [ACTION: make_character(prompt="two")] [ACTION: generate_image(prompt="three")]');
    await settle();
    expect(calls.ops.map((c) => c.params.prompt)).toEqual(['one']);
    let release!: () => void;
    opImpl = () => new Promise((resolve) => { release = () => resolve({ ok: false, code: 'running', httpStatus: 202, message: '', ledgerId: null, requestId: 'r' }); });
    dispatch('[ACTION: generate_video(prompt="slow")]');
    await settle();
    dispatch('[ACTION: make_character(prompt="fast")]');
    await settle();
    expect(calls.ops.map((c) => c.params.prompt)).toEqual(['one', 'slow']);
    expect(calls.results.at(-1)).toContain('refused (in_flight)');
    release();
    await settle();
  });

  test('the per-avatar daily cap and the human limits come back from the service as one short line', async () => {
    opImpl = async () => ({ ok: false, code: 'hosted_daily_cap', httpStatus: 429, ledgerId: null, message: 'Your hosted agent reached its own daily cap for this Studios action. Try again after 00:00 UTC.' });
    dispatch('[ACTION: generate_video(prompt="again")]');
    await settle();
    expect(calls.results.at(-1)).toBe('Studio: generate_video refused (hosted_daily_cap): Your hosted agent reached its own daily cap for this Studios action. Try again after 00:00 UTC.');
    opImpl = async () => ({ ok: false, code: 'awaiting_approval', httpStatus: 202, ledgerId: null, message: 'x', requestId: 'r', expiresAt: 'z' });
    dispatch('[ACTION: make_character(prompt="wait")]');
    await settle();
    expect(calls.results.at(-1)).toContain('waits for your human to approve it');
    for (const line of calls.results) expect(line.length).toBeLessThanOrEqual(200);
  });

  test('guard drops (house actor, no session, not ledger, other avatar) never call the service and free the slot', async () => {
    isHouse = true;
    dispatch('[ACTION: generate_video(prompt="house")]');
    await settle();
    isHouse = false;
    for (const value of [null, { ...resolved, ledgerCapable: false }, { ...resolved, avatarId: 'someone-else' }]) {
      resolved = value;
      dispatch('[ACTION: generate_video(prompt="x")]');
      await settle();
    }
    expect(calls.ops).toEqual([]);
    expect(sim.autonomousImageInFlight.size).toBe(0);
  });
});
