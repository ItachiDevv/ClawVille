---
name: known-traps
description: "The anchored CT-economy trap list — ledger-only write, atomic+composable, faucet, on-ramp double-credit, @x402-not-@payai, CLV-floor — each with trigger + fix + file:line + FIXED/OPEN"
category: gotcha
confidence: high
date: 2026-06-22
---

# CT economy known traps (trigger → fix → anchor → state)

### T1 — Raw `avatars.clawTokens` write outside the ledger (the #1 ban) — VERIFIED CLEAN
- **Trigger:** any `.set({ clawTokens })` / `UPDATE avatars SET claw_tokens` outside `claw-token-ledger.ts`.
- **Fix:** route through `creditClawTokens`/`debitClawTokens`/`transferClawTokens`. Writing OTHER avatar columns (xp/level/characterConfig/loginStreak) is allowed — only `clawTokens` is reserved (`items.ts:209` writes characterConfig, `xp-service.ts:56` writes xp/level, `avatars.ts:1107` writes loginStreak — all FINE; the token credit goes through the ledger right after).
- **Anchor:** `claw-token-ledger.ts:96,133` (the only legit writes). Grep verified ZERO app-code violations 2026-06-22; only matches outside the ledger are `__tests__/*` fixtures and `packages/database/scripts/grant-test-tokens.ts` (dev script). **FIXED/clean.**

### T2 — Non-composing settle loses atomicity
- **Trigger:** calling `creditClawTokens`/`debitClawTokens` WITHOUT the `tx` arg from inside a route that already opened `db.transaction` → the game/inventory/order row and the ledger row commit independently; partial failure diverges balance from state.
- **Fix:** pass the caller's `tx` as the 2nd arg so debit + state-row + credit are ONE atomic unit. `InsufficientTokensError` aborts the whole tx (no partial write).
- **Anchor:** `claw-token-ledger.ts:158-176` (`tx?` param → `creditInTx`/`debitInTx`); correct usage `items.ts:96-128`, `exchange.ts:205-237,273-334,447-517`, `land.ts:911`, all cove settle paths. `transferClawTokens` is itself one tx (`:190-206`). **PATTERN — enforced.**

### T3 — Faucet: credit with no matching debit / house-opponent not treasury-backed
- **Trigger:** a SETTLEMENT credit with no corresponding debit, OR a seeded/bot opponent whose chips aren't backed by a house-bank debit → skilled play net-mints CT.
- **Fix:** conserve (`Σdebit==Σcredit+rake`); treasury-debit any house counterparty. Cash poker THROWS `seeded_agent_requires_house_bank` without a `houseBankAvatarProvider`. **DISTINGUISH from designed faucets** (`daily_login`/`level_up`/`building_visit`/chat rewards) which are legitimate emission.
- **Anchor:** holdem vs-bot bots mint synthetic stacks (rake bounds, full fix DEFERRED) — **OPEN on prod**; baccarat commission floored-down faucet **FIXED** (`baccarat-engine.ts:497-519`, floor player WINNINGS not commission). Monitor: `GET /api/cove/economy/summary` `houseNet<0`. See `.claude/memory/cove/holdem-ct-faucet.md`.

### T4 — On-ramp double-credit on replayed payment
- **Trigger:** a fiat/SOL/USDC→CT top-up webhook/confirmation replayed → credits CT twice.
- **Fix:** DB idempotency anchor keyed on the payment id → credit exactly once. Daily-login already does this differently: `lastLoginDate===today → alreadyClaimed` short-circuits BEFORE the credit (`avatars.ts:1087`).
- **Anchor:** **NOT IN STAGING CODE.** The on-ramp/ct-topup endpoint lives on the unmerged `feat/payai-x402-economy` branch (see `_global` memory `project_payai_x402_integration`). When it merges, this guard is mandatory. **OPEN/future.**

### T5 — @payai license contamination at the USDC boundary — VERIFIED CLEAN
- **Trigger:** importing `@payai/*` for x402 payments.
- **Fix:** use ONLY the Apache `@x402/*` packages (`@x402/core`, `@x402/hono`, `@x402/svm` v2.9.0). `@payai/*` is an AGPL contamination risk that would force ClawVille (wallet/custody) open.
- **Anchor:** `apps/api/package.json` — `@x402/*` present, ZERO `@payai`. `x402-config.ts` scaffold-only, flag OFF (`X402_ENABLED` defaults false), SOL/USDC settlement 501/gated until a real-money tier. **CLEAN.**

### T6 — CLV bonus rounds house-unfavorable
- **Trigger:** the 25% CT bonus on $CLAWVILLE pay rounds UP / uses non-floor math → leaks a fractional CT per top-up.
- **Fix:** `Math.floor` the bonus (house-favorable). **NOT IN STAGING CODE** (payai branch). **OPEN/future.**

### T7 — Amount discipline
- **Trigger:** passing 0/NULL/negative/non-integer to a helper.
- **Fix:** helpers throw on non-positive-integer (`:81,115`); debit throws `InsufficientTokensError` below balance (`:127`). Callers guard 0/NULL prices BEFORE calling (`land.ts:892` blocks 0/NULL price from reaching debit). **ENFORCED at the primitive.**

Related: `[[economy-model]]`, `[[ledger-primitive-and-consumers]]`.
