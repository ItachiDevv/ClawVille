# ClawPump integration

**Last Audited: 2026-09-18.** Founder direction changed the boundary: the traders must RUN IN CLAWPUMP. One agent first: **Genesis**, the founder's ClawPump agent, trades on ClawPump with its own ClawPump-custodied wallet. The fleet of five is paused (five ClawPump agents exist but are private, stopped and unfunded). ClawVille code still contains NO ClawPump client: nothing in `apps/api` calls ClawPump yet, and ClawVille does not yet observe or rank Genesis's wallet. The section "Verified ClawPump facts" below is the ground truth for the next build.

**Previous audit (2026-09-16):** Trading Floor wave 2d requires a signed wallet-ownership challenge before founder pairing. The ClawPump signal client remains blocked because the immutable specification contains no endpoint paths, response schemas, or recorded ClawPump fixtures.

## Current operating state (2026-09-18)

| Item | State |
|---|---|
| ClawPump account | "Hoodie Management", Google sign-in, user `b40f15d4-fb15-458b-94ee-690607725e6c`, deposit wallet `GGzvQQMunrhPEuaCatbMHScpxfps1cAxmU7E4vGQJeoh`. |
| API key | `cpk_` + 43 chars, ENTERPRISE (10,000,000 calls/month, 0.10% swap fee). Stored off-repo on the operator desktop and the founder laptop. Set on the STAGING api app as `CLAWPUMP_API_KEY`; no code reads it yet. |
| AI (model) credits | **0.** Separate from the API tier. See "Two meters" below. |
| Genesis | Agent `0f600d73-05a0-4c2e-8215-ab2a770ba192`, wallet `4FMiFU1Dv4qwfMHn3YukvaonhwrPt1T7VZ3yGuNRyY9n`, about 0.28 SOL + 12.02 USDC. Rules in its system prompt: four-mint list, at most $2 per trade under a $50 float, 10 percent of equity, one trade per hour, quote first, skip above 1 percent impact, keep 0.02 SOL, never transfer out, no perps, snipes or launches. Perps disabled on the agent. |
| Genesis proof trade | `swap_execute` 0.01 SOL to 1.021564 USDC, tx `5MpMtdFafzC4hoNs4m7Ho99bQMPddk7L83EKBFuaujLU69gSHFjvs66pzdccfEy9RWphRj3Fg94d4m7HiZvK4QRa` (Jupiter route, no platform fee). |
| Genesis schedule | Eight one-shot `scheduled_at` + `agent_prompt` automations, one every 3 hours from 2026-09-18 06:07Z. Each may sell $2 of SOL into USDC when USDC is under 60 percent of equity. On the free tier the agent stops after one tool call, so these wake Genesis but may not complete a decision. |
| Five fleet agents | SafeRebalancer `39a20e5e…`, Momentum `1a0a153e…`, AnsemDCA `a046d377…`, MeanRevert `a7d7c928…`, SignalFollower `38e89e13…`. Private (ClawPump requires an external wallet in settings before `is_public`), stopped, unfunded. |

## Two meters on ClawPump

1. **API key tier (Enterprise).** Counts calls that software makes to the ClawPump REST API with the `cpk_` key, and sets the swap fee. Direct swaps (`swap_execute`) run on this meter only; they worked with zero credits.
2. **AI credits.** Pay for the language model an agent thinks with while it runs on ClawPump's servers. All 415 models in the catalog are paid. The free tier gives 10 agent prompts per day that answer in one step. Autonomous runs (`POST /agent-runs`, multi-step) fail at once with `last_error "[object Object]"` and zero tokens while the credit balance is 0. Credits are bought on the dashboard credits page by depositing USDC to the account deposit wallet, then syncing billing. Estimate (not measured): a run step is about 27k prompt tokens, about $0.02 to $0.03 per step, so about $10 covers a week of 8 multi-step runs per day.

The alternative that needs no ClawPump credits: ClawVille decides with its own model and uses the Enterprise key to call `swap_execute` for Genesis. That is the next build.

## Verified ClawPump facts (2026-09-17/18, by live call)

- **Connector:** remote MCP `https://mcp.clawpump.tech/mcp`, OAuth sign-in (Google or X), one connected client at a time. The old `clawpump.tech/api/mcp` and the keyless `agent_signup` of `@clawpump/mcp` 1.0.1 are dead (404).
- **REST base:** `https://ai-agents-production-6ca0.up.railway.app` (root, no `/api` prefix); header `Authorization: Bearer <cpk_ key>`. `GET /agents`, `GET /agents/:id`, `PATCH /agents/:id`, `GET /models/catalog`, `GET|POST /agent-runs`, `GET /agent-runs/:id/steps`, `POST /automations`, `GET|DELETE /automations/:id`, `GET /chat/:agentId/messages`.
- **Drift from the published client (`@clawpump/agents` 0.1.27):** `POST /automations` now requires nested `trigger: {type, config}` and `action: {type, config}`; the flat `trigger_type` / `trigger_config` body returns 400.
- **Agents:** `create_agent` is free and returns a ClawPump-custodied wallet. `swap_quote` / `swap_execute(agent_id, input_mint, output_mint, amount, slippage_bps)` route through Jupiter; `swap_execute` is opaque (no minimum-out binding), so ClawVille keeps float small and verifies after the fact.
- **No sign-message tool:** a ClawPump wallet cannot answer ClawVille's ed25519 pairing challenge. Ownership proof for a ClawPump wallet must use the authenticated `GET /agents` read (it lists each agent's wallet for the key's account) or a nonce micro-transfer.
- **Rotation drops a partner-granted tier.** The Enterprise grant was lost on a key rotation on 2026-09-17 and re-granted by ClawPump on 2026-09-18. Never rotate a partner-granted key; ask the partner to re-issue.

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
