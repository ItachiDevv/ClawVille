/**
 * Land tenure sweeper (builder-economics 2026-06-24; Phase B 2026-07-07) — the
 * recurring CT sink across all three LIVE tenures.
 *
 * A parcel with `tenure IN ('rented','deposit','hold')` owes `rent_ct_weekly`
 * every `RENT_PERIOD_DAYS`. This periodic pass finds every parcel that is due
 * (or in an elapsed grace window) and settles it PER PARCEL under the same
 * money discipline as the land routes — per-owner advisory lock (OUTER) then
 * `SELECT … FOR UPDATE` (INNER), debit/credit composed in the same tx:
 *
 *   - `rented` (LEGACY, pre-Phase-B — behavior UNCHANGED): charge the owner one
 *     week → treasury; insufficient CT → grace; grace elapsed → evict.
 *   - `deposit` (Phase B1 starter escrow): the weekly rent is DRAWN FROM THE
 *     ESCROW REMAINDER (`deposit_remaining_ct`) → treasury — the tenant is
 *     NEVER debited here (the claim/top-up already debited the escrow in; the
 *     treasury credit is balanced by that earlier debit — see the schema's
 *     escrow-conservation invariant). Full-week draw → advance + clear grace.
 *     Partial/zero draw (remainder short) → open grace, do NOT advance. Grace
 *     elapsed → LAPSE: any remainder FORFEITS to the treasury (nothing refunds
 *     on lapse), parcel reverts to the pool, structure archives.
 *   - `hold` (Phase B2 hold-to-keep): unless grandfathered, RE-CHECK the
 *     subject's CLV against the stacked thresholds of the owner's holds WITH
 *     THE SAME `hold_subject` — 'user' holds back the linked self-custody
 *     wallet, 'agent' holds back the custodial avatar wallet; different
 *     wallets, so the sums never cross-count — CONFIRMED-below → open
 *     grace, skip upkeep. UNCONFIRMED (RPC down / wallet unlinked / subject
 *     unresolvable) → FAIL-OPEN: LOUD warn, skip the hold check, still charge
 *     upkeep — a tenant is NEVER graced/lapsed on an unconfirmed balance (the
 *     claim route is the mirror image: FAIL-CLOSED, no grant on unconfirmed).
 *     Hold OK / grandfathered → debit the owner the weekly upkeep → treasury;
 *     insufficient CT → grace; grace elapsed → LAPSE (revert + archive; no CT
 *     moves — nothing was escrowed).
 *
 * DEED-LOCK GUARD (marketplace C4 seam, 2026-07-07): every pool-revert branch
 * (rented/hold graceElapsed, deposit lapse) first consults
 * `parcelHasLiveDeedLock` (routes/land.ts) under the already-held locks — a
 * parcel whose deed is escrow-locked by a live P2P listing is PARKED (revert
 * suppressed, grace untouched, loud warn + alert post-commit) instead of
 * reverted, so a settling buyer can never be double-sold. Re-checked every pass.
 *
 * IDEMPOTENCY: the `rent_paid_through = now() + period` advance runs UNDER the
 * row lock and is re-read (as `rent_due`) at lock time, so a given due week
 * draws/charges EXACTLY ONCE — two overlapping ticks serialize on the row lock
 * and the second sees the first's committed advance (rent_due=false → skip).
 * Grace opens use `WHERE grace_until IS NULL` so an existing window is never
 * extended.
 *
 * LOCK ORDER (matches the routes — advisory OUTER, row INNER): the owner is
 * peeked UNLOCKED first to learn the advisory key, the advisory lock is taken,
 * THEN the parcel row is locked and everything re-verified; if the owner
 * changed between peek and lock, the parcel is skipped (next pass reprocesses
 * under the right key). Taking the row lock first would invert the routes'
 * order (deposit-topup/release hold advisory(owner) and then lock this same
 * parcel row) and create an AB-BA deadlock edge.
 *
 * SAFETY (mirrors agent-body-idle-sweeper):
 *   - PER-PARCEL try/catch: one bad row never aborts the rest of the pass, and
 *     the sweep never throws to its caller.
 *   - No partial tenant debit, ever. The deposit draw is bounded by
 *     `min(remainder, weekly)` (see `decideDepositSweep` — the single pure
 *     draw-math authority, unit-tested for exact conservation) and the
 *     `land_parcels_deposit_remaining_nonneg` CHECK backs it in the DB.
 *   - On a successful charge/draw we set `rent_paid_through = now() + period`
 *     (a fresh week from now) rather than `+= period`, so a multi-week outage
 *     forgives the missed weeks instead of charging arrears in a burst.
 *   - Side effects (cache bust + SSE broadcast) run AFTER each parcel's tx
 *     commits, so a notification failure can never affect a settled charge.
 *   - The hold-branch CLV read is an RPC INSIDE the per-parcel tx (it holds the
 *     owner advisory + row lock for its duration). Accepted trade-off: hourly
 *     cadence, tiny hold set, 5-min balance cache, fail-soft (never throws);
 *     the alternative (pre-fetch outside the tx) reintroduces a subject/wallet
 *     TOCTOU for no consistency gain on an external chain value.
 */

import { sql } from 'drizzle-orm';
import { db } from '@clawville/database';
import { RENT_PERIOD_DAYS, RENT_GRACE_DAYS, type LandTier } from '@clawville/shared';
import { creditClawTokens, debitClawTokens, InsufficientTokensError } from './claw-token-ledger';
import { getHouseTreasuryAvatarId } from './house-treasury-seeder';
import {
  getLinkedWalletClvBalance,
  getWalletClvBalance,
} from './linked-wallet-clv-balance';
import { broadcastLandEvent } from '../routes/world';
import { bustOwnedCache, bustParcelsAvailableCache, parcelHasLiveDeedLock } from '../routes/land';
import { alertError } from './alert-error';

const DEFAULT_SWEEP_PERIOD_MS = 60 * 60 * 1000; // 1 hour
const MIN_SWEEP_PERIOD_MS = 5 * 60 * 1000; // 5 min floor (mis-set guard)
/** Bound a pathological pass; the swept set is tiny in practice. Logged if hit. */
const MAX_CANDIDATES_PER_PASS = 2000;

/** The tenures this sweeper settles. Everything else is never a candidate. */
const SWEEPABLE_TENURES = ['rented', 'deposit', 'hold'] as const;
type SweepableTenure = (typeof SWEEPABLE_TENURES)[number];

/** Resolve the sweep cadence from env, floored so a tiny value can't thrash. */
export function resolveRentSweepPeriodMs(): number {
  const raw = process.env.LAND_RENT_SWEEP_PERIOD_MS;
  if (!raw) return DEFAULT_SWEEP_PERIOD_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MIN_SWEEP_PERIOD_MS) return DEFAULT_SWEEP_PERIOD_MS;
  return n;
}

/** PG wire booleans arrive as `true`/`'t'`/`'true'` depending on driver path. */
function isTrue(v: unknown): boolean {
  return v === true || v === 't' || v === 'true';
}

type SweepAction =
  | { kind: 'charged'; parcelCode: string; ownerAvatarId: string }
  | { kind: 'graced' }
  | { kind: 'evicted'; parcelCode: string; tier: LandTier; ownerAvatarId: string }
  | { kind: 'parked'; parcelCode: string; ownerAvatarId: string; tier: LandTier }
  | { kind: 'skip' };

// ─────────────────────────────────────────────────────────────────────────────
// Pure deposit draw math (Phase B1) — THE single authority for what a sweep
// step does to an escrow remainder. Exported for the conservation unit tests:
// over any decision sequence, Σ draws + forfeit (+ a route-side refund of the
// final remainder) equals EXACTLY the escrowed-in total. No decision can ever
// draw more than the remainder or more than one week.
// ─────────────────────────────────────────────────────────────────────────────

export type DepositSweepDecision =
  | { kind: 'lapse'; forfeitCt: number }
  | { kind: 'draw'; drawnCt: number; fullWeek: boolean }
  | { kind: 'grace' }
  | { kind: 'skip' };

export function decideDepositSweep(input: {
  graceElapsed: boolean;
  rentDue: boolean;
  depositRemainingCt: number;
  rentCtWeekly: number;
}): DepositSweepDecision {
  // Lapse takes priority — an elapsed grace forfeits whatever is left (which is
  // < one week by construction: grace only opens when the remainder can't cover
  // a full week, and a full top-up clears it).
  if (input.graceElapsed) {
    return { kind: 'lapse', forfeitCt: Math.max(0, Math.floor(input.depositRemainingCt)) };
  }
  if (!input.rentDue) return { kind: 'skip' };
  // A deposit parcel with no positive weekly rent is a data anomaly — never
  // draw or grace on it (caller warns); mis-billing is worse than skipping.
  if (!Number.isInteger(input.rentCtWeekly) || input.rentCtWeekly <= 0) {
    return { kind: 'skip' };
  }
  const drawnCt = Math.min(Math.max(0, Math.floor(input.depositRemainingCt)), input.rentCtWeekly);
  if (drawnCt <= 0) return { kind: 'grace' };
  return { kind: 'draw', drawnCt, fullWeek: drawnCt === input.rentCtWeekly };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared row shape + helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The FOR-UPDATE re-read every branch decides on (PG wire types — coerce!).
 * A type ALIAS (not an interface) so it satisfies tx.execute's
 * `Record<string, unknown>` constraint via the implicit index signature.
 */
type LockedParcelRow = {
  id: string;
  parcel_code: string;
  tier: LandTier;
  owner_avatar_id: string;
  rent_ct_weekly: number | string | null;
  tenure: SweepableTenure;
  deposit_remaining_ct: number | string | null;
  hold_subject: 'user' | 'agent' | null;
  grandfathered: unknown;
  rent_due: unknown;
  grace_elapsed: unknown;
};

type LandTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Return a parcel to the pool: clear owner + EVERY tenure field (rent, deposit
 * escrow, hold) and archive its active structure (soft — restored on a
 * same-avatar re-acquire, purged on a re-lease to someone else). Mirrors the
 * /release route's revert. Must run with the parcel row already locked.
 */
async function revertParcelToPool(tx: LandTx, parcelId: string): Promise<void> {
  await tx.execute(
    sql`UPDATE land_parcels
        SET status = 'available',
            owner_avatar_id = NULL,
            tenure = NULL,
            acquired_at = NULL,
            rent_paid_through = NULL,
            grace_until = NULL,
            deposit_ct = NULL,
            deposit_remaining_ct = NULL,
            hold_threshold_ct = NULL,
            hold_subject = NULL,
            grandfathered = false,
            updated_at = now()
        WHERE id = ${parcelId}`,
  );
  await tx.execute(
    sql`UPDATE land_structures
        SET status = 'archived', updated_at = now()
        WHERE parcel_id = ${parcelId} AND status = 'active'`,
  );
}

/** Open a grace window ONLY if one is not already open (never extend). */
async function openGraceIfAbsent(tx: LandTx, parcelId: string): Promise<void> {
  await tx.execute(
    sql`UPDATE land_parcels
        SET grace_until = now() + make_interval(days => ${RENT_GRACE_DAYS}),
            updated_at = now()
        WHERE id = ${parcelId} AND grace_until IS NULL`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch: rented (LEGACY — money semantics unchanged from 2026-06-24)
// ─────────────────────────────────────────────────────────────────────────────

async function sweepRented(tx: LandTx, p: LockedParcelRow): Promise<SweepAction> {
  const ownerAvatarId = p.owner_avatar_id;
  const graceElapsed = isTrue(p.grace_elapsed);
  const rentDue = isTrue(p.rent_due);

  // (A) EVICTION takes priority — grace window has elapsed.
  if (graceElapsed) {
    if (await parcelHasLiveDeedLock(tx, p.id)) {
      // Deed-locked by a live marketplace listing — suppress the pool-revert so
      // the parcel can't be double-sold out from under a settling buyer. Grace
      // state is left untouched; the next pass re-checks and normal eviction
      // resumes once the listing cancels/transfers and the lock clears. LOUD
      // log + alert happen post-commit (out of the money tx).
      return { kind: 'parked', parcelCode: p.parcel_code, ownerAvatarId, tier: p.tier };
    }
    await revertParcelToPool(tx, p.id);
    const meta = JSON.stringify({ reason: 'rent_lapsed', tier: p.tier, parcelCode: p.parcel_code });
    await tx.execute(
      sql`INSERT INTO land_transactions (kind, parcel_id, avatar_id, amount_ct, metadata)
          VALUES ('eviction', ${p.id}, ${ownerAvatarId}, 0, ${meta}::jsonb)`,
    );
    return { kind: 'evicted', parcelCode: p.parcel_code, tier: p.tier, ownerAvatarId };
  }

  // (B) Not in elapsed grace, and not due → nothing to do (defensive; the
  // candidate query already filtered, but the lock-time re-read is authoritative).
  if (!rentDue) {
    return { kind: 'skip' };
  }

  // (C) Rent is due — attempt the weekly charge.
  const rentCt = p.rent_ct_weekly == null ? null : Number(p.rent_ct_weekly);
  if (rentCt == null || rentCt <= 0) {
    // A rented parcel with no rent price is a data anomaly — don't charge, don't
    // evict; skip and let it surface in monitoring rather than mis-bill.
    console.warn(`[LandRentSweeper] rented parcel ${p.parcel_code} has NULL/<=0 rent_ct_weekly — skipping`);
    return { kind: 'skip' };
  }

  try {
    const debit = await debitClawTokens(
      {
        avatarId: ownerAvatarId,
        amount: rentCt,
        reason: 'land_parcel_rent',
        source: 'system',
        metadata: { parcelId: p.id, parcelCode: p.parcel_code, tier: p.tier, period: 'weekly' },
        actorKind: 'system',
      },
      tx,
    );
    // T0 fee routing (2026-07-07): the weekly rent → house treasury, IN THIS
    // SAME per-parcel tx as the tenant's debit (net-neutral supply — there is
    // NO player-landlord; the rent previously burned to nobody). Tenant-side
    // amount UNCHANGED; the lock-time re-read above (rent_due under FOR
    // UPDATE) already makes the charge exactly-once per due week, and this
    // credit rides that same guarantee. A null treasury (unavailable)
    // degrades to the pre-T0 burn — never blocks the charge.
    if (Number.isInteger(rentCt) && rentCt > 0) {
      const treasuryId = await getHouseTreasuryAvatarId();
      if (treasuryId) {
        await creditClawTokens(
          {
            avatarId: treasuryId,
            amount: rentCt,
            reason: 'house_fee_land_rent',
            source: 'system',
            metadata: {
              parcelId: p.id,
              parcelCode: p.parcel_code,
              tier: p.tier,
              period: 'weekly',
              renterAvatarId: ownerAvatarId,
            },
            actorKind: 'system',
          },
          tx,
        );
      } else {
        console.error(
          `[LandRentSweeper] house treasury unavailable — ${rentCt} CT weekly rent burned (pre-T0 behavior) for parcel ${p.parcel_code}`,
        );
      }
    }
    // Charged — advance a fresh week from now (forgives outage arrears), clear grace.
    await tx.execute(
      sql`UPDATE land_parcels
          SET rent_paid_through = now() + make_interval(days => ${RENT_PERIOD_DAYS}),
              grace_until = NULL,
              updated_at = now()
          WHERE id = ${p.id}`,
    );
    const meta = JSON.stringify({ tier: p.tier, parcelCode: p.parcel_code, period: 'weekly', rentCtWeekly: rentCt });
    await tx.execute(
      sql`INSERT INTO land_transactions
            (kind, parcel_id, avatar_id, amount_ct, debit_ledger_tx_id, metadata)
          VALUES ('rent_payment', ${p.id}, ${ownerAvatarId}, ${rentCt}, ${debit.ledgerId}, ${meta}::jsonb)`,
    );
    return { kind: 'charged', parcelCode: p.parcel_code, ownerAvatarId };
  } catch (err) {
    if (err instanceof InsufficientTokensError) {
      // The debit threw BEFORE any write (balance check precedes the UPDATE), so
      // the tx is healthy. Open a grace window if one is not already open. Charge
      // NOTHING — no partial debit.
      await openGraceIfAbsent(tx, p.id);
      return { kind: 'graced' };
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch: deposit (Phase B1 starter escrow)
// ─────────────────────────────────────────────────────────────────────────────

async function sweepDeposit(tx: LandTx, p: LockedParcelRow): Promise<SweepAction> {
  const ownerAvatarId = p.owner_avatar_id;
  const remaining = p.deposit_remaining_ct == null ? 0 : Number(p.deposit_remaining_ct);
  const rentCt = p.rent_ct_weekly == null ? 0 : Number(p.rent_ct_weekly);

  const decision = decideDepositSweep({
    graceElapsed: isTrue(p.grace_elapsed),
    rentDue: isTrue(p.rent_due),
    depositRemainingCt: remaining,
    rentCtWeekly: rentCt,
  });

  switch (decision.kind) {
    case 'skip': {
      if (isTrue(p.rent_due) && rentCt <= 0) {
        console.warn(
          `[LandRentSweeper] deposit parcel ${p.parcel_code} has NULL/<=0 rent_ct_weekly — skipping (anomaly)`,
        );
      }
      return { kind: 'skip' };
    }

    case 'lapse': {
      if (await parcelHasLiveDeedLock(tx, p.id)) {
        // Deed-locked by a live marketplace listing — suppress the pool-revert so
        // the parcel can't be double-sold out from under a settling buyer. Grace
        // state is left untouched (escrow remainder does NOT forfeit while
        // parked); the next pass re-checks and normal eviction resumes once the
        // listing cancels/transfers and the lock clears. LOUD log + alert happen
        // post-commit (out of the money tx).
        return { kind: 'parked', parcelCode: p.parcel_code, ownerAvatarId, tier: p.tier };
      }
      // Grace elapsed → the tenancy ends and any escrow remainder FORFEITS to
      // the treasury. NO tenant debit — the escrow already left the tenant at
      // claim/top-up time; this credit is balanced by those earlier debits
      // (conservation: draws + forfeit close the escrow at exactly what was
      // paid in). A null treasury degrades to a burn (pre-T0 behavior) — the
      // eviction itself is never blocked.
      let creditLedgerId: string | null = null;
      if (decision.forfeitCt > 0) {
        const treasuryId = await getHouseTreasuryAvatarId();
        if (treasuryId) {
          const credit = await creditClawTokens(
            {
              avatarId: treasuryId,
              amount: decision.forfeitCt,
              reason: 'house_fee_land_rent',
              source: 'system',
              metadata: {
                parcelId: p.id,
                parcelCode: p.parcel_code,
                tier: p.tier,
                tenure: 'deposit',
                reason: 'forfeit_on_lapse',
                tenantAvatarId: ownerAvatarId,
              },
              actorKind: 'system',
            },
            tx,
          );
          creditLedgerId = credit.ledgerId;
        } else {
          console.error(
            `[LandRentSweeper] house treasury unavailable — ${decision.forfeitCt} CT deposit forfeit burned (pre-T0 behavior) for parcel ${p.parcel_code}`,
          );
        }
      }
      await revertParcelToPool(tx, p.id);
      const meta = JSON.stringify({
        reason: 'deposit_exhausted',
        tenure: 'deposit',
        forfeitedCt: decision.forfeitCt,
        tier: p.tier,
        parcelCode: p.parcel_code,
      });
      await tx.execute(
        sql`INSERT INTO land_transactions (kind, parcel_id, avatar_id, amount_ct, credit_ledger_tx_id, metadata)
            VALUES ('eviction', ${p.id}, ${ownerAvatarId}, ${decision.forfeitCt}, ${creditLedgerId}, ${meta}::jsonb)`,
      );
      return { kind: 'evicted', parcelCode: p.parcel_code, tier: p.tier, ownerAvatarId };
    }

    case 'grace': {
      // Remainder can't cover anything — pause the tenancy (never extend an
      // existing window). Nothing draws.
      await openGraceIfAbsent(tx, p.id);
      return { kind: 'graced' };
    }

    case 'draw': {
      // Move `drawnCt` escrow → treasury. NO tenant debit on this branch (the
      // escrow was debited at claim/top-up — see the conservation invariant).
      let creditLedgerId: string | null = null;
      const treasuryId = await getHouseTreasuryAvatarId();
      if (treasuryId) {
        const credit = await creditClawTokens(
          {
            avatarId: treasuryId,
            amount: decision.drawnCt,
            reason: 'house_fee_land_rent',
            source: 'system',
            metadata: {
              parcelId: p.id,
              parcelCode: p.parcel_code,
              tier: p.tier,
              tenure: 'deposit',
              period: 'weekly',
              drawnFromEscrow: true,
              tenantAvatarId: ownerAvatarId,
            },
            actorKind: 'system',
          },
          tx,
        );
        creditLedgerId = credit.ledgerId;
      } else {
        console.error(
          `[LandRentSweeper] house treasury unavailable — ${decision.drawnCt} CT escrow draw burned (pre-T0 behavior) for parcel ${p.parcel_code}`,
        );
      }

      if (decision.fullWeek) {
        // Full week covered — decrement the remainder, advance, clear grace.
        await tx.execute(
          sql`UPDATE land_parcels
              SET deposit_remaining_ct = deposit_remaining_ct - ${decision.drawnCt},
                  rent_paid_through = now() + make_interval(days => ${RENT_PERIOD_DAYS}),
                  grace_until = NULL,
                  updated_at = now()
              WHERE id = ${p.id}`,
        );
      } else {
        // PARTIAL draw (remainder < one week): the escrow drains to zero and
        // the grace clock starts, but the week is NOT advanced — a top-up that
        // re-covers a full week clears the grace and the next sweep draws the
        // (still-due) full week. Spec'd Phase-B behavior: the draw order
        // favors the house; the partial never buys a week.
        await tx.execute(
          sql`UPDATE land_parcels
              SET deposit_remaining_ct = deposit_remaining_ct - ${decision.drawnCt},
                  grace_until = COALESCE(grace_until, now() + make_interval(days => ${RENT_GRACE_DAYS})),
                  updated_at = now()
              WHERE id = ${p.id}`,
        );
      }

      const meta = JSON.stringify({
        tenure: 'deposit',
        tier: p.tier,
        parcelCode: p.parcel_code,
        period: 'weekly',
        drawnCt: decision.drawnCt,
        fullWeek: decision.fullWeek,
        remainingAfter: remaining - decision.drawnCt,
      });
      await tx.execute(
        sql`INSERT INTO land_transactions
              (kind, parcel_id, avatar_id, amount_ct, credit_ledger_tx_id, metadata)
            VALUES ('rent_payment', ${p.id}, ${ownerAvatarId}, ${decision.drawnCt}, ${creditLedgerId}, ${meta}::jsonb)`,
      );
      return decision.fullWeek
        ? { kind: 'charged', parcelCode: p.parcel_code, ownerAvatarId }
        : { kind: 'graced' };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch: hold (Phase B2 hold-to-keep)
// ─────────────────────────────────────────────────────────────────────────────

type HoldClvResolution =
  | { status: 'confirmed'; uiAmount: number }
  | { status: 'unconfirmed'; why: string };

/**
 * Resolve the LIVE CLV balance backing a hold parcel by its stamped
 * hold_subject. Every unresolvable/unavailable path returns 'unconfirmed' —
 * the caller FAILS-OPEN on it (warn + charge upkeep; never grace/lapse).
 */
async function resolveHoldClv(tx: LandTx, p: LockedParcelRow): Promise<HoldClvResolution> {
  if (p.hold_subject === 'agent') {
    const rows = await tx.execute<{ wallet_address: string | null }>(
      sql`SELECT wallet_address FROM avatars WHERE id = ${p.owner_avatar_id}`,
    );
    const pubkey = rows[0]?.wallet_address ?? null;
    if (!pubkey) return { status: 'unconfirmed', why: 'agent avatar has no custodial wallet_address' };
    const clv = await getWalletClvBalance(pubkey);
    if (clv.available !== true || clv.uiAmount == null) {
      return { status: 'unconfirmed', why: 'CLV read unavailable (agent custodial wallet)' };
    }
    return { status: 'confirmed', uiAmount: clv.uiAmount };
  }
  if (p.hold_subject === 'user') {
    const rows = await tx.execute<{ user_id: string | null }>(
      sql`SELECT user_id FROM avatars WHERE id = ${p.owner_avatar_id}`,
    );
    const userId = rows[0]?.user_id ?? null;
    if (!userId) return { status: 'unconfirmed', why: 'owner avatar row missing/userless' };
    const res = await getLinkedWalletClvBalance(userId);
    if (!res.linked) {
      // KNOWN LIMITATION (report): a human who UNLINKS/relinks after claiming
      // leaves the hold unverifiable — fail-open per spec, never lapse on it.
      return { status: 'unconfirmed', why: 'user has no linked wallet (unlinked after claim?)' };
    }
    if (res.clv.available !== true || res.clv.uiAmount == null) {
      return { status: 'unconfirmed', why: 'CLV read unavailable (linked wallet)' };
    }
    return { status: 'confirmed', uiAmount: res.clv.uiAmount };
  }
  return { status: 'unconfirmed', why: 'hold_subject NULL on a non-grandfathered hold (anomaly)' };
}

async function sweepHold(tx: LandTx, p: LockedParcelRow): Promise<SweepAction> {
  const ownerAvatarId = p.owner_avatar_id;
  const graceElapsed = isTrue(p.grace_elapsed);
  const rentDue = isTrue(p.rent_due);

  // (A) LAPSE takes priority — grace elapsed. No CT moves (nothing escrowed;
  // the missed upkeep was simply never collected).
  if (graceElapsed) {
    if (await parcelHasLiveDeedLock(tx, p.id)) {
      // Deed-locked by a live marketplace listing — suppress the pool-revert so
      // the parcel can't be double-sold out from under a settling buyer. Grace
      // state is left untouched; the next pass re-checks and normal eviction
      // resumes once the listing cancels/transfers and the lock clears. LOUD
      // log + alert happen post-commit (out of the money tx).
      return { kind: 'parked', parcelCode: p.parcel_code, ownerAvatarId, tier: p.tier };
    }
    await revertParcelToPool(tx, p.id);
    const meta = JSON.stringify({
      reason: 'hold_lapsed',
      tenure: 'hold',
      tier: p.tier,
      parcelCode: p.parcel_code,
    });
    await tx.execute(
      sql`INSERT INTO land_transactions (kind, parcel_id, avatar_id, amount_ct, metadata)
          VALUES ('eviction', ${p.id}, ${ownerAvatarId}, 0, ${meta}::jsonb)`,
    );
    return { kind: 'evicted', parcelCode: p.parcel_code, tier: p.tier, ownerAvatarId };
  }

  if (!rentDue) return { kind: 'skip' };

  const rentCt = p.rent_ct_weekly == null ? null : Number(p.rent_ct_weekly);
  if (rentCt == null || rentCt <= 0) {
    console.warn(`[LandRentSweeper] hold parcel ${p.parcel_code} has NULL/<=0 rent_ct_weekly — skipping (anomaly)`);
    return { kind: 'skip' };
  }

  // (B) CLV hold re-check — skipped entirely for grandfathered legacy holds.
  if (!isTrue(p.grandfathered)) {
    const clv = await resolveHoldClv(tx, p);
    if (clv.status === 'unconfirmed') {
      // FAIL-OPEN: never grace/lapse on an unconfirmed balance. LOUD by design.
      console.warn(
        `[LandRentSweeper] HOLD CHECK SKIPPED (fail-open) for ${p.parcel_code} owner=${ownerAvatarId}: ${clv.why} — charging upkeep, hold re-checks next sweep`,
      );
    } else {
      // Stacked requirement — scoped PER hold_subject (fixed 2026-07-09): only
      // the owner's holds stamped with THIS parcel's hold_subject count,
      // because resolveHoldClv reads the wallet THAT subject backs ('user' →
      // users.linked_wallet_pubkey, 'agent' → avatars.wallet_address — two
      // DIFFERENT wallets). One avatar can legitimately carry BOTH a 'user'
      // hold (claimed via a human session) AND an 'agent' hold (claimed via an
      // agent session on the same bound avatar); a subject-blind sum compared
      // BOTH subjects' thresholds against ONE subject's wallet and wrongly
      // graced/lapsed fully-funded holds. (p.hold_subject is non-NULL on this
      // path — the NULL-subject anomaly returns 'unconfirmed' above and never
      // reaches this sum; grandfathered rows carry NULL hold_subject and stay
      // excluded, as before, by the grandfathered predicate.)
      // Within the subject: the owner's OTHER non-grandfathered holds that are
      // NOT already in grace, PLUS THIS parcel regardless of its own grace
      // state. Self-inclusion is load-bearing: without it a single-parcel
      // holder in grace would compare against 0 and trivially "recover".
      // Excluding OTHER graced parcels makes a multi-parcel holder lose the
      // MINIMUM set in sweep order (already-graced ones stop counting against
      // the survivors).
      const sumRows = await tx.execute<{ s: number | string }>(
        sql`SELECT COALESCE(SUM(hold_threshold_ct), 0)::int AS s
            FROM land_parcels
            WHERE owner_avatar_id = ${ownerAvatarId}
              AND tenure = 'hold'
              AND hold_subject = ${p.hold_subject}
              AND grandfathered = false
              AND (grace_until IS NULL OR id = ${p.id})`,
      );
      const requiredClv = Number(sumRows[0]?.s ?? 0);
      if (clv.uiAmount < requiredClv) {
        // CONFIRMED below the stacked hold → pause (grace), skip the upkeep
        // charge. Lapse only if still failing when the grace elapses.
        await openGraceIfAbsent(tx, p.id);
        return { kind: 'graced' };
      }
    }
  }

  // (C) Hold OK / grandfathered / unconfirmed → charge the weekly upkeep:
  // debit the OWNER (this is real avatar CT, unlike the deposit branch) and
  // credit the treasury in the same tx.
  try {
    const debit = await debitClawTokens(
      {
        avatarId: ownerAvatarId,
        amount: rentCt,
        reason: 'land_parcel_rent',
        source: 'system',
        metadata: { parcelId: p.id, parcelCode: p.parcel_code, tier: p.tier, tenure: 'hold', period: 'weekly' },
        actorKind: 'system',
      },
      tx,
    );
    let creditLedgerId: string | null = null;
    const treasuryId = await getHouseTreasuryAvatarId();
    if (treasuryId) {
      const credit = await creditClawTokens(
        {
          avatarId: treasuryId,
          amount: rentCt,
          reason: 'house_fee_land_rent',
          source: 'system',
          metadata: {
            parcelId: p.id,
            parcelCode: p.parcel_code,
            tier: p.tier,
            tenure: 'hold',
            period: 'weekly',
            holderAvatarId: ownerAvatarId,
          },
          actorKind: 'system',
        },
        tx,
      );
      creditLedgerId = credit.ledgerId;
    } else {
      console.error(
        `[LandRentSweeper] house treasury unavailable — ${rentCt} CT hold upkeep burned (pre-T0 behavior) for parcel ${p.parcel_code}`,
      );
    }
    await tx.execute(
      sql`UPDATE land_parcels
          SET rent_paid_through = now() + make_interval(days => ${RENT_PERIOD_DAYS}),
              grace_until = NULL,
              updated_at = now()
          WHERE id = ${p.id}`,
    );
    const meta = JSON.stringify({
      tenure: 'hold',
      tier: p.tier,
      parcelCode: p.parcel_code,
      period: 'weekly',
      rentCtWeekly: rentCt,
      grandfathered: isTrue(p.grandfathered),
    });
    await tx.execute(
      sql`INSERT INTO land_transactions
            (kind, parcel_id, avatar_id, amount_ct, debit_ledger_tx_id, credit_ledger_tx_id, metadata)
          VALUES ('rent_payment', ${p.id}, ${ownerAvatarId}, ${rentCt}, ${debit.ledgerId}, ${creditLedgerId}, ${meta}::jsonb)`,
    );
    return { kind: 'charged', parcelCode: p.parcel_code, ownerAvatarId };
  } catch (err) {
    if (err instanceof InsufficientTokensError) {
      // No partial debit — open grace (never extend) and try again next sweep.
      await openGraceIfAbsent(tx, p.id);
      return { kind: 'graced' };
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-parcel settle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process ONE due parcel atomically. Returns the action taken (the caller runs
 * the post-commit side effects). Throws only on an unexpected (non-insufficient)
 * error, which the caller isolates per-parcel.
 *
 * Exported for the DB-gated tests (they must settle ONLY their fixture parcels,
 * never sweep the whole shared DB) and for targeted ops.
 */
export async function processDueParcel(parcelId: string): Promise<SweepAction> {
  return db.transaction(async (tx): Promise<SweepAction> => {
    // (0a) UNLOCKED peek — learn the owner for the advisory key without holding
    // any lock (see the LOCK ORDER note in the header).
    const peekRows = await tx.execute<{ owner_avatar_id: string | null; tenure: string | null }>(
      sql`SELECT owner_avatar_id, tenure FROM land_parcels WHERE id = ${parcelId}`,
    );
    const peek = peekRows[0];
    if (
      !peek ||
      !peek.owner_avatar_id ||
      !SWEEPABLE_TENURES.includes(peek.tenure as SweepableTenure)
    ) {
      return { kind: 'skip' };
    }

    // (0b) Per-owner advisory lock (OUTER — matches the land routes' order).
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${peek.owner_avatar_id}, 0))`,
    );

    // (0c) Parcel row lock (INNER) + authoritative re-read against the DB clock.
    const rows = await tx.execute<LockedParcelRow>(
      sql`SELECT id, parcel_code, tier, owner_avatar_id, rent_ct_weekly, tenure,
                 deposit_remaining_ct, hold_subject, grandfathered,
                 (rent_paid_through IS NOT NULL AND rent_paid_through <= now()) AS rent_due,
                 (grace_until IS NOT NULL AND grace_until <= now()) AS grace_elapsed
          FROM land_parcels
          WHERE id = ${parcelId}
          FOR UPDATE`,
    );
    const p = rows[0];
    // (0d) Re-verify under the lock. If the owner changed between peek and lock
    // (acquire/release race) our advisory key is stale — skip; the next pass
    // reprocesses under the right key. Tenure can also have changed.
    if (
      !p ||
      !p.owner_avatar_id ||
      p.owner_avatar_id !== peek.owner_avatar_id ||
      !SWEEPABLE_TENURES.includes(p.tenure)
    ) {
      return { kind: 'skip' };
    }

    switch (p.tenure) {
      case 'rented':
        return sweepRented(tx, p);
      case 'deposit':
        return sweepDeposit(tx, p);
      case 'hold':
        return sweepHold(tx, p);
    }
  });
}

/**
 * One sweep pass. Reads the due-candidate set (cheap, partial-indexed), then
 * processes each parcel in its OWN transaction. Returns the action counts.
 */
export async function sweepDueRents(): Promise<{
  charged: number;
  graced: number;
  evicted: number;
  parked: number;
}> {
  let candidates: Array<{ id: string }>;
  try {
    const rows = await db.execute<{ id: string }>(
      sql`SELECT id FROM land_parcels
          WHERE tenure IN ('rented', 'deposit', 'hold')
            AND (
              (rent_paid_through IS NOT NULL AND rent_paid_through <= now())
              OR (grace_until IS NOT NULL AND grace_until <= now())
            )
          ORDER BY rent_paid_through ASC NULLS FIRST
          LIMIT ${MAX_CANDIDATES_PER_PASS}`,
    );
    candidates = Array.from(rows as Iterable<{ id: string }>);
  } catch (err) {
    console.warn('[LandRentSweeper] candidate read failed (non-fatal):', err);
    return { charged: 0, graced: 0, evicted: 0, parked: 0 };
  }

  if (candidates.length === 0) return { charged: 0, graced: 0, evicted: 0, parked: 0 };
  if (candidates.length >= MAX_CANDIDATES_PER_PASS) {
    console.warn(
      `[LandRentSweeper] candidate cap hit (${MAX_CANDIDATES_PER_PASS}) — remaining due parcels roll to the next pass`,
    );
  }

  let charged = 0;
  let graced = 0;
  let evicted = 0;
  let parked = 0;

  for (const { id } of candidates) {
    let action: SweepAction;
    try {
      action = await processDueParcel(id);
    } catch (err) {
      console.warn(`[LandRentSweeper] parcel ${id} failed (non-fatal):`, err);
      continue;
    }

    // Post-commit side effects — never inside the money tx.
    try {
      if (action.kind === 'charged') {
        charged++;
        bustOwnedCache(action.ownerAvatarId);
      } else if (action.kind === 'graced') {
        graced++;
      } else if (action.kind === 'evicted') {
        evicted++;
        bustOwnedCache(action.ownerAvatarId);
        bustParcelsAvailableCache(action.tier);
        // Live: the parcel is back in the pool — its for-sale sign reappears for
        // every connected player. Fire-and-forget (already fully guarded).
        broadcastLandEvent({
          parcelCode: action.parcelCode,
          status: 'available',
          ownerAvatarId: null,
        });
      } else if (action.kind === 'parked') {
        parked++;
        console.warn(
          `[LandRentSweeper] EVICTION SUPPRESSED (deed-locked) parcel=${action.parcelCode} owner=${action.ownerAvatarId} tier=${action.tier} — a live marketplace listing holds the deed; parked (revert skipped), re-checks next pass`,
        );
        void alertError({
          severity: 'warning',
          source: 'land-rent-sweeper',
          message: `parcel ${action.parcelCode} due for eviction but deed-locked by a live marketplace listing — pool-revert suppressed`,
          context: { parcelCode: action.parcelCode, ownerAvatarId: action.ownerAvatarId, tier: action.tier },
        });
      }
    } catch (err) {
      console.warn('[LandRentSweeper] post-commit side effect failed (non-fatal):', err);
    }
  }

  if (charged + graced + evicted + parked > 0) {
    console.log(
      `[LandRentSweeper] pass complete — charged=${charged} graced=${graced} evicted=${evicted} parked=${parked}`,
    );
  }
  return { charged, graced, evicted, parked };
}

let sweepInterval: ReturnType<typeof setInterval> | null = null;

/** Wire up the periodic tenure sweep. Called once from index.ts at boot. */
export function startLandRentSweeper(): void {
  if (sweepInterval) return;
  const periodMs = resolveRentSweepPeriodMs();
  sweepInterval = setInterval(() => {
    sweepDueRents().catch((err) => {
      console.error('[LandRentSweeper] sweep failed:', err);
    });
  }, periodMs);
  console.log(`[LandRentSweeper] Started — sweeping due rents every ${Math.round(periodMs / 60000)}min`);
}

export function stopLandRentSweeper(): void {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
