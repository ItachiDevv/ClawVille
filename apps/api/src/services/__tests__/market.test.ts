/**
 * P2P MARKETPLACE v1 (Tokenomics C4) — unit tests.
 * LIGHT + DETERMINISTIC — no real Postgres, no RPC, no facilitator network.
 *
 * INVARIANTS PROVEN (the C4 trap-list test set):
 *   1. SELLER LICENSE: below-threshold refuses, exactly-at-threshold passes,
 *      FAIL-SOFT (balance unavailable) REFUSES — never fail-open; human reads
 *      the linked wallet, agent reads its custodial avatars.wallet_address;
 *      env retunes the threshold but can never disable it.
 *   2. EARNED-BUNDLE BLOCKED: earned_bundle refuses `earned_not_available`
 *      with ZERO DB touches.
 *   3. LISTING STATE MACHINE: create takes the land lock order (advisory →
 *      parcel FOR UPDATE) then INSERTs listing + deed lock in ONE tx;
 *      owner/tenure guards refuse; a lock conflict (or the live-item 23505)
 *      aborts the whole tx → `parcel_already_listed`. Cancel flips
 *      active→cancelled + releases the lock; wrong-seller / non-active refuse.
 *   4. FLAG GATE: with MARKETPLACE_SETTLE_ENABLED unset, the fulfiller throws
 *      CheckoutFulfillmentRefusal('marketplace_settle_disabled') BEFORE any
 *      DB touch, and the quote resolver + preflight refuse the same code
 *      (no 402 is ever issuable while gated). 'TRUE'/'false' stay disabled.
 *   5. SETTLEMENT-INTENT SHAPE (flag on): rake = 4.44% (444 bps) EXACT µUSD,
 *      seller payout = 95.56%, conservation rake+payout==basis; the FULL USDC
 *      is enqueued as a C3 CLV buy on the SAME tx; payout row is QUEUED
 *      'pending_review'; ZERO internal-vCLAW ledger calls; no SQL touches
 *      avatars/claw_tokens; deed transfer recorded as a pending Codex-gated
 *      intent (land ownership untouched).
 *   6. REPLAY DOES NOT DOUBLE-PAY: an existing settlement row for the
 *      checkoutId short-circuits to a no-op replay — zero new enqueues, zero
 *      new intent rows.
 *
 * Harness mirrors x402-checkout.test.ts exactly (fake @clawville/database with
 * a programmable execute queue; intercept-guarded delegating mocks so the real
 * implementations survive for later suites in bun's shared module registry).
 */

// Crash-loud module-load env BEFORE imports (the fulfiller pulls the checkout
// service → routes/ct-topup → require-auth-or-agent chain). DATABASE_URL is
// SCOPED to module init (deleted after imports) so DB-gated suites later in
// the shared bun process keep their skip-when-no-DB behavior.
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
// Deterministic gate state: the flag + threshold envs start UNSET.
const PRIOR_SETTLE_FLAG = process.env.MARKETPLACE_SETTLE_ENABLED;
delete process.env.MARKETPLACE_SETTLE_ENABLED;
const PRIOR_MIN_CLV = process.env.MARKET_SELLER_MIN_CLV;
delete process.env.MARKET_SELLER_MIN_CLV;

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import * as realDatabase from '@clawville/database';
import * as realLedger from '../claw-token-ledger';
import * as realSwap from '../clv-swap-executor';
import * as realClv from '../linked-wallet-clv-balance';

// ── LEAK GUARD (same mechanism as x402-checkout.test.ts) ────────────────────
let intercept = true;
afterAll(() => {
  intercept = false;
  if (PRIOR_SETTLE_FLAG === undefined) delete process.env.MARKETPLACE_SETTLE_ENABLED;
  else process.env.MARKETPLACE_SETTLE_ENABLED = PRIOR_SETTLE_FLAG;
  if (PRIOR_MIN_CLV === undefined) delete process.env.MARKET_SELLER_MIN_CLV;
  else process.env.MARKET_SELLER_MIN_CLV = PRIOR_MIN_CLV;
});
const REAL_credit = realLedger.creditClawTokens;
const REAL_debit = realLedger.debitClawTokens;
const REAL_mintEarned = realLedger.mintEarned;
const REAL_transfer = realLedger.transferClawTokens;
const REAL_enqueueClvBuy = realSwap.enqueueClvBuy;
const REAL_getLinked = realClv.getLinkedWalletClvBalance;
const REAL_getWallet = realClv.getWalletClvBalance;

// ── @clawville/database stub ────────────────────────────────────────────────
type Row = Record<string, unknown>;

/** Programmable per-call queue: Row[] resolves, Error throws (23505 sims). */
const executeCalls: unknown[] = [];
let executeQueue: Array<Row[] | Error> = [];
async function fakeExecute(q: unknown): Promise<Row[]> {
  executeCalls.push(q);
  if (executeQueue.length === 0) return [];
  const next = executeQueue.shift()!;
  if (next instanceof Error) throw next;
  return next;
}

let txRan = 0;
const fakeTx = { execute: fakeExecute };

let avatarFindFirstRow: Row | undefined;
const fakeDb = {
  ...(realDatabase as unknown as { db: Record<string, unknown> }).db,
  execute: fakeExecute,
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    txRan += 1;
    return fn(fakeTx);
  },
  query: {
    avatars: {
      findFirst: async (_opts: unknown) => avatarFindFirstRow,
    },
  },
};

mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: fakeDb,
}));

// ── claw-token-ledger: spies — the CONSERVATION assertions ──────────────────
const ledgerCalls: string[] = [];
mock.module('../claw-token-ledger', () => ({
  ...realLedger,
  creditClawTokens: async (input: realLedger.LedgerCreditInput, tx?: unknown) => {
    if (!intercept) return REAL_credit(input, tx as never);
    ledgerCalls.push('credit');
    throw new Error(`unexpected creditClawTokens on a marketplace path: ${JSON.stringify(input)}`);
  },
  debitClawTokens: async (input: realLedger.LedgerDebitInput, tx?: unknown) => {
    if (!intercept) return REAL_debit(input, tx as never);
    ledgerCalls.push('debit');
    throw new Error(`unexpected debitClawTokens on a marketplace path: ${JSON.stringify(input)}`);
  },
  mintEarned: async (input: Parameters<typeof realLedger.mintEarned>[0], tx?: unknown) => {
    if (!intercept) return REAL_mintEarned(input, tx as never);
    ledgerCalls.push('mintEarned');
    throw new Error(`unexpected mintEarned on a marketplace path: ${JSON.stringify(input)}`);
  },
  transferClawTokens: async (input: Parameters<typeof realLedger.transferClawTokens>[0]) => {
    if (!intercept) return REAL_transfer(input);
    ledgerCalls.push('transfer');
    throw new Error(`unexpected transferClawTokens on a marketplace path: ${JSON.stringify(input)}`);
  },
}));

// ── clv-swap-executor: record enqueueClvBuy + the composed tx ───────────────
const enqueueCalls: Array<{ input: Record<string, unknown>; tx: unknown }> = [];
mock.module('../clv-swap-executor', () => ({
  ...realSwap,
  enqueueClvBuy: async (input: realSwap.EnqueueClvBuyInput, tx?: unknown) => {
    if (!intercept) return REAL_enqueueClvBuy(input, tx as never);
    enqueueCalls.push({ input: input as unknown as Record<string, unknown>, tx });
    return { queueId: 'queue-77' };
  },
}));

// ── linked-wallet-clv-balance: programmable license-gate inputs ─────────────
let linkedResult: Awaited<ReturnType<typeof realClv.getLinkedWalletClvBalance>> = {
  linked: false,
  walletPubkey: null,
  clv: {
    available: false,
    amountAtomic: null,
    decimals: null,
    uiAmount: null,
    cached: false,
    fetchedAt: null,
  },
};
let walletResult: realClv.ClvBalanceResult = {
  available: false,
  amountAtomic: null,
  decimals: null,
  uiAmount: null,
  cached: false,
  fetchedAt: null,
};
const walletBalanceCalls: string[] = [];
mock.module('../linked-wallet-clv-balance', () => ({
  ...realClv,
  getLinkedWalletClvBalance: async (userId: string) => {
    if (!intercept) return REAL_getLinked(userId);
    return linkedResult;
  },
  getWalletClvBalance: async (pubkey: string) => {
    if (!intercept) return REAL_getWallet(pubkey);
    walletBalanceCalls.push(pubkey);
    return walletResult;
  },
}));

// Import AFTER the mocks. The fulfiller import is the side-effect registration
// the checkout route relies on — the same mechanism under test.
const checkout = await import('../x402-checkout');
const market = await import('../checkout-fulfillers/marketplace-purchase');
const listings = await import('../market-listings');

// Route chain loaded — drop the module-init DATABASE_URL placeholder.
if (!DB_URL_WAS_SET) {
  delete process.env.DATABASE_URL;
}

// ── shared fixtures ──────────────────────────────────────────────────────────

const SELLER = 'a0000000-0000-4000-8000-00000000se11';
const BUYER = 'a0000000-0000-4000-8000-0000000buy3r';
const PARCEL = 'a1a1a1a1-0000-4000-8000-000000000001';
const LISTING = 'b2b2b2b2-0000-4000-8000-000000000002';
const CHECKOUT = 'c3c3c3c3-0000-4000-8000-000000000003';

const humanSubject: import('../x402-checkout').CheckoutSubject = {
  avatarId: SELLER,
  userId: 'user-1',
  kind: 'user',
};
const agentSubject: import('../x402-checkout').CheckoutSubject = {
  avatarId: SELLER,
  userId: 'agent-user-1',
  kind: 'agent',
};

function clv(uiAmount: number | null, available = true): realClv.ClvBalanceResult {
  return {
    available,
    amountAtomic: uiAmount == null ? null : String(Math.round(uiAmount * 1e9)),
    decimals: 9,
    uiAmount,
    cached: false,
    fetchedAt: new Date().toISOString(),
  };
}

function listingRow(overrides: Row = {}): Row {
  return {
    id: LISTING,
    seller_avatar_id: SELLER,
    item_kind: 'land_deed',
    item_ref: PARCEL,
    price_vclaw: 500,
    status: 'active',
    escrow_state: 'deed_locked',
    seller_wallet_pubkey: 'SellerWallet1111111111111111111111111111111',
    created_at: '2026-07-07T00:00:00Z',
    expires_at: null,
    ...overrides,
  };
}

function parcelRow(overrides: Row = {}): Row {
  return {
    id: PARCEL,
    parcel_code: 'parcel-b-01',
    owner_avatar_id: SELLER,
    tenure: 'owned',
    ...overrides,
  };
}

/** Recursive drizzle-SQL flattener (handles nested sql.raw fragments). */
function flattenSql(q: unknown): { text: string; params: unknown[] } {
  const out = { text: '', params: [] as unknown[] };
  const walk = (node: unknown) => {
    const chunks = (node as { queryChunks?: unknown[] })?.queryChunks;
    if (!Array.isArray(chunks)) return false;
    for (const ch of chunks) {
      const v = (ch as { value?: unknown } | null)?.value;
      if (ch && typeof ch === 'object' && Array.isArray(v) && v.every((s) => typeof s === 'string')) {
        out.text += v.join('');
      } else if (ch && typeof ch === 'object' && Array.isArray((ch as { queryChunks?: unknown[] }).queryChunks)) {
        walk(ch); // nested SQL fragment (sql.raw column lists etc.)
      } else {
        out.text += ` $${out.params.length + 1} `;
        out.params.push(ch);
      }
    }
    return true;
  };
  walk(q);
  return out;
}

function sqlTexts(): string[] {
  return executeCalls.map((q) => flattenSql(q).text);
}

beforeEach(() => {
  executeCalls.length = 0;
  executeQueue = [];
  ledgerCalls.length = 0;
  enqueueCalls.length = 0;
  walletBalanceCalls.length = 0;
  txRan = 0;
  avatarFindFirstRow = undefined;
  delete process.env.MARKETPLACE_SETTLE_ENABLED;
  delete process.env.MARKET_SELLER_MIN_CLV;
});

// ─────────────────────────────────────────────────────────────────────────────
// 0. Registration + rake math
// ─────────────────────────────────────────────────────────────────────────────

describe('marketplace_purchase — registration + rake split', () => {
  it('fulfiller self-registered under marketplace_purchase via side-effect import', () => {
    expect(checkout.getFulfiller('marketplace_purchase')).toBeDefined();
  });

  it('rake split is EXACT µUSD conservation at every amount (444 + 9556 = 10000 bps)', () => {
    for (const cents of [1, 3, 499, 500, 12_345, 999_999, 1_000_000]) {
      const s = market.splitMarketplaceUsd(cents);
      const toMicro = (v: string) => {
        const [i, f] = v.split('.');
        return BigInt(i!) * 1_000_000n + BigInt(f!);
      };
      expect(toMicro(s.rakeUsd) + toMicro(s.sellerPayoutUsd)).toBe(BigInt(cents) * 10_000n);
      expect(toMicro(s.totalUsd)).toBe(BigInt(cents) * 10_000n);
      expect(s.rakeUsd).toMatch(/^\d+\.\d{6}$/);
      expect(s.sellerPayoutUsd).toMatch(/^\d+\.\d{6}$/);
    }
    // The canonical example: $5.00 → $0.222000 rake + $4.778000 seller.
    const five = market.splitMarketplaceUsd(500);
    expect(five).toEqual({ rakeUsd: '0.222000', sellerPayoutUsd: '4.778000', totalUsd: '5.000000' });
    expect(market.MARKETPLACE_RAKE_BPS).toBe(444);
    expect(market.MARKETPLACE_SELLER_BPS).toBe(9556);
  });

  it.each([[0], [-5], [2.5]])('rake split rejects non-positive/fractional cents (%p)', (bad) => {
    expect(() => market.splitMarketplaceUsd(bad as number)).toThrow(/positive integer/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Seller license — threshold + fail-soft (trap 5) + E5 wallet split
// ─────────────────────────────────────────────────────────────────────────────

describe('checkSellerLicense — CLV Resident license', () => {
  it('human BELOW threshold refuses seller_license_required (reports both numbers)', async () => {
    linkedResult = { linked: true, walletPubkey: 'HumanWallet1', clv: clv(49_999.999) };
    const res = await listings.checkSellerLicense(humanSubject);
    expect(res).toEqual({
      ok: false,
      code: 'seller_license_required',
      thresholdClv: 50_000,
      clvUiAmount: 49_999.999,
    });
  });

  it('human EXACTLY AT the 50,000 threshold passes; wallet pubkey returned for payout stamping', async () => {
    linkedResult = { linked: true, walletPubkey: 'HumanWallet1', clv: clv(50_000) };
    const res = await listings.checkSellerLicense(humanSubject);
    expect(res).toEqual({
      ok: true,
      walletPubkey: 'HumanWallet1',
      clvUiAmount: 50_000,
      thresholdClv: 50_000,
    });
  });

  it('FAIL-SOFT ⇒ REFUSE: available:false refuses clv_balance_unavailable (never fail-open)', async () => {
    linkedResult = { linked: true, walletPubkey: 'HumanWallet1', clv: clv(null, false) };
    const res = await listings.checkSellerLicense(humanSubject);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('clv_balance_unavailable');
  });

  it('human with no linked wallet refuses wallet_not_linked', async () => {
    linkedResult = { linked: false, walletPubkey: null, clv: clv(null, false) };
    const res = await listings.checkSellerLicense(humanSubject);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('wallet_not_linked');
  });

  it('AGENT reads its custodial avatars.wallet_address (E5 split), passes at threshold', async () => {
    avatarFindFirstRow = { walletAddress: 'AgentCustodial1111111111111111111111111111' };
    walletResult = clv(123_456);
    const res = await listings.checkSellerLicense(agentSubject);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.walletPubkey).toBe('AgentCustodial1111111111111111111111111111');
    expect(walletBalanceCalls).toEqual(['AgentCustodial1111111111111111111111111111']);
  });

  it('agent with no custodial wallet refuses wallet_not_linked; agent fail-soft refuses too', async () => {
    avatarFindFirstRow = { walletAddress: null };
    const noWallet = await listings.checkSellerLicense(agentSubject);
    expect(noWallet.ok).toBe(false);
    if (!noWallet.ok) expect(noWallet.code).toBe('wallet_not_linked');

    avatarFindFirstRow = { walletAddress: 'AgentCustodial1111111111111111111111111111' };
    walletResult = clv(null, false);
    const softFail = await listings.checkSellerLicense(agentSubject);
    expect(softFail.ok).toBe(false);
    if (!softFail.ok) expect(softFail.code).toBe('clv_balance_unavailable');
  });

  it('MARKET_SELLER_MIN_CLV retunes the threshold; invalid/non-positive env falls back to 50,000', async () => {
    process.env.MARKET_SELLER_MIN_CLV = '100';
    linkedResult = { linked: true, walletPubkey: 'HumanWallet1', clv: clv(99) };
    const below = await listings.checkSellerLicense(humanSubject);
    expect(below.ok).toBe(false);
    if (!below.ok) expect(below.thresholdClv).toBe(100);
    linkedResult = { linked: true, walletPubkey: 'HumanWallet1', clv: clv(100) };
    expect((await listings.checkSellerLicense(humanSubject)).ok).toBe(true);

    // The gate can be retuned but never DISABLED: 0 / garbage → default.
    process.env.MARKET_SELLER_MIN_CLV = '0';
    expect(listings.resolveMarketSellerMinClv()).toBe(50_000);
    process.env.MARKET_SELLER_MIN_CLV = 'garbage';
    expect(listings.resolveMarketSellerMinClv()).toBe(50_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2+3. Listing state machine — create (escrow-lock) + cancel (unlock)
// ─────────────────────────────────────────────────────────────────────────────

describe('createMarketListing — (create) → active + deed lock', () => {
  const createInput = {
    subject: humanSubject,
    itemKind: 'land_deed' as const,
    itemRef: PARCEL,
    priceVclaw: 500,
    sellerWalletPubkey: 'HumanWallet1',
    expiresAt: null,
  };

  it('earned_bundle refuses earned_not_available with ZERO DB touches (trap 6)', async () => {
    const res = await listings.createMarketListing({ ...createInput, itemKind: 'earned_bundle' });
    expect(res).toEqual({ ok: false, code: 'earned_not_available' });
    expect(executeCalls.length).toBe(0);
    expect(txRan).toBe(0);
  });

  it('happy path: land lock order (advisory → parcel FOR UPDATE) then listing + deed lock in ONE tx', async () => {
    executeQueue = [
      [], // 1: pg_advisory_xact_lock(seller)
      [parcelRow()], // 2: parcel FOR UPDATE
      [listingRow()], // 3: INSERT market_listings RETURNING
      [{ parcel_id: PARCEL }], // 4: INSERT market_deed_locks RETURNING
    ];
    const res = await listings.createMarketListing(createInput);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.listing).toMatchObject({
      id: LISTING,
      itemKind: 'land_deed',
      itemRef: PARCEL,
      priceVclaw: 500,
      status: 'active',
      escrowState: 'deed_locked',
    });
    expect(txRan).toBe(1);
    const texts = sqlTexts();
    expect(texts[0]).toContain('pg_advisory_xact_lock');
    expect(texts[1]).toContain('FOR UPDATE');
    expect(texts[2]).toContain('INSERT INTO market_listings');
    expect(texts[2]).toContain("'deed_locked'");
    expect(texts[3]).toContain('INSERT INTO market_deed_locks');
    expect(texts[3]).toContain('ON CONFLICT (parcel_id) DO NOTHING');
    // LEDGER-ONLY: no internal vCLAW moved anywhere on the listing path.
    expect(ledgerCalls).toEqual([]);
    for (const t of texts) expect(t).not.toMatch(/claw_tokens|avatars\s+set/i);
  });

  it('non-owner refuses not_parcel_owner (no INSERT ever runs)', async () => {
    executeQueue = [[], [parcelRow({ owner_avatar_id: 'someone-else' })]];
    const res = await listings.createMarketListing(createInput);
    expect(res).toEqual({ ok: false, code: 'not_parcel_owner' });
    expect(executeCalls.length).toBe(2); // advisory + select only
  });

  it.each([['rented'], ['deposit'], ['starter'], [null]])(
    'non-deed-able tenure %p refuses not_transferable_tenure',
    async (tenure) => {
      executeQueue = [[], [parcelRow({ tenure })]];
      const res = await listings.createMarketListing(createInput);
      expect(res).toEqual({ ok: false, code: 'not_transferable_tenure' });
    },
  );

  it("tenure 'hold' is deed-able (ownership tenure)", async () => {
    executeQueue = [[], [parcelRow({ tenure: 'hold' })], [listingRow()], [{ parcel_id: PARCEL }]];
    const res = await listings.createMarketListing(createInput);
    expect(res.ok).toBe(true);
  });

  it('missing parcel refuses parcel_not_found', async () => {
    executeQueue = [[], []];
    const res = await listings.createMarketListing(createInput);
    expect(res).toEqual({ ok: false, code: 'parcel_not_found' });
  });

  it('deed-lock conflict (parcel already locked) aborts the WHOLE tx → parcel_already_listed', async () => {
    executeQueue = [
      [], // advisory
      [parcelRow()], // parcel FOR UPDATE
      [listingRow()], // INSERT listing (will be rolled back by the abort)
      [], // INSERT lock ON CONFLICT DO NOTHING → no row = already locked
    ];
    const res = await listings.createMarketListing(createInput);
    expect(res).toEqual({ ok: false, code: 'parcel_already_listed' });
  });

  it('live-item partial-UNIQUE 23505 on the listing INSERT maps to parcel_already_listed', async () => {
    executeQueue = [
      [],
      [parcelRow()],
      Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        constraint: 'market_listings_live_item_unique',
      }),
    ];
    const res = await listings.createMarketListing(createInput);
    expect(res).toEqual({ ok: false, code: 'parcel_already_listed' });
  });
});

describe('cancelMarketListing — active → cancelled + lock release', () => {
  it('happy cancel: listing FOR UPDATE → status cancelled + escrow_state NULL + DELETE lock row', async () => {
    executeQueue = [
      [listingRow()], // SELECT ... FOR UPDATE
      [listingRow({ status: 'cancelled', escrow_state: null })], // UPDATE RETURNING
      [], // DELETE market_deed_locks
    ];
    const res = await listings.cancelMarketListing({ subject: humanSubject, listingId: LISTING });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.listing.status).toBe('cancelled');
    expect(res.listing.escrowState).toBeNull();
    const texts = sqlTexts();
    expect(texts[0]).toContain('FOR UPDATE');
    expect(texts[1]).toContain("status = 'cancelled'");
    expect(texts[1]).toContain('escrow_state = NULL');
    expect(texts[2]).toContain('DELETE FROM market_deed_locks');
  });

  it('someone else cannot cancel your listing (not_your_listing)', async () => {
    executeQueue = [[listingRow()]];
    const res = await listings.cancelMarketListing({
      subject: { avatarId: BUYER, userId: 'user-2', kind: 'user' },
      listingId: LISTING,
    });
    expect(res).toEqual({ ok: false, code: 'not_your_listing' });
    expect(executeCalls.length).toBe(1); // no UPDATE / DELETE
  });

  it.each([['settled'], ['cancelled'], ['pending_settlement']])(
    'cancel from %p refuses listing_not_cancellable (only active cancels)',
    async (status) => {
      executeQueue = [[listingRow({ status })]];
      const res = await listings.cancelMarketListing({ subject: humanSubject, listingId: LISTING });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('listing_not_cancellable');
        expect(res.status).toBe(status as string);
      }
    },
  );

  it('unknown listing refuses listing_not_found', async () => {
    executeQueue = [[]];
    const res = await listings.cancelMarketListing({ subject: humanSubject, listingId: LISTING });
    expect(res).toEqual({ ok: false, code: 'listing_not_found' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. FLAG GATE — MARKETPLACE_SETTLE_ENABLED off ⇒ every layer refuses
// ─────────────────────────────────────────────────────────────────────────────

function fulfillerCtx(
  overrides: Partial<import('../x402-checkout').CheckoutFulfillmentContext> = {},
): import('../x402-checkout').CheckoutFulfillmentContext {
  return {
    tx: fakeTx as never,
    checkoutId: CHECKOUT,
    subject: { avatarId: BUYER, userId: 'user-2', kind: 'agent' },
    itemKind: 'marketplace_purchase',
    itemRef: LISTING,
    priceVclaw: 500,
    usdCents: 500,
    usdBasis: '5.00',
    txSignature: 'SIG_MKT_1',
    settlePayer: 'PayerPubkey111',
    network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    ...overrides,
  };
}

describe('marketplace_purchase — FLAG GATE (default OFF)', () => {
  it("fulfiller refuses CheckoutFulfillmentRefusal('marketplace_settle_disabled') BEFORE any DB touch", async () => {
    const fulfiller = checkout.getFulfiller('marketplace_purchase')!;
    await expect(fulfiller(fulfillerCtx())).rejects.toThrow(/marketplace_settle_disabled/);
    expect(executeCalls.length).toBe(0); // zero writes — nothing half-completes
    expect(enqueueCalls.length).toBe(0);
    expect(ledgerCalls).toEqual([]);
  });

  it('quote resolver refuses the same code with ZERO DB reads — no 402 is issuable while gated', async () => {
    const res = await market.resolveMarketplaceCheckoutItem(BUYER, LISTING);
    expect(res).toEqual({ ok: false, code: 'marketplace_settle_disabled' });
    expect(executeCalls.length).toBe(0);
  });

  it.each([['false'], ['TRUE'], ['1'], ['yes']])(
    'only the literal string true enables — %p stays disabled',
    async (v) => {
      process.env.MARKETPLACE_SETTLE_ENABLED = v as string;
      expect(market.isMarketplaceSettleEnabled()).toBe(false);
      const res = await market.resolveMarketplaceCheckoutItem(BUYER, LISTING);
      expect(res).toEqual({ ok: false, code: 'marketplace_settle_disabled' });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5+6. Settlement intent (flag ON) — shape, conservation, replay no-op
// ─────────────────────────────────────────────────────────────────────────────

describe('marketplace_purchase — settlement intent (flag ON in-test only)', () => {
  beforeEach(() => {
    process.env.MARKETPLACE_SETTLE_ENABLED = 'true';
  });

  it('quote resolver prices from the LISTING row server-side; refuses expired/own/inactive', async () => {
    executeQueue = [[listingRow()], [{ owner_avatar_id: SELLER }]];
    const ok = await market.resolveMarketplaceCheckoutItem(BUYER, LISTING);
    expect(ok).toEqual({ ok: true, priceVclaw: 500, listingId: LISTING, sellerAvatarId: SELLER });

    executeQueue = [[listingRow({ expires_at: '2020-01-01T00:00:00Z' })]];
    expect(await market.resolveMarketplaceCheckoutItem(BUYER, LISTING)).toEqual({
      ok: false,
      code: 'listing_expired',
    });

    executeQueue = [[listingRow()]];
    expect(await market.resolveMarketplaceCheckoutItem(SELLER, LISTING)).toEqual({
      ok: false,
      code: 'own_listing',
    });

    executeQueue = [[listingRow({ status: 'cancelled' })]];
    expect(await market.resolveMarketplaceCheckoutItem(BUYER, LISTING)).toEqual({
      ok: false,
      code: 'listing_not_active',
    });

    executeQueue = [[]];
    expect(await market.resolveMarketplaceCheckoutItem(BUYER, LISTING)).toEqual({
      ok: false,
      code: 'listing_not_found',
    });

    // Parcel drifted out from under the listing (land paths don't consult the
    // market lock — the resolver/preflight/fulfiller re-checks are the guard).
    executeQueue = [[listingRow()], [{ owner_avatar_id: 'new-owner' }]];
    expect(await market.resolveMarketplaceCheckoutItem(BUYER, LISTING)).toEqual({
      ok: false,
      code: 'seller_no_longer_owns_parcel',
    });
  });

  it('happy settle: intents recorded, FULL USDC enqueued same-tx, ZERO internal vCLAW, payout QUEUED pending_review', async () => {
    executeQueue = [
      [listingRow()], // 1: listing FOR UPDATE
      [], // 2: prior-settlement idempotency read (none)
      [], // 3: advisory(seller)
      [parcelRow()], // 4: parcel FOR UPDATE
      [{ parcel_id: PARCEL }], // 5: deed-lock presence
      [{ id: LISTING }], // 6: claim active→pending_settlement RETURNING
      [{ id: 'settlement-1' }], // 7: INSERT market_settlements RETURNING
      [], // 8: pending_settlement→settled
    ];
    const fulfiller = checkout.getFulfiller('marketplace_purchase')!;
    const out = await fulfiller(fulfillerCtx());

    expect(out.fulfilled).toBe(true);
    expect(out.detail).toMatchObject({
      listingId: LISTING,
      settlementId: 'settlement-1',
      itemKind: 'land_deed',
      itemRef: PARCEL,
      priceVclaw: 500,
      rakeBps: 444,
      rakeUsd: '0.222000',
      sellerPayoutUsd: '4.778000',
      payoutStatus: 'pending_review',
      clvBuyQueueId: 'queue-77',
      deedTransfer: 'pending_codex_gated_transfer',
    });

    // CONSERVATION (traps 1+2): zero internal-vCLAW ledger calls; no SQL ever
    // touches the avatars balance.
    expect(ledgerCalls).toEqual([]);
    const texts = sqlTexts();
    for (const t of texts) expect(t).not.toMatch(/claw_tokens|avatars\s+set/i);

    // Lock order: listing FOR UPDATE, then advisory(seller) OUTER, parcel INNER.
    expect(texts[0]).toContain('FOR UPDATE');
    expect(texts[2]).toContain('pg_advisory_xact_lock');
    expect(texts[3]).toContain('FOR UPDATE');

    // State machine: active→pending_settlement (bound) then →settled, same tx.
    expect(texts[5]).toContain("status = 'pending_settlement'");
    expect(texts[5]).toContain("WHERE id = ");
    expect(texts[5]).toContain("status = 'active'");
    expect(texts[7]).toContain("status = 'settled'");

    // The settlement-intent INSERT: QUEUED payout + exact split params.
    expect(texts[6]).toContain('INSERT INTO market_settlements');
    expect(texts[6]).toContain("'pending_review'");
    const insertParams = flattenSql(executeCalls[6]).params;
    expect(insertParams).toContain('0.222000'); // rake intent (4.44%)
    expect(insertParams).toContain('4.778000'); // seller payout intent (95.56%)
    expect(insertParams).toContain('5.000000'); // usd_basis (conservation: sum)
    expect(insertParams).toContain(444); // rake_bps
    expect(insertParams).toContain('queue-77'); // the C3 buy this settlement funded
    expect(insertParams).toContain('SIG_MKT_1');
    expect(insertParams).toContain('SellerWallet1111111111111111111111111111111');

    // The owed USDC→CLV buy — FULL settled amount, composed into THE settle tx.
    expect(enqueueCalls.length).toBe(1);
    expect(enqueueCalls[0]!.input).toMatchObject({
      amountUsdc: '5.000000',
      reason: 'marketplace_purchase',
      sourceRef: CHECKOUT,
    });
    expect(enqueueCalls[0]!.tx).toBe(fakeTx);
  });

  it('REPLAY DOES NOT DOUBLE-PAY: an existing settlement for the checkoutId is a no-op (trap 3)', async () => {
    executeQueue = [
      [listingRow({ status: 'settled' })], // listing FOR UPDATE (already settled)
      [
        {
          id: 'settlement-1',
          clv_buy_queue_id: 'queue-77',
          rake_usd: '0.222000',
          seller_payout_usd: '4.778000',
          payout_status: 'pending_review',
        },
      ], // prior settlement found
    ];
    const fulfiller = checkout.getFulfiller('marketplace_purchase')!;
    const out = await fulfiller(fulfillerCtx());
    expect(out.fulfilled).toBe(true);
    expect(out.detail).toMatchObject({
      replay: true,
      settlementId: 'settlement-1',
      rakeUsd: '0.222000',
      sellerPayoutUsd: '4.778000',
    });
    expect(enqueueCalls.length).toBe(0); // never double-queues the buy
    expect(executeCalls.length).toBe(2); // read-only — zero new intent rows
    expect(ledgerCalls).toEqual([]);
  });

  it('seller lost the parcel under the lock ⇒ refusal, tx rolls back, nothing enqueued', async () => {
    executeQueue = [
      [listingRow()],
      [],
      [],
      [parcelRow({ owner_avatar_id: 'new-owner' })], // authoritative re-check fails
    ];
    const fulfiller = checkout.getFulfiller('marketplace_purchase')!;
    await expect(fulfiller(fulfillerCtx())).rejects.toThrow(/seller_no_longer_owns_parcel/);
    expect(enqueueCalls.length).toBe(0);
  });

  it('missing deed lock under a live listing ⇒ deed_lock_missing refusal', async () => {
    executeQueue = [[listingRow()], [], [], [parcelRow()], []];
    const fulfiller = checkout.getFulfiller('marketplace_purchase')!;
    await expect(fulfiller(fulfillerCtx())).rejects.toThrow(/deed_lock_missing/);
    expect(enqueueCalls.length).toBe(0);
  });

  it('self-buy + price drift refuse under the lock (own_listing / price_mismatch)', async () => {
    executeQueue = [[listingRow()], []];
    const fulfiller = checkout.getFulfiller('marketplace_purchase')!;
    await expect(
      fulfiller(fulfillerCtx({ subject: { avatarId: SELLER, userId: 'user-1', kind: 'user' } })),
    ).rejects.toThrow(/own_listing/);

    executeQueue = [[listingRow({ price_vclaw: 600 })], []];
    await expect(fulfiller(fulfillerCtx())).rejects.toThrow(/price_mismatch/);
    expect(enqueueCalls.length).toBe(0);
  });

  it('cancelled/expired listing refuses at fulfillment (listing_not_active / listing_expired)', async () => {
    const fulfiller = checkout.getFulfiller('marketplace_purchase')!;
    executeQueue = [[listingRow({ status: 'cancelled' })], []];
    await expect(fulfiller(fulfillerCtx())).rejects.toThrow(/listing_not_active/);

    executeQueue = [[listingRow({ expires_at: '2020-01-01T00:00:00Z' })], []];
    await expect(fulfiller(fulfillerCtx())).rejects.toThrow(/listing_expired/);
    expect(enqueueCalls.length).toBe(0);
  });
});
