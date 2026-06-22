---
name: buy-idempotency-race
description: "OPEN (UX-only, not a double-charge): the buy already-owned pre-check is outside the tx and the in-tx insert has no onConflictDoNothing/23505 catch -- two concurrent same-SKU buys surface a raw 500 instead of the idempotent 200."
category: gotcha
confidence: high
date: 2026-06-22
---

---
name: buy-idempotency-race
description: "Buy pre-check is pre-tx + insert has no onConflict catch -> concurrent same-SKU buy yields a 500, not the idempotent 200. NOT a double-charge. OPEN."
category: gotcha
confidence: 0.85
date: 2026-06-22
---

## Symptom
Under two concurrent same-SKU buys for the same avatar, one returns a raw 500 instead of the documented idempotent `200 {alreadyOwned:true}`.

## Root cause
- The already-owned short-circuit is a SELECT **outside** the transaction (`cosmetics.ts:295-308`).
- The in-tx insert is a bare `tx.insert(avatarSkins).values(...).returning()` (`cosmetics.ts:324-333`) with **no `.onConflictDoNothing`** on `(avatarId, skuId)` and no `23505` catch -- only `InsufficientTokensError` is caught (`:337`).
- The unique index `uniq_avatar_skin_avatar_sku` (schema `:196`) aborts the 2nd insert; the abort propagates as a 500.

## Important: NOT a double-charge
Because the insert is INSIDE the same `db.transaction` as the `debitClawTokens` debit, the unique-violation abort rolls the 2nd debit back too -- **CT conservation holds.** The bug is purely that the 500 violates the idempotent contract (the docstring promises re-buy -> 200).

## Fix
1. Make the insert `.onConflictDoNothing({ target: [avatarSkins.avatarId, avatarSkins.skuId] })`.
2. On 0 returned rows, re-read the owned row OUTSIDE the aborted tx and return `200 {alreadyOwned:true}`.
3. (Keep the pre-tx fast-path for the common already-owned case.)

## State
**OPEN.** Anchored at `cosmetics.ts:295-308` (pre-check) + `:324-333` (insert).

Related: [[ct-only-carve-out-not-marketplace]] (atomic-buy invariant).
