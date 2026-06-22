# Token-Economy — Memory Index

> Persistent memory for the `token-economy` agent — OWNER of the **ClawToken ledger primitive** (`claw-token-ledger.ts`, the ONLY writer of `avatars.clawTokens`), the conservation audit-trail (`clawTokenTransactions` in `schema/treasury.ts`), the fiat/SOL/USDC/$CLAWVILLE on-ramp + exchange, and the x402 USDC↔CT boundary. **Every CT spend/earn in the game flows through this ledger** — a change here ripples to all settlement. **Precedence: live code > the 3 canonical docs > this memory** — verify `git show origin/master:<f>` vs `origin/staging:<f>` vs working tree before trusting any FIXED/LIVE claim. Seeded 2026-06-22 from a verified code audit.

## Known traps (read BEFORE any CT/ledger change — feeds Phase 0)
Phase-0 pre-flight checklist — read EVERY one before writing code (full anchored versions in `known-traps.md`):

1. **Raw `avatars.clawTokens` write outside the ledger = the #1 ban.** Only `claw-token-ledger.ts:96,133` may `.set({ clawTokens })`. Grep-verified ZERO app-code violations 2026-06-22 (only the ledger + 2 test fixtures + a dev script). Writing OTHER avatar columns (xp/level/characterConfig/loginStreak) is fine. `[[ledger-only-write-path]]` — VERIFIED CLEAN.
2. **Non-composing settle loses atomicity.** A `debit`/`credit` that opens its OWN tx when the caller already has one → game/order row and ledger row diverge on partial failure. ALWAYS pass `tx`. `[[atomic-compose-into-caller-tx]]` — ENFORCED.
3. **Faucet — credit with no matching debit, or house-opponent with no treasury backing.** Cove holdem vs-bot bots mint synthetic stacks (rake only BOUNDS) — **OPEN on prod**; baccarat commission floored-down faucet **FIXED**. Designed faucets (daily_login/level_up/building_visit/chat) are legitimate. `[[no-game-is-a-faucet]]` `[[treasury-backed-house-opponents]]`.
4. **On-ramp double-credit.** A fiat/SOL/USDC→CT top-up replayed needs a DB idempotency anchor → exactly-once. **NOTE: the on-ramp/ct-topup is NOT in staging code — it lives on the unmerged `feat/payai-x402-economy` branch.** `[[on-ramp-double-credit-guard]]` — OPEN/future.
5. **@x402-not-@payai.** Apache `@x402/*` v2.9.0 only; `@payai/*` is AGPL license contamination. Verified zero `@payai`; x402 scaffold-only, flag OFF. `[[usdc-ct-boundary-x402-not-payai]]` — VERIFIED CLEAN.
6. **CLV bonus rounding.** 25% CT bonus on $CLAWVILLE pay MUST `Math.floor` (house-favorable). Not in staging code (payai branch). `[[clv-bonus-house-favorable]]` — OPEN/future.
7. **Amount discipline.** Helpers throw on non-positive-integer (81/115); debit throws below balance (127). Guard 0/NULL prices BEFORE calling (`land.ts:892`). `[[amount-discipline]]` — ENFORCED at the primitive.
8. **Conservation per game.** `Σdebit == Σcredit + rake`; tournament `Σprize + rake == pool` (fold remainder into 1st). `[[conservation-by-construction]]`.
9. **Initial-grant has no opening ledger row.** A new avatar's starting CT (100, `auth.ts:1011`) is an INSERT literal with no `claw_token_transactions` row — a future ledger-replay gap (treat creation literals as off-ledger genesis), NOT a live bug. `[[ct-not-withdrawable]]` context.
10. **CT is non-withdrawable internal play-currency** — structurally caps damage; keeps the USDC boundary (x402) one-directional and the SOL/USDC settlement 501-gated.

## Invariants (the money contract)
1. CANONICAL WRITE PATH — ledger-only: real CT moves ONLY through claw-token-ledger (creditClawTokens/debitClawTokens/transferClawTokens) on avatar.id. The ONLY two direct avatars.clawTokens writes in the whole worktree are claw-token-ledger.ts:96 (creditInTx) and :133 (debitInTx), both inside the row-locked tx. NEVER a direct .set({ clawTokens }) / raw UPDATE avatars SET claw_tokens anywhere else (the #1 static ban — grep-verified ZERO app-code violations 2026-06-22; only other hits are 2 test fixtures + a dev script). Writing avatars for OTHER columns (xp/level/characterConfig/loginStreak/position/walletAddress) is fine — only clawTokens is reserved; a creation-time INSERT literal (guest grant 100, auth.ts:1011) is allowed (creation ≠ balance mutation).
2. ATOMIC + COMPOSABLE: each helper row-locks the avatar (SELECT user_id, claw_tokens FROM avatars WHERE id=$ FOR UPDATE, ll.86-87/119-120), computes balanceAfter, UPDATEs avatars.clawTokens, and INSERTs a claw_token_transactions row (signed amount: +credit, -debit at l.140; balanceAfter snapshot) — ALL in ONE tx. Pass the caller's tx (2nd arg, ll.158-176) to compose INTO their db.transaction so a debit + the game/inventory/order row + a credit commit-or-roll-back together. Omit tx → the helper opens its own. transferClawTokens always opens its own tx (debit+credit both-or-neither, ll.182-225).
3. INSUFFICIENT-FUNDS ABORTS THE WHOLE TX: debitInTx throws InsufficientTokensError when row.claw_tokens < amount (l.127) — inside the caller's tx this aborts EVERYTHING (no partial write: a settle that can't debit the stake never credits the payout). The route-level pre-check (e.g. me.clawTokens < amount, exchange.ts:199/307, items.ts:90) reads a STALE pre-tx balance and is ADVISORY ONLY — the FOR UPDATE re-check at debit is the authoritative gate; never remove it thinking the pre-check guards.
4. CONSERVATION: amount is a signed integer with a balanceAfter snapshot, so Σ over an avatar reconstructs the balance exactly. No path mints or vaporizes CT — every settlement Σdebit == Σcredit (+ rake); tournament Σprize + rake == pool (fold the rounding remainder into 1st place). House-funded opponents (seeded agents, vs-bots) must be TREASURY-BACKED (a real house-bank debit), NEVER a synthetic faucet. The cove house is implicit (no treasury row) — P&L = SUM(bet)-SUM(payout), surfaced only by the admin economy monitor GET /api/cove/economy/summary. Designed faucets (daily_login, level_up, building_visit, chat rewards) are the game's LEGITIMATE emission — a faucet BUG is an unintended credit-without-debit on a SETTLEMENT path or an untreasury-backed house opponent.
5. IDEMPOTENT ON-RAMP + RETRY: a fiat/SOL/USDC→CT top-up (when it ships — NOT in this worktree, lives on the unmerged feat/payai-x402-economy branch) must credit exactly once per payment via a DB idempotency anchor keyed on the payment/webhook id (replayed confirmation → exactly-once). Daily-login already guards differently: lastLoginDate===today → alreadyClaimed short-circuits BEFORE the credit (avatars.ts:1087). Any game retry path (client 404 self-heal, reconnect) must not double-credit.
6. USDC/CT BOUNDARY: x402 is the USDC payment boundary; CT is the internal NON-WITHDRAWABLE play-currency (which structurally caps damage). Keep ONLY the Apache @x402/* packages (@x402/core, @x402/hono, @x402/svm v2.9.0); NEVER @payai/* (AGPL license contamination — would force ClawVille wallet/custody open). x402-config.ts is scaffold-only behind FEATURE_GATE x402_payment_middleware, X402_ENABLED defaults OFF (buildX402ResourceServer returns null when disabled); the only route is a $0.001 demo ping — there is NO USDC→CT settlement path. SOL/USDC settlement stays 501/gated until a real-money tier with legal/custodial sign-off.
7. CLV BONUS FLOORS HOUSE-FAVORABLE: paying in $CLAWVILLE grants a 25% CT bonus — the bonus math must Math.floor (house-favorable), never ceil/round, so it can't leak a fractional CT. NOT in this worktree (payai branch) — OPEN/future; verify with a unit test on non-round amounts when it lands.
8. AMOUNT DISCIPLINE: helpers require a positive integer (Number.isInteger && > 0) and throw otherwise (ll.81/115); debit asserts balance >= amount (l.127). Callers must guard 0/NULL prices BEFORE calling (land.ts:892 blocks 0/NULL price from reaching debit). No fractional/negative/overflow CT.
9. TREASURY-BACK HOUSE OPPONENTS — NO FAUCET: any house/seeded/bot counterparty providing CT must be funded by a treasury-bank debit (chip-for-chip) or the path must THROW (cash poker throws seeded_agent_requires_house_bank without a houseBankAvatarProvider). Rake only BOUNDS, never closes, a synthetic faucet. OPEN on prod: cove holdem vs-bot bots mint synthetic stacks (full fix deferred). FIXED: baccarat commission floored-down faucet (baccarat-engine.ts:497-519, floor player WINNINGS not commission).
10. GUEST ISOLATION: guests NEVER touch avatars.clawTokens — demo balances live on a session row; private-room results don't score the leaderboard, public do. An agent is NEVER routed to the guest tier (E5 + XOR-constraint violation). Real CT flows only for ledger subjects (user|agent) resolved by the auth-identity-session primitive — token-economy CONSUMES that resolver and binds settlement to the resolved avatar.id; it never resolves subjects itself.
11. CONSUMER BLAST RADIUS: a change to the primitive's signature/contract ripples to ~20 call sites across 8 owning domains (cove, land, leaderboard, activities, marketplace, knowledge-orientation, agent-protocol, self). PRE-READ the blast radius (grep creditClawTokens|debitClawTokens|transferClawTokens) and confirm conservation + atomicity hold for ALL of them before changing the primitive.
12. STAGING-FIRST + SAME-DIFF DOCS: ledger/economy changes go to staging first → drive the real spend→balance→audit-row loop (a replayed credit credits once; a settle conserves; the monitor shows no houseNet<0 regression) → promote. bun test green is NOT a substitute for the adversarial audit or the staging smoke. Every route/table/service change updates ARCHITECTURE.md; every economy/formula change updates GameFeatures.md §4/§5/§8 AND the 3 operational-knowledge surfaces (Nori town-guide.ts, connection SKILL.md, hosted-runtime) per CLAUDE.md.

## File map (owned)
## OWN — the CT ledger primitive + economy domains

| File | Role |
|---|---|
| `apps/api/src/services/claw-token-ledger.ts` | **THE primitive.** `creditInTx` (ll.80-112) + `debitInTx` (ll.114-149) are the atomic core: `SELECT user_id, claw_tokens FROM avatars WHERE id=$ FOR UPDATE` (87/119) → compute `balanceAfter` → `tx.update(avatars).set({clawTokens})` (**96/133 — the ONLY two direct `avatars.clawTokens` writes in the repo**) → `INSERT claw_token_transactions` (signed: `+credit`, `-input.amount` for debit at 140). Positive-int guard throws (81/115); debit asserts `claw_tokens >= amount` else `InsufficientTokensError` (127). Public fns take optional `tx` (158-176) → compose into caller's tx; omit → own tx. `transferClawTokens` (182-225) does debit+credit in ONE tx + fires post-commit `tokens.settled` telemetry (void, 212). Exports `ClawTokenSource` enum + `InsufficientTokensError`. |
| `packages/database/src/schema/treasury.ts` | Home of **`clawTokenTransactions`** (104-129) — the append-only conservation ledger (NOT in `claws.ts`). Cols: `avatarId`(FK cascade), `userId`, `amount`(signed int), `balanceAfter`(snapshot), `reason`, `source`(enum 80-90: api\|simulation\|quest\|bounty\|exchange\|daily_login\|admin\|x402\|system), `metadata`(jsonb). Header (96-99): "every write to avatars.clawTokens MUST go through credit/debitClawTokens". Also `treasuryWallets` (team merchant supply, AES-256-GCM, NEVER user-facing). |
| `apps/api/src/routes/exchange.ts` | **OWNED** — peer NEED/OFFER escrow marketplace (NOT a fiat on-ramp). Every CT move is `debit/credit(input, tx)` composed into the route's `db.transaction` (create 205-237, order 273-334, confirm/release 447-517, cancel/refund 539-623, listing-cancel 627-725), `source='exchange'`. Conservation: escrow debit at post/order ↔ credit-release at confirm ↔ credit-refund at cancel. **E5 GAP: all 6 mutating handlers are `requireAuth` (human-only) — no agent-session resolver.** |
| `apps/api/src/routes/items.ts` | **OWNED** — book/item shop. `/buy` (67-153) `debitClawTokens(book.price, tx)` + inventory insert in ONE tx (96-128, insert-fail rolls back the debit). Uses `requireAuthOrAgentSession` + `c.get('identity')` (68-69) → **HAS agent parity** (contrast exchange.ts). `/learn` (160-363) writes `avatars.characterConfig` only (209) — NO clawTokens, correct separation. |
| `apps/api/src/services/x402-config.ts` | **OWNED** — x402 USDC boundary, `FEATURE_GATE x402_payment_middleware` (1-12, review 2026-07-21), flag `X402_ENABLED` defaults OFF (65), `buildX402ResourceServer` returns null when disabled (86). Apache `@x402/core` + `@x402/svm` + `@x402/hono` (48-50). Only route is `GET /api/v2/agent/ping` $0.001 (111-121) — NO USDC→CT settlement. Merchant pubkey from `CLAWVILLE_MERCHANT_WALLET_PUBKEY`. Keep `@x402/*`; **NEVER `@payai/*`**. |
| `packages/database/src/schema/{exchange,inventory,token-launch}.ts` | `exchange_listings`+`exchange_orders` (NO escrow column — the ledger IS truth; `amount_ct` snapshots price at order time so listing edits don't reprice open orders); `avatar_inventory` (avatarId,itemId,quantity, no CT col); `vanity_keypairs`+`token_launches` (**on-chain SPL mint infra — UNRELATED to internal CT; do NOT conflate `token_launches` with `claw_token_transactions`**). |
| `apps/api/src/routes/claws.ts` + `packages/database/src/schema/claws.ts` | **NOT a CT path** despite the registry naming. `claws.ts` = browser-claw NPC registration (/connect /disconnect /heartbeat) + saved-claw CRUD; `schema/claws.ts` = `openclaw_bots` (agent-session persistence: `sessionExpiresAt` 24h TTL, `sessionKeyHash` UNIQUE partial idx, encrypted Hatcher proxy token). ZERO ClawToken movement — co-owned with auth/agent-protocol. |
| `apps/web/src/components/game/{exchange,inventory,shop-overlay}-modal.tsx` | **OWNED** — economy web UI surfaces. |

## CONSUMER reference (separation invariant)

| File | Role |
|---|---|
| `apps/api/src/services/xp-service.ts` | The canonical separation example — `update(avatars).set({xp,level,totalXp})` (56-64) touches XP cols ONLY, then `creditClawTokens` for level-up (68). Inline comment: "NOT the token balance — that goes through the ledger." Every `update(avatars)` caller follows this: CT never rides in a `.set()`. |
| `apps/api/src/routes/avatars.ts` | Daily-login credit (1116) gated by `alreadyClaimed` idempotency (1087, `lastLoginDate===today`); `update(avatars).set({loginStreak})` (1107) is non-CT. |

## Agent definition + memory (already authored — keep in sync)

- `.claude/agents/token-economy.md` — the seeded specialist subagent (manager+reviewer, PRE-READ trap gate, 9-invariant money contract, OWN/CONSUME/CONSUMERS boundaries).
- `.claude/memory/token-economy/{MEMORY.md, economy-model.md, known-traps.md, ledger-primitive-and-consumers.md}` — RLM index (Phase-0 trap checklist) + economy model + anchored traps + consumer blast-radius map.

## Boundaries (owns vs consumes)
## OWNS — the shared money primitive + the on-ramp/exchange/x402 domains

- The **CT ledger primitive** `services/claw-token-ledger.ts` — `creditClawTokens`/`debitClawTokens`/`transferClawTokens`/`InsufficientTokensError`/`ClawTokenSource`. The ONLY code allowed to write `avatars.clawTokens` (lines 96/133).
- The conservation audit-trail `claw_token_transactions` (in `schema/treasury.ts`).
- The **on-ramp + exchange escrow** `routes/exchange.ts` (peer NEED/OFFER), item shop `routes/items.ts` (buy/learn).
- The **x402 USDC payment boundary** `services/x402-config.ts` (scaffold, flag OFF).
- The CT economy schema `schema/{claws, exchange, inventory, token-launch}` + economy web modals `components/game/{exchange,inventory,shop-overlay}-modal.tsx`.
- The faucet/conservation discipline + economy-monitor surface (`GET /api/cove/economy/summary`).

## CONSUMES — upstream dependency

- **`auth-identity-session`** — the `{user, agent, guest}` resolver → the `avatar.id` every settlement binds to. token-economy NEVER resolves subjects itself; it binds the debit/credit to the already-resolved avatar. It reviews its own *usage* of the resolver (e.g. `items.ts` correctly uses `requireAuthOrAgentSession`; `exchange.ts` only does `requireAuth` — an E5 parity gap to fix). Resolver *changes* are filed to that owner, not made here.

## CONSUMED-BY — domains that call this agent's ledger (this agent reviews their USE + faucet/conservation of their settlement, not their game logic)

- **cove-casino** — `cove-slots.ts`, `cove-blackjack.ts`, `cove-baccarat.ts`, `cove-holdem.ts`, `poker/tournament-manager.ts`, `poker/cash-table-manager.ts` (local-only), `special-event-manager.ts`, `runtime-services-adapter.ts`, `avatar-simulation-bridge.ts` (dormant). The single largest CT consumer.
- **land-economy** — `land.ts` parcel primary-sale debit/credit (911, 1283).
- **leaderboard-progression** — `quests.ts` (reward credit 469/1370), `bounties.ts` (escrow debit 349 / hunter+poster credit 554/1219), `xp-service.ts` (level-up credit 68), `avatars.ts` (daily-login credit 1116, idempotent at 1087).
- **activities-arena** — `activity/reward-pipeline.ts` (match payout 438; bots get leaderboardPoints=0 + NO credit).
- **marketplace-trade** — `bazaar.ts`/`auctions.ts`/`marketplace.ts` (PAUSED, write handlers 503-gated, but still ledger-wired for the gated buy path).
- **knowledge-orientation** — `chat.ts` (system-agent + location-chat reward credits 119/310).
- **agent-protocol-partner** — `agent-gateway.ts` (autonomous-visit/building reward credits 2223/2433); **protected partner surface** — invoke `codex:codex-rescue` for adversarial review on any partner/x402/USDC settlement path.
- **cosmetics-shop** — `cosmetics.ts` first-party CT cosmetic debit (allowed carve-out, not peer commerce).

A change to the primitive's signature/contract ripples to ALL ~20 call sites across these 8 domains — pre-read the blast radius (grep the three helper names) and confirm conservation + atomicity for each before changing the primitive.

## Entries

### Patterns
- [atomic-compose-into-caller-tx](atomic-compose-into-caller-tx.md) — Pass the caller's tx to credit/debit so the ledger write + the game/order/inventory row commit-or-roll-back as one atomic unit; InsufficientTokensError aborts the whole tx

### Gotchas
- [no-game-is-a-faucet](no-game-is-a-faucet.md) — A settlement credit with no matching debit net-mints CT; house/seeded/bot opponents must be treasury-backed or the path throws. Holdem vs-bot OPEN on prod; baccarat commission FIXED

### Constraints
- [ledger-only-write-path](ledger-only-write-path.md) — The #1 static ban — avatars.clawTokens is written ONLY by claw-token-ledger.ts:96/133; every other CT move routes through credit/debit/transfer
- [on-ramp-double-credit-guard](on-ramp-double-credit-guard.md) — A fiat/SOL/USDC→CT top-up must credit exactly once per payment via a DB idempotency anchor on the payment/webhook id. NOT in staging code — lives on feat/payai-x402-economy. OPEN/future
- [usdc-ct-boundary-x402-not-payai](usdc-ct-boundary-x402-not-payai.md) — x402 (Apache @x402/* only, NEVER @payai/*) is the USDC payment boundary; CT is the internal non-withdrawable play-currency. x402 scaffold-only, flag OFF, no USDC→CT settlement path exists
- [amount-discipline](amount-discipline.md) — Ledger helpers require a positive integer (throw else) and debit asserts balance>=amount (InsufficientTokensError); callers must guard 0/NULL prices before calling

### Economy
- [conservation-by-construction](conservation-by-construction.md) — Σdebit == Σcredit (+rake) on every settlement; signed-amount + balanceAfter ledger reconstructs balances exactly; no path mints or vaporizes CT
- [treasury-backed-house-opponents](treasury-backed-house-opponents.md) — Any house/seeded/bot CT counterparty must be funded by a treasury-bank debit chip-for-chip or the path must throw — never a synthetic stack
- [clv-bonus-house-favorable](clv-bonus-house-favorable.md) — The 25% CT bonus on $CLAWVILLE pay must Math.floor (house-favorable) — never ceil/round. NOT in staging code (payai branch). OPEN/future
- [ct-not-withdrawable](ct-not-withdrawable.md) — CT is the internal non-withdrawable play-currency (caps damage); guests never touch avatars.clawTokens; an agent is never guest-demoted; initial-grant has no opening ledger row (replay gap)
