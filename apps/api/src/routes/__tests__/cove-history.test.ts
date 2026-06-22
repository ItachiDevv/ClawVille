/**
 * Cove prod hotfix (2026-06-21) — cove-history subject-resolution tests.
 *
 * Regression guard for the E5-parity defect behind "won 20 CT, no history":
 * the WRITE path (cove-slots getSubject) resolved {user, agent, guest} and an
 * agent's spin events are written with `user_id` = the agent's BOUND userId,
 * but the READ path (cove-history resolveSubject) had NO agent branch, so a
 * connected/hosted agent fell through to GUEST scoping and read ZERO rows.
 *
 * These tests assert the fixed precedence: Lucia user → agent session →
 * guest, and that an agent reads exactly the rows its own userId wrote (and
 * NOT a guest's rows).
 *
 * `resolveAgentSession` is MOCKED so no live agent session / npc-sim registry
 * is needed — we only need to prove the routing + DB scoping. DB-backed (mirrors
 * cove-slots.test.ts `describeIfDb`): skips locally without DATABASE_URL,
 * runs in CI / Coolify env.
 */

import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
// Capture the REAL module exports BEFORE installing the process-global mock so
// we can re-export the members we don't override (validateLiveAgentSession,
// requireAuthOrAgentSession, …) — sibling test files in the same bun run load
// this module too and need its full surface.
import * as realAuthOrAgent from '../../middleware/require-auth-or-agent';
import type { AppContext } from '../../types';

// Set the fingerprint secret before anything that transitively loads the
// fingerprint middleware (module-load throw guard).
process.env.FINGERPRINT_SECRET =
  process.env.FINGERPRINT_SECRET ?? 'a'.repeat(64);

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const AGENT_SESSION_HEADER = 'X-Clawville-Agent-Session';

// The agent session id the mock recognizes, and the user it resolves to. The
// test inserts a cove event under AGENT_USER_ID and asserts the agent-header
// request sees it (scoped by that userId), exactly like the human would.
const AGENT_SESSION_ID = 'mock-agent-session-cove-history';
let AGENT_USER_ID = '';

// Mock the dual-identity middleware so cove-history's agent branch resolves to
// a ledger-capable bound user WITHOUT a real npc-sim session. bun's
// `mock.module` is PROCESS-GLOBAL and REPLACES the module wholesale, so we must
// re-export the real module's other members (validateLiveAgentSession, the
// middleware, etc.) that sibling test files in the same run transitively import
// — otherwise overriding just `resolveAgentSession` would erase them.
mock.module('../../middleware/require-auth-or-agent', () => {
  return {
    ...realAuthOrAgent,
    AGENT_SESSION_HEADER,
    resolveAgentSession: async (sessionId: string) => {
      if (sessionId === AGENT_SESSION_ID) {
        return {
          userId: AGENT_USER_ID,
          avatarId: 'mock-avatar-id',
          agentId: 'mock-agent-id',
          ledgerCapable: true,
        };
      }
      return null;
    },
  };
});

describeIfDb('Cove History — subject resolution (agent parity hotfix)', () => {
  let app: Hono<any>;
  let db: typeof import('@clawville/database')['db'];
  let coveGameEvents: typeof import('@clawville/database')['coveGameEvents'];
  let users: typeof import('@clawville/database')['users'];

  const GUEST_FP = 'mock-guest-fp-hash-cove-history';
  let guestEventId = '';
  let agentEventId = '';

  // Stub the fingerprint context vars (set globally in index.ts; tests don't
  // mount that middleware). The guest read path keys on c.get('fpHash').
  function buildApp(coveHistoryRouter: Hono<any>) {
    const a = new Hono<AppContext>();
    a.use('*', async (c, next) => {
      c.set('fpHash', GUEST_FP);
      c.set('ipPrefixHash', '');
      // No Lucia user by default — individual requests don't carry a cookie,
      // so c.get('user') is undefined and the agent/guest branches decide.
      await next();
    });
    a.route('/api/cove/history', coveHistoryRouter);
    return a;
  }

  function makeEvent(over: Record<string, unknown>) {
    return {
      gameType: 'slots',
      sessionId: crypto.randomUUID(),
      shoeId: crypto.randomUUID(),
      betAmount: '20',
      payout: '40',
      outcomeJson: { paytableId: 'classic-3x5', winAmount: '40' },
      serverSeedHash: 'a'.repeat(64),
      clientSeed: 'client-seed',
      nonce: 0,
      engineVersion: 'v1',
      ...over,
    };
  }

  beforeAll(async () => {
    const dbmod = await import('@clawville/database');
    db = dbmod.db;
    coveGameEvents = dbmod.coveGameEvents;
    users = dbmod.users;

    // Real user row (FK target for the agent-owned event).
    const [u] = await db.insert(users).values({}).returning({ id: users.id });
    AGENT_USER_ID = u.id;

    // Import the router AFTER the mock + user id are set.
    const { coveHistoryRouter } = await import('../cove-history');
    app = buildApp(coveHistoryRouter);

    // One event owned by the agent's bound user (userId set, guestFpHash null).
    const [ae] = await db
      .insert(coveGameEvents)
      .values(makeEvent({ userId: AGENT_USER_ID, guestFpHash: null }))
      .returning({ id: coveGameEvents.id });
    agentEventId = ae.id;

    // One event owned by a guest (guestFpHash set, userId null).
    const [ge] = await db
      .insert(coveGameEvents)
      .values(makeEvent({ userId: null, guestFpHash: GUEST_FP }))
      .returning({ id: coveGameEvents.id });
    guestEventId = ge.id;
  });

  afterAll(async () => {
    // Restore the process-global module mock so a full `bun test` run doesn't
    // carry our sentinel-only resolveAgentSession into other route suites.
    mock.restore();
    if (!HAS_DB) return;
    if (agentEventId) await db.delete(coveGameEvents).where(eq(coveGameEvents.id, agentEventId));
    if (guestEventId) await db.delete(coveGameEvents).where(eq(coveGameEvents.id, guestEventId));
    if (AGENT_USER_ID) await db.delete(users).where(eq(users.id, AGENT_USER_ID));
  });

  it('agent-session request scopes history by the BOUND userId (FIX A)', async () => {
    const res = await app.request('/api/cove/history?game=slots', {
      headers: { [AGENT_SESSION_HEADER]: AGENT_SESSION_ID },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ id: string }>; subject: string };
    // Resolved as a 'user' subject (the agent's bound userId), NOT 'guest'.
    expect(body.subject).toBe('user');
    const ids = body.events.map((e) => e.id);
    expect(ids).toContain(agentEventId);
    // Must NOT leak the guest's rows to the agent.
    expect(ids).not.toContain(guestEventId);
  });

  it('guest-only request (no agent header) does NOT see the agent-owned event', async () => {
    const res = await app.request('/api/cove/history?game=slots', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ id: string }>; subject: string };
    expect(body.subject).toBe('guest');
    const ids = body.events.map((e) => e.id);
    expect(ids).toContain(guestEventId);
    expect(ids).not.toContain(agentEventId);
  });

  it('unknown agent session falls through to guest scoping (read-only, no leak)', async () => {
    const res = await app.request('/api/cove/history?game=slots', {
      headers: { [AGENT_SESSION_HEADER]: 'totally-unknown-session' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ id: string }>; subject: string };
    // Unknown agent → mock returns null → guest scoping. Sees the guest row
    // (same fpHash stub), never the agent's.
    expect(body.subject).toBe('guest');
    const ids = body.events.map((e) => e.id);
    expect(ids).not.toContain(agentEventId);
  });
});
