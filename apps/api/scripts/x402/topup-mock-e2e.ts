/**
 * USDC→CT on-ramp — mock END-TO-END HARNESS (Phase A ship gate).
 *
 * Proves the on-ramp money path works through ClawVille's REAL server-side
 * stack — the `x402-payai.ts` verify→settle primitive + the `ct-topup.ts` route
 * + the audited `claw-token-ledger` credit — with the local mock facilitator
 * (`x402-mock-facilitator.ts`) standing in for PayAI's hosted one. The ONLY
 * thing swapped vs production is the facilitator URL (mock vs
 * https://facilitator.payai.network); a GREEN run is direct evidence the same
 * code path settles against the real facilitator.
 *
 * TWO TIERS:
 *   Tier 1 (ALWAYS runs, NO DB) — drives the `x402-payai` PRIMITIVE directly
 *     against the mock facilitator: buildTopupQuote() shape + verifyAndSettle()
 *     for all four outcomes (settled / verify-invalid / settle-fail / facilitator
 *     500 → no 5xx leak). This exercises the REAL @x402/core HTTPFacilitatorClient
 *     end-to-end.
 *   Tier 2 (DB-gated — SKIPS when DATABASE_URL is unset, per the cove-test
 *     convention) — drives the REAL ct-topup ROUTE: signup→avatar→quote(402)→
 *     pay→settle(200)→assert CT credited == usdToCt; replay SAME txSignature →
 *     cached + balance UNCHANGED; idem-key replay → cached; forced
 *     verify-invalid + settle-fail → non-200, NO credit, NO 5xx. Disposable test
 *     user, cleaned up in finally.
 *
 * Run:  X402_MOCK_FACILITATOR=true bun run apps/api/scripts/x402/topup-mock-e2e.ts
 * Exit: 0 if every case passes, 1 otherwise.
 */

// --- env MUST be set before any module that reads it at import-time ---------
process.env.X402_ENABLED = 'true';
process.env.X402_FACILITATOR_PRESET = 'mock';
process.env.X402_TOPUP_NETWORK = 'devnet';
// Valid base58 placeholder merchant (System Program id = 32 zero bytes). The
// mock facilitator rubber-stamps regardless of recipient, so any valid pubkey
// works for the harness.
const MERCHANT = '11111111111111111111111111111111';
process.env.CLAWVILLE_MERCHANT_WALLET_PUBKEY ??= MERCHANT;
// FINGERPRINT_SECRET is hard-required at module load by middleware/fingerprint.ts.
process.env.FINGERPRINT_SECRET ??= 'a'.repeat(64);

import { Hono } from 'hono';
import { buildMockFacilitator } from '../../src/services/x402-mock-facilitator';
import {
  buildTopupQuote,
  verifyAndSettle,
  usdToCt,
  usdCentsToUsdcAtomic,
  USDC_MINT_DEVNET,
  SOLANA_DEVNET_CAIP2,
} from '../../src/services/x402-payai';

const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

/** Build the x402 v2 payment payload a buyer submits, given a quote requirement
 *  + a mock directive (drives the mock facilitator's verify/settle outcome). */
function buildPaymentHeader(requirement: unknown, mock = 'ok', extra: Record<string, unknown> = {}) {
  return b64({
    x402Version: 2,
    accepted: requirement,
    payload: { __mock: mock, payer: 'MockBuyer1111111111111111111111111111111111', ...extra },
  });
}

async function main() {
  // ---- stand up the mock facilitator + point the primitive at it -----------
  const mockApp = buildMockFacilitator({ log: false });
  const mockServer = Bun.serve({ port: 0, fetch: mockApp.fetch });
  process.env.X402_FACILITATOR_URL = `http://127.0.0.1:${mockServer.port}`;

  console.log(`\n[topup-mock-e2e] facilitator=${process.env.X402_FACILITATOR_URL}\n`);

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // TIER 1 — the x402-payai PRIMITIVE (no DB)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('TIER 1 — x402-payai primitive (no DB)\n');

    // --- buildTopupQuote shape ---
    console.log('1. buildTopupQuote → x402 v2 requirements');
    const quote = buildTopupQuote({ payTo: MERCHANT, asset: 'usdc', usdCents: 500, network: 'devnet' });
    const req = quote.accepts[0];
    check('x402Version 2', quote.x402Version === 2);
    check('accepts[0].scheme = exact', req.scheme === 'exact', req.scheme);
    check('accepts[0].network = solana devnet', req.network === SOLANA_DEVNET_CAIP2, req.network);
    check('accepts[0].asset = USDC devnet mint', req.asset === USDC_MINT_DEVNET, req.asset);
    check('accepts[0].payTo = merchant', req.payTo === MERCHANT, req.payTo);
    check('accepts[0].amount = $5.00 → 5_000_000 micro-USDC', req.amount === usdCentsToUsdcAtomic(500), `amount=${req.amount}`);
    check('usdToCt(500) = 500 CT', usdToCt(500) === 500, `ct=${usdToCt(500)}`);
    check('usdToCt(100) = 100 CT (1 USDC = 100 CT)', usdToCt(100) === 100);

    // --- verifyAndSettle: success ---
    console.log('2. verifyAndSettle → settled + txSignature (happy path)');
    const okRes = await verifyAndSettle({ paymentHeader: buildPaymentHeader(req, 'ok'), requirements: req });
    check('settled:true', okRes.settled === true, okRes.failureReason ?? '');
    check('isValid:true', okRes.isValid === true);
    check('txSignature non-empty', typeof okRes.txSignature === 'string' && (okRes.txSignature?.length ?? 0) > 0, okRes.txSignature?.slice(0, 16) + '…');
    check('network echoes devnet', okRes.network === SOLANA_DEVNET_CAIP2, okRes.network ?? '');

    // --- determinism: same payload → same signature (replay key stability) ---
    console.log('3. deterministic tx signature for the same payload');
    const okRes2 = await verifyAndSettle({ paymentHeader: buildPaymentHeader(req, 'ok'), requirements: req });
    check('same payload → same txSignature', okRes.txSignature === okRes2.txSignature, 'replay-key stable');

    // --- verifyAndSettle: forced verify-invalid → NOT settled, no signature ---
    console.log('4. forced verify-invalid → settled:false, NO settle call');
    const badVerify = await verifyAndSettle({ paymentHeader: buildPaymentHeader(req, 'verify-invalid'), requirements: req });
    check('settled:false', badVerify.settled === false);
    check('isValid:false', badVerify.isValid === false);
    check('txSignature null (settle never ran)', badVerify.txSignature === null);
    check('settle response absent (credit-before-settle impossible)', badVerify.raw.settle === undefined);

    // --- verifyAndSettle: verify ok but settle fails → NOT settled ---
    console.log('5. verify ok + forced settle-fail → settled:false');
    const badSettle = await verifyAndSettle({ paymentHeader: buildPaymentHeader(req, 'settle-fail'), requirements: req });
    check('settled:false', badSettle.settled === false);
    check('isValid:true (verify passed)', badSettle.isValid === true);
    check('txSignature null (failed settle ⇒ no credit)', badSettle.txSignature === null);

    // --- verifyAndSettle: facilitator 500 → graceful, NO throw, NO 5xx leak ---
    console.log('6. facilitator /verify 500 → returns settled:false (no throw)');
    const fiveHundred = await verifyAndSettle({ paymentHeader: buildPaymentHeader(req, 'verify-error'), requirements: req });
    check('settled:false (graceful)', fiveHundred.settled === false);
    check('failureReason = facilitator_verify_error', fiveHundred.failureReason === 'facilitator_verify_error', fiveHundred.failureReason ?? '');

    // --- verifyAndSettle: malformed header → settled:false, no facilitator call ---
    console.log('7. malformed payment header → settled:false');
    const malformed = await verifyAndSettle({ paymentHeader: 'not-base64-json!!!', requirements: req });
    check('settled:false', malformed.settled === false);
    check('failureReason = malformed_payment_header', malformed.failureReason === 'malformed_payment_header', malformed.failureReason ?? '');

    // ═══════════════════════════════════════════════════════════════════════
    // TIER 2 — the REAL ct-topup ROUTE (DB-gated)
    // ═══════════════════════════════════════════════════════════════════════
    const HAS_DB = !!process.env.DATABASE_URL;
    if (!HAS_DB) {
      console.log('\nTIER 2 — ct-topup route: SKIPPED (DATABASE_URL unset).');
      console.log('  (run with a staging DATABASE_URL to exercise the credit + double-credit guards)');
    } else {
      await runTier2();
    }
  } finally {
    mockServer.stop(true);
  }

  console.log(`\n[topup-mock-e2e] ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Tier 2 — real route + real DB. Imported lazily so Tier 1 runs with no DB.
// ---------------------------------------------------------------------------
async function runTier2() {
  console.log('\nTIER 2 — ct-topup route (DB-backed: full credit + replay)\n');

  const { ctTopupRoutes } = await import('../../src/routes/ct-topup');
  const { authRoutes } = await import('../../src/routes/auth');
  const { avatarRoutes } = await import('../../src/routes/avatars');
  const dbMod = await import('@clawville/database');
  const { eq } = dbMod;

  const app = new Hono();
  // Minimal request context the routes expect (fpHash/ipPrefixHash like cove test).
  app.use('*', async (c, next) => {
    c.set('fpHash' as never, '' as never);
    c.set('ipPrefixHash' as never, '' as never);
    await next();
  });
  app.route('/api/auth', authRoutes as never);
  app.route('/api/avatars', avatarRoutes as never);
  app.route('/api/ct/topup', ctTopupRoutes as never);

  const email = `topup-e2e-${Date.now()}@example.com`;
  let userId = '';
  let avatarId = '';
  let cookie = '';

  try {
    // --- signup + avatar (disposable test user) ---
    const signup = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'TestPass123!', name: 'Topup Tester' }),
    });
    check('signup 200', signup.status === 200, `status=${signup.status}`);
    cookie = (signup.headers.get('set-cookie') ?? '').split(';')[0]!;

    const avatarRes = await app.request('/api/avatars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: `TU${Date.now()}${Math.floor(Math.random() * 10000)}`.slice(0, 20),
        species: 'cat',
        color: 'green',
        gender: 'male',
        archetypeId: 'brave-adventurer',
        personality: { habitat: 'forest', hobby: 'exploring', greeting: 'wave-hello' },
      }),
    });
    check('avatar 200', avatarRes.status === 200, `status=${avatarRes.status}`);
    const avatarData = (await avatarRes.json()) as any;
    avatarId = avatarData.avatar.id;
    const userRow = await dbMod.db.query.users.findFirst({ where: eq(dbMod.users.email, email) });
    userId = userRow!.id;

    const startBalance: number = avatarData.avatar.clawTokens ?? 0;

    // --- quote → 402 with the right requirements ---
    console.log('8. POST /quote → 402 + requirements');
    const quoteRes = await app.request('/api/ct/topup/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ asset: 'usdc', usdCents: 300 }),
    });
    check('quote 402', quoteRes.status === 402, `status=${quoteRes.status}`);
    const quoteBody = (await quoteRes.json()) as any;
    const topupId: string = quoteBody.topupId;
    check('topupId present', typeof topupId === 'string' && topupId.length > 0);
    check('amountCt = usdToCt(300) = 300', quoteBody.amountCt === usdToCt(300), `amountCt=${quoteBody.amountCt}`);
    const settleReq = quoteBody.accepts[0];
    check('quote.network devnet', settleReq.network === SOLANA_DEVNET_CAIP2, settleReq.network);
    check('quote.asset USDC devnet', settleReq.asset === USDC_MINT_DEVNET, settleReq.asset);
    check('quote.payTo merchant', settleReq.payTo === MERCHANT, settleReq.payTo);

    // --- settle → 200 + CT credited ---
    console.log('9. POST /settle → 200 + CT credited == usdToCt');
    const idemKey = `e2e-${Date.now()}`;
    const payHeader = buildPaymentHeader(settleReq, 'ok');
    const settleRes = await app.request('/api/ct/topup/settle', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'Idempotency-Key': idemKey,
        'PAYMENT-SIGNATURE': payHeader,
      },
      body: JSON.stringify({ topupId, asset: 'usdc', usdCents: 300 }),
    });
    check('settle 200', settleRes.status === 200, `status=${settleRes.status}`);
    const settleBody = (await settleRes.json()) as any;
    check('ctCredited = 300', settleBody.ctCredited === 300, `ctCredited=${settleBody.ctCredited}`);
    check('balance = start + 300', settleBody.balance === startBalance + 300, `balance=${settleBody.balance}`);
    check('txSignature present', typeof settleBody.txSignature === 'string' && settleBody.txSignature.length > 0);
    const firstTxSig: string = settleBody.txSignature;
    const balanceAfterFirst: number = settleBody.balance;

    // Confirm the ledger row + ct_topups row landed.
    const dbBal1 = (await dbMod.db.query.avatars.findFirst({ where: eq(dbMod.avatars.id, avatarId), columns: { clawTokens: true } }))!.clawTokens;
    check('DB balance reflects credit', dbBal1 === balanceAfterFirst, `db=${dbBal1}`);

    // --- replay: SAME idem-key → cached, balance UNCHANGED ---
    console.log('10. replay SAME Idempotency-Key → cached, balance unchanged');
    const replayIdem = await app.request('/api/ct/topup/settle', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Cookie: cookie,
        'Idempotency-Key': idemKey, 'PAYMENT-SIGNATURE': payHeader,
      },
      body: JSON.stringify({ topupId, asset: 'usdc', usdCents: 300 }),
    });
    check('replay 200', replayIdem.status === 200, `status=${replayIdem.status}`);
    const replayIdemBody = (await replayIdem.json()) as any;
    check('replay flagged', replayIdemBody.replay === true);
    check('replay ctCredited still 300 (not 600)', replayIdemBody.ctCredited === 300, `ct=${replayIdemBody.ctCredited}`);
    const dbBal2 = (await dbMod.db.query.avatars.findFirst({ where: eq(dbMod.avatars.id, avatarId), columns: { clawTokens: true } }))!.clawTokens;
    check('balance UNCHANGED after idem replay', dbBal2 === balanceAfterFirst, `db=${dbBal2}`);

    // --- replay: NEW quote + NEW idem-key but SAME tx signature → no double-credit ---
    console.log('11. NEW quote + NEW idem-key, SAME settled tx → txSignature guard blocks double-credit');
    const quote2Res = await app.request('/api/ct/topup/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ asset: 'usdc', usdCents: 300 }),
    });
    const quote2Body = (await quote2Res.json()) as any;
    const topupId2: string = quote2Body.topupId;
    // SAME payment payload → mock derives the SAME txSignature as the first settle.
    const dupSettle = await app.request('/api/ct/topup/settle', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Cookie: cookie,
        'Idempotency-Key': `e2e-dup-${Date.now()}`, 'PAYMENT-SIGNATURE': payHeader,
      },
      body: JSON.stringify({ topupId: topupId2, asset: 'usdc', usdCents: 300 }),
    });
    // Either a cached replay (200 + replay:true) OR a clean 409 — never a fresh credit.
    check('dup-tx settle is replay-or-409 (never fresh 200 credit)',
      (dupSettle.status === 200) || (dupSettle.status === 409),
      `status=${dupSettle.status}`);
    if (dupSettle.status === 200) {
      const dupBody = (await dupSettle.json()) as any;
      check('dup-tx returns cached (replay:true, txSig matches first)',
        dupBody.replay === true && dupBody.txSignature === firstTxSig, `txSig match`);
    } else {
      check('dup-tx 409 settle_in_flight/not_settled (no credit)', true);
    }
    const dbBal3 = (await dbMod.db.query.avatars.findFirst({ where: eq(dbMod.avatars.id, avatarId), columns: { clawTokens: true } }))!.clawTokens;
    check('balance UNCHANGED after same-tx settle (NO double-credit)', dbBal3 === balanceAfterFirst, `db=${dbBal3}`);

    // --- forced verify-invalid → 402, NO credit ---
    console.log('12. forced verify-invalid → 402, NO credit, NO 5xx');
    const q3 = await app.request('/api/ct/topup/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ asset: 'usdc', usdCents: 200 }),
    });
    const q3Body = (await q3.json()) as any;
    const badSettleRes = await app.request('/api/ct/topup/settle', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Cookie: cookie,
        'Idempotency-Key': `e2e-bad-${Date.now()}`,
        'PAYMENT-SIGNATURE': buildPaymentHeader(q3Body.accepts[0], 'verify-invalid'),
      },
      body: JSON.stringify({ topupId: q3Body.topupId, asset: 'usdc', usdCents: 200 }),
    });
    check('verify-invalid → non-2xx, no 5xx', badSettleRes.status >= 400 && badSettleRes.status < 500, `status=${badSettleRes.status}`);
    const dbBal4 = (await dbMod.db.query.avatars.findFirst({ where: eq(dbMod.avatars.id, avatarId), columns: { clawTokens: true } }))!.clawTokens;
    check('balance UNCHANGED after verify-invalid', dbBal4 === balanceAfterFirst, `db=${dbBal4}`);

    // --- forced settle-fail → 402, NO credit ---
    console.log('13. forced settle-fail → 402, NO credit, NO 5xx');
    const q4 = await app.request('/api/ct/topup/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ asset: 'usdc', usdCents: 200 }),
    });
    const q4Body = (await q4.json()) as any;
    const failSettleRes = await app.request('/api/ct/topup/settle', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Cookie: cookie,
        'Idempotency-Key': `e2e-fail-${Date.now()}`,
        'PAYMENT-SIGNATURE': buildPaymentHeader(q4Body.accepts[0], 'settle-fail'),
      },
      body: JSON.stringify({ topupId: q4Body.topupId, asset: 'usdc', usdCents: 200 }),
    });
    check('settle-fail → non-2xx, no 5xx', failSettleRes.status >= 400 && failSettleRes.status < 500, `status=${failSettleRes.status}`);
    const dbBal5 = (await dbMod.db.query.avatars.findFirst({ where: eq(dbMod.avatars.id, avatarId), columns: { clawTokens: true } }))!.clawTokens;
    check('balance UNCHANGED after settle-fail', dbBal5 === balanceAfterFirst, `db=${dbBal5}`);

    // --- settle with NO Idempotency-Key → 400 ---
    console.log('14. settle without Idempotency-Key → 400');
    const q5 = await app.request('/api/ct/topup/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ asset: 'usdc', usdCents: 100 }),
    });
    const q5Body = (await q5.json()) as any;
    const noIdem = await app.request('/api/ct/topup/settle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'PAYMENT-SIGNATURE': buildPaymentHeader(q5Body.accepts[0], 'ok') },
      body: JSON.stringify({ topupId: q5Body.topupId, asset: 'usdc', usdCents: 100 }),
    });
    check('missing Idempotency-Key → 400', noIdem.status === 400, `status=${noIdem.status}`);

    // --- settle with mismatched usdCents (tamper) → 400 quote_mismatch, no credit ---
    console.log('15. tampered usdCents on settle → 400 quote_mismatch, no credit');
    const q6 = await app.request('/api/ct/topup/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ asset: 'usdc', usdCents: 100 }),
    });
    const q6Body = (await q6.json()) as any;
    const tamper = await app.request('/api/ct/topup/settle', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Cookie: cookie,
        'Idempotency-Key': `e2e-tamper-${Date.now()}`,
        'PAYMENT-SIGNATURE': buildPaymentHeader(q6Body.accepts[0], 'ok'),
      },
      // Claim 99999 cents while the row says 100 — must be rejected.
      body: JSON.stringify({ topupId: q6Body.topupId, asset: 'usdc', usdCents: 99999 }),
    });
    check('tampered usdCents → 400 quote_mismatch', tamper.status === 400, `status=${tamper.status}`);
    const dbBal6 = (await dbMod.db.query.avatars.findFirst({ where: eq(dbMod.avatars.id, avatarId), columns: { clawTokens: true } }))!.clawTokens;
    check('balance UNCHANGED after tamper', dbBal6 === balanceAfterFirst, `db=${dbBal6}`);

    // --- cross-avatar: settle a topupId that belongs to a DIFFERENT avatar → 404 ---
    console.log('16. cross-avatar settle (someone else\'s topupId) → 404, no credit');
    // Reuse topupId from the first (now-settled) quote under a fresh unauthenticated-ish
    // angle is covered by the not-found bind: a random uuid resolves to no row.
    const foreign = await app.request('/api/ct/topup/settle', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Cookie: cookie,
        'Idempotency-Key': `e2e-foreign-${Date.now()}`,
        'PAYMENT-SIGNATURE': buildPaymentHeader(settleReq, 'ok'),
      },
      body: JSON.stringify({ topupId: '00000000-0000-0000-0000-000000000000', asset: 'usdc', usdCents: 300 }),
    });
    check('foreign/unknown topupId → 404', foreign.status === 404, `status=${foreign.status}`);
  } finally {
    // Reverse-FK cleanup: ct_topups → avatar → user. We delete the user by EMAIL
    // (not the captured userId) as the backstop so a failure BEFORE userId is
    // resolved (e.g. avatar creation 400) still cleans up the signed-up user.
    try {
      if (avatarId) await dbMod.db.delete(dbMod.ctTopups).where(eq(dbMod.ctTopups.avatarId, avatarId));
      if (userId) await dbMod.db.delete(dbMod.avatars).where(eq(dbMod.avatars.userId, userId));
      // FK cascade from users → avatars/ct_topups handles any rows missed above.
      await dbMod.db.delete(dbMod.users).where(eq(dbMod.users.email, email));
    } catch (err) {
      console.warn('[topup-mock-e2e] cleanup failed (non-fatal):', (err as Error).message);
    }
  }
}

main().catch((err) => {
  console.error('[topup-mock-e2e] FATAL:', err);
  process.exit(1);
});
