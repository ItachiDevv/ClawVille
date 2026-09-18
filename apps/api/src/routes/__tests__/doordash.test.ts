import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import { lucia } from '../../lib/auth';
import * as cli from '../../services/doordash-cli';
import * as operator from '../../services/doordash-operator';

const previousEnv = {
  DOORDASH_OPERATOR_USER_ID: process.env.DOORDASH_OPERATOR_USER_ID,
  ADMIN_USER_IDS: process.env.ADMIN_USER_IDS,
  CORS_ORIGIN: process.env.CORS_ORIGIN,
};
let app: Hono;
let routeImport = 0;
let userId: string | null;
let hasSession: boolean;
let dark: ReturnType<typeof cli.doordashDarkState>;
let available: boolean;
let runMock: ReturnType<typeof spyOn<typeof cli, 'runDdCli'>>;
let spawnGuard: ReturnType<typeof spyOn<typeof Bun, 'spawn'>>;
const restoreMocks: (() => void)[] = [];

beforeAll(() => {
  process.env.DOORDASH_OPERATOR_USER_ID = 'founder';
  process.env.ADMIN_USER_IDS = 'founder,other-admin';
  process.env.CORS_ORIGIN = 'https://operator.example';
});

beforeEach(async () => {
  userId = 'founder';
  hasSession = true;
  available = true;
  dark = { dark: false, since: null, reason: null };
  spawnGuard = spyOn(Bun, 'spawn').mockImplementation(() => {
    throw new Error('Tests must never execute the real dd-cli binary');
  });
  const sessionMock = spyOn(lucia, 'validateSession').mockImplementation(async () => ({
    user: userId ? { id: userId } : null,
    session: userId && hasSession ? {
      id: 'test-session', userId, fresh: false, expiresAt: new Date(Date.now() + 60_000),
    } : null,
  } as Awaited<ReturnType<typeof lucia.validateSession>>));
  // The operator id is fixed when doordash-operator first loads. In CI every
  // route file shares one Bun process, so an earlier file can load it with no
  // env and freeze it empty. Stub the lookup rather than trusting load order.
  const operatorMock = spyOn(operator, 'doordashOperatorUserId').mockImplementation(
    () => (process.env.ADMIN_USER_IDS ?? '').split(',').includes(process.env.DOORDASH_OPERATOR_USER_ID ?? '')
      ? process.env.DOORDASH_OPERATOR_USER_ID ?? null : null);
  restoreMocks.push(() => operatorMock.mockRestore());
  runMock = spyOn(cli, 'runDdCli').mockResolvedValue({ ok: true, data: { version: '0.2.4' }, durationMs: 1 });
  const availabilityMock = spyOn(cli, 'isDoordashAvailable').mockImplementation(() => available);
  const darkMock = spyOn(cli, 'doordashDarkState').mockImplementation(() => ({ ...dark }));
  restoreMocks.push(() => sessionMock.mockRestore(), () => runMock.mockRestore(),
    () => availabilityMock.mockRestore(), () => darkMock.mockRestore());
  const { doordashRoutes } = await import(`../doordash.ts?health-test=${++routeImport}`) as typeof import('../doordash');
  app = new Hono().route('/api/doordash', doordashRoutes);
});

afterEach(() => {
  for (const restore of restoreMocks.splice(0)) restore();
  expect(spawnGuard).not.toHaveBeenCalled();
  spawnGuard.mockRestore();
});

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function request(overrides: Record<string, string> = {}) {
  return app.request('/api/doordash/health', { headers: {
    cookie: `${lucia.sessionCookieName}=test-session`, origin: 'https://operator.example',
    ...overrides,
  } });
}

function expectNoStore(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Vary')).toBe('Cookie, X-Clawville-Agent-Session');
}

describe('GET /api/doordash/health', () => {
  test('returns the exact health shape for a founder Lucia session', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: true, dark: false, since: null, reason: null, binVersion: '0.2.4' });
    expect(runMock.mock.calls).toEqual([['version', []]]);
    expectNoStore(response);
  });

  test('probes while dark and reads state after successful recovery', async () => {
    available = false;
    dark = { dark: true, since: '2026-09-16T00:00:00.000Z', reason: 'ddcli_version_mismatch' };
    runMock.mockImplementation((async () => {
      available = true;
      dark = { dark: false, since: null, reason: null };
      return { ok: true, data: { version: '0.2.4' }, durationMs: 1 };
    }) as typeof cli.runDdCli);
    const response = await request();
    expect(await response.json()).toEqual({ available: true, dark: false, since: null, reason: null, binVersion: '0.2.4' });
    expect(runMock.mock.calls).toEqual([['version', []]]);
  });

  test('reports a failed probe with no binary version or failure detail', async () => {
    available = false;
    dark = { dark: true, since: '2026-09-16T00:00:00.000Z', reason: 'ddcli_version_mismatch' };
    runMock.mockResolvedValue({ ok: false, failure: 'ddcli_version_mismatch', detail: 'private detail', durationMs: 1 });
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false, ...dark, binVersion: null });
  });

  test('rejects another logged-in user or admin before probing', async () => {
    for (const id of ['other-user', 'other-admin']) {
      userId = id;
      const response = await request();
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('doordash_operator_only');
      expectNoStore(response);
    }
    expect(runMock).not.toHaveBeenCalled();
  });

  test('rejects unauthenticated requests and missing live Lucia sessions', async () => {
    const anonymous = await request({ cookie: 'cv_dash=shared-password-cookie' });
    expect(anonymous.status).toBe(401);
    expectNoStore(anonymous);
    hasSession = false;
    const stale = await request();
    expect(stale.status).toBe(401);
    expectNoStore(stale);
    expect(runMock).not.toHaveBeenCalled();
  });

  test('enforces the existing Origin gate for founder requests', async () => {
    const response = await request({ origin: 'https://unapproved.example' });
    expect(response.status).toBe(403);
    expectNoStore(response);
    expect(runMock).not.toHaveBeenCalled();
  });

  test('allows twenty probes per minute and refuses the next without a probe', async () => {
    for (let i = 0; i < 20; i++) expect((await request()).status).toBe(200);
    const response = await request();
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'rate_limited' });
    expectNoStore(response);
    expect(runMock).toHaveBeenCalledTimes(20);
  });

  test('does not expose the Phase 3 order routes', async () => {
    expect((await app.request('/api/doordash/orders')).status).toBe(404);
    expect((await app.request('/api/doordash/orders/order-1')).status).toBe(404);
    expect(runMock).not.toHaveBeenCalled();
  });
});
