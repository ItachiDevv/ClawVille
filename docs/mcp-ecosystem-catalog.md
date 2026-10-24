# MCP ecosystem catalog: research and decisions

**Last Audited: 2026-10-24 06:28Z (the Shinjuku StAItion row moves from the hosted read-only HTTP MCP to the Shinjuku Shield npm wallet, as a local MCP server or a command-line tool, pinned to 0.3.95; new optional row field `cli` for Shinjuku StAItion and Pay.sh; PROTOCOL_VERSION 103 -> 104).**

**Prior Last Audited: 2026-10-23 21:16Z (new rows: Shinjuku StAItion and Pay.sh served, SAID Protocol planned; Trader Ralph and PenguinXBT out by owner decision; PROTOCOL_VERSION 101 -> 103).**

**Prior Last Audited: 2026-10-23 10:31Z (first version, MCP hub step 1, PROTOCOL_VERSION 101).**

Research date: 2026-10-23. Method: public pages and unauthenticated probes only. We did not sign in to any service and we made no payment.

## Purpose

A ClawVille user runs an LLM client such as Claude Code, Codex, Hermes, Claude Desktop or Cursor. The ClawVille MCP connects that client to the game. Other projects in the same ecosystem also have MCP servers or paid APIs that an agent can use. This page records which projects we reviewed, what we found, and how ClawVille will use each one.

The source of truth for the served list is the constant `ECOSYSTEM_CATALOG` in `packages/shared/src/constants/ecosystem-catalog.ts`. `servedEcosystemCatalog(apiBase)` returns only the rows with status `available`. ClawVille serves those rows in two places:

- the manual topic `ecosystem`: MCP `clawville_docs { topic: "ecosystem" }`, or `GET /api/skills/protocol/ecosystem.md` with an agent session;
- the public JSON route `GET /api/ecosystem/catalog` (no login).

Each change to the catalog is a change to the agent manual, so it bumps `PROTOCOL_VERSION` in the same diff (rule E6).

## The two buckets

**Installer.** The user adds the third-party MCP server to their own client and signs in to the third party there. ClawVille gives the install steps only. ClawVille never holds the user's login, token or spend limit for that service.

**Gateway.** ClawVille calls the third-party service on the agent's behalf. ClawVille pays from the agent wallet by x402, or uses ClawVille's own access to the service. Every gateway call goes through a ClawVille route, so ClawVille can apply its own caps and its own review. No gateway call exists in step 1.

## Reviewed projects

Only rows with status `available` are served. A `planned` project is not served until its step is built and reviewed.

| Project | Surface | Bucket | Status |
|---|---|---|---|
| ClawVille MCP | `/api/agent/mcp`, Streamable HTTP, install steps per client | (first party) | available |
| Studios by Claw Hunter MCP | `https://mcp.mystudios.fun/mcp`, OAuth 2.1 in the user's client; the user sets a daily spend limit | installer now, gateway later | available |
| Atelier MCP | `https://app.useatelier.ai/mcp`, OAuth or an `atelier_` API key | installer now, gateway later | available |
| Shinjuku StAItion (Shinjuku Shield wallet) | npm package at one pinned version: a local stdio MCP server, or a command-line tool; no sign-in, the keys stay on the user's computer | installer | available |
| Pay.sh MCP | local stdio server, `pay mcp`; the operating system asks the user to approve each payment | installer | available |
| UsePod | paid inference tier from the agent wallet | gateway | planned |
| ClawPump agent tools | through ClawVille's own ClawPump access | gateway | planned |
| Hydra | paid read-only x402 data routes | gateway | planned |
| SAID Protocol | trust check on another agent's wallet, paid by x402 | gateway | planned |

## Research notes

### Studios by Claw Hunter

- One API for 39 chat models and 43 image and video models.
- The MCP server uses OAuth only. `initialize` returns 401 without a sign-in.
- The REST chat, image and video routes accept x402: USDC on Solana or Base, USDG on Robinhood Chain, or some tokens at 10% off.
- An x402 chat payment pays the full `max_tokens` reserve.
- The `/messages` and `/responses` routes (Claude Code and Codex use these) take prepaid credits only. They do not take x402.
- A free bounty feed is at `/api/v1/bounties`.
- Bucket: installer now. Gateway later, for x402 images and video.

### UsePod

- An inference marketplace.
- An OpenAI-compatible and Anthropic-compatible proxy at `api.usepod.ai`, with a token in the path.
- An x402 route, `/proxy/x402/v1/chat/completions`. It is text only and needs `max_tokens`. The minimum payment is $0.01. The service credits the unused part of the quote to the payer wallet. The quote carries a `feePayer`, so the payer needs no SOL.
- The ClawPump tools `usepod_provision` and `usepod_deposit` only fund an account. They do not run inference.
- Bucket: gateway (planned). Planned use: a paid inference tier behind the InferenceRouter (step 4).

### Atelier

- A market where AI agents sell services. At research time it listed about 488 agents and 706 services.
- Payment in USDC or SOL. Atelier takes a 10% fee.
- MCP server at `https://app.useatelier.ai/mcp`, with OAuth or an `atelier_` API key.
- An x402 service list at `https://api.useatelier.ai/api/x402/services`. Prices go from $0.01 to $35.
- At research time its Solana quote had no `feePayer`, so a payer can need SOL for the fee.
- Bucket: installer now. Gateway hiring is planned (step 5). Selling for hosted agents needs a custody review first (step 6).

### Hydra

- A Solana trading-swarm partner. The partnership is public.
- A free x402 manifest at `https://www.hydraswarm.io/api/x402` lists three paid, read-only data routes:
  - a token safety screen, $0.01;
  - scout candidates, $0.05;
  - trade fills, published 10 minutes after the fill, $0.05.
- x402 v2, USDC on Solana.
- Bucket: gateway (planned). Planned use: data inputs for Trading Floor agents, paid from the agent wallet, with per-avatar caps (step 2).

### Shinjuku StAItion

- The catalog row is Shinjuku Shield, a self-custody wallet that pays x402 URLs privately from a shielded USDC balance on Solana. Source: the public npm package README of `shinjuku-shield` 0.3.95.
- Two options from the npm package. (1) A local MCP server over stdio: `npx -y --no-audit --no-fund shinjuku-shield@0.3.95 mcp`. (2) A command-line tool, for use without an MCP client: `npm install -g shinjuku@0.3.95`, then `shinjuku help`. The `shinjuku` package depends on `shinjuku-shield` at the same version.
- Version: npm `latest` was 0.3.86 and `next` was 0.3.95 on 2026-10-24. The owner asked for the newest version, so the row pins 0.3.95. The version is one constant in `ecosystem-catalog.ts`. A version bump changes the served manual, so it bumps `PROTOCOL_VERSION`.
- The MCP server name in every client config is `shinjuku-shielded`. The Claude Code line is the vendor's published form. We composed the Codex CLI and Hermes lines from their `mcp add` help. Hermes `--args` must be the last option, so `--connect-timeout 60` goes before `--command`.
- No sign-in. The wallet and its keys stay on the user's computer. The user runs setup once in a terminal first. Setup makes the wallet, a private passphrase file and about 191 MB of proof tools, and writes a recovery file.
- Spending limits are off by default: only the balance limits a payment. Setup takes `--max-payment`, `--max-session` and `--max-cumulative` in USDC.
- Needs Node.js 22.21 or later (or 24 or later), on Linux or Windows with WSL. macOS is not supported.
- Release check: each npm version holds one wallet release, with a hash in the release table at `https://github.com/ShinjukuStaition/shinjuku-shielded#releases`.
- The row no longer points at the hosted read-only HTTP MCP.
- Homepage: `https://shinjukustaition.com`.
- Bucket: installer.

### Pay.sh

- A command-line tool that pays for x402 APIs from a local wallet on Solana.
- Its MCP server runs on the user's own computer over stdio. The command is `pay mcp`.
- No sign-in to the server. The operating system asks the user to approve each payment from the local wallet.
- The user installs the pay CLI first. On macOS: `brew install pay`. Other ways: `https://pay.sh/docs/toolchain/install/index.md`.
- `pay setup` makes the local wallet. It can also write the MCP config for Claude Code and Codex.
- The row's `cli` block (since protocol 104) is `brew install pay`, then `pay setup`.
- `pay mcp` has no spending limit by default. Its own docs show a guard, for example `pay mcp --max-payment '$1.00'`.
- Homepage: `https://pay.sh`.
- Bucket: installer.

### SAID Protocol

- Agent identity and reputation on Solana.
- Planned use: a trust check on another agent's wallet, paid by x402 from the agent's own wallet.
- Not served. Its published MCP command does not start an MCP server today, so the row has no MCP URL and no install steps.
- Homepage: `https://www.saidprotocol.com`.
- Bucket: gateway (planned).

### Trader Ralph and PenguinXBT

- Out by owner decision.

### SelfMade by SP3ND

- No fit. It sells nothing that an agent can call.
- SP3ND is real-world shopping. That is out of scope for the game economy.

### Pod the Squire

- Skipped. It is the token behind UsePod.

## Planned gateway steps

None of these steps is built. Each one gets its own review.

1. Step 1 (this change): the reviewed catalog, the manual topic and the public route. No money moves.
2. Step 2: the first paid x402 tools, each with a per-avatar daily cap on paid calls.
3. Step 3: ClawPump agent tools on ClawVille's own access, with a per-user call budget.
4. Step 4: a UsePod paid inference tier behind the InferenceRouter.
5. Step 5: Atelier hiring by x402, and an `npx clawville` installer.
6. Step 6: Atelier selling for hosted agents, after a custody review.

## Security

- **Third-party text is untrusted.** A third party's tool names, tool descriptions and answers are untrusted input. They can contain instructions that try to steer an agent. The catalog holds only text that ClawVille wrote and reviewed.
- **No relay of `tools/list`.** ClawVille never fetches a third party's `tools/list` and never relays it to an agent or a client. In the installer bucket, the user's own client talks to the third party directly.
- **Caps on every paid call.** From step 2, every paid call that ClawVille makes from an agent wallet has a per-avatar daily cap, enforced in ClawVille code. A provider-side limit does not replace the ClawVille cap.
- **ClawPump access.** One ClawVille ClawPump key controls the agent wallets that ClawVille creates through ClawPump. So ClawVille enforces its own destination rules and its own spend caps before any ClawPump call.
