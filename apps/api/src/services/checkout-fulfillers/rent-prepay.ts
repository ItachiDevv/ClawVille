/**
 * LAND RENT/DEPOSIT PREPAY FULFILLER (Tokenomics C — checkout stage, 2026-07-07).
 *
 * Lets a deposit-tenure parcel OWNER (human or connected/hosted agent) fund
 * their escrow remainder (`land_parcels.deposit_remaining_ct`) with REAL USDC
 * through the generic x402 checkout — the USDC analog of
 * `POST /api/land/parcels/:id/deposit-topup`. Registers itself on import.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠ LAND-DOMAIN + CODEX-REVIEW-GATED — ESCROW-CONSERVATION INVARIANT EXTENSION
 * ═══════════════════════════════════════════════════════════════════════════
 * Land's escrow invariant (documented on `land_parcels.depositRemainingCt` in
 * `packages/database/src/schema/land.ts`) originally read: every CT in the
 * escrow remainder was DEBITED from the claimant's avatar balance. This
 * fulfiller EXTENDS it to:
 *
 *     escrow CT traces to an avatar debit OR a recorded USDC settlement.
 *
 * Concretely: `deposit_remaining_ct += priceVclaw` with NO avatar debit; the
 * backing is the settled x402 USDC payment — the same-tx `x402_checkouts`
 * row (status='settled', tx_signature claimed under the partial-UNIQUE
 * index) plus a NEW distinct `land_transactions.kind='land_deposit_prepay_usdc'`
 * audit row stamped with `usdBasis` in its metadata and NO
 * `debit_ledger_tx_id` (there is no ledger debit to point at — that absence
 * IS the marker of a USDC-backed credit). A later sweeper draw of this CT
 * into the treasury is therefore a BACKED emission (real dollars entered
 * underneath); refund/forfeit conserve exactly like a debited top-up:
 *
 *     Σ draws + refund + forfeit == claim + Σ CT top-ups + Σ USDC prepays.
 *
 * The sweeper is NOT modified: `decideDepositSweep` (land-rent-sweeper.ts,
 * the single draw-math authority) is reused strictly READ-ONLY below to
 * decide whether the topped-up remainder covers a full week again (grace
 * clear) — no draw is applied here, and the sweeper keeps sole authority
 * over draws/lapses. Any change to THIS money shape re-binds the land domain
 * owner + a Codex adversarial pass before ship.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * LOCK ORDER (matches every land mutation — deposit-topup/release/sweeper):
 * per-owner advisory lock OUTER (`pg_advisory_xact_lock(hashtextextended(
 * avatarId, 0))`), THEN the parcel row `FOR UPDATE` INNER. Inverting it would
 * create an AB-BA deadlock edge against those paths. Both locks live inside
 * the checkout settle tx, so the escrow credit + the checkout flip + the CLV
 * buy intent commit or roll back as ONE unit.
 *
 * TREASURY REVENUE: none is minted here. The dollars owed to the market are
 * recorded via `enqueueClvBuy` in the SAME tx (the C3 queue).
 */

import { sql } from 'drizzle-orm';
import { db } from '@clawville/database';
import {
  registerFulfiller,
  registerCheckoutPreflight,
  CheckoutFulfillmentRefusal,
  type CheckoutFulfiller,
  type CheckoutPreflight,
} from '../x402-checkout';
import { decideDepositSweep } from '../land-rent-sweeper';
import { enqueueClvBuy } from '../clv-swap-executor';

/** Kind-specific quote refusals the route maps to HTTP statuses. Mirrors the
 *  deposit-topup handler's guard set exactly. */
export type RentPrepayRefusal =
  | 'parcel_not_found'
  | 'not_parcel_owner'
  | 'not_deposit_tenure'
  | 'invalid_escrow_state';

export type RentPrepayCheckoutItem =
  | { ok: true; priceVclaw: number; parcelCode: string }
  | { ok: false; code: RentPrepayRefusal };

/** The columns every check/mutation here reads (PG wire types — coerce!). */
type PrepayParcelRow = {
  id: string;
  parcel_code: string;
  owner_avatar_id: string | null;
  tenure: string | null;
  deposit_remaining_ct: number | string | null;
  rent_ct_weekly: number | string | null;
  grace_until: string | Date | null;
};

function guardParcel(
  p: PrepayParcelRow | undefined,
  avatarId: string,
): { ok: true; parcel: PrepayParcelRow } | { ok: false; code: RentPrepayRefusal } {
  if (!p) return { ok: false, code: 'parcel_not_found' };
  if (p.owner_avatar_id !== avatarId) return { ok: false, code: 'not_parcel_owner' };
  if (p.tenure !== 'deposit') return { ok: false, code: 'not_deposit_tenure' };
  if (
    p.deposit_remaining_ct == null ||
    p.rent_ct_weekly == null ||
    Number(p.rent_ct_weekly) <= 0
  ) {
    return { ok: false, code: 'invalid_escrow_state' };
  }
  return { ok: true, parcel: p };
}

/**
 * QUOTE-TIME resolver. The prepay AMOUNT is caller-chosen (like the
 * deposit-topup body's `amountCt` — this is a SELF-directed escrow credit,
 * not a priced item; the route Zod-caps it 1..1_000_000). This resolver
 * validates the PARCEL guards read-only (unlocked — the fulfiller re-checks
 * authoritatively under the row lock).
 */
export async function resolveRentPrepayCheckoutItem(
  avatarId: string,
  parcelId: string,
  amountVclaw: number,
): Promise<RentPrepayCheckoutItem> {
  const rows = await db.execute<PrepayParcelRow>(
    sql`SELECT id, parcel_code, owner_avatar_id, tenure, deposit_remaining_ct, rent_ct_weekly, grace_until
        FROM land_parcels WHERE id = ${parcelId}`,
  );
  const guarded = guardParcel(rows[0], avatarId);
  if (!guarded.ok) return { ok: false, code: guarded.code };
  return { ok: true, priceVclaw: amountVclaw, parcelCode: guarded.parcel.parcel_code };
}

/** Settle-time READ-ONLY preflight — same guards, just before the facilitator
 *  call, so a parcel released/evicted since the quote refuses cleanly with the
 *  row still pending and NO money moved. */
const rentPrepayPreflight: CheckoutPreflight = async ({ subject, itemRef, priceVclaw }) => {
  const item = await resolveRentPrepayCheckoutItem(subject.avatarId, itemRef, priceVclaw);
  return item.ok ? { ok: true } : { ok: false, code: item.code };
};

const rentPrepayFulfiller: CheckoutFulfiller = async (ctx) => {
  const avatarId = ctx.subject.avatarId;
  const amountCt = ctx.priceVclaw;

  // Per-owner advisory lock OUTER, parcel row INNER — the land lock order.
  await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${avatarId}, 0))`);
  const rows = await ctx.tx.execute<PrepayParcelRow>(
    sql`SELECT id, parcel_code, owner_avatar_id, tenure, deposit_remaining_ct, rent_ct_weekly, grace_until
        FROM land_parcels
        WHERE id = ${ctx.itemRef}
        FOR UPDATE`,
  );

  // AUTHORITATIVE re-check under the lock (the preflight made this window
  // near-zero). A failure here rolls the settle tx back; the service records
  // the loud fulfillment_refused terminal state for manual refund.
  const guarded = guardParcel(rows[0], avatarId);
  if (!guarded.ok) {
    throw new CheckoutFulfillmentRefusal(guarded.code);
  }
  const p = guarded.parcel;

  const newRemaining = Number(p.deposit_remaining_ct) + amountCt;
  const rentWeekly = Number(p.rent_ct_weekly);

  // Grace-clear decision via the SINGLE draw-math authority, READ-ONLY: we ask
  // decideDepositSweep "would a due week draw in FULL at this remainder?"
  // (kind='draw' + fullWeek ⇔ newRemaining >= a positive weekly rent — the
  // exact `coversWeek` predicate the deposit-topup handler derives inline).
  // NO draw is applied; the remainder only GROWS here.
  const decision = decideDepositSweep({
    graceElapsed: false,
    rentDue: true,
    depositRemainingCt: newRemaining,
    rentCtWeekly: rentWeekly,
  });
  const coversWeek = decision.kind === 'draw' && decision.fullWeek;
  const graceCleared = coversWeek && p.grace_until != null;

  // ESCROW CREDIT — NO avatar debit (see the invariant-extension header). The
  // in-DB `deposit_remaining_ct + amount` form matches deposit-topup so the
  // nonneg CHECK + concurrent-safety shape stay identical.
  await ctx.tx.execute(
    sql`UPDATE land_parcels
        SET deposit_remaining_ct = COALESCE(deposit_remaining_ct, 0) + ${amountCt},
            grace_until = CASE WHEN ${coversWeek} THEN NULL ELSE grace_until END,
            updated_at = now()
        WHERE id = ${p.id}`,
  );

  // Land-domain audit row: the NEW distinct kind. NO debit_ledger_tx_id — the
  // backing is the settled USDC (usdBasis + txSignature + checkoutId below),
  // not a ledger debit. `refundable:true` mirrors deposit-topup: the escrow
  // remainder refunds/forfeits identically regardless of which rail funded it.
  const meta = JSON.stringify({
    newRemaining,
    graceCleared,
    refundable: true,
    usdBasis: ctx.usdBasis,
    usdCents: ctx.usdCents,
    txSignature: ctx.txSignature,
    checkoutId: ctx.checkoutId,
    subjectKind: ctx.subject.kind,
  });
  await ctx.tx.execute(
    sql`INSERT INTO land_transactions (kind, parcel_id, avatar_id, amount_ct, metadata)
        VALUES ('land_deposit_prepay_usdc', ${p.id}, ${avatarId}, ${amountCt}, ${meta}::jsonb)`,
  );

  // The owed USDC→CLV buy, SAME tx (commits/rolls back with the settle).
  await enqueueClvBuy(
    {
      amountUsdc: (ctx.usdCents / 100).toFixed(6),
      reason: 'checkout_rent_prepay',
      sourceRef: ctx.checkoutId,
      metadata: {
        parcelId: p.id,
        parcelCode: p.parcel_code,
        avatarId,
        subjectKind: ctx.subject.kind,
        txSignature: ctx.txSignature,
      },
    },
    ctx.tx,
  );

  return {
    fulfilled: true,
    detail: {
      parcelId: p.id,
      parcelCode: p.parcel_code,
      depositRemainingCt: newRemaining,
      graceCleared,
    },
  };
};

registerFulfiller('rent_payment', rentPrepayFulfiller);
registerCheckoutPreflight('rent_payment', rentPrepayPreflight);
