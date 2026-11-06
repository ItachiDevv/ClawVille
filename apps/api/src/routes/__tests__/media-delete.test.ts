/**
 * DELETE /api/media/:id (MCP hub phase 3b): only the human owner of the
 * active avatar deletes an item. The agent header, an agent-exchange cookie,
 * no session and a guest are refused before any delete. No DB: the session,
 * the avatar read and the delete are fakes.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import * as realDatabase from '@clawville/database';
import * as realGuard from '../../middleware/require-non-guest';
import * as realAgentAuth from '../../middleware/require-auth-or-agent';
import * as realMedia from '../../services/studios-media';

const sessions = new Map<string, { userId: string; createdVia: string | null }>();
const deletes: Array<{ avatarId: string; id: string }> = [];
let guest = false;
const MEDIA = '11111111-2222-4333-8444-555555555555';

mock.module('../../lib/auth', () => ({
  resolveSessionCookieDomain: () => undefined,
  lucia: {
    readSessionCookie: (cookie: string) => /auth_session=([^;]+)/.exec(cookie)?.[1] ?? null,
    validateSession: async (id: string) => {
      const s = sessions.get(id);
      if (!s) return { session: null, user: null };
      return { session: { id, userId: s.userId, fresh: false, expiresAt: new Date(Date.now() + 60_000), createdVia: s.createdVia }, user: { id: s.userId } };
    },
    createSessionCookie: () => ({ serialize: () => 'auth_session=x' }),
    createBlankSessionCookie: () => ({ serialize: () => 'auth_session=' }),
  },
}));
mock.module('../../middleware/require-non-guest', () => ({
  ...realGuard,
  requireNonGuestUser: async (c: any, next: () => Promise<void>) => (guest ? c.json({ code: 'guest_not_allowed' }, 403) : next()),
}));
mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: { query: { avatars: { findFirst: async () => ({ id: 'avatar-of-user' }) } } },
}));
mock.module('../../services/studios-media', () => ({
  ...realMedia,
  deleteOwnMedia: async (avatarId: string, id: string) => {
    deletes.push({ avatarId, id });
    return id === MEDIA;
  },
}));

const { mediaRoutes } = await import('../media');
const app = new Hono().route('/api/media', mediaRoutes);
app.onError((err, c) => (err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.json({ error: 'x' }, 500)));

function del(id: string, opts: { cookie?: string; agent?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = `auth_session=${opts.cookie}`;
  if (opts.agent) headers[realAgentAuth.AGENT_SESSION_HEADER] = 'agent-session';
  return app.request(`/api/media/${id}`, { method: 'DELETE', headers });
}

beforeEach(() => {
  sessions.clear();
  deletes.length = 0;
  guest = false;
  sessions.set('human', { userId: 'u1', createdVia: 'password' });
  sessions.set('exchanged', { userId: 'u1', createdVia: 'agent_exchange' });
});

describe('DELETE /api/media/:id', () => {
  it('the human owner deletes one item of the active avatar', async () => {
    const res = await del(MEDIA, { cookie: 'human' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, mediaId: MEDIA });
    expect(deletes).toEqual([{ avatarId: 'avatar-of-user', id: MEDIA }]);
  });

  it('an item that is not theirs (or not there) is 404', async () => {
    const res = await del('99999999-2222-4333-8444-555555555555', { cookie: 'human' });
    expect(res.status).toBe(404);
  });

  it('the agent header, an agent-exchange cookie, no session and a guest are refused before any delete', async () => {
    const agent = await del(MEDIA, { cookie: 'human', agent: true });
    expect(agent.status).toBe(403);
    expect(((await agent.json()) as { code: string }).code).toBe('media_delete_human_only');
    expect((await del(MEDIA, { cookie: 'exchanged' })).status).toBe(403);
    expect((await del(MEDIA)).status).toBe(401);
    guest = true;
    expect((await del(MEDIA, { cookie: 'human' })).status).toBe(403);
    expect(deletes).toEqual([]);
  });
});
