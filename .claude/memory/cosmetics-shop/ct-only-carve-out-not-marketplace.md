---
name: ct-only-carve-out-not-marketplace
description: "INVARIANT: cosmetics is the first-party CT cosmetic carve-out (allowed) -- NOT peer commerce (marketplace/bazaar/auctions, 503-paused). It is a pure one-way CT SINK (buy debits, no offsetting credit, no faucet) and server-priced + ledger-only + atomic."
category: economy
confidence: high
date: 2026-06-22
---

---
name: ct-only-carve-out-not-marketplace
description: "Cosmetics = first-party CT carve-out (allowed), NOT paused peer commerce. Pure CT sink (debit-only, no faucet), server-priced, ledger-only, atomic."
category: economy
confidence: 0.95
date: 2026-06-22
---

## The carve-out vs the pause
- **Cosmetics IS allowed**: the first-party cosmetic shop (skins/hats/glasses/auras/boards/particles/emotes). Pricing in CT only.
- **Peer commerce IS paused** (503): `bazaar_listings`, `auctions`, `published_skills` -- owned by **marketplace-trade**, write handlers return 503.
- Conflating the two is a category error. Never add a cosmetic resale/gift-for-CT/peer-trade path -- that's marketplace-trade territory AND a faucet.

## Money invariants (mirror cove)
1. **CT-only, ledger-only.** Settle via `claw-token-ledger.debitClawTokens(...,tx)` (`cosmetics.ts:312`); NEVER write `avatars.clawTokens`. `exclusiveCurrency !== 'CT'` => 400 on `/buy` (`:284`); CLV/SOL/USDC/fiat route through a future Phase-4 path.
2. **Pure CT SINK, no faucet.** The buy is debit-only (`reason:'buy_cosmetic'`, `:319`) -- NO offsetting credit/treasury (like a burn). Conservation = debit-only. NEVER add a credit path that returns CT for a cosmetic. `acquiredVia` tracks provenance (`shop_ct`/`gift`/`reward`); gift/reward write provenance with no debit, never a CT credit to the recipient.
3. **Server-priced only.** Price read from `cosmetic_skus.price_ct`; the buy body carries nothing (`:skuId` is a path param). A client value must never reach the debit.
4. **Atomic + idempotent.** debit + `avatar_skins` insert in ONE `db.transaction` (`:311-343`); re-buy -> 200 `{alreadyOwned:true}` (`:295-308`), backed by `uniq_avatar_skin_avatar_sku`. (See [[buy-idempotency-race]] for the concurrent-buy 500 to fix.)
5. **Availability windows.** `/buy` enforces `availableFrom <= now < availableUntil`; `/catalog` applies the same filter. (supplyCap un-enforced -- see [[sku-needs-row-asset-mesh]].)

## State
**INVARIANT.** token-economy MEMORY confirms "cosmetics-shop -- first-party CT cosmetic debit (allowed carve-out, not peer commerce)."

Related: [[buy-idempotency-race]], [[e5-parity-gap-cosmetics]], [[sku-needs-row-asset-mesh]].
