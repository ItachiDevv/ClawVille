/**
 * P3 Slice 4 — `land.service.sold` SCORING (the 4th land event) in the
 * contribution leaderboard CTE (`buildAgentSnapshot` in `leaderboard.ts`).
 *
 * The EMISSION side (single seller-keyed event per fresh settled sale, payload
 * shape, idempotent replay) is covered by `land-services.test.ts`. THIS file
 * covers the read/score side that the leaderboard-progression domain owns: the
 * event, once emitted, is scored at weight 40 / cap 50 with the TWO anti-farm
 * carve-outs that are unique to this cross-subject event —
 *
 *   (a) PAID-ONLY   — a `priceCt=0` sale is rank-inert (still logged for audit).
 *   (b) DISTINCT-BUYER — the daily count is `COUNT(DISTINCT buyerAvatarId)`, not
 *       `COUNT(*)`, so a single colluding buyer credits the seller at most once
 *       per day (a 2-party wash collapses from 50/day to 1/day); reaching the
 *       50/day cap requires 50 DISTINCT funded buyer avatars.
 *
 * and that the two disjoint subject legs (`agent_daily` = Trainers,
 * `avatar_daily` = Players) score it IDENTICALLY, and that the house-agent
 * carve-out (`NOT EXISTS` against `openclaw_bots.is_house`) still suppresses it.
 *
 * Two tiers, matching the harness `land-services.test.ts` / `cove-*.test.ts`
 * already use:
 *   1. CONSTANT-DRIFT guard — pure, always runs: the weight/cap the CTE reads
 *      from `@clawville/shared` are exactly 40 / 50. If someone retunes the
 *      shared constant, the score math here moves with it (single-sourced), and
 *      this pins the value the docs + rubric promise.
 *   2. DB-BACKED SCORING — `describeIfDb()`-gated (skips without DATABASE_URL,
 *      exactly like the sibling money-path suites). Inserts controlled `events`
 *      rows DIRECTLY (bypassing the full buy HTTP flow, which the sibling file
 *      already exercises) and asserts `buildAgentSnapshot` output. `buyerAvatarId`
 *      is a payload string (NOT an FK), so distinct wash/cap buyers are cheap
 *      random UUIDs; only the SELLER `avatar_id` needs a real avatars row.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as dbMod from '@clawville/database';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { authRoutes } from '../auth';
import { avatarRoutes } from '../avatars';
import { buildAgentSnapshot } from '../leaderboard';
import {
  LAND_EVENT_TYPES,
  LAND_EVENT_WEIGHTS,
  LAND_EVENT_DAILY_CAPS,
} from '@clawville/shared';
import type { AppContext } from '../../types';

const HAS_DB = !!process.env.DATABASE_URL;
// Setup creates avatars through the real routes, which mint custodial wallets
// via the Cloudflare worker — without real worker creds (or with a sibling
// suite's 'example.invalid' placeholder) the hooks fail, so gate like HAS_DB.
const HAS_WALLET_INFRA =
  !!process.env.CLOUDFLARE_WORKER_URL &&
  !process.env.CLOUDFLARE_WORKER_URL.includes('example.invalid') &&
  !!process.env.CLOUDFLARE_WORKER_BEARER;
const describeIfDb = HAS_DB && HAS_WALLET_INFRA ? describe : describe.skip;

const SERVICE_SOLD_WEIGHT = 40;
const SERVICE_SOLD_CAP = 50;

// ═════════════════════════════════════════════════════════════════════════
// 1. CONSTANT-DRIFT guard (pure, always runs) — the CTE scores this event by
//    reading these shared constants (mirrored into LAND_W/LAND_C in
//    leaderboard.ts), so pinning them here pins the score math + the docs.
// ═════════════════════════════════════════════════════════════════════════

describe('land.service.sold — registered weight/cap (drift guard)', () => {
  it('is weight 40 in the shared registry', () => {
    expect(LAND_EVENT_WEIGHTS[LAND_EVENT_TYPES.SERVICE_SOLD]).toBe(SERVICE_SOLD_WEIGHT);
  });
  it('is cap 50/day in the shared registry', () => {
    expect(LAND_EVENT_DAILY_CAPS[LAND_EVENT_TYPES.SERVICE_SOLD]).toBe(SERVICE_SOLD_CAP);
  });
  it('has the canonical event-type literal the CTE FILTERs on', () => {
    expect(LAND_EVENT_TYPES.SERVICE_SOLD).toBe('land.service.sold');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. DB-backed scoring — describeIfDb()-gated
// ═════════════════════════════════════════════════════════════════════════

function buildApp() {
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.set('fpHash', '');
    c.set('ipPrefixHash', '');
    await next();
  });
  app.route('/api/auth', authRoutes);
  app.route('/api/avatars', avatarRoutes);
  return app;
}

describeIfDb('land.service.sold — scoring CTE (requires DATABASE_URL)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // dbMod is the top-level ESM namespace import (bun test cannot resolve the
  // workspace package via CJS require(); ESM import works — same as every
  // other api test). describeIfDb still gates execution on DATABASE_URL.

  const TEST_TAG = `lbsvc${Date.now()}`;
  const PASSWORD = 'lbsvcpassword123';

  let app: ReturnType<typeof buildApp>;

  // Agent-leg (Trainer) seller: events carry a non-null text agent_id.
  const trainerAgentId = `test-trainer-${TEST_TAG}`;
  let trainerAvatarId = ''; // real avatars row (FK for events.avatar_id) + its user
  let trainerUserId = '';

  // Avatar-leg (Player) seller: events carry agent_id NULL, avatar_id set.
  let playerAvatarId = '';
  let playerUserId = '';

  // House-agent seller (agent-leg): excluded via NOT EXISTS(is_house).
  const houseAgentId = `test-house-${TEST_TAG}`;
  let houseAvatarId = '';
  let houseUserId = '';

  // Track the events we insert so afterAll can clean up precisely.
  const insertedEventIds: bigint[] = [];
  let insertedHouseBotId = '';

  async function signupAndCreateAvatar(email: string): Promise<{ userId: string; avatarId: string }> {
    // P2 (2026-07-04): signup AUTO-PROVISIONS the avatar (fail-soft, rows-only)
    // and returns it in the response — a follow-up POST /api/avatars trips the
    // one-avatar-per-user 400. Use the provisioned avatar; only fall back to an
    // explicit create if the fail-soft provisioning didn't return one.
    const signup = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, name: 'LB Svc Tester' }),
    });
    expect(signup.status).toBe(200);
    const signupData = (await signup.json()) as { avatar?: { id: string } };
    let avatarId = signupData.avatar?.id ?? '';
    if (!avatarId) {
      const cookie = (signup.headers.get('set-cookie') ?? '').split(';')[0]!;
      const avatarRes = await app.request('/api/avatars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: `LB${Date.now()}${Math.floor(Math.random() * 10000)}`,
          species: 'cat',
          color: 'green',
          gender: 'male',
          personality: { habitat: 'forest', hobby: 'exploring', greeting: 'wave-hello' },
        }),
      });
      expect(avatarRes.status).toBe(200);
      const avatarData = (await avatarRes.json()) as { avatar: { id: string } };
      avatarId = avatarData.avatar.id;
    }
    const userRow = await dbMod.db.query.users.findFirst({ where: eq(dbMod.users.email, email) });
    if (!userRow) throw new Error(`test fixture: no users row for ${email}`);
    return { userId: userRow.id as string, avatarId };
  }

  /**
   * Insert a single `land.service.sold` event row directly. Mirrors the shape
   * `land.ts` emits after a settled sale: keyed to the SELLER (agentId/avatarId),
   * payload carries `priceCt` + `buyerAvatarId` (the two fields the CTE reads).
   * `agentId=null` → avatar leg (Player); `agentId=set` → agent leg (Trainer).
   */
  async function emitSale(opts: {
    sellerAvatarId: string;
    sellerAgentId: string | null;
    sellerUserId: string | null;
    buyerAvatarId: string;
    priceCt: number;
  }): Promise<void> {
    const [row] = await dbMod.db
      .insert(dbMod.events)
      .values({
        eventType: LAND_EVENT_TYPES.SERVICE_SOLD,
        userId: opts.sellerUserId,
        agentId: opts.sellerAgentId,
        avatarId: opts.sellerAvatarId,
        sessionId: null,
        payload: {
          listingId: randomUUID(),
          structureId: randomUUID(),
          priceCt: opts.priceCt,
          buyerAvatarId: opts.buyerAvatarId,
        },
        // fp/ip are the BUYER's on the real path; irrelevant to the LEAST cap
        // (which never keys on them) — left null here.
        fpHash: null,
        ipPrefixHash: null,
      })
      .returning({ id: dbMod.events.id });
    insertedEventIds.push(row.id as bigint);
  }

  /** Find the board row for an agent-leg (Trainer) subject. */
  async function agentRow(agentId: string) {
    const snap = await buildAgentSnapshot('all', 1_000_000);
    return snap.agents.find((e) => e.subjectType === 'agent' && e.agentId === agentId);
  }

  /** Find the board row for an avatar-leg (Player) subject. */
  async function avatarRow(avatarId: string) {
    const snap = await buildAgentSnapshot('all', 1_000_000);
    return snap.agents.find((e) => e.subjectType === 'avatar' && e.avatarId === avatarId);
  }

  beforeAll(async () => {
    app = buildApp();
    const trainer = await signupAndCreateAvatar(`${TEST_TAG}-trainer@clawville-test.com`);
    trainerUserId = trainer.userId;
    trainerAvatarId = trainer.avatarId;

    const player = await signupAndCreateAvatar(`${TEST_TAG}-player@clawville-test.com`);
    playerUserId = player.userId;
    playerAvatarId = player.avatarId;

    const house = await signupAndCreateAvatar(`${TEST_TAG}-house@clawville-test.com`);
    houseUserId = house.userId;
    houseAvatarId = house.avatarId;

    // House agent bound to the house user — is_house=true. Used by BOTH house
    // legs: agent-leg NOT EXISTS(agent_id) + avatar-leg NOT EXISTS(user_id join).
    const [bot] = await dbMod.db
      .insert(dbMod.agentBots)
      .values({
        agentId: houseAgentId,
        mode: 'autonomous',
        userId: houseUserId,
        isHouse: true,
      })
      .returning({ id: dbMod.agentBots.id });
    insertedHouseBotId = bot.id as string;
  });

  afterAll(async () => {
    if (!dbMod) return;
    if (insertedEventIds.length > 0) {
      await dbMod.db.delete(dbMod.events).where(inArray(dbMod.events.id, insertedEventIds));
    }
    if (insertedHouseBotId) {
      await dbMod.db.delete(dbMod.agentBots).where(eq(dbMod.agentBots.id, insertedHouseBotId));
    }
    for (const uid of [trainerUserId, playerUserId, houseUserId].filter(Boolean)) {
      await dbMod.db.delete(dbMod.avatars).where(eq(dbMod.avatars.userId, uid));
      await dbMod.db.delete(dbMod.users).where(eq(dbMod.users.id, uid));
    }
  });

  it('scores a single paid sale at weight 40 on the agent (Trainer) leg', async () => {
    await emitSale({
      sellerAvatarId: trainerAvatarId,
      sellerAgentId: trainerAgentId,
      sellerUserId: trainerUserId,
      buyerAvatarId: randomUUID(),
      priceCt: 10,
    });
    const row = await agentRow(trainerAgentId);
    expect(row).toBeDefined();
    expect(row!.breakdown.land_services_sold).toBe(1);
    // Fresh subject — no other scored events — so score is exactly 1 × 40.
    expect(row!.score).toBe(SERVICE_SOLD_WEIGHT);
  });

  it('PAID-ONLY: a priceCt=0 sale is rank-inert (adds no count, no score)', async () => {
    const buyerA = randomUUID();
    const buyerB = randomUUID();
    // Fresh Player subject: one FREE sale + one PAID sale from distinct buyers.
    // Only the paid one should count → land_services_sold=1, score=40.
    await emitSale({ sellerAvatarId: playerAvatarId, sellerAgentId: null, sellerUserId: playerUserId, buyerAvatarId: buyerA, priceCt: 0 });
    await emitSale({ sellerAvatarId: playerAvatarId, sellerAgentId: null, sellerUserId: playerUserId, buyerAvatarId: buyerB, priceCt: 25 });
    const row = await avatarRow(playerAvatarId);
    expect(row).toBeDefined();
    expect(row!.breakdown.land_services_sold).toBe(1); // the free sale excluded
    expect(row!.score).toBe(SERVICE_SOLD_WEIGHT);
  });

  it('DISTINCT-BUYER: 50 paid sales from ONE buyer collapse to a single credit (wash defense)', async () => {
    // A fresh Trainer whose ONLY activity is being hammered by one wash buyer.
    const washAgentId = `test-wash-${TEST_TAG}`;
    const oneBuyer = randomUUID();
    for (let i = 0; i < 50; i++) {
      await emitSale({
        sellerAvatarId: trainerAvatarId, // reuse a real avatars FK; agent leg keys on agentId
        sellerAgentId: washAgentId,
        sellerUserId: trainerUserId,
        buyerAvatarId: oneBuyer, // SAME buyer 50×
        priceCt: 1,
      });
    }
    const row = await agentRow(washAgentId);
    expect(row).toBeDefined();
    // COUNT(DISTINCT buyerAvatarId) = 1, not 50 → score 40, not 2000.
    expect(row!.breakdown.land_services_sold).toBe(1);
    expect(row!.score).toBe(SERVICE_SOLD_WEIGHT);
  });

  it('CAP: distinct buyers are capped at 50/day (LEAST) even with 60 distinct buyers', async () => {
    const capAgentId = `test-cap-${TEST_TAG}`;
    for (let i = 0; i < 60; i++) {
      await emitSale({
        sellerAvatarId: trainerAvatarId,
        sellerAgentId: capAgentId,
        sellerUserId: trainerUserId,
        buyerAvatarId: randomUUID(), // 60 DISTINCT buyers
        priceCt: 5,
      });
    }
    const row = await agentRow(capAgentId);
    expect(row).toBeDefined();
    // LEAST(60, 50) = 50 → score 50 × 40 = 2000.
    expect(row!.breakdown.land_services_sold).toBe(SERVICE_SOLD_CAP);
    expect(row!.score).toBe(SERVICE_SOLD_CAP * SERVICE_SOLD_WEIGHT);
  });

  it('BOTH AXES: a Player (avatar-leg) seller scores identically to a Trainer', async () => {
    // Fresh Player, 3 distinct paying buyers → 3 × 40 = 120.
    const axisPlayer = await signupAndCreateAvatar(`${TEST_TAG}-axis@clawville-test.com`);
    for (let i = 0; i < 3; i++) {
      await emitSale({
        sellerAvatarId: axisPlayer.avatarId,
        sellerAgentId: null, // avatar leg
        sellerUserId: axisPlayer.userId,
        buyerAvatarId: randomUUID(),
        priceCt: 7,
      });
    }
    const row = await avatarRow(axisPlayer.avatarId);
    expect(row).toBeDefined();
    expect(row!.breakdown.land_services_sold).toBe(3);
    expect(row!.score).toBe(3 * SERVICE_SOLD_WEIGHT);
    // Cleanup this scenario's user (not tracked in beforeAll's fixed list).
    await dbMod.db.delete(dbMod.events).where(eq(dbMod.events.avatarId, axisPlayer.avatarId));
    await dbMod.db.delete(dbMod.avatars).where(eq(dbMod.avatars.userId, axisPlayer.userId));
    await dbMod.db.delete(dbMod.users).where(eq(dbMod.users.id, axisPlayer.userId));
  });

  it('HOUSE-EXCLUSION: a house agent (is_house) never appears on the board despite paid sales', async () => {
    // Agent leg — NOT EXISTS(openclaw_bots ob WHERE ob.agent_id = events.agent_id AND ob.is_house)
    for (let i = 0; i < 5; i++) {
      await emitSale({
        sellerAvatarId: houseAvatarId,
        sellerAgentId: houseAgentId, // bound to the is_house bot
        sellerUserId: houseUserId,
        buyerAvatarId: randomUUID(),
        priceCt: 100,
      });
    }
    const row = await agentRow(houseAgentId);
    expect(row).toBeUndefined(); // suppressed by the durable is_house carve-out
  });

  it('HOUSE-EXCLUSION (avatar leg): a house user\'s avatar is suppressed via the user_id join', async () => {
    // Avatar leg — NOT EXISTS(avatars a2 JOIN openclaw_bots ob ON ob.user_id = a2.user_id AND ob.is_house)
    for (let i = 0; i < 4; i++) {
      await emitSale({
        sellerAvatarId: houseAvatarId,
        sellerAgentId: null, // avatar leg
        sellerUserId: houseUserId,
        buyerAvatarId: randomUUID(),
        priceCt: 50,
      });
    }
    const row = await avatarRow(houseAvatarId);
    expect(row).toBeUndefined(); // suppressed because houseUser owns an is_house bot
  });
});
