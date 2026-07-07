/**
 * GENERIC x402 CHECKOUT (Tokenomics C — checkout stage, 2026-07-07).
 *
 * ONE reusable service that lets ANY vCLAW-priced thing settle as a REAL x402
 * USDC payment through the existing PayAI facilitator primitive
 * (`x402-payai.ts`), with the item's value recorded ATOMICALLY by a
 * kind-specific FULFILLER that runs inside the settle transaction.
 *
 * STRUCTURE IS COPIED FROM `routes/ct-topup.ts` — the proven money path:
 *   quote  → persist a PENDING `x402_checkouts` row → 402 challenge.
 *   settle → withKeyedMutex(per-checkout) → fast idem replay → load the
 *            pending row BOUND TO THE CALLER → re-derive the requirements
 *            SERVER-SIDE from the persisted row (never a client echo) →
 *            verifyAndSettle (never throws; verify-before-settle) → ONE
 *            db.transaction { flip pending→settled claiming the tx signature
 *            under the partial-UNIQUE index + run the fulfiller's writes } →
 *            23505 ⇒ CheckoutReplay ⇒ replay the already-fulfilled row
 *            OUTSIDE the aborted tx. Transient facilitator failures leave the
 *            row PENDING; definitive rejections poison it to 'failed'.
 *
 * ── THE MONEY MODEL: USDC-SETTLES-UNDERNEATH ────────────────────────────────
 * vCLAW is the QUOTE UNIT ONLY (¢-peg: 1 vCLAW = $0.01 ⇒ usdCents ==
 * priceVclaw, asserted at module load AND per quote). The buyer pays REAL
 * USDC to the merchant wallet; their internal vCLAW balance is NEVER debited
 * on a checkout. Fulfillers must therefore obey:
 *   (a) NEVER debit the buyer's internal vCLAW (they paid USDC, not vCLAW).
 *   (b) NEVER mint unbacked internal vCLAW. Every internal-vCLAW-denominated
 *       credit a fulfiller produces MUST carry a usd_basis tracing to the
 *       settled tx (a BACKED emission — real dollars entered underneath).
 *   (c) Do ALL writes on the PASSED `ctx.tx`. A fulfiller opening its own
 *       transaction breaks settle atomicity and is a BLOCKING defect.
 *   (d) Record the treasury's USDC-rail revenue as an `enqueueClvBuy` intent
 *       (the C3 queue — the on-chain USDC→CLV leg), NOT as a minted internal
 *       treasury-avatar credit (that would be an unbacked faucet).
 *
 * ── THE FULFILLER REGISTRY (the marketplace stage imports this) ─────────────
 * `registerFulfiller` / `getFulfiller` / `CheckoutItemKind` /
 * `CheckoutFulfillmentContext` / `CheckoutFulfiller` / `createCheckoutQuote` /
 * `settleCheckout` are the STABLE exported contract — the marketplace stage
 * registers `marketplace_purchase` / `tournament_entry` fulfillers against
 * these exact signatures. Fulfillers SELF-REGISTER via side-effect import
 * (`checkout-fulfillers/*.ts`, pulled by `routes/x402-checkout.ts`, pulled by
 * `index.ts`). A kind with NO registered fulfiller is refused at QUOTE time
 * and again at SETTLE time BEFORE the facilitator is ever called — we never
 * take USDC we cannot fulfill.
 *
 * Optional (additive, not part of the pinned contract): a kind may also
 * register a read-only PREFLIGHT via `registerCheckoutPreflight`. It runs at
 * settle time BEFORE the facilitator call, so a precondition that died
 * between quote and settle (parcel released, cosmetic bought with CT, …)
 * refuses CLEANLY while the row is still pending and NO money has moved.
 */

import { db, x402Checkouts, avatars, and, eq } from '@clawville/database';
import { loadX402Config } from './x402-config';
import {
  buildTopupQuote,
  resolveFacilitatorFeePayer,
  verifyAndSettle,
  usdToCt,
  CT_PER_USDC,
  type TopupQuote,
  type X402Network,
} from './x402-payai';
import { resolveTopupNetwork } from '../routes/ct-topup';
import { withKeyedMutex } from './keyed-mutex';
import type { LedgerTx } from './claw-token-ledger';

// ---------------------------------------------------------------------------
// ¢-PEG TRIPWIRE — the whole quote model assumes 1 vCLAW = $0.01
// ---------------------------------------------------------------------------
// `usdCents === priceVclaw` is only an identity while CT_PER_USDC === 100
// (1 USDC = 100¢ = 100 vCLAW ⇒ 1 vCLAW = 1¢). If the store rate is ever
// edited, this module's peg math silently mis-prices every checkout — so we
// crash LOUD at module load (this file is on index.ts's static import graph
// via the route) instead of quoting wrong prices. Changing the rate requires
// revisiting `usdCentsForPriceVclaw` deliberately.
if (CT_PER_USDC !== 100) {
  throw new Error(
    `[x402-checkout] ¢-peg violated: CT_PER_USDC=${CT_PER_USDC} (expected 100). ` +
      'The checkout quotes usdCents === priceVclaw ONLY at the ¢-peg — update ' +
      'usdCentsForPriceVclaw before changing the rate.',
  );
}

/** ¢-peg conversion: N vCLAW costs N cents. Kept as a named fn (not inline)
 *  so a future rate change has exactly one place to edit + the tripwire above. */
function usdCentsForPriceVclaw(priceVclaw: number): number {
  return priceVclaw;
}

/** Single-checkout cap, mirroring ct-topup's quote cap (1_000_000¢ = $10,000). */
export const CHECKOUT_MAX_PRICE_VCLAW = 1_000_000;

// ---------------------------------------------------------------------------
// The pinned contract types
// ---------------------------------------------------------------------------

export type CheckoutItemKind =
  | 'rent_payment'
  | 'cosmetic_purchase'
  | 'marketplace_purchase'
  | 'tournament_entry';

/** The settling buyer — middleware-resolved (Rule E5), NEVER body-supplied.
 *  `kind:'agent'` is a connected/hosted agent settling for ITS OWN avatar. */
export interface CheckoutSubject {
  avatarId: string;
  userId: string | null;
  kind: 'user' | 'agent';
}

export interface CheckoutFulfillmentContext {
  /** The settle transaction — fulfillers do ALL writes on THIS tx. */
  tx: LedgerTx;
  checkoutId: string;
  subject: CheckoutSubject;
  itemKind: CheckoutItemKind;
  itemRef: string;
  /** Positive int quote unit. */
  priceVclaw: number;
  /** ¢-peg: usdCents === priceVclaw exactly (1 vCLAW = $0.01). */
  usdCents: number;
  /** (usdCents/100).toFixed(2) — the usd_basis for any backed emission. */
  usdBasis: string;
  txSignature: string;
  settlePayer: string | null;
  network: string | null;
}

export type CheckoutFulfiller = (
  ctx: CheckoutFulfillmentContext,
) => Promise<{ fulfilled: true; detail?: Record<string, unknown> }>;

// ---------------------------------------------------------------------------
// Registry (fulfillers self-register via side-effect import)
// ---------------------------------------------------------------------------

const fulfillers = new Map<CheckoutItemKind, CheckoutFulfiller>();
const preflights = new Map<CheckoutItemKind, CheckoutPreflight>();

export function registerFulfiller(kind: CheckoutItemKind, fn: CheckoutFulfiller): void {
  if (fulfillers.has(kind)) {
    // Duplicate registration = a wiring bug (two modules claiming one kind).
    // Crash loud at import time rather than let the later import silently win.
    throw new Error(`[x402-checkout] fulfiller for '${kind}' is already registered`);
  }
  fulfillers.set(kind, fn);
}

export function getFulfiller(kind: CheckoutItemKind): CheckoutFulfiller | undefined {
  return fulfillers.get(kind);
}

/**
 * ADDITIVE (not part of the pinned marketplace contract): a read-only settle
 * preflight. Runs BEFORE the facilitator call so a precondition that died
 * between quote and settle refuses cleanly with the row still PENDING and no
 * money moved. MUST NOT write anything.
 */
export type CheckoutPreflight = (input: {
  subject: CheckoutSubject;
  itemRef: string;
  priceVclaw: number;
}) => Promise<{ ok: true } | { ok: false; code: string }>;

export function registerCheckoutPreflight(kind: CheckoutItemKind, fn: CheckoutPreflight): void {
  if (preflights.has(kind)) {
    throw new Error(`[x402-checkout] preflight for '${kind}' is already registered`);
  }
  preflights.set(kind, fn);
}

/**
 * Thrown BY A FULFILLER (inside the settle tx) when an authoritative,
 * row-locked precondition check fails — e.g. the parcel changed owner in the
 * milliseconds between the facilitator settle and the row lock. The settle tx
 * rolls back (no partial fulfillment); `settleCheckout` then records the
 * least-bad terminal state OUTSIDE the aborted tx: the row flips to 'failed'
 * CLAIMING the tx signature (so no other checkout can ever claim it) with
 * `failureReason:'fulfillment_refused'` + the refusal code — a LOUD, queryable
 * "USDC arrived but could not be fulfilled; manual refund required" record.
 * Preflights exist precisely to make this path near-unreachable.
 */
export class CheckoutFulfillmentRefusal extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? `checkout_fulfillment_refused:${code}`);
    this.name = 'CheckoutFulfillmentRefusal';
  }
}

// ---------------------------------------------------------------------------
// createCheckoutQuote — persist a pending row + build the 402 challenge
// ---------------------------------------------------------------------------

export type CheckoutQuoteResult =
  | {
      ok: true;
      checkoutId: string;
      itemKind: CheckoutItemKind;
      itemRef: string;
      priceVclaw: number;
      usdCents: number;
      network: X402Network;
      /** The full x402 v2 PaymentRequired body (header + JSON echo). */
      quote: TopupQuote;
    }
  | {
      ok: false;
      code: 'invalid_amount' | 'fulfiller_unavailable' | 'on_ramp_unconfigured' | 'quote_failed';
    };

export async function createCheckoutQuote(input: {
  subject: CheckoutSubject;
  itemKind: CheckoutItemKind;
  itemRef: string;
  priceVclaw: number;
}): Promise<CheckoutQuoteResult> {
  const { subject, itemKind, itemRef, priceVclaw } = input;

  // AMOUNT DISCIPLINE — guard 0/NULL/fractional BEFORE any row or requirement
  // exists. The DB CHECKs are the backstop; this is the clean 400 path.
  if (
    !Number.isInteger(priceVclaw) ||
    priceVclaw <= 0 ||
    priceVclaw > CHECKOUT_MAX_PRICE_VCLAW
  ) {
    return { ok: false, code: 'invalid_amount' };
  }
  const usdCents = usdCentsForPriceVclaw(priceVclaw);
  // Per-quote peg tripwire (module-load assert is the primary): the ct-topup
  // rate math MUST agree that these cents buy exactly priceVclaw coins.
  if (usdToCt(usdCents) !== priceVclaw || usdCents !== priceVclaw) {
    console.error('[x402-checkout] ¢-peg drift', { priceVclaw, usdCents });
    return { ok: false, code: 'quote_failed' };
  }

  // NEVER quote a kind we cannot fulfill — the settle-side refusal's twin.
  if (!getFulfiller(itemKind)) {
    return { ok: false, code: 'fulfiller_unavailable' };
  }

  const config = loadX402Config();
  if (!config.merchantWalletPubkey) {
    // No payout pubkey — refuse rather than mint an unsettleable requirement.
    return { ok: false, code: 'on_ramp_unconfigured' };
  }

  const network = resolveTopupNetwork();

  // Persist the pending checkout BEFORE returning the quote so /settle can
  // flip an existing row + the quote is auditable (ct-topup shape).
  let checkoutId: string;
  try {
    const [row] = await db
      .insert(x402Checkouts)
      .values({
        avatarId: subject.avatarId,
        userId: subject.userId,
        itemKind,
        itemRef,
        priceVclaw,
        usdCents,
        status: 'pending',
        metadata: {
          network,
          subjectKind: subject.kind, // 'user' | 'agent' — E5 parity audit trail
        },
      })
      .returning({ id: x402Checkouts.id });
    checkoutId = row.id;
  } catch (err) {
    console.error('[x402-checkout] pending insert failed:', (err as Error).message);
    return { ok: false, code: 'quote_failed' };
  }

  // Facilitator gas signer — REQUIRED by real SVM facilitators (PayAI /verify
  // 400s missing_fee_payer without it). null (mock) → omitted.
  const feePayer = await resolveFacilitatorFeePayer(network);
  const quote = buildTopupQuote({
    payTo: config.merchantWalletPubkey,
    asset: 'usdc',
    usdCents,
    network,
    resource: {
      url: '/api/x402/checkout',
      description: `ClawVille checkout — ${itemKind} ${itemRef} (${priceVclaw} vCLAW = $${(usdCents / 100).toFixed(2)} USDC)`,
    },
    feePayer: feePayer ?? undefined,
  });

  return { ok: true, checkoutId, itemKind, itemRef, priceVclaw, usdCents, network, quote };
}

// ---------------------------------------------------------------------------
// settleCheckout — verify+settle the payment, fulfill EXACTLY ONCE
// ---------------------------------------------------------------------------

export type CheckoutSettleResult =
  | {
      ok: true;
      checkoutId: string;
      itemKind: CheckoutItemKind;
      itemRef: string;
      priceVclaw: number;
      txSignature: string;
      replay: boolean;
      fulfillment: Record<string, unknown> | null;
    }
  | {
      ok: false;
      code:
        | 'checkout_not_found'
        | 'checkout_not_pending'
        | 'fulfiller_unavailable'
        | 'on_ramp_unconfigured'
        | 'precondition_failed'
        | 'payment_not_settled'
        | 'fulfillment_refused'
        | 'settle_in_flight'
        | 'settle_failed';
      /** payment_not_settled: the facilitator reason + whether a retry may work. */
      reason?: string;
      transient?: boolean;
      /** precondition_failed / fulfillment_refused: the kind-specific code. */
      refusalCode?: string;
      /** checkout_not_pending: the row's actual status. */
      status?: string;
    };

/** Raised inside the settle tx when a unique index trips (23505) or the
 *  pending→settled flip matched no row — already fulfilled by a prior /
 *  concurrent settle. Caught OUTSIDE the aborted tx to replay. (ct-topup's
 *  TopupReplay, verbatim shape.) */
class CheckoutReplay extends Error {
  constructor(public readonly kind: 'txsig' | 'idem') {
    super(`x402_checkout_replay:${kind}`);
    this.name = 'CheckoutReplay';
  }
}

export async function settleCheckout(input: {
  checkoutId: string;
  subject: CheckoutSubject;
  paymentHeader: string;
  idempotencyKey: string;
}): Promise<CheckoutSettleResult> {
  const { checkoutId, subject, paymentHeader, idempotencyKey } = input;

  // SERIALIZE per-checkoutId (ct-topup FIX-5, payer-loss): two concurrent
  // settles of the SAME checkout carrying DIFFERENT valid payments could BOTH
  // pass the external verify→settle (each moves USDC on-chain) then race the
  // pending→settled UPDATE — the loser paid real USDC for nothing. The mutex
  // makes read-pending → verifyAndSettle → fulfill atomic per checkoutId
  // within this process; the txsig unique index stays the cross-process
  // double-FULFILLMENT backstop.
  return withKeyedMutex(`x402-checkout-settle:${checkoutId}`, async () => {
    // 1) FAST idempotency replay — BEFORE touching the facilitator.
    const priorByKey = await db.query.x402Checkouts.findFirst({
      where: and(
        eq(x402Checkouts.avatarId, subject.avatarId),
        eq(x402Checkouts.idempotencyKey, idempotencyKey),
      ),
    });
    if (priorByKey && priorByKey.status === 'settled') {
      return replayResult(priorByKey);
    }

    // 2) Load the pending row BOUND TO THE CALLER'S avatar — an agent/human can
    //    only settle ITS OWN checkout; a foreign checkoutId resolves to no row.
    const pending = await db.query.x402Checkouts.findFirst({
      where: and(eq(x402Checkouts.id, checkoutId), eq(x402Checkouts.avatarId, subject.avatarId)),
    });
    if (!pending) {
      return { ok: false as const, code: 'checkout_not_found' as const };
    }
    if (pending.status === 'settled') {
      return replayResult(pending);
    }
    if (pending.status !== 'pending') {
      // 'failed' is terminal — a known-bad payment/refusal can't be re-poked.
      return {
        ok: false as const,
        code: 'checkout_not_pending' as const,
        status: pending.status,
      };
    }

    const itemKind = pending.itemKind as CheckoutItemKind;

    // 3) Fulfiller MUST exist BEFORE the facilitator is called — never take
    //    USDC we can't fulfill. (Quote refuses too; this covers a deploy that
    //    dropped a fulfiller between quote and settle.)
    const fulfiller = getFulfiller(itemKind);
    if (!fulfiller) {
      return { ok: false as const, code: 'fulfiller_unavailable' as const };
    }

    // 4) Amounts come from the PERSISTED ROW (server-authoritative — there is
    //    no client echo to trust). Internal-consistency guard: a peg-violating
    //    or tampered row must never reach the facilitator.
    const priceVclaw = pending.priceVclaw;
    const rowUsdCents = pending.usdCents;
    if (
      !Number.isInteger(priceVclaw) ||
      priceVclaw <= 0 ||
      rowUsdCents !== usdCentsForPriceVclaw(priceVclaw) ||
      usdToCt(rowUsdCents) !== priceVclaw
    ) {
      console.error('[x402-checkout] corrupt checkout row', { checkoutId, priceVclaw, rowUsdCents });
      return { ok: false as const, code: 'settle_failed' as const };
    }

    // 5) READ-ONLY PREFLIGHT (when the kind registered one) — re-check the
    //    fulfillment preconditions BEFORE any money moves. A precondition that
    //    died since the quote (parcel released, cosmetic already owned, …)
    //    refuses cleanly: row stays PENDING, facilitator never called.
    const preflight = preflights.get(itemKind);
    if (preflight) {
      let pre: Awaited<ReturnType<CheckoutPreflight>>;
      try {
        pre = await preflight({ subject, itemRef: pending.itemRef, priceVclaw });
      } catch (err) {
        console.error('[x402-checkout] preflight threw:', (err as Error).message);
        return { ok: false as const, code: 'settle_failed' as const };
      }
      if (!pre.ok) {
        return {
          ok: false as const,
          code: 'precondition_failed' as const,
          refusalCode: pre.code,
        };
      }
    }

    // 6) Re-derive the EXACT requirements the quote issued — server-side.
    const config = loadX402Config();
    if (!config.merchantWalletPubkey) {
      return { ok: false as const, code: 'on_ramp_unconfigured' as const };
    }
    const meta = (pending.metadata ?? {}) as Record<string, unknown>;
    const network = (meta.network === 'mainnet' || meta.network === 'devnet'
      ? meta.network
      : resolveTopupNetwork()) as X402Network;
    const settleFeePayer = await resolveFacilitatorFeePayer(network);
    const quote = buildTopupQuote({
      payTo: config.merchantWalletPubkey,
      asset: 'usdc',
      usdCents: rowUsdCents,
      network,
      feePayer: settleFeePayer ?? undefined,
    });
    const requirements = quote.accepts[0];

    // 7) Verify → (only on valid) settle. NEVER throws; !settled → clean
    //    result. Transient facilitator failure leaves the row PENDING for a
    //    retry of the SAME checkoutId; definitive rejection poisons to failed.
    const result = await verifyAndSettle({ paymentHeader, requirements });
    if (!result.settled || !result.txSignature) {
      const reason = result.failureReason ?? 'unsettled';
      const transient = reason === 'facilitator_verify_error' || reason === 'facilitator_settle_error';
      if (!transient) {
        try {
          await db
            .update(x402Checkouts)
            .set({ status: 'failed', metadata: { ...meta, failureReason: reason } })
            .where(and(eq(x402Checkouts.id, checkoutId), eq(x402Checkouts.status, 'pending')));
        } catch (err) {
          console.warn('[x402-checkout] mark-failed write failed (non-fatal):', (err as Error).message);
        }
      }
      return { ok: false as const, code: 'payment_not_settled' as const, reason, transient };
    }

    const txSignature = result.txSignature;
    const usdBasis = (rowUsdCents / 100).toFixed(2);

    // 8) ATOMIC settle: flip pending→settled (claiming the tx signature under
    //    the partial-UNIQUE index) + the fulfiller's writes, in ONE tx. A
    //    duplicate signature/idem key trips 23505 → the WHOLE tx (fulfillment
    //    included) rolls back → replay the already-fulfilled row outside.
    try {
      const settled = await db.transaction(async (tx) => {
        const settleMeta: Record<string, unknown> = {
          ...meta,
          txSignature,
          settlePayer: result.payer ?? undefined,
          settleNetwork: result.network ?? undefined,
        };
        let updated: { id: string }[] | undefined;
        try {
          updated = await tx
            .update(x402Checkouts)
            .set({
              status: 'settled',
              txSignature,
              usdBasisAtReceipt: usdBasis,
              idempotencyKey,
              metadata: settleMeta,
            })
            .where(and(eq(x402Checkouts.id, checkoutId), eq(x402Checkouts.status, 'pending')))
            .returning({ id: x402Checkouts.id });
        } catch (err) {
          const pgCode = (err as { code?: string } | undefined)?.code;
          if (pgCode === '23505') {
            const constraint = (err as { constraint?: string } | undefined)?.constraint ?? '';
            throw new CheckoutReplay(constraint.includes('idem') ? 'idem' : 'txsig');
          }
          throw err;
        }
        if (!updated || updated.length === 0) {
          // WHERE status='pending' matched nothing — a concurrent settle won.
          throw new CheckoutReplay('txsig');
        }

        // THE FULFILLER — all item-domain writes compose into THIS tx. It may
        // throw CheckoutFulfillmentRefusal (authoritative row-locked
        // precondition failure) → whole tx rolls back → terminal-failure
        // handling below.
        const fulfillment = await fulfiller({
          tx,
          checkoutId,
          subject,
          itemKind,
          itemRef: pending.itemRef,
          priceVclaw,
          usdCents: rowUsdCents,
          usdBasis,
          txSignature,
          settlePayer: result.payer,
          network: result.network,
        });
        const detail = fulfillment.detail ?? {};

        // Persist the fulfillment detail on the row (same tx) so replays can
        // echo it back.
        await tx
          .update(x402Checkouts)
          .set({ metadata: { ...settleMeta, fulfillment: detail } })
          .where(eq(x402Checkouts.id, checkoutId));

        return { detail };
      });

      return {
        ok: true as const,
        checkoutId,
        itemKind,
        itemRef: pending.itemRef,
        priceVclaw,
        txSignature,
        replay: false,
        fulfillment: settled.detail,
      };
    } catch (err) {
      if (err instanceof CheckoutReplay) {
        const replayed = await findSettledForReplay({
          avatarId: subject.avatarId,
          txSignature,
          idempotencyKey,
          kind: err.kind,
        });
        if (replayed && replayed.status === 'settled') {
          return replayResult(replayed);
        }
        return { ok: false as const, code: 'settle_in_flight' as const };
      }
      if (err instanceof CheckoutFulfillmentRefusal) {
        // USDC MOVED but the authoritative in-tx precondition refused (the
        // preflight narrowed this to a near-zero race window). Least-bad
        // terminal state, recorded OUTSIDE the aborted tx: fail the row
        // CLAIMING the tx signature (nothing else can ever claim it) + a LOUD
        // ops trail. Manual refund path — money is never silently dropped.
        console.error(
          `[x402-checkout] FULFILLMENT REFUSED AFTER SETTLE — USDC arrived but could not be fulfilled; ` +
            `manual refund required. checkout=${checkoutId} kind=${itemKind} refusal=${err.code} tx=${txSignature}`,
        );
        try {
          await db
            .update(x402Checkouts)
            .set({
              status: 'failed',
              txSignature,
              usdBasisAtReceipt: usdBasis,
              metadata: {
                ...meta,
                failureReason: 'fulfillment_refused',
                refusalCode: err.code,
                txSignature,
                settlePayer: result.payer ?? undefined,
                settleNetwork: result.network ?? undefined,
              },
            })
            .where(and(eq(x402Checkouts.id, checkoutId), eq(x402Checkouts.status, 'pending')));
        } catch (recordErr) {
          console.error(
            '[x402-checkout] failed to record fulfillment refusal (manual reconciliation needed):',
            (recordErr as Error).message,
          );
        }
        return {
          ok: false as const,
          code: 'fulfillment_refused' as const,
          refusalCode: err.code,
        };
      }
      console.error('[x402-checkout] settle transaction failed:', (err as Error).message);
      return { ok: false as const, code: 'settle_failed' as const };
    }
  }); // end withKeyedMutex — serialized critical section per checkoutId
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type CheckoutRow = NonNullable<Awaited<ReturnType<typeof db.query.x402Checkouts.findFirst>>>;

/** Shape an already-settled row into the idempotent replay response. */
function replayResult(row: CheckoutRow): CheckoutSettleResult {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const fulfillment =
    meta.fulfillment && typeof meta.fulfillment === 'object'
      ? (meta.fulfillment as Record<string, unknown>)
      : null;
  return {
    ok: true,
    checkoutId: row.id,
    itemKind: row.itemKind as CheckoutItemKind,
    itemRef: row.itemRef,
    priceVclaw: row.priceVclaw,
    txSignature: row.txSignature ?? '',
    replay: true,
    fulfillment,
  };
}

/** Re-read the already-settled row a collision replays. Scoped to the CALLER'S
 *  avatar (ct-topup's cross-avatar-leak guard): a caller replaying another
 *  avatar's settled payment header reads nothing and 409s settle_in_flight. */
async function findSettledForReplay(input: {
  avatarId: string;
  txSignature: string;
  idempotencyKey: string;
  kind: 'txsig' | 'idem';
}) {
  if (input.kind === 'idem') {
    return db.query.x402Checkouts.findFirst({
      where: and(
        eq(x402Checkouts.avatarId, input.avatarId),
        eq(x402Checkouts.idempotencyKey, input.idempotencyKey),
      ),
    });
  }
  return db.query.x402Checkouts.findFirst({
    where: and(
      eq(x402Checkouts.txSignature, input.txSignature),
      eq(x402Checkouts.avatarId, input.avatarId),
    ),
  });
}

/** Current CT balance (read-only) — exported for route responses that want to
 *  show the (unchanged) balance, proving no internal vCLAW moved. */
export async function checkoutSubjectBalance(avatarId: string): Promise<number> {
  const row = await db.query.avatars.findFirst({
    where: eq(avatars.id, avatarId),
    columns: { clawTokens: true },
  });
  return row?.clawTokens ?? 0;
}
