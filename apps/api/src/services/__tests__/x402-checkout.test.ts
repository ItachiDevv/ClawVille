/**
 * GENERIC x402 CHECKOUT (Tokenomics C — checkout stage) — unit tests.
 * LIGHT + DETERMINISTIC — no real Postgres, no facilitator network.
 *
 * INVARIANTS PROVEN (the Phase-0 trap-list test set):
 *   1. QUOTE: server-side amount discipline — zero/negative/fractional/
 *      over-cap priceVclaw refuses BEFORE any row insert; a happy quote
 *      persists a pending row and returns the ¢-pegged 402 requirement
 *      (usdCents === priceVclaw; atomic USDC amount correct).
 *   2. REGISTRY: dispatch by kind; an UNKNOWN/unregistered itemKind refuses
 *      at quote AND at settle BEFORE the facilitator is ever called (the
 *      "never take USDC we can't fulfill" rule); duplicate registration
 *      throws.
 *   3. DURABLE SETTLE MACHINE (the Codex money-path review): pending → settling
 *      (a DB-backed CLAIM that stakes the idempotency key BEFORE the facilitator
 *      — a key reused on another checkout 23505s to a clean conflict, no money
 *      moved) → CAPTURE (the signature + global receipt commit in one transaction
 *      the instant the facilitator settles, BEFORE fulfillment — a capture
 *      conflict means the signature is owned by another checkout ⇒ reconcile,
 *      and the fulfiller NEVER runs on another item's payment) → FULFILL (flip
 *      settling→settled + the
 *      fulfiller atomically). A captured-but-unfulfilled row RESUMES without
 *      re-calling the facilitator; a settled row replays; a settled row WITHOUT a
 *      signature refuses replay (corruption). A stale settling claim with no
 *      signature ⇒ reconcile (money-state unknown, NEVER auto-retried); a fresh
 *      one ⇒ settle_in_flight. Definitive verify failures ⇒ terminal failed;
 *      transient failures RELEASE the claim back to pending.
 *   4. COSMETIC FULFILLER CONSERVATION: mints/debits ZERO internal vCLAW —
 *      no creditClawTokens/debitClawTokens/mintEarned/transferClawTokens call
 *      for the buyer OR the treasury, no raw avatars write; grants the skin
 *      (acquiredVia 'shop_usdc', ledgerId null) and enqueues the USDC→CLV
 *      buy intent on the SAME settle tx.
 *   5. RENT FULFILLER BACKED-EMISSION: escrow increment carries the usd_basis
 *      audit (land_transactions kind 'land_deposit_prepay_usdc' with
 *      usdBasis/txSignature/checkoutId in metadata), takes the land lock
 *      order (advisory THEN row FOR UPDATE), debits NO avatar, and refuses
 *      (CheckoutFulfillmentRefusal) on owner/tenure mismatch under the lock.
 *
 * The DB is a stubbed @clawville/database (query/insert/update/transaction
 * chains recorded with programmable returns; every other named export spread
 * from the real module). x402-payai is spread-real (REAL buildTopupQuote /
 * usdToCt — the peg math under test) with only verifyAndSettle +
 * resolveFacilitatorFeePayer stubbed. claw-token-ledger's writers are spies
 * that RECORD (the conservation assertions); clv-swap-executor's
 * enqueueClvBuy is a spy that records the composed tx.
 */

// Crash-loud module-load env BEFORE imports (mirrors moonpay.test.ts — the
// service pulls routes/ct-topup → require-auth-or-agent → npc-simulation and
// friends; the fulfillers pull routes/cosmetics + routes/land). DATABASE_URL
// is SCOPED to module init (deleted after the imports below) so DB-gated
// suites later in the shared bun process keep their skip-when-no-DB behavior.
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
// The checkout quotes against the merchant wallet; X402_ENABLED stays OFF
// (loadX402Config only hard-requires the pubkey when enabled).
process.env.CLAWVILLE_MERCHANT_WALLET_PUBKEY = 'MerchantTest1111111111111111111111111111111';
delete process.env.X402_TOPUP_NETWORK; // devnet-first default under test

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import * as realDatabase from '@clawville/database';
import * as realPayai from '../x402-payai';
import * as realLedger from '../claw-token-ledger';
import * as realSwap from '../clv-swap-executor';
import * as realReceipts from '../x402-settlement-receipts';

// ── LEAK GUARD ───────────────────────────────────────────────────────────────
// bun's mock.module is PROCESS-GLOBAL and files share one module registry, so
// a naive override of x402-payai/claw-token-ledger would clobber the REAL
// implementations for every LATER test file (verified: x402-payai.test.ts +
// x402-verify-only.test.ts fail when this suite loads first). Every service
// mock below therefore DELEGATES to the real implementation unless THIS
// suite's intercept flag is on; afterAll releases it.
//
// The originals are captured into consts BEFORE mock.module runs: bun patches
// the already-imported namespace objects IN PLACE, so `realPayai.verifyAndSettle`
// would point at the wrapper itself after registration (verified: delegating
// through the namespace recursed infinitely and failed the payai harness).
let intercept = true;
afterAll(() => {
  intercept = false;
});
const REAL_verifyAndSettle = realPayai.verifyAndSettle;
const REAL_resolveFeePayer = realPayai.resolveFacilitatorFeePayer;
const REAL_credit = realLedger.creditClawTokens;
const REAL_debit = realLedger.debitClawTokens;
const REAL_mintEarned = realLedger.mintEarned;
const REAL_transfer = realLedger.transferClawTokens;
const REAL_enqueueClvBuy = realSwap.enqueueClvBuy;
const REAL_claimSettlement = realReceipts.claimX402Settlement;

// ── @clawville/database stub ────────────────────────────────────────────────
type Row = Record<string, unknown>;

const insertCalls: Array<{ values: Row; conflictTarget: boolean }> = [];
let insertReturnRows: Row[] = [{ id: 'checkout-1' }];
let insertReturningImpl: (() => Row[]) | null = null;
const updateCalls: Array<{ set: Row; hasReturning: boolean }> = [];
/** Programmable behavior for the NEXT update(...).returning() — throw or rows. */
let updateReturningImpl: () => Row[] = () => [{ id: 'checkout-1' }];
/** Optional per-call queue for update(...).returning() — shift one behavior per
 *  call; falls back to updateReturningImpl when empty. Lets a test script the
 *  durable multi-UPDATE flow (claim → capture → flip) with distinct behavior
 *  (rows, [], or throw) per step. */
let updateReturningQueue: Array<() => Row[]> = [];
let findFirstQueue: Array<Row | undefined> = [];
let txRan = 0;

/** Thenable + .returning() so both `await ...where(...)` and
 *  `await ...where(...).returning(...)` drizzle shapes work. */
function whereResult() {
  const p = Promise.resolve([] as Row[]);
  return {
    returning: async (_sel: unknown) => {
      updateCalls[updateCalls.length - 1]!.hasReturning = true;
      const step = updateReturningQueue.length > 0 ? updateReturningQueue.shift()! : updateReturningImpl;
      return step();
    },
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    finally: p.finally.bind(p),
  };
}

function makeInsert() {
  return (_table: unknown) => ({
    values: (v: Row) => {
      const call = { values: v, conflictTarget: false };
      insertCalls.push(call);
      return {
        returning: async (_sel: unknown) =>
          insertReturningImpl ? insertReturningImpl() : insertReturnRows,
        onConflictDoNothing: (_target: unknown) => {
          call.conflictTarget = true;
          return {
            returning: async (_sel: unknown) =>
              insertReturningImpl ? insertReturningImpl() : insertReturnRows,
          };
        },
      };
    },
  });
}

function makeUpdate() {
  return (_table: unknown) => ({
    set: (s: Row) => {
      updateCalls.push({ set: s, hasReturning: false });
      return { where: (_w: unknown) => whereResult() };
    },
  });
}

/** select(...).from(...).where(...).limit(n) — findOwnedSkin's shape. */
let selectReturnRows: Row[] = [];
let selectReturnQueue: Row[][] = [];
function makeSelect() {
  return (_sel: unknown) => ({
    from: (_t: unknown) => ({
      where: (_w: unknown) => ({
        limit: async (_n: number) =>
          selectReturnQueue.length > 0 ? selectReturnQueue.shift()! : selectReturnRows,
      }),
    }),
  });
}

/** tx.execute — programmable per-call queue + full capture (rent fulfiller). */
const executeCalls: unknown[] = [];
let executeQueue: Array<Row[]> = [];
async function fakeExecute(q: unknown): Promise<Row[]> {
  executeCalls.push(q);
  return executeQueue.length > 0 ? executeQueue.shift()! : [];
}

const fakeTx = {
  insert: makeInsert(),
  update: makeUpdate(),
  select: makeSelect(),
  execute: fakeExecute,
};

const fakeDb = {
  ...(realDatabase as unknown as { db: Record<string, unknown> }).db,
  insert: makeInsert(),
  update: makeUpdate(),
  select: makeSelect(),
  execute: fakeExecute,
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    txRan += 1;
    return fn(fakeTx);
  },
  query: {
    x402Checkouts: {
      findFirst: async (_opts: unknown) => findFirstQueue.shift(),
    },
    avatars: {
      findFirst: async (_opts: unknown) => ({ clawTokens: 4242 }),
    },
  },
};

mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: fakeDb,
}));

// ── x402-payai: REAL peg/quote math; stub only the facilitator boundary ─────
let verifyAndSettleCalls = 0;
let verifyAndSettleResult: Partial<realPayai.VerifyAndSettleResult> = {};
mock.module('../x402-payai', () => ({
  ...realPayai,
  resolveFacilitatorFeePayer: async (network: realPayai.X402Network) =>
    intercept ? null : REAL_resolveFeePayer(network),
  verifyAndSettle: async (input: realPayai.VerifyAndSettleInput) => {
    if (!intercept) return REAL_verifyAndSettle(input);
    verifyAndSettleCalls += 1;
    return {
      settled: false,
      isValid: false,
      txSignature: null,
      network: null,
      payer: null,
      failureReason: 'unsettled',
      raw: {},
      ...verifyAndSettleResult,
    };
  },
}));

const receiptOwners = new Map<string, realReceipts.ClaimX402SettlementInput>();
const claimSettlement = async (
  input: realReceipts.ClaimX402SettlementInput,
  tx: realLedger.LedgerTx,
): Promise<realReceipts.ClaimX402SettlementResult> => {
  if (!intercept) return REAL_claimSettlement(input, tx);
  const existing = receiptOwners.get(input.txSignature);
  const toRow = (src: realReceipts.ClaimX402SettlementInput) => ({
    ...src,
    createdAt: new Date(),
    grossUsdcAtomic: src.grossUsdcAtomic ?? null,
    platformFeeUsdcAtomic: src.platformFeeUsdcAtomic ?? null,
    treasuryFeeUsdcAtomic: src.treasuryFeeUsdcAtomic ?? null,
    netUsdcAtomic: src.netUsdcAtomic ?? null,
  });
  if (!existing) {
    receiptOwners.set(input.txSignature, input);
    return { kind: 'claimed', receipt: toRow(input) };
  }
  const receipt = toRow(existing);
  return realReceipts.receiptMatchesOwner(receipt, input)
    ? { kind: 'same_owner', receipt }
    : { kind: 'foreign_owner', receipt };
};
mock.module('../x402-settlement-receipts', () => ({
  ...realReceipts,
  claimX402Settlement: claimSettlement,
}));

// ── claw-token-ledger: spies — the CONSERVATION assertions ──────────────────
const ledgerCalls: string[] = [];
mock.module('../claw-token-ledger', () => ({
  ...realLedger,
  creditClawTokens: async (input: realLedger.LedgerCreditInput, tx?: unknown) => {
    if (!intercept) return REAL_credit(input, tx as never);
    ledgerCalls.push('credit');
    throw new Error(`unexpected creditClawTokens on a checkout path: ${JSON.stringify(input)}`);
  },
  debitClawTokens: async (input: realLedger.LedgerDebitInput, tx?: unknown) => {
    if (!intercept) return REAL_debit(input, tx as never);
    ledgerCalls.push('debit');
    throw new Error(`unexpected debitClawTokens on a checkout path: ${JSON.stringify(input)}`);
  },
  mintEarned: async (input: Parameters<typeof realLedger.mintEarned>[0], tx?: unknown) => {
    if (!intercept) return REAL_mintEarned(input, tx as never);
    ledgerCalls.push('mintEarned');
    throw new Error(`unexpected mintEarned on a checkout path: ${JSON.stringify(input)}`);
  },
  transferClawTokens: async (input: Parameters<typeof realLedger.transferClawTokens>[0]) => {
    if (!intercept) return REAL_transfer(input);
    ledgerCalls.push('transfer');
    throw new Error(`unexpected transferClawTokens on a checkout path: ${JSON.stringify(input)}`);
  },
}));

// ── clv-swap-executor: record enqueueClvBuy + the composed tx ───────────────
const enqueueCalls: Array<{ input: Record<string, unknown>; tx: unknown }> = [];
mock.module('../clv-swap-executor', () => ({
  ...realSwap,
  enqueueClvBuy: async (input: realSwap.EnqueueClvBuyInput, tx?: unknown) => {
    if (!intercept) return REAL_enqueueClvBuy(input, tx as never);
    enqueueCalls.push({ input: input as unknown as Record<string, unknown>, tx });
    return { queueId: 'queue-1' };
  },
}));

// Import AFTER the mocks are registered. The fulfiller imports are the
// side-effect registrations the route relies on — same mechanism under test.
const checkout = await import('../x402-checkout');
const cosmeticFulfillerModule = await import('../checkout-fulfillers/cosmetic-purchase');
await import('../checkout-fulfillers/rent-prepay');

// Route chain loaded — drop the module-init DATABASE_URL placeholder.
if (!DB_URL_WAS_SET) {
  delete process.env.DATABASE_URL;
}

const SUBJECT: import('../x402-checkout').CheckoutSubject = {
  avatarId: 'avatar-1',
  userId: 'user-1',
  kind: 'agent',
};

/** A pending x402_checkouts row as the query stub returns it. */
function pendingRow(overrides: Row = {}): Row {
  return {
    id: 'checkout-1',
    avatarId: 'avatar-1',
    userId: 'user-1',
    itemKind: 'tournament_entry',
    itemRef: 'item-ref-1',
    priceVclaw: 500,
    usdCents: 500,
    txSignature: null,
    usdBasisAtReceipt: null,
    status: 'pending',
    idempotencyKey: null,
    metadata: { network: 'devnet', subjectKind: 'agent' },
    ...overrides,
  };
}

/** Tolerant drizzle-SQL flattener for asserting on captured tx.execute SQL.
 *  This drizzle version's queryChunks mix StringChunk{value: string[]} text
 *  pieces with RAW interpolated params (string/number/boolean/null) —
 *  verified by probing `sql\`...\``.queryChunks directly. */
function flattenSql(q: unknown): { text: string; params: unknown[] } {
  const out = { text: '', params: [] as unknown[] };
  const chunks = (q as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return out;
  for (const ch of chunks) {
    const v = (ch as { value?: unknown } | null)?.value;
    if (ch && typeof ch === 'object' && Array.isArray(v) && v.every((s) => typeof s === 'string')) {
      out.text += v.join('');
    } else {
      out.text += ` $${out.params.length + 1} `;
      out.params.push(ch);
    }
  }
  return out;
}

beforeEach(() => {
  insertCalls.length = 0;
  updateCalls.length = 0;
  executeCalls.length = 0;
  ledgerCalls.length = 0;
  enqueueCalls.length = 0;
  insertReturnRows = [{ id: 'checkout-1' }];
  insertReturningImpl = null;
  updateReturningImpl = () => [{ id: 'checkout-1' }];
  updateReturningQueue = [];
  findFirstQueue = [];
  executeQueue = [];
  selectReturnRows = [];
  receiptOwners.clear();
  selectReturnQueue = [];
  txRan = 0;
  verifyAndSettleCalls = 0;
  verifyAndSettleResult = {
    settled: true,
    isValid: true,
    txSignature: 'SIG_TEST_1',
    network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    payer: 'PayerPubkey111',
    failureReason: null,
  };
});

// A test fulfiller registered under the tournament kind (the ONE kind still
// unclaimed by shipped fulfillers — marketplace_purchase is claimed by the C4
// module, whose registration would collide in the shared bun module registry)
// so registry/settle tests control their own fulfillment.
let testFulfillerCalls: Array<import('../x402-checkout').CheckoutFulfillmentContext> = [];
let testFulfillerImpl: import('../x402-checkout').CheckoutFulfiller = async () => ({
  fulfilled: true,
  detail: { proof: 'test-fulfilled' },
});
checkout.registerFulfiller('tournament_entry', async (ctx) => {
  testFulfillerCalls.push(ctx);
  return testFulfillerImpl(ctx);
});
beforeEach(() => {
  testFulfillerCalls = [];
  testFulfillerImpl = async () => ({ fulfilled: true, detail: { proof: 'test-fulfilled' } });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Registry
// ─────────────────────────────────────────────────────────────────────────────

describe('x402-checkout — fulfiller registry', () => {
  it('shipped fulfillers self-registered via side-effect import; unclaimed kind is undefined', () => {
    expect(checkout.getFulfiller('cosmetic_purchase')).toBeDefined();
    expect(checkout.getFulfiller('rent_payment')).toBeDefined();
    expect(checkout.getFulfiller('tournament_entry')).toBeDefined(); // the test one
    // A kind nothing registered (cast — every enum kind may be claimed once
    // the C4 marketplace module loads anywhere in the shared bun process).
    expect(
      checkout.getFulfiller('__unregistered__' as unknown as import('../x402-checkout').CheckoutItemKind),
    ).toBeUndefined();
  });

  it('duplicate registration throws (wiring-bug tripwire)', () => {
    expect(() =>
      checkout.registerFulfiller('cosmetic_purchase', async () => ({ fulfilled: true })),
    ).toThrow(/already registered/);
  });

  it('settle of an UNREGISTERED kind refuses BEFORE the facilitator is called', async () => {
    findFirstQueue = [pendingRow({ itemKind: '__unregistered__' })];
    const res = await checkout.settleCheckout({
      checkoutId: 'checkout-1',
      subject: SUBJECT,
      paymentHeader: 'aGVhZGVy',
      idempotencyKey: 'idem-1',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('fulfiller_unavailable');
    expect(verifyAndSettleCalls).toBe(0); // never took the USDC
    expect(txRan).toBe(0);
  });

  it('quote of an UNREGISTERED kind refuses with no pending row', async () => {
    const res = await checkout.createCheckoutQuote({
      subject: SUBJECT,
      itemKind: '__unregistered__' as unknown as import('../x402-checkout').CheckoutItemKind,
      itemRef: 'item-x',
      priceVclaw: 100,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('fulfiller_unavailable');
    expect(insertCalls.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Quote issuance + amount discipline
// ─────────────────────────────────────────────────────────────────────────────

describe('x402-checkout — quote', () => {
  it.each([[0], [-5], [2.5], [checkout.CHECKOUT_MAX_PRICE_VCLAW + 1]])(
    'rejects priceVclaw=%p BEFORE any row insert',
    async (bad) => {
      const res = await checkout.createCheckoutQuote({
        subject: SUBJECT,
        itemKind: 'tournament_entry',
        itemRef: 'item-1',
        priceVclaw: bad as number,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('invalid_amount');
      expect(insertCalls.length).toBe(0);
    },
  );

  it('happy quote: pending row + ¢-pegged 402 requirement (usdCents === priceVclaw)', async () => {
    const res = await checkout.createCheckoutQuote({
      subject: SUBJECT,
      itemKind: 'tournament_entry',
      itemRef: 'item-1',
      priceVclaw: 500,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.checkoutId).toBe('checkout-1');
    expect(res.usdCents).toBe(500); // ¢-peg: 500 vCLAW = $5.00
    expect(res.network).toBe('devnet'); // devnet-first default
    // The pending row persisted BEFORE the quote returned.
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0]!.values).toMatchObject({
      avatarId: 'avatar-1',
      itemKind: 'tournament_entry',
      itemRef: 'item-1',
      priceVclaw: 500,
      usdCents: 500,
      status: 'pending',
    });
    // REAL buildTopupQuote output: $5.00 = 5 USDC = 5_000_000 atomic, paid to
    // the merchant wallet on the devnet USDC mint.
    const req = res.quote.accepts[0]!;
    expect(req.amount).toBe('5000000');
    expect(req.payTo).toBe('MerchantTest1111111111111111111111111111111');
    expect(req.asset).toBe(realPayai.USDC_MINT_DEVNET);
  });

  it('refuses on_ramp_unconfigured (no merchant wallet) with no row insert', async () => {
    const prior = process.env.CLAWVILLE_MERCHANT_WALLET_PUBKEY;
    delete process.env.CLAWVILLE_MERCHANT_WALLET_PUBKEY;
    try {
      const res = await checkout.createCheckoutQuote({
        subject: SUBJECT,
        itemKind: 'tournament_entry',
        itemRef: 'item-1',
        priceVclaw: 500,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('on_ramp_unconfigured');
      expect(insertCalls.length).toBe(0);
    } finally {
      process.env.CLAWVILLE_MERCHANT_WALLET_PUBKEY = prior;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Settle — exactly-once + replay + failure classes
// ─────────────────────────────────────────────────────────────────────────────

describe('x402-checkout — settle: durable claim → capture → resumable fulfill', () => {
  const settleArgs = {
    checkoutId: 'checkout-1',
    subject: SUBJECT,
    paymentHeader: 'aGVhZGVy',
    idempotencyKey: 'idem-1',
  };

  /** A settling row that has ALREADY captured the signature (money durable,
   *  fulfillment pending) — the shape step-10 re-reads + the resume path loads. */
  function capturedRow(overrides: Row = {}): Row {
    return pendingRow({
      status: 'settling',
      txSignature: 'SIG_TEST_1',
      usdBasisAtReceipt: '5.00',
      settlingId: 'claim-1',
      settlingStartedAt: new Date().toISOString(),
      metadata: {
        network: 'devnet',
        subjectKind: 'agent',
        txSignature: 'SIG_TEST_1',
        settlePayer: 'PayerPubkey111',
        settleNetwork: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      },
      ...overrides,
    });
  }

  /** A settling row still awaiting the facilitator (NO signature yet), aged. */
  function settlingNoSigRow(ageMs: number, overrides: Row = {}): Row {
    return pendingRow({
      status: 'settling',
      txSignature: null,
      settlingId: 'claim-x',
      settlingStartedAt: new Date(Date.now() - ageMs).toISOString(),
      ...overrides,
    });
  }

  const throw23505 = () => () => {
    throw Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    });
  };

  it('happy settle: CLAIM (settling) → facilitator → CAPTURE (signature) → FULFILL (settled)', async () => {
    // step-1 load (pending) → step-10 re-read (captured). claim/capture/flip all
    // return [{id}] via the default updateReturningImpl.
    findFirstQueue = [pendingRow(), capturedRow()];
    const res = await checkout.settleCheckout(settleArgs);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.txSignature).toBe('SIG_TEST_1');
    expect(res.replay).toBe(false);
    expect(res.fulfillment).toEqual({ proof: 'test-fulfilled' });
    expect(txRan).toBe(2); // capture+global receipt, then fulfillment, are separate committed txs
    expect(verifyAndSettleCalls).toBe(1);
    expect(testFulfillerCalls.length).toBe(1);
    const ctx = testFulfillerCalls[0]!;
    expect(ctx.tx).toBe(fakeTx as never); // fulfiller composes into THE fulfillment tx
    expect(ctx.usdBasis).toBe('5.00');
    expect(ctx.txSignature).toBe('SIG_TEST_1');

    // CLAIM staked status='settling' + a settlingId + the idempotency key BEFORE
    // the facilitator (Codex finding 1 — the DB-backed cross-process claim).
    const claim = updateCalls.find((u) => u.set.status === 'settling');
    expect(claim).toBeDefined();
    expect(claim!.set.idempotencyKey).toBe('idem-1');
    expect(claim!.set.settlingId).toBeTruthy();

    // CAPTURE persisted the signature IMMEDIATELY, in its own UPDATE, BEFORE
    // fulfillment (Codex finding 2 — the money proof is durable).
    const capture = updateCalls.find(
      (u) => u.set.txSignature === 'SIG_TEST_1' && u.set.status === undefined,
    );
    expect(capture).toBeDefined();
    expect(capture!.set.usdBasisAtReceipt).toBe('5.00');

    // FLIP settling → settled (carries NO signature — it was already captured).
    const flip = updateCalls.find((u) => u.set.status === 'settled');
    expect(flip).toBeDefined();
  });

  it('idempotency-key reuse on ANOTHER checkout ⇒ claim 23505 ⇒ conflict, NO money moves', async () => {
    findFirstQueue = [pendingRow()];
    updateReturningQueue = [throw23505()]; // the CLAIM trips the (avatar,key) UNIQUE
    const res = await checkout.settleCheckout(settleArgs);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('idempotency_key_conflict');
    expect(verifyAndSettleCalls).toBe(0); // never reached the facilitator
    expect(testFulfillerCalls.length).toBe(0);
  });

  it('DEFINITIVE verify rejection ⇒ terminal failed; no fulfillment, no money', async () => {
    findFirstQueue = [pendingRow()];
    verifyAndSettleResult = { settled: false, isValid: false, txSignature: null, failureReason: 'payment_invalid' };
    const res = await checkout.settleCheckout(settleArgs);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('payment_not_settled');
    expect(res.transient).toBe(false);
    // Claimed (settling) then flipped to failed — checked to our claim.
    expect(updateCalls.find((u) => u.set.status === 'settling')).toBeDefined();
    expect(updateCalls.find((u) => u.set.status === 'failed')).toBeDefined();
    expect(testFulfillerCalls.length).toBe(0);
  });

  it('VERIFY-phase transport error ⇒ RELEASE the claim to pending (no money moved, no failed)', async () => {
    findFirstQueue = [pendingRow()];
    verifyAndSettleResult = { settled: false, isValid: false, txSignature: null, failureReason: 'facilitator_verify_error' };
    const res = await checkout.settleCheckout(settleArgs);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('payment_not_settled');
    expect(res.transient).toBe(true);
    // Released settling → pending; NEVER failed (the payment can still land).
    expect(updateCalls.find((u) => u.set.status === 'pending')).toBeDefined();
    expect(updateCalls.find((u) => u.set.status === 'failed')).toBeUndefined();
  });

  it('SETTLE-phase error (ambiguous) ⇒ reconcile, NEVER pending (Codex round-2 BLOCKING)', async () => {
    findFirstQueue = [pendingRow()];
    // The /settle call was attempted and threw — the settlement MAY have landed.
    verifyAndSettleResult = { settled: false, isValid: false, txSignature: null, failureReason: 'facilitator_settle_error' };
    const res = await checkout.settleCheckout(settleArgs);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('checkout_reconciliation');
    expect(res.status).toBe('reconcile');
    // Money-state UNKNOWN ⇒ the claim is NEVER released to pending (a retry must
    // never re-call the facilitator after an ambiguous settle).
    expect(updateCalls.find((u) => u.set.status === 'reconcile')).toBeDefined();
    expect(updateCalls.find((u) => u.set.status === 'pending')).toBeUndefined();
    expect(updateCalls.find((u) => u.set.status === 'failed')).toBeUndefined();
  });

  it('post-settle independent proof failure preserves the signature and fulfills nothing', async () => {
    findFirstQueue = [pendingRow()];
    verifyAndSettleResult = {
      settled: false,
      isValid: true,
      txSignature: 'SIG_CHAIN_MISMATCH',
      failureReason: 'independent_chain_mismatch',
    };
    const res = await checkout.settleCheckout(settleArgs);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('checkout_reconciliation');
    expect(updateCalls.find((u) => u.set.status === 'reconcile')).toBeDefined();
    expect(testFulfillerCalls).toHaveLength(0);
  });

  it('SIGNATURE CONFLICT: capture 23505 (sig owned by another checkout) ⇒ reconcile, fulfiller ZERO', async () => {
    findFirstQueue = [pendingRow()];
    // claim → ok; CAPTURE → 23505 (the tx_signature UNIQUE — another checkout owns it).
    updateReturningQueue = [() => [{ id: 'checkout-1' }], throw23505()];
    const res = await checkout.settleCheckout(settleArgs);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('signature_conflict');
    expect(res.status).toBe('reconcile');
    expect(verifyAndSettleCalls).toBe(1); // money DID move — hence reconcile, not a clean fail
    expect(testFulfillerCalls.length).toBe(0); // NEVER fulfilled on another item's signature
    expect(updateCalls.find((u) => u.set.status === 'reconcile')).toBeDefined();
  });

  it('CAPTURE then REFUSAL preserves the receipt and blocks reuse by a top-up rail', async () => {
    findFirstQueue = [pendingRow(), capturedRow()];
    testFulfillerImpl = async () => {
      throw new checkout.CheckoutFulfillmentRefusal('inventory_changed');
    };

    const res = await checkout.settleCheckout(settleArgs);
    expect(res).toEqual({
      ok: false,
      code: 'fulfillment_refused',
      refusalCode: 'inventory_changed',
    });
    expect(receiptOwners.get('SIG_TEST_1')).toMatchObject({
      rail: 'x402_checkout',
      referenceId: 'checkout-1',
      subjectId: 'avatar-1',
    });

    const replay = await claimSettlement({
      txSignature: 'SIG_TEST_1',
      rail: 'ct_topup',
      kind: 'topup',
      referenceId: 'topup-2',
      subjectId: 'avatar-2',
      amountUsdcAtomic: 5_000_000n,
    }, fakeTx as never);
    expect(replay.kind).toBe('foreign_owner');
    expect(updateCalls.find((u) => u.set.status === 'failed')).toBeDefined();
  });

  it('RESUME: a captured row (settling + signature) re-fulfills WITHOUT re-calling the facilitator', async () => {
    findFirstQueue = [capturedRow()]; // step-1 load finds a captured, unfulfilled row
    const res = await checkout.settleCheckout(settleArgs);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.txSignature).toBe('SIG_TEST_1');
    expect(res.replay).toBe(false);
    expect(verifyAndSettleCalls).toBe(0); // the facilitator is NEVER re-called on resume
    expect(testFulfillerCalls.length).toBe(1); // fulfilled exactly once
    expect(updateCalls.find((u) => u.set.status === 'settled')).toBeDefined();
  });

  it('settled row on load ⇒ idempotent replay; facilitator + fulfiller untouched', async () => {
    findFirstQueue = [
      pendingRow({ status: 'settled', txSignature: 'SIG_PRIOR', metadata: { fulfillment: { a: 1 } } }),
    ];
    const res = await checkout.settleCheckout(settleArgs);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.replay).toBe(true);
    expect(res.txSignature).toBe('SIG_PRIOR');
    expect(res.fulfillment).toEqual({ a: 1 });
    expect(verifyAndSettleCalls).toBe(0);
    expect(testFulfillerCalls.length).toBe(0);
    expect(txRan).toBe(0);
  });

  it('settled row WITHOUT a signature ⇒ replay REFUSED (Codex finding 5, corruption guard)', async () => {
    findFirstQueue = [pendingRow({ status: 'settled', txSignature: null })];
    const res = await checkout.settleCheckout(settleArgs);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('settle_failed'); // never replayed as ok without the money proof
  });

  it('STALE settling claim (no signature, aged) ⇒ reconcile, facilitator NOT re-called', async () => {
    // step-1 load = a 10-min-old settling row w/o signature; re-read = reconcile.
    findFirstQueue = [
      settlingNoSigRow(10 * 60_000),
      pendingRow({ status: 'reconcile', txSignature: null }),
    ];
    const res = await checkout.settleCheckout(settleArgs);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('checkout_reconciliation');
    expect(res.status).toBe('reconcile');
    expect(verifyAndSettleCalls).toBe(0); // money-state UNKNOWN ⇒ NEVER auto-retry the facilitator
    expect(updateCalls.find((u) => u.set.status === 'reconcile')).toBeDefined();
  });

  it('FRESH settling claim (no signature, recent) ⇒ settle_in_flight (a concurrent settle owns it)', async () => {
    findFirstQueue = [settlingNoSigRow(1_000)]; // 1s old — a live concurrent settle
    const res = await checkout.settleCheckout(settleArgs);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('settle_in_flight');
    expect(verifyAndSettleCalls).toBe(0);
  });

  it('foreign checkoutId (caller-bound row load misses) ⇒ checkout_not_found, facilitator untouched', async () => {
    findFirstQueue = [undefined];
    const res = await checkout.settleCheckout(settleArgs);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('checkout_not_found');
    expect(verifyAndSettleCalls).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Cosmetic fulfiller — mints ZERO internal vCLAW
// ─────────────────────────────────────────────────────────────────────────────

describe('cosmetic_purchase fulfiller — conservation', () => {
  function cosmeticCtx(): import('../x402-checkout').CheckoutFulfillmentContext {
    return {
      tx: fakeTx as never,
      checkoutId: 'checkout-9',
      subject: SUBJECT,
      itemKind: 'cosmetic_purchase',
      itemRef: 'b6e7c1de-0000-4000-8000-000000000001',
      priceVclaw: 500,
      usdCents: 500,
      usdBasis: '5.00',
      txSignature: 'SIG_COS_1',
      settlePayer: 'PayerPubkey111',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    };
  }

  it('grants the skin + enqueues the CLV buy on the SAME tx — ZERO ledger calls, no treasury credit', async () => {
    insertReturnRows = [{ id: 'skin-row-1' }];
    const fulfiller = checkout.getFulfiller('cosmetic_purchase')!;
    const out = await fulfiller(cosmeticCtx());

    expect(out.fulfilled).toBe(true);
    expect(out.detail).toMatchObject({ avatarSkinId: 'skin-row-1', alreadyOwned: false });

    // CONSERVATION: no internal vCLAW moved for buyer OR treasury — the spies
    // would have thrown (and recorded) on any credit/debit/mint/transfer.
    expect(ledgerCalls).toEqual([]);

    // The grant row: USDC provenance, NO ledger debit pointer (by design).
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0]!.values).toMatchObject({
      avatarId: 'avatar-1',
      acquiredVia: 'shop_usdc',
      ledgerId: null,
      equipped: false,
    });
    expect(insertCalls[0]!.conflictTarget).toBe(true); // idempotent grant

    // The treasury's revenue on this rail: the owed on-chain USDC→CLV buy,
    // recorded on the SAME settle tx (µUSD decimal string).
    expect(enqueueCalls.length).toBe(1);
    expect(enqueueCalls[0]!.input).toMatchObject({
      amountUsdc: '5.000000',
      reason: 'checkout_cosmetic',
      sourceRef: 'checkout-9',
    });
    expect(enqueueCalls[0]!.tx).toBe(fakeTx);
  });

  it('sub-second ownership race: no-op grant reports alreadyOwned, settle still completes, CLV buy still owed', async () => {
    insertReturnRows = []; // ON CONFLICT DO NOTHING — someone else owns it
    selectReturnRows = [{ id: 'skin-row-existing', equipped: false }];
    const fulfiller = checkout.getFulfiller('cosmetic_purchase')!;
    const out = await fulfiller(cosmeticCtx());
    expect(out.detail).toMatchObject({ avatarSkinId: 'skin-row-existing', alreadyOwned: true });
    expect(ledgerCalls).toEqual([]);
    expect(enqueueCalls.length).toBe(1);
  });

  it('sub-second stock race: refuses through the durable refund-required path and enqueues no CLV buy', async () => {
    // Migration 0032's insertion-boundary trigger is authoritative. The losing
    // transaction never receives a provisional ownership row; Postgres raises
    // the named 23514 and rolls the INSERT back.
    insertReturningImpl = () => {
      throw {
        code: '23514',
        constraint: 'cosmetic_skus_supply_cap_enforced',
      };
    };
    const fulfiller = checkout.getFulfiller('cosmetic_purchase')!;

    await expect(fulfiller(cosmeticCtx())).rejects.toMatchObject({
      name: 'CheckoutFulfillmentRefusal',
      code: 'sold_out',
    });
    expect(enqueueCalls).toEqual([]);
    expect(ledgerCalls).toEqual([]);
  });

  it('quote resolver refuses a zero-priced SKU (unquotable as USDC) and an already-owned SKU', async () => {
    // checkSkuPurchasable goes through db.query.cosmeticSkus — stub it here.
    const q = fakeDb.query as Record<string, { findFirst: (o: unknown) => Promise<unknown> }>;
    const skuId = 'b6e7c1de-0000-4000-8000-000000000002';
    q.cosmeticSkus = {
      findFirst: async () => ({
        id: skuId,
        slug: 'free-hat',
        priceCt: 0,
        exclusiveCurrency: null,
        availableFrom: null,
        availableUntil: null,
      }),
    };
    const zero = await cosmeticFulfillerModule.resolveCosmeticCheckoutItem('avatar-1', skuId);
    expect(zero).toEqual({ ok: false, code: 'zero_price' });

    q.cosmeticSkus = {
      findFirst: async () => ({
        id: skuId,
        slug: 'paid-hat',
        priceCt: 300,
        exclusiveCurrency: 'CT',
        availableFrom: null,
        availableUntil: null,
      }),
    };
    selectReturnRows = [{ id: 'owned-row', equipped: true }]; // findOwnedSkin hit
    const owned = await cosmeticFulfillerModule.resolveCosmeticCheckoutItem('avatar-1', skuId);
    expect(owned).toEqual({ ok: false, code: 'already_owned' });
  });

  it('refuses the reward-only Kelp collectible on every purchasable checkout rail', async () => {
    const q = fakeDb.query as Record<string, { findFirst: (o: unknown) => Promise<unknown> }>;
    const skuId = 'b6e7c1de-0000-4000-8000-000000000099';
    q.cosmeticSkus = {
      findFirst: async () => ({
        id: skuId,
        slug: 'kelp-maze-collectible',
        priceCt: 0,
        exclusiveCurrency: 'REWARD_ONLY',
        availableFrom: null,
        availableUntil: null,
        supplyCap: null,
        soldCount: 0,
      }),
    };

    const rewardOnly = await cosmeticFulfillerModule.resolveCosmeticCheckoutItem('avatar-1', skuId);
    expect(rewardOnly).toEqual({ ok: false, code: 'wrong_currency' });
  });

  it('quote resolver refuses a sold-out SKU for a non-owner', async () => {
    const q = fakeDb.query as Record<string, { findFirst: (o: unknown) => Promise<unknown> }>;
    const skuId = 'b6e7c1de-0000-4000-8000-000000000003';
    q.cosmeticSkus = {
      findFirst: async () => ({
        id: skuId,
        slug: 'last-hat',
        priceCt: 300,
        exclusiveCurrency: 'CT',
        availableFrom: null,
        availableUntil: null,
        supplyCap: 1,
        soldCount: 1,
      }),
    };
    selectReturnRows = [];

    const soldOut = await cosmeticFulfillerModule.resolveCosmeticCheckoutItem('avatar-1', skuId);
    expect(soldOut).toEqual({ ok: false, code: 'sold_out' });
  });

  it('quote resolver detects ownership granted by an old rollout pod even when soldCount is stale', async () => {
    const q = fakeDb.query as Record<string, { findFirst: (o: unknown) => Promise<unknown> }>;
    const skuId = 'b6e7c1de-0000-4000-8000-000000000004';
    q.cosmeticSkus = {
      findFirst: async () => ({
        id: skuId,
        slug: 'rollout-last-hat',
        priceCt: 300,
        exclusiveCurrency: 'CT',
        availableFrom: null,
        availableUntil: null,
        supplyCap: 1,
        soldCount: 0,
      }),
    };
    // First select is the live ownership COUNT; second proves this caller is
    // not the owner, so the refusal is sold_out rather than already_owned.
    selectReturnQueue = [[{ ownershipCount: 1 }], []];

    const soldOut = await cosmeticFulfillerModule.resolveCosmeticCheckoutItem('avatar-1', skuId);
    expect(soldOut).toEqual({ ok: false, code: 'sold_out' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Rent-prepay fulfiller — escrow increment is BACKED (usd_basis, no debit)
// ─────────────────────────────────────────────────────────────────────────────

describe('rent_payment fulfiller — backed escrow emission', () => {
  const PARCEL = 'a1a1a1a1-0000-4000-8000-000000000001';

  function rentCtx(): import('../x402-checkout').CheckoutFulfillmentContext {
    return {
      tx: fakeTx as never,
      checkoutId: 'checkout-77',
      subject: SUBJECT,
      itemKind: 'rent_payment',
      itemRef: PARCEL,
      priceVclaw: 500,
      usdCents: 500,
      usdBasis: '5.00',
      txSignature: 'SIG_RENT_1',
      settlePayer: 'PayerPubkey111',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    };
  }

  function parcelRow(overrides: Row = {}): Row {
    return {
      id: PARCEL,
      parcel_code: 'C-042',
      owner_avatar_id: 'avatar-1',
      tenure: 'deposit',
      deposit_remaining_ct: 40,
      rent_ct_weekly: 100,
      grace_until: '2026-07-09T00:00:00Z',
      ...overrides,
    };
  }

  it('escrow += amount with NO avatar debit; audit row carries usd_basis; land lock order held', async () => {
    executeQueue = [
      [], // 1: advisory lock
      [parcelRow()], // 2: SELECT ... FOR UPDATE
      [], // 3: UPDATE escrow
      [], // 4: INSERT land_transactions
    ];
    const fulfiller = checkout.getFulfiller('rent_payment')!;
    const out = await fulfiller(rentCtx());

    expect(out.fulfilled).toBe(true);
    // 40 + 500 = 540 ≥ weekly 100 ⇒ covers a week again ⇒ grace cleared.
    expect(out.detail).toMatchObject({
      parcelCode: 'C-042',
      depositRemainingCt: 540,
      graceCleared: true,
    });

    // NO internal vCLAW moved — no debit (the invariant extension), no credit.
    expect(ledgerCalls).toEqual([]);

    // Lock order: advisory(owner) OUTER, parcel row FOR UPDATE INNER.
    const texts = executeCalls.map((q) => flattenSql(q).text);
    expect(texts[0]).toContain('pg_advisory_xact_lock');
    expect(texts[1]).toContain('FOR UPDATE');
    // Escrow increment shape matches deposit-topup (in-DB addition).
    expect(texts[2]).toContain('deposit_remaining_ct = deposit_remaining_ct +');
    // The NEW audit kind, usd_basis-stamped, NO debit_ledger_tx_id column.
    expect(texts[3]).toContain('land_deposit_prepay_usdc');
    expect(texts[3]).not.toContain('debit_ledger_tx_id');
    const insertParams = flattenSql(executeCalls[3]).params;
    const metaParam = insertParams.find((p) => typeof p === 'string' && (p as string).includes('usdBasis'));
    expect(metaParam).toBeDefined();
    const meta = JSON.parse(metaParam as string) as Record<string, unknown>;
    expect(meta).toMatchObject({
      usdBasis: '5.00',
      usdCents: 500,
      txSignature: 'SIG_RENT_1',
      checkoutId: 'checkout-77',
      newRemaining: 540,
      graceCleared: true,
      refundable: true,
    });

    // No captured SQL ever touches the avatars balance (ledger-only trap).
    for (const t of texts) {
      expect(t).not.toMatch(/claw_tokens|avatars\s+set/i);
    }

    // The owed USDC→CLV buy on the SAME tx.
    expect(enqueueCalls.length).toBe(1);
    expect(enqueueCalls[0]!.input).toMatchObject({
      amountUsdc: '5.000000',
      reason: 'checkout_rent_prepay',
      sourceRef: 'checkout-77',
    });
    expect(enqueueCalls[0]!.tx).toBe(fakeTx);
  });

  it('owner mismatch under the lock ⇒ CheckoutFulfillmentRefusal, NO escrow write', async () => {
    executeQueue = [[], [parcelRow({ owner_avatar_id: 'someone-else' })]];
    const fulfiller = checkout.getFulfiller('rent_payment')!;
    await expect(fulfiller(rentCtx())).rejects.toThrow(/not_parcel_owner/);
    expect(executeCalls.length).toBe(2); // advisory + select only — no UPDATE/INSERT
    expect(enqueueCalls.length).toBe(0);
  });

  it('non-deposit tenure ⇒ refusal; NULL weekly rent ⇒ grace NOT cleared (decideDepositSweep read-only)', async () => {
    executeQueue = [[], [parcelRow({ tenure: 'hold' })]];
    const fulfiller = checkout.getFulfiller('rent_payment')!;
    await expect(fulfiller(rentCtx())).rejects.toThrow(/not_deposit_tenure/);

    executeCalls.length = 0;
    executeQueue = [[], [parcelRow({ rent_ct_weekly: null })], [], []];
    const out = await fulfiller(rentCtx());
    expect(out.detail).toMatchObject({ graceCleared: false }); // no positive weekly ⇒ 'skip'
  });
});
