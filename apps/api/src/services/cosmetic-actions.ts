/**
 * COSMETIC ACTIONS — the context-free cosmetic shop business logic
 * (extracted from `routes/cosmetics.ts`, 2026-10-22 quests wire).
 *
 * WHY: a hosted agent acts only through `[ACTION:]` verbs that the server runs
 * in `npc-simulation.ts` (no HTTP request, no Hono Context). The verbs
 * `buy_cosmetic` / `equip_cosmetic` must run the SAME logic as
 * `POST /api/cosmetics/:skuId/buy` and `POST /api/cosmetics/:skuId/{equip,unequip}`,
 * so that logic lives here and BOTH callers use it. The REST handlers are thin
 * adapters: identity -> actor, request -> input/meta, result -> c.json.
 *
 * IMPORT RULE: this module must NEVER import a route or a middleware that
 * pulls `npc-simulation.ts` (`require-auth-or-agent.ts` does). The executor
 * imports this module, so such an import is a load-time cycle (TDZ). The only
 * middleware import is `isGuestUser` from `require-non-guest.ts`, whose own
 * middleware imports are type-only.
 *
 * FAILURE CONTRACT: a failure WITH `body` is a JSON response (`c.json(body,
 * status)`); a failure WITHOUT `body` is what the route always threw as an
 * `HTTPException(status, { message })`. The route keeps that split so every
 * REST status and body stays byte-identical.
 *
 * The shared purchase helpers (`checkSkuPurchasable`, `findOwnedSkin`,
 * `grantSkinInTx`, `CosmeticSoldOutError`) also serve the x402 USDC checkout
 * fulfiller (`checkout-fulfillers/cosmetic-purchase.ts`): two payment rails,
 * one item path. Neither helper moves value.
 */

import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { REWARD_ONLY_COSMETIC_CURRENCY } from '@clawville/shared';
import { db, cosmeticSkus, avatarSkins, avatars, events } from '@clawville/database';
import { logEvent } from './event-logger';
import {
  creditClawTokens,
  debitClawTokens,
  InsufficientTokensError,
  type LedgerTx,
} from './claw-token-ledger';
import { getHouseTreasuryAvatarId } from './house-treasury-seeder';
import { spendCosmeticBonusInTx } from './cosmetic-signup-bonus';
import { isGuestUser } from '../middleware/require-non-guest';

// ---------------------------------------------------------------------------
// Public types (worker D's executor codes against these)
// ---------------------------------------------------------------------------

export interface CosmeticActor {
  kind: 'user' | 'agent';
  userId: string;
  avatarId: string;
  agentId?: string | null;
  /**
   * Agent actors only: the session proved ownership of its bound avatar. An
   * agent actor is refused (403) unless this is exactly `true` (fail closed),
   * the same rule as `requireLedgerCapableIdentity`. Ignored for `user`.
   */
  ledgerCapable?: boolean;
}

/** The anti-farm tags `logEventFromContext` derives from a request. REST
 *  passes them; the `[ACTION:]` executor passes nothing (rows stay untagged,
 *  like every system write). */
export interface CosmeticEventMeta {
  fpHash?: string | null;
  ipPrefixHash?: string | null;
}

export type CosmeticActionFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
  body?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Shared purchase helpers (Tokenomics C checkout stage, 2026-07-07)
// ---------------------------------------------------------------------------

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const skuIdSchema = z.string().regex(uuidRegex);

export class CosmeticSoldOutError extends Error {
  constructor(public readonly skuId: string) {
    super('cosmetic_sold_out');
    this.name = 'CosmeticSoldOutError';
  }
}

export type SkuPurchasabilityCheck =
  | { ok: true; sku: typeof cosmeticSkus.$inferSelect }
  | {
      ok: false;
      code: 'not_found' | 'not_yet_available' | 'no_longer_available' | 'wrong_currency' | 'sold_out';
      /** For wrong_currency: the currency the SKU demands. */
      requiredCurrency?: string;
    };

async function countCosmeticOwnerships(skuId: string, tx?: LedgerTx): Promise<number> {
  const runner = tx ?? db;
  const rows = await runner
    .select({ ownershipCount: sql<number>`COUNT(*)::integer` })
    .from(avatarSkins)
    .where(eq(avatarSkins.skuId, skuId))
    .limit(1);
  return Number(rows[0]?.ownershipCount ?? 0);
}

/**
 * Validate a SKU is purchasable RIGHT NOW on a CT-denominated rail: exists,
 * inside its availability window, and not exclusive to a non-CT currency.
 * Behavior-identical to the checks the balance-buy always ran. Read-only.
 */
export async function checkSkuPurchasable(skuId: string): Promise<SkuPurchasabilityCheck> {
  if (!skuIdSchema.safeParse(skuId).success) return { ok: false, code: 'not_found' };
  const sku = await db.query.cosmeticSkus.findFirst({ where: eq(cosmeticSkus.id, skuId) });
  if (!sku) return { ok: false, code: 'not_found' };
  if (sku.exclusiveCurrency === REWARD_ONLY_COSMETIC_CURRENCY) {
    return { ok: false, code: 'wrong_currency', requiredCurrency: REWARD_ONLY_COSMETIC_CURRENCY };
  }
  const now = new Date();
  if (sku.availableFrom && sku.availableFrom > now) {
    return { ok: false, code: 'not_yet_available' };
  }
  if (sku.availableUntil && sku.availableUntil <= now) {
    return { ok: false, code: 'no_longer_available' };
  }
  if (sku.exclusiveCurrency && sku.exclusiveCurrency !== 'CT') {
    // CLV / SOL / fiat exclusives are not buyable on either CT-denominated
    // rail (balance OR the ¢-pegged USDC checkout) — they go through a
    // currency-specific path (Phase 4 follow-up).
    return { ok: false, code: 'wrong_currency', requiredCurrency: sku.exclusiveCurrency };
  }
  // During a rolling deploy, an old pod can grant ownership after the migration
  // backfill but before every pod increments sold_count. Treat the live ledger
  // count as authoritative whenever it is ahead of the monotonic counter.
  if (sku.supplyCap !== null) {
    const ownershipCount = await countCosmeticOwnerships(skuId);
    if (Math.max(sku.soldCount, ownershipCount) >= sku.supplyCap) {
      return { ok: false, code: 'sold_out' };
    }
  }
  return { ok: true, sku };
}

/** Read-only ownership probe (outside or inside a tx). */
export async function findOwnedSkin(
  avatarId: string,
  skuId: string,
  tx?: LedgerTx,
): Promise<{ id: string; equipped: boolean } | null> {
  const runner = tx ?? db;
  const rows = await runner
    .select({ id: avatarSkins.id, equipped: avatarSkins.equipped })
    .from(avatarSkins)
    .where(and(eq(avatarSkins.avatarId, avatarId), eq(avatarSkins.skuId, skuId)))
    .limit(1);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Idempotently grant a skin INSIDE the caller's transaction. Uses ON CONFLICT
 * DO NOTHING on the `uniq_avatar_skin_avatar_sku` index so a concurrent
 * double-grant can never 23505-poison the surrounding money tx — the loser
 * reads the winner's row and reports `alreadyOwned: true`. The caller decides
 * what alreadyOwned means for ITS money model (the balance-buy rolls back its
 * debit; the USDC fulfiller records a no-op grant — the payment already
 * settled).
 */
export async function grantSkinInTx(
  tx: LedgerTx,
  input: {
    avatarId: string;
    skuId: string;
    /** Provenance for revenue audits — 'shop_ct' | 'shop_usdc' | … */
    acquiredVia: string;
    /** Ledger row of the CT debit (balance-buy) — null on non-CT rails. */
    ledgerId: string | null;
  },
): Promise<{ avatarSkinId: string; alreadyOwned: boolean }> {
  let inserted: Array<{ id: string }>;
  try {
    inserted = await tx
      .insert(avatarSkins)
      .values({
        avatarId: input.avatarId,
        skuId: input.skuId,
        acquiredVia: input.acquiredVia,
        ledgerId: input.ledgerId,
        equipped: false,
      })
      .onConflictDoNothing({ target: [avatarSkins.avatarId, avatarSkins.skuId] })
      .returning({ id: avatarSkins.id });
  } catch (err) {
    const dbError = err as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
    const constraint = dbError.constraint_name ?? dbError.constraint;
    if (dbError.code === '23514' && constraint === 'cosmetic_skus_supply_cap_enforced') {
      throw new CosmeticSoldOutError(input.skuId);
    }
    throw err;
  }
  if (inserted.length > 0) {
    // Migration 0032's AFTER INSERT trigger is the inventory boundary for
    // every writer, including old pods. It serializes on cosmetic_skus and
    // raises the named CHECK violation before a capped SKU can oversell.
    return { avatarSkinId: inserted[0].id, alreadyOwned: false };
  }
  const existing = await findOwnedSkin(input.avatarId, input.skuId, tx);
  if (!existing) {
    // Conflict fired yet no row visible — only possible if the owning tx is
    // still uncommitted elsewhere. Surface it; the caller's tx rolls back.
    throw new Error(`grantSkinInTx: conflict without visible row (avatar=${input.avatarId} sku=${input.skuId})`);
  }
  return { avatarSkinId: existing.id, alreadyOwned: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** In-tx control-flow signal: the skin turned out to be owned AFTER the debit
 *  ran (a concurrent double-buy race). Thrown to roll the WHOLE tx back
 *  (debit + treasury credit included) and answer alreadyOwned — previously
 *  this race 23505'd into a 500. Module-private. */
class AlreadyOwnedRace extends Error {
  constructor(public readonly avatarSkinId: string) {
    super('cosmetic_already_owned_race');
    this.name = 'AlreadyOwnedRace';
  }
}

/** Same JSON `requireNonGuestIdentity` answers (founder ruling 2026-07-06). */
const GUEST_BLOCKED_MESSAGE = 'Guests run a demo economy. Create a free account to use this feature.';

const AGENT_NOT_LEDGER_MESSAGE =
  'agent_session_not_ledger_authorized: prove avatar ownership before using a ledger or custodial-money route';

function fail(
  status: number,
  code: string,
  message: string,
  body?: Record<string, unknown>,
): CosmeticActionFailure {
  return body ? { ok: false, status, code, message, body } : { ok: false, status, code, message };
}

/** `requireLedgerCapableIdentity` for a context-free caller: an agent actor
 *  must carry `ledgerCapable: true`. */
function ledgerRefusal(actor: CosmeticActor): CosmeticActionFailure | null {
  if (actor.kind === 'agent' && actor.ledgerCapable !== true) {
    return fail(403, 'agent_session_not_ledger_authorized', AGENT_NOT_LEDGER_MESSAGE);
  }
  return null;
}

function eventTags(meta?: CosmeticEventMeta): { fpHash: string | null; ipPrefixHash: string | null } {
  return { fpHash: meta?.fpHash ?? null, ipPrefixHash: meta?.ipPrefixHash ?? null };
}

// ---------------------------------------------------------------------------
// BUY — the CT balance rail (POST /api/cosmetics/:skuId/buy)
// ---------------------------------------------------------------------------
//
// Spends ClawTokens to acquire the SKU and inserts an avatar_skins row.
// Idempotent: re-buying an already-owned SKU returns `{ alreadyOwned: true }`
// and does NOT debit again. Atomicity: bonus draw + debit + treasury credit +
// grant run in ONE db.transaction(); a failed grant rolls the debit back.

/**
 * Buy a cosmetic for a human or an agent actor. `input.variantId` is accepted
 * for the executor signature and NOT used: the REST buy has no variant choice
 * (the owned SKU carries every rig variant; the loader picks one at render).
 * Guest owners are refused (demo economy); agent actors need `ledgerCapable`.
 */
export async function buyCosmeticForActor(
  actor: CosmeticActor,
  input: { skuId: string; variantId?: string | null },
  meta?: CosmeticEventMeta,
): Promise<{ ok: true; body: Record<string, unknown> } | CosmeticActionFailure> {
  const ledger = ledgerRefusal(actor);
  if (ledger) return ledger;
  // A guest arrives as a human OR as the owner of an agent it connected; both
  // stay demo-only (same check as requireNonGuestIdentity).
  if (actor.userId && (await isGuestUser(actor.userId))) {
    return fail(403, 'guest_not_allowed', GUEST_BLOCKED_MESSAGE, {
      error: GUEST_BLOCKED_MESSAGE,
      code: 'guest_not_allowed',
    });
  }

  const skuId = input.skuId;
  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.id, actor.avatarId), eq(avatars.isActive, true)),
  });
  if (!avatar) return fail(404, 'no_active_avatar', 'No active avatar found');

  // SKU must exist, be inside its availability window, and be CT-buyable —
  // the SAME shared check the USDC checkout fulfiller runs.
  const purchasable = await checkSkuPurchasable(skuId);
  if (!purchasable.ok) {
    switch (purchasable.code) {
      case 'not_found':
        return uuidRegex.test(skuId)
          ? fail(404, 'not_found', 'Cosmetic not found')
          : fail(400, 'invalid_sku_id', 'Invalid skuId');
      case 'not_yet_available':
        return fail(400, 'not_yet_available', 'Not yet available');
      case 'no_longer_available':
        return fail(400, 'no_longer_available', 'No longer available');
      case 'wrong_currency':
        return fail(400, 'wrong_currency', `This item must be purchased with ${purchasable.requiredCurrency}.`);
      case 'sold_out': {
        // Idempotent retries by the owner of the final unit still succeed.
        const existing = await findOwnedSkin(avatar.id, skuId);
        if (existing) {
          return {
            ok: true,
            body: {
              ok: true,
              alreadyOwned: true,
              avatarSkinId: existing.id,
              equipped: existing.equipped,
              clawTokens: avatar.clawTokens,
            },
          };
        }
        return fail(409, 'sold_out', 'Sold out', { error: 'sold_out' });
      }
    }
  }
  const sku = purchasable.sku;

  // Idempotent: already owned ⇒ `{ alreadyOwned: true }`, no debit.
  const existing = await findOwnedSkin(avatar.id, skuId);
  if (existing) {
    return {
      ok: true,
      body: {
        ok: true,
        alreadyOwned: true,
        avatarSkinId: existing.id,
        equipped: existing.equipped,
        clawTokens: avatar.clawTokens,
      },
    };
  }

  // Atomic bonus-draw + debit + insert.
  let result: { balanceAfter: number; avatarSkinId: string; grantUsed: number; realCt: number };
  try {
    result = await db.transaction(async (tx) => {
      // ── A2 cosmetics-scoped signup bonus (2026-07-07) ───────────────────
      // Draw the one-time signup-bonus grant FIRST (row-locked, in-tx). It is a
      // scoped promo that lives OUTSIDE avatars.clawTokens (schema/cosmetic-
      // bonus.ts), so it can only be spent HERE. Only the REAL-CT remainder is
      // debited from the buyer + routed to the treasury below — the grant
      // portion mints NOTHING (a house-eaten marketing expense). Rolls back with
      // the whole tx on any failure, so a failed purchase never consumes it.
      const grantUsed = await spendCosmeticBonusInTx(tx, actor.userId, sku.priceCt);
      const realCt = sku.priceCt - grantUsed;

      // Debit only the real-CT remainder. Skip entirely when the grant fully
      // covers the price (debitClawTokens rejects a non-positive amount).
      let debitLedgerId: string | null = null;
      let balanceAfter = avatar.clawTokens; // unchanged when fully grant-funded
      if (realCt > 0) {
        const debit = await debitClawTokens(
          {
            avatarId: avatar.id,
            amount: realCt,
            reason: 'buy_cosmetic',
            source: 'api',
            metadata: { skuId, slug: sku.slug, category: sku.category, grantUsed, priceCt: sku.priceCt },
            actorKind: actor.kind === 'user' ? 'human' : 'agent',
          },
          tx,
        );
        debitLedgerId = debit.ledgerId;
        balanceAfter = debit.balanceAfter;

        // ── T0 fee routing (2026-07-07): shop revenue → house treasury ────
        // Credit ONLY the real-CT remainder to the treasury (debit == credit =
        // net-neutral supply; the CT moves player→treasury). CONSERVATION: the
        // grant portion is NOT credited here — crediting the full priceCt while
        // only debiting realCt would MINT `grantUsed` into the treasury. The
        // `alreadyOwned` replay returns before this tx, so a re-buy never
        // re-credits. A null treasury degrades to the pre-T0 burn — never
        // blocks the purchase.
        const treasuryId = await getHouseTreasuryAvatarId();
        if (treasuryId) {
          await creditClawTokens(
            {
              avatarId: treasuryId,
              amount: realCt,
              reason: 'house_fee_cosmetic_purchase',
              source: 'system',
              metadata: { skuId, slug: sku.slug, buyerAvatarId: avatar.id, grantUsed, priceCt: sku.priceCt },
              actorKind: 'system',
            },
            tx,
          );
        } else {
          console.error(
            `[cosmetics] house treasury unavailable — ${realCt} CT purchase burned (pre-T0 behavior) for sku ${skuId}`,
          );
        }
      }

      // Shared idempotent grant. ledgerId is null when fully bonus-funded (no
      // debit ledger row) — the cosmetic.purchased event records
      // grantUsed/realCt for the audit. If a concurrent buy won the grant
      // while we were debiting, roll the WHOLE tx back (debit + treasury
      // credit) and answer alreadyOwned instead of the old 23505→500.
      const grant = await grantSkinInTx(tx, {
        avatarId: avatar.id,
        skuId: sku.id,
        acquiredVia: 'shop_ct',
        ledgerId: debitLedgerId,
      });
      if (grant.alreadyOwned) {
        throw new AlreadyOwnedRace(grant.avatarSkinId);
      }
      return { balanceAfter, avatarSkinId: grant.avatarSkinId, grantUsed, realCt };
    });
  } catch (err) {
    if (err instanceof CosmeticSoldOutError) {
      return fail(409, 'sold_out', 'Sold out', { error: 'sold_out' });
    }
    if (err instanceof AlreadyOwnedRace) {
      return {
        ok: true,
        body: {
          ok: true,
          alreadyOwned: true,
          avatarSkinId: err.avatarSkinId,
          // The concurrent winner inserts with equipped:false; equip is a
          // separate endpoint, so this is exact, not a guess.
          equipped: false,
          clawTokens: avatar.clawTokens,
        },
      };
    }
    if (err instanceof InsufficientTokensError) {
      // `err.requested` is the real-CT remainder we tried to debit (after the
      // bonus), `err.available` the buyer's balance — report those, not priceCt.
      return fail(400, 'insufficient_tokens', `Not enough vCLAW. Need ${err.requested}, have ${err.available}.`);
    }
    throw err;
  }

  // Fire-and-forget (logEvent never throws). `cosmetic.purchased` is the proof
  // the `style-statement` tutorial quest reads, for a human AND an agent.
  void logEvent({
    eventType: 'cosmetic.purchased',
    userId: actor.userId,
    avatarId: avatar.id,
    payload: {
      skuId: sku.id,
      slug: sku.slug,
      category: sku.category,
      pricePaid: sku.priceCt,
      // A2 — split the price into the real CT charged vs the signup-bonus
      // covered portion (the treasury only received `realCt`).
      bonusApplied: result.grantUsed,
      realCtCharged: result.realCt,
      balanceAfter: result.balanceAfter,
      // Who bought, like `cosmetic.equipped` and `wallet.viewed`. Payload
      // only: the event's agentId column and scoring inputs are unchanged.
      subjectKind: actor.kind,
    },
    ...eventTags(meta),
  });

  return {
    ok: true,
    body: {
      ok: true,
      alreadyOwned: false,
      avatarSkinId: result.avatarSkinId,
      clawTokens: result.balanceAfter,
      // A2 — how much of the price the cosmetics signup bonus covered (0 when none).
      bonusApplied: result.grantUsed,
    },
  };
}

// ---------------------------------------------------------------------------
// EQUIP / UNEQUIP (POST /api/cosmetics/:skuId/{equip,unequip})
// ---------------------------------------------------------------------------

/**
 * Set the equipped flag on an OWNED skin. Idempotent (equipping an equipped
 * SKU returns the same state). Guests MAY equip: this touches no ledger, so
 * there is no guest check here. Agent actors need `ledgerCapable` (the REST
 * routes run `requireLedgerCapableIdentity`).
 */
export async function setCosmeticEquippedForActor(
  actor: CosmeticActor,
  skuId: string,
  equipped: boolean,
  meta?: CosmeticEventMeta,
): Promise<{ ok: true; equipped: boolean } | CosmeticActionFailure> {
  const ledger = ledgerRefusal(actor);
  if (ledger) return ledger;
  if (!skuIdSchema.safeParse(skuId).success) {
    return fail(400, 'invalid_sku_id', 'Invalid skuId');
  }

  // Update only if the row exists.
  const result = await db
    .update(avatarSkins)
    .set({
      equipped,
      equippedAt: equipped ? new Date() : null,
    })
    .where(and(eq(avatarSkins.avatarId, actor.avatarId), eq(avatarSkins.skuId, skuId)))
    .returning();

  if (result.length === 0) {
    return fail(404, 'not_owned', 'You do not own this cosmetic.', {
      ok: false,
      error: 'not_owned',
      message: 'You do not own this cosmetic.',
    });
  }

  // Telemetry — equipping is a meaningful engagement signal. Fire-and-forget
  // (logEvent never throws). `cosmetic.equipped` is also the proof the
  // `style-statement` and `inventory-in-action` tutorial quests read, so it
  // carries the bound avatar for a human AND for an agent.
  void logEvent({
    eventType: equipped ? 'cosmetic.equipped' : 'cosmetic.unequipped',
    userId: actor.userId,
    avatarId: actor.avatarId,
    payload: {
      skuId,
      subjectKind: actor.kind,
      equippedAt: equipped ? new Date().toISOString() : null,
    },
    ...eventTags(meta),
  });

  return { ok: true, equipped: result[0].equipped };
}

// ---------------------------------------------------------------------------
// USDC checkout rail — the purchase event (checkout-fulfillers/cosmetic-purchase.ts)
// ---------------------------------------------------------------------------

/**
 * Record `cosmetic.purchased` for a USDC checkout grant INSIDE the settle tx,
 * under a SAVEPOINT. Why in-tx: the checkout service has no after-commit hook,
 * and the fulfiller can run, roll back, and run again on resume. In the tx,
 * the row commits exactly when the grant commits, and a rolled-back attempt
 * leaves no row. Why a savepoint: an events-insert failure rolls back only the
 * savepoint, so the paid grant still settles (the event is best-effort).
 *
 * Call it only for a FRESH grant (`alreadyOwned === false`): a fresh grant
 * happens once per (avatar, sku), so the event is once per fulfilment. Never
 * throws. Writes only to `events`; moves no value (`realCtCharged: 0`).
 * `subject_was_guest` stays NULL (the leaderboard CTE's live-join backstop);
 * the checkout route already refuses guests.
 */
export async function recordUsdcCosmeticPurchaseInTx(
  tx: LedgerTx,
  input: {
    checkoutId: string;
    userId: string | null;
    avatarId: string;
    subjectKind: 'user' | 'agent';
    skuId: string;
    avatarSkinId: string;
    priceVclaw: number;
    usdCents: number;
  },
): Promise<void> {
  try {
    await tx.transaction(async (sp) => {
      await sp.insert(events).values({
        eventType: 'cosmetic.purchased',
        userId: input.userId,
        avatarId: input.avatarId,
        payload: {
          skuId: input.skuId,
          avatarSkinId: input.avatarSkinId,
          rail: 'usdc',
          checkoutId: input.checkoutId,
          subjectKind: input.subjectKind,
          pricePaid: input.priceVclaw,
          usdCents: input.usdCents,
          bonusApplied: 0,
          realCtCharged: 0,
        },
        fpHash: null,
        ipPrefixHash: null,
      });
    });
  } catch (err) {
    console.warn(
      `[cosmetics] cosmetic.purchased (usdc) record failed; grant unaffected. checkout=${input.checkoutId}`,
      err,
    );
  }
}
