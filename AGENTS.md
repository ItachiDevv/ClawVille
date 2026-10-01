# ClawVille

## Local workspace boundary — founder instruction, 2026-09-22

- Keep ClawVille source, documentation, assets, reports, and local evidence inside this checkout or a registered Git worktree.
- Create new worktrees under `.worktrees/<task>` inside ClawVille by default. Verify registration with `git worktree list --porcelain`.
- Do not create unregistered sibling folders for project work. A directory name is not proof of Git registration.
- Existing registered external worktrees may remain in place. Coordinate with their active owner before relocating them.
- The founder explicitly classifies `clawville-milady-plugin` and `cv-agentsmd` as unrelated. Do not migrate or include them in ClawVille cleanup.
- Before moving a folder, verify absolute paths, pending work, active processes, and reparse points. Preserve links and file contents.
- Never recursively delete a worktree or its shared brain links as a cleanup shortcut.
- Keep large local evidence inside the checkout with explicit Git ignore rules. Keep credentials in their approved credential locations.
- Authorized remote deployment directories remain separate from the local source boundary.
- Current layout and relocation evidence: `docs/workspace-boundaries.md`.

> # ⛔ TOP DIRECTIVE (read before anything) ⛔
> **DOCUMENT EVERYTHING METICULOUSLY AND MAKE SURE THERE IS ALWAYS HUMAN-AGENT PARITY FOR ALL FEATURES.**
> Every feature ships fully usable by BOTH a human AND a connected/hosted agent (agent session → bound avatar → real CT + leaderboard, never a guest fallback), and every change is documented in the same diff (canonical doc + PARITY note). Human-only or agent-only is a defect, not a scope cut. Enforced by Rule E5. Set 2026-06-03.

## ENFORCEMENT — mechanical, not judgment-based (set 2026-05-25)

### E1 — "plan first, no code" session lock
Session opens with **"plan first, no code"** (case-insensitive) → NO `Edit`/`Write`/mutating-`Bash` until explicit approval ("approved" / "go" / "ship it" / "yes start"); "looks fine, but…" keeps the lock; read-only tools allowed. Plan includes: (1) PRODUCTION reference (screenshot/curl), (2) smallest visible diff proving correctness, (3) granularity + why it matches the reference, (4) agent team + team_name, (5) what gets reverted if "broken" after attempt one. Violation → `git stash` what was written, restart from the plan.

### E3 — 3D / shader / WebGPU / meshlet work is a CLAUDE↔CODEX COLLABORATION
Covers Three.js / R3F / WebGPU / WGSL / TSL shaders · meshlet rasterizer (`apps/web/src/lib/three/experimental/nanite-rasterizer.ts` + `meshlet/`) · atlas/UV/texture-array work · GLB pipelines into shaders · avatar mesh + rig + decimation. Either may author; the OTHER reviews independently; iterate until right. Going solo or rubber-stamping is forbidden. Claude owns decomposition (prod reference, constraints, paths, known bugs, verify loop, success criterion), `3da` / `blend007` dispatch, screenshot verification every iteration, and commit/push.

### E4 — no "shipped" / "done" / "complete" / "milestone" / "working" / "ready" / "fixed" without same-turn user sign-off
Sign-off = a user screenshot, or "looks good" / "ship it" / "yes that works" this conversation; green build/tests/console do NOT substitute. Allowed: "compiled and rendering — needs your eyes to confirm". Violation → retract and re-describe.

### E5 — HUMAN/AGENT PARITY on every user-facing feature (set 2026-06-03)
Any feature that mutates user-facing state or economy (games, shops, quests, activities, chat, learning/skills, leaderboard-scoring actions, wallets, anything spending/earning CT) MUST work for BOTH a **human** (logged-in, plus the guest tier where one exists) AND a **connected/hosted agent** (agent session → bound avatar → REAL CT settlement + leaderboard credit). "Agent can hit it as an anonymous guest" is NOT parity. Every PR adding/changing such a feature MUST, same diff:
1. Resolve agent identity on the write path (`requireAuthOrAgentSession` or a `getSubject()`-style resolver extended to agent sessions → the agent's avatar). `requireAuth` / user-XOR-guest only on an economy route = automatic BLOCKING.
2. Expose it on the agent action surface — Hatcher `[ACTION:]` whitelist (`npc-simulation.ts` executor) and/or `tools.json` — documented in the protocol SKILL.md with a `PROTOCOL_VERSION` bump.
3. Carry a one-line **PARITY note** in the PR/commit body: "human path: <endpoint/UI>; agent path: <endpoint/action>; settlement binds to <avatar resolution>." No note ⇒ not mergeable.
4. Be audited against the LIVE game by the Adversarial auditor for the agent path before "done".

Audits also check that an agent can *become* bound (identity-key bind, PROTOCOL_VERSION 19). Records: `ARCHITECTURE.md` §13, `docs/agent-onboarding-audit-2026-07-16.md`. A pre-existing human-only economy feature is a bug to FIX.

### E6 — deferrals tracked; agent-facing knowledge lives in code (set 2026-07-16)
1. **No comment-only deferrals.** Deferring load-bearing work ("FOLLOW-UP #N") MUST, same diff, add a `FEATURE_GATE` block or a tracked punch-list entry in the relevant audit/plan doc with owner condition + review deadline.
2. **Agent-fetchable knowledge is code-generated** — from `buildProtocolManual` / `buildPlayManual` or a `packages/shared` constant, never hand-written into a DB row.
3. **Release gates** (on staging before promotion): `apps/api/scripts/agent-onboarding-smoke.ts` for `/api/agent/connect`, identity issue/bind, session-authed skills, served manuals; `apps/api/scripts/agent-connect/hosted-skill-runtime-probe.ts` for `packages/agent-runtime/src/providers/**`, `eliza-runtime.ts` prompts, `building-skill-install.ts`, `skill-protocol.ts`, gateway-provider plugins.

---

## Brand + Priorities

ClawVille is an **agent–human-economy metaverse** on ElizaOS: humans + AI agents (OpenClaw / Hermes / MiladyAI, hosted or BYO) share one 3D/2D world, each with an avatar-bound agent — 10 teaching buildings (residents teach OpenClaw development), skills, stores/land, one economy + leaderboard. Humans train agents by playing; agents train each other. **Primary distribution: direct-web (`clawville.world`) to a crypto-native audience** (2026-06-02); Milady is a secondary channel. **Three first-class bidirectional axes:** Agent ↔ Agent · Human-controlled Agent ↔ Agent · Human ↔ Agent. Eliza v2.0.0 is the memory substrate · a one-axis metric understates the product · retention is THE signal · the 10 building residents' agent chats are the primary knowledge-transfer event.

**#1 — WEB PERFORMANCE (overriding, 2026-06-02).** Desktop load time + sustained FPS come before new scope. Baseline ~40–45 FPS on Iris Xe (target 80, floor 60); render engine + physics solid before new gameplay. Tracking: `docs/perf-audit-2026-05-22.md`, `docs/perf-phase2-recon-2026-05-22.md`. GAP: ClawVille must become an **authoritative shared server** (humans + agents in one live world) — `.claude/plans/multiplayer-phase1.md`.

Four equal-weight product priorities, each measured against #1:
1. **Milady app store (secondary).** Sideload (`@clawville/app-clawville`) RETIRED (2026-07-23); the one-step magic link is the single connect path. Grid merged (`milady-ai/milady#1839`); `docs/milady-integration-plan.md`.
2. **Open agent onboarding** — any OpenClaw/Hermes/variant agent enters + learns with no human account, no lock-in. Entry `/api/agent/connect`; 11 SKILL.md at `/api/skills/*`. Players also onboard **without** an agent (Player tier); upgrade to Trainer is non-destructive; Player ↔ Agent is playable alone.
3. **Free agent leaderboard** (pivoted from paid marketplace 2026-04-21). Public `/leaderboard`, `GET /api/leaderboard/agents?window={24h|7d|30d|all}&limit=100`, 60s cache, 60 req/min/IP. Weights, caps, anti-farm, cosmetic carve-out: `GameFeatures.md` §7. Peer skill commerce (`bazaar_listings`, `auctions`, `published_skills`) PAUSED — writes 503. A first-party CT cosmetic shop is allowed (SKU needs an `avatar_skins` row + valid asset URL + 3da-validated mesh).
4. **Gamified UI + free promotion + unified leaderboard** fed by all three axes. `/dash` = internal metrics.

**Every PR:** weigh against #1 first (load, draw calls, per-frame cost), then the four; helps one + hurts another → discuss first. Complex AI integrations: phased plan in `.claude/plans/` + research in `docs/` first.

## CANONICAL DOCS — READ FIRST EVERY SESSION

`GameFeatures.md` (gameplay, economy, UI, NPC sim) · `3dStructure.md` (world layout, camera, lighting, perf, GPU) · `ARCHITECTURE.md` (routes, DB, services, env §4, deploy §12, agent identity) · `docs/agent-metaverse-model.md` (target model). Abide by them unless the user says otherwise.

**Precedence:** code > canonical docs > `AGENTS.md`/`README.md` > memory (advisory); fix the loser the same turn.

**File-path triggers — read BEFORE editing:**

| Editing… | Read |
|---|---|
| `apps/web/src/lib/three/**`, `apps/web/src/components/three/**`, `apps/web/public/models/**` | `3dStructure.md` (+ `3da` for non-trivial 3D) |
| `apps/web/src/components/game/**`, token-economy code, `packages/shared/src/constants/{knowledge-books,avatar-archetypes,map-locations}.ts`, quest/login routes | `GameFeatures.md` |
| `apps/api/src/routes/portal/*`, `services/cf-secrets-*`, `service-issuer.ts`, `auth-challenge.ts`, `identity-service.ts`, `keypair-vault.ts`, `wallet-service.ts`, `users.identity_*` / `wallets.dek_wrapped` | `ARCHITECTURE.md §7` (Phase 5.1) |
| `services/wager-program-client.ts`, `routes/wager.ts`, `contracts/wager/**`, `packages/wager-program/**`, `treasury_purpose='wager-settlement-authority'` | `ARCHITECTURE.md` (wager §2/§4 + §13) |
| `apps/api/src/routes/agent.ts`, agent-connect modal, `/api/agent/*` | `GameFeatures.md §2` + `ARCHITECTURE.md §6` |
| `routes/{partner-hatcher,partner-hatcher-launch,portal,skills}.ts`, `services/{partner-signature,service-issuer,skill-protocol,agent-substrate-client,agent-session-config,hatcher-config,hatcher-session-webhook,reserved-agent-namespaces,agent-session-restore}.ts`, `middleware/require-auth-or-agent.ts`, `packages/shared/src/types/agent-substrate.ts`, `apps/api/scripts/hatcher/*`, `.hatcher-ref/**` | `docs/hatcher-integration-spec.md` §11 (BINDING) |
| `branding/**`, outward graphics, logos, fonts, marketing copy | `branding/BRAND.md` + `docs/brand-language.md` |
| New Hono route, Drizzle schema, service file, env var, deploy/CI config | `ARCHITECTURE.md` |

**Same-diff rule:** each code change above updates its matching doc in the same diff, with "Last Audited" bumped + a one-line drift note.

**Animation shipping — STRICT (2026-05-18).** Any Mixamo/VRM clip add/remove/retarget/trigger satisfies the 9-point checklist in `3dStructure.md` §6f, incl. rule 9: bump `?v=N` when mutating an asset at an existing path (`/avatars/*.vrm`, `/avatars/animations/*.glb`, `/cosmetics/*.glb`) — Cloudflare's 1-week edge cache cannot be purged with our token. Diagnostic: `curl ?cache_bust=$(date +%s)` returns the new file, the bare URL the stale one.

### Kill-the-build invariants — ALWAYS-ON (never demoted to a referenced doc)

- **PUSH FLOW — staging-first (2026-05-24):** all new work → `git push origin staging` → `deploy-staging.yml` → verify on `https://staging.clawville.world` + `https://api-staging.clawville.world` → `gh pr create --base master --head staging` → merge → `deploy.yml` ships prod. **NEVER push to `master`** unless the user's message contains the literal **`direct to master`** (hotfix only). Each box has its OWN self-hosted Postgres (`clawville-db`; staging since 2026-09-25, prod since 2026-09-28; the old Supabase projects are frozen). Schema reaches prod only via the CI **migration gate** (`migrate` job applies `packages/database/migrations/*.sql`; `deploy` needs it) on promotion. **After every staging push and promotion, update `deploy-status.md` SAME-DIFF:** CURRENT STATE (only if you pushed last; tiebreak `git log -1 origin/staging`) + an honest DEPLOY LOG entry (what changed · what broke + root cause + fix · who it's for) + `SCHEMA:` (`synced` | `prod-migration-pending: <file>`).
- **Iris Xe GPU:** NO drei `<Text>` / `<Billboard>` in game/world scenes (hard crash). NO `InstancedMesh + ShaderMaterial` (silent WebGPU crash). NO per-frame `new Vector3()` in `useFrame` (GC thrash).
- **Local testing FIRST (2026-06-01):** iterate with `bun run build && bun run start` (prod bundle, :3000, Iris-Xe-safe) on `localhost`. NEVER `bun run dev` (HMR crashes WebGPU → PC restart). Do not push unfinished features to `staging` (clogs the Coolify build cache); push when ready for sign-off or when a bug cannot reproduce locally.
- **Phase 5.1 wallet:** `wallet.secretKey` is returned **EXACTLY ONCE** on first connect; later reads MUST omit it; no recovery path. `ARCHITECTURE.md §7`.
- **Push-auth fallback chain:** see "No lazy handoffs" below. Never hand the push to the user as the first move.

---

## MANDATORY: Non-trivial implementation runs as COLLABORATIVE AGENT TEAMS

> **Ownership registry — consult `.claude/agents/REGISTRY.md` BEFORE touching any domain (2026-06-22).** Every file has ONE owning domain agent (cove-casino · land-economy · token-economy · auth-identity-session · agent-protocol-partner · knowledge-orientation · activities-arena · leaderboard-progression · cosmetics-shop · marketplace-trade · 3da · world-presence). **BECOME the owner or DEFER** — never edit a primitive you don't own. Every domain agent runs **Phase 0 PRE-READ + TRAP DETECTION** before code: a TRAP LIST from the domain's "Known traps" + the vertical's couplings, handed to implementers as hard constraints. Rationale: `.claude/plans/subagent-structure.md`; CI gates: `.claude/plans/ci-gates-protection.md`.

Agent teams are on globally (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, `teammateMode=in-process`). Teams = LIVE COLLABORATION (concurrent work, `SendMessage` DMs), NOT members sitting `blockedBy` others. **Spawn a member only when it has useful work NOW**; an auditor qualifies at launch only if it PRE-READS the baseline and posts constraints before the diff exists.

**Dispatch — HYBRID:** 3D / Three.js / shaders / WebGPU → ONE `3da` manager; Blender → `blend007:mesh`; Anchor / Solana → `solana-auditor`. A manager runs its own sub-team, posts ONE consolidated report, keeps its memory (`3da` → `.claude/memory/threejs/`). Plain backend → flat team. **Fixers** spawn no new agent: the Reconciler (impl-2) applies BLOCKING-ISSUE punch lists in place. The orchestrator only commits, pushes, verifies — never writes code.

**Teams mandatory for** 3D / Blender / backend / API / DB / money paths · > 5 min, > 300 LOC, or ≥ 3 files across subsystems · quality verbs ("polish", "iterate", "rework", "elite"). `bun test` green does NOT replace the Adversarial audit. **Tiers:** direct edit ≤ 5 lines · light team (ultrathink Implementer + combined-lens Auditor) ≤ 100 LOC or one file with deterministic tests · full 5-role team (DEFAULT) for 3D, Blender, backend, money, > 100 LOC or > 3 files · high-stakes (migrations, custodial keys, auth, billing, rewrites) adds an independent re-implementing `reconciler-manager`, no exceptions. In doubt → full team. Every agent prompt carries the literal **"use ultrathink reasoning before writing code"** (or "before reviewing code"), team name + role + members, deps, and this file's hard constraints. Status via `TaskList`; "diff ready" / APPROVED / BLOCKING ISSUES via `SendMessage`, never silent. Compositions + protocol: `CONTRIBUTING.md` → "Agent team operating rules" (3da def `.claude/agents/3da.md`; local Blender is exclusive — launch a NEW instance or use CC0 GLBs).

---

## MANDATORY: ElizaOS

Never remove or stub. Avatar + location chat MUST use the ElizaOS runtime (`@clawville/agent-runtime`); the orchestrator MUST use `createElizaRuntime`. Deploy to persistent servers (Hetzner+Coolify, Render, Fly.io), NOT Vercel serverless. Never replace with direct API calls.

## MANDATORY: Hatcher `[ACTION:]` whitelist parity

ENFORCEMENT (authoritative): `apps/api/src/services/npc-simulation.ts` `dispatchHatcherActions` / `executeHatcherAction` — only whitelisted verbs execute. DOCUMENTATION: the protocol SKILL.md from `skill-protocol.ts buildProtocolManual` (single source of `PROTOCOL_VERSION`). Any verb/param change in the executor ⇒ update the manual AND bump `PROTOCOL_VERSION`, same diff. Agents re-pull the manual when the version bumps.

## MANDATORY: Partner / integration surface is PROTECTED (2026-06-15)

Hatcher is our ONLY partner and runs **LIVE on our PROD**; staging is pre-prod validation. It is security- and money-load-bearing (ed25519 signing, custodial Solana wallets, real-CT Cove settlement, SSRF-guarded cognition) and brittle. Binding text (PROTECTED SURFACE list, "ALSO BINDS" clause, suite FEATURE_GATE, five MANDATES: validate against `.hatcher-ref/`; mock-Hatcher harness on staging per `apps/api/scripts/hatcher/run-mock-e2e.md`; same-diff spec + `PROTOCOL_VERSION`; Codex adversarial pass on signing / session / SSRF / money / custodial paths; never-regress security invariants): **`docs/hatcher-integration-spec.md` §11**. Editing a listed file, or changing the agent-session bearer/TTL model, the `hatcher:` namespace, the cognition body shape, the `[ACTION:]` whitelist, leaderboard event names/weights, or `types/agent-substrate.ts` binds it: read §11 first, satisfy every mandate before "done". Green `tsc`/`bun test` does NOT replace the harness.

## MANDATORY: Agent world-scope skill file — current, installed, CONSUMED (founder 2026-07-15)

Origin: `docs/agent-autonomy-audit-2026-07-15.md` (the deciding LLM saw a narrower menu than the executor).
1. **Same-diff manual update.** Any change to what an agent can do, see, reach, or earn (routes, verbs, locations, games, economy, movement bounds, directives) updates `buildProtocolManual` (`skill-protocol.ts`) and/or `CLAWVILLE_ORIENTATION_KNOWLEDGE` (`packages/shared/src/constants/orientation-skill.ts`) with a `PROTOCOL_VERSION` bump.
2. **Install + refresh on every login.** Hosted runtimes get the manual at provisioning AND a version check on every start and connect; connected agents get version/content-hash in every connect payload.
3. **CONSUMPTION MANDATE.** Every LLM path that chooses agent actions (`buildDecisionPrompt`/`decide()`, directive interpretation, talk prompts) gets the current world scope and the FULL executor menu. A narrower prompt, or a surface injected but unread on decide, is a **defect**. Audits check what the deciding model actually SEES.
4. **INSTALLED = stored per-agent + read on every consume path + refreshed**, verified same diff: **(a)** every deterministic ElizaOS memory id has the agentId in its uuidv5 seed (`plugin-sql createMemory` dedupes GLOBALLY — no agentId ⇒ BLOCKING); **(b)** a reader on chat (`knowledgeProvider`) AND decide (`buildDecisionPrompt`), and for a gateway-routed hosted framework the text reaches the outbound wire (mock-gateway probe); **(c)** version/content-hash refresh on every start and connect. Definitions + required PR evidence phrase: `docs/agent-onboarding-audit-2026-07-16.md` §5.

## MANDATORY: Game-flow changes update all three operational-knowledge surfaces, same diff

Any new game flow, world addition, or mechanic edit (modes, buildings, currencies, quests, wager rules, casino/arcade games, table rules, connect flow, disconnect/timer behavior, leaderboard weights, paused features…) updates **all three**, or the PR is not mergeable:
1. **Nori the Town Guide `knowledge[]`** — `packages/agent-templates/src/locations/town-guide.ts`, in `SYSTEM_AGENT_TEMPLATES`, re-seeded by `ensureSystemAgents()` on every API boot. Orientation only: point at the teacher, don't replace.
2. **Connection SKILL.md** — `GET /api/skills/protocol/skill.md` from `buildProtocolManual`, fetched fresh on every connect; `GET /api/skills/manifest.json` has content hashes.
3. **Hosted-agent runtime copy of #2** — `createMemory()` with `subtype: 'protocol-knowledge'` on each runtime restart.

Details (surface contents, endpoints, rate limits, adding a system agent, exclusions): `GameFeatures.md` §2 "Three operational-knowledge surfaces".

## Tech Stack + Structure

Turborepo + Bun. **Web:** Next.js 16 App Router (`cookies()`/`headers()`/`params` are async — always `await`), Three.js (3D) + PixiJS 8 (2D fallback), Zustand, TanStack Query, Tailwind. **API:** Hono 4.x on Bun. **DB:** PostgreSQL 17 + pgvector (self-hosted `clawville-db` on each box) + Drizzle. **AI:** ElizaOS 2.0.0-alpha (plugin-openai, plugin-sql). **Auth:** Lucia 3.x + Drizzle adapter.

`apps/web` (game, :3000) · `apps/api` (Hono REST, :4000) · `packages/shared` (types + constants) · `packages/database` (schema + migrations) · `packages/agent-runtime` (ElizaOS wrapper) · `packages/agent-templates` (10 location + system-agent templates). All `@clawville/*`.

```bash
bun install      # deps
bun run dev      # DON'T — see Kill-the-build invariants
bun run db:push  # push schema
bun run db:seed  # seed 10 map locations
bun run db:studio
bun run build
```

**Code style:** TypeScript strict. Kebab-case files, PascalCase components. Zod on all API inputs. `@/` alias in web; `@clawville/*` for packages.

## Environment Variables

Canonical: **`ARCHITECTURE.md` §4** — update it same diff for any add, rename, or default change. Hard constraints:
- **Crash-loud on boot:** `FINGERPRINT_SECRET` + `CLOUDFLARE_WORKER_*`. `CLAWVILLE_ENV` (`staging` | `production`) is the ONLY env discriminator (`NODE_ENV` is `production` on both boxes). `ALLOW_TEST_PARTNER_PUBKEY` is STAGING-ONLY; throws at module load elsewhere.
- **MUST NEVER be `'true'`:** `RECONCILE_APPLY`. **DARK, stay unset/false:** `MARKET_DEED_TRANSFER_ENABLED`, `MARKET_PAYOUT_EXECUTE`, `WALLET_WITHDRAW_ENABLED` — opening one is a Codex-reviewed change, never an env flip. `MOONPAY_*` test-mode only.
- **`CLV_SWAP_EXECUTE`:** seam OPEN; real money gated by `assertMainnetRealMoneyContext()` (mainnet + real facilitator). Ladder: devnet → staging → mainnet → production.
- **Never reintroduce** `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_BASE_URL` (replaced by InferenceRouter `INFERENCE_*`; only house-fleet agents route to local boxes). Embedding model + dimension are pinned in code.
- **`ELIZA_DATABASE_URL`:** UNSET on Coolify (the adapter uses the self-hosted `DATABASE_URL` as is; it only rewrites legacy Supabase pooler URLs). Local `.env.local`: `DB_POOL_MAX=4`.
- **Meridian fallback** settles only to the dashboard recipient, which must equal `CLAWVILLE_MERCHANT_WALLET_PUBKEY` (runtime-asserted); `sk_` org secrets never enter runtime env.
- **Land hold-wallet verify** door 2 has NO enable flag — it derives from the `treasury_wallets` row `purpose='land-hold-verify'` (dark flags in prod are forbidden).

## Deployment — Hetzner + Coolify

Two boxes (prod Hillsboro / staging Ashburn), Coolify + Traefik, Cloudflare DNS, a separate self-hosted Postgres (`clawville-db`) on each box. IPs, keys, app IDs, tinker env encryption, queue, migrations, SSH, rollback: **`docs/DEPLOY-HETZNER.md` → "Deploying a new version — day-to-day runbook"**. Inline rules:
- **"Finished" ≠ live:** `docker exec <app-container> env | grep SOURCE_COMMIT` must equal the pushed sha (+ bundle grep for a new string when in doubt); queue rows can read `finished` while the flip failed.
- **DB migrations:** `bun run db:push` from root before deploy if `packages/database/src/schema/*.ts` changed — Coolify does NOT migrate. Destructive needs `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true`.
- Never let superseded/duplicate builds finish. Git Bash curl needs `--ssl-no-revoke` (schannel rejects CRLs).

**Browser check after every deploy — MANDATORY:** after Coolify (~3–5 min) or `curl -sS --ssl-no-revoke https://api.clawville.world/health`, open `https://clawville.world/game` via Chrome MCP: buildings visible + unclipped, camera zoom, spawn center, FPS > 50, no console errors. Chrome disconnected → "I cannot verify — please screenshot". Never claim a visual fix unseen.

**Mobile + iPad — MANDATORY for every on-screen UI change (2026-05-28):** (1) `chrome-devtools` `emulate` `<w>x<h>x2,mobile,touch` at 390×844, 744×1133, 820×1180, 1024×1366, **portrait AND landscape**; (2) per size: both joystick zones visible + uncovered, no overlapping fixed/absolute elements, tap target ≥44px and not under Safari chrome, modals fit + dismiss; (3) gate with `useIsMobile()` (`maxTouchPoints > 1` + coarse pointer), NEVER a bare Tailwind `md:` / `max-width` query; (4) devtools has NO `env(safe-area-inset-*)` — bottom-anchored elements need a real-iPad screenshot from the user, say so; (5) force the live state (walk to the building / open the modal / fire the toast) — a component returning `null` proves nothing.

## Game Modes + Architecture

`controlMode` (Zustand `game.ts`): `'explore' | 'npc' | 'player' | 'autonomous'`, gated by AUTH STATE. Logged out → Explore ↔ NPC, DEMO economy; real-money surfaces (bounties, wallets, real-CT games) READ-ONLY, enforced server-side. Logged in ≡ agent connected → Controlled ↔ Autonomous, REAL economy on the account's avatar. Target model (account ≡ agent ≡ avatar; Autonomous persists when the user leaves): `GameFeatures.md` §1.

- **3D primary / 2D fallback:** `World3DCanvas` (Three.js) + `PixiCanvas` share Zustand state. `/arena` spectator page RETIRED 2026-07-28; `arena-*` lib files are the main world renderer.
- **Agent lifecycle:** lazy-start on first chat, auto-stop after 30 min idle (`agent-orchestrator.ts`). **One avatar per user** (unique `avatars.userId`). 10 building zones in `map-locations.ts`; NPC sim in `npc-simulation.ts`.
- **Detail lives in docs:** buildings → `map-locations.ts` + `building-types.ts`, roster `WorldContent.md §2` · DB schema → `ARCHITECTURE.md §8` (`wallets` = unified custodial table; `treasury_wallets` = team supply, never user-facing) · ClawToken economy, books, daily login, archetypes → `GameFeatures.md §4 / §5 / §8 / §9a`; write path `claw-token-ledger.transferClawTokens()` — NEVER write `avatars.clawTokens` directly · agent connection → `GameFeatures.md §2` + `ARCHITECTURE.md §6` (agent-initiated; humans never paste credentials) · Phase 5.1 wallet identity + 'scape portal → `ARCHITECTURE.md §7`.

## Documentation Update Policy

**Same-diff doc table (MANDATORY):** 3D world → `3dStructure.md` (3da enforces) · gameplay → `GameFeatures.md` · routes, DB, services, data flow → `ARCHITECTURE.md` (env vars §4) · deploy runbook → `docs/DEPLOY-HETZNER.md` · invariants, workflow rules, commands → `AGENTS.md` (`CLAUDE.md` is only the `@AGENTS.md` import) · user overview → `README.md` · brand assets → `branding/BRAND.md` · each staging push / promotion → `deploy-status.md` · founder-eyes items → `FOUNDER-REVIEW.md`. "Update later" is unacceptable; bump "Last Audited"; a memory entry instead of the doc = the same violation. Order: code → doc → optional memory.

**FOUNDER-REVIEW.md (2026-08-20):** the founder's standing answer is "push it, I'll test later" — never block a ship on a founder playtest (founder DECISIONS that change what gets built still block). Every push shipping something that needs founder eyes appends an entry to repo-root `FOUNDER-REVIEW.md` in the same push (what to look at · env + exact path · feedback wanted · session + date), by game area. Verdicts get absorbed into the owning docs and the entry deleted.

## ZERO LAZINESS + Audit Policy

Right tool immediately (`/browser-live`, `3da`); fix every bug when found; test for real; Codex audits everything. After a plan is implemented, a team audits against it and fixes findings; then a NEW team re-audits.

**Feature Gates — no scaffolding theater.** Every scaffolded feature (compiled but not in the user flow) carries a `// FEATURE_GATE: <name>` comment block with lines `Status:`, `Metric to graduate:`, `Current reading:` (last `/dash` value), `Review deadline: YYYY-MM-DD`, `On deadline:`, `Reference:`. A lapsed deadline without the metric met ⇒ the feature is DELETED, not extended; renewal must cite a new metric reading. Active gates (2026-04-21): `x402_payment_middleware`, `multi_agent_roster`. `skill_marketplace` DELETED 2026-07-02: peer skill-commerce verticals were REMOVED (a sold/published skill is an injectable prompt), not un-paused.

**No lazy handoffs — the full ship loop is YOUR job.** "Implement" = commit + push + verify deploy + verify in browser. Push fails → try ALL: `gh auth status` → `unset GITHUB_TOKEN && gh auth setup-git` (an invalid env `GITHUB_TOKEN` beats a good keyring token) → SSH remote (`git remote set-url origin git@github.com:USER/REPO.git`) → `gh api` / `gh pr create`. Same at every step: deploy → webhook, then `php artisan tinker` via SSH; verify deploy → `SOURCE_COMMIT`, `/health`, bundle scan; verify browser → `browser-live` CDP, bundle strings, scene graph. Ask the user only after EVERY option fails, errors quoted.

## Memory System
<!-- itachi-memory-system v12 -->

Itachi Memory System for persistent context across agent sessions (Claude
Code, Codex, Gemini, Ollama-backed local harnesses). Two pools available:

- `<project>` — scoped to this repo
- `_global` — cross-project, topic-general

### RULE 1 — Recall before you act (MANDATORY)

BEFORE working on anything you're not deep in, query memory for prior lessons.
You don't pay the learning tax twice.

**Triggers:** new MCP server; unfamiliar lang/framework; specific system
(Supabase RLS, systemd, Docker, Coolify, Helius, Stripe …); accumulating topic
(`tokenomics`, `vrm-avatars`, `webgpu-shaders` …); error you might have solved
before; unfamiliar API/SDK.

**How** — query both pools (`$ITACHI_API_URL` + `$ITACHI_API_KEY` come from `~/.itachi-api-keys`):

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

DURING the session, record anything non-obvious immediately. Session-end
extraction is a safety net, not the primary capture mechanism.

**Triggers:** error solved that docs don't cover; quirk/constraint/API
surprise; non-obvious pattern that worked; A failed + B succeeded (record
both + why); correct default/flag/version found after trial.

**Scope:** `_global` for tool/lang/framework quirks (default); `<current project>` for repo-specific.

POST `/api/memory/create` with `category: "lesson"`, one-line `summary` ("WHEN
X, DO Y because Z"), `content`, `metadata.confidence` starting 0.6,
`lesson_category` ∈ `tool-usage|debugging|pattern|constraint|workflow`.
Confidence climbs when confirmed, decays when contradicted — that's the
reinforcement loop.

### RULE 3 — Category discipline

The only production lesson category is `lesson`. Do NOT write to
`task_lesson` or `project_rule` (test fixtures, zero prod rows).

### RULE 4 — Drive the test yourself, don't loop the user (MANDATORY)

When the user reports broken, reproduce end-to-end YOURSELF before asking them
to verify anything. "Try again / what do you see / now try X" loops are
laziness. Use the browser/CLI/log automation available in the current harness
to confirm via DOM/logs/output — not speculation. Report findings with
evidence + timestamps, not guesses.

### RULE 5 — NEVER ASSUME, always verify (MANDATORY)

Before saying something is true/working/deployed/fixed — VERIFY. "I think",
"should", "probably", "likely works" are banned unless immediately followed
by the verification step.

**Verify by claim:** "Deployed" → `curl` live or grep bundle. "Fix works" →
rerun repro + output. "Build passes" → `bun run build` exit code. "Tests
pass" → `bun test` summary. "Env var set" → `ssh … env | grep FOO`. "File or
function exists" → `Read`/`Grep`. "Memory/lesson written" → query DB or hit
`/api/…/get`.

Banned without same-response evidence: "should work", "looks right", "logic is
correct", "probably compiles", "I'm confident".

If verification is impossible, say so explicitly: *"I wrote the code but
can't run the build here."* Claiming it works without checking is lying.

### RULE 6 — NEVER BE LAZY: if you find a bug, fix it (MANDATORY)

Zero tolerance for noticing a problem and walking past it. Every bug, broken
check, stale comment, wrong env var, dead import, failing test, or
misconfiguration gets fixed — even if they didn't ask.

- **Noticing ≠ fixing.** Senior engineer wouldn't leave it? Fix it.
- **Never "note it for later."** Small → fix this session. Large → real task
  (Supabase, Linear, GitHub).
- **Check BEFORE acting.** Read code, grep helpers, check current state.
- **Before declaring done:** run code, read output, verify end-to-end. Tests +
  build + live-check green = done.
- **Exhaust alternatives before escalating.** Escalate only with evidence:
  "Tried A (error X), B (error Y), C (error Z) — blocked by [root cause]".
- **No surface-level audits.** Claim it works = you actually read + ran + checked.

### Commands

Claude Code: `/recall <query>`, `/recent [limit]`, `/itachi-init`.
Codex CLI: `$recall <query>`, `$recent`, `$itachi-init` (or the plain prompt
"use the recall/recent/itachi-init skill"). Codex rejects unknown slash
commands before the model sees them.

### Memory Categories

Auto-categorized by PostToolUse hook: `code_change` (default), `test`,
`documentation` (.md), `dependencies` (package.json, requirements.txt).
Lessons + facts use `category: "lesson"` (knowledge) or `category: "fact"`
(state).

### Disable

Create `.no-memory` at project root.

## Coding Principles

Behavioral guidelines to reduce common LLM coding mistakes (derived from
Andrej Karpathy's observations on LLM coding pitfalls — see
multica-ai/andrej-karpathy-skills). Merge with project-specific instructions
as needed. **Tradeoff:** these bias toward caution over speed; for trivial
tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If
yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it
work") require constant clarification.

**These principles are working if:** fewer unnecessary changes in diffs,
fewer rewrites due to overcomplication, and clarifying questions come
before implementation rather than after mistakes.
