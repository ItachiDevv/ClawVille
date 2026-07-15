/**
 * COSMETIC PURCHASE FULFILLER (Tokenomics C — checkout stage, 2026-07-07).
 *
 * Lets a human or connected/hosted agent buy a CT-priced cosmetic SKU with
 * REAL USDC through the generic x402 checkout. Registers itself on import
 * (side-effect) — `routes/x402-checkout.ts` imports this module, so mounting
 * the route wires the fulfiller.
 *
 * ── CONSERVATION MODEL (trap 2b — the exact rule) ───────────────────────────
 * The buyer paid USDC to the merchant wallet. Therefore this fulfiller:
 *   - debits ZERO internal vCLAW from the buyer (they paid dollars, not vCLAW);
 *   - mints ZERO internal vCLAW anywhere — in particular it does NOT credit
 *     the house-treasury AVATAR the way the CT balance-buy does. The balance-
 *     buy's treasury credit is a net-neutral TRANSFER (buyer debit == treasury
 *     credit); here there is no buyer debit, so a treasury credit would be an
 *     UNBACKED FAUCET. The treasury's revenue on this rail is the on-chain
 *     USDC itself, owed to the market as a CLV buy via `enqueueClvBuy` (the
 *     C3 queue) — recorded in the SAME settle tx, executed later by the
 *     (dry-run-gated) swap executor.
 *   - records the settlement's usd_basis on the `x402_checkouts` row (the
 *     service does this in the same tx) — the audit trail of the dollars.
 *
 * The skin grant reuses the SHARED helpers extracted from
 * `routes/cosmetics.ts` (`checkSkuPurchasable` / `grantSkinInTx`) so the two
 * rails can never drift on validation or grant semantics.
 *
 * Race handling: the QUOTE resolver + the registered settle PREFLIGHT both
 * reject an already-owned or already-sold-out SKU BEFORE any money moves. If
 * the final unit sells in the sub-second window after facilitator settlement,
 * the checkout enters the durable manual-refund path; it never silently grants
 * an oversold unit or enqueues the downstream buy.
 */

import {
  registerFulfiller,
  registerCheckoutPreflight,
  CheckoutFulfillmentRefusal,
  type CheckoutFulfiller,
  type CheckoutPreflight,
} from '../x402-checkout';
import {
  checkSkuPurchasable,
  CosmeticSoldOutError,
  findOwnedSkin,
  grantSkinInTx,
} from '../../routes/cosmetics';
import { enqueueClvBuy } from '../clv-swap-executor';

/** Kind-specific quote refusals the route maps to HTTP statuses. */
export type CosmeticCheckoutRefusal =
  | 'not_found'
  | 'not_yet_available'
  | 'no_longer_available'
  | 'wrong_currency'
  | 'sold_out'
  | 'zero_price'
  | 'already_owned';

export type CosmeticCheckoutItem =
  | { ok: true; priceVclaw: number; slug: string }
  | { ok: false; code: CosmeticCheckoutRefusal };

/**
 * QUOTE-TIME resolver — the route calls this to price the item SERVER-SIDE
 * (the client never supplies a cosmetic price). Read-only.
 */
export async function resolveCosmeticCheckoutItem(
  avatarId: string,
  skuId: string,
): Promise<CosmeticCheckoutItem> {
  const purchasable = await checkSkuPurchasable(skuId);
  if (!purchasable.ok) {
    if (purchasable.code === 'sold_out') {
      // Preserve quote idempotency for the owner of the final unit.
      const owned = await findOwnedSkin(avatarId, skuId);
      return { ok: false, code: owned ? 'already_owned' : 'sold_out' };
    }
    return { ok: false, code: purchasable.code };
  }
  // AMOUNT DISCIPLINE: a 0-price SKU is a legit FREE grant on the balance
  // rail, but a USDC checkout for $0.00 is unquotable (the x402 requirement
  // rejects a non-positive amount) — refuse BEFORE any row exists.
  if (!Number.isInteger(purchasable.sku.priceCt) || purchasable.sku.priceCt <= 0) {
    return { ok: false, code: 'zero_price' };
  }
  const owned = await findOwnedSkin(avatarId, skuId);
  if (owned) return { ok: false, code: 'already_owned' };
  return { ok: true, priceVclaw: purchasable.sku.priceCt, slug: purchasable.sku.slug };
}

/** Settle-time READ-ONLY preflight — same checks, run just before the
 *  facilitator call so nothing that died since the quote can take USDC. */
const cosmeticPreflight: CheckoutPreflight = async ({ subject, itemRef }) => {
  const item = await resolveCosmeticCheckoutItem(subject.avatarId, itemRef);
  return item.ok ? { ok: true } : { ok: false, code: item.code };
};

const cosmeticFulfiller: CheckoutFulfiller = async (ctx) => {
  // 1) Grant the skin — shared idempotent helper, INSIDE the settle tx.
  //    acquiredVia 'shop_usdc' (already a documented avatar_skins provenance
  //    value); ledgerId null BY DESIGN — there is NO CT debit ledger row on
  //    this rail (the x402_checkouts row + tx signature is the money audit).
  let grant: Awaited<ReturnType<typeof grantSkinInTx>>;
  try {
    grant = await grantSkinInTx(ctx.tx, {
      avatarId: ctx.subject.avatarId,
      skuId: ctx.itemRef,
      acquiredVia: 'shop_usdc',
      ledgerId: null,
    });
  } catch (err) {
    if (err instanceof CosmeticSoldOutError) {
      throw new CheckoutFulfillmentRefusal('sold_out', 'cosmetic_sold_out_after_settlement');
    }
    throw err;
  }

  // 2) Record the owed USDC→CLV buy in the SAME tx (commits/rolls back with
  //    the settle). µUSD decimal string per the C3 seam contract.
  await enqueueClvBuy(
    {
      amountUsdc: (ctx.usdCents / 100).toFixed(6),
      reason: 'checkout_cosmetic',
      sourceRef: ctx.checkoutId,
      metadata: {
        itemRef: ctx.itemRef,
        avatarId: ctx.subject.avatarId,
        subjectKind: ctx.subject.kind,
        txSignature: ctx.txSignature,
      },
    },
    ctx.tx,
  );

  // NO ledger call anywhere above — this fulfiller imports NOTHING from
  // claw-token-ledger. The unit tests assert zero credit/debit/mintEarned.
  return {
    fulfilled: true,
    detail: {
      avatarSkinId: grant.avatarSkinId,
      alreadyOwned: grant.alreadyOwned,
      skuId: ctx.itemRef,
    },
  };
};

registerFulfiller('cosmetic_purchase', cosmeticFulfiller);
registerCheckoutPreflight('cosmetic_purchase', cosmeticPreflight);
