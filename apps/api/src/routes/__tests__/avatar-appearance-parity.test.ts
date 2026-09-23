import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as database from '@clawville/database';
process.env.FINGERPRINT_SECRET ??= 'appearance-auth-test-fixture-secret-000000000000000000000000';

let avatar: any;
let owner: any;
let platform: any;
let resolved: any;
let beforeTransaction: (() => void) | null;
let afterWrite: (() => void) | null;
let afterCommit: (() => void) | null;
let projectionTargets: Array<{ agentId: string; sessionId: string }>;
let projected: any[];
let resolveHook: (() => Promise<void>) | null;
let denyUpdate: boolean;
let resolutions: string[];
let updates: Array<{ table: unknown; patch: any; params: unknown[] }>;
let events: any[];
const dialect = new PgDialect();
const fakeDb: any = {
  query: {
    avatars: { findFirst: async () => avatar ? { ...avatar } : null },
    users: { findFirst: async () => owner },
    agents: { findFirst: async () => platform },
  },
  transaction: async (fn: (tx: any) => Promise<any>) => {
    beforeTransaction?.();
    const oldAvatar = avatar ? { ...avatar } : null;
    const oldPlatform = platform ? { ...platform } : null;
    try { const result = await fn(fakeDb); afterCommit?.(); return result; }
    catch (error) { avatar = oldAvatar; platform = oldPlatform; updates.length = 0; throw error; }
  },
  update: (table: unknown) => ({ set: (patch: any) => ({ where: (where: any) => {
    const perform = async () => {
      if (denyUpdate) return [];
      updates.push({ table, patch, params: dialect.sqlToQuery(where).params });
      if (table === database.avatars) { avatar = { ...avatar, ...patch }; afterWrite?.(); return [avatar]; }
      if (table === database.agentBots) return projectionTargets.map(({ agentId }) => ({ agentId }));
      return [];
    };
    return { returning: perform, then: (resolve: any, reject: any) => perform().then(resolve, reject) };
  } }) }),
  select: () => ({ from: () => ({ where: () => ({ limit: async () => platform ? [platform] : [] }) }) }),
};
mock.module('@clawville/database', () => ({ ...database, db: fakeDb }));
mock.module('../../middleware/auth', () => ({
  sessionMiddleware: async (c: any, next: any) => { c.set('user', c.req.header('Cookie') ? { id: 'human-owner' } : null); c.set('session', null); await next(); },
  requireAuth: async (c: any, next: any) => { if (!c.get('user')) throw new HTTPException(401); await next(); },
}));
// The canonical resolver has its own TTL/hash tests. Here its changing result
// drives the real shared appearance service and real HTTP handler.
const actualAuth = await import('../../middleware/require-auth-or-agent');
mock.module('../../middleware/require-auth-or-agent', () => ({ ...actualAuth,
  resolveAgentSession: async (sessionId: string) => { resolutions.push(sessionId); await resolveHook?.(); return resolved ? { ...resolved } : null; },
}));
mock.module('../../services/event-logger', () => ({ logEvent: async (value: any) => { events.push(value); }, logEventFromContext: async () => {} }));
const { avatarRoutes } = await import('../avatars');
const { updateAvatarAppearance } = await import('../../services/avatar-appearance');
const { npcSimulation } = await import('../../services/npc-simulation');
const originalCapture = npcSimulation.captureBoundAppearanceProjection;
afterAll(() => { npcSimulation.captureBoundAppearanceProjection = originalCapture; });
const app = new Hono(); app.route('/api/avatars', avatarRoutes);
const agentHeaders = { 'X-Clawville-Agent-Session': 'appearance-session' };
function request(patch: unknown = { color: 'blue' }, headers: Record<string, string> = agentHeaders) {
  return app.request('/api/avatars/me/appearance', { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(patch) });
}
beforeEach(() => {
  avatar = { id: 'avatar', userId: 'owner', platformAgentId: 'platform', isActive: true, isGuest: false, harness: 'openclaw', modelKey: 'lobster', color: 'red', gender: 'male', characterConfig: null };
  owner = { id: 'owner', isGuest: false };
  platform = { id: 'platform', userId: 'owner', config: { currentDirective: { text: 'keep this' } } };
  resolved = { userId: 'owner', avatarId: 'avatar', agentId: 'connected-agent', ledgerCapable: true };
  beforeTransaction = null; afterWrite = null; afterCommit = null; denyUpdate = false;
  resolutions = []; updates = []; events = [];
  projectionTargets = []; projected = [];
  resolveHook = null;
  npcSimulation.captureBoundAppearanceProjection = (avatarId, userId) => ({
    agentIds: projectionTargets.map(({ agentId }) => agentId), targets: projectionTargets,
    project: (appearance, authorized) => { if (authorized.length) projected.push({ avatarId, userId, appearance, authorized }); },
  });
});

describe('appearance shared human and bound-agent authorization', () => {
  test('anonymous fails without writes', async () => { expect((await request({}, {})).status).toBe(401); expect(updates).toHaveLength(0); });
  test('a bound agent edits only its resolved avatar and attributes the event', async () => {
    const res = await request({ color: 'blue', userId: 'victim', avatarId: 'victim', platformAgentId: 'victim', harness: 'milady' });
    expect(res.status).toBe(200);
    expect(avatar.color).toBe('blue'); expect(avatar.harness).toBe('openclaw');
    expect(updates[0].params).toContain('avatar'); expect(updates[0].params).toContain('owner'); expect(updates[0].params).toContain('platform');
    expect(updates[0].params).not.toContain('victim');
    expect(events[0]).toMatchObject({ userId: 'owner', avatarId: 'avatar', agentId: 'connected-agent' });
    expect(resolutions).toHaveLength(4);
  });
  for (const failure of ['expired', 'unbound', 'non-ledger', 'missing-owner', 'guest-owner', 'guest-avatar', 'missing-avatar', 'wrong-avatar', 'inactive-avatar', 'missing-platform', 'foreign-platform']) {
    test(`${failure} agent fails before any write`, async () => {
      if (failure === 'expired') resolved = null;
      if (failure === 'unbound') resolved.avatarId = null;
      if (failure === 'non-ledger') resolved.ledgerCapable = false;
      if (failure === 'missing-owner') owner = null;
      if (failure === 'guest-owner') owner.isGuest = true;
      if (failure === 'guest-avatar') avatar.isGuest = true;
      if (failure === 'missing-avatar') avatar = null;
      if (failure === 'wrong-avatar') avatar.id = 'wrong';
      if (failure === 'inactive-avatar') avatar.isActive = false;
      if (failure === 'missing-platform') platform = null;
      if (failure === 'foreign-platform') platform.userId = 'victim';
      expect((await request()).status).toBe(failure === 'expired' ? 401 : 403);
      expect(updates).toHaveLength(0); expect(events).toHaveLength(0);
    });
  }
  test('human cookie wins over agent header and preserves guest cosmetics', async () => {
    avatar.userId = 'human-owner'; avatar.isGuest = true; owner = { id: 'human-owner', isGuest: true };
    const res = await request({ color: 'blue' }, { ...agentHeaders, Cookie: 'human=1' });
    expect(res.status).toBe(200); expect(resolutions).toHaveLength(0);
    expect(updates[0].params).toContain('human-owner'); expect(events[0].agentId).toBeUndefined();
  });
  test('human without an avatar retains 404', async () => { avatar = null; expect((await request({ color: 'blue' }, { Cookie: 'human=1' })).status).toBe(404); });
  test('empty and authority-only bodies retain 400 without writes', async () => {
    expect((await request({})).status).toBe(400);
    expect((await request({ userId: 'victim', avatarId: 'victim' })).status).toBe(400);
    expect(updates).toHaveLength(0);
  });
  for (const phase of ['before-write', 'after-write']) {
    test(`revocation ${phase} rejects and rolls back`, async () => {
      const revoke = () => { resolved = null; };
      if (phase === 'before-write') beforeTransaction = revoke; else afterWrite = revoke;
      expect((await request()).status).toBe(403); expect(avatar.color).toBe('red'); expect(updates).toHaveLength(0);
    });
  }
  test('avatar changes at the pinned UPDATE fail without a replacement-avatar write', async () => { denyUpdate = true; expect((await request()).status).toBe(403); expect(updates).toHaveLength(0); });
  test('appearance persists exact captured bot rows and projects only the revalidated binding', async () => {
    projectionTargets = [{ agentId: 'connected-agent', sessionId: 'appearance-session' }];
    expect((await request()).status).toBe(200);
    const botWrite = updates.find((update) => update.table === database.agentBots)!;
    expect(botWrite.params).toContain('connected-agent'); expect(botWrite.params).toContain('owner'); expect(botWrite.params).toContain('avatar');
    expect(botWrite.patch.species).toBe('lobster'); expect(typeof botWrite.patch.color).toBe('number');
    expect(projected).toEqual([{ avatarId: 'avatar', userId: 'owner', appearance: { modelKey: 'lobster', color: 'blue' }, authorized: ['connected-agent'] }]);
  });
  test('post-commit revocation skips live projection without misreporting the committed edit', async () => {
    projectionTargets = [{ agentId: 'connected-agent', sessionId: 'appearance-session' }];
    afterCommit = () => { resolved = null; };
    expect((await request()).status).toBe(200); expect(avatar.color).toBe('blue'); expect(projected).toHaveLength(0);
  });
  test('a held older post-commit projection cannot overwrite a newer HTTP edit', async () => {
    avatar.color = 'green';
    projectionTargets = [{ agentId: 'connected-agent', sessionId: 'appearance-session' }];
    let release!: () => void; let signal!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const projectionStarted = new Promise<void>((resolve) => { signal = resolve; });
    resolveHook = async () => { if (resolutions.length === 5) { signal(); await held; } };
    const older = request({ color: 'blue' });
    await projectionStarted;
    const newer = request({ color: 'red' });
    try {
      await Bun.sleep(10);
      expect(updates.filter((update) => update.table === database.avatars)).toHaveLength(1);
    } finally { release(); }
    expect((await older).status).toBe(200); expect((await newer).status).toBe(200);
    expect(avatar.color).toBe('red'); expect(projected.map((entry) => entry.appearance.color)).toEqual(['blue', 'red']);
  });
  test('hosted expected identity and body fence reject stale callers', async () => {
    await expect(updateAvatarAppearance({ actor: { kind: 'agent', sessionId: 'appearance-session', expectedAvatarId: 'wrong' }, patch: { color: 'blue' } })).rejects.toMatchObject({ status: 403 });
    await expect(updateAvatarAppearance({ actor: { kind: 'agent', sessionId: 'appearance-session' }, patch: { color: 'blue' }, isCurrent: () => false })).rejects.toMatchObject({ status: 403 });
    expect(updates).toHaveLength(0);
  });
  test('same model validation rejects invalid, reserved, and wrong-harness changes', async () => {
    expect((await request({ modelKey: 'not-a-model' })).status).toBe(400);
    const { AGENT_MODELS } = await import('@clawville/shared');
    const models = Object.values(AGENT_MODELS);
    for (const category of ['hatcher', 'milady']) {
      const model = models.find((value) => value.category === category)!;
      expect(model).toBeDefined(); expect((await request({ modelKey: model.key })).status).toBe(400);
    }
    expect(updates).toHaveLength(0);
  });
});
