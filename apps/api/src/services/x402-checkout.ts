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

import { randomUUID } from 'node:crypto';
import { db, x402Checkouts, avatars, and, eq, isNull } from '@clawville/database';
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
        | 'idempotency_key_conflict'
        | 'checkout_reconciliation'
        | 'signature_conflict'
        | 'settle_failed';
      /** payment_not_settled: the facilitator reason + whether a retry may work. */
      reason?: string;
      transient?: boolean;
      /** precondition_failed / fulfillment_refused: the kind-specific code. */
      refusalCode?: string;
      /** checkout_not_pending / *_reconciliation / signature_conflict: the row's state. */
      status?: string;
    };

type CheckoutRow = NonNullable<Awaited<ReturnType<typeof db.query.x402Checkouts.findFirst>>>;

/**
 * A `settling` row with NO signature older than this is a DEAD claim (its
 * process died before the facilitator returned) → reconcile, NEVER an auto-retry
 * of the facilitator (Codex finding 1). Floor 30s; MUST exceed the facilitator
 * settle timeout (buildTopupQuote maxTimeoutSeconds default 120s) so a live
 * in-flight settle is never mis-reconciled.
 */
const SETTLING_STALE_MS_DEFAULT = 5 * 60_000;
function resolveSettlingStaleMs(): number {
  const raw = process.env.X402_CHECKOUT_SETTLING_STALE_MS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 30_000 ? n : SETTLING_STALE_MS_DEFAULT;
}

/** Thrown inside the fulfillment tx when the settling→settled flip matches no row
 *  (a concurrent resume already settled it) → caught outside → idempotent replay.
 *  The facilitator is NEVER re-called on this path. */
class CheckoutAlreadySettled extends Error {
  constructor() {
    super('x402_checkout_already_settled');
    this.name = 'CheckoutAlreadySettled';
  }
}

export async function settleCheckout(input: {
  checkoutId: string;
  subject: CheckoutSubject;
  paymentHeader: string;
  idempotencyKey: string;
}): Promise<CheckoutSettleResult> {
  const { checkoutId, subject, paymentHeader, idempotencyKey } = input;

  // In-process serialization per checkoutId — an efficiency layer, NOT the
  // correctness guarantee. The DURABLE guarantees are the DB-backed CLAIM (only
  // one process flips pending→settling before the facilitator is called) and the
  // tx_signature partial-UNIQUE CAPTURE (a settled signature is bound to exactly
  // one checkout). Cross-process safety comes from those, not this mutex.
  return withKeyedMutex(`x402-checkout-settle:${checkoutId}`, async () => {
    // 1) Load the row BOUND TO THE CALLER'S avatar — an agent/human can only
    //    settle ITS OWN checkout; a foreign checkoutId resolves to no row. This
    //    is the ONLY replay lookup, scoped by checkoutId (Codex finding 4): a
    //    settled/settling/failed/reconcile row dispatches to terminal/resume
    //    handling and NEVER echoes another checkout's fulfillment.
    const row = await db.query.x402Checkouts.findFirst({
      where: and(eq(x402Checkouts.id, checkoutId), eq(x402Checkouts.avatarId, subject.avatarId)),
    });
    if (!row) {
      return { ok: false as const, code: 'checkout_not_found' as const };
    }
    if (row.status !== 'pending') {
      return dispatchExistingRow(row, subject);
    }

    const itemKind = row.itemKind as CheckoutItemKind;

    // 2) Fulfiller MUST exist BEFORE we claim/settle — never take USDC we can't
    //    fulfill. (Quote refuses too; this covers a deploy that dropped a
    //    fulfiller between quote and settle.)
    if (!getFulfiller(itemKind)) {
      return { ok: false as const, code: 'fulfiller_unavailable' as const };
    }

    // 3) Amounts come from the PERSISTED ROW (server-authoritative — no client
    //    echo to trust). A peg-violating / tampered row never reaches the
    //    facilitator.
    const priceVclaw = row.priceVclaw;
    const rowUsdCents = row.usdCents;
    if (
      !Number.isInteger(priceVclaw) ||
      priceVclaw <= 0 ||
      rowUsdCents !== usdCentsForPriceVclaw(priceVclaw) ||
      usdToCt(rowUsdCents) !== priceVclaw
    ) {
      console.error('[x402-checkout] corrupt checkout row', { checkoutId, priceVclaw, rowUsdCents });
      return { ok: false as const, code: 'settle_failed' as const };
    }

    // 4) READ-ONLY PREFLIGHT — re-check preconditions BEFORE claiming/settling. A
    //    precondition that died since the quote refuses cleanly: row stays
    //    PENDING, no claim taken, facilitator never called, no money moves.
    const preflight = preflights.get(itemKind);
    if (preflight) {
      let pre: Awaited<ReturnType<CheckoutPreflight>>;
      try {
        pre = await preflight({ subject, itemRef: row.itemRef, priceVclaw });
      } catch (err) {
        console.error('[x402-checkout] preflight threw:', (err as Error).message);
        return { ok: false as const, code: 'settle_failed' as const };
      }
      if (!pre.ok) {
        return { ok: false as const, code: 'precondition_failed' as const, refusalCode: pre.code };
      }
    }

    // 5) On-ramp must be configured BEFORE we claim (no point staking a claim on
    //    a row we can't settle).
    const config = loadX402Config();
    if (!config.merchantWalletPubkey) {
      return { ok: false as const, code: 'on_ramp_unconfigured' as const };
    }

    // 6) DB-BACKED CLAIM (Codex finding 1): pending → settling, exclusive across
    //    PROCESSES. Only the winner of `WHERE status='pending'` calls the
    //    facilitator; every other settle sees 'settling' and never double-calls
    //    verify→settle. The claim also stakes the idempotency key: a reuse on a
    //    DIFFERENT checkout trips the (avatar,key) UNIQUE → a clean conflict
    //    BEFORE any money moves.
    const settlingId = randomUUID();
    let claimed: { id: string }[];
    try {
      claimed = await db
        .update(x402Checkouts)
        .set({ status: 'settling', settlingId, settlingStartedAt: new Date(), idempotencyKey })
        .where(and(eq(x402Checkouts.id, checkoutId), eq(x402Checkouts.status, 'pending')))
        .returning({ id: x402Checkouts.id });
    } catch (err) {
      if ((err as { code?: string } | undefined)?.code === '23505') {
        // (avatar, idempotency_key) UNIQUE tripped — this avatar used this key on
        // ANOTHER checkout. Refuse; NO money has moved.
        return { ok: false as const, code: 'idempotency_key_conflict' as const };
      }
      throw err;
    }
    if (claimed.length === 0) {
      // Someone else advanced this checkout between our read and here — re-read +
      // dispatch (resume / replay / in-flight / reconcile).
      const reread = await db.query.x402Checkouts.findFirst({
        where: and(eq(x402Checkouts.id, checkoutId), eq(x402Checkouts.avatarId, subject.avatarId)),
      });
      if (!reread) return { ok: false as const, code: 'checkout_not_found' as const };
      return dispatchExistingRow(reread, subject);
    }

    // 7) Re-derive the EXACT requirements the quote issued — server-side.
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
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

    // 8) Verify → (only on valid) settle. MONEY MAY MOVE HERE.
    const result = await verifyAndSettle({ paymentHeader, requirements });
    if (!result.settled || !result.txSignature) {
      const reason = result.failureReason ?? 'unsettled';
      const transient = reason === 'facilitator_verify_error' || reason === 'facilitator_settle_error';
      if (transient) {
        // NO money moved. Release the claim (settling → pending) so a retry of
        // the SAME checkout can re-claim. Checked to our settlingId.
        await releaseClaim(checkoutId, settlingId);
      } else {
        // Definitive rejection, NO money moved → terminal failed (checked to our
        // claim). A known-bad payment can't be re-poked.
        await db
          .update(x402Checkouts)
          .set({
            status: 'failed',
            settlingId: null,
            settlingStartedAt: null,
            metadata: { ...meta, failureReason: reason },
          })
          .where(
            and(
              eq(x402Checkouts.id, checkoutId),
              eq(x402Checkouts.status, 'settling'),
              eq(x402Checkouts.settlingId, settlingId),
            ),
          );
      }
      return { ok: false as const, code: 'payment_not_settled' as const, reason, transient };
    }

    // 9) CAPTURE (Codex finding 2): the facilitator settled — persist the tx
    //    signature IMMEDIATELY in its OWN committed UPDATE, BEFORE fulfillment is
    //    attempted. The money proof is now durable, so a later fulfillment
    //    failure can NEVER lose it and re-settle real USDC on retry. The
    //    tx_signature partial-UNIQUE makes the capture the single exactly-once
    //    binding of this on-chain payment to this checkout.
    const txSignature = result.txSignature;
    const usdBasis = (rowUsdCents / 100).toFixed(2);
    const captureMeta: Record<string, unknown> = {
      ...meta,
      txSignature,
      settlePayer: result.payer ?? undefined,
      settleNetwork: result.network ?? undefined,
    };
    let captured: { id: string }[];
    try {
      captured = await db
        .update(x402Checkouts)
        .set({ txSignature, usdBasisAtReceipt: usdBasis, metadata: captureMeta })
        .where(
          and(
            eq(x402Checkouts.id, checkoutId),
            eq(x402Checkouts.status, 'settling'),
            eq(x402Checkouts.settlingId, settlingId),
            isNull(x402Checkouts.txSignature),
          ),
        )
        .returning({ id: x402Checkouts.id });
    } catch (err) {
      if ((err as { code?: string } | undefined)?.code === '23505') {
        // The settled signature is ALREADY owned by a DIFFERENT checkout (Codex
        // finding 4): the same on-chain payment maps to another item. NEVER
        // fulfill this one on that signature — reconcile, recording the spent
        // signature in metadata (the column stays owned by the other checkout).
        console.error(
          `[x402-checkout] SIGNATURE CONFLICT — settled tx ${txSignature} already owned by another ` +
            `checkout; checkout=${checkoutId} → reconcile (no fulfillment)`,
        );
        await markReconcile(checkoutId, settlingId, 'signature_conflict', txSignature, meta, result);
        return { ok: false as const, code: 'signature_conflict' as const, status: 'reconcile' };
      }
      // Transient error persisting the signature — money moved, sig NOT yet
      // durable on our row. Leave the claim: a retry inside the stale window is
      // settle_in_flight, past it reconcile. LOUD.
      console.error(
        `[x402-checkout] CAPTURE FAILED AFTER USDC MOVED — signature not yet durable; ` +
          `checkout=${checkoutId} tx=${txSignature} err=${(err as Error).message}`,
      );
      return { ok: false as const, code: 'settle_failed' as const, transient: true };
    }
    if (captured.length === 0) {
      // Our claim no longer matches (settlingId changed, or already captured). If
      // the row now carries OUR signature, resume/replay; else money moved but we
      // could not record it → loud reconcile.
      const reread = await db.query.x402Checkouts.findFirst({
        where: and(eq(x402Checkouts.id, checkoutId), eq(x402Checkouts.avatarId, subject.avatarId)),
      });
      if (reread && reread.txSignature === txSignature) {
        if (reread.status === 'settled') return replayResult(reread);
        if (reread.status === 'settling') return runFulfillment(reread, subject);
      }
      console.error(
        `[x402-checkout] CAPTURE MATCHED NO ROW AFTER USDC MOVED — checkout=${checkoutId} ` +
          `tx=${txSignature}; MANUAL reconcile required`,
      );
      await markReconcile(checkoutId, settlingId, 'capture_lost', txSignature, meta, result);
      return { ok: false as const, code: 'checkout_reconciliation' as const, status: 'reconcile' };
    }

    // 10) FULFILL (resumable). Re-read the captured row for the full context and
    //     run the shared, resumable fulfillment (flip settling→settled + the
    //     fulfiller, atomically). The facilitator is NEVER called again.
    const capturedRow = await db.query.x402Checkouts.findFirst({
      where: eq(x402Checkouts.id, checkoutId),
    });
    if (!capturedRow) {
      // Impossible (we just updated it) — defensive. Row is captured+durable; a
      // retry resumes.
      return { ok: false as const, code: 'settle_failed' as const, transient: true };
    }
    return runFulfillment(capturedRow, subject);
  }); // end withKeyedMutex — per-checkout in-process serialization
}

// ---------------------------------------------------------------------------
// settle helpers
// ---------------------------------------------------------------------------

/** Dispatch a NON-pending row (loaded by checkoutId+avatar) to its terminal or
 *  RESUME outcome. NEVER calls the facilitator. */
async function dispatchExistingRow(
  row: CheckoutRow,
  subject: CheckoutSubject,
): Promise<CheckoutSettleResult> {
  switch (row.status) {
    case 'settled':
      return replayResult(row);
    case 'failed':
      // Definitive facilitator rejection OR a recorded post-settle refusal —
      // terminal either way (a refusal row carries the signature for the refund
      // trail). Not re-pokable.
      return { ok: false as const, code: 'checkout_not_pending' as const, status: 'failed' };
    case 'reconcile':
      return { ok: false as const, code: 'checkout_reconciliation' as const, status: 'reconcile' };
    case 'settling': {
      if (row.txSignature) {
        // CAPTURED — the money is durable, only fulfillment is incomplete. RESUME
        // it (never re-call the facilitator).
        return runFulfillment(row, subject);
      }
      // settling with NO signature — the facilitator call is in-flight or its
      // process died mid-call.
      const startedAt = row.settlingStartedAt ? new Date(row.settlingStartedAt).getTime() : 0;
      const ageMs = Date.now() - startedAt;
      if (ageMs < resolveSettlingStaleMs()) {
        // A concurrent settle holds a FRESH claim — let the caller retry shortly.
        return { ok: false as const, code: 'settle_in_flight' as const };
      }
      // STALE claim, no signature: money-state UNKNOWN. Do NOT re-call the
      // facilitator (Codex finding 1) — a chain-check reconciler resolves whether
      // the payment landed. `requireNullSignature` guards a capture racing in.
      console.error(
        `[x402-checkout] STALE SETTLING CLAIM — checkout=${row.id} settling ${Math.round(ageMs / 1000)}s ` +
          `with no signature; money-state UNKNOWN → reconcile (no facilitator re-call)`,
      );
      await markReconcile(
        row.id,
        row.settlingId,
        'stale_settling',
        null,
        (row.metadata ?? {}) as Record<string, unknown>,
        null,
        true,
      );
      // Re-read to report the resolved state (reconcile, or resumed if a capture
      // beat the reconcile in).
      const after = await db.query.x402Checkouts.findFirst({
        where: and(eq(x402Checkouts.id, row.id), eq(x402Checkouts.avatarId, subject.avatarId)),
      });
      if (after && after.status === 'settling' && after.txSignature) {
        return runFulfillment(after, subject);
      }
      return { ok: false as const, code: 'checkout_reconciliation' as const, status: 'reconcile' };
    }
    default:
      return { ok: false as const, code: 'checkout_not_pending' as const, status: row.status };
  }
}

/** Run the fulfiller for a CAPTURED row (settling + tx_signature), flipping
 *  settling→settled atomically. Resumable + exactly-once: a prior failed attempt
 *  rolled back ENTIRELY (flip + all fulfiller writes are one tx), so this applies
 *  the fulfiller exactly once; a concurrent resume that already settled the row
 *  is detected (0-row flip → CheckoutAlreadySettled) and replayed. NEVER calls
 *  the facilitator. */
async function runFulfillment(
  row: CheckoutRow,
  subject: CheckoutSubject,
): Promise<CheckoutSettleResult> {
  const checkoutId = row.id;
  const itemKind = row.itemKind as CheckoutItemKind;
  const txSignature = row.txSignature;
  if (!txSignature) {
    // runFulfillment is only ever called on a captured row — defensive.
    console.error(`[x402-checkout] runFulfillment without a signature — checkout=${checkoutId}`);
    return { ok: false as const, code: 'settle_failed' as const, transient: true };
  }
  const fulfiller = getFulfiller(itemKind);
  if (!fulfiller) {
    return { ok: false as const, code: 'fulfiller_unavailable' as const };
  }
  const rowUsdCents = row.usdCents;
  const usdBasis = (rowUsdCents / 100).toFixed(2);
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const settlePayer = typeof meta.settlePayer === 'string' ? meta.settlePayer : null;
  const network =
    typeof meta.settleNetwork === 'string'
      ? (meta.settleNetwork as string)
      : typeof meta.network === 'string'
        ? (meta.network as string)
        : null;

  try {
    const out = await db.transaction(async (tx) => {
      // Flip settling(+sig) → settled FIRST, checked. A concurrent resume that
      // already settled ⇒ 0 rows ⇒ CheckoutAlreadySettled ⇒ replay (the fulfiller
      // NEVER runs twice).
      const flipped = await tx
        .update(x402Checkouts)
        .set({ status: 'settled', settlingId: null, settlingStartedAt: null })
        .where(
          and(
            eq(x402Checkouts.id, checkoutId),
            eq(x402Checkouts.status, 'settling'),
            eq(x402Checkouts.txSignature, txSignature),
          ),
        )
        .returning({ id: x402Checkouts.id });
      if (flipped.length === 0) {
        throw new CheckoutAlreadySettled();
      }

      // THE FULFILLER — all item-domain writes compose into THIS tx. On any throw
      // (refusal OR error) the whole tx (flip included) rolls back → the row
      // stays settling+sig, resumable, and the signature is never lost.
      const fulfillment = await fulfiller({
        tx,
        checkoutId,
        subject,
        itemKind,
        itemRef: row.itemRef,
        priceVclaw: row.priceVclaw,
        usdCents: rowUsdCents,
        usdBasis,
        txSignature,
        settlePayer,
        network,
      });
      const detail = fulfillment.detail ?? {};
      await tx
        .update(x402Checkouts)
        .set({ metadata: { ...meta, fulfillment: detail } })
        .where(eq(x402Checkouts.id, checkoutId));
      return { detail };
    });

    return {
      ok: true as const,
      checkoutId,
      itemKind,
      itemRef: row.itemRef,
      priceVclaw: row.priceVclaw,
      txSignature,
      replay: false,
      fulfillment: out.detail,
    };
  } catch (err) {
    if (err instanceof CheckoutAlreadySettled) {
      const settled = await db.query.x402Checkouts.findFirst({
        where: and(eq(x402Checkouts.id, checkoutId), eq(x402Checkouts.avatarId, subject.avatarId)),
      });
      if (settled && settled.status === 'settled') return replayResult(settled);
      return { ok: false as const, code: 'settle_in_flight' as const };
    }
    if (err instanceof CheckoutFulfillmentRefusal) {
      // Money moved + captured, fulfillment REFUSED (an authoritative row-locked
      // precondition failed — the preflight narrowed this to a near-zero window).
      // MANDATORY, CHECKED terminal record CARRYING the signature (Codex finding
      // 3): settling(+sig) → failed. A missed/errored record is escalated LOUD —
      // the money proof is already durable on the row, so ops reconciles.
      const refusalCode = err.code;
      let recorded: { id: string }[] | undefined;
      try {
        recorded = await db
          .update(x402Checkouts)
          .set({
            status: 'failed',
            settlingId: null,
            settlingStartedAt: null,
            metadata: { ...meta, failureReason: 'fulfillment_refused', refusalCode },
          })
          .where(
            and(
              eq(x402Checkouts.id, checkoutId),
              eq(x402Checkouts.status, 'settling'),
              eq(x402Checkouts.txSignature, txSignature),
            ),
          )
          .returning({ id: x402Checkouts.id });
      } catch (recErr) {
        console.error(
          `[x402-checkout] FULFILLMENT-REFUSED RECORD ERROR — checkout=${checkoutId} tx=${txSignature} ` +
            `refusal=${refusalCode}: ${(recErr as Error).message}`,
        );
      }
      if (!recorded || recorded.length === 0) {
        console.error(
          `[x402-checkout] FULFILLMENT REFUSED AFTER SETTLE — USDC moved, terminal record MISSED; ` +
            `checkout=${checkoutId} kind=${itemKind} refusal=${refusalCode} tx=${txSignature} — MANUAL refund + reconcile`,
        );
      } else {
        console.error(
          `[x402-checkout] FULFILLMENT REFUSED AFTER SETTLE — USDC moved but could not be fulfilled; ` +
            `manual refund required. checkout=${checkoutId} kind=${itemKind} refusal=${refusalCode} tx=${txSignature}`,
        );
      }
      return { ok: false as const, code: 'fulfillment_refused' as const, refusalCode };
    }
    // POST-CAPTURE transient failure (a 40001 serialization_failure under the
    // fulfillers' advisory/parcel locks, a transient DB error, an enqueueClvBuy
    // failure). The signature is DURABLE (captured), the row stays settling+sig,
    // so a retry RESUMES this fulfillment and NEVER re-calls the facilitator.
    // Loud; transient.
    console.error(
      `[x402-checkout] FULFILLMENT TX FAILED AFTER USDC CAPTURED — row left settling+signature for ` +
        `idempotent resume (no facilitator re-call); checkout=${checkoutId} kind=${itemKind} ` +
        `tx=${txSignature} err=${(err as Error).message}`,
    );
    return { ok: false as const, code: 'settle_failed' as const, transient: true };
  }
}

/** Release a settling claim back to pending (a transient, NO-money-moved
 *  facilitator failure) so a retry can re-claim. Checked to the claim holder. */
async function releaseClaim(checkoutId: string, settlingId: string): Promise<void> {
  try {
    await db
      .update(x402Checkouts)
      .set({ status: 'pending', settlingId: null, settlingStartedAt: null, idempotencyKey: null })
      .where(
        and(
          eq(x402Checkouts.id, checkoutId),
          eq(x402Checkouts.status, 'settling'),
          eq(x402Checkouts.settlingId, settlingId),
        ),
      );
  } catch (err) {
    console.warn('[x402-checkout] releaseClaim failed (non-fatal):', (err as Error).message);
  }
}

/** Move a settling row to the terminal `reconcile` state, recording the spent
 *  signature (if any) in metadata for the chain-check reconciler. NEVER writes
 *  the tx_signature COLUMN (that stays the exactly-once capture key). Checked to
 *  the claim; a miss is logged LOUD — money is never silently lost. */
async function markReconcile(
  checkoutId: string,
  settlingId: string | null,
  reason: string,
  spentTxSignature: string | null,
  meta: Record<string, unknown>,
  result: { payer?: string | null; network?: string | null } | null,
  requireNullSignature = false,
): Promise<void> {
  const conds = [eq(x402Checkouts.id, checkoutId), eq(x402Checkouts.status, 'settling')];
  if (settlingId) conds.push(eq(x402Checkouts.settlingId, settlingId));
  if (requireNullSignature) conds.push(isNull(x402Checkouts.txSignature));
  try {
    const updated = await db
      .update(x402Checkouts)
      .set({
        status: 'reconcile',
        settlingId: null,
        settlingStartedAt: null,
        metadata: {
          ...meta,
          reconcileReason: reason,
          ...(spentTxSignature
            ? {
                spentTxSignature,
                settlePayer: result?.payer ?? undefined,
                settleNetwork: result?.network ?? undefined,
              }
            : {}),
        },
      })
      .where(and(...conds))
      .returning({ id: x402Checkouts.id });
    if (updated.length === 0) {
      console.error(
        `[x402-checkout] RECONCILE RECORD MISSED — checkout=${checkoutId} reason=${reason} ` +
          `spentTx=${spentTxSignature ?? 'none'} — MANUAL reconciliation required`,
      );
    }
  } catch (err) {
    console.error(
      `[x402-checkout] RECONCILE RECORD FAILED — checkout=${checkoutId} reason=${reason} ` +
        `spentTx=${spentTxSignature ?? 'none'}: ${(err as Error).message}`,
    );
  }
}

/** Shape an already-settled row into the idempotent replay response. A settled
 *  row ALWAYS carries a signature (DB CHECK `x402_checkouts_settled_has_signature`);
 *  a settled-without-signature row is corruption and is REFUSED, never replayed
 *  as ok (Codex finding 5). */
function replayResult(row: CheckoutRow): CheckoutSettleResult {
  if (!row.txSignature) {
    console.error(
      `[x402-checkout] settled row ${row.id} has NO tx_signature — refusing replay (corruption)`,
    );
    return { ok: false as const, code: 'settle_failed' as const };
  }
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
    txSignature: row.txSignature,
    replay: true,
    fulfillment,
  };
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
