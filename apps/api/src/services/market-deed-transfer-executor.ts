/**
 * MARKET DEED-TRANSFER EXECUTOR (Tokenomics GoLive executors, 2026-07-07).
 * ============================================================================
 * ███ DARK. NOTHING HERE RUNS TODAY. ███
 *
 * Flips `land_parcels.owner_avatar_id` seller→buyer for SETTLED `land_deed`
 * marketplace settlements (`market_settlements.deed_transferred_at IS NULL`).
 * PURE DB — no custody, no chain, no CT ledger. Ships ENTIRELY behind the
 * default-OFF `MARKET_DEED_TRANSFER_ENABLED` flag; NOTHING imports this from
 * index.ts boot (running it is a deliberate, Codex-reviewed wiring change).
 *
 * // FEATURE_GATE: market_deed_transfer_executor
 * // Status: dark plumbing — exported but unreachable (default-OFF gate at
 * //   every entrypoint); NOT wired into index.ts.
 * // Metric to graduate: Codex adversarial review PASSED on this file +
 * //   migration 0020, AND land-domain review of the tenure/structure
 * //   semantics flagged below, AND a staging smoke of one settled deed flip.
 * // Current reading: 0 executions (gate has never been opened).
 * // Review deadline: 2026-08-07.
 * // On deadline: if the go-live is not scheduled, stays dark or is deleted —
 * //   never rots half-reviewed.
 * // Reference: CLAUDE.md kill-the-build invariants; market.ts schema header.
 *
 * ── ORDERING (Codex, BLOCKING): deed FIRST, payout SECOND ────────────────────
 * A settlement row exists ONLY post-USDC-capture (the marketplace fulfiller
 * runs INSIDE the checkout settle tx, after the tx signature was captured), so
 * any settled row's funds are already secured — the deed can never flip before
 * the money arrived. The payout executor (`market-payout-executor.ts`) then
 * reads `deed_transferred_at IS NOT NULL` as its PRECONDITION, so the seller
 * is never paid for a deed that did not (or could not) transfer. A crash
 * between deed-flip-commit and payout leaves the row
 * (deed_transferred_at set, payout_status='pending_review') — the payout tick
 * simply picks it up later: resumable, never a lost deed, never a lost payout.
 *
 * ── ATOMICITY: ONE transaction per settlement ────────────────────────────────
 * claim + re-verify + parcel flip + structure transfer + deed stamp + lock
 * release all commit together or roll back together. A crash mid-transfer
 * rolls the whole thing back (row unclaimed, parcel untouched) — the next tick
 * resumes it cleanly. The cross-process mutex is `FOR UPDATE SKIP LOCKED` on
 * the settlement row + the `deed_transferred_at IS NULL` predicate (a second
 * worker skips a locked row; a replay sees the stamp and no-ops);
 * `deed_transfer_claim_id`/`deed_transfer_started_at` are the durable AUDIT of
 * which attempt performed the flip, committed only with the outcome.
 *
 * ── LOCK ORDER (the land lock order — no AB-BA edge) ─────────────────────────
 * (1) the settlement row FOR UPDATE SKIP LOCKED (market-owned — nothing in the
 * land domain ever locks it), THEN (2) per-SELLER advisory lock
 * `pg_advisory_xact_lock(hashtextextended(sellerAvatarId, 0))` OUTER, THEN
 * (3) the parcel row FOR UPDATE INNER — (2)→(3) is exactly the order every
 * land mutation and the marketplace fulfiller use.
 *
 * ── UNDER-LOCK RE-VERIFY — never force a flip ────────────────────────────────
 * Land's release/evict/tenure-lapse paths do NOT consult `market_deed_locks`
 * (documented C4 seam owned by the land domain), so the parcel may have left
 * the seller between settle and this run. Under the parcel lock we RE-VERIFY
 * `owner_avatar_id` still equals the settlement's seller — if not, the row is
 * stamped TERMINAL `deed_transfer_conflict` (deed_transfer_failure_reason) and
 * the flip NEVER happens: the buyer's money is loud manual-refund territory
 * (the checkout carries the signature trail), and the payout executor's
 * deed-precondition guarantees the seller is never paid for it. We also refuse
 * (`deed_transfer_escrow_present`) if the parcel carries a LIVE deposit escrow
 * (`deposit_remaining_ct > 0`) — NULLing it would vaporize escrowed CT and
 * break the land escrow-conservation invariant. Should be impossible (only
 * 'owned'/'hold' tenures can list) — defense-in-depth, terminal, loud.
 * On any terminal conflict the `market_deed_locks` row stays HELD
 * (house-favorable freeze of the parcel's transferability until ops resolves).
 *
 * ── WHAT THE FLIP WRITES (land_parcels — via OUR OWN SQL; land.ts untouched) ─
 * owner_avatar_id=buyer · status='owned' · tenure='owned' [FLAG for land
 * review: a P2P-bought parcel defaults to the buy-outright tenure; land may
 * prefer 'hold' with a re-stamped threshold] · acquired_at=now() · deposit_ct/
 * deposit_remaining_ct/rent_paid_through/grace_until/hold_threshold_ct/
 * hold_subject=NULL · grandfathered=false · rent_ct_weekly KEPT (per-parcel
 * seed-stamped listing value, not per-tenancy). Any structure on the parcel
 * transfers to the buyer AS-IS (denormalized `land_structures.owner_avatar_id`
 * updated, status/level untouched) [FLAG for land review: the deed sale
 * conveys the build; land may prefer archived-structure purge semantics].
 *
 * LEDGER-ONLY DISCIPLINE: this module never imports `claw-token-ledger` and
 * never writes `avatars.clawTokens` — no internal vCLAW moves here, ever.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, sql } from '@clawville/database';

// ---------------------------------------------------------------------------
// The default-OFF gate
// ---------------------------------------------------------------------------

/** True ONLY when `MARKET_DEED_TRANSFER_ENABLED === 'true'`. Default OFF. */
export function isMarketDeedTransferEnabled(): boolean {
  return process.env.MARKET_DEED_TRANSFER_ENABLED === 'true';
}

/** Re-asserted at EVERY entrypoint. Throws unless the env is literally 'true'. */
export function requireMarketDeedTransferEnabled(): void {
  if (!isMarketDeedTransferEnabled()) {
    throw new Error(
      `[market-deed-transfer] executor is DARK — MARKET_DEED_TRANSFER_ENABLED is not 'true' ` +
        `(default-OFF; opening it is a Codex+land-reviewed change, never an env flip alone)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Injectable DB surface (tests inject a fake; defaults are the real SQL)
// ---------------------------------------------------------------------------

export interface DeedSettlementRow {
  id: string;
  listingId: string;
  checkoutId: string;
  buyerAvatarId: string;
  sellerAvatarId: string;
  deedTransferredAt: Date | null;
  deedTransferFailureReason: string | null;
}

export interface DeedListingRow {
  id: string;
  itemKind: string;
  itemRef: string;
  status: string;
  sellerAvatarId: string;
}

export interface DeedParcelRow {
  id: string;
  ownerAvatarId: string | null;
  tenure: string | null;
  depositRemainingCt: number | null;
}

/** All methods run on the SAME open transaction the executor drives. */
export interface DeedTransferTx {
  /**
   * THE claim: `SELECT … FOR UPDATE SKIP LOCKED` on the settlement row where
   * `deed_transferred_at IS NULL AND deed_transfer_failure_reason IS NULL`,
   * then stamp `deed_transfer_claim_id`/`deed_transfer_started_at` (audit —
   * commits only with the outcome). null ⇒ locked by another worker OR
   * ineligible (caller re-reads to distinguish).
   */
  claimSettlement(settlementId: string, claimId: string): Promise<DeedSettlementRow | null>;
  /** Plain (unlocked) read used to classify a failed claim. */
  readSettlement(settlementId: string): Promise<DeedSettlementRow | null>;
  getListing(listingId: string): Promise<DeedListingRow | null>;
  /** Land lock order OUTER: pg_advisory_xact_lock(hashtextextended(seller,0)). */
  acquireSellerAdvisoryLock(sellerAvatarId: string): Promise<void>;
  /** Land lock order INNER: the parcel row FOR UPDATE. null = parcel missing. */
  lockParcel(parcelId: string): Promise<DeedParcelRow | null>;
  /**
   * The ownership flip (tripwire `WHERE owner_avatar_id = seller` under the
   * lock). Returns false when the tripwire missed — caller treats as conflict.
   */
  flipParcelToBuyer(parcelId: string, sellerAvatarId: string, buyerAvatarId: string): Promise<boolean>;
  /** Denormalized land_structures.owner_avatar_id → buyer (only the SELLER's
   *  own ACTIVE structure, as-is). Returns count. */
  transferStructuresToBuyer(
    parcelId: string,
    sellerAvatarId: string,
    buyerAvatarId: string,
  ): Promise<number>;
  /** Stamp deed_transferred_at (checked: claim + still NULL). */
  stampDeedTransferred(settlementId: string, claimId: string): Promise<boolean>;
  /** DELETE the market_deed_locks row (same tx as the flip). */
  releaseDeedLock(parcelId: string, listingId: string): Promise<void>;
  /** TERMINAL conflict stamp (deed_transfer_failure_reason) — commits with the tx. */
  markDeedConflict(settlementId: string, claimId: string, reason: string): Promise<void>;
}

export interface MarketDeedTransferDb {
  /** Oldest-first pending land_deed settlements (deed NULL, no terminal failure). */
  listEligibleSettlements(limit: number): Promise<string[]>;
  /** ONE transaction per settlement — commit together or roll back together. */
  runInTransaction<T>(fn: (tx: DeedTransferTx) => Promise<T>): Promise<T>;
}

export interface MarketDeedTransferDeps {
  db?: MarketDeedTransferDb;
}

type SettlementWire = {
  id: string;
  listing_id: string;
  checkout_id: string;
  buyer_avatar_id: string;
  seller_avatar_id: string;
  deed_transferred_at: string | Date | null;
  deed_transfer_failure_reason: string | null;
};

function toSettlementRow(r: SettlementWire): DeedSettlementRow {
  return {
    id: r.id,
    listingId: r.listing_id,
    checkoutId: r.checkout_id,
    buyerAvatarId: r.buyer_avatar_id,
    sellerAvatarId: r.seller_avatar_id,
    deedTransferredAt: r.deed_transferred_at == null ? null : new Date(r.deed_transferred_at),
    deedTransferFailureReason: r.deed_transfer_failure_reason,
  };
}

const SETTLEMENT_COLS = sql.raw(
  'id, listing_id, checkout_id, buyer_avatar_id, seller_avatar_id, deed_transferred_at, deed_transfer_failure_reason',
);

/** Drizzle tx handle (matches the LedgerTx alias shape used across services). */
type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function makeTxApi(tx: DrizzleTx): DeedTransferTx {
  return {
    async claimSettlement(settlementId, claimId) {
      const rows = await tx.execute<SettlementWire>(
        sql`SELECT ${SETTLEMENT_COLS}
            FROM market_settlements
            WHERE id = ${settlementId}
              AND deed_transferred_at IS NULL
              AND deed_transfer_failure_reason IS NULL
            FOR UPDATE SKIP LOCKED`,
      );
      const row = rows[0];
      if (!row) return null;
      await tx.execute(
        sql`UPDATE market_settlements
            SET deed_transfer_claim_id = ${claimId}, deed_transfer_started_at = now()
            WHERE id = ${settlementId}`,
      );
      return toSettlementRow(row);
    },
    async readSettlement(settlementId) {
      const rows = await tx.execute<SettlementWire>(
        sql`SELECT ${SETTLEMENT_COLS} FROM market_settlements WHERE id = ${settlementId}`,
      );
      return rows[0] ? toSettlementRow(rows[0]) : null;
    },
    async getListing(listingId) {
      const rows = await tx.execute<{
        id: string;
        item_kind: string;
        item_ref: string;
        status: string;
        seller_avatar_id: string;
      }>(
        sql`SELECT id, item_kind, item_ref, status, seller_avatar_id
            FROM market_listings WHERE id = ${listingId}`,
      );
      const r = rows[0];
      return r
        ? {
            id: r.id,
            itemKind: r.item_kind,
            itemRef: r.item_ref,
            status: r.status,
            sellerAvatarId: r.seller_avatar_id,
          }
        : null;
    },
    async acquireSellerAdvisoryLock(sellerAvatarId) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${sellerAvatarId}, 0))`);
    },
    async lockParcel(parcelId) {
      const rows = await tx.execute<{
        id: string;
        owner_avatar_id: string | null;
        tenure: string | null;
        deposit_remaining_ct: number | string | null;
      }>(
        sql`SELECT id, owner_avatar_id, tenure, deposit_remaining_ct
            FROM land_parcels WHERE id = ${parcelId} FOR UPDATE`,
      );
      const r = rows[0];
      return r
        ? {
            id: r.id,
            ownerAvatarId: r.owner_avatar_id,
            tenure: r.tenure,
            depositRemainingCt: r.deposit_remaining_ct == null ? null : Number(r.deposit_remaining_ct),
          }
        : null;
    },
    async flipParcelToBuyer(parcelId, sellerAvatarId, buyerAvatarId) {
      // Fresh-owned reset. rent_ct_weekly is deliberately KEPT (per-parcel
      // seed-stamped listing value). Tenure default 'owned' — FLAG for land
      // review (see module header).
      const rows = await tx.execute<{ id: string }>(
        sql`UPDATE land_parcels
            SET owner_avatar_id = ${buyerAvatarId},
                status = 'owned',
                tenure = 'owned',
                acquired_at = now(),
                deposit_ct = NULL,
                deposit_remaining_ct = NULL,
                rent_paid_through = NULL,
                grace_until = NULL,
                hold_threshold_ct = NULL,
                hold_subject = NULL,
                grandfathered = false,
                updated_at = now()
            WHERE id = ${parcelId} AND owner_avatar_id = ${sellerAvatarId}
            RETURNING id`,
      );
      return rows.length > 0;
    },
    async transferStructuresToBuyer(parcelId, sellerAvatarId, buyerAvatarId) {
      // Transfer ONLY the SELLER's own ACTIVE structure AS-IS (status/level
      // untouched). Scoped to `owner_avatar_id = seller AND status = 'active'`
      // (adversarial-audit item 3): a bare `WHERE parcel_id` would also reassign
      // an ARCHIVED structure left by a PRIOR evicted tenant (a third party) to
      // the buyer. What happens to a seller-owned ARCHIVED structure on a deed
      // sale (transfer vs purge, mirroring `reconcileArchivedStructureOnAcquire`)
      // is a land-domain policy decision — left untouched here, FLAG for land review.
      const rows = await tx.execute<{ id: string }>(
        sql`UPDATE land_structures
            SET owner_avatar_id = ${buyerAvatarId}, updated_at = now()
            WHERE parcel_id = ${parcelId}
              AND owner_avatar_id = ${sellerAvatarId}
              AND status = 'active'
            RETURNING id`,
      );
      return rows.length;
    },
    async stampDeedTransferred(settlementId, claimId) {
      const rows = await tx.execute<{ id: string }>(
        sql`UPDATE market_settlements
            SET deed_transferred_at = now()
            WHERE id = ${settlementId}
              AND deed_transfer_claim_id = ${claimId}
              AND deed_transferred_at IS NULL
            RETURNING id`,
      );
      return rows.length > 0;
    },
    async releaseDeedLock(parcelId, listingId) {
      await tx.execute(
        sql`DELETE FROM market_deed_locks
            WHERE parcel_id = ${parcelId} AND listing_id = ${listingId}`,
      );
    },
    async markDeedConflict(settlementId, claimId, reason) {
      await tx.execute(
        sql`UPDATE market_settlements
            SET deed_transfer_failure_reason = ${reason}
            WHERE id = ${settlementId}
              AND deed_transfer_claim_id = ${claimId}
              AND deed_transferred_at IS NULL`,
      );
    },
  };
}

const defaultDb: MarketDeedTransferDb = {
  async listEligibleSettlements(limit) {
    const n = Math.min(Math.max(1, Math.floor(limit)), 100);
    const rows = await db.execute<{ id: string }>(
      sql`SELECT s.id
          FROM market_settlements s
          JOIN market_listings l ON l.id = s.listing_id
          WHERE l.item_kind = 'land_deed'
            AND s.deed_transferred_at IS NULL
            AND s.deed_transfer_failure_reason IS NULL
          ORDER BY s.created_at ASC
          LIMIT ${n}`,
    );
    return rows.map((r) => r.id);
  },
  async runInTransaction(fn) {
    return db.transaction(async (tx) => fn(makeTxApi(tx)));
  },
};

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

export type DeedTransferResult =
  | {
      ok: true;
      settlementId: string;
      parcelId: string;
      buyerAvatarId: string;
      structuresTransferred: number;
      /** true = the deed was ALREADY transferred (idempotent no-op). */
      replay: boolean;
    }
  | {
      ok: false;
      code:
        | 'invalid_settlement_id'
        | 'settlement_not_found'
        | 'not_claimable' // locked by a concurrent worker — retry next tick
        | 'listing_not_found'
        | 'not_land_deed'
        | 'listing_not_settled'
        | 'deed_transfer_conflict' // TERMINAL — seller no longer owns / parcel gone / escrow live
        | 'stamp_lost';
      detail?: string;
    };

const uuidSchema = z.string().uuid();

/**
 * Transfer ONE settled deed. ONE transaction: claim (SKIP LOCKED) → re-verify
 * under the land lock order → flip → transfer structures → stamp → release the
 * deed lock. Idempotent (a transferred deed replays as a no-op), resumable (a
 * crash rolls the whole tx back), conflict-safe (never forces a flip).
 * DARK — throws unless `MARKET_DEED_TRANSFER_ENABLED === 'true'`.
 */
export async function runDeedTransferForSettlement(
  settlementId: string,
  deps?: MarketDeedTransferDeps,
): Promise<DeedTransferResult> {
  requireMarketDeedTransferEnabled();
  if (!uuidSchema.safeParse(settlementId).success) {
    return { ok: false, code: 'invalid_settlement_id' };
  }
  const d = deps?.db ?? defaultDb;
  const claimId = randomUUID();

  return d.runInTransaction<DeedTransferResult>(async (tx) => {
    // 1) CLAIM — FOR UPDATE SKIP LOCKED + the pending predicates.
    const settlement = await tx.claimSettlement(settlementId, claimId);
    if (!settlement) {
      // Classify: transferred replay / terminal / missing / concurrently locked.
      const plain = await tx.readSettlement(settlementId);
      if (!plain) return { ok: false, code: 'settlement_not_found' };
      if (plain.deedTransferredAt) {
        const doneListing = await tx.getListing(plain.listingId);
        return {
          ok: true,
          settlementId,
          parcelId: doneListing?.itemRef ?? '',
          buyerAvatarId: plain.buyerAvatarId,
          structuresTransferred: 0,
          replay: true,
        };
      }
      if (plain.deedTransferFailureReason) {
        // TERMINAL — never retried by the executor; operator resolves.
        return {
          ok: false,
          code: 'deed_transfer_conflict',
          detail: plain.deedTransferFailureReason,
        };
      }
      return { ok: false, code: 'not_claimable' };
    }

    // 2) The listing (kind + parcel ref). A settlement only exists for a
    //    settled listing; re-verify anyway (defense-in-depth, cheap).
    const listing = await tx.getListing(settlement.listingId);
    if (!listing) return { ok: false, code: 'listing_not_found' };
    if (listing.itemKind !== 'land_deed') {
      // Non-deed kinds (future earned_bundle) have no deed to transfer — this
      // executor must never touch them (the scan filters; this is the guard).
      return { ok: false, code: 'not_land_deed', detail: listing.itemKind };
    }
    if (listing.status !== 'settled') {
      return { ok: false, code: 'listing_not_settled', detail: listing.status };
    }
    const parcelId = listing.itemRef;

    // 3) LAND LOCK ORDER: advisory(seller) OUTER, parcel FOR UPDATE INNER.
    await tx.acquireSellerAdvisoryLock(settlement.sellerAvatarId);
    const parcel = await tx.lockParcel(parcelId);
    if (!parcel) {
      console.error(
        `[market-deed-transfer] PARCEL MISSING — settlement=${settlementId} parcel=${parcelId}; ` +
          `terminal conflict (buyer refund = ops, checkout trail on checkout=${settlement.checkoutId})`,
      );
      await tx.markDeedConflict(settlementId, claimId, 'deed_transfer_parcel_missing');
      return { ok: false, code: 'deed_transfer_conflict', detail: 'parcel_missing' };
    }

    // 4) UNDER-LOCK RE-VERIFY — the land release/evict race. NEVER force a flip.
    if (parcel.ownerAvatarId !== settlement.sellerAvatarId) {
      console.error(
        `[market-deed-transfer] SELLER NO LONGER OWNS PARCEL — settlement=${settlementId} ` +
          `parcel=${parcelId} owner=${parcel.ownerAvatarId ?? 'NULL'} seller=${settlement.sellerAvatarId}; ` +
          `terminal conflict; deed lock stays HELD; payout will never run (deed precondition)`,
      );
      await tx.markDeedConflict(settlementId, claimId, 'deed_transfer_conflict');
      return { ok: false, code: 'deed_transfer_conflict', detail: 'seller_not_owner' };
    }

    // 5) ESCROW GUARD — a live deposit escrow must never be vaporized by the
    //    fresh-owned reset (land escrow-conservation invariant). Should be
    //    impossible (only 'owned'/'hold' tenures list) — terminal + loud.
    if (parcel.depositRemainingCt !== null && parcel.depositRemainingCt > 0) {
      console.error(
        `[market-deed-transfer] LIVE ESCROW ON DEED PARCEL — settlement=${settlementId} ` +
          `parcel=${parcelId} deposit_remaining_ct=${parcel.depositRemainingCt} tenure=${parcel.tenure}; ` +
          `refusing the flip (escrow conservation); terminal conflict`,
      );
      await tx.markDeedConflict(settlementId, claimId, 'deed_transfer_escrow_present');
      return { ok: false, code: 'deed_transfer_conflict', detail: 'escrow_present' };
    }

    // 6) THE FLIP (tripwire WHERE owner=seller — cannot miss under the lock).
    const flipped = await tx.flipParcelToBuyer(
      parcelId,
      settlement.sellerAvatarId,
      settlement.buyerAvatarId,
    );
    if (!flipped) {
      // Unreachable under the lock (we just verified the owner) — defensive.
      await tx.markDeedConflict(settlementId, claimId, 'deed_transfer_flip_missed');
      return { ok: false, code: 'deed_transfer_conflict', detail: 'flip_missed' };
    }

    // 7) Denormalized structures → buyer (as-is; FLAG for land review).
    const structuresTransferred = await tx.transferStructuresToBuyer(
      parcelId,
      settlement.sellerAvatarId,
      settlement.buyerAvatarId,
    );

    // 8) Stamp the deed (the payout executor's precondition) — checked.
    const stamped = await tx.stampDeedTransferred(settlementId, claimId);
    if (!stamped) {
      // Our claim/predicates no longer match INSIDE our own tx — impossible
      // without a wiring bug. Throw ⇒ the WHOLE tx (flip included) rolls back;
      // nothing half-commits.
      throw new Error(
        `[market-deed-transfer] STAMP MISSED inside own tx — settlement=${settlementId}; rolling back`,
      );
    }

    // 9) Release the market deed lock — the transfer is complete.
    await tx.releaseDeedLock(parcelId, listing.id);

    return {
      ok: true,
      settlementId,
      parcelId,
      buyerAvatarId: settlement.buyerAvatarId,
      structuresTransferred,
      replay: false,
    };
  });
}

/**
 * One pass: scan pending settled deeds oldest-first and transfer each.
 * Exported for the (future, Codex-gated) worker + staging harness — index.ts
 * does NOT call this; the executor ships dark.
 */
export async function runDeedTransferTick(
  deps?: MarketDeedTransferDeps,
  limit = 10,
): Promise<Array<{ settlementId: string; result: DeedTransferResult }>> {
  requireMarketDeedTransferEnabled();
  const d = deps?.db ?? defaultDb;
  const ids = await d.listEligibleSettlements(limit);
  const out: Array<{ settlementId: string; result: DeedTransferResult }> = [];
  for (const id of ids) {
    try {
      out.push({ settlementId: id, result: await runDeedTransferForSettlement(id, deps) });
    } catch (err) {
      // A tx-level failure rolled the whole transfer back — resumable next tick.
      console.error(
        `[market-deed-transfer] transfer failed (rolled back, resumable) — settlement=${id}: ` +
          `${(err as Error).message}`,
      );
    }
  }
  return out;
}
