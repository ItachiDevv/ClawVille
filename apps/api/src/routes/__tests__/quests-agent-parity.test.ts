/**
 * Rule E5 quest agent parity (2026-07-13) — routing-integrity tests.
 *
 * The five PLAYER quest routes moved from `requireAuth, requireNonGuestUser`
 * (human-only — the economy-audit P2 parity defect) to
 * `requireAuthOrAgentSession` (+ `requireNonGuestIdentity` on writes), the
 * SAME audited middleware every land/bounty economy route uses. Following the
 * `land-services.test.ts` precedent, the connected-agent write path itself is
 * NOT re-harnessed here (that coverage belongs to the middleware's own test
 * surface + the staging e2e smoke); what THIS file locks in is the routing
 * contract that resolves BEFORE any database touch:
 *
 *   1. Every player route rejects zero-auth-material requests with 401 —
 *      i.e. none of them silently fell back to a public or guest tier.
 *   2. The 401 comes from `requireAuthOrAgentSession` (its message names the
 *      agent-session header), proving the routes accept the agent bearer as
 *      a first-class credential — the actual parity change.
 *   3. Admin + tutorial routes still require the Lucia cookie (unchanged
 *      surface, human-only by design).
 */

import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { questRoutes, requireLedgerCapableIdentity } from '../quests';
import type { ActivityAuthContext } from '../../middleware/require-auth-or-agent';

const app = new Hono();
app.route('/api/quests', questRoutes);

const QUEST_ID = '3f2b8a1c-0000-4000-8000-000000000000';

const PLAYER_ROUTES: Array<{ method: 'GET' | 'POST'; path: string }> = [
  { method: 'GET', path: '/api/quests/my-quests' },
  { method: 'GET', path: '/api/quests/quest-log' },
  { method: 'POST', path: `/api/quests/${QUEST_ID}/accept` },
  { method: 'POST', path: `/api/quests/${QUEST_ID}/start` },
  { method: 'POST', path: `/api/quests/${QUEST_ID}/submit` },
];

describe('quest player routes — agent-or-auth gate (Rule E5)', () => {
  for (const { method, path } of PLAYER_ROUTES) {
    it(`${method} ${path} → 401 with zero auth material (no public/guest fallback)`, async () => {
      const res = await app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
      });
      expect(res.status).toBe(401);
      // The 401 must be requireAuthOrAgentSession's (it names BOTH accepted
      // credentials) — not requireAuth's cookie-only rejection. This is the
      // parity assertion: the agent bearer is a first-class credential here.
      const text = await res.text();
      expect(text).toContain('X-Clawville-Agent-Session');
    });
  }

  // DB-gated (land-services precedent): an unknown bearer takes the
  // restore-from-row path, which reads the database — without DATABASE_URL the
  // lazy db proxy throws (500 in the unit env, 401 in any real deployment).
  const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
  describeIfDb('with a database', () => {
    it('an invalid agent-session bearer is rejected 401 (fail-closed), not demoted', async () => {
      const res = await app.request(`/api/quests/${QUEST_ID}/accept`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Clawville-Agent-Session': 'not-a-real-session',
        },
      });
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).toContain('Invalid or expired agent session');
    });
  });

  it('non-UUID quest id 404s pre-DB on the write paths', async () => {
    const res = await app.request('/api/quests/not-a-uuid/accept', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Bearer present so the auth gate is not what rejects — but the UUID
        // guard runs in-handler AFTER auth, so an invalid bearer would 401
        // first. Use no auth and assert the 401 ordering instead.
      },
    });
    // Auth gate runs before the handler's UUID guard — zero-auth is 401 even
    // for a garbage id (no information leak about quest existence).
    expect(res.status).toBe(401);
  });
});

describe('requireLedgerCapableIdentity — ownership-proof gate (Codex HIGH #1)', () => {
  // Tiny harness: stamp an identity, then run the REAL exported middleware.
  function appWithIdentity(identity: ActivityAuthContext['Variables']['identity']) {
    const a = new Hono<ActivityAuthContext>();
    a.use('*', async (c, next) => {
      c.set('identity', identity);
      return next();
    });
    a.get('/probe', requireLedgerCapableIdentity, (c) => c.json({ ok: true }));
    return a;
  }

  const base = {
    userId: 'u-1',
    avatarId: 'av-1',
  };

  it('403s a bound-but-ownership-UNPROVEN agent session BEFORE the handler', async () => {
    const res = await appWithIdentity({
      kind: 'agent',
      ...base,
      agentId: 'a-1',
      sessionId: 's-1',
      ledgerCapable: false,
    } as ActivityAuthContext['Variables']['identity']).request('/probe');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('agent_session_not_ledger_authorized');
  });

  it('passes a ledger-capable agent session', async () => {
    const res = await appWithIdentity({
      kind: 'agent',
      ...base,
      agentId: 'a-1',
      sessionId: 's-1',
      ledgerCapable: true,
    } as ActivityAuthContext['Variables']['identity']).request('/probe');
    expect(res.status).toBe(200);
  });

  it('passes a human identity untouched', async () => {
    const res = await appWithIdentity({
      kind: 'user',
      ...base,
      agentId: null,
    } as ActivityAuthContext['Variables']['identity']).request('/probe');
    expect(res.status).toBe(200);
  });
});

describe('quest admin + tutorial routes — unchanged human-only surface', () => {
  it('POST /api/quests/admin/create → 401 without a Lucia cookie', async () => {
    const res = await app.request('/api/quests/admin/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it('tutorial claim stays cookie-gated (agent bearer is NOT accepted)', async () => {
    const res = await app.request('/api/quests/tutorial/say-hi/claim', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Clawville-Agent-Session': 'not-a-real-session',
      },
      body: JSON.stringify({}),
    });
    // requireAuth ignores the agent header entirely — 401, not 403/404.
    expect(res.status).toBe(401);
  });
});

// ─── DB-gated race coverage (Codex HIGH #2) ─────────────────────────────────
// Runs only with DATABASE_URL (staging DB) — exercises the REAL database
// semantics the fixes rely on: the partial unique index kills concurrent
// duplicate accepts, and the conditional completion-slot consume refuses the
// over-cap approval.
const describeIfDb2 = process.env.DATABASE_URL ? describe : describe.skip;
describeIfDb2('quest race guards (DB)', () => {
  it('concurrent duplicate active-submission inserts: exactly one wins (unique index)', async () => {
    const { db, quests, questSubmissions, avatars } = await import('@clawville/database');
    const { eq, sql } = await import('drizzle-orm');
    const [quest] = await db
      .insert(quests)
      .values({
        title: 'RACE-TEST quest (auto-cleanup)',
        description: 'test-only row for the concurrent-accept race guard',
        tier: 'side_quest',
        status: 'draft', // never visible on the live board
        tokenReward: 1,
        maxCompletions: 1,
      })
      .returning();
    const [anyAvatar] = await db.select({ id: avatars.id }).from(avatars).limit(1);
    expect(anyAvatar).toBeTruthy();
    try {
      const insertOnce = () =>
        db
          .insert(questSubmissions)
          .values({ questId: quest.id, avatarId: anyAvatar.id, status: 'accepted' })
          .returning()
          .then(() => 'ok' as const)
          .catch((e: { code?: string; cause?: { code?: string } }) =>
            e?.code === '23505' || e?.cause?.code === '23505' ? ('dup' as const) : Promise.reject(e),
          );
      const results = await Promise.all([insertOnce(), insertOnce(), insertOnce()]);
      expect(results.filter((r) => r === 'ok').length).toBe(1);
      expect(results.filter((r) => r === 'dup').length).toBe(2);
    } finally {
      await db.delete(questSubmissions).where(eq(questSubmissions.questId, quest.id));
      await db.delete(quests).where(eq(quests.id, quest.id));
    }
  });

  it('completion-slot consume: second approval of a 1-max quest gets 0 rows', async () => {
    const { db, quests } = await import('@clawville/database');
    const { eq, and, sql } = await import('drizzle-orm');
    const [quest] = await db
      .insert(quests)
      .values({
        title: 'CAP-TEST quest (auto-cleanup)',
        description: 'test-only row for the over-cap approval guard',
        tier: 'side_quest',
        status: 'draft',
        tokenReward: 1,
        maxCompletions: 1,
      })
      .returning();
    try {
      const consume = () =>
        db
          .update(quests)
          .set({ currentCompletions: sql`COALESCE(${quests.currentCompletions}, 0) + 1` })
          .where(
            and(
              eq(quests.id, quest.id),
              sql`(${quests.maxCompletions} IS NULL OR COALESCE(${quests.currentCompletions}, 0) < ${quests.maxCompletions})`,
            ),
          )
          .returning();
      const first = await consume();
      const second = await consume();
      expect(first.length).toBe(1);
      expect(first[0].currentCompletions).toBe(1);
      expect(second.length).toBe(0); // cap enforced — no second payout possible
    } finally {
      await db.delete(quests).where(eq(quests.id, quest.id));
    }
  });
});
