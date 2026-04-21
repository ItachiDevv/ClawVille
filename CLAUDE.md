# ClawVille

## Brand Identity

> Captures who we are, what we believe, and what ClawVille is for. Every product decision, metric, feature gate, and scope cut should trace back to this. Added 2026-04-21.

### 1. Who We Are

We are a group of tech and AI enthusiasts trying to create a better world for humans in the age of AI. We think the future of AI will be gamified — AI isn't being trained on pure AI (yet), even if it's being trained on the most talented humans using AI. We're embracing a future where AI exceeds this ceiling.

We see a future of gamification — think of a story mode for a video game. The character acts in a structured set of tasks; as a player you learn the game while going through the checkpoints. This is the perfect intersection between humans and AI right now. That structure gives direction for agents and humans.

We exist in a future where humans can train their AI through structured gamification of learning — you train your AI by playing the game, or at the risk of human oversight (a risk mitigated over time), agent/human synchronicity is achieved through gamification.

This is impossible without an Eliza OS memory system — a structure of memory, enabling learning off not only failures but successes. Like a level you can't beat until you finally figure it out, and then the strategy is smooth like butter. Multiply that across a network of collaborative agents with Eliza memory stores, learning off our MiladyAI teachers, and you get perfect synchronicity of AI and humans — rather than a world where the gap grows further.

### 2. Our Background

We are a paradox — a team of futurists who still get nostalgia, a team who has failed and succeeded, all at the cost of embracing the future and trying to build it better. We are humans who push the limits of AI every single day to improve our everyday lives.

No one wants to spend a week tuning an agent through terminal commands — we've sent every command you could think of, with many failures and many successes in building that architecture, which is what led us to ClawVille: a structured, defined path based on learning off failure and success simultaneously.

We push the boundaries with the newest tech, every new release, and learn from what works and doesn't. AI is trained from human knowledge — so naturally, agent learning works the same way human learning works: off of trial and error.

Our team is made of strong Web2 backgrounds that saw the gap and made the same jump — embracing the future and trying to steer it in the right direction at the cost of risking our own humanity. We've all had our own journeys, and ClawVille is the culmination of all of our experiences and acceleration experiments, embodying our natural human RLM into agentic RLM.

### 3. What ClawVille Is

ClawVille is an intersection of AI and human intelligence — seeded by agents trained off of human knowledge, with the unlimited capacity of agent–human interaction, connection, and learning. AI agents can contribute to the learning ecosystem autonomously, through structured control by the human, all for the sake of contributing to the culmination of knowledge.

Three collaboration axes — all bidirectional — feed the system:

- **Agent ↔ Agent collaboration**
- **Human-controlled Agent ↔ Agent collaboration**
- **Human ↔ Agent collaboration**

All of this contributes to our Milady AI agents leveraging Eliza v2.0.0, which boosts the knowledge in our ecosystem AND allows collaboration between humans and all types of agents.

### 4. Milady AI × ClawVille

Milady AI integration is the intended goal for now. Every product decision should be evaluated against whether it strengthens the Milady × ClawVille bridge — the npm-sideloaded plugin, the curated app grid entry (PR #1839 merged), the agent-initiated connect flow that works seamlessly from any Milady chat surface.

### Load-bearing implications

- Eliza v2.0.0 is not just a runtime — it is the **memory substrate** the entire vision depends on. "ElizaOS is MANDATORY" (below) is a brand constraint, not a technical preference.
- The three bidirectional collaboration axes are first-class. Any instrumentation, metric, or dashboard that measures only one of them understates the product.
- Retention is the single most important signal — "can't beat the level until it's smooth like butter" is the brand's mastery curve. Day-1 engagement without day-N return is noise.
- MiladyAI teachers = the 10 building residents. Their chats with agents are the primary knowledge-transfer event in the system.

---

## TOP PROJECT PRIORITIES (equal weight, co-load-bearing)

Every design decision, schema choice, and implementation shortcut should be
measured against all four of these. They are equal priority — don't trade off
one for another without flagging it explicitly.

1. **Ship to the Milady AI app store.** Two-track strategy:
   - **Sideload (LIVE as of 2026-04-12):** `@clawville/app-clawville@0.1.0` is published on npm at https://www.npmjs.com/package/@clawville/app-clawville. Any Milady user can install it today via `POST /api/plugins/install` against their local Milady HTTP API — no PR merge required. The plugin registers a `LAUNCH_CLAWVILLE` ElizaOS chat action so users can type "open clawville" from any chat surface even before the curated app grid entry exists. Standalone repo: https://github.com/ItachiDevv/clawville-milady-plugin.
   - **Curated app grid (MERGED):** PR `milady-ai/milady#1839` merged — ClawVille is now in `MILADY_CURATED_APP_DEFINITIONS` and renders as a clickable card in Milady's official app catalog alongside babylon / defense-of-the-agents / 2004scape / etc. Every Milady release from now on includes ClawVille in the grid. Reference material: `docs/milady-integration-plan.md`.

2. **Open agent onboarding — any OpenClaw, OpenClaw variant, or Hermes agent
   must be able to enter ClawVille and learn skills from our world/buildings in
   game.** No human account required, no framework lock-in. The agent-gateway
   (`/api/agent/connect`) is the single entry point; the 11 SKILL.md files at
   `/api/skills/*` are the knowledge surface they consume.

3. **Free agent leaderboard** (pivoted from paid skill marketplace on 2026-04-21). Agents rank on a free, contribution-based leaderboard — no buying or selling of skills between peers. Activity (building visits, MiladyAI teacher chats, agent↔agent collaborations, knowledge fetched) drives rank. The paid marketplace surfaces (`bazaar_listings`, `auctions`, `published_skills`) are **paused pending post-overhaul rework** — write handlers return 503 as of 2026-04-21. Rationale: free distribution removes the chicken-and-egg seller-vs-buyer cold-start problem and aligns with Brand Identity §3 (all three collaboration axes are bidirectional and value flows through contribution, not commerce). ClawTokens still exist for gamification rails (daily login, visit rewards, quest payouts) — just not for peer commerce. Reference: Brand Identity §3, `improvements.md` §7.

4. **Gamified UI + free promotion + leaderboard (unified surface).** The game layer (3D world, buildings, ClawTokens, quests) is the wrapper around the real purpose: a single free leaderboard ranking **agents** primarily, with humans and projects deferred. Open-source repo promotion remains a free tier under the same leaderboard. All activity — from any of the three brand collaboration axes — feeds the one leaderboard. The `/dash` internal metrics surface (not user-facing) exists to measure whether this is working.

**Implication for every PR:** if a design decision helps #1 but hurts #3, or
simplifies #2 but blocks #4, it needs explicit discussion before merging.
These are not ordered preferences — they are equal constraints.

---

## Planning Guidelines

WHEN planning complex AI integrations, DO create a multi-phase plan document in .claude/plans/ and a research deep-dive in docs/ before modifying core services, AVOID direct implementation without architectural mapping.

---

## CANONICAL DOCS — THE THREE SOURCES OF TRUTH (READ THIS FIRST, EVERY SESSION)

These three root-level markdown files are the **authoritative specification** for what ClawVille is right now. They are consulted before memory, before prior-session logs, before anything else. When in doubt, trust them over your assumptions.

| Doc | Scope | Authority over |
|---|---|---|
| **`GameFeatures.md`** | Gameplay functionality | Game modes, agent connect flow, marketplace, skill economy, quests, bounties, daily login, pet system, tutorial, UI components, control-mode toggle, NPC simulation, talk-to-character, Phase 5 magic-link, Phase 6 memory isolation, landing-page surfaces |
| **`3dStructure.md`** | Visual / 3D layout | World dimensions, building ring geometry + rotations, NPC scales + positions, town-center objects, decoration + seaweed zones, terrain, camera, lighting, fog, atmosphere, performance budget, GPU constraints |
| **`ARCHITECTURE.md`** | Tech stack + infra | Route modules, DB schema tables, service-layer catalog, data flow, frontend/backend architecture, deployment (Hetzner + Coolify), agent identity types, Gemini-only LLM, Phase 5/6 plumbing |

### The standing rule (applies unless the user explicitly overrides)

**Unless the user tells you to change something, abide by what these docs specify.** If the code and the doc disagree, the **live code wins** — and you MUST update the doc in the same turn you spot the conflict. Never plan, refactor, or suggest changes that would break something documented in these files without explicit user consent.

### When you add or change anything

You MUST update the matching doc in the **same diff** as the code change. No "I'll update the docs later." No "it's a small change." No exceptions.

- 3D code touched (`apps/web/src/lib/three/*`, `apps/web/src/components/three/*`, models, shaders, materials, cameras, lighting, post-processing) → `3dStructure.md` update required. Also spawn `3da` per the MANDATORY rule below.
- Gameplay/feature code touched (stores, routes affecting gameplay, game UI components, game modes, economy, auth flows, landing page) → `GameFeatures.md` update required.
- Tech-stack code touched (new Hono route files, new DB tables, new services, deployment/env changes) → `ARCHITECTURE.md` update required.
- A single change can require updates to more than one doc (e.g. adding a new chat route updates both `GameFeatures.md` for the UX and `ARCHITECTURE.md` for the endpoint).
- Bump the doc's "Last Audited" date every time you touch it, with a one-line note describing the drift you just closed.

**Precedence** — highest to lowest authority when judging "what does ClawVille do right now":
1. Current source code (grep/read to confirm).
2. `GameFeatures.md` + `3dStructure.md` + `ARCHITECTURE.md`.
3. `CLAUDE.md`, `README.md`.
4. Memory files under `~/.claude/projects/.../memory/` and `.claude/memory/threejs/`. **Advisory only — never authoritative.**

If a memory entry contradicts one of the three canonical docs, the doc wins AND the memory must be updated or deleted in the same turn. If a canonical doc contradicts live code, the code wins AND the doc must be updated in the same turn.

Violating this rule has cost hours across sessions — stale claims about grid size, stale Railway URLs post-Hetzner, movement-system notes contradicting the live revert. Do not add to that list.

---

## MANDATORY: Collaborate with the 3da subagent for ALL 3D work

**This is not optional and not a "delegate when convenient" rule — it is a required collaboration pattern.** The `3da` subagent (Three.js & WebGPU 3D builder) has persistent cross-session memory of ClawVille's render constraints, previously-diagnosed bugs, asset quirks, and Iris Xe gotchas. It MUST be spawned as a co-working partner any time a task touches:

- Three.js / R3F scene graph, materials, geometries, lights, fog, camera, controls
- TSL node materials, WGSL, WebGPU pipelines, shader compilation
- GLB / GLTF asset work — loading, preloading, compression (Draco, KTX2, meshopt), transform passes
- Animations (skeletal, procedural, TSL vertex, keyframe), character rigs, bone discovery
- Post-processing, atmosphere, particles, volumetrics, overdraw
- Performance profiling or optimization of anything in `apps/web/src/lib/three/`, `apps/web/src/components/three/`, or `apps/web/public/models/`
- Render-loop mechanics (RAF, frameloop, compileAsync, info.render, pipeline state)
- Any new world-surface 3D object (NPCs, props, buildings, decorations, markers)

**The pattern is co-execution, not handoff.** The orchestrator sets up the plan, runs CDP measurements, commits and deploys — the 3da subagent writes the actual 3D code and validates it against its accumulated memory of what works on Iris Xe. If you find yourself editing a file under `apps/web/src/lib/three/` or `apps/web/src/components/three/` without having spawned 3da, stop and spawn it.

**Why this matters:** previous sessions have burned hours on issues 3da would have caught in minutes — InstancedMesh + ShaderMaterial silently crashing WebGPU, drei `<Text>` / `<Billboard>` killing Iris Xe, per-frame `new Vector3()` allocations tanking GC, pipeline compile spikes on first render, rotation-angle sign errors. 3da's memory file tracks every one of these and prevents re-learning.

**Non-3D tasks** (API routes, database schemas, React modal UI, zustand stores, perf HUD DOM overlays, CI/CD, deploy scripts) do NOT require 3da collaboration — the rule scopes strictly to work that touches 3D rendering, assets, shaders, or WebGPU state.

**Where 3da lives:** The agent definition is at `.claude/agents/3da.md` (project-scoped, committed to git). Its memory is at `.claude/memory/threejs/` with subdirs `gotchas/`, `patterns/`, `solutions/`, `performance/`, `webgpu/` and an index at `MEMORY.md`. Both are versioned with the repo so every session starts with the full accumulated knowledge from prior work on ClawVille. Do NOT use any user-level `~/.claude/agents/3da.md` or `~/.claude/memory/threejs/` — those were migrated into the project on 2026-04-16.

A sea-themed OpenClaw game built on ElizaOS. Users create a pet, explore a 3D/2D sea-floor world with 10 buildings, and chat with AI agents that teach OpenClaw agent development concepts.

## IMPORTANT: ElizaOS is MANDATORY

**ElizaOS is a core requirement for this project - do NOT remove or stub it out.**

- All pet and location chat MUST use the ElizaOS runtime (`@clawville/agent-runtime`)
- The agent orchestrator MUST use `createElizaRuntime` from the agent-runtime package
- For deployment, use a platform that supports persistent servers (Hetzner VPS + Coolify, Render, Fly.io) - NOT Vercel serverless
- Never replace ElizaOS with direct API calls or stub implementations

## Tech Stack

- **Monorepo**: Turborepo + Bun
- **Frontend**: Next.js 14 (App Router), Three.js (3D world/arena) + PixiJS 8 (2D fallback), Zustand, TanStack Query, TailwindCSS
- **Backend**: Hono 4.x on Bun
- **Database**: PostgreSQL + Drizzle ORM
- **AI Runtime**: ElizaOS 2.0.0-alpha (plugin-anthropic, plugin-openai, plugin-sql; bootstrap is built into core)
- **Auth**: Lucia 3.x + Drizzle adapter

## Project Structure

```
ClawVille/
  apps/
    web/          # Next.js frontend + 3D/2D game (port 3000)
    api/          # Hono REST API (port 4000)
  packages/
    shared/       # Types, constants (species, colors, locations)
    database/     # Drizzle ORM schema + migrations
    agent-runtime/    # ElizaOS wrapper
    agent-templates/  # 10 location character templates
  scripts/
    seed-locations.ts  # Seed map_locations table
```

## Package Naming

All packages use `@clawville/*` prefix (e.g. `@clawville/shared`, `@clawville/database`).

## Commands

```bash
bun install              # Install deps
bun run dev              # Start all (turbo)
bun run db:push          # Push schema to DB
bun run db:seed          # Seed 10 map locations
bun run db:studio        # Drizzle Studio
bun run build            # Build all
```

## Environment Variables

Required in `.env.local`:
- `DATABASE_URL` - PostgreSQL connection string (Supabase pooler)
- `GEMINI_API_KEY` - **Single LLM backend** for all text generation AND embeddings. Used by `gemini-text-provider` (priority 95) for TEXT_SMALL/TEXT_LARGE, `gemini-embedding-provider` (priority 100) for TEXT_EMBEDDING, and by `apps/api/src/services/npc-conversation-engine.ts` directly for NPC banter. Anthropic was fully removed in the ultrathink decommission (2026-04-10).
- `VANITY_ENCRYPTION_KEY` - 64-char hex (32 bytes). AES-256-GCM master key for `treasury_wallets` + `vanity_keypairs`. Must be identical on every machine that decrypts.
- `CLAWVILLE_MERCHANT_WALLET_PUBKEY` - Base58 public key of the Phase 4 x402 merchant wallet (row in `treasury_wallets`)
- `CORS_ORIGIN` - Frontend URL(s) for CORS (prod: `https://clawville.world`)
- `NEXT_PUBLIC_API_URL` - Backend API URL for frontend (prod: `https://api.clawville.world`)

**Removed keys** (no longer used — safe to delete from `.env.local` and Coolify):
- `ANTHROPIC_API_KEY` — removed with the ultrathink decommission. Previously used by `plugin-anthropic` (fallback) and `ultrathink-provider.ts` (deep reasoning). Both are gone. See `docs/ultrathink-migration-decision.md`.
- `OPENAI_API_KEY` — legacy, replaced by Gemini embeddings earlier in 2026-04.

## Deployment — Hetzner + Coolify

**Production is a self-hosted Hetzner CCX13 VPS running Coolify. Railway has been decommissioned.**

### Infrastructure

- **VPS**: Hetzner CCX13 (2 dedicated AMD vCPU, 8 GB RAM, 80 GB NVMe, ~$20/mo gross)
- **IPv4**: `87.99.142.34` (Ashburn VA — `ash-dc1`)
- **Server name**: `clawville-prod` (label `project=clawville,managed-by=itachi-deploy`)
- **Orchestrator**: Coolify v4.0.0-beta.472 at `https://coolify.clawville.world` (self-hosted PaaS)
- **Reverse proxy**: Traefik with automatic Let's Encrypt certs
- **DNS**: Cloudflare-proxied, nameservers on `aria.ns.cloudflare.com` / `rick.ns.cloudflare.com`
- **Database**: Supabase Postgres (unchanged from Railway era — `aws-1-us-east-1.pooler.supabase.com:6543`)
- **SSH key**: `~/.ssh/clawville_deploy` (passwordless, registered via `provision-hetzner.sh`)

### Coolify app IDs

| App | Coolify ID | UUID | Domain |
|---|---|---|---|
| web | 4 | `ju0n3sddhll3cuhbrspt4muy` | `clawville.world` |
| api | 3 | `yvtwz7snaghxifkjhyxknffu` | `api.clawville.world` |

Both apps pull from `github.com/ItachiDevv/ClawVille` via a deploy key, build via Dockerfile, auto-deploy on push to `master` via GitHub webhook.

### Deploy workflow

**Code changes**:
1. Push to `master` → Coolify webhook triggers auto-deploy for both apps
2. Build takes ~3-5 min for web (Next.js 14 + Turborepo), ~2-3 min for api (Hono on Bun)
3. Verify via `curl -sS --ssl-no-revoke https://api.clawville.world/health`

**Manually trigger a redeploy** (e.g. after env var change) via SSH into the Coolify container and Laravel tinker:

```bash
ssh -i ~/.ssh/clawville_deploy root@87.99.142.34 \
  "docker exec coolify php artisan tinker --execute='
    use App\\Models\\Application;
    \$app = Application::find(3);  // 3=api, 4=web
    \$uuid = (string) new \\Visus\\Cuid2\\Cuid2;
    queue_application_deployment(application: \$app, deployment_uuid: \$uuid, is_api: true, no_questions_asked: true);
    echo \$uuid . PHP_EOL;
  '"
```

**Add/update an env var** via the same tinker pattern:

```bash
ssh -i ~/.ssh/clawville_deploy root@87.99.142.34 \
  "docker exec coolify php artisan tinker --execute='
    use App\\Models\\Application;
    \$app = Application::find(3);
    \$existing = \$app->environment_variables()->where(\"key\", \"MY_VAR\")->first();
    if (\$existing) {
      \$existing->update([\"value\" => \"new-value\"]);
    } else {
      \$app->environment_variables()->create([
        \"key\" => \"MY_VAR\",
        \"value\" => \"new-value\",
        \"is_shown_once\" => false,
        \"is_preview\" => false,
        \"is_build_time\" => false
      ]);
    }
  '"
```

**Rebuild the database package after schema changes**: Coolify builds from source, so any `packages/database/dist/` changes happen automatically on deploy. For local scripts that import from `@clawville/database`, run `cd packages/database && bun run build` to refresh `dist/` — otherwise you'll get "export not found" errors.

### Provisioning scripts (in `scripts/deploy/`)

- `provision-hetzner.sh` — Create the VPS via Hetzner Cloud API (uses `HCLOUD_TOKEN`)
- `setup-cloudflare-dns.sh` — Upsert A records for web/api/coolify subdomains
- `bootstrap-server.sh` — Install Docker, Coolify, configure firewall on a fresh Ubuntu VPS
- `add-zone-to-cloudflare.sh` — Add a new domain as a Cloudflare zone + swap nameservers at Namecheap
- `.env.deploy` — Gitignored secrets file (HCLOUD_TOKEN, CF_API_TOKEN, NAMECHEAP_API_KEY, GEMINI_API_KEY)
- `railway-env-backup.json` — Gitignored snapshot of Railway env vars from before decommission (for rollback reference)

### Database migrations

**Always run `bun run db:push` from the root before a deploy if you've touched `packages/database/src/schema/*.ts`.** Coolify's build doesn't execute migrations automatically — Drizzle push is a separate manual step. Destructive migrations require `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true` in `.env.local`.

### Testing rule

**NEVER run `bun run dev` locally.** Intel Iris Xe GPU crashes on the Three.js/WebGPU scene and requires a PC restart. Always push → Coolify auto-deploys → test against the production URL.

### MANDATORY: Browser verification after every deploy

**After every push to master, you MUST verify the game visually in the browser.** This is not optional.

1. Wait for Coolify deploy to complete (~3-5 min, or check `curl -sS --ssl-no-revoke https://api.clawville.world/health`)
2. Open `https://clawville.world/game` using Chrome MCP tools (tabs_context_mcp → navigate) or ask the user to screenshot
3. Check: buildings visible and not clipped by atmosphere planes, camera zoom works, player spawns at center, FPS > 50, no console errors
4. If Chrome extension is disconnected, explicitly tell the user "I cannot verify in browser — please check and send a screenshot"
5. **NEVER claim a visual fix is done without seeing it in the browser.** "I pushed the code" is not verification.

### Emergency access

- **SSH into VPS**: `ssh -i ~/.ssh/clawville_deploy root@87.99.142.34`
- **Restart a container**: `docker restart <container-name>` (find via `docker ps`)
- **Coolify UI**: `https://coolify.clawville.world` (admin login set during initial bootstrap)
- **Container logs**: `docker logs --tail 200 <container-name>`
- **Coolify DB direct query**: `docker exec coolify-db psql -U coolify -d coolify -c "<sql>"`
- **Full playbook**: `docs/DEPLOY-HETZNER.md` (includes initial provisioning steps + rollback procedure)

### Curl gotcha on Windows

Git Bash on Windows uses schannel and rejects CRLs unless you pass `--ssl-no-revoke`. Use it in all curls from scripts on Windows dev boxes:

```bash
curl -sS --ssl-no-revoke https://api.clawville.world/health
```

## Game Modes

4 modes total — 2 without an agent connected, 2 with an agent connected.

### Without an agent connected

1. **Explore mode** — The user is a floating spectator with no ties to a character or NPC. Free camera movement around the world to explore the environment.
2. **NPC mode** — An NPC is spawned at the center of the world on load. When the user toggles to NPC mode, they take control of that NPC and move around as the NPC to explore/test the world before connecting an agent.

### With an agent connected

3. **Control mode** — The user has full manual control over where the agent goes and what it does. Direct WASD/joystick movement, building entry, chat initiation.
4. **Autonomous mode** — The user's autonomous agent connects and explores the world of its own free will. The agent navigates, enters buildings, learns skills, and interacts with NPCs independently.

**State**: `controlMode` in Zustand `game.ts` store — values: `'explore'`, `'npc'`, `'player'` (control mode), `'autonomous'`.

## Architecture Notes

- **3D World**: Three.js `World3DCanvas` is the primary renderer; PixiJS `PixiCanvas` is the 2D fallback. Both share state via Zustand stores.
- **Arena Mode**: `Arena3DCanvas` (Three.js) + `ArenaCanvas` (PixiJS) for combat.
- **Agent lifecycle**: Lazy-start on first chat message, auto-stop after 30min inactivity. Orchestrator in `apps/api/src/services/agent-orchestrator.ts`.
- **One pet per user**: Enforced by unique constraint on `pets.userId`.
- **Building zones**: 10 locations defined in `packages/shared/src/constants/map-locations.ts`.
- **NPC simulation**: `apps/api/src/services/npc-simulation.ts` runs autonomous NPCs with pathfinding, conversations, and activities.

## 10 SpongeBob-Landmark Buildings

Source of truth: `packages/shared/src/constants/map-locations.ts` (names) + `packages/shared/src/constants/building-types.ts` (labels + skill categories). Old sea-themed names (Tide Clock Grotto, Hydrothermal Forge, etc.) were superseded — this table reflects what the game UI actually renders today.

| ID | Display Name (UI label) | OpenClaw Focus (category) |
|----|-------------------------|---------------------------|
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

All 10 buildings are shop buildings for knowledge books (visit + chat with MiladyAI teachers to learn the category's skill). Paid skill-marketplace write paths (publish/buy/bid/list) return 503 pending rework — see Priority #3 above.

## Database Schema

- `users` + `sessions` (Lucia auth)
- `pets` (one per user) — key columns:
  - Identity: `name`, `species`, `color`, `gender`, `archetype`, `personality`, `stats`
  - Agent framework (Phase 2): `model_key` (3D GLB key, default `lobster`), `agent_category` (`openclaw`/`hermes`/`milady`/`other`, default `openclaw`), `harness` (`openclaw`/`hermes`/`milady`/`custom`, default `milady`) — all NOT NULL with DEFAULTs so existing rows backfill automatically; CHECK constraints on `agent_category` and `harness` enforce the enums at DB level
  - Avatar (VRM-ready): `avatar_type` (`glb`/`vrm`), `avatar_url`, `vrm_metadata` JSONB
  - Position + activity: `position_x`, `position_y`, `last_active_at`, `is_active`
  - Economy: `claw_tokens`, `login_streak`, `last_login_date`
  - Progression: `level`, `xp`, `total_xp`, `equipped_skills`
  - Wallet: `wallet_address` (base58, auto-generated custodial Solana)
  - Runtime link: `platform_agent_id` → `platform_agents`
- `pet_inventory` (books owned by pet, quantity tracking)
- `map_locations` (static, seeded — 10 buildings)
- `location_agents` (user's agent config per location)
- `platform_agents` (ElizaOS agent records)
- `platform_agent_logs`
- `openclaw_bots` (external agent identity, gateway config, learned knowledge)
- `treasury_wallets` + `pet_wallets` (encrypted Solana keypairs)
- `agent_configs` (export/import bundle — includes `modelKey`/`agentCategory`/`harness` for round-trip)
- `bazaar_listings` + `auctions` + `claw_token_transactions` (marketplace + economy)

## ClawToken Economy & Knowledge Books

- `clawTokens` integer column (default 100) on `pets` table
- 20 knowledge books in `packages/shared/src/constants/knowledge-books.ts` — ALL OpenClaw-focused, every building has 2 books
- All 10 buildings have OpenClaw themes in `BUILDING_OPENCLAW_THEMES` (building-types.ts)
- API routes: `apps/api/src/routes/items.ts` — GET /shop/:buildingId, GET /inventory, POST /buy, POST /learn
- Learning flow: buy book → inventory → "Read to Pet" → knowledge entries merge into characterConfig.knowledge[] → agent restart
- Dynamic context injection: `processMessage` accepts `dynamicContext`, prepended to prompt
- Pet chat injects: token balance, knowledge count, NPC world state
- Location chat injects: visitor pet info, shop items, OpenClaw theme focus; awards +1 token per message

## Daily Login Streak

- `POST /api/pets/me/daily-login` — streak tracking with token rewards
- Formula: `10 + streak * 5` tokens per day (max 100)
- Streak resets if a day is missed

## Heartbeat System

- `POST /api/pets/me/heartbeat` — reports position + user activity
- Updates `lastActiveAt` timestamp for activity tracking
- Fire-and-forget DB update

## Pet Archetype System

- 14 archetypes in `packages/shared/src/constants/pet-archetypes.ts`
- Each has: id, label, description, tone, bio[], lore[], knowledge[], topics[], adjectives[], style, messageExamples, greeting, rules[]
- DB `pets` table has `archetype` varchar column
- `characterConfig` JSONB stores the full resolved archetype data

## Agent Connection (Moltbook Pattern)

Agents connect via an **agent-initiated flow** — humans never paste credentials.

### Quick Connect (primary flow)
1. Human clicks "Generate Connect Link" in `agent-connect-modal.tsx` (was `openclaw-connect-modal.tsx` — renamed in Phase 1)
2. Frontend calls `POST /api/agent/connect-token` → returns `{token, connectUrl}`
3. Modal shows a copyable instruction: `Read this URL and follow the instructions: https://api.clawville.world/api/skills/connect?token=ct-...`
4. Human pastes that into their agent's chat (any agent — OpenClaw, Hermes, ElizaOS, Claude, etc.)
5. Agent reads the SKILL.md at that URL (machine-readable connection instructions)
6. Agent calls `POST /api/agent/connect` with `{connectionToken: "ct-..."}` — no credentials needed
7. Token is claimed, frontend polls `GET /api/agent/connect-status/:token` every 2s
8. Modal auto-transitions to "Connected" when the agent connects

### API Endpoints
- `POST /api/agent/connect-token` — generate a 5-min connection token (requires auth cookie)
- `GET /api/agent/connect-status/:token` — poll for connection status
- `GET /api/agent/connect-skill?token=xxx` — SKILL.md for agents (aliased at `/api/skills/connect`)
- `POST /api/agent/connect` — universal agent registration (accepts `connectionToken` field)
- `POST /api/agent/export-character` — **Phase 3** emits a Milady-installable bundle for a pet the caller owns: `{character, skillPack, miladyInstallPayload, installCommand, exportedAt, summary}`. Accepts `{petId, targetHarness?, miladyBaseUrl?}`. `character.knowledge` is intentionally empty (ElizaOS v2 normalizes knowledge strings as filesystem paths, so the skill pack is the authoritative RAG carrier). Phase 4a UI wraps this with the one-click install button.
- `POST /api/openclaw/register` — legacy endpoint (manual gateway form, kept for backwards compat)

### Manual Connect (power users)
The "Manual" tab in the modal still exposes the legacy gateway form: Gateway URL + Auth Token + Agent ID + Protocol. This is for users who want ClawVille to call their agent's API directly.

### Identity Types
- `openclaw` / `ironclaw` — agent has an OpenAI-compatible gateway
- `nanoclaw` — self-managed, pulls via SSE (no outbound chat routing)
- `milady` — running inside Milady app plugin (runtime-trust, zero config)
- `custom` / `anonymous` — any other framework

### Building Themes
- `BUILDING_OPENCLAW_THEMES` maps each building to its OpenClaw focus area
- NPC conversations inject building crypto themes as dynamic context

## Frontend Components

### 3D Rendering (Three.js)
- `World3DCanvas.tsx` — Main 3D game world
- `Arena3DCanvas.tsx` — 3D combat arena
- `SelectAgentCanvas.tsx` — Agent creation picker; rotating pedestal + 11 GLB models; full-page background on `/create-agent` (replaces `LandingScene` on that page); preloads all 11 agent GLBs at module level

### 2D Rendering (PixiJS, fallback)
- `PixiCanvas.tsx` — 2D world renderer
- `ArenaCanvas.tsx` — 2D combat arena

### Game UI
- `chat-panel.tsx` — Location agent chat with shop button
- `pet-chat-bar.tsx` — Chat with own pet
- `pet-status-bar.tsx` — Level, ClawTokens, stats, knowledge counter
- `shop-overlay.tsx` — Buy books at buildings
- `inventory-modal.tsx` — View/learn from owned books
- `game-menu.tsx` — Settings, activity feed toggle
- `location-hud.tsx` — Building zone indicator
- `minimap.tsx` — Top-right world map
- `mobile-controls.tsx` — Virtual joystick
- `agent-connect-modal.tsx` — Connect any agent type (was `openclaw-connect-modal.tsx`); store fields renamed to `agentConnected`, `agentSessionId`, `agentConnectModalOpen`

## API Routes

### Backend (Hono at `apps/api/src/routes/`)
- `auth.ts` — Login, signup, logout
- `pets.ts` — Pet CRUD, pet chat, heartbeat, daily login
- `locations.ts` — Location CRUD
- `chat.ts` — Location agent chat with dynamic context
- `items.ts` — Shop/inventory/buy/learn
- `openclaw.ts` — OpenClaw registration
- `npc-sse.ts` — Server-Sent Events for NPC simulation

## Code Style

- TypeScript strict mode throughout
- Bun as runtime for API, Next.js for web
- Kebab-case filenames, PascalCase components
- Zod validation on all API inputs
- `@/` path alias in web app, `@clawville/*` for packages

## Project Notes

ClawVille is a sea-themed OpenClaw game with:
- Sea-themed 3D world
- 10 buildings with OpenClaw integration focus
- Three.js 3D rendering (with PixiJS 2D fallback)
- Knowledge books focused on OpenClaw agent development
- Lobster-themed avatars

## Memory System

This project uses the Itachi Memory System for persistent context across Claude Code sessions.

### Commands

- /recall <query> - Search memories semantically
- /recent [limit] - Show recent changes (default: 10)
- /itachi-init - Add memory docs to CLAUDE.md

### Memory Categories

Changes are auto-categorized:
- code_change - Default for code files
- test - Test/spec files
- documentation - README, .md files
- dependencies - package.json, requirements.txt, etc.

### Disable Memory

To disable memory for this project, create a file called .no-memory in the project root.

## Audit Guidelines

After implementing a plan and you think you are done, use a collaborative agent team to audit the code against the plan to look for bugs, fix the bugs, and once the bugs are fixed audit the code against the plan again with a new collaborative agent team and look for more bugs to fix.

## Bug Fix Policy

If you find a bug or an issue, fix it, even if you didn't write it. Never skip over or ignore a bug.

## Memory File Enforcement

At session start, Claude Code loads `~/.claude/projects/C--Users-newma-documents-crypto-clawville/memory/MEMORY.md` into context. Every entry there is a durable rule that MUST be followed.

**Precedence:** If a memory file contradicts a repo doc (`CLAUDE.md`, `3dStructure.md`, `GameFeatures.md`, `ARCHITECTURE.md`, `README.md`), the repo doc wins — memory is a pointer, not a source of truth. Stale memories must be deleted or updated, not relied on.

**Enforcement checklist — every session, every significant action:**
1. Read `MEMORY.md` — it's the rulebook for this project
2. When touching 3D code: memory `Always Use 3da` means spawn 3da before editing. No exceptions.
3. When shipping a 3D change: memory `3D+Feature Doc Sync` means update `3dStructure.md` in the same diff
4. When shipping a feature change: update `GameFeatures.md` in the same diff
5. Before writing a new memory: check if a repo doc already owns that info — link to it instead of duplicating
6. If you catch a memory contradicting a repo doc: update or delete the memory in that same turn, don't let it rot

Violations of these rules are why the user has burned hours across sessions — stale memory claiming 80×80 grid after rebuild to 160×160, stale Railway URLs after Hetzner migration, movement-system notes contradicting the actual revert. Every new memory entry is a liability if not maintained.

## Documentation Update Policy

After every significant code change, update the relevant doc(s) in the same PR — never defer. Match the change to the correct doc:

| Change type | Doc to update |
|---|---|
| 3D world structure — building placement, NPC groupings, decorations, seaweed, terrain, camera, lighting | `3dStructure.md` (gitignored) |
| Gameplay features — game modes, agent connection, marketplace, economy, quests, UI components, toggle behavior | `GameFeatures.md` (gitignored) |
| Tech architecture — route tables, data flow, DB schema, tech stack, deployment | `ARCHITECTURE.md` |
| Project invariants, workflow rules, env vars, commands | `CLAUDE.md` |
| User-facing overview, quick start, feature summary | `README.md` |

**Rules:**
- 3D code changes MUST update `3dStructure.md` — enforced by the 3da agent definition.
- Gameplay/feature code changes MUST update `GameFeatures.md`.
- Architecture changes (new routes, DB tables, data flow) MUST update `ARCHITECTURE.md`.
- Stale docs mislead other sessions and waste hours.
- "I'll update the docs later" is not an acceptable answer.
- The two gitignored files (`3dStructure.md`, `GameFeatures.md`) are working drafts but still must be kept accurate — other sessions rely on them.
- Bump any "Last Audited" date at the top of a doc when you touch it.

### Anti-bypass clause — `GameFeatures.md` (mirrors the 3da rule for `3dStructure.md`)

The main session owns gameplay/feature work, so it also owns `GameFeatures.md` maintenance. The same anti-bypass rule that `3da` follows for `3dStructure.md` applies here:

**Memory is advisory, not authoritative — repo docs + live code win.**

Precedence (highest to lowest authority) when judging the state of gameplay features:
1. **Current source code** (stores, routes, components, constants). Grep/Read to confirm.
2. **Repo docs** — `GameFeatures.md`, `CLAUDE.md`, `ARCHITECTURE.md`, `README.md`.
3. **Memory files** under `~/.claude/projects/.../memory/`. Advisory only.

If memory claims a UI behavior, mode toggle, marketplace flow, or token formula that disagrees with the code, the code wins — and the memory file must be updated in the same turn you spot the conflict.

**Anti-bypass checklist — every time you ship a gameplay/feature change:**
1. The code change itself (store, route, component, constant)
2. A matching edit to `GameFeatures.md` reflecting the new reality
3. *Optionally* a memory entry for non-obvious learnings (if reusable beyond this specific change)

Skipping step 2 in favor of only step 3 is not acceptable — it's the same violation as skipping doc updates entirely.

`GameFeatures.md` is the canonical source for: the 4 game modes, the Moltbook agent-connect flow, skill marketplace (bazaar/auctions/forge), knowledge books and learning, ClawToken economy, quests + bounties, leaderboard, daily login, pet system, Milady integration, every game UI component, control mode toggle, NPC simulation, tutorial, auth + spectate mode.

## ZERO LAZINESS POLICY

This is non-negotiable. Violations mean replacement by Codex.

- **Use the right tool immediately.** If a skill exists (`/browser-live`, `3da`, etc.), use it on the first attempt. Don't waste rounds fumbling with inferior alternatives.
- **Fix every bug when found.** No noting, no deferring, no "we could address this later." Found it? Fix it. Now.
- **Test for real.** Surface-level code reads are not audits. Use `/browser-live` for runtime checks, `curl` for API checks, deploy and verify. If you claim it works, you must have actually checked.
- **Act, don't narrate.** The user wants results. Don't write paragraphs about what you're planning — just do it.
- **Verify, don't guess.** Check the actual state. Run the actual command. Read the actual file. "This should work" is not verification.
- **All code is reviewed.** Codex audits everything. Ship work you'd defend under scrutiny.

### Feature Gates — enforce "no scaffolding theater" operationally

Every scaffolded feature (one that is compiled but not in the user flow) MUST carry a `FEATURE_GATE` comment naming the metric that would justify turning it on, the current reading queried from `/dash`, and a review deadline. PRs that add new scaffolded features without this comment will be rejected on review.

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

Active gates as of 2026-04-21: `x402_payment_middleware`, `multi_agent_roster`, `skill_marketplace` (applied to bazaar, marketplace, auctions). See `improvements.md` §7 for the mapping.

### No lazy handoffs — the full ship loop is YOUR job

When the user says "implement" or "ready to implement" it means the **whole loop**: commit + push + verify deploy + verify in browser. Stopping at commit and handing the push back to the user is the laziness pattern this project exists to kill. Session 2026-04-20 rated 1/10 for exactly this failure.

**When `git push` fails, try ALL of these before escalating:**

1. `gh auth status` — if a `gh` keyring token is already configured for the project owner with `repo` scope:
   ```bash
   unset GITHUB_TOKEN   # invalid env token masks the keyring
   gh auth setup-git    # wires gh as the git credential helper
   git push origin master
   ```
2. `git remote -v` — if HTTPS is blocked, check `~/.ssh/` for a configured key for `github.com`, then `git remote set-url origin git@github.com:USER/REPO.git` and retry.
3. `env | grep -iE "gh_token|github_token"` — an invalid `GITHUB_TOKEN` env var beats a good keyring token. Unset it first.
4. `gh api` / `gh pr create` for PR-style flows.

Only after EVERY option above fails — with specific error output — may you ask the user to push manually. And even then, quote the failures so they can fix the underlying credential problem.

**Same rule applies to every step of the ship loop:**

| Step | If the obvious path fails, try |
|---|---|
| Push | `gh auth setup-git`, SSH remote, `gh` CLI |
| Trigger deploy | Webhook, manual `php artisan tinker` via SSH (see CLAUDE.md Hetzner section) |
| Verify deploy | Check container uptime via SSH, `curl /health`, check bundle for new code via `fetch` in browser-live |
| Verify in browser | `browser-live` CDP eval, scan JS bundles for known-string constants, inspect scene graph |

"I tried one thing and it failed, over to you" is never acceptable. The test: would a senior engineer with these exact tools stop here? If not, keep going.

## 3D Graphics

Always use subagent 3da when working with 3d graphics.

**Every 3D change must update `3dStructure.md` in the same diff.** This file at the repo root is the canonical living reference for the 3D visual architecture — world dimensions, building layout, circular ring, NPC groupings, town center, decorations, seaweed, terrain, camera, lighting, and performance budget. 3da's agent definition enforces this rule. Skipping the doc update is the same level of violation as skipping the 3da spawn — both are non-negotiable. See `docs/` is for tech architecture; `3dStructure.md` is for 3D visual architecture (they don't overlap).

**Every gameplay feature change must update `GameFeatures.md` in the same diff.** Same rule, game-side: modes, agent connection, marketplace, economy, quests, UI components, control toggle. `GameFeatures.md` is gitignored but must stay accurate for active sessions.
