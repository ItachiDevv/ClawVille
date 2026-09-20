# ClawPump integration

**Last Audited: 2026-09-20 (Genesis runner: LP lock rule for all pool types, cap reset, +15 percent trail, all launchpads; plus the RUNNER STATUS FEED).** Drift note: new "Runner status feed" subsection under House traders records `POST /api/floor/house-traders/status`, the `HOUSE_TRADER_STATUS_TOKEN` bearer, the body contract, the post-on-change plus 60 second heartbeat cadence, the 150 second ageout, and the rule that a pause is REPORTED and never inferred from trade silence. Runner section records the FEELSGOOD rug, the on-chain LP lock check per pool type, the replayed exit change and StonkFun support. Earlier: the read-only ownership client, four operator routes, script flow, and recorded fixture inventory.

**Last Audited: 2026-09-18 (docs + code research pass, 09:30Z).** Corrections from the research pass are in "Research pass 2026-09-18" below; they override older lines in this file. Founder direction changed the boundary: the traders must RUN IN CLAWPUMP. One agent first: **Genesis**, the founder's ClawPump agent, trades on ClawPump with its own ClawPump-custodied wallet. The fleet of five is paused (five ClawPump agents exist but are private, stopped and unfunded). ClawVille now has `clawpump-client.ts`, a read-only client for `GET /agents` and `GET /agents/:id`. It proves operator ownership before observe-only pairing. After pairing, ClawVille observes and ranks Genesis under its dedicated account. The client has no execution method. The section "Verified ClawPump facts" below is the ground truth for the next build.

**Previous audit (2026-09-16):** Trading Floor wave 2d requires a signed wallet-ownership challenge before founder pairing. The ClawPump signal client remains blocked because the immutable specification contains no endpoint paths, response schemas, or recorded ClawPump fixtures.

## Current operating state (2026-09-18)

| Item | State |
|---|---|
| ClawPump account | "Hoodie Management", Google sign-in, user `b40f15d4-fb15-458b-94ee-690607725e6c`, deposit wallet `GGzvQQMunrhPEuaCatbMHScpxfps1cAxmU7E4vGQJeoh`. |
| API key | `cpk_` + 43 chars, ENTERPRISE (readable: `POST /api/mcp/token` returns `"tier": "enterprise"`). ClawPump's developer page says call limits are "recorded but not enforced" and the tier swap fee is "not currently applied on-chain". Stored off-repo on the operator desktop and the founder laptop. Set on the STAGING api app as `CLAWPUMP_API_KEY`; no code reads it yet. |
| AI (model) credits | **0.** Separate from the API tier. See "Two meters" below. |
| Genesis | Agent `0f600d73-05a0-4c2e-8215-ab2a770ba192`, wallet `4FMiFU1Dv4qwfMHn3YukvaonhwrPt1T7VZ3yGuNRyY9n`, about 0.28 SOL + 12.02 USDC. Rules in its system prompt: four-mint list, at most $2 per trade under a $50 float, 10 percent of equity, one trade per hour, quote first, skip above 1 percent impact, keep 0.02 SOL, never transfer out, no perps, snipes or launches. Perps disabled on the agent. |
| Genesis proof trade | `swap_execute` 0.01 SOL to 1.021564 USDC, tx `5MpMtdFafzC4hoNs4m7Ho99bQMPddk7L83EKBFuaujLU69gSHFjvs66pzdccfEy9RWphRj3Fg94d4m7HiZvK4QRa` (Jupiter route, no platform fee). |
| Genesis schedule | Eight one-shot `scheduled_at` + `agent_prompt` automations, one every 3 hours from 2026-09-18 06:07Z. Each may sell $2 of SOL into USDC when USDC is under 60 percent of equity. Each fires 2 to 8 minutes late (cycle 2: due 09:06:58Z, fired 09:14:31Z). They run on the free tier, which answers on `openai/gpt-5.4-mini`, not the configured Kimi K2.5. Cycle 2 computed usdc_share 28.9 percent correctly, then wrongly judged 0.26 SOL (about $27) as "not worth more than $2" and did not trade. |
| Five fleet agents | SafeRebalancer `39a20e5e…`, Momentum `1a0a153e…`, AnsemDCA `a046d377…`, MeanRevert `a7d7c928…`, SignalFollower `38e89e13…`. Private (ClawPump requires an external wallet in settings before `is_public`), stopped, unfunded. |

## Two meters on ClawPump

1. **API key tier (Enterprise).** Counts calls that software makes to the ClawPump REST API with the `cpk_` key, and sets the swap fee. Direct swaps (`swap_execute`) run on this meter only; they worked with zero credits.
2. **AI credits.** Pay for the language model an agent thinks with while it runs on ClawPump's servers. All 415 models in the catalog are paid. The free tier gives 10 turns per account per rolling 24 hours, counted from the first use; automations spend the same quota. (Docs also say "1,000 messages/day shared globally" and "default 3"; the live account shows 10.) Exhaustion returns HTTP 402 `free_quota_exceeded` with a paid-fallback offer. A free chat can call more than one tool. Autonomous runs (`POST /agent-runs`, multi-step) fail at once with `last_error "[object Object]"` and zero tokens while the credit balance is 0. Credits are bought on the dashboard credits page by depositing USDC to the account deposit wallet, then syncing billing. Estimate (not measured): a run step is about 27k prompt tokens, about $0.02 to $0.03 per step, so about $10 covers a week of 8 multi-step runs per day.

The alternative that needs no ClawPump credits: ClawVille decides with its own model and uses the Enterprise key to call `swap_execute` for Genesis. That is the next build.

## Verified ClawPump facts (2026-09-17/18, by live call)

- **Connector:** remote MCP `https://mcp.clawpump.tech/mcp`, OAuth sign-in (Google or X), one connected client at a time. The old `clawpump.tech/api/mcp` and the keyless `agent_signup` of `@clawpump/mcp` 1.0.1 are dead (404).
- **REST base:** `https://ai-agents-production-6ca0.up.railway.app` (root, no `/api` prefix); header `Authorization: Bearer <cpk_ key>`. `GET /agents`, `GET /agents/:id`, `PATCH /agents/:id`, `GET /models/catalog`, `GET|POST /agent-runs`, `GET /agent-runs/:id/steps`, `POST /automations`, `GET|DELETE /automations/:id`, `GET /chat/:agentId/messages`.
- **Drift from the published client (`@clawpump/agents` 0.1.27):** `POST /automations` now requires nested `trigger: {type, config}` and `action: {type, config}`; the flat `trigger_type` / `trigger_config` body returns 400.
- **Agents:** `create_agent` is free and returns a ClawPump-custodied wallet. `swap_quote` / `swap_execute(agent_id, input_mint, output_mint, amount, slippage_bps)` route through Jupiter; `swap_execute` is opaque (no minimum-out binding), so ClawVille keeps float small and verifies after the fact.
- **No sign-message tool:** a ClawPump wallet cannot answer ClawVille's ed25519 pairing challenge. Ownership proof for a ClawPump wallet must use the authenticated `GET /agents` read (it lists each agent's wallet for the key's account) or a nonce micro-transfer.
- **Rotation drops a partner-granted tier.** The Enterprise grant was lost on a key rotation on 2026-09-17 and re-granted by ClawPump on 2026-09-18. Never rotate a partner-granted key; ask the partner to re-issue.

## Genesis runner (memecoin runners, founder option B, 2026-09-18)

Founder direction (09:45Z): stop the four-coin USDC rebalancer; trade Solana memecoin "runners" of at least a few hundred thousand dollars market cap, small size, with a fast loop. Design B = a no-LLM scanner that executes through ClawPump for Genesis's own wallet.

- **Where it runs:** the staging Hetzner box, `/root/runner-data/` (outside Coolify; plain `python3`, `setsid nohup`). Files: `runner.py` (the loop), `recorder.py` (read-only data recorder), `MODE` (`paper` or `live`, read once at start), `.cpkey` and `.rpc` (600, copied from the staging api container env `CLAWPUMP_API_KEY` / `HELIUS_RPC_URL`), per-mode state `runner_state_<mode>.json`, logs `runner_{evals,trades,closed,halts,skips,errors,meta}.jsonl`. Source of truth for the code: `C:\Users\itachi\Documents\Crypto\runner-data\` on the operator desktop (to be moved into this repo with the observe build).
- **Loop (15 s):** manage held positions first; then discover candidates (ClawPump `/intelligence/signals`, DexScreener boosts and profiles, GeckoTerminal trending pools); DexScreener pair data; filters: market cap $300k-$5M, liquidity >= $25k, 1 h volume / market cap >= 0.10, 1 h change >= +20 percent, >= 300 txns in 1 h, pair age >= 1 h, quote token SOL or USDC; chain checks: no mint or freeze authority, no risky Token-2022 extension (permanent delegate, transfer hook, transfer fee, non-transferable, pausable, default-frozen), top-10 holders < 20 percent excluding the pool vault.
- **Exits:** stop at 0.70x, take profit half at 1.5x, half of the rest at 2x, all at 3x, 25 percent trailing stop after the first take profit, 6 h time stop; exits run before discovery.
- **Risk:** $2 per position, max 3 open, $6 daily loss (realized losses, SOL costs and open losses; gains never offset) halts new buys for the UTC day, $15 lifetime loss floor, USDC >= position + $2 and SOL >= 0.02 before any buy, single-instance file lock.
- **Execution facts (recorded live 11:54Z with a $1 round trip):** `POST /swap/quote` and `POST /swap/execute` on the REST base accept `{agent_id, input_mint, output_mint, amount (smallest units), slippage_bps}`; mints must be base58 addresses (symbols are refused with 422). Execute is synchronous (~1 s) and signs server-side: 200 `{status:"executed", txHash}` or 400 `{status:"failed", txHash, error:"Swap transaction failed on-chain: ..."}` (the failed tx still lands and pays a fee). The response output amount is the QUOTE, not the fill; the runner books fills only from `getTransaction` balance changes of the wallet.
- **Where the filters come from:** the Artemis 2026-03/04 backup on the laptop USB drive (`D:\supabase-backups\pumpcaster\Artemis-us-west-2.dump`, 665 trending tokens, 76k mcap snapshots). In $300k-$5M, 27 percent of tokens reached 1.5x before -30 percent; volume/mcap >= 0.10, >= 300 wallets in 1 h, 1 h change >= +50 percent and top-10 < 20 percent each raised that to 40-48 percent. Small sample, no fees: directional only. The LotiScan backup has almost no closed outcomes in this range. The old agentClaim bots (PIQ, Artemis, buyback front-runner) all lost money with real or clean paper fills.
- **LIVE since 2026-09-18 12:45Z (`MODE=live`).** Review chain: v1 BLOCKED (12), v2 BLOCKED (unbooked ambiguous sells; unbounded failing exits), v3 BLOCKED (quote-echo check could block exits), v4 = v3 + the one-line fix the reviewer pre-approved (its `VERDICT: GO-LIVE-OK` condition). v4 adds: fills and failed-tx fees booked from the transaction; `book_shortfall` (tokens that leave the wallet unbooked count as a full loss); exit backoff 30-300 s and a 20-failed-exits/day halt; write-ahead `preflight` -> `pending_buy` states; HARD loss caps (a new position is refused unless its worst case fits under the $6/day and $15/lifetime floors, so at most 2 positions are open at once); no entries while any intent is unresolved; one entry per tick plus a second exit pass; Token-2022 extension allow-list; orphan scan at start. Before go-live: 0 armed automations, 0 DCA, 0 limit orders on Genesis (read-only listings).
- **First live runner trade (2026-09-18):** bought $2 of TIGRINO (`91ryaCo5...pump`, $315k market cap, PumpSwap pair) at 13:17Z, tx `2dFNniTXhcSeMWZ4ivRJC4vawFfBdJQCBEXtUm2Y68ctqU2LmzM743bfubpvRhfThm6nMiXpr4VsZR1QpsEWtiQa`; it peaked at 3.09x; the ladder sold at 1.5x (`gMzMfW8D...`, $1.74), 2x (`2WQBrRXM...`, $1.17) and 3x (`6SKaHJgb...`, $1.49): $4.40 back for $2, realized +$1.92 after $0.31 of SOL costs (token-account rent + fees). All four txs finalized with no error. One sample: not evidence of an edge.
- **Live results to 2026-09-18 18:00Z (5 closed trades):** TIGRINO +$1.92 (peak 3.09x, full ladder), Meepcat -$0.83 (stop), Tilcayo -$1.21 (stop; filled at 0.61x after one ClawPump safety refusal), SOLCAT -$0.98 (stop; never rose), GUMBUS +$0.43 (tp1 then trail; one on-chain slippage failure, retried). Net -$0.67. SOL costs per new token are $0.18 to $0.35 (token-account rent, higher for Token-2022, plus fees), i.e. 9 to 17 percent of a $2 position: at $2 the costs outweigh the filter effect. Forward check on the recorder (244 tokens, 18:00Z): all band samples 42 percent reach 1.5x before 0.7x; the current filters 32 percent (50 decided, correlated samples); one sample per token 75 percent (4 decided). Evidence is insufficient in both directions, so no parameter changed. Founder call: position size.
- **Founder change 2026-09-18 ~21:05Z: $10 positions.** Founder: "swap the sol, just leave enough for fees and raise the position size to $10". Swapped 0.185 SOL to 21.01 USDC (tx `4VBd9fg3HBU6rEy6ambaFYPSBio2CoNNKTNZTPmif4KvTaWBRRZBPXSQ58AmXBtoZ8LmeHJ6EkvLVZBF8KNxwZGh`); wallet after: 34.11 USDC, 0.0596 SOL (about 15 new-token rents). Runner limits now `position_usd` 10, `daily_loss_usd` 15, `total_loss_usd` 25 (the $6/$15 caps would have blocked every $10 entry under the hard-cap rule; 15/25 allow one open position at a time and were chosen by the operator, not the founder). Persona updated to match. Buys and sells stay against USDC: a SOL quote side would save about $0.002 per round trip, and token-account rent ($0.20-$0.35 per new token) is the same either way.
- **Tuning 2026-09-19 00:00-00:50Z (founder: keep $10, lower the restrictions, evaluate the missed runners, start now).** Evidence (scripts on the staging box: `analyze_coverage.py`, `analyze_missed.py`, `backtest.py`, `backtest2.py`): (1) 19 tokens doubled from an in-band moment in the first 13 h; the runner bought 2. Blockers: market-cap floor 10, never re-checked (the runner only looked at the current discovery lists) 5, age 5, volume ratio 4, 1 h change 4. (2) Buying each of 183 scanned tokens at first look with our exits: $150k-$300k +2.2% avg, 45% wins, 13/42 reached 2x; $300k-$1M -20.8%, 15% wins, 2/48 reached 2x; the volume-ratio filter rejected mostly losers (-11.7%, 1/60 doubled); the age filter rejected 9 tokens, 8 fell about 99%. (3) Full replay through the exit rules (recorder universe, 3% costs): every tested entry and exit variant is negative (best about -1% to -3% per trade); the 5-minute pullback rule showed no edge in the replay (it looked good only on an overlapping-sample metric, which was wrong to use). Changes live: $10 positions, daily cap $20, lifetime $25; market cap $150k-$300k; volume/mcap >= 0.05; 1 h change >= +10%; >= 150 txns/h; age >= 30 min; pullback rule off; a 12 h WATCHLIST re-checks every discovered token each loop; exits now trigger on ClawPump's executable sell quote for the held amount (DexScreener mark only as backup). DexScreener stays the discovery and market-data source: entry fills were within +-3% of its marks. One day of data: directional, not proven.
- **2026-09-19 01:00-03:00Z: LP lock rule, cap reset, new exits, all launchpads.**
  - **FEELSGOOD rug (-$10.20, 00:3xZ buy).** Its PumpSwap LP (`lp_supply` 100) was held by the creator wallet, which withdrew it 44 min after our buy; with no route and pool liquidity < $1000 the runner booked a full loss. Founder rule (stated before, violated): LP must be burned or locked. The runner had no LP check.
  - **LP lock check (`lp_lock_fail()` in `runner.py`).** A pool is tradable only when >= 95 percent of its liquidity is burned or permanently locked, read on chain per pool type: PumpSwap (LP mint supply; burned is 0), Raydium CPMM (LP in the Raydium lock PDA `3f7GcQ...` = seed `lock_cp_authority_seed` of `LockrWmn...`; LaunchLab's `MigrateToCpswap` runs `LockCpLiquidity`), Raydium AMM v4 (circulating LP minus burned or locked, against the pool's own `lp_amount` @720), Raydium CLMM (each position NFT held by the lock PDA `kN1kEz...` = seed `program_authority_seed`; ~26k locked positions, fee-collection txs only), Meteora DAMM v2 (`permanent_lock_liquidity` @552 / `liquidity` @360), Meteora DAMM v1 (LP in LockEscrow accounts owned by the pool program). Launch curves (pump.fun, Meteora DBC, Raydium LaunchLab) hold the reserves in the program and have no LP, so they pass. Meteora DLMM and Orca Whirlpool are refused (liquidity is per position with no standard permanent lock). 95 percent, not 99: Meteora launchpad migrations lock 97-99 percent (MCAT 98.6, EMBER 98.1, TRENDS 97.1); at 95 percent the most any wallet can pull is 5 percent of the pool. Tests on real pools: pass TIGRINO, Pepe (v4, 99.9 percent burned), StonkFun CPMM pools, MCAT/TRENDS/EMBER; refuse FEELSGOOD-type creator LP, CAT (CPMM, unlocked), STONK/SPYx CLMM (owner removed liquidity), Bonk v4 (39 percent unlocked), Bonk DAMM v1, DOG (DAMM v2, 25 percent locked), PERPSPAD (77 percent).
  - **Rugged handler.** No sell quote and pool liquidity < $1000: book the shortfall, free the slot, never re-enter the mint.
  - **Cap reset (founder 01:41Z: "just reset the caps so they keep trading").** `day_loss` 10.20 and `total_loss` 13.88 reset to 0 (recorded in `runner_state_live.json` `cap_resets`); limits unchanged ($20/day, $25 lifetime).
  - **Exits (02:05Z).** The second TIGRINO took 6 h for +$0.18 because the trail armed only after 1.5x and it peaked at 1.27x. Replay `backtest_trail.py` (72 entries, 14.7 h, 3 percent costs): old exits -1.0 percent avg per trade, "arm the trail at +15 percent, trail 15 percent" +3.1 percent (44 percent wins), better in both halves of the data (-3.7 to +1.1, +1.6 to +5.1). A 25 percent moonbag helped only in one half and was not adopted. Live: `trail_from_peak` 0.15, `trail_arm_mult` 1.15. Known limit: the loop reads prices every 15 s, so a fast drop can fill below the trail (hoverfly: peak 1.19x, filled 0.90x, -$1.20).
  - **All launchpads (02:35Z, founder: StonkFun and others were invisible).** Discovery accepts any quote token (StonkFun pairs quote in tokenized stocks such as SPYx); a verifiable pool type wins over deeper unverifiable pairs; GeckoTerminal `raydium-launchlab` pools added to the rotation. ClawPump routed a $10 StonkFun buy USDC -> SPYx -> token at 0.08 percent impact. StonkFun "reward" launches carry a 1-3 percent Token-2022 transfer fee and stay refused (`t22_transfer_fee`).
  - **Clean stop.** SIGTERM now finishes the current loop, saves state and exits; restarts never cut a swap.
  - **2 s exit thread (03:48Z, founder: "this is not code executed if you're just checking it every 15 seconds").** hoverfly and buggy trail exits filled about 11 percent below the trail level; the minute candles showed real one-minute dumps (buggy 1.41x to 0.84x inside one minute), not a bug. A second thread (`exit_watcher`) now re-quotes every open position on ClawPump every 2 s and runs the exit rules under a shared state lock; discovery and entries stay on the 15 s loop; the rug check and intent reconciliation stay on the main loop (the fast path never declares a rug). Failed exits retry after 5, 10, 20, 40, 80 s (was 30-300 s). Offline test: a fake price path fired the trail on the first quote below the level. Cost: no inference; about 1,800 ClawPump quotes per hour per open position on the Enterprise key (no per-call fee known), none while flat.
  - **Resting stops on Jupiter (research, not built).** Jupiter Trigger V2 supports stop-loss, OCO and trailing orders on every paid plan (not Pro-only), but the wallet must sign and funds move into a Privy vault; ClawPump holds Genesis's keys and its `limit_order_create` exposes only `trigger_price` (a V1-style limit order, so a sell below market would fill at once). Next option: a Helius websocket on the pool vaults (measured 0.2-0.5 s behind the chain).
  - **On-chain reserve check (04:40Z).** A pulled pool ends with LP supply 0, which the LP check read as burned, while DexScreener kept the old liquidity (copycat TIGRINO `AZt3...` and FEELSGOOD both showed liquidity above market cap). `pool_reserve_fail()` reads the pool's SOL or USDC vault on chain (PumpSwap, CPMM, AMM v4, DAMM v2) and requires at least $5k and a quarter of DexScreener's figure for that side. Tests: both pulled pools fail; TIGRINO, Pigeon, buggy, hoverfly, MCAT, NASDOG pass.
  - **Calmer entries tested and rejected.** Replay (84 entries, 16.6 h, new exits): current rules +1.9 percent per trade; liquidity >= $50k -16.3; 1 h change capped at +100 percent -2.3; liquidity/market cap >= 0.25 -15.7. The volatility is where the gains come from.
  - **Jupiter Tokens API replaces GeckoTerminal (05:27Z, founder: "it's not reliable for this").** GeckoTerminal returned 293 HTTP 429s on 09-18 and only one list a minute was safe. Discovery now reads four Jupiter Tokens API v2 lists every loop (`toptrending/5m`, `toptrending/1h`, `toptraded/5m`, `toporganicscore/5m`, 100 tokens each, about 0.2 s per call) with the paid key from the staging api env (`/root/runner-data/.jupkey`, 600). One pass finds about 324 mints in 0.6 s (was about 150). Usage: 16 calls a minute = about 700k credits a month of the Developer plan's 25M, 0.27 of the 10 req/s ceiling. Watchlist cap 600 -> 900.
  - **Filters relaxed (05:12Z, founder: age and liquidity too strict).** Age 30 min -> 10 min, liquidity $25k -> $15k. Replay on 18 h: age 10 min +3.2 percent per trade vs 30 min +0.9 (noisy, 20 min was negative); liquidity 10k/15k/20k/25k were identical because every in-band token already had more than $25k.
  - **BACKFILL, 2026-09-19 07:00-08:30Z: neither strategy has a proven edge.** The 18 h recorder replay was too small, so both rules were retested on real 15-minute GeckoTerminal candles (scripts `dip_backfill.py`, `genesis_backfill.py`, `exit_sweep.py` in the session scratchpad; universe = Jupiter lists, candle highs and lows drive the exits, 3 percent costs).
    - **Dip Hunter REJECTED and stopped.** 67 tokens, median 20.8 days: the live rule (24 h >= +50 percent, 1 h <= -15 percent) = 87 trades, 38 percent wins, **-5.1 percent per trade**; five looser and stricter variants all between -4.0 and -10.0 percent, both halves negative. The 18 h replay's +5.7 percent on 12 trades was noise. The paper process was stopped; its ClawPump agent (a7d7c928, renamed "ClawVille Dip Hunter") stays stopped, unfunded and private.
    - **Genesis's own entry rule also tests negative.** 47 tokens, 25,540 candles, median 5.5 days: live rule 69 trades, 42 percent wins, **-2.8 percent per trade**, nothing doubled; without the volume ratio -5.3; 1 h >= +20 percent -3.4; no 1 h filter -7.6; wider band 120-400k +0.7; no band 0.0.
    - **Exit sweep on the same 69 entries:** live exits -2.8 percent; the exits we replaced this morning -10.1 percent (the change was right); best tested = quick take-profits (half at 1.2x, rest at 1.5x, 10 percent trail armed at +10 percent) at **-0.6 percent per trade, 52 percent wins, median +0.6** but a smaller best trade (+31 vs +67 percent).
    - **Bias, stated both ways:** the backfill universe is today's surviving tokens (optimistic), stop and trail fills are assumed exact (optimistic), and it cannot apply the live liquidity, transaction-count, holder, LP-lock or reserve checks (pessimistic).
  - **2026-09-19 evening: two evidence-backed strategies, one per agent.** Founder: "improving the filters is expanding or removing them", plus two observations to test (we see coins only after they pump; some moon after we exit).
    - **Evidence A, our own log (2,084 coins evaluated in 12 h, first-sight price vs price now):** the old $150k-$300k band had the WORST forward prices of any band (median -98 percent, 10 percent up); $300k-$1M and $1M-$5M held up best; coins blocked ONLY by the age filter fell 95 percent (the filter earns its place); coins blocked only by the 1 h change were flat (median -0.1, 49 percent up).
    - **Evidence B, candle backfill with the live exits (47 tokens, about 5.5 days each, 3 percent costs):** $150k-$300k -0.55 percent per trade; $100k-$1M +0.34; with 1 h >= +20 percent +2.00; with volume/mcap >= 0.10 **+4.95 per trade, 66 percent wins, positive in BOTH halves**. Removing the volume filter scored -2.75. LIVE FILTERS NOW: mcap $100k-$1M, 1 h >= +20 percent, volume/mcap >= 0.10 (liquidity $15k, age 10 min, txns 150 unchanged).
    - **Entry timing (68 signals):** a SUSTAINED move (the rule already held 15 minutes earlier) scored +7.44 percent per trade at 70 percent wins, against +0.82 percent at 58 percent for a move that had just crossed the line. So entering "late" is better, not worse. LIVE: `SUSTAIN_S = 900`, a coin must pass the filters for 15 minutes before a buy (`not_sustained`).
    - **What we leave behind:** after our exit the price later reached a median of 1.36x our exit price and doubled 21 percent of the time, which is why the second agent exists.
    - **The two strategies (same entries, different exits):** Genesis = `quick` (half at 1.2x, rest at 1.5x, 10 percent trail armed at +10 percent): 70 percent wins, +7.4 percent per trade, best trade capped near +31 percent. ClawPump agent `1a0a153e` (renamed **ClawVille Runner**, wallet `AgTanzAa2cidQzJ8KEsm5mkhS18uaqBrAaas7XKHk4XE`) = `runner` (NO take-profit, 15 percent trail from the peak armed at +10 percent, 0.75x stop): 59 percent wins, +5.0 percent per trade, and across all signals it caught a +311 percent trade where `quick` capped at +31. It runs as profile `classic` (`classic_runner.py`, own state, logs and caps) in PAPER mode until the founder funds its wallet.
    - Overfit warning, stated in the docs on purpose: about 20 combinations were tested on 5.5 days of candles from coins that are still alive today, so the live edge will be smaller than the test.
  - **Results to 03:05Z (9 closed):** net -$3.97 after all costs (TIGRINO +1.92, Meepcat -0.83, Tilcayo -1.21, SOLCAT -0.98, GUMBUS +0.43, TIGRINO +0.18, FEELSGOOD -10.20, hoverfly -1.20, Pigeon +7.92 with 1.5x, 2x and trail exits, peak 2.66x). Wallet 33.60 USDC + 0.0527 SOL reconciles with the trade log to $0.01. ClawPump AI spend stays $0.08 (the runner uses no LLM; balance $10.12).
- **Safety history:** v1 was BLOCKED by an adversarial review (12 blocking items: duplicate buys from lagging balance reads, unknown execute outcomes, failed sells booked as done, fail-open impact gate, shared paper/live state, uncounted SOL costs, no balance check, no lock, slow exits, other traders on the wallet, unrecorded REST shapes). v2 fixes them; the 6 remaining ClawPump rebalance automations were deleted and the persona now states the runner rules. Live mode needs the v2 re-review verdict first.

## First autonomous trade and measured cost (2026-09-18 09:37Z)

- **Credits unblock runs.** The founder deposited about $10 to the credit wallet; `sync_billing` credited $10.195374 and the agent status changed from `stopped` to `running`. Runs that failed at once before now complete. So the instant failure was the 0-credit balance.
- **`config.system_prompt` does NOT reach autonomous runs.** On a run, Genesis reported no objective and no hard rules; it saw only its SOUL.md (name and skills). After `update_agent persona=<the rules>`, it repeated every rule word for word. Put agent rules in `persona`, not only in `system_prompt`.
- **Words that switch mode.** An objective that contained "SOUL.md" put the run into a "read-only web analysis mode": the runtime fetched `https://SOUL.md` and replaced the agent prompt. Do not put file names or domain-like words in objectives.
- **Unit error, fixed by a persona rule.** The first live decision computed usdc_share 28.9 percent and the $2 rule correctly, then requested 2 SOL instead of $2 of SOL; the swap tool refused it (insufficient balance), nothing moved. A "SWAP AMOUNT RULE" in the persona (amount in input-token units, $X of SOL = X / price, lamports example) fixed it.
- **First autonomous trade.** Run `07542bce-1ecf-4954-b879-73406e4f8677`, one step with `portfolio_balance`, `swap_quote`, `swap_execute`: 0.018901739 SOL to 2.000506 USDC, 0 percent impact, Jupiter v6, tx `21k5fZgAyCCv75Y5KemTZisWwu42HoHNDesaS7VW93iiby9cApaLZybbvk2KmiLcTCXEArVswVC8YA6dC99VP8ZQ` (slot 448045004, verified by `getTransaction`: USDC 12.016708 to 14.017214).
- **Measured cost (Kimi K2.5).** A step is 17k to 37k input tokens and 300 to 800 output tokens. Read-only run: $0.011. Decision run with a trade: $0.024 (one step). Day total for 7 steps: $0.0795, equal to the sum of run costs, so no hidden self-learning charge so far. At one decision run every 3 hours this is about $0.20 per day.

## Research pass 2026-09-18 (docs + public code + read-only live calls)

Sources: https://clawpump.tech/docs and its subpages, https://clawpump.tech/developers, https://clawpump.tech/guide, https://clawpump.tech/ansemhack, the public runtime github.com/Clawpump/claw-agent (a Hermes fork; the hosted platform server is private), and the MCP tool contracts. Nothing was spent or changed.

- **Whitelist = allowed transfer destinations.** `wallet_transfer` sends only to an address on the agent's whitelist and needs `confirm_transfer=true`. Genesis's whitelist is empty, so `wallet_transfer` cannot send anywhere. Swaps do not use the whitelist. OPEN: the always-on `private-transfers` skill (MagicBlock) has its own route; no source says it checks the whitelist. Ask ClawPump.
- **Forced skills.** `private-transfers`, `self-learning` and `skill-management` are re-added on every `update_agent`. Founder decision 2026-09-18: keep them. The dashboard describes self-learning as a daily digest, suggested skill changes that the owner approves, and advisory trade ideas. Its billing is UNKNOWN.
- **Hosting fee.** Hosting is free while launch spots remain, then 0.1 SOL per agent per month from credits (402 `HOSTING_PAYMENT_REQUIRED`). Whether our account is inside the free offer is UNKNOWN.
- **Start and stop.** Only the v1 API starts an agent: `POST https://clawpump.tech/api/v1/agents/{id}/start` and `/stop`. There is no MCP tool for it. Genesis is `stopped`. The instant run failure (`[object Object]`) has three candidate causes: 0 credits, the stopped agent, or the hosting fee. UNKNOWN which.
- **Credits.** The guide accepts SOL, USDC, CLAW or ANSEM with a 3 percent fee. The billing docs say SOL only, converted at the Jupiter spot price. Model prices carry a 30 percent markup over the provider price.
- **Market data today.** `get_news_feed` returns 503 "News service not configured". `intelligence_market` fails for SOL. `intelligence_perps` returns static market metadata. `get_indicators` returns SOL price, 24 h change and one sentiment word. `intelligence_signals` returns Bitget alpha-hunter and KOL buys of micro-cap tokens.
- **Execution path for a ClawVille-driven Genesis.** The public v1 `/swap/execute` returns an UNSIGNED transaction for external wallets. A ClawPump-custodied wallet signs only through the MCP `swap_execute` route (or the internal backend route). The ClawPump client build must use that route.
- **Hackathon.** Register, post on X, and tokenize by 20 September; "No token, no award". The token is per project. $CLAWVILLE is on the ClawPump token board since 2026-07-16; whether it counts as the entry token, and its verification against the registered X handle, is a founder item. Trader judging: "realised performance, risk control, onchain volume on Solana".

## Boundary

ClawPump supplies market intelligence and the founder's observed agent. It is not an execution rail. Its trade result lacks the quote binding, exact transaction validation, durable idempotency, captured signature, and explicit chain recovery required for ClawVille custody.

ClawVille executes fleet swaps only through Jupiter. The core observer can verify and score the founder's external ClawPump wallet after pairing. ClawVille does not hold that external wallet key and cannot halt its trades.

## Endpoint contract

| Purpose | Endpoint | Status |
|---|---|---|
| Board or agent intelligence | `TODO-SEAM:clawpump-endpoint-contract` | No path or response schema exists in the final specification. |
| Founder ownership challenge | `POST /api/admin/trading/pair/challenge` | Takes `avatarId` and `walletPubkey`. It returns the exact four-line ed25519 message and a single-use wallet nonce. The write also requires a separate money-operator nonce header. |
| Founder agent pairing | `POST /api/admin/trading/pair` | Takes `avatarId`, opaque `clawpumpAgentId`, `walletPubkey`, objective, wallet `nonce`, and detached base58 `signature`. It verifies wallet control, binds an observe-only agent wallet, and forces `operatedByClawville=false`. |
| Founder agent lookup | `GET /agents` + `GET /agents/:id` via `clawpump-client.ts` | Implemented. Authenticated list membership proves ownership; the detail read must agree on ID, user ID, and wallet. |
| Operator agent list | `GET /api/admin/trading/clawpump/agents` | Lists the API-key account's agents and their paired avatar identifiers. |
| Operator account provision | `POST /api/admin/trading/clawpump/provision` | Takes `clawpumpAgentId`. Creates or reuses a dedicated account with no custodial wallet and no autonomy start. |
| Operator observe-only pair | `POST /api/admin/trading/clawpump/pair` | Takes `avatarId`, `clawpumpAgentId`, and `objective`. Proves ownership and binds the wallet with `operatedByClawville=false`; the link never arms. |
| Operator unpair | `POST /api/admin/trading/clawpump/unpair` | Takes `avatarId` and `clawpumpAgentId`. Revokes observation and deletes the observe-only link without changing trade history or earned points. |
| Trade execution | None | Forbidden for ClawVille custody. |
| Public trader templates | `GET /api/floor/templates` | Implemented. No authentication, 60 requests per minute per IP, `Cache-Control: public, max-age=300`. Returns `version`, `model`, `skills`, `dashboardUrl`, and five `templates`. It calls no ClawPump API: the body is ClawVille's own text, read from `packages/shared/src/constants/trading-agent-templates.ts`. |
| Public house-trader watch | `GET /api/floor/house-traders` | Implemented. No authentication, 60 requests per minute per IP, `Cache-Control: public, max-age=15` plus a 15 second in-process cache. Always every `HOUSE_TRADER_LINEUP` slot (2026-09-19: Genesis, then ClawVille Runner), never the five templates. Read the count from the lineup, not from this sentence. Calls no ClawPump API: it reads `clawpump_agent_links`, `trading_wallets`, `users` and `verified_trades`. No wallet address, user id or identity fingerprint in the response. |
| Agent creation | None | ClawVille never calls ClawPump `create_agent`. The call takes no owner parameter, so the agent would hold the user's funds inside ClawVille's ClawPump account. The user creates it. |

All four operator routes require Lucia, `ADMIN_USER_IDS`, and the allowed Origin. POST routes also require JSON and a fresh single-use money-operator nonce. N1: a detail ID mismatch raises `ClawPumpAgentMismatchError` and returns 404 `clawpump_agent_not_owned`.

## House traders (founder lineup, 2026-09-19)

ClawVille runs TWO house traders (Dip Hunter was tested and dropped on 2026-09-19), held in
`packages/shared/src/constants/house-trader-lineup.ts`:

| Slot (`objective`) | Label | Strategy |
|---|---|---|
| `momentum-board` | Genesis | Momentum on small-cap memecoins that are not in a sharp five-minute dip, with on-chain safety checks before every buy and a trailing stop from the peak. Rules only, no AI decisions. |
| `intel-signal-follower` | ClawVille Runner | Sharp five-minute dips on small-cap memecoins, the same safety checks, and a wider trailing stop from the peak. Rules only, no AI decisions. |

**They are DISJOINT lanes** (clawPump, 2026-09-20 03:45Z), split on one
condition: the sharp five-minute dip. Genesis takes coins that are NOT in one,
the Runner takes ONLY coins that ARE, so the two can never buy the same coin at
the same moment. Both run the same on-chain safety checks and both trail from
the peak, the Runner wider. The earlier "same entries, different exits" wording
is RETIRED and wrong: it described the 2026-09-19 lineup and would present the
pair as an exit-rule A/B test on one coin stream. Neither note carries a
threshold, on purpose: the
rule loops run outside this repo and change without a deploy, so a number
published here would go stale silently. **Live P&L is PUBLIC** (founder order, 2026-09-20; the earlier no-P&L rule is
revoked). Each slot carries a `realised` block computed server side from that
avatar's FULL verified history: `closedPositions`, `wins`, `losses`,
`realisedUsd` (signed USD), `bestUsd`, `worstUsd`, `openPositions`,
`preBindIncluded`, `unpricedLegs`, `unclassifiedLegs`, `computedAt`. Basis is `gross_usdc_leg`, cost basis `round_trip_fifo`: legs are read row by row in chain-time order with NO
limit (a 50-row window read Genesis as +8.87 against a true -5.20), lots are matched FIFO by TOKEN UNITS, a partial sell
realises only the matched quantity, a lot with no exit after 24 hours counts as a total loss of its unmatched cost (a rug
has no sell leg), and a mint with a non-USDC quote leg, an unpriced, undated or non-positive leg is excluded whole and
counted (`excludedNonUsdc`, `unpricedLegs`, `undatedLegs`, `invalidLegs`, `unmatchedSells`). `computedOverTrades` is
compared with `counts.verified`; a mismatch or any exclusion sets the server-side `partial` flag. Gross of network fees and rent. Reconciliation (2026-09-20): the figure that holds across BOTH systems is NET, a single banked number with no basis
choice in it: Genesis 20 trips, net -5.20 USD; Runner 7 trips, net +4.05 USD (clawPump closed-trip files, live rows only).
The route reports GROSS on its own basis (`gross_usdc_leg`, FIFO by token units, whole-mint exclusions), so its figure is
NOT expected to equal clawPump's per-position gross. First read on the real staging DB, 10:12Z: Genesis closed 20, 10 wins,
10 losses, -0.05 gross, one no-exit write-off of 10.00 (the FEELSGOOD rug), `partial` from 5 unclassified legs that are
pre-runner hand swaps (53 verified rows - 5 = the runner's 48 legs); Runner closed 7, 4 wins, 3 losses, +6.14 gross.
Trip counts, win/loss splits and the negative Genesis sign match. OPEN: both route grosses read high against clawPump's
per-position gross (by 0.59 and 0.37); settle it per signature against `runner-data/sigs_GENESIS.txt` / `sigs_RUNNER.txt`. Never hand-type or
paste a figure into copy; read it from the route. No boast wording. Read each
slot's live `status` from the route rather than writing one here: a slot nobody
has paired reports `not-yet-running`, which is its real state.

ClawPump identities (clawPump, 2026-09-19): Runner = agent `1a0a153e`, wallet `AgTanzAa2cidQzJ8KEsm5mkhS18uaqBrAaas7XKHk4XE`,
funded 22:00Z, live since 21:58Z; Dip Hunter = agent `a7d7c928`, stopped, unfunded, private.

### Runner status feed (founder decision, 2026-09-20)

**Why it exists.** Genesis went cap-blocked at 03:25Z on 2026-09-20 (lifetime loss 14.95 against the 25.00 floor, so
14.95 + a 10.25 worst case would breach it), placed no trade for hours, and `halted` stayed `false` the whole time.
Nothing on any surface said so, and a reader saw a quiet trader rather than a blocked one.

**THE RULE: a pause is REPORTED, never INFERRED.** The rule loop runs outside this repo, so it is the only thing that
knows why it did not buy. ClawVille must never derive a pause from trade silence: silence is equally consistent with
"no candidate passed the filter", and guessing would publish an invented reason on a public board. A slot with no
fresh report carries `risk: null`, which means "we were not told" and is an honest answer.

**Who posts.** The runner, a Python process on the staging box owned by session clawPump. It is a MACHINE feed for our
own trader, not a player action: it settles nothing, writes no ledger row and has no `[ACTION:]` verb, so no agent and no
partner can call it. `PROTOCOL_VERSION` still went 66 to 67, because the READ side changed: manual section 17b now
documents the `risk` field, and hosted runtimes key their manual memory on the version.

**Cadence.** Post on every state change, plus a heartbeat every 60 seconds even when nothing changed. A report ages out
after 150 seconds, which is two and a half missed heartbeats: one lost post does not blank the badge, and a dead feed
clears it within three minutes instead of leaving a stale claim on a public board.

**Endpoint.**

```http
POST {apiBase}/api/floor/house-traders/status
Authorization: Bearer <HOUSE_TRADER_STATUS_TOKEN>
Content-Type: application/json
```

Body, all fields required except `detail`, and strictly validated (an unknown field is a refusal, not a silent drop):

| Field | Type | Rule |
|---|---|---|
| `wallet` | string | base58, 32 to 44 chars. MUST be the bound trading wallet of a current lineup slot. |
| `canEnter` | boolean | Can the runner open a position right now. The runner is the authority; the reason only explains. |
| `reason` | enum | `ok`, `daily_loss_floor`, `halted`, `insufficient_usdc`, `gas_reserve`, `at_max_positions`, `settling`, `price_feed_down`, `other`. |
| `detail` | string, optional | Max 120 chars. **A note containing anything that looks like a wallet is DROPPED WHOLE, not patched**, and the 200 comes back with `detailRedacted: true`. Detection runs on a copy folded to NFKD with every mark, format character, control, line and paragraph separator and default-ignorable codepoint deleted, then searched for `0x` hex and for a run of 32 or more base58 characters, so splitting an address with a zero-width space, a combining mark, a variation selector or a NEWLINE does not get it through. Note the newline: a Python traceback that happens to print a pubkey will cost you the whole note. Send figures and reasons, not addresses. What survives detection is then rendered: invisible characters deleted, remaining non-printables to a space, whitespace collapsed, capped. An empty result stores as `null`. |
| `dayLossUsd` | number | Finite, at or above 0. |
| `dayLossCapUsd` | number | Finite, above 0. A zero cap would render as "14.95 of 0.00". |
| `roomNeededUsd` | number | Finite, at or above 0. Headroom needed before the runner can enter again. |
| `at` | string | **The time you SEND this post.** Not the time the state began, and not a value you cache alongside the state: stamping it fresh on EVERY post, including a heartbeat that reports no change, is what we expect you to build. An IDENTICAL `at` is nevertheless TOLERATED and still refreshes, so a naive resend-last-payload heartbeat keeps working; see ORDERING below for why we accept it rather than treat it as a replay. ISO 8601, and send ISO 8601: parsing is `Date.parse`, which is lenient and will also accept forms this contract does not promise, and the server stores the normalised ISO 8601 UTC form whatever you send. Must parse AND sit inside an ASYMMETRIC window: at most **60 seconds AHEAD** of server time, and at most 10 minutes behind. Else `stale_timestamp`. The future side is the tight one because a future `at` is stored and then outranks every later report until the wall clock catches up, so a fast clock you later correct would black out the board for as long as that bound allows. |

Two body rules that are easy to trip and are refusals, not warnings. `{canEnter:false, reason:'ok'}` is REFUSED: it says
"I cannot open a position and nothing is wrong", which the classifier would otherwise read as `live`, so the board would
print a working trader over a report saying the opposite. The mirror, `{canEnter:true, reason:'daily_loss_floor'}`, IS
accepted and reads `live`; that is the tick a runner recovers on, and it is also how a `price_feed_down` fault arrives
from a runner that still believes it could enter.

**ORDERING: only a report that is STRICTLY OLDER than the one we hold is dropped.** HTTP does not promise delivery
order, so the store compares the incoming `at` with the `at` it already holds for that wallet. Strictly older answers
`200 {ok:true, ignored:'older_report'}` and the store is not touched: a delayed `canEnter:false` landing behind the
newer `canEnter:true` would otherwise pin a pause on a trader that has already recovered. It is a 200, so do NOT retry
it. EQUAL OR NEWER is stored and refreshes the receipt time the 150 second ageout measures from, which is what keeps an
unchanged pause on the board across heartbeats. Sending a fresh `at` on every post is what we expect you to build, but
an identical one is deliberately TOLERATED rather than rejected: a naive heartbeat that resends its last payload
verbatim must never be the reason a live pause disappears from a public board.

**The ordering rule switches OFF once the held report goes stale.** It only applies while what we hold is still inside
its 150 second life. A stale report is already publishing `risk: null`, so there is nothing left for the rule to
protect, and any valid report takes over. That is a deadlock breaker: together with the 60 second future bound it means
a runner that banked a fast-clock timestamp and then corrected itself is locked out for at most 60 seconds, never for
the ten minutes the old symmetric window allowed.

**ACCEPTED RISK: two reports carrying the SAME millisecond are not ordered.** Whichever arrives second wins. This is
safe because the runner posts from ONE sequential loop, so it cannot produce two different states inside a single
millisecond; if it ever could, ordering them would need a sequence number rather than a clock. Do not parallelise the
post loop without telling us.

An earlier draft of this contract dropped an equal `at` as a duplicate. That was wrong and is recorded here so it does
not come back: a desk paused for ten minutes heartbeats every 60 seconds, and if `at` describes the STATE rather than
the POST then every one of those heartbeats carries the same value, none of them refresh the receipt time, and the
board drops the PAUSED badge after 150 seconds while the runner is still reporting the pause correctly. That is the
Genesis failure this feature exists to prevent, reproduced in three minutes with a healthy feed. Two things fix it
together and both are part of the contract: `at` is the SEND time of the post, and equal stores. Equal is not a replay
hole, because the plus or minus 10 minute window already bounds a replayed body to re-asserting a state at most ten
minutes old, and your next heartbeat corrects it within 60 seconds.

Answers: `200 {ok:true, wallet, receivedAt}`, plus `detailRedacted: true` when a note was sent and dropped for
carrying an address · `200 {ok:true, ignored:'older_report'}` (see ORDERING above; accepted,
not stored) · `400 {error:'invalid_body'}` (any zod failure, including the contradiction
above and an `at` that is not a timestamp at all) · `400 {error:'stale_timestamp'}` (a well-formed time outside the 10
minute window, in either direction; kept separate from `invalid_body` because "fix your serialiser" and "fix your clock,
or stop replaying" are two different fixes) · `400 {error:'invalid_json'}` (malformed JSON, answered by the API's global
body guard before this route runs) · `401 {error:'unauthorized'}` · `404 {error:'unknown_wallet'}` ·
`415 {error:'unsupported_media_type'}` (content type is not `application/json`; a `charset` parameter is fine) ·
`429 {error:'rate_limited'}` (30 per minute per IP) · `503 {error:'not_configured'}` when `HOUSE_TRADER_STATUS_TOKEN` is
unset, so an un-provisioned box is OFF rather than open.

The `Authorization` scheme is matched case-insensitively (RFC 7235), so `bearer` and `Bearer` both work.

**A stopped slot is accepted but never published.** If an operator revokes the trading wallet while the runner keeps
heartbeating, the POST still returns 200 and the state is stored, so a re-pairing has current state immediately. The
GET publishes `risk` only for a `live-observed` slot; a `stopped` slot always reads `risk: null`, because both human
surfaces show STOPPED and already say why that desk is idle. Do not read a 200 as "the board is now showing this".

**What the board does with it.** `GET /api/floor/house-traders` gains a `risk` block per slot:
`{ state, reason, detail, dayLossUsd, dayLossCapUsd, roomNeededUsd, at, ageSeconds }`, or `null` when the slot is
unpaired, is stopped, has never reported, or has aged out. `state` is `paused` only when `canEnter` is false AND the reason is
`daily_loss_floor`, `halted`, `insufficient_usdc` or `gas_reserve`; `fault` for `price_feed_down` or `other` whatever
`canEnter` says, so a dead price feed is never dressed up as a deliberate risk decision; `live` for everything else,
including `at_max_positions` and `settling`, which are working states. The merge runs on every request, outside the
route's 15 second in-process cache, so a pause and a recovery both show on the next poll.

**Two caches, two different bounds.** The route keeps a 15 second in-process cache of the SLOT data (counts, tape,
realised), which is fine because those move slowly, and it serves `Cache-Control: public, max-age=5` so a shared cache
may replay a whole response, `risk` included, for at most 5 seconds. The header is the shorter of the two deliberately:
at 15 seconds an edge could serve "Paused by risk limit" for 15 seconds after the trader recovered, which undoes the
reason the merge sits outside the cache at all, and it could serve a report 15 seconds past its 150 second life. WORST
CASE as built: a pause, or a recovery, is visible within one client poll plus 5 seconds, and a report served from an
edge is at most 155 seconds old rather than 150.

**Operational notes.** The state lives in an in-process Map, one entry per wallet, last write wins, hard-capped at 16
entries with insertion-order eviction, no table and no migration: it ages out in 150 seconds, carries no money and has
no history obligation. **It is per API PROCESS**, which is one api container today, and it dies on every deploy: post to
ONE host, and expect every slot to read `risk: null` right after a flip until the next heartbeat lands. If the api is
ever scaled to more than one container, this feed needs shared storage before that happens, because each container
would otherwise answer from its own partial view. The token is never logged and never echoed in an
error body. The wallet is a join key only and never reaches the public response.

**NOTHING PAGES ON A PAUSE, and that is a deliberate choice, not an oversight.** This feed drives the BOARD only. A
report of `state: 'paused'` raises no alert, sends no Telegram message and writes no `alertError`. Record it here
because the founder's 2026-09-20 complaint was precisely that nothing reported the cap block: a board that shows
PAUSED beside a pager that stays silent is an improvement, not a fix. Alerting is a separate decision with its own
thresholds and its own noise budget, and it should be taken deliberately rather than discovered missing later.

**Dropped 2026-09-19: `sol-usdc-mean-reversion` / "Dip Hunter".** It was
backtested, REJECTED and stopped the same day and will never be paired, so its
entry was REMOVED rather than left as a `not-yet-running` slot, which would have
advertised a trader that is not coming. The objective stays valid as a copyable
TEMPLATE only, and `readHouseTraderSlots` filters candidates to the lineup
BEFORE selection, so a stray link on it can never resurrect a public slot.

The remaining profiles were DROPPED as house traders; they remain only as
copyable templates. These two are **not** the templates below and no copy may
say they match: a template is a user starting point, while a house trader runs
the operator's own rule loop on ClawPump, outside this repo. So the profile
brief and allowed outputs in `trading-fleet.ts` do NOT describe a house trader,
and Genesis proves it by holding `momentum-board` while trading small-cap
memecoins on any venue. `objective` survives only as the join key into
`clawpump_agent_links`. A `strategyNote` carries no numbers, because the rule
loops change without a deploy.

## Data sources: what each one is for (2026-09-19 22:10Z)

The founder asked whether the runner leans on Jupiter and ClawPump enough. The
answer came from measurement, not opinion, and it changed the runner.

**The defect.** DexScreener rejected **1,837 of the last 2,000** batch calls with
HTTP 429, on both agents at once. The runner therefore priced a median of 69
tokens a minute against a 900-token watchlist. Jupiter supplied 83 percent of
all evaluated candidates but only 3 of 15 buys, because most Jupiter-discovered
mints never got priced. The cause was our own load: two agents times 30 batch
calls every 15 seconds, plus the recorder, against one free API on one IP.

**The fix.** Jupiter now decides which mints are worth pricing, and DexScreener
still decides whether to buy. `/tokens/v2/search` returns 100 full token objects
per call in 0.12 seconds on our paid key. `jup_screen()` applies a deliberately
LOOSE version of the live filters; only the survivors go to DexScreener, whose
numbers the thresholds are tuned on, so no threshold changes meaning.

Each pre-screen bound is a live filter widened by the measured ratio between the
two sources (112 tokens, same instant): market cap median 1.00 (p10 0.94, p90
2.01), liquidity median 0.55 (p10 0.47), volume median 1.19, transactions median
1.51, age median 1.01, and 1-hour change a median 0.31 points apart. The spread
is explained: DexScreener reports ONE pair, Jupiter reports the token across all
its pools, and Jupiter counts liquidity one-sided.

**Proof it loses nothing.** On 165 live tokens the live filters accepted 8 and
the pre-screen kept 8 of 8, while DexScreener batches per loop fell from 9 to 1.
Re-run `screen_check.py` after any change to `FILTERS`.

**Measured result.** Before: 1,837 of 2,000 error entries were DexScreener 429s.
After: **zero errors in 240 seconds across both agents**, 16 ticks each exactly
on the 15-second schedule, every screened candidate priced. `WATCH_MAX` rose
from 900 to 2,500, because the watchlist is now bounded by Jupiter (25 calls, 0.6
requests a second against a 10 per second plan) instead of by DexScreener.

**Three things we did NOT do, and why.** Each was a plausible idea that the data
refused:

1. *Use ClawPump `/intelligence/market` to find a verifiable pool when the
   DexScreener pair cannot be checked.* The fail code `lp_unverifiable_dex` did
   not fire once in 24 hours, because `key_of()` already prefers a checkable
   pool. Building this would have fixed a problem we do not have.
2. *Gate on Jupiter's `audit.mintAuthorityDisabled` and `freezeAuthorityDisabled`.*
   `chain_checks()` already reads both authorities on chain. The gate would have
   been a second copy of a check we pass today.
3. *Add eight more Jupiter discovery lists.* They returned 115 mints we did not
   already have, and **0** of them passed the pre-screen. The longer windows
   surface established tokens with no fresh move, and the 12-hour watchlist
   already keeps anything the 5-minute and 1-hour lists saw.

### A refused quote no longer buries a coin for six hours (2026-09-20 00:20Z)

`enter()` stamps the re-entry cooldown BEFORE it sends a swap, so a crash can
never re-buy the same coin. That part is right and stays. The defect was what
happened when the swap was refused BEFORE anything was sent: the position was
deleted and the full six-hour stamp was left in place, so a coin that had passed
every filter was locked out over one bad quote.

It cost a trade, and both agents were live to prove it. At 00:15:38Z Genesis
evaluated JEANTRUMP (`DgAEy7sL…`) with an empty fail list, then refused the buy
on a 3.37 percent price-impact reading, above the 3 percent limit. The refusal
was correct. The six-hour lockout was not. ClawVille Runner quoted the same coin
19 seconds later, got an acceptable impact, bought it at 00:15:58Z and closed it
at +0.51 USD.

The intent had been there since 2026-09-18: `fail_cooldown_s` (30 minutes) was
defined and **used nowhere in the file**.

The fix is `short_cooldown(state, mint)`, which back-dates the stamp so exactly
`fail_cooldown_s` remains. It is called on the balance-too-low skip, and in the
failed-swap branch ONLY when `pos['status'] == 'preflight'` — that status means
the write-ahead `on_send` marker never ran, so `/swap/execute` was never called
and nothing left the wallet. A refusal that may have landed keeps the full
window. Verified by `test_cooldown.py`, 6 of 6:

| Case | Lockout |
|---|---|
| Normal entry | 6 h |
| Refused before sending (bad quote, echo mismatch, impact) | **30 min** |
| `pending_buy` (may have landed) | 6 h |
| `unknown_buy` (unresolved) | 6 h |
| `open` | 6 h |

Both agents restarted on this code at 00:20Z and 00:24Z, checksum-identical.

### Why we still buy pump.fun pools (2026-09-19 22:35Z)

The founder asked twice why the runner keeps landing on pump.fun coins. The
funnel says the cause is not discovery and not the market filters:

| Stage | pumpswap | raydium | meteora | orca |
|---|---|---|---|---|
| evaluated (24 h) | 63,322 | 73,821 | 18,055 | 9,311 |
| passed the market filters | 589 | 479 | 33 | 12 |
| passed every chain check | **127** | **11** | 0 | 0 |

Discovery is not pump.fun biased. Raydium is in fact the larger half. The
narrowing happens in the chain checks, and two of them do it.

**Blocker one: the Token-2022 transfer fee.** It refused 45 Raydium tokens in 24
hours, several up more than 400 percent in the hour. Measured on chain: 17 carry
a 1 percent fee, 23 carry 3 percent, none higher. The fee authority is live on
all 45 and the maximum fee is uncapped, but Token-2022 stamps a raised fee with
`current_epoch + 2`, about two days, while our longest hold is six hours, and we
already read the pending fee as well as the live one. So a creator cannot raise
the fee on a position we hold.

A 100 bps limit was written and tested against all 45 tokens. It admitted every
1 percent token and still refused every 3 percent one, with both regression
checks clean. **It was then reverted**, because all 24 tested fee tokens ALSO
fail the top-10 holder check. It would have added about 2 points of round-trip
cost and admitted nothing. The test script is `test_fee.py`.

**Blocker two: top-10 holder concentration above 20 percent.** This is the
largest single chain refusal, and it refuses every venue about equally (422
pumpswap, 396 raydium, 33 meteora, 9 orca in 24 h). The check removes the pool's
own vault before counting, but only ONE vault, matched to one DexScreener pair,
so a multi-pool token counts its own liquidity as insider supply.

That defect is real and it is small. Resolving the owner of every large account
against the AMM programs, across 12 tokens refused for concentration alone,
showed real wallets holding 28 to 43 percent of supply. **Eleven of the twelve
still fail once the pools are excluded correctly.** So the check is measuring
genuine concentration and the threshold stays at 20 percent. The script is
`test_top10.py`.

Our own 15 trades carry top-10 at entry, which is the only at-entry
concentration data we own. Under 12 percent averaged +0.24 USD over 5 trades;
12 to 20 percent averaged -0.34 USD over 10. That gap is one trade: the
FEELSGOOD rug at -10.20 USD. Without it the second group averages +0.75 USD. The
sample does not support moving the threshold in either direction, and it is
recorded here so it is not read as though it did.

**Recorded, not used.** `jup_extras()` logs Jupiter's organic score, holder
count, net buyers, buy-volume share and launchpad on every evaluation and every
buy. Nothing gates on them, because we hold no history to set a threshold
against. They are stored so the trade record can answer that question later.
Setting a threshold on them today would be a guess.

## Trader templates (2026-09-19)

ClawVille publishes five copyable ClawPump trader templates, one per fleet
objective. `GET /api/floor/templates` serves them and the Trading Floor tab
renders them from the same constant, so the two cannot disagree.

- **Source:** `packages/shared/src/constants/trading-agent-templates.ts`. Every
  persona line is DERIVED from `TRADING_OBJECTIVE_BRIEFS`,
  `TRADING_OBJECTIVE_ALLOWED_OUTPUTS`, `TRADING_OBJECTIVE_MIN_USDC_SHARE_PCT`,
  `TRADING_CODE_LIMITS` and `TRADING_DEFAULT_COOLDOWN_SECONDS`, so the published
  text cannot drift from the fleet rules. Only the DISPLAY NAMES match the five
  live agents (Momentum, AnsemDCA, MeanRevert, SignalFollower, SafeRebalancer);
  the rule set is ClawVille code, not any live agent's hand-written prompt.
- **The numbers, and where each comes from.** Mint list from
  `TRADING_OBJECTIVE_ALLOWED_OUTPUTS`, rendered through an inverse map that
  prints WSOL as `SOL` (same idiom as `autonomous-trading-targets.ts:38`).
  USDC floor from `TRADING_OBJECTIVE_MIN_USDC_SHARE_PCT`, carrying the exact
  rule `objectiveUsdcShareBreached` (`trading-guardrails.ts:269-282`) applies:
  it fires only when the trade SPENDS USDC. `$25` from
  `TRADING_CODE_LIMITS.maxTradeUsd`; 10 percent of equity is a template value,
  not the executor's 25 percent float cap. 3 percent quote impact from
  `maxQuoteImpactPct`. 5 minutes of pacing from the exported
  `TRADING_DEFAULT_COOLDOWN_SECONDS` (300 s), which `readTradingLimits` now uses
  as its own fallback so there is one source. 0.02 SOL from
  `minSolReserveLamports`. The shared constant deliberately does NOT call
  `readTradingLimits()`: that reads `process.env`, which would make the persona
  environment-dependent and let the API and the web bundle disagree.
  Genesis's runner rules ($2, one hour, 1 percent) are NOT used: those are
  operator settings for one memecoin runner, not user defaults.
- **Enforced versus suggested.** The same rules run server side in
  `trading-guardrails.ts` for the profiles ClawVille signs for and refuse the
  trade. On a ClawPump wallet the identical text is only an instruction to the
  model, because ClawVille holds no key there. `guardrailNotes` line one states
  exactly that distinction.
- **Rules live in `persona`.** `config.system_prompt` does not reach an
  autonomous run (see "Verified ClawPump facts"), so the manual, the UI and
  Nori all say to paste the text into the PERSONA field. Note that the five
  live agents still carry their rules in `system_prompt`; the templates
  deliberately do not copy that mistake.
- **Verified live 2026-09-19, by read-only call:** the four skill slugs
  `defi-trading`, `portfolio`, `market-intel`, `wallet-ops` all exist in
  `list_available_skills`; `moonshotai/kimi-k2.5` exists in the model catalog;
  the dashboard is `https://agents.clawpump.tech/dashboard` and the credits
  page is `/dashboard/credits`. ClawPump re-adds forced skills of its own
  (`action-plans`, `private-transfers`, `bitget-intel`, `self-learning`,
  `skill-management`) on every update, so the four are what the user enables,
  not what the agent ends up with.
- **The model is a SUGGESTION and the copy says so.** Line 18 of this file
  records that the five agents "run on the free tier, which answers on
  `openai/gpt-5.4-mini`, not the configured Kimi K2.5". So
  `TRADING_TEMPLATE_MODEL` always travels with `TRADING_TEMPLATE_MODEL_NOTE`,
  which states that ClawPump answers on its own free-tier model until the
  account buys AI credits. Naming the model without that note would be a false
  claim in outward copy.
- **Two deliberate deviations from the live prompts.** The templates follow the
  CODE, not the hand-written live prompts. `intel-signal-follower` omits
  `$CLAWVILLE` and `momentum-board` omits `$ANSEM` and `$CLAWVILLE`, because
  `TRADING_OBJECTIVE_ALLOWED_OUTPUTS` does not list them, even though the live
  prompts name them (checked against live `get_agent` on ClawVille Momentum,
  2026-09-19). The templates ask for 10 percent of equity per trade, not the
  executor's 25 percent float cap, because that cap governs swaps ClawVille
  signs and never reaches a ClawPump wallet.
- **The live five keep their rules in `system_prompt`.** Verified by
  `get_agent` on ClawVille Momentum, 2026-09-19. That is the exact mistake the
  "Verified ClawPump facts" section documents, so the templates are more
  correct than the live agents. Worth a founder pass on the live five.
- **Unverified:** the ClawPump persona field length limit. The 1200-character
  cap in the test is a safety margin, not a measured limit.
- **No scoring yet, and the copy says so.** A ClawPump wallet cannot sign the
  bind message, and `reportTradeSignature` (`services/trade-observer.ts`)
  refuses a reported signature whose signers hold no already-bound wallet
  (`wallet_not_bound`, 409). So a user cannot register a ClawPump wallet by
  pasting a signature. The exact-dust ownership proof that would fix this is
  wave B and is not built.

## Fixture inventory

The agent lookup uses `apps/api/src/services/__tests__/__fixtures__/clawpump/get-agent-genesis.json` and its `.source.json` sidecar. The fixture contains trimmed MCP-recorded `get_agent` output, not a recorded REST body. Client tests cover bare and wrapped agent responses plus array and `{agents}` list responses.

`TODO-FIXTURE:clawpump` remains for the separate board or intelligence client only.

Six trade fixtures and their `.source.json` sidecars live under `apps/api/src/services/__tests__/__fixtures__/trade/`:

| Fixture | Verification result |
|---|---|
| `genesis-sol-usdc-route.json` | Jupiter `route`: SOL to USDC. |
| `genesis-usdc-sol-route.json` | Jupiter `route`: USDC to SOL. |
| `genesis-sol-usdc-shared-route.json` | Jupiter `shared_accounts_route`: SOL to USDC. |
| `jupiter-usdc-meme-route-v2.json` | Jupiter `route_v2`: USDC to memecoin, with token-account rent netting. The verifier combines pump accumulator rent and token-account rent into one adjustment. It applies this adjustment only toward zero, so rent can never create or flip a SOL leg. N8 residual: rent paid by another party can hide a same-size real SOL outflow inside a swap. The hidden amount cannot exceed the wallet's real outflow and gives no scoring benefit. |
| `jupiter-usdc-meme-route-v2-multihop.json` | Jupiter `route_v2`: USDC to memecoin through multiple pools. |
| `jupiter-shared-route-v2-foreign-leg.json` | Jupiter `shared_accounts_route_v2` pin; refuses `vault_flow_mismatch`. |

The Jupiter fixture inventory is separate. The four files live under `apps/api/src/services/__tests__/__fixtures__/jupiter/` and their SHA-256 values are fixed in the Wave 2 report.

## Operations

### Founder pairing

1. Set `CLAWVILLE_API_URL`, `CLAWVILLE_OPERATOR_ORIGIN`, and `CLAWVILLE_OPERATOR_COOKIE` for the target environment.
2. Add `--production` for `api.clawville.world` or `CLAWVILLE_ENV=production`.
3. Run `bun apps/api/scripts/trading/pair-genesis.ts [--agent <uuid>] [--objective <TradingObjective>] [--production]`.

The default agent is Genesis (`0f600d73-05a0-4c2e-8215-ab2a770ba192`); the default objective is `momentum-board`. The script lists owned agents with their IDs, names, status, wallets, and paired avatar identifiers. It refuses an absent agent. It obtains a nonce and provisions the dedicated account, then prints `avatarId`, `avatarName`, and `created`. It obtains another nonce and pairs that account, then prints `replayed`, `boundSlot`, and the wallet public key. N4: the first backfill after pairing can send up to 5 refusal alerts per wallet in the first hour, one per reason.

To unpair, run `bun apps/api/scripts/trading/pair-genesis.ts --unpair [--agent <uuid>] [--production]`. The script requires `pairedAvatarId` from the list, obtains a nonce, calls `/clawpump/unpair`, and prints `alreadyUnpaired`. This stops observation, retains trade history and points, and does not halt ClawPump trades.

The legacy signature routes retain their wallet-nonce policy:

The wallet nonce expires after two minutes and is consumed once. The money-operator nonce is separate and expires after one minute.

### Signal client

1. Record read-only ClawPump responses from the approved environment.
2. Remove credentials and preserve each file byte-for-byte.
3. Record SHA-256 values.
4. Define an HTTPS host allowlist and explicit path prefixes.
5. Derive strict Zod schemas from all fixtures.
6. Add daily call accounting and bounded timeouts.
7. Keep execution methods absent.
8. Run only fixture-backed tests before staging.

`CLAWPUMP_API_KEY` gates signal reads only. Its absence must never stop Jupiter execution. `CLAWPUMP_FIXTURE_DIR` is test only, and staging or production refuses boot when it is set.
