/**
 * Executed contract of `callVendorWithAvatarWallet` against DATABASE_URL
 * (migrations 0089 + 0090). The seller, the wallet and the signer are fakes;
 * the caps, the ledger and the advisory lock are real.
 *
 * Skips when DATABASE_URL is absent or migration 0090 is not applied.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import * as dbMod from '@clawville/database';
import { SOLANA_MAINNET, callVendorWithAvatarWallet, type OutboundDeps } from '../../services/outbound-x402';
import { writeSpendPolicy } from '../../services/spend-policy';
import { STUDIOS_MAX_CALL_ATOMIC, STUDIOS_PAY_TO } from '../../services/vendors/studios';

const { db, sql } = dbMod;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PIN = { vendor: 'studios' as const, payTo: STUDIOS_PAY_TO, maxCallAtomic: STUDIOS_MAX_CALL_ATOMIC };
const PAYER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const sig64 = () => bs58.encode(randomBytes(64));

function first<T>(rows: Iterable<T>): T {
  const row = Array.from(rows)[0];
  if (!row) throw new Error('fixture query returned no row');
  return row;
}

let schemaReady = false;
if (process.env.DATABASE_URL) {
  try {
    const t = await db.execute<{ n: number | string }>(
      sql`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name = 'vendor_spend_ledger'`,
    );
    schemaReady = Number(first(t).n) === 1;
  } catch {
    schemaReady = false;
  }
  if (!schemaReady) console.warn('[outbound-x402-db] SKIPPING: migration 0090 is not applied to this DATABASE_URL yet.');
}
const describeIfSchema = schemaReady ? describe : describe.skip;

function quoteResponse(amount = '5000', payTo = STUDIOS_PAY_TO[0]!): Response {
  const header = encodePaymentRequiredHeader({
    x402Version: 2,
    resource: { url: 'https://mystudios.fun/api/v1/images/generations' },
    accepts: [{ scheme: 'exact', network: SOLANA_MAINNET, amount, asset: USDC, payTo, maxTimeoutSeconds: 300, extra: { feePayer: 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww' } }],
  } as never);
  return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': header } });
}

function settledResponse(status: number, body: unknown, tx: string | null): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (tx !== null) {
    headers['PAYMENT-RESPONSE'] = Buffer.from(JSON.stringify({ success: status < 400, transaction: tx, network: SOLANA_MAINNET })).toString('base64');
  }
  return new Response(JSON.stringify(body), { status, headers });
}

describeIfSchema('outbound x402: executed DB contract', () => {
  const tag = `ox${Date.now().toString(36)}${Math.floor(Math.random() * 46_656).toString(36)}`;
  let userId = '';
  let avatarId = '';
  let paidCalls = 0;
  let signCalls = 0;
  let wipes = 0;

  function deps(paid: () => Response | Promise<Response>, quote: () => Response = () => quoteResponse()): Partial<OutboundDeps> {
    return {
      fetch: async (_url, init) => {
        const signed = new Headers(init.headers).get('PAYMENT-SIGNATURE');
        if (!signed) return quote();
        paidCalls += 1;
        return paid();
      },
      loadWalletPubkey: async () => PAYER,
      loadSigningKey: async () => ({ publicKey: PAYER, secretKey: new Uint8Array(64).fill(7), wipe: () => { wipes += 1; } }),
      signPayment: async () => {
        signCalls += 1;
        return { header: 'signed-payment-header', payerSignature: sig64() };
      },
    };
  }

  const call = (key: string, d: Partial<OutboundDeps>) => callVendorWithAvatarWallet({
    avatarId,
    actor: 'agent',
    pin: PIN,
    tool: 'images.generations',
    idempotencyKey: `${tag}-${key}`,
    url: 'https://mystudios.fun/api/v1/images/generations',
    body: { model: 'z-image-turbo', prompt: 'test', n: 1 },
  }, d);

  const statusOf = async (ledgerId: string) => first(await db.execute<{ status: string; tx_signature: string | null }>(
    sql`SELECT status, tx_signature FROM vendor_spend_ledger WHERE id = ${ledgerId}`,
  ));
  const payerSigOf = async (ledgerId: string) => first(await db.execute<{ payer_signature: string | null }>(
    sql`SELECT payer_signature FROM vendor_spend_ledger WHERE id = ${ledgerId}`,
  )).payer_signature;

  beforeAll(async () => {
    userId = first(await db.execute<{ id: string }>(
      sql`INSERT INTO users (email, password_hash, name) VALUES (${`${tag}@clawville-test.invalid`}, ${`disabled-${tag}`}, 'Outbound x402 DB Test') RETURNING id`,
    )).id;
    avatarId = first(await db.execute<{ id: string }>(
      sql`INSERT INTO avatars (user_id, name, species, color, gender, archetype, personality, stats, claw_tokens, soft_balance, bought_balance, earned_balance, is_active, is_guest)
          VALUES (${userId}, ${tag}, 'cat', 'green', 'male', 'brave-adventurer',
            ${JSON.stringify({ habitat: 'test', hobby: 'testing', greeting: 'hi' })}::jsonb,
            ${JSON.stringify({ strength: 1, defence: 1, movement: 1 })}::jsonb, 0, 0, 0, 0, true, false)
          RETURNING id`,
    )).id;
  });

  beforeEach(async () => {
    paidCalls = 0;
    signCalls = 0;
    wipes = 0;
    await db.execute(sql`DELETE FROM vendor_spend_ledger WHERE avatar_id = ${avatarId}`);
    await db.execute(sql`DELETE FROM user_spend_policies WHERE avatar_id = ${avatarId}`);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM vendor_spend_ledger WHERE avatar_id = ${avatarId}`).catch(() => {});
    await db.execute(sql`DELETE FROM user_spend_policies WHERE avatar_id = ${avatarId}`).catch(() => {});
    await db.execute(sql`DELETE FROM avatars WHERE id = ${avatarId}`).catch(() => {});
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`).catch(() => {});
  });

  it('refuses before signing when caps are unset or the vendor is not allowed', async () => {
    expect(await call('a', deps(() => settledResponse(200, {}, 'tx')))).toEqual({ ok: false, code: 'spend_rules_not_set' });
    await writeSpendPolicy(avatarId, userId, { dailyCapUsdCents: 100, perCallCapUsdCents: 1, allowedVendors: [] });
    expect(await call('b', deps(() => settledResponse(200, {}, 'tx')))).toEqual({ ok: false, code: 'vendor_not_allowed' });
    expect(signCalls).toBe(0);
    expect(paidCalls).toBe(0);
  });

  it('pays once, records paid with the settlement tx, and refuses the same key again', async () => {
    await writeSpendPolicy(avatarId, userId, { dailyCapUsdCents: 100, perCallCapUsdCents: 1, allowedVendors: ['studios'] });
    const tx1 = sig64();
    const result = await call('pay', deps(() => settledResponse(200, { data: [{ url: 'https://cdn.example/x.png' }] }, tx1)));
    expect(result).toMatchObject({ ok: true, usdcAtomic: '5000', usdCents: 1, txSignature: tx1 });
    if (!result.ok) throw new Error('expected ok');
    expect(await statusOf(result.ledgerId)).toEqual({ status: 'paid', tx_signature: tx1 });
    expect(await payerSigOf(result.ledgerId)).not.toBeNull();
    expect(wipes).toBe(1);
    const again = await call('pay', deps(() => settledResponse(200, {}, sig64())));
    expect(again).toMatchObject({ ok: false, code: 'duplicate_request', ledgerId: result.ledgerId });
    expect(paidCalls).toBe(1);
  });

  it('enforces the per-call cap on the quoted amount', async () => {
    await writeSpendPolicy(avatarId, userId, { dailyCapUsdCents: 100, perCallCapUsdCents: 1, allowedVendors: ['studios'] });
    const result = await call('big', deps(() => settledResponse(200, {}, 'tx'), () => quoteResponse('10001')));
    expect(result).toEqual({ ok: false, code: 'over_per_call_cap' });
    expect(signCalls).toBe(0);
  });

  it('refuses a quote that names another wallet', async () => {
    await writeSpendPolicy(avatarId, userId, { dailyCapUsdCents: 100, perCallCapUsdCents: 1, allowedVendors: ['studios'] });
    const result = await call('payto', deps(() => settledResponse(200, {}, 'tx'), () => quoteResponse('5000', 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww')));
    expect(result).toEqual({ ok: false, code: 'vendor_pay_to_changed' });
  });

  it('counts a 402 after sending as ambiguous, and failed signing as failed (not counted)', async () => {
    // Daily cap 1 cent = 10000 atomic = two calls of 5000.
    await writeSpendPolicy(avatarId, userId, { dailyCapUsdCents: 1, perCallCapUsdCents: 1, allowedVendors: ['studios'] });
    const failedSign = await call('s1', { ...deps(() => settledResponse(200, {}, sig64())), signPayment: async () => { throw new Error('rpc down'); } });
    expect(failedSign).toMatchObject({ ok: false, code: 'payment_prepare_failed' });
    if (failedSign.ok || !failedSign.ledgerId) throw new Error('expected ledger row');
    expect((await statusOf(failedSign.ledgerId)).status).toBe('failed');
    expect(wipes).toBe(1);

    const refused = await call('f1', deps(() => settledResponse(402, {}, null)));
    expect(refused).toMatchObject({ ok: false, code: 'payment_ambiguous', httpStatus: 402 });
    if (refused.ok || !refused.ledgerId) throw new Error('expected ledger row');
    expect((await statusOf(refused.ledgerId)).status).toBe('ambiguous');

    expect((await call('p1', deps(() => settledResponse(200, {}, sig64())))).ok).toBe(true);
    expect(await call('p2', deps(() => settledResponse(200, {}, sig64())))).toEqual({ ok: false, code: 'over_daily_cap' });
  });

  it('returns the image but records ambiguous when a 2xx has no valid settlement proof', async () => {
    await writeSpendPolicy(avatarId, userId, { dailyCapUsdCents: 100, perCallCapUsdCents: 1, allowedVendors: ['studios'] });
    for (const [key, tx] of [['n1', null], ['n2', 'not-a-signature']] as const) {
      const result = await call(key, deps(() => settledResponse(200, { data: [{ url: 'https://cdn.example/y.png' }] }, tx)));
      expect(result).toMatchObject({ ok: true, txSignature: null });
      if (!result.ok) throw new Error('expected ok');
      expect(await statusOf(result.ledgerId)).toEqual({ status: 'ambiguous', tx_signature: null });
    }
  });

  it('refuses a quote that names our own wallet as fee payer, before any decrypt', async () => {
    await writeSpendPolicy(avatarId, userId, { dailyCapUsdCents: 100, perCallCapUsdCents: 1, allowedVendors: ['studios'] });
    const own = () => new Response('{}', {
      status: 402,
      headers: {
        'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
          x402Version: 2,
          resource: { url: 'https://mystudios.fun/api/v1/images/generations' },
          accepts: [{ scheme: 'exact', network: SOLANA_MAINNET, amount: '5000', asset: USDC, payTo: STUDIOS_PAY_TO[0]!, maxTimeoutSeconds: 300, extra: { feePayer: PAYER } }],
        } as never),
      },
    });
    expect(await call('fee', deps(() => settledResponse(200, {}, sig64()), own))).toEqual({ ok: false, code: 'vendor_quote_invalid' });
    expect(signCalls).toBe(0);
    expect(wipes).toBe(0);
  });

  it('marks a timeout after payment as ambiguous, and a 402 that names a tx as ambiguous', async () => {
    await writeSpendPolicy(avatarId, userId, { dailyCapUsdCents: 100, perCallCapUsdCents: 1, allowedVendors: ['studios'] });
    const timeout = await call('t1', deps(() => { throw new Error('timeout'); }));
    expect(timeout).toMatchObject({ ok: false, code: 'payment_ambiguous' });
    const tx5 = sig64();
    const settledThenRefused = await call('t2', deps(() => settledResponse(402, {}, tx5)));
    expect(settledThenRefused).toMatchObject({ ok: false, code: 'payment_ambiguous' });
    if (settledThenRefused.ok || !settledThenRefused.ledgerId) throw new Error('expected ledger row');
    expect(await statusOf(settledThenRefused.ledgerId)).toEqual({ status: 'ambiguous', tx_signature: tx5 });
  });

  it('admits only what the daily cap allows under concurrent calls', async () => {
    // Daily cap 1 cent = exactly two calls of 5000 atomic.
    await writeSpendPolicy(avatarId, userId, { dailyCapUsdCents: 1, perCallCapUsdCents: 1, allowedVendors: ['studios'] });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => call(`c${i}`, deps(() => settledResponse(200, {}, sig64())))));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok && r.code === 'over_daily_cap')).toHaveLength(4);
    const total = first(await db.execute<{ total: string }>(
      sql`SELECT COALESCE(SUM(usdc_atomic), 0)::text AS total FROM vendor_spend_ledger WHERE avatar_id = ${avatarId} AND status <> 'failed'`,
    )).total;
    expect(total).toBe('10000');
  });
});
