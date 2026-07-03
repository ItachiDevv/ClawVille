/**
 * x402-payai pure-conversion unit tests (Tokenomics F2).
 *
 * Locks the store buy-price math so a rate edit can't silently regress:
 *   - `CT_PER_USDC = 10` ($0.10/coin) — the F2 founder rate (was 100).
 *   - `usdToCt($10) = 100` (NOT 1000) — the headline store price.
 *   - `usdCentsToUsdcAtomic` is the on-chain USDC unit conversion and is
 *     INDEPENDENT of the vCLAW rate (a dollar is always a dollar of USDC).
 *
 * These are pure functions over integers — no DB, no facilitator, no network.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  CT_PER_USDC,
  usdToCt,
  usdCentsToUsdcAtomic,
  buildPartnerPurchaseQuote,
  settlePartnerPurchase,
} from '../x402-payai';
import { buildMockFacilitator } from '../x402-mock-facilitator';

describe('x402-payai — F2 store buy-price ($0.10/coin)', () => {
  it('CT_PER_USDC is 10 (the F2 founder rate, was 100)', () => {
    expect(CT_PER_USDC).toBe(10);
  });

  it('usdToCt($10) = 100 vCLAW — the headline store price (NOT 1000)', () => {
    // $10 = 1000 cents → (1000/100) * 10 = 100.
    expect(usdToCt(1000)).toBe(100);
  });

  it('usdToCt($1) = 10 vCLAW (1 USDC buys 10 coins)', () => {
    expect(usdToCt(100)).toBe(10);
  });

  it('usdToCt($100) = 1000 vCLAW (linear in the amount)', () => {
    expect(usdToCt(10_000)).toBe(1000);
  });

  it('floors a sub-dime cents amount that cannot mint a whole coin', () => {
    // 5 cents → (5/100)*10 = 0.5 → floor 0. (The route caps usdCents ≥ 1, but the
    // primitive must never mint a fractional coin regardless.)
    expect(usdToCt(5)).toBe(0);
    // 10 cents → exactly 1 coin.
    expect(usdToCt(10)).toBe(1);
  });

  it('rejects a non-positive / non-integer cents amount', () => {
    expect(() => usdToCt(0)).toThrow();
    expect(() => usdToCt(-100)).toThrow();
    expect(() => usdToCt(10.5)).toThrow();
  });
});

describe('x402-payai — USDC atomic conversion is rate-independent', () => {
  it('1 cent → "10000" atomic micro-USDC (6-decimal USDC, 2-decimal USD)', () => {
    expect(usdCentsToUsdcAtomic(1)).toBe('10000');
  });

  it('$1 (100 cents) → "1000000" = 1 USDC', () => {
    expect(usdCentsToUsdcAtomic(100)).toBe('1000000');
  });

  it('$10 (1000 cents) → "10000000" = 10 USDC (the on-chain amount the buyer pays)', () => {
    // Unchanged by the F2 vCLAW rate edit — a $10 buy still moves $10 of USDC
    // on-chain; only the vCLAW the buyer RECEIVES (100) changed.
    expect(usdCentsToUsdcAtomic(1000)).toBe('10000000');
  });
});

/**
 * Phase D partner direct-USDC PRIMITIVES — the ship-gate "mock-x402 harness:
 * partner quote → 402 → settle happy path" proof at the primitive level.
 *
 * Stands up the in-repo mock facilitator (`x402-mock-facilitator.ts`) over an
 * ephemeral Bun HTTP port and points the real `@x402/core` `HTTPFacilitatorClient`
 * (inside `settlePartnerPurchase → verifyAndSettle`) at it via the explicit
 * `X402_FACILITATOR_URL` override. This exercises the REAL verify→settle wire, not
 * a stub — asserting the four money-safety invariants the partner path inherits:
 *   HAPPY        — a payment paying the partner payout pubkey settles with a tx sig.
 *   NO-CUSTODY   — a payTo≠expected mismatch settles NOTHING and never calls the
 *                  facilitator (recipient binding; the whole reason this wrapper exists).
 *   INVALID      — facilitator verify rejection → not settled, settle never runs.
 *   NEVER-THROWS — facilitator HTTP 500 AND an unreachable facilitator both resolve
 *                  to `{settled:false}`, never a throw.
 *
 * NOTE: we use the explicit `X402_FACILITATOR_URL` OVERRIDE (not the `mock`
 * PRESET) so the x402-config boot guard — which crashes the API when the mock
 * PRESET is active off-staging — stays dormant; from `verifyAndSettle`'s view an
 * override URL is just "some facilitator", which is exactly the prod-parity path.
 */
describe('x402-payai — partner direct-USDC primitives (mock-facilitator harness)', () => {
  const PARTNER_PAYOUT = 'PARTNERpayout1111111111111111111111111111111';
  let server: ReturnType<typeof Bun.serve>;
  const priorEnv: Record<string, string | undefined> = {};

  const setEnv = (k: string, v: string) => {
    if (!(k in priorEnv)) priorEnv[k] = process.env[k];
    process.env[k] = v;
  };

  beforeAll(() => {
    // Ephemeral port; the mock router's `.fetch` handles /verify, /settle, /supported.
    const mock = buildMockFacilitator({ log: false });
    server = Bun.serve({ port: 0, fetch: (req) => mock.fetch(req) });

    setEnv('X402_ENABLED', 'true');
    // loadX402Config() THROWS when enabled && !merchant pubkey. The partner path never
    // uses the merchant pubkey (it pays the partner payout), but a dummy keeps the
    // config valid so verifyAndSettle reaches the facilitator instead of failing on config.
    setEnv('CLAWVILLE_MERCHANT_WALLET_PUBKEY', 'MockMerchant11111111111111111111111111111111');
    // Explicit override always wins in resolveFacilitator() — point at our in-test server.
    setEnv('X402_FACILITATOR_URL', `http://127.0.0.1:${server.port}`);
  });

  afterAll(() => {
    server.stop(true);
    for (const [k, v] of Object.entries(priorEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** A base64(JSON) x402 v2 payment header the mock accepts. Extra payload keys
   *  (e.g. `__mock`) ride inside `payload` — the only client-controlled blob that
   *  reaches the facilitator (the mock's negative-testing sentinel channel). */
  const paymentHeader = (network: string, extraPayload: Record<string, unknown> = {}) =>
    Buffer.from(
      JSON.stringify({
        x402Version: 2,
        scheme: 'exact',
        network,
        payload: { payer: 'BUYER1111111111111111111111111111111111111111', ...extraPayload },
      }),
    ).toString('base64');

  const partnerQuote = () =>
    buildPartnerPurchaseQuote({
      payoutPubkey: PARTNER_PAYOUT,
      asset: 'usdc',
      usdCents: 500,
      network: 'devnet',
    });

  it('buildPartnerPurchaseQuote binds payTo to the partner payout pubkey + the on-chain USDC amount', () => {
    const q = partnerQuote();
    expect(q.x402Version).toBe(2);
    expect(q.accepts).toHaveLength(1);
    // NO-CUSTODY at the quote level: the buyer is told to pay the PARTNER, not us.
    expect(q.accepts[0].payTo).toBe(PARTNER_PAYOUT);
    expect(q.accepts[0].amount).toBe(usdCentsToUsdcAtomic(500));
    // devnet CAIP-2 flows through unchanged.
    expect(q.accepts[0].network).toBe('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');
    // Default resource is the partner storefront, NOT the on-ramp /api/ct/topup.
    expect(q.resource.url).toBe('/api/partner/storefront/purchase');
  });

  it('HAPPY: verify→settle against the partner payout pubkey settles with a non-empty tx signature', async () => {
    const q = partnerQuote();
    const res = await settlePartnerPurchase({
      paymentHeader: paymentHeader(q.accepts[0].network),
      requirements: q.accepts[0],
      expectedPayoutPubkey: PARTNER_PAYOUT,
    });
    expect(res.settled).toBe(true);
    expect(res.isValid).toBe(true);
    expect(typeof res.txSignature).toBe('string');
    expect((res.txSignature ?? '').length).toBeGreaterThan(0);
    expect(res.failureReason).toBeNull();
  });

  it('NO-CUSTODY binding: payTo ≠ expectedPayoutPubkey settles NOTHING and never calls the facilitator', async () => {
    const q = partnerQuote(); // requirements.payTo === PARTNER_PAYOUT
    const res = await settlePartnerPurchase({
      paymentHeader: paymentHeader(q.accepts[0].network),
      requirements: q.accepts[0],
      expectedPayoutPubkey: 'DIFFERENTpayout2222222222222222222222222222',
    });
    expect(res.settled).toBe(false);
    expect(res.failureReason).toBe('payout_binding_mismatch');
    // failed() shape — proves we short-circuited BEFORE any facilitator call.
    expect(res.isValid).toBe(false);
    expect(res.txSignature).toBeNull();
    expect(res.raw.verify).toBeUndefined();
    expect(res.raw.settle).toBeUndefined();
  });

  it('NO-CUSTODY binding: an empty expectedPayoutPubkey also settles NOTHING', async () => {
    const q = partnerQuote();
    const res = await settlePartnerPurchase({
      paymentHeader: paymentHeader(q.accepts[0].network),
      requirements: q.accepts[0],
      expectedPayoutPubkey: '',
    });
    expect(res.settled).toBe(false);
    expect(res.failureReason).toBe('payout_binding_mismatch');
    expect(res.raw.verify).toBeUndefined();
  });

  it('INVALID: facilitator verify rejection → not settled, settle never runs', async () => {
    const q = partnerQuote();
    const res = await settlePartnerPurchase({
      paymentHeader: paymentHeader(q.accepts[0].network, { __mock: 'verify-invalid' }),
      requirements: q.accepts[0],
      expectedPayoutPubkey: PARTNER_PAYOUT,
    });
    expect(res.settled).toBe(false);
    expect(res.isValid).toBe(false);
    expect(res.txSignature).toBeNull();
    // verify ran (raw.verify present, reason forwarded) but settle did NOT.
    expect(res.failureReason).toBe('mock_forced_invalid');
    expect(res.raw.verify).toBeDefined();
    expect(res.raw.settle).toBeUndefined();
  });

  it('NEVER-THROWS (facilitator HTTP 500 on verify): resolves to settled:false, not a throw', async () => {
    const q = partnerQuote();
    const res = await settlePartnerPurchase({
      paymentHeader: paymentHeader(q.accepts[0].network, { __mock: 'verify-error' }),
      requirements: q.accepts[0],
      expectedPayoutPubkey: PARTNER_PAYOUT,
    });
    expect(res.settled).toBe(false);
    expect(res.failureReason).toBe('facilitator_verify_error');
    expect(res.txSignature).toBeNull();
  });

  it('NEVER-THROWS (facilitator unreachable): resolves to settled:false, not a throw', async () => {
    const q = partnerQuote();
    const good = process.env.X402_FACILITATOR_URL;
    // Repoint at a closed port for this single case (client rebuilds on URL change).
    process.env.X402_FACILITATOR_URL = 'http://127.0.0.1:9'; // discard port → ECONNREFUSED
    try {
      const res = await settlePartnerPurchase({
        paymentHeader: paymentHeader(q.accepts[0].network),
        requirements: q.accepts[0],
        expectedPayoutPubkey: PARTNER_PAYOUT,
      });
      expect(res.settled).toBe(false);
      expect(res.txSignature).toBeNull();
    } finally {
      if (good === undefined) delete process.env.X402_FACILITATOR_URL;
      else process.env.X402_FACILITATOR_URL = good;
    }
  });
});
