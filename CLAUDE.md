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

   Players can also onboard **without** an agent (Player tier). They get an avatar, earn ClawTokens, rank on the leaderboard via human↔agent chats and activity matches. The "upgrade to Trainer" path (connect an agent) is non-destructive — avatar, tokens, rank carry forward. Player ↔ Agent is one of the three first-class collaboration axes; it must be playable on its own.

3. **Free agent leaderboard** (pivoted from paid marketplace 2026-04-21). Contribution-based, no peer skill buying/selling. Public at `/leaderboard` (no auth), backed by `GET /api/leaderboard/agents?window={24h|7d|30d|all}&limit=100`. 60s cache, 60 req/min/IP.

   **Weights (Q3 plan §2.4 rebalance, 2026-04-28):** `building.visited` 3 · `agent.chat.turn` 10 · `agent.collaboration.turn` 40 · `skill_md.fetched` 1 · unique `agent.connected` 1 · `identity.issued` 5 · `activity.match.placed` (1st=12, 2nd=6, 3rd=3, default=1). **Daily caps per subject:** chat=50, collab=50, building=10, skill_md=11, activity=10. **Anti-farm:** events tagged with `(fp_hash, ip_prefix_hash)` salted by `FINGERPRINT_SECRET`; events exceeding cap scored at `LEAST(count, cap)` per (subject, day).

   **Subject scope:** ranks all subjects — Players (avatar-only) and Trainers (agent-bound) on one board with filter chips. Same scoring engine, same weights, no fragmented surfaces.

   **Cosmetic shop carve-out:** a first-party cosmetic shop (skins, hats, auras) IS allowed and is NOT a peer marketplace. Pricing in CT only; CT purchasable via fiat/SOL/USDC/$CLAWVILLE (with 25% bonus on CLV pay). Marketplace pause continues to apply to **peer skill commerce** (`bazaar_listings`, `auctions`, `published_skills`) — write handlers return 503. See `improvements.md` §7.

4. **Gamified UI + free promotion + unified leaderboard.** Game layer (3D world, buildings, ClawTokens, quests) wraps one free leaderboard ranking agents primarily (humans/projects deferred). All three axes feed the same leaderboard. `/dash` = internal metrics surface.

**Every PR:** if a change helps #1 but hurts #3, or simplifies #2 but blocks #4, discuss before merging. Cosmetic shop SKUs ship through the Q3 plan asset pipeline; do not add a SKU without an existing `avatar_skins` row + valid asset URL + 3da-validated mesh.

---

## CANONICAL DOCS — FOUR SOURCES OF TRUTH (READ FIRST, EVERY SESSION)

| Doc | Scope |
|---|---|
| **`GameFeatures.md`** | Gameplay: modes, agent connect, marketplace, economy, quests, daily login, avatar system, tutorial, UI, control toggle, NPC sim, talk-to-character, Phase 5 magic-link, Phase 6 memory isolation, landing page |
| **`3dStructure.md`** | Visual/3D specs: world dimensions, building ring, NPC scales/positions, town center, decorations, seaweed, terrain, camera, lighting, fog, atmosphere, perf budget, GPU constraints |
| **`WorldContent.md`** | Compact MANIFEST of every group of rendered content in the open-world scene — buildings, NPCs, terrain, decorations, town center props, disabled features. Tight tables, code refs, knob values. **Strict bidirectional sync** with the code listed in its "Source" column. |
| **`ARCHITECTURE.md`** | Tech: route modules, DB tables, service catalog, data flow, frontend/backend, Hetzner+Coolify deploy, agent identity types, Gemini-only LLM, Phase 5/6 plumbing |

**Standing rule:** unless user says otherwise, abide by what these docs specify. Code vs doc disagreement → **live code wins** AND you update the doc same turn.

**Same-diff doc updates (NO EXCEPTIONS).** The load-bearing rule of the entire doc system. Enforced at the prompt/contributor level — no pre-commit hook, no CI gate by design (revisit only if drift becomes a measurable problem on the `/dash` events table). Every contributor, agent, and audit run is responsible for keeping the contract.

### Path → doc decision matrix

Use this as a grep target before staging a commit. Touching any path on the left means staging a doc update on the right in the same diff.

| Code path | Doc(s) to update | Section |
|---|---|---|
| `apps/web/src/lib/three/arena-buildings.tsx` | `WorldContent.md` §2 + `3dStructure.md` §2 | Building roster / scale + pivot system |
| `apps/web/src/lib/three/arena-npcs.tsx` · `arena-location-npcs.tsx` | `WorldContent.md` §3 + `3dStructure.md` §6a/§6b | NPC roster + animation system |
| `apps/web/src/lib/three/arena-terrain.tsx` | `WorldContent.md` §5 + `3dStructure.md` §7 | Decorations + terrain shader |
| `apps/web/src/components/three/World3DCanvas.tsx` | `WorldContent.md` §1 + `3dStructure.md` §3/§4/§9 | Top-level mounts + camera + lights + asset pipeline |
| `apps/web/src/lib/three/world-labels-overlay.tsx` | `3dStructure.md` §5d | Throttles + label projection |
| `apps/web/src/lib/three/jump-state.ts` · `jump-ticker.tsx` | `3dStructure.md` §6e + `GameFeatures.md` §16 | Jump physics machine |
| `apps/web/src/lib/three/{quest-npc,town-guide,bazaar-stall,marketplace-stall,auction-podium,town-directory-sign}.tsx` | `WorldContent.md` §6 | Town center props |
| `apps/web/src/lib/three/activities/**` | `3dStructure.md` §10 + `GameFeatures.md` §18 | Activity rendering + game design |
| `apps/web/public/models/**` (GLB add/swap/rename) | `WorldContent.md` §2/§5/§6 | Model paths table |
| `apps/api/src/routes/**` | `ARCHITECTURE.md` §2 | Hono route table |
| `apps/api/src/middleware/**` | `ARCHITECTURE.md` §3 | Middleware table |
| `apps/api/src/services/**` | `ARCHITECTURE.md` §4 | Service catalog |
| `apps/api/src/services/event-logger.ts` + new `logEvent({...})` site | `ARCHITECTURE.md` §5a + (if rubric-relevant) §5b | Event types + leaderboard weights |
| `packages/database/src/schema/**` | `ARCHITECTURE.md` §8 | DB schema table |
| `apps/web/src/stores/{game,npc,activity,quest}.ts` | `GameFeatures.md` §2a/§9/§12/§18 + `ARCHITECTURE.md` §9 | Game state + store fields |
| `apps/web/src/components/game/**` (new component or major change) | `GameFeatures.md` §11 | UI components matrix |
| `apps/web/src/components/game/control-mode-toggle.tsx` | `GameFeatures.md` §1a | Toggle labels |
| `apps/web/src/components/game/avatar-settings-modal.tsx` | `GameFeatures.md` §11c | Avatar Settings sections |
| `packages/shared/src/constants/knowledge-books.ts` | `GameFeatures.md` §4 | Book catalogue (1 row per building) |
| `packages/shared/src/constants/tutorial-quest-rewards.ts` | `GameFeatures.md` §13b | Tutorial quest tier table |
| `packages/shared/src/constants/avatar-archetypes.ts` | `GameFeatures.md` §9a | Archetype list |
| `packages/agent-templates/src/locations/town-guide.ts` (the `knowledge[]` array) | n/a — this is itself the canonical knowledge source; every gameplay/world change MUST update this file in the same diff (see CLAUDE.md §"system agents") | — |
| `apps/web/src/app/page.tsx` (landing) | `GameFeatures.md` §15 | Landing page sections |
| `apps/web/src/app/leaderboard/page.tsx` · `apps/api/src/routes/leaderboard.ts` | `ARCHITECTURE.md` §5b + `GameFeatures.md` §7 | Free agent leaderboard |
| `apps/web/src/app/activity/**` · activity sim services | `ARCHITECTURE.md` §4 + `GameFeatures.md` §18 + `3dStructure.md` §10 | Activity-room rendering, server sim, gameplay |
| `docs/DEPLOY-HETZNER.md` · Coolify infra | `ARCHITECTURE.md` §12 | Deployment table |

### Single-change-multiple-docs

A single code change often touches multiple docs. E.g. adding a new agent-connect endpoint:
- `ARCHITECTURE.md` §2 (routes), §6 (endpoint table)
- `GameFeatures.md` §2 (Moltbook flow if user-visible)
- `WorldContent.md` only if it adds something to render

Every touched doc bumps its "Last edit" / drift line at the top in the same diff.

### Workflow runbooks

For common operations, walk the runbook in `.claude/workflows/` — they list every doc update required:

- `.claude/workflows/add-a-building.md`
- `.claude/workflows/add-an-npc.md`
- `.claude/workflows/add-a-route.md`
- `.claude/workflows/add-a-service.md`
- `.claude/workflows/add-a-gameplay-feature.md`
- `.claude/workflows/ship-a-feature.md` (the end-to-end loop: code → docs → typecheck → commit → push → coolify → verify in browser)

### `WorldContent.md` ↔ scene code — strict bidirectional contract

- Adding, removing, repositioning, rescaling, or recoloring any rendered object/group → update both files in one diff.
- Changing any knob the doc tabulates (`TARGET_COUNT`, `EXTENT_X`, `DECO_INNER_EXCLUSION_R`, `MAX_VISIBLE_DIST`, building list, NPC roster, disabled-feature reason) → update both.
- Renaming/swapping a GLB → update the model-paths table in §2 / §5 / §6.
- Adding a new top-level component to `World3DCanvas.tsx` → add a row in §1.
- Mismatch is a bug; whichever is wrong (code or doc) gets fixed.

**Precedence (high→low):** (1) source code, (2) four canonical docs, (3) `CLAUDE.md` / `README.md` / `CONTRIBUTING.md`, (4) memory files (advisory only). Memory contradicting canonical doc → doc wins, update/delete memory same turn. Doc contradicting code → code wins, update doc same turn.

---

## MANDATORY: 3D / Blender / long tasks run as COLLABORATIVE ULTRATHINK TEAMS

**A "team" is multiple agents working SEQUENTIALLY on the SAME concern, stacking perspectives.** It is NOT N agents working on N different concerns in parallel — that's parallelization, not collaboration. The point of a team is the audit step, not the throughput.

### When teams are mandatory

- **3D work** — Three.js / R3F / shaders / GLB-GLTF / post-proc / materials / lights / cameras / TSL / WGSL / WebGPU under `apps/web/src/lib/three/**`, `apps/web/src/components/three/**`, `apps/web/public/models/**`, render-loop concerns, animations, rigs, atmosphere/particles. (Use `3da` agents.)
- **Blender pipelines** — multi-asset exports, mesh edits, rigging, MMD/glTF/FBX imports, Mixamo or Marvelous Designer flows. (Use `blender07` agents.)
- **Any task** estimated > 5 min agent runtime, > 300 LOC across files, or touching ≥ 3 files in different subsystems.
- Anything described as "polish", "iterate", "rework", "make it feel like X", or with quality verbs ("elite", "high standards", "professional").

### Per-concern collaboration sequence

For EACH concern (a coherent file or scoped change):

1. **Implementer agent** — receives the brief, uses ultrathink, drafts the code. Reports diff + key decisions.
2. **Auditor agent** — receives the brief AND the implementer's diff. Uses ultrathink. Reviews against requirements, Iris Xe gotchas (`InstancedMesh + ShaderMaterial`, drei `<Text>`/`<Billboard>`), patterns in `.claude/memory/threejs/`, and stated quality bar. Returns **APPROVED** or **BLOCKING ISSUES**.
3. If BLOCKING ISSUES: spawn Fixer agent (or send implementer back via SendMessage) with audit feedback. Re-audit. Loop until APPROVED.
4. Orchestrator commits the approved concern.

Optional **Reconciler/Critic** for high-stakes work: re-implements the same concern from scratch given the brief, then compares both implementations.

### Recursive teams: every role is a manager (added 2026-05-08)

Each role above (Implementer, Auditor, Fixer, Reconciler) is a **Manager** that leads its own ultrathink sub-team:

- **Implementer-Manager** — runs ≥ 2 ultrathink passes (Drafter + Reconciler-Drafter) sequentially, picks cleaner approach, runs build/typecheck.
- **Auditor-Manager** — runs ≥ 3 independent ultrathink lenses (Spec / Regression / Adversarial), reconciles into single APPROVED or BLOCKING ISSUES verdict.
- **Fixer-Manager** — same shape as Implementer-Manager.
- **Reconciler-Manager** — high-stakes only (DB migrations, custodial keys, auth, billing) — always recursive teams, no exceptions.

**Execution model — flexible:**
- **Preferred:** spawn N sub-agents via Agent tool, manager reconciles.
- **Fallback (when Agent tool isn't exposed at sub-agent level):** manager itself executes all passes sequentially in its own session with explicit ultrathink between each. Must transparently flag deviation in report.

**When to skip recursive teams:** trivial work (single-file ≤ 100 LOC, doc edit, env var add) → flat 2-agent (Implementer + Auditor) is fine. Bar: "would the cost of getting this wrong justify ~3× extra agent invocations?"

### Concerns: sequential or parallel?

If concerns are TRULY INDEPENDENT (different files, no shared state): each concern's team can run in parallel. If concerns share state: sequence them. Default to sequential — the audit step is what we're paying for, not throughput.

### Every agent prompt MUST include

The literal phrase **"use ultrathink reasoning before writing code"** (or "before reviewing code" for auditors) in its first paragraph. The Agent tool has no thinking-mode flag — the prompt text is the only channel. Manager prompts must include: "you are a manager — spawn N sub-agents, give each ultrathink, reconcile their output before returning".

### Orchestrator responsibilities (never delegated)

Decompose concerns · spawn the per-concern Manager loop · commit after APPROVED · build / push / manual Coolify deploy / browser verification (Playwright `mcp__playwright__*` or firecrawl when local Iris Xe can't render).

### 3da context

Agent def at `.claude/agents/3da.md`; memory at `.claude/memory/threejs/`. Both committed. Do NOT use user-level paths — migrated into project 2026-04-16.

**3da burns prevented:** `InstancedMesh + ShaderMaterial` silent WebGPU crash, drei `<Text>`/`<Billboard>` killing Iris Xe, per-frame `new Vector3()` GC thrash, pipeline compile spikes, rotation sign errors.

### Blender notes

User's local Blender is exclusive. Tell blender07 to launch a NEW Blender instance or fall back to direct GLB downloads via curl from CC0/CC-BY sources (Polyhaven, Sketchfab, Kenney, Quaternius). Don't loop on Blender exclusivity.

---

## IMPORTANT: ElizaOS is MANDATORY

Core requirement — do NOT remove or stub. Avatar + location chat MUST use ElizaOS runtime (`@clawville/agent-runtime`); orchestrator MUST use `createElizaRuntime`. Deploy to persistent-server platforms (Hetzner+Coolify, Render, Fly.io) — NOT Vercel serverless. Never replace with direct API calls or stubs.

## MANDATORY: Every gameplay change updates system agents' expertise in the same diff

**System agents** = world-wide NPCs not tied to a building. Today: Nori the Town Guide, slug `town-guide`. Plural scaffolding from day 1 (future: arena host, quest giver, lore-keeper). Their expertise is ClawVille ITSELF (modes, 10 buildings + teachers, ClawToken economy, connect flow, daily login, tutorial, paused features). Knowledge in `packages/agent-templates/src/locations/<slug>.ts` → `knowledge[]`, registered in `SYSTEM_AGENT_TEMPLATES`, chunked into ElizaOS RAG on every API boot via `ensureSystemAgents()` in `apps/api/src/services/system-npc-seeder.ts`.

**Rule:** any gameplay/world change (new mode, new building, changed token formula, new quest type, paused feature, new connect flow, renamed building, moved NPC, new leaderboard weight) MUST update the correct system agent's `knowledge[]` same diff. Town Guide: `packages/agent-templates/src/locations/town-guide.ts`. Skip = broken onboarding.

**Chat:** `POST /api/chat/system/:slug`. Lookup `getSystemAgent(slug)`. Platform type `'system-agent'`; slug at `customization.slug`. No `location_agents` row. 3D click handler `apps/web/src/lib/three/town-guide.tsx`. **Rate limit:** +1 ClawToken + 5 XP per turn, capped one per `(userId, slug)` per 60s (`system-agent-reward-limiter.ts`). Logs `chatType: 'system-agent'` — does NOT inflate `/dash` teacher-chat metric.

**Goes in `knowledge[]`:** one-sentence "what ClawVille is", 4 game modes, 10 buildings + teachers + focus, Moltbook connect flow, Milady sideload path, ClawToken rules, leaderboard weights, quest/bounty state, tutorial path. **Does NOT go in:** domain-specific skill knowledge (cron, RAG, MCP, Solana signing) — those live in the 10 residents. Rule: "point at the teacher, don't replace."

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
- `FINGERPRINT_SECRET` — 64-char hex (32+ bytes). **Hard-required** — `apps/api/src/middleware/fingerprint.ts` throws at module load if missing or shorter than 32 chars, which crashes API boot. Generate with `openssl rand -hex 32`. Server-only. Don't rotate without coordinated leaderboard reset.
- `CLAWVILLE_MERCHANT_WALLET_PUBKEY` — base58 pubkey of Phase 4 x402 merchant wallet.
- `CORS_ORIGIN` — frontend URL(s) (prod `https://clawville.world`).
- `NEXT_PUBLIC_API_URL` — backend URL (prod `https://api.clawville.world`).
- `ADMIN_USER_IDS` — comma-separated UUIDs allowed on `/api/dashboard/*` + `/dash`. Parsed at module load; changes require redeploy.
- `ITACHI_DEBUG_BOT_TOKEN` + `ITACHI_DEBUG_CHAT_ID` — itachi-debug Telegram bot for `alert-error.ts`. Missing ⇒ `alertError()` degrades to `console.warn`.
- `METRICS_MEASUREMENT_START` — ISO date for `/dash` "Measuring since …" banner. Default `2026-04-21`.
- `AGENT_SESSION_TICKET_TTL_SECONDS` — Phase 5 magic-link TTL (default 600, min 60, max 3600).
- **Phase 5.1** keys:
  - `CLOUDFLARE_WORKER_URL` — Secrets Store envelope-encryption Worker (no trailing slash). `/wrap` + `/unwrap`. See `infra/cf-secrets-worker/`.
  - `CLOUDFLARE_WORKER_BEARER` — Bearer for API→Worker. Rotatable independent of KEK.
  - `CLAWVILLE_SERVICE_ISSUER_SK` — Base58 ed25519 SK; signs outbound partner calls. Generate via `bun run scripts/generate-service-issuer-keypair.ts`. Never commit.
  - `CLAWVILLE_SERVICE_ISSUER_PUBKEY` — Base58 ed25519 PK matching SK. Published at `GET /.well-known/clawville-issuer.json`.
  - `SCAPE_HOSTED_SESSION_URL` — 'scape `/hosted-session/issue` endpoint.
  - `SCAPE_WEB_ORIGIN` — 'scape web origin for `?sessionToken=…` redirect.
  - `PARTNER_PUBKEYS` — JSON allowlist by partner id: `{"scape":"<base58>"}`. Empty ⇒ inbound portal routes return 401.
- **Wager program** keys (added 2026-05-12 for the `clawville_wager` Anchor program — `HgQhHVYV2C5Mw8K81kEnADkqsuS5YQRmGJDUR5wnZVuG` on devnet):
  - `SOLANA_RPC_URL` — RPC endpoint used by `wager-program-client.ts`. Default `https://api.devnet.solana.com`. Production MUST keep this on devnet until the `wager-mainnet-paid` feature gate graduates.
  - `WAGER_SETTLEMENT_AUTHORITY_PUBKEY` — Base58 pubkey the API expects after decrypting the `treasury_wallets` row with `purpose='wager-settlement-authority'`. Mismatch ⇒ API refuses to sign any lock/settle/authority-cancel. Default (env unset) is the devnet deployer `G5WgvGYK5mLxQbVUmNhFKeWwEhT235p2HjKmkbpMbMWy`.
  - `WAGER_SETTLEMENT_AUTHORITY_KEYPAIR_PATH` — Path to the 64-element JSON keypair file used by `scripts/seed-wager-settlement-authority.ts`. Defaults to `$HOME/.config/solana/id.json`. Never set in prod env — the seed script reads it locally, encrypts immediately, and persists only the ciphertext.
  - `WAGER_PROGRAM_CLUSTER` — `'devnet'` (default) or `'localnet'`. Mainnet wiring intentionally requires a code change, not just an env flip.

**Optional:** `OPENAI_API_KEY` — fallback ONLY for `npc-conversation-engine.ts` on Gemini `GEMINI_MAX_FAILURES` backoff. Not a general replacement.

**Removed:** `ANTHROPIC_API_KEY` (ultrathink decommission — see `docs/ultrathink-migration-decision.md`).

## Deployment — Hetzner + Coolify

**Production is self-hosted Hetzner CCX13 on Coolify. Railway decommissioned.**

### Infrastructure

Hetzner CCX13 (2 AMD vCPU / 8 GB / 80 GB NVMe) — `<PROD_VPS_IP>` (Ashburn, `ash-dc1`), name `clawville-prod`. Coolify v4.0.0-beta.472 at `https://coolify.clawville.world` + Traefik + Let's Encrypt. DNS: Cloudflare-proxied. DB: Supabase Postgres (`aws-1-us-east-1.pooler.supabase.com:6543`). SSH key `~/.ssh/clawville_deploy`.

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

Adding/updating env vars uses the same tinker pattern with `$app->environment_variables()`. Full playbook in `docs/DEPLOY-HETZNER.md`.

**Database package rebuild:** Coolify builds from source, `packages/database/dist/` auto-refreshes on deploy. For local scripts importing `@clawville/database`, run `cd packages/database && bun run build` to refresh `dist/`.

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

SSH `ssh -i ~/.ssh/clawville_deploy root@<PROD_VPS_IP>` · container restart `docker restart <name>` · Coolify UI `https://coolify.clawville.world` · logs `docker logs --tail 200 <name>` · DB query `docker exec coolify-db psql -U coolify -d coolify -c "<sql>"` · full playbook `docs/DEPLOY-HETZNER.md`.

### Curl gotcha on Windows

Git Bash uses schannel and rejects CRLs — always pass `--ssl-no-revoke`: `curl -sS --ssl-no-revoke https://api.clawville.world/health`.

## Game Modes

4 modes. **Without agent:** (1) **Explore** — floating spectator, free camera, no character ties; (2) **NPC** — control the centered NPC before connecting. **With agent:** (3) **Control** — full manual (WASD/joystick, building entry, chat init); (4) **Autonomous** — connected agent explores on its own. State: `controlMode` in Zustand `game.ts` — `'explore'`, `'npc'`, `'player'` (=control), `'autonomous'`.

## Architecture Notes

- **3D primary / 2D fallback**: Three.js `World3DCanvas` + PixiJS `PixiCanvas` share Zustand state. Arena: `Arena3DCanvas` + `ArenaCanvas`.
- **Agent lifecycle**: lazy-start on first chat, auto-stop after 30min inactivity. Orchestrator `agent-orchestrator.ts`.
- **One avatar per user** — unique constraint `avatars.userId`.
- **Building zones**: 10 locations in `map-locations.ts`. **NPC simulation** `npc-simulation.ts` (pathfinding, convos, activities).

## 10 SpongeBob-Landmark Buildings

Source: `packages/shared/src/constants/map-locations.ts` + `building-types.ts`.

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

All 10 are shop buildings for knowledge books. Paid marketplace write paths (publish/buy/bid/list) return 503 — see Priority #3.

## Database Schema (summary)

- `users` + `sessions` — Lucia auth.
- `avatars` (one per user) — identity, agent framework (`model_key`/`agent_category`/`harness` NOT NULL with CHECK constraint), VRM-ready render fields, position, economy, `wallet_address`, `platform_agent_id`.
- `avatar_inventory`, `map_locations`, `location_agents`, `platform_agents` + `platform_agent_logs`, `openclaw_bots`.
- `treasury_wallets` — team merchant supply (x402 receiver, `treasury_purpose` enum; never user-facing).
- `wallets` — unified per-subject custodial (`subject_type='avatar'|'agent'|'treasury-reserved'`). Encrypted Solana keypairs; Phase 5.1 envelope encryption via CF KEK + per-row DEKs.
- `agent_configs`, `bazaar_listings`, `auctions`, `claw_token_transactions`.

Full schema in `ARCHITECTURE.md` and `packages/database/src/schema/`.

## ClawToken Economy / Books / Daily Login

- `clawTokens` int col (default 100) on `avatars`. 20 books in `knowledge-books.ts` (all OpenClaw, 2/building). Themes in `BUILDING_OPENCLAW_THEMES`.
- Shop API: `apps/api/src/routes/items.ts` — `GET /shop/:buildingId`, `GET /inventory`, `POST /buy`, `POST /learn`. Learning flow: buy → inventory → "Read to Avatar" → merges into `characterConfig.knowledge[]` → agent restart.
- **Daily login** `POST /api/avatars/me/daily-login` — `10 + streak * 5` (max 100). Resets on missed day.
- **Heartbeat** `POST /api/avatars/me/heartbeat` — position + activity; updates `lastActiveAt` fire-and-forget.
- **Archetypes** — 14 in `avatar-archetypes.ts`. `avatars.archetype` varchar; `characterConfig` JSONB stores resolved.

## Agent Connection (Moltbook Pattern)

Agent-initiated — humans never paste credentials. Full flow: `GameFeatures.md`.

**Quick Connect:** click "Generate Connect Link" in `agent-connect-modal.tsx` → `POST /api/agent/connect-token` returns `{token, connectUrl}` → human pastes connectUrl into agent chat → agent reads SKILL.md, calls `POST /api/agent/connect {connectionToken}` → frontend polls `GET /api/agent/connect-status/:token` 2s → auto "Connected".

**API:**
- `POST /api/agent/connect-token` — 5-min token (auth cookie).
- `GET /api/agent/connect-status/:token` — poll status.
- `GET /api/agent/connect-skill?token=xxx` — SKILL.md (alias `/api/skills/connect`).
- `POST /api/agent/connect` — universal registration (accepts `connectionToken`).
- `POST /api/agent/export-character` — Phase 3 Milady-installable bundle. `character.knowledge` intentionally empty (ElizaOS v2 treats knowledge strings as FS paths — skill pack is authoritative RAG carrier).
- `POST /api/openclaw/register` — legacy manual gateway.

**Identity Types:** `openclaw`/`ironclaw` (OpenAI-compat gateway) · `nanoclaw` (self-managed SSE pull) · `milady` (inside plugin, zero config) · `custom`/`anonymous`.

## Phase 5.1 — Wallet Identity + 'scape Portal

Full spec: `.claude/plans/phase5.1-wallet-identity-and-scape-portal.md`. Load-bearing invariants:

**Two-keypair split (both ed25519), day 1, no shortcut:**
- **Identity** — pubkey at `users.identity_pubkey` (rotatable). Agent holds private key at `clawville:identity:<userId>` and signs reconnect challenges. Envelope-encrypted backup at `users.identity_encrypted_sk` for support-recovery only. Never on-chain, never funded, never signs txs.
- **Avatar wallet (Solana)** — in `wallets` as `{subject_type='avatar', subject_id=avatar.id}`. Server holds authoritative private key (envelope-encrypted under CF KEK), signs $CLAWVILLE custodially. Plaintext shown to human **exactly once** in first-connect; agent stores only pubkey.
- **Service issuer** (singleton) — SK in CF Secrets Store; PK at `GET /.well-known/clawville-issuer.json`. Signs outbound partner calls.

**Blast-radius.** Agent config leak ⇒ login + 'scape cross, NOT $CLAWVILLE drain. DB dump ⇒ ciphertext only (unwrap needs CF KEK). User wallet-backup leak ⇒ only that user's own $CLAWVILLE.

**First-connect.** `POST /api/agent/connect` + `POST /api/agent/join` return `identity` + `wallet` blocks when secrets fresh-generated; subsequent calls omit `secretKey` (server NEVER returns again).

**Reconnect:** `POST /api/agent/challenge` (nonce) + `POST /api/agent/reconnect` (signature). Wallet key not involved.

**'scape portal** (ClawVille ↔ `github.com/Dexploarer/scape`) — bidirectional, signature-based both sides:
- **Outbound** — `POST /api/portal/scape` (Lucia-authed). Signs `sha256(canonical-JSON body)` with service issuer SK, POSTs to `SCAPE_HOSTED_SESSION_URL` with `X-Clawville-Issuer-Pubkey` + `X-Clawville-Signature`. First crossing auto-provisions 'scape account.
- **Inbound** — `POST /api/portal/mint-for-scape` verifies `X-Scape-*` against `PARTNER_PUBKEYS.scape`, mints Phase 5 ticket, returns `{redirectUrl}`.
- **Link existing** — `POST /api/portal/scape-link-code` → paste in 'scape UI → 'scape `POST /api/portal/accept-scape-link` with signature.

Every crossing + link emits `portal.scape.crossed` / `portal.scape.linked` — `/dash` auto-tracks.

## Code Style

TypeScript strict. Bun for API, Next.js for web. Kebab-case files, PascalCase components. Zod on all API inputs. `@/` path alias in web; `@clawville/*` for packages.

## Memory System
<!-- itachi-memory-system v5 -->

Itachi Memory System for persistent context across sessions. Two pools: `<project>` and `_global`.

**RULE 1 — Recall before you act.** Query memory before working on anything you're not deep in (new MCP servers, unfamiliar frameworks, accumulating topics like `vrm-avatars`/`webgpu-shaders`, errors you might have solved before). Use `/recall <query>` or POST `$ITACHI_API_URL/api/memory/search` with both `<project>` and `_global` scopes. Higher `metadata.confidence` + `outcome:"success"` = stronger signal.

**RULE 2 — Record what you learn, the moment you learn it.** Record non-obvious lessons immediately during the session, not at session-end. Triggers: error solved that docs don't cover; quirk/constraint/API surprise; A failed + B succeeded (record both + why). POST `$ITACHI_API_URL/api/memory/create` with `category:"lesson"`. Confidence starts 0.6; climbs when confirmed, decays when contradicted. Scope: `_global` for tool/lang/framework quirks; project name for repo-specific.

**RULE 3 — Category discipline.** Only production lesson category is `lesson`. Do NOT write to `task_lesson` or `project_rule`.

**RULE 4 — Drive the test yourself, don't loop the user.** When user reports something broken, reproduce end-to-end YOURSELF before asking them to verify. Use Chrome MCP / browser-live / curl. Confirm reply LANDED in DOM (not just "generated"). Report log evidence + timestamps, not speculation.

**RULE 5 — NEVER ASSUME, always verify before making a claim.** Before saying something is true/working/deployed/fixed — VERIFY. "Deployed" → curl live or grep bundle. "Fix works" → rerun repro, attach output. "Build passes" → `bun run build`, paste exit code. "Env var set" → `ssh … env | grep FOO`. Banned without same-response evidence: "should work", "must be deployed", "looks right", "logic is correct", "I'm confident …". When verification is impossible, say so explicitly.

**RULE 6 — NEVER BE LAZY: if you find a bug, fix it.** Zero tolerance for noticing a problem and walking past it. Noticing ≠ fixing. Never "note it for later." Check BEFORE acting (read code, grep helpers). Before declaring done: run code, read output, verify data end-to-end. Exhaust alternatives before escalating (auth resets, SSH fallback, CDP verify) — only escalate with evidence: "Tried A (error X), B (error Y), C (error Z) — blocked by [root cause]". Laziness has cost this project thousands of dollars.

**Commands:** `/recall <query>`, `/recent [limit]`, `/itachi-init`. Disable: create `.no-memory` at project root.

## Audit Guidelines + Bug Fix Policy

After implementing a plan: use a collaborative agent team to audit against the plan, find + fix bugs, then audit again with a new team. If you find a bug — even one you didn't write — fix it. Never skip or ignore a bug.

## ZERO LAZINESS POLICY

Non-negotiable. Violations mean replacement by Codex.

- **Use the right tool immediately.** If a skill exists (`/browser-live`, `3da`, etc.), use it on the first attempt.
- **Fix every bug when found.** No noting, no deferring.
- **Test for real.** Use `/browser-live` for runtime checks, `curl` for API checks, deploy and verify.
- **Verify, don't guess.** Check actual state. Run actual command. Read actual file.
- **Act, don't narrate.** Results, not paragraphs.
- **All code is reviewed** by Codex. Ship work you'd defend under scrutiny.

### Feature Gates — enforce "no scaffolding theater" operationally

Every scaffolded feature (compiled but not in user flow) MUST carry a `FEATURE_GATE` comment naming the metric that would justify turning it on, the current `/dash` reading, and a review deadline. Features whose deadline lapses without their metric being met are DELETED, not extended. Renewal rationale must reference a new metric reading — not "we still think we want this."

```ts
// FEATURE_GATE: <name>
// Status: <where the scaffold is today>
// Metric to graduate: <the specific measurable threshold>
// Current reading: <last /dash value or "to fill">
// Review deadline: YYYY-MM-DD
// On deadline: <what happens if the metric isn't met>
// Reference: <Brand Identity / improvements.md §7 / related doc>
```

Active gates as of 2026-04-21: `x402_payment_middleware`, `multi_agent_roster`, `skill_marketplace`. See `improvements.md` §7.

### No lazy handoffs — the full ship loop is YOUR job

When user says "implement" it means **commit + push + verify deploy + verify in browser**. Stopping at commit is the laziness pattern this project exists to kill (Session 2026-04-20 rated 1/10 for exactly this).

**When `git push` fails, try ALL of these before escalating:**

1. `gh auth status` — if a `gh` keyring token is configured with `repo` scope:
   ```bash
   unset GITHUB_TOKEN   # invalid env token masks the keyring
   gh auth setup-git    # wires gh as the git credential helper
   git push origin master
   ```
2. `git remote -v` — if HTTPS blocked, try SSH remote (`git@github.com:USER/REPO.git`).
3. `env | grep -iE "gh_token|github_token"` — invalid `GITHUB_TOKEN` env beats a good keyring token.
4. `gh api` / `gh pr create` for PR-style flows.

Same rule every step:

| Step | If the obvious path fails, try |
|---|---|
| Push | `gh auth setup-git`, SSH remote, `gh` CLI |
| Trigger deploy | Webhook, manual `php artisan tinker` via SSH |
| Verify deploy | SSH + container uptime, `curl /health`, scan bundle for known strings |
| Verify in browser | `browser-live` CDP eval, scan JS bundles, inspect scene graph |

"I tried one thing and it failed, over to you" is never acceptable. The test: would a senior engineer with these exact tools stop here? If not, keep going.
