/**
 * REAL x402 CHECKOUT settle smoke — ② CLV sweep rung prep (mainnet-staging).
 *
 * Drives the deployed staging API: rent_payment checkout for 10 vCLAW ($0.10)
 * on landtest3's deposit-tenure parcel, paid in REAL mainnet USDC signed by the
 * local rescue keyfile. A settled checkout enqueues the checkout_clv_leg row
 * that funds the CLV sweep (verified after via DB + live-tick-once).
 *
 * Spends real USDC. No secret bytes, payment payload, cookie, or private
 * material are ever logged. Exit 0 = all pass.
 */
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { PaymentRequiredSchema, PaymentRequirementsSchema } from '@x402/core/schemas';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { toClientSvmSigner } from '@x402/svm';
import { z } from 'zod';

const API_BASE = process.env.CLAWVILLE_API_BASE ?? 'https://api-staging.clawville.world';
const EMAIL = process.env.SMOKE_EMAIL ?? '';
const PASSWORD = process.env.SMOKE_PASSWORD ?? '';
const PARCEL_ID = process.env.SMOKE_PARCEL_ID ?? '';
const AMOUNT_VCLAW = Number.parseInt(process.env.SMOKE_AMOUNT_VCLAW ?? '10', 10); // vclaw == usd cents (¢-peg)
const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 3 * 60_000;

const quoteResponseSchema = z.object({
  checkoutId: z.string().uuid(),
  itemKind: z.literal('rent_payment'),
  itemRef: z.string().uuid(),
  priceVclaw: z.number().int().positive(),
  usdCents: z.number().int().positive(),
  network: z.enum(['mainnet', 'devnet']),
  accepts: z.array(PaymentRequirementsSchema).min(1),
  x402Version: z.literal(2),
});
const settledResponseSchema = z.object({
  checkoutId: z.string().uuid(),
  itemKind: z.string(),
  itemRef: z.string(),
  priceVclaw: z.number().int().positive(),
  txSignature: z.string().min(1),
  fulfillment: z.unknown(),
  balance: z.number().int().nonnegative(),
  replay: z.boolean().optional(),
});
const errorResponseSchema = z
  .object({
    error: z.string().optional(),
    code: z.string().optional(),
    reason: z.string().optional(),
    transient: z.boolean().optional(),
  })
  .passthrough();
const keypairJsonSchema = z.array(z.number().int().min(0).max(255)).length(64);

function fail(stage: string, message: string): never {
  console.error(`[FAIL:${stage}] ${message}`);
  process.exit(1);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function login(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (res.status !== 200) fail('login', `HTTP ${res.status}: ${await res.text()}`);
  const m = (res.headers.get('set-cookie') ?? '').match(/(?:^|,\s*)(auth_session=[^;,\s]+)/i);
  if (!m) fail('login', 'no auth_session cookie');
  console.log(`[login] ${EMAIL} authenticated`);
  return m[1];
}

if (!EMAIL || !PASSWORD || !PARCEL_ID) fail('config', 'SMOKE_EMAIL, SMOKE_PASSWORD, SMOKE_PARCEL_ID required');
if (!Number.isSafeInteger(AMOUNT_VCLAW) || AMOUNT_VCLAW < 1 || AMOUNT_VCLAW > 1_000_000) {
  fail('config', 'SMOKE_AMOUNT_VCLAW must be an integer from 1 through 1000000');
}

const cookie = await login();

// --- quote ------------------------------------------------------------------
const quoteRes = await fetch(`${API_BASE}/api/x402/checkout/quote`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ itemKind: 'rent_payment', itemRef: PARCEL_ID, amountVclaw: AMOUNT_VCLAW }),
});
if (quoteRes.status !== 402) fail('quote', `expected 402, got ${quoteRes.status}: ${await quoteRes.text()}`);
const quoteBody = quoteResponseSchema.parse(await quoteRes.clone().json());
if (quoteBody.usdCents !== AMOUNT_VCLAW) fail('quote', `usdCents ${quoteBody.usdCents} != ${AMOUNT_VCLAW} (¢-peg violated)`);
if (quoteBody.network !== 'mainnet') fail('quote', `network ${quoteBody.network} — X402_TOPUP_NETWORK=mainnet not effective`);
const header = quoteRes.headers.get('payment-required');
if (!header) fail('quote', '402 omitted PAYMENT-REQUIRED');
const decoder = new x402HTTPClient(new x402Client());
const decoded = decoder.getPaymentRequiredResponse((n) => (n.toLowerCase() === 'payment-required' ? header : null));
const paymentRequired = PaymentRequiredSchema.parse(decoded) as PaymentRequired & { x402Version: 2 };
if (paymentRequired.x402Version !== 2) fail('quote', 'not an x402 v2 challenge');
const matches = paymentRequired.accepts.filter(
  (a: PaymentRequirements) => a.scheme === 'exact' && a.network === SOLANA_MAINNET_CAIP2,
);
if (matches.length === 0) fail('quote', 'no mainnet exact-SVM accept in challenge');
const requirement = matches[0];
if (requirement.asset !== USDC_MINT_MAINNET) fail('quote', `asset ${requirement.asset} is not mainnet Circle USDC`);
if (requirement.amount !== String(AMOUNT_VCLAW * 10_000)) fail('quote', `amount ${requirement.amount} != ${AMOUNT_VCLAW * 10_000}`);
const bodyMatch = quoteBody.accepts.some(
  (a) => a.scheme === requirement.scheme && a.network === requirement.network
    && a.amount === requirement.amount && a.asset === requirement.asset && a.payTo === requirement.payTo,
);
if (!bodyMatch) fail('quote', '402 body and PAYMENT-REQUIRED header disagree');
console.log(`[quote] checkoutId=${quoteBody.checkoutId} usdCents=${quoteBody.usdCents} network=mainnet payTo=${requirement.payTo}`);

// --- sign -------------------------------------------------------------------
const keyPath = process.env.PAYER_KEYPAIR_PATH ?? fail('keypair', 'PAYER_KEYPAIR_PATH required');
const keyJson = keypairJsonSchema.parse(JSON.parse(await Bun.file(keyPath).text()));
const signer = toClientSvmSigner(await createKeyPairSignerFromBytes(Uint8Array.from(keyJson)));
const client = new x402Client();
client.register(requirement.network, new ExactSvmScheme(signer));
const http = new x402HTTPClient(client);
const payload = await http.createPaymentPayload({ ...paymentRequired, accepts: [requirement] });
const paymentSignature = http.encodePaymentSignatureHeader(payload)['PAYMENT-SIGNATURE']
  ?? fail('payment_sign', 'no PAYMENT-SIGNATURE emitted');
console.log('[payment_sign] exact-SVM payment signed locally');

// --- settle (poll) -----------------------------------------------------------
const idemKey = `smoke-checkout-clv-${Date.now()}`;
const startedAt = Date.now();
let settled: z.infer<typeof settledResponseSchema> | null = null;
let attempt = 0;
while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
  attempt += 1;
  const res = await fetch(`${API_BASE}/api/x402/checkout/settle`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      'Idempotency-Key': idemKey,
      'PAYMENT-SIGNATURE': paymentSignature,
    },
    body: JSON.stringify({ checkoutId: quoteBody.checkoutId }),
  });
  if (res.ok) { settled = settledResponseSchema.parse(await res.json()); break; }
  const body = errorResponseSchema.parse(await res.json().catch(() => ({})));
  const retryable =
    (res.status === 409 && body.code === 'settle_in_flight') ||
    (res.status === 402 && body.code === 'payment_not_settled' && body.transient === true) ||
    (res.status === 500 && body.code === 'settle_failed' && body.transient === true);
  if (!retryable) fail('settle_poll', `terminal HTTP ${res.status}: ${JSON.stringify(body)}`);
  console.log(`[settle_poll] attempt ${attempt} retryable (${body.code}); polling`);
  await sleep(POLL_INTERVAL_MS);
}
if (!settled) fail('settle_poll', 'timed out');

if (settled.itemKind !== 'rent_payment' || settled.itemRef !== PARCEL_ID) {
  fail('settled', `wrong item: ${settled.itemKind}/${settled.itemRef}`);
}
if (settled.priceVclaw !== AMOUNT_VCLAW) fail('settled', `priceVclaw ${settled.priceVclaw} != ${AMOUNT_VCLAW}`);

console.log('');
console.log('=== CHECKOUT SETTLED ===');
console.log(`checkoutId  : ${settled.checkoutId}`);
console.log(`txSignature : ${settled.txSignature}`);
console.log(`priceVclaw  : ${settled.priceVclaw}`);
console.log(`fulfillment : ${JSON.stringify(settled.fulfillment)}`);
console.log(`idempotency : ${idemKey}`);
process.exit(0);
