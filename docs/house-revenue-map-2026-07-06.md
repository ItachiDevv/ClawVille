# ClawVille House-Revenue Audit — CORRECTED (v2, 2026-07-06)

Synthesized from 6 vertical maps + direct verification of the ledger code. **Verification note up front:** the checked-out worktree (`docs/agent-metaverse-model`) `apps/api/src/services/claw-token-ledger.ts` is the **pre-wall 226-line ledger — NO provenance exists on this branch or on prod/master** (verified by full read: plain credit/debit/transfer, no `mintEarned`, no `allocateDebit`). The SOFT/BOUGHT/EARNED wall exists on **`origin/staging` + `feat/tokenomics-earn`** (verified: `claw-token-ledger.ts:317-333` allocateDebit, `:290` SOFT default, `:443` mintEarned, `:497-524` transferClawTokens). Every "under the wall" claim below is a staging/branch analysis; prod today has fully fungible CT.

---

## 1. THE COMPLETE HOUSE-REVENUE MAP

| # | Vertical | Stream | Fee/rate (exact) | Currency | Where the fee lands | Status | Micro-safe? | Prior-audit missed? |
|---|---|---|---|---|---|---|---|---|
| 1 | Reef/Wager | SOL wager-lobby escrow rake (Reef Race + Bumper Shells) | 5% of pot (`rake_bps=500`, cap 1000) — `settle_lobby_sol.rs:100-111`; off-chain mirror `wager-program-client.ts:611-612` | SOL lamports | On-chain `treasury` = `treasury_wallets purpose='wager-settlement-authority'` custodial Solana wallet (`wager-program-client.ts:129-134,564-569`) — **outside the CT ledger entirely** | Backend live master+staging, **DEVNET-only** (gate `wager-mainnet-paid`, wager.ts:35-42); reef consumer branch-only `feat/reef-race-rebuild` | Yes (checked BigInt floor; rounding favors winner; pot=payout+rake exact) | **YES — the founder's #1 named miss** |
| 2 | Reef/Wager | SPL-token lobby rake (dormant) | Same 500 bps, arbitrary SPL mint | SPL token | Same treasury snapshot | On-chain `create_lobby_spl` exists; route-gated OFF (`wager-spl-lobbies`, 0 requests) | Same math | YES |
| 3 | Poker/Cove | Cove Hold'em vs-bots pot rake | `min(floor(pot*5/100), 5)` CT — `holdem-engine.ts:71-72,1785-1786`; applied `cove-holdem.ts:1348` | CT | **NOWHERE — un-minted (burn)**; bookkeeping only (`outcomeJson.rake`) | live-prod | **NO** — rake=0 for pot<20 CT; 5-CT cap ≈2.5BB | No (visible on master) |
| 4 | Poker | MTT tournament rake | `floor(prizePool*rakeBps/10000)`, rakeBps default **0**, admin 0–10000 — `tournament-manager.ts:1981-1984,608`; `cove-poker-mtt.ts:180` | CT | **NOWHERE** — written to `poker_tournaments.rake_taken_ct` (:2044), never credited; net burn | branch-only `feat/poker-tournament-consolidated` (7 local commits unpushed) + staging partial; dormant (0 bps) | Yes (floor under-collects; remainder folds to 1st, sum(prizes)+rake==pool) | **YES** |
| 5 | Poker | Cash ring-game rake | **0, hardcoded** — `cash-table-manager.ts:25,374-376,1262`; dormant `rake_bps/rake_cap_ct` columns | CT | N/A | live-staging (P1+P2 2026-06-21) | Trivially | YES (dormant columns) |
| 6 | Cove | Slots RTP edge | ~2.5% paytable edge (`slot-engine.ts:441-451`; plan says ~6% — **drift**) | CT | **NOWHERE** — mint/burn asymmetry on player's own balance; observable only via `cove-economy.ts` monitor | live-prod | Yes (statistical, no rounding step) | Partly (mechanic understated) |
| 7 | Cove | Baccarat banker commission + tie edge | winnings=`floor(stake*95/100)`, commission=stake−winnings ≥1 at every stake≥1; tie 8:1 — `baccarat-engine.ts:106,513-514` | CT | **NOWHERE** — un-minted | live-prod | **Yes — the only micro-safe cove fee** (floors winnings, not fee) | No |
| 8 | Cove | Blackjack net-winnings rake | `floor(max(0,net)*5/100)` — `blackjack-engine.ts:95,951-952`; `cove-blackjack.ts:1782,1836` | CT | **NOWHERE** — un-minted ("never credited → house keeps it" = burn) | live-prod | **NO** — 0 rake below 20 CT net win, on the countable (+EV-able) game | No |
| 9 | Cove | Hold'em bot-stack faucet (**NEGATIVE revenue**) | `BOT_STACK=100n` synthetic, no treasury debit — `cove-holdem.ts:133` | CT | Minted INTO winning players (SOFT on staging) | live-prod **OPEN incident** | N/A (it's the leak) | Root-cause framing missed (fix pattern `cove-cash-poker.ts` `seeded_agent_requires_house_bank` exists staging-only, never back-ported) |
| 10 | Land | Parcel primary sale | full `price_ct` (starter 0–150 … a 40k–80k) — `land.ts:1181-1213` | CT | **NOWHERE — pure burn-sink**, no treasury credit | live-prod + staging | Yes (integer, 0-price guarded) | No |
| 11 | Land | Rent (initial + weekly sweeper) | full `rent_ct_weekly` (c 50–100 … a 1000–2400) — `land.ts:1907-1937`; `land-rent-sweeper.ts:146-170` (zero `credit` hits) | CT | **NOWHERE — burned** (pool is lessor, no landlord) | live-prod + staging | Yes | **Sweeper YES** (cron, not a route) |
| 12 | Land | Structure upgrade | `STRUCTURE_UPGRADE_COSTS[lvl]` = 600/1800/4500/11000 — `land.ts:1573-1578`; `land-economy.ts:113-122` | CT | **NOWHERE — burned** | live-prod + staging | Yes | No |
| 13 | Land | Service purchase (run-a-store) | **0% — conservation**: buyer debit == seller credit (SOFT) — `land.ts:2503-2540`; `platform_fee_bps` column **inert 0** (`schema/land.ts:425`, read only for display `land.ts:661`) | CT | No fee; 100% to seller as SOFT | **live-staging ONLY** (commit `4d7cc9d6`), absent on master | Yes (no bps math ever runs) | **YES — entire marketplace + the inert fee column the founder believed was live** |
| 14 | Agent svc | Exchange peer marketplace (NEED/OFFER) | **0% live**; EARN-3 rake plan-only — `exchange.ts:365,574,585`; `tokenomics-vclaw-v1.md §5` | CT | Full escrow to seller | live-prod, fee unbuilt | N/A | YES (plan rake) |
| 15 | Agent svc | Bounties CT payout | 0% — `bounties.ts:790,1726` | CT | Full reward to hunter | live-prod | N/A | No |
| 16 | Agent svc | EARN-2 platform-mediated USDC bounty-settle rake | **PLANNED 5%→1% floor** (stake lever a) — `tokenomics-vclaw-v1.md §2.1(4),§5,§6(a)`; needs NEW Anchor settle variant | USDC → net mints EARNED | Contested — 40/20/30/10 split **founder-REJECTED** (banner 2026-07-06); destination OPEN | **plan-doc-only, unbuilt** | Unbuilt (floor-at-dust rule needed) | **YES — the only genuinely BACKED agent-services fee** |
| 17 | Agent svc | Partner storefront (x402 USDC) | `platform_fee_bps` hard 0; USDC direct to `payout_pubkey` — `partner-storefront.ts:290,480-487` | USDC | Nowhere (platform deliberately out of money path) | staging-only, 503-gated, no live buy path | Trivially | YES |
| 18 | Agent svc | SAP on-chain escrow settle | 0 — no treasury account passed (mainnet-tx-verified) | USDC/SOL | Full vault → agent ATA | built, GATED OFF (`SAP_ENABLED=false`) | By construction | YES |
| 19 | Agent svc | Bazaar/auctions skill commerce | 15%: `Math.floor(price*0.15)` — `bazaar.ts:739-740`, `auctions.ts:139-140` (feat/token-economy-agent) | CT | **BURNED** — fee never credited anywhere | **PAUSED 503** (master gate bazaar.ts:36) | Leaky — fee=0 for price 1–6 | Partly (that it burns, YES) |
| 20 | Catch-all | Cosmetics shop | full `sku.priceCt` — `cosmetics.ts:314-323` | CT | **BURNED** (debit, no treasury credit) | live-prod | Yes | **YES** |
| 21 | Catch-all | Knowledge books | full `book.price` — `items.ts:90-143` | CT | **BURNED** | live-prod | Yes | **YES** |
| 22 | Catch-all | **CT top-up on-ramp** (the real-dollar entry) | No fee; margin = the peg. `usdToCt` at `CT_PER_USDC=10` ($0.10/coin) — `ct-topup.ts:26,141-143`; mints **BOUGHT** (`:472` guard, never EARNED); CLV pay +25% | fiat/SOL/USDC/CLV in → BOUGHT CT out | **Real dollars → ClawVille merchant/treasury** (x402 verifyAndSettle) | branch `feat/tokenomics-earn` + staging, gated (Null-Tide P1) | Guarded (sub-dime → 0 CT rejected) | **YES — the actual revenue entry point** |
| 23 | Catch-all | EARNED-import labor rake | caller bps, **floor 100 bps (1%)** — `earned-import.ts:98,190-192,298-301`; net mints EARNED, rake → `earn_rake_accruals` | USDC atomic 6dp | `earn_rake_accruals` claim against treasury USDC reserve (E3 dividend pool) | branch/staging, gated (E1) | Partial (floor→0 under 100 atomic gross; under-rakes dust) | **YES — BACKED** |
| 24 | Catch-all | **Cash-out exit fee** | **LOCKED 4.44%** (founder) vs plan 3%→0.5% curve + velocity penalty — `tokenomics-vclaw-v1.md:52,112` — **4.44 appears in ZERO code/docs** | EARNED → USDC/CLV | Treasury/dividend pool at the two-phase cash-out seam | **plan-only, no code path exists** (`cashoutCodeExists=false`) | Unbuilt (4.44%=444 bps is exact at 6dp; floors to 0 only <23 atomic units — fine) | YES (headline fee invisible to code-only audit) |

Non-revenue emissions (house COSTS, for completeness): reef finisher CT credit (`reward-pipeline.ts:438`), quests/daily-login faucets, cove hold'em bot faucet (#9). Confirmed NON-existent: teleport/naming/quest-entry/arena-entry fees, agent-gateway cognition metering — no code, no plan.

---

## 2. THE KEY ECONOMIC MECHANIC — surplus backing, verified against the ledger

**Verified code facts (origin/staging `claw-token-ledger.ts`):**
1. Debits burn **SOFT → BOUGHT → EARNED, strict order** (`allocateDebit`, :317-333, comment :324), one ledger row per tag burned.
2. `creditClawTokens` provenance type is `'soft' | 'bought'`, **defaults `'soft'`** (:290); `'earned'` is unrepresentable — `mintEarned` (:443) is the sole EARNED writer, enforced by a module-private capability symbol AND a DB trigger.
3. `transferClawTokens` (:497-524): payer burns in order; **"Receiver ALWAYS gets SOFT"** (:513) — no override parameter. Internal recirculation can never become cashable.
4. **On prod/master and the current worktree, NONE of this exists** — the ledger is the plain 226-line version, all CT fungible.

**The founder's mechanic, corrected against reality:** the hypothesis ("player's EARNED burns, house credited SOFT → outstanding EARNED shrinks, backing USDC stays → surplus backing = realized dollar revenue") is **directionally CORRECT — and the code is one step more extreme: the house isn't even credited SOFT.** Every in-game rake (holdem #3, blackjack #8, MTT #4, all land sinks #10-12, shops #20-21, bazaar #19) is a **silent burn** — no `transferClawTokens` to any house subject exists on any branch. Economically, burn and credit-house-SOFT are dollar-identical: SOFT is unbacked either way. The dollar event is entirely on the **liability side**:

- **Burned SOFT** → destroys unbacked free-play credit. Dollar revenue: **$0**. (This is the overwhelmingly common case — SOFT burns first.)
- **Burned BOUGHT** → the dollar was already realized at top-up (V-Bucks model; `usd_basis` stamped on the BOUGHT row). The burn extinguishes prepaid buy-power. Incremental dollar revenue: **$0** (revenue was booked at purchase; the burn is margin realization on already-booked revenue).
- **Burned EARNED** → outstanding cashable claims shrink 1:1 while the treasury USDC reserve is untouched → **SURPLUS BACKING = reserve − Σ(outstanding EARNED). This surplus is real, realized, sweepable dollar revenue.** ✅ Founder is right.

**So: are in-game rakes real revenue or unbacked credit? BOTH, determined by the burned tranche's provenance — and today they are neither well-defined nor well-sized:**

1. **Not accounted.** No table records "EARNED burned by reason X". The per-tag ledger rows (:369-389) contain the data (`provenance='earned'`, negative amount, reason), but nothing aggregates it into a treasury surplus accrual. House P&L is an inferred `SUM(bet)−SUM(payout)` in the admin monitor (`cove-economy.ts`) that doesn't even distinguish tags.
2. **Rarely triggered.** SOFT-first burn order means rake revenue is $0 unless the player has exhausted SOFT and BOUGHT. By design the wall protects the player's cashable balance — which means in-game rakes are ~pure SOFT deflation in practice.
3. **CATASTROPHICALLY over-sized when triggered — the payout bug.** Game payouts always mint SOFT (:290 default; every cove/poker settle uses plain `creditClawTokens`). A player staking 100 EARNED and **winning** 200 receives 200 SOFT: their 100 EARNED is confiscated as backing surplus **on a winning hand**. House "revenue" from gambling isn't the rake — it's **100% of all EARNED ever wagered**. That's not a revenue stream, it's a cashability trap that makes EARNED radioactive at any game table.

**What must change so house revenue is well-defined (minimal set):**
- **(a) Every rake becomes a `transferClawTokens` to a registered house treasury avatar** (receiver-SOFT is automatic and correct). Revenue becomes an account, the monitor becomes its audit check. Applies to #3, #4, #8, and any future fee.
- **(b) Backing-surplus accrual:** on every `provenance='earned'` debit row, write a `(reason, avatar, earned_burned, usd_equiv)` row into a treasury accrual table (the `earn_rake_accruals` pattern, `earned-import.ts:421-459`, already exists — extend it). Sweep rule: treasury may withdraw reserve down to Σ(outstanding EARNED), never below. This is the founder's surplus made mechanical.
- **(c) Fix the confiscation:** simplest wall-consistent rule — **EARNED is not stake-eligible.** Add a debit mode (`spendable='soft_bought'`) that throws `InsufficientTokensError` against `soft+bought` only, used by all game buy-in/bet paths. Then game rakes burn only SOFT/BOUGHT (never a backing event), and EARNED surplus arises ONLY from deliberate sinks that accept it (cosmetics, land — where "spending your earnings on the world" is the intended conversion) plus the 4.44% exit. Alternative (provenance-restoring payouts up to stake) is strictly more complex and re-opens laundering review.

---

## 3. CORRECTED R3 — house revenue is NOT exit-coupled-only

The founder is right. Pre-exit revenue streams, in order of dollar-realness:

| Stream | When the dollar is realized | Status |
|---|---|---|
| **CT top-up (BOUGHT mint)** — `ct-topup.ts` | **At purchase** — external fiat/SOL/USDC lands in treasury; BOUGHT is non-cashable, so it is booked revenue with only in-game goods liability (V-Bucks model) | branch/staging, gated |
| **EARNED-import rake (≥1% floor)** — `earned-import.ts:190-192` | At external settlement — gross USDC inbound, rake retained in `earn_rake_accruals` | branch/staging, gated |
| **EARN-2 labor rake 5%→1%** | At platform-mediated USDC bounty settle | plan-only |
| **EARNED-burn backing surplus** (sinks/rakes consuming EARNED) | At the burn — liability shrinks, reserve unchanged (§2b) | mechanic real NOW on staging; **unaccounted, needs (b)** |
| **BOUGHT-burn margin** (cosmetics/books/land consuming BOUGHT) | Realized upstream at top-up; burn extinguishes the goods liability | live wherever BOUGHT exists |
| **SOL wager rake 5%** — settlement-authority wallet | At settle, on-chain — **real only after the mainnet gate flips** (devnet = $0 today) | live code, devnet-gated |
| **Partner storefront `platform_fee_bps`** | Would be USDC at sale — 0 today | staging, gated |
| **4.44% cash-out fee** | At exit | plan-only |

The exit fee is one stream among eight. What IS exit-coupled-only is the *EARNED holder's* realization — the house realizes dollars continuously before that.

---

## 4. THE EXPANDABILITY CONTRACT — checklist for ANY new economy PR

Every PR adding a money/fee/game/store/service surface is reviewed against ALL of these. One ❌ = BLOCKING.

- [ ] **C1 — Ledger-only writes.** Every CT/vCLAW mutation goes through `creditClawTokens` / `debitClawTokens` / `transferClawTokens` / `mintEarned`. Zero direct `avatars.clawTokens` (or tag-column) UPDATEs — grep the diff.
- [ ] **C2 — Provenance wall compliance.** Receiver of any internal transfer gets SOFT (automatic via `transferClawTokens` — do not hand-roll debit+credit pairs). `'earned'` never appears in a `creditClawTokens` call (the type forbids it; don't cast). External-dollar credits: on-ramp → `provenance:'bought'` + `usdBasis`; confirmed external labor/settlement → `mintEarned` with gross `usdBasis` — **these are the ONLY two non-SOFT mints, ever.**
- [ ] **C3 — Fee registration: no silent burns.** Every fee/rake is a `transferClawTokens` to the registered house treasury avatar (or, for USDC-rail fees, a row in the treasury accrual table naming the reserve claim). A debit whose fee lands "nowhere" is a defect (this audit's central finding). New fee ⇒ add it to the house-revenue map table (this doc / its canonical home) in the same diff.
- [ ] **C4 — Stake-eligibility.** Gambling/game stakes debit SOFT+BOUGHT only (§2c) once that mode ships; until then, document the EARNED-exposure explicitly in the PR.
- [ ] **C5 — Atomic micro-units.** All fee math in integer atomic units with BigInt, bps-style `(amount * bps) / 10_000n`, floor **in the house-conservative direction** (baccarat pattern: floor the counterparty's winnings, never floor the fee to 0 when a fee is owed — or accept + document the dust-leak). Assert exact conservation: `sum(payouts) + fee === pot`. On the 6dp migration, every existing `floor(x*5/100)` is re-derived (§5.6).
- [ ] **C6 — E5 human/agent parity.** Write path resolves BOTH a logged-in human AND a connected/hosted agent session to the bound avatar (`requireAuthOrAgentSession` / `resolveAgentSession`); guests demo-only, non-ledger agents 403 (never guest demotion). PARITY note in the commit body.
- [ ] **C7 — External-dollar-only EARNED.** No new `mintEarned` call site without a confirmed external USDC settlement + gross `usdBasis` + solvency check (reserve ≥ outstanding EARNED after mint). The EARNED_TOKEN symbol stays module-private.
- [ ] **C8 — House counterparty is funded, never synthetic.** Any house-vs-player game seats the house from a treasury-debited bank (cove-cash-poker `houseBankAvatarProvider` pattern), never a `BOT_STACK`-style mint-from-nothing.
- [ ] **C9 — Doc propagation.** Same-diff: `GameFeatures.md`/`ARCHITECTURE.md` per trigger table, the three-surface rule (Nori knowledge / connection SKILL.md + `PROTOCOL_VERSION` / hosted-runtime memory) for any game-flow change, and the tokenomics spec if a rate/peg/fee changes.
- [ ] **C10 — Audit gates.** Money-path = full team + adversarial audit of the AGENT path against the live game; provably-fair engines get a staging live-smoke; conservation identity re-derived under READ-COMMITTED interleaving (the PayAI lesson); no "done" without the harness/live evidence.

---

## 5. GAPS + CONFLICTS under locked 1:1 Kintara

1. **PEG CONFLICT — three incompatible values.** Locked: vCLAW ≡ USDC **1:1**. Code: `CT_PER_USDC = 10` ($0.10/coin, `ct-topup.ts:26`, also used by `earned-import`). Plan doc: ×100 ($0.01). **Fix:** one shared constant in `packages/shared` (`VCLAW_PER_USDC = 1n` atomic-aware), consumed by ct-topup, earned-import, and the future cash-out; migration script re-bases existing balances; plan docs corrected same diff. Until this lands, every `usdBasis` written is denominated ambiguously — blocking for any real-dollar flip.
2. **4.44% exists nowhere.** Zero hits for 4.44/444/0.0444 across ~60 branch tips + all plans; plan docs instead carry the founder-REJECTED 3%→0.5% curve and 40/20/30/10 split. **Fix:** rewrite `tokenomics-vclaw-v1.md` fee section to the locked model (444 bps, single fee, destination = market-buy CLV for the earner per Kintara), delete the rejected split. At 6dp atomic, `fee = (atomic*444n)/10_000n` is exact and floors to 0 only below 23 micro-USDC — acceptable dust.
3. **SOL wager rail is outside the vCLAW economy.** The only rake that lands in a real wallet (#1) accrues SOL to `wager-settlement-authority`, invisible to the vCLAW books, and is devnet ($0) today. **Fix (on mainnet flip):** scheduled sweep SOL→USDC→treasury reserve + accrual row (books it as backed ops revenue); never mint vCLAW from it. Alternatively re-rail wagers onto vCLAW escrow and retire the SOL path — decide before the `wager-mainnet-paid` gate (2026-09-01).
4. **Cove mint-on-win + bot faucet.** All game payouts are fresh mints; hold'em's `BOT_STACK=100n` (`cove-holdem.ts:133`) lets skill mint net-new SOFT (live open incident). Under the wall the damage is capped at SOFT (non-cashable) — but on **prod, which has NO wall, it mints fungible CT**. **Fix:** ship the wall to prod (it's the prerequisite for everything here), then back-port the `houseBankAvatarProvider` treasury counterparty from `cove-cash-poker.ts` to cove hold'em.
5. **EARNED confiscation at game tables** (§2.3). **Fix:** stake-eligibility mode (§2c / C4). Without it, the first user who tops-up→earns→plays blackjack loses cashability silently — a trust-killing bug under 1:1.
6. **Fee floors at 1 cent.** `floor(x*5/100)`=0 below 20 units hits blackjack (#8) and hold'em (#3) — micro-unsafe today, and the dead zone returns for sub-cent stakes after 6dp migration. **Fix:** re-derive all three as atomic bps math with the baccarat floor-the-winnings pattern; add a shared `takeFee(atomic, bps)` helper so future streams can't re-introduce it (C5).
7. **No treasury subject for internal fees.** Nothing to credit even if a PR wanted to comply with C3. **Fix:** create the house treasury avatar/ledger subject (distinct from `treasury_wallets` merchant supply — `feedback_wallet_table_semantics`) + the burn-surplus accrual table (§2a/b), then convert #3/#4/#19 (and #13's fee when flipped) from silent burns to transfers.
8. **MTT `rakeBps` is an unregistered 0–100% admin dial** (`cove-poker-mtt.ts:180`) whose proceeds vanish (#4). **Fix:** cap sanely (e.g. ≤1000 bps), route via C3, and record the rate in the tournament row it already has.
9. **Inert `platform_fee_bps` columns** (land services :425, partner storefronts) read as live fees to anyone reading schema — this audit cycle's exact failure. **Fix:** `FEATURE_GATE` comment on each column naming activation conditions + that activation must satisfy C3/C5, or drop the columns until the fee is designed.
10. **Bazaar/auctions 15% burns behind the 503 pause** (#19). **Fix:** before any unpause, convert `Math.floor(price*0.15)` Number math to BigInt bps + treasury transfer (C3/C5); the current code fails both.