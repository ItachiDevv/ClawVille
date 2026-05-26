# ClawVille → Steam — Codebase Audit & File-by-File Gate Plan

*Last audited: 2026-04-17*
*Author: Steam risk-audit pass (Opus 4.7, 1M context)*
*Scope: identify every feature, route, component, schema, and env var that must be stripped, gated, or rewritten for a Steam submission. `NEXT_PUBLIC_BUILD_TARGET=steam` is the compile-time flag; `STEAM_BUILD=true` is the backend server-side counterpart.*

---

## Executive Summary

- **~63 source files** need edits (9 DB schema/migration files, 7 backend routes, 5 backend services, 18 frontend components/pages, 6 frontend hooks/libs, 8 `apps/promo-videos/*` assets that bake crypto copy into marketing footage, 6 scripts, 4 docs/env). **10 backend routes strip-by-env** (bazaar, auctions, token-launch, x402 ping, vanity, wallet export, leaderboard gold tab, bounties-claw-reward, daily-login reward, items/export-skill — the last five partially).
- **Single biggest "oh no" finding (architectural, not cosmetic):** the entire landing page at `apps/web/src/app/page.tsx` is a crypto token marketing site. Contract address (`Epht7Fw4Sgh6fdcJj6afWXuNcAUmLLMc3MSthUqELiZA`) in the sticky header, `$CLAWVILLE` tokenomics hero, *three-chain* launch section (Solana/Pump.fun + BSC/4meme + Base), treasury tax card — all hard-coded JSX, no feature flag. Steam's store page screenshot + linked website policy ([distribution agreement §4.A](https://partner.steamgames.com/doc/gettingstarted/onboarding)) makes the store page effectively inseparable from the published site. If Valve clicks `clawville.world` from the store page and sees "Launch Token / SOL · BSC · BASE / Pump.fun · Raydium · 4meme," the submission is dead on arrival regardless of how clean the Electron build is. **We need a second domain** (e.g. `clawville.game` or a subdirectory) hosting a Steam-clean landing page, *or* we gate every crypto section in `page.tsx` behind `NEXT_PUBLIC_BUILD_TARGET` AND repoint the Steam Electron app to that clean host. The engineering for a gate is trivial; the marketing/comms cost of scrubbing the public-web landing is real.
- **Second-worst finding:** crypto terminology is embedded in 8 of 14 avatar archetypes (`packages/shared/src/constants/avatar-archetypes.ts`) — bio strings, topic arrays, messageExamples. These feed `characterConfig.knowledge[]` which feeds the Gemini system prompt. A Steam player chatting with their archetype avatar will hear the NPC talk about "Solscan," "liquidity locks," "hardware wallets." This isn't a one-line strip — it's rewriting 8 archetypes' worth of character lore. Also blocks the AI content disclosure (we'd have to represent to Valve that agents don't generate crypto content, which would be false).
- **Good news:** ClawTokens themselves are purely an off-chain `integer` column (`avatars.clawTokens` + `claw_token_transactions` ledger). No SPL token backing, no on-chain mint, not tradeable externally. Rename to "Claws" or "Coral" in the Steam build and the token economy itself is Steam-compliant. The bazaar/auction houses price everything in this off-chain integer — once renamed, they're just in-game currency.
- **Wallet surface is self-contained.** Wallets are auto-generated on avatar creation / agent connect, stored encrypted, *never shown to the user in any UI component*. The `walletAddress` mirror column is returned from `POST /api/agent/connect` to the agent's JSON response — but the web client doesn't render it anywhere. Suppress it in the API response when `STEAM_BUILD=true` and the wallet surface disappears from the client experience entirely. We still have to document the custodial wallets in our Steam EULA (Valve cares about real money flowing through a game), but the UX strip is shallow.

---

## Env Flag Design

### Frontend flag: `NEXT_PUBLIC_BUILD_TARGET`

- **Values**: `'web'` (default) | `'steam'`
- **Where set**: Docker build arg in Electron CI, passed via `docker build --build-arg NEXT_PUBLIC_BUILD_TARGET=steam …` when producing the Steam asset. `apps/web/Dockerfile:25-26` already follows this pattern for `NEXT_PUBLIC_API_URL`.
- **Where read**: `process.env.NEXT_PUBLIC_BUILD_TARGET` in any client component. Next baked at build, not runtime, so different Steam/web bundles come from different CI runs.
- **Helper to add** (new file, `apps/web/src/lib/build-target.ts`):
  ```ts
  export const IS_STEAM_BUILD = process.env.NEXT_PUBLIC_BUILD_TARGET === 'steam';
  export const IS_WEB_BUILD = !IS_STEAM_BUILD;
  ```
- **Pattern**: `{!IS_STEAM_BUILD && <TokenLaunchSection />}` wrapping any crypto/marketplace JSX block.

### Backend flag: `STEAM_BUILD`

- **Values**: `'true'` | unset
- **Where set**: Env var on the Coolify API container *only when that container serves Steam clients exclusively*. Given the plan is to keep `api.clawville.world` shared between web and Steam clients, we actually need a **per-request gate, not an env**. Either:
  - **Option A (preferred):** Electron client sends `X-ClawVille-Client: steam` header on every request; middleware treats Steam clients as crypto-blocked. Web clients omit the header.
  - **Option B:** Steam Electron calls a *different* API (`api-steam.clawville.world`) that runs the same code with `STEAM_BUILD=true`. Heavier infra, clearer separation.
- **Routes to disable when a request is from a Steam client**:
  - All of `/api/bazaar/*` (return 404)
  - All of `/api/auctions/*` (return 404)
  - `POST /api/items/export-skill/:buildingId` (this would also need scrubbing anyway since "skill export" isn't crypto — leave it if cleaned)
  - Any future `/api/token-launch/*` routes
  - `/api/v2/agent/ping` (x402 — return 404)
- **Routes to strip from responses** (still reachable, but crypto fields omitted):
  - `POST /api/agent/connect` — omit `walletAddress` from response body
  - `POST /api/agent/connect` SKILL.md docs — omit wallet mention

### Why not just one flag?

The frontend flag gates UI. The backend flag gates API surface. They have to be independent because `api.clawville.world` serves *both* web users (wallets allowed) and Steam users (wallets not allowed) simultaneously. The per-request header (`X-ClawVille-Client: steam`) is the cleanest way to thread this through a shared backend.

---

## 1. Wallet / Crypto Audit Table

| File:Line | What it does | Steam action |
|---|---|---|
| `packages/database/src/schema/wallets.ts:1-90` | Unified encrypted custodial Solana keypair table (`wallets`, `wallet_subject_type` enum) | **Keep schema, never surface.** DB stays so web+Steam shared API works. |
| `packages/database/src/schema/treasury.ts:23-58` | `treasury_wallets` + `treasury_purpose` enum (x402-merchant / fee-collector / escrow) | **Keep schema, never surface** |
| `packages/database/src/schema/token-launch.ts:14-41` | `vanity_keypairs` pool (CLAW/HRMS suffix vanity addresses) | **Keep schema — Steam build server-side flag MUST block all reads/writes from Steam clients** |
| `packages/database/src/schema/token-launch.ts:45-108` | `token_launches` table with `pumpfun`/`raydium` platforms, dev-wallet encryption columns | **Schema kept, but no code path in Steam build can route here. Add a runtime assertion at the top of any route file that touches this table: `if (isSteamClient(c)) throw new HTTPException(404)`.** |
| `packages/database/src/schema/avatars.ts:178` | `avatars.wallet_address` varchar(64) — mirror of avatar's custodial Solana pubkey | **Keep column, omit from `/api/avatars/me` JSON response when Steam client** |
| `packages/database/src/schema/claws.ts:45-50` | `openclaw_bots.wallet_address` — mirror of bot's custodial Solana pubkey | **Keep column, omit from `/api/agent/connect` response when Steam client** |
| `apps/api/src/services/keypair-vault.ts:1-177` | AES-256-GCM encryption + vanity keypair pool helpers (`encryptSecretKey`, `reserveVanityKeypair`, `loadVanityKeypair`, `markKeypairUsed`) | **Keep module, no Steam UI references it. No change.** |
| `apps/api/src/services/wallet-service.ts:1-169` | `ensureWallet()` + `getWalletAddress()` — auto-generates Solana keypair for any avatar/agent | **Keep module. `ensureWallet` still runs on Steam user signup (custodial wallet silently created, invisible to Steam UI). If we wanted to be fully clean: add `if (STEAM_BUILD) return { publicKey: '', subjectType, subjectId, alreadyExisted: false }` shim at top. Risk: DB FK assumptions elsewhere break. SAFER: keep silent wallet creation but never surface it.** |
| `apps/api/src/services/x402-config.ts:1-112` | x402 merchant server + Solana Exact scheme + Coinbase CDP facilitator + Solana mainnet CAIP-2 network ID | **Behind `X402_ENABLED=true` today. Hardcode `enabled: false` in Steam build of the API, OR ensure `X402_ENABLED !== 'true'` on the Steam-serving container. Remove `'GET /api/v2/agent/ping'` from `buildX402Routes` in Steam build.** |
| `apps/api/src/routes/agent-v2.ts:*` | Wraps the x402-gated `/api/v2/agent/ping` paid endpoint | **404 when `STEAM_BUILD=true`** |
| `apps/api/src/routes/agent-gateway.ts:271-282` | Calls `ensureWallet('agent', uuid)` during `/api/agent/connect` → generates custodial Solana wallet | **Let the wallet generate silently, BUT strip `walletAddress` from the JSON response at line 388 when request is from a Steam client** |
| `apps/api/src/routes/agent-gateway.ts:1552` | SKILL.md documentation string mentions `"walletAddress"` field | **Remove from docs emitted to Steam clients; easiest via a separate `skill-steam.md` template** |
| `apps/api/src/routes/avatars.ts:287-290` | Calls `ensureWallet('avatar', avatar.id)` at avatar create → sets `avatar.walletAddress` | **Same as above — generate silently, omit from response field when Steam** |
| `apps/web/src/app/page.tsx:122-138` | "1B $CLAWVILLE / 3 chains SOL·BSC·BASE" stats hero strip | **Gate entire `<div className="anim-up mt-10 flex flex-wrap …">` block behind `!IS_STEAM_BUILD`** |
| `apps/web/src/app/page.tsx:149-161` | "Launch Token" CTA (violet/amber/blue gradient btn with 3-chain SVG icons) | **Remove entirely in Steam build** |
| `apps/web/src/app/page.tsx:297-418` | Entire "AGENT TOKEN LAUNCH" section — Solana/Pump.fun, BSC/4meme, Base launch cards, 4-step launch flow | **Gate the whole `<section id="launch">` behind `!IS_STEAM_BUILD`** |
| `apps/web/src/app/page.tsx:420-583` | Entire "TOKENOMICS" section — 1B total supply, 5 utility pillars (Governance/Bounties/Auctions/Skill Shops/Treasury Tax) | **Gate the whole `<section id="tokenomics">` behind `!IS_STEAM_BUILD`** |
| `apps/web/src/app/page.tsx:610-635` | "How It Works" step 5 ("Launch a token… Pump.fun / Raydium / 4meme") | **Trim to 4 steps in Steam build** |
| `apps/web/src/app/page.tsx:822-928` | `SiteHeader` — sticky top bar with copyable Solana CA + socials | **Remove CA pill entirely, keep socials only, when `IS_STEAM_BUILD`** |
| `apps/web/src/app/page.tsx:164-182` | Nav pills (Tokenomics / Launch Token / Roadmap) | **Remove Tokenomics + Launch Token pills when Steam** |
| `apps/web/src/app/page.tsx:58-69` `SKILL_CATEGORIES` | Includes `{ icon: '⛓️', name: 'Crypto & Web3', building: 'Shell Fortress' }` | **Rename to `{ icon: '🛡️', name: 'Security & Defense', building: 'Shell Fortress' }` in Steam build (constant-level branch)** |
| `apps/web/src/app/page.tsx:779-784` | Marketing copy "earn $CLAWVILLE" in hero | **Swap to generic "earn Claws" when Steam** |
| `packages/shared/src/constants/building-types.ts:35` | `'agent-security': { label: "Patrick's Rock", focus: 'Solana development, wallets, DeFi protocols, smart contracts, and on-chain data', category: 'Crypto & Web3' }` | **Rewrite focus string: "API security, authentication, rate limiting, access controls." Category → "Security & Defense".** |
| `packages/shared/src/constants/avatar-archetypes.ts:78-81` | `trench-drifter` archetype bio talks about rug pulls, Solscan, liquidity locks | **Replace crypto-flavored lore with exploration-themed lore in Steam build (requires a parallel `avatar-archetypes-steam.ts` file, or build-time strip) — 8 of 14 archetypes affected** |
| `packages/shared/src/constants/avatar-archetypes.ts:124-127` | `tide-sage` archetype mentions Solana proof-of-history, DeFi protocols, tokenomics | **Same — rewrite lore. Affects `characterConfig.knowledge` fed to Gemini system prompt.** |
| `packages/shared/src/constants/avatar-archetypes.ts:171-173` | `coral-jester` talks about memecoins, Solana memes, degen culture | **Same — rewrite as joke-themed lore** |
| `packages/shared/src/constants/avatar-archetypes.ts:216-219` | `kelp-healer` references crypto portfolio health, Solana staking | **Same — rewrite as wellness/patience lore** |
| `packages/shared/src/constants/avatar-archetypes.ts:262-265` | `ironfin-warrior` references crypto trading, Jupiter DEX | **Same — rewrite as combat strategy lore** |
| `packages/shared/src/constants/avatar-archetypes.ts:308-325` | `coral-artist` references Solana NFTs, Metaplex, mint costs | **Same — rewrite as digital-art lore, drop NFT mentions** |
| `packages/shared/src/constants/avatar-archetypes.ts:354-371` | `reef-guardian` references hardware wallets, contract audits, crypto security | **Same — rewrite as general security/vigilance lore** |
| `packages/shared/src/constants/avatar-archetypes.ts:400-403` | `tide-trader` references Solana DEX, Jupiter, whale wallet tracking | **Same — rewrite as market analysis / general trading metaphor lore** |
| `packages/agent-runtime/src/actions/check-balance.ts:10-21` | ElizaOS `CHECK_BALANCE` action, similes include `WALLET`; description says "Check your ClawToken balance" | **Rename action to `CHECK_STATUS` + drop `WALLET` simile when Steam (wallet is suggestive, "balance" alone is fine for in-game currency)** |
| `apps/api/src/services/npc-conversation-engine.ts:*` | Per-character Gemini system prompts injected from archetype data | **Inherits the avatar-archetypes fix automatically once archetypes are scrubbed** |
| `packages/shared/src/types/agent-gateway.ts` | Types mentioning wallet fields | **Keep types — scrubbing the response at the route layer is enough** |
| `scripts/backfill-wallets.ts` | Backfill script | **Keep; ops-only, never shipped in Electron** |
| `scripts/generate-treasury-keypair.ts` | Dev/ops tool | **Keep; ops-only** |
| `scripts/import-treasury-wallet.ts` | Dev/ops tool | **Keep; ops-only** |
| `scripts/import-vanity-keypairs.ts` | Dev/ops tool | **Keep; ops-only** |
| `.env.local` (env var: `VANITY_ENCRYPTION_KEY`) | AES-256-GCM master key for wallet secrets | **Keep on server; never shipped to client** |
| `.env.local` (env var: `CLAWVILLE_MERCHANT_WALLET_PUBKEY`) | x402 merchant wallet pubkey | **Keep on server; only read when `X402_ENABLED=true`** |

---

## 2. Marketplace / Skill-Economy Audit Table

| File:Line | What it does | Steam action |
|---|---|---|
| `packages/database/src/schema/bazaar.ts:19-69` | `bazaar_listings`, `bazaar_transactions`, `bazaar_reviews` tables | **Keep schema; block all routes in Steam** |
| `packages/database/src/schema/auctions.ts:27-76` | `auctions`, `auction_bids`, `auction_agent_configs` tables | **Keep schema; block all routes in Steam** |
| `packages/database/src/schema/marketplace.ts:21-55` | `published_skills` + `skill_upvotes` — foundational skill authorship tables | **KEEP. Skill publishing is content creation (Steam-compliant) as long as we strip the paid-listing layer.** |
| `packages/database/src/schema/treasury.ts:65-113` | `claw_token_transactions` ledger with `bazaar`/`x402` source values | **Keep schema; `x402` enum value never used in Steam** |
| `apps/api/src/routes/bazaar.ts:1-868` | Entire bazaar route: browse/list/buy/review/fees/rarity | **404 all routes when Steam client. File stays, add a `middleware` at the top: `bazaarRoutes.use('*', (c, next) => isSteamClient(c) ? c.json({error:'not found'}, 404) : next())`.** |
| `apps/api/src/routes/auctions.ts:*` | Entire auctions route: browse/bid/buynow/resolve + SSE bus | **404 all routes when Steam client (same middleware pattern as bazaar)** |
| `apps/api/src/routes/items.ts:278-334` | `POST /items/export-skill/:buildingId` — exports avatar knowledge to external Milady skill gateway | **Keep. Not crypto. Just scrub the "take home your agent" phrasing if needed in frontend.** |
| `apps/api/src/routes/items.ts:62-129` | `POST /items/buy` — spends ClawTokens on knowledge books | **Keep. In-game currency, no crypto.** |
| `apps/api/src/services/claw-token-ledger.ts:30-113` | Atomic ClawToken credit/debit helpers | **Keep. Off-chain integer, Steam-compliant.** |
| `apps/api/src/routes/leaderboard.ts:1-40` | Leaderboard aggregates over avatars + bazaar + quests + bounties | **Keep. Strip "Skills Sold" tab and "Gold earned from bazaar" sub-metric when Steam client to avoid implying real-money economy.** |
| `apps/api/src/routes/quests.ts:*` | Quest system with token rewards | **Keep. Rename "ClawToken reward" → "Claws reward" in prompts/UI copy.** |
| `apps/api/src/routes/bounties.ts:*` | Bounty system with token rewards | **Keep. Same rename.** |
| `apps/web/src/components/game/bazaar-modal.tsx:1-60+` | Skill bazaar modal (browse/list/buy) | **Conditionally mount: return `null` at top when `IS_STEAM_BUILD`** |
| `apps/web/src/components/game/auction-modal.tsx:1-60+` | Auction house modal | **Conditionally mount: return `null` at top when Steam** |
| `apps/web/src/components/game/sidebar-menu.tsx:14-35` | Menu entries for Marketplace/Bazaar/Auction in ECONOMY category | **Hide Bazaar + Auction entries when Steam. Keep Marketplace (knowledge book shop — uses off-chain ClawTokens).** |
| `apps/web/src/components/game/shop-overlay.tsx:1-60+` | Knowledge-book shop overlay at buildings | **Keep. Internal currency only.** |
| `apps/web/src/components/game/inventory-modal.tsx` | Book + skill inventory | **Keep.** |
| `apps/web/src/components/game/leaderboard-modal.tsx:70-119` | Leaderboard tabs including "Gold" (`unit: 'NT'`, description: "Current ClawToken balance"), "Skills Sold" | **Rename labels: "Gold" → "Claws", drop "Skills Sold" tab when Steam. Already uses internal unit `NT`, the text just needs adjustment.** |
| `apps/web/src/components/game/avatar-status-bar.tsx:44-48` | ClawTokens badge with 🦞 emoji | **Keep (in-game currency). Consider renaming the label to "Claws" for thematic consistency.** |
| `apps/web/src/components/game/avatar-chat-bar.tsx:74` | Avatar chat injects `clawTokens` into `avatarContext` | **Keep — the chat already avoids saying "crypto"; once archetypes are scrubbed this is safe.** |
| `apps/web/src/stores/game.ts:*` | Game state including `clawTokens` displays | **Keep.** |
| `apps/web/src/components/game/skill-builder-modal.tsx` | Skill authoring UI | **Keep. Authoring ≠ selling.** |

---

## 3. AI-Generated Content Audit (for Steam AI disclosure)

Steam's 2026-01-17 AI policy rewrite requires *separate* disclosures for "pre-generated" content (static assets produced by AI pipelines pre-ship) and "live-generated" content (content generated at runtime in the player's session). ClawVille has both.

### Live-generated content to disclose

| File:Line | What it does | Disclosure needed |
|---|---|---|
| `apps/api/src/services/npc-conversation-engine.ts:1-40` | Gemini-backed NPC banter generation (10 building residents speak in real time) | **YES — live-generated. Gemini 2.0 Flash. Must describe: guardrails, filters, fallback to canned lines.** |
| `apps/api/src/routes/chat.ts:*` | Location agent chat routes — ElizaOS runtime chat per building character | **YES — live-generated** |
| `apps/api/src/routes/avatars.ts` avatar chat | Avatar chat with user's own agent | **YES — live-generated** |
| `packages/agent-runtime/src/eliza-runtime.ts` | ElizaOS runtime, Gemini text + embedding provider | **YES — live-generated (this is the wrapper)** |
| `apps/api/src/services/agent-orchestrator.ts` | Orchestrates ElizaOS runtimes per avatar | **YES — part of live-generated pipeline** |
| `apps/api/src/services/research-service.ts` | Research feature using LLM | **YES — live-generated** |
| Any chat where user message is visible to another player | None currently — chat is 1:1 (user↔NPC) and private | **No cross-player chat exposure. Safer than MMOs.** |
| Quest descriptions (`quests.description` column) | User-submitted text, seen by other players bidding on quests | **Pre-shipped content is moderated, but user-submitted quest descriptions are a content-moderation vector. Disclose per Steam CMA requirements ([Steam CMA](https://partner.steamgames.com/doc/store/assets/unsupported_products)).** |

### Guardrails we currently have

- Gemini has Google's built-in safety filters (off by default in text-generation API, but we do set them). **Verify in `packages/agent-runtime/src/gemini-text-provider.ts` and document.**
- `apps/api/src/services/npc-conversation-engine.ts:16-19` — `geminiBackoffUntil` drops to canned lines after 3 consecutive failures.
- No user-submitted prompts are baked into the system prompt — only archetype data + building context + the user's single message.

### Guardrails we DON'T have (and must build before submission)

- No profanity filter on user chat input → Steam UGC moderation requirement
- No "report" button on NPC output → Steam live-gen content requirement
- No "This was AI-generated" disclaimer on chat bubbles → not required but recommended

### Pre-generated content to disclose

- Archetype bios + NPC personality prompts are hand-written. **Do not disclose as AI-generated.**
- Knowledge books (`packages/shared/src/constants/knowledge-books.ts`) — hand-written. **Do not disclose.**
- The 3D models + textures — not AI-generated (author-made or licensed). **Verify with team; document any AI-generated model/texture in pre-gen disclosure.**

---

## 4. Online-Only Dependencies — Graceful Degrade TODO

Every frontend fetch today goes to `api.clawville.world`. If the backend is unreachable, the game is unplayable. Steam community expects at minimum a graceful offline error screen.

| File:Line | Behavior today | Action |
|---|---|---|
| `apps/web/src/lib/api.ts:3-40` | All `request()` calls throw `HTTP …` on failure | **Wrap in a service-worker-style retry or show a global "ClawVille is offline" banner** |
| `apps/web/src/lib/api.ts:4` `HONO_API_URL` | Falls back to `http://localhost:4000` at build if env var missing | **Fail loudly at build-time in CI if `NEXT_PUBLIC_API_URL` is unset** |
| `apps/web/src/app/enter/page.tsx:39` | Fallback hardcoded to `https://api.clawville.world` | **Document in Steam EULA: required online service** |
| `apps/web/src/hooks/use-npc-stream.ts:7` | SSE stream to NPC simulation | **Add reconnect-with-backoff + user-visible "reconnecting…" indicator** |
| `apps/web/src/hooks/use-research-stream.ts:6` | Research SSE stream | **Same — reconnect + indicator** |
| `apps/web/src/hooks/use-milady-embed.ts:73` | Milady session exchange | **Not used in Steam build (Milady-specific). Guard with `IS_STEAM_BUILD` to skip entirely.** |
| `apps/web/src/components/game/chat-panel.tsx:9` | Location chat API | **Reconnect logic + cache the last 20 messages locally so the panel stays populated during brief outages** |
| `apps/web/src/components/three/World3DCanvas.tsx` | Renders 3D world with continuous NPC SSE updates | **World still renders statically even if SSE disconnects; add a debug-off-by-default "server disconnected" toast** |
| `apps/web/public/sw.js:64` | Service worker caches api.clawville.world responses | **Leverage this more aggressively for Steam — cache static `/api/locations`, `/api/avatars/me`, `/api/items/inventory` for 30s** |
| Steam disclosure: system requirements + store page | **MUST call out "requires persistent internet connection"** in Steam store requirements field |
| Landing disclosure on launch: **ADD an Electron splash screen** that checks API health before loading `/game`; if down, show "ClawVille servers are currently offline — please try again later" with a retry button |

### Single-player offline demo mode (NOT shipping)

The 3D world, NPCs, and chat all require the backend. A true single-player fallback would require packaging the Gemini prompts + NPC personas into the Electron client and running a local LLM — out of scope for v1. Explicitly document in Steam FAQ: "ClawVille is an online-only game."

---

## 5. Auth Audit — Current vs Steam

### Current flow (Lucia + cookie)

- `apps/api/src/routes/auth.ts:38-75` — email/password signup
- `apps/api/src/routes/auth.ts:83-112` — email/password login
- `apps/api/src/routes/auth.ts:23-29` — logout
- `apps/api/src/routes/auth.ts:188-229` — `/api/auth/enter?t=…` magic-link ticket (agent-initiated login)
- `apps/api/src/routes/auth.ts:231-313` — `/api/auth/milady-session-exchange` — Milady embedded session
- `apps/api/src/lib/auth.ts` — Lucia setup (not audited in detail; presumed standard Lucia with `drizzle-lucia-adapter`)
- `apps/web/src/app/login/page.tsx` — login form page
- Session cookie: HTTP-only, SameSite=Lax (presumed; verify in `lib/auth.ts`)

### Steam flow (new `/api/auth/steam`)

| File:Line | Today | Steam change |
|---|---|---|
| `apps/api/src/routes/auth.ts` | Email+password only (+magic-link) | **Add `POST /api/auth/steam` handler that accepts Steam session ticket from Electron's `GetAuthTicketForWebApi`, verifies via `partner.steam-api.com/ISteamUserAuth/AuthenticateUserTicket/v1/`, looks up/creates user with new `users.steam_id` column, mints Lucia cookie** |
| `packages/database/src/schema/users.ts` | `users` table | **Add `steam_id` varchar(32) unique nullable column + migration** |
| `apps/web/src/app/login/page.tsx` | Email form | **In Steam build: skip form entirely; check `window.steamBridge?.getAuthTicket()` on mount, auto-POST to `/api/auth/steam`, redirect to `/game`** |
| `apps/web/src/app/enter/page.tsx` | Magic-link ticket exchange | **Keep for web build; skip in Steam build (magic-link is an agent flow — not applicable to Steam users who own the machine)** |
| Agent-connect (Moltbook) — `apps/web/src/components/game/agent-connect-modal.tsx` | Generate connect link in chat | **Keep, but if Steam user clicks "agent connect" while playing via Steam, explain that the feature is for developer agents and route them to a help page** |
| `apps/api/src/routes/agent-gateway.ts:356-377` | Mints session ticket from `/connect` | **Keep. Agent-to-game session tickets != Steam session.** |

### Steam authentication adds

- **New env vars**: `STEAM_WEB_API_KEY` (from partner.steampowered.com), `STEAM_APP_ID` (from Steam Direct submission, numeric)
- **Steam Web API validation path**: `GET https://partner.steam-api.com/ISteamUserAuth/AuthenticateUserTicket/v1/?key=$STEAM_WEB_API_KEY&appid=$STEAM_APP_ID&ticket=$TICKET_HEX` returns `{result: "OK", steamid: "…", ownersteamid: "…"}` on success.
- **Lobby/overlay**: Electron main enables overlay via `steamworks.js` init. Renderer gets `window.steamBridge` IPC API.

---

## 6. Landing / Marketing Copy Audit (Steam store description sources)

Steam store description is written separately in the partner portal, but **the store page links to the website** — and Valve reviewers click those links. Our `clawville.world` landing is the externally-visible marketing that Steam submission ties to.

### Must-remove strings from Steam-facing landing (if we stand up a Steam-clean host)

| File:Line | String | Action |
|---|---|---|
| `apps/web/src/app/page.tsx:103` | "Where Autonomous Agents Learn Skills" | Keep |
| `apps/web/src/app/page.tsx:108-113` | "turn SKILL.md files into capital" | **Swap to "turn SKILL.md files into progression"** |
| `apps/web/src/app/page.tsx:119` | "earn $CLAWVILLE" | **Swap to "earn Claws"** |
| `apps/web/src/app/page.tsx:127` | "$CLAWVILLE" stat label | **Remove the stat entirely** |
| `apps/web/src/app/page.tsx:129` | "SOL · BSC · BASE" chains label | **Replace with something else or remove** |
| `apps/web/src/app/page.tsx:150-158` | "Launch Token" CTA + Solana/BSC/Base chain SVG icons | **Remove** |
| `apps/web/src/app/page.tsx:291` | "Earn $CLAWVILLE" skill economy tagline | **Swap** |
| `apps/web/src/app/page.tsx:298-302` | "Launch Your Agent Token" section header | **Remove entire section** |
| `apps/web/src/app/page.tsx:316` | "Pump.fun · Raydium LaunchLab" | **Remove** |
| `apps/web/src/app/page.tsx:322-336` | Solana launch details | **Remove** |
| `apps/web/src/app/page.tsx:347-367` | BSC/4meme launch details | **Remove** |
| `apps/web/src/app/page.tsx:371-399` | Base launch details | **Remove** |
| `apps/web/src/app/page.tsx:434-437` | "Tokenomics" heading + "$CLAWVILLE is the governance and utility token" | **Remove** |
| `apps/web/src/app/page.tsx:454-459` | "1,000,000,000 $CLAWVILLE" supply hero | **Remove** |
| `apps/web/src/app/page.tsx:501-511` | Ticker / Chains / Role card | **Remove** |
| `apps/web/src/app/page.tsx:520-581` | Utility pillars (Governance, Bounties, Auctions, Skill Shops, Treasury Tax on-chain) | **Remove OR rewrite to remove "$CLAWVILLE" and "on-chain" language** |
| `apps/web/src/app/page.tsx:622-623` | Step 05: "Launch a token…" | **Remove step** |
| `apps/web/src/app/page.tsx:827` | `CONTRACT_ADDRESS = 'Epht7Fw4Sgh6fdcJj6afWXuNcAUmLLMc3MSthUqELiZA'` | **Remove the CA pill from header** |
| `apps/web/src/components/three/LandingScene.tsx` | 3D underwater intro scene | **Keep — visually Steam-safe** |
| `apps/promo-videos/src/Root.tsx` + videos 16-18 | Promo videos with crypto narration | **Do NOT reuse for Steam store trailer; produce a separate Steam trailer** |

### Store page copy guidelines (for Valve partner portal form)

- Never use the words: **crypto, cryptocurrency, blockchain, token, wallet, Solana, Pump.fun, Raydium, 4meme, BSC, BNB, on-chain, NFT, $CLAWVILLE, airdrop, liquidity, web3, degen, rugpull, staking, mint**.
- Safe vocabulary: **agents, AI, skills, economy (in-game), progression, leaderboard, bounties, quests, auctions (in-game), online multiplayer, procedural dialogue**.
- **Mandatory disclosures to include** in the store page free-text fields:
  - AI-generated content live in game (live-gen dialog with Gemini)
  - Required internet connection
  - Moderation summary (for user-submitted quest/bounty text)

---

## 7. Migration Risks — Existing Users' Wallets

Users who created agents on `clawville.world` already have auto-generated custodial Solana wallets (`avatars.wallet_address` populated). When a Steam user signs in via Steam auth and we match them to the same email address (or if we keep Steam users strictly separate), they will inherit this wallet.

| Risk | Mitigation |
|---|---|
| Existing wallet address returned in `/api/avatars/me` to Steam client | **Gate the field out of the JSON response when `X-ClawVille-Client: steam` header is present** |
| User who plays on both Steam and web sees the same wallet | **Intentional. Web sees wallet, Steam doesn't. Same DB row.** |
| Brand-new Steam user creates an agent → wallet auto-generated silently | **Acceptable for Steam as long as UI never surfaces it. If Valve has concerns about custodial assets, we can make wallet creation conditional: skip `ensureWallet` call when Steam client. Requires small changes in `agent-gateway.ts:277` and `avatars.ts:287`.** |
| Steam user transfers value into a Steam-created wallet by knowing the address externally | **Mitigation: never expose the wallet address to the Steam user AT ALL. They can't know the address they can't see. If they somehow discover it (by inspecting network tab with debug tools), they're off Steam's Trusted Client assumption — document in EULA.** |
| User has $CLAWVILLE (real crypto token) in their custodial wallet and plays on Steam | **Not applicable today — custodial wallets have no real assets. x402 paywall is `X402_ENABLED=false`. No on-chain value to worry about.** |
| Future (Phase 4+): x402 paywall becomes active | **When that ships, Steam build MUST strip x402 middleware — already noted above** |

---

## 8. Docs + Config to Change

| File | Change |
|---|---|
| `CLAUDE.md` | Add "Steam build" section: env flags, header pattern, strip list |
| `README.md` | Add Steam build quick start |
| `apps/web/Dockerfile` | Accept `NEXT_PUBLIC_BUILD_TARGET` build arg, bake into env |
| `apps/api/Dockerfile` | No change (server can't differentiate build targets; header-based gating inside routes) |
| `.env.local.example` | Document new vars: `STEAM_WEB_API_KEY`, `STEAM_APP_ID`, optionally `NEXT_PUBLIC_BUILD_TARGET` |
| `docs/steam-packaging-research.md` (existing) | Reference this audit from that doc |
| `docs/steam-research/06-*.md` (next doc, if any) | Implementation plan based on this audit |
| Steam EULA (new file, `docs/steam-research/steam-eula-draft.md`) | Document: online-only; custodial wallets generated behind-the-scenes but not surfaced/accessible; AI-generated dialog; user-submitted quest text moderation |

---

## 9. Suggested Implementation Order

1. **Add the build target flag** — `apps/web/src/lib/build-target.ts`, wire Docker build args, verify two separate build outputs. (~2 hours)
2. **Strip the landing page** — gate all `$CLAWVILLE` / token-launch / crypto JSX in `apps/web/src/app/page.tsx` behind `!IS_STEAM_BUILD`. Preview the Steam build locally. (~4 hours)
3. **Server-side client gate** — `apps/api/src/middleware/client-detector.ts` reads `X-ClawVille-Client` header, exposes `isSteamClient(c)` helper; wire into bazaar + auctions + agent-v2 routes. (~4 hours)
4. **Wallet response scrub** — remove `walletAddress` from `/api/agent/connect` + `/api/avatars/me` responses when Steam client. (~2 hours)
5. **Archetype crypto scrub** — new file `packages/shared/src/constants/avatar-archetypes-steam.ts` OR build-time AST replace for the 8 affected archetypes' `bio` / `topics` / `knowledge` / `messageExamples`. (~8-12 hours — needs careful lore rewrite, not just regex)
6. **Steam auth route** — `POST /api/auth/steam` + `steam_id` column + migration + Lucia integration. (~6 hours)
7. **Electron main + preload** — `apps/electron/*` new workspace: `steamworks.js`, ticket IPC, window config. (~12-16 hours)
8. **Steam splash + offline check** — Electron loads a health check first, shows error banner if backend unreachable. (~4 hours)
9. **Test + submit** — Steam sandbox, SteamPipe upload, internal playtest. (~8-12 hours)

**Total engineering (Windows-only, no macOS/Linux):** ~50-70 hours / 1-2 engineer-weeks, matching the 4-6 week estimate from `docs/steam-packaging-research.md` which includes store assets, capsule art, EULA, and review back-and-forth.

---

## References

- `docs/steam-packaging-research.md` — Business + policy context, Electron decision, cost estimate
- [Steam onboarding policy #13 — blockchain ban](https://partner.steamgames.com/doc/gettingstarted/onboarding)
- [Steam AI content policy 2026-01-17](https://store.steampowered.com/news/group/4145017/view/3862463747997849618)
- [Steam Direct $100 fee](https://partner.steamgames.com/doc/gettingstarted/appfee)
- [ceifa/steamworks.js](https://github.com/ceifa/steamworks.js/) — Rust-NAPI Steam SDK bindings for Node/Electron
- [ValveSoftware/steam-runtime#579](https://github.com/ValveSoftware/steam-runtime/issues/579) — Electron Steam Deck SLR incompat
- [Off The Grid precedent — CCN](https://www.ccn.com/news/technology/off-the-grid-first-blockchain-game-steam-crypto-ban/) — Blockchain game on Steam 2025
