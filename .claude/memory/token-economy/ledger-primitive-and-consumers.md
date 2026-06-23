---
name: ledger-primitive-and-consumers
description: "claw-token-ledger internals (credit/debit/transfer row-lock+audit+tx-compose) + the COMPLETE consumer map — the blast radius of any contract change to the primitive"
category: pattern
confidence: high
date: 2026-06-22
---

# Ledger primitive + the consumer blast radius

## The primitive (`apps/api/src/services/claw-token-ledger.ts`)

Three exported helpers + one error + one source enum:
- `creditClawTokens(input, tx?)` / `debitClawTokens(input, tx?)` — each: validate positive-integer amount (throw else) → `SELECT user_id, claw_tokens FROM avatars WHERE id=:id FOR UPDATE` (row lock) → compute `balanceAfter` (debit asserts `>= amount` else `InsufficientTokensError`) → `UPDATE avatars.clawTokens` → INSERT `claw_token_transactions` (signed `amount` — negative for debit — + `balanceAfter` + `reason` + `source` + `metadata`). All in ONE tx. Pass `tx` to compose into the caller's transaction; omit → opens its own.
- `transferClawTokens({from,to,amount,reason,source,metadata})` — debit `from` + credit `to` in ONE `db.transaction` (both or neither), then fires a `tokens.settled` event (peer transfers paused but infra live).
- `ClawTokenSource` = `'api'|'simulation'|'quest'|'bounty'|'exchange'|'daily_login'|'admin'|'x402'|'system'`.

**Contract invariant:** `avatars.clawTokens` ALWAYS equals the latest `balanceAfter` for that avatar in the ledger. Any change to the helper signatures/behavior ripples to EVERY consumer below.

## Consumer map (blast radius — grep `creditClawTokens|debitClawTokens|transferClawTokens` to refresh)

**cove-casino** (owner: `cove`): `cove-slots.ts` (:1199 debit spin, :1386 credit win), `cove-blackjack.ts` (:1172/:1423/:1813 debit stake/delta, :1837 credit payout), `cove-baccarat.ts` (:810 debit, :831 credit), `cove-holdem.ts` (:669 debit buyin, :1444 credit cashout), `poker/tournament-manager.ts` (:838 debit buyin, :933/:1874/:2021 credit prize/refund — also uses `transferClawTokens`), `poker/cash-table-manager.ts` (:584 debit sit/rebuy, :755 credit cashout — LOCAL-ONLY, not deployed), `special-event-manager.ts` (:565 debit), `runtime-services-adapter.ts` (wraps both for ElizaOS runtime), `avatar-simulation-bridge.ts` (:74 credit — DORMANT scaffolding).

**land-economy** (owner: `land`): `land.ts` (:911, :1283 debit parcel purchase).

**leaderboard-progression** (owner: `leaderboard-progression`): `quests.ts` (:469, :1370 credit quest reward), `bounties.ts` (:349 debit escrow, :554/:1219 credit reward/refund), `xp-service.ts` (:68 credit level-up), `avatars.ts` (:1116 credit daily-login).

**activities-arena** (owner: `activities-arena`): `activity/reward-pipeline.ts` (:438 credit match payout — bots get `leaderboardPoints=0` + NO credit).

**marketplace-trade** (PAUSED, 503-gated but ledger-wired): `bazaar.ts` (:743 debit buyer, :751 credit seller), `auctions.ts` (:143/:785/:950/:963 credit, :775/:940 debit).

**knowledge-orientation** (owner: `knowledge-orientation`): `chat.ts` (:119 system-agent reward, :310 location-chat reward).

**agent-protocol-partner** (owner: `agent-protocol-partner`): `agent-gateway.ts` (:2223, :2433 credit autonomous-visit / building reward).

**token-economy (self):** `exchange.ts` (escrow need/offer — :225/:312 debit, :476/:571/:582/:659/:694 credit refunds/release), `items.ts` (:98 debit buy-book).

## How to use this for a contract change

A signature/behavior change to a helper is NOT a local edit — it touches ~20 call sites across 8 domains. Pre-read this map, confirm conservation + atomicity (`tx` passed) still hold per consumer, and run the staging spend→audit→conserve loop. Each consumer owns its game logic; I (token-economy) own the primitive + review their USE for faucet/double-credit/non-atomic settle.

Related: `[[economy-model]]`, `[[known-traps]]`.
