---
name: jsonb-verifier-false-negative
description: "Provably-fair /verify reported every honest stored hand as rigged because jsonb reorders object keys — fixed with canonicalize()/canonicalJsonEq"
category: solution
confidence: high
date: 2026-06-21
---

# Provably-fair verifier false-negative (FIXED on prod)

**Bug:** Postgres `jsonb` does NOT preserve object key order (it sorts by length then bytewise). The verifier compared engine output to the jsonb-stored `outcomeJson` with a raw `JSON.stringify` equality, so EVERY fair stored row reported `verified:false` — telling honest players the game was rigged.

**Fix:** `services/cove-verify-compat.ts:79-104` — `canonicalize()` recursively SORTS object keys but PRESERVES array order (cards/reels/winningLines are order-significant). `canonicalJsonEq` is the shared equality op used by every per-game comparator. Commit `48cc6be9` (the prompt's '#142/#144' maps to this landed commit). ON PROD + staging.

**Back-compat tolerance (same file):** `blackjackOutcomesMatch`/`holdemOutcomesMatch` STRIP rake keys from both sides when the stored row predates the 2026-05-29 rake fix; `baccaratOutcomesMatch`/`oldBaccaratSettle` accept EITHER the new floored-winnings formula OR the old commission formula so pre-fix banker wins still verify true. `engineVersion`/`slot_spins.paytable_version` pin replay against the historical engine after retunes.

**GOTCHA — unit tests won't catch a regression:** tests build the 'stored' side with JS literals that PRESERVE insertion order, so they will NOT reproduce the jsonb reorder. **Add an explicit key-shuffle test for any new verifier branch.**

**verified:null ≠ false:** open shoe (revealedServerSeed NULL) and `engine-not-yet-shipped` both return `null`, not a fairness failure.

**STALENESS:** the `feat/poker-mtt-tournament` working tree's `cove-verify-compat.ts` LACKS `canonicalize`/`canonicalJsonEq` — read via `git show origin/master:`. Related: [[working-tree-staleness-trap]], [[commit-reveal-no-board-leak]].
