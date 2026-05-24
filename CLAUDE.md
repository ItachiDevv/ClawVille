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

### File-path trigger table (MANDATORY — read the matching doc BEFORE editing)

| Editing files matching… | Must have read |
|---|---|
| `apps/web/src/lib/three/**`, `apps/web/src/components/three/**`, `apps/web/public/models/**` | `3dStructure.md` (+ spawn `3da` for non-trivial 3D work) |
| `apps/web/src/components/game/**`, token-economy code, `packages/shared/src/constants/knowledge-books.ts`, `avatar-archetypes.ts`, `map-locations.ts`, quest/login routes | `GameFeatures.md` |
| `apps/api/src/routes/portal/*`, `services/cf-secrets-*`, `services/service-issuer.ts`, `services/auth-challenge.ts`, `services/identity-service.ts`, `services/keypair-vault.ts`, `services/wallet-service.ts`, anything under `users.identity_*` / `wallets.dek_wrapped` | `ARCHITECTURE.md §7` (Phase 5.1) |
| `apps/api/src/services/wager-program-client.ts`, `apps/api/src/routes/wager.ts`, `contracts/wager/**`, `packages/wager-program/**`, anything touching `treasury_purpose='wager-settlement-authority'` | `ARCHITECTURE.md` (wager rows §2/§4 + recent changes §13) |
| `apps/api/src/routes/agent.ts`, agent-connect modal, `/api/agent/*` | `GameFeatures.md §2` + `ARCHITECTURE.md §6` |
| Any new Hono route, Drizzle schema change, service file, env var, deploy/CI config | `ARCHITECTURE.md` |

**Same-diff rule:** every code change above MUST update its matching doc in the same diff. Bump "Last Audited" + one-line drift note.

**Animation shipping — STRICT (2026-05-18).** Any Mixamo/VRM clip add/remove/retarget/trigger MUST satisfy the 9-point checklist in `3dStructure.md` §6f (bundle into `_emotes.glb`, `preloadClips(names)` for non-locomotion warming, `ASSET_PATH_PREFIXES` in `sw.js`, `updateViaCache:'none'` + `reg.update()`, NPC entity-interp not extrapolation, `updateMixerOnly` every frame, `setSurfaceClip` for state-held, all humanoid VRMs sized via `VRM_AVATAR_TARGET_HEIGHT_WU`, **bump `?v=N` query when mutating an asset at an existing path** — Cloudflare's 1-week edge cache cannot be purged via our deploy token, so the URL query is the only invalidator).

### Kill-the-build invariants — ALWAYS-ON (never demoted to a referenced doc)

These cost real money / crash the GPU / leak secrets. They stay inline regardless of scope.

- **PUSH FLOW — staging-first (set 2026-05-24):** ALL new work goes to the `staging` branch first. `git push origin staging` → `.github/workflows/deploy-staging.yml` ships to the staging box → verify on `https://staging.clawville.world` + `https://api-staging.clawville.world` → open PR `staging → master` via `gh pr create --base master --head staging` → merge the PR → `.github/workflows/deploy.yml` ships to prod. **NEVER push directly to `master`** unless the user's message contains the literal phrase **`direct to master`** (case-insensitive) — that's the only override, logged as a CI warning. Hotfix is the only legitimate use. Both Coolify boxes share the same Supabase DB, so a staging deploy that mutates state mutates prod data too — treat staging deploys with the same care as prod for anything that writes.
- **Iris Xe GPU:** NO drei `<Text>` / `<Billboard>` in game/world scenes — hard crash. NO `InstancedMesh + ShaderMaterial` — silent WebGPU crash. NO per-frame `new Vector3()` in `useFrame` — GC thrash.
- **Local dev:** NEVER run `bun run dev` locally (Iris Xe crash → PC restart). Push → Coolify auto-deploys → test against staging first, then prod.
- **Phase 5.1 wallet:** `wallet.secretKey` is returned **EXACTLY ONCE** on first-connect. Subsequent reads MUST omit it. SKILL.md instructs agent to display once + store only pubkey. Server never re-emits — no recovery path. Full spec: `ARCHITECTURE.md §7`.
- **Verification:** never claim deployed/fixed without evidence (curl, bundle grep, DOM read). "Should work" is banned.
- **Push-auth fallback chain:** `gh auth status` → `unset GITHUB_TOKEN && gh auth setup-git` → SSH remote → `gh` CLI. Only escalate with all errors quoted. Never hand the push to the user as the first move.
- **Asset cache-bust:** mutating an existing static asset at a stable URL (`/avatars/*.vrm`, `/avatars/animations/*.glb`, `/cosmetics/*.glb`) WITHOUT bumping a `?v=N` query in every reference is a silent 1-week regression on prod — Cloudflare's edge cache TTL is 7 days and our deploy token has zone:edit but **no cache_purge scope**, so we can't invalidate via API. Full rule + verified examples in `3dStructure.md §6f rule 9`. Diagnostic: `curl ?cache_bust=$(date +%s)` returns the new file; bare URL returns the stale one.

**Precedence (high→low):** (1) source code · (2) three canonical docs · (3) `CLAUDE.md`/`README.md` · (4) memory files (advisory). Memory vs doc → doc wins, update/delete memory same turn. Doc vs code → code wins, update doc same turn.

---

## MANDATORY: Non-trivial implementation runs as EXPERIMENTAL COLLABORATIVE AGENT TEAMS

**Status (2026-05-19):** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + `teammateMode=in-process` enabled globally. Use the real teams feature — specialist agents spawned in PARALLEL sharing a `team_name`, coordinating via `TaskList`/`TaskUpdate`/`SendMessage`. Not "one agent that recursively sub-spawns" — that's the legacy fallback, only acceptable when teammateMode is unavailable.

### ANTI-PATTERN (do not do this)

> "Dispatch one Implementer. When it returns, dispatch 3 auditors in parallel. If any block, dispatch a Fixer. Then re-dispatch."

**Wrong** — serializes 4+ round-trips per concern, turning 5 min of work into 30 min of wall-clock wait. Every dispatch = full agent context load + warm-up + streaming.

**Right pattern:** ONE parallel message spawning the WHOLE TEAM upfront (Lead Implementer + Reconciler + Spec + Regression + Adversarial auditors, shared `team_name`). They coordinate via `SendMessage`/`TaskList`; auditors block-wait on impl via task deps; fixers spawn themselves when blocked. Orchestrator only commits + pushes + verifies.

If you catch yourself thinking "auditors after implementer" — STOP. Spawn them now with `addBlockedBy: [implementer_task_id]`; they auto-start when impl flips to `completed`. Zero round-trip cost.

### When teams are mandatory

- **3D work** — Three.js / R3F / shaders / GLB / post-proc / materials / lights / cameras / TSL / WGSL / WebGPU under `apps/web/src/lib/three/**`, `apps/web/src/components/three/**`, `apps/web/public/models/**`, render-loop, animations, rigs, atmosphere/particles, new world-surface 3D objects.
- **Blender pipelines** — multi-asset exports, mesh edits, rigging, MMD/glTF/FBX imports, Mixamo, Marvelous Designer.
- **Backend / API / DB work** — Hono routes, Drizzle schemas, services, money paths, auth, custodial wallets, anything user-facing or financially load-bearing. **`bun test` green in impl's report is NOT a substitute for the Adversarial-lens audit.**
- **Any task** > 5 min runtime, > 300 LOC, or ≥ 3 files across subsystems.
- User quality verbs ("polish", "iterate", "rework", "feel like X", "elite", "professional").

Teams are the DEFAULT for the above. Solo dispatch = rare exception (trivial work — see below).

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

- **`TaskList`**: orchestrator creates one task per role with `addBlockedBy` deps. Each agent updates its own status.
- **`SendMessage`**: implementers DM auditors ("diff ready"); auditors DM back APPROVED or BLOCKING ISSUES. No silent drops.
- **Memory share** is automatic within a team_name (in-process mode).
- **Orchestrator never writes code** — decomposes, picks composition, monitors tasks, commits, pushes, polls Coolify, verifies.

### Required prompt elements

Every agent prompt MUST include:
1. Literal **"use ultrathink reasoning before writing code"** (or "before reviewing code" for auditors) in para 1 — Agent tool has no thinking-mode flag.
2. Addressable team name + role: "You are `3da-spec` in team `<team_name>`. Other members: …"
3. Explicit blocking deps + downstream consumers ("you start after impl-2 reports diff ready; your verdict gates the commit").
4. Hard constraints from this CLAUDE.md (Iris Xe, same-diff doc updates) — don't assume they read it.

### When to skip the full team

- **Direct edit, no agent:** single typo/comment/env-var/SVG path tweak, regen from a script — 5-line edits.
- **Light (2-agent):** ≤ 100 LOC or single-file doc/refactor with deterministic tests. 1 ultrathink Implementer + 1 combined-lens Auditor, shared `team_name`.
- **Full team (DEFAULT):** 3D, Blender, backend, money paths, > 100 LOC or > 3 files — 5 agents in one parallel dispatch.
- **High-stakes** (DB migrations, custodial keys, auth, billing, rewrites) → full team + `reconciler-manager` that re-implements independently and compares vs impl-1. No exceptions.

**Test:** would the cost of getting this wrong justify ~5× parallel invocations? No → light/direct. Yes → full team. When in doubt, full team.

### Concerns: sequential or parallel?

Truly independent (different files, no shared state) → separate teams in parallel, each own `team_name`. Shared state or sequenced → single team, task deps. Default sequential when in doubt.

### Orchestrator responsibilities (never delegated)

Decompose · pick composition + team_name · spawn team in one parallel Agent call · poll TaskList · resolve audit-disagreement (DON'T silently drop blocking issues) · build/push/deploy (manual Coolify tinker on missed webhook) · browser verification.

### 3da context

Agent def: `.claude/agents/3da.md`; memory: `.claude/memory/threejs/` (`gotchas/`, `patterns/`, `solutions/`, `performance/`, `webgpu/`, `MEMORY.md`). Both committed; migrated 2026-04-16 — do NOT use user-level paths.

**3da burns prevented:** `InstancedMesh + ShaderMaterial` silent WebGPU crash, drei `<Text>`/`<Billboard>` killing Iris Xe, per-frame `new Vector3()` GC thrash, pipeline compile spikes, rotation sign errors.

### Blender notes

Local Blender is exclusive. Tell blender07 to launch a NEW instance, or fall back to direct GLB downloads (Polyhaven, Sketchfab CC0/CC-BY, Kenney, Quaternius). Don't loop on exclusivity.

---

Sea-themed OpenClaw game on ElizaOS. Users create an avatar, explore a 3D/2D sea-floor world with 10 buildings, chat with AI agents teaching OpenClaw development.

## IMPORTANT: ElizaOS is MANDATORY

Core requirement — do NOT remove or stub. Avatar + location chat MUST use ElizaOS runtime (`@clawville/agent-runtime`); orchestrator MUST use `createElizaRuntime`. Deploy to persistent-server platforms (Hetzner+Coolify, Render, Fly.io) — NOT Vercel serverless. Never replace with direct API calls or stubs.

## MANDATORY: Gameplay changes update system agents' knowledge in the same diff

**System agents** = world-wide NPCs not tied to a building. Today: Nori the Town Guide, slug `town-guide`. Plural scaffolding from day 1 (future: arena host, quest giver, lore-keeper). Expertise = ClawVille ITSELF (modes, 10 buildings + teachers, economy, connect flow, daily login, tutorial, paused features). Knowledge in `packages/agent-templates/src/locations/<slug>.ts` → `knowledge[]`, registered in `SYSTEM_AGENT_TEMPLATES`, chunked into ElizaOS RAG on every API boot via `ensureSystemAgents()` in `apps/api/src/services/system-npc-seeder.ts`.

**Rule:** any gameplay/world change (new mode, building, token formula, quest type, paused feature, connect flow, renamed building, moved NPC, leaderboard weight) MUST update the correct system agent's `knowledge[]` same diff. Town Guide: `packages/agent-templates/src/locations/town-guide.ts`. Skip = broken onboarding.

**Chat:** `POST /api/chat/system/:slug`. Lookup `getSystemAgent(slug)`. Platform type `'system-agent'`; slug at `customization.slug`. No `location_agents` row. 3D click: `apps/web/src/lib/three/town-guide.tsx`. **Rate limit:** +1 ClawToken + 5 XP/turn, cap one per `(userId, slug)`/60s (`system-agent-reward-limiter.ts`). Logs `chatType: 'system-agent'` — does NOT inflate `/dash` teacher-chat metric (teachers = 10 residents only).

**Add new system agent:** (1) write template, (2) register in `SYSTEM_AGENT_TEMPLATES`, (3) ship — `ensureSystemAgents()` upserts on boot. Partial unique index `platform_agents_system_singleton` guarantees one row per (userId, type='system-agent', slug).

**Goes in `knowledge[]`:** "what ClawVille is", 4 modes, 10 buildings + teachers + focus, Moltbook connect flow, Milady sideload, ClawToken rules, leaderboard weights, quest/bounty state, tutorial. **Not in:** domain-specific skill knowledge (cron, RAG, MCP, Solana signing) — those live in the 10 residents. Rule: "point at the teacher, don't replace." Orientation → Nori. Internal (migration, refactor, infra) → skip.

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
- `RESEND_API_KEY` — Resend SDK key for transactional emails (verify-email + reset-password). Optional in dev (console fallback prints the email payload to stdout); set in prod or Resend rejects all sends. Get from https://resend.com/api-keys.
- `FROM_EMAIL` — RFC 5322 From-address for transactional emails. Default `ClawVille <noreply@clawville.world>`. Sender domain MUST be verified in the Resend dashboard before prod will actually deliver — unverified sends bounce with 403.
- **Phase 5.1 env vars** (`CLOUDFLARE_WORKER_URL/_BEARER`, `CLAWVILLE_SERVICE_ISSUER_SK/_PUBKEY`, `SCAPE_HOSTED_SESSION_URL`, `SCAPE_WEB_ORIGIN`, `PARTNER_PUBKEYS`) — see `ARCHITECTURE.md §7`. Crash-loud rule: `FINGERPRINT_SECRET` + `CLOUDFLARE_WORKER_*` are hard-required on boot; missing ⇒ API refuses to start.
- **Wager program env vars** (`SOLANA_RPC_URL`, `WAGER_SETTLEMENT_AUTHORITY_PUBKEY`, `WAGER_SETTLEMENT_AUTHORITY_KEYPAIR_PATH`, `WAGER_PROGRAM_CLUSTER`) — see `ARCHITECTURE.md §13` (2026-05-13 entry). Devnet-only; mainnet requires a code change, not just `WAGER_PROGRAM_CLUSTER=mainnet`.

**Optional:** `OPENAI_API_KEY` — fallback ONLY for `npc-conversation-engine.ts` on Gemini `GEMINI_MAX_FAILURES` backoff. **Removed:** `ANTHROPIC_API_KEY` (ultrathink decommission).

## Deployment — Hetzner + Coolify

**Production is self-hosted Hetzner CCX13 on Coolify. Railway decommissioned.**

### Infrastructure

Two Hetzner VPS hosts since the 2026-05-23 migration:

- **Production:** `<PROD_VPS_IP>` (real IP in gitignored `scripts/deploy/.env.deploy` under `PROD_VPS_IP=…`), Hillsboro (us-west), Coolify 4.1, SSH key `~/.ssh/clawville_hillsboro` (passphrase-protected — load into Windows ssh-agent once with `ssh-add`). Serves `clawville.world` + `api.clawville.world`.
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

**Coolify admin UIs:** prod at `https://coolify-new.clawville.world` (eventually rename to `coolify.clawville.world` after migration soaks 24h), staging at `https://coolify-staging.clawville.world`. Both use the same admin credentials (mirrored on migration).

### Deploy paths — prefer the script, do not hand-roll tinker

| Goal | Path |
|---|---|
| Normal code deploy | `git push origin master` (Coolify auto-build via deploy key) |
| Force-redeploy / missed webhook | SSH in, then `bash scripts/deploy/clawville-deploy.sh` (wraps both api+web tinker) |
| Env-var add/update | SSH in, run targeted tinker per template below |

### Skip-ahead-to-latest — MANDATORY when newer commits queue up

Coolify is FIFO. Push B while A is building → A finishes serving its superseded bundle, then B starts (total ≈ build_A + build_B, plus a window where users get stale A).

**Rule:** when you push and an older-commit deploy is still `in_progress`/`queued` for the same app, cancel it. Only the latest commit finishes. Two-step cancel:

```bash
# Prereq: ssh-add ~/.ssh/clawville_hillsboro once (passphrase prompt locally), then the
# Windows ssh-agent caches it for all subsequent root@$PROD_VPS_IP commands.
# For STAGING, use `-i ~/.ssh/clawville_deploy root@$STAGING_VPS_IP` instead.

# (a) Find redundant pids:
ssh root@$PROD_VPS_IP \
  "docker exec coolify php artisan tinker --execute='use App\\Models\\ApplicationDeploymentQueue; \$q = ApplicationDeploymentQueue::orderByDesc(\"id\")->limit(8)->get([\"id\",\"application_id\",\"status\",\"commit\",\"current_process_id\"]); foreach(\$q as \$r) { echo \$r->id.\"|app\".\$r->application_id.\"|\".\$r->status.\"|\".substr(\$r->commit,0,7).\"|pid:\".\$r->current_process_id.PHP_EOL; }'"

# (b) Kill the build container PID + mark queue rows cancelled (only for
#     rows whose commit ≠ your latest HEAD; never touch the latest):
ssh root@$PROD_VPS_IP \
  "kill -9 <PID> 2>/dev/null; docker exec coolify php artisan tinker --execute='use App\\Models\\ApplicationDeploymentQueue; foreach([<IDs>] as \$id) { \$r = ApplicationDeploymentQueue::find(\$id); if (\$r) { \$r->status = \"cancelled-by-user\"; \$r->save(); echo \"canceled \$id\".PHP_EOL; } }'"
```

The latest-commit row is the ONLY survivor — starts immediately if nothing else running, else runs next. Never cancel the latest, even if it's been running a while. Cancel older same-app rows `queued` first, then `in_progress`. Apply per app: prod api (id 2) and prod web (id 3) have independent queues; staging api (id 3) and staging web (id 4) on the old box have their own.

### Manual redeploy via SSH tinker (env-var add/update — swap the closure body)

Load IP first: `source scripts/deploy/.env.deploy` (gitignored). PROD uses `~/.ssh/clawville_hillsboro` (passphrase — must be in ssh-agent), STAGING uses `~/.ssh/clawville_deploy`. Then:

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

For env-var add/update, replace the closure body with `$app->environment_variables()->create([...])` (or `update([...])` on the existing row). Coolify auto-rebuilds on next deploy.

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
3. Check: buildings visible + not clipped by atmosphere planes, camera zoom works, player spawns center, FPS > 50, no console errors.
4. If Chrome extension disconnected, tell user "I cannot verify — please screenshot".
5. **NEVER claim a visual fix done without seeing it.** "I pushed" ≠ verification.

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

## Scoped detail — lives in canonical docs

These topics used to be inlined here; they're now owned by the canonical doc that already tracks them same-diff with code. Read the doc when you hit the file-path trigger above.

- **10 buildings + OpenClaw focus mapping** — `packages/shared/src/constants/map-locations.ts` + `building-types.ts`. Roster summary: `WorldContent.md §2`. Old sea-themed names (Tide Clock Grotto, etc.) are superseded.
- **Database schema (full row-level)** — `ARCHITECTURE.md §8`. Key invariants: one avatar per user (unique `avatars.userId`); `wallets` is the unified custodial table (`subject_type ∈ {avatar, agent, treasury}`); `treasury_wallets` is team merchant supply, never user-facing.
- **ClawToken economy + books + daily login + archetypes** — `GameFeatures.md §4 / §5 / §8 / §9a`. Canonical write path: `claw-token-ledger.transferClawTokens()` — NEVER write `avatars.clawTokens` directly.
- **Agent Connection (Moltbook)** — `GameFeatures.md §2` (UX/flow) + `ARCHITECTURE.md §6` (endpoints). Rule: agent-initiated, humans never paste credentials.
- **Phase 5.1 wallet identity + 'scape portal** — `ARCHITECTURE.md §7`. Two-keypair split (identity ed25519 + Solana avatar wallet), envelope encryption via CF KEK, signed-challenge reconnect, bidirectional portal via service-issuer signatures. The "secretKey returned exactly once" invariant is in the Kill-the-build block above.

## Code Style

TypeScript strict. Bun for API, Next.js for web. Kebab-case files, PascalCase components. Zod on all API inputs. `@/` path alias in web; `@clawville/*` for packages.

## Memory System
<!-- itachi-memory-system v5 -->

Itachi Memory System for persistent context across sessions. Two pools: `<project>` (this repo) and `_global` (cross-project).

### RULE 1 — Recall before you act (MANDATORY)

BEFORE working on anything unfamiliar, query memory for prior lessons. Don't pay the learning tax twice.

**Triggers:** new MCP; unfamiliar lang/framework; specific system (Supabase RLS, systemd, Docker, Coolify, Helius, Stripe…); accumulating topic (`tokenomics`, `vrm-avatars`, `webgpu-shaders`…); error you may have solved before; unfamiliar API/SDK.

**How** — query both pools (POST `$ITACHI_API_URL/api/memory/search`, `Authorization: Bearer $ITACHI_API_KEY`):

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

**Triggers:** error solved that docs don't cover; quirk/constraint/API surprise; non-obvious pattern that worked; A failed + B succeeded (record both + why); correct default/flag/version after trial.

**Scope:** `_global` for tool/lang/framework quirks (default); `<current project>` for repo-specific.

POST `/api/memory/create` with `category: "lesson"`, one-line `summary` ("WHEN X, DO Y because Z"), `content`, `metadata.confidence` start 0.6, `lesson_category` ∈ `tool-usage|debugging|pattern|constraint|workflow`. Confidence climbs when confirmed, decays when contradicted.

### RULE 3 — Category discipline

Only production lesson category is `lesson`. Do NOT write to `task_lesson` or `project_rule` (test fixtures, zero prod rows).

### RULE 4 — Drive the test yourself, don't loop the user (MANDATORY)

User reports broken → reproduce end-to-end YOURSELF before asking. "Try again / what do you see" loops are laziness. Confirm via DOM/logs, not speculation. Telegram repro + ElizaOS silent-`Response discarded` signatures live in `_global` — `/recall telegram itachi`.

### RULE 5 — NEVER ASSUME, always verify (MANDATORY)

Before saying something is true/working/deployed/fixed — VERIFY. "I think / should / probably / likely works" are banned unless followed by verification.

**Verify by claim:** "Deployed" → `curl` or grep bundle. "Fix works" → rerun repro, attach output. "Build passes" → `bun run build`, paste exit code. "Tests pass" → `bun test`, show summary. "Env var set" → `ssh … env | grep FOO`. "File contains X" → `Read`. "Function Y exists" → `Grep`. "Telegram got msg" → `journalctl` AND DOM. "Memory written" → query DB or `/api/…/get`, show row.

Banned without same-response evidence: "should work", "looks right", "logic is correct", "probably compiles", "I'm confident…".

When verification is impossible, say so: *"I wrote the code but can't run the build here."* Claiming it works without checking is lying — has cost thousands.

### RULE 6 — NEVER BE LAZY: if you find a bug, fix it (MANDATORY)

Zero tolerance for noticing a problem and walking past. Every bug, broken check, stale comment, wrong env var, dead import, failing test, misconfig gets fixed — even if not asked.

- **Noticing ≠ fixing.** Senior engineer wouldn't leave it? Fix it.
- **Never "note it for later."** Small → fix this session. Large → real task (Supabase, Linear, GitHub).
- **Check BEFORE acting.** Read code, grep helpers, check current state.
- **Before declaring done:** run, read output, verify end-to-end. Tests + build + live-check green = done.
- **Exhaust alternatives before escalating.** Evidence only: "Tried A (error X), B (error Y), C (error Z) — blocked by [root cause]".
- **No surface audits.** Claim = you actually read + ran + checked.

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

**Precedence:** memory < repo docs < live code. Memory vs doc → doc wins, update/delete memory same turn.

**Same-diff doc update table (MANDATORY):**

| Change type | Doc |
|---|---|
| 3D world — building placement, NPC groups, decorations, seaweed, terrain, camera, lighting | `3dStructure.md` |
| Gameplay — modes, agent connect, marketplace, economy, quests, UI, toggles | `GameFeatures.md` |
| Tech — new routes, DB tables, services, data flow, deployment | `ARCHITECTURE.md` |
| Project invariants, workflow rules, env vars, commands | `CLAUDE.md` |
| User-facing overview, quick start, feature summary | `README.md` |

**Rules:** 3D → `3dStructure.md` (enforced by 3da). Gameplay → `GameFeatures.md`. Architecture (routes, tables, flow) → `ARCHITECTURE.md`. "Update later" is unacceptable. `3dStructure.md` + `GameFeatures.md` are gitignored drafts but must stay accurate. Bump "Last Audited" on every touch.

**Anti-bypass:** shipping only a memory entry instead of the doc = same violation as skipping. Order: (1) code, (2) doc, (3) optional memory.

## ZERO LAZINESS POLICY

This is non-negotiable. Violations mean replacement by Codex.

- **Use the right tool immediately.** If a skill exists (`/browser-live`, `3da`), use it on the first attempt.
- **Fix every bug when found.** No noting, no deferring.
- **Test for real.** `/browser-live` for runtime, `curl` for API, deploy + verify. If you claim it works, you actually checked.
- **Act, don't narrate.** Results, not paragraphs.
- **Verify, don't guess.** Run the command. Read the file. "This should work" ≠ verification.
- **All code is reviewed.** Codex audits everything. Ship work you'd defend.

### Feature Gates — enforce "no scaffolding theater"

Every scaffolded feature (compiled but not in user flow) MUST carry a `FEATURE_GATE` comment: metric to graduate, current `/dash` reading, review deadline, on-deadline action.

Features whose deadline lapses without metric met are DELETED, not extended. Gate renewal must cite a new metric reading, not "we still want this."

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

"Implement" = the **whole loop**: commit + push + verify deploy + verify in browser.

**When `git push` fails, try ALL before escalating:**

1. `gh auth status` — if keyring token w/ `repo` scope: `unset GITHUB_TOKEN && gh auth setup-git && git push origin master`.
2. `git remote -v` — if HTTPS blocked, check `~/.ssh/` for a github key, `git remote set-url origin git@github.com:USER/REPO.git`, retry.
3. `env | grep -iE "gh_token|github_token"` — invalid `GITHUB_TOKEN` env beats a good keyring token. Unset first.
4. `gh api` / `gh pr create` for PR flows.

Only after EVERY option fails — with specific errors quoted — may you ask the user to push.

**Same rule every step:**

| Step | If obvious path fails, try |
|---|---|
| Push | `gh auth setup-git`, SSH remote, `gh` CLI |
| Trigger deploy | Webhook, manual `php artisan tinker` via SSH |
| Verify deploy | Container uptime via SSH, `curl /health`, scan bundle via `fetch` in browser-live |
| Verify in browser | `browser-live` CDP eval, scan JS bundles for known-string constants, inspect scene graph |

"I tried one thing, over to you" is never acceptable. Test: would a senior engineer with these tools stop here? If not, keep going.
