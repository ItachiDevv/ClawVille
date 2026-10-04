/**
 * Security H3 (2026-09-30) — issuing a staging Cove test-fixture run arms
 * deterministic outcomes for its owner's games, so POST /run now also needs a
 * NAMED admin (ADMIN_USER_IDS Lucia session), not any logged-in user or
 * ledger-capable agent. The env gate (staging-only, 404 elsewhere) still runs
 * first. `fixtureEnabled` is mocked on; the DB avatar lookup returns nothing, so
 * a request that passes the admin gate stops at 403 `active_avatar_required`.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import * as realDatabase from '@clawville/database';
import * as realAuth from '../../middleware/auth';
import * as realFixture from '../../services/cove-test-fixture';

process.env.FINGERPRINT_SECRET ??= '44'.repeat(32);
process.env.ADMIN_USER_IDS = '11111111-1111-4111-8111-111111111111';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

let fixtureOn = true;
let avatarLookups = 0;

mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: {
    query: {
      avatars: {
        findFirst: async () => {
          avatarLookups += 1;
          return undefined;
        },
      },
    },
  },
}));
mock.module('../../middleware/auth', () => ({
  ...realAuth,
  sessionMiddleware: async (c: any, next: () => Promise<void>) => {
    const userId = c.req.header('x-test-user');
    c.set('user', userId ? { id: userId } : null);
    await next();
  },
}));
mock.module('../../services/cove-test-fixture', () => ({
  ...realFixture,
  fixtureEnabled: () => fixtureOn,
}));

const { coveTestFixtureRouter } = await import('../cove-test-fixture');
const app = new Hono().route('/api/cove/test-fixture', coveTestFixtureRouter);

const body = { scenarioName: 'bj-natural', exposureBudgetCt: 100, ttlSeconds: 60 };
async function run(headers: Record<string, string> = {}) {
  const res = await app.request('/api/cove/test-fixture/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

afterAll(() => {
  mock.module('@clawville/database', () => realDatabase);
  mock.module('../../middleware/auth', () => realAuth);
  mock.module('../../services/cove-test-fixture', () => realFixture);
});

describe('POST /api/cove/test-fixture/run — named admin only (security H3)', () => {
  test('no session, a non-admin user, and an agent session are refused before any lookup', async () => {
    const attempts: Array<Record<string, string>> = [
      {},
      { 'x-test-user': OTHER_ID },
      { 'X-Clawville-Agent-Session': 'agent-session-id' },
    ];
    for (const headers of attempts) {
      const res = await run(headers);
      expect(res.status).toBe(403);
      expect(res.text).toContain('named_admin_required');
    }
    expect(avatarLookups).toBe(0);
  });

  test('a named admin passes the gate (then needs an active avatar as before)', async () => {
    const res = await run({ 'x-test-user': ADMIN_ID });
    expect(res.status).toBe(403);
    expect(res.text).toContain('active_avatar_required');
    expect(avatarLookups).toBe(1);
  });

  test('the staging env gate still answers 404 first', async () => {
    fixtureOn = false;
    try {
      const res = await run({ 'x-test-user': ADMIN_ID });
      expect(res.status).toBe(404);
    } finally {
      fixtureOn = true;
    }
  });
});
