/**
 * REAL x402 USDC -> vCLAW top-up smoke harness.
 *
 * Usage:
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... PAYER_KEYPAIR_PATH=... \
 *   TOPUP_EXPECT_NETWORK=solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp \
 *   bun apps/api/scripts/x402/topup-settle-smoke.ts
 *
 * This spends real USDC. The local keypair is read only to sign the x402
 * transaction; no secret bytes, payment payload, session cookie, or private
 * material are ever logged.
 */

import { createKeyPairSignerFromBytes } from '@solana/kit';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { PaymentRequiredSchema, PaymentRequirementsSchema } from '@x402/core/schemas';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { toClientSvmSigner } from '@x402/svm';
import { z } from 'zod';

const DEFAULT_API_BASE = 'https://api.clawville.world';
const DEFAULT_TOPUP_USD_CENTS = 10;
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 3 * 60_000;
const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SOLANA_DEVNET_CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const envSchema = z.object({
  CLAWVILLE_API_BASE: z.string().url().default(DEFAULT_API_BASE),
  SMOKE_EMAIL: z.string().email(),
  SMOKE_PASSWORD: z.string().min(1),
  PAYER_KEYPAIR_PATH: z.string().min(1),
  TOPUP_USD_CENTS: z.string().regex(/^\d+$/).optional(),
  TOPUP_EXPECT_NETWORK: z.string().min(1).optional(),
});

const loginResponseSchema = z.object({ success: z.literal(true) });
const avatarResponseSchema = z.object({
  avatar: z
    .object({
      id: z.string().uuid(),
      clawTokens: z.number().int().nonnegative(),
    })
    .passthrough()
    .nullable(),
});
const quoteResponseSchema = z.object({
  topupId: z.string().uuid(),
  amountCt: z.number().int().positive(),
  asset: z.literal('usdc'),
  usdCents: z.number().int().positive(),
  network: z.enum(['mainnet', 'devnet']),
  accepts: z.array(PaymentRequirementsSchema).min(1),
  x402Version: z.literal(2),
});
const settledResponseSchema = z.object({
  ctCredited: z.number().int().positive(),
  balance: z.number().int().nonnegative(),
  txSignature: z.string().min(1),
  replay: z.boolean().optional(),
});
const errorResponseSchema = z
  .object({
    error: z.string().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
    reason: z.string().optional(),
    status: z.string().optional(),
    transient: z.boolean().optional(),
  })
  .passthrough();
const keypairJsonSchema = z.array(z.number().int().min(0).max(255)).length(64);

type Stage =
  | 'config'
  | 'login'
  | 'avatar_before'
  | 'quote'
  | 'network_safety'
  | 'keypair'
  | 'payment_sign'
  | 'settle_poll'
  | 'avatar_after'
  | 'balance_delta'
  | 'proof';

class StageError extends Error {
  constructor(
    readonly stage: Stage,
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'StageError';
  }
}

function fail(stage: Stage, message: string, exitCode = 1): never {
  throw new StageError(stage, message, exitCode);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJsonText(text: string, stage: Stage): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail(stage, 'API returned a non-JSON response');
  }
}

async function parseResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  stage: Stage,
): Promise<T> {
  const body = parseJsonText(await response.text(), stage);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    fail(stage, `unexpected response shape: ${parsed.error.issues.map((issue) => issue.path.join('.') || 'body').join(', ')}`);
  }
  return parsed.data;
}

function describeApiError(body: z.infer<typeof errorResponseSchema>): string {
  return [body.code, body.error, body.reason, body.message, body.status]
    .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index)
    .join(': ') || 'unknown API error';
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/(?:^|,\s*)(auth_session=[^;,\s]+)/i);
  return match?.[1] ?? fail('login', 'login succeeded but no auth_session cookie was returned');
}

function apiUrl(base: string, path: string): string {
  return `${base}${path}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function login(base: string, email: string, password: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(apiUrl(base, '/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch (error) {
    return fail('login', `request failed: ${errorMessage(error)}`);
  }

  if (!response.ok) {
    const body = await parseResponse(response, errorResponseSchema, 'login');
    fail('login', `HTTP ${response.status}: ${describeApiError(body)}`);
  }
  await parseResponse(response.clone(), loginResponseSchema, 'login');
  return sessionCookie(response);
}

async function getAvatar(base: string, cookie: string, stage: 'avatar_before' | 'avatar_after') {
  let response: Response;
  try {
    response = await fetch(apiUrl(base, '/api/avatars/me'), {
      headers: { cookie },
    });
  } catch (error) {
    return fail(stage, `request failed: ${errorMessage(error)}`);
  }
  if (!response.ok) {
    const body = await parseResponse(response, errorResponseSchema, stage);
    fail(stage, `HTTP ${response.status}: ${describeApiError(body)}`);
  }
  const body = await parseResponse(response, avatarResponseSchema, stage);
  return body.avatar ?? fail(stage, 'logged-in account has no active avatar');
}

interface QuoteResult {
  body: z.infer<typeof quoteResponseSchema>;
  paymentRequired: PaymentRequired & { x402Version: 2 };
}

async function requestQuote(
  base: string,
  cookie: string,
  usdCents: number,
): Promise<QuoteResult> {
  let response: Response;
  try {
    response = await fetch(apiUrl(base, '/api/ct/topup/quote'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ asset: 'usdc', usdCents }),
    });
  } catch (error) {
    return fail('quote', `request failed: ${errorMessage(error)}`);
  }

  if (response.status !== 402) {
    const body = await parseResponse(response, errorResponseSchema, 'quote');
    fail('quote', `expected HTTP 402, received ${response.status}: ${describeApiError(body)}`);
  }
  const body = await parseResponse(response.clone(), quoteResponseSchema, 'quote');
  if (body.usdCents !== usdCents) fail('quote', 'quote usdCents did not match the request');

  const header = response.headers.get('payment-required');
  if (!header) fail('quote', 'HTTP 402 omitted PAYMENT-REQUIRED');
  let decoded: unknown;
  try {
    const decoder = new x402HTTPClient(new x402Client());
    decoded = decoder.getPaymentRequiredResponse((name) =>
      name.toLowerCase() === 'payment-required' ? header : null,
    );
  } catch (error) {
    return fail('quote', `invalid PAYMENT-REQUIRED header: ${errorMessage(error)}`);
  }
  const parsed = PaymentRequiredSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.x402Version !== 2) {
    fail('quote', 'PAYMENT-REQUIRED was not a valid x402 v2 challenge');
  }

  return { body, paymentRequired: parsed.data };
}

function selectSvmExact(
  quote: QuoteResult,
): { requirement: PaymentRequirements; paymentRequired: PaymentRequired & { x402Version: 2 } } {
  const matches = quote.paymentRequired.accepts.filter(
    (accept) => accept.scheme === 'exact' && accept.network.startsWith('solana:'),
  );
  if (matches.length === 0) fail('quote', '402 challenge offered no Solana exact-scheme payment');
  const requirement = matches[0];

  const bodyMatch = quote.body.accepts.some(
    (accept) =>
      accept.scheme === requirement.scheme &&
      accept.network === requirement.network &&
      accept.amount === requirement.amount &&
      accept.asset === requirement.asset &&
      accept.payTo === requirement.payTo,
  );
  if (!bodyMatch) fail('quote', '402 body and PAYMENT-REQUIRED header disagree');

  const routeNetwork = quote.body.network === 'mainnet'
    ? SOLANA_MAINNET_CAIP2
    : SOLANA_DEVNET_CAIP2;
  if (requirement.network !== routeNetwork) {
    fail('quote', `route network '${quote.body.network}' disagrees with accept network '${requirement.network}'`);
  }
  const expectedUsdcMint = requirement.network === SOLANA_MAINNET_CAIP2
    ? USDC_MINT_MAINNET
    : USDC_MINT_DEVNET;
  if (requirement.asset !== expectedUsdcMint) {
    fail('quote', `accept asset '${requirement.asset}' is not Circle USDC on '${requirement.network}'`);
  }
  if (requirement.amount !== String(quote.body.usdCents * 10_000)) {
    fail('quote', 'accept amount did not equal the quoted USDC atomic amount');
  }

  return {
    requirement,
    paymentRequired: { ...quote.paymentRequired, accepts: [requirement] },
  };
}

async function loadPayer(path: string) {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    return fail('keypair', 'could not read PAYER_KEYPAIR_PATH');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return fail('keypair', 'PAYER_KEYPAIR_PATH must contain Solana keypair JSON');
  }
  const checked = keypairJsonSchema.safeParse(parsed);
  if (!checked.success) {
    fail('keypair', 'PAYER_KEYPAIR_PATH must be a 64-byte Solana keypair JSON array');
  }

  try {
    const signer = await createKeyPairSignerFromBytes(Uint8Array.from(checked.data));
    return toClientSvmSigner(signer);
  } catch {
    return fail('keypair', 'PAYER_KEYPAIR_PATH did not contain a valid Solana keypair');
  }
}

async function signPayment(
  paymentRequired: PaymentRequired & { x402Version: 2 },
  requirement: PaymentRequirements,
  signer: Awaited<ReturnType<typeof loadPayer>>,
): Promise<string> {
  try {
    const client = new x402Client();
    client.register(requirement.network, new ExactSvmScheme(signer));
    const http = new x402HTTPClient(client);
    const payload = await http.createPaymentPayload(paymentRequired);
    const headers = http.encodePaymentSignatureHeader(payload);
    return headers['PAYMENT-SIGNATURE'] ?? fail('payment_sign', 'x402 v2 client did not emit PAYMENT-SIGNATURE');
  } catch (error) {
    if (error instanceof StageError) throw error;
    return fail('payment_sign', `official SVM client failed: ${errorMessage(error)}`);
  }
}

interface SettleInput {
  base: string;
  cookie: string;
  paymentSignature: string;
  idempotencyKey: string;
  topupId: string;
  usdCents: number;
}

async function pollSettle(input: SettleInput): Promise<z.infer<typeof settledResponseSchema>> {
  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    attempt += 1;
    let response: Response;
    try {
      response = await fetch(apiUrl(input.base, '/api/ct/topup/settle'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: input.cookie,
          'Idempotency-Key': input.idempotencyKey,
          'PAYMENT-SIGNATURE': input.paymentSignature,
        },
        body: JSON.stringify({ topupId: input.topupId, asset: 'usdc', usdCents: input.usdCents }),
      });
    } catch (error) {
      return fail('settle_poll', `request failed on attempt ${attempt}: ${errorMessage(error)}`);
    }

    if (response.ok) {
      return parseResponse(response, settledResponseSchema, 'settle_poll');
    }

    const body = await parseResponse(response, errorResponseSchema, 'settle_poll');
    const retryable =
      (response.status === 409 && body.code === 'settle_in_flight') ||
      (response.status === 402 && body.code === 'payment_not_settled' && body.transient === true) ||
      (response.status === 500 && body.code === 'settle_failed' && body.transient === true);
    if (!retryable) {
      fail('settle_poll', `terminal HTTP ${response.status}: ${describeApiError(body)}`);
    }

    console.log(`[settle_poll] attempt ${attempt} is retryable (${body.code}); polling again`);
    await sleep(POLL_INTERVAL_MS);
  }
  return fail('settle_poll', `timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)} seconds`);
}

async function main(): Promise<void> {
  const parsedEnv = envSchema.safeParse(process.env);
  if (!parsedEnv.success) {
    fail('config', `invalid or missing env: ${parsedEnv.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  }
  const env = parsedEnv.data;
  const apiBase = env.CLAWVILLE_API_BASE.replace(/\/+$/, '');
  const usdCents = env.TOPUP_USD_CENTS === undefined
    ? DEFAULT_TOPUP_USD_CENTS
    : Number.parseInt(env.TOPUP_USD_CENTS, 10);
  if (!Number.isSafeInteger(usdCents) || usdCents <= 0 || usdCents > 1_000_000) {
    fail('config', 'TOPUP_USD_CENTS must be an integer from 1 through 1000000');
  }

  console.log(`ClawVille x402 settled top-up smoke -> ${apiBase}`);
  console.log(`Requested top-up: ${usdCents} USD cents`);

  const cookie = await login(apiBase, env.SMOKE_EMAIL, env.SMOKE_PASSWORD);
  console.log('[login] authenticated');
  const avatarBefore = await getAvatar(apiBase, cookie, 'avatar_before');
  console.log(`[avatar_before] avatar=${avatarBefore.id} vclaw=${avatarBefore.clawTokens}`);

  const quote = await requestQuote(apiBase, cookie, usdCents);
  const selected = selectSvmExact(quote);
  const resolvedNetwork = selected.requirement.network;
  console.log(`[quote] topup=${quote.body.topupId} vclaw=${quote.body.amountCt}`);
  console.log(`[network_safety] resolved network: ${resolvedNetwork}`);
  if (env.TOPUP_EXPECT_NETWORK && env.TOPUP_EXPECT_NETWORK !== resolvedNetwork) {
    fail(
      'network_safety',
      `TOPUP_EXPECT_NETWORK '${env.TOPUP_EXPECT_NETWORK}' does not match '${resolvedNetwork}'; refusing to sign or pay`,
      2,
    );
  }

  const signer = await loadPayer(env.PAYER_KEYPAIR_PATH);
  console.log(`[keypair] payer pubkey: ${signer.address}`);
  const paymentSignature = await signPayment(
    selected.paymentRequired,
    selected.requirement,
    signer,
  );
  console.log('[payment_sign] signed x402 exact-SVM payload locally');

  const settled = await pollSettle({
    base: apiBase,
    cookie,
    paymentSignature,
    idempotencyKey: crypto.randomUUID(),
    topupId: quote.body.topupId,
    usdCents,
  });
  if (settled.ctCredited !== quote.body.amountCt) {
    fail('settle_poll', `credited ${settled.ctCredited}, quote promised ${quote.body.amountCt}`);
  }

  const avatarAfter = await getAvatar(apiBase, cookie, 'avatar_after');
  if (avatarAfter.id !== avatarBefore.id) fail('avatar_after', 'active avatar changed during the smoke');
  const delta = avatarAfter.clawTokens - avatarBefore.clawTokens;
  if (delta !== settled.ctCredited) {
    fail(
      'balance_delta',
      `avatar vCLAW delta was ${delta}; settled credit was ${settled.ctCredited}`,
    );
  }
  if (avatarAfter.clawTokens !== settled.balance) {
    fail(
      'balance_delta',
      `avatar balance ${avatarAfter.clawTokens} disagreed with settle balance ${settled.balance}`,
    );
  }

  console.log('\n=== CLAWVILLE X402 TOP-UP PROOF ===');
  console.log(`topup id: ${quote.body.topupId}`);
  console.log('status: settled');
  console.log(`usd cents: ${usdCents}`);
  console.log(`vclaw credited: ${settled.ctCredited}`);
  console.log(`on-chain tx signature: ${settled.txSignature}`);
  console.log(`merchant wallet: ${selected.requirement.payTo}`);
  console.log(`network: ${resolvedNetwork}`);
  console.log('=== END PROOF ===');
}

main().catch((error: unknown) => {
  if (error instanceof StageError) {
    console.error(`SMOKE FAILURE [${error.stage}]: ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error(`SMOKE FAILURE [proof]: ${errorMessage(error)}`);
  process.exit(1);
});
