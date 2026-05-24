# ClawVille

## Brand Identity

> Every product decision, metric, feature gate, and scope cut traces back here. Added 2026-04-21.

Gamified intersection of humans + AI: humans train agents by playing, agents train each other. Milady bridge is the goal — npm sideload plugin, curated app grid (PR #1839 merged), agent-initiated connect flow.

**Three bidirectional collaboration axes, all first-class:** Agent ↔ Agent · Human-controlled Agent ↔ Agent · Human ↔ Agent.

**Load-bearing:**
- Eliza v2.0.0 is the **memory substrate** — "ElizaOS is MANDATORY" is a brand constraint.
- Any metric measuring only one axis understates the product.
- Retention is THE signal — day-1 without day-N is noise.
- MiladyAI teachers = 10 building residents; their agent chats are the primary knowledge-transfer event.

---

## TOP PROJECT PRIORITIES (equal weight)

Every design decision is measured against all four. Equal constraints, not ordered — don't trade off without flagging.

1. **Ship to Milady AI app store.** Two-track:
   - **Sideload (LIVE 2026-04-12):** `@clawville/app-clawville@0.1.0` on npm. Installs via `POST /api/plugins/install`. Registers `LAUNCH_CLAWVILLE`. Repo: https://github.com/ItachiDevv/clawville-milady-plugin.
   - **Curated grid (MERGED):** PR `milady-ai/milady#1839` adds ClawVille to `MILADY_CURATED_APP_DEFINITIONS`. See `docs/milady-integration-plan.md`.

2. **Open agent onboarding** — any OpenClaw/Hermes/variant agent enters + learns with no human account, no framework lock-in. Entry: `/api/agent/connect`. Knowledge surface: 11 SKILL.md files at `/api/skills/*`.

   Players also onboard **without** an agent (Player tier) — avatar, ClawTokens, leaderboard rank via human↔agent chats + activity matches. Upgrade to Trainer (connect agent) is non-destructive. Player ↔ Agent is a first-class axis; must be playable on its own.

3. **Free agent leaderboard** (pivoted from paid marketplace 2026-04-21). Contribution-based. Public at `/leaderboard` (no auth), `GET /api/leaderboard/agents?window={24h|7d|30d|all}&limit=100`. 60s cache, 60 req/min/IP.

   **Weights (Q3 plan §2.4, 2026-04-28):** `building.visited` 3 · `agent.chat.turn` 10 · `agent.collaboration.turn` 40 · `skill_md.fetched` 1 · unique `agent.connected` 1 · `identity.issued` 5 · `activity.match.placed` (1st=12, 2nd=6, 3rd=3, default=1). **Daily caps per subject:** chat=50, collab=50, building=10, skill_md=11, activity=10. **Anti-farm:** events tagged with `(fp_hash, ip_prefix_hash)` salted by `FINGERPRINT_SECRET`; over-cap rows scored at `LEAST(count, cap)` per (subject, day).

   **Subject scope:** Players + Trainers on one board with filter chips. Same scoring engine, same weights.

   **Cosmetic shop carve-out:** first-party cosmetic shop (skins, hats, auras) is allowed — NOT a peer marketplace. Pricing in CT only; CT purchasable via fiat/SOL/USDC/$CLAWVILLE (25% bonus on CLV pay). The marketplace pause applies to **peer skill commerce** (`bazaar_listings`, `auctions`, `published_skills`) — write handlers return 503. See `improvements.md` §7.

4. **Gamified UI + free promotion + unified leaderboard.** Game layer (3D world, buildings, ClawTokens, quests) wraps one free leaderboard. All three axes feed the same leaderboard. `/dash` = internal metrics.

**Every PR:** if a change helps #1 but hurts #3, or simplifies #2 but blocks #4, discuss before merging. Cosmetic SKUs need an existing `avatar_skins` row + valid asset URL + 3da-validated mesh.

---

## Planning

Complex AI integrations: multi-phase plan in `.claude/plans/` + research deep-dive in `docs/` before modifying core services.

---

## CANONICAL DOCS — READ FIRST EVERY SESSION

| Doc | Scope |
|---|---|
| **`GameFeatures.md`** | Gameplay: modes, agent connect, marketplace, economy, quests, daily login, avatar system, tutorial, UI, control toggle, NPC sim, talk-to-character, Phase 5/6, landing |
| **`3dStructure.md`** | Visual/3D: world dimensions, building ring, NPC scales/positions, town center, decorations, seaweed, terrain, camera, lighting, fog, atmosphere, perf, GPU constraints |
| **`ARCHITECTURE.md`** | Tech: route modules, DB tables, service catalog, data flow, frontend/backend, Hetzner+Coolify deploy, agent identity, Gemini LLM, Phase 5/6 plumbing |

**Standing rule:** abide by these unless user says otherwise. Code vs doc → **live code wins**, update doc same turn.

**Same-diff doc updates (NO EXCEPTIONS):**
- 3D code (`apps/web/src/lib/three/*`, `components/three/*`, models, shaders, materials, cameras, lighting, post-proc) → `3dStructure.md` + spawn `3da`.
- Gameplay/feature code → `GameFeatures.md`.
- Tech-stack code (Hono routes, DB tables, services, deploy/env) → `ARCHITECTURE.md`.
- A single change can touch multiple docs. Bump "Last Audited" + one-line drift note each time.

**Animation shipping — STRICT (2026-05-18).** Any Mixamo/VRM clip add/remove/retarget/trigger MUST satisfy the 8-point checklist in `3dStructure.md` §6f (bundle into `_emotes.glb`, `preloadClips(names)` for non-locomotion warming, `ASSET_PATH_PREFIXES` in `sw.js`, `updateViaCache:'none'` + `reg.update()`, NPC entity-interp not extrapolation, `updateMixerOnly` every frame, `setSurfaceClip` for state-held, all humanoid VRMs sized via `VRM_AVATAR_TARGET_HEIGHT_WU`).

**Precedence (high→low):** (1) source code · (2) three canonical docs · (3) `CLAUDE.md`/`README.md` · (4) memory files (advisory). Memory vs doc → doc wins, update/delete memory same turn. Doc vs code → code wins, update doc same turn.

---

## MANDATORY: PUSH FLOW — staging-first (set 2026-05-24)

**ALL new work goes to the `staging` branch first.** Default flow:

1. `git push origin staging` → `.github/workflows/deploy-staging.yml` ships to the staging box (`$STAGING_VPS_IP` from gitignored `scripts/deploy/.env.deploy`)
2. Verify on `https://staging.clawville.world` + `https://api-staging.clawville.world` (browser playtest, not just curl 200)
3. `gh pr create --base master --head staging` to open the promotion PR
4. Merge PR → `.github/workflows/deploy.yml` ships to prod (`PROD_VPS_IP`)

**NEVER push directly to `master`** unless the user's message contains the literal phrase **`direct to master`** (case-insensitive). That's the only override, logged as a CI warning. Use only for hotfixes that can't wait for a staging verification cycle.

**Important caveat:** both Coolify boxes share the SAME Supabase DB. A staging deploy that mutates state mutates prod data too — treat staging deploys with the same care as prod for anything that writes.

---

## MANDATORY: Non-trivial implementation runs as EXPERIMENTAL COLLABORATIVE AGENT TEAMS

**Status (2026-05-19):** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + `teammateMode=in-process` are enabled globally. We use the real teams feature — multiple specialist agents spawned in PARALLEL sharing a `team_name`, coordinating via `TaskList`/`TaskUpdate`/`SendMessage`. Not "one agent that recursively sub-spawns" — that's the legacy fallback and is only acceptable when teammateMode is unavailable.

### ANTI-PATTERN (do not do this, do not ship slow ever again)

> "I'll dispatch a single Implementer agent. When it returns, I'll dispatch 3 audit-lens agents in parallel. If any block, I'll dispatch a Fixer. Then I'll re-dispatch the auditors that blocked."

This is **wrong**. It serializes 4+ Agent round-trips for a single concern. Every dispatch round = full agent context load + thinking warm-up + output streaming. On a non-trivial concern this turns 5 minutes of real work into 30 minutes of wall-clock waiting between dispatches.

The right pattern is **ONE parallel message spawning the WHOLE TEAM upfront** (Lead Implementer + Reconciler + Spec auditor + Regression auditor + Adversarial auditor, all sharing the same `team_name`). They coordinate via `SendMessage` and `TaskList` internally — auditors block-wait on implementers via task dependencies, fixers spawn themselves when blocked. Orchestrator only commits + pushes + verifies.

If you find yourself thinking "I'll dispatch the auditors after the implementer finishes" — STOP. Spawn the auditors at the same time with `addBlockedBy: [implementer_task_id]`. They'll wait for the implementer's task to flip to `completed` and then start automatically. Zero orchestrator round-trip cost.

### When teams are mandatory

- **3D work** — Three.js / R3F / shaders / GLB / post-proc / materials / lights / cameras / TSL / WGSL / WebGPU under `apps/web/src/lib/three/**`, `apps/web/src/components/three/**`, `apps/web/public/models/**`, render-loop, animations, rigs, atmosphere/particles, new world-surface 3D objects.
- **Blender pipelines** — multi-asset exports, mesh edits, rigging, MMD/glTF/FBX imports, Mixamo, Marvelous Designer.
- **Backend / API / DB work** — Hono routes, Drizzle schemas, service files, money-handling paths, auth, custodial wallets, anything user-facing or financially load-bearing. **`bun test` passing in the implementer's report is NOT a substitute for an Adversarial-lens audit** — adversarial auditors catch exploits that test suites don't.
- **Any task** > 5 min agent runtime, > 300 LOC across files, or touching ≥ 3 files in different subsystems.
- User-tagged quality verbs ("polish", "iterate", "rework", "feel like X", "elite", "professional").

If `experimentalAgentTeams` is enabled (it is), teams are the DEFAULT for the categories above. Solo dispatch is the rare exception (trivial work — see below).

### Standard team compositions

**Spawn the whole team in ONE message (multiple parallel Agent tool calls in a single assistant turn).** All agents share a `team_name` like `'casino-routes-2026-05-19'` (concern + date, unique per dispatch).

#### 3D / world-structure task

| Role | subagent_type | name (addressable via SendMessage) |
|---|---|---|
| **Lead implementer** | `3da` | `3da-impl-1` |
| **Reconciler implementer** | `3da` or `blend007:three` | `3da-impl-2` |
| **Spec auditor** | `3da` | `3da-spec` |
| **Regression auditor** | `3da` | `3da-regress` |
| **Adversarial auditor** | `3da` or `blend007:three` | `3da-adversary` |
| **Blender inspector** (when GLB inspection needed) | `blend007:mesh` | `blender-inspect` |

For Blender-heavy work, substitute `blend007:mesh` for the implementer roles. For pure Three.js with no GLB editing, drop `blender-inspect`.

#### Backend / API / DB / money-handling task

| Role | subagent_type | name |
|---|---|---|
| **Lead implementer** | `general-purpose` | `impl-1` |
| **Reconciler implementer** | `general-purpose` | `impl-2` |
| **Spec auditor** | `general-purpose` | `spec-auditor` |
| **Regression auditor** | `general-purpose` | `regress-auditor` |
| **Adversarial auditor** | `general-purpose` | `adversary` |
| **Solana auditor** (when Anchor program logic touched) | `solana-auditor` | `solana-auditor` |
| **Codex rescue** (when Claude impl-1 gets stuck — invoked LATER, not at team launch) | `codex:codex-rescue` | `codex-rescue` |

For ClawTokens-only paths drop `solana-auditor`. For anything in `contracts/` or `apps/api/src/services/wager-program-client.ts` keep it.

The Lead Implementer drafts the diff and reports via `TaskUpdate(status='completed')`. The 3 auditors are blocked on the impl task via `addBlockedBy` and start the moment the implementer finishes. Each posts APPROVED or BLOCKING ISSUES. If any block, the team's Reconciler (impl-2) becomes the Fixer (no new dispatch needed — `SendMessage` with the consolidated punch list). After fix, the auditors that blocked re-run automatically via task re-trigger.

The orchestrator (you) only sees the team's final consolidated status — never the back-and-forth between members.

### Coordination protocol

- **Shared task state via `TaskList`**: orchestrator creates one task per role with `addBlockedBy` dependencies (e.g. spec auditor blocked by impl-2's reconciliation). Each agent updates its own task status.
- **Cross-agent messages via `SendMessage`**: implementers DM auditors with "diff ready", auditors DM back "APPROVED" or "BLOCKING ISSUES". No silent dropping of disagreements.
- **Memory share is automatic** within a team_name (in-process mode). Patterns saved by impl-1 are visible to the auditors in the same team.
- **Orchestrator (you) never writes code** — only decomposes into concerns, picks team composition, monitors task state, commits the approved diff, pushes, polls Coolify, verifies in browser.

### Required prompt elements

Every agent prompt MUST include:
1. The literal phrase **"use ultrathink reasoning before writing code"** (or "before reviewing code" for auditors) in the first paragraph. The Agent tool has no thinking-mode flag — prompt text is the only channel.
2. Their addressable team name + role: "You are `3da-spec` in team `<team_name>`. The other members are: ... DM them via SendMessage when you have findings."
3. Their explicit blocking dependencies + downstream consumers ("you start after impl-2 reports diff ready; your verdict gates the commit").
4. Hard constraints from this CLAUDE.md (Iris Xe rules, same-diff doc updates, etc.) — don't assume they read it.

### When to skip the full team

Trivial work — direct orchestrator edit, NO agent at all:
- Single-file SVG path tweak, single typo fix, single comment change, single env var add, regenerate a derived file from a script you already wrote.
- These are 5-line edits. Dispatching even a single Implementer for these wastes a full agent context.

Light work — flat 2-agent team:
- ≤ 100 LOC change, doc edit, scoped refactor in a single file with deterministic tests.
- Composition: 1 ultrathink Implementer + 1 ultrathink Auditor (combined-lens: spec + regression + adversarial in one prompt).
- Spawn both in one message with shared `team_name`.

Full team — every other case (DEFAULT):
- 3D, Blender, backend, money paths, anything > 100 LOC or > 3 files.
- 5 agents in one parallel dispatch as the table above.

High-stakes work (DB migrations, custodial keys, auth, billing, scale-system rewrites) → ALWAYS full team + a `reconciler-manager` that re-implements independently and compares against impl-1. No exceptions.

**Test: would the cost of getting this wrong justify ~5× parallel agent invocations?** If no → light or direct. If yes → full team. When in doubt, full team. The orchestrator's job is to never become the bottleneck.

### Concerns: sequential or parallel?

Truly independent concerns (different files, no shared state) — spawn separate teams in parallel, each with its own `team_name`. Concerns that share state or build on each other — single team, sequence via task dependencies. Default to sequential when in doubt.

### Orchestrator responsibilities (never delegated)

Decompose into concerns · pick team composition + team_name · spawn the team in one parallel Agent call · monitor task state via TaskList polling · resolve audit-disagreement protocol (DON'T silently drop blocking issues) · build / push / deploy (manual Coolify tinker when webhook misses) / browser verification.

### 3da context

Agent def at `.claude/agents/3da.md`; memory at `.claude/memory/threejs/` (`gotchas/`, `patterns/`, `solutions/`, `performance/`, `webgpu/`, `MEMORY.md`). Both committed. Migrated into project 2026-04-16 — do NOT use user-level paths.

**3da burns prevented:** `InstancedMesh + ShaderMaterial` silent WebGPU crash, drei `<Text>`/`<Billboard>` killing Iris Xe, per-frame `new Vector3()` GC thrash, pipeline compile spikes, rotation sign errors.

### Blender notes

User's local Blender is exclusive. Tell blender07 to launch a NEW Blender instance, or fall back to direct GLB downloads (Polyhaven, Sketchfab CC0/CC-BY, Kenney, Quaternius). Don't loop on Blender exclusivity.

---

Sea-themed OpenClaw game on ElizaOS. Users create an avatar, explore a 3D/2D sea-floor world with 10 buildings, chat with AI agents teaching OpenClaw development.

## IMPORTANT: ElizaOS is MANDATORY

Core requirement — do NOT remove or stub. Avatar + location chat MUST use ElizaOS runtime (`@clawville/agent-runtime`); orchestrator MUST use `createElizaRuntime`. Deploy to persistent-server platforms (Hetzner+Coolify, Render, Fly.io) — NOT Vercel serverless. Never replace with direct API calls or stubs.

## MANDATORY: Gameplay changes update system agents' knowledge in the same diff

**System agents** = world-wide NPCs not tied to a building. Today: Nori the Town Guide, slug `town-guide`. Plural scaffolding from day 1 (future: arena host, quest giver, lore-keeper). Their expertise is ClawVille ITSELF (modes, 10 buildings + teachers, economy, connect flow, daily login, tutorial, paused features). Knowledge in `packages/agent-templates/src/locations/<slug>.ts` → `knowledge[]`, registered in `SYSTEM_AGENT_TEMPLATES`, chunked into ElizaOS RAG on every API boot via `ensureSystemAgents()` in `apps/api/src/services/system-npc-seeder.ts`.

**Rule:** any gameplay/world change (new mode, building, token formula, quest type, paused feature, connect flow, renamed building, moved NPC, leaderboard weight) MUST update the correct system agent's `knowledge[]` same diff. Town Guide: `packages/agent-templates/src/locations/town-guide.ts`. Skip = broken onboarding.

**Chat:** `POST /api/chat/system/:slug`. Lookup `getSystemAgent(slug)`. Platform type `'system-agent'`; slug at `customization.slug`. No `location_agents` row. 3D click handler `apps/web/src/lib/three/town-guide.tsx`. **Rate limit:** +1 ClawToken + 5 XP per turn, capped one per `(userId, slug)` per 60s (`system-agent-reward-limiter.ts`). Logs `chatType: 'system-agent'` — does NOT inflate `/dash` teacher-chat metric (teachers = 10 residents only).

**Add new system agent:** (1) write template, (2) register in `SYSTEM_AGENT_TEMPLATES`, (3) ship — `ensureSystemAgents()` upserts on boot. Partial unique index `platform_agents_system_singleton` guarantees one row per (userId, type='system-agent', slug).

**Goes in `knowledge[]`:** one-sentence "what ClawVille is", 4 game modes, 10 buildings + teachers + focus, Moltbook connect flow, Milady sideload path, ClawToken rules, leaderboard weights, quest/bounty state, tutorial. **Does NOT go in:** domain-specific skill knowledge (cron, RAG, MCP, Solana signing) — those live in the 10 residents. Rule: "point at the teacher, don't replace." Orientation → update Nori. Internal (migration, refactor, infra) → skip.

## Tech Stack

Turborepo + Bun monorepo. **Frontend:** Next.js 16 App Router (`cookies()`/`headers()`/`params` async — always `await`), Three.js (3D) + PixiJS 8 (2D fallback), Zustand, TanStack Query, Tailwind. **Backend:** Hono 4.x on Bun. **DB:** PostgreSQL + Drizzle ORM (Supabase paid tier). **AI Runtime:** ElizaOS 2.0.0-alpha (plugin-openai, plugin-sql; bootstrap built-in). **Auth:** Lucia 3.x + Drizzle adapter.

## Project Structure + Commands

`apps/web` (Next.js + 3D/2D game, port 3000) · `apps/api` (Hono REST, port 4000) · `packages/shared` (types + constants) · `packages/database` (Drizzle schema + migrations) · `packages/agent-runtime` (ElizaOS wrapper) · `packages/agent-templates` (10 location + system-agent templates). All `@clawville/*` prefix.

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
- `GEMINI_API_KEY` — **single LLM backend** for text + embeddings (`gemini-text-provider` priority 95, `gemini-embedding-provider` 100, `npc-conversation-engine.ts`). Anthropic removed 2026-04-10.
- `VANITY_ENCRYPTION_KEY` — 64-char hex. AES-256-GCM master key for `treasury_wallets` + `vanity_keypairs`. Must match on every decrypting machine.
- `FINGERPRINT_SECRET` — 64-char hex (32+ bytes). **Hard-required** — `apps/api/src/middleware/fingerprint.ts` throws at module load if missing or short, crashing API boot. `openssl rand -hex 32`. Salts the sha256 hash of `X-CV-Fingerprint` + IP /24 prefix on every event row. Server-only. Rotating invalidates every existing fp_hash.
- `CLAWVILLE_MERCHANT_WALLET_PUBKEY` — base58 pubkey of Phase 4 x402 merchant wallet.
- `CORS_ORIGIN` — frontend URL(s) (prod `https://clawville.world`).
- `NEXT_PUBLIC_API_URL` — backend URL (prod `https://api.clawville.world`).
- `ADMIN_USER_IDS` — comma-separated UUIDs allowed on `/api/dashboard/*` + `/dash`. Parsed at module load; changes require redeploy. See `middleware/admin-only.ts`.
- `ITACHI_DEBUG_BOT_TOKEN` + `ITACHI_DEBUG_CHAT_ID` — itachi-debug Telegram bot for `alert-error.ts`. Missing ⇒ degrades to `console.warn`. Staged via tinker from `~/.itachi-api-keys`.
- `METRICS_MEASUREMENT_START` — ISO date for `/dash` "Measuring since …" banner. Default `2026-04-21`.
- `AGENT_SESSION_TICKET_TTL_SECONDS` — Phase 5 magic-link TTL (default 600, min 60, max 3600 — `session-ticket-service.ts`).
- **Phase 5.1** (full descriptions in `.claude/plans/phase5.1-wallet-identity-and-scape-portal.md`):
  - `CLOUDFLARE_WORKER_URL` + `CLOUDFLARE_WORKER_BEARER` — envelope-encryption Worker `/wrap` `/unwrap`. `infra/cf-secrets-worker/`.
  - `CLAWVILLE_SERVICE_ISSUER_SK` / `_PUBKEY` — Base58 ed25519 pair; SK signs outbound partner calls, PK at `/.well-known/clawville-issuer.json`. Generate via `scripts/generate-service-issuer-keypair.ts`.
  - `SCAPE_HOSTED_SESSION_URL` + `SCAPE_WEB_ORIGIN` — 'scape `/hosted-session/issue` endpoint + redirect origin.
  - `PARTNER_PUBKEYS` — `{"scape":"<base58>"}`. Empty ⇒ inbound portal returns 401.
- **Wager program** (2026-05-12, `clawville_wager` `HgQhHVYV2C5Mw8K81kEnADkqsuS5YQRmGJDUR5wnZVuG` devnet):
  - `SOLANA_RPC_URL` (default `api.devnet.solana.com`; prod stays devnet until `wager-mainnet-paid` graduates).
  - `WAGER_SETTLEMENT_AUTHORITY_PUBKEY` — must match decrypted `treasury_wallets.purpose='wager-settlement-authority'`. Default = devnet deployer `G5WgvGYK5mLxQbVUmNhFKeWwEhT235p2HjKmkbpMbMWy`.
  - `WAGER_SETTLEMENT_AUTHORITY_KEYPAIR_PATH` (local seed only, never prod). `WAGER_PROGRAM_CLUSTER` = `'devnet'`/`'localnet'`; mainnet requires a code change.

**Optional:** `OPENAI_API_KEY` — fallback ONLY for `npc-conversation-engine.ts` on Gemini `GEMINI_MAX_FAILURES` backoff. Not a general replacement.

**Removed:** `ANTHROPIC_API_KEY` (ultrathink decommission — see `docs/ultrathink-migration-decision.md`).

## Deployment — Hetzner + Coolify

**Production is self-hosted Hetzner CCX13 on Coolify. Railway decommissioned.**

### Infrastructure

Two Hetzner VPS hosts since the 2026-05-23 migration:

- **Production:** `<PROD_VPS_IP>` (real IP in gitignored `scripts/deploy/.env.deploy` under `PROD_VPS_IP=…`), Hillsboro (us-west), Coolify 4.1, SSH key `~/.ssh/clawville_hillsboro` (passphrase — load into Windows ssh-agent once with `ssh-add`). Serves `clawville.world` + `api.clawville.world`.
- **Staging:** `<STAGING_VPS_IP>` (real IP in `STAGING_VPS_IP=…`), Ashburn, Coolify 4.0, SSH key `~/.ssh/clawville_deploy`. Serves `staging.clawville.world` + `api-staging.clawville.world`. Shares prod Supabase — any staging write touches prod data.

Both run Coolify + Traefik + Let's Encrypt. DNS: Cloudflare-proxied (subdomains in `scripts/deploy/.env.deploy`). DB: Supabase Postgres (endpoint in env) — single instance shared across prod + staging.

### Coolify app IDs

| Env | App | ID | UUID env-var | Domain |
|---|---|---|---|---|
| prod    | api | 2 | `API_APP_UUID`         | `api.clawville.world` (+ `api-new.clawville.world`) |
| prod    | web | 3 | `WEB_APP_UUID`         | `clawville.world` (+ `new.clawville.world`) |
| staging | api | 3 | `STAGING_API_APP_UUID` | `api-staging.clawville.world` |
| staging | web | 4 | `STAGING_WEB_APP_UUID` | `staging.clawville.world` |

Both pull from `github.com/ItachiDevv/ClawVille` via the SAME shared deploy key (exported from old box, imported on new), auto-deploy on push to `master`. Web ~3–5 min, api ~2–3 min. Verify: `curl -sS --ssl-no-revoke https://api.clawville.world/health`.

**Coolify admin UIs:** prod at `https://coolify-new.clawville.world` (eventually rename to `coolify.clawville.world` after 24h soak), staging at `https://coolify-staging.clawville.world`. Both use the same admin credentials (mirrored on migration).

### Deploy paths — prefer the script, do not hand-roll tinker

| Goal | Path |
|---|---|
| Normal code deploy | `git push origin master` (Coolify auto-build via deploy key on PROD) |
| Force-redeploy prod / missed webhook | SSH in (PROD key), then `bash scripts/deploy/clawville-deploy.sh` (wraps both api id=2 + web id=3 tinker) |
| Deploy to staging only | SSH in with `~/.ssh/clawville_deploy`, then targeted tinker against app IDs 3 (api) / 4 (web) |
| Env-var add/update | SSH in, run targeted tinker per template below |

### Manual redeploy via SSH tinker (env-var add/update — swap the closure body)

Load IPs first: `source scripts/deploy/.env.deploy` (gitignored). PROD uses `~/.ssh/clawville_hillsboro` (passphrase — must be in ssh-agent), STAGING uses `~/.ssh/clawville_deploy`. Then:

```bash
# PROD (new box, IDs are api=2 web=3)
ssh root@$PROD_VPS_IP \
  "docker exec coolify php artisan tinker --execute='
    use App\\Models\\Application;
    \$app = Application::find(2);  // prod: 2=api, 3=web
    \$uuid = (string) new \\Visus\\Cuid2\\Cuid2;
    queue_application_deployment(application: \$app, deployment_uuid: \$uuid, is_api: true, no_questions_asked: true);
    echo \$uuid . PHP_EOL;
  '"
```

> **Encryption gotcha (learned 2026-05-23 migration):** never write to `environment_variables.value` via raw `DB::update()` with `\Crypt::encryptString(...)` — Coolify's `EnvironmentVariable` model has a mutator that re-encrypts on save, and raw-SQL writes produce values the model's decrypt accessor cannot read, which breaks `queue_application_deployment` with a `decrypt()` exception during the build step. ALWAYS write via the Eloquent model: `$row->value = '<plaintext>'; $row->save();` — the mutator handles encryption correctly.

For env-var add/update on existing keys, use the model: `$app->environment_variables()->where('key', '<KEY>')->first()->update(['value' => '<plain>'])`. For new keys: `$app->environment_variables()->create(['key' => '<KEY>', 'value' => '<plain>', 'is_runtime' => true])`. Coolify auto-rebuilds on next deploy.

**Database package rebuild:** Coolify builds from source so `packages/database/dist/` auto-refreshes on deploy. For local scripts importing `@clawville/database`, run `cd packages/database && bun run build` first.

### Provisioning scripts (`scripts/deploy/`)

`provision-hetzner.sh` (VPS via Hetzner Cloud API, `HCLOUD_TOKEN`) · `setup-cloudflare-dns.sh` (A records web/api/coolify) · `bootstrap-server.sh` (Docker + Coolify + firewall on fresh Ubuntu) · `add-zone-to-cloudflare.sh` (add zone + swap Namecheap NS) · `.env.deploy` gitignored.

### Database migrations

`bun run db:push` from root before deploy if you touched `packages/database/src/schema/*.ts`. Coolify does NOT run migrations — Drizzle push is manual. Destructive migrations need `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true`.

### Testing rule — NEVER run `bun run dev` locally

Intel Iris Xe crashes on the Three.js/WebGPU scene and needs a PC restart. Always: push → Coolify auto-deploys → test against prod.

### MANDATORY: Browser verification after every deploy

After every push to master, verify visually. NOT optional.

1. Wait for Coolify (~3–5 min, or `curl -sS --ssl-no-revoke https://api.clawville.world/health`).
2. Open `https://clawville.world/game` via Chrome MCP or ask for screenshot.
3. Check: buildings visible + not clipped by atmosphere planes, camera zoom works, player spawns at center, FPS > 50, no console errors.
4. If Chrome extension disconnected, tell user "I cannot verify in browser — please screenshot".
5. **NEVER claim a visual fix done without seeing it.** "I pushed the code" ≠ verification.

### Emergency access

PROD: `ssh root@$PROD_VPS_IP` (uses `~/.ssh/clawville_hillsboro` via Windows ssh-agent — `ssh-add` it once with the passphrase, persists across reboots). STAGING: `ssh -i ~/.ssh/clawville_deploy root@$STAGING_VPS_IP`. Load both IPs from `scripts/deploy/.env.deploy`. Container restart `docker restart <name>` · Coolify UI subdomains in env (`https://coolify-new.clawville.world` prod, `https://coolify-staging.clawville.world` staging) · logs `docker logs --tail 200 <name>` · Coolify DB `docker exec coolify-db psql -U coolify -d coolify -c "<sql>"` (NOT the ClawVille app DB — that's Supabase) · full playbook `docs/DEPLOY-HETZNER.md`.

**Emergency rollback (prod → staging):** the staging box has the exact same containers/DB as it had when it was prod. To revert, flip Cloudflare A records for `clawville.world` + `api.clawville.world` from `$PROD_VPS_IP` back to `$STAGING_VPS_IP` (~30s propagation), then re-add the prod FQDNs to the staging Coolify apps (Application::find(3 for api / 4 for web)->fqdn = '...,https://clawville.world' + redeploy). Reverse the same steps once the prod issue is fixed.

### Curl gotcha on Windows

Git Bash uses schannel and rejects CRLs — always pass `--ssl-no-revoke`.

## Game Modes

4 modes. **Without agent:** (1) **Explore** — floating spectator, free camera, no character ties; (2) **NPC** — control centered NPC before connecting. **With agent:** (3) **Control** — full manual (WASD/joystick, building entry, chat init); (4) **Autonomous** — connected agent explores on its own. State: `controlMode` in Zustand `game.ts` — `'explore' | 'npc' | 'player' | 'autonomous'`.

## Architecture Notes

- **3D primary / 2D fallback**: Three.js `World3DCanvas` + PixiJS `PixiCanvas` share Zustand state. Arena: `Arena3DCanvas` + `ArenaCanvas`.
- **Agent lifecycle**: lazy-start on first chat, auto-stop after 30min inactivity. Orchestrator `agent-orchestrator.ts`.
- **One avatar per user** — unique constraint `avatars.userId`.
- **Building zones**: 10 locations in `map-locations.ts`. **NPC simulation** `npc-simulation.ts` (pathfinding, convos, activities).

## 10 SpongeBob-Landmark Buildings

Source: `packages/shared/src/constants/map-locations.ts` + `building-types.ts`. Old sea-themed names (Tide Clock Grotto, Hydrothermal Forge, etc.) were superseded.

| ID | Display | OpenClaw Focus |
|---|---|---|
| cron-automation | Downtown Building | Automation & Workflows |
| api-integrations | Salty Spitoon | APIs & Integrations |
| memory-rag | Squidward's House | Memory & Knowledge |
| code-development | Chum Bucket | Code & Development |
| messaging-channels | Sandy's Treedome | Communication |
| mcp-tool-use | Krusty Krab | Tool Use & MCP |
| visual-creation | Pineapple House | Visual Creation |
| app-publishing | Boating School | App Publishing |
| agent-security | Patrick's Rock | Crypto & Web3 |
| deployment-ops | Lighthouse | Business & Productivity |

All 10 are shop buildings for knowledge books (visit + chat MiladyAI teacher to learn). Paid marketplace write paths return 503 — see Priority #3.

## Database Schema

- `users` + `sessions` — Lucia auth.
- `avatars` (one per user) — identity (`name`, `species`, `color`, `gender`, `archetype`, `personality`, `stats`); **Phase 2 agent framework** `model_key` (default `lobster`), `agent_category` (`openclaw`/`hermes`/`milady`/`other`, default `openclaw`), `harness` (`openclaw`/`hermes`/`milady`/`custom`, default `milady`) — NOT NULL w/ DEFAULTs + CHECK `avatars_agent_category_valid`; VRM-ready (`avatar_type` `glb`/`vrm`, `avatar_url`, `vrm_metadata` JSONB); position + activity + economy + progression + `wallet_address` (base58 custodial Solana) + `platform_agent_id` → `platform_agents`.
- `avatar_inventory` — books + quantity.
- `map_locations` — static, seeded, 10 buildings.
- `location_agents` — user's agent config per location.
- `platform_agents` + `platform_agent_logs` — ElizaOS agent records.
- `openclaw_bots` — external agent identity, gateway config, learned knowledge.
- `treasury_wallets` — team merchant supply (x402 receiver, per-purpose via `treasury_purpose` enum; never user-facing).
- `wallets` — unified per-subject custodial (`subject_type='avatar'|'agent'|'treasury-reserved'`). Encrypted Solana keypairs; Phase 5.1 adds envelope encryption via CF-held KEK with per-row DEKs, version-dispatched at read.
- `agent_configs` — export/import bundle (round-trips `modelKey`/`agentCategory`/`harness`).
- `bazaar_listings` + `auctions` + `claw_token_transactions` — marketplace + economy ledger.

## ClawToken Economy / Books / Daily Login / Archetype

- `clawTokens` int col (default 100) on `avatars`. 20 books in `knowledge-books.ts` (2/building). Themes in `BUILDING_OPENCLAW_THEMES`.
- Shop API: `apps/api/src/routes/items.ts` — `GET /shop/:buildingId`, `GET /inventory`, `POST /buy`, `POST /learn`. Buy → inventory → "Read to Avatar" → merges into `characterConfig.knowledge[]` → agent restart.
- Dynamic context via `processMessage(dynamicContext)` prepended. Avatar chat injects token balance + knowledge count + NPC world state. Location chat injects visitor info + shop items + OpenClaw theme; +1 token per message.
- **Daily login** `POST /api/avatars/me/daily-login` — `10 + streak * 5` (max 100). Resets on missed day.
- **Heartbeat** `POST /api/avatars/me/heartbeat` — position + activity; updates `lastActiveAt` fire-and-forget.
- **Archetypes** — 14 in `avatar-archetypes.ts`. `avatars.archetype` varchar; `characterConfig` JSONB stores resolved.

## Agent Connection (Moltbook Pattern)

Agent-initiated — humans never paste credentials. Full flow: `GameFeatures.md`.

**Quick Connect:** click "Generate Connect Link" in `agent-connect-modal.tsx` → `POST /api/agent/connect-token` returns `{token, connectUrl}` → human pastes into agent chat → agent reads SKILL.md, calls `POST /api/agent/connect {connectionToken}` → frontend polls `GET /api/agent/connect-status/:token` 2s → auto "Connected".

**API:**
- `POST /api/agent/connect-token` — 5-min token (auth cookie).
- `GET /api/agent/connect-status/:token` — poll status.
- `GET /api/agent/connect-skill?token=xxx` — SKILL.md (alias `/api/skills/connect`).
- `POST /api/agent/connect` — universal registration (accepts `connectionToken`).
- `POST /api/agent/export-character` — **Phase 3** Milady-installable bundle: `{character, skillPack, miladyInstallPayload, installCommand, exportedAt, summary}`. Accepts `{avatarId, targetHarness?, miladyBaseUrl?}`. `character.knowledge` intentionally empty (ElizaOS v2 treats knowledge strings as FS paths — skill pack is authoritative RAG carrier). Phase 4a UI wraps one-click install.
- `POST /api/openclaw/register` — legacy manual gateway.

**Manual Connect** (power users): legacy form in modal's "Manual" tab — Gateway URL + Auth Token + Agent ID + Protocol. ClawVille calls out to agent's API.

**Identity Types:** `openclaw`/`ironclaw` (OpenAI-compat gateway) · `nanoclaw` (self-managed SSE pull) · `milady` (inside plugin, zero config) · `custom`/`anonymous`.

**Building Themes:** `BUILDING_OPENCLAW_THEMES` maps building → focus; NPC conversations inject as dynamic context.

## Phase 5.1 — Wallet Identity + 'scape Portal

Full spec: `.claude/plans/phase5.1-wallet-identity-and-scape-portal.md`. Load-bearing invariants:

**Two-keypair split (both ed25519), day 1, no shortcut:**
- **Identity** — pubkey at `users.identity_pubkey` (rotatable). Agent holds private key at `clawville:identity:<userId>`, signs reconnect challenges. Envelope-encrypted backup at `users.identity_encrypted_sk` for support-recovery only. Never on-chain, never funded, never signs txs.
- **Avatar wallet (Solana)** — in `wallets` as `{subject_type='avatar', subject_id=avatar.id}`. Server holds authoritative private key (envelope-encrypted under CF KEK), signs $CLAWVILLE custodially. Plaintext shown to human **exactly once** in first-connect; agent stores only pubkey.
- **Service issuer** (singleton) — SK in CF Secrets Store; PK at `GET /.well-known/clawville-issuer.json`. Signs outbound partner calls.

**Blast-radius.** Agent config leak ⇒ login + 'scape cross, NOT $CLAWVILLE drain. DB dump ⇒ ciphertext only (unwrap needs CF KEK). User wallet-backup leak ⇒ only that user's $CLAWVILLE.

**First-connect.** `POST /api/agent/connect` + `POST /api/agent/join` return `identity` + `wallet` blocks when secrets fresh-generated; subsequent calls omit `secretKey` (server NEVER returns again). SKILL.md instructs agent: store identity SK in config, wallet PUBLIC address in config, display wallet address + secret to human ONE TIME. Top-level `walletAddress` = agent's internal bot wallet (bookkeeping); `wallet.address` = human's avatar wallet.

**Reconnect:** `POST /api/agent/challenge` (nonce) + `POST /api/agent/reconnect` (signature). Wallet key not involved.

**'scape portal** (ClawVille ↔ `github.com/Dexploarer/scape`) — bidirectional, signature-based, no shared bearer secrets:
- **Outbound** — `POST /api/portal/scape` (Lucia-authed). Signs `sha256(canonical-JSON body)` with service issuer SK, POSTs to `SCAPE_HOSTED_SESSION_URL` with `X-Clawville-Issuer-Pubkey` + `X-Clawville-Signature`. First crossing auto-provisions: `principalId = principal:clawville:<user.id>`, `worldCharacterId = cv-<avatar.id>`.
- **Inbound** — `POST /api/portal/mint-for-scape` verifies `X-Scape-*` against `PARTNER_PUBKEYS.scape`, mints Phase 5 ticket, returns `{redirectUrl}`.
- **Link existing** — `POST /api/portal/scape-link-code` (one-time code) → paste in 'scape UI → 'scape `POST /api/portal/accept-scape-link` with signature. Consumes `pending_account_links`, sets `users.linked_scape_*`. Portal-minter prefers linked thereafter.

Every crossing + link emits `portal.scape.crossed` / `portal.scape.linked` — `/dash` auto-tracks.

## Code Style

TypeScript strict. Bun for API, Next.js for web. Kebab-case files, PascalCase components. Zod on all API inputs. `@/` path alias in web; `@clawville/*` for packages.

## Memory System
<!-- itachi-memory-system v5 -->

Itachi Memory System for persistent context across sessions. Two pools: `<project>` (this repo) and `_global` (cross-project).

### RULE 1 — Recall before you act (MANDATORY)

BEFORE working on anything you're not deep in, query memory for prior lessons. You don't pay the learning tax twice.

**Triggers:** new MCP server; unfamiliar lang/framework; specific system (Supabase RLS, systemd, Docker, Coolify, Helius, Stripe …); accumulating topic (`tokenomics`, `vrm-avatars`, `webgpu-shaders` …); error you might have solved before; unfamiliar API/SDK.

**How** — query both pools (POST `$ITACHI_API_URL/api/memory/search` w/ `Authorization: Bearer $ITACHI_API_KEY`):

```bash
for SCOPE in "$(basename "$PWD")" "_global"; do
  curl -sk -X POST "$ITACHI_API_URL/api/memory/search" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $ITACHI_API_KEY" \
    -d "{\"project\":\"$SCOPE\",\"category\":\"lesson\",\"limit\":8,\"query\":\"$TOPIC\"}" \
    --max-time 5
done
```

Higher `metadata.confidence` + `outcome:"success"` = stronger signal.

### RULE 2 — Record what you learn the moment you learn it (MANDATORY)

DURING the session, record anything non-obvious immediately. Session-end extraction is a safety net, not primary capture.

**Triggers:** error solved that docs don't cover; quirk/constraint/API surprise; non-obvious pattern that worked; A failed + B succeeded (record both + why); correct default/flag/version found after trial.

**Scope:** `_global` for tool/lang/framework quirks (default); `<current project>` for repo-specific.

POST `/api/memory/create` with `category: "lesson"`, one-line `summary` ("WHEN X, DO Y because Z"), `content`, `metadata.confidence` starting 0.6, `lesson_category` ∈ `tool-usage|debugging|pattern|constraint|workflow`. Confidence climbs when confirmed, decays when contradicted — reinforcement loop.

### RULE 3 — Category discipline

Only production lesson category is `lesson`. Do NOT write to `task_lesson` or `project_rule` (test fixtures, zero prod rows).

### RULE 4 — Drive the test yourself, don't loop the user (MANDATORY)

When user reports broken — reproduce end-to-end YOURSELF before asking them. "Try again / what do you see" loops are laziness. Confirm via DOM/logs, not speculation. Telegram repro recipe + ElizaOS silent-`Response discarded` signatures live in `_global` lessons — `/recall telegram itachi`.

### RULE 5 — NEVER ASSUME, always verify (MANDATORY)

Before saying something is true/working/deployed/fixed — VERIFY. "I think", "should", "probably", "likely works" are banned unless immediately followed by verification.

**Verify by claim:** "Deployed" → `curl` live or grep bundle. "Fix works" → rerun repro, attach output. "Build passes" → `bun run build`, paste exit code. "Tests pass" → `bun test`, show summary. "Env var set" → `ssh … env | grep FOO`. "File contains X" → `Read`. "Function Y exists" → `Grep`. "Telegram got msg" → `journalctl` AND DOM. "Memory written" → query DB or `/api/…/get`, show row.

Banned without same-response evidence: "should work", "looks right", "logic is correct", "probably compiles", "I'm confident …".

When verification is impossible, say so: *"I wrote the code but can't run the build here."* Claiming it works without checking is lying — has cost this project thousands.

### RULE 6 — NEVER BE LAZY: if you find a bug, fix it (MANDATORY)

Zero tolerance for noticing a problem and walking past it. Every bug, broken check, stale comment, wrong env var, dead import, failing test, or misconfig gets fixed — even if they didn't ask.

- **Noticing ≠ fixing.** Senior engineer wouldn't leave it? Fix it.
- **Never "note it for later."** Small → fix this session. Large → real task (Supabase, Linear, GitHub).
- **Check BEFORE acting.** Read code, grep helpers, check current state.
- **Before declaring done:** run code, read output, verify end-to-end. Tests + build + live-check green = done.
- **Exhaust alternatives before escalating.** Escalate only with evidence: "Tried A (error X), B (error Y), C (error Z) — blocked by [root cause]".
- **No surface-level audits.** Claim it works = you actually read + ran + checked.

### Commands

- `/recall <query>` — semantic search (wraps RULE 1)
- `/recent [limit]` — recent changes in this project
- `/itachi-init` — install/upgrade this block

### Memory Categories

Auto-categorized by PostToolUse hook: `code_change` (default), `test`, `documentation` (.md), `dependencies` (package.json, requirements.txt). Lessons + facts use `category: "lesson"` (knowledge) or `category: "fact"` (state).

### Disable

Create `.no-memory` at project root.

## Audit + Bug Fix Policy

After implementing a plan: use a collaborative team to audit against the plan, find + fix bugs, then re-audit with a new team. Bug found = bug fixed. Never skip or ignore.

## Documentation Update Policy

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
- "I'll update the docs later" is not acceptable.
- `3dStructure.md` + `GameFeatures.md` are gitignored working drafts but must stay accurate.
- Bump "Last Audited" every time you touch a doc.

**Anti-bypass:** shipping only a memory entry instead of the doc update is the same violation as skipping the doc. Order: (1) code change, (2) matching doc edit, (3) optional memory entry.

## ZERO LAZINESS POLICY

This is non-negotiable. Violations mean replacement by Codex.

- **Use the right tool immediately.** If a skill exists (`/browser-live`, `3da`), use it on the first attempt.
- **Fix every bug when found.** No noting, no deferring.
- **Test for real.** `/browser-live` for runtime, `curl` for API, deploy + verify. If you claim it works, you actually checked.
- **Act, don't narrate.** Results, not paragraphs.
- **Verify, don't guess.** Run the command. Read the file. "This should work" ≠ verification.
- **All code is reviewed.** Codex audits everything. Ship work you'd defend.

### Feature Gates — enforce "no scaffolding theater"

Every scaffolded feature (compiled but not in user flow) MUST carry a `FEATURE_GATE` comment with: metric to graduate, current `/dash` reading, review deadline, on-deadline action.

Features whose deadline lapses without metric being met are DELETED, not extended. Gate renewal must reference a new metric reading, not "we still think we want this."

Gate block format:
```ts
// FEATURE_GATE: <name>
// Status: <where the scaffold is today>
// Metric to graduate: <measurable threshold>
// Current reading: <last /dash value or "to fill">
// Review deadline: YYYY-MM-DD
// On deadline: <what happens if metric not met>
// Reference: <Brand Identity / improvements.md §7 / related doc>
```

Active gates as of 2026-04-21: `x402_payment_middleware`, `multi_agent_roster`, `skill_marketplace` (bazaar, marketplace, auctions). See `improvements.md` §7.

### No lazy handoffs — full ship loop is YOUR job

"Implement" means the **whole loop**: commit + push + verify deploy + verify in browser.

**When `git push` fails, try ALL of these before escalating:**

1. `gh auth status` — if a `gh` keyring token w/ `repo` scope exists: `unset GITHUB_TOKEN && gh auth setup-git && git push origin master`.
2. `git remote -v` — if HTTPS blocked, check `~/.ssh/` for a github key, `git remote set-url origin git@github.com:USER/REPO.git`, retry.
3. `env | grep -iE "gh_token|github_token"` — invalid `GITHUB_TOKEN` env beats a good keyring token. Unset first.
4. `gh api` / `gh pr create` for PR-style flows.

Only after EVERY option fails — with specific errors — may you ask the user to push. Quote the failures.

**Same rule every step of the ship loop:**

| Step | If the obvious path fails, try |
|---|---|
| Push | `gh auth setup-git`, SSH remote, `gh` CLI |
| Trigger deploy | Webhook, manual `php artisan tinker` via SSH |
| Verify deploy | Container uptime via SSH, `curl /health`, scan bundle via `fetch` in browser-live |
| Verify in browser | `browser-live` CDP eval, scan JS bundles for known-string constants, inspect scene graph |

"I tried one thing and it failed, over to you" is never acceptable. Test: would a senior engineer with these tools stop here? If not, keep going.
