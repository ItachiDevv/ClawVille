/**
 * Security M12 (2026-09-30) — land service purchase price binding.
 *
 * The buy body carried only an idempotency key, so a seller could PATCH
 * `priceCt` between the buyer's read and the debit. `expectedPriceCt` now binds
 * the buy: when it differs from the price read under the listing lock, the route
 * returns 409 `price_changed` with the current price and charges nothing.
 * Protocol 83 made it REQUIRED: omitted ⇒ 400 `expected_price_required`, before
 * any DB touch (the old unbound buy is gone).
 *
 * The DB is a SQL-text fake of the buy transaction up to the debit. The ledger
 * debit is a spy that throws InsufficientTokensError, so reaching it shows up as
 * a 400 `insufficient_clawtokens` — proof the price check let the buy through.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { SQL } from 'drizzle-orm';
import * as realDatabase from '@clawville/database';
import * as realAuth from '../../middleware/auth';
import * as realAgentAuth from '../../middleware/require-auth-or-agent';
import * as realNonGuest from '../../middleware/require-non-guest';
import * as realLedger from '../../services/claw-token-ledger';

process.env.FINGERPRINT_SECRET ??= '44'.repeat(32);

const BUYER = '33333333-3333-4333-8333-333333333333';
const SELLER = '44444444-4444-4444-8444-444444444444';
const LISTING = '55555555-5555-4555-8555-555555555555';
const STRUCTURE = '66666666-6666-4666-8666-666666666666';

let listingPriceCt = 250;
let debitCalls: Array<{ avatarId: string; amount: number }> = [];

function render(query: SQL): string {
  const chunks = (query as unknown as { queryChunks: unknown[] }).queryChunks ?? [];
  let text = '';
  for (const chunk of chunks) {
    const name = (chunk as { constructor?: { name?: string } })?.constructor?.name;
    if (name === 'StringChunk') text += ((chunk as { value: string[] }).value ?? []).join('');
    else if (name === 'SQL') text += render(chunk as SQL);
    else text += '?';
  }
  return text.replace(/\s+/g, ' ').trim();
}

const fakeTx = {
  execute: async (query: SQL) => {
    const text = render(query);
    if (text.startsWith('SELECT pg_advisory_xact_lock')) return [];
    if (text.startsWith('SELECT id, listing_id, buyer_avatar_id, seller_avatar_id, price_ct')) return [];
    if (text.startsWith('SELECT id, structure_id, owner_avatar_id, kind, title, price_ct, status')) {
      return [{
        id: LISTING,
        structure_id: STRUCTURE,
        owner_avatar_id: SELLER,
        kind: 'peer',
        title: 'Hull scrub',
        price_ct: String(listingPriceCt),
        status: 'active',
        slot_suspended_at: null,
      }];
    }
    if (text.startsWith('SELECT s.status AS struct_status, p.owner_avatar_id AS parcel_owner')) {
      return [{ struct_status: 'active', parcel_owner: SELLER }];
    }
    throw new Error(`fake tx: unhandled SQL: ${text}`);
  },
};

mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: { transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx) },
}));
mock.module('../../middleware/auth', () => ({
  ...realAuth,
  sessionMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module('../../middleware/require-auth-or-agent', () => ({
  ...realAgentAuth,
  requireAuthOrAgentSession: async (c: any, next: () => Promise<void>) => {
    c.set('identity', { kind: 'user', userId: 'buyer-user', avatarId: BUYER });
    await next();
  },
  requireLedgerCapableIdentity: async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module('../../middleware/require-non-guest', () => ({
  ...realNonGuest,
  requireNonGuestIdentity: async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module('../../services/claw-token-ledger', () => ({
  ...realLedger,
  debitClawTokens: async (input: { avatarId: string; amount: number }) => {
    debitCalls.push({ avatarId: input.avatarId, amount: input.amount });
    throw new realLedger.InsufficientTokensError(input.avatarId, 0, input.amount);
  },
}));

const { landRoutes, buyServiceBodySchema, EXPECTED_PRICE_REQUIRED_BODY } = await import('../land');
const app = new Hono().route('/api/land', landRoutes);

function buy(body: Record<string, unknown>) {
  return app.request(`/api/land/services/${LISTING}/buy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  listingPriceCt = 250;
  debitCalls = [];
});

afterAll(() => {
  mock.module('@clawville/database', () => realDatabase);
  mock.module('../../middleware/auth', () => realAuth);
  mock.module('../../middleware/require-auth-or-agent', () => realAgentAuth);
  mock.module('../../middleware/require-non-guest', () => realNonGuest);
  mock.module('../../services/claw-token-ledger', () => realLedger);
});

describe('POST /api/land/services/:listingId/buy — expectedPriceCt binding (security M12)', () => {
  test('a changed price → 409 price_changed with the current price, nothing charged', async () => {
    listingPriceCt = 400; // the seller raised it after the buyer saw 250
    const res = await buy({ idempotencyKey: 'key-price-changed-1', expectedPriceCt: 250 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'price_changed', priceCt: 400 });
    expect(debitCalls).toHaveLength(0);
  });

  test('a matching price proceeds to the debit at the server price', async () => {
    const res = await buy({ idempotencyKey: 'key-price-match-1', expectedPriceCt: 250 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'insufficient_clawtokens' });
    expect(debitCalls).toEqual([{ avatarId: BUYER, amount: 250 }]);
  });

  test('protocol 83: no expectedPriceCt → 400 expected_price_required, no transaction, nothing charged', async () => {
    listingPriceCt = 400;
    let txStarted = false;
    const original = fakeTx.execute;
    fakeTx.execute = async (query: SQL) => {
      txStarted = true;
      return original(query);
    };
    try {
      const res = await buy({ idempotencyKey: 'key-no-binding-1' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('expected_price_required');
      expect(body).toEqual({ ...EXPECTED_PRICE_REQUIRED_BODY });
      // The message tells the caller exactly what to send.
      expect(body.message).toContain('expectedPriceCt');
      expect(body.message).toContain('priceCt');
      expect(body.message).toContain('price_changed');
    } finally {
      fakeTx.execute = original;
    }
    expect(txStarted).toBe(false);
    expect(debitCalls).toHaveLength(0);
  });

  test('protocol 83: an empty object body also gets expected_price_required', async () => {
    const res = await buy({});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('expected_price_required');
    expect(debitCalls).toHaveLength(0);
  });

  test('a present but invalid expectedPriceCt stays the generic invalid_body', async () => {
    for (const bad of [null, '250', -1, 1.5, 1_000_001]) {
      const res = await buy({ idempotencyKey: 'key-bad-price-1', expectedPriceCt: bad });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_body' });
    }
    expect(debitCalls).toHaveLength(0);
  });

  test('a free listing (priceCt 0) binds with expectedPriceCt 0', async () => {
    listingPriceCt = 0;
    const res = await buy({ idempotencyKey: 'key-free-mismatch', expectedPriceCt: 5 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'price_changed', priceCt: 0 });
  });

  test('schema: expectedPriceCt is a REQUIRED integer in 0..1_000_000', () => {
    const ok = (v: unknown) =>
      buyServiceBodySchema.safeParse({ idempotencyKey: 'abcdefgh', expectedPriceCt: v }).success;
    expect(buyServiceBodySchema.safeParse({ idempotencyKey: 'abcdefgh' }).success).toBe(false);
    expect(ok(0)).toBe(true);
    expect(ok(1_000_000)).toBe(true);
    expect(ok(-1)).toBe(false);
    expect(ok(1.5)).toBe(false);
    expect(ok(1_000_001)).toBe(false);
    expect(ok('250')).toBe(false);
  });
});
