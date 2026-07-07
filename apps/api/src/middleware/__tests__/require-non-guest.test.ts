/**
 * GUEST → REAL-CT INVARIANT — shared guest-guard middleware unit tests.
 *
 * Drives the REAL `require-non-guest.ts` guards against a STUBBED
 * @clawville/database `db` (only `db.query.users.findFirst` is overridden; every
 * other member is spread from the real drizzle instance so co-running test files
 * that import named members keep resolving — bun shares ONE module registry).
 *
 * INVARIANTS PROVEN (founder ruling 2026-07-06 — guests earn DEMO CT only):
 *   1. requireNonGuestUser 403s a guest Lucia user (code:'guest_not_allowed'), does NOT call next().
 *   2. requireNonGuestUser passes a non-guest Lucia user (calls next()).
 *   3. requireNonGuestUser passes when there is NO Lucia user (agent path) WITHOUT a DB hit.
 *   4. requireNonGuestIdentity 403s a kind:'user' guest, does NOT call next().
 *   5. requireNonGuestIdentity passes a kind:'user' non-guest.
 *   6. requireNonGuestIdentity passes a kind:'agent' WITHOUT a DB hit  ← E5 AGENT-PASSTHROUGH lock.
 *   7. isGuestUser reflects the row's isGuest (true / false / missing → false).
 */

// Env BEFORE touching the database module: spreading the lazy `db` Proxy below
// reads `realDb.query`, which constructs the postgres client and THROWS at
// module load when DATABASE_URL is unset (pre-existing fragility — the file
// only passed when an earlier test file in the shared bun process had set it).
// SCOPED to module init: the placeholder is DELETED again right after the stub
// is built (see below), so DB-gated suites loading later in the same process
// still SKIP instead of running against a fake URL. No connection ever opens
// (every query hit is stubbed).
const DB_URL_WAS_SET = !!process.env.DATABASE_URL;
if (!DB_URL_WAS_SET) {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
}

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import * as realDatabase from '@clawville/database';

// The value the stubbed users.findFirst returns for the NEXT call. Each test
// controls it; the guard passes `where: eq(users.id, userId)` which we don't
// introspect — a test exercises exactly one userId so the return value is the
// scenario. `undefined` models "no row found".
let nextUserRow: { isGuest: boolean } | undefined;
const usersFindFirst = mock(async () => nextUserRow);

// Spread the real drizzle instance so ONLY users.findFirst is faked (keeps
// db.transaction / db.query.avatars real for any co-running test file).
const realDb = (realDatabase as any).db;
const fakeDb = {
  ...realDb,
  query: {
    ...(realDb?.query ?? {}),
    users: {
      ...(realDb?.query?.users ?? {}),
      findFirst: usersFindFirst,
    },
  },
};

mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: fakeDb,
}));

// Stub built — drop the module-init placeholder so later files see the real
// (absent) env and keep their skip-when-no-DB behavior.
if (!DB_URL_WAS_SET) {
  delete process.env.DATABASE_URL;
}

// Import the guards AFTER the mock is registered.
const { requireNonGuestUser, requireNonGuestIdentity, isGuestUser } = await import(
  '../require-non-guest'
);

const GUEST_ID = 'guest-user-id';
const REAL_ID = 'real-user-id';

// Minimal fake Hono context: the guards only touch c.get(k) + c.json(body,status).
function makeCtx(vars: Record<string, unknown>) {
  return {
    get: (k: string) => vars[k],
    // Mirror Hono's c.json shape enough to assert on (body + status).
    json: (body: unknown, status?: number) => ({ __json: true, body, status }),
  } as any;
}

beforeEach(() => {
  usersFindFirst.mockClear();
  nextUserRow = undefined;
});

describe('requireNonGuestUser (AppContext — after requireAuth / sessionMiddleware)', () => {
  it('403s a guest Lucia user and does NOT call next', async () => {
    nextUserRow = { isGuest: true };
    // Cast keeps bun's Mock assignable to Hono's Next (Promise<void>) while the
    // runtime still resolves the 'NEXT' sentinel the passthrough asserts on.
    const next = mock(async () => 'NEXT' as unknown as void);
    const res: any = await requireNonGuestUser(makeCtx({ user: { id: GUEST_ID } }), next);
    expect(res.__json).toBe(true);
    expect(res.status).toBe(403);
    expect((res.body as any).code).toBe('guest_not_allowed');
    expect(next).not.toHaveBeenCalled();
  });

  it('passes a non-guest Lucia user (calls next)', async () => {
    nextUserRow = { isGuest: false };
    // Cast keeps bun's Mock assignable to Hono's Next (Promise<void>) while the
    // runtime still resolves the 'NEXT' sentinel the passthrough asserts on.
    const next = mock(async () => 'NEXT' as unknown as void);
    const res = await requireNonGuestUser(makeCtx({ user: { id: REAL_ID } }), next);
    expect(res as unknown).toBe('NEXT');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes when there is NO Lucia user (agent path) WITHOUT a DB hit', async () => {
    // Cast keeps bun's Mock assignable to Hono's Next (Promise<void>) while the
    // runtime still resolves the 'NEXT' sentinel the passthrough asserts on.
    const next = mock(async () => 'NEXT' as unknown as void);
    const res = await requireNonGuestUser(makeCtx({ user: null }), next);
    expect(res as unknown).toBe('NEXT');
    expect(next).toHaveBeenCalledTimes(1);
    expect(usersFindFirst).not.toHaveBeenCalled();
  });
});

describe('requireNonGuestIdentity (ActivityAuthContext — after requireAuthOrAgentSession)', () => {
  it('403s a kind:"user" guest and does NOT call next', async () => {
    nextUserRow = { isGuest: true };
    // Cast keeps bun's Mock assignable to Hono's Next (Promise<void>) while the
    // runtime still resolves the 'NEXT' sentinel the passthrough asserts on.
    const next = mock(async () => 'NEXT' as unknown as void);
    const res: any = await requireNonGuestIdentity(
      makeCtx({ identity: { kind: 'user', userId: GUEST_ID } }),
      next,
    );
    expect(res.status).toBe(403);
    expect((res.body as any).code).toBe('guest_not_allowed');
    expect(next).not.toHaveBeenCalled();
  });

  it('passes a kind:"user" non-guest (calls next)', async () => {
    nextUserRow = { isGuest: false };
    // Cast keeps bun's Mock assignable to Hono's Next (Promise<void>) while the
    // runtime still resolves the 'NEXT' sentinel the passthrough asserts on.
    const next = mock(async () => 'NEXT' as unknown as void);
    const res = await requireNonGuestIdentity(
      makeCtx({ identity: { kind: 'user', userId: REAL_ID } }),
      next,
    );
    expect(res as unknown).toBe('NEXT');
    expect(next).toHaveBeenCalledTimes(1);
  });

  // E5 AGENT-PASSTHROUGH LOCK: an agent is NEVER a guest and must pass without
  // ever hitting the DB (no needless users lookup on the agent path).
  it('passes a kind:"agent" identity WITHOUT a DB hit', async () => {
    // Cast keeps bun's Mock assignable to Hono's Next (Promise<void>) while the
    // runtime still resolves the 'NEXT' sentinel the passthrough asserts on.
    const next = mock(async () => 'NEXT' as unknown as void);
    const res = await requireNonGuestIdentity(
      makeCtx({ identity: { kind: 'agent', userId: REAL_ID, agentId: 'a1' } }),
      next,
    );
    expect(res as unknown).toBe('NEXT');
    expect(next).toHaveBeenCalledTimes(1);
    expect(usersFindFirst).not.toHaveBeenCalled();
  });
});

describe('isGuestUser', () => {
  it('true when the row is a guest', async () => {
    nextUserRow = { isGuest: true };
    expect(await isGuestUser(GUEST_ID)).toBe(true);
  });
  it('false when the row is not a guest', async () => {
    nextUserRow = { isGuest: false };
    expect(await isGuestUser(REAL_ID)).toBe(false);
  });
  it('false when no row is found', async () => {
    nextUserRow = undefined;
    expect(await isGuestUser('missing')).toBe(false);
  });
});
