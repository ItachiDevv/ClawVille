/**
 * CT-TOPUP ON-RAMP SETTLE — durable settle machine (Codex money-path review
 * fast-follow). LIGHT + DETERMINISTIC — no real Postgres, no facilitator network.
 *
 * The on-ramp shared x402_checkouts' pre-hardening residual (the signature was
 * persisted only inside the credit tx ⇒ a post-settle failure re-settled real
 * USDC). ct_topups now mirrors the same machine; this suite proves the wired
 * route behaviour:
 *   1. CLAIM (pending→settling, idempotency key staked) runs BEFORE the
 *      facilitator; an idem-key reused on another top-up ⇒ 409 conflict, NO money.
 *   2. CAPTURE persists the signature in its own committed UPDATE BEFORE the
 *      credit; a capture 23505 (signature owned by another top-up) ⇒ 409
 *      reconcile, the credit NEVER runs.
 *   3. CREDIT (flip settling→settled + creditClawTokens BOUGHT) is resumable: a
 *      captured-but-uncredited row RESUMES without re-calling the facilitator; a
 *      settled row replays; a settled row WITHOUT a signature refuses replay.
 *   4. A stale settling claim (no signature) ⇒ 409 reconcile (money-state
 *      unknown, NEVER auto-retried); a fresh one ⇒ 409 settle_in_flight.
 *   5. Definitive verify failure ⇒ 402 (terminal failed); transient ⇒ 402 with
 *      the claim RELEASED back to pending. Client-echo mismatch ⇒ 400.
 *   6. CONSERVATION: the credit is BOUGHT with a usd_basis; no other ledger
 *      writer is called.
 *
 * DB + facilitator + ledger are stubbed; middleware is a passthrough injecting a
 * fixed ledger identity. The credit is driven through the real Hono route.
 */

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

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { Hono } from 'hono';
import * as realDatabase from '@clawville/database';
import * as realPayai from '../../services/x402-payai';
import * as realLedger from '../../services/claw-token-ledger';
import * as realAuthMw from '../../middleware/auth';
import * as realAoaMw from '../../middleware/require-auth-or-agent';
import * as realNgMw from '../../middleware/require-non-guest';

// ── LEAK GUARD (bun mock.module is process-global — every mock below DELEGATES
//    to the real impl unless THIS suite's intercept flag is on; released in
//    afterAll). Originals captured BEFORE mock.module patches the namespaces in
//    place. This is what keeps sibling route tests' REAL auth intact. ─────────
let intercept = true;
afterAll(() => {
  intercept = false;
});
const REAL_verifyAndSettle = realPayai.verifyAndSettle;
const REAL_resolveFeePayer = realPayai.resolveFacilitatorFeePayer;
const REAL_credit = realLedger.creditClawTokens;
type Mw = (c: any, next: any) => unknown;
const REAL_sessionMiddleware = realAuthMw.sessionMiddleware as Mw;
const REAL_requireAuth = realAuthMw.requireAuth as Mw;
const REAL_requireAoa = realAoaMw.requireAuthOrAgentSession as Mw;
const REAL_requireNonGuestIdentity = realNgMw.requireNonGuestIdentity as Mw;
const REAL_requireNonGuestUser = realNgMw.requireNonGuestUser as Mw;
const guard = (mockFn: Mw, realFn: Mw): Mw => (c, next) => (intercept ? mockFn(c, next) : realFn(c, next));

// ── @clawville/database stub (findFirst queue + update returning queue) ──────
type Row = Record<string, unknown>;
const updateCalls: Array<Row> = [];
let updateReturningImpl: () => Row[] = () => [{ id: 'topup-1' }];
let updateReturningQueue: Array<() => Row[]> = [];
let findFirstQueue: Array<Row | undefined> = [];
let txRan = 0;

function whereResult() {
  const p = Promise.resolve([] as Row[]);
  return {
    returning: async (_sel: unknown) => {
      const step = updateReturningQueue.length > 0 ? updateReturningQueue.shift()! : updateReturningImpl;
      return step();
    },
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    finally: p.finally.bind(p),
  };
}
function makeUpdate() {
  return (_t: unknown) => ({
    set: (s: Row) => {
      updateCalls.push(s);
      return { where: (_w: unknown) => whereResult() };
    },
  });
}
const receiptInsertCalls: Row[] = [];
const fakeTx = {
  update: makeUpdate(),
  insert: (_table: unknown) => ({
    values: (value: Row) => {
      receiptInsertCalls.push(value);
      return {
        onConflictDoNothing: (_opts: unknown) => ({
          returning: async () => [{ ...value, createdAt: new Date() }],
        }),
      };
    },
  }),
};
const fakeDb = {
  ...(realDatabase as unknown as { db: Record<string, unknown> }).db,
  update: makeUpdate(),
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    txRan += 1;
    return fn(fakeTx);
  },
  query: {
    ctTopups: { findFirst: async (_o: unknown) => findFirstQueue.shift() },
    avatars: { findFirst: async (_o: unknown) => ({ clawTokens: 7777 }) },
  },
};
mock.module('@clawville/database', () => ({ ...realDatabase, db: fakeDb }));

// ── x402-payai: REAL peg/quote; stub only the facilitator boundary ──────────
let verifyAndSettleCalls = 0;
let verifyAndSettleResult: Partial<realPayai.VerifyAndSettleResult> = {};
mock.module('../../services/x402-payai', () => ({
  ...realPayai,
  resolveFacilitatorFeePayer: async (n: realPayai.X402Network) =>
    intercept ? null : REAL_resolveFeePayer(n),
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

// ── claw-token-ledger: creditClawTokens spy (records the CONSERVATION shape) ─
const creditCalls: Array<realLedger.LedgerCreditInput> = [];
mock.module('../../services/claw-token-ledger', () => ({
  ...realLedger,
  creditClawTokens: async (input: realLedger.LedgerCreditInput, tx?: unknown) => {
    if (!intercept) return REAL_credit(input, tx as never);
    creditCalls.push(input);
    return { balanceAfter: 7777 + input.amount, ledgerId: 'ledger-1' };
  },
}));

// ── middleware passthrough injecting a fixed ledger identity (leak-guarded:
//    DELEGATES to the real middleware for every OTHER route test) ────────────
const IDENTITY = { avatarId: 'avatar-1', userId: 'user-1', kind: 'agent' as const };
const passIdentity: Mw = async (c, next) => {
  (c as { set: (k: string, v: unknown) => void }).set('identity', IDENTITY);
  await next();
};
const passthrough: Mw = async (_c, next) => {
  await next();
};
mock.module('../../middleware/auth', () => ({
  ...realAuthMw,
  sessionMiddleware: guard(passthrough, REAL_sessionMiddleware),
  requireAuth: guard(passthrough, REAL_requireAuth),
}));
mock.module('../../middleware/require-auth-or-agent', () => ({
  ...realAoaMw,
  requireAuthOrAgentSession: guard(passIdentity, REAL_requireAoa),
}));
mock.module('../../middleware/require-non-guest', () => ({
  ...realNgMw,
  requireNonGuestIdentity: guard(passthrough, REAL_requireNonGuestIdentity),
  requireNonGuestUser: guard(passthrough, REAL_requireNonGuestUser),
}));

const { ctTopupRoutes } = await import('../ct-topup');
if (!DB_URL_WAS_SET) delete process.env.DATABASE_URL;

function buildApp() {
  const app = new Hono();
  app.route('/api/ct/topup', ctTopupRoutes);
  return app;
}
const app = buildApp();

/** A valid UUID for the settle body (Zod `.uuid()`); the mock findFirst ignores
 *  the WHERE, so the row ids below need not match — only the body must parse. */
const TOPUP_ID = 'a1a1a1a1-0000-4000-8000-000000000001';

/** POST /settle with the standard headers + body echo. */
async function settle(body: Record<string, unknown> = { topupId: TOPUP_ID, asset: 'usdc', usdCents: 500 }) {
  return app.request('/api/ct/topup/settle', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': 'idem-1',
      'PAYMENT-SIGNATURE': 'aGVhZGVy',
    },
    body: JSON.stringify(body),
  });
}

/** A pending ct_topups row as the query stub returns it. */
function pendingRow(overrides: Row = {}): Row {
  return {
    id: 'topup-1',
    avatarId: 'avatar-1',
    userId: 'user-1',
    rail: 'x402',
    amountCt: 500,
    txSignature: null,
    usdBasisAtReceipt: null,
    status: 'pending',
    settlingId: null,
    settlingStartedAt: null,
    idempotencyKey: null,
    metadata: { asset: 'usdc', usdCents: 500, network: 'devnet' },
    ...overrides,
  };
}
function capturedRow(overrides: Row = {}): Row {
  return pendingRow({
    status: 'settling',
    txSignature: 'SIG_TOPUP_1',
    usdBasisAtReceipt: '5.00',
    settlingId: 'claim-1',
    settlingStartedAt: new Date().toISOString(),
    metadata: { asset: 'usdc', usdCents: 500, network: 'devnet', txSignature: 'SIG_TOPUP_1' },
    ...overrides,
  });
}
function settlingNoSig(ageMs: number, overrides: Row = {}): Row {
  return pendingRow({
    status: 'settling',
    txSignature: null,
    settlingId: 'claim-x',
    settlingStartedAt: new Date(Date.now() - ageMs).toISOString(),
    ...overrides,
  });
}
const throw23505 = () => () => {
  throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
};

beforeEach(() => {
  updateCalls.length = 0;
  creditCalls.length = 0;
  receiptInsertCalls.length = 0;
  updateReturningImpl = () => [{ id: 'topup-1', amountCt: 500 }];
  updateReturningQueue = [];
  findFirstQueue = [];
  txRan = 0;
  verifyAndSettleCalls = 0;
  verifyAndSettleResult = {
    settled: true,
    isValid: true,
    txSignature: 'SIG_TOPUP_1',
    network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    payer: 'PayerPubkey111',
    failureReason: null,
  };
});

describe('ct-topup settle — durable claim → capture → resumable credit', () => {
  it('happy settle: CLAIM (settling+idem) → facilitator → CAPTURE (signature) → CREDIT BOUGHT', async () => {
    findFirstQueue = [pendingRow(), capturedRow()]; // step-1 load, step-8 re-read
    const res = await settle();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ctCredited).toBe(500);
    expect(json.txSignature).toBe('SIG_TOPUP_1');
    expect(json.balance).toBe(7777 + 500);
    expect(verifyAndSettleCalls).toBe(1);
    expect(txRan).toBe(1); // only the credit runs in a tx
    expect(receiptInsertCalls).toHaveLength(1);
    expect(receiptInsertCalls[0]).toMatchObject({
      txSignature: 'SIG_TOPUP_1',
      rail: 'ct_topup',
      referenceId: 'topup-1',
      amountUsdcAtomic: 5_000_000n,
    });

    // CLAIM staked settling + idem key BEFORE the facilitator.
    const claim = updateCalls.find((s) => s.status === 'settling');
    expect(claim).toBeDefined();
    expect(claim!.idempotencyKey).toBe('idem-1');
    expect(claim!.settlingId).toBeTruthy();
    // CAPTURE persisted the signature in its own UPDATE (no status change).
    const capture = updateCalls.find((s) => s.txSignature === 'SIG_TOPUP_1' && s.status === undefined);
    expect(capture).toBeDefined();
    expect(capture!.usdBasisAtReceipt).toBe('5.00');
    // FLIP settling → settled.
    expect(updateCalls.find((s) => s.status === 'settled')).toBeDefined();

    // CONSERVATION: exactly one credit, BOUGHT, with the usd_basis.
    expect(creditCalls.length).toBe(1);
    expect(creditCalls[0]!.provenance).toBe('bought');
    expect(creditCalls[0]!.usdBasis).toBe('5.00');
    expect(creditCalls[0]!.amount).toBe(500);
    expect(creditCalls[0]!.reason).toBe('topup_usdc');
  });

  it('RESUME: a captured row (settling+sig) credits WITHOUT re-calling the facilitator', async () => {
    findFirstQueue = [capturedRow()];
    const res = await settle();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ctCredited).toBe(500);
    expect(verifyAndSettleCalls).toBe(0); // NEVER re-called on resume
    expect(creditCalls.length).toBe(1);
  });

  it('settled row on load ⇒ idempotent replay; facilitator + credit untouched', async () => {
    findFirstQueue = [pendingRow({ status: 'settled', txSignature: 'SIG_PRIOR' })];
    const res = await settle();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.replay).toBe(true);
    expect(json.txSignature).toBe('SIG_PRIOR');
    expect(verifyAndSettleCalls).toBe(0);
    expect(creditCalls.length).toBe(0);
  });

  it('settled row WITHOUT a signature ⇒ replay REFUSED (corruption guard)', async () => {
    findFirstQueue = [pendingRow({ status: 'settled', txSignature: null })];
    const res = await settle();
    expect(res.status).toBe(500);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('settle_failed');
    expect(creditCalls.length).toBe(0);
  });

  it('idem-key reuse on ANOTHER top-up ⇒ claim 23505 ⇒ 409 conflict, NO money', async () => {
    findFirstQueue = [pendingRow()];
    updateReturningQueue = [throw23505()]; // the CLAIM trips (avatar,key) UNIQUE
    const res = await settle();
    expect(res.status).toBe(409);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('idempotency_key_conflict');
    expect(verifyAndSettleCalls).toBe(0);
    expect(creditCalls.length).toBe(0);
  });

  it('SIGNATURE CONFLICT: capture 23505 (sig owned by another top-up) ⇒ 409 reconcile, credit ZERO', async () => {
    findFirstQueue = [pendingRow()];
    updateReturningQueue = [() => [{ id: 'topup-1' }], throw23505()]; // claim ok, CAPTURE 23505
    const res = await settle();
    expect(res.status).toBe(409);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('signature_conflict');
    expect(json.status).toBe('reconcile');
    expect(verifyAndSettleCalls).toBe(1); // money moved ⇒ reconcile, not a clean fail
    expect(creditCalls.length).toBe(0); // NEVER credited on another top-up's signature
    expect(updateCalls.find((s) => s.status === 'reconcile')).toBeDefined();
  });

  it('DEFINITIVE verify rejection ⇒ 402 terminal failed; no credit', async () => {
    findFirstQueue = [pendingRow()];
    verifyAndSettleResult = { settled: false, isValid: false, txSignature: null, failureReason: 'payment_invalid' };
    const res = await settle();
    expect(res.status).toBe(402);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('payment_not_settled');
    expect(json.transient).toBe(false);
    expect(updateCalls.find((s) => s.status === 'failed')).toBeDefined();
    expect(creditCalls.length).toBe(0);
  });

  it('VERIFY-phase transport error ⇒ 402, claim RELEASED to pending (no money, no failed)', async () => {
    findFirstQueue = [pendingRow()];
    verifyAndSettleResult = { settled: false, isValid: false, txSignature: null, failureReason: 'facilitator_verify_error' };
    const res = await settle();
    expect(res.status).toBe(402);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.transient).toBe(true);
    expect(updateCalls.find((s) => s.status === 'pending')).toBeDefined(); // released
    expect(updateCalls.find((s) => s.status === 'failed')).toBeUndefined();
  });

  it('SETTLE-phase error (ambiguous) ⇒ 409 reconcile, NEVER pending (Codex round-2 BLOCKING)', async () => {
    findFirstQueue = [pendingRow()];
    // The /settle call was attempted and threw — the settlement MAY have landed.
    verifyAndSettleResult = { settled: false, isValid: false, txSignature: null, failureReason: 'facilitator_settle_error' };
    const res = await settle();
    expect(res.status).toBe(409);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('topup_reconciliation');
    expect(json.status).toBe('reconcile');
    // Money-state UNKNOWN ⇒ never released to pending (no retry may re-settle).
    expect(updateCalls.find((s) => s.status === 'reconcile')).toBeDefined();
    expect(updateCalls.find((s) => s.status === 'pending')).toBeUndefined();
    expect(updateCalls.find((s) => s.status === 'failed')).toBeUndefined();
    expect(creditCalls.length).toBe(0);
  });

  it('post-settle independent proof failure preserves the signature and credits nothing', async () => {
    findFirstQueue = [pendingRow()];
    verifyAndSettleResult = {
      settled: false,
      isValid: true,
      txSignature: 'SIG_CHAIN_UNAVAILABLE',
      failureReason: 'independent_chain_unavailable',
    };
    const res = await settle();
    expect(res.status).toBe(409);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('topup_reconciliation');
    expect(updateCalls.find((s) => s.status === 'reconcile')).toBeDefined();
    expect(creditCalls).toHaveLength(0);
  });

  it('STALE settling claim (no signature, aged) ⇒ 409 reconcile, facilitator NOT re-called', async () => {
    findFirstQueue = [settlingNoSig(10 * 60_000), pendingRow({ status: 'reconcile', txSignature: null })];
    const res = await settle();
    expect(res.status).toBe(409);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('topup_reconciliation');
    expect(verifyAndSettleCalls).toBe(0);
    expect(updateCalls.find((s) => s.status === 'reconcile')).toBeDefined();
  });

  it('FRESH settling claim (no signature, recent) ⇒ 409 settle_in_flight', async () => {
    findFirstQueue = [settlingNoSig(1_000)];
    const res = await settle();
    expect(res.status).toBe(409);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('settle_in_flight');
    expect(verifyAndSettleCalls).toBe(0);
  });

  it('client-echo mismatch (usdCents disagrees with the row) ⇒ 400 quote_mismatch, no claim', async () => {
    findFirstQueue = [pendingRow()];
    const res = await settle({ topupId: TOPUP_ID, asset: 'usdc', usdCents: 999 });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('quote_mismatch');
    expect(verifyAndSettleCalls).toBe(0);
    expect(updateCalls.find((s) => s.status === 'settling')).toBeUndefined();
  });

  it('foreign topupId (caller-bound load misses) ⇒ 404, facilitator untouched', async () => {
    findFirstQueue = [undefined];
    const res = await settle();
    expect(res.status).toBe(404);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('topup_not_found');
    expect(verifyAndSettleCalls).toBe(0);
  });
});
