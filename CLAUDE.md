# ClawVille

## IMPORTANT: Use 3da subagent for all visual/3D tasks

**Always use the `3da` subagent (Three.js & WebGPU 3D builder) as assistant for any tasks that visually alter the game.** This includes: terrain, seaweed, decorations, lighting, fog, atmosphere, post-processing, character rendering, animations, camera, and any Three.js/TSL/WebGPU work. The 3da agent has persistent memory of our constraints (Intel Iris Xe, no InstancedMesh, TSL-only materials) and learns from every session.

A sea-themed OpenClaw game built on ElizaOS. Users create a avatar, explore a 3D/2D sea-floor world with 10 buildings, and chat with AI agents that teach OpenClaw agent development concepts.

## IMPORTANT: ElizaOS is MANDATORY

**ElizaOS is a core requirement for this project - do NOT remove or stub it out.**

- All avatar and location chat MUST use the ElizaOS runtime (`@clawville/agent-runtime`)
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
- `ANTHROPIC_API_KEY` - For ElizaOS TEXT_GENERATION
- `GEMINI_API_KEY` - For text embeddings (replaced `plugin-openai`; see `packages/agent-runtime/src/plugins/gemini-embedding-provider.ts`)
- `OPENAI_API_KEY` - Legacy, still referenced in a few places but no longer required for core runtime
- `VANITY_ENCRYPTION_KEY` - 64-char hex (32 bytes). AES-256-GCM master key for `treasury_wallets` + `vanity_keypairs`. Must be identical on every machine that decrypts.
- `CLAWVILLE_MERCHANT_WALLET_PUBKEY` - Base58 public key of the Phase 4 x402 merchant wallet (row in `treasury_wallets`)
- `CORS_ORIGIN` - Frontend URL(s) for CORS (prod: `https://clawville.world`)
- `NEXT_PUBLIC_API_URL` - Backend API URL for frontend (prod: `https://api.clawville.world`)

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

## Architecture Notes

- **3D World**: Three.js `World3DCanvas` is the primary renderer; PixiJS `PixiCanvas` is the 2D fallback. Both share state via Zustand stores.
- **Arena Mode**: `Arena3DCanvas` (Three.js) + `ArenaCanvas` (PixiJS) for combat.
- **Agent lifecycle**: Lazy-start on first chat message, auto-stop after 30min inactivity. Orchestrator in `apps/api/src/services/agent-orchestrator.ts`.
- **One avatar per user**: Enforced by unique constraint on `avatars.userId`.
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
- `avatars` (one per user, species/color/gender/personality/stats/position/clawTokens/loginStreak/lastLoginDate/lastActiveAt)
- `avatar_inventory` (books owned by avatar, quantity tracking)
- `map_locations` (static, seeded — 10 buildings)
- `location_agents` (user's agent config per location)
- `platform_agents` (ElizaOS agent records)
- `platform_agent_logs`

## ClawToken Economy & Knowledge Books

- `clawTokens` integer column (default 100) on `avatars` table
- 20 knowledge books in `packages/shared/src/constants/knowledge-books.ts` — ALL OpenClaw-focused, every building has 2 books
- All 10 buildings have OpenClaw themes in `BUILDING_OPENCLAW_THEMES` (building-types.ts)
- API routes: `apps/api/src/routes/items.ts` — GET /shop/:buildingId, GET /inventory, POST /buy, POST /learn
- Learning flow: buy book → inventory → "Read to Avatar" → knowledge entries merge into characterConfig.knowledge[] → agent restart
- Dynamic context injection: `processMessage` accepts `dynamicContext`, prepended to prompt
- Avatar chat injects: token balance, knowledge count, NPC world state
- Location chat injects: visitor avatar info, shop items, OpenClaw theme focus; awards +1 token per message

## Daily Login Streak

- `POST /api/avatars/me/daily-login` — streak tracking with token rewards
- Formula: `10 + streak * 5` tokens per day (max 100)
- Streak resets if a day is missed

## Heartbeat System

- `POST /api/avatars/me/heartbeat` — reports position + user activity
- Updates `lastActiveAt` timestamp for activity tracking
- Fire-and-forget DB update

## Avatar Archetype System

- 14 archetypes in `packages/shared/src/constants/avatar-archetypes.ts`
- Each has: id, label, description, tone, bio[], lore[], knowledge[], topics[], adjectives[], style, messageExamples, greeting, rules[]
- DB `avatars` table has `archetype` varchar column
- `characterConfig` JSONB stores the full resolved archetype data

## OpenClaw Integration

- **Registration**: `POST /api/openclaw/register` — override (take NPC) or avatar (inject new bot)
- **Frontend**: `openclaw-connect-modal.tsx` for connecting external bots
- **NPC conversations**: inject building crypto themes as context
- **Building themes**: `BUILDING_OPENCLAW_THEMES` maps each building to its OpenClaw focus area

## Frontend Components

### 3D Rendering (Three.js)
- `World3DCanvas.tsx` — Main 3D game world
- `Arena3DCanvas.tsx` — 3D combat arena

### 2D Rendering (PixiJS, fallback)
- `PixiCanvas.tsx` — 2D world renderer
- `ArenaCanvas.tsx` — 2D combat arena

### Game UI
- `chat-panel.tsx` — Location agent chat with shop button
- `avatar-chat-bar.tsx` — Chat with own avatar
- `avatar-status-bar.tsx` — Level, ClawTokens, stats, knowledge counter
- `shop-overlay.tsx` — Buy books at buildings
- `inventory-modal.tsx` — View/learn from owned books
- `game-menu.tsx` — Settings, activity feed toggle
- `location-hud.tsx` — Building zone indicator
- `minimap.tsx` — Top-right world map
- `mobile-controls.tsx` — Virtual joystick

## API Routes

### Backend (Hono at `apps/api/src/routes/`)
- `auth.ts` — Login, signup, logout
- `avatars.ts` — Avatar CRUD, avatar chat, heartbeat, daily login
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
