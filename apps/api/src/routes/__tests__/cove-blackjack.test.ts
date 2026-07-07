/**
 * Phase 6.4.1 — Cove blackjack ROUTE regression tests (Codex cove INFO).
 *
 * Locks the concurrency / hidden-state / money-lens invariants that the
 * agent-parity + Autonomous-relay work introduced. Like cove-slots.test.ts these
 * are DB-backed and live inside a `describeIfDb()` block that SKIPS when
 * DATABASE_URL is unset (local Windows dev runs without it per CLAUDE.md; CI /
 * Coolify provides it). Nothing here mutates real production state beyond the
 * disposable per-run test users, all cleaned up in afterAll.
 *
 * Coverage (the four Codex INFO regressions + the insure-parity fix this round):
 *   1. GET /hand/current — VISIBLE view only: player cards + dealer UPCARD, and
 *      NEVER the dealer hole card, the undealt shoe, or the serverSeed. This is
 *      the read-only restore surface the Autonomous driver uses after a stale 409,
 *      so a single leaked field would hand a co-piloting agent the future deck.
 *   2. Stale-DEAL 409 (`stale_agent_deal`) — once a hand has been dealt (shoe
 *      handCounter advanced), a deal carrying the OLD `expectedHandsPlayed` epoch
 *      is rejected, so a stale in-flight agent deal can't open an extra hand; a
 *      deal at the CURRENT epoch still succeeds.
 *   3. Stale-ACTION 409 (`stale_agent_decision`) — an /action carrying a
 *      `expectedHandVersion` that no longer matches the live hand is rejected; the
 *      same action at the live version succeeds. PLUS the insure-parity fix:
 *      /action {action:'insure'} now honors `expectedHandVersion` too (it was the
 *      ONLY action not wired through the stale-decision contract), and an insure
 *      against an already-settled hand replays the settled outcome rather than a
 *      phantom { tookInsurance } ack.
 *   4. Settle `hand_shoe_mismatch` 409 — `settleHand` loads the hand by BOTH (id,
 *      shoeId); a caller-owned shoeId + a foreign handId resolves to no row → 409,
 *      never settling the foreign hand's outcome to the caller's balance.
 *
 * The precondition fields (`expectedHandsPlayed`/`expectedHandVersion`) are
 * OPTIONAL on the schema and enforced for ANY subject, so the human path drives
 * them directly here without standing up an agent session — exactly the contract
 * the route promises ("OMITTED on human manual ... preserves unconditional legacy
 * behavior").
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import {
  coveBlackjackRouter,
  __resetBlackjackRateLimits,
  __settleHandForTest,
} from '../cove-blackjack';
import { authRoutes } from '../auth';
import { avatarRoutes } from '../avatars';
import { createServerSeed } from '../../services/provable-rng';
import type { AppContext } from '../../types';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

function buildApp() {
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.set('fpHash', '');
    c.set('ipPrefixHash', '');
    await next();
  });
  app.route('/api/auth', authRoutes);
  app.route('/api/avatars', avatarRoutes);
  app.route('/api/cove/blackjack', coveBlackjackRouter);
  return app;
}

/**
 * Recursively walk a parsed JSON response and collect every string-ish value +
 * key so a hidden-state assertion can prove a secret NEVER appears anywhere in
 * the payload (not just at the top level). Used by the /hand/current leak test.
 */
function flattenStrings(v: unknown, keys: string[] = [], strings: string[] = []): {
  keys: string[];
  strings: string[];
} {
  if (v === null || v === undefined) return { keys, strings };
  if (typeof v === 'string') {
    strings.push(v);
  } else if (Array.isArray(v)) {
    for (const item of v) flattenStrings(item, keys, strings);
  } else if (typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      keys.push(k);
      flattenStrings(val, keys, strings);
    }
  }
  return { keys, strings };
}

describeIfDb('Cove Blackjack — route regressions (requires DATABASE_URL)', () => {
  const dbMod = HAS_DB ? require('@clawville/database') : null;

  const TEST_EMAIL = `bj-${Date.now()}@clawville-test.com`;
  const TEST_PASSWORD = 'bjpassword123';
  let app: ReturnType<typeof buildApp>;
  let cookie1 = '';
  let userId1 = '';
  let avatarId1 = '';

  async function signupAndCreateAvatar(email: string) {
    const signup = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: TEST_PASSWORD, name: 'BJ Tester' }),
    });
    expect(signup.status).toBe(200);
    const cookieHeader = signup.headers.get('set-cookie') ?? '';
    const sessionCookie = cookieHeader.split(';')[0]!;

    const avatarRes = await app.request('/api/avatars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({
        name: `BJ${Date.now()}${Math.floor(Math.random() * 10000)}`,
        species: 'cat',
        color: 'green',
        gender: 'male',
        personality: { habitat: 'forest', hobby: 'exploring', greeting: 'wave-hello' },
        characterConfig: {
          bio: 'A bj-test avatar.',
          greeting: 'Hello there!',
          personality: 'Test avatar',
          tone: 'friendly',
          topics: ['cove'],
          adjectives: ['lucky'],
          rules: [],
          style: [],
        },
      }),
    });
    expect(avatarRes.status).toBe(200);
    const avatarData = (await avatarRes.json()) as any;
    const userRow = await dbMod.db.query.users.findFirst({
      where: eq(dbMod.users.email, email),
    });
    return {
      cookie: sessionCookie,
      userId: userRow.id as string,
      avatarId: avatarData.avatar.id as string,
    };
  }

  /** Open a shoe (route) + deal until a NON-natural in-progress hand lands. */
  async function dealLiveHand(): Promise<{ shoeId: string; handId: string }> {
    const openRes = await app.request('/api/cove/blackjack/session/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ currency: 'clawtoken' }),
    });
    expect(openRes.status).toBe(200);
    const shoeId = ((await openRes.json()) as any).shoe.id as string;

    // Deal until a non-natural hand survives (naturals settle inline). Bounded.
    for (let i = 0; i < 30; i++) {
      const res = await app.request('/api/cove/blackjack/hand/deal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie1,
          'Idempotency-Key': `deal-live-${Date.now()}-${i}`,
        },
        body: JSON.stringify({ shoeId, bet: 5 }),
      });
      if (res.status === 409) {
        // penetration reshuffle — re-open a fresh shoe and keep going.
        return dealLiveHand();
      }
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      if (data.status === 'in_progress') {
        return { shoeId, handId: data.handId as string };
      }
      // Natural settled inline — stand the next hand by dealing again.
    }
    throw new Error('could not land a non-natural hand in 30 deals (RNG)');
  }

  beforeAll(async () => {
    app = buildApp();
    const u1 = await signupAndCreateAvatar(TEST_EMAIL);
    cookie1 = u1.cookie;
    userId1 = u1.userId;
    avatarId1 = u1.avatarId;
    await dbMod.db
      .update(dbMod.avatars)
      // F1 vCLAW provenance: mirror into tag balances so the
      // avatars_vclaw_balance_sum CHECK (claw_tokens = soft+bought+earned) holds.
      // Test top-up is non-cashable SOFT.
      .set({ clawTokens: 1_000_000, softBalance: 1_000_000, boughtBalance: 0, earnedBalance: 0 })
      .where(eq(dbMod.avatars.id, avatarId1));
  });

  afterAll(async () => {
    if (!dbMod) return;
    // Reverse-FK cleanup: cove_game_events → hands → shoes → avatar → user.
    const shoeRows = await dbMod.db
      .select({ id: dbMod.blackjackShoes.id })
      .from(dbMod.blackjackShoes)
      .where(eq(dbMod.blackjackShoes.userId, userId1));
    for (const r of shoeRows) {
      await dbMod.db.delete(dbMod.coveGameEvents).where(eq(dbMod.coveGameEvents.sessionId, r.id));
      await dbMod.db.delete(dbMod.blackjackHands).where(eq(dbMod.blackjackHands.shoeId, r.id));
    }
    await dbMod.db.delete(dbMod.blackjackShoes).where(eq(dbMod.blackjackShoes.userId, userId1));
    await dbMod.db.delete(dbMod.avatars).where(eq(dbMod.avatars.userId, userId1));
    await dbMod.db.delete(dbMod.users).where(eq(dbMod.users.id, userId1));
  });

  beforeEach(() => {
    __resetBlackjackRateLimits();
  });

  // ─── 1. GET /hand/current never leaks hidden state ─────────────────────────
  describe('GET /hand/current — visible view only (no hole/undealt/seed)', () => {
    it('returns player cards + dealer UPCARD and leaks NO hidden state', async () => {
      const { shoeId, handId } = await dealLiveHand();

      // Pull the shoe's real secrets directly from the DB to assert they NEVER
      // appear in the visible response.
      const shoeRow = await dbMod.db.query.blackjackShoes.findFirst({
        where: eq(dbMod.blackjackShoes.id, shoeId),
      });
      expect(shoeRow).toBeTruthy();
      const secretSeed = shoeRow.serverSeed as string;
      expect(secretSeed).toMatch(/^[0-9a-f]{64}$/);

      const res = await app.request('/api/cove/blackjack/hand/current', {
        headers: { Cookie: cookie1 },
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;

      // It is the live hand.
      expect(data.handId).toBe(handId);
      expect(data.status).toBe('in_progress');
      expect(Array.isArray(data.playerHands)).toBe(true);
      expect(data.playerHands.length).toBeGreaterThanOrEqual(1);
      // Player has its two opening cards, all FACE-UP (no hidden flag).
      const playerCards = data.playerHands[0].cards as Array<{ hidden?: boolean }>;
      expect(playerCards.length).toBe(2);
      for (const card of playerCards) {
        expect(card.hidden).toBeFalsy();
      }
      // EXACTLY ONE dealer card is exposed (the upcard) and it is not hidden.
      expect(data.dealerUpcard).toBeTruthy();
      expect((data.dealerUpcard as { hidden?: boolean }).hidden).toBeFalsy();
      // No field named like the dealer's full hand / hole / undealt shoe / seed.
      const { keys, strings } = flattenStrings(data);
      for (const k of keys) {
        expect(k).not.toBe('serverSeed');
        expect(k).not.toBe('server_seed');
        expect(k).not.toBe('hole');
        expect(k).not.toBe('holeCard');
        expect(k).not.toBe('remaining');
        expect(k).not.toBe('remainingShoe');
      }
      // The actual secret seed value never appears anywhere in the payload.
      expect(strings).not.toContain(secretSeed);

      // Cleanup: stand the hand so the shoe can be reused by later tests.
      await app.request('/api/cove/blackjack/action', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie1,
          'Idempotency-Key': `cleanup-${Date.now()}`,
        },
        body: JSON.stringify({ handId, action: 'stand' }),
      });
    });
  });

  // ─── 2. Stale-DEAL 409 ─────────────────────────────────────────────────────
  describe('POST /hand/deal — stale_agent_deal epoch guard', () => {
    it('rejects a deal at an old handCounter epoch, accepts at the current one', async () => {
      const openRes = await app.request('/api/cove/blackjack/session/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
        body: JSON.stringify({ currency: 'clawtoken' }),
      });
      expect(openRes.status).toBe(200);
      const shoeId = ((await openRes.json()) as any).shoe.id as string;

      // Deal hand 0 (handCounter 0 → 1). It may natural-settle inline; either way
      // the counter advances to 1 and there is no live hand left if it settled.
      const deal0 = await app.request('/api/cove/blackjack/hand/deal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie1,
          'Idempotency-Key': `epoch-d0-${Date.now()}`,
        },
        body: JSON.stringify({ shoeId, bet: 5 }),
      });
      expect(deal0.status).toBe(200);
      const d0 = (await deal0.json()) as any;
      // If it stayed in progress, stand it so the shoe has no live hand (the
      // stale-deal guard fires BEFORE the in-progress guard, but we want to prove
      // the epoch check, not the in-progress check).
      if (d0.status === 'in_progress') {
        const stood = await app.request('/api/cove/blackjack/action', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie1,
            'Idempotency-Key': `epoch-stand-${Date.now()}`,
          },
          body: JSON.stringify({ handId: d0.handId, action: 'stand' }),
        });
        expect(stood.status).toBe(200);
      }

      // handCounter is now 1. A deal carrying the STALE epoch 0 must 409.
      const stale = await app.request('/api/cove/blackjack/hand/deal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie1,
          'Idempotency-Key': `epoch-stale-${Date.now()}`,
        },
        body: JSON.stringify({ shoeId, bet: 5, expectedHandsPlayed: 0 }),
      });
      expect(stale.status).toBe(409);
      const staleBody = (await stale.json()) as any;
      expect(String(staleBody.message)).toMatch(/stale_agent_deal/);

      // A deal at the CURRENT epoch (1) succeeds.
      const fresh = await app.request('/api/cove/blackjack/hand/deal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie1,
          'Idempotency-Key': `epoch-fresh-${Date.now()}`,
        },
        body: JSON.stringify({ shoeId, bet: 5, expectedHandsPlayed: 1 }),
      });
      expect(fresh.status).toBe(200);
      const freshBody = (await fresh.json()) as any;
      // Clean up a live hand so the shoe is reusable.
      if (freshBody.status === 'in_progress') {
        await app.request('/api/cove/blackjack/action', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie1,
            'Idempotency-Key': `epoch-cleanup-${Date.now()}`,
          },
          body: JSON.stringify({ handId: freshBody.handId, action: 'stand' }),
        });
      }
    });
  });

  // ─── 3. Stale-ACTION 409 + insure-parity fix ───────────────────────────────
  describe('POST /action — stale_agent_decision version guard', () => {
    it('rejects an action at a stale handVersion, accepts at the live one', async () => {
      const { handId } = await dealLiveHand();

      // The fresh hand has decision version 0. A mismatched expectedHandVersion
      // must 409 (server is the authority, computed under the hand lock).
      const stale = await app.request('/api/cove/blackjack/action', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie1,
          'Idempotency-Key': `act-stale-${Date.now()}`,
        },
        body: JSON.stringify({ handId, action: 'hit', expectedHandVersion: 99 }),
      });
      expect(stale.status).toBe(409);
      const staleBody = (await stale.json()) as any;
      expect(String(staleBody.message)).toMatch(/stale_agent_decision/);

      // The SAME action at the live version (0) is accepted.
      const live = await app.request('/api/cove/blackjack/action', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie1,
          'Idempotency-Key': `act-live-${Date.now()}`,
        },
        body: JSON.stringify({ handId, action: 'stand', expectedHandVersion: 0 }),
      });
      expect(live.status).toBe(200);
    });

    it('insure honors expectedHandVersion (parity fix) and replays a settled hand', async () => {
      // (a) A stale insure version is rejected exactly like the other actions.
      const live = await dealLiveHand();
      const staleIns = await app.request('/api/cove/blackjack/action', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie1,
          'Idempotency-Key': `ins-stale-${Date.now()}`,
        },
        body: JSON.stringify({ handId: live.handId, action: 'insure', expectedHandVersion: 99 }),
      });
      expect(staleIns.status).toBe(409);
      const staleInsBody = (await staleIns.json()) as any;
      expect(String(staleInsBody.message)).toMatch(/stale_agent_decision/);
      // Settle the hand so the next part can target an ALREADY-settled hand.
      const stood = await app.request('/api/cove/blackjack/action', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie1,
          'Idempotency-Key': `ins-stand-${Date.now()}`,
        },
        body: JSON.stringify({ handId: live.handId, action: 'stand' }),
      });
      expect(stood.status).toBe(200);

      // (b) An insure against an ALREADY-SETTLED hand replays the settled outcome
      // (status:'settled'), never a phantom { tookInsurance } ack. This is the
      // exact mishandling the client fix guards against.
      const replay = await app.request('/api/cove/blackjack/action', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie1,
          'Idempotency-Key': `ins-replay-${Date.now()}`,
        },
        body: JSON.stringify({ handId: live.handId, action: 'insure' }),
      });
      expect(replay.status).toBe(200);
      const replayBody = (await replay.json()) as any;
      expect(replayBody.status).toBe('settled');
      expect(replayBody.tookInsurance).toBeUndefined();
      expect(replayBody.outcome).toBeTruthy();
    });
  });

  // ─── 4. settle hand_shoe_mismatch (money-lens BLOCKING #1) ──────────────────
  describe('settleHand — binds the hand to the locked shoe (hand_shoe_mismatch)', () => {
    it('a caller-owned shoeId + a foreign handId resolves to 409, never settles it', async () => {
      // Shoe A — caller-owned, OPEN, no live hand.
      const openA = await app.request('/api/cove/blackjack/session/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
        body: JSON.stringify({ currency: 'clawtoken' }),
      });
      expect(openA.status).toBe(200);
      const shoeAId = ((await openA.json()) as any).shoe.id as string;

      // Shoe B — a SEPARATE shoe carrying an in_progress hand. Insert directly so
      // it is genuinely a different shoe id than A (the route keys an open shoe on
      // userId, so we mark B 'closed' to avoid the one-open-shoe-per-user unique
      // index, then insert its hand). The settle guard keys on (handId, shoeId),
      // not on shoe status, so 'closed' does not affect what we are testing.
      const { serverSeed, serverSeedHash } = createServerSeed();
      const [shoeB] = await dbMod.db
        .insert(dbMod.blackjackShoes)
        .values({
          userId: userId1,
          guestFpHash: null,
          currency: 'clawtoken',
          serverSeed,
          serverSeedHash,
          clientSeed: 'cafebabecafebabe',
          startingBalance: '0',
          status: 'closed',
          engineVersion: 'bj-v1',
        })
        .returning();
      const [handOnB] = await dbMod.db
        .insert(dbMod.blackjackHands)
        .values({
          shoeId: shoeB.id,
          handIndex: 0,
          cursorBefore: 0,
          dealtBefore: 0,
          bet: '5',
          stakedAmount: '5',
          script: { hands: [[]], didSplit: false, tookInsurance: false },
          tookInsurance: false,
          status: 'in_progress',
        })
        .returning();

      // Caller owns BOTH shoes, but passes shoeId=A with handId=<hand on B>. The
      // settle fn loads the hand by (id, shoeId)=(handOnB, shoeA) → no row → 409
      // hand_shoe_mismatch. Without the BLOCKING #1 fix (bare handId load) this
      // would settle handOnB's outcome against shoe A.
      const subject = {
        kind: 'user' as const,
        userId: userId1,
        avatarId: null,
        agentId: null,
        sessionId: null,
        guestFpHash: null,
      };
      const mockCtx = {
        get: (_k: string) => '',
        req: { header: (_n: string) => undefined },
      } as any;

      let status = 0;
      let message = '';
      try {
        await __settleHandForTest(mockCtx, shoeAId, handOnB.id, subject, undefined);
      } catch (err: any) {
        status = err?.status ?? 0;
        message = String(err?.message ?? err);
      }
      expect(status).toBe(409);
      expect(message).toMatch(/hand_shoe_mismatch/);

      // The foreign hand is UNTOUCHED — still in_progress, never settled to A.
      const afterB = await dbMod.db.query.blackjackHands.findFirst({
        where: eq(dbMod.blackjackHands.id, handOnB.id),
      });
      expect(afterB.status).toBe('in_progress');
      expect(afterB.payout).toBeNull();

      void shoeAId;
    });
  });
});
