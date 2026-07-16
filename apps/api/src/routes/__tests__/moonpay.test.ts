/**
 * MOONPAY CARD RAIL (Tokenomics C2) — webhook idempotency + signature + config
 * tests. LIGHT + DETERMINISTIC — no real Postgres, no network.
 *
 * INVARIANTS PROVEN:
 *   1. WEBHOOK IDEMPOTENCY (the spec's DB-unique-index contract): first
 *      delivery INSERTs (`ON CONFLICT DO NOTHING` targeting external_tx_id);
 *      a replayed delivery (insert conflicts, guarded update matches nothing
 *      because processed_at is already claimed) returns 200 `{replay:true}`
 *      and performs ZERO re-processing; a status PROGRESSION (pending →
 *      completed) lands through the guarded update exactly once, claiming
 *      processed_at.
 *   2. Bad/missing signature ⇒ 401 with NO DB touch; malformed JSON (valid
 *      signature) ⇒ 400; unconfigured webhook key ⇒ 503. Never a 5xx on bad
 *      input.
 *   3. Signature crypto: verifyMoonpayWebhookSignature accepts the real
 *      HMAC-SHA256 `t.body` hex scheme and rejects tampering/malformed headers.
 *   4. buildSignedWidgetUrl: sandbox-pinned, pk_test_-only (a live key returns
 *      null), signature recomputable over url.search; computeCardFee rounds UP.
 *   5. /widget-url is auth-gated (no cookie/agent header ⇒ 401) — the E5
 *      parity middleware is present on the money-adjacent endpoint.
 *
 * The DB is a stubbed @clawville/database (insert/update chains recorded with
 * programmable returns; every other named export spread from the real module).
 */

// Crash-loud module-load env BEFORE imports (mirrors partner-storefront.test.ts —
// the route pulls require-auth-or-agent → npc-simulation and friends).
// DATABASE_URL is SCOPED to module init (deleted again after the route import
// below) so DB-gated suites loading later in the shared bun process keep their
// skip-when-no-DB behavior instead of running against a fake URL.
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

// MoonPay TEST-mode keys for the suite (wk key is what the signer uses).
process.env.MOONPAY_API_KEY = 'pk_test_abc123';
process.env.MOONPAY_SECRET_KEY = 'sk_test_secret456';
process.env.MOONPAY_WEBHOOK_KEY = 'wk_test_whsec789';
delete process.env.MOONPAY_CARD_FEE_BPS;

import { afterAll, describe, it, expect, beforeEach, mock } from 'bun:test';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import * as realDatabase from '@clawville/database';

// ── @clawville/database stub ────────────────────────────────────────────────
type Row = Record<string, unknown>;
const insertCalls: Row[] = [];
const updateCalls: Row[] = [];
let insertReturnRows: Array<{ id: string }> = [];
let updateReturnRows: Array<{ id: string }> = [];

const fakeDb = {
  ...(realDatabase as unknown as { db: Record<string, unknown> }).db,
  insert: (_table: unknown) => ({
    values: (v: Row) => {
      insertCalls.push(v);
      return {
        onConflictDoNothing: (_target: unknown) => ({
          returning: async (_sel: unknown) => insertReturnRows,
        }),
      };
    },
  }),
  update: (_table: unknown) => ({
    set: (s: Row) => {
      updateCalls.push(s);
      return {
        where: (_w: unknown) => ({
          returning: async (_sel: unknown) => updateReturnRows,
        }),
      };
    },
  }),
};

// Leak-guard: `mock.module` is process-global, so once this file's suite is done
// every db property read delegates to the db that was live at this file's load —
// later files (quest race guards etc.) see real behavior instead of this stub.
let moonpaySuiteActive = true;
afterAll(() => {
  moonpaySuiteActive = false;
});
const DELEGATE_DB = (realDatabase as unknown as { db: Record<string, unknown> }).db;
mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: new Proxy(fakeDb, {
    get: (t, p, r) =>
      moonpaySuiteActive ? Reflect.get(t, p, r) : Reflect.get(DELEGATE_DB, p, DELEGATE_DB),
  }),
}));

// Import AFTER the mock is registered.
const { moonpayRoutes } = await import('../moonpay');
const {
  verifyMoonpayWebhookSignature,
  buildSignedWidgetUrl,
  computeCardFee,
  MOONPAY_WIDGET_BASE_URL,
} = await import('../../services/moonpay-config');

// Route chain loaded — drop the module-init DATABASE_URL placeholder so later
// files in the shared process keep their skip-when-no-DB behavior.
if (!DB_URL_WAS_SET) {
  delete process.env.DATABASE_URL;
}

const WEBHOOK_KEY = 'wk_test_whsec789';

function buildApp() {
  const app = new Hono();
  app.route('/api/moonpay', moonpayRoutes);
  return app;
}

/** Sign a raw body exactly the way MoonPay does (v2: hex hmac of `t.body`). */
function signV2(rawBody: string, key = WEBHOOK_KEY, t = Math.floor(Date.now() / 1000)) {
  const s = createHmac('sha256', key).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},s=${s}`;
}

function webhookBody(overrides: Partial<{ id: string; status: string }> = {}) {
  return JSON.stringify({
    type: 'transaction_updated',
    data: {
      id: overrides.id ?? 'mp-tx-001',
      status: overrides.status ?? 'completed',
      walletAddress: 'So1anaWa11etAddre55xxxxxxxxxxxxxxxxxxxxxxxx',
      baseCurrencyAmount: 10.0,
      quoteCurrencyAmount: 9.42,
      currency: { code: 'usdc_sol' },
      externalTransactionId: 'checkout-ref-42',
    },
  });
}

async function postWebhook(app: Hono, rawBody: string, sigHeader?: string) {
  return app.request('/api/moonpay/webhook', {
    method: 'POST',
    body: rawBody,
    headers: {
      'content-type': 'application/json',
      ...(sigHeader ? { 'Moonpay-Signature-V2': sigHeader } : {}),
    },
  });
}

beforeEach(() => {
  insertCalls.length = 0;
  updateCalls.length = 0;
  insertReturnRows = [];
  updateReturnRows = [];
  process.env.MOONPAY_WEBHOOK_KEY = WEBHOOK_KEY;
});

// ─────────────────────────────────────────────────────────────────────────────
describe('webhook — DB-enforced idempotency by external_tx_id', () => {
  it('FIRST delivery (terminal): inserts with processed_at claimed → 200 replay:false', async () => {
    insertReturnRows = [{ id: 'row-1' }]; // insert wins (no conflict)
    const raw = webhookBody({ status: 'completed' });
    const res = await postWebhook(buildApp(), raw, signV2(raw));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Row;
    expect(json).toMatchObject({ ok: true, replay: false, recorded: 'inserted' });
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0]).toMatchObject({
      externalTxId: 'mp-tx-001',
      status: 'completed',
      clientRef: 'checkout-ref-42',
      baseCurrencyAmount: '10.000000',
      quoteCurrencyAmount: '9.420000',
      currencyCode: 'usdc_sol',
    });
    // Terminal first delivery claims the marker atomically in the INSERT.
    expect(insertCalls[0].processedAt).toBeInstanceOf(Date);
    expect(updateCalls.length).toBe(0);
  });

  it('REPLAY of a processed tx: insert conflicts + guarded update matches 0 rows → 200 replay:true, ZERO re-processing', async () => {
    insertReturnRows = []; // UNIQUE index conflict absorbed (row exists)
    updateReturnRows = []; // WHERE processed_at IS NULL matches nothing
    const raw = webhookBody({ status: 'completed' });
    const res = await postWebhook(buildApp(), raw, signV2(raw));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Row;
    expect(json).toMatchObject({ ok: true, replay: true });
    // Exactly one insert ATTEMPT (absorbed by the index) + one guarded update
    // attempt (matched nothing) — no second processing path exists.
    expect(insertCalls.length).toBe(1);
    expect(updateCalls.length).toBe(1);
  });

  it('PROGRESSION pending → completed: guarded update claims processed_at exactly once', async () => {
    // Delivery 1: pending (insert wins; processed_at NOT claimed).
    insertReturnRows = [{ id: 'row-1' }];
    const rawPending = webhookBody({ status: 'pending' });
    const res1 = await postWebhook(buildApp(), rawPending, signV2(rawPending));
    expect(res1.status).toBe(200);
    expect(insertCalls[0].processedAt).toBeNull();

    // Delivery 2: completed (insert conflicts; guarded update matches the
    // still-unprocessed row and claims the marker).
    insertReturnRows = [];
    updateReturnRows = [{ id: 'row-1' }];
    const rawDone = webhookBody({ status: 'completed' });
    const res2 = await postWebhook(buildApp(), rawDone, signV2(rawDone));
    expect(res2.status).toBe(200);
    const json2 = (await res2.json()) as Row;
    expect(json2).toMatchObject({ ok: true, replay: false, recorded: 'progressed' });
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].status).toBe('completed');
    expect(updateCalls[0].processedAt).toBeInstanceOf(Date);
  });

  it('non-terminal replay (pending again on a processed row) is still replay:true', async () => {
    insertReturnRows = [];
    updateReturnRows = []; // processed_at already set ⇒ guarded update no-ops
    const raw = webhookBody({ status: 'pending' });
    const res = await postWebhook(buildApp(), raw, signV2(raw));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Row).replay).toBe(true);
    // A non-terminal progression must NEVER stamp processed_at.
    expect(updateCalls[0].processedAt).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('webhook — signature + input hygiene (never 5xx on bad input)', () => {
  it('missing signature → 401, NO DB touch', async () => {
    const res = await postWebhook(buildApp(), webhookBody());
    expect(res.status).toBe(401);
    expect(insertCalls.length).toBe(0);
    expect(updateCalls.length).toBe(0);
  });

  it('tampered body under a valid-format signature → 401, NO DB touch', async () => {
    const raw = webhookBody();
    const sig = signV2(raw);
    const tampered = raw.replace('9.42', '999999.0');
    const res = await postWebhook(buildApp(), tampered, sig);
    expect(res.status).toBe(401);
    expect(insertCalls.length).toBe(0);
  });

  it('valid signature over malformed JSON → 400', async () => {
    const raw = 'not-json{{{';
    const res = await postWebhook(buildApp(), raw, signV2(raw));
    expect(res.status).toBe(400);
  });

  it('valid signature over a body missing data.id → 400', async () => {
    const raw = JSON.stringify({ type: 'transaction_updated', data: { status: 'completed' } });
    const res = await postWebhook(buildApp(), raw, signV2(raw));
    expect(res.status).toBe(400);
  });

  it('unconfigured webhook key → 503 (MoonPay retries once provisioned)', async () => {
    delete process.env.MOONPAY_WEBHOOK_KEY;
    const raw = webhookBody();
    const res = await postWebhook(buildApp(), raw, signV2(raw));
    expect(res.status).toBe(503);
    expect(((await res.json()) as Row).code).toBe('moonpay_unconfigured');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('verifyMoonpayWebhookSignature — crypto unit', () => {
  it('accepts the real t.body hex HMAC and rejects tampering', () => {
    const raw = '{"a":1}';
    const t = 1_700_000_000;
    const good = `t=${t},s=${createHmac('sha256', WEBHOOK_KEY).update(`${t}.${raw}`).digest('hex')}`;
    expect(verifyMoonpayWebhookSignature(raw, good, WEBHOOK_KEY)).toBe(true);
    expect(verifyMoonpayWebhookSignature('{"a":2}', good, WEBHOOK_KEY)).toBe(false);
    expect(verifyMoonpayWebhookSignature(raw, good, 'wrong-key')).toBe(false);
  });

  it('rejects malformed headers cleanly (no throw)', () => {
    expect(verifyMoonpayWebhookSignature('x', undefined, WEBHOOK_KEY)).toBe(false);
    expect(verifyMoonpayWebhookSignature('x', '', WEBHOOK_KEY)).toBe(false);
    expect(verifyMoonpayWebhookSignature('x', 'garbage', WEBHOOK_KEY)).toBe(false);
    expect(verifyMoonpayWebhookSignature('x', 't=abc,s=zz', WEBHOOK_KEY)).toBe(false);
    expect(verifyMoonpayWebhookSignature('x', 't=123,s=deadbeef', WEBHOOK_KEY)).toBe(false); // short hex
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('buildSignedWidgetUrl + computeCardFee — config unit', () => {
  it('signs a sandbox URL whose signature recomputes over url.search', () => {
    const url = buildSignedWidgetUrl({
      walletAddress: 'So1anaWa11etAddre55xxxxxxxxxxxxxxxxxxxxxxxx',
      usdCents: 1000,
      externalTransactionId: 'checkout-ref-42',
    });
    expect(url).not.toBeNull();
    expect(url!.startsWith(MOONPAY_WIDGET_BASE_URL)).toBe(true);
    const u = new URL(url!);
    const sig = u.searchParams.get('signature')!;
    expect(sig.length).toBeGreaterThan(0);
    // Recompute the way MoonPay verifies: strip signature, HMAC url.search.
    u.searchParams.delete('signature');
    // Rebuild the search EXACTLY as it was signed (signature was appended last,
    // so the remaining search string is byte-identical to what was signed).
    const expected = createHmac('sha256', 'sk_test_secret456').update(u.search).digest('base64');
    expect(decodeURIComponent(encodeURIComponent(sig))).toBe(sig);
    expect(sig).toBe(expected);
    expect(u.searchParams.get('currencyCode')).toBe('usdc_sol');
    expect(u.searchParams.get('baseCurrencyAmount')).toBe('10.00');
    expect(u.searchParams.get('externalTransactionId')).toBe('checkout-ref-42');
  });

  it('REFUSES a live (non-pk_test_) publishable key — test-mode pin', () => {
    process.env.MOONPAY_API_KEY = 'pk_live_evil';
    expect(buildSignedWidgetUrl({ walletAddress: 'x'.repeat(40) })).toBeNull();
    process.env.MOONPAY_API_KEY = 'pk_test_abc123';
  });

  it('returns null when keys are missing', () => {
    const prev = process.env.MOONPAY_SECRET_KEY;
    delete process.env.MOONPAY_SECRET_KEY;
    expect(buildSignedWidgetUrl({ walletAddress: 'x'.repeat(40) })).toBeNull();
    process.env.MOONPAY_SECRET_KEY = prev;
  });

  it('computeCardFee: +4.5% default, fee rounds UP (house-favorable)', () => {
    expect(computeCardFee(1000)).toMatchObject({ feeUsdCents: 45, totalUsdCents: 1045, cardFeeBps: 450 });
    // ceil(1 × 450 / 10000) = ceil(0.045) = 1 cent — never a free ride.
    expect(computeCardFee(1)).toMatchObject({ feeUsdCents: 1, totalUsdCents: 2 });
    expect(() => computeCardFee(0)).toThrow();
    expect(() => computeCardFee(-5)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('/widget-url — auth gate present (E5 middleware chain)', () => {
  it('no cookie + no agent header → 401 before any handler logic', async () => {
    const app = buildApp();
    const res = await app.request('/api/moonpay/widget-url', {
      method: 'POST',
      body: JSON.stringify({ usdCents: 1000 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
    expect(insertCalls.length).toBe(0);
  });
});
