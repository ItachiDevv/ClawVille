/**
 * MARKET LISTING-EXPIRY SWEEPER (task D) — unit tests.
 *
 * Proves the squatting-hole fix WITHOUT a real Postgres:
 *   1. `processExpiredListing` state machine — only an `active` + genuinely
 *      expired listing flips to `expired` and releases its deed lock; gone /
 *      not-active (pending_settlement/settled/cancelled) / not-yet-expired /
 *      concurrent-flip-lost all resolve to a NO-OP (idempotent).
 *   2. LOCK ORDER — a land_deed expiry locks in the fulfiller order (listing
 *      FOR UPDATE → advisory(seller) → parcel FOR UPDATE), so the deed-lock
 *      DELETE is atomic w.r.t. land's deed-lock guard read; a non-deed kind
 *      skips the advisory + parcel locks.
 *   3. `sweepExpiredListings` — aggregates, isolates a per-listing failure,
 *      no-ops on an empty candidate set.
 *
 * Harness mirrors market.test.ts: a fake @clawville/database with a programmable
 * per-call execute queue + recorded SQL for order/text assertions.
 */

const HEX32 = '0'.repeat(64);
function ensureEnv(k: string, v: string) {
  if (!process.env[k]) process.env[k] = v;
}
const DB_URL_WAS_SET = !!process.env.DATABASE_URL;
ensureEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/db');
ensureEnv('VANITY_ENCRYPTION_KEY', HEX32);

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import * as realDatabase from '@clawville/database';

// ── @clawville/database stub ────────────────────────────────────────────────
type Row = Record<string, unknown>;
const executeCalls: unknown[] = [];
let executeQueue: Array<Row[] | Error> = [];
async function fakeExecute(q: unknown): Promise<Row[]> {
  executeCalls.push(q);
  if (executeQueue.length === 0) return [];
  const next = executeQueue.shift()!;
  if (next instanceof Error) throw next;
  return next;
}
let txRan = 0;
const fakeTx = { execute: fakeExecute };
const fakeDb = {
  ...(realDatabase as unknown as { db: Record<string, unknown> }).db,
  execute: fakeExecute,
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    txRan += 1;
    return fn(fakeTx);
  },
};
mock.module('@clawville/database', () => ({ ...realDatabase, db: fakeDb }));

const sweeper = await import('../market-listing-expiry-sweeper');
if (!DB_URL_WAS_SET) delete process.env.DATABASE_URL;

/** Recursive drizzle-SQL flattener (handles nested sql.raw fragments). */
function flattenSql(q: unknown): { text: string; params: unknown[] } {
  const out = { text: '', params: [] as unknown[] };
  const walk = (node: unknown) => {
    const chunks = (node as { queryChunks?: unknown[] })?.queryChunks;
    if (!Array.isArray(chunks)) return false;
    for (const ch of chunks) {
      const v = (ch as { value?: unknown } | null)?.value;
      if (ch && typeof ch === 'object' && Array.isArray(v) && v.every((s) => typeof s === 'string')) {
        out.text += v.join('');
      } else if (ch && typeof ch === 'object' && Array.isArray((ch as { queryChunks?: unknown[] }).queryChunks)) {
        walk(ch);
      } else {
        out.text += ` $${out.params.length + 1} `;
        out.params.push(ch);
      }
    }
    return true;
  };
  walk(q);
  return out;
}
const sqlTexts = (): string[] => executeCalls.map((q) => flattenSql(q).text);

const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 60_000).toISOString();

beforeEach(() => {
  executeCalls.length = 0;
  executeQueue = [];
  txRan = 0;
});

describe('resolveExpirySweepPeriodMs', () => {
  it('defaults to 1h when unset', () => {
    delete process.env.MARKET_LISTING_EXPIRY_SWEEP_PERIOD_MS;
    expect(sweeper.resolveExpirySweepPeriodMs()).toBe(60 * 60 * 1000);
  });
  it('floors a too-small value back to default', () => {
    process.env.MARKET_LISTING_EXPIRY_SWEEP_PERIOD_MS = '1000';
    expect(sweeper.resolveExpirySweepPeriodMs()).toBe(60 * 60 * 1000);
    delete process.env.MARKET_LISTING_EXPIRY_SWEEP_PERIOD_MS;
  });
  it('honors a valid override', () => {
    process.env.MARKET_LISTING_EXPIRY_SWEEP_PERIOD_MS = String(10 * 60 * 1000);
    expect(sweeper.resolveExpirySweepPeriodMs()).toBe(10 * 60 * 1000);
    delete process.env.MARKET_LISTING_EXPIRY_SWEEP_PERIOD_MS;
  });
});

describe('processExpiredListing', () => {
  it('expires an active+expired land_deed and releases the deed lock, in fulfiller lock order', async () => {
    executeQueue = [
      [{ id: 'l1', seller_avatar_id: 's1', item_kind: 'land_deed', item_ref: 'p1', status: 'active', expires_at: PAST }], // listing FOR UPDATE
      [], // advisory lock
      [{ id: 'p1' }], // parcel FOR UPDATE
      [{ id: 'l1' }], // UPDATE ... RETURNING id
      [{ parcel_id: 'p1' }], // DELETE ... RETURNING parcel_id
    ];
    const action = await sweeper.processExpiredListing('l1');
    expect(action).toEqual({ kind: 'expired', listingId: 'l1', itemKind: 'land_deed', itemRef: 'p1', lockReleased: true });
    const texts = sqlTexts();
    expect(texts.length).toBe(5);
    expect(texts[0]).toContain('FROM market_listings'); // listing FOR UPDATE first
    expect(texts[0]).toContain('FOR UPDATE');
    expect(texts[1]).toContain('pg_advisory_xact_lock'); // advisory OUTER
    expect(texts[2]).toContain('FROM land_parcels'); // parcel INNER
    expect(texts[2]).toContain('FOR UPDATE');
    expect(texts[3]).toContain("status = 'expired'");
    expect(texts[3]).toContain("status = 'active'"); // idempotent guard
    expect(texts[4]).toContain('DELETE FROM market_deed_locks');
  });

  it('no-ops when the listing is gone', async () => {
    executeQueue = [[]];
    expect(await sweeper.processExpiredListing('nope')).toEqual({ kind: 'noop', listingId: 'nope', reason: 'gone' });
    expect(executeCalls.length).toBe(1); // only the listing SELECT
  });

  it('no-ops (never touches) a settled listing — the deed executor owns that lock', async () => {
    executeQueue = [[{ id: 'l1', seller_avatar_id: 's1', item_kind: 'land_deed', item_ref: 'p1', status: 'settled', expires_at: PAST }]];
    expect(await sweeper.processExpiredListing('l1')).toEqual({ kind: 'noop', listingId: 'l1', reason: 'not_active' });
    expect(executeCalls.length).toBe(1); // no advisory/parcel/UPDATE/DELETE
  });

  it('no-ops a pending_settlement listing', async () => {
    executeQueue = [[{ id: 'l1', seller_avatar_id: 's1', item_kind: 'land_deed', item_ref: 'p1', status: 'pending_settlement', expires_at: PAST }]];
    expect(await sweeper.processExpiredListing('l1')).toEqual({ kind: 'noop', listingId: 'l1', reason: 'not_active' });
  });

  it('no-ops a still-live (not-yet-expired) active listing', async () => {
    executeQueue = [[{ id: 'l1', seller_avatar_id: 's1', item_kind: 'land_deed', item_ref: 'p1', status: 'active', expires_at: FUTURE }]];
    expect(await sweeper.processExpiredListing('l1')).toEqual({ kind: 'noop', listingId: 'l1', reason: 'not_expired' });
    expect(executeCalls.length).toBe(1); // guarded before any lock/flip
  });

  it('no-ops an active listing with NULL expires_at (never expires)', async () => {
    executeQueue = [[{ id: 'l1', seller_avatar_id: 's1', item_kind: 'land_deed', item_ref: 'p1', status: 'active', expires_at: null }]];
    expect(await sweeper.processExpiredListing('l1')).toEqual({ kind: 'noop', listingId: 'l1', reason: 'not_expired' });
  });

  it('no-ops when a concurrent cancel/settle wins the flip (0-row UPDATE)', async () => {
    executeQueue = [
      [{ id: 'l1', seller_avatar_id: 's1', item_kind: 'land_deed', item_ref: 'p1', status: 'active', expires_at: PAST }],
      [], // advisory
      [{ id: 'p1' }], // parcel
      [], // UPDATE returns 0 rows — someone else moved it
    ];
    expect(await sweeper.processExpiredListing('l1')).toEqual({ kind: 'noop', listingId: 'l1', reason: 'not_active' });
    const texts = sqlTexts();
    expect(texts.some((t) => t.includes('DELETE FROM market_deed_locks'))).toBe(false); // no lock delete on a lost flip
  });

  it('skips the advisory + parcel locks for a non-deed kind', async () => {
    executeQueue = [
      [{ id: 'l1', seller_avatar_id: 's1', item_kind: 'earned_bundle', item_ref: 'x1', status: 'active', expires_at: PAST }],
      [{ id: 'l1' }], // UPDATE
      [], // DELETE (no lock row)
    ];
    const action = await sweeper.processExpiredListing('l1');
    expect(action.kind).toBe('expired');
    if (action.kind === 'expired') expect(action.lockReleased).toBe(false);
    const texts = sqlTexts();
    expect(texts.some((t) => t.includes('pg_advisory_xact_lock'))).toBe(false);
    expect(texts.some((t) => t.includes('FROM land_parcels'))).toBe(false);
  });
});

describe('sweepExpiredListings', () => {
  it('no-ops on an empty candidate set', async () => {
    executeQueue = [[]]; // candidate read → none
    expect(await sweeper.sweepExpiredListings()).toEqual({ expired: 0, locksReleased: 0, noop: 0 });
  });

  it('aggregates across candidates and isolates a per-listing failure', async () => {
    executeQueue = [
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }], // candidate read
      // a: expires cleanly (deed)
      [{ id: 'a', seller_avatar_id: 's', item_kind: 'land_deed', item_ref: 'pa', status: 'active', expires_at: PAST }],
      [],
      [{ id: 'pa' }],
      [{ id: 'a' }],
      [{ parcel_id: 'pa' }],
      // b: candidate read said due, but under lock it's already settled → noop
      [{ id: 'b', seller_avatar_id: 's', item_kind: 'land_deed', item_ref: 'pb', status: 'settled', expires_at: PAST }],
      // c: throws (isolated, non-fatal)
      new Error('boom on c'),
    ];
    const res = await sweeper.sweepExpiredListings();
    expect(res).toEqual({ expired: 1, locksReleased: 1, noop: 1 });
  });
});
