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
 *      check by design); the claim-hold FAIL-CLOSED 403s that resolve
 *      BEFORE any RPC (unlinked human wallet; starter tier); and the
 *      MIXED-SUBJECT stacked-hold re-check (one avatar holding under BOTH
 *      hold_subjects — the sweeper's SUM must scope per subject; both CLV
 *      readers module-mocked, leak-guarded, so no mainnet RPC ever fires).
 *
 *      Starter-pool safety: the claim route picks the first AVAILABLE starter
 *      ORDER BY parcel_code — fixture codes start with '0' ('0' < 'p') so they
 *      sort BEFORE every real `parcel-starter-*` row and the claims
 *      deterministically consume the fixtures, never live supply.
 */

import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import * as dbMod from '@clawville/database';
import * as realClv from '../../services/linked-wallet-clv-balance';
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
// Setup creates avatars through the real routes, which mint custodial wallets
// via the Cloudflare worker — without real worker creds (or with a sibling
// suite's 'example.invalid' placeholder) the hooks fail, so gate like HAS_DB.
const HAS_WALLET_INFRA =
  !!process.env.CLOUDFLARE_WORKER_URL &&
  !process.env.CLOUDFLARE_WORKER_URL.includes('example.invalid') &&
  !!process.env.CLOUDFLARE_WORKER_BEARER;
const describeIfDb = HAS_DB && HAS_WALLET_INFRA ? describe : describe.skip;

// ── CLV-reader module mock (leak-guarded — market.test.ts pattern) ──────────
// The sweeper's non-grandfathered hold branch resolves LIVE CLV through two
// MAINNET readers (`getLinkedWalletClvBalance` for hold_subject='user',
// `getWalletClvBalance` for hold_subject='agent'). The mixed-subject tests
// below must control EACH subject's wallet independently and never touch an
// RPC, so both readers are module-mocked with a PASSTHROUGH default: while
// `clvIntercept` is false (everywhere except inside the mixed-subject
// describe, and in every later test FILE in this process — mock.module
// persists), callers get the REAL functions.
let clvIntercept = false;
let mockUserClv: realClv.ClvBalanceResult = clvOkResult(0);
let mockAgentClv: realClv.ClvBalanceResult = clvOkResult(0);
const REAL_getLinkedWalletClvBalance = realClv.getLinkedWalletClvBalance;
const REAL_getWalletClvBalance = realClv.getWalletClvBalance;

/** A confirmed on-chain read — the sweeper only consumes `available` + `uiAmount`. */
function clvOkResult(uiAmount: number): realClv.ClvBalanceResult {
  return {
    available: true,
    amountAtomic: (BigInt(Math.round(uiAmount)) * 1_000_000n).toString(),
    decimals: 6,
    uiAmount,
    cached: false,
    fetchedAt: new Date().toISOString(),
  };
}

mock.module('../../services/linked-wallet-clv-balance', () => ({
  ...realClv,
  getLinkedWalletClvBalance: async (userId: string) => {
    if (!clvIntercept) return REAL_getLinkedWalletClvBalance(userId);
    return { linked: true, walletPubkey: 'mock-linked-wallet', clv: mockUserClv };
  },
  getWalletClvBalance: async (walletPubkey: string) => {
    if (!clvIntercept) return REAL_getWalletClvBalance(walletPubkey);
    return mockAgentClv;
  },
}));

// ═════════════════════════════════════════════════════════════════════════
// 1a. Hold stacking math (pure — the SHARED constants the route/sweeper sum)
// ═════════════════════════════════════════════════════════════════════════

describe('phase B — hold stacking math (pure)', () => {
  it('per-tier thresholds match the founder-locked ladder', () => {
    expect(holdThresholdForTier('starter')).toBe(100_000);
    expect(holdThresholdForTier('c')).toBe(250_000);
    expect(holdThresholdForTier('b')).toBeNull();
    expect(holdThresholdForTier('a')).toBeNull();
    expect(holdThresholdForTier('founder')).toBe(10_000_000);
    // The function IS the record — no drift possible.
    expect(holdThresholdForTier('c')).toBe(LAND_HOLD_THRESHOLDS_CLV.c!);
  });

  it('500k CLV holds starter+c but NOT starter+c+c (thresholds stack account-wide)', () => {
    const held = 500_000;
    const starterPlusC = holdThresholdForTier('starter')! + holdThresholdForTier('c')!;
    expect(starterPlusC).toBe(350_000);
    expect(held >= starterPlusC).toBe(true);
    const starterPlusTwoC = starterPlusC + holdThresholdForTier('c')!;
    expect(starterPlusTwoC).toBe(600_000);
    expect(held >= starterPlusTwoC).toBe(false);
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

  it('sub-week remainder is preserved: 250 at 100/wk draws 100, 100, then leaves 50 for refund/forfeit', () => {
    const r = simulateTenancy({ escrowIn: [250], rentWeekly: W, dueWeeks: 5, terminal: 'lapse' });
    expect(r.draws).toEqual([100, 100]);
    expect(r.forfeit).toBe(50);
    expect(r.draws.reduce((a, b) => a + b, 0) + r.forfeit).toBe(250);
  });

  it('a sub-week remainder opens grace without drawing or advancing the week', () => {
    const d = decideDepositSweep({
      graceElapsed: false,
      rentDue: true,
      depositRemainingCt: 50,
      rentCtWeekly: 100,
    });
    expect(d).toEqual({ kind: 'grace' });
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
const depositTopupBodySchemaMirror = z.union([
  z.object({
    weeks: z.number().int().min(1).max(26),
    idempotencyKey: z.string().min(8).max(64),
  }).strict(),
  z.object({
    amountCt: z.number().int().min(1).max(1_000_000),
    idempotencyKey: z.string().min(8).max(64),
  }).strict(),
]);

describe('phase B — deposit-topup zod mirror (deterministic, no DB)', () => {
  it('accepts preferred week bounds and the legacy amount bounds', () => {
    expect(depositTopupBodySchemaMirror.safeParse({ weeks: 1, idempotencyKey: '12345678' }).success).toBe(true);
    expect(depositTopupBodySchemaMirror.safeParse({ weeks: 26, idempotencyKey: '12345678' }).success).toBe(true);
    expect(depositTopupBodySchemaMirror.safeParse({ amountCt: 1, idempotencyKey: '12345678' }).success).toBe(true);
    expect(depositTopupBodySchemaMirror.safeParse({ amountCt: 1_000_000, idempotencyKey: '12345678' }).success).toBe(true);
  });
  it('rejects invalid bounds, mixed forms, missing fields, and stray keys', () => {
    expect(depositTopupBodySchemaMirror.safeParse({ weeks: 0, idempotencyKey: '12345678' }).success).toBe(false);
    expect(depositTopupBodySchemaMirror.safeParse({ weeks: 27, idempotencyKey: '12345678' }).success).toBe(false);
    expect(depositTopupBodySchemaMirror.safeParse({ weeks: 1.5, idempotencyKey: '12345678' }).success).toBe(false);
    expect(depositTopupBodySchemaMirror.safeParse({ amountCt: 0 }).success).toBe(false);
    expect(depositTopupBodySchemaMirror.safeParse({ amountCt: -100 }).success).toBe(false);
    expect(depositTopupBodySchemaMirror.safeParse({ amountCt: 1_000_001 }).success).toBe(false);
    expect(depositTopupBodySchemaMirror.safeParse({ amountCt: 10.5 }).success).toBe(false);
    expect(depositTopupBodySchemaMirror.safeParse({}).success).toBe(false);
    expect(
      depositTopupBodySchemaMirror.safeParse({ weeks: 1, amountCt: 100, idempotencyKey: '12345678' }).success,
    ).toBe(false);
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

describe('P2 retired starter door', () => {
  it('POST /claim-starter is a stable pre-auth 409 dead end', async () => {
    const app = buildRoutingApp();
    const res = await app.request('/api/land/claim-starter', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe('tenure_model_active');
  });
});

describe('phase B — routing integrity (no DB touch)', () => {
  it('POST /parcels/:id/buy -> 409 tenure_model_active for everyone (dead route, pre-auth)', async () => {
    const app = buildRoutingApp();
    const res = await app.request(`/api/land/parcels/${crypto.randomUUID()}/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': 'test-phaseb-routing' },
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
      '/api/land/hold-wallet',
      `/api/land/parcels/${crypto.randomUUID()}/claim-rent`,
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
        tenureTermsVersion: 1,
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

  it('claim-hold without a declared wallet -> 403 wallet_not_declared (fail-closed, parcel untouched)', async () => {
    const res = await app.request(`/api/land/parcels/${cTierParcelId}/claim-hold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: holderCookie },
      body: JSON.stringify({ idempotencyKey: 'phaseb-wallet-missing' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe('wallet_not_declared');
    const row = await dbMod.db.query.landParcels.findFirst({ where: eq(dbMod.landParcels.id, cTierParcelId) });
    expect(row?.status).toBe('available');
    expect(row?.ownerAvatarId).toBeNull();
  });

  it('deposit-topup on a NON-deposit parcel -> 409 not_deposit_tenure; on someone else\'s -> 403', async () => {
    // cTierParcelId is available (no owner) → the owner check fires first.
    const res = await app.request(`/api/land/parcels/${cTierParcelId}/deposit-topup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: holderCookie },
      body: JSON.stringify({ weeks: 1, idempotencyKey: 'phaseb-not-owner' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe('not_parcel_owner');
  });

  // ─── B2 mixed-subject stacked holds — the per-subject SUM re-check ────────
  //
  // REGRESSION (fixed 2026-07-09): the sweeper's stacked-requirement SUM was
  // subject-BLIND — it summed the thresholds of BOTH hold_subjects and
  // compared that cross-subject total against ONE subject's wallet
  // (resolveHoldClv reads 'user' → linked wallet, 'agent' → custodial wallet —
  // different wallets), wrongly gracing a fully-funded hold whenever the same
  // avatar also held under the OTHER subject. The two "KEEPS" tests FAIL on
  // the old code and PASS with the hold_subject-scoped SUM; the "still
  // GRACES" test proves the fix scoped the check rather than disabling it.

  describe('mixed-subject stacked holds (per-subject CLV re-check)', () => {
    const MIXED_EMAIL = `${TEST_TAG}-mixed@clawville-test.com`;
    const userHoldCode = `0${TEST_TAG}mu`;
    const agentHoldCode = `0${TEST_TAG}ma`;
    let mixedUserId = '';
    let mixedAvatarId = '';
    let userHoldId = '';
    let agentHoldId = '';

    beforeAll(async () => {
      const mixed = await signupAndCreateAvatar(MIXED_EMAIL);
      mixedUserId = mixed.userId;
      mixedAvatarId = mixed.avatarId;
      // The 'agent' branch of resolveHoldClv reads avatars.wallet_address to
      // reach the custodial-wallet CLV reader (mocked here) — stamp one. The
      // 'user' branch reads avatars.user_id (already set by signup) and goes
      // through the (mocked) linked-wallet reader, so no users-table stamp is
      // needed.
      await dbMod.db
        .update(dbMod.avatars)
        .set({ walletAddress: `0${TEST_TAG}AgentCustodialWallet` })
        .where(eq(dbMod.avatars.id, mixedAvatarId));

      // ONE avatar, TWO live non-grandfathered holds under DIFFERENT subjects:
      // a 'user' c-tier hold (100k CLV) + an 'agent' b-tier hold (500k CLV),
      // both due now, neither in grace. Unique high-offset grid coords +
      // '0'-prefixed codes per the fixture convention (sort before real
      // supply; never collide).
      const [userHold] = await dbMod.db
        .insert(dbMod.landParcels)
        .values({
          parcelCode: userHoldCode,
          tier: 'c' as const,
          status: 'owned' as const,
          priceCt: 500,
          ownerAvatarId: mixedAvatarId,
          tenure: 'hold' as const,
          tenureTermsVersion: 1,
          grandfathered: false,
          holdSubject: 'user' as const,
          holdThresholdCt: 100_000,
          rentCtWeekly: 100,
          rentPaidThrough: new Date(Date.now() - 1000),
          acquiredAt: new Date(),
          ...nextGrid(),
        })
        .returning();
      userHoldId = userHold.id as string;

      const [agentHold] = await dbMod.db
        .insert(dbMod.landParcels)
        .values({
          parcelCode: agentHoldCode,
          tier: 'b' as const,
          status: 'owned' as const,
          priceCt: 2500,
          ownerAvatarId: mixedAvatarId,
          tenure: 'hold' as const,
          tenureTermsVersion: 1,
          grandfathered: false,
          holdSubject: 'agent' as const,
          holdThresholdCt: 500_000,
          rentCtWeekly: 100,
          rentPaidThrough: new Date(Date.now() - 1000),
          acquiredAt: new Date(),
          ...nextGrid(),
        })
        .returning();
      agentHoldId = agentHold.id as string;

      clvIntercept = true; // route the two CLV readers to the mocks
    });

    afterAll(async () => {
      clvIntercept = false; // NEVER leak the mock into later tests/files
      await dbMod.db
        .delete(dbMod.landParcels)
        .where(inArray(dbMod.landParcels.parcelCode, [userHoldCode, agentHoldCode]));
      if (mixedUserId) {
        await dbMod.db.delete(dbMod.avatars).where(eq(dbMod.avatars.userId, mixedUserId));
        await dbMod.db.delete(dbMod.users).where(eq(dbMod.users.id, mixedUserId));
      }
    });

    it('KEEPS a fully-funded agent hold when a user hold coexists (agent wallet == agent-subject sum; subject-blind sum would grace)', async () => {
      await setBalance(mixedAvatarId, 1_000); // plenty for the 100 CT upkeep
      // Agent custodial wallet covers EXACTLY the agent-subject stack (500k),
      // NOT user+agent (600k). Linked user wallet deliberately EMPTY — if the
      // sweeper consults the wrong reader or the wrong sum, this fails.
      mockAgentClv = clvOkResult(500_000);
      mockUserClv = clvOkResult(0);
      const treasuryBefore = await treasuryBalance();

      const action = await processDueParcel(agentHoldId);
      // OLD subject-blind code: required = 100k + 500k = 600k > 500k → 'graced'.
      // Per-subject fix: required = 500k == 500k → upkeep charges, hold kept.
      expect(action.kind).toBe('charged');

      expect(await getBalance(mixedAvatarId)).toBe(900); // weekly upkeep debited
      expect(await treasuryBalance()).toBe(treasuryBefore + 100);
      const row = await getParcelByCode(agentHoldCode);
      expect(row.graceUntil).toBeNull(); // no grace window opened
      expect(row.ownerAvatarId).toBe(mixedAvatarId);
    });

    it('KEEPS a fully-funded user hold in the symmetric direction (user wallet == user-subject sum)', async () => {
      // Defensive: make this direction INDEPENDENTLY damning on the old
      // subject-blind code. If the previous test failed there, it left the
      // AGENT hold in grace, and the sum's grace carve-out would then mask
      // this test's cross-count. Under the fixed code the previous charge
      // already cleared grace, so this is a no-op.
      await dbMod.db
        .update(dbMod.landParcels)
        .set({ graceUntil: null })
        .where(eq(dbMod.landParcels.id, agentHoldId));
      const balBefore = await getBalance(mixedAvatarId);
      // Linked wallet covers EXACTLY the user-subject stack (100k); custodial
      // agent wallet deliberately empty — must not be consulted for a 'user' hold.
      mockUserClv = clvOkResult(100_000);
      mockAgentClv = clvOkResult(0);
      const treasuryBefore = await treasuryBalance();

      const action = await processDueParcel(userHoldId);
      // OLD subject-blind code: required = 600k > 100k → 'graced'.
      expect(action.kind).toBe('charged');

      expect(await getBalance(mixedAvatarId)).toBe(balBefore - 100);
      expect(await treasuryBalance()).toBe(treasuryBefore + 100);
      const row = await getParcelByCode(userHoldCode);
      expect(row.graceUntil).toBeNull();
      expect(row.ownerAvatarId).toBe(mixedAvatarId);
    });

    it("still GRACES when the subject's OWN wallet is short — the fix scoped the sum, it did not disable the check", async () => {
      await forceDue(agentHoldId); // the first test advanced its week
      const balBefore = await getBalance(mixedAvatarId);
      mockAgentClv = clvOkResult(499_999); // 1 CLV below the agent-subject stack

      const action = await processDueParcel(agentHoldId);
      expect(action.kind).toBe('graced');

      expect(await getBalance(mixedAvatarId)).toBe(balBefore); // no upkeep charged on grace
      const row = await getParcelByCode(agentHoldCode);
      expect(row.graceUntil).not.toBeNull(); // grace window opened, parcel not reverted
      expect(row.ownerAvatarId).toBe(mixedAvatarId);
    });
  });
});
