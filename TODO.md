# ClawVille TODO

## CRITICAL RULES
- **NEVER run localhost for testing** — crashes Intel Iris Xe GPU, requires PC restart
- **Always push to git → Coolify auto-deploys → test on production URL**
- Production URL: https://clawville.world/game
- API URL: https://api.clawville.world
- Server: Hetzner CCX13 at <PROD_VPS_IP>, orchestrated by Coolify at https://coolify.clawville.world

---

## 🔴 IMMEDIATE — Treasury wallet import

**Drop the file at exactly this path:**

```
C:\Users\newma\Documents\Crypto\ClawVille\scripts\deploy\treasury-wallet.json
```

Format must be the Solana CLI byte-array (64-integer JSON array). If your wallet is
currently stored differently, tell Claude the format and it will explain how to convert
it without exposing the key.

Once the file is in place, tell Claude "imported" (or just "go") and it will run:

```bash
bun run scripts/import-treasury-wallet.ts scripts/deploy/treasury-wallet.json x402-merchant "Phase 4 prod merchant"
```

That will print the public key. Claude will then:
- Stage `CLAWVILLE_MERCHANT_WALLET_PUBKEY=<pubkey>` on Coolify
- Redeploy the api container
- Confirm you can safely delete the local JSON file (and advise you to move the
  original to cold storage)

Claude will never cat, print, or log the contents of the file at any point. The only
way the secret bytes leave memory is encrypted, into the DB.

---

## Cross-chain (deferred work)

All cross-chain and on-chain work lives here until Hetzner/Coolify cutover is done. Each sub-section is independent — they can ship in any order.

### x402 middleware activation (Solana-first)
Phase 4 shipped the audit ledger + treasury keypair infra. This activates the actual HTTP 402 paywall on agent-facing endpoints.

**Status: scaffold shipped, paywall off by default.** The full wiring exists but is gated on `X402_ENABLED=true`. Activation is one env var flip away; the gate protects against accidental mainnet charges during dev iteration.

**What's live:**
- `@x402/hono@2.9.0`, `@x402/svm@2.9.0`, `@x402/core@2.9.0` installed in `apps/api`
- `apps/api/src/services/x402-config.ts` — loads env, builds `x402ResourceServer` with `registerExactSvmScheme`, defines `RoutesConfig`
- `apps/api/src/routes/agent-v2.ts` — `GET /api/v2/agent/ping` protected by `paymentMiddleware` when `X402_ENABLED=true`. When disabled, the route still responds with `{ x402Enabled: false }` so you can verify the route is mounted.
- Merchant wallet in `treasury_wallets`: pubkey `79sH9jtT7EpWLCemadFZQb7sD1b6rCqkwTtSxDCViLLE`, encrypted secret in Supabase
- `CLAWVILLE_MERCHANT_WALLET_PUBKEY` + `VANITY_ENCRYPTION_KEY` staged on Coolify api app

**Tasks:**
- [x] Post-Hetzner deploy: import merchant wallet into treasury_wallets via `scripts/import-treasury-wallet.ts` (pubkey `79sH9jtT7EpWLCemadFZQb7sD1b6rCqkwTtSxDCViLLE`)
- [x] Add `CLAWVILLE_MERCHANT_WALLET_PUBKEY` env var to Hetzner/Coolify config
- [x] Add deps: `@x402/hono@2.9.0`, `@x402/svm@2.9.0`, `@x402/core@2.9.0` to `apps/api/package.json`
- [x] v1/v2 Solana coexistence: no interop needed — server-side verification only uses the merchant *public key* as a string. `keypair-vault.ts` stays on v1, `@x402/svm` uses v2 internally. Peer-dep warning for `@solana/kit@6.8.0` is non-blocking; add it explicitly if/when we need client-side signing.
- [x] Write `apps/api/src/services/x402-config.ts` — loads env, builds `x402ResourceServer`, defines `RoutesConfig`
- [x] Skeleton: `/api/v2/agent/ping` route wired behind `X402_ENABLED` env flag (default off). Files: `apps/api/src/routes/agent-v2.ts`, registered at `apps/api/src/index.ts`.
- [ ] **Next**: flip `X402_ENABLED=true` on Coolify once a Solana mainnet USDC wallet is funded + CDP facilitator account is set up
- [ ] Wire middleware onto real endpoints (consult, knowledge export, simulation status) after the ping smoke-test passes
- [ ] Decision point: free tier limit (e.g. 3 consults/IP/day) vs hard 402 from first request
- [ ] Verify CDP facilitator URL for Solana mainnet (check https://docs.cdp.coinbase.com/x402/welcome — currently defaulting to `https://api.cdp.coinbase.com/platform/v2/x402`)

### BSC migration
User has partnerships and networks on BSC — first-class chain target alongside Solana.

**Tasks:**
- [ ] Decide: BEP-20 ClawToken mirror or x402 on BSC or both?
- [ ] Add `@solana-program` equivalent for BSC (viem or ethers)
- [ ] Duplicate treasury_wallets pattern for EVM keypairs (different encryption scheme — key storage format differs from Solana)
- [ ] x402 on BSC: register `ExactEvmScheme` with `network: 'eip155:56'` (BSC mainnet chain ID)
- [ ] Wallet custody for BSC funds — same cold-wallet pattern
- [ ] BSC USDC or BSC-USD (USDT) or custom token — decide default settlement asset
- [ ] Frontend: wallet connect for users with BSC wallets (Trust Wallet, MetaMask)

### Base migration
Base has the strongest agent ecosystem (ERC-8004, x402 default, Coinbase CDP). Good second EVM chain after BSC.

**Tasks:**
- [ ] Add Base as a third network alongside Solana + BSC
- [ ] x402 on Base: `network: 'eip155:8453'`, USDC at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- [ ] Coinbase CDP facilitator + Base Paymaster for gasless user UX
- [ ] Evaluate ERC-8004 canonical deployment on Base (Basescan lookup — may need to deploy our own fork)

### Pet Identity NFTs (Phase 5 candidate — Solana first)
**Tasks:**
- [ ] Mint each pet as a Metaplex Core NFT or cNFT on Solana (cheap, ~$0.00005/mint via cNFTs)
- [ ] `pets.walletAddress` column + Transfer event indexer
- [ ] Dynamic metadata endpoint `/api/pets/:id/metadata.json`
- [ ] BSC/Base: ERC-721 mint, ERC-8004 Identity Registry integration
- [ ] Decision: custodial (keypair-vault) vs embedded wallet (Privy)

### Pet Token Launches (Phase 5 candidate — Solana first, schema already exists)
**Already done:** Schema (`vanityKeypairs`, `tokenLaunches`), encryption, keypair import CLI, docs at `docs/agent-token-launch-research.md`

**Tasks:**
- [ ] Wire POST `/api/tokens/launch/:petId` endpoint
- [ ] Pump.fun integration — bonding curve interaction, SOL transfer, mint flow
- [ ] Raydium LaunchLab integration (alternative platform)
- [ ] Status polling for graduation
- [ ] BSC: PancakeSwap launchpad equivalent
- [ ] Base: Base memecoin launchpads (Zora, Uniswap V4)

---

## Current State
- WebGPU renderer active with WebGL2 fallback ✅
- GLB model buildings (SpongeBob style: Krusty Krab, Pineapple, Patrick's Rock, etc.) ✅
- GLB lobster NPCs with species color tinting ✅
- Bikini Bottom terrain GLB as sandy landscape ✅
- Terrain raycasting with Layer 1 isolation ✅
- Deployed to Hetzner CCX13 + Coolify ✅ (migrated off Railway 2026-04-10)

---

## TOP PRIORITY: ElizaOS v2 Migration (4 Phases)

Currently on `@elizaos/core@1.7.1`. Migrate to `2.0.0` in 4 bounded, independent phases. Each phase ships separately and is reversible. Phases 2-4 are enabled by Phase 1 but should NOT be bundled with it.

**Key research findings (from collaborative agent team, 2026-04-10):**
- `AgentRuntime` class name and `@elizaos/core` package name unchanged in v2
- `adapter: IDatabaseAdapter` is now REQUIRED on AgentRuntime constructor (no longer lazy-loaded via plugin-sql)
- `@elizaos/plugin-bootstrap` REMOVED — replaced by `createBootstrapPlugin(config)` built into core, auto-registered during `runtime.initialize()`. External code must NOT import `bootstrapPlugin` directly.
- API keys move from runtime `settings` → `character.secrets` field
- `getMemories({ count })` → `getMemories({ limit })` (count deprecated but still works)
- `Plugin.models` remains single-handler-per-key (not array): `{ [ModelType.TEXT_LARGE]: handler }` pattern unchanged
- `createMemory(memory, tableName)` second arg retained
- `ChannelType.API` still valid
- `runtime.generateText(prompt, opts)` still on IAgentRuntime (don't have to migrate to `useModel`)
- Our OpenClaw + Ultrathink providers port ~unchanged (priority-based model selection preserved)

### Phase 1 — Pure Runtime Port (CURRENT)
Bump versions, rewrite `eliza-runtime.ts` to match v2 APIs, verify custom plugins still work, ensure existing chat/NPC/autonomy flows function unchanged. **No feature changes.** Ship boring, reversible parity.

- [ ] Bump `@elizaos/core` 1.7.1 → 2.0.0
- [ ] Bump `@elizaos/plugin-anthropic` 1.5.12 → 2.0.0 (still used as fallback; ultrathink bypasses it)
- [ ] Bump `@elizaos/plugin-openai` 1.6.0 → 2.0.0 (embeddings)
- [ ] Bump `@elizaos/plugin-sql` 1.7.1 → 2.0.0
- [ ] Remove `@elizaos/plugin-bootstrap` from pluginMap + dynamic import (built into core in v2)
- [ ] Construct + inject `IDatabaseAdapter` directly into AgentRuntime constructor
- [ ] Move API keys from `settings` → `character.secrets`
- [ ] Update `getMemories` to use `limit` instead of `count`
- [ ] Verify OpenClaw provider plugin (`priority: 100`) still wins priority chain
- [ ] Verify Ultrathink provider plugin (`priority: 90`) still wins over default Anthropic
- [ ] Test all 10 building agents chat flow on clawville.world
- [ ] Test pet chat, NPC conversations, pet autonomy
- [ ] Verify Milady gateway + collaboration still inject dynamic context correctly
- [ ] Rollback path: revert package.json + eliza-runtime.ts if anything breaks

### Phase 2 — Autonomy System (HTN-driven pet behavior)
Replace 336-line hand-rolled `pet-autonomy.ts` state machine with v2's ActionPlan + autonomy primitives. Pets pursue declarative goals like "visit 3 buildings, earn tokens, learn about cron jobs" via runtime-driven planning.

**v2 primitives used:** `ActionPlan`, `ActionResult` (with `values` + `data` for chaining), `Action` interface, task-mode autonomy (if `ENABLE_AUTONOMY` ships in our build — otherwise wrap `agentloop` manually).

- [ ] Verify `ENABLE_AUTONOMY` + `AutonomyService` are available in our v2 install (may be Eliza Cloud only)
- [ ] If not available: build thin custom `AutonomyService` wrapping `agentloop` + `ActionPlan` type
- [ ] Define actions: `MOVE_TO_BUILDING(id)`, `CHAT_WITH_BUILDING(id)`, `BUY_BOOK(bookId)`, `LEARN_BOOK(bookId)`, `RETURN_HOME`
- [ ] Each action returns `ActionResult` with `values.tokensEarned`, `data.bookPurchased`, etc.
- [ ] Move pathfinding (`findPath()`) into `MOVE_TO_BUILDING` handler body
- [ ] Move token award + activity log DB writes into action handlers
- [ ] Port `maxVisitsThreshold` + `MAX_TOKENS_PER_SESSION` to a cost-control Evaluator firing on `ACTION_COMPLETED`
- [ ] Add `sendToAdmin` equivalent for failure reporting back to the owner
- [ ] Delete `apps/api/src/services/pet-autonomy.ts` (336 lines → ~0)
- [ ] Test: pet enters autonomous mode, completes 3-building task, returns home

### Phase 3 — Event-Driven Agent Collaboration
Replace 191-line `agent-collaboration.ts` bespoke keyword routing with v2 plugin events + a process-level broker service. Cross-building agents consult each other via events instead of ad-hoc Haiku calls.

**v2 primitives used:** Plugin `events: { [EventType.X]: [handler] }`, `runtime.on/emit`, `ACTION_COMPLETED` evaluator, custom namespaced event `CLAWVILLE_NEED_SPECIALIST`.

**Gotcha:** Event bus is per-runtime. Cross-agent delivery requires a process-level broker — NOT built into v2 core. Our `agent-orchestrator.ts` becomes the broker.

- [ ] Add `CLAWVILLE_NEED_SPECIALIST` custom event constant
- [ ] Build evaluator on building agents that fires event on keyword match (reuses `EXPERTISE_KEYWORDS`)
- [ ] Extend `agent-orchestrator.ts` with cross-runtime event broker (listens on all runtimes, routes by target building, calls target `processMessage`, returns result)
- [ ] Anti-recursion guard: consultation responses must NOT re-trigger evaluators
- [ ] Per-conversation cooldown (e.g., max 2 consultations per user turn)
- [ ] Result becomes provider output on the next source-agent tick
- [ ] Remove ad-hoc `anthropic.messages.create` from collaboration service
- [ ] Delete `apps/api/src/services/agent-collaboration.ts` (191 lines → replaced by broker in orchestrator)
- [ ] Test: cron-hub receives webhook question → cross-consults webhook-gateway → answer enriched with specialist insight

### Phase 4 — AgentID / On-Chain Identity (ERC-8004 + x402)
Pets become ERC-721 NFTs with ERC-8004 Identity Registry entries. Buildings can charge ClawTokens or USDC-on-Base for teaching services via HTTP 402 payment protocol.

**External deps:** ERC-8004 EIP, Coinbase x402 protocol, wallet custody (KMS or Privy-style embedded wallets), on-chain indexer.

**Decoupled from v2 core.** Can ship after Phases 1-3. Real blockchain infra project, not a runtime port.

- [ ] **Decision point:** custodial wallets (KMS) vs embedded wallets (Privy/Dynamic) vs user-held
- [ ] **Decision point:** ClawTokens off-chain (cleaner) vs on-chain ERC-20 (composable)
- [ ] Sub-phase 4a: Mint ERC-8004 Identity NFT at pet creation (Base or Solana)
- [ ] Sub-phase 4a: `pets.walletAddress` DB column + Transfer event indexer updates `pets.userId`
- [ ] Sub-phase 4a: Dynamic metadata endpoint `/api/pets/:id/metadata.json` serving live pet state
- [ ] Sub-phase 4b: x402 paywall on building chat endpoints (returns 402 + price in ClawTokens/USDC)
- [ ] Sub-phase 4b: Pet wallet service auto-pays for teaching requests
- [ ] Sub-phase 4b: Evaluate 0xgasless/agent-sdk as reference implementation
- [ ] **Prerequisite:** ServiceType.wallet ships in public v2 or we vendor a wallet plugin
- [ ] Risks: ERC-8004 registries not yet canonically deployed; custodial wallet regulatory exposure

---

## Completed: Control System Redesign

### Step 1. Game store — add control mode state ✅
### Step 2. Separate WASD from Arrow Keys ✅
### Step 3. New camera controllers (FPS follow + WASD pan + Arrow rotation) ✅
### Step 4. NPC possession mode (WASD drives NPC, camera follows) ✅
### Step 5. Autonomous mode ✅
- [x] Goal-driven autonomy engine (`stores/autonomy.ts`) with state machine
- [x] Scoring: unvisited buildings +50, proximity +20, variety bonus +25
- [x] Reuses clickPath for movement (zero 3D changes)
- [x] WASD/E/Escape disabled in autonomous mode
- [x] Autonomy HUD showing goals, thoughts, session stats
- [x] `enterBuilding` / `exitBuilding` with timed study sessions (8-15s)
- [x] External goal injection via `injectGoal()` for OpenClaw/Hermes
### Step 6. Mode toggle UI ✅

## NEXT: Autonomous Agent Enhancements

---

## Completed: Visual Upgrades
- [x] V1. Fix buildings — swapped 3 dome duplicates to unique GLBs
- [x] V2. Fix decorations — cluster scatter, 120 items, more variety
- [x] V3. Fix floor — TSL sand material with ripples, grain, height roughness
- [x] V4. Character animations — LobsterAnimator wired (skeletal + procedural)
- [x] Merged seaweed — 3000 blades, 3 variants, TSL wind animation
- [x] Underwater atmosphere — caustics, depth backdrop, dust particles
- [x] God rays — 7 pulsing light shafts
- [x] Direction fix — lobster models face correct direction

---

## Previous: Visual Issues (archived)

### V1. Fix buildings — wrong models rendering at some locations
- [ ] Audit which buildings are rendering the wrong GLB model
- [ ] Ensure each buildingZone maps to its correct GLB file
- [ ] File: `apps/web/src/lib/three/arena-buildings.tsx`

### V2. Fix decorations — bare map, clustered placement
- [ ] Decorations currently sit in random clusters instead of spread across the map
- [ ] Use ALL available decoration types (corals, kelp, rocks, etc.)
- [ ] Spread evenly across the terrain for an exciting, populated map
- [ ] File: `apps/web/src/lib/three/arena-terrain.tsx` or dedicated decorations file

### V3. Fix floor — untextured sand
- [ ] The ground is plain untextured sand, needs proper material for a 3D game
- [ ] Add sand texture (normal map, roughness, color variation)
- [ ] Consider underwater caustic/ripple effects
- [ ] File: `apps/web/src/lib/three/arena-terrain.tsx`

### V4. 🔴 Big Task: Fix character movement animations
- [ ] GLB models exist for agents and NPCs but have NO movement animations
- [ ] Need walk/idle animation cycles on the lobster GLBs
- [ ] Options: Mixamo retarget, procedural animation, or swap to animated GLBs
- [ ] Apply to both player pet and NPC lobsters
- [ ] Files: `apps/web/src/lib/three/arena-npcs.tsx`, `apps/web/src/lib/three/player-pet.tsx`

---

## Previous Priority Issues

### 1. ~~NPCs not moving~~ DONE
- [x] Root cause: API SSE stream sending 10 idle NPCs overwriting client wander
- [x] Fix: disabled SSE stream, demo wander runs freely with 10 colorful lobsters

### 2. Location NPC models — unique character per building
Each building needs a dedicated NPC that stands in front and teaches the building's skill.
- [ ] Find/create 10 unique character GLB models (one per building theme)
- [ ] Possible sources: Sketchfab, ReadyPlayerMe, Mixamo characters
- [ ] Suggested characters per building:
  - cron-hub (Tide Clock): clockwork robot / old sailor
  - webhook-gateway (Krusty Krab): SpongeBob-style fry cook
  - memory-vault (Squidward's): librarian / scholar
  - skill-forge (Chum Bucket): blacksmith / mad scientist
  - channel-bridge (Shipwreck): pirate captain
  - tool-workshop (Submarine): mechanic / engineer
  - canvas-studio (Pineapple): artist / painter
  - voice-tower (Tower): bard / town crier
  - security-fortress (Rock): knight / guard
  - config-citadel (Seashell): wizard / sage
- [ ] Place each NPC at the entrance of their building using buildingZones positions
- [ ] Wire up interaction — clicking NPC opens the building's chat/shop
- File: create `apps/web/src/lib/three/arena-location-npcs.tsx`

### 3. ~~Ground texture + decorations~~ DONE
- [x] Procedural sand texture (canvas noise + ripples, tiled 24x16)
- [x] Replaced blue blob decorations with 12 coral-reef + kelp models

## DONE (this session)

### ~~Extend sandy terrain~~ DONE
- [x] Added sand plane (0xe8d5b0) at y=-6, MAP_WIDTH*3 x MAP_HEIGHT*3

### ~~Spread buildings apart~~ DONE
- [x] Repositioned all 10 buildingZones across full 40x25 grid

### ~~NPCs bigger~~ DONE
- [x] NPC_SCALE 4->8, speed 1.5->4, tick 200->100ms

### ~~Wire up underwater decorations~~ DONE
- [x] underwater-decorations.glb loaded + 8 clones scattered at map edges

### ~~Building edit mode~~ DONE
- [x] Visit /game?edit=1 to drag-and-drop buildings, copy positions

## Completed
- [x] WebGPU renderer with WebGL2 fallback
- [x] GLB model buildings replacing primitive geometry
- [x] GLB lobster NPCs replacing 30-mesh primitives
- [x] Bikini Bottom terrain replacing grey procedural sand
- [x] Terrain raycasting with layer isolation
- [x] SpongeBob building models downloaded (Krusty Krab, Pineapple, Patrick's Rock, Squidward's House, Chum Bucket)
- [x] Deploy to Railway (web + API) — later migrated to Hetzner + Coolify (2026-04-10)
- [x] GPU-safe scene (~50 draw calls, was 350+)

## Gameify — RPG/MMO Features

### 1. Skill Bazaar (Diablo/WoW/EverQuest themed)
A marketplace building where players/agents buy and sell skills.
- [ ] Bazaar building in the 3D world (dedicated zone, maybe Sandy's Treedome or new building)
- [ ] Browse skills by category, rarity, price — RPG-style item cards with stats
- [ ] Sellers list skills they've earned from buildings (knowledge books = inventory items)
- [ ] Buyers spend ClawTokens to purchase — seller gets paid
- [ ] Rarity tiers: Common (free lessons), Rare (building-specific), Epic (quest rewards), Legendary (bounty completions)
- [ ] Visual: glowing item pedestals, particle effects per rarity, haggle animations
- [ ] DB: `skill_listings` table (sellerId, skillId, price, rarity, listedAt)
- [ ] API: GET /bazaar/listings, POST /bazaar/list, POST /bazaar/buy

### 2. Auction House for Skills & Agents
Timed auctions where agents and skills go to highest bidder.
- [ ] Auction house building in the world
- [ ] List a skill or full agent config for auction (starting bid, duration)
- [ ] Real-time bidding with countdown timer
- [ ] Snipe protection (extends timer if bid in last 30s)
- [ ] "Buy Now" option at premium price
- [ ] Agent auctions: sell a fully configured agent (character + all learned skills)
- [ ] History log of past auctions and price trends
- [ ] DB: `auctions` table (sellerId, itemType, itemId, startBid, currentBid, bidderId, endsAt)
- [ ] API: GET /auctions, POST /auctions/create, POST /auctions/bid
- [ ] WebSocket or SSE for live bid updates

### 3. Quest NPC — Coding Bounties
A quest-giver NPC that posts coding bounties from the ClawVille team. Completing quests earns native tokens + exclusive skills.
- [ ] Quest board building/NPC in the world (town center or dedicated building)
- [ ] Quests = real coding tasks/bounties posted by the team
- [ ] Reward structure: native token amount + exclusive skill (like getting a legendary item from a raid boss)
- [ ] Quest tiers: Side Quest (small tasks, 10-50 tokens), Main Quest (features, 100-500 tokens + rare skill), Legendary Quest (major milestones, 1000+ tokens + legendary skill + title)
- [ ] Quest status: Available → Accepted → In Progress → Review → Complete/Failed
- [ ] Submission: link to PR/commit, verified by team or automated tests
- [ ] Quest log UI: active quests, completed quests, rewards earned
- [ ] DB: `quests` table, `quest_submissions` table, `quest_rewards` table
- [ ] API: GET /quests, POST /quests/accept, POST /quests/submit

### 4. Agent Setup Screen (WoW Character Select)
Before entering the world, players choose/configure which agent to bring in.
- [ ] Full-screen character select UI (3D model preview, rotating platform, spotlight)
- [ ] Choose from: new blank agent, pre-configured archetypes, previously saved agents
- [ ] Agent stats display: skills learned, knowledge areas, level, token balance
- [ ] "Talent tree" style skill visualization showing what the agent knows
- [ ] Loadout system: equip skills before entering (limited skill slots like ability bars)
- [ ] Import/export agent configs (JSON or on-chain)
- [ ] Visual: dramatic lighting, particle effects, "Enter World" button with animation
- [ ] Route: /select-agent (before /game)

### 5. Bounty Board — Community Coding Bounties
An open board where anyone (AI agents or humans) can post coding bounties for others to complete.
- [ ] Bounty board building in the world (notice board visual with pinned tasks)
- [ ] Anyone can post a bounty: title, description, requirements, reward
- [ ] Minimum reward: must include native token (ensures skin in the game)
- [ ] Bonus rewards: poster can add new AI agent configs, new skills, NFTs, etc.
- [ ] AI agents can autonomously browse, accept, and attempt bounties
- [ ] Reputation system: completion rate, quality score, earnings history
- [ ] Dispute resolution: poster approves/rejects, escalation to DAO vote
- [ ] Featured bounties: team-promoted bounties get visibility boost
- [ ] DB: `bounties` table, `bounty_attempts` table, `bounty_rewards` table
- [ ] API: GET /bounties, POST /bounties/create, POST /bounties/accept, POST /bounties/submit, POST /bounties/approve

## Later
- [ ] Remove ground plane squares from building GLB models (the pineapple has a visible sand square)
- [x] Custom domain for web (clawville.world)
- [ ] Fix API NPC conversations (Anthropic API key not resolving — re-verify on Coolify after Phase 2/3/4 deploys stabilize)
- [ ] Building proximity interactions (enter building on approach)
- [ ] Minimap showing NPC positions
- [ ] Better camera follow for logged-in player
- [ ] Add more SpongeBob-style buildings (Sandy's Treedome, etc.)

## GPU Performance Rules
- NEVER use Text/Billboard from drei (crashes Intel Iris Xe)
- NEVER test locally — always push → Coolify auto-deploys → test on clawville.world
- Keep total draw calls under 100
- Use GLB models (1-2 draw calls each) not primitive meshes
- WebGPU renderer is active (import from three/webgpu)
- No per-frame Object3D allocation
- Max 3 lights (hemisphere + ambient + 1 directional)
- Prefer MeshBasicMaterial where lighting isn't needed

## Key Files
- `apps/web/src/components/three/World3DCanvas.tsx` — Canvas + WebGPU + camera
- `apps/web/src/lib/three/arena-terrain.tsx` — Bikini Bottom GLB terrain
- `apps/web/src/lib/three/arena-buildings.tsx` — GLB building loader + raycasting
- `apps/web/src/lib/three/arena-npcs.tsx` — GLB lobster NPCs + terrain following
- `apps/web/src/lib/three/player-pet.tsx` — GLB lobster player + terrain following
- `apps/web/src/stores/npc.ts` — Demo NPC wander system
- `apps/web/src/lib/pixi/tilemap-data.ts` — Building zone positions (buildingZones)
