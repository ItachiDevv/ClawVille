/**
 * MARKET DEED-TRANSFER EXECUTOR — unit tests (Tokenomics GoLive executors, 2026-07-07).
 *
 * Proves the deed-flip money discipline WITHOUT Postgres (all DB I/O through
 * the injectable MarketDeedTransferDb; the fake's runInTransaction snapshots
 * state and RESTORES it on a throw, so rollback/resumability is exercised for
 * real):
 *
 *   1. GATE: every entrypoint refuses when MARKET_DEED_TRANSFER_ENABLED != 'true'.
 *   2. HAPPY PATH: one tx — claim (SKIP LOCKED) → land lock order (advisory
 *      OUTER, parcel INNER) → under-lock re-verify → flip → structures → stamp
 *      → lock release. Ordering asserted.
 *   3. IDEMPOTENCY: an already-transferred deed replays as a no-op.
 *   4. DOUBLE-CLAIM: a row locked by a concurrent worker is skipped
 *      (not_claimable), nothing mutates.
 *   5. CONFLICT: seller no longer owns the parcel → TERMINAL
 *      deed_transfer_conflict; the flip NEVER happens; the deed lock stays
 *      HELD; a re-run refuses terminally.
 *   6. ESCROW GUARD: a live deposit escrow refuses the flip (conservation).
 *   7. CRASH/RESUME: a mid-tx failure rolls EVERYTHING back (row unclaimed,
 *      parcel untouched) and a re-run completes — resumable, never a lost deed.
 */

// Scoped module-load env (the @clawville/database import graph).
const DB_URL_WAS_SET = !!process.env.DATABASE_URL;
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
}

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import type {
  DeedListingRow,
  DeedParcelRow,
  DeedSettlementRow,
  DeedTransferTx,
  MarketDeedTransferDb,
  MarketDeedTransferDeps,
} from '../market-deed-transfer-executor';

const { runDeedTransferForSettlement, runDeedTransferTick, requireMarketDeedTransferEnabled } =
  await import('../market-deed-transfer-executor');

if (!DB_URL_WAS_SET) {
  delete process.env.DATABASE_URL;
}

const SETT = '22222222-2222-4222-8222-222222222222';

// ── the injectable fake (snapshot/restore = real rollback semantics) ─────────

interface FakeState {
  settlements: Map<string, DeedSettlementRow & { claimStamped?: string }>;
  listings: Map<string, DeedListingRow>;
  parcels: Map<
    string,
    DeedParcelRow & { flippedTo?: string; lockedByOther?: boolean }
  >;
  structures: Map<string, { id: string; parcelId: string; ownerAvatarId: string; status: string }>;
  locks: Map<string, { listingId: string }>;
}

interface Harness {
  deps: MarketDeedTransferDeps;
  log: string[];
  state: FakeState;
}

function makeHarness(opts: {
  settlement?: Partial<DeedSettlementRow>;
  listing?: Partial<DeedListingRow>;
  parcel?: Partial<DeedParcelRow>;
  structures?: Array<{ id: string; parcelId: string; ownerAvatarId: string; status: string }>;
  noLock?: boolean;
  noParcel?: boolean;
  settlementLockedByOther?: boolean;
  failFlipOnce?: boolean;
} = {}): Harness {
  const log: string[] = [];
  const state: FakeState = {
    settlements: new Map([
      [
        SETT,
        {
          id: SETT,
          listingId: 'list-1',
          checkoutId: 'chk-1',
          buyerAvatarId: 'buyer-1',
          sellerAvatarId: 'seller-1',
          deedTransferredAt: null,
          deedTransferFailureReason: null,
          ...opts.settlement,
        },
      ],
    ]),
    listings: new Map([
      [
        'list-1',
        {
          id: 'list-1',
          itemKind: 'land_deed',
          itemRef: 'parcel-1',
          status: 'settled',
          sellerAvatarId: 'seller-1',
          ...opts.listing,
        },
      ],
    ]),
    parcels: new Map(
      opts.noParcel
        ? []
        : [
            [
              'parcel-1',
              {
                id: 'parcel-1',
                ownerAvatarId: 'seller-1',
                tenure: 'owned',
                depositRemainingCt: null,
                ...opts.parcel,
              },
            ],
          ],
    ),
    structures: new Map(
      (opts.structures ?? [
        { id: 'st-1', parcelId: 'parcel-1', ownerAvatarId: 'seller-1', status: 'active' },
      ]).map((s) => [s.id, { ...s }]),
    ),
    locks: new Map(opts.noLock ? [] : [['parcel-1', { listingId: 'list-1' }]]),
  };
  const lockedByOther = new Set<string>(opts.settlementLockedByOther ? [SETT] : []);
  let flipShouldFail = opts.failFlipOnce === true;

  function snapshot(s: FakeState): FakeState {
    return {
      settlements: new Map([...s.settlements].map(([k, v]) => [k, { ...v }])),
      listings: new Map([...s.listings].map(([k, v]) => [k, { ...v }])),
      parcels: new Map([...s.parcels].map(([k, v]) => [k, { ...v }])),
      structures: new Map([...s.structures].map(([k, v]) => [k, { ...v }])),
      locks: new Map([...s.locks].map(([k, v]) => [k, { ...v }])),
    };
  }
  function restore(s: FakeState, snap: FakeState): void {
    s.settlements = snap.settlements;
    s.listings = snap.listings;
    s.parcels = snap.parcels;
    s.structures = snap.structures;
    s.locks = snap.locks;
  }

  const txApi: DeedTransferTx = {
    async claimSettlement(settlementId, claimId) {
      log.push('claimSettlement');
      if (lockedByOther.has(settlementId)) return null; // SKIP LOCKED semantics
      const s = state.settlements.get(settlementId);
      if (!s || s.deedTransferredAt || s.deedTransferFailureReason) return null;
      s.claimStamped = claimId;
      return { ...s };
    },
    async readSettlement(settlementId) {
      log.push('readSettlement');
      const s = state.settlements.get(settlementId);
      return s ? { ...s } : null;
    },
    async getListing(listingId) {
      log.push('getListing');
      const l = state.listings.get(listingId);
      return l ? { ...l } : null;
    },
    async acquireSellerAdvisoryLock(_sellerAvatarId) {
      log.push('advisoryLock');
    },
    async lockParcel(parcelId) {
      log.push('lockParcel');
      const p = state.parcels.get(parcelId);
      return p ? { ...p } : null;
    },
    async flipParcelToBuyer(parcelId, sellerAvatarId, buyerAvatarId) {
      log.push('flip');
      if (flipShouldFail) {
        flipShouldFail = false;
        throw new Error('boom: flip died mid-tx');
      }
      const p = state.parcels.get(parcelId);
      if (!p || p.ownerAvatarId !== sellerAvatarId) return false;
      p.ownerAvatarId = buyerAvatarId;
      p.tenure = 'owned';
      p.depositRemainingCt = null;
      p.flippedTo = buyerAvatarId;
      return true;
    },
    async transferStructuresToBuyer(parcelId, buyerAvatarId) {
      log.push('transferStructures');
      let n = 0;
      for (const st of state.structures.values()) {
        if (st.parcelId === parcelId) {
          st.ownerAvatarId = buyerAvatarId;
          n += 1;
        }
      }
      return n;
    },
    async stampDeedTransferred(settlementId, claimId) {
      log.push('stamp');
      const s = state.settlements.get(settlementId);
      if (!s || s.claimStamped !== claimId || s.deedTransferredAt) return false;
      s.deedTransferredAt = new Date();
      return true;
    },
    async releaseDeedLock(parcelId, listingId) {
      log.push('releaseLock');
      const l = state.locks.get(parcelId);
      if (l && l.listingId === listingId) state.locks.delete(parcelId);
    },
    async markDeedConflict(settlementId, claimId, reason) {
      log.push('markConflict');
      const s = state.settlements.get(settlementId);
      if (s && s.claimStamped === claimId && !s.deedTransferredAt) {
        s.deedTransferFailureReason = reason;
      }
    },
  };

  const fakeDb: MarketDeedTransferDb = {
    async listEligibleSettlements(limit) {
      return [...state.settlements.values()]
        .filter((s) => !s.deedTransferredAt && !s.deedTransferFailureReason)
        .slice(0, limit)
        .map((s) => s.id);
    },
    async runInTransaction(fn) {
      const snap = snapshot(state);
      try {
        return await fn(txApi);
      } catch (err) {
        restore(state, snap); // the real impl's Postgres ROLLBACK
        throw err;
      }
    },
  };

  return { deps: { db: fakeDb }, log, state };
}

beforeEach(() => {
  process.env.MARKET_DEED_TRANSFER_ENABLED = 'true';
});

afterAll(() => {
  delete process.env.MARKET_DEED_TRANSFER_ENABLED;
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GATE — the executor is dark by default', () => {
  it('every entrypoint refuses when MARKET_DEED_TRANSFER_ENABLED is not "true"', async () => {
    delete process.env.MARKET_DEED_TRANSFER_ENABLED;
    const h = makeHarness();
    expect(() => requireMarketDeedTransferEnabled()).toThrow(/DARK/);
    await expect(runDeedTransferForSettlement(SETT, h.deps)).rejects.toThrow(/DARK/);
    await expect(runDeedTransferTick(h.deps)).rejects.toThrow(/DARK/);
    expect(h.log.length).toBe(0); // nothing touched anything
  });

  it('zod refuses a non-uuid settlement id before any DB touch', async () => {
    const h = makeHarness();
    const res = await runDeedTransferForSettlement('not-a-uuid', h.deps);
    expect(res).toMatchObject({ ok: false, code: 'invalid_settlement_id' });
    expect(h.log.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('HAPPY PATH — one-tx claim → verify → flip → stamp → release', () => {
  it('flips ownership, transfers structures, stamps the deed, releases the lock', async () => {
    const h = makeHarness();
    const res = await runDeedTransferForSettlement(SETT, h.deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.replay).toBe(false);
    expect(res.parcelId).toBe('parcel-1');
    expect(res.structuresTransferred).toBe(1);

    const parcel = h.state.parcels.get('parcel-1')!;
    expect(parcel.ownerAvatarId).toBe('buyer-1');
    expect(parcel.tenure).toBe('owned');
    expect(parcel.depositRemainingCt).toBeNull();
    expect(h.state.structures.get('st-1')!.ownerAvatarId).toBe('buyer-1');
    expect(h.state.settlements.get(SETT)!.deedTransferredAt).not.toBeNull();
    expect(h.state.locks.has('parcel-1')).toBe(false); // lock released

    // ORDERING: claim → advisory OUTER → parcel INNER → flip → stamp → release.
    const idx = (name: string) => h.log.indexOf(name);
    expect(idx('claimSettlement')).toBeLessThan(idx('advisoryLock'));
    expect(idx('advisoryLock')).toBeLessThan(idx('lockParcel'));
    expect(idx('lockParcel')).toBeLessThan(idx('flip'));
    expect(idx('flip')).toBeLessThan(idx('stamp'));
    expect(idx('stamp')).toBeLessThan(idx('releaseLock'));
  });

  it('IDEMPOTENT: an already-transferred deed replays as a no-op', async () => {
    const h = makeHarness({ settlement: { deedTransferredAt: new Date() } });
    const res = await runDeedTransferForSettlement(SETT, h.deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.replay).toBe(true);
    expect(h.log).not.toContain('flip');
    expect(h.log).not.toContain('stamp');
    expect(h.state.parcels.get('parcel-1')!.ownerAvatarId).toBe('seller-1'); // untouched
  });

  it('DOUBLE-CLAIM: a row locked by a concurrent worker is skipped, nothing mutates', async () => {
    const h = makeHarness({ settlementLockedByOther: true });
    const res = await runDeedTransferForSettlement(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'not_claimable' });
    expect(h.log).not.toContain('flip');
    expect(h.state.parcels.get('parcel-1')!.ownerAvatarId).toBe('seller-1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('CONFLICTS — never force a flip', () => {
  it('seller no longer owns the parcel → TERMINAL conflict; lock stays HELD', async () => {
    const h = makeHarness({ parcel: { ownerAvatarId: 'someone-else' } });
    const res = await runDeedTransferForSettlement(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'deed_transfer_conflict', detail: 'seller_not_owner' });

    const s = h.state.settlements.get(SETT)!;
    expect(s.deedTransferFailureReason).toBe('deed_transfer_conflict');
    expect(s.deedTransferredAt).toBeNull();
    expect(h.state.parcels.get('parcel-1')!.ownerAvatarId).toBe('someone-else'); // untouched
    expect(h.state.locks.has('parcel-1')).toBe(true); // HELD for ops
    expect(h.log).not.toContain('flip');

    // A re-run refuses TERMINALLY — the conflict is never retried.
    const res2 = await runDeedTransferForSettlement(SETT, h.deps);
    expect(res2).toMatchObject({ ok: false, code: 'deed_transfer_conflict' });
    expect(h.log.filter((l) => l === 'flip').length).toBe(0);
  });

  it('parcel missing → TERMINAL conflict (parcel_missing)', async () => {
    const h = makeHarness({ noParcel: true });
    const res = await runDeedTransferForSettlement(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'deed_transfer_conflict', detail: 'parcel_missing' });
    expect(h.state.settlements.get(SETT)!.deedTransferFailureReason).toBe(
      'deed_transfer_parcel_missing',
    );
  });

  it('ESCROW GUARD: a live deposit escrow refuses the flip (conservation)', async () => {
    const h = makeHarness({ parcel: { tenure: 'deposit', depositRemainingCt: 500 } });
    const res = await runDeedTransferForSettlement(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'deed_transfer_conflict', detail: 'escrow_present' });
    const p = h.state.parcels.get('parcel-1')!;
    expect(p.ownerAvatarId).toBe('seller-1'); // untouched
    expect(p.depositRemainingCt).toBe(500); // escrow NOT vaporized
    expect(h.state.settlements.get(SETT)!.deedTransferFailureReason).toBe(
      'deed_transfer_escrow_present',
    );
  });

  it('non-deed kinds are refused (the executor never touches them)', async () => {
    const h = makeHarness({ listing: { itemKind: 'earned_bundle' } });
    const res = await runDeedTransferForSettlement(SETT, h.deps);
    expect(res).toMatchObject({ ok: false, code: 'not_land_deed' });
    expect(h.log).not.toContain('flip');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('CRASH/RESUME — one tx, rollback, re-run completes', () => {
  it('a mid-tx failure rolls EVERYTHING back; the re-run succeeds', async () => {
    const h = makeHarness({ failFlipOnce: true });

    await expect(runDeedTransferForSettlement(SETT, h.deps)).rejects.toThrow(/flip died/);
    // ROLLED BACK: unclaimed, parcel untouched, lock intact, deed unstamped.
    const s = h.state.settlements.get(SETT)!;
    expect(s.claimStamped).toBeUndefined();
    expect(s.deedTransferredAt).toBeNull();
    expect(s.deedTransferFailureReason).toBeNull();
    expect(h.state.parcels.get('parcel-1')!.ownerAvatarId).toBe('seller-1');
    expect(h.state.locks.has('parcel-1')).toBe(true);

    // RESUMABLE: the next run completes the transfer cleanly.
    const res = await runDeedTransferForSettlement(SETT, h.deps);
    expect(res.ok).toBe(true);
    expect(h.state.parcels.get('parcel-1')!.ownerAvatarId).toBe('buyer-1');
    expect(h.state.settlements.get(SETT)!.deedTransferredAt).not.toBeNull();
    expect(h.state.locks.has('parcel-1')).toBe(false);
  });

  it('runDeedTransferTick survives a per-settlement tx failure (logged, resumable)', async () => {
    const h = makeHarness({ failFlipOnce: true });
    const out1 = await runDeedTransferTick(h.deps);
    expect(out1.length).toBe(0); // the failed transfer rolled back, not reported ok
    const out2 = await runDeedTransferTick(h.deps);
    expect(out2.length).toBe(1);
    expect(out2[0].result.ok).toBe(true);
  });
});
