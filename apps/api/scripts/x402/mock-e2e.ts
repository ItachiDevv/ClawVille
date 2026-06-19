/**
 * x402 + PayAI mock END-TO-END HARNESS.
 *
 * Proves the FULL x402 payment handshake works through ClawVille's REAL
 * server-side stack — `@x402/hono`'s `paymentMiddleware` + `@x402/core`'s
 * `HTTPFacilitatorClient` + `@x402/svm`'s Exact scheme, wired by our own
 * `buildX402ResourceServer` / `buildX402Routes` — with the local mock
 * facilitator standing in for PayAI's hosted one.
 *
 * The ONLY thing swapped vs production is the facilitator URL: in prod that is
 * `https://facilitator.payai.network`; here it's the in-process mock. Because
 * the mock speaks the identical `/supported` + `/verify` + `/settle` wire
 * contract, a GREEN run here is direct evidence that pointing
 * `X402_FACILITATOR_PRESET=payai` (or `X402_FACILITATOR_URL=...payai...`) will
 * exercise the same code path against the real facilitator.
 *
 * No DB, no API boot, no real funds, no Solana signer — the mock rubber-stamps
 * verify/settle, and for x402 v2 the resource server matches a payment to the
 * quote by deep-equality on the echoed `accepted` requirement, so the client
 * needs no on-chain signature to drive the handshake.
 *
 * Run:  bun run apps/api/scripts/x402/mock-e2e.ts
 * Exit: 0 if every case passes, 1 otherwise.
 */

import { Hono } from 'hono';
import { paymentMiddleware } from '@x402/hono';
import { buildMockFacilitator } from '../../src/services/x402-mock-facilitator';
import {
  buildX402ResourceServer,
  buildX402Routes,
  type X402Config,
} from '../../src/services/x402-config';

const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// Valid base58 placeholder merchant (System Program id = 32 zero bytes).
const MERCHANT = '11111111111111111111111111111111';
const PAID_PATH = '/api/v2/agent/ping';

const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
const unb64 = (s: string) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));

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

async function main() {
  // ---- stand up the mock facilitator on an ephemeral port -----------------
  const mockApp = buildMockFacilitator({ log: true }); // logs each facilitator hit as evidence
  const mockServer = Bun.serve({ port: 0, fetch: mockApp.fetch });
  const facilitatorUrl = `http://127.0.0.1:${mockServer.port}`;

  // ---- build the REAL resource server pointed at the mock ------------------
  const config: X402Config = {
    enabled: true,
    facilitatorPreset: 'mock',
    facilitatorUrlExplicit: true,
    facilitatorUrl,
    merchantWalletPubkey: MERCHANT,
    network: SOLANA_MAINNET,
  };
  const resourceServer = buildX402ResourceServer(config);
  if (!resourceServer) throw new Error('buildX402ResourceServer returned null (config.enabled?)');
  const routes = buildX402Routes(config);

  const resApp = new Hono();
  resApp.use('*', paymentMiddleware(routes, resourceServer));
  resApp.get(PAID_PATH, (c) => c.json({ ok: true, paid: true, service: 'mock-e2e' }));
  const resServer = Bun.serve({ port: 0, fetch: resApp.fetch });
  const base = `http://127.0.0.1:${resServer.port}`;

  console.log(`\n[x402 mock-e2e] facilitator=${facilitatorUrl}  resource=${base}\n`);

  try {
    // === Case A: facilitator GET /supported is wire-compatible ============
    console.log('A. Mock facilitator GET /supported');
    {
      const r = await fetch(`${facilitatorUrl}/supported`);
      const body: any = await r.json();
      check('200 OK', r.status === 200, `status=${r.status}`);
      check('has kinds[]', Array.isArray(body?.kinds), `kinds=${body?.kinds?.length}`);
      const mainnetKind = body?.kinds?.find(
        (k: any) => k.network === SOLANA_MAINNET && k.scheme === 'exact' && k.x402Version === 2,
      );
      check('advertises Solana mainnet exact v2', !!mainnetKind);
      check('has extensions[] + signers{} (schema)', Array.isArray(body?.extensions) && typeof body?.signers === 'object');
    }

    // === Case B: unpaid request → 402 + correct quote ====================
    console.log('B. GET paid route with NO payment → 402 challenge');
    let accepts0: any;
    {
      const r = await fetch(`${base}${PAID_PATH}`);
      check('HTTP 402', r.status === 402, `status=${r.status}`);
      const hdr = r.headers.get('payment-required');
      check('PAYMENT-REQUIRED header present', !!hdr);
      const quote = hdr ? unb64(hdr) : {};
      accepts0 = quote?.accepts?.[0];
      check('x402Version 2', quote?.x402Version === 2);
      check('accepts[0].scheme = exact', accepts0?.scheme === 'exact', accepts0?.scheme);
      check('accepts[0].network = solana mainnet', accepts0?.network === SOLANA_MAINNET, accepts0?.network);
      check('accepts[0].asset = USDC mainnet mint', accepts0?.asset === USDC_MAINNET, accepts0?.asset);
      check('accepts[0].payTo = merchant', accepts0?.payTo === MERCHANT, accepts0?.payTo);
      check('accepts[0].amount numeric ($0.001 → 1000)', /^\d+$/.test(String(accepts0?.amount)), `amount=${accepts0?.amount}`);
    }

    // === Case C: pay → 200 + settlement header ===========================
    console.log('C. Retry WITH PAYMENT-SIGNATURE → 200 + settlement');
    {
      const payload = { x402Version: 2, accepted: accepts0, payload: { __mock: 'ok', note: 'mock-signed-tx' } };
      const r = await fetch(`${base}${PAID_PATH}`, { headers: { 'PAYMENT-SIGNATURE': b64(payload) } });
      if (r.status !== 200) {
        const diag = r.headers.get('payment-required');
        console.log('    [diag] reject reason:', diag ? unb64(diag)?.error : '(no payment-required header)');
      }
      check('HTTP 200', r.status === 200, `status=${r.status}`);
      const body: any = await r.json().catch(() => ({}));
      check('handler body returned (paid:true)', body?.ok === true && body?.paid === true);
      const settleHdr = r.headers.get('payment-response');
      check('PAYMENT-RESPONSE header present', !!settleHdr);
      const settle = settleHdr ? unb64(settleHdr) : {};
      check('settlement success:true', settle?.success === true);
      check('settlement transaction non-empty', typeof settle?.transaction === 'string' && settle.transaction.length > 0, settle?.transaction?.slice?.(0, 16) + '…');
      check('settlement network echoes mainnet', settle?.network === SOLANA_MAINNET, settle?.network);
    }

    // === Case D: forced verify failure → 402 (not paid) ==================
    console.log('D. Forced verify-invalid → 402 (payment rejected)');
    {
      const payload = { x402Version: 2, accepted: accepts0, payload: { __mock: 'verify-invalid' } };
      const r = await fetch(`${base}${PAID_PATH}`, { headers: { 'PAYMENT-SIGNATURE': b64(payload) } });
      check('HTTP 402', r.status === 402, `status=${r.status}`);
    }

    // === Case E: verify ok but settle fails → non-200 ====================
    console.log('E. Forced settle-fail → non-200 + success:false');
    {
      const payload = { x402Version: 2, accepted: accepts0, payload: { __mock: 'settle-fail' } };
      const r = await fetch(`${base}${PAID_PATH}`, { headers: { 'PAYMENT-SIGNATURE': b64(payload) } });
      // @x402/core buildSettlementFailureResponse hard-codes 402 on settle failure.
      check('HTTP 402 (settlement failure)', r.status === 402, `status=${r.status}`);
      const settleHdr = r.headers.get('payment-response');
      if (settleHdr) {
        const settle = unb64(settleHdr);
        check('settlement success:false', settle?.success === false);
      } else {
        check('settlement failure surfaced (no 200)', r.status !== 200);
      }
    }

    // === Case F: facilitator 500 handled gracefully (no 5xx leak) ========
    console.log('F. Facilitator /verify 500 → graceful client-error (no 5xx leak)');
    {
      const payload = { x402Version: 2, accepted: accepts0, payload: { __mock: 'verify-error' } };
      const r = await fetch(`${base}${PAID_PATH}`, { headers: { 'PAYMENT-SIGNATURE': b64(payload) } });
      check('status is 4xx (no crash / no 5xx)', r.status >= 400 && r.status < 500, `status=${r.status}`);
    }
  } finally {
    mockServer.stop(true);
    resServer.stop(true);
  }

  console.log(`\n[x402 mock-e2e] ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[x402 mock-e2e] FATAL:', err);
  process.exit(1);
});
