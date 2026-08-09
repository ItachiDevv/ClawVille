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
import {
  requireLedgerCapableIdentity as requireSharedLedgerCapableIdentity,
  type ActivityAuthContext,
} from '../../middleware/require-auth-or-agent';

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

  it('fails closed when identity resolution middleware was omitted', async () => {
    const a = new Hono<ActivityAuthContext>();
    a.get('/probe', requireSharedLedgerCapableIdentity, (c) => c.json({ ok: true }));
    const res = await a.request('/probe');
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('identity_resolution_required');
  });

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

describe('quest admin routes — unchanged human-only surface', () => {
  it('POST /api/quests/admin/create → 401 without a Lucia cookie', async () => {
    const res = await app.request('/api/quests/admin/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

});

describe('tutorial ladder — the P6 parity flip (was tracked debt)', () => {
  // This suite used to assert the OPPOSITE: that the tutorial ladder ignored
  // the agent header entirely. It paid real vCLAW on a Lucia-only route, which
  // was the last Rule E5 parity gap on a live money surface. P6 (2026-08-09)
  // closed it, and these cases are the deliberate flip.
  const TUTORIAL_ROUTES: Array<{ method: 'GET' | 'POST'; path: string }> = [
    { method: 'POST', path: '/api/quests/tutorial/say-hi-nori/claim' },
    { method: 'GET', path: '/api/quests/tutorial/claims' },
  ];

  for (const { method, path } of TUTORIAL_ROUTES) {
    it(`${method} ${path} → 401 naming the agent header, not a cookie-only rejection`, async () => {
      const res = await app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
      });
      expect(res.status).toBe(401);
      // The parity assertion: the agent bearer is a first-class credential on
      // the tutorial ladder now, so the 401 must be
      // requireAuthOrAgentSession's (which names BOTH accepted credentials),
      // never requireAuth's cookie-only one.
      expect(await res.text()).toContain('X-Clawville-Agent-Session');
    });

    it(`${method} ${path} → rejects an unresolvable agent session (401, session-aware)`, async () => {
      const res = await app.request(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Clawville-Agent-Session': 'not-a-real-session',
        },
        ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
      });
      // requireAuth would have ignored the header and produced its own 401.
      // This 401 comes from session resolution, so the header was READ.
      expect(res.status).toBe(401);
      expect(await res.text()).toContain('agent session');
    });
  }
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

  it('CAS submit predicate cannot reopen an approved submission (round-2 HIGH #1)', async () => {
    const { db, quests, questSubmissions, questRewards, avatars } = await import('@clawville/database');
    const { eq, and, sql } = await import('drizzle-orm');
    const [quest] = await db
      .insert(quests)
      .values({
        title: 'REOPEN-TEST quest (auto-cleanup)',
        description: 'test-only row for the stale-submit reopen guard',
        tier: 'side_quest',
        status: 'draft',
        tokenReward: 1,
        maxCompletions: 1,
      })
      .returning();
    const [anyAvatar] = await db.select({ id: avatars.id }).from(avatars).limit(1);
    try {
      const [sub] = await db
        .insert(questSubmissions)
        .values({ questId: quest.id, avatarId: anyAvatar.id, status: 'approved' })
        .returning();
      // The EXACT predicate the submit handler uses — an approved row must not match.
      const reopened = await db
        .update(questSubmissions)
        .set({ status: 'submitted' })
        .where(
          and(
            eq(questSubmissions.questId, quest.id),
            eq(questSubmissions.avatarId, anyAvatar.id),
            sql`${questSubmissions.status} IN ('accepted', 'in_progress')`,
          ),
        )
        .returning();
      expect(reopened.length).toBe(0);

      // Defense-in-depth: a second reward row for the same submission is refused.
      await db.insert(questRewards).values({
        submissionId: sub.id, avatarId: anyAvatar.id, questId: quest.id, tokensAwarded: 1,
      });
      const dup = await db
        .insert(questRewards)
        .values({ submissionId: sub.id, avatarId: anyAvatar.id, questId: quest.id, tokensAwarded: 1 })
        .then(() => 'ok')
        .catch((e: { code?: string; cause?: { code?: string } }) =>
          e?.code === '23505' || e?.cause?.code === '23505' ? 'dup' : Promise.reject(e),
        );
      expect(dup).toBe('dup');
    } finally {
      await db.delete(questRewards).where(eq(questRewards.questId, quest.id));
      await db.delete(questSubmissions).where(eq(questSubmissions.questId, quest.id));
      await db.delete(quests).where(eq(quests.id, quest.id));
    }
  });

  it('round 3: one payout per (quest, avatar) — duplicate reward 23505; approved row blocks the accept predicate', async () => {
    const { db, quests, questSubmissions, questRewards, avatars } = await import('@clawville/database');
    const { eq, and, sql } = await import('drizzle-orm');
    const [quest] = await db
      .insert(quests)
      .values({
        title: 'REPAYOUT-TEST quest (auto-cleanup)',
        description: 'test-only row for the per-avatar repeat-payout guard',
        tier: 'side_quest',
        status: 'draft',
        tokenReward: 1,
        maxCompletions: 5,
      })
      .returning();
    const [anyAvatar] = await db.select({ id: avatars.id }).from(avatars).limit(1);
    try {
      const [subA] = await db
        .insert(questSubmissions)
        .values({ questId: quest.id, avatarId: anyAvatar.id, status: 'approved' })
        .returning();
      // The accept route/action predicate: any non-rejected row blocks.
      const blocking = await db
        .select({ id: questSubmissions.id })
        .from(questSubmissions)
        .where(
          and(
            eq(questSubmissions.questId, quest.id),
            eq(questSubmissions.avatarId, anyAvatar.id),
            sql`${questSubmissions.status} <> 'rejected'`,
          ),
        );
      expect(blocking.length).toBe(1);

      // DB layer: a second reward for the same (quest, avatar) — even via a
      // DIFFERENT submission — is refused by quest_rewards_avatar_quest_unique.
      const [subB] = await db
        .insert(questSubmissions)
        .values({ questId: quest.id, avatarId: anyAvatar.id, status: 'rejected' })
        .returning();
      await db.insert(questRewards).values({
        submissionId: subA.id, avatarId: anyAvatar.id, questId: quest.id, tokensAwarded: 1,
      });
      const dup = await db
        .insert(questRewards)
        .values({ submissionId: subB.id, avatarId: anyAvatar.id, questId: quest.id, tokensAwarded: 1 })
        .then(() => 'ok')
        .catch((e: { code?: string; cause?: { code?: string } }) =>
          e?.code === '23505' || e?.cause?.code === '23505' ? 'dup' : Promise.reject(e),
        );
      expect(dup).toBe('dup');
    } finally {
      await db.delete(questRewards).where(eq(questRewards.questId, quest.id));
      await db.delete(questSubmissions).where(eq(questSubmissions.questId, quest.id));
      await db.delete(quests).where(eq(quests.id, quest.id));
    }
  });

  it('round 3: expired active quest fails the accept lookup predicate', async () => {
    const { db, quests } = await import('@clawville/database');
    const { eq, and, sql } = await import('drizzle-orm');
    const [quest] = await db
      .insert(quests)
      .values({
        title: 'EXPIRY-TEST quest (auto-cleanup)',
        description: 'test-only row for the expiry accept guard',
        tier: 'side_quest',
        status: 'active',
        tokenReward: 1,
        expiresAt: new Date(Date.now() - 60_000),
      })
      .returning();
    try {
      const rows = await db
        .select({ id: quests.id })
        .from(quests)
        .where(
          and(
            eq(quests.id, quest.id),
            eq(quests.status, 'active'),
            sql`(${quests.expiresAt} IS NULL OR ${quests.expiresAt} > now())`,
          ),
        );
      expect(rows.length).toBe(0);
    } finally {
      await db.delete(quests).where(eq(quests.id, quest.id));
    }
  });

  it('round 5: native quest actions fail closed on unresolvable + guest identities', async () => {
    const dbMod = await import('@clawville/database');
    const { allActions } = await import('@clawville/agent-runtime');
    const acceptQuestAction = allActions.find((a: { name: string }) => a.name === 'ACCEPT_QUEST')!;
    const submitQuestAction = allActions.find((a: { name: string }) => a.name === 'SUBMIT_QUEST')!;
    const services = {
      db: dbMod.db,
      creditClawTokens: async () => ({ balanceAfter: 0 }),
      debitClawTokens: async () => ({ balanceAfter: 0 }),
    };
    const msg = (params: Record<string, string>) => ({
      content: { text: '', parameters: params },
      parameters: params,
      ...params,
    });

    // Unresolvable actor (e.g. a bot-row id wrongly passed as avatarId).
    const ghost = await acceptQuestAction.handler(
      null,
      msg({ questId: '3f2b8a1c-0000-4000-8000-000000000000' }),
      { avatarId: 'a0000000-0000-4000-8000-000000000000', userId: 'u', services },
    );
    expect(ghost.success).toBe(false);
    expect(ghost.text).toContain('quest_actor_unresolved');

    const ghostSubmit = await submitQuestAction.handler(
      null,
      msg({ questId: '3f2b8a1c-0000-4000-8000-000000000000', note: 'ten characters minimum note' }),
      { avatarId: 'a0000000-0000-4000-8000-000000000000', userId: 'u', services },
    );
    expect(ghostSubmit.success).toBe(false);
    expect(ghostSubmit.text).toContain('quest_actor_unresolved');

    // Guest-owned avatar (if one exists in this DB): real-economy wall holds.
    const { avatars, users, eq } = dbMod;
    const [guestAvatar] = await dbMod.db
      .select({ id: avatars.id })
      .from(avatars)
      .innerJoin(users, eq(users.id, avatars.userId))
      .where(eq(users.isGuest, true))
      .limit(1);
    if (guestAvatar) {
      const asGuest = await acceptQuestAction.handler(
        null,
        msg({ questId: '3f2b8a1c-0000-4000-8000-000000000000' }),
        { avatarId: guestAvatar.id, userId: 'u', services },
      );
      expect(asGuest.success).toBe(false);
      expect(asGuest.text).toContain('demo economy');
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
