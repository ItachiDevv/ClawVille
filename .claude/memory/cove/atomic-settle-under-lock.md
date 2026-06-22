---
name: atomic-settle-under-lock
description: "Every settle re-asserts ownership + re-loads the hand bound to (id,parentId) + recomputes the engine UNDER the parent FOR UPDATE lock — never trust pre-lock reads"
category: pattern
confidence: high
date: 2026-06-21
---

# Atomic settle under the parent lock (defense-in-depth)

Every cove settle (blackjack/baccarat/holdem; MTT register/settle) holds `SELECT ... FOR UPDATE` on the parent row (shoe/session/table/tournament) for the WHOLE transaction and does ALL of:

1. **Re-assert ownerMatch UNDER the lock** — the money fn never trusts the route's pre-check (`cove-blackjack.ts:1678-1680` 403 `settle_subject_mismatch`).
2. **Load the hand bound to `(id, shoeId)` not `id` alone** — prevents settling a victim hand on shoe B against the attacker's shoe-A balance (foreign handId → 409 `hand_shoe_mismatch`).
3. **Cursor/dealt drift assertion** — stored `cursorBefore`/`dealtBefore` MUST equal reconstructed, else 500 `shoe_counter_drift_at_settle` (`:1738-1746`).
4. **Recompute the engine UNDER the lock** (`:1747-1764`) — a stale pre-lock `spinResult`/`handResult` can NEVER commit a divergent outcome. The engine is recomputed even if nonce/cursor/mode drifted between the pre-lock snapshot and the tx (`cove-slots.ts:1114-1152`).
5. MAX_SAFE_INTEGER guards on payout/bet, then ledger debit (incremental delta only — base stake was debited at deal) + credit RAKED payout.
6. Compare-and-set status flip + insert one `cove_game_events` row (revealedServerSeed NULL until close) + advance counters.

**Deal-side reservation:** `handCounter` strictly +1 per deal reserves `(shoeId, handIndex)`; a shoe has AT MOST ONE `in_progress` hand (`hand_in_progress` guard). `expectedHandsPlayed` is an optional stale-agent-deal guard (409 `stale_agent_deal`).

**Rate-limit:** `subjectKey` keys user+agent on the SAME `userId` bucket — can't dodge the limit by toggling cookie vs agent header on one avatar.

Related: [[conservation-and-idempotency-patterns]], [[subject-keying-keystone]].
