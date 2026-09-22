import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
// Run in its own process: no network, database, runtime, or ledger is loaded.
let guest = false;
let avatar: Record<string, unknown> | null;
let resolved: { userId: string | null; avatarId: string | null; agentId: string; ledgerCapable: boolean } | null;
let afterReply: (() => void) | null;
let creditFails = false;
const turns: Array<{ content: string; context: any }> = [];
const credits: any[] = [], xp: unknown[][] = [], events: any[] = [], lessons: any[] = [];
const resolutions: string[] = [];
const clauses: unknown[] = [];
const fakeDb = { query: {
  avatars: { findFirst: async (query: any) => { clauses.push(query.where); return avatar; } },
  avatarInventory: { findMany: async () => [] },
} };
mock.module('@clawville/database', () => ({ db: fakeDb, avatars: { id: 'id', userId: 'userId', isActive: 'isActive' }, avatarInventory: { avatarId: 'avatarId' }, locationAgents: {} }));
mock.module('drizzle-orm', () => ({ eq: (a: unknown, b: unknown) => [a, b], and: (...args: unknown[]) => args, sql: () => '' }));
mock.module('@clawville/agent-runtime', () => ({ characterRoomId: (slug: string, owner: string) => `${slug}:${owner}` }));
mock.module('../../middleware/require-auth-or-agent', () => ({ AGENT_SESSION_HEADER: 'X-Clawville-Agent-Session', resolveAgentSession: async (id: string) => { resolutions.push(id); return resolved; } }));
mock.module('../../middleware/require-non-guest', () => ({ isGuestUser: async () => guest }));
mock.module('../../middleware/auth', () => ({
  sessionMiddleware: async (c: any, next: () => Promise<void>) => { c.set('user', c.req.header('Cookie') === 'human=1' ? { id: 'owner' } : null); await next(); },
  requireAuth: async (_c: any, next: () => Promise<void>) => next(),
}));
mock.module('../../services/agent-orchestrator', () => ({ agentOrchestrator: { ensureAgentRuntime: async () => ({ processMessage: async (content: string, context: unknown) => { turns.push({ content, context }); afterReply?.(); return { content: 'Visit the Bounty Board.', timestamp: new Date('2026-09-22T00:00:00Z') }; } }) } }));
mock.module('../../services/system-npc-seeder', () => ({ getSystemAgent: async () => ({ platformAgent: { id: 'nori-runtime' }, systemUserId: 'nori-owner' }), getSystemNpcAgent: async () => null }));
mock.module('../../services/runtime-services-adapter', () => ({ buildRuntimeServices: (_db: unknown, opts: unknown) => opts }));
mock.module('../../services/claw-token-ledger', () => ({ creditClawTokens: async (input: unknown) => { credits.push(input); if (creditFails) throw Error('credit unavailable'); } }));
mock.module('../../services/xp-service', () => ({ awardXp: async (...args: unknown[]) => { xp.push(args); } }));
mock.module('../../services/event-logger', () => ({ logEvent: async (input: unknown) => { events.push(input); }, logEventFromContext: async () => {} }));
mock.module('../../services/earned-skill-memory', () => ({ recordEarnedSkillLesson: async (input: unknown) => { lessons.push(input); return 'eliza'; } }));
mock.module('../../services/moderation-service', () => ({ moderateText: async () => ({ allowed: true }), CONTENT_BLOCKED_MESSAGE: 'blocked', CONTENT_BLOCKED_CODE: 'blocked', OUTPUT_REFUSAL_MESSAGE: 'refused' }));
mock.module('../../services/agent-collaboration', () => ({ shouldCollaborate: () => false, collaborateOnQuery: async () => null }));
mock.module('../../services/milady-gateway', () => ({ miladyGateway: {} }));
mock.module('../../services/building-reward', () => ({ creditBuildingChatRewardOncePerDay: async () => false, humanBuildingChatRewardAvatarId: () => null }));
const { chatRoutes } = await import('../chat');
const { systemAgentRewardLimiter } = await import('../../services/system-agent-reward-limiter');
const app = new Hono();
app.route('/api/chat', chatRoutes);
function request(headers: Record<string, string> = {}) {
  return app.request('/api/chat/system/town-guide', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ content: 'Where are bounties?', avatarId: 'attacker-input' }) });
}
const agentHeaders = { 'X-Clawville-Agent-Session': 'test-agent-session' };
beforeEach(() => {
  guest = false; creditFails = false; afterReply = null;
  avatar = { id: 'avatar', userId: 'owner', isActive: true, platformAgentId: 'own-runtime', characterConfig: {} };
  resolved = { userId: 'owner', avatarId: 'avatar', agentId: 'agent', ledgerCapable: true };
  for (const list of [turns, credits, xp, events, lessons, resolutions, clauses]) list.length = 0;
  systemAgentRewardLimiter._resetForTests();
});
describe('system chat bound-agent parity', () => {
  test('anonymous fails before runtime', async () => { expect((await request()).status).toBe(401); expect(turns).toHaveLength(0); });
  test('bound agent uses exact avatar, own memory, agent attribution and real reward', async () => {
    const res = await request(agentHeaders);
    expect(res.status).toBe(200);
    expect((await res.json() as { message: { content: string } }).message.content).toBe('Visit the Bounty Board.');
    expect(clauses[0]).toEqual([['userId', 'owner'], ['isActive', true], ['id', 'avatar']]);
    expect(turns[0].context.roomId).toBe('town-guide:owner');
    expect(turns[0].context.state.services).toBeUndefined();
    expect(credits[0]).toMatchObject({ avatarId: 'avatar', actorKind: 'agent', amount: 1 });
    expect(xp).toEqual([['avatar', 5, 'npc-chat']]);
    expect(events[0]).toMatchObject({ agentId: 'agent', userId: 'owner', avatarId: 'avatar', payload: { chatType: 'system-agent', tokenAwarded: 1 } });
    expect(lessons[0]).toMatchObject({ platformAgentId: 'own-runtime', avatarId: 'avatar', agentId: 'agent', lesson: 'Nori told me: Visit the Bounty Board.' });
  });
  for (const kind of ['expired', 'unbound', 'non-ledger', 'guest', 'avatar-missing', 'wrong-avatar']) {
    test(`${kind} agent cannot reach runtime, services or rewards`, async () => {
      if (kind === 'expired') resolved = null;
      if (kind === 'unbound') resolved!.userId = null;
      if (kind === 'non-ledger') resolved!.ledgerCapable = false;
      if (kind === 'guest') guest = true;
      if (kind === 'avatar-missing') avatar = null;
      if (kind === 'wrong-avatar') avatar!.id = 'other-avatar';
      expect((await request(agentHeaders)).status).toBe(kind === 'expired' ? 401 : 403);
      expect(turns).toHaveLength(0); expect(credits).toHaveLength(0); expect(lessons).toHaveLength(0);
    });
  }
  test('human cookie wins over agent header and shares owner room/cooldown', async () => {
    expect((await request({ Cookie: 'human=1', ...agentHeaders })).status).toBe(200);
    expect(resolutions).toHaveLength(0);
    expect((await request(agentHeaders)).status).toBe(200);
    expect(turns.map((t) => t.context.roomId)).toEqual(['town-guide:owner', 'town-guide:owner']);
    expect(credits).toHaveLength(1); expect(events[1].payload.tokenAwarded).toBe(0);
  });
  test('human without avatar still chats', async () => { avatar = null; expect((await request({ Cookie: 'human=1' })).status).toBe(200); expect(credits).toHaveLength(0); });
  test('human guest gets no real CT or XP', async () => { guest = true; expect((await request({ Cookie: 'human=1' })).status).toBe(200); expect(credits).toHaveLength(0); expect(xp).toHaveLength(0); });
  test('expiry while Nori replies prevents reward, memory and event', async () => {
    afterReply = () => { resolved = null; };
    expect((await request(agentHeaders)).status).toBe(401);
    expect(credits).toHaveLength(0); expect(lessons).toHaveLength(0); expect(events).toHaveLength(0);
  });
  test('rebind while Nori replies cannot attach the old turn to a new owner', async () => {
    afterReply = () => { resolved = { ...resolved!, userId: 'new-owner', avatarId: 'new-avatar' }; };
    expect((await request(agentHeaders)).status).toBe(403);
    expect(credits).toHaveLength(0); expect(lessons).toHaveLength(0);
  });
  test('failed credit reports zero and does not award XP', async () => {
    creditFails = true;
    expect((await request(agentHeaders)).status).toBe(200);
    expect(events[0].payload.tokenAwarded).toBe(0); expect(xp).toHaveLength(0);
  });
});
