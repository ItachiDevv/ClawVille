---
name: land-money-contract
description: "Land's CT money paths: burn-sink priced buy (atomic, per-avatar advisory lock + FOR UPDATE), idempotency-key-REQUIRED upgrade (Codex BLOCK), server-priced-only, E5 parity on write+read+agent path, conservation/no-faucet."
category: economy
confidence: 0.9
date: 2026-06-22
---

# Land money contract (verified from `routes/land.ts` on origin/staging)

**CT-only, ledger-only.** Settlement via `claw-token-ledger` `debitClawTokens`. NEVER write
`avatars.clawTokens`. Founder tier = auction/USDC-only (`price_ct NULL` → buy 501); CT tiers
are `starter|c|b|a`.

**Burn-sink, not transfer.** The priced parcel buy and the structure upgrade DEBIT the buyer
with **no offsetting treasury credit** — a one-time CT sink by design (`land_transactions` row
records `debit_ledger_tx_id`, no credit leg). The free starter claim + free Lv1 placement write
`amount_ct = 0` audit rows with NO ledger touch. No land path mints CT (no faucet) — conserve.

**Atomic + single-charge, correct lock order.** Each money op is ONE `db.transaction`:
- `POST /parcels/:id/buy`: `pg_advisory_xact_lock(hashtext(avatarId))` (OUTER, serializes
  same-avatar) → `SELECT … FOR UPDATE` the parcel row (INNER) → assert `status='available'`
  (the flip to `owned` IS the idempotency key; a replay sees `owned` → 409) → assert
  `price_ct NOT NULL/>0` → `COUNT owner_avatar_id < MAX_PARCELS_PER_AVATAR` (under the advisory
  lock, since the cap spans many rows) → `debitClawTokens(price_ct, tx)` (throws
  `InsufficientTokensError` → 400) → flip ownership → insert `land_transactions`. Bust the
  for-sale + owned caches after commit; emit `LAND_EVENT_TYPES.PARCEL_PURCHASED`.
- `POST /structures/:id/upgrade`: advisory lock → `FOR UPDATE OF s, p` (lock structure AND its
  parcel) → OWNERSHIP FIRST against the AUTHORITATIVE `land_parcels.owner_avatar_id` (never the
  denorm alone; a drift → `ownership_desync` 409) → THEN idempotency replay. `idempotencyKey`
  is **REQUIRED** (Codex BLOCK HIGH — a keyless retry would be charged again as a fresh Lv+1).
  The `land_upgrades_idem_unique` index is GLOBAL on `idempotency_key` alone: a key already
  spent on a DIFFERENT structure → `idempotency_key_conflict` 409 (pre-debit); same structure →
  replay the cached result, no new debit. Cost = `STRUCTURE_UPGRADE_COSTS[level+1]`, server-
  derived off the freshly LOCKED level.

**Deadlock rule:** per-avatar advisory lock OUTER, row lock INNER, ALWAYS. Mirrors the cove +
the project `pattern_per_subject_serialization_mutex_plus_advisory`.

**Server-priced only.** Buy/upgrade bodies are `.strict()` empty (buy) / `{idempotencyKey}`
(upgrade) — NO client price/tier ever reaches a debit. Price = `land_parcels.price_ct`
(seed-stamped from `LAND_TIER_LADDER`).

**E5 parity — write + read + agent.** All writes resolve `requireAuthOrAgentSession` →
`identity.avatarId` (REAL for human Lucia cookie AND connected/hosted agent via
`X-Clawville-Agent-Session` → bound avatar; guest → 403, no fallback). Read seams (`/me`,
`/owned/:avatarId`) resolve the same. PARITY note in every PR. Phase 3 adds the agent ACTION
surface (tools.json + `[ACTION:]` whitelist + `PROTOCOL_VERSION`) — protected Hatcher surface,
Codex pass; settlement is unchanged (already binds to the agent's avatar).

**Tier gate on structures.** `isSkuAllowedForTier(catalogKey, type, parcel.tier)` server-side;
`getTierMaxLevel(tier)` caps upgrades below the global `MAX_STRUCTURE_LEVEL`. One structure per
parcel (UNIQUE on `parcel_id`, 23505 → `structure_exists` 409).

Related: [[world-economy-parity-gap]] · [[file-map-and-deployment-state]] · [[seed-is-manual-data]].
