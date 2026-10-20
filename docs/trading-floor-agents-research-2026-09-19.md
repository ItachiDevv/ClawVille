# Trading Floor and user trading agents: research and decisions

**Last Audited: 2026-09-19.** Author: session `clawAgents`, team `tf-research`. Revision 2, after an adversarial review.

**Code basis.** Every code claim was read in the worktree `C:\Users\itachi\Documents\Crypto\cv-tradefloor` at commit `2fbfd987` (= `origin/staging`). The earlier survey ran at `032bfb8a`, so line numbers were re-checked. A claim I could not verify carries the label **UNVERIFIED**.

**Sources.**

| Source | Use |
|---|---|
| `handoffs\clawAgents-handoff-2026-09-19.md` | Founder decisions, verbatim. |
| Repo worktree at `2fbfd987` | All code claims. |
| `docs/clawpump-integration.md`, `deploy-status.md` | ClawPump facts, Genesis runner, live deploy record. |
| `GameFeatures.md` (Trading Floor execution, §17g), `ARCHITECTURE.md` (Trading Floor wave 2) | Documented behaviour, and two drifts recorded below. |
| Cloned read-only: `claw-agent`, `agents-skills`, `ClawQuant`, `@clawpump/agents` dist | Harness and journal research. |
| Reference image `clawump-ref.jpg` | Visual style only. |

**Scope note.** No token launch. No agent token-launch verb. Trading only.

**The one fact that shapes everything below.** ClawVille can enforce a guardrail only on a wallet whose key it holds. `docs/clawpump-integration.md:89` states it: ClawVille "does not hold that external wallet key and cannot halt its trades". There is no third option where ClawVille caps a wallet it does not control. Every section obeys that fork.

---

## Founder summary

**Your question, answered.** Three ways exist. The ClawPump dashboard: ClawPump holds the wallet. The claw-agent harness: the person runs the agent, but the wallet stays with ClawPump and no key sits on their machine. A ClawVille-hosted agent: we hold the wallet. Every product answers the same three questions first: who holds the key, who pays the model, what caps the size.

**Three things change the plan.**

- **Token eligibility outranks the build.** The hackathon terms say "No token, no award", and you have ordered no token launch. Nobody has confirmed $CLAWVILLE as the entry token. Settle it today, or the work scores nothing. Decision 1.
- **A production gate lapsed.** `trading_floor_directional_vault_flow` said block the prod promotion. The Trading Floor shipped to prod anyway, metric unmet by its own reading, and no waiver exists. Decision 2.
- **Guardrails are real only where we hold the key.** On a ClawPump wallet we score and advise, never cap or halt. Holding the key makes caps real, and makes us look like a money transmitter. Decision 9.

**By 2026-09-20 23:59 UTC, on staging only:** the agent decide-path fix, and the wallet ownership proof. Nothing more is honest.

**Decisions are in section 11, ordered by what they block.**

---

## 1. How does a regular person open a trading agent?

Three paths exist today.

**ClawPump dashboard.** The person signs in with Google. They press create agent. ClawPump makes the agent and custodies its Solana wallet. They fund the wallet. They buy AI credits by sending USDC to the account deposit wallet, then they sync billing. They pick a model, add skills such as DeFi Trading, and add automations such as DCA or limit orders. Hosting is free during the launch offer, then 0.1 SOL per agent per month (`docs/clawpump-integration.md:78`; UNVERIFIED whether our account sits inside that offer). The person pays model usage plus a 30 percent markup.

**claw-agent, the open-source harness.** `npx @clawpump/claw-agent` installs a Python 3.11 environment and two launchers. `claw clawpump setup` runs browser OAuth or takes a `cpk_` key. The person picks a model provider. The agent wallet stays with ClawPump: the harness holds no local keypair, and no message-signing tool exists anywhere in the clone. UNVERIFIED conflict on that point: ClawPump's public docs say it never holds your keys, while the harness text describes custodial server-side signing. Financial and irreversible tools, `swap_execute` and `wallet_transfer` among them, are OFF by default. `hermes mcp configure clawpump` turns them on. UNVERIFIED estimate: 10 to 20 minutes for a command-line user, and hard for anyone else.

**Market patterns.** Four shapes exist, at three to six steps each: chat-first platform wallet, embedded-wallet terminal, bring your own wallet with scoped delegation, and copy or vault deposit. Step counts are UNVERIFIED vendor-document estimates.

**The shape under all of them.** Every product answers three questions in the first minute: who holds the key, who pays the model, and what caps the trade size. ClawVille must answer the same three at the monitor.

---

## 2. The monitor connect flow

The human walks to the monitor and presses E. A DOM panel opens over the 3D scene. This copies the Cove pattern: hotspots live in the scene, and all text lives in DOM modals.

**Screen 0 (shared).** Title "Trading Floor". Three cards. Each card states who holds the money before the person picks it.

**A hard constraint that shapes screen 0.** `clawpump_agent_links.avatarId` is the PRIMARY KEY (`packages/database/src/schema/trading-fleet.ts:40`) and `wallet_pubkey` is unique (`:44`). One avatar per user is already a repo invariant. So today the three paths are MUTUALLY EXCLUSIVE per account: a person who binds a ClawPump wallet cannot also run a ClawVille-hosted trading agent. Screen 0 must say so, and the person must be able to leave a path. Founder decision 3 covers whether we lift this.

### (a) "I have a ClawPump agent"

| Step | Screen |
|---|---|
| A1 | Paste the agent wallet address from the ClawPump dashboard. |
| A2 | ClawVille shows one verification address and one exact dust amount, plus the two ClawPump commands. |
| A3 | The person whitelists the verification address, then sends the exact amount from the agent wallet. |
| A4 | ClawVille matches sender, destination, amount and slot at finalized commitment, then binds the wallet observe-only. It then ATTEMPTS a dust refund. |
| A5 | The monitor shows the live tape, the trade journal and the leaderboard row. |

- **Funds:** ClawPump holds the key. ClawVille can observe, verify and score. It cannot sign, cap, halt or stop. Any guardrail offered here is advisory text only.
- **Cost:** the dust plus one Solana fee. ClawVille attempts the refund; section 5 says why "attempts" is the honest word.
- **Agent path (E5):** add a `method: 'transfer'` branch to `POST /api/exchange/wallets/bind/challenge` plus `POST /api/exchange/wallets/bind/transfer`. Both sit behind `requireAuthOrAgentSession` + `requireNonGuestIdentity` + `requireLedgerCapableIdentity` (`routes/exchange.ts:133-180`). Extend `clawville_bind_trading_wallet` (`constants/building-tools.ts:76-77`) with two transfer actions. Update `buildProtocolManual`, bump `PROTOCOL_VERSION` (63 at `services/skill-protocol.ts:497`).

### (b) "I run claw-agent, Hermes or any OpenClaw agent"

| Step | Screen |
|---|---|
| B1 | ClawVille shows one magic link and the skill install command. |
| B2 | The person runs `hermes skills install <protocol skill.md URL>`. |
| B3 | The agent opens the magic link, calls `/api/agent/connect`, and binds to the avatar. |
| B4 | Wallet registration. A wallet that can sign a message uses the existing ed25519 challenge. A ClawPump wallet uses the dust proof from (a). |
| B5 | Switching to path (c) later requires unbinding first. See the constraint above screen 0. |

- **Funds:** ClawPump, for a claw-agent wallet. The person, only for a self-custody wallet they bind by signature. ClawVille verifies and scores, and enforces nothing on a wallet it does not sign for.
- **Cost:** their own model provider bill. ClawVille charges nothing.
- **Agent path (E5):** already live. Verified: claw-agent holds no local keypair, and no message-signing tool exists anywhere in the clone. So B4 for a claw-agent user always means the dust proof.

### (c) "Make me a ClawVille agent"

| Step | Screen |
|---|---|
| C1 | Pick one objective from the five in code (`TRADING_OBJECTIVES`, `packages/shared/src/constants/trading-fleet.ts:3-9`). The objective also sets a USDC floor of 0, 10, 20, 10 or 60 percent (`:28-34`) and restricts output mints (`:20-26`). |
| C2 | Pick a guardrail preset, or set caps by hand. |
| C3 | Fund the wallet. The screen must state the real minimum: more than 0.02 SOL AND more than 2 USDC, and NO token outside the four-mint whitelist. |
| C4 | Disclosure. "ClawVille holds this wallet key. Your caps run on our server. They are our promise, not an on-chain limit." The person must tick it. |
| C5 | Review and arm. |
| C6 | Live panel: equity, positions, cooldown, daily use, halt, kill, disarm. |

- **Funds:** ClawVille custodial. This is the only path where ClawVille holds user money.
- **The C3 funding cliff is the likeliest drop-off.** The arm route refuses on zero equity, on any unknown positive token balance (`unknown_token_balance`), and below either reserve floor (`routes/admin-trading.ts:138-146`). A wallet holding one memecoin is refused.
- **ClawVille enforces every guardrail in code:** mint whitelist, per-trade ceiling, float percent, daily notional, cooldown, slippage, quote impact, reserve floors, objective USDC floor, drawdown halt, operator halt, kill. Signing re-checks halt and arm state.
- **Cost:** the funded float plus Solana fees. Model cost sits on the ClawVille bill; see founder decision 8.
- **Agent path (E5):** new routes on `routes/trading-floor.ts` beside `POST /trade` (:29) and `GET /state` (:55), with the same three middlewares: `/api/floor/caps` (GET and POST), `/arm`, `/disarm`, `/halt`, `/unbind`. Add tools `clawville_set_trading_caps` and `clawville_arm_trading`. Do NOT add an `[ACTION:]` arming verb in v1; arming is the money door.
- **Guests:** `requireNonGuestIdentity` refuses them server-side, so the monitor degrades to read-only rather than showing a dead button.

**PARITY note each phase must carry**, in the shape of `GameFeatures.md:1994`: "Human path: the in-world monitor through the caps, arm and unbind endpoints. Agent path: the same REST routes through `X-Clawville-Agent-Session` and the published tools. Settlement binds to `identity.avatarId`. No client feature flag exists."

---

## 3. Custody recommendation for path (c)

| Option | Who owns the cap | Honest label |
|---|---|---|
| A. ClawVille custodial executor with user-set caps | ClawVille | The cap is a promise. We can change it or fail it. The user cannot enforce it. |
| B. User-owned policy wallet (Privy agent signer, Turnkey policy engine, Swig session keys) | The user key owns the policy root | The cap is hard. ClawVille cannot exceed it even if our code is wrong. |

**Recommendation.** Ship A for v1, with four restrictions: a small float ceiling per user, the C4 disclosure, spot only, and no pooling of user funds. Build B as step 2 and migrate. UNVERIFIED by me: the Solana capability of each vendor. I tested none of them.

**The custody consequence, stated plainly.** ClawVille emits `wallet.secretKey` exactly once, with no recovery path. If ClawVille custodies a user's trading wallet and loses that key, the money is gone and the loss is ClawVille's. Path (c) must never be presented as the easy default.

**Regulatory flags, not legal advice.** FinCEN 2019 CVC guidance treats a hosted wallet with control of user funds as a money transmitter. Option A puts ClawVille in that shape. Option B does not. Two further flags exist. A CFTC adviser or pool-operator question arises if ClawVille charges for advice on leveraged products, or pools user funds. A CFTC advisory also warns against profit claims for AI trading bots.

**What needs a lawyer, before path (c) opens to a non-founder user:**
1. Is the custodial executor money transmission in the United States, and in which states.
2. Does a public P&L ranking plus any ClawVille fee make us an adviser.
3. What the monitor and the leaderboard may say about performance.

---

## 4. Self-serve arming design

### 4.1 Why it does not work today (verified)

Seven locks, plus one state fact.

| # | Lock | File and line |
|---|---|---|
| 1 | The arm route is operator only | `routes/admin-trading.ts:14` (`moneyOperatorOnly` on `*`), route at `:131` |
| 2 | The route refuses a non-fleet link | `admin-trading.ts:136` `not_fleet_operated` |
| 3 | The UPDATE predicate requires the fleet flag | `services/trading-links.ts:64` |
| 4 | Execution refuses an unarmed link twice | `services/trading-guardrails.ts:196` and `:328` |
| 5 | The drawdown sweep only sees fleet links | `trading-guardrails.ts:532-536` |
| 6 | Caps are global, never per link | `trading-fleet.ts:43-94`; `clawpump_agent_links` has no cap column (`schema/trading-fleet.ts:39-54`) |
| 7 | THROUGHPUT, not permission: one global mutex | `withKeyedMutex('trading:fleet')` plus `pg_advisory_xact_lock('trading:fleet')` on every admission (`trading-guardrails.ts:302,323`), arm (`trading-links.ts:50-52`), kill (`:71-73`), halt (`trading-guardrails.ts:504-526`) and reservation change (`:430-432`) |

**State fact.** The custodial executor has executed exactly ONE live trade, ever, and only on staging. `deploy-status.md:117` records it: decision `1374fb60…`, signature `5mytFoup…`, slot 447873097, SOL to USDC, wallet delta -0.009997 SOL and +0.999229 USDC, ingested to `verified_trades` with event 29171. Prod has NO fleet account and no armed link (`deploy-status.md:129`). `GameFeatures.md:39` and `:1968` still say "The fleet remains unarmed". That is prod-scoped and stale for staging, and it is drift to correct. Per session record the staging link was later swept and disarmed; I did not verify the current arm state. Building self-serve arming on a path with one lifetime trade is the largest schedule risk here.

**Lock 7 matters more than it looks.** A live USDC balance RPC with a 4 second abort runs INSIDE that globally locked transaction (`trading-guardrails.ts:363-383`, `TRADING_BALANCE_RPC_TIMEOUT_MS = 4000` at `:147`). With one fleet this is invisible. With N users, every ClawVille trade queues behind one lock and one Helius call.

### 4.2 Changes by file

1. **`schema/trading-fleet.ts` plus a numbered migration.** Add `cap_per_trade_usd_micros`, `cap_daily_usd_micros`, `cap_drawdown_pct`, `cap_cooldown_s`, `cap_token_list jsonb`, `caps_set_at`, `caps_set_by`, each with a CHECK bounding it by `TRADING_CODE_LIMITS`. The database then refuses a bad cap even when a route is wrong. Watch two existing CHECKs: `trading_halts.scope` is `varchar(8)` admitting only `fleet` and `agent` (`:101,109`), and `trading_decisions.origin` admits four values (`:89`). Additive migrations are safe under the CI gate, which runs BEFORE the code flip; a tightened CHECK or a DROP ships in a later promotion.
2. **`services/trading-links.ts`.** Give `armTradingLink` a `requireFleet: boolean`; the fleet route keeps `true`. **New `services/trading-limits-resolver.ts`:** `resolveEffectiveLimits(link)` returns `min(user, env, code)` per ceiling and `max(...)` per floor. Code ceiling and env default already differ, so a user cap sits under the lower: daily notional 100 / 60, per trade 25 / 25, slippage 300 bps / 150, drawdown 25 / 20 percent, cooldown floor 60 s / env 300.
3. **`services/trading-guardrails.ts`, both admit points.** Replace `readTradingLimits()` with the resolver at the pre-check (`:194-253`) AND inside `admitTrade` (`:325-358`). I checked for a third read point; there is none. Missing either makes the user cap decorative.
4. **The drawdown sweep (`:531-581`) is the most dangerous change here.** Three branches engage a FLEET halt, and a fleet halt refuses every agent's trades (`:199`, `:334`): invalid or missing `baselineEvidence` (`:545-556`), equity unreadable past the grace window (`:566-568`), and the breach itself (`:577-578`). The first two also `return` early, so one bad link aborts the sweep for every other link. Join self-serve links to this loop unchanged and one user with a corrupt baseline halts Genesis and everybody else, without trading at all. The self-serve sweep must be a SEPARATE loop. All three branches engage `scope:'agent'` with that link's `scopeId`, and the loop continues past a failed link. A self-serve link must never reach `engageHalt` with `scope:'fleet'`. Omitting self-serve links from any sweep is equally unacceptable: those users get no drawdown protection.
5. **`services/trading-provisioning.ts` and `routes/trading-floor.ts`.** Add a self-serve custodial provisioning function; do not reuse `pairObservedClawPumpAgent` (`:473`), whose observe-only rows stay permanently cold. Add the 2(c) routes with the same three middlewares as `/trade` (`:29`), including a self-serve unbind: today the only exit is `unpairObservedClawPumpAgent`, behind `moneyOperatorOnly` (`admin-trading.ts:79`), refusing any link that is `operatedByClawville || armed` (`trading-provisioning.ts:562-563`). A user who cannot leave is a support and legal problem. Rate-limit per SUBJECT as `exchange.ts:137-141` does, not per IP as `/api/floor/trade` does (`:14,30`).
6. **New `services/trading-token-safety.ts`.** Port `lp_lock_fail()` and `chain_checks()` from `runner.py`; it is Python, so port it, never import it. A pool is tradable only when at least 95 percent of its liquidity is burned or permanently locked. Covered: PumpSwap, Raydium CPMM, AMM v4 and CLMM, Meteora DAMM v1 and v2, and launch curves. Meteora DLMM and Orca Whirlpool are refused. Mint checks: no mint or freeze authority, a Token-2022 extension allow-list, top-10 holders under 20 percent excluding the pool vault.

Every new knob needs its row in the canonical env table at `ARCHITECTURE.md:43-61`, under the direction rule `assertTradingLimitsWithinCode` enforces at boot (`trading-fleet.ts:96-123`). `TRADING_ARM_GRACE_S` already sits at `:57`, "Reserved for the blocked provisioning and arming seam".

### 4.3 Token list beyond four mints

Today the whitelist is four mints (`TRADE_MINTS`, `constants/trading-floor.ts:2-7`). USDC is pinned to Circle's live mint and freeze authority (`:16-19`); the other three must carry no authority. Extend in two tiers. Tier 1 stays the four mints and is the default. Tier 2 is opt-in and admits a mint that passes `trading-token-safety.ts`. Run that check BEFORE the admission transaction opens, not inside it: several chain reads inside the globally locked transaction of lock 7 would stall every other user.

### 4.4 Optional guardrail presets (PROPOSALS, not defaults)

Genesis's filters are for our agent only. Every number here is a proposal needing founder approval.

| Preset | Per trade | Daily | Drawdown stop | Cooldown | Tokens |
|---|---|---|---|---|---|
| Careful | $5 | $20 | 10 percent | 900 s | Tier 1 only |
| Balanced | $10 | $50 | 15 percent | 600 s | Tier 1 plus tier 2 above $1M market cap |
| Active | $25 | $100 | 20 percent | 300 s | Tier 1 plus tier 2 above $300k market cap |

Every value is clamped by `resolveEffectiveLimits`. "Active" already sits at the compiled ceiling, so a preset cannot raise it.

---

## 5. Ownership proof for a ClawPump wallet

**Scope it narrowly.** Signature binding already works and stays the default: `/api/exchange/wallets/bind/challenge` plus `/wallets/bind` (`exchange.ts:132-151`), and `/trades/report` resolves the wallet from the transaction SIGNERS while refusing the fee payer (`:185-206`). A micro-transfer is needed only because ClawPump exposes no message-signing tool. Its `wallet_transfer` also has no memo field, which rules out one shared address plus a memo.

**Status: DESIGNED, NOT TESTED.** The handoff and the research inputs both mark this untested. No sentence may state that it works.

**Do not invent it.** ClawVille already runs an exact-dust proof on mainnet: `services/land-hold-transfer-verify.ts` with `schema/land-hold-verify.ts`, the land hold-wallet door 2. Verified exports: `probeTransaction` (:855), `transactionMatchesTransferLeg` (:901), `transactionSignedBySource` (:965), `transactionSettlesChallenge` (:974), `blockTimeInsideWindow` (:985), `insertWithUniqueAmount` (:1070).

**What it already does.**

- Amount = a base plus a random 1 to 9999 lamport discriminator. A partial index on pending rows holds it unique, so two live challenges never share an amount (`schema/land-hold-verify.ts:111`).
- A transaction settles only when all hold: it did not fail; it carries a SystemProgram `transfer` whose SOURCE is the declared wallet, whose DESTINATION is our verify address, and whose lamports match exactly; the declared wallet signed it; the block time is inside the window. Inner instructions are searched. `transferWithSeed` is refused.
- Finalized commitment only, because a reorg can roll back a confirmed-only grant. One signature, one challenge, through a unique index on `inbound_signature`.
- Fail closed on the grant, fail soft on the refund. An ambiguous refund reconciles and pages, and never re-signs. A per-user daily attempt cap and a global 24-hour refund spend cap apply.

**The failure modes this design must answer.**

| Mode | Answer |
|---|---|
| Address reuse | One challenge per address, or one address plus the unique amount. Never let one old transfer satisfy two claims. |
| Replay of an old transfer | Record the issuance SLOT. Require the transfer slot to be strictly greater. |
| Amount-only matching | Forbidden. Match on source, destination and slot. The amount is a secondary check that separates live challenges. |
| Third-party sender | Require source equals the claimed pubkey. A centralized-exchange withdrawal would otherwise bind an exchange hot wallet and import its P&L. |
| Front-running the claim | Bind (subject, claimed pubkey, address) at ISSUANCE and re-check the subject on consume, as `consumeTradingWalletChallenge` does (`trading-wallet-challenge.ts:60-71`). |
| Rent and sweep | State the dust size, who pays it, and whether ClawVille holds that keypair. A per-challenge address is a new custodial key class and needs a sweep. |
| Refund drain | The 24-hour refund cap is shared, so an attacker can exhaust it and block honest users. Add a per-user sub-cap, or carry the load on the attempt cap. |

**Durability.** 30 minutes, in a DB row. The existing signature-challenge store is a process-local `Map` with a 120 second TTL that evicts the OLDEST entry at 10,000 (`trading-wallet-challenge.ts:23-25,45-51`). It dies on deploy, does not cross replicas, and a flood silently drops live challenges. Fine for an instant signature; wrong for a dust transfer.

**Treasury row.** Provision a second wallet with `purpose='trading-wallet-verify'`. Do not reuse the land verify wallet: mixing two economies on one address makes an orphan deposit unattributable. `treasury_purpose` is a Postgres ENUM of eight values (`schema/treasury.ts:65-74`), and its header is explicit. Extend it with `ALTER TYPE treasury_purpose ADD VALUE IF NOT EXISTS`, in a numbered migration, NEVER via `db:push`. The new value cannot be used in the transaction that adds it, so the migration and the first insert are separate steps.

**What the user must enable** (verified against the cloned harness and the MCP server build). First `hermes mcp configure clawpump`: the manifest states financial and irreversible tools are OFF by default and names `wallet_transfer`. Then `add_to_whitelist(address=<verify address>)`, because the server refuses a non-whitelisted destination. Then `wallet_transfer(to=..., amount=<exact>, token='SOL', confirm_transfer=true)`, because the server requires that flag. Three gated steps, each able to fail. A stable verify address means the whitelist step happens once.

**Test plan with the founder's own agents.** The account lists six agents: Genesis plus five stopped "ClawVille" agents. Use a STOPPED agent, so the live runner wallet stays untouched. Fund it with about 0.01 SOL and whitelist the staging verify address. Run the transfer. Confirm the challenge settles and the refund lands. Then repeat from a different sender and confirm ClawVille REFUSES it.

**Founder decision.** The dust amount. Proposal: a base of 0.0005 SOL plus the random discriminator.

---

## 6. The trade journal

### 6.1 The verified defect this fixes first

`readAutonomousTradingTargets` computes `positions` (`autonomous-trading-targets.ts:73-78`) and `lastTrades` (`:86`). `formatAutonomousTradingDesk` (`:90-104`) renders neither. The decide path reads only that formatter (`agent-autonomy-driver.ts:1669, 1680`). The deciding model therefore sees its objective, equity, cooldown, daily use, halt state, allowed mints and the refusal list. It sees NO position and NO past outcome.

`GameFeatures.md` "Trading Floor execution" says the desk carries "positions ... and recent outcomes". Code wins. This is doc drift and a CLAUDE.md consumption-mandate defect. Fix both in one diff.

Second finding, same file: `lastIntel` is hard-coded `null` at `:85`, and the `Intel:` line at `:103` sits behind `if (desk.lastIntel)`. So it never renders. The `intel-signal-follower` objective brief tells the agent to act on that snapshot, and to not trade when it is absent. That objective cannot trade correctly today.

### 6.2 Journal design

Neither ClawPump nor claw-agent links a decision to its outcome. ClawQuant does, through a "Trade Learning Record". Adapted fields, in a new table `trading_journal_entries`:

| Field | Source |
|---|---|
| `id`, `avatarId`, `walletPubkey`, `mint` | Bind time |
| `openedAt`, `closedAt`, `status` (`open` \| `closed` \| `orphaned`) | Leg matching |
| `entryThesis` | `trading_decisions.reason`, already stored |
| `marketSnapshot`, `featuresAtEntry` | Price, liquidity, market cap, quote impact at admission |
| `risk` | `{stop, target, sizeUsd}` from the caps in force |
| `fills[]` | Verified on-chain legs, not the quote |
| `outcome` | `{realizedPnlUsd, simpleReturn, holdSeconds, costsUsd}` |
| `attribution` | `{entryQuality, exitQuality, regimeFit, sizingFit}` |
| `lesson` | One short line the agent writes at close |

Book fills from `getTransaction` balance changes, never from the quote. The Genesis runner learned that the ClawPump response output amount is the quote, not the fill.

### 6.3 Read-back on the decide path

A journal that is written and never read is exactly the fake feedback loop CLAUDE.md forbids. The reader is named: `formatAutonomousTradingDesk`, after the 6.1 fix, gains current open positions and the last five closed journal rows as `mint, held, result, lesson`, capped near 1,200 characters. That block reaches the model through `buildDecisionPrompt` at `agent-autonomy-driver.ts:1680`. Same diff: the protocol manual, the Nori knowledge entries, the hosted-runtime injection, and a `PROTOCOL_VERSION` bump.

---

## 7. The Trading Agents leaderboard

**Boundary first.** The Trading Floor moves no vCLAW: trading "never mints, burns, credits, debits, or transfers vCLAW" (`GameFeatures.md:57`, `:1968`). So this board pays no vCLAW prize, and the monitor is not a faucet. Any vCLAW reward for trading crosses a documented boundary and is founder decision 11.

### 7.1 What exists

`apps/api/src/routes/leaderboard.ts:583-628` scores `trade.verified` by COUNT, weighted by pair tier (base 20, CLAWVILLE 30, ANSEM 40). The cap is 20 scored trades per subject per UTC day, over two legs, agent and avatar. It is not volume and it is not P&L. Keep it. It measures participation.

Do NOT fold P&L into that score. Contribution measures participation; P&L measures capital. Mixing them lets a rich trader buy rank. Renaming or reweighting `trade.verified` also binds the protected partner surface; see section 10.

### 7.2 The new board, proposed

A SEPARATE "Trading Agents" board beside the Trader column.

- **Primary sort:** realized P&L in USD, net of fees and Solana costs, inside the window.
- **Secondary column:** deposit-adjusted ROI = realized P&L divided by `max($100, start value + max net deposits)`. The capital floor stops a $2 account outranking a $10,000 account.
- **Eligibility:** at least 10 closed trades, and at least 7 days since the wallet bind slot.
- **Drawdown:** its own column. Do not fold it into the score in v1.
- **Windows:** 7d, 30d, all. Not 24h, because one trade wins a 24h board.
- **Unrealized:** excluded until a position closes.
- **Never rank by volume.** The research input cites a study finding about 25 percent wash volume on one prediction market (UNVERIFIED by me).

### 7.3 Gaming vectors and countermeasures

| Vector | Countermeasure |
|---|---|
| Deposits counted as profit | Deposit-adjusted ROI with the capital floor |
| Withdrawals inflating ROI | Track net deposits over the window, not the closing balance |
| Wash trading between a user's own wallets | Thin CLAWVILLE and ANSEM pools make this cheap. Flag wallets repeatedly taking opposite sides of one thin pool in a short window, and reuse the `(fp_hash, ip_prefix_hash)` anti-farm tagging |
| Unrealized marks on illiquid tokens | Exclude unrealized until close |
| Stale or manipulated price | Already refused as `price_stale_window` and `price_unavailable` (`constants/trading-floor.ts:50-58`); a Jupiter-versus-chain decimals mismatch pages (`trading-guardrails.ts:106-124`) |
| Volume farming | Never rank by volume |
| Low-trade-count luck | The minimum trade count and account age above |
| Same-pair churn | `pair_repeat_today` already exists as an unscored reason; reuse it |
| Importing a lucky pre-bind history | Reuse `pre_bind`; see 7.4 |

The verifier already requires both wallet legs inside the qualifying DEX instruction, after address-lookup-table resolution. It refuses a third-party counter-leg (`token_account_not_owned`) and an ambiguous one-leg flow (`single_sided`). Add a minimum pool-depth-at-fill refusal.

### 7.4 What buy-to-sell matching needs

The substrate already exists, so this is smaller than it looks. `verified_trades` (`packages/database/src/schema/trading.ts:49-89`) stores per signature: both legs and decimals, `notionalUsd` with `notionalSource`, `blockTime`, `slot`, `scoreDay`, `dex`, `wallet`, `avatarId`, `agentId`, `subjectKind` and `decisionId`. No new chain indexing is needed.

What is missing is position and lot state, a matching policy and a fee treatment. Build a FIFO lot matcher per `(wallet, mint)`. A buy leg opens a lot. A sell leg closes it, whole or partial. Realized P&L is proceeds minus matched cost basis minus recorded costs.

Two rules the matcher must carry, both correcting an earlier draft of this document.

1. **A USD price is NOT on every row.** `notional_usd` is nullable (`schema/trading.ts:64`) with CHECK `verified_trades_notional_pair` (`:88`) tying it to `notional_source`, and the observer writes `?? null`. Mark an unpriced lot as unpriced and exclude that position from the ranked P&L. Never guess a price.
2. **Only rows with `slot > boundSlot` may open or close a lot.** The observer INSERTS pre-bind trades and merely marks them unscored with reason `pre_bind` (`trade-observer.ts:313`; the reason is pinned in the CHECK at `schema/trading.ts:82`). Without this rule a user binds a wallet with a lucky history and imports the profit. The 7-day age rule does not cover this.

### 7.5 The verification limit this board must disclose

`FEATURE_GATE trading_floor_directional_vault_flow` (`apps/api/src/services/trade-verifier.ts:111-121`) states that condition (e1) "checks membership only. It does not claim directional vault proof", with a current reading of zero of three official IDLs pinned. So a verified trade today proves instruction membership, not proven vault direction. The board must say so until (e2) graduates.

---

## 8. The building

### 8.1 Keep the id `cron-automation`

| Breaks if the id changes | Verified at |
|---|---|
| Owned book items `cron-automation-basics` and `-advanced` in player inventories | `constants/knowledge-books.ts:19, 33` |
| The building tool dispatcher key | `constants/building-tools.ts:303` |
| Historical `building.visited` events and earned-skill memories keyed on buildingId | Event spine, ElizaOS memories |
| The agent-side skill folder `~/.hermes/skills/clawville-cron-automation/` | Already on user machines |

Re-theme three fields only. `constants/map-locations.ts:108-117` holds `{ id: 'cron-automation', name: 'Downtown Building', description: ..., icon: '🐚', positionX: 11040, positionY: 15200, width: 448, height: 448 }`. Keep `id`; change `name`, `description`, `icon`. Record the reason in `WorldContent.md` so nobody "cleans it up" later.

The re-theme also touches `building-types.ts`, `npc-definitions.ts`, `world-colliders-data.ts`, `arena-buildings.tsx:325` (model `patty-building-opt1-mo-ktx.glb?v=3`), `meshlet/buildings-manifest.ts`, `LandingScene.tsx`, `arena-location-npcs.tsx`, the PixiJS tilemap renderer, `minimap.tsx`, `world-map-modal.tsx`, `orientation-skill.ts` and `skill-protocol.ts`. `knowledge-accuracy.test.ts` reads these facts from the code and locks them, so it moves in the same diff.

### 8.2 Pearl, her books, her tools, the activity

**Proposal, founder decision.** Pearl stays and her subject widens. Cron is the literal mechanism behind DCA, limit orders and scheduled automations, so her 8 knowledge lines and both books stay true. Add 4 lines about scheduled trading. Keep `cron_describe` and `cron_next_fires`. She explains the monitor and points at it; she does not run it.

The coming-soon activity "Co-op Puzzle Lab" (`packages/shared/src/activities/activities.ts:347-360`) can move, be deleted, or be re-themed. Recommendation: delete it. It is a scaffold with no build behind it.

### 8.3 Enterable scene, parts list

**Human parts,** copying the Cove: an exterior click target and E-press hotspot; a walk-in trigger mirroring `triggerCoveWalkIn()` (`apps/web/src/lib/three/arena-buildings.tsx:143`, in `lib/three`, NOT `components/three`); a new scene id plus a `sceneIdForPathname` branch in `components/three/world-stage/stage-scene-id.ts`, whose pathnames are hard-coded, so a new route without this edit navigates nowhere; a route on the persistent canvas; a stage-hosted scene component; an interior module with hotspots; DOM modals; a mobile control set; and a back exit mirroring `handleBack`.

**Agent parts.** A verb `enter_trading_floor()` in `HATCHER_ACTION_VERBS` and `HATCHER_ACTION_MENU` (`constants/hatcher-actions.ts`, 15 verbs today). An executor case in `npc-simulation.ts` beside `enter_cove` (`:3022`). A FOURTH row in `AUTONOMY_ENTERABLE_PLACES` (`map-locations.ts:197`), which today holds only cove, poker-room and kelp-forest; without it the decide prompt never lists the place, which is an E5 defect. Plus the manual, Nori and a `PROTOCOL_VERSION` bump. The server keeps no interior SCENE state. The Cove does hold authoritative game state for its tables, so this is not licence to put trading state on the client.

### 8.4 Assets and render budget (3da owns the detail)

Meshy list from the reference: exterior aquatic-stone hall with a domed roof; a green emissive roof claw sign as the landmark; an arched entrance with a lintel sign panel; a side sign pylon; a circular floor medallion marking the entry hotspot; one console-row module repeated four to six times; a centre hologram dais; a monitor station for the section 2 flow; and existing kelp and coral dressing reused, not authored. Palette: green, teal, deep blue, purple, grey.

Hard render rules: no drei `<Text>` or `<Billboard>`; no `InstancedMesh` with `ShaderMaterial`; no `new Vector3()` in `useFrame`; all screen text in DOM; KTX2 textures and Draco meshes; bump `?v=N` on any replaced asset, because our deploy token cannot purge the Cloudflare edge cache. Full checklist: `3dStructure.md` §6f. Mobile and iPad sweep before "done", including the real-device safe-area screenshot devtools cannot produce: `docs/mobile-ipad-verification.md`.

---

## 9. Ownership of the vertical

`.claude/agents/REGISTRY.md` lists 13 domain agents and claims full repo coverage. It does not cover the Trading Floor. No row owns:

`routes/trading-floor.ts`, `routes/admin-trading.ts`, `services/trading-*.ts`, `clawpump-client.ts`, `trade-observer.ts`, `trade-verifier.ts`, `autonomous-trading-targets.ts`, `constants/trading-floor.ts`, `constants/trading-fleet.ts`, `schema/trading-fleet.ts`, `schema/trading.ts`, `components/game/trading-floor/**`.

`routes/exchange` belongs to token-economy. `leaderboard.ts` belongs to leaderboard-progression. The trading core belongs to nobody, which is why this vertical has no Phase 0 trap list and no standing reviewer.

| Agent | Status | Lev | Owns | Key owned paths | Consumes |
|---|---|---|---|---|---|
| **trading-floor** | new | high | Real-money Solana execution, guardrails, custody arming, ClawPump observation, verification, journal, P&L board | the paths above, plus `lib/three/trading-floor/**`, `.claude/agents/trading-floor.md`, `.claude/memory/trading-floor/**` | token-economy, auth-identity-session, agent-protocol-partner, leaderboard-progression, 3da, world-presence, knowledge-orientation |

Keystone traps for its Phase 0 list: the limits resolver must be read at BOTH admit points; a self-serve halt must never reach fleet scope; the FIFO matcher must obey `slot > boundSlot` and null prices.

---

## 10. Phased build plan

**A production gate is already open and already lapsed.** `FEATURE_GATE trading_floor_directional_vault_flow` (`trade-verifier.ts:111-121`) says "block production promotion until (e2) meets the metric". Its review point is "Before Trading Floor promotion from staging to production", and its reading is zero of three IDLs pinned. The Trading Floor nonetheless reached prod in PR #276 (2026-09-16) and #278, metric unmet, with no waiver in either PR or in `deploy-status.md`. It is open as founder item D5 (`FOUNDER-REVIEW.md:87-88`). The repo rule for a lapsed gate is delete or renew with a fresh reading. Until it is ruled on, no phase below may claim a prod path.

| Phase | Content | Gate before it ships |
|---|---|---|
| P0 | Fix the 6.1 decide-path defect and the `GameFeatures.md` line | A test asserting positions and last outcomes appear in the formatter output. Staging only |
| P1 | Dust ownership proof, using the extracted land door-2 core | The section 5 test plan green, including the wrong-sender refusal. Staging only |
| P2 | Building shell: re-theme, model, walk-in, empty interior, agent verb | 3da plus Codex cross-review; Iris Xe check; mobile and iPad sweep; manual, Nori and `PROTOCOL_VERSION` same diff; mock-Hatcher harness on staging because a verb changes |
| P3 | Monitor register flow, paths (a) and (b), observe-only | Live smoke on staging for a human AND a connected agent; PARITY note |
| P4 | Self-serve arming, path (c) | Adversarial money review; CI migration gate; agent-scoped drawdown proof; per-subject rate limits; self-serve unbind; per-agent model budget; disclosure screen; the section 3 legal answers |
| P5 | Trade journal plus read-back | A consumption test proving the prompt contains the journal block |
| P6 | FIFO matcher plus the P&L board | The 7.3 countermeasures; the 7.4 null-price and `pre_bind` rules; the D5 gate ruling before any prod score |

**Why every money phase needs a live $1 rung, not just a review.** `deploy-status.md:320` records what the staging $1 rung found: "Three real-money findings from one $1 rung, none visible to three review passes and 120+ fixture-driven unit tests." Offline review missed all three. So every new money path gets its own $1 rung before it carries real float.

**Any phase touching the `[ACTION:]` whitelist binds `docs/hatcher-integration-spec.md` §11.** Its mandates cost wall-clock time. Validate against `.hatcher-ref/`, which is absent from this worktree; that comparison cannot be claimed and was already waived once. Run the mock-Hatcher harness on staging. Update the spec and bump `PROTOCOL_VERSION` in the same diff. Get a Codex adversarial pass on money paths. A green `tsc` or `bun test` is explicitly not a substitute.

**Hackathon deadline 2026-09-20 23:59 UTC**, about 44 hours from the handoff timestamp.

**Can make it:** P0, and P1 on staging.

**Cannot make it, and I will not pretend otherwise:** the P2 interior, P3, P4, P5 and P6. P4 alone needs a migration, a resolver at two admit points, a separate agent-scoped sweep, an adversarial review and legal answers. P6 needs a matcher that does not exist. Any claim that a P&L leaderboard ships by Sunday would be false.

**A larger risk than the build.** `docs/clawpump-integration.md:83` records the entry terms: register, post on X, and tokenize by 20 September, "No token, no award", one token per project. Two things are unresolved: whether $CLAWVILLE counts as the entry token, and whether it verifies against the registered X handle. The founder has also ordered no token launch. Showing the runner's record is worth nothing if the entry is invalid. That is founder decision 1.

**What to show at the deadline:** the Genesis runner's real on-chain record, the observe-only pairing, the live tape, and the existing Trader column. The judging line quoted at `docs/clawpump-integration.md:83` is "realised performance, risk control, onchain volume on Solana", and the runner already produces all three.

---

## 11. Founder decisions

| # | Decision | Options | Recommendation | Blocks |
|---|---|---|---|---|
| 1 | Hackathon entry validity: "No token, no award" versus the no-token-launch order | Confirm $CLAWVILLE as the entry token; register another; accept no award | Confirm $CLAWVILLE against the registered X handle TODAY. No build fixes an invalid entry | Everything at the deadline |
| 2 | The lapsed `trading_floor_directional_vault_flow` gate (D5) | Graduate (e2) before any P&L score; record a waiver with a new dated metric; keep the Floor on staging | Record a dated waiver now, and graduate (e2) before P6 ships any P&L score to prod | P6, and every prod promotion |
| 3 | One trading link per avatar (`avatarId` is the primary key) | Keep paths mutually exclusive and ship a self-serve unbind; or change the schema to allow several links | Keep exclusive for v1, ship unbind in P4, revisit after real usage | P3, P4 |
| 4 | Dust amount for the ownership proof | 0.0005 SOL base; 0.001 SOL base; another | 0.0005 SOL plus the random discriminator | P1 |
| 5 | Which ClawPump agent tests the proof first | Genesis; a stopped "ClawVille" agent | A stopped agent, so the live runner wallet is untouched | P1 |
| 6 | Pearl's future | Keep and widen; replace; move | Keep and widen. Her existing content stays true | P2 |
| 7 | The "Co-op Puzzle Lab" coming-soon activity | Delete; move; re-theme | Delete. It is a scaffold with no build behind it | P2 |
| 8 | Who pays the model bill for a user's hosted trading agent | ClawVille absorbs it; the user funds credits; a hard per-agent daily decision budget | A hard per-agent daily budget in P4. Cost otherwise scales with signups, not revenue | P4 |
| 9 | Custody model for path (c) | A: ClawVille custodial with soft caps; B: user-owned policy wallet | A for v1 with the four restrictions; B as step 2 | P4 |
| 10 | Legal review before a non-founder uses path (c) | Answers first; founder-only accounts first | Founder-only first. Legal answers before any public opening | P4 |
| 11 | Any vCLAW prize for trading | None, keeping the documented boundary; or a new crossing | None. Trading moves no vCLAW today, and crossing that needs its own economy review | P6 |
| 12 | The three guardrail presets and their numbers | Accept; change; ship none | Accept as proposals, then tune from real data, never from a guess | P4 |
| 13 | Tier 2 token list | Open with the ported safety checks; stay at four mints | Stay at four mints until P4 is live | P4 |
| 14 | May an autonomous agent arm itself | Yes; human confirmation only | Human confirmation only for v1 | P4 |
| 15 | Add the `trading-floor` domain agent row | Yes; fold into token-economy | Add the row. The vertical is too large and too money-heavy to fold | P0 |
| 16 | What ships by the deadline | Accept section 10; re-scope | Accept it. A false "shipped" claim costs more than a missed feature | All |

---

## Residual risks and what I could not verify

- **UNVERIFIED:** the ClawVille model cost per hosted agent per day. I did not read a bill. VERIFIED: no per-agent spend cap exists in code; `agent-autonomy-driver.ts` carries only `TICK_MS = 30_000` (`:234`) and `DECIDE_MAX_TOKENS = 200` (`:285`), and `inference-usage-reporter.ts` reports without refusing. At one decision every 30 seconds the cost is unbounded by software.
- **UNVERIFIED:** whether our ClawPump account sits inside the free hosting offer.
- **UNVERIFIED:** the Solana capability of Privy, Turnkey, Swig and Squads. I tested none of them.
- **UNVERIFIED:** the market-survey step counts and the wash-volume study.
- **UNVERIFIED:** the current staging arm state. `deploy-status.md:117` records the one executed trade; the later sweep and disarm is per session record only.
- **UNVERIFIED and the biggest technical unknown in P1:** that a ClawPump `wallet_transfer` produces a plain SystemProgram transfer the door-2 attribution accepts. The section 5 test plan exists to answer it.
- **Weak spot:** the custodial executor has ONE lifetime trade. Path (c) builds on a nearly unexercised path.
- **Weak spot:** option A caps are our promise. A resolver bug is the user's loss. That is why the disclosure screen is not optional.
- **Weak spot:** a P&L board with few traders is easy to game with two wallets. The 7.3 rules reduce it; they do not remove it. Under about 20 independent traders, keep the board internal.
