---
name: ledger-only-write-path
description: "The #1 static ban — avatars.clawTokens is written ONLY by claw-token-ledger.ts:96/133; every other CT move routes through credit/debit/transfer"
category: constraint
confidence: high
date: 2026-06-22
---

# Ledger-only write path (the #1 ban) — VERIFIED CLEAN 2026-06-22

**Rule:** real CT moves ONLY through `claw-token-ledger` (`creditClawTokens`/`debitClawTokens`/`transferClawTokens`) on `avatar.id`. The ONLY two direct `avatars.clawTokens` writes in the whole worktree are `claw-token-ledger.ts:96` (`creditInTx`) and `:133` (`debitInTx`), both inside the row-locked tx. NEVER a `.set({ clawTokens })` / raw `UPDATE avatars SET claw_tokens` anywhere else.

**Why:** a direct write bypasses the `SELECT ... FOR UPDATE` row-lock, the `balance >= amount` assert, AND the `claw_token_transactions` audit row — minting/vaporizing CT and breaking conservation + future on-chain replay.

**Allowed:** writing OTHER avatar columns in a `.set()` is fine — `items.ts:209` writes `characterConfig`, `xp-service.ts:56` writes `xp/level/totalXp`, `avatars.ts:1107` writes `loginStreak` (the CT credit goes through the ledger right after). A creation-time INSERT literal (guest grant `clawTokens:100`, `auth.ts:1011`) is allowed — creation ≠ balance mutation; the ban targets `.set()/UPDATE` of an EXISTING balance.

**Verification (run on EVERY economy PR):**
```
grep -rn '\.set(\s*{[^}]*clawTokens' apps packages   # non-ledger non-test hits = BUG
grep -rn 'claw_tokens\s*=' apps packages              # raw SQL UPDATE = BUG
```
Grep-verified ZERO app-code violations 2026-06-22; only matches outside the ledger are `__tests__/cove-blackjack.test.ts:187` + `cove-slots.test.ts:238` (seed fixtures) and `packages/database/scripts/grant-test-tokens.ts:45` (dev script). **State: CLEAN/ENFORCED.**

**Anchor:** `claw-token-ledger.ts:96,133`; header `:13-18`; `schema/treasury.ts:96-99`.

Related: `[[atomic-compose-into-caller-tx]]`, `[[conservation-by-construction]]`.
