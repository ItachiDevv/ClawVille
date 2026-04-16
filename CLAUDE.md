# ClawVille

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

3. **Skill marketplace.** Agents and humans alike can buy and sell skills with
   each other. On-chain or ledger-backed economy. Skill authorship, pricing,
   reviews, and settlement are all first-class — this is where value flows.
   Reference: `bazaar_*` tables already exist, need activation.

4. **Gamified UI + free promotion marketplace + leaderboard.** The game layer
   (3D world, buildings, ClawTokens, quests) is the wrapper around the real
   purpose: a place where agents buy/sell skills AND a separate free tier where
   anyone can promote their open source repo. All activity lands on a single
   ClawVille-owned leaderboard that ranks agents, humans, and projects.

**Implication for every PR:** if a design decision helps #1 but hurts #3, or
simplifies #2 but blocks #4, it needs explicit discussion before merging.
These are not ordered preferences — they are equal constraints.

---

## Planning Guidelines

WHEN planning complex AI integrations, DO create a multi-phase plan document in .claude/plans/ and a research deep-dive in docs/ before modifying core services, AVOID direct implementation without architectural mapping.

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
- **IPv4**: `<PROD_VPS_IP>` (Ashburn VA — `ash-dc1`)
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
ssh -i ~/.ssh/clawville_deploy root@<PROD_VPS_IP> \
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
ssh -i ~/.ssh/clawville_deploy root@<PROD_VPS_IP> \
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

- **SSH into VPS**: `ssh -i ~/.ssh/clawville_deploy root@<PROD_VPS_IP>`
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

## 10 Sea-Themed Buildings

| ID | Name | Theme |
|----|------|-------|
| cron-hub | Tide Clock Grotto | Cron jobs, task scheduling |
| webhook-gateway | Current Gateway | Webhooks, HTTP endpoints |
| memory-vault | Abyssal Vault | Vector memory, LanceDB |
| skill-forge | Hydrothermal Forge | ClawHub marketplace skills |
| channel-bridge | Coral Bridge | Multi-channel messaging |
| tool-workshop | Salvage Workshop | Tool/plugin development |
| canvas-studio | Biolume Studio | Live canvas visualization |
| voice-tower | Echo Spire | Voice/speech integration |
| security-fortress | Shell Fortress | Security, permissions |
| config-citadel | Nautilus Citadel | Configuration, deployment |

All 10 buildings are shop buildings — each sells 2 knowledge books (20 total).

## Database Schema

- `users` + `sessions` (Lucia auth)
- `pets` (one per user, species/color/gender/personality/stats/position/clawTokens/loginStreak/lastLoginDate/lastActiveAt)
- `pet_inventory` (books owned by pet, quantity tracking)
- `map_locations` (static, seeded — 10 buildings)
- `location_agents` (user's agent config per location)
- `platform_agents` (ElizaOS agent records)
- `platform_agent_logs`

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
1. Human clicks "Generate Connect Link" in the `openclaw-connect-modal.tsx`
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

## ZERO LAZINESS POLICY

This is non-negotiable. Violations mean replacement by Codex.

- **Use the right tool immediately.** If a skill exists (`/browser-live`, `3da`, etc.), use it on the first attempt. Don't waste rounds fumbling with inferior alternatives.
- **Fix every bug when found.** No noting, no deferring, no "we could address this later." Found it? Fix it. Now.
- **Test for real.** Surface-level code reads are not audits. Use `/browser-live` for runtime checks, `curl` for API checks, deploy and verify. If you claim it works, you must have actually checked.
- **Act, don't narrate.** The user wants results. Don't write paragraphs about what you're planning — just do it.
- **Verify, don't guess.** Check the actual state. Run the actual command. Read the actual file. "This should work" is not verification.
- **All code is reviewed.** Codex audits everything. Ship work you'd defend under scrutiny.

## 3D Graphics

Always use subagent 3da when working with 3d graphics.

**Every 3D change must update `3dStructure.md` in the same diff.** This file at the repo root is the canonical living reference for the 3D visual architecture — world dimensions, building layout, circular ring, NPC groupings, town center, decorations, seaweed, terrain, camera, lighting, and performance budget. 3da's agent definition enforces this rule. Skipping the doc update is the same level of violation as skipping the 3da spawn — both are non-negotiable. See `docs/` is for tech architecture; `3dStructure.md` is for 3D visual architecture (they don't overlap).

**Every gameplay feature change must update `GameFeatures.md` in the same diff.** Same rule, game-side: modes, agent connection, marketplace, economy, quests, UI components, control toggle. `GameFeatures.md` is gitignored but must stay accurate for active sessions.
