# ClawPump integration

**Last Audited: 2026-09-18 (docs + code research pass, 09:30Z).** Corrections from the research pass are in "Research pass 2026-09-18" below; they override older lines in this file. Founder direction changed the boundary: the traders must RUN IN CLAWPUMP. One agent first: **Genesis**, the founder's ClawPump agent, trades on ClawPump with its own ClawPump-custodied wallet. The fleet of five is paused (five ClawPump agents exist but are private, stopped and unfunded). ClawVille code still contains NO ClawPump client: nothing in `apps/api` calls ClawPump yet, and ClawVille does not yet observe or rank Genesis's wallet. The section "Verified ClawPump facts" below is the ground truth for the next build.

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
| Founder agent lookup | `TODO-SEAM:clawpump-endpoint-contract` | A later API-driven lookup needs a documented path, response schema, and recorded fixture. |
| Trade execution | None | Forbidden for ClawVille custody. |

## Fixture inventory

`TODO-FIXTURE:clawpump`: the supplied scratchpad contains no ClawPump JSONC fixture. The client must remain absent until recorded fixtures define strict response schemas.

The Jupiter fixture inventory is separate. The four files live under `apps/api/src/services/__tests__/__fixtures__/jupiter/` and their SHA-256 values are fixed in the Wave 2 report.

## Operations

### Founder pairing

1. Set `CLAWVILLE_API_URL`, operator origin, operator cookie, and genesis avatar ID.
2. Add `--production` when the API host is `api.clawville.world`.
3. Run `bun apps/api/scripts/trading/pair-genesis.ts <walletPubkey> --challenge [--production]`.
4. Sign the returned `messageToSign` with the ClawPump wallet.
5. Keep the returned wallet nonce and encode the detached signature as base58.
6. Run `bun apps/api/scripts/trading/pair-genesis.ts <walletPubkey> <walletNonce> <signature> [--production]`.
7. If the key is not available locally, export genesis's detached signature from its signer and submit the same message.

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
