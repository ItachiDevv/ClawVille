/**
 * M8 — USDC rent prepay is NON-REFUNDABLE (founder decision 2026-10-04).
 *
 * Three tiers:
 *   1. PURE split math (`splitDepositEscrowByFunding`): vCLAW-only refunds as
 *      before, USDC-only forfeits, mixed splits, draws consume USDC first, and a
 *      non-reconciling replay can only forfeit MORE (never refund USDC value).
 *   2. PURE tenancy classification (`depositEscrowEventsForTenancy`): the
 *      first-week rent row is not an escrow draw, other tenancies' USDC rows are
 *      excluded by their `tenancyAcquiredAt` stamp, legacy unstamped rows fall
 *      back to the created_at window.
 *   3. `settleTenureRelease` end to end against a scripted fake tx: the refund
 *      credit carries only the vCLAW part, the USDC part is recorded as
 *      `forfeitedUsdcPrepayCt` in the response + the land_transactions row, and
 *      NO ledger credit (refund or treasury) is ever written for it.
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

import * as realDatabase from '@clawville/database';
import * as realLedger from '../claw-token-ledger';

// ── LEAK GUARD: mock.module is process-global; delegate to the real modules
// once this suite is done. Originals are captured BEFORE mock.module runs.
let intercept = true;
afterAll(() => {
  intercept = false;
});
const REAL_db = realDatabase.db;
const REAL_credit = realLedger.creditClawTokens;
const REAL_debit = realLedger.debitClawTokens;

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
const PARCEL_CODE = 'parcel-starter-01';
const ACQUIRED = '2026-09-01T00:00:00.000Z';
const PRIOR_TENANCY = '2026-08-01T00:00:00.000Z';

let parcelRemaining = 0;
let escrowRows: Row[] = [];
const executed: Captured[] = [];
const credits: realLedger.LedgerCreditInput[] = [];
const debits: unknown[] = [];

function route(q: unknown): Row[] {
  const flat = flattenSql(q);
  executed.push(flat);
  const t = flat.text;
  if (t.includes('FROM avatars') && t.includes('FOR UPDATE')) return [{ user_id: USER }];
  if (t.includes('FROM land_tenure_settlements')) return [];
  if (t.includes('FROM land_parcels WHERE parcel_code')) {
    return [
      {
        id: PARCEL_ID,
        parcel_code: PARCEL_CODE,
        tier: 'starter',
        status: 'owned',
        owner_avatar_id: AVATAR,
        acquired_at: new Date(ACQUIRED),
        price_ct: null,
        rent_ct_weekly: 1000,
        tenure: 'deposit',
        deposit_ct: 2000,
        deposit_remaining_ct: parcelRemaining,
        hold_threshold_ct: null,
        grace_until: null,
        grid_x: 1,
        grid_y: 2,
      },
    ];
  }
  if (t.includes('FROM land_transactions')) return escrowRows;
  return [];
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
    throw new Error('unexpected debit on a release path');
  },
}));

const settlement = await import('../land-tenure-settlement');
const {
  splitDepositEscrowByFunding,
  depositEscrowEventsForTenancy,
  settleTenureRelease,
  USDC_RENT_PREPAY_FORFEIT_REASON,
} = settlement;

if (!DB_URL_WAS_SET) delete process.env.DATABASE_URL;

function ledgerRow(
  kind: string,
  amount: number,
  createdAt: string,
  extra: Partial<Row> = {},
): Row {
  return {
    kind,
    amount_ct: amount,
    has_debit: kind === 'land_deposit_escrow' || kind === 'land_deposit_topup',
    meta_tenure: null,
    tenancy_acquired_at: null,
    created_at: new Date(createdAt),
    ...extra,
  };
}
const escrowIn = (amount: number, at = ACQUIRED) => ledgerRow('land_deposit_escrow', amount, at);
const topup = (amount: number, at: string) => ledgerRow('land_deposit_topup', amount, at);
const usdcPrepay = (amount: number, at: string, tenancy: string | null = ACQUIRED) =>
  ledgerRow('land_deposit_prepay_usdc', amount, at, { has_debit: false, tenancy_acquired_at: tenancy });
const draw = (amount: number, at: string) =>
  ledgerRow('rent_payment', amount, at, { has_debit: false, meta_tenure: 'deposit' });
const firstWeek = (amount: number) =>
  ledgerRow('rent_payment', amount, ACQUIRED, { has_debit: true, meta_tenure: null });

function releaseInput(key: string) {
  return {
    identity: { kind: 'user' as const, userId: USER, avatarId: AVATAR, agentId: null },
    expectedAvatarId: AVATAR,
    expectedUserId: USER,
    expectedAgentId: null,
    parcelCode: PARCEL_CODE,
    idempotencyKey: key,
  };
}

function refundRowMeta(): Record<string, unknown> {
  const insert = executed.find(
    (q) => q.text.includes('INSERT INTO land_transactions') && q.text.includes('land_deposit_refund'),
  );
  if (!insert) throw new Error('no land_deposit_refund row');
  const meta = insert.params.find((p) => typeof p === 'string' && p.includes('voluntary_release'));
  return JSON.parse(meta as string) as Record<string, unknown>;
}

beforeEach(() => {
  executed.length = 0;
  credits.length = 0;
  debits.length = 0;
  escrowRows = [];
  parcelRemaining = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Pure split math
// ─────────────────────────────────────────────────────────────────────────────

describe('M8 splitDepositEscrowByFunding (pure)', () => {
  it('vCLAW-only escrow refunds exactly as before', () => {
    const split = splitDepositEscrowByFunding(
      [
        { source: 'vclaw', amountCt: 2000 },
        { source: 'draw', amountCt: 1000 },
        { source: 'vclaw', amountCt: 500 },
      ],
      1500,
    );
    expect(split).toEqual({
      refundableVclawCt: 1500,
      forfeitedUsdcCt: 0,
      replayedVclawCt: 1500,
      replayedUsdcCt: 0,
      reconciled: true,
    });
  });

  it('USDC-only escrow forfeits everything and refunds 0', () => {
    const split = splitDepositEscrowByFunding([{ source: 'usdc', amountCt: 700 }], 700);
    expect(split.refundableVclawCt).toBe(0);
    expect(split.forfeitedUsdcCt).toBe(700);
    expect(split.reconciled).toBe(true);
  });

  it('mixed escrow refunds the vCLAW part and forfeits the USDC part', () => {
    const split = splitDepositEscrowByFunding(
      [
        { source: 'vclaw', amountCt: 2000 },
        { source: 'usdc', amountCt: 500 },
      ],
      2500,
    );
    expect(split.refundableVclawCt).toBe(2000);
    expect(split.forfeitedUsdcCt).toBe(500);
  });

  it('draws consume the USDC-funded part first (nobody pays a week twice)', () => {
    // 2000 vCLAW deposit, 1500 USDC prepay, then one 1000 weekly draw.
    const split = splitDepositEscrowByFunding(
      [
        { source: 'vclaw', amountCt: 2000 },
        { source: 'usdc', amountCt: 1500 },
        { source: 'draw', amountCt: 1000 },
      ],
      2500,
    );
    expect(split.refundableVclawCt).toBe(2000);
    expect(split.forfeitedUsdcCt).toBe(500);
    // A draw larger than the USDC bucket spills into vCLAW.
    const spill = splitDepositEscrowByFunding(
      [
        { source: 'vclaw', amountCt: 2000 },
        { source: 'usdc', amountCt: 300 },
        { source: 'draw', amountCt: 1000 },
      ],
      1300,
    );
    expect(spill).toMatchObject({ refundableVclawCt: 1300, forfeitedUsdcCt: 0, reconciled: true });
  });

  it('a draw BEFORE the USDC prepay is paid from vCLAW; the later prepay stays forfeitable', () => {
    const split = splitDepositEscrowByFunding(
      [
        { source: 'vclaw', amountCt: 2000 },
        { source: 'draw', amountCt: 1000 },
        { source: 'usdc', amountCt: 1000 },
      ],
      2000,
    );
    expect(split.refundableVclawCt).toBe(1000);
    expect(split.forfeitedUsdcCt).toBe(1000);
  });

  it('a non-reconciling replay can only forfeit MORE, never refund USDC value', () => {
    // Replay says 1000 USDC is still escrowed but the live remainder is 600.
    const short = splitDepositEscrowByFunding(
      [
        { source: 'vclaw', amountCt: 400 },
        { source: 'usdc', amountCt: 1000 },
      ],
      600,
    );
    expect(short).toMatchObject({ refundableVclawCt: 0, forfeitedUsdcCt: 600, reconciled: false });
    // Unexplained extra escrow (no recorded rail) is not USDC: every USDC
    // credit records its row in the same tx.
    const extra = splitDepositEscrowByFunding([{ source: 'usdc', amountCt: 100 }], 900);
    expect(extra).toMatchObject({ refundableVclawCt: 800, forfeitedUsdcCt: 100, reconciled: false });
  });

  it('always conserves: refund + forfeit == remainder', () => {
    for (const remaining of [0, 1, 999, 2500]) {
      const s = splitDepositEscrowByFunding(
        [
          { source: 'vclaw', amountCt: 1200 },
          { source: 'usdc', amountCt: 1300 },
        ],
        remaining,
      );
      expect(s.refundableVclawCt + s.forfeitedUsdcCt).toBe(remaining);
      expect(s.refundableVclawCt).toBeGreaterThanOrEqual(0);
      expect(s.forfeitedUsdcCt).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Pure tenancy classification
// ─────────────────────────────────────────────────────────────────────────────

describe('M8 depositEscrowEventsForTenancy (pure)', () => {
  it('excludes the first-week rent row, other tenancies, and pre-tenancy rows', () => {
    const events = depositEscrowEventsForTenancy(
      [
        usdcPrepay(400, '2026-08-05T00:00:00.000Z', PRIOR_TENANCY), // other tenancy
        firstWeek(1000), // debited first week, not an escrow draw
        escrowIn(2000),
        usdcPrepay(500, '2026-09-02T00:00:00.000Z'),
        draw(1000, '2026-09-08T00:00:00.000Z'),
        topup(300, '2026-09-09T00:00:00.000Z'),
      ] as never,
      ACQUIRED,
    );
    expect(events).toEqual([
      { source: 'vclaw', amountCt: 2000 },
      { source: 'usdc', amountCt: 500 },
      { source: 'draw', amountCt: 1000 },
      { source: 'vclaw', amountCt: 300 },
    ]);
  });

  it('binds a USDC row by its tenancyAcquiredAt stamp, not by created_at', () => {
    // Stamped for THIS tenancy but with a created_at before acquired_at (a
    // settle tx that started before the claim committed): still counted.
    const events = depositEscrowEventsForTenancy(
      [usdcPrepay(250, '2026-08-31T23:59:59.000Z', ACQUIRED)] as never,
      ACQUIRED,
    );
    expect(events).toEqual([{ source: 'usdc', amountCt: 250 }]);
  });

  it('legacy unstamped USDC rows fall back to the created_at window', () => {
    const events = depositEscrowEventsForTenancy(
      [
        usdcPrepay(100, '2026-08-20T00:00:00.000Z', null),
        usdcPrepay(200, '2026-09-03T00:00:00.000Z', null),
      ] as never,
      ACQUIRED,
    );
    expect(events).toEqual([{ source: 'usdc', amountCt: 200 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. settleTenureRelease end to end (scripted tx)
// ─────────────────────────────────────────────────────────────────────────────

describe('M8 settleTenureRelease — USDC-funded escrow forfeits', () => {
  it('USDC-funded prepay: 0 refunded, forfeited amount recorded, NO credit at all', async () => {
    parcelRemaining = 1500;
    escrowRows = [usdcPrepay(1500, '2026-09-02T00:00:00.000Z')];
    const out = await settleTenureRelease(releaseInput('m8-usdc-only'));

    expect(out.fresh).toBe(true);
    expect(out.refundedCt).toBe(0);
    expect(out.forfeitedUsdcPrepayCt).toBe(1500);
    expect(out.forfeitReason).toBe('usdc_rent_prepay_non_refundable');
    expect(credits).toEqual([]); // no vCLAW refund, no treasury mint
    expect(debits).toEqual([]);

    const meta = refundRowMeta();
    expect(meta).toMatchObject({
      reason: 'voluntary_release',
      tenure: 'deposit',
      refundedCt: 0,
      escrowRemainingCt: 1500,
      forfeitedUsdcPrepayCt: 1500,
      forfeitReason: 'usdc_rent_prepay_non_refundable',
      escrowFunding: { replayedVclawCt: 0, replayedUsdcCt: 1500, reconciled: true },
    });
    // The parcel still reverts to the pool and the escrow column clears.
    expect(executed.some((q) => q.text.includes('deposit_remaining_ct = NULL'))).toBe(true);
    // The persisted idempotency response carries the forfeit for replays.
    const persisted = executed.find((q) => q.text.includes('INSERT INTO land_tenure_settlements'));
    const response = JSON.parse(
      persisted!.params.find((p) => typeof p === 'string' && p.includes('forfeitedUsdcPrepayCt')) as string,
    ) as Record<string, unknown>;
    expect(response).toMatchObject({ refundedCt: 0, forfeitedUsdcPrepayCt: 1500 });
  });

  it('vCLAW-funded prepay still refunds in full, exactly as before', async () => {
    parcelRemaining = 1300;
    escrowRows = [
      firstWeek(1000),
      escrowIn(2000),
      draw(1000, '2026-09-08T00:00:00.000Z'),
      topup(300, '2026-09-09T00:00:00.000Z'),
    ];
    const out = await settleTenureRelease(releaseInput('m8-vclaw-only'));

    expect(out.refundedCt).toBe(1300);
    expect(out.forfeitedUsdcPrepayCt).toBe(0);
    expect(out.forfeitReason).toBeUndefined();
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({
      avatarId: AVATAR,
      amount: 1300,
      reason: 'land_deposit_refund',
      metadata: { parcelId: PARCEL_ID, parcelCode: PARCEL_CODE },
    });
    expect((credits[0]!.metadata as Record<string, unknown>).forfeitedUsdcPrepayCt).toBeUndefined();
    expect(refundRowMeta()).toMatchObject({ refundedCt: 1300, forfeitedUsdcPrepayCt: 0 });
    expect(refundRowMeta().forfeitReason).toBeUndefined();
  });

  it('mixed escrow: refunds only the vCLAW part, forfeits the USDC part', async () => {
    // 2000 vCLAW escrow + 1500 USDC prepay, one 1000 draw (paid by USDC first).
    parcelRemaining = 2500;
    escrowRows = [
      firstWeek(1000),
      escrowIn(2000),
      usdcPrepay(1500, '2026-09-02T00:00:00.000Z'),
      draw(1000, '2026-09-08T00:00:00.000Z'),
    ];
    const out = await settleTenureRelease(releaseInput('m8-mixed'));

    expect(out.refundedCt).toBe(2000);
    expect(out.forfeitedUsdcPrepayCt).toBe(500);
    expect(out.refundedCt + out.forfeitedUsdcPrepayCt).toBe(parcelRemaining);
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({
      amount: 2000,
      reason: 'land_deposit_refund',
      metadata: {
        forfeitedUsdcPrepayCt: 500,
        forfeitReason: USDC_RENT_PREPAY_FORFEIT_REASON,
      },
    });
    const meta = refundRowMeta();
    expect(meta).toMatchObject({
      refundedCt: 2000,
      escrowRemainingCt: 2500,
      forfeitedUsdcPrepayCt: 500,
      forfeitReason: 'usdc_rent_prepay_non_refundable',
    });
    // The land_transactions refund row amount stays the REFUNDED amount.
    const insert = executed.find((q) => q.text.includes('land_deposit_refund') && q.text.includes('INSERT'));
    expect(insert!.params).toContain(2000);
  });

  it('reads the escrow ledger for THIS parcel with the tenancy window', async () => {
    parcelRemaining = 0;
    await settleTenureRelease(releaseInput('m8-query-shape'));
    const q = executed.find((x) => x.text.includes('FROM land_transactions'));
    expect(q).toBeDefined();
    expect(q!.text).toContain("kind = 'land_deposit_prepay_usdc'");
    expect(q!.text).toContain("metadata ->> 'tenancyAcquiredAt'");
    expect(q!.text).toContain('ORDER BY created_at ASC, id ASC');
    expect(q!.params).toContain(PARCEL_ID);
    expect(q!.params).toContain(ACQUIRED);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Provenance + disclosure wiring (structural)
// ─────────────────────────────────────────────────────────────────────────────

describe('M8 provenance + disclosure wiring', () => {
  const API_SRC = join(import.meta.dir, '..', '..');
  const fulfiller = readFileSync(
    join(API_SRC, 'services', 'checkout-fulfillers', 'rent-prepay.ts'),
    'utf8',
  );
  const routes = readFileSync(join(API_SRC, 'routes', 'land.ts'), 'utf8');

  it('the fulfiller stamps the same reason literal and the tenancy binding', () => {
    expect(fulfiller).toContain(
      `USDC_RENT_PREPAY_NON_REFUNDABLE_REASON = '${USDC_RENT_PREPAY_FORFEIT_REASON}'`,
    );
    expect(fulfiller).toContain('refundable: false,');
    expect(fulfiller).toContain('tenancyAcquiredAt,');
    expect(fulfiller).not.toContain('refundable: true');
  });

  it('the checkout disclosure is plain language with no em dash', () => {
    const terms =
      'USDC rent prepay is non-refundable. If you release the plot early, the USDC-funded rent is not returned.';
    expect(fulfiller).toContain(terms);
    expect(terms).not.toContain('—');
  });

  it('the REST release response reports the forfeit', () => {
    expect(routes).toContain('forfeitedUsdcPrepayCt: released.forfeitedUsdcPrepayCt,');
  });
});
