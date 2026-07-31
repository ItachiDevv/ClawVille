import { beforeAll, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import type { AppContext } from '../../types';

process.env.FINGERPRINT_SECRET =
  process.env.FINGERPRINT_SECRET ?? 'world-ws-identity-test-secret-000000000000000000';

mock.module('../../lib/auth', () => ({
  resolveSessionCookieDomain: () => undefined,
  lucia: {
    readSessionCookie(cookie: string) {
      return /(?:^|;\s*)auth_session=([^;]+)/u.exec(cookie)?.[1] ?? null;
    },
    async validateSession(sessionId: string) {
      if (sessionId !== 'valid-human') return { session: null, user: null };
      return {
        session: {
          id: 'lucia-session-1',
          userId: 'user-1',
          expiresAt: new Date(Date.now() + 60_000),
          fresh: false,
        },
        user: {
          id: 'user-1',
          email: 'human@example.test',
          name: 'Human',
          avatarUrl: null,
          username: null,
        },
      };
    },
    createSessionCookie(sessionId: string) {
      return { serialize: () => `auth_session=${sessionId}; Path=/; HttpOnly` };
    },
    createBlankSessionCookie() {
      return { serialize: () => 'auth_session=; Path=/; Max-Age=0' };
    },
  },
}));

mock.module('../../middleware/require-auth-or-agent', () => ({
  AGENT_SESSION_HEADER: 'X-Clawville-Agent-Session',
  async validateLiveAgentSession(sessionId: string) {
    if (sessionId !== 'valid-agent') return null;
    return {
      config: { agentId: 'agent-7' },
      bot: { userId: 'user-agent-owner' },
    };
  },
}));

const { sessionMiddleware } = await import('../../middleware/auth');
const { fingerprintMiddleware } = await import('../../middleware/fingerprint');
const { resolveWorldPresence } = await import(
  '../../services/world-presence-identity'
);
const {
  guestBindingCookieOptions,
  signGuestBinding,
  verifyGuestBinding,
  WORLD_GUEST_COOKIE_NAME,
} = await import('../../services/world-guest-binding');

let app: Hono<AppContext>;

beforeAll(() => {
  app = new Hono<AppContext>();
  app.use('*', fingerprintMiddleware);
  app.use('*', sessionMiddleware);
  app.get('/resolve', async (c) => c.json(await resolveWorldPresence(c)));
  app.post('/join', async (c) => {
    const presence = await resolveWorldPresence(c);
    if (presence.kind === 'guest' && presence.guestPresenceKey) {
      setCookie(
        c,
        WORLD_GUEST_COOKIE_NAME,
        signGuestBinding(presence.guestPresenceKey),
        guestBindingCookieOptions(),
      );
    }
    return c.json(presence);
  });
});

function headers(overrides: Record<string, string> = {}): Headers {
  return new Headers({
    'User-Agent': 'identity-test-agent',
    'X-Forwarded-For': '203.0.113.8',
    ...overrides,
  });
}

async function readPresence(
  path: '/resolve' | '/join',
  requestHeaders: Headers,
) {
  const response = await app.request(path, {
    method: path === '/join' ? 'POST' : 'GET',
    headers: requestHeaders,
  });
  return {
    response,
    body: (await response.json()) as {
      sessionId: string;
      kind: 'human' | 'guest' | 'agent';
      userId: string | null;
      guestPresenceKey?: string;
      guestBindingFromCookie?: boolean;
    },
  };
}

function worldCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie') ?? '';
  const match = new RegExp(`${WORLD_GUEST_COOKIE_NAME}=([^;,]+)`, 'u').exec(
    setCookie,
  );
  expect(match).not.toBeNull();
  return `${WORLD_GUEST_COOKIE_NAME}=${match![1]}`;
}

describe('world presence identity resolver', () => {
  it('resolves a valid Lucia cookie as human', async () => {
    const result = await readPresence(
      '/resolve',
      headers({ Cookie: 'auth_session=valid-human' }),
    );
    expect(result.body).toMatchObject({
      kind: 'human',
      sessionId: 'lucia-session-1',
      userId: 'user-1',
    });
  });

  it('falls through an invalid Lucia cookie to guest', async () => {
    const result = await readPresence(
      '/resolve',
      headers({ Cookie: 'auth_session=expired' }),
    );
    expect(result.body.kind).toBe('guest');
  });

  it('resolves a valid agent bearer and fails an invalid bearer closed to guest', async () => {
    const valid = await readPresence(
      '/resolve',
      headers({ 'X-Clawville-Agent-Session': 'valid-agent' }),
    );
    expect(valid.body).toMatchObject({
      kind: 'agent',
      sessionId: 'a:agent-7',
      userId: 'user-agent-owner',
    });
    const invalid = await readPresence(
      '/resolve',
      headers({ 'X-Clawville-Agent-Session': 'expired-agent' }),
    );
    expect(invalid.body.kind).toBe('guest');
  });

  it('keeps Lucia precedence over an agent bearer', async () => {
    const result = await readPresence(
      '/resolve',
      headers({
        Cookie: 'auth_session=valid-human',
        'X-Clawville-Agent-Session': 'valid-agent',
      }),
    );
    expect(result.body.kind).toBe('human');
    expect(result.body.sessionId).toBe('lucia-session-1');
  });

  it('/join stamps a session-scoped cookie committing to its exact guest key', async () => {
    const joined = await readPresence('/join', headers());
    const cookie = worldCookie(joined.response);
    const value = cookie.slice(cookie.indexOf('=') + 1);
    expect(joined.body.guestPresenceKey).toBeDefined();
    expect(joined.body.sessionId).toBe(`g:${joined.body.guestPresenceKey}`);
    expect(verifyGuestBinding(value)).toBe(joined.body.guestPresenceKey!);
    const serialized = joined.response.headers.get('set-cookie') ?? '';
    expect(serialized).toContain('HttpOnly');
    expect(serialized).toContain('Path=/');
    expect(serialized).not.toContain('Max-Age');
    expect(serialized).not.toContain('Expires');
  });

  it('pins guest identity across IP-prefix and User-Agent changes', async () => {
    const joined = await readPresence('/join', headers());
    const cookie = worldCookie(joined.response);
    const changed = await readPresence(
      '/resolve',
      headers({
        Cookie: cookie,
        'User-Agent': 'different-agent',
        'X-Forwarded-For': '198.51.100.9',
      }),
    );
    expect(changed.body.sessionId).toBe(joined.body.sessionId);
    expect(changed.body.guestBindingFromCookie).toBe(true);

    const unbound = await readPresence(
      '/resolve',
      headers({
        'User-Agent': 'different-agent',
        'X-Forwarded-For': '198.51.100.9',
      }),
    );
    expect(unbound.body.sessionId).not.toBe(joined.body.sessionId);
  });

  it('pins a tier-1 fingerprint join to a headerless upgrade-shaped request', async () => {
    const joined = await readPresence(
      '/join',
      headers({ 'X-CV-Fingerprint': 'browser-fingerprint' }),
    );
    const resolved = await readPresence(
      '/resolve',
      headers({ Cookie: worldCookie(joined.response) }),
    );
    expect(resolved.body.sessionId).toBe(joined.body.sessionId);
  });

  it('with cookies blocked, remains as consistent as the fingerprint fallback', async () => {
    const first = await readPresence('/resolve', headers());
    const second = await readPresence('/resolve', headers());
    expect(second.body.sessionId).toBe(first.body.sessionId);
  });
});
