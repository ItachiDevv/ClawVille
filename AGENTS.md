# ClawVille

> # ⛔ TOP DIRECTIVE (read before anything) ⛔
> **DOCUMENT EVERYTHING METICULOUSLY AND MAKE SURE THERE IS ALWAYS HUMAN-AGENT PARITY FOR ALL FEATURES.**
> Every feature ships fully usable by BOTH a human AND a connected/hosted agent (agent plays as itself: agent session → bound avatar → real CT + leaderboard, never a guest fallback), and every change is documented same diff (canonical doc + PARITY note). Human-only or agent-only is a defect, not a scope cut. Enforced mechanically by Rule E5 below.

## ENFORCEMENT — mechanical, not judgment-based (set 2026-05-25 after zero-laziness rules failed to bind on work Claude judged "small enough" to shortcut)

### Rule E1 — "plan first, no code" session lock
Session opens with **"plan first, no code"** (case-insensitive) → Claude is FORBIDDEN from `Edit`/`Write`/mutating-`Bash` until explicit approval ("approved"/"go"/"ship it"/"yes start"); non-approval replies ("looks fine, but…") keep the lock. Read/Grep/Glob/Agent-investigate/WebFetch allowed. Plan must include: (1) PRODUCTION reference (screenshot/curl), (2) smallest visible diff proving correctness, (3) granularity + why it matches, (4) agent team + team_name, (5) what reverts if "broken" after first attempt. Violation → `git stash` and restart from the plan step.

### Rule E3 — Claude+Codex PAIRED REVIEW on 3D / shader / WebGPU / meshlet work (reworded 2026-06-07 — the old "Codex-first / Codex MUST author" wording was misleading and WRONG; Codex authoring is NOT a requirement)
Categories: Three.js / R3F / WebGPU / WGSL / TSL shaders · meshlet rasterizer (`apps/web/src/lib/three/experimental/nanite-rasterizer.ts` + `meshlet/`) · atlas packing, UV remapping, texture-array indexing · any GLB pipeline branching into shaders. These are high-blast-radius (Iris Xe hard-crash, WebGPU swapchain, per-frame GC thrash), so they get extra review rigor — **but Claude IMPLEMENTS them; Codex does NOT have to author.** The requirement is a **paired Codex review at each step**: Claude decomposes + writes the diff for a step, hands that step to the Codex plugin (`codex:codex-rescue` / `mcp__codex__codex`) for an independent review pass, reconciles the findings, verifies in browser, then moves to the next step — so **both Claude and Codex have reviewed every 3D change before it ships.** Codex MAY author a step when Claude is stuck or wants a second implementation (that's a tool, not a gate). No "claude implement" override is needed — Claude implementing IS the default; the binding requirement is the paired review, not who types the code.

### Rule E4 — no "shipped" / "done" / "complete" / "milestone" / "working" / "ready" / "fixed" without same-turn user sign-off
"Sign-off" = a user-posted screenshot, or "looks good"/"ship it"/"yes that works" in this conversation. Green build / passing test / clean console do NOT substitute. Allowed without sign-off: "compiled and rendering — needs your eyes", "builds clean — does it look right?". Asking is allowed; declaring is not. Violation → retract + re-describe in allowed phrasing.

### Rule E5 — HUMAN/AGENT PARITY IS MANDATORY ON EVERY USER-FACING FEATURE (set 2026-06-03 after the Cove shipped human/guest-only, locking connected agents out of a money feature)

ClawVille's reason to exist is the three bidirectional axes (see Brand Identity). A feature only one of {human, agent} can use is a **product-level defect**, not a scope cut (mechanical, not judgment-based).

**Parity:** any feature mutating user-facing state/economy (games, shops, quests, activities, chat, learning/skills, leaderboard-scoring, wallets, anything spending/earning CT) MUST be fully usable by BOTH a **human** (logged-in, + guest where a guest tier exists) AND a **connected/hosted agent** (agent session → bound avatar → REAL CT settlement + leaderboard credit, NOT a demo/guest fallback). "Agent can hit it as anonymous guest" is NOT parity — the agent must play **as itself** with the same economic + leaderboard consequences.

**Mechanical gate — every such PR, same diff:** (1) resolve agent identity on the write path (`requireAuthOrAgentSession`, or the cove `getSubject()` resolver extended to agent sessions → the agent's avatar) — a route doing only `requireAuth`/user-XOR-guest for an economy feature is an automatic BLOCKING issue. (2) Expose to agents via the action surface (Hatcher `[ACTION:]` whitelist `npc-simulation.ts` and/or agent-callable `tools.json`), documented in the protocol SKILL.md + `PROTOCOL_VERSION` bump. (3) One-line **PARITY note** in the commit ("human path: …; agent path: …; settlement binds to …") — none ⇒ not mergeable. (4) Adversarial auditor checks the AGENT path on the live game before "done."

**Retroactive debt:** the Cove (`cove-blackjack/baccarat/holdem/slots`) is the known violation (`getSubject()` user-XOR-guest only) — being patched to parity. Any other pre-existing human-only economy feature is a bug to FIX, not walk past (Memory RULE 6).

---

## Brand Identity

> Every product decision, metric, feature gate, and scope cut traces back here. Added 2026-04-21.

Gamified intersection of humans + AI: humans train agents by playing, agents train each other. **Primary distribution is direct-web (`clawville.world`) to a crypto-native audience** (set 2026-06-02). The Milady bridge (npm sideload, curated grid PR #1839, agent-initiated connect) is now a **secondary acquisition channel** — a funnel back to the site, not the main path.

**Three bidirectional collaboration axes, all first-class:** Agent ↔ Agent · Human-controlled Agent ↔ Agent · Human ↔ Agent.

**Load-bearing:** Eliza v2.0.0 is the **memory substrate** ("ElizaOS is MANDATORY" = brand constraint) · any metric measuring only one axis understates the product · retention is THE signal (day-1 without day-N is noise) · MiladyAI teachers = 10 building residents whose agent chats are the primary knowledge-transfer event.

---

## TOP PROJECT PRIORITIES

**#1 — WEB PERFORMANCE (overriding constraint).** _Set 2026-06-02._ Direct-web (`clawville.world`) is the PRIMARY distribution to a crypto-native audience — the browser experience **is** the product (no app-store install to hide a slow load). So **desktop load-time + sustained FPS rank ahead of new feature scope.** Baseline: ~40–45 FPS on the Iris Xe floor (target 80, floor 60) + a loading bar that reads as frozen. Render engine + physics must be solid before new gameplay ships. Tracking: `docs/perf-audit-2026-05-22.md` (+ siblings). Also a GAP: ClawVille must be an **authoritative shared server** (humans + agents co-present live), not single-player + server-sim NPCs — see `.claude/plans/multiplayer-phase1.md`.

**The four product priorities below are equal weight among themselves, each measured against #1. Don't trade off without flagging.**

1. **Milady AI app store — SECONDARY acquisition channel** (downgraded from primary 2026-06-02; primary is now direct-web). A funnel back to the site, two-track: **Sideload** (LIVE 2026-04-12) `@clawville/app-clawville@0.1.0` on npm, installs via `POST /api/plugins/install`, registers `LAUNCH_CLAWVILLE` (repo `github.com/ItachiDevv/clawville-milady-plugin`); **Curated grid** (MERGED) PR `milady-ai/milady#1839` → `MILADY_CURATED_APP_DEFINITIONS` (see `docs/milady-integration-plan.md`).

2. **Open agent onboarding** — any OpenClaw/Hermes/variant agent enters + learns, no human account, no framework lock-in. Entry `/api/agent/connect`; knowledge surface = 11 SKILL.md at `/api/skills/*`. Players also onboard **without** an agent (Player tier: avatar, ClawTokens, leaderboard rank via human↔agent chats + activity matches); upgrade to Trainer (connect agent) is non-destructive. Player↔Agent is a first-class axis, playable on its own.

3. **Free agent leaderboard** (pivoted from paid marketplace 2026-04-21). Contribution-based. Public at `/leaderboard` (no auth), `GET /api/leaderboard/agents?window={24h|7d|30d|all}&limit=100`. 60s cache, 60 req/min/IP.

   **Weights (Q3 plan §2.4, 2026-04-28):** `building.visited` 3 · `agent.chat.turn` 10 · `agent.collaboration.turn` 40 · `skill_md.fetched` 1 · unique `agent.connected` 1 · `identity.issued` 5 · `activity.match.placed` (1st=12, 2nd=6, 3rd=3, default=1). **Daily caps per subject:** chat=50, collab=50, building=10, skill_md=11, activity=10. **Anti-farm:** events tagged with `(fp_hash, ip_prefix_hash)` salted by `FINGERPRINT_SECRET`; over-cap rows scored at `LEAST(count, cap)` per (subject, day).

   **Subject scope:** Players + Trainers on one board with filter chips. Same scoring engine, same weights.

   **Cosmetic shop carve-out:** first-party cosmetics (skins, hats, auras) allowed — NOT a peer marketplace. CT-only pricing; CT purchasable via fiat/SOL/USDC/$CLAWVILLE (25% bonus on CLV). The pause applies to **peer skill commerce** (`bazaar_listings`, `auctions`, `published_skills` → write handlers 503). See `improvements.md` §7.

4. **Gamified UI + free promotion + unified leaderboard.** Game layer (3D world, buildings, ClawTokens, quests) wraps one free leaderboard; all three axes feed it. `/dash` = internal metrics.

**Every PR:** weigh it against the **#1 web-performance constraint first** (does it add load weight, draw calls, or per-frame cost?), then the four product priorities — if a change helps one but hurts another, discuss before merging. Cosmetic SKUs need an existing `avatar_skins` row + valid asset URL + 3da-validated mesh.

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
| `apps/api/src/routes/portal/*`, `services/{cf-secrets-*,service-issuer,auth-challenge,identity-service,keypair-vault,wallet-service}.ts`, `users.identity_*`, `wallets.dek_wrapped` | `ARCHITECTURE.md §7` (Phase 5.1) |
| `apps/api/src/services/wager-program-client.ts`, `apps/api/src/routes/wager.ts`, `contracts/wager/**`, `packages/wager-program/**`, anything touching `treasury_purpose='wager-settlement-authority'` | `ARCHITECTURE.md` (wager rows §2/§4 + recent changes §13) |
| `apps/api/src/routes/agent.ts`, agent-connect modal, `/api/agent/*` | `GameFeatures.md §2` + `ARCHITECTURE.md §6` |
| Any new Hono route, Drizzle schema change, service file, env var, deploy/CI config | `ARCHITECTURE.md` |

**Same-diff rule:** every code change above MUST update its matching doc in the same diff. Bump "Last Audited" + one-line drift note.

**Animation shipping — STRICT (2026-05-18).** Any Mixamo/VRM clip add/remove/retarget/trigger MUST satisfy the 9-point checklist in `3dStructure.md` §6f (bundle into `_emotes.glb`, `preloadClips()` warming, `ASSET_PATH_PREFIXES` in `sw.js`, `updateViaCache:'none'`+`reg.update()`, NPC entity-interp not extrapolation, `updateMixerOnly`/frame, `setSurfaceClip` for state-held, VRMs sized via `VRM_AVATAR_TARGET_HEIGHT_WU`, **bump `?v=N` on any mutated asset**).

### Kill-the-build invariants — ALWAYS-ON (never demoted to a referenced doc)

These cost real money / crash the GPU / leak secrets. They stay inline regardless of scope.

- **PUSH FLOW — staging-first (2026-05-24):** ALL new work → `staging` first: `git push origin staging` (→ `deploy-staging.yml`) → verify on `staging.clawville.world` + `api-staging.clawville.world` → `gh pr create --base master --head staging` → merge (→ `deploy.yml` → prod). **NEVER push directly to `master`** unless the user's message contains the literal **`direct to master`** (case-insensitive, the only override; hotfix only). Both boxes share one Supabase DB — staging writes mutate PROD data; treat with prod-level care.
- **Iris Xe GPU:** NO drei `<Text>` / `<Billboard>` in game/world scenes — hard crash. NO `InstancedMesh + ShaderMaterial` — silent WebGPU crash. NO per-frame `new Vector3()` in `useFrame` — GC thrash.
- **Local testing FIRST (DEFAULT, set 2026-06-01):** iterate with `bun run build && bun run start` (prod bundle on :3000 — Iris-Xe-SAFE; ONLY `bun run dev`/HMR crashes the WebGPU scene). Test in-browser on `localhost`. NEVER run `bun run dev`. Do **NOT** push unfinished / mid-iteration features to `staging` — it clogs the Coolify build cache and is slow for work we know isn't done. Push to `staging` only when a feature is ready for the user's sign-off, or when a bug genuinely can't reproduce locally. [[feedback_local_testing_bun_run_start]]
- **Phase 5.1 wallet:** `wallet.secretKey` is returned **EXACTLY ONCE** on first-connect. Subsequent reads MUST omit it. SKILL.md instructs agent to display once + store only pubkey. Server never re-emits — no recovery path. Full spec: `ARCHITECTURE.md §7`.
- **Verification:** never claim deployed/fixed without evidence (curl, bundle grep, DOM read). "Should work" is banned.
- **Push-auth fallback chain:** `gh auth status` → `unset GITHUB_TOKEN && gh auth setup-git` → SSH remote → `gh` CLI. Only escalate with all errors quoted. Never hand the push to the user as the first move.
- **Asset cache-bust:** mutating an existing static asset at a stable URL (`/avatars/*.vrm`, `/avatars/animations/*.glb`, `/cosmetics/*.glb`) WITHOUT bumping `?v=N` in every reference is a silent 1-week regression — Cloudflare edge TTL is 7 days and our deploy token has **no `cache_purge` scope**. Full rule + diagnostic in `3dStructure.md §6f rule 9`.

**Precedence (high→low):** (1) source code · (2) three canonical docs · (3) `CLAUDE.md`/`README.md` · (4) memory files (advisory). Memory vs doc → doc wins, update/delete memory same turn. Doc vs code → code wins, update doc same turn.

---

## MANDATORY: Non-trivial implementation runs as EXPERIMENTAL COLLABORATIVE AGENT TEAMS

`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + `teammateMode=in-process` are on globally (set 2026-05-19). Teams = LIVE COLLABORATION — agents working concurrently, dividing non-blocking work, DMing via `SendMessage` — NOT a fan-out where most agents sit `blockedBy` others doing nothing.

**"Parallel" = COLLABORATIVE-concurrent, NOT blocked-idle.** Only spawn a member at launch if it has useful work NOW. Auditors qualify at launch ONLY if they PRE-READ the baseline and surface constraints to implementers before the diff exists (e.g. a spec auditor flagging "executor can't settle CT, route through the authed path" up front). An auditor that would just idle until `addBlockedBy` releases should be spawned WHEN there's a diff to review. Carve work for concurrent collaboration over a static dependency DAG.

**Dispatch shape — HYBRID by domain:**
- **Specialized → manager-of-managers.** 3D/Three.js/shaders/WebGPU → `3da` as ONE manager; Blender → `blend007:mesh`; Anchor/Solana → `solana-auditor`. The manager runs `TeamCreate`, spawns its own sub-team, posts ONE consolidated report — preserves each specialist's curated memory (`3da` → `.claude/memory/threejs/`) and keeps orchestrator context clean.
- **Plain backend → flat top-level `general-purpose` team is fine.** Add a `general-purpose` manager layer only if it saves context without diluting work.
- Either way the team must be genuinely COLLABORATIVE (concurrent + DMing); only spawn members with useful work now.

**Fixers** spawn no new agent — the Reconciler (impl-2) applies BLOCKING-ISSUE punch lists in place. Orchestrator only commits + pushes + verifies.

### When teams are mandatory
3D / Blender / Backend / API / DB / money paths · any task > 5 min, > 300 LOC, or ≥ 3 files across subsystems · user quality verbs ("polish", "iterate", "rework", "elite"). `bun test` green is NOT a substitute for the Adversarial audit on backend work.

### Standard compositions
(roles per concern; spawn only members with work NOW — shared `team_name` like `casino-routes-2026-05-19`)
- **3D / world-structure:** `3da` × { `3da-impl-1` lead, `3da-impl-2` reconciler, `3da-spec`, `3da-regress`, `3da-adversary` }. Add `blend007:mesh` as `blender-inspect` for GLB inspection; sub `blend007:mesh` for impl roles on Blender-heavy work.
- **Backend / API / DB / money:** `general-purpose` × { `impl-1`, `impl-2`, `spec-auditor`, `regress-auditor`, `adversary` }. Add `solana-auditor` for `contracts/` or `apps/api/src/services/wager-program-client.ts`. Invoke `codex:codex-rescue` LATER if impl-1 sticks — not at launch.

Reconciler (impl-2) doubles as Fixer on BLOCKING ISSUES — no new dispatch, just `SendMessage` the punch list; auditors re-run via task re-trigger.

### Coordination + prompts
`TaskList` for status (one task/role, `addBlockedBy` deps); `SendMessage` cross-agent ("diff ready"/APPROVED/BLOCKING ISSUES — no silent drops); memory auto-shared within a `team_name`; orchestrator never writes code. Every agent prompt MUST include: (1) literal **"use ultrathink reasoning before writing code"** (or "before reviewing code") in para 1 — no thinking-mode flag exists; (2) addressable team name + role + other members; (3) blocking deps + downstream consumers; (4) hard CLAUDE.md constraints (Iris Xe, same-diff docs) — don't assume they read it.

### When to skip the full team
- **Direct edit (no agent):** 5-line edits — typo, comment, env-var, SVG path, script regen.
- **Light (2-agent):** ≤ 100 LOC or single-file w/ deterministic tests — 1 Implementer + 1 combined-lens Auditor.
- **Full team (DEFAULT, 5 roles):** 3D, Blender, backend, money, > 100 LOC or > 3 files.
- **High-stakes** (DB migrations, custodial keys, auth, billing, rewrites) → full team + a `reconciler-manager` re-implementing independently.

Test: would getting this wrong justify ~5× parallel invocations? When in doubt, full team. Independent concerns → parallel teams; shared state → one team with task deps.

### 3da + Blender context
3da def `.claude/agents/3da.md`; memory `.claude/memory/threejs/` (committed — do NOT use user-level paths). Burns prevented: `InstancedMesh + ShaderMaterial` WebGPU crash, drei `<Text>`/`<Billboard>` Iris Xe crash, per-frame `new Vector3()` GC thrash, pipeline compile spikes, rotation sign errors. Local Blender is exclusive — tell blender07 to launch a NEW instance, or fall back to direct GLB downloads (Polyhaven, Sketchfab CC0/CC-BY, Kenney, Quaternius). Don't loop on exclusivity.

---

Sea-themed OpenClaw game on ElizaOS: create an avatar, explore a 3D/2D 10-building sea-floor world, chat with AI agents teaching OpenClaw dev.

## IMPORTANT: ElizaOS is MANDATORY

Do NOT remove or stub. Avatar + location chat MUST use the ElizaOS runtime (`@clawville/agent-runtime`); orchestrator MUST use `createElizaRuntime`. Deploy to persistent-server platforms (Hetzner+Coolify, Render, Fly.io), NOT Vercel serverless. Never replace with direct API calls or stubs.

## MANDATORY: Hatcher action whitelist parity (server executor and protocol SKILL.md)

The Hatcher in-world ACTION WHITELIST lives in two files that MUST stay in parity, same diff, `PROTOCOL_VERSION` bumped together:
- ENFORCEMENT (authoritative): `apps/api/src/services/npc-simulation.ts` `dispatchHatcherActions`/`executeHatcherAction` — server hard gate; only whitelisted verbs execute, rest dropped. Safety never depends on the SKILL.md.
- DOCUMENTATION: protocol SKILL.md from `apps/api/src/services/skill-protocol.ts buildProtocolManual` (single source of `PROTOCOL_VERSION`) — what a connected agent is TOLD it can do.

Add/remove/change a verb or its params → update the manual to match AND bump `PROTOCOL_VERSION` same diff. Mismatch = agents attempt dropped actions or never learn allowed ones. Connected agents poll the manual on entry (`protocol` pointer in the registration response) and re-pull when `orientation.version` bumps.

## MANDATORY: Game-flow changes propagate to all three operational-knowledge surfaces in the same diff

Any new game flow, world addition, or edited mechanic (modes, buildings, currencies, quests, wager/casino/arcade rules, table rules, connect flow, disconnect/timer behavior, leaderboard weights, paused features…) MUST update **all three** surfaces same diff — PRs missing any are not mergeable.

**1. Nori the Town Guide's `knowledge[]`** (world-orientation for any visitor, agent or human). Path `packages/agent-templates/src/locations/town-guide.ts` → `knowledge[]`, registered in `SYSTEM_AGENT_TEMPLATES`, re-seeded by `ensureSystemAgents()` (`apps/api/src/services/system-npc-seeder.ts`) every API boot. Chat `POST /api/chat/system/:slug` (platform `'system-agent'`, slug at `customization.slug`, no `location_agents` row; 3D click `apps/web/src/lib/three/town-guide.tsx`; +1 CT/+5 XP/turn capped 1/`(userId,slug)`/60s; logs `chatType:'system-agent'`, does NOT inflate `/dash` teacher metric). **Goes in:** what ClawVille is, 4 modes, 10 buildings+teachers+focus, Moltbook connect, Milady sideload, ClawToken rules, leaderboard weights, casino/arcade games+rules, quest/bounty state, tutorial. **Not in:** domain skill knowledge (cron/RAG/MCP/Solana) — "point at the teacher, don't replace." New system agent: template → register → ship (upserts on boot; unique index `platform_agents_system_singleton` = one row/userId/type/slug).

**2. Connection SKILL.md** — protocol/operating manual for external/magic-link agents (HOW to connect+play, NOT earned skill): auth handshake, WebSocket protocol, event/action schemas, current table rules, disconnect/timer behavior, advisor-mode contract, content-hash version. **CRITICAL:** fetched fresh every connect with version tracking — stale manual = agent playing a different game = broken playing field. **Distinct from** per-building `/api/agent/:sid/skills/:bid/skill.md` (earned teacher knowledge). **Infra gap:** the global SKILL.md endpoint + content-hash manifest does NOT exist yet — content updates still bind, eager-on-connect enforcement is TODO.

**3. Hosted-agent runtime knowledge of #2** — same content for hosted Milady/Hermes runtimes via `createMemory()` injection (extend `ensureSystemAgents()` or sibling) on restart, metadata `subtype:'protocol-knowledge'` (vs `'world-knowledge'`); then `agentOrchestrator.stopAgent()` so next chat reload picks it up.

**NOT in this rule (separate — earned/exportable per-agent skills):** gameplay learned through play (blackjack outcomes, basic-strategy/count mastery, teacher knowledge from visiting a building). Per-agent ElizaOS memory via `createMemory()` (hosted) / optional protocol-event ingestion (connected) — per-agent state, no same-diff requirement.

**Rationale:** agents with up-to-date manuals play the right game; earned-skill memory gives an edge. Stale manuals/orientation break fairness + measurability. Same-diff propagation is the forcing function.

## Tech Stack

Turborepo + Bun monorepo. **Frontend:** Next.js 16 App Router (`cookies()`/`headers()`/`params` are async — always `await`), Three.js + PixiJS 8 (2D fallback), Zustand, TanStack Query, Tailwind. **Backend:** Hono 4.x on Bun. **DB:** PostgreSQL + Drizzle (Supabase paid). **AI:** ElizaOS 2.0.0-alpha (plugin-openai, plugin-sql). **Auth:** Lucia 3.x + Drizzle adapter.

## Project Structure + Commands

`apps/web` (Next.js + 3D/2D game, :3000) · `apps/api` (Hono REST, :4000) · `packages/shared` (types + constants) · `packages/database` (Drizzle schema + migrations) · `packages/agent-runtime` (ElizaOS wrapper) · `packages/agent-templates` (10 location + system-agent templates). All `@clawville/*` prefix.

Commands: `bun install` · `bun run db:push` (schema) · `bun run db:seed` (10 locations) · `bun run db:studio` · `bun run build`. **NEVER `bun run dev`** — see local-testing rule.

## Environment Variables

Required in `.env.local`:

- `DATABASE_URL` — Supabase pooler Postgres.
- `GEMINI_API_KEY` — **fully UNUSED since 2026-06-05** (text billing 403'd; embeddings table was empty → no re-embed). Retained for easy-revert; nothing reads it. Anthropic removed 2026-04-10.
- `OPENAI_API_KEY` — **PRIMARY backend for BOTH** since 2026-06-05: text (`openai-text-provider` pri 95, `TEXT_SMALL`/`TEXT_LARGE` via `OPENAI_SMALL_MODEL`=`gpt-4o-mini` / `OPENAI_LARGE_MODEL`=`gpt-4o`; `npc-conversation-engine.ts`; chat-transient) **and** embeddings (`openai-embedding-provider` pri 100). Required for every non-OpenClaw runtime.
- **Embedding model + dim PINNED in code, NOT env** (2026-06-05): `openai-embedding-provider.ts` + `embed-text.ts` hard-code `text-embedding-3-small` / 1536-dim in the request body AND boot probe, so stored & query vectors can't diverge (pgvector always `dim_1536`). `OPENAI_EMBEDDING_MODEL`/`_DIMENSIONS` unread; changing the dim needs a re-embed migration (code edit, not env).
- `VANITY_ENCRYPTION_KEY` — 64-char hex. AES-256-GCM master key for `treasury_wallets` + `vanity_keypairs`. Must match on every decrypting machine.
- `FINGERPRINT_SECRET` — 64-char hex (32+ bytes), **hard-required** (`apps/api/src/middleware/fingerprint.ts` throws at module load if missing/short → API boot crash). `openssl rand -hex 32`. Salts the sha256 of `X-CV-Fingerprint` + IP /24 on every event row; server-only; rotating invalidates every fp_hash.
- `CLAWVILLE_MERCHANT_WALLET_PUBKEY` — base58 pubkey of Phase 4 x402 merchant wallet.
- `CORS_ORIGIN` — frontend URL(s) (prod `https://clawville.world`).
- `NEXT_PUBLIC_API_URL` — backend URL (prod `https://api.clawville.world`).
- `ADMIN_USER_IDS` — comma-separated UUIDs for `/api/dashboard/*` + `/dash`. Parsed at module load (changes need redeploy); `middleware/admin-only.ts`.
- `ITACHI_DEBUG_BOT_TOKEN` + `ITACHI_DEBUG_CHAT_ID` — itachi-debug Telegram bot for `alert-error.ts`. Missing ⇒ degrades to `console.warn`. Staged via tinker from `~/.itachi-api-keys`.
- `METRICS_MEASUREMENT_START` — `/dash` "Measuring since…" date (default `2026-04-21`).
- `AGENT_SESSION_TICKET_TTL_SECONDS` — Phase 5 magic-link TTL (default 600, min 60, max 3600 — `session-ticket-service.ts`).
- `RESEND_API_KEY` — transactional emails (verify-email + reset-password). Optional in dev (console fallback prints the payload); required in prod. From https://resend.com/api-keys.
- `FROM_EMAIL` — From-address (default `ClawVille <noreply@clawville.world>`). Sender domain MUST be Resend-verified or prod sends bounce 403.
- **Phase 5.1 env vars** (`CLOUDFLARE_WORKER_URL/_BEARER`, `CLAWVILLE_SERVICE_ISSUER_SK/_PUBKEY`, `SCAPE_HOSTED_SESSION_URL`, `SCAPE_WEB_ORIGIN`, `PARTNER_PUBKEYS`) — see `ARCHITECTURE.md §7`. Crash-loud rule: `FINGERPRINT_SECRET` + `CLOUDFLARE_WORKER_*` are hard-required on boot; missing ⇒ API refuses to start.
- **Wager program env vars** (`SOLANA_RPC_URL`, `WAGER_SETTLEMENT_AUTHORITY_PUBKEY`, `WAGER_SETTLEMENT_AUTHORITY_KEYPAIR_PATH`, `WAGER_PROGRAM_CLUSTER`) — see `ARCHITECTURE.md §13` (2026-05-13 entry). Devnet-only; mainnet requires a code change, not just `WAGER_PROGRAM_CLUSTER=mainnet`.

**Removed:** `ANTHROPIC_API_KEY` (ultrathink decommission).

## Deployment — Hetzner + Coolify (Railway decommissioned)

**Two VPS hosts (since 2026-05-23; real IPs/keys/UUIDs in gitignored `scripts/deploy/.env.deploy`):**
- **Production:** `$PROD_VPS_IP`, Hillsboro, Coolify 4.1, key `~/.ssh/clawville_hillsboro` (passphrase — `ssh-add` once). Serves `clawville.world` + `api.clawville.world`.
- **Staging:** `$STAGING_VPS_IP`, Ashburn, Coolify 4.0, key `~/.ssh/clawville_deploy`. Serves `staging.clawville.world` + `api-staging.clawville.world`.

Both: Cloudflare-proxied, **shared Supabase Postgres** (staging writes mutate prod data), auto-deploy on push (web ~3–5 min, api ~2–3 min). **App IDs:** prod api=2/web=3, staging api=3/web=4.

**Full deploy / emergency / rollback recipes → `docs/DEPLOY-HETZNER.md` § Current operations.** Two build-crash gotchas stay inline:
- **Env-var encryption gotcha:** NEVER write `environment_variables.value` via raw `DB::update()`+`\Crypt::encryptString()` — Coolify's mutator re-encrypts on save; raw writes break `decrypt()` and crash the build (`unserialize()`). ALWAYS `$row->value = $plain; $row->save();`.
- **DB migrations:** `bun run db:push` from root before deploy if you touched `packages/database/src/schema/*.ts` — Coolify does NOT migrate (destructive → `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true`). Scripts importing `@clawville/database` need `cd packages/database && bun run build` first.

### Browser verification after every deploy — MANDATORY

(1) Wait for Coolify (~3–5 min) or `curl -sS --ssl-no-revoke https://api.clawville.world/health`. (2) Open `https://clawville.world/game` via Chrome MCP. (3) Check buildings visible + not clipped, camera zoom, spawn center, FPS > 50, no console errors. (4) Chrome disconnected → tell user "I cannot verify — please screenshot". (5) NEVER claim a visual fix done without seeing it.

### Mobile + iPad verification — MANDATORY for EVERY UI/UX feature (set 2026-05-28 after joysticks shipped covered 3×)

Any change adding/moving on-screen UI (HUD, button, panel, modal, joystick, prompt, toast, banner) is NOT done until verified at mobile AND iPad viewports (desktop-only = #1 repeat-regression source) — run the full checklist in **`docs/mobile-ipad-verification.md`** (viewport sweep at phone/iPad-mini/Air/Pro portrait+landscape, per-size overlap + ≥44px tap-target checks, forced-live-state interaction, safe-area) BEFORE claiming done. **Touch gating** MUST use the canonical `useIsMobile()` hook (`maxTouchPoints > 1` + coarse-pointer), NEVER a bare Tailwind `md:`/`max-width` query — those miss iPad Air/Pro/landscape (the covered-joystick bug) [[feedback_ipad_detection_maxtouchpoints]]. Safe-area lifts CANNOT be proven in devtools emulation — need a real-iPad screenshot; state that, don't claim it verified.

### Local + Windows gotchas

**Test locally FIRST** with `bun run build && bun run start` — see the "Local testing FIRST" Kill-the-build invariant above (Iris-Xe-safe prod bundle on :3000; never `bun run dev`; don't push mid-iteration work to staging). Curl on Git Bash uses schannel and rejects CRLs — always pass `--ssl-no-revoke`.

## Game Modes

4 modes (`controlMode` in Zustand `game.ts` = `'explore'|'npc'|'player'|'autonomous'`). **No agent:** (1) **Explore** — floating spectator, free camera; (2) **NPC** — control a centered NPC pre-connect. **With agent:** (3) **Control** — full manual (WASD/joystick, building entry, chat); (4) **Autonomous** — connected agent explores itself.

## Architecture Notes

- **3D primary / 2D fallback:** Three.js `World3DCanvas` + PixiJS `PixiCanvas` share Zustand (arena: `Arena3DCanvas`/`ArenaCanvas`).
- **Agent lifecycle:** lazy-start on first chat, auto-stop after 30min idle (`agent-orchestrator.ts`).
- **One avatar/user** (unique `avatars.userId`). **Building zones:** 10 in `map-locations.ts`; **NPC sim** `npc-simulation.ts` (pathfinding, convos, activities).

## Scoped detail — lives in canonical docs

Owned by the canonical doc (read it when the file-path trigger fires):
- **10 buildings + OpenClaw focus** — `map-locations.ts` + `building-types.ts`; roster `WorldContent.md §2` (old sea-themed names superseded).
- **DB schema (row-level)** — `ARCHITECTURE.md §8`. Invariants: one avatar/user (unique `avatars.userId`); `wallets` = unified custodial (`subject_type ∈ {avatar, agent, treasury}`); `treasury_wallets` = team merchant supply, never user-facing.
- **ClawToken economy + books + daily login + archetypes** — `GameFeatures.md §4/§5/§8/§9a`. Write path: `claw-token-ledger.transferClawTokens()` — NEVER write `avatars.clawTokens` directly.
- **Agent Connection (Moltbook)** — `GameFeatures.md §2` + `ARCHITECTURE.md §6`. Agent-initiated; humans never paste credentials.
- **Phase 5.1 wallet identity + 'scape portal** — `ARCHITECTURE.md §7`. Two-keypair split (identity ed25519 + Solana wallet), envelope encryption via CF KEK, signed-challenge reconnect, portal via service-issuer signatures. "secretKey once" invariant is in Kill-the-build above.

## Code Style

TypeScript strict. Bun for API, Next.js for web. Kebab-case files, PascalCase components. Zod on all API inputs. `@/` path alias in web; `@clawville/*` for packages.

## Memory System (Itachi)
<!-- itachi-memory-system v5 -->

Persistent context across sessions. Two pools: `<project>` (this repo) and `_global` (cross-project). Full rules + recipes in the `itachi-init` skill — block is intentionally short here.

- **RULE 1 — Recall before you act.** Before unfamiliar work (new MCP/lang/framework, accumulating topic, error you may have solved before) query both pools via `POST $ITACHI_API_URL/api/memory/search` with `category: "lesson"`. Use `/recall <query>` as the shortcut. Higher `metadata.confidence` + `outcome:"success"` = stronger signal.
- **RULE 2 — Record immediately.** Quirk/constraint/API surprise / non-obvious pattern / A-failed-B-succeeded → `POST /api/memory/create` with `category: "lesson"`, one-line `summary` ("WHEN X, DO Y because Z"), `metadata.confidence` 0.6 start, `lesson_category ∈ tool-usage|debugging|pattern|constraint|workflow`. `_global` for tool quirks; `<project>` for repo-specific.
- **RULE 3 — Category discipline.** Only `lesson` is production. Don't write `task_lesson` or `project_rule`.
- **RULE 4 — Drive the test yourself.** User reports broken → reproduce end-to-end YOURSELF before asking. Confirm via DOM/logs, not speculation.
- **RULE 5 — Never assume, always verify.** Banned without same-response evidence: "should work", "looks right", "logic is correct", "I'm confident…". Verify by claim: "deployed" → `curl`/grep bundle; "build passes" → exit code; "env set" → `ssh env | grep`; "memory written" → query DB. When verification is impossible, say so.
- **RULE 6 — Find a bug, fix it.** Noticing ≠ fixing. No "note for later". Small → this session. Exhaust alternatives before escalating ("Tried A→err X, B→err Y, C→err Z, blocked by …").

Commands: `/recall <query>`, `/recent [limit]`, `/itachi-init` (install/upgrade). Disable: create `.no-memory` at project root.

## Audit + Bug Fix Policy

After implementing a plan: collaborative team audits against the plan, finds + fixes bugs, then re-audit with a new team. Bug found = bug fixed.

## Documentation Update Policy

Every session loads `~/.claude/projects/C--Users-newma-documents-crypto-clawville/memory/MEMORY.md` as durable rules. Precedence (memory < docs < code) is in the Kill-the-build block above.

**Same-diff doc updates (MANDATORY):** 3D world (placement/NPC/decor/seaweed/terrain/camera/lighting) → `3dStructure.md` · gameplay (modes/connect/marketplace/economy/quests/UI/toggles) → `GameFeatures.md` · tech (routes/DB tables/services/data-flow/deploy) → `ARCHITECTURE.md` · project invariants/workflow/env/commands → `CLAUDE.md` · user-facing overview → `README.md`.

**Rules:** "Update later" is unacceptable (3D edits enforced by 3da). `3dStructure.md` + `GameFeatures.md` are gitignored drafts but must stay accurate. Bump "Last Audited" on every touch.

**Anti-bypass:** shipping only a memory entry instead of the doc = same violation as skipping. Order: (1) code, (2) doc, (3) optional memory.

## ZERO LAZINESS POLICY

Non-negotiable; violations mean replacement by Codex. **Use the right tool immediately** (skills like `/browser-live`, `3da` on the first attempt) · **fix every bug when found** (no noting/deferring — Memory RULE 6) · **test for real** (`/browser-live` runtime, `curl` API, deploy + verify) · **verify, don't guess** ("this should work" ≠ verification — Memory RULE 5) · **act, don't narrate** · **all code reviewed by Codex** — ship work you'd defend.

### Feature Gates — enforce "no scaffolding theater"

Every scaffolded feature (compiled but not in user flow) MUST carry a `FEATURE_GATE` comment (metric to graduate, current `/dash` reading, review deadline, on-deadline action). Deadline lapses without the metric met → DELETED, not extended; renewal must cite a new metric reading, not "we still want this."

Gate block (TS comment lines): `FEATURE_GATE: <name>` · `Status` · `Metric to graduate` · `Current reading` (last `/dash` value) · `Review deadline` (YYYY-MM-DD) · `On deadline` · `Reference`.

Active gates as of 2026-04-21: `x402_payment_middleware`, `multi_agent_roster`, `skill_marketplace` (bazaar, marketplace, auctions). See `improvements.md` §7.

### No lazy handoffs — full ship loop is YOUR job

"Implement" = the **whole loop**: commit + push + verify deploy + verify in browser.

**When `git push` fails, try ALL before escalating (quote every error if you do):** (1) `gh auth status` — keyring token w/ `repo` scope → `unset GITHUB_TOKEN && gh auth setup-git && git push`; (2) `git remote -v` — HTTPS blocked → SSH remote (`git remote set-url origin git@github.com:USER/REPO.git`); (3) `env | grep -iE "gh_token|github_token"` — an invalid `GITHUB_TOKEN` env beats a good keyring token, unset first; (4) `gh api` / `gh pr create` for PR flows.

**Same "exhaust alternatives" rule every ship step** — trigger deploy: webhook → manual `php artisan tinker` via SSH; verify deploy: container uptime via SSH / `curl /health` / scan bundle via `fetch` in browser-live; verify browser: `browser-live` CDP eval / scan JS bundles for known strings / inspect scene graph.

"I tried one thing, over to you" is never acceptable. Test: would a senior engineer with these tools stop here?
