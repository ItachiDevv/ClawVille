# ClawVille — TODO

> **What this doc is.** A single, scrollable view of *open* work — nothing
> already shipped. When an item ships, it gets removed here and lands in the
> appropriate canonical doc's "Recent material changes" log
> (`WorldContent.md` / `3dStructure.md` / `ARCHITECTURE.md` /
> `GameFeatures.md` §13/§20). Don't leave checked-off items piled up.
>
> **Not in scope:** the bidirectional code↔doc sync contract — that's
> enforced in `CLAUDE.md` "CANONICAL DOCS" and lives in the four manifest
> docs, not here.

**Last edit:** 2026-05-12 — tight rewrite (524 → ~280 lines). Archived ~300 lines of "FIXED" / "DONE" items + duplicated GPU rules + stale "Current State" snapshots that are already covered in the four canonical docs.

---

## Critical rules

- **Local dev:** `bun run dev` / HMR is FINE on the founder's desktop (2026-07-02 — the old ban was laptop-Iris-Xe-specific); final-verify WebGPU/perf work against the prod bundle (`bun run build && bun run start`). The SHIPPED product still targets the Iris Xe floor.
- **Push flow is STAGING-FIRST (2026-05-24, CLAUDE.md):** push `staging` → verify on `staging.clawville.world` → PR staging→master. NEVER direct to master without the literal founder phrase `direct to master`.
- Production: `https://clawville.world/game` · API: `https://api.clawville.world`
- Server: Hetzner CCX13 + Coolify v4. Full playbook: `DEPLOY-HETZNER.md`. Deploy mechanics summary in `ARCHITECTURE.md §12`.
- Iris Xe / GPU rules: canonical reference is `3dStructure.md §5a`. **Do not duplicate here.**

---

## 🟢 Active — biggest blocks first

### 0. Agent-metaverse P1 follow-ups (2026-07-03 — P1 live-proven on staging `0b6a29a4`, founder sign-off pending)
Full state: `docs/agent-metaverse-p1-plan.md` (Slice 4 shipped + live proof) + `docs/agent-metaverse-p0-v2-refound.md` (all P0 gates CLOSED incl. restart-survival 14/14 + reconnect fresh-bearer fix, PROTOCOL v9).
- [ ] **FOUNDER: browser sign-off** — watch Coralia walk + converse on staging; click a magic-link control handback (Rule E4 gate for "done").
- [ ] **FOUNDER: D2 board-policy conflict** — house/fleet agents currently EXCLUDED from the public board (safe default) vs D2's "internal-only management policy". One-line flip; options in `docs/agent-metaverse-model.md` §8 D2 note.
- [ ] Teacher REPLY bubbles in-world — impossible today (10 residents are client-rendered; zero server sim bodies). New scope: server resident bodies or a pendingEvents type the client maps onto the location-NPC render. The turn settles fine without it.
- [ ] Hatcher `talk_to_npc` proximity-gate fast-follow (tracked debt + checklist in `agent-metaverse-p1-plan.md` §Deferred; `.hatcher-ref/` must be refreshed first).
- [ ] `cash-house-seeder.ts:114` `$house$disabled$` sentinel hash — `Bun.password.verify` THROWS → login route 500s (enumeration signal, no takeover). Same fix as house-agent-seeder (valid bcrypt of a discarded secret).
- [ ] `partner-hatcher-p5-handler.test.ts` 3/4 red at HEAD (pre-existing) — a permanently-red test on the PROTECTED partner surface masks regressions. Root-cause or quarantine-with-ticket.
- [ ] Building edge-margin refine (adjacent-large-building overlap nit, deferred from the edge-distance gate fix).
- [ ] Pre-existing: bound identity-bootstrap can create unbounded users rows (tracked since the P1 adversarial pass).
- [ ] Three-surface #3 gap: hosted-runtime protocol-knowledge injection (`createMemory` on restart) still unbuilt — content changes tracked, enforcement TODO.

### 0b. Agent-metaverse P2 — provision-on-signup + tier migration (2026-07-04, IN PROGRESS)
Plan: `docs/agent-metaverse-p2-plan.md` (binding) · worktree `feat/agent-metaverse-p0`. Server slices A/B/D SHIPPED to the worktree (new `avatar-agent-provisioning.ts`; signup auto-provisions FAIL-SOFT + response carries avatar/agentId/one-time wallet; `/me/agent-session` mode `'provisioning-pending'`; `PATCH /avatars/me` customize extension; limiters on `openclaw/register` 5/min, `claws/connect|heartbeat` 10/min + B3 FEATURE_GATE, `research/trigger` 5/min; stale guest-leaderboard comments corrected). See `ARCHITECTURE.md §13` 2026-07-04.
- [ ] Web slices (impl-2): pending-state banner + sidebar re-label (B-web), toggle reconcile + fabricated-bearer kill + `/create-agent` prefill→PATCH (C).
- [ ] Staging deploy → live e2e signup proof (fresh email → rows → `/me/agent-session` hosted → real ElizaOS chat reply → toggle Controlled/Autonomous → FirstTimeBackupModal → legacy agent-less account shows pending). Guest regression: NPC mode still mints guest, no promotion hijack.
- [ ] mock-Hatcher harness ALL-PASS post-deploy (openclaw.ts limiter is additive on the protected surface).
- [ ] FOUNDER (open decisions surfaced by P2, NOT built): guest economy semantics; guest exclusion from the GLOBAL leaderboard (guests CAN rank today — two stale comments corrected 2026-07-04); unverified-email provisioning default (currently: provision immediately).
- [ ] FEATURE_GATE `browser_claws` review 2026-08-15 (`apps/api/src/routes/claws.ts`) — delete-vs-keep in its own audited diff per B3.

**P2 follow-ups (post-panel, 2026-07-04 — surfaced but deliberately NOT built in the P2 diff):**
- [ ] **Wallet-secret loss window widened.** The one-time custodial wallet secret from `POST /api/auth/signup` (Path-B) is stashed in `sessionStorage` (`FIRST_TIME_DISCLOSURE_STORAGE_KEY`) by `/login`, but `FirstTimeBackupModal` only renders on `/game` first mount — so the secret rides through the WHOLE `/create-agent` → `/personality` wizard before the user is ever prompted to back it up (tab-close mid-wizard = secret lost, server never re-emits). FOUNDER/UX call: render `FirstTimeBackupModal` on `/create-agent` too, OR add a persistent "backup pending" nudge until acknowledged.
- [ ] **PATCH `/me/appearance` harness-pool asymmetry.** `POST /api/avatars` (create) accepts a `chibi`-category model for a milady-HARNESS avatar, but the `/me/appearance` swap guard forbids it (milady-harness may only swap to `category==='milady'`, chibi is create-time-only). So a chibi picked at signup can never be re-selected after an appearance swap away from it. FOUNDER/PRODUCT call: relax the swap guard to allow milady↔chibi, or keep chibi create-time-only and document it.
- [ ] **Research/trigger limiter is a shared per-IP bucket.** `POST /api/research/trigger` 5/min/IP (Slice D) also caps AUTHENTICATED users behind the same shared-IP bucket (e.g. co-located/NAT users share the budget). Fine while research is an anonymous-cost-hole guard, but if research becomes a real gameplay surface, re-key the limiter by userId for authed callers so one IP's guests can't starve authed users.
- [ ] **PATCH `/me/appearance` never reloads a hot runtime.** It mirrors `customization` onto `platform_agents` but (pre-existing) never calls `agentOrchestrator.stopAgent`, so a HOT ElizaOS runtime keeps the old persona until the 30-min idle sweep. The P2 customize branch on PATCH `/me` DOES stop-on-persona-rebuild (items.ts precedent); port the same fire-and-forget stop to `/me/appearance` in its own small diff.

### 1. ElizaOS v2 migration (4 phases, currently on Phase 1)

Currently on `@elizaos/core@1.7.1`. Migrate to `2.0.0` in 4 bounded, independent phases. Each phase ships separately and is reversible. Phases 2–4 are enabled by Phase 1 but should NOT be bundled with it.

**Key v2 facts (from collaborative agent team, 2026-04-10):**
- `AgentRuntime` class + `@elizaos/core` package name unchanged.
- `adapter: IDatabaseAdapter` is now REQUIRED on the constructor (no longer lazy via plugin-sql).
- `@elizaos/plugin-bootstrap` REMOVED — replaced by `createBootstrapPlugin(config)` built into core, auto-registered during `runtime.initialize()`. External code must NOT import `bootstrapPlugin` directly.
- API keys move from runtime `settings` → `character.secrets`.
- `getMemories({ count })` → `getMemories({ limit })` (count deprecated but still works).
- `Plugin.models` remains single-handler-per-key — `{ [ModelType.TEXT_LARGE]: handler }` pattern unchanged.
- `createMemory(memory, tableName)` second arg retained.
- `runtime.generateText(prompt, opts)` still on IAgentRuntime — no forced migration to `useModel`.
- Our OpenAI providers port unchanged (priority-based model selection preserved — `openai-text-provider` priority 95, `openai-embedding-provider` priority 100). _(Gemini fully scrubbed 2026-06-16; both `gemini-*-provider` files deleted.)_

#### Phase 1 — pure runtime port (CURRENT)

Bump versions, rewrite `eliza-runtime.ts` to match v2 APIs, verify custom plugins still work, ensure existing chat / NPC / autonomy flows function unchanged. **No feature changes.** Ship boring, reversible parity.

- [ ] Bump `@elizaos/core` 1.7.1 → 2.0.0
- [ ] Bump `@elizaos/plugin-sql` 1.7.1 → 2.0.0
- [ ] Remove `@elizaos/plugin-bootstrap` from pluginMap + dynamic import (built into core in v2)
- [ ] Construct + inject `IDatabaseAdapter` directly into AgentRuntime constructor
- [ ] Move API keys from `settings` → `character.secrets`
- [ ] Update `getMemories` to use `limit` instead of `count`
- [ ] Verify the Gemini providers (priority 95 + 100) still win the priority chain
- [ ] Test all 10 building agents chat flow on prod
- [ ] Test avatar chat, NPC conversations, avatar autonomy
- [ ] Verify Milady gateway + collaboration still inject dynamic context correctly
- [ ] Rollback path: revert package.json + eliza-runtime.ts if anything breaks

#### Phase 2 — autonomy via v2 ActionPlan

Replace the hand-rolled state machine in the historical `pet-autonomy.ts` (file deleted before the rename pass) with v2's `ActionPlan` + autonomy primitives. Avatars pursue declarative goals like "visit 3 buildings, earn tokens, learn about cron jobs" via runtime-driven planning.

**v2 primitives used:** `ActionPlan`, `ActionResult` (with `values` + `data` for chaining), `Action` interface, task-mode autonomy (if `ENABLE_AUTONOMY` ships in our build — otherwise wrap `agentloop` manually).

- [ ] Verify `ENABLE_AUTONOMY` + `AutonomyService` are available in our v2 install (may be Eliza Cloud only)
- [ ] If not available: build thin custom `AutonomyService` wrapping `agentloop` + `ActionPlan` type
- [ ] Define actions: `MOVE_TO_BUILDING(id)`, `CHAT_WITH_BUILDING(id)`, `BUY_BOOK(bookId)`, `LEARN_BOOK(bookId)`, `RETURN_HOME`
- [ ] Each action returns `ActionResult` with `values.tokensEarned`, `data.bookPurchased`, etc.
- [ ] Move pathfinding (`findPath()`) into `MOVE_TO_BUILDING` handler body
- [ ] Move token award + activity log DB writes into action handlers
- [ ] Port the cost-control thresholds (`maxVisitsThreshold`, `MAX_TOKENS_PER_SESSION`) to a cost-control Evaluator firing on `ACTION_COMPLETED`
- [ ] Add `sendToAdmin` equivalent for failure reporting back to the owner
- [ ] Test: avatar enters autonomous mode, completes 3-building task, returns home

#### Phase 3 — event-driven agent collaboration

Replace `agent-collaboration.ts`'s bespoke keyword routing with v2 plugin events + a process-level broker. Cross-building agents consult each other via events instead of ad-hoc Gemini calls.

**v2 primitives used:** Plugin `events: { [EventType.X]: [handler] }`, `runtime.on/emit`, `ACTION_COMPLETED` evaluator, custom namespaced event `CLAWVILLE_NEED_SPECIALIST`.

**Gotcha:** Event bus is per-runtime. Cross-agent delivery requires a process-level broker — NOT built into v2 core. Our `agent-orchestrator.ts` becomes the broker.

- [ ] Add `CLAWVILLE_NEED_SPECIALIST` custom event constant
- [ ] Build evaluator on building agents that fires the event on keyword match (reuses `EXPERTISE_KEYWORDS`)
- [ ] Extend `agent-orchestrator.ts` with the cross-runtime event broker (listens on all runtimes, routes by target building, calls target `processMessage`, returns result)
- [ ] Anti-recursion guard: consultation responses must NOT re-trigger evaluators
- [ ] Per-conversation cooldown (e.g., max 2 consultations per user turn)
- [ ] Result becomes provider output on the next source-agent tick
- [ ] Remove ad-hoc `gemini` calls from `agent-collaboration.ts`
- [ ] Test: cron-automation receives webhook question → cross-consults api-integrations → answer enriched with specialist insight

#### Phase 4 — on-chain AgentID (ERC-8004 + x402)

Avatars become ERC-721 NFTs with ERC-8004 Identity Registry entries. Buildings can charge ClawTokens or USDC-on-Base for teaching via HTTP 402. **Decoupled from v2 core — can ship after Phases 1–3.** Real blockchain infra project, not a runtime port.

**Decision points (must resolve before sub-phase 4a):**
- Custodial wallets (KMS via `keypair-vault`) vs embedded wallets (Privy / Dynamic) vs user-held.
- ClawTokens off-chain (cleaner) vs on-chain ERC-20 (composable).

- [ ] Sub-phase 4a: Mint ERC-8004 Identity NFT at avatar creation (Base or Solana)
- [ ] Sub-phase 4a: `avatars.walletAddress` already exists — add Transfer event indexer to update `avatars.userId` on ownership change
- [ ] Sub-phase 4a: Dynamic metadata endpoint `/api/avatars/:id/metadata.json` serving live avatar state
- [ ] Sub-phase 4b: x402 paywall on building chat endpoints (returns 402 + price in ClawTokens/USDC)
- [ ] Sub-phase 4b: Avatar wallet service auto-pays for teaching requests
- [ ] Sub-phase 4b: Evaluate `0xgasless/agent-sdk` as a reference implementation
- [ ] **Prerequisite:** `ServiceType.wallet` ships in public v2 or we vendor a wallet plugin
- [ ] Risks: ERC-8004 registries not yet canonically deployed; custodial wallet regulatory exposure

---

### 2. Phase 5.1 follow-on work

Phase 5 (magic-link) + Phase 5.1 (wallet identity + 'scape portal) are shipped + deployed. Everything below is natural next-step work that didn't need to block the 5.1 PR.

#### Support-chat + admin-identity-recovery (BLOCKED on support-chat infra)

- `POST /api/admin/identity-recover` returns 501 with `FEATURE_GATE: admin_identity_recovery`.
- Graduates when `support.identity_recovery_requests > 5/week` (metric on `events`) AND support-chat service exists AND identity-verification workflow is defined AND admin approval UI is built.
- Until then, users who lose agent config AND wallet-key backup AND Lucia cookie are permanently locked out of their avatar.
- FEATURE_GATE review deadline: **2026-07-01**.

#### Self-custody wallet graduation

- UI to let users pull their avatar wallet's funds to their own Phantom / Solflare.
- No UI today. First-connect disclosure of the wallet secret is the **only** export path per the updated `wallets.ts` custodial doctrine.
- Triggers: when avatar wallets actually hold meaningful $CLAWVILLE. None do today — the SPL is live but no airdrops yet.
- Scope: "Export my wallet to Phantom" button in Avatar Settings → confirm + legal copy → display the secret once. Either re-runs `ensureWalletWithFirstTimeSecret`-style disclosure or lifts the "no subsequent retrieval" rule with a second explicit gate. **Needs legal review before shipping** per the custodial WARNING in `wallets.ts`.

#### KEK rotation dry-run

- Cloudflare Secrets Store holds `KEK_V1`. No rotation procedure has been exercised.
- Runbook: `infra/cf-secrets-worker/README.md`. Steps: provision `KEK_V2`, re-wrap every DB row, flip `encryption_version`.
- Dry-run against a throwaway encrypted-column fixture once before we need it for real.
- Non-urgent — noted so we don't discover gaps mid-incident.

#### Agent plugin cohort (candidate "Phase 5.2")

- **Hermes** — shipped locally at `C:/Users/newma/documents/crypto/hermes` branch `clawville-integration` (commit `1fc55d78`, not pushed). End-to-end test: `hermes clawville login` → `reconnect` → `wallet` all work.
- **Milady** — `@clawville/app-clawville` on npm needs the new identity-keypair flow. Currently uses old Phase 5 string-based `identityKey`. Mirror of the Hermes plugin.
- **OpenClaw / IronClaw** — same pattern, for any agent framework that wants `clawville:identity:<userId>` + signed-challenge reconnect as its own CLI command.
- If bundled as "Phase 5.2", ships as one batch PR across the plugin repos.

#### 'scape portal — external (BLOCKED on dex)

- Our side is 100% deployed.
- 'scape's `/hosted-session/issue` accepts shared-secret bearer only — doesn't accept our signature headers yet.
- Unblock requires one of:
  - Dex merges the signature-auth PR (preferred, ~30 LOC on his side)
  - Dex shares his `HOSTED_SESSION_ISSUER_SECRET` → we add `SCAPE_SHARED_BEARER` env var + fallback auth path (~20 LOC on our side)
- Reverse direction ('scape → ClawVille) also needs dex to add "Cross to ClawVille" button + "Link External Account" UI on his side.
- Our `PARTNER_PUBKEYS` env is `{}` — populate once dex sends his pubkey.

#### Smaller Phase 5.1 polish

- [ ] **Dashboard surfacing for Phase 5.1 events** — four new event types (`identity.issued`, `identity.reconnected`, `portal.scape.crossed`/`cross_failed`, `portal.scape.linked`) live on `events` but `/dash` has no cards. Add 4 cards to `apps/api/src/routes/dashboard.ts` matching the existing pattern.
- [ ] **Retry-After header on 429** — rate limiter returns 429 without `Retry-After`; well-behaved clients can't auto-back-off. Surface `resetAt`, compute remaining seconds, set the header. One-line change.
- [ ] **Per-user rate limits for Lucia-authed endpoints** — `/portal/scape`, `/portal/scape-link-code`, future `/admin/*` should key by `user.id` instead of IP. Public endpoints stay per-IP. Requires a `resolveIdentity(c)` helper.
- [ ] **Sliding-window rate limiter via Redis** — deferred. Only matters when we go multi-node; single-node today.

---

### 3. Cross-chain deferred work

#### x402 middleware activation (Solana-first)

Phase 4 shipped the audit ledger + treasury keypair infra. This activates the actual HTTP 402 paywall on agent-facing endpoints.

**Status: scaffold shipped, paywall off by default.** Gated on `X402_ENABLED=true`. Activation is one env var flip away; the gate protects against accidental mainnet charges during dev iteration.

**Live:**
- `@x402/hono@2.9.0`, `@x402/svm@2.9.0`, `@x402/core@2.9.0` installed in `apps/api`
- `apps/api/src/services/x402-config.ts` — loads env, builds `x402ResourceServer` with `registerExactSvmScheme`, defines `RoutesConfig`
- `apps/api/src/routes/agent-v2.ts` — `GET /api/v2/agent/ping` protected by `paymentMiddleware` when `X402_ENABLED=true`. When disabled, route still responds with `{ x402Enabled: false }` so you can verify it's mounted.
- Merchant wallet in `treasury_wallets`: pubkey `79sH9jtT7EpWLCemadFZQb7sD1b6rCqkwTtSxDCViLLE`, encrypted secret in Supabase.
- `CLAWVILLE_MERCHANT_WALLET_PUBKEY` + `VANITY_ENCRYPTION_KEY` staged on Coolify api app.

**Open:**
- [ ] Flip `X402_ENABLED=true` on Coolify once a Solana mainnet USDC wallet is funded + CDP facilitator account is set up
- [ ] Wire middleware onto real endpoints (consult, knowledge export, simulation status) after the ping smoke-test passes
- [ ] Decision point: free tier limit (e.g. 3 consults/IP/day) vs hard 402 from first request
- [ ] Verify CDP facilitator URL for Solana mainnet (check https://docs.cdp.coinbase.com/x402/welcome — currently defaulting to `https://api.cdp.coinbase.com/platform/v2/x402`)

#### BSC migration

User has partnerships and networks on BSC — first-class chain target alongside Solana.

- [ ] Decide: BEP-20 ClawToken mirror, x402 on BSC, or both
- [ ] Add EVM client (viem or ethers) alongside Solana web3.js
- [ ] Duplicate `treasury_wallets` pattern for EVM keypairs (different encryption scheme)
- [ ] x402 on BSC: register `ExactEvmScheme` with `network: 'eip155:56'`
- [ ] BSC USDC vs USDT vs custom token — decide default settlement asset
- [ ] Frontend: wallet connect for BSC users (Trust Wallet, MetaMask)

#### Base migration

Base has the strongest agent ecosystem (ERC-8004, x402 default, Coinbase CDP). Good second EVM chain after BSC.

- [ ] Add Base as a third network alongside Solana + BSC
- [ ] x402 on Base: `network: 'eip155:8453'`, USDC at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- [ ] Coinbase CDP facilitator + Base Paymaster for gasless user UX
- [ ] Evaluate ERC-8004 canonical deployment on Base (may need to deploy our own fork)

#### Avatar Identity NFTs (Phase 5 candidate — Solana first)

- [ ] Mint each avatar as a Metaplex Core NFT or cNFT on Solana (cheap, ~$0.00005/mint via cNFTs)
- [ ] Transfer event indexer updates `avatars.userId` on ownership change
- [ ] Dynamic metadata endpoint `/api/avatars/:id/metadata.json`
- [ ] BSC / Base: ERC-721 mint + ERC-8004 Identity Registry integration

#### Avatar token launches (Phase 5 candidate — Solana first, schema already exists)

**Done:** Schema (`vanityKeypairs`, `tokenLaunches`), encryption, keypair import CLI, docs at `docs/agent-token-launch-research.md`.

- [ ] Wire `POST /api/tokens/launch/:avatarId` endpoint
- [ ] Pump.fun integration — bonding curve interaction, SOL transfer, mint flow
- [ ] Raydium LaunchLab as alternative platform
- [ ] Status polling for graduation
- [ ] BSC: PancakeSwap launchpad equivalent
- [ ] Base: Zora / Uniswap V4 memecoin launchpads

---

### 4. Milady sideload follow-ups

**Status:** `@clawville/app-clawville@0.1.0` LIVE on npm. PR `milady-ai/milady#1839` MERGED into Milady's `develop` branch (default branch, where releases are cut from). ClawVille is in the curated app grid and ships in the next Milady release (v2.0.11+). Last release was v2.0.10 on 2026-04-07.

**Verified 2026-04-13:** Plugin smoke test passes end-to-end (`npm run smoke` in plugin repo). All 8 tests pass. Persistent fixture avatar `clawville-plugin-smoketest-v1` confirmed on prod.

**Not yet tested:** Milady viewer iframe embedding (loading clawville.world/game inside Milady's app shell with bootstrap script injection). Requires a running Milady runtime instance. Low priority until next Milady release ships and real users access the app grid entry.

- [ ] **Migrate GitHub repo ownership** from `ItachiDevv/clawville-milady-plugin` to a dedicated `clawville` GitHub org. Update `package.json` `repository.url` + `bugs.url`, republish as `0.1.1` with new links, update all docs pointing at the old URL. Keep `ItachiDevv` as a maintainer on the transferred repo.
- [ ] **Post announcement of the sideload path** in Milady community channels (Discord `#plugins` / `#apps`, `@miladyai` Twitter, awesome-Milady README if it exists, link from blog if we have one). Lead with "ClawVille now runs inside Milady — one curl command to install" + point at INSTALL.md. **Do NOT post until tested against a real Milady instance.**
- [ ] **Re-enable npm "Auth and writes" 2FA** on the `clawville-admin` account once next version is published via an automation token. Profile: https://www.npmjs.com/settings/clawville-admin/profile.
- [ ] **Tag GitHub release `v0.1.0`** on the plugin repo so users have a stable download pointer separate from the npm tarball.
- [ ] **Wire `clawville-embed-mode` detection** in `apps/web/src/app/page.tsx` so landing/auth overlays auto-hide when ClawVille is loaded inside a Milady viewer. Detection via `window.parent !== window` + `document.referrer`, or via a query param the plugin appends.
- [ ] **Verify DOM element IDs** used by the plugin's viewer bootstrap script match what ClawVille actually renders. Bootstrap was written defensively without verifying — selectors target `#landing-overlay`, `#auth-modal`, `#login-overlay`, `#create-avatar-overlay`. (Overlay id renamed from `create-pet-overlay` in the 2026-05-08 rename — verify the plugin bootstrap.)

---

### 5. Treasury wallet import (WAITING ON USER)

**Drop the file at exactly this path:**

```
C:\Users\newma\Documents\Crypto\ClawVille\scripts\deploy\treasury-wallet.json
```

Format must be the Solana CLI byte-array (64-integer JSON array). If your wallet is stored differently, say what format and I'll explain how to convert it without exposing the key.

Once the file is in place, say "imported" (or just "go") and I'll run:

```bash
bun run scripts/import-treasury-wallet.ts scripts/deploy/treasury-wallet.json x402-merchant "Phase 4 prod merchant"
```

Then I'll print the public key, stage `CLAWVILLE_MERCHANT_WALLET_PUBKEY=<pubkey>` on Coolify, redeploy api, and confirm you can safely delete the local JSON file (advise you to move the original to cold storage).

**Never** cat / print / log the file contents. The only path out of memory is encrypted, into the DB.

---

### 6. VPS infrastructure hygiene

Coolify VPS hit 100% disk on 2026-04-16 from accumulated Docker images + build cache during rapid iteration. Pruned to 71% used. Each push creates a new image layer + build cache; Next.js + Turborepo builds are ~2 GB each.

- [ ] **Docker log rotation** — add `/etc/docker/daemon.json`:
  ```json
  { "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "3" } }
  ```
  Then `systemctl restart docker`. Caps each container log at 150 MB.
- [ ] **Weekly prune cron (Sunday 3 AM):**
  ```bash
  echo '0 3 * * 0 docker system prune -af --filter "until=168h" >/dev/null 2>&1' | ssh root@<PROD_VPS_IP> "tee -a /etc/cron.d/clawville-prune"
  ```
  Keeps last 7 days of images for rollback; reclaims everything older.
- [ ] **Disk > 85% Telegram alert** — hourly cron `df / | awk 'NR==2{if (+$5+0 > 85) send_push()}'` via the existing `ITACHI_DEBUG_BOT_TOKEN` Bot API.

---

## 🟡 Small backlog

### Land economy follow-ups (after the 2026-06-18 FOR-RENT showroom)
- [ ] **Land parcel INTERIORS / interior designs** — when you own a home/shop, let it have a walk-in interior scene (enter the building → interior room you can decorate/lay out). Tiered interior design options (higher land tier / structure level unlocks nicer interior kits), mirroring the exterior tier-gate. This is the big one the showroom is a teaser for. (Relates to the §Small-backlog "enter building" interior item below — share the interior-scene infra.)
- [ ] **"Claim a model home & inherit its level" transfer economy** — make the FOR-RENT showroom lots actually claimable as fixer-uppers: a buy/claim that transfers the showroom-styled parcel to the buyer WITH a pre-placed structure at its showroom level (vs the current path of buy-empty-then-place). Needs a system-owned "ClawVille Estates" avatar (or a `showroom`/`rentable` parcel flag) + a claim/transfer route; today the showroom is decorative-only and the buyer just buys the empty lot and places their own. Wire parcel-ownership hydration into the land store so `land-showroom.tsx`'s hide-when-owned actually fires in real time.

#### Land polish + UX (founder review 2026-06-18, after the 2-ring big-plot ship to prod)
- [ ] **Bump building/plot size up another notch** — the 2-ring big plots (founder 1216wu / starter 1088wu, buildings ~0.62–0.78× footprint) read better than the 180-plot grid but are still "a bit too small" per founder. Try another size pass (bigger footprints and/or a higher `FOOTPRINT_FRACTION`/`levelScale` for placed structures in `land-showroom.tsx` + `land-structures.tsx`) so a building feels closer to town-building scale. Re-check no-overlap + grid bounds in `land-parcels.ts` after any footprint change.
- [ ] **In-world walk-up-to-buy** — today the ONLY way to purchase land is the sidebar **Land Office** menu (`openLandOffice()`); walking up to a plot does NOTHING. Add proximity detection on a parcel (reuse the building/NPC proximity pattern) → an in-world "Press E to view / buy this plot" prompt → opens the Land Office **focused on that specific parcel**. This is the missing in-world affordance the signs imply. (There is currently NO raycast/proximity/click handler on land parcels — confirmed.)
- [ ] **Sign-post occludes the "FOR SALE" plank text** — in `land-parcels.tsx` the wooden sign POST (the "wood spine") sits in FRONT of the plank face and covers the baked "FOR SALE"/"PREMIUM"/"PARTNER" content. Move the post BEHIND or to the SIDE of the plank (offset the post along the plank's facing normal so it doesn't overlap the readable face), or split the post into two thin legs at the plank edges. The 3 category sign sizes are otherwise "decent, could be better" — open to a fancier plank pass too.
- [ ] **DESIGN: what does "build mode" / land ownership actually DO? (needs case studies)** — the sidebar menu proposes a "build mode" but it is **not laid out/designed**. Today you can claim/buy a parcel and place a structure + "upgrade" it, but the post-claim metrics (structure level "v2") **do essentially nothing** — no gameplay payoff. Before building more, actually DESIGN the loop: what does owning land give you, what does building/upgrading unlock, what is the build-mode UI/UX. Do **case studies** of land/build-economy games (what ownership + upgrade levels actually grant) and write a short design doc / plan before implementing. This gates the INTERIORS + transfer-economy items above.
- [ ] Remove the visible sand square on pineapple-house.glb (artifact in the source GLB).
- [ ] Building proximity interactions — currently you walk up to a character; later: explicit "enter building" with an interior scene.
- [ ] Minimap shows player position; add NPC positions (sonar blips with species color).
- [ ] Personality page UX bug — large empty space between archetype cards and the CREATE button on `/create-agent/personality`; habitat/hobby/greeting selectors not visible without scrolling.
- [ ] Tutorial Quest tracker — 2 quests have `status: 'pending'` (Style Statement, Big Spender) — wire them up when the cosmetic shop has SKUs and a "Big Spender" event aggregator exists.

---

## Naming + housekeeping

- The `pets` → `avatars` rename pass landed 2026-05-08. If you see a leftover `pet` reference anywhere except `pet_session_*` schema columns and the deprecated `seed-bot-pets.ts` script name (kept for historical Git blame), fix it on sight and note the change in the relevant doc's "Recent material changes" log.
- The four canonical docs (`CLAUDE.md` / `WorldContent.md` / `3dStructure.md` / `ARCHITECTURE.md` / `GameFeatures.md`) have a strict bidirectional sync contract with the code paths they reference. Same-diff updates only. Mismatch is a bug.

---

## 🔒 Security hardening backlog

- [ ] **(LOW, gated) Hatcher launch-exchange SSRF parity** — `apps/api/src/routes/partner-hatcher-launch.ts:244` validates the outbound exchange URL with the *synchronous* `validateHatcherProxyUrl()` (host-allowlist only), whereas the portal session-issue fetches use the DNS-resolving `validateHatcherProxyUrlResolved()` (security #2, 2026-06-16). Risk is **LOW** — the exchange URL is a hard-coded literal (not partner-steerable), `redirect:'manual'` backstops a rebind hop, and a 10s `AbortController` bounds it. For parity / defense-in-depth, swap to `validateHatcherProxyUrlResolved()` to add a guard-time private-IP reject. **GATED: protected partner surface** — per `CLAUDE.md`, any change to `partner-hatcher-launch.ts` requires a Codex adversarial pass + the mock-Hatcher harness gate before ship; logic is comment-equivalent, **no `PROTOCOL_VERSION` bump** (no wire change). Surfaced by the 2026-06-18 staging audit (Codex review).
