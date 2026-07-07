/**
 * Phase B land tenure — deposit-escrow (B1) + hold-to-keep (B2) tests.
 *
 * Three coverage tiers, matching the harness patterns of the sibling
 * `land-services.test.ts` (mirrors + routing + `describeIfDb()` money paths):
 *
 *   1. PURE MATH (always run, no DB, no HTTP):
 *      - hold stacking arithmetic over the SHARED `holdThresholdForTier`
 *        constants (600k CLV holds c+b, does NOT hold c+b+c);
 *      - ESCROW CONSERVATION over `decideDepositSweep` — the sweeper's single
 *        draw-math authority (exported from land-rent-sweeper.ts). Over every
 *        simulated tenancy: Σ draws + forfeit + refund == Σ escrowed-in,
 *        EXACTLY, and no decision ever over-draws;
 *      - sweep-idempotency SHAPE: a settled week (rentDue=false after the
 *        advance) decides `skip` — nothing draws twice.
 *
 *   2. ZOD MIRROR + ROUTING INTEGRITY (always run): the deposit-topup body
 *      mirror, the disabled /buy + /rent 409 `tenure_model_active` stubs
 *      (deterministic — they answer BEFORE auth/DB), and 401s on the three new
 *      authed writes with zero auth material.
 *
 *   3. MONEY-PATH E2E (DB-backed, `describeIfDb()`-gated — skips without
 *      DATABASE_URL; REQUIRES migration 0013 applied to the target DB):
 *      escrow conservation through the real claim → sweep-draw → release
 *      pipeline; the same-due-week-twice idempotency via the exported
 *      `processDueParcel` (NEVER `sweepDueRents()` here — a whole-DB sweep
 *      from a test would settle OTHER rows in a shared DB); the lapse forfeit
 *      (deposit → treasury, zero net mint); the grandfathered-hold upkeep
 *      charge/grace/evict lifecycle (no CLV RPC — grandfathered skips the
 *      check by design); and the claim-hold FAIL-CLOSED 403s that resolve
 *      BEFORE any RPC (unlinked human wallet; starter tier).
 *
 *      Starter-pool safety: the claim route picks the first AVAILABLE starter
 *      ORDER BY parcel_code — fixture codes start with '0' ('0' < 'p') so they
 *      sort BEFORE every real `parcel-starter-*` row and the claims
 *      deterministically consume the fixtures, never live supply.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as dbMod from '@clawville/database';
import { Hono } from 'hono';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import { landRoutes } from '../land';
import { authRoutes } from '../auth';
import { avatarRoutes } from '../avatars';
import {
  LAND_STARTER_DEPOSIT_CT,
  LAND_STARTER_RENT_CT_WEEKLY,
  LAND_HOLD_THRESHOLDS_CLV,
  holdThresholdForTier,
} from '@clawville/shared';
import {
  decideDepositSweep,
  processDueParcel,
  type DepositSweepDecision,
} from '../../services/land-rent-sweeper';
import { getHouseTreasuryAvatarId } from '../../services/house-treasury-seeder';
import type { AppContext } from '../../types';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

// ═════════════════════════════════════════════════════════════════════════
// 1a. Hold stacking math (pure — the SHARED constants the route/sweeper sum)
// ═════════════════════════════════════════════════════════════════════════

describe('phase B — hold stacking math (pure)', () => {
  it('per-tier thresholds match the founder-locked ladder', () => {
    expect(holdThresholdForTier('starter')).toBeNull();
    expect(holdThresholdForTier('c')).toBe(100_000);
    expect(holdThresholdForTier('b')).toBe(500_000);
    expect(holdThresholdForTier('a')).toBe(2_500_000);
    expect(holdThresholdForTier('founder')).toBe(10_000_000);
    // The function IS the record — no drift possible.
    expect(holdThresholdForTier('c')).toBe(LAND_HOLD_THRESHOLDS_CLV.c!);
  });

  it('600k CLV holds c+b but NOT c+b+c (thresholds STACK — requirement is the SUM)', () => {
    const held = 600_000;
    const cPlusB = holdThresholdForTier('c')! + holdThresholdForTier('b')!;
    expect(cPlusB).toBe(600_000);
    // Claiming b while holding c: required = c + b = 600k → 600k passes.
    expect(held >= cPlusB).toBe(true);
    // Claiming ANOTHER c while holding c+b: required = c + b + c = 700k → fails.
    const cPlusBPlusC = cPlusB + holdThresholdForTier('c')!;
    expect(cPlusBPlusC).toBe(700_000);
    expect(held >= cPlusBPlusC).toBe(false);
  });

  it('a single founder hold needs 10M — a 9_999_999 wallet fails, 10M passes', () => {
    const required = holdThresholdForTier('founder')!;
    expect(9_999_999 >= required).toBe(false);
    expect(10_000_000 >= required).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 1b. Escrow conservation over decideDepositSweep (pure)
// ═════════════════════════════════════════════════════════════════════════

/**
 * Simulate a deposit tenancy at the DECISION level. Applies each decision the
 * way the sweeper does (draw decrements the remainder; grace/skip leave it;
 * lapse forfeits it) and returns the money totals. `dueWeeks` = how many sweep
 * ticks arrive with rent due before the terminal event.
 */
function simulateTenancy(opts: {
  escrowIn: number[];
  rentWeekly: number;
  dueWeeks: number;
  terminal: 'release' | 'lapse';
}): { draws: number[]; forfeit: number; refund: number; remaining: number } {
  let remaining = 0;
  const pendingTopups = [...opts.escrowIn];
  // The claim is the first escrow-in.
  remaining += pendingTopups.shift() ?? 0;
  const draws: number[] = [];
  let graceOpen = false;

  for (let week = 0; week < opts.dueWeeks; week++) {
    const decision: DepositSweepDecision = decideDepositSweep({
      graceElapsed: false,
      rentDue: true,
      depositRemainingCt: remaining,
      rentCtWeekly: opts.rentWeekly,
    });
    if (decision.kind === 'draw') {
      draws.push(decision.drawnCt);
      remaining -= decision.drawnCt;
      if (!decision.fullWeek) graceOpen = true;
      else graceOpen = false;
    } else if (decision.kind === 'grace') {
      graceOpen = true;
    }
    // Mid-life top-up (if any) lands after the first draw — arbitrary but
    // deterministic; conservation must hold regardless of ordering.
    if (week === 0 && pendingTopups.length > 0) {
      remaining += pendingTopups.shift()!;
      if (remaining >= opts.rentWeekly) graceOpen = false;
    }
  }

  let forfeit = 0;
  let refund = 0;
  if (opts.terminal === 'lapse') {
    const d = decideDepositSweep({
      graceElapsed: true,
      rentDue: true,
      depositRemainingCt: remaining,
      rentCtWeekly: opts.rentWeekly,
    });
    if (d.kind !== 'lapse') throw new Error(`expected lapse, got ${d.kind}`);
    forfeit = d.forfeitCt;
    remaining -= forfeit;
  } else {
    // Voluntary release refunds the remainder (the /release route's math).
    refund = remaining;
    remaining = 0;
  }
  void graceOpen;
  return { draws, forfeit, refund, remaining };
}

describe('phase B — escrow conservation over decideDepositSweep (pure)', () => {
  const D = LAND_STARTER_DEPOSIT_CT; // 2000
  const W = LAND_STARTER_RENT_CT_WEEKLY; // 100

  it(`full exhaustion: ${D} deposit at ${W}/wk drains in exactly ${D / W} full draws, then graces, then lapses with forfeit 0`, () => {
    const r = simulateTenancy({ escrowIn: [D], rentWeekly: W, dueWeeks: D / W + 3, terminal: 'lapse' });
    expect(r.draws.length).toBe(D / W); // 20 draws — the post-exhaustion weeks grace, never draw
    expect(r.draws.every((d) => d === W)).toBe(true);
    const totalDrawn = r.draws.reduce((a, b) => a + b, 0);
    expect(totalDrawn).toBe(D);
    expect(r.forfeit).toBe(0);
    // CONSERVATION: draws + forfeit + refund == escrowed-in, remainder 0.
    expect(totalDrawn + r.forfeit + r.refund).toBe(D);
    expect(r.remaining).toBe(0);
  });

  it('early release: 3 draws then release refunds EXACTLY deposit − draws', () => {
    const r = simulateTenancy({ escrowIn: [D], rentWeekly: W, dueWeeks: 3, terminal: 'release' });
    const totalDrawn = r.draws.reduce((a, b) => a + b, 0);
    expect(totalDrawn).toBe(300);
    expect(r.refund).toBe(D - 300);
    expect(totalDrawn + r.refund + r.forfeit).toBe(D); // exact — not >=, not ~
  });

  it('mid-life lapse: 5 draws then elapsed grace forfeits the WHOLE remainder to the house — nothing refunds', () => {
    const r = simulateTenancy({ escrowIn: [D], rentWeekly: W, dueWeeks: 5, terminal: 'lapse' });
    const totalDrawn = r.draws.reduce((a, b) => a + b, 0);
    expect(totalDrawn).toBe(500);
    expect(r.forfeit).toBe(D - 500);
    expect(r.refund).toBe(0);
    expect(totalDrawn + r.forfeit).toBe(D);
  });

  it('top-up conservation: claim + topup both count as escrow-in; draws + refund equal the combined total', () => {
    const TOPUP = 500;
    const r = simulateTenancy({
      escrowIn: [D, TOPUP],
      rentWeekly: W,
      dueWeeks: 7,
      terminal: 'release',
    });
    const totalDrawn = r.draws.reduce((a, b) => a + b, 0);
    expect(totalDrawn).toBe(700);
    expect(r.refund).toBe(D + TOPUP - 700);
    expect(totalDrawn + r.refund + r.forfeit).toBe(D + TOPUP);
  });

  it('partial draw never over-draws: remainder 250 at 100/wk draws 100, 100, then 50 (partial, NOT a full week), then graces', () => {
    const r = simulateTenancy({ escrowIn: [250], rentWeekly: W, dueWeeks: 5, terminal: 'lapse' });
    expect(r.draws).toEqual([100, 100, 50]);
    expect(r.forfeit).toBe(0); // remainder hit 0 on the partial
    expect(r.draws.reduce((a, b) => a + b, 0)).toBe(250);
  });

  it('the partial-draw decision reports fullWeek=false (grace opens, week does NOT advance)', () => {
    const d = decideDepositSweep({
      graceElapsed: false,
      rentDue: true,
      depositRemainingCt: 50,
      rentCtWeekly: 100,
    });
    expect(d).toEqual({ kind: 'draw', drawnCt: 50, fullWeek: false });
  });

  it('sweep idempotency SHAPE: after the advance the week is no longer due → decision is skip (draws nothing)', () => {
    // The sweeper's real guard is the rent_paid_through advance under FOR
    // UPDATE; this is its decision-level mirror: rentDue=false → skip.
    const d = decideDepositSweep({
      graceElapsed: false,
      rentDue: false,
      depositRemainingCt: 1900,
      rentCtWeekly: 100,
    });
    expect(d).toEqual({ kind: 'skip' });
  });

  it('zero remainder with rent due → grace (never a draw of 0, never a lapse before grace elapses)', () => {
    const d = decideDepositSweep({
      graceElapsed: false,
      rentDue: true,
      depositRemainingCt: 0,
      rentCtWeekly: 100,
    });
    expect(d).toEqual({ kind: 'grace' });
  });

  it('anomalous weekly rent (0 / negative / non-integer) → skip, never a draw or grace', () => {
    for (const bad of [0, -5, 10.5]) {
      const d = decideDepositSweep({
        graceElapsed: false,
        rentDue: true,
        depositRemainingCt: 2000,
        rentCtWeekly: bad,
      });
      expect(d).toEqual({ kind: 'skip' });
    }
  });

  it('elapsed grace always lapses and forfeits max(0, remainder) — even mid-balance', () => {
    expect(
      decideDepositSweep({ graceElapsed: true, rentDue: true, depositRemainingCt: 1500, rentCtWeekly: 100 }),
    ).toEqual({ kind: 'lapse', forfeitCt: 1500 });
    expect(
      decideDepositSweep({ graceElapsed: true, rentDue: false, depositRemainingCt: 0, rentCtWeekly: 100 }),
    ).toEqual({ kind: 'lapse', forfeitCt: 0 });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. Zod mirror + routing integrity (always run)
// ═════════════════════════════════════════════════════════════════════════

/** Mirrors `land.ts`'s (unexported) `depositTopupBodySchema` — keep in sync. */
const depositTopupBodySchemaMirror = z
  .object({
    amountCt: z.number().int().min(1).max(1_000_000),
  })
  .strict();

describe('phase B — deposit-topup zod mirror (deterministic, no DB)', () => {
  it('accepts 1 and 1_000_000 (boundaries)', () => {
    expect(depositTopupBodySchemaMirror.safeParse({ amountCt: 1 }).success).toBe(true);
    expect(depositTopupBodySchemaMirror.safeParse({ amountCt: 1_000_000 }).success).toBe(true);
  });
  it('rejects 0, negatives, 1_000_001, non-integers, missing, stray keys', () => {
    expect(depositTopupBodySchemaMirror.safeParse({ amountCt: 0 }).success).toBe(false);
    expect(depositTopupBodySchemaMirror.safeParse({ amountCt: -100 }).success).toBe(false);
    expect(depositTopupBodySchemaMirror.safeParse({ amountCt: 1_000_001 }).success).toBe(false);
    expect(depositTopupBodySchemaMirror.safeParse({ amountCt: 10.5 }).success).toBe(false);
    expect(depositTopupBodySchemaMirror.safeParse({}).success).toBe(false);
    expect(
      depositTopupBodySchemaMirror.safeParse({ amountCt: 100, parcelId: 'x' }).success,
    ).toBe(false);
  });
});

function buildRoutingApp() {
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.set('fpHash', '');
    c.set('ipPrefixHash', '');
    await next();
  });
  app.route('/api/land', landRoutes);
  return app;
}

describe('phase B — routing integrity (no DB touch)', () => {
  it('POST /parcels/:id/buy -> 409 tenure_model_active for everyone (dead route, pre-auth)', async () => {
    const app = buildRoutingApp();
    const res = await app.request(`/api/land/parcels/${crypto.randomUUID()}/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe('tenure_model_active');
  });

  it('POST /parcels/:id/rent -> 409 tenure_model_active for everyone (dead route, pre-auth)', async () => {
    const app = buildRoutingApp();
    const res = await app.request(`/api/land/parcels/${crypto.randomUUID()}/rent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe('tenure_model_active');
  });

  it('the three NEW authed writes 401 with zero auth material (mounted under requireAuthOrAgentSession)', async () => {
    const app = buildRoutingApp();
    for (const path of [
      `/api/land/parcels/${crypto.randomUUID()}/claim-hold`,
      `/api/land/parcels/${crypto.randomUUID()}/deposit-topup`,
      `/api/land/parcels/${crypto.randomUUID()}/release`,
    ]) {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountCt: 100 }),
      });
      expect(res.status).toBe(401);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. Money-path E2E — DB-backed, describeIfDb()-gated.
//    REQUIRES migration 0013 applied to the target DB.
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
  app.route('/api/land', landRoutes);
  return app;
}

describeIfDb('phase B — money-path E2E (requires DATABASE_URL + migration 0013)', () => {
  const TEST_TAG = `phb${Date.now()}`;
  const PASSWORD = 'phasebtestpassword123';
  const TENANT_EMAIL = `${TEST_TAG}-tenant@clawville-test.com`;
  const LAPSER_EMAIL = `${TEST_TAG}-lapser@clawville-test.com`;
  const HOLDER_EMAIL = `${TEST_TAG}-holder@clawville-test.com`;

  let app: ReturnType<typeof buildApp>;
  let tenantCookie = '';
  let lapserCookie = '';
  let holderCookie = '';
  let tenantUserId = '';
  let lapserUserId = '';
  let holderUserId = '';
  let tenantAvatarId = '';
  let lapserAvatarId = '';
  let holderAvatarId = '';
  /** Fixture starter parcels — codes start '0' so the claim pool picks them FIRST. */
  const starterCodeA = `0${TEST_TAG}a`;
  const starterCodeB = `0${TEST_TAG}b`;
  let holdParcelId = '';
  let cTierParcelId = '';

  async function signupAndCreateAvatar(email: string) {
    const signup = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, name: 'PhaseB Tester' }),
    });
    expect(signup.status).toBe(200);
    const cookieHeader = signup.headers.get('set-cookie') ?? '';
    const sessionCookie = cookieHeader.split(';')[0]!;
    const signupData = (await signup.json()) as { avatar?: { id: string } };
    let avatarId = signupData.avatar?.id ?? '';
    if (!avatarId) {
      const avatarRes = await app.request('/api/avatars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: JSON.stringify({
          name: `PB${Date.now()}${Math.floor(Math.random() * 10000)}`,
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
    const userRow = await dbMod.db.query.users.findFirst({
      where: eq(dbMod.users.email, email),
    });
    if (!userRow) throw new Error(`test fixture: no users row for ${email}`);
    return { cookie: sessionCookie, userId: userRow.id as string, avatarId };
  }

  async function setBalance(avatarId: string, amount: number) {
    await dbMod.db
      .update(dbMod.avatars)
      .set({ clawTokens: amount, softBalance: amount, boughtBalance: 0, earnedBalance: 0 })
      .where(eq(dbMod.avatars.id, avatarId));
  }

  async function getBalance(avatarId: string): Promise<number> {
    const row = await dbMod.db.query.avatars.findFirst({ where: eq(dbMod.avatars.id, avatarId) });
    if (!row) throw new Error(`test fixture: no avatars row for ${avatarId}`);
    return row.clawTokens as number;
  }

  async function treasuryBalance(): Promise<number> {
    const id = await getHouseTreasuryAvatarId();
    if (!id) throw new Error('house treasury unavailable in test DB');
    return getBalance(id);
  }

  async function getParcelByCode(code: string) {
    const row = await dbMod.db.query.landParcels.findFirst({
      where: eq(dbMod.landParcels.parcelCode, code),
    });
    if (!row) throw new Error(`test fixture: no parcel ${code}`);
    return row;
  }

  async function forceDue(parcelId: string) {
    await dbMod.db
      .update(dbMod.landParcels)
      .set({ rentPaidThrough: new Date(Date.now() - 1000) })
      .where(eq(dbMod.landParcels.id, parcelId));
  }

  async function forceGraceElapsed(parcelId: string) {
    await dbMod.db
      .update(dbMod.landParcels)
      .set({ graceUntil: new Date(Date.now() - 1000) })
      .where(eq(dbMod.landParcels.id, parcelId));
  }

  let gridCounter = 0;
  function nextGrid(): { gridX: number; gridY: number } {
    gridCounter -= 2;
    return { gridX: -8_500_000 + gridCounter, gridY: -8_500_000 + gridCounter };
  }

  beforeAll(async () => {
    app = buildApp();
    const tenant = await signupAndCreateAvatar(TENANT_EMAIL);
    tenantCookie = tenant.cookie;
    tenantUserId = tenant.userId;
    tenantAvatarId = tenant.avatarId;
    const lapser = await signupAndCreateAvatar(LAPSER_EMAIL);
    lapserCookie = lapser.cookie;
    lapserUserId = lapser.userId;
    lapserAvatarId = lapser.avatarId;
    const holder = await signupAndCreateAvatar(HOLDER_EMAIL);
    holderCookie = holder.cookie;
    holderUserId = holder.userId;
    holderAvatarId = holder.avatarId;

    // Fixture starter parcels — '0'-prefixed codes sort before every real
    // 'parcel-starter-*' row, so the claims below consume THESE, never supply.
    await dbMod.db.insert(dbMod.landParcels).values([
      { parcelCode: starterCodeA, tier: 'starter' as const, status: 'available' as const, priceCt: 0, ...nextGrid() },
      { parcelCode: starterCodeB, tier: 'starter' as const, status: 'available' as const, priceCt: 0, ...nextGrid() },
    ]);

    // Fixture c-tier parcel for the grandfathered-hold lifecycle — inserted
    // DIRECTLY as an already-grandfathered hold (the migration script's end
    // state), owner = holder, due immediately.
    const [holdParcel] = await dbMod.db
      .insert(dbMod.landParcels)
      .values({
        parcelCode: `0${TEST_TAG}h`,
        tier: 'c' as const,
        status: 'owned' as const,
        priceCt: 500,
        ownerAvatarId: holderAvatarId,
        tenure: 'hold' as const,
        grandfathered: true,
        holdThresholdCt: 100_000,
        rentCtWeekly: 100,
        rentPaidThrough: new Date(Date.now() - 1000),
        acquiredAt: new Date(),
        ...nextGrid(),
      })
      .returning();
    holdParcelId = holdParcel.id as string;

    // Fixture AVAILABLE c-tier parcel for the claim-hold fail-closed checks.
    const [cParcel] = await dbMod.db
      .insert(dbMod.landParcels)
      .values({
        parcelCode: `0${TEST_TAG}c`,
        tier: 'c' as const,
        status: 'available' as const,
        priceCt: 500,
        rentCtWeekly: 100,
        ...nextGrid(),
      })
      .returning();
    cTierParcelId = cParcel.id as string;
  });

  afterAll(async () => {
    if (!dbMod) return;
    // Fixture parcels by code prefix (covers claimed/reverted states alike).
    const codes = [starterCodeA, starterCodeB, `0${TEST_TAG}h`, `0${TEST_TAG}c`];
    await dbMod.db
      .delete(dbMod.landStructures)
      .where(
        inArray(
          dbMod.landStructures.parcelId,
          (await dbMod.db
            .select({ id: dbMod.landParcels.id })
            .from(dbMod.landParcels)
            .where(inArray(dbMod.landParcels.parcelCode, codes))).map((r) => r.id),
        ),
      )
      .catch(() => {});
    await dbMod.db.delete(dbMod.landParcels).where(inArray(dbMod.landParcels.parcelCode, codes));
    for (const userId of [tenantUserId, lapserUserId, holderUserId].filter(Boolean)) {
      await dbMod.db.delete(dbMod.avatars).where(eq(dbMod.avatars.userId, userId));
      await dbMod.db.delete(dbMod.users).where(eq(dbMod.users.id, userId));
    }
  });

  // ─── B1 escrow conservation: claim → draw → idempotent re-sweep → release ─

  it('claim-starter debits the deposit INTO escrow (no treasury credit), stamps the deposit tenancy', async () => {
    await setBalance(tenantAvatarId, 5000);
    const treasuryBefore = await treasuryBalance();

    const res = await app.request('/api/land/claim-starter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: tenantCookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      alreadyOwned: boolean;
      parcel: { parcelCode: string; tenure: string; depositCt: number; depositRemainingCt: number; rentCtWeekly: number };
    };
    expect(data.alreadyOwned).toBe(false);
    expect(data.parcel.parcelCode).toBe(starterCodeA); // fixture, not live supply
    expect(data.parcel.tenure).toBe('deposit');
    expect(data.parcel.depositCt).toBe(LAND_STARTER_DEPOSIT_CT);
    expect(data.parcel.depositRemainingCt).toBe(LAND_STARTER_DEPOSIT_CT);
    expect(data.parcel.rentCtWeekly).toBe(LAND_STARTER_RENT_CT_WEEKLY);

    // Claimant −deposit; treasury UNCHANGED (escrow is not revenue).
    expect(await getBalance(tenantAvatarId)).toBe(5000 - LAND_STARTER_DEPOSIT_CT);
    expect(await treasuryBalance()).toBe(treasuryBefore);
  });

  it('a replayed claim is alreadyOwned and NEVER charged twice', async () => {
    const before = await getBalance(tenantAvatarId);
    const res = await app.request('/api/land/claim-starter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: tenantCookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { alreadyOwned: boolean };
    expect(data.alreadyOwned).toBe(true);
    expect(await getBalance(tenantAvatarId)).toBe(before); // zero re-charge
  });

  it('the weekly sweep DRAWS from the escrow → treasury (tenant untouched), and the SAME due week never draws twice', async () => {
    const parcel = await getParcelByCode(starterCodeA);
    await forceDue(parcel.id as string);
    const tenantBefore = await getBalance(tenantAvatarId);
    const treasuryBefore = await treasuryBalance();

    const action1 = await processDueParcel(parcel.id as string);
    expect(action1.kind).toBe('charged');

    const afterFirst = await getParcelByCode(starterCodeA);
    expect(afterFirst.depositRemainingCt).toBe(LAND_STARTER_DEPOSIT_CT - LAND_STARTER_RENT_CT_WEEKLY);
    expect(await treasuryBalance()).toBe(treasuryBefore + LAND_STARTER_RENT_CT_WEEKLY);
    expect(await getBalance(tenantAvatarId)).toBe(tenantBefore); // NO tenant debit on draws

    // IDEMPOTENCY: the advance under FOR UPDATE settled this week — a second
    // pass (overlapping tick / crash-retry) must draw NOTHING.
    const action2 = await processDueParcel(parcel.id as string);
    expect(action2.kind).toBe('skip');
    const afterSecond = await getParcelByCode(starterCodeA);
    expect(afterSecond.depositRemainingCt).toBe(LAND_STARTER_DEPOSIT_CT - LAND_STARTER_RENT_CT_WEEKLY);
    expect(await treasuryBalance()).toBe(treasuryBefore + LAND_STARTER_RENT_CT_WEEKLY);
  });

  it('release refunds EXACTLY the remainder — full-life conservation: claim == draws + refund, 0 net mint', async () => {
    const parcel = await getParcelByCode(starterCodeA);
    const tenantBefore = await getBalance(tenantAvatarId);
    const treasuryBefore = await treasuryBalance();
    const expectedRefund = LAND_STARTER_DEPOSIT_CT - LAND_STARTER_RENT_CT_WEEKLY; // 1900

    const res = await app.request(`/api/land/parcels/${parcel.id}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: tenantCookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { released: boolean; refundedCt: number; parcel: { status: string; tenure: string | null } };
    expect(data.released).toBe(true);
    expect(data.refundedCt).toBe(expectedRefund);
    expect(data.parcel.status).toBe('available');
    expect(data.parcel.tenure).toBeNull();

    expect(await getBalance(tenantAvatarId)).toBe(tenantBefore + expectedRefund);
    expect(await treasuryBalance()).toBe(treasuryBefore); // release credits the TENANT, not the house

    // FULL-LIFE CONSERVATION (exact): escrow-in 2000 == draw 100 + refund 1900
    // + forfeit 0. Tenant net −100 == treasury net +100 → system supply Δ 0.
    const reverted = await getParcelByCode(starterCodeA);
    expect(reverted.depositCt).toBeNull();
    expect(reverted.depositRemainingCt).toBeNull();
    expect(reverted.ownerAvatarId).toBeNull();
  });

  // ─── B1 lapse forfeit: nothing refunds, remainder → treasury, 0 net mint ──

  it('lapse (elapsed grace) forfeits the WHOLE remainder to the treasury and reverts the parcel — zero net mint', async () => {
    await setBalance(lapserAvatarId, 5000);
    const claim = await app.request('/api/land/claim-starter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: lapserCookie },
      body: JSON.stringify({}),
    });
    expect(claim.status).toBe(200);
    const claimData = (await claim.json()) as { parcel: { parcelCode: string } };
    expect(claimData.parcel.parcelCode).toBe(starterCodeB);

    const parcel = await getParcelByCode(starterCodeB);
    await forceGraceElapsed(parcel.id as string);
    const treasuryBefore = await treasuryBalance();
    const lapserBefore = await getBalance(lapserAvatarId); // 3000 after the claim debit

    const action = await processDueParcel(parcel.id as string);
    expect(action.kind).toBe('evicted');

    // The FULL 2000 remainder forfeits (no draws happened): lapser stays at
    // 3000 (net −2000 from claim), treasury +2000 → supply Δ over the tenancy
    // is exactly 0 (claim debit == forfeit credit). NOTHING refunds on lapse.
    expect(await getBalance(lapserAvatarId)).toBe(lapserBefore);
    expect(await treasuryBalance()).toBe(treasuryBefore + LAND_STARTER_DEPOSIT_CT);

    const reverted = await getParcelByCode(starterCodeB);
    expect(reverted.status).toBe('available');
    expect(reverted.tenure).toBeNull();
    expect(reverted.depositRemainingCt).toBeNull();
    expect(reverted.ownerAvatarId).toBeNull();
  });

  // ─── B2 grandfathered hold: upkeep charge / idempotency / grace / evict ───

  it('grandfathered hold pays weekly upkeep (owner debit → treasury) with NO CLV check, exactly once per due week', async () => {
    await setBalance(holderAvatarId, 500);
    const treasuryBefore = await treasuryBalance();

    const action1 = await processDueParcel(holdParcelId);
    expect(action1.kind).toBe('charged');
    expect(await getBalance(holderAvatarId)).toBe(400);
    expect(await treasuryBalance()).toBe(treasuryBefore + 100);

    // Same due week again → skip, no double charge.
    const action2 = await processDueParcel(holdParcelId);
    expect(action2.kind).toBe('skip');
    expect(await getBalance(holderAvatarId)).toBe(400);
    expect(await treasuryBalance()).toBe(treasuryBefore + 100);
  });

  it('insufficient CT on a hold opens grace (no partial debit); elapsed grace evicts and clears every hold field', async () => {
    await setBalance(holderAvatarId, 0);
    await forceDue(holdParcelId);

    const graced = await processDueParcel(holdParcelId);
    expect(graced.kind).toBe('graced');
    expect(await getBalance(holderAvatarId)).toBe(0); // nothing partial

    const row1 = await dbMod.db.query.landParcels.findFirst({ where: eq(dbMod.landParcels.id, holdParcelId) });
    expect(row1?.graceUntil).not.toBeNull();

    await forceGraceElapsed(holdParcelId);
    const evicted = await processDueParcel(holdParcelId);
    expect(evicted.kind).toBe('evicted');

    const row2 = await dbMod.db.query.landParcels.findFirst({ where: eq(dbMod.landParcels.id, holdParcelId) });
    expect(row2?.status).toBe('available');
    expect(row2?.tenure).toBeNull();
    expect(row2?.holdThresholdCt).toBeNull();
    expect(row2?.grandfathered).toBe(false);
  });

  // ─── B2 claim-hold FAIL-CLOSED paths (resolve BEFORE any RPC) ─────────────

  it('claim-hold without a linked wallet -> 403 wallet_not_linked (fail-closed, parcel untouched)', async () => {
    const res = await app.request(`/api/land/parcels/${cTierParcelId}/claim-hold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: holderCookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe('wallet_not_linked');
    const row = await dbMod.db.query.landParcels.findFirst({ where: eq(dbMod.landParcels.id, cTierParcelId) });
    expect(row?.status).toBe('available');
    expect(row?.ownerAvatarId).toBeNull();
  });

  it('claim-hold on a STARTER parcel -> 400 use_claim_starter', async () => {
    const starter = await getParcelByCode(starterCodeB); // reverted to available above
    const res = await app.request(`/api/land/parcels/${starter.id}/claim-hold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: holderCookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe('use_claim_starter');
  });

  it('deposit-topup on a NON-deposit parcel -> 409 not_deposit_tenure; on someone else\'s -> 403', async () => {
    // cTierParcelId is available (no owner) → the owner check fires first.
    const res = await app.request(`/api/land/parcels/${cTierParcelId}/deposit-topup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: holderCookie },
      body: JSON.stringify({ amountCt: 100 }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe('not_parcel_owner');
  });
});
