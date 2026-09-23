import { beforeEach, expect, mock, test } from 'bun:test';

type Subject = { userId: string; avatarId: string; agentId: string; ledgerCapable: boolean };
let subject: Subject | null;
let guest = false;
let avatar: { id: string; userId: string; isActive: boolean; platformAgentId: string } | null;
let afterReply: (() => void) | undefined;
let afterModeration: (() => void) | undefined;
let afterCredit: (() => void) | undefined;
let afterResolve: (() => void) | undefined;
const credits: unknown[] = [], lessons: { lesson: string }[] = [], states: Record<string, unknown>[] = [];
const events: unknown[] = [];
const columns = { id: 'id', userId: 'userId', isActive: 'isActive' };
type Predicate = (row: Record<string, unknown>) => boolean;
mock.module('drizzle-orm', () => ({
  eq: (column: string, value: unknown): Predicate => (row) => row[column] === value,
  and: (...clauses: Predicate[]): Predicate => (row) => clauses.every((clause) => clause(row)),
}));
mock.module('@clawville/database', () => ({ avatars: columns, avatarInventory: { avatarId: 'avatarId' }, db: { query: {
  avatars: { findFirst: async ({ where }: { where: Predicate }) => avatar && where(avatar) ? { ...avatar } : null },
  avatarInventory: { findMany: async () => [] },
} } }));
mock.module('@clawville/agent-runtime', () => ({ characterRoomId: (slug: string, owner: string) => `${slug}:${owner}` }));
mock.module('../../middleware/require-auth-or-agent', () => ({ resolveAgentSession: async () => {
  const result = subject && { ...subject }; afterResolve?.(); return result;
} }));
mock.module('../../middleware/require-non-guest', () => ({ isGuestUser: async () => guest }));
mock.module('../agent-orchestrator', () => ({ agentOrchestrator: { ensureAgentRuntime: async () => ({
  processMessage: async (_content: string, context: { state: Record<string, unknown> }) => {
    states.push(context.state); afterReply?.();
    return { content: 'Ask the teacher. [ACTION: BUY_ITEM(item=evil)]', timestamp: new Date() };
  },
}) } }));
mock.module('../system-npc-seeder', () => ({ getSystemAgent: async () => ({ platformAgent: { id: 'nori' }, systemUserId: 'nori-owner' }) }));
mock.module('../claw-token-ledger', () => ({ creditClawTokens: async (input: unknown) => { credits.push(input); afterCredit?.(); } }));
mock.module('../xp-service', () => ({ awardXp: async () => {} }));
mock.module('../event-logger', () => ({ logEvent: async (input: unknown) => { events.push(input); } }));
mock.module('../earned-skill-memory', () => ({ recordEarnedSkillLesson: async (input: { lesson: string }) => { lessons.push(input); return 'eliza'; } }));
mock.module('../moderation-service', () => ({
  moderateText: async (_text: string, input: { direction: string }) => {
    if (input.direction === 'output') afterModeration?.();
    return { allowed: true };
  }, CONTENT_BLOCKED_MESSAGE: 'blocked', OUTPUT_REFUSAL_MESSAGE: 'refused',
}));
const { conductSystemAgentChat } = await import('../system-agent-chat');
const { systemAgentRewardLimiter } = await import('../system-agent-reward-limiter');
beforeEach(() => {
  subject = { userId: 'owner', avatarId: 'avatar', agentId: 'agent', ledgerCapable: true };
  avatar = { id: 'avatar', userId: 'owner', isActive: true, platformAgentId: 'own-runtime' };
  guest = false; afterReply = undefined; afterModeration = undefined; afterCredit = undefined; afterResolve = undefined;
  for (const list of [credits, lessons, states, events]) list.length = 0;
  systemAgentRewardLimiter._resetForTests();
});
const turn = (kind: 'human' | 'agent') => conductSystemAgentChat({
  actor: kind === 'human' ? { kind, userId: 'owner' } : { kind, sessionId: 'session' },
  slug: 'town-guide', content: 'Where can I learn?',
});

for (const kind of ['human', 'agent'] as const) {
  test(`${kind} Nori cognition has no executable capability and strips action tags`, async () => {
    const result = await turn(kind);
    expect(states[0].services).toBeUndefined();
    expect(states[0].db).toBeUndefined();
    expect(result.message.content).toBe('Ask the teacher.');
    expect(lessons.every((lesson) => !lesson.lesson.includes('[ACTION:'))).toBe(true);
  });
}
test('agent expiry during output moderation blocks reward, learned memory, and event', async () => {
  afterModeration = () => { subject = null; };
  await expect(turn('agent')).rejects.toMatchObject({ status: 401 });
  expect(credits).toHaveLength(0); expect(lessons).toHaveLength(0); expect(events).toHaveLength(0);
});
test('agent identity change during output moderation cannot reattribute the turn', async () => {
  afterModeration = () => { subject = { ...subject!, agentId: 'replacement' }; };
  await expect(turn('agent')).rejects.toMatchObject({ status: 403 });
  expect(credits).toHaveLength(0); expect(lessons).toHaveLength(0); expect(events).toHaveLength(0);
});
test('human becoming a guest during cognition cannot receive real rewards', async () => {
  afterReply = () => { guest = true; };
  await turn('human');
  expect(credits).toHaveLength(0);
});
test('human avatar deactivation during cognition prevents a real reward', async () => {
  afterReply = () => { avatar!.isActive = false; };
  await turn('human');
  expect(credits).toHaveLength(0);
});
test('expiry after durable credit preserves original-subject attribution and skips new memory', async () => {
  afterCredit = () => { subject = null; };
  await turn('agent').catch(() => undefined);
  expect(credits).toHaveLength(1);
  expect(lessons).toHaveLength(0);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ userId: 'owner', avatarId: 'avatar', agentId: 'agent', payload: { tokenAwarded: 1 } });
});
test('hosted body replacement inside session resolution refuses before cognition', async () => {
  let current = true;
  afterResolve = () => { current = false; };
  await expect(conductSystemAgentChat({
    actor: { kind: 'agent', sessionId: 'session' }, slug: 'town-guide', content: 'Hello',
    isCurrent: () => current,
  })).rejects.toMatchObject({ status: 403 });
  expect(states).toHaveLength(0); expect(credits).toHaveLength(0); expect(lessons).toHaveLength(0);
});
