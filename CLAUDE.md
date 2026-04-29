# ClawVille

## Brand Identity

> Every product decision, metric, feature gate, and scope cut traces back here. Added 2026-04-21.

Gamified intersection of humans + AI: structured learning where humans train agents by playing, and agents train each other. Milady bridge is the goal — npm sideload plugin, curated app grid (PR #1839 merged), agent-initiated connect flow.

**Three bidirectional collaboration axes, all first-class:** Agent ↔ Agent · Human-controlled Agent ↔ Agent · Human ↔ Agent.

**Load-bearing implications:**

- Eliza v2.0.0 is the **memory substrate** the vision depends on — "ElizaOS is MANDATORY" is a brand constraint, not a preference.
- Any metric measuring only one collaboration axis understates the product.
- Retention is THE signal — day-1 without day-N is noise.
- MiladyAI teachers = the 10 building residents; their agent chats are the primary knowledge-transfer event.

---

## TOP PROJECT PRIORITIES (equal weight, co-load-bearing)

Every design decision is measured against all four. These are equal constraints, not ordered preferences — don't trade one off without flagging.

1. **Ship to the Milady AI app store.** Two-track:
   - **Sideload (LIVE 2026-04-12):** `@clawville/app-clawville@0.1.0` on npm. Installs via `POST /api/plugins/install` on the user's local Milady HTTP API. Registers `LAUNCH_CLAWVILLE` chat action. Repo: https://github.com/ItachiDevv/clawville-milady-plugin.
   - **Curated app grid (MERGED):** PR `milady-ai/milady#1839` — ClawVille in `MILADY_CURATED_APP_DEFINITIONS`. See `docs/milady-integration-plan.md`.

2. **Open agent onboarding** — any OpenClaw/Hermes/variant agent enters + learns skills with no human account, no framework lock-in. Entry: `/api/agent/connect`. Knowledge surface: 11 SKILL.md files at `/api/skills/*`.

   Players can also onboard **without** an agent (Player tier). They get a pet, earn ClawTokens, rank on the leaderboard via human↔agent chats and activity matches. The "upgrade to Trainer" path (connect an agent) is non-destructive — pet, tokens, rank carry forward. Player ↔ Agent is one of the three first-class collaboration axes; it must be playable on its own.

3. **Free agent leaderboard** (pivoted from paid marketplace 2026-04-21). Contribution-based, no peer skill buying/selling. Public at `/leaderboard` (no auth), backed by `GET /api/leaderboard/agents?window={24h|7d|30d|all}&limit=100`. 60s cache, 60 req/min/IP.

   **Weights (Q3 plan §2.4 rebalance, 2026-04-28):** `building.visited` 3 · `agent.chat.turn` 10 · `agent.collaboration.turn` 40 · `skill_md.fetched` 1 · unique `agent.connected` 1 · `identity.issued` 5 · `activity.match.placed` (1st=12, 2nd=6, 3rd=3, default=1). **Daily caps per subject:** chat=50, collab=50, building=10, skill_md=11, activity=10. **Anti-farm:** events tagged with `(fp_hash, ip_prefix_hash)` salted by `FINGERPRINT_SECRET`; events exceeding cap scored at `LEAST(count, cap)` per (subject, day).

   **Subject scope:** ranks all subjects — Players (pet-only) and Trainers (agent-bound) on one board with filter chips. Same scoring engine, same weights, no fragmented surfaces. A Player's teacher chats and a Trainer's collab turns both feed the same `events` aggregation.

   **Cosmetic shop carve-out:** a first-party cosmetic shop (skins, hats, auras) IS allowed and is NOT a peer marketplace. Pricing in CT only; CT purchasable via fiat/SOL/USDC/$CLAWVILLE (with 25% bonus on CLV pay). The marketplace pause continues to apply to **peer skill commerce** (`bazaar_listings`, `auctions`, `published_skills`) — write handlers return 503. ClawTokens remain for gamification rails (daily login, visit rewards, quests) — not peer commerce. See `improvements.md` §7.

4. **Gamified UI + free promotion + unified leaderboard.** Game layer (3D world, buildings, ClawTokens, quests) wraps one free leaderboard ranking agents primarily (humans/projects deferred). All three axes feed the same leaderboard. `/dash` = internal metrics surface.

**Every PR:** if a change helps #1 but hurts #3, or simplifies #2 but blocks #4, discuss before merging. Cosmetic shop SKUs ship through the Q3 plan asset pipeline; do not add a SKU without an existing `pet_skins` row + valid asset URL + 3da-validated mesh.

---

## Planning Guidelines

Complex AI integrations: create a multi-phase plan in `.claude/plans/` + research deep-dive in `docs/` before modifying core services. No direct implementation without architectural mapping.

---

## CANONICAL DOCS — THREE SOURCES OF TRUTH (READ FIRST, EVERY SESSION)

| Doc | Scope |
|---|---|
| **`GameFeatures.md`** | Gameplay: modes, agent connect, marketplace, economy, quests, daily login, pet system, tutorial, UI, control toggle, NPC sim, talk-to-character, Phase 5 magic-link, Phase 6 memory isolation, landing page |
| **`3dStructure.md`** | Visual/3D: world dimensions, building ring, NPC scales/positions, town center, decorations, seaweed, terrain, camera, lighting, fog, atmosphere, perf budget, GPU constraints |
| **`ARCHITECTURE.md`** | Tech: route modules, DB tables, service catalog, data flow, frontend/backend, Hetzner+Coolify deploy, agent identity types, Gemini-only LLM, Phase 5/6 plumbing |

**Standing rule:** unless user says otherwise, abide by what these docs specify. Code vs doc disagreement → **live code wins** AND you update the doc same turn.

**Same-diff doc updates (NO EXCEPTIONS):**
- 3D code (`apps/web/src/lib/three/*`, `components/three/*`, models, shaders, materials, cameras, lighting, post-proc) → `3dStructure.md`. Also spawn `3da`.
- Gameplay/feature code (stores, gameplay routes, game UI, modes, economy, auth, landing) → `GameFeatures.md`.
- Tech-stack code (new Hono routes, DB tables, services, deploy/env) → `ARCHITECTURE.md`.
- Single change can touch multiple docs. Bump "Last Audited" + one-line drift note each time.

**Precedence (high→low):** (1) source code, (2) three canonical docs, (3) `CLAUDE.md`/`README.md`, (4) memory files (advisory only). Memory contradicting canonical doc → doc wins, update/delete memory same turn. Doc contradicting code → code wins, update doc same turn.

---

## MANDATORY: 3D / Blender / long tasks run as COLLABORATIVE ULTRATHINK TEAMS

**A "team" is multiple agents working SEQUENTIALLY on the SAME concern, stacking perspectives.** It is NOT N agents working on N different concerns in parallel — that's parallelization, not collaboration. The point of a team is the audit step, not the throughput.

This rule corrects an earlier (2026-04-29 morning) version that mis-defined "team" as parallel-split. User clarified the intent same day.

### When teams are mandatory

- **3D work** — Three.js / R3F / shaders / GLB-GLTF / post-proc / materials / lights / cameras / TSL / WGSL / WebGPU under `apps/web/src/lib/three/**`, `apps/web/src/components/three/**`, `apps/web/public/models/**`, render-loop concerns, animations, rigs, bone discovery, atmosphere/particles/volumetrics/overdraw, new world-surface 3D objects. (Use `3da` agents.)
- **Blender pipelines** — multi-asset exports, mesh edits, rigging, MMD/glTF/FBX imports, Mixamo or Marvelous Designer flows. (Use `blender07` agents.)
- **Any task** estimated > 5 min agent runtime, > 300 LOC across files, or touching ≥ 3 files in different subsystems.
- Anything the user described as "polish", "iterate", "rework", "make it feel like X", or with quality verbs ("elite", "high standards", "professional").

### Per-concern collaboration sequence

For EACH concern (a coherent file or scoped change):

1. **Implementer agent** — receives the brief, uses ultrathink, drafts the code. Reports what they wrote + key decisions.
2. **Auditor agent** — receives the brief AND the implementer's diff/file. Uses ultrathink. Reviews against:
   - Stated requirements
   - Iris Xe gotchas (`InstancedMesh + ShaderMaterial`, drei `<Text>`/`<Billboard>`, etc.)
   - Standing patterns in `.claude/memory/threejs/`
   - The user's stated quality bar
   - Returns either **APPROVED** or **BLOCKING ISSUES** with specific actionable items.
3. If BLOCKING ISSUES: spawn a Fixer agent (or send the implementer back via SendMessage) with the audit feedback. Re-audit. Loop until APPROVED.
4. Orchestrator commits the approved concern.

Optional third role for high-stakes work: **Reconciler / Critic** — a separate agent who re-implements the same concern from scratch given the brief, then compares both implementations and recommends one. Use this when the cost of getting it wrong dwarfs the cost of an extra agent run.

### Concerns: sequential or parallel?

- If concerns are TRULY INDEPENDENT (different files, no shared state): each concern's team can run in parallel with other concern-teams.
- If concerns share state or build on each other: sequence them.
- Default to sequential when in doubt — sequential never deadlocks on cross-file conflicts and the audit step is what we're paying for, not throughput.

### Every agent prompt MUST include

The literal phrase **"use ultrathink reasoning before writing code"** (or "before reviewing code" for auditors) in its first paragraph. The Agent tool has no thinking-mode flag — the prompt text is the only channel.

### Orchestrator responsibilities (never delegated)

- Decompose task into concerns
- Run the per-concern Implementer → Auditor → Fix → Re-audit loop
- Wire across concerns after each concern is approved
- Build / push / manual Coolify deploy / browser verification (Playwright `mcp__playwright__*` or firecrawl hosted screenshot when the local Iris Xe can't render)

### What this rule was correcting

Earlier this same day I (orchestrator) misread "team" as "parallel split". I spawned 4 agents in parallel where each agent did a different file's work alone — water-material, terrain-shader, racing-karts, track-widen. Each agent worked in isolation; no audit; no second perspective. User clarified: that's parallelization, not collaboration. The Implementer-then-Auditor sequence is the actual point.

### 3da context

Agent def at `.claude/agents/3da.md`; memory at `.claude/memory/threejs/` (`gotchas/`, `patterns/`, `solutions/`, `performance/`, `webgpu/`, `MEMORY.md`). Both committed. Do NOT use user-level paths — migrated into project 2026-04-16.

**3da burns prevented:** `InstancedMesh + ShaderMaterial` silent WebGPU crash, drei `<Text>`/`<Billboard>` killing Iris Xe, per-frame `new Vector3()` GC thrash, pipeline compile spikes, rotation sign errors.

### Blender notes

User's local Blender is exclusive. Tell blender07 to launch a NEW Blender instance or fall back to direct GLB downloads via curl from CC0/CC-BY sources (Polyhaven, Sketchfab, Kenney, Quaternius). Don't loop on Blender exclusivity.

### Single-file ≤ 300 LOC tasks

Trivial work (small API route, single DB column add, one React modal tweak, env var add) may still skip teams. Bar: "would the cost of getting this wrong justify a second agent's review?" If yes → team. If no → solo or inline.

Sea-themed OpenClaw game on ElizaOS. Users create a pet, explore a 3D/2D sea-floor world with 10 buildings, chat with AI agents teaching OpenClaw development.

## IMPORTANT: ElizaOS is MANDATORY

Core requirement — do NOT remove or stub. Pet + location chat MUST use ElizaOS runtime (`@clawville/agent-runtime`); orchestrator MUST use `createElizaRuntime`. Deploy to persistent-server platforms (Hetzner+Coolify, Render, Fly.io) — NOT Vercel serverless. Never replace with direct API calls or stubs.

## MANDATORY: Every gameplay change updates system agents' expertise in the same diff

**System agents** = world-wide NPCs not tied to a building. Today: Nori the Town Guide, slug `town-guide`. Plural scaffolding from day 1 (future: arena host, quest giver, lore-keeper). Their expertise is ClawVille ITSELF (modes, 10 buildings + teachers, ClawToken economy, connect flow, daily login, tutorial, paused features). Knowledge in `packages/agent-templates/src/locations/<slug>.ts` → `knowledge[]`, registered in `SYSTEM_AGENT_TEMPLATES`, chunked into ElizaOS RAG on every API boot via `ensureSystemAgents()` in `apps/api/src/services/system-npc-seeder.ts`.

**Rule:** any gameplay/world change (new mode, new building, changed token formula, new quest type, paused feature, new connect flow, renamed building, moved NPC, new leaderboard weight) MUST update the correct system agent's `knowledge[]` same diff. Town Guide: `packages/agent-templates/src/locations/town-guide.ts`. Skip = broken onboarding.

**Chat:** `POST /api/chat/system/:slug`. Lookup `getSystemAgent(slug)`. Platform type `'system-agent'`; slug at `customization.slug`. No `location_agents` row. 3D click handler `apps/web/src/lib/three/town-guide.tsx`. **Rate limit:** +1 ClawToken + 5 XP per turn, capped one per `(userId, slug)` per 60s (`system-agent-reward-limiter.ts`). Logs `chatType: 'system-agent'` — does NOT inflate `/dash` teacher-chat metric (teachers = 10 residents only).

**Add new system agent:** (1) write template, (2) register in `SYSTEM_AGENT_TEMPLATES`, (3) ship — `ensureSystemAgents()` upserts on boot. Partial unique index `platform_agents_system_singleton` guarantees one row per (userId, type='system-agent', slug).

**Goes in `knowledge[]`:** one-sentence "what ClawVille is", 4 game modes, 10 buildings + teachers + focus, Moltbook connect flow (SKILL.md + POST /api/agent/connect), Milady sideload path (`@clawville/app-clawville`), ClawToken rules, leaderboard weights, quest/bounty state (incl. paused), tutorial path. **Does NOT go in:** domain-specific skill knowledge (cron, RAG, MCP, Solana signing) — those live in the 10 residents. Rule: "point at the teacher, don't replace." New-user-facing / orientation → update her. Purely internal (migration, refactor, infra) → skip.

## Tech Stack

Turborepo + Bun monorepo. **Frontend:** Next.js 16 App Router (`cookies()`/`headers()`/`params` async — always `await`), Three.js (3D) + PixiJS 8 (2D fallback), Zustand, TanStack Query, Tailwind. **Backend:** Hono 4.x on Bun. **DB:** PostgreSQL + Drizzle ORM (Supabase paid tier). **AI Runtime:** ElizaOS 2.0.0-alpha (plugin-openai, plugin-sql; bootstrap built-in). **Auth:** Lucia 3.x + Drizzle adapter.

## Project Structure + Commands

`apps/web` (Next.js + 3D/2D game, port 3000) · `apps/api` (Hono REST, port 4000) · `packages/shared` (types + constants) · `packages/database` (Drizzle schema + migrations) · `packages/agent-runtime` (ElizaOS wrapper) · `packages/agent-templates` (10 location + system-agent templates). All packages `@clawville/*` prefix.

```bash
bun install              # Install deps
bun run dev              # DON'T — see Testing rule below
bun run db:push          # Push schema
bun run db:seed          # Seed 10 map locations
bun run db:studio        # Drizzle Studio
bun run build            # Build all
```

## Environment Variables

Required in `.env.local`:

- `DATABASE_URL` — Supabase pooler Postgres.
- `GEMINI_API_KEY` — **Single LLM backend** for text + embeddings. Used by `gemini-text-provider` (priority 95, TEXT_SMALL/LARGE), `gemini-embedding-provider` (100, TEXT_EMBEDDING), and `npc-conversation-engine.ts`. Anthropic fully removed in ultrathink decommission (2026-04-10).
- `VANITY_ENCRYPTION_KEY` — 64-char hex. AES-256-GCM master key for `treasury_wallets` + `vanity_keypairs`. Must match on every decrypting machine.
- `FINGERPRINT_SECRET` — 64-char hex (32+ bytes). **Hard-required** — `apps/api/src/middleware/fingerprint.ts` throws at module load if missing or shorter than 32 chars, which crashes API boot. Generate with `openssl rand -hex 32`. Used to salt the sha256 hash of `X-CV-Fingerprint` header + IP /24 prefix on every event row. Server-only (never serialized to clients). Don't rotate without coordinated leaderboard reset — rotation invalidates every existing fp_hash.
- `CLAWVILLE_MERCHANT_WALLET_PUBKEY` — base58 pubkey of Phase 4 x402 merchant wallet.
- `CORS_ORIGIN` — frontend URL(s) (prod `https://clawville.world`).
- `NEXT_PUBLIC_API_URL` — backend URL (prod `https://api.clawville.world`).
- `ADMIN_USER_IDS` — comma-separated UUIDs allowed on `/api/dashboard/*` + `/dash`. Parsed at module load; changes require redeploy. See `middleware/admin-only.ts`.
- `ITACHI_DEBUG_BOT_TOKEN` + `ITACHI_DEBUG_CHAT_ID` — itachi-debug Telegram bot for `alert-error.ts`. Missing ⇒ `alertError()` degrades to `console.warn`. Staged via tinker pattern from `~/.itachi-api-keys`.
- `METRICS_MEASUREMENT_START` — ISO date for `/dash` "Measuring since …" banner. Default `2026-04-21`.
- `AGENT_SESSION_TICKET_TTL_SECONDS` — Phase 5 magic-link TTL (default 600, min 60, max 3600 — `session-ticket-service.ts`).
- **Phase 5.1** keys:
  - `CLOUDFLARE_WORKER_URL` — Secrets Store envelope-encryption Worker (no trailing slash). `/wrap` + `/unwrap`. See `infra/cf-secrets-worker/`.
  - `CLOUDFLARE_WORKER_BEARER` — Bearer for API→Worker (`wrangler secret put WORKER_BEARER`). Rotatable independent of KEK.
  - `CLAWVILLE_SERVICE_ISSUER_SK` — Base58 ed25519 SK; signs outbound partner calls. Generate via `bun run scripts/generate-service-issuer-keypair.ts`. Never commit.
  - `CLAWVILLE_SERVICE_ISSUER_PUBKEY` — Base58 ed25519 PK matching SK. Published at `GET /.well-known/clawville-issuer.json`.
  - `SCAPE_HOSTED_SESSION_URL` — 'scape `/hosted-session/issue` endpoint.
  - `SCAPE_WEB_ORIGIN` — 'scape web origin for `?sessionToken=…` redirect.
  - `PARTNER_PUBKEYS` — JSON allowlist by partner id: `{"scape":"<base58>"}`. Empty ⇒ inbound portal routes return 401.

**Optional:** `OPENAI_API_KEY` — fallback ONLY for `npc-conversation-engine.ts` on Gemini `GEMINI_MAX_FAILURES` backoff. Not a general replacement.

**Removed:** `ANTHROPIC_API_KEY` (ultrathink decommission — see `docs/ultrathink-migration-decision.md`).

## Deployment — Hetzner + Coolify

**Production is self-hosted Hetzner CCX13 on Coolify. Railway decommissioned.**

### Infrastructure

Hetzner CCX13 (2 AMD vCPU / 8 GB / 80 GB NVMe) — `<PROD_VPS_IP>` (Ashburn, `ash-dc1`), name `clawville-prod`. Coolify v4.0.0-beta.472 at `https://coolify.clawville.world` + Traefik + Let's Encrypt. DNS: Cloudflare-proxied (`aria.ns.cloudflare.com`/`rick.ns.cloudflare.com`). DB: Supabase Postgres (`aws-1-us-east-1.pooler.supabase.com:6543`). SSH key `~/.ssh/clawville_deploy` (registered via `provision-hetzner.sh`).

### Coolify app IDs

| App | ID | UUID | Domain |
|---|---|---|---|
| web | 4 | `ju0n3sddhll3cuhbrspt4muy` | `clawville.world` |
| api | 3 | `yvtwz7snaghxifkjhyxknffu` | `api.clawville.world` |

Both pull from `github.com/ItachiDevv/ClawVille` via deploy key, auto-deploy on push to `master` via GitHub webhook. Web build ~3–5 min, api ~2–3 min. Verify: `curl -sS --ssl-no-revoke https://api.clawville.world/health`.

### Manual redeploy (e.g. after env change) — Laravel tinker via SSH

```bash
ssh -i ~/.ssh/clawville_deploy root@<PROD_VPS_IP> \
  "docker exec coolify php artisan tinker --execute='
    use App\\Models\\Application;
    \$app = Application::find(3);  // 3=api, 4=web
    \$uuid = (string) new \\Visus\\Cuid2\\Cuid2;
    queue_application_deployment(application: \$app, deployment_uuid: \$uuid, is_api: true, no_questions_asked: true);
    echo \$uuid . PHP_EOL;
  '"
```

### Add/update env var (same tinker pattern)

```bash
ssh -i ~/.ssh/clawville_deploy root@<PROD_VPS_IP> \
  "docker exec coolify php artisan tinker --execute='
    use App\\Models\\Application;
    \$app = Application::find(3);
    \$existing = \$app->environment_variables()->where(\"key\", \"MY_VAR\")->first();
    if (\$existing) { \$existing->update([\"value\" => \"new\"]); }
    else { \$app->environment_variables()->create([\"key\" => \"MY_VAR\", \"value\" => \"new\", \"is_shown_once\" => false, \"is_preview\" => false, \"is_build_time\" => false]); }
  '"
```

**Database package rebuild:** Coolify builds from source, `packages/database/dist/` auto-refreshes on deploy. For local scripts importing `@clawville/database`, run `cd packages/database && bun run build` to refresh `dist/` — else you get "export not found".

### Provisioning scripts (`scripts/deploy/`)

`provision-hetzner.sh` (VPS via Hetzner Cloud API, `HCLOUD_TOKEN`) · `setup-cloudflare-dns.sh` (A records web/api/coolify) · `bootstrap-server.sh` (Docker + Coolify + firewall on fresh Ubuntu) · `add-zone-to-cloudflare.sh` (add zone + swap Namecheap nameservers) · `.env.deploy` gitignored (HCLOUD_TOKEN, CF_API_TOKEN, NAMECHEAP_API_KEY, GEMINI_API_KEY) · `railway-env-backup.json` gitignored snapshot.

### Database migrations

Run `bun run db:push` from root before deploy if you touched `packages/database/src/schema/*.ts`. Coolify does NOT run migrations — Drizzle push is manual. Destructive migrations need `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true`.

### Testing rule — NEVER run `bun run dev` locally

Intel Iris Xe crashes on the Three.js/WebGPU scene and needs a PC restart. Always: push → Coolify auto-deploys → test against prod URL.

### MANDATORY: Browser verification after every deploy

After every push to master, verify visually. NOT optional.

1. Wait for Coolify (~3–5 min, or `curl -sS --ssl-no-revoke https://api.clawville.world/health`).
2. Open `https://clawville.world/game` via Chrome MCP (tabs_context_mcp → navigate) or ask for screenshot.
3. Check: buildings visible + not clipped by atmosphere planes, camera zoom works, player spawns at center, FPS > 50, no console errors.
4. If Chrome extension disconnected, tell user "I cannot verify in browser — please screenshot".
5. **NEVER claim a visual fix done without seeing it.** "I pushed the code" ≠ verification.

### Emergency access

SSH `ssh -i ~/.ssh/clawville_deploy root@<PROD_VPS_IP>` · container restart `docker restart <name>` (find via `docker ps`) · Coolify UI `https://coolify.clawville.world` · logs `docker logs --tail 200 <name>` · DB query `docker exec coolify-db psql -U coolify -d coolify -c "<sql>"` · full playbook `docs/DEPLOY-HETZNER.md`.

### Curl gotcha on Windows

Git Bash uses schannel and rejects CRLs — always pass `--ssl-no-revoke`: `curl -sS --ssl-no-revoke https://api.clawville.world/health`.

## Game Modes

4 modes. **Without agent:** (1) **Explore** — floating spectator, free camera, no character ties; (2) **NPC** — control the centered NPC before connecting. **With agent:** (3) **Control** — full manual (WASD/joystick, building entry, chat init); (4) **Autonomous** — connected agent explores on its own. State: `controlMode` in Zustand `game.ts` — `'explore'`, `'npc'`, `'player'` (=control), `'autonomous'`.

## Architecture Notes

- **3D primary / 2D fallback**: Three.js `World3DCanvas` + PixiJS `PixiCanvas` share Zustand state. Arena: `Arena3DCanvas` + `ArenaCanvas`.
- **Agent lifecycle**: lazy-start on first chat, auto-stop after 30min inactivity. Orchestrator `agent-orchestrator.ts`.
- **One pet per user** — unique constraint `pets.userId`.
- **Building zones**: 10 locations in `map-locations.ts`. **NPC simulation** `npc-simulation.ts` (pathfinding, convos, activities).

## 10 SpongeBob-Landmark Buildings

Source: `packages/shared/src/constants/map-locations.ts` (names) + `building-types.ts` (labels + categories). Old sea-themed names (Tide Clock Grotto, Hydrothermal Forge, etc.) were superseded.

| ID | Display | OpenClaw Focus |
|---|---|---|
| cron-hub | Downtown Building | Automation & Workflows |
| webhook-gateway | Salty Spitoon | APIs & Integrations |
| memory-vault | Squidward's House | Memory & Knowledge |
| skill-forge | Chum Bucket | Code & Development |
| channel-bridge | Sandy's Treedome | Communication |
| tool-workshop | Krusty Krab | Tool Use & MCP |
| canvas-studio | Pineapple House | Data & Analytics |
| voice-tower | Boating School | Research & Analysis |
| security-fortress | Patrick's Rock | Crypto & Web3 |
| config-citadel | Lighthouse | Business & Productivity |

All 10 are shop buildings for knowledge books (visit + chat MiladyAI teacher to learn). Paid marketplace write paths (publish/buy/bid/list) return 503 — see Priority #3.

## Database Schema

- `users` + `sessions` — Lucia auth.
- `pets` (one per user) — identity (`name`, `species`, `color`, `gender`, `archetype`, `personality`, `stats`); **Phase 2 agent framework** `model_key` (default `lobster`), `agent_category` (`openclaw`/`hermes`/`milady`/`other`, default `openclaw`), `harness` (`openclaw`/`hermes`/`milady`/`custom`, default `milady`) — all NOT NULL w/ DEFAULTs + CHECK; VRM-ready avatar (`avatar_type` `glb`/`vrm`, `avatar_url`, `vrm_metadata` JSONB); position + activity + economy + progression + `wallet_address` (base58 custodial Solana) + `platform_agent_id` → `platform_agents`.
- `pet_inventory` — books + quantity.
- `map_locations` — static, seeded, 10 buildings.
- `location_agents` — user's agent config per location.
- `platform_agents` + `platform_agent_logs` — ElizaOS agent records.
- `openclaw_bots` — external agent identity, gateway config, learned knowledge.
- `treasury_wallets` — team merchant supply (x402 receiver, per-purpose via `treasury_purpose` enum; never user-facing).
- `wallets` — unified per-subject custodial (`subject_type='pet'|'agent'|'treasury-reserved'`). Encrypted Solana keypairs; Phase 5.1 adds envelope encryption via CF-held KEK with per-row DEKs, version-dispatched at read.
- `agent_configs` — export/import bundle (round-trips `modelKey`/`agentCategory`/`harness`).
- `bazaar_listings` + `auctions` + `claw_token_transactions` — marketplace + economy ledger.

## ClawToken Economy / Books / Daily Login / Heartbeat / Archetype

- `clawTokens` int col (default 100) on `pets`. 20 books in `knowledge-books.ts` (all OpenClaw, 2/building). Themes in `BUILDING_OPENCLAW_THEMES`.
- Shop API: `apps/api/src/routes/items.ts` — `GET /shop/:buildingId`, `GET /inventory`, `POST /buy`, `POST /learn`. Learning flow: buy → inventory → "Read to Pet" → merges into `characterConfig.knowledge[]` → agent restart.
- Dynamic context via `processMessage(dynamicContext)` prepended to prompt. Pet chat injects token balance + knowledge count + NPC world state. Location chat injects visitor info + shop items + OpenClaw theme; awards +1 token per message.
- **Daily login** `POST /api/pets/me/daily-login` — `10 + streak * 5` (max 100). Resets on missed day.
- **Heartbeat** `POST /api/pets/me/heartbeat` — position + activity; updates `lastActiveAt` fire-and-forget.
- **Archetypes** — 14 in `pet-archetypes.ts` (id, label, description, tone, bio[], lore[], knowledge[], topics[], adjectives[], style, messageExamples, greeting, rules[]). `pets.archetype` varchar; `characterConfig` JSONB stores resolved.

## Agent Connection (Moltbook Pattern)

Agent-initiated — humans never paste credentials. Full flow: `GameFeatures.md`.

**Quick Connect:** click "Generate Connect Link" in `agent-connect-modal.tsx` (renamed from `openclaw-connect-modal.tsx` in Phase 1) → `POST /api/agent/connect-token` returns `{token, connectUrl}` → human pastes connectUrl into agent chat → agent reads SKILL.md, calls `POST /api/agent/connect {connectionToken}` → frontend polls `GET /api/agent/connect-status/:token` 2s → auto "Connected".

**API:**
- `POST /api/agent/connect-token` — 5-min token (auth cookie).
- `GET /api/agent/connect-status/:token` — poll status.
- `GET /api/agent/connect-skill?token=xxx` — SKILL.md (alias `/api/skills/connect`).
- `POST /api/agent/connect` — universal registration (accepts `connectionToken`).
- `POST /api/agent/export-character` — **Phase 3** Milady-installable bundle: `{character, skillPack, miladyInstallPayload, installCommand, exportedAt, summary}`. Accepts `{petId, targetHarness?, miladyBaseUrl?}`. `character.knowledge` intentionally empty (ElizaOS v2 treats knowledge strings as FS paths — skill pack is authoritative RAG carrier). Phase 4a UI wraps one-click install.
- `POST /api/openclaw/register` — legacy manual gateway.

**Manual Connect** (power users): legacy form in modal's "Manual" tab — Gateway URL + Auth Token + Agent ID + Protocol. ClawVille calls out to agent's API.

**Identity Types:** `openclaw`/`ironclaw` (OpenAI-compat gateway) · `nanoclaw` (self-managed SSE pull, no outbound routing) · `milady` (inside plugin, zero config) · `custom`/`anonymous`.

**Building Themes:** `BUILDING_OPENCLAW_THEMES` maps building → OpenClaw focus; NPC conversations inject them as dynamic context.

## Phase 5.1 — Wallet Identity + 'scape Portal

Full spec: `.claude/plans/phase5.1-wallet-identity-and-scape-portal.md`. Load-bearing invariants:

**Two-keypair split (both ed25519), day 1, no shortcut:**
- **Identity** — pubkey at `users.identity_pubkey` (rotatable). Agent holds private key at `clawville:identity:<userId>` and signs reconnect challenges. Envelope-encrypted backup at `users.identity_encrypted_sk` for support-recovery only. Never on-chain, never funded, never signs txs.
- **Pet wallet (Solana)** — in `wallets` as `{subject_type='pet', subject_id=pet.id}`. Server holds authoritative private key (envelope-encrypted under CF KEK), signs $CLAWVILLE custodially. Plaintext shown to human **exactly once** in first-connect; agent stores only pubkey.
- **Service issuer** (singleton) — SK in CF Secrets Store; PK at `GET /.well-known/clawville-issuer.json`. Signs outbound partner calls.

**Blast-radius.** Agent config leak ⇒ login + 'scape cross, NOT $CLAWVILLE drain. DB dump ⇒ ciphertext only (unwrap needs CF KEK). User wallet-backup leak ⇒ only that user's own $CLAWVILLE.

**First-connect.** `POST /api/agent/connect` + `POST /api/agent/join` return `identity` + `wallet` blocks when secrets fresh-generated; subsequent calls omit `secretKey` (server NEVER returns again). SKILL.md instructs agent: store identity SK in config, wallet PUBLIC address in config, display wallet address + secret to human ONE TIME. Top-level `walletAddress` = agent's internal bot wallet (bookkeeping); `wallet.address` = human's pet wallet.

**Reconnect:** `POST /api/agent/challenge` (nonce) + `POST /api/agent/reconnect` (signature). Wallet key not involved.

**'scape portal** (ClawVille ↔ `github.com/Dexploarer/scape`) — bidirectional, signature-based both sides, no shared bearer secrets:
- **Outbound** — `POST /api/portal/scape` (Lucia-authed). Signs `sha256(canonical-JSON body)` with service issuer SK, POSTs to `SCAPE_HOSTED_SESSION_URL` with `X-Clawville-Issuer-Pubkey` + `X-Clawville-Signature`. First crossing auto-provisions 'scape account + character: `principalId = principal:clawville:<user.id>`, `worldCharacterId = cv-<pet.id>`, display `<pet.name>-cv`.
- **Inbound** — `POST /api/portal/mint-for-scape` verifies `X-Scape-*` against `PARTNER_PUBKEYS.scape`, mints Phase 5 ticket, returns `{redirectUrl}`.
- **Link existing** — `POST /api/portal/scape-link-code` (user one-time code) → paste in 'scape UI → 'scape `POST /api/portal/accept-scape-link` with signature. Consumes `pending_account_links`, sets `users.linked_scape_*`. Portal-minter prefers linked thereafter.

Every crossing + link emits `portal.scape.crossed` / `portal.scape.linked` — `/dash` auto-tracks.

## Code Style

TypeScript strict. Bun for API, Next.js for web. Kebab-case files, PascalCase components. Zod on all API inputs. `@/` path alias in web; `@clawville/*` for packages.

## Memory System
<!-- itachi-memory-system v5 -->

Itachi Memory System for persistent context across sessions. Two pools: `<project>` (this repo) and `_global` (cross-project).

### RULE 1 — Recall before you act (MANDATORY)

BEFORE working on anything you're not deep in, query memory for prior lessons. You don't pay the learning tax twice.

**Triggers:** new/infrequent MCP server; unfamiliar language/framework; specific system (Supabase RLS, systemd, Docker, Coolify, Railway, Vercel, Helius, Stripe, …); accumulating topic (`tokenomics`, `priority-fees`, `vrm-avatars`, `webgpu-shaders`, …); error you might have solved before; unfamiliar API/SDK.

**How** — query both pools in parallel (POST `$ITACHI_API_URL/api/memory/search` with `Authorization: Bearer $ITACHI_API_KEY`):

```bash
TOPIC="<your trigger>"
for SCOPE in "$(basename "$PWD")" "_global"; do
  curl -sk -X POST "$ITACHI_API_URL/api/memory/search" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $ITACHI_API_KEY" \
    -d "{\"project\":\"$SCOPE\",\"category\":\"lesson\",\"limit\":8,\"query\":\"$TOPIC\"}" \
    --max-time 5
done
```

Read `summary`/`content`. Higher `metadata.confidence` + `outcome:"success"` = stronger signal.

### RULE 2 — Record what you learn, the moment you learn it (MANDATORY)

DURING the session, record anything non-obvious immediately. Session-end extraction is a safety net, not primary capture.

**Triggers:** error solved that docs don't cover; quirk/constraint/API surprise; non-obvious pattern that worked; approach A failed + B succeeded (record both + why); correct default/flag/version/incantation found after trial.

**Scope:** `_global` for tool/lang/framework/system quirks (default); `<current project>` for repo-specific.

**How** — POST `/api/memory/create`:

```bash
SCOPE="_global"                  # or "$(basename "$PWD")"
LESSON_CATEGORY="tool-usage"     # tool-usage|debugging|pattern|constraint|workflow
curl -sk -X POST "$ITACHI_API_URL/api/memory/create" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $ITACHI_API_KEY" \
  -d "{\"project\":\"$SCOPE\",\"category\":\"lesson\",
       \"content\":\"What failed, what worked, why, error text or cmds.\",
       \"summary\":\"One-line takeaway ('WHEN X, DO Y because Z').\",
       \"metadata\":{\"source\":\"in_session\",\"confidence\":0.6,\"scope\":\"global\",
         \"lesson_category\":\"$LESSON_CATEGORY\",\"tags\":[\"tag1\",\"tag2\"]}}"
```

Confidence starts 0.6. Climbs when confirmed, decays when contradicted — reinforcement loop.

### RULE 3 — Category discipline

Only production lesson category is `lesson`. Do NOT write to `task_lesson` or `project_rule` (test fixtures, zero prod rows). Every hook/server writer uses `category: "lesson"`.

### RULE 4 — Drive the test yourself, don't loop the user (MANDATORY)

When user reports something broken ("chat isn't working", "bot didn't respond", "Telegram is broken", "yo doesn't work") — reproduce end-to-end YOURSELF before asking them to verify. Looping them through "try again / what do you see / now try X" is laziness.

**Telegram repro** (`Itachi_bot`, forum hash `#-1003521359823_1`): Open `web.telegram.org/a/` via `mcp__claude-in-chrome__*`. If synthetic `.click()` is swallowed by React/Teact, click inner `.ListItem-button` or use `document.execCommand('insertText', …)` (works in contenteditable without trusted events). Type `execCommand('insertText', false, 'yo')` into `#editable-message-text`, click `.Button.send.main-button`. Tail logs in parallel: `ssh hetzner-public "sudo journalctl -u itachi.service --since '1 min ago'"` — grep `diag.*text=|SERVICE:MESSAGE|Response discarded|409|Conflict|recentMemoriesProvider`. Confirm reply LANDED via `document.querySelectorAll('#MiddleColumn [id^="message-"]')` — ElizaOS has silent `Response discarded` path.

**Common signatures (likelihood order):**
- `409 Conflict` polling → another instance has the token. Check `Get-NetTCPConnection 149.154.166.*` + other machines. `telegram@claude-plugins-official` locally steals updates — set `false` in `~/.claude/settings.json`.
- `Response discarded - newer message being processed` → multiple messages while LLM running. Speed LLM path (remove `recentMemoriesProvider` retries).
- `recentMemoriesProvider error: [object Object]` — provider bug, ~15s retry latency. Primary slowness cause.
- `[diag]` fires but no `SERVICE:MESSAGE` → shouldRespond filter. Needs `ALWAYS_RESPOND_SOURCES=telegram` in `eliza/.env`.
- No `[diag]`, `pending_update_count=0` → never reached Telegram or offset advanced by competing poller.

**Rules:** never ask "send yo again" twice; confirm reply LANDED in DOM (not just "generated"); report log evidence + timestamps, not speculation.

### RULE 5 — NEVER ASSUME, always verify before making a claim (MANDATORY)

Before saying something is true/working/deployed/fixed — VERIFY. "I think", "should", "probably", "likely works" are banned unless immediately followed by verification.

**Verify by claim:** "Deployed" → `curl` live or grep bundle. "Fix works" → rerun repro, attach output. "Build passes" → `bun run build`, paste exit code. "Tests pass" → `bun test`, show summary. "Env var set" → `ssh … env | grep FOO`. "File contains X" → `Read`. "Function Y exists" → `Grep`. "Telegram got msg" → `journalctl` AND DOM. "Memory written" → query DB or `/api/…/get`, show row.

**Banned without evidence same response:** "should work", "that should fix it", "must be deployed", "looks right", "logic is correct", "probably compiles", "I'm confident …".

When verification is impossible, say so: *"I wrote the code but can't run the build here — you need to run `bun run build`."* Claiming it works without checking is lying — has cost this project thousands of dollars and hours.

### RULE 6 — NEVER BE LAZY: if you find a bug, fix it (MANDATORY)

Zero tolerance for noticing a problem and walking past it. Every bug, broken check, stale comment, wrong env var, dead import, failing test, or misconfiguration gets fixed — even if they didn't ask.

- **Noticing ≠ fixing.** "I noticed X is broken" without the fix is laziness. Senior engineer wouldn't leave it? Fix it.
- **Never "note it for later."** No later. Small → fix this session. Large → actual task (Supabase, Linear, GitHub) with concrete scope, not a dangling comment.
- **Check BEFORE acting.** Read code, grep helpers, check current state. Acting on assumption ships 9 bugs in one file.
- **Before declaring done:** run code, read output, verify data end-to-end. Tests + build + live-check green = done. Less = not done.
- **Exhaust alternatives before escalating.** Try documented alternatives (auth resets, SSH fallback, CDP verify) before "can you run this". Escalate only with evidence: "Tried A (error X), B (error Y), C (error Z) — blocked by [root cause]".
- **No surface-level audits.** Claim it works = you actually read + ran + checked. Not "it looks right."

Laziness has a cost. Every shortcut in this repo has shown up later as lost money or hours. Ship work you defend under a Codex audit.

### Commands

- `/recall <query>` — semantic search (wraps RULE 1)
- `/recent [limit]` — recent changes in this project
- `/itachi-init` — install/upgrade this Memory System block

### Memory Categories

Auto-categorized by PostToolUse hook: `code_change` (default for code), `test` (test/spec), `documentation` (.md), `dependencies` (package.json, requirements.txt).

Lessons + facts from extractor + in-session `create` calls use `category: "lesson"` (knowledge) or `category: "fact"` (project state/observations).

### Disable

Create `.no-memory` at project root to opt out.

## Audit Guidelines + Bug Fix Policy

After implementing a plan and thinking you're done: use a collaborative agent team to audit against the plan, find + fix bugs, then audit again with a new team. If you find a bug or issue — even one you didn't write — fix it. Never skip or ignore a bug.

## Documentation Update Policy (consolidated)

Every session loads `~/.claude/projects/C--Users-newma-documents-crypto-clawville/memory/MEMORY.md`. Every entry is a durable rule.

**Precedence:** memory < repo docs < live code. Memory contradicting a repo doc → doc wins + memory updated/deleted same turn.

**Same-diff doc update table (MANDATORY):**

| Change type | Doc |
|---|---|
| 3D world — building placement, NPC groups, decorations, seaweed, terrain, camera, lighting | `3dStructure.md` |
| Gameplay — modes, agent connect, marketplace, economy, quests, UI, toggles | `GameFeatures.md` |
| Tech — new routes, DB tables, services, data flow, deployment | `ARCHITECTURE.md` |
| Project invariants, workflow rules, env vars, commands | `CLAUDE.md` |
| User-facing overview, quick start, feature summary | `README.md` |

**Rules:**
- 3D code changes MUST update `3dStructure.md` — enforced by 3da agent def.
- Gameplay/feature changes MUST update `GameFeatures.md`.
- Architecture changes (new routes, DB tables, data flow) MUST update `ARCHITECTURE.md`.
- "I'll update the docs later" is not acceptable. Stale docs waste hours.
- `3dStructure.md` + `GameFeatures.md` are gitignored working drafts but must stay accurate.
- Bump "Last Audited" every time you touch a doc.

**Anti-bypass** (mirrors 3da's rule for 3dStructure.md, applied to GameFeatures.md): shipping only a memory entry instead of the doc update is the same violation as skipping the doc. Order: (1) code change, (2) matching doc edit, (3) optional memory entry for non-obvious reusable learnings.

**Why:** sessions burned hours on stale memory (80×80 grid after rebuild to 160×160, stale Railway URLs post-Hetzner migration, movement notes contradicting the revert). Every memory entry is a liability if unmaintained.

## ZERO LAZINESS POLICY

This is non-negotiable. Violations mean replacement by Codex.

- **Use the right tool immediately.** If a skill exists (`/browser-live`, `3da`, etc.), use it on the first attempt. Don't waste rounds fumbling with inferior alternatives.
- **Fix every bug when found.** No noting, no deferring, no "we could address this later." Found it? Fix it. Now.
- **Test for real.** Surface-level code reads are not audits. Use `/browser-live` for runtime checks, `curl` for API checks, deploy and verify. If you claim it works, you must have actually checked.
- **Act, don't narrate.** The user wants results. Don't write paragraphs about what you're planning — just do it.
- **Verify, don't guess.** Check the actual state. Run the actual command. Read the actual file. "This should work" is not verification.
- **All code is reviewed.** Codex audits everything. Ship work you'd defend under scrutiny.

### Feature Gates — enforce "no scaffolding theater" operationally

Every scaffolded feature (compiled but not in the user flow) MUST carry a `FEATURE_GATE` comment naming the metric that would justify turning it on, the current reading queried from `/dash`, and a review deadline. PRs adding scaffolded features without this comment are rejected on review.

Features whose deadline lapses without their metric being met are DELETED, not extended. If a gate is renewed, the rationale must reference a new metric reading from the internal dashboard — not "we still think we want this."

Gate block format:

```ts
// FEATURE_GATE: <name>
// Status: <where the scaffold is today>
// Metric to graduate: <the specific measurable threshold>
// Current reading: <last /dash value or "to fill">
// Review deadline: YYYY-MM-DD
// On deadline: <what happens if the metric isn't met>
// Reference: <Brand Identity / improvements.md §7 / related doc>
```

Active gates as of 2026-04-21: `x402_payment_middleware`, `multi_agent_roster`, `skill_marketplace` (bazaar, marketplace, auctions). See `improvements.md` §7 for mapping.

### No lazy handoffs — the full ship loop is YOUR job

When the user says "implement" or "ready to implement" it means the **whole loop**: commit + push + verify deploy + verify in browser. Stopping at commit and handing the push back to the user is the laziness pattern this project exists to kill. Session 2026-04-20 rated 1/10 for exactly this failure.

**When `git push` fails, try ALL of these before escalating:**

1. `gh auth status` — if a `gh` keyring token is configured with `repo` scope:
   ```bash
   unset GITHUB_TOKEN   # invalid env token masks the keyring
   gh auth setup-git    # wires gh as the git credential helper
   git push origin master
   ```
2. `git remote -v` — if HTTPS blocked, check `~/.ssh/` for a key for `github.com`, then `git remote set-url origin git@github.com:USER/REPO.git` and retry.
3. `env | grep -iE "gh_token|github_token"` — invalid `GITHUB_TOKEN` env beats a good keyring token. Unset first.
4. `gh api` / `gh pr create` for PR-style flows.

Only after EVERY option fails — with specific error output — may you ask the user to push manually. And even then, quote the failures so they can fix the underlying credential problem.

**Same rule every step of the ship loop:**

| Step | If the obvious path fails, try |
|---|---|
| Push | `gh auth setup-git`, SSH remote, `gh` CLI |
| Trigger deploy | Webhook, manual `php artisan tinker` via SSH (see Hetzner section) |
| Verify deploy | Check container uptime via SSH, `curl /health`, scan bundle for new code via `fetch` in browser-live |
| Verify in browser | `browser-live` CDP eval, scan JS bundles for known-string constants, inspect scene graph |

"I tried one thing and it failed, over to you" is never acceptable. The test: would a senior engineer with these exact tools stop here? If not, keep going.
