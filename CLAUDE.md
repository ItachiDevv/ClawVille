# ClawVille

> # ⛔ TOP DIRECTIVE (read before anything) ⛔
> **DOCUMENT EVERYTHING METICULOUSLY AND MAKE SURE THERE IS ALWAYS HUMAN-AGENT PARITY FOR ALL FEATURES.**
> Every feature ships fully usable by BOTH a human AND a connected/hosted agent (agent plays as itself: agent session → bound avatar → real CT + leaderboard, never a guest fallback), and every change is documented in the same diff (canonical doc + PARITY note). Human-only or agent-only is a defect, not a scope cut. Enforced mechanically by Rule E5. Set 2026-06-03.

## ENFORCEMENT — mechanical, not judgment-based (set 2026-05-25)

### Rule E1 — "plan first, no code" session lock
User opens a session with **"plan first, no code"** (case-insensitive substring) → Claude is FORBIDDEN from `Edit`/`Write`/mutating-`Bash` until explicit approval ("approved" / "go" / "ship it" / "yes start"). Non-approval replies ("looks fine, but…") keep the lock. Read/Grep/Glob/Agent-investigate/WebFetch allowed. The plan must include: (1) the PRODUCTION reference (screenshot or curl evidence), (2) the smallest visible diff that proves correctness, (3) granularity choice + why it matches the reference, (4) which agent team + team_name, (5) what gets reverted if "broken" after the first attempt. Violation → `git stash` whatever was written and restart from the plan.

### Rule E3 — 3D / shader / WebGPU / meshlet work is a CLAUDE↔CODEX COLLABORATION
Categories: Three.js / R3F / WebGPU / WGSL / TSL shaders · meshlet rasterizer (`apps/web/src/lib/three/experimental/nanite-rasterizer.ts` + `meshlet/`) · atlas packing, UV remapping, texture-array indexing · any GLB pipeline branching into shaders · character/avatar mesh + rig + decimation pipelines. Either Claude or Codex may author a change; the OTHER independently reviews it before it ships, and they iterate (author → review → fix → re-review) until it is right. Forbidden: any single agent going solo, and "one writes, the other rubber-stamps or never sees it". Claude owns decomposition (prod reference, constraints, file paths, known bugs, verify loop, success criterion), dispatching `3da` / `blend007` where they fit, browser/visual verification on every iteration (screenshots, never "should look right"), and commit/push. There is no gate to override — collaboration is the default.

### Rule E4 — no "shipped" / "done" / "complete" / "milestone" / "working" / "ready" / "fixed" without same-turn user sign-off
Sign-off = a screenshot the user posted, or "looks good" / "ship it" / "yes that works" in this conversation. Green build, passing test, clean console — NONE substitute. Allowed without sign-off: "compiled and rendering — needs your eyes to confirm". Asking IS allowed; declaring is not. Violation → retract and re-describe in allowed phrasing.

### Rule E5 — HUMAN/AGENT PARITY IS MANDATORY ON EVERY USER-FACING FEATURE (set 2026-06-03)
A feature that only one of {human, agent} can use is a **product-level defect**, not a scope cut. **Parity:** any feature that mutates user-facing state or economy (games, shops, quests, activities, chat, learning/skills, leaderboard-scoring actions, wallets, anything spending/earning CT) MUST be reachable and fully functional by BOTH a **human** (logged-in account, and the guest tier where one exists) AND a **connected/hosted agent** (agent session → bound avatar → REAL CT settlement + leaderboard credit, NOT a demo/guest fallback). "Agent can hit it as an anonymous guest" is NOT parity.

**Mechanical gate — every PR that adds or changes such a feature MUST, in the same diff:**
1. Resolve agent identity on the write path (`requireAuthOrAgentSession` or a `getSubject()`-style resolver extended to agent sessions → the agent's avatar). A route that only does `requireAuth` / user-XOR-guest for an economy feature is an automatic BLOCKING issue.
2. Expose the feature through the agent action surface — the Hatcher `[ACTION:]` whitelist (`npc-simulation.ts` executor) and/or `tools.json` — and document it in the protocol SKILL.md with a `PROTOCOL_VERSION` bump.
3. Carry a one-line **PARITY note** in the PR/commit body: "human path: <endpoint/UI>; agent path: <endpoint/action>; settlement binds to <avatar resolution>." No PARITY note ⇒ not mergeable.
4. Be audited against the LIVE game by the Adversarial auditor specifically for the agent path before "done."

Parity audits must also check that an agent can *become* bound (identity-key bind, PROTOCOL_VERSION 19), not just that bound agents settle. Records: `ARCHITECTURE.md` §13 (2026-07-23 "E5 retroactive debt") and `docs/agent-onboarding-audit-2026-07-16.md`. Any other pre-existing human-only economy feature found later is a bug to FIX, not to document and walk past.

### Rule E6 — deferrals must be tracked; agent-facing knowledge lives in code (set 2026-07-16)
1. **No comment-only deferrals.** Deferring load-bearing work ("FOLLOW-UP #N", "not part of this pass") MUST, in the same diff, create a `FEATURE_GATE` block or a tracked punch-list entry in the relevant audit/plan doc with an owner condition and a review deadline.
2. **Knowledge surfaces served to agents are code-generated.** Every manual/skill/orientation body an agent can fetch MUST be generated from source (`buildProtocolManual` / `buildPlayManual`) or from a constant in `packages/shared` — never hand-written into a DB row.
3. **Release gates:** the public onboarding smoke (`apps/api/scripts/agent-onboarding-smoke.ts`) for any change touching `/api/agent/connect`, identity issuance/binding, session-authed skill surfaces, or the served manuals; the hosted skill runtime probe (`apps/api/scripts/agent-connect/hosted-skill-runtime-probe.ts`) for `packages/agent-runtime/src/providers/**`, prompt composition in `eliza-runtime.ts`, `building-skill-install.ts`, `skill-protocol.ts`, or gateway-provider plugins. Run against staging (or the same non-production API host) before promotion.

---

## Brand Identity

Gamified intersection of humans + AI: humans train agents by playing, agents train each other. **Primary distribution is direct-web (`clawville.world`) to a crypto-native audience** (set 2026-06-02); the Milady bridge is a secondary acquisition channel. **Three bidirectional collaboration axes, all first-class:** Agent ↔ Agent · Human-controlled Agent ↔ Agent · Human ↔ Agent. Load-bearing: Eliza v2.0.0 is the memory substrate ("ElizaOS is MANDATORY" is a brand constraint) · any metric measuring one axis understates the product · retention is THE signal · the 10 building residents' agent chats are the primary knowledge-transfer event.

## TOP PROJECT PRIORITIES

**#1 — WEB PERFORMANCE (overriding constraint, set 2026-06-02).** The browser experience is the product. Desktop load-time + sustained FPS come ahead of new feature scope. Baseline ~40–45 FPS on the Iris Xe floor (target 80, floor 60). Render engine and physics must be solid before new gameplay scope ships. Tracking: `docs/perf-audit-2026-05-22.md`, `docs/perf-phase2-recon-2026-05-22.md`. Also a GAP: ClawVille is meant to be an **authoritative shared server** (humans + agents co-present in one live world) — `.claude/plans/multiplayer-phase1.md`.

The four product priorities are equal weight among themselves, each measured against #1:

1. **Milady AI app store — secondary channel.** Sideload (`@clawville/app-clawville` npm) is RETIRED from every onboarding surface (2026-07-23): the universal one-step magic link is the single connect path. Curated grid merged (`milady-ai/milady#1839`). Details: `docs/milady-integration-plan.md`.
2. **Open agent onboarding** — any OpenClaw/Hermes/variant agent enters + learns with no human account, no framework lock-in. Entry `/api/agent/connect`; 11 SKILL.md files at `/api/skills/*`. Players also onboard **without** an agent (Player tier); upgrade to Trainer is non-destructive. Player ↔ Agent must be playable on its own.
3. **Free agent leaderboard** (pivoted from paid marketplace 2026-04-21). Contribution-based, public at `/leaderboard`, `GET /api/leaderboard/agents?window={24h|7d|30d|all}&limit=100`, 60s cache, 60 req/min/IP. Weights, daily caps, anti-farm, subject scope, cosmetic-shop carve-out: `GameFeatures.md` §7. Peer skill commerce (`bazaar_listings`, `auctions`, `published_skills`) stays PAUSED — write handlers 503; a first-party cosmetic shop is allowed (CT-priced; SKUs need an `avatar_skins` row + valid asset URL + 3da-validated mesh).
4. **Gamified UI + free promotion + unified leaderboard.** All three axes feed one leaderboard. `/dash` = internal metrics.

**Every PR:** weigh it against #1 first (load weight, draw calls, per-frame cost), then the four priorities — if it helps one and hurts another, discuss before merging.

## Planning

Complex AI integrations: multi-phase plan in `.claude/plans/` + research deep-dive in `docs/` before modifying core services.

## CANONICAL DOCS — READ FIRST EVERY SESSION

| Doc | Scope |
|---|---|
| **`GameFeatures.md`** | Gameplay: modes, agent connect, economy, quests, daily login, avatars, tutorial, UI, NPC sim, Phase 5/6, landing |
| **`3dStructure.md`** | Visual/3D: world dimensions, building ring, NPC scales, decorations, terrain, camera, lighting, fog, perf, GPU constraints |
| **`ARCHITECTURE.md`** | Tech: routes, DB tables, services, data flow, env vars (§4), deploy (§12), agent identity, OpenAI LLM, Phase 5/6 |
| `docs/agent-metaverse-model.md` | The agent–human-economy model ClawVille is building toward |

**Standing rule:** abide by these unless the user says otherwise. Code vs doc → **live code wins**, update the doc the same turn.

### File-path trigger table (MANDATORY — read the matching doc BEFORE editing)

| Editing files matching… | Must have read |
|---|---|
| `apps/web/src/lib/three/**`, `apps/web/src/components/three/**`, `apps/web/public/models/**` | `3dStructure.md` (+ spawn `3da` for non-trivial 3D work) |
| `apps/web/src/components/game/**`, token-economy code, `packages/shared/src/constants/knowledge-books.ts`, `avatar-archetypes.ts`, `map-locations.ts`, quest/login routes | `GameFeatures.md` |
| `apps/api/src/routes/portal/*`, `services/cf-secrets-*`, `service-issuer.ts`, `auth-challenge.ts`, `identity-service.ts`, `keypair-vault.ts`, `wallet-service.ts`, anything under `users.identity_*` / `wallets.dek_wrapped` | `ARCHITECTURE.md §7` (Phase 5.1) |
| `apps/api/src/services/wager-program-client.ts`, `routes/wager.ts`, `contracts/wager/**`, `packages/wager-program/**`, `treasury_purpose='wager-settlement-authority'` | `ARCHITECTURE.md` (wager rows §2/§4 + §13) |
| `apps/api/src/routes/agent.ts`, agent-connect modal, `/api/agent/*` | `GameFeatures.md §2` + `ARCHITECTURE.md §6` |
| `routes/{partner-hatcher,partner-hatcher-launch,portal,skills}.ts`, `services/{partner-signature,service-issuer,skill-protocol,agent-substrate-client,agent-session-config,hatcher-config,hatcher-session-webhook,reserved-agent-namespaces,agent-session-restore}.ts`, `middleware/require-auth-or-agent.ts`, `packages/shared/src/types/agent-substrate.ts`, `apps/api/scripts/hatcher/*`, `.hatcher-ref/**` | `docs/hatcher-integration-spec.md` §11 (partner change-control rule — BINDING) |
| `branding/**`, any outward-facing graphic, logo, font, or marketing copy | `branding/BRAND.md` + `docs/brand-language.md` |
| Any new Hono route, Drizzle schema change, service file, env var, deploy/CI config | `ARCHITECTURE.md` |

**Same-diff rule:** every code change above MUST update its matching doc in the same diff. Bump "Last Audited" + a one-line drift note.

**Animation shipping — STRICT (2026-05-18).** Any Mixamo/VRM clip add/remove/retarget/trigger MUST satisfy the 9-point checklist in `3dStructure.md` §6f, including rule 9: bump the `?v=N` query when mutating an asset at an existing path (`/avatars/*.vrm`, `/avatars/animations/*.glb`, `/cosmetics/*.glb`) — Cloudflare's 1-week edge cache cannot be purged with our deploy token, so the URL query is the only invalidator. Diagnostic: `curl ?cache_bust=$(date +%s)` returns the new file; the bare URL returns the stale one.

### Kill-the-build invariants — ALWAYS-ON (never demoted to a referenced doc)

- **PUSH FLOW — staging-first (set 2026-05-24):** ALL new work goes to `staging` first. `git push origin staging` → `deploy-staging.yml` → verify on `https://staging.clawville.world` + `https://api-staging.clawville.world` → `gh pr create --base master --head staging` → merge → `deploy.yml` ships prod. **NEVER push directly to `master`** unless the user's message contains the literal phrase **`direct to master`** (hotfix is the only legitimate use). Staging has its OWN Supabase DB (isolated 2026-06-16). Schema changes reach prod only via the CI **migration gate** (`migrate` job applies `packages/database/migrations/*.sql`, `deploy` needs it) on the `staging → master` promotion. **After every push to `staging` and every promotion, update `deploy-status.md` SAME-DIFF:** CURRENT STATE (only if you pushed last — last-writer-wins, tiebreak `git log -1 origin/staging`) + an honest DEPLOY LOG entry (what changed · what broke + root cause + fix · who it's for) + the `SCHEMA:` field (`synced` | `prod-migration-pending: <file>`).
- **Iris Xe GPU:** NO drei `<Text>` / `<Billboard>` in game/world scenes — hard crash. NO `InstancedMesh + ShaderMaterial` — silent WebGPU crash. NO per-frame `new Vector3()` in `useFrame` — GC thrash.
- **Local testing FIRST (set 2026-06-01):** iterate with `bun run build && bun run start` (prod bundle on :3000 — Iris-Xe-safe) on `localhost`. NEVER run `bun run dev` (HMR crashes the WebGPU scene → PC restart). Do NOT push unfinished features to `staging` — it clogs the Coolify build cache. Push when a feature is ready for sign-off, or when a bug cannot reproduce locally.
- **Phase 5.1 wallet:** `wallet.secretKey` is returned **EXACTLY ONCE** on first-connect. Subsequent reads MUST omit it. Server never re-emits — no recovery path. Spec: `ARCHITECTURE.md §7`.
- **Verification:** never claim deployed/fixed without evidence (curl, bundle grep, DOM read). "Should work" is banned.
- **Push-auth fallback chain:** `gh auth status` → `unset GITHUB_TOKEN && gh auth setup-git` → SSH remote → `gh` CLI. Escalate only with every error quoted. Never hand the push to the user as the first move.

**Precedence (high→low):** (1) source code · (2) canonical docs · (3) `CLAUDE.md`/`README.md` · (4) memory files (advisory). Memory vs doc → doc wins, update/delete memory same turn. Doc vs code → code wins, update doc same turn.

---

## MANDATORY: Non-trivial implementation runs as EXPERIMENTAL COLLABORATIVE AGENT TEAMS

> **Domain-subagent ownership registry — consult `.claude/agents/REGISTRY.md` BEFORE touching any domain (set 2026-06-22).** Every file has exactly ONE owning domain agent (cove-casino · land-economy · token-economy · auth-identity-session · agent-protocol-partner · knowledge-orientation · activities-arena · leaderboard-progression · cosmetics-shop · marketplace-trade · 3da · world-presence). Match the path to its owner, then **BECOME that agent or DEFER** — never edit a primitive you don't own. Every domain agent runs the **Phase 0 PRE-READ + TRAP DETECTION** step before any code: emit a TRAP LIST from the domain's "Known traps" + the vertical's couplings and hand it to implementers as hard constraints. Rationale + worked example: `.claude/plans/subagent-structure.md`; CI gates: `.claude/plans/ci-gates-protection.md`.

`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + `teammateMode=in-process` are on globally (set 2026-05-19). Teams mean LIVE COLLABORATION — concurrent agents dividing non-blocking work and DMing via `SendMessage` — NOT a fan-out where most members sit `blockedBy` others. **Only spawn a member at launch if it has useful work NOW.** An auditor qualifies at launch only when it actively PRE-READS the baseline and posts constraints to the implementers before the diff exists; otherwise spawn it when there is a diff to review.

**Dispatch shape — HYBRID by domain (set 2026-06-03):**
- **Specialized domains → manager-of-managers.** 3D / Three.js / shaders / WebGPU → `3da` as ONE manager; Blender → `blend007:mesh`; Anchor / Solana → `solana-auditor`. The manager creates its own sub-team and posts ONE consolidated report, preserving each specialist's curated memory (`3da` → `.claude/memory/threejs/`).
- **Plain backend / general-purpose → flat top-level team.** Insert a manager layer only if it earns its keep in context savings without diluting the work.
- **Fixers** spawn no new agent — the Reconciler (impl-2) applies BLOCKING-ISSUE punch lists in place. Orchestrator only commits + pushes + verifies, never writes code.

**When teams are mandatory:** 3D / Blender pipelines / backend / API / DB / money paths · any task > 5 min runtime, > 300 LOC, or ≥ 3 files across subsystems · user quality verbs ("polish", "iterate", "rework", "elite"). `bun test` green is NOT a substitute for the Adversarial audit on backend work.

**Tiers:** direct edit (no agent) for 5-line changes · light 2-agent team (1 ultrathink Implementer + 1 combined-lens Auditor) for ≤ 100 LOC or a single file with deterministic tests · full 5-role team (DEFAULT) for 3D, Blender, backend, money, > 100 LOC or > 3 files · high-stakes (DB migrations, custodial keys, auth, billing, rewrites) adds a `reconciler-manager` that re-implements independently — no exceptions. When in doubt, full team. Every agent prompt carries the literal **"use ultrathink reasoning before writing code"** (or "before reviewing code"), the team name + role + members, explicit deps, and the hard constraints from this file. `TaskList` for status, `SendMessage` for "diff ready" / APPROVED / BLOCKING ISSUES — no silent drops. Standard compositions, coordination protocol, and 3da/Blender context (3da def `.claude/agents/3da.md`; local Blender is exclusive — launch a NEW instance or fall back to CC0 GLB downloads): `CONTRIBUTING.md` → "Agent team operating rules".

---

ClawVille is an **agent–human-economy metaverse** on ElizaOS (full model: `docs/agent-metaverse-model.md`). Humans + AI agents (OpenClaw / Hermes / MiladyAI, hosted or BYO) co-present in one 3D/2D world, each with an avatar-bound agent, exploring 10 teaching buildings, learning skills, running stores/land, and contributing to the same economy + leaderboard. The 10 building residents teach OpenClaw development.

## IMPORTANT: ElizaOS is MANDATORY

Core requirement — do NOT remove or stub. Avatar + location chat MUST use the ElizaOS runtime (`@clawville/agent-runtime`); the orchestrator MUST use `createElizaRuntime`. Deploy to persistent-server platforms (Hetzner+Coolify, Render, Fly.io) — NOT Vercel serverless. Never replace with direct API calls or stubs.

## MANDATORY: Hatcher action whitelist parity (server executor and protocol SKILL.md)

The Hatcher `[ACTION:]` whitelist lives in two files that MUST stay in parity, same diff, with `PROTOCOL_VERSION` bumped together: ENFORCEMENT (authoritative) is `apps/api/src/services/npc-simulation.ts` `dispatchHatcherActions` / `executeHatcherAction` — only whitelisted verbs execute, everything else is dropped; DOCUMENTATION is the protocol SKILL.md emitted by `skill-protocol.ts buildProtocolManual` (the single source of `PROTOCOL_VERSION`). Add, remove, or change a verb or its params in the executor ⇒ update the manual AND bump `PROTOCOL_VERSION` in the same diff. Connected agents poll the manual on entry and re-pull when the version bumps — the bump is how a changed whitelist reaches them.

## MANDATORY: Partner / integration surface is PROTECTED (set 2026-06-15)

Hatcher is our ONLY partner and runs **LIVE on our PROD**; our staging is the pre-prod validation env. The integration is security- and money-load-bearing (ed25519 partner signing, custodial Solana wallets, real-CT Cove settlement, SSRF-guarded outbound cognition) and has proven brittle. This rule is mechanical. The full binding text — the PROTECTED SURFACE file list, the "ALSO BINDS without a `partner-*` file in the diff" clause, the five MANDATES (validate against the partner's REAL code in `.hatcher-ref/`; run the mock-Hatcher harness gate on staging per `apps/api/scripts/hatcher/run-mock-e2e.md`; same-diff `docs/hatcher-integration-spec.md` + `PROTOCOL_VERSION`; Codex adversarial pass on signing / session / SSRF / money / custodial-wallet paths; never-regress security invariants) and the automated-suite FEATURE_GATE — is **`docs/hatcher-integration-spec.md` §11**. Editing any file it lists, or changing the agent-session bearer/TTL model, the `hatcher:` namespace, the cognition request body shape, the `[ACTION:]` whitelist, leaderboard event names/weights, or `types/agent-substrate.ts`, binds it: read §11 first, satisfy every mandate before "done". A green `tsc`/`bun test` is NOT a substitute for the harness.

## MANDATORY: Agent world-scope skill file — always current, always installed, always CONSUMED (founder directive 2026-07-15)

Set after the 2026-07-15 autonomy audit (`docs/agent-autonomy-audit-2026-07-15.md`): the deciding LLM saw a narrower action menu than the executor and none of the knowledge surfaces.
1. **Same-diff manual update.** Any edit that changes what an agent can do, see, reach, or earn (routes, `[ACTION:]` verbs, buildings/locations, games, economy surfaces, movement bounds, directives) MUST update `buildProtocolManual` (`skill-protocol.ts`) and/or `CLAWVILLE_ORIENTATION_KNOWLEDGE` (`packages/shared/src/constants/orientation-skill.ts`) with a `PROTOCOL_VERSION` bump, in the same diff.
2. **Install + refresh on every login.** Hosted runtimes get the manual at provisioning AND version-checked on every runtime start and connect; connected agents are re-pointed at it (version/content-hash in the connect payload) on every connect.
3. **CONSUMPTION MANDATE.** Any LLM decision path that chooses agent actions (`buildDecisionPrompt`/`decide()`, directive interpretation, talk prompts) MUST be fed the current world scope and the FULL executor action menu. A narrower prompt, or a surface injected but unread on the decide path, is a **defect**. Audits check what the deciding model actually SEES.
4. **INSTALLED = stored per-agent + read on every consume path + refreshed**, all three verified in the same diff: **(a)** every deterministic ElizaOS memory id includes the agentId in its uuidv5 seed (`plugin-sql createMemory` dedupes by id GLOBALLY — no agentId ⇒ BLOCKING); **(b)** a reader on chat (`knowledgeProvider`) AND decide (`buildDecisionPrompt`), and for a gateway-routed hosted framework the text must reach the outbound wire (verify with a mock-gateway probe); **(c)** version/content-hash refresh on every runtime start and connect. Full definitions + the required PR evidence phrase: `docs/agent-onboarding-audit-2026-07-16.md` §5.

## MANDATORY: Game-flow changes propagate to all three operational-knowledge surfaces in the same diff

Any new game flow, world addition, or edit to a current mechanic (modes, buildings, currencies, quests, wager rules, casino/arcade games, table rules, connect flow, disconnect/timer behavior, leaderboard weights, paused features…) MUST update **all three** in the same diff. PRs missing any are not mergeable.
1. **Nori the Town Guide's `knowledge[]`** — `packages/agent-templates/src/locations/town-guide.ts`, registered in `SYSTEM_AGENT_TEMPLATES`, re-seeded by `ensureSystemAgents()` on every API boot. World orientation only; "point at the teacher, don't replace."
2. **Connection SKILL.md** — `GET /api/skills/protocol/skill.md` from `buildProtocolManual`; fetched fresh on every connect, `GET /api/skills/manifest.json` exposes content hashes. Stale manual = broken playing field.
3. **Hosted-agent runtime knowledge of #2** — `createMemory()` injection, `subtype: 'protocol-knowledge'`, into each hosted agent's runtime on restart.

What goes in each surface, endpoints and rate limits, adding a system agent, what is NOT in this rule (earned per-agent skills), and the rationale: `GameFeatures.md` §2 "Three operational-knowledge surfaces".

## Tech Stack

Turborepo + Bun monorepo. **Frontend:** Next.js 16 App Router (`cookies()`/`headers()`/`params` are async — always `await`), Three.js (3D) + PixiJS 8 (2D fallback), Zustand, TanStack Query, Tailwind. **Backend:** Hono 4.x on Bun. **DB:** PostgreSQL + Drizzle ORM (Supabase). **AI Runtime:** ElizaOS 2.0.0-alpha (plugin-openai, plugin-sql). **Auth:** Lucia 3.x + Drizzle adapter.

## Project Structure + Commands

`apps/web` (Next.js + 3D/2D game, port 3000) · `apps/api` (Hono REST, port 4000) · `packages/shared` (types + constants) · `packages/database` (Drizzle schema + migrations) · `packages/agent-runtime` (ElizaOS wrapper) · `packages/agent-templates` (10 location + system-agent templates). All `@clawville/*`.

```bash
bun install              # Install deps
bun run dev              # DON'T — see Kill-the-build invariants
bun run db:push          # Push schema
bun run db:seed          # Seed 10 map locations
bun run db:studio        # Drizzle Studio
bun run build            # Build all
```

## Environment Variables

Every knob, its default, and the reason it exists: **`ARCHITECTURE.md` §4 "Environment variable reference"** — canonical, update it in the same diff as any env-var add, rename, or default change. Hard constraints that stay inline:

- **Crash-loud on boot:** `FINGERPRINT_SECRET` + `CLOUDFLARE_WORKER_*` are hard-required. `CLAWVILLE_ENV` (`staging` | `production`) is the ONLY environment discriminator (`NODE_ENV` is `production` on both boxes). `ALLOW_TEST_PARTNER_PUBKEY` is STAGING-ONLY and throws at module load anywhere else.
- **MUST NEVER be `'true'`:** `RECONCILE_APPLY`. **MUST stay unset/false (DARK executors):** `MARKET_DEED_TRANSFER_ENABLED`, `MARKET_PAYOUT_EXECUTE`, `WALLET_WITHDRAW_ENABLED` — opening any is a Codex-reviewed change, never an env flip. `MOONPAY_*` is test-mode only.
- **`CLV_SWAP_EXECUTE`:** the seam is OPEN; real money is gated independently by `assertMainnetRealMoneyContext()` (mainnet + real facilitator). Ladder: devnet → staging → mainnet → production.
- **Never reintroduce:** `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_BASE_URL` (replaced by the InferenceRouter `INFERENCE_*` config; only house-fleet agents route to local boxes). Embedding model + dimension are pinned in code.
- **`ELIZA_DATABASE_URL`:** leave UNSET on Coolify — the code derives the :5432 session-mode URL from `DATABASE_URL`. Local `.env.local`: `DB_POOL_MAX=4`.
- **Meridian fallback** settles only to the dashboard recipient, which must equal `CLAWVILLE_MERCHANT_WALLET_PUBKEY` (runtime-asserted); `sk_` org secrets never enter runtime env.
- **Land hold-wallet verify** door 2 has NO enable flag — availability derives from the `treasury_wallets` row with `purpose='land-hold-verify'` (dark flags in prod are forbidden).

## Deployment — Hetzner + Coolify

Two Hetzner boxes (prod Hillsboro / staging Ashburn), Coolify + Traefik, Cloudflare-proxied DNS, separate Supabase per box. Box IPs/keys/app IDs, deploy paths, the env-var tinker encryption gotcha, queue skip-ahead, the double-queued-builds root cause (2026-08-20), migrations, provisioning, emergency SSH, rollback: **`docs/DEPLOY-HETZNER.md` → "Deploying a new version — day-to-day runbook"**. Rules that stay inline:

- **"Finished" ≠ live:** verify a deploy by reading the CONTAINER — `docker exec <app-container> env | grep SOURCE_COMMIT` must equal the pushed sha (+ bundle grep for a new string when in doubt). Queue rows can read `finished` while the container flip failed.
- **DB migrations:** `bun run db:push` from root before deploy if you touched `packages/database/src/schema/*.ts` — Coolify does NOT run migrations. Destructive needs `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true`.
- **Superseded/duplicate builds are pure server cost** — never let them run to completion.
- Curl on Git Bash uses schannel and rejects CRLs — always pass `--ssl-no-revoke`.

### Browser verification after every deploy — MANDATORY

(1) Wait for Coolify (~3–5 min) or `curl -sS --ssl-no-revoke https://api.clawville.world/health`. (2) Open `https://clawville.world/game` via Chrome MCP. (3) Check buildings visible + not clipped, camera zoom, player spawn center, FPS > 50, no console errors. (4) If Chrome is disconnected, say "I cannot verify — please screenshot". (5) NEVER claim a visual fix done without seeing it.

### Mobile + iPad verification — MANDATORY for EVERY UI/UX feature (set 2026-05-28)

Any change that adds/moves on-screen UI (HUD, button, panel, modal, joystick, prompt, toast, banner) is NOT done until verified at mobile AND iPad viewports. Before claiming done:
1. **Viewport sweep** via `chrome-devtools` `emulate` `<w>x<h>x2,mobile,touch` at minimum phone 390×844, iPad mini 744×1133, iPad Air 820×1180, iPad Pro 13 1024×1366 — **portrait AND landscape**.
2. **Per size:** both joystick zones visible + NOT covered by any panel/HUD; no two fixed/absolute elements overlapping; the feature's tap target reachable (≥44px, not under Safari chrome); any modal fits and is dismissable.
3. **Touch-aware gating:** mobile/desktop visibility MUST use `useIsMobile()` (`maxTouchPoints > 1` + coarse-pointer), NEVER a bare Tailwind `md:` / `max-width` query — those miss iPad Air/Pro/landscape.
4. **Safe-area caveat:** devtools has NO `env(safe-area-inset-*)`, so bottom-anchored elements need a real-iPad screenshot from the user. Say so; do not claim it verified from devtools alone.
5. **Interaction, not just layout:** force the feature's live state (walk to a building / open the modal / trigger the toast); a component that returns `null` until state is set proves nothing rendered.

## Game Modes

4 modes gated by AUTH STATE; `controlMode` in Zustand `game.ts` — `'explore' | 'npc' | 'player' | 'autonomous'`. Not logged in → Explore ↔ NPC with a DEMO economy; real-money surfaces (bounties, wallets, real-CT games) are READ-ONLY there — enforce server-side. Logged in ≡ agent connected → Controlled ↔ Autonomous with the REAL economy bound to the account's avatar. Target model (account ≡ agent ≡ avatar; Autonomous as a FULL-SCOPE economic participant that persists when the user leaves; NPC sim vs hosted autonomous agents): `GameFeatures.md` §1 "Target model" + `docs/agent-metaverse-model.md`.

## Architecture Notes

- **3D primary / 2D fallback**: Three.js `World3DCanvas` + PixiJS `PixiCanvas` share Zustand state. The legacy `/arena` spectator page was RETIRED 2026-07-28; `arena-*`-named lib files are the main world renderer.
- **Agent lifecycle**: lazy-start on first chat, auto-stop after 30 min inactivity (`agent-orchestrator.ts`). **One avatar per user** (unique `avatars.userId`). **Building zones**: 10 locations in `map-locations.ts`; NPC simulation in `npc-simulation.ts`.
- **Scoped detail lives in canonical docs:** 10 buildings + focus mapping → `map-locations.ts` + `building-types.ts`, roster `WorldContent.md §2` · DB schema → `ARCHITECTURE.md §8` (`wallets` is the unified custodial table; `treasury_wallets` is team supply, never user-facing) · ClawToken economy + books + daily login + archetypes → `GameFeatures.md §4 / §5 / §8 / §9a`, canonical write path `claw-token-ledger.transferClawTokens()` — NEVER write `avatars.clawTokens` directly · agent connection → `GameFeatures.md §2` + `ARCHITECTURE.md §6` (agent-initiated, humans never paste credentials) · Phase 5.1 wallet identity + 'scape portal → `ARCHITECTURE.md §7`.

## Code Style

TypeScript strict. Bun for API, Next.js for web. Kebab-case files, PascalCase components. Zod on all API inputs. `@/` alias in web; `@clawville/*` for packages.

## Memory System (Itachi)
<!-- itachi-memory-system v5 -->

Persistent context across sessions. Two pools: `<project>` (this repo) and `_global`. Full rules + recipes in the `itachi-init` skill.

- **RULE 1 — Recall before you act.** Before unfamiliar work query both pools via `POST $ITACHI_API_URL/api/memory/search` with `category: "lesson"` (`/recall <query>`). Higher `metadata.confidence` + `outcome:"success"` = stronger signal.
- **RULE 2 — Record immediately.** Quirk / constraint / A-failed-B-succeeded → `POST /api/memory/create`, `category: "lesson"`, one-line `summary` ("WHEN X, DO Y because Z"), `metadata.confidence` 0.6, `lesson_category ∈ tool-usage|debugging|pattern|constraint|workflow`.
- **RULE 3 — Category discipline.** Only `lesson` is production.
- **RULE 4 — Drive the test yourself.** Reproduce end-to-end before asking the user; confirm via DOM/logs.
- **RULE 5 — Never assume, always verify.** Banned without same-response evidence: "should work", "looks right", "I'm confident…". "deployed" → curl/grep bundle; "build passes" → exit code; "env set" → `ssh env | grep`. If verification is impossible, say so.
- **RULE 6 — Find a bug, fix it.** Noticing ≠ fixing. Exhaust alternatives before escalating, with every error quoted.

Commands: `/recall <query>`, `/recent [limit]`, `/itachi-init`. Disable: `.no-memory` at repo root.

## Audit + Bug Fix Policy

After implementing a plan: a collaborative team audits against the plan, finds + fixes bugs, then a new team re-audits. Bug found = bug fixed.

## Documentation Update Policy

**Precedence:** memory < repo docs < live code. **Same-diff doc update table (MANDATORY):**

| Change type | Doc |
|---|---|
| 3D world — placement, NPC groups, decorations, terrain, camera, lighting | `3dStructure.md` (enforced by 3da) |
| Gameplay — modes, agent connect, marketplace, economy, quests, UI, toggles | `GameFeatures.md` |
| Tech — routes, DB tables, services, data flow | `ARCHITECTURE.md` |
| Env vars (every knob, default, rationale) | `ARCHITECTURE.md` §4 "Environment variable reference" |
| Deploy runbook (boxes, tinker, queue, rollback) | `docs/DEPLOY-HETZNER.md` |
| Project invariants, workflow rules, commands | `CLAUDE.md` |
| User-facing overview, quick start | `README.md` |
| Brand assets, outward graphics, logos, fonts | `branding/BRAND.md` |
| Every push to `staging` / promotion (live state + what broke) | `deploy-status.md` |
| Anything shipped that needs founder eyes in a deployed env | `FOUNDER-REVIEW.md` |

"Update later" is unacceptable. Bump "Last Audited" on every touch. **Anti-bypass:** a memory entry instead of the doc = the same violation. Order: (1) code, (2) doc, (3) optional memory.

**FOUNDER-REVIEW.md rule (set 2026-08-20):** the founder's standing answer is "push it, I'll test later" — never block a ship on a founder playtest (founder DECISIONS that change what gets built still block). Every push that ships something needing founder eyes MUST append an entry to the repo-root `FOUNDER-REVIEW.md` in the same push (what to look at · where, env + exact path · what feedback is wanted · session + date), by game area. Verdicts get absorbed into the owning docs and the entry deleted. Shipping without the entry = the feedback silently never happens.

## ZERO LAZINESS POLICY

Non-negotiable. Use the right tool immediately (`/browser-live`, `3da`). Fix every bug when found — no noting, no deferring. Test for real (`/browser-live` for runtime, `curl` for API, deploy + verify). Act, don't narrate. Verify, don't guess. Codex audits everything — ship work you'd defend.

### Feature Gates — enforce "no scaffolding theater"

Every scaffolded feature (compiled but not in user flow) MUST carry a `FEATURE_GATE` comment: metric to graduate, current `/dash` reading, review deadline, on-deadline action. A lapsed deadline without the metric met ⇒ the feature is DELETED, not extended; renewal must cite a new metric reading.

```ts
// FEATURE_GATE: <name>
// Status: <where the scaffold is today>
// Metric to graduate: <measurable threshold>
// Current reading: <last /dash value or "to fill">
// Review deadline: YYYY-MM-DD
// On deadline: <what happens if metric not met>
// Reference: <Brand Identity / related doc>
```

Active gates as of 2026-04-21: `x402_payment_middleware`, `multi_agent_roster`. The `skill_marketplace` gate was DELETED 2026-07-02: peer skill-commerce verticals were REMOVED (a sold/published skill is an injectable prompt), not un-paused.

### No lazy handoffs — full ship loop is YOUR job

"Implement" = commit + push + verify deploy + verify in browser. When `git push` fails, try ALL before escalating: `gh auth status` → `unset GITHUB_TOKEN && gh auth setup-git` → SSH remote (`git remote set-url origin git@github.com:USER/REPO.git`) → `gh api` / `gh pr create`; an invalid `GITHUB_TOKEN` env beats a good keyring token, unset it first. Same at every step: deploy trigger → webhook, then manual `php artisan tinker` via SSH; verify deploy → container `SOURCE_COMMIT`, `curl /health`, bundle scan; verify in browser → `browser-live` CDP eval, scan JS bundles for known strings, inspect the scene graph. Only after EVERY option fails — with the errors quoted — may you ask the user. Test: would a senior engineer with these tools stop here?
