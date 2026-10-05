/**
 * M8 — USDC rent prepay is NON-REFUNDABLE (founder decision 2026-10-04),
 * bucket model (Codex review fix, migration 0078).
 *
 * The USDC-funded part of a deposit escrow is a running balance ON THE PARCEL
 * ROW (`land_parcels.deposit_usdc_funded_ct`), changed only in the same UPDATE
 * that changes `deposit_remaining_ct`. Release reads only those two locked
 * columns. These tests drive the REAL code paths in sequence against ONE
 * stateful fake parcel row:
 *   - the x402 rent-prepay fulfiller (USDC in),
 *   - settleRentPrepay (vCLAW top-up),
 *   - processDueParcel (sweeper draw and lapse),
 *   - settleTenureRelease (release).
 * The fake applies each recognized SET clause with Postgres semantics (every
 * SET expression reads the PRE-update row) and enforces the three DB CHECKs
 * after every UPDATE, so a statement that broke the invariant would throw here
 * exactly like Postgres would. An UPDATE clause the fake does not recognize
 * fails the test (the SQL shape is pinned by the interpreter itself).
 *
 * Codex findings covered:
 *   1. ordering race: a draw before or after a prepay leaves the bucket right;
 *      the split never reads created_at or land_transactions.
 *   2. missing / odd audit rows: the split ignores land_transactions, so a
 *      missing or misclassified USDC row cannot become a vCLAW refund.
 * Codex round 2 (migration 0078 has NO backfill):
 *   3. the fulfiller stamps every new prepay row `usdcBucketed: true`; a
 *      release whose CURRENT tenancy has an unmarked (pre-bucket) prepay row
 *      refuses 409 `usdc_prepay_unproven` and moves nothing. The fake records
 *      every land_transactions INSERT and answers the release guard query with
 *      a JS copy of its SQL predicate; the structural pins below hold the SQL
 *      text that the copy mirrors.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// Crash-loud module-load env, scoped to module init (see x402-checkout.test.ts).
const HEX32 = '0'.repeat(64);
function ensureEnv(k: string, v: string) {
  if (!process.env[k]) process.env[k] = v;
}
ensureEnv('FINGERPRINT_SECRET', HEX32);
const DB_URL_WAS_SET = !!process.env.DATABASE_URL;
ensureEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/db');
ensureEnv('CLOUDFLARE_WORKER_URL', 'https://example.invalid');
ensureEnv('CLOUDFLARE_WORKER_BEARER', 'dummy');
ensureEnv('VANITY_ENCRYPTION_KEY', HEX32);
process.env.CLAWVILLE_MERCHANT_WALLET_PUBKEY = 'MerchantTest1111111111111111111111111111111';
delete process.env.X402_TOPUP_NETWORK;

import * as realDatabase from '@clawville/database';
import * as realLedger from '../claw-token-ledger';
import * as realTreasury from '../house-treasury-seeder';
import * as realSwap from '../clv-swap-executor';

// ── LEAK GUARD: mock.module is process-global; delegate to the real modules
// once this suite is done. Originals are captured BEFORE mock.module runs.
let intercept = true;
afterAll(() => {
  intercept = false;
});
const REAL_db = realDatabase.db;
const REAL_credit = realLedger.creditClawTokens;
const REAL_debit = realLedger.debitClawTokens;
const REAL_treasury = realTreasury.getHouseTreasuryAvatarId;
const REAL_enqueue = realSwap.enqueueClvBuy;

type Row = Record<string, unknown>;
type Captured = { text: string; params: unknown[] };

function flattenSql(q: unknown): Captured {
  const out: Captured = { text: '', params: [] };
  const chunks = (q as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return out;
  for (const ch of chunks) {
    const v = (ch as { value?: unknown } | null)?.value;
    if (ch && typeof ch === 'object' && Array.isArray(v) && v.every((s) => typeof s === 'string')) {
      out.text += v.join('');
    } else if (ch && typeof ch === 'object' && 'queryChunks' in (ch as object)) {
      const inner = flattenSql(ch);
      out.text += inner.text;
      out.params.push(...inner.params);
    } else {
      out.text += ` $${out.params.length + 1} `;
      out.params.push(ch);
    }
  }
  return out;
}

const AVATAR = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PARCEL_ID = '33333333-3333-4333-8333-333333333333';
const TREASURY = '44444444-4444-4444-8444-444444444444';
const PARCEL_CODE = 'parcel-starter-01';
const ACQUIRED = '2026-09-01T00:00:00.000Z';
const WEEKLY = 1000;

// ── The ONE stateful parcel row ─────────────────────────────────────────────
type ParcelState = {
  remaining: number | null;
  usdc: number;
  tenure: 'deposit' | null;
  owner: string | null;
  acquiredAt: Date | null;
  rentDue: boolean;
  graceElapsed: boolean;
};
let parcel: ParcelState;
/** Adversarial / legacy audit rows: shape { kind, metadata?, created_at }.
 *  Returned raw if code reads land_transactions OUTSIDE the release guard;
 *  fed through the guard predicate for the guard query. */
let auditRows: Row[] = [];
/** Every land_transactions row the real code paths INSERT (same shape). */
let ledgerRows: Row[] = [];
const executed: Captured[] = [];
const credits: realLedger.LedgerCreditInput[] = [];
const debits: realLedger.LedgerDebitInput[] = [];
const enqueued: unknown[] = [];
/** Invariant snapshots, one per applied UPDATE land_parcels. */
const snapshots: Array<{ remaining: number | null; usdc: number }> = [];

function freshParcel(remaining: number): ParcelState {
  return {
    remaining,
    usdc: 0,
    tenure: 'deposit',
    owner: AVATAR,
    acquiredAt: new Date(ACQUIRED),
    rentDue: false,
    graceElapsed: false,
  };
}

function paramAt(flat: Captured, idx: string): number {
  return Number(flat.params[Number(idx) - 1]);
}

/** Postgres CHECK semantics for the three land escrow constraints. */
function assertChecks(s: { remaining: number | null; usdc: number }): void {
  if (s.remaining != null && s.remaining < 0) {
    throw new Error('violates check constraint "land_parcels_deposit_remaining_nonneg"');
  }
  if (s.usdc < 0) {
    throw new Error('violates check constraint "land_parcels_deposit_usdc_funded_nonneg"');
  }
  if (!(s.usdc === 0 || (s.remaining != null && s.usdc <= s.remaining))) {
    throw new Error('violates check constraint "land_parcels_deposit_usdc_funded_within_remaining"');
  }
}

/** Applies one UPDATE land_parcels with Postgres semantics: every SET
 *  expression reads the OLD row. Unknown escrow clauses fail loudly. */
function applyParcelUpdate(flat: Captured): void {
  const t = flat.text;
  const old = { ...parcel };
  const next = { ...parcel };
  let m: RegExpMatchArray | null;

  if ((m = t.match(/deposit_remaining_ct = COALESCE\(deposit_remaining_ct, 0\) \+\s*\$(\d+)/))) {
    next.remaining = (old.remaining ?? 0) + paramAt(flat, m[1]!);
  } else if ((m = t.match(/deposit_remaining_ct = deposit_remaining_ct - \s*\$(\d+)/))) {
    next.remaining = old.remaining == null ? null : old.remaining - paramAt(flat, m[1]!);
  } else if (/deposit_remaining_ct = NULL/.test(t)) {
    next.remaining = null;
  } else if (/deposit_remaining_ct\s*=/.test(t)) {
    throw new Error(`unrecognized deposit_remaining_ct clause: ${t}`);
  }

  if ((m = t.match(/deposit_usdc_funded_ct = deposit_usdc_funded_ct \+\s*\$(\d+)/))) {
    next.usdc = old.usdc + paramAt(flat, m[1]!);
  } else if (
    (m = t.match(
      /deposit_usdc_funded_ct = deposit_usdc_funded_ct - LEAST\(\s*\$(\d+)\s*, deposit_usdc_funded_ct\)/,
    ))
  ) {
    next.usdc = old.usdc - Math.min(paramAt(flat, m[1]!), old.usdc);
  } else if (/deposit_usdc_funded_ct = 0\b/.test(t)) {
    next.usdc = 0;
  } else if (/deposit_usdc_funded_ct\s*=/.test(t)) {
    throw new Error(`unrecognized deposit_usdc_funded_ct clause: ${t}`);
  }

  if (/owner_avatar_id = NULL/.test(t)) {
    next.owner = null;
    next.tenure = null;
    next.acquiredAt = null;
  }
  if (/rent_paid_through = now\(\)/.test(t)) next.rentDue = false;

  assertChecks(next);
  parcel = next;
  snapshots.push({ remaining: next.remaining, usdc: next.usdc });
}

function parcelRow(): Row {
  return {
    id: PARCEL_ID,
    parcel_code: PARCEL_CODE,
    tier: 'starter',
    status: parcel.owner ? 'owned' : 'available',
    owner_avatar_id: parcel.owner,
    acquired_at: parcel.acquiredAt,
    price_ct: null,
    rent_ct_weekly: WEEKLY,
    tenure: parcel.tenure,
    tenure_terms_version: parcel.tenure ? 2 : null,
    deposit_ct: 2000,
    deposit_remaining_ct: parcel.remaining,
    deposit_usdc_funded_ct: parcel.usdc,
    hold_threshold_ct: null,
    hold_subject: null,
    grandfathered: false,
    grace_until: parcel.graceElapsed ? new Date('2026-09-20T00:00:00.000Z') : null,
    rent_due: parcel.rentDue,
    has_grace: parcel.graceElapsed,
    grace_elapsed: parcel.graceElapsed,
    grid_x: 1,
    grid_y: 2,
  };
}

/** Mirrors the release guard's ISO stamp regex (land-tenure-settlement.ts). */
const ISO_STAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$/;

/** JS copy of `currentTenancyHasUnprovenUsdcPrepay`'s WHERE clause. */
function legacyGuardHits(): Row[] {
  if (!parcel.acquiredAt) return [];
  const acquired = parcel.acquiredAt.getTime();
  const hit = [...ledgerRows, ...auditRows].some((r) => {
    if (r.kind !== 'land_deposit_prepay_usdc') return false;
    const meta = (r.metadata ?? {}) as Row;
    if (meta.usdcBucketed === true) return false; // strict JSON boolean true
    const stamp = meta.tenancyAcquiredAt;
    if (typeof stamp === 'string' && ISO_STAMP.test(stamp) && !Number.isNaN(Date.parse(stamp))) {
      return Math.abs(Date.parse(stamp) - acquired) <= 1;
    }
    return (r.created_at as Date).getTime() >= acquired;
  });
  return hit ? [{ hit: 1 }] : [];
}

function isLegacyGuardQuery(t: string): boolean {
  return t.includes('FROM land_transactions') && t.includes("'usdcBucketed'");
}

function recordLandTransaction(flat: Captured): void {
  const kind = flat.text.match(/VALUES \('([a-z_]+)'/)?.[1];
  const metaParam = [...flat.params]
    .reverse()
    .find((p) => typeof p === 'string' && p.startsWith('{'));
  ledgerRows.push({
    kind,
    metadata: metaParam ? (JSON.parse(metaParam as string) as Row) : {},
    created_at: new Date(),
  });
}

function route(q: unknown): Row[] {
  const flat = flattenSql(q);
  executed.push(flat);
  const t = flat.text;
  if (t.includes('pg_advisory_xact_lock')) return [];
  if (t.includes('FROM avatars') && t.includes('FOR UPDATE')) return [{ user_id: USER }];
  if (t.includes('land_tenure_settlements')) return [];
  if (t.includes('market_deed_locks')) return [];
  if (isLegacyGuardQuery(t)) return legacyGuardHits();
  if (t.includes('FROM land_transactions')) return auditRows;
  if (t.includes('INSERT INTO land_transactions')) {
    recordLandTransaction(flat);
    return [];
  }
  if (t.includes('UPDATE land_structures')) return [];
  if (t.includes('UPDATE land_parcels')) {
    applyParcelUpdate(flat);
    return [];
  }
  if (t.includes('SELECT owner_avatar_id, tenure FROM land_parcels WHERE id')) {
    return [{ owner_avatar_id: parcel.owner, tenure: parcel.tenure }];
  }
  if (t.includes('FROM land_parcels')) return [parcelRow()];
  throw new Error(`unrouted SQL in M8 fake: ${t}`);
}

const fakeTx = { execute: async (q: unknown) => route(q) };
const fakeDb = new Proxy({} as Record<string, unknown>, {
  get(_target, prop) {
    if (intercept && prop === 'transaction') {
      return async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx);
    }
    if (intercept && prop === 'execute') return fakeTx.execute;
    return (REAL_db as unknown as Record<string | symbol, unknown>)[prop];
  },
});

mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: fakeDb,
}));

mock.module('../claw-token-ledger', () => ({
  ...realLedger,
  creditClawTokens: async (input: realLedger.LedgerCreditInput, tx?: unknown) => {
    if (!intercept) return REAL_credit(input, tx as never);
    credits.push(input);
    return { ledgerId: `credit-${credits.length}`, newBalance: 0 } as never;
  },
  debitClawTokens: async (input: realLedger.LedgerDebitInput, tx?: unknown) => {
    if (!intercept) return REAL_debit(input, tx as never);
    debits.push(input);
    return { ledgerId: `debit-${debits.length}`, newBalance: 0 } as never;
  },
}));

mock.module('../house-treasury-seeder', () => ({
  ...realTreasury,
  getHouseTreasuryAvatarId: async () => (intercept ? TREASURY : REAL_treasury()),
}));

mock.module('../clv-swap-executor', () => ({
  ...realSwap,
  enqueueClvBuy: async (input: unknown, tx?: unknown) => {
    if (!intercept) return REAL_enqueue(input as never, tx as never);
    enqueued.push(input);
    return { queueId: `q-${enqueued.length}` };
  },
}));

const settlement = await import('../land-tenure-settlement');
const {
  settleTenureRelease,
  settleRentPrepay,
  USDC_RENT_PREPAY_FORFEIT_REASON,
  USDC_PREPAY_BUCKETED_MARKER,
  USDC_PREPAY_UNPROVEN_CODE,
  USDC_PREPAY_UNPROVEN_MESSAGE,
  LandTenureSettlementError,
} = settlement;
const { processDueParcel } = await import('../land-rent-sweeper');
const checkout = await import('../x402-checkout');
const rentPrepay = await import('../checkout-fulfillers/rent-prepay');

if (!DB_URL_WAS_SET) delete process.env.DATABASE_URL;

// ── Step helpers (each runs a REAL code path) ───────────────────────────────
const identity = { kind: 'user' as const, userId: USER, avatarId: AVATAR, agentId: null };
function common(key: string) {
  return {
    identity,
    expectedAvatarId: AVATAR,
    expectedUserId: USER,
    expectedAgentId: null,
    parcelCode: PARCEL_CODE,
    idempotencyKey: key,
  };
}

let seq = 0;
let ledgerIn = 0; // escrow funded: initial + vCLAW top-ups + USDC prepays

async function usdcPrepay(amount: number): Promise<void> {
  const fulfiller = checkout.getFulfiller('rent_payment')!;
  seq += 1;
  await fulfiller({
    tx: fakeTx as never,
    checkoutId: `checkout-${seq}`,
    subject: { avatarId: AVATAR, userId: USER, kind: 'user' } as never,
    itemKind: 'rent_payment',
    itemRef: PARCEL_ID,
    priceVclaw: amount,
    usdCents: amount,
    usdBasis: (amount / 100).toFixed(2),
    txSignature: `SIG-${seq}`,
    settlePayer: null,
    network: null,
  });
  ledgerIn += amount;
}

async function vclawTopup(amount: number): Promise<void> {
  seq += 1;
  await settleRentPrepay({ ...common(`topup-${seq}`), amountCt: amount });
  ledgerIn += amount;
}

async function draw(): Promise<void> {
  parcel.rentDue = true;
  const action = await processDueParcel(PARCEL_ID);
  expect(['charged', 'graced']).toContain(action.kind);
}

async function release(key = `release-${++seq}`) {
  return settleTenureRelease(common(key));
}

function treasuryDraws(): number {
  return credits
    .filter((c) => c.avatarId === TREASURY && (c.metadata as Row)?.drawnFromEscrow === true)
    .reduce((s, c) => s + c.amount, 0);
}

function startTenancy(remaining: number): void {
  parcel = freshParcel(remaining);
  ledgerIn = remaining;
}

beforeEach(() => {
  executed.length = 0;
  credits.length = 0;
  debits.length = 0;
  enqueued.length = 0;
  snapshots.length = 0;
  auditRows = [];
  ledgerRows = [];
  startTenancy(2000);
});

function expectInvariantHeldEveryStep(): void {
  expect(snapshots.length).toBeGreaterThan(0);
  for (const s of snapshots) {
    expect(s.usdc).toBeGreaterThanOrEqual(0);
    if (s.remaining == null) expect(s.usdc).toBe(0);
    else expect(s.usdc).toBeLessThanOrEqual(s.remaining);
  }
}

/** True when any land_transactions read OTHER than the legacy guard ran (the
 *  guard can only refuse; it never feeds the split). */
function releaseReadAuditRows(): boolean {
  return executed.some((q) => q.text.includes('FROM land_transactions') && !isLegacyGuardQuery(q.text));
}

function legacyGuardRan(): boolean {
  return executed.some((q) => isLegacyGuardQuery(q.text));
}

function refundRowMeta(): Row {
  const insert = executed.find(
    (q) => q.text.includes('INSERT INTO land_transactions') && q.text.includes('land_deposit_refund'),
  );
  if (!insert) throw new Error('no land_deposit_refund row');
  const meta = insert.params.find((p) => typeof p === 'string' && p.includes('voluntary_release'));
  return JSON.parse(meta as string) as Row;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Each mutation path moves the bucket correctly
// ─────────────────────────────────────────────────────────────────────────────

describe('M8 bucket — mutation paths', () => {
  it('USDC prepay adds to BOTH columns in one statement; no ledger write', async () => {
    await usdcPrepay(1500);
    expect(parcel).toMatchObject({ remaining: 3500, usdc: 1500 });
    expect(credits).toEqual([]);
    expect(debits).toEqual([]);
    expect(enqueued).toHaveLength(1);
    const update = executed.find((q) => q.text.includes('UPDATE land_parcels'))!;
    expect(update.text).toContain('deposit_usdc_funded_ct = deposit_usdc_funded_ct +');
    expectInvariantHeldEveryStep();
  });

  it('vCLAW top-up grows only the remainder; the bucket is unchanged', async () => {
    await usdcPrepay(500);
    await vclawTopup(300);
    expect(parcel).toMatchObject({ remaining: 2800, usdc: 500 });
    expect(debits.map((d) => d.reason)).toEqual(['land_deposit_topup']);
    expectInvariantHeldEveryStep();
  });

  it('a draw consumes the USDC bucket FIRST', async () => {
    await usdcPrepay(1500);
    await draw();
    expect(parcel).toMatchObject({ remaining: 2500, usdc: 500 });
    expect(treasuryDraws()).toBe(WEEKLY);
    const drawRow = executed.find(
      (q) => q.text.includes('INSERT INTO land_transactions') && q.text.includes('rent_payment'),
    )!;
    const meta = JSON.parse(
      drawRow.params.find((p) => typeof p === 'string' && p.includes('drawnCt')) as string,
    ) as Row;
    expect(meta).toMatchObject({ drawnCt: WEEKLY, usdcFundedDrawnCt: WEEKLY, remainingAfter: 2500 });
    expectInvariantHeldEveryStep();
  });

  it('a draw larger than the bucket empties it and spills into vCLAW', async () => {
    await usdcPrepay(300);
    await draw();
    expect(parcel).toMatchObject({ remaining: 1300, usdc: 0 });
    const out = await release();
    expect(out).toMatchObject({ refundedCt: 1300, forfeitedUsdcPrepayCt: 0 });
    expectInvariantHeldEveryStep();
  });

  it('lapse closes the bucket with the escrow; the tenant gets nothing back', async () => {
    startTenancy(0);
    await usdcPrepay(600); // below one week: the next due draw opens grace
    expect(parcel).toMatchObject({ remaining: 600, usdc: 600 });
    parcel.graceElapsed = true;
    const action = await processDueParcel(PARCEL_ID);
    expect(action.kind).toBe('evicted');
    expect(parcel).toMatchObject({ remaining: null, usdc: 0, owner: null, tenure: null });
    // Unchanged lapse behavior: the whole remainder (USDC part included) goes
    // to the house treasury; nothing is credited to the tenant.
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({
      avatarId: TREASURY,
      amount: 600,
      metadata: { reason: 'forfeit_on_lapse' },
    });
    expect(credits.some((c) => c.avatarId === AVATAR)).toBe(false);
    const eviction = executed.find(
      (q) => q.text.includes('INSERT INTO land_transactions') && q.text.includes("'eviction'"),
    )!;
    const meta = JSON.parse(
      eviction.params.find((p) => typeof p === 'string' && p.includes('deposit_exhausted')) as string,
    ) as Row;
    expect(meta).toMatchObject({ forfeitedCt: 600, forfeitedUsdcFundedCt: 600 });
    expectInvariantHeldEveryStep();
  });

  it('release zeroes the bucket and the remainder in one statement', async () => {
    await usdcPrepay(400);
    await release();
    expect(parcel).toMatchObject({ remaining: null, usdc: 0, owner: null });
    const revert = executed.filter((q) => q.text.includes('UPDATE land_parcels')).pop()!;
    expect(revert.text).toContain('deposit_remaining_ct = NULL');
    expect(revert.text).toContain('deposit_usdc_funded_ct = 0');
    expectInvariantHeldEveryStep();
  });

  it('the fake rejects an UPDATE that would leave the bucket above the remainder', () => {
    parcel = { ...freshParcel(1000), usdc: 1000 };
    // A draw that forgot the bucket clause: Postgres would reject it by CHECK.
    expect(() =>
      applyParcelUpdate({
        text: 'UPDATE land_parcels SET deposit_remaining_ct = deposit_remaining_ct -  $1  WHERE id =  $2 ',
        params: [1000, PARCEL_ID],
      }),
    ).toThrow(/land_parcels_deposit_usdc_funded_within_remaining/);
    expect(parcel).toMatchObject({ remaining: 1000, usdc: 1000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Codex finding 1 — ordering race (commit order is the only order)
// ─────────────────────────────────────────────────────────────────────────────

describe('M8 bucket — ordering race (Codex finding 1)', () => {
  it('draw commits BEFORE the prepay: the draw is vCLAW, the prepay stays forfeitable', async () => {
    await draw(); // 2000 vCLAW -> 1000 vCLAW
    await usdcPrepay(1000); // + 1000 USDC
    expect(parcel).toMatchObject({ remaining: 2000, usdc: 1000 });
    // Adversarial audit rows: the prepay "created_at" sorts BEFORE the draw
    // (transaction start time). The old replay would have paid the draw from
    // USDC and refunded the prepay as vCLAW. Release must not care.
    // (Marked like every row the fulfiller writes since Codex round 2.)
    auditRows = [
      {
        kind: 'land_deposit_prepay_usdc',
        amount_ct: 1000,
        metadata: { usdcBucketed: true, tenancyAcquiredAt: ACQUIRED },
        created_at: new Date('2026-09-07T23:59:59Z'),
      },
      { kind: 'rent_payment', amount_ct: 1000, created_at: new Date('2026-09-08T00:00:00Z') },
    ];
    const out = await release();
    expect(out).toMatchObject({ refundedCt: 1000, forfeitedUsdcPrepayCt: 1000 });
    expect(releaseReadAuditRows()).toBe(false);
    expect(legacyGuardRan()).toBe(true);
    expectInvariantHeldEveryStep();
  });

  it('prepay commits BEFORE the draw: the draw is paid from USDC first', async () => {
    await usdcPrepay(1000);
    await draw();
    expect(parcel).toMatchObject({ remaining: 2000, usdc: 0 });
    auditRows = [
      { kind: 'rent_payment', amount_ct: 1000, created_at: new Date('2026-09-07T00:00:00Z') },
      {
        kind: 'land_deposit_prepay_usdc',
        amount_ct: 1000,
        metadata: { usdcBucketed: true, tenancyAcquiredAt: ACQUIRED },
        created_at: new Date('2026-09-08T00:00:00Z'),
      },
    ];
    const out = await release();
    expect(out).toMatchObject({ refundedCt: 2000, forfeitedUsdcPrepayCt: 0 });
    expect(releaseReadAuditRows()).toBe(false);
    expectInvariantHeldEveryStep();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Codex finding 2 — audit rows do not decide the refund
// ─────────────────────────────────────────────────────────────────────────────

describe('M8 bucket — missing or odd audit rows (Codex finding 2)', () => {
  it('a MISSING USDC audit row still forfeits the USDC part', async () => {
    await usdcPrepay(700);
    auditRows = []; // the land_deposit_prepay_usdc row is gone
    const out = await release();
    expect(out).toMatchObject({ refundedCt: 2000, forfeitedUsdcPrepayCt: 700 });
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({ avatarId: AVATAR, amount: 2000, reason: 'land_deposit_refund' });
  });

  it('an ODD audit row (prior-tenancy date, misplaced stamp key) changes nothing', async () => {
    // The first row is unmarked but dated 2020 (before acquired_at), so it is
    // a prior-tenancy row and the legacy guard does not refuse.
    await usdcPrepay(700);
    auditRows = [
      {
        kind: 'land_deposit_prepay_usdc',
        amount_ct: 700,
        tenancy_acquired_at: '2020-01-01T00:00:00.000Z',
        created_at: new Date('2020-01-01T00:00:00Z'),
      },
      { kind: 'land_deposit_topup', amount_ct: 99_999, has_debit: true, created_at: new Date() },
    ];
    const out = await release();
    expect(out).toMatchObject({ refundedCt: 2000, forfeitedUsdcPrepayCt: 700 });
    expect(releaseReadAuditRows()).toBe(false);
  });

  it('a corrupt bucket read fails closed: 409, no credit, no state change', async () => {
    await usdcPrepay(700);
    const saved = parcel;
    parcel = { ...parcel, usdc: Number.NaN };
    await expect(release()).rejects.toMatchObject({ code: 'invalid_escrow_state', status: 409 });
    expect(credits).toEqual([]);
    parcel = saved;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Release outcomes
// ─────────────────────────────────────────────────────────────────────────────

describe('M8 settleTenureRelease — outcomes', () => {
  it('USDC-only escrow: 0 refunded, all forfeited, NO credit at all', async () => {
    startTenancy(0);
    await usdcPrepay(1500);
    const out = await release('m8-usdc-only');

    expect(out.fresh).toBe(true);
    expect(out.refundedCt).toBe(0);
    expect(out.forfeitedUsdcPrepayCt).toBe(1500);
    expect(out.forfeitReason).toBe('usdc_rent_prepay_non_refundable');
    expect(credits).toEqual([]); // no vCLAW refund, no treasury mint
    expect(refundRowMeta()).toEqual({
      reason: 'voluntary_release',
      tenure: 'deposit',
      refundedCt: 0,
      escrowRemainingCt: 1500,
      forfeitedUsdcPrepayCt: 1500,
      forfeitReason: 'usdc_rent_prepay_non_refundable',
      escrowUsdcFundedCt: 1500,
    });
    const persisted = executed.find((q) => q.text.includes('INSERT INTO land_tenure_settlements'));
    const response = JSON.parse(
      persisted!.params.find((p) => typeof p === 'string' && p.includes('forfeitedUsdcPrepayCt')) as string,
    ) as Row;
    expect(response).toMatchObject({ refundedCt: 0, forfeitedUsdcPrepayCt: 1500 });
  });

  it('vCLAW-only escrow refunds in full, exactly as before', async () => {
    await draw();
    await vclawTopup(300);
    const out = await release('m8-vclaw-only');

    expect(out.refundedCt).toBe(1300);
    expect(out.forfeitedUsdcPrepayCt).toBe(0);
    expect(out.forfeitReason).toBeUndefined();
    const refunds = credits.filter((c) => c.reason === 'land_deposit_refund');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      avatarId: AVATAR,
      amount: 1300,
      metadata: { parcelId: PARCEL_ID, parcelCode: PARCEL_CODE },
    });
    expect((refunds[0]!.metadata as Row).forfeitedUsdcPrepayCt).toBeUndefined();
    expect(refundRowMeta()).toMatchObject({ refundedCt: 1300, forfeitedUsdcPrepayCt: 0, escrowUsdcFundedCt: 0 });
    expect(refundRowMeta().forfeitReason).toBeUndefined();
    // No USDC rows at all: the legacy guard runs, finds nothing, never refuses.
    expect(legacyGuardRan()).toBe(true);
    expect(ledgerRows.some((r) => r.kind === 'land_deposit_prepay_usdc')).toBe(false);
  });

  it('mixed escrow refunds only the vCLAW part and forfeits the USDC part', async () => {
    // 2000 vCLAW escrow + 1500 USDC prepay, one 1000 draw (paid by USDC first).
    await usdcPrepay(1500);
    await draw();
    const out = await release('m8-mixed');

    expect(out.refundedCt).toBe(2000);
    expect(out.forfeitedUsdcPrepayCt).toBe(500);
    const refunds = credits.filter((c) => c.reason === 'land_deposit_refund');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      amount: 2000,
      metadata: { forfeitedUsdcPrepayCt: 500, forfeitReason: USDC_RENT_PREPAY_FORFEIT_REASON },
    });
    expect(refundRowMeta()).toMatchObject({
      refundedCt: 2000,
      escrowRemainingCt: 2500,
      forfeitedUsdcPrepayCt: 500,
      forfeitReason: 'usdc_rent_prepay_non_refundable',
      escrowUsdcFundedCt: 500,
    });
    const insert = executed.find((q) => q.text.includes('land_deposit_refund') && q.text.includes('INSERT'));
    expect(insert!.params).toContain(2000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4b. Codex round 2 — no backfill; legacy unmarked USDC rows refuse release
// ─────────────────────────────────────────────────────────────────────────────

describe('M8 legacy guard — unmarked USDC prepay rows (Codex round 2)', () => {
  /** A pre-bucket fulfiller row: no usdcBucketed marker. */
  function legacyRow(metadata: Row, createdAt = '2026-09-02T00:00:00Z'): Row {
    return {
      kind: 'land_deposit_prepay_usdc',
      amount_ct: 100,
      metadata: { usdBasis: '1.00', usdCents: 100, ...metadata },
      created_at: new Date(createdAt),
    };
  }

  /** Runs a release that must refuse, and proves nothing moved. */
  async function expectUnprovenRefusal(): Promise<void> {
    const before = { ...parcel };
    const snapshotCount = snapshots.length;
    executed.length = 0;
    credits.length = 0;
    debits.length = 0;
    const err = await release().then(
      () => {
        throw new Error('release should have refused');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LandTenureSettlementError);
    expect(err).toMatchObject({
      code: 'usdc_prepay_unproven',
      status: 409,
      details: { error: USDC_PREPAY_UNPROVEN_MESSAGE },
    });
    // The REST mapper (routes/land.ts settlementError) builds
    // { error: code, code, ...details }: the body is { code, error: <text> }.
    const e = err as InstanceType<typeof LandTenureSettlementError>;
    expect({ error: e.code, code: e.code, ...e.details }).toEqual({
      code: 'usdc_prepay_unproven',
      error: USDC_PREPAY_UNPROVEN_MESSAGE,
    });
    expect(USDC_PREPAY_UNPROVEN_MESSAGE).toContain('An operator must settle this release.');
    expect(USDC_PREPAY_UNPROVEN_MESSAGE).not.toContain('—');
    // Nothing moved: no ledger write, no parcel write, no audit or settlement row.
    expect(credits).toEqual([]);
    expect(debits).toEqual([]);
    expect(parcel).toEqual(before);
    expect(snapshots.length).toBe(snapshotCount);
    expect(executed.some((q) => /\bUPDATE\s+land_/.test(q.text))).toBe(false);
    expect(executed.some((q) => q.text.includes('INSERT INTO'))).toBe(false);
    expect(legacyGuardRan()).toBe(true);
  }

  it('the fulfiller stamps usdcBucketed: true on every new prepay row', async () => {
    await usdcPrepay(250);
    await usdcPrepay(50);
    const prepays = ledgerRows.filter((r) => r.kind === 'land_deposit_prepay_usdc');
    expect(prepays).toHaveLength(2);
    for (const r of prepays) {
      expect(r.metadata).toMatchObject({
        usdcBucketed: true,
        refundable: false,
        nonRefundableReason: USDC_RENT_PREPAY_FORFEIT_REASON,
        tenancyAcquiredAt: ACQUIRED,
      });
    }
    expect(rentPrepay.USDC_PREPAY_BUCKETED_MARKER).toBe(USDC_PREPAY_BUCKETED_MARKER);
  });

  it('marked rows only: normal M8 split (forfeit the bucket, refund the rest)', async () => {
    await usdcPrepay(1500);
    await draw();
    const out = await release();
    expect(out).toMatchObject({ refundedCt: 2000, forfeitedUsdcPrepayCt: 500 });
    expect(legacyGuardRan()).toBe(true);
  });

  it('an unmarked row of the current tenancy WITHOUT a stamp (created after acquired_at) -> 409', async () => {
    await usdcPrepay(400); // marked; the legacy row below still blocks
    auditRows = [legacyRow({ refundable: false })];
    await expectUnprovenRefusal();
  });

  it('the Codex example (scaled to one week): vCLAW + legacy USDC, one draw, release -> 409, no vCLAW forfeit', async () => {
    startTenancy(WEEKLY);
    auditRows = [{ ...legacyRow({}), amount_ct: WEEKLY }]; // legacy prepay, not in the bucket
    parcel.remaining = 2 * WEEKLY; // the legacy prepay grew the remainder only
    await draw(); // 2W -> W; the bucket stays 0 (no backfill)
    expect(parcel).toMatchObject({ remaining: WEEKLY, usdc: 0 });
    await expectUnprovenRefusal();
  });

  it('an unmarked row stamped with the current tenancy -> 409', async () => {
    auditRows = [legacyRow({ tenancyAcquiredAt: ACQUIRED })];
    await expectUnprovenRefusal();
  });

  it('the marker must be the JSON boolean true (string "true" or false is unmarked) -> 409', async () => {
    auditRows = [legacyRow({ usdcBucketed: 'true', tenancyAcquiredAt: ACQUIRED })];
    await expectUnprovenRefusal();
    auditRows = [legacyRow({ usdcBucketed: false, tenancyAcquiredAt: ACQUIRED })];
    await expectUnprovenRefusal();
  });

  it('prior-tenancy unmarked rows do not block a new tenancy', async () => {
    await usdcPrepay(300);
    auditRows = [
      // Stamped with an OLD tenancy: the stamp wins even though created_at is
      // after the current acquired_at.
      legacyRow({ tenancyAcquiredAt: '2026-08-01T00:00:00.000Z' }, '2026-09-05T00:00:00Z'),
      // No stamp, created before the current acquired_at.
      legacyRow({}, '2026-08-15T00:00:00Z'),
    ];
    const out = await release();
    expect(out).toMatchObject({ refundedCt: 2000, forfeitedUsdcPrepayCt: 300 });
    expect(legacyGuardRan()).toBe(true);
  });

  it('an unparseable stamp falls back to created_at (current tenancy -> 409)', async () => {
    auditRows = [legacyRow({ tenancyAcquiredAt: 'not-a-date' }, '2026-09-03T00:00:00Z')];
    await expectUnprovenRefusal();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Invariant + conservation over many sequences
// ─────────────────────────────────────────────────────────────────────────────

describe('M8 bucket — invariant and conservation over random sequences', () => {
  it('0 <= bucket <= remainder after every mutation; draws + refund + forfeit == funded', async () => {
    let rng = 0x5eed;
    const next = (n: number) => {
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      return rng % n;
    };
    for (let run = 0; run < 40; run++) {
      credits.length = 0;
      snapshots.length = 0;
      startTenancy(next(3) * 1000);
      let usdcIn = 0;
      const steps = 2 + next(8);
      for (let i = 0; i < steps; i++) {
        const op = next(3);
        if (op === 0) {
          const amt = 1 + next(2500);
          await usdcPrepay(amt);
          usdcIn += amt;
        } else if (op === 1) {
          await vclawTopup(1 + next(2500));
        } else {
          await draw();
        }
      }
      const before = { ...parcel };
      const out = await release();
      // Release split = the locked columns, nothing else.
      expect(out.forfeitedUsdcPrepayCt).toBe(Math.min(before.usdc, before.remaining ?? 0));
      expect(out.refundedCt + out.forfeitedUsdcPrepayCt).toBe(before.remaining ?? 0);
      // Never refund more than the vCLAW-funded part; never forfeit more USDC
      // than was prepaid.
      expect(out.forfeitedUsdcPrepayCt).toBeLessThanOrEqual(usdcIn);
      // Conservation.
      expect(treasuryDraws() + out.refundedCt + out.forfeitedUsdcPrepayCt).toBe(ledgerIn);
      expectInvariantHeldEveryStep();
      expect(parcel).toMatchObject({ remaining: null, usdc: 0 });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Structural pins: every escrow-mutating statement handles the bucket
// ─────────────────────────────────────────────────────────────────────────────

describe('M8 bucket — structural pins', () => {
  const API_SRC = join(import.meta.dir, '..', '..');
  const ROOT = join(API_SRC, '..', '..', '..');
  const read = (...p: string[]) => readFileSync(join(...p), 'utf8');
  const service = read(API_SRC, 'services', 'land-tenure-settlement.ts');
  const sweeper = read(API_SRC, 'services', 'land-rent-sweeper.ts');
  const fulfiller = read(API_SRC, 'services', 'checkout-fulfillers', 'rent-prepay.ts');
  const deed = read(API_SRC, 'services', 'market-deed-transfer-executor.ts');
  const routes = read(API_SRC, 'routes', 'land.ts');
  const schema = read(ROOT, 'packages', 'database', 'src', 'schema', 'land.ts');
  const migration = read(ROOT, 'packages', 'database', 'migrations', '0078_land_deposit_usdc_bucket.sql');

  it('the replay split is gone; the ONLY land_transactions read is the legacy guard', () => {
    expect(service).not.toContain('splitDepositEscrowByFunding');
    expect(service).not.toContain('depositEscrowEventsForTenancy');
    expect(service).not.toContain('readDepositEscrowLedger');
    expect(service.split('FROM land_transactions').length - 1).toBe(1);
    const guardStart = service.indexOf('async function currentTenancyHasUnprovenUsdcPrepay(');
    const guardEnd = service.indexOf('return rows.length > 0;', guardStart);
    const read = service.indexOf('FROM land_transactions');
    expect(guardStart).toBeGreaterThan(0);
    expect(read).toBeGreaterThan(guardStart);
    expect(read).toBeLessThan(guardEnd);
    expect(service).toContain('forfeitedUsdcPrepayCt = Math.min(usdcFundedCt, remainingCt);');
  });

  it('the legacy guard SQL: current tenancy, strict marker, acquired_at from the locked row', () => {
    const guard = service.slice(
      service.indexOf('async function currentTenancyHasUnprovenUsdcPrepay('),
      service.indexOf('return rows.length > 0;'),
    );
    // The JS copy in this file (legacyGuardHits) mirrors exactly these clauses.
    expect(guard).toContain("AND t.kind = 'land_deposit_prepay_usdc'");
    expect(guard).toContain("AND (t.metadata -> 'usdcBucketed') IS DISTINCT FROM 'true'::jsonb");
    expect(guard).toContain('JOIN land_parcels p ON p.id = t.parcel_id');
    expect(guard).toContain('WHERE t.parcel_id = ${parcelId}');
    expect(guard).toContain(
      "WHEN (t.metadata ->> 'tenancyAcquiredAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'",
    );
    expect(guard).toContain("AND pg_input_is_valid(t.metadata ->> 'tenancyAcquiredAt', 'timestamptz')");
    expect(guard).toContain("BETWEEN p.acquired_at - interval '1 millisecond'");
    expect(guard).toContain("AND p.acquired_at + interval '1 millisecond'");
    expect(guard).toContain('ELSE t.created_at >= p.acquired_at');
    expect(ISO_STAMP.source).toBe(
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$',
    );
    // The guard runs inside the deposit branch BEFORE the split and the credit.
    const call = service.indexOf('if (await currentTenancyHasUnprovenUsdcPrepay(tx, parcel.id)) {');
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(service.indexOf('forfeitedUsdcPrepayCt = Math.min(usdcFundedCt, remainingCt);'));
    const releaseFn = service.indexOf('export async function settleTenureRelease(');
    expect(releaseFn).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(releaseFn);
    expect(service.split('currentTenancyHasUnprovenUsdcPrepay(tx, parcel.id)').length - 1).toBe(1);
    expect(service).toContain(`USDC_PREPAY_BUCKETED_MARKER = '${USDC_PREPAY_BUCKETED_MARKER}'`);
    expect(USDC_PREPAY_UNPROVEN_CODE).toBe('usdc_prepay_unproven');
  });

  it('the REST release maps the 409 through settlementError with the clear text', () => {
    expect(routes).toContain(
      "return c.json(\n    { error: err.code, code: err.code, ...err.details },\n    err.status as 400 | 403 | 404 | 409 | 429 | 503,\n  );",
    );
    const handler = routes.slice(
      routes.indexOf("landRoutes.post('/parcels/:parcelId/release'"),
      routes.indexOf('\nif (false) {', routes.indexOf("landRoutes.post('/parcels/:parcelId/release'")),
    );
    expect(handler).toContain('const released = await settleTenureRelease(');
    expect(handler).toContain('} catch (err) {\n    return settlementError(c, err);\n  }');
  });

  it('both sweeper draw statements consume the bucket first; the pool revert zeroes it', () => {
    const drawClause =
      'deposit_usdc_funded_ct = deposit_usdc_funded_ct - LEAST(${decision.drawnCt}, deposit_usdc_funded_ct),';
    expect(sweeper.split(drawClause).length - 1).toBe(2);
    expect(sweeper.split('deposit_remaining_ct = deposit_remaining_ct - ${decision.drawnCt},').length - 1).toBe(2);
    expect(sweeper).toContain('deposit_remaining_ct = NULL,\n            deposit_usdc_funded_ct = 0,');
    expect(sweeper).toContain('deposit_remaining_ct, deposit_usdc_funded_ct, hold_subject');
  });

  it('claims and the deed flip reset the bucket with the remainder', () => {
    expect(service).toContain('deposit_remaining_ct = ${escrowCt},\n                  deposit_usdc_funded_ct = 0,');
    expect(service).toContain('deposit_remaining_ct = NULL,\n                  deposit_usdc_funded_ct = 0,');
    expect(deed).toContain('deposit_remaining_ct = NULL,\n                deposit_usdc_funded_ct = 0,');
  });

  it('every live escrow writer outside dead code names the bucket', () => {
    // routes/land.ts escrow writers are all inside `if (false)` (retired
    // Phase-B routes); the live routes delegate to land-tenure-settlement.
    const live = routes.replace(/\nif \(false\) \{[\s\S]*?\n\}\n/g, '\n');
    expect(live).not.toMatch(/deposit_remaining_ct\s*=/);
    expect(fulfiller).toContain('deposit_usdc_funded_ct = deposit_usdc_funded_ct + ${amountCt},');
  });

  it('the fulfiller keeps the provenance stamp and the reason literal', () => {
    expect(fulfiller).toContain(
      `USDC_RENT_PREPAY_NON_REFUNDABLE_REASON = '${USDC_RENT_PREPAY_FORFEIT_REASON}'`,
    );
    expect(fulfiller).toContain('refundable: false,');
    expect(fulfiller).toContain('tenancyAcquiredAt,');
    expect(fulfiller).toContain(`USDC_PREPAY_BUCKETED_MARKER = '${USDC_PREPAY_BUCKETED_MARKER}'`);
    expect(fulfiller).toContain('[USDC_PREPAY_BUCKETED_MARKER]: true,');
    expect(fulfiller).not.toContain('refundable: true');
    const terms =
      'USDC rent prepay is non-refundable. If you release the plot early, the USDC-funded rent is not returned.';
    expect(fulfiller).toContain(terms);
    expect(terms).not.toContain('—');
  });

  it('the REST release response reports the forfeit', () => {
    expect(routes).toContain('forfeitedUsdcPrepayCt: released.forfeitedUsdcPrepayCt,');
  });

  it('the drizzle schema declares the column and both CHECKs', () => {
    expect(schema).toContain("depositUsdcFundedCt: integer('deposit_usdc_funded_ct').notNull().default(0),");
    expect(schema).toContain("'land_parcels_deposit_usdc_funded_nonneg'");
    expect(schema).toContain("'land_parcels_deposit_usdc_funded_within_remaining'");
  });

  it('migration 0078 is additive and idempotent, with NO backfill (Codex round 2)', () => {
    const sqlOnly = migration.replace(/--[^\n]*/g, '');
    expect(sqlOnly).toContain(
      'ADD COLUMN IF NOT EXISTS "deposit_usdc_funded_ct" integer NOT NULL DEFAULT 0;',
    );
    expect(sqlOnly).not.toMatch(/\bDROP\b/i);
    expect(sqlOnly).not.toMatch(/ALTER TYPE/i);
    // No backfill of any kind: no row writes, no read of the audit table.
    expect(sqlOnly).not.toMatch(/\bUPDATE\b/i);
    expect(sqlOnly).not.toMatch(/\bINSERT\b/i);
    expect(sqlOnly).not.toMatch(/\bDELETE\b/i);
    expect(sqlOnly).not.toContain('land_transactions');
    expect(sqlOnly).not.toContain('tenancyAcquiredAt');
    // Every ADD CONSTRAINT sits behind its own pg_constraint guard, so a rerun
    // is a no-op. Both CHECKs hold at the column default 0 for existing rows:
    // "0 >= 0", and the second CHECK's first arm is "= 0".
    expect(sqlOnly.split('ADD CONSTRAINT').length - 1).toBe(2);
    expect(sqlOnly.split('IF NOT EXISTS (\n    SELECT 1 FROM pg_constraint').length - 1).toBe(2);
    expect(sqlOnly).toContain("conname = 'land_parcels_deposit_usdc_funded_nonneg'");
    expect(sqlOnly).toContain("conname = 'land_parcels_deposit_usdc_funded_within_remaining'");
    expect(sqlOnly).toContain('CHECK ("deposit_usdc_funded_ct" >= 0) NOT VALID;');
    expect(sqlOnly).toMatch(/CHECK \(\s*"deposit_usdc_funded_ct" = 0\s*OR \(/);
    expect(sqlOnly.indexOf('ADD COLUMN IF NOT EXISTS')).toBeLessThan(sqlOnly.indexOf('ADD CONSTRAINT'));
  });

  it('migration 0078 bounds lock waits and adds each CHECK NOT VALID, then VALIDATEs it (Codex round 3)', () => {
    const sqlOnly = migration.replace(/--[^\n]*/g, '');
    // migrate-ci runs the file as ONE implicit transaction, so SET LOCAL is the
    // first statement and lasts exactly for the file.
    expect(sqlOnly.trim().startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
    expect(sqlOnly.split('lock_timeout').length - 1).toBe(1);
    // Both CHECKs are added NOT VALID (no scan under the ADD) ...
    expect(sqlOnly.split(') NOT VALID;').length - 1).toBe(2);
    // ... and each is VALIDATEd after its ADD, behind its own guard that runs
    // only while the constraint is not yet validated (a rerun is a no-op).
    expect(sqlOnly.split('VALIDATE CONSTRAINT').length - 1).toBe(2);
    expect(sqlOnly.split('AND NOT convalidated').length - 1).toBe(2);
    for (const name of [
      'land_parcels_deposit_usdc_funded_nonneg',
      'land_parcels_deposit_usdc_funded_within_remaining',
    ]) {
      const add = sqlOnly.indexOf(`ADD CONSTRAINT "${name}"`);
      const validate = sqlOnly.indexOf(`VALIDATE CONSTRAINT "${name}";`);
      expect(add).toBeGreaterThan(-1);
      expect(validate).toBeGreaterThan(add);
    }
  });
});
