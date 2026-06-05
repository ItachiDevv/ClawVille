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

**Last edit:** 2026-06-01 — refreshed against a grounded repo scan (feature gates, open PRs/branches, doc + plan pending items, Cove economy). Fixed the stale deploy rules (staging-first, two-host). Added the Feature-Gate graduate-or-delete board, Phase 6 (the Cove), in-flight threads, git hygiene, and grounded backlog. The detailed long-horizon workstreams (ElizaOS v2, Phase 5.1, cross-chain, Milady sideload) below are unchanged.

---

## Critical rules

- **NEVER `bun run dev` locally** — Three.js / WebGPU scene crashes Intel Iris Xe → PC restart. Local test = `bun run build && bun run start`.
- **Staging-first deploy:** push to `staging` → GitHub Actions ships the staging box → verify on the staging URLs → PR `staging → master` → merge → prod. **Never push directly to `master`** except hotfixes (override phrase `direct to master`).
- **Two Hetzner hosts** (Coolify + Traefik + Let's Encrypt, **shared Supabase Postgres** — staging writes mutate prod data):
  - Production → `https://clawville.world` + `https://api.clawville.world`
  - Staging → `https://staging.clawville.world` + `https://api-staging.clawville.world`
- Full playbook: `docs/DEPLOY-HETZNER.md`. Iris Xe / GPU rules: canonical in `3dStructure.md §5a` — **do not duplicate here.**

---

## 🔴 Now — in-flight + prod-reproduced (clear these first)

- [ ] **Promote `staging` → `master` (prod).** `origin/staging` is 3 commits ahead of prod — `6b561af8` (repo `.md` drift purge + gitignore guard), `df630522` (accurate root README), `0054ad58` (NPC run-on-sprint + faithful demo wander + Hermes hosted-gate fix). `gh pr create --base master --head staging` → merge → prod deploys. *(blue-screen fix `3c4e7d1a` already on prod.)*
- [ ] **NPC overlap-deadlock "moonwalk"** (prod-reproduced 2026-05-31) — pairs lock at the 75wu push-out min-separation walking in place; clusters run ~¼ speed. `resolveNpcNpcOverlaps` resets `stuckTicks` every tick so the breaker never fires. Fix specced (~40 LOC + test). `.claude/plans/npc-overlap-deadlock-fix.md`; `npc-simulation.ts:629-670,1225-1234`.
- [ ] **Cove → prod is gated on the §3 verification gate (still open).** All 3 economy fixes are implemented + staging-verified. Before ANY cove game promotes: §3.3 re-run `scripts/casino/edge-sim-{baccarat,blackjack,holdem}.ts` + paste post-fix numbers; §3.4 phone + iPad UI audit of all 3 modals (rake field). `.claude/plans/cove-casino-economy.md §3`.
- [ ] **Tutorial quests humans can never claim** — door-knocker / town-tour / cartographer / building-champion / open-house 400 forever: `building.visited` + chat events fire ONLY from `agent-gateway.ts:1882`, never from human actions (client-only `enterBuilding`). `.claude/plans/tutorial-human-engagement.md`.
- [ ] **Purge hosted-Hermes E2E test data** (shared Supabase; left by the 2026-06-01 live test — API blocks deleting a user's last agent). user `1837a497-4b2b-45e7-a94f-d3c8d4e8db22`, avatar `f3436e0d-9062-4b06-8c8d-2b23ea5a962e` + its agent. Targeted DB delete.
- [ ] **`.md` sync-drift source — optional (already neutralized).** The gitignore guard blocks re-commits. The generator ("sync-hook drift from hoodie-prometh") is NOT a local hook/task or the brain-API syncs — likely a WSL clone or a personal `git add -A` wrapper. Hunt `wsl --list` + cron, or leave it (impact solved).

## 🚦 Feature gates — graduate-or-delete board

> Policy (`CLAUDE.md`): a gate whose review deadline lapses **without its metric met is DELETED, not extended.** Renewal must cite a fresh metric reading.

**🔴 LAPSED — decide now:**
- [ ] `reef_race_spline_sim` (2026-05-12) — `NEXT_PUBLIC_REEF_RACE_USE_SPLINE` never enabled in prod. `reef-race-spline-sim.ts:12`.
- [ ] `reef_race_v2_spline_hud` (2026-05-15) — same un-shipped v2 sim. `reef-race-hud.tsx:63`.
- [ ] `reef_race_build_summary` (2026-05-23) — metric never measurable (no telemetry hook). `reef-race-build-summary.tsx:3`.
- [ ] `sea_creature_animator` ×2 (2026-05-26) — 0 species rigged (`hasRig=false`); delete animator path, keep procedural. `ReefRacePlayer.tsx:620`, `BumperShellsPlayer.tsx:256`.
- [ ] `reef_pb_ghost_toggle` (2026-06-01) — PB-ghost flag respected but toggle UI never surfaced. `ReefRaceGhost.tsx:24`.
- [ ] `skill_marketplace` (bazaar/auctions/marketplace, deadline "deferred") — **no dated deadline = policy violation.** Writes 503 since 2026-04-21; 3D pedestals render empty. Set a real metric+deadline or delete. `improvements.md §7`.

**🟡 ACTIVE — need a `/dash` reading before the date:**
- [ ] `dev_quick_queue_button` (06-15) — dev-only; delete at deadline. `sidebar-menu.tsx:550`.
- [ ] `party_invite_search` (06-15) — UI shell only, endpoints not built; delete popover. `InviteSearchPopover.tsx:23`.
- [ ] `multi_agent_roster` (06-21) — `MAX_AGENTS=1` while N-agent plumbing built; raise to 6 if median session >15min AND return-day >20%, else delete loadout plumbing. `agent-setup.ts:31`.
- [ ] `cove_ct_economy_monitor` (07-01) — houseNet ≥0/gameType over 7d ×2wk once cove ships. `cove-economy.ts:28`.
- [ ] `track-rake-snapshot` (07-01) — wager rake hardcoded 500bps; mirror `rake_bps_snapshot` per-lobby. `wager-program-client.ts:550`.
- [ ] `admin_identity_recovery` (07-01) — 501 stub, blocked on support-chat infra. `admin-identity.ts:22`.
- [ ] `wager-spl-lobbies` (07-01) — SPL write path schema-ready, routes refuse; ship or delete column. `wager.ts:26`.
- [ ] `holdem`/`blackjack`/`baccarat` `autonomous_agent_mode` (07-15) — Autonomous toggle + advisor are UI seams; the connected-agent WS protocol doesn't exist. Delete radio+panel per modal if WS not shipped.
- [ ] `x402_payment_middleware` (07-21) — scaffold live, flag OFF; rip `@x402/*` + `agent-v2.ts` if no metered feature proposed. `x402-config.ts`. *(detail in cross-chain §3 below.)*
- [ ] `wager-mainnet-paid` (09-01) — devnet-only; needs legal + custodial signoff. `wager.ts:35`.

## 🎰 Phase 6 — the Cove (current active phase)

Slots (live, ClawTokens) · Blackjack · Hold'em · Baccarat — engines staging-verified, provably-fair commit-reveal + per-event verifier + cross-game history. **Not on prod** (gated on the §3 verification gate in 🔴 Now).

- [ ] **Global connection SKILL.md endpoint + content-hash manifest — MISSING (BLOCKER for Priority #2).** `/api/skills/connect` is token-gated onboarding only — no in-world WS event/action schemas, table rules, disconnect/timer, advisor contract, or version hash. Until shipped, connected external agents play a different game than hosted agents (three-surface fairness invariant is best-effort only). `agent-gateway.ts:2774`; `CLAUDE.md` three-surface rule.
- [ ] **Hosted-agent protocol-knowledge (3rd surface)** — `createMemory()` injection of the connection manual into hosted ElizaOS runtimes (`subtype:'protocol-knowledge'`) + `stopAgent()` reload. Pairs with the SKILL.md endpoint.
- [ ] **Hosted-agent autonomous in-world (avatar-simulation-bridge)** — chat verified live 2026-06-01 (hosted Hermes responds via ElizaOS+Gemini); the autonomous bridge driving the avatar was NOT separately verified.
- [ ] **Cove guest history (Phase 6.7.5)** — plan drafted, awaiting team dispatch; blackjack/hold'em/baccarat are still mock display shells for guests. `.claude/plans/cove-guest-history.md`.

## 🌿 Git hygiene — branches + PRs

- [ ] **PR #87 (multiplayer Phase 1)** — `feat/multiplayer-phase1` → master, 4 ahead / 38 behind; rebase + retarget `staging`, then review/merge or close.
- [ ] **`perf/meshlet-integration`** — 40 ahead / 102 behind, no PR (Nanite/meshlet rasterizer experiment). Resurrect into a PR or formally retire — biggest unintegrated chunk, going stale. (Rule E3: Codex-first for meshlet/WebGPU.)
- [ ] **Prune stale branches** — `perf/iris-xe-80fps`, `origin/perf/world-labels-overlay`, `origin/worktree-gambling-contracts` (0 ahead → safe delete); `origin/perf/disable-reef-shadows`, `revert/c6-broken-assets`, `origin/memory-audits` (1 ahead → cherry-pick decision first).

## 🧹 Backlog — grounded code/infra debt (from scan)

- [ ] **`building.visited` anti-farm gap** — proximity arm radius is 25× too loose (`agent-gateway.ts:1799`); `building.visited` is leaderboard-scored (weight 3, cap 10/day) so agents can farm visit points off-site. Scoring-integrity, not cosmetic.
- [ ] **Guest-avatar cleanup cron** — `scripts/prune-guest-avatars.ts` never built; expired guest rows accumulate unbounded. `users.ts:116`.
- [ ] **Activity-replay 14-day retention cron** — `prune-activity-replays.ts` missing; `activity_replays.frames` grows unbounded. `activity-replay-log.ts:22`.
- [ ] **Per-user concurrent-match cap (3) unenforced** — `activity-queue.enqueue` only checks the enqueueing avatar. `activity-queue.ts:134`.
- [ ] **`match.found` poll-only (~1s)** — add a control-WS push channel. `activities.ts:412`.
- [ ] **E-key bank-proximity hardcoded centroids** — reads module-scope constants, not discovered GLB centroids; breaks if casino GLB shifts. `3dStructure.md:742`.
- [ ] **reef-race-v2 Phase 2 stubs** — `REEF_RACE_RAMP_ZONES` empty, obstacle-jump unimplemented, `boxCount` hardcoded; drift-sparks UI flagged for deletion once spline graduates. Blocked on the lapsed reef-race gates.
- [ ] **Placeholder GLBs** — quest-giver `crayfish.glb`, deployment-ops `lobster_plush` (pending `larry.glb`). Art-debt.
- [ ] **Client-side rarity fallback** — remove once endpoints ship server-side rarity. `rpg/rarity.ts:161`.
- [ ] **Server-side NPC↔player collision deferred** — unblocked by Multiplayer Phase 1's `POST /api/world/position`. `3dStructure.md:283`.
- [ ] **`agent.memory.persisted` event (Tier 2)** — deferred; until shipped the "ElizaOS is the memory substrate" claim is unmeasured. `improvements.md §7.3`.

## 🗺️ Bigger plans (planning / not started)

- [ ] **crashcat NPC physics** — plan-only (Phase 0 flagged single-NPC server spike → Phase 1 all NPCs + collider unification → Phase 2 player + cove). Aims to replace the AABB clamp / `resolveNpcNpcOverlaps` behind the moonwalk deadlock. `.claude/plans/crashcat-physics-eval.md`.
- [ ] **Multiplayer Phase 1 / 1.5** — 20-player rooms + NPC swap-out + distance LOD (plan-only); 1.5 = wanderer VRM→GLB (deferred, ~30-40% anim-CPU saving, FULL_CAP 14→25).
- [ ] **Meshlet rasterizer Phase B** — wire the proven 167-FPS WebGPU compute rasterizer into `/game` via stacked canvases. Plan v1. (Rule E3.)
- [ ] **Coral Plot builder world (Q3)** — DRAFT awaiting founder review.
- [ ] **Gamification/Economy/Shop Q3** — cosmetic shop, multi-rail CT top-up (fiat/SOL/USDC/$CLAWVILLE), agent-payment surfaces, deferred CT→$CLAWVILLE redemption. Leaderboard weights already live.

---

## 🟢 Active — biggest blocks first

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
- Our Gemini providers port unchanged (priority-based model selection preserved — `gemini-text-provider` priority 95, `gemini-embedding-provider` priority 100).

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

- [ ] Remove the visible sand square on pineapple-house.glb (artifact in the source GLB).
- [ ] Building proximity interactions — currently you walk up to a character; later: explicit "enter building" with an interior scene.
- [ ] Minimap shows player position; add NPC positions (sonar blips with species color).
- [ ] Personality page UX bug — large empty space between archetype cards and the CREATE button on `/create-agent/personality`; habitat/hobby/greeting selectors not visible without scrolling.
- [ ] Tutorial Quest tracker — 2 quests have `status: 'pending'` (Style Statement, Big Spender) — wire them up when the cosmetic shop has SKUs and a "Big Spender" event aggregator exists.

---

## Naming + housekeeping

- The `pets` → `avatars` rename pass landed 2026-05-08. If you see a leftover `pet` reference anywhere except `pet_session_*` schema columns and the deprecated `seed-bot-pets.ts` script name (kept for historical Git blame), fix it on sight and note the change in the relevant doc's "Recent material changes" log.
- The four canonical docs (`CLAUDE.md` / `WorldContent.md` / `3dStructure.md` / `ARCHITECTURE.md` / `GameFeatures.md`) have a strict bidirectional sync contract with the code paths they reference. Same-diff updates only. Mismatch is a bug.
