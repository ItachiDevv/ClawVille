# ClawVille

> # ⛔ TOP DIRECTIVE (read before anything) ⛔
> **DOCUMENT EVERYTHING METICULOUSLY AND MAKE SURE THERE IS ALWAYS HUMAN-AGENT PARITY FOR ALL FEATURES.**
> Every feature ships fully usable by BOTH a human AND a connected/hosted agent (agent plays as itself: agent session → bound avatar → real CT + leaderboard, never a guest fallback), and every change is documented in the same diff (canonical doc + PARITY note). Human-only or agent-only is a defect, not a scope cut. Enforced mechanically by Rule E5 below. Set 2026-06-03 after the Cove shipped with autonomous/connected-agent play left as disabled scaffolding.

## ENFORCEMENT — mechanical, not judgment-based (set 2026-05-25 after meshlet/atlas session where zero-laziness rules failed to bind because Claude judged work "small enough" to shortcut)

### Rule E1 — "plan first, no code" session lock
User opens a session with **"plan first, no code"** (case-insensitive substring) → Claude is FORBIDDEN from `Edit`/`Write`/mutating-`Bash` until explicit approval ("approved" / "go" / "ship it" / "yes start"). Non-approval replies ("looks fine, but…") keep the lock active. Read/Grep/Glob/Agent-investigate/WebFetch allowed.

Plan must include: (1) the PRODUCTION reference (screenshot or curl evidence), (2) the smallest visible diff that proves correctness, (3) granularity choice + why it matches the reference, (4) which agent team + team_name, (5) what gets reverted if "broken" after first attempt.

Violation → `git stash` whatever was written and restart from the plan step.

### Rule E3 — 3D / shader / WebGPU / meshlet work is a CLAUDE↔CODEX COLLABORATION (not Codex-gated)
Categories: Three.js / R3F / WebGPU / WGSL / TSL shaders · meshlet rasterizer (`apps/web/src/lib/three/experimental/nanite-rasterizer.ts` + `meshlet/`) · atlas packing, UV remapping, texture-array indexing · any GLB pipeline branching into shaders · character/avatar mesh + rig + decimation pipelines.

This work is genuinely hard for a single LLM to get right, so it is done as a CONTINUOUS COLLABORATION between Claude and Codex who REVIEW EACH OTHER'S WORK THE WHOLE TIME — NOT a strict hand-off where Codex authors and Claude only verifies, and NOT Claude solo. Either may author a given change; whoever authors it, the OTHER independently reviews it before it ships, and they iterate together (author → review → fix → re-review) until it is right. Two sets of eyes on every shader / UV / atlas / rig / decimation change, continuously.

Claude still owns: decomposition (prod reference, constraints, file paths, known bugs, verify loop, success criterion), dispatching the `3da` / `blend007` specialist where it fits, browser/visual verification on every iteration (screenshots, not "should look right"), and commit/push. Codex is engaged as a co-author AND reviewer throughout — pulled in repeatedly, not invoked once at the start.

Two failure modes this rule forbids: (1) Claude (or any single agent) going solo on this work — one LLM is not enough here; (2) "Codex writes, Claude rubber-stamps" OR "Claude writes, Codex never sees it" — review must be real and mutual. (Supersedes the old "first edit MUST be authored by Codex / `claude implement` to override" framing — collaboration is the default; there is no gate to override.)

### Rule E4 — no "shipped" / "done" / "complete" / "milestone" / "working" / "ready" / "fixed" without same-turn user sign-off
"Sign-off" = a screenshot the user posted, or "looks good" / "ship it" / "yes that works" in this conversation. Green build, passing test, clean console — NONE substitute.

Allowed alternatives without sign-off: "compiled and rendering — needs your eyes to confirm", "builds without errors — does it look right to you?". Asking IS allowed; declaring is not. Violation → retract the claim and re-describe in allowed phrasing.

### Rule E5 — HUMAN/AGENT PARITY IS MANDATORY ON EVERY USER-FACING FEATURE (set 2026-06-03 after the Cove casino shipped human/guest-only, structurally locking connected agents out of a money-handling feature — a foundational violation of the product premise)

ClawVille's reason to exist is the three bidirectional axes (Human↔Agent, Human-controlled-Agent↔Agent, Agent↔Agent — see Brand Identity). A feature that only one of {human, agent} can use is a **product-level defect**, not a scope cut. This rule is mechanical, not judgment-based.

**Definition of parity:** any feature that mutates user-facing state or economy (games, shops, quests, activities, chat, learning/skills, leaderboard-scoring actions, wallets, anything spending/earning CT) MUST be reachable and fully functional by BOTH:
- a **human** (logged-in account, and where a guest tier exists, the guest too), AND
- a **connected/hosted agent** (agent session → bound avatar → REAL CT settlement + leaderboard credit, NOT a demo/guest fallback).

"Agent can technically hit it as an anonymous guest" is NOT parity — guest play feeds nothing persistent. Parity means the agent plays **as itself**, with the same economic + leaderboard consequences a human gets.

**Mechanical gate — every PR that adds or changes such a feature MUST, in the same diff:**
1. Resolve agent identity on the write path (`requireAuthOrAgentSession` or the cove `getSubject()`-style resolver extended to agent sessions → the agent's avatar), so settlement and scoring bind to the agent. A route that only does `requireAuth` / user-XOR-guest for an economy feature is an automatic BLOCKING issue.
2. Expose the feature to agents through the agent action surface — the Hatcher in-world `[ACTION:]` whitelist (`npc-simulation.ts` executor) and/or the agent-callable `tools.json` mechanism — and document it in the protocol SKILL.md with a `PROTOCOL_VERSION` bump (see the whitelist-parity rule below).
3. Carry a one-line **PARITY note** in the PR/commit body: "human path: <endpoint/UI>; agent path: <endpoint/action>; settlement binds to <avatar resolution>." No PARITY note ⇒ not mergeable.
4. Be audited against the LIVE game by the Adversarial auditor specifically for the agent path (not just the human path) before "done."

**Retroactive debt — RESOLVED 2026-06-15:** the Cove was the known violation (`getSubject()` resolved user-XOR-guest only, no agent session). All four games now have agent parity: `cove-blackjack.ts` shipped it first (2026-06-03), and `cove-baccarat.ts`, `cove-holdem.ts`, and `cove-slots.ts` now resolve a connected/hosted agent session (`X-Clawville-Agent-Session` → `resolveAgentSession`) to the bound avatar for REAL-CT settlement, matching blackjack (`user` + `agent` are both ledger subjects; guests stay demo; non-ledger/unbound agents get 403, never a guest demotion). No `PROTOCOL_VERSION` bump — only the settlement resolver changed; the agent ACTION whitelist is unchanged. Any other pre-existing human-only economy feature discovered later is a bug to FIX, not to document and walk past (see Memory RULE 6).

**Substrate corollary — RESOLVED 2026-07-16 (see `docs/agent-onboarding-audit-2026-07-16.md`):** parity audits must check that an agent can *become* bound, not just that bound agents settle correctly. The 2026-06-03 pass deferred the self-connect user bind as a "FOLLOW-UP #6" code comment; it silently strangled open onboarding for six weeks (178/232 prod agent rows unbound). Fixed by the identity-key bind (`planConnectOwnerBinding`, PROTOCOL_VERSION 19).

### Rule E6 — deferrals must be tracked; agent-facing knowledge lives in code (set 2026-07-16 after the onboarding audit)
1. **No comment-only deferrals.** Any review pass that intentionally defers load-bearing work ("FOLLOW-UP #N", "deferred FEATURE", "not part of this pass") MUST, in the same diff, create a `FEATURE_GATE` block or a tracked punch-list entry in the relevant audit/plan doc with an owner condition and a review deadline. A deferral that exists only as a code comment is a silent product regression, not a decision.
2. **Knowledge surfaces served to agents are code-generated.** Every manual/skill/orientation body an agent can fetch MUST be generated from source (like `buildProtocolManual` / `buildPlayManual`) or from a constant in `packages/shared` — never hand-written into a DB row by a one-time script. Same-diff rules bind on file edits; DB-resident prose is invisible to them and fossilizes (the `clawville-play` entry skill served a wrong connect contract for 10 weeks).
3. **The public onboarding smoke (`apps/api/scripts/agent-onboarding-smoke.ts`) is a release gate** for any change touching `/api/agent/connect`, identity issuance/binding, session-authed skill surfaces, or the served manuals: run it against staging before promotion, exactly like the mock-Hatcher harness gates the partner surface.
   **The hosted skill runtime probe (`apps/api/scripts/agent-connect/hosted-skill-runtime-probe.ts`) is a release gate** for changes touching `packages/agent-runtime/src/providers/**`, prompt composition in `packages/agent-runtime/src/eliza-runtime.ts`, `apps/api/src/services/building-skill-install.ts`, `apps/api/src/services/skill-protocol.ts`, or gateway-provider plugins; run it on the same non-production API host before promotion.

---

## Brand Identity

> Every product decision, metric, feature gate, and scope cut traces back here. Added 2026-04-21.

Gamified intersection of humans + AI: humans train agents by playing, agents train each other. **Primary distribution is direct-web (`clawville.world`) to a crypto-native audience** (set 2026-06-02). The Milady bridge — npm sideload plugin, curated app grid (PR #1839 merged), agent-initiated connect flow — is now a **secondary acquisition channel**, a funnel back to the site, not the main path.

**Three bidirectional collaboration axes, all first-class:** Agent ↔ Agent · Human-controlled Agent ↔ Agent · Human ↔ Agent.

**Load-bearing:**
- Eliza v2.0.0 is the **memory substrate** — "ElizaOS is MANDATORY" is a brand constraint.
- Any metric measuring only one axis understates the product.
- Retention is THE signal — day-1 without day-N is noise.
- MiladyAI teachers = 10 building residents; their agent chats are the primary knowledge-transfer event.

---

## TOP PROJECT PRIORITIES

**#1 — WEB PERFORMANCE (overriding constraint).** _Set 2026-06-02._ Direct-web (`clawville.world`) is the PRIMARY distribution, to a crypto-native audience — the browser experience **is** the product, with no app-store install to amortize a slow load behind. So **desktop browser load-time + sustained FPS are the top constraint, ahead of new feature scope.** Baseline today: ~40–45 FPS on the Iris Xe desktop floor (target 80, floor 60) + a loading bar that reads as frozen. **The render engine and physics performance must be solid before new gameplay scope ships.** Tracking: `docs/perf-audit-2026-05-22.md` (+ `perf-research-2026-05-22.md`, `perf-phase2-recon-2026-05-22.md`). Also load-bearing and currently a GAP: ClawVille is meant to be an **authoritative shared server** (real humans + agents co-present in one live world), not single-player + server-simulated NPCs — see `.claude/plans/multiplayer-phase1.md`.

**The four product priorities below are equal weight among themselves, each measured against #1. Don't trade off without flagging.**

1. **Milady AI app store — SECONDARY acquisition channel** (downgraded from primary distribution 2026-06-02; primary is now direct-web at `clawville.world`). Still live as a funnel back to the site. Two-track:
   - **Sideload (LIVE 2026-04-12):** `@clawville/app-clawville@0.1.0` on npm. Installs via `POST /api/plugins/install`. Registers `LAUNCH_CLAWVILLE`. Repo: https://github.com/ItachiDevv/clawville-milady-plugin.
   - **Curated grid (MERGED):** PR `milady-ai/milady#1839` adds ClawVille to `MILADY_CURATED_APP_DEFINITIONS`. See `docs/milady-integration-plan.md`.

2. **Open agent onboarding** — any OpenClaw/Hermes/variant agent enters + learns with no human account, no framework lock-in. Entry: `/api/agent/connect`. Knowledge surface: 11 SKILL.md files at `/api/skills/*`.

   Players also onboard **without** an agent (Player tier) — avatar, ClawTokens, leaderboard rank via human↔agent chats + activity matches. Upgrade to Trainer (connect agent) is non-destructive. Player ↔ Agent is a first-class axis; must be playable on its own.

3. **Free agent leaderboard** (pivoted from paid marketplace 2026-04-21). Contribution-based. Public at `/leaderboard` (no auth), `GET /api/leaderboard/agents?window={24h|7d|30d|all}&limit=100`. 60s cache, 60 req/min/IP.

   **Weights (Q3 plan §2.4, 2026-04-28):** `building.visited` 3 · `agent.chat.turn` 10 · `agent.collaboration.turn` 40 · `skill_md.fetched` 1 · unique `agent.connected` 1 · `identity.issued` 5 · `activity.match.placed` (1st=12, 2nd=6, 3rd=3, default=1). **Daily caps per subject:** chat=50, collab=50, building=10, skill_md=11, activity=10. **Anti-farm:** events tagged with `(fp_hash, ip_prefix_hash)` salted by `FINGERPRINT_SECRET`; over-cap rows scored at `LEAST(count, cap)` per (subject, day).

   **Subject scope:** Players + Trainers on one board with filter chips. Same scoring engine, same weights.

   **Cosmetic shop carve-out:** first-party cosmetic shop (skins, hats, auras) is allowed — NOT a peer marketplace. Pricing in CT only; CT purchasable via fiat/SOL/USDC/$CLAWVILLE (25% bonus on CLV pay). The marketplace pause applies to **peer skill commerce** (`bazaar_listings`, `auctions`, `published_skills`) — write handlers return 503. See `improvements.md` §7.

4. **Gamified UI + free promotion + unified leaderboard.** Game layer (3D world, buildings, ClawTokens, quests) wraps one free leaderboard. All three axes feed the same leaderboard. `/dash` = internal metrics.

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
| **`ARCHITECTURE.md`** | Tech: route modules, DB tables, service catalog, data flow, frontend/backend, Hetzner+Coolify deploy, agent identity, OpenAI LLM, Phase 5/6 plumbing |

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

- **PUSH FLOW — staging-first (set 2026-05-24):** ALL new work goes to the `staging` branch first. `git push origin staging` → `.github/workflows/deploy-staging.yml` ships to the staging box → verify on `https://staging.clawville.world` + `https://api-staging.clawville.world` → open PR `staging → master` via `gh pr create --base master --head staging` → merge the PR → `.github/workflows/deploy.yml` ships to prod. **NEVER push directly to `master`** unless the user's message contains the literal phrase **`direct to master`** (case-insensitive) — that's the only override, logged as a CI warning. Hotfix is the only legitimate use. **Staging now has its OWN Supabase DB (isolated 2026-06-16)** — staging writes no longer touch prod data. Schema changes reach prod via the **CI migration gate** (a `migrate` job that applies pending `packages/database/migrations/*.sql` via `scripts/migrate-ci.ts` and gates `deploy` with `needs: migrate`, in both deploy workflows) on the `staging → master` promotion. **After any push to `staging` (and every `staging → master` promotion), update `deploy-status.md` SAME-DIFF:** set CURRENT STATE (only if you pushed last — last-writer-wins, tiebreak `git log -1 origin/staging`) + add an honest DEPLOY LOG entry (what changed · what broke + root cause + fix · who it's for) + set the `SCHEMA:` field (`synced` | `prod-migration-pending: <file>`) if the schema changed.
- **Iris Xe GPU:** NO drei `<Text>` / `<Billboard>` in game/world scenes — hard crash. NO `InstancedMesh + ShaderMaterial` — silent WebGPU crash. NO per-frame `new Vector3()` in `useFrame` — GC thrash.
- **Local testing FIRST (DEFAULT, set 2026-06-01):** iterate with `bun run build && bun run start` (prod bundle on :3000 — Iris-Xe-SAFE; ONLY `bun run dev`/HMR crashes the WebGPU scene). Test in-browser on `localhost`. NEVER run `bun run dev`. Do **NOT** push unfinished / mid-iteration features to `staging` — it clogs the Coolify build cache and is slow for work we know isn't done. Push to `staging` only when a feature is ready for the user's sign-off, or when a bug genuinely can't reproduce locally. [[feedback_local_testing_bun_run_start]]
- **Phase 5.1 wallet:** `wallet.secretKey` is returned **EXACTLY ONCE** on first-connect. Subsequent reads MUST omit it. SKILL.md instructs agent to display once + store only pubkey. Server never re-emits — no recovery path. Full spec: `ARCHITECTURE.md §7`.
- **Verification:** never claim deployed/fixed without evidence (curl, bundle grep, DOM read). "Should work" is banned.
- **Push-auth fallback chain:** `gh auth status` → `unset GITHUB_TOKEN && gh auth setup-git` → SSH remote → `gh` CLI. Only escalate with all errors quoted. Never hand the push to the user as the first move.
- **Asset cache-bust:** mutating an existing static asset at a stable URL (`/avatars/*.vrm`, `/avatars/animations/*.glb`, `/cosmetics/*.glb`) WITHOUT bumping a `?v=N` query in every reference is a silent 1-week regression on prod — Cloudflare's edge cache TTL is 7 days and our deploy token has zone:edit but **no cache_purge scope**, so we can't invalidate via API. Full rule + verified examples in `3dStructure.md §6f rule 9`. Diagnostic: `curl ?cache_bust=$(date +%s)` returns the new file; bare URL returns the stale one.

**Precedence (high→low):** (1) source code · (2) three canonical docs · (3) `CLAUDE.md`/`README.md` · (4) memory files (advisory). Memory vs doc → doc wins, update/delete memory same turn. Doc vs code → code wins, update doc same turn.

---

## MANDATORY: Non-trivial implementation runs as EXPERIMENTAL COLLABORATIVE AGENT TEAMS

> **DOMAIN-SUBAGENT OWNERSHIP REGISTRY — consult `.claude/agents/REGISTRY.md` BEFORE touching any domain (set 2026-06-22).** Every file has exactly ONE owning domain agent (cove-casino · land-economy · token-economy · auth-identity-session · agent-protocol-partner · knowledge-orientation · activities-arena · leaderboard-progression · cosmetics-shop · marketplace-trade · 3da · world-presence). Match the file's path to its owner, then **BECOME that agent or DEFER** (file the change to the owner — never edit a primitive you don't own). One owner per domain is the structural fix for **decoupling** (the menu can't drift from its backend) AND for **concurrent-session collisions** (two sessions can't fork the same vertical — the F4 lesson). Every domain agent runs the **Phase 0 PRE-READ + TRAP DETECTION** step before any code: emit a TRAP LIST from the domain's "Known traps" + the vertical's couplings, hand it to implementers as hard constraints — the regression is designed out before it's written, not found in audit. Full map + operating-model skeleton: `.claude/agents/REGISTRY.md`; rationale + land worked example: `.claude/plans/subagent-structure.md`; the CI gates that mechanically enforce each agent's couplings: `.claude/plans/ci-gates-protection.md`.

`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + `teammateMode=in-process` are on globally (set 2026-05-19; the feature was NOT enabled when the older manager-of-managers memory was written, so that memory is now superseded by this section). The point of teams is LIVE COLLABORATION — agents working concurrently, dividing non-blocking work, and DMing via `SendMessage` — NOT a fan-out where most agents sit `blockedBy` others doing nothing.

**"Parallel" means COLLABORATIVE-concurrent, NOT blocked-idle (clarified 2026-06-03 by the user).** Spawning 5 agents at once where 3 are `blockedBy` the 2 implementers is fan-out-with-a-barrier, not collaboration — the blocked agents just burn context idling. Only spawn a member at launch if it has useful work to do NOW. Auditors qualify at launch ONLY when they actively PRE-READ the baseline and surface constraints to the implementers BEFORE the diff exists (e.g. a spec auditor posting the "executor can't settle CT, route through the authed path" trap up front — that is real early collaboration that prevents a wrong build). An auditor that would merely idle until `addBlockedBy` releases should instead be spawned WHEN there is a diff to review. Prefer carving work so members collaborate on non-blocking pieces simultaneously over a static dependency DAG.

**Dispatch shape — HYBRID by domain (set 2026-06-03; supersedes BOTH the flat-only doc rule and the manager-of-managers-only memory `feedback_agent_team_managers`):**
- **Specialized domains → manager-of-managers.** 3D / Three.js / shaders / WebGPU → dispatch `3da` as ONE manager; Blender → `blend007:mesh`; Anchor / Solana → `solana-auditor`. The manager runs `TeamCreate`, spawns its own sub-team, and posts ONE consolidated report. This preserves each specialist's curated memory (`3da` → `.claude/memory/threejs/`, etc.) and keeps the orchestrator's context clean.
- **Plain backend / general-purpose → flat top-level team is fine.** No specialized manager exists to gain from, so the orchestrator may spawn the `general-purpose` team directly. Insert a `general-purpose` manager layer ONLY if it does not cost quality — the extra layer must earn its keep in context savings, never dilute the work.
- Either way the team must be genuinely COLLABORATIVE (concurrent + DMing), and you only spawn members who can do useful work now.

**Fixers** spawn no new agent — the Reconciler (impl-2) applies BLOCKING-ISSUE punch lists in place. Orchestrator only commits + pushes + verifies.

### When teams are mandatory

3D / Blender pipelines / Backend / API / DB / money paths · any task > 5 min runtime, > 300 LOC, or ≥ 3 files across subsystems · user quality verbs ("polish", "iterate", "rework", "elite"). `bun test` green is NOT a substitute for the Adversarial audit on backend work.

### Standard compositions (roles per concern; spawn members per the collaborative-concurrent rule above — only those with work to do now — shared `team_name` like `casino-routes-2026-05-19`)

**3D / world-structure:** `3da` × { `3da-impl-1` lead, `3da-impl-2` reconciler, `3da-spec`, `3da-regress`, `3da-adversary` }. Add `blend007:mesh` as `blender-inspect` when GLB inspection needed; substitute `blend007:mesh` for impl roles on Blender-heavy work.

**Backend / API / DB / money:** `general-purpose` × { `impl-1`, `impl-2`, `spec-auditor`, `regress-auditor`, `adversary` }. Add `solana-auditor` for `contracts/` or `apps/api/src/services/wager-program-client.ts`. Invoke `codex:codex-rescue` as `codex-rescue` LATER if impl-1 gets stuck — not at team launch.

Reconciler (impl-2) doubles as the Fixer on BLOCKING ISSUES — no new dispatch, just `SendMessage` with the punch list; auditors re-run via task re-trigger after fix.

### Coordination

`TaskList` for status (one task per role, `addBlockedBy` deps). `SendMessage` for cross-agent ("diff ready" / APPROVED / BLOCKING ISSUES — no silent drops). Memory is auto-shared within a `team_name`. Orchestrator never writes code.

### Required prompt elements

(1) Literal **"use ultrathink reasoning before writing code"** (or "before reviewing code" for auditors) in para 1 — Agent tool has no thinking-mode flag. (2) Addressable team name + role + other members. (3) Explicit blocking deps + downstream consumers. (4) Hard constraints from this CLAUDE.md (Iris Xe, same-diff doc updates) — don't assume they read it.

### When to skip the full team

- **Direct edit (no agent):** 5-line edits — typo, comment, env-var, SVG path, script regen.
- **Light (2-agent, shared team_name):** ≤ 100 LOC or single-file with deterministic tests — 1 ultrathink Implementer + 1 combined-lens Auditor.
- **Full team (DEFAULT, 5 collaborative-concurrent roles):** 3D, Blender, backend, money, > 100 LOC or > 3 files.
- **High-stakes** (DB migrations, custodial keys, auth, billing, rewrites) → full team + `reconciler-manager` that re-implements independently. No exceptions.

Test: would the cost of getting this wrong justify ~5× parallel invocations? When in doubt, full team. Independent concerns → separate teams in parallel; shared state → single team with task deps.

### 3da + Blender context

3da def: `.claude/agents/3da.md`; memory: `.claude/memory/threejs/` (committed, migrated 2026-04-16 — do NOT use user-level paths). Burns prevented: `InstancedMesh + ShaderMaterial` WebGPU crash, drei `<Text>`/`<Billboard>` Iris Xe crash, per-frame `new Vector3()` GC thrash, pipeline compile spikes, rotation sign errors.

Local Blender is exclusive. Tell blender07 to launch a NEW instance, or fall back to direct GLB downloads (Polyhaven, Sketchfab CC0/CC-BY, Kenney, Quaternius). Don't loop on exclusivity.

---

ClawVille is an **agent–human-economy metaverse** on ElizaOS — evolved past "game", aiming to be the first live agent–human economy (full model: **`docs/agent-metaverse-model.md`**). Humans + AI agents (OpenClaw / Hermes / MiladyAI, hosted or BYO) co-present in one 3D/2D world, each with an avatar-bound agent, exploring 10 teaching buildings, learning skills, running stores/land, and both contributing to the same economy + leaderboard. Original sea-floor theme; the 10 building residents teach OpenClaw development.

## IMPORTANT: ElizaOS is MANDATORY

Core requirement — do NOT remove or stub. Avatar + location chat MUST use ElizaOS runtime (`@clawville/agent-runtime`); orchestrator MUST use `createElizaRuntime`. Deploy to persistent-server platforms (Hetzner+Coolify, Render, Fly.io) — NOT Vercel serverless. Never replace with direct API calls or stubs.

## MANDATORY: Hatcher action whitelist parity (server executor and protocol SKILL.md)

The Hatcher in-world ACTION WHITELIST lives in two files that MUST stay in parity, same diff, with `PROTOCOL_VERSION` bumped together:
- ENFORCEMENT (authoritative): `apps/api/src/services/npc-simulation.ts` `dispatchHatcherActions` / `executeHatcherAction` is the server hard gate. Only whitelisted verbs execute; everything else is dropped. Safety lives here and never depends on the SKILL.md.
- DOCUMENTATION: the protocol SKILL.md emitted by `apps/api/src/services/skill-protocol.ts buildProtocolManual` (the single source of `PROTOCOL_VERSION`). This is what a connected agent is TOLD it can do.

When you add, remove, or change a verb or its params in the executor, you MUST update the protocol manual to match AND bump `PROTOCOL_VERSION` in the same diff. A mismatch means agents either attempt actions the server silently drops, or never learn an action the server allows. Connected Hatcher agents poll the manual on entry (via the `protocol` pointer in the registration response) and re-pull when `orientation.version` bumps, so the version bump is how an expanded whitelist reaches them.

## MANDATORY: Partner / integration surface is PROTECTED — contract-locked, harness-gated, never silently broken (set 2026-06-15)

Hatcher is our ONLY partner and runs **LIVE on our PROD** (Hatcher PROD → ClawVille PROD, repointed 2026-06-15; their dev is local; our staging is the pre-prod validation env). **A prod break now directly breaks the live partner integration** — treat prod deploys touching the partner surface with the highest care, dry-run on staging first. The integration is **security- and money-load-bearing** (ed25519 partner signing, custodial Solana wallets, real-CT Cove settlement, SSRF-guarded outbound cognition) and has proven **brittle** — independent reviews found holes across many rounds. A change to this surface — OR an unrelated change that touches something the partner depends on — that ships without contract + harness verification can silently break a live partner. This rule is mechanical, not judgment-based.

**PROTECTED SURFACE (file-path trigger — editing ANY of these binds this rule):**
- Routes: `apps/api/src/routes/{partner-hatcher,partner-hatcher-launch,portal}.ts` (incl. `mint-for-hatcher` / `accept-hatcher-link`), `routes/skills.ts` (manifest / protocol / per-building `skill.md` emitters).
- Services: `partner-signature.ts`, `service-issuer.ts`, `skill-protocol.ts` (`PROTOCOL_VERSION` source), `agent-substrate-client.ts` (cognition `chatHatcherProxy`; renamed from `openclaw-client.ts` in P3 slice 5 — internal substrate rename, NO wire change), `agent-session-config.ts`, `hatcher-config.ts` (SSRF allowlist), `hatcher-session-webhook.ts`, `reserved-agent-namespaces.ts`, `agent-session-restore.ts` (renamed from `openclaw-session-restore.ts`, P3 slice 5).
- Middleware: `require-auth-or-agent.ts` (`validateLiveAgentSession` — the bearer/TTL gate).
- `npc-simulation.ts` — the Hatcher-touching parts: `dispatchHatcherActions`, `oc-`/override bodies, the controlled-launch suppression (`humanControlled*`).
- Shared types: `packages/shared/src/types/agent-substrate.ts` (registration / response / error shapes; renamed from `types/openclaw.ts` in P3 slice 5 — a deprecated re-export shim is retained at the old path so the `types/openclaw` import path still resolves).
- Harness + contract: `apps/api/scripts/hatcher/*` (`mock-hatcher-client.ts`, `mock-hatcher-proxy.ts`, `contract-probe.ts`, `run-mock-e2e.md`), `.hatcher-ref/CONTRACT.md`, `docs/hatcher-integration-spec.md` (the partner-facing single source of truth).

**ALSO BINDS without a `partner-*` file in the diff** — the "unrelated change corrupts the partner" guard. If your change alters any of: the agent-session bearer/TTL model · the `hatcher:` namespace · the cognition request body shape · the `[ACTION:]` whitelist · the leaderboard event names/weights the stats endpoint reports · the shared agent-substrate types (`types/agent-substrate.ts`, né `openclaw`) — the partner surface IS in scope, treat it as such.

**MANDATES (every in-scope change, same diff, before "done"):**
1. **Validate against the partner's REAL code, not our assumptions.** Check our side against Hatcher's ACTUAL open-source contract staged in `.hatcher-ref/` (their host-frontend types/methods + `CONTRACT.md`). If `.hatcher-ref/` is stale, refresh it from their public repo FIRST. (This is the lesson from the contract-parity session — assumptions drifted from their real frontend.)
2. **Run the harness gate.** Drive the live signed binary end-to-end with the mock-Hatcher harness on staging (`apps/api/scripts/hatcher/run-mock-e2e.md`: `mock-hatcher-client` register→stats→401→DELETE + `contract-probe`) and assert GREEN before claiming done. A green `tsc`/`bun test` is **NOT** a substitute — only the harness exercises the real signed wire.
3. **Same-diff docs.** Update `docs/hatcher-integration-spec.md` (its "cross-validated against live code" promise is load-bearing — a drift there mis-tells the partner). When the WIRE contract changes (request/response/error shape, a verb, a bound, a default), bump `PROTOCOL_VERSION` and propagate per the whitelist-parity + three-surface rules above.
4. **Adversarial review.** Any change to signing/verification, session/bearer resolution, the SSRF allowlist, money/CT settlement, or the custodial-wallet path gets a **Codex adversarial pass** before ship (these are the exact paths repeated reviews kept finding holes in). Backend full-team rules apply.
5. **Security invariants — never regress:** partner writes ed25519-verified + ±5 min windowed; `ALLOW_TEST_PARTNER_PUBKEY` staging-ONLY (crash-loud on prod via `CLAWVILLE_ENV`); `hatcher:` namespace reserved on public registration paths; all outbound cognition/webhook/launch SSRF-guarded + signed; scoped token encrypted at rest, never logged/echoed; `wallet.secretKey` returned exactly once.

**FEATURE_GATE — automated staging contract suite (backlogged until Hatcher is confirmed live):** until the automated suite lands, the manual harness (mandate 2) IS the regression gate. Once Hatcher is live and the suite exists, it runs in CI on every push touching the protected surface, and the manual harness becomes the fallback. Review on Hatcher go-live; do not delete this gate while the manual harness is the only protection.

## MANDATORY: Agent world-scope skill file — always current, always installed, always CONSUMED (founder directive 2026-07-15; committed 2026-07-16 — it had lived only as an uncommitted edit on the dev box, itself an E6-class loss)

Set after the 2026-07-15 autonomy audit (`docs/agent-autonomy-audit-2026-07-15.md`): the founder's agent, told "go play cards" in Autonomous mode, walked to a teaching house — the decision prompt offered only the 10 teachers + `enter_building` while `enter_cove` existed in the executor, and none of the three knowledge surfaces reached the deciding LLM. This rule closes that class of defect mechanically:

1. **Same-diff manual update.** Any edit that changes what an agent can do, see, reach, or earn (routes, `[ACTION:]` verbs, buildings/locations, games, economy surfaces, movement bounds, directives) MUST update the canonical world-scope manual — `buildProtocolManual` (`apps/api/src/services/skill-protocol.ts`) and/or `CLAWVILLE_ORIENTATION_KNOWLEDGE` (`packages/shared/src/constants/orientation-skill.ts`) — with a `PROTOCOL_VERSION` bump, in the same diff. (Extends, not replaces, the three-surface rule below.)
2. **Install + refresh on every login.** Every hosted runtime gets the manual injected at provisioning AND re-delivered (version-checked) on every runtime start and session connect. Connected agents are re-pointed at the manual on every connect (version/content-hash in the connect payload).
3. **CONSUMPTION MANDATE — the load-bearing clause.** Any LLM decision path that chooses agent actions (autonomous planner `buildDecisionPrompt`/`decide()`, directive interpretation, talk prompts) MUST be fed the current world scope and the FULL executor action menu. A decision prompt that offers a narrower action set than the server whitelist, or a knowledge surface that is injected but unread on the decide path, is a **defect** — not a scope cut. Audits of agent behavior check what the deciding model actually SEES, not what is stored somewhere.
4. **INSTALLED = stored per-agent + read on every consume path + refreshed** (extended 2026-07-16 after the R2 hosted-skill repair: the play manual had reached **1 of 66** hosted agents for 10 weeks, and nothing read it even where present). A knowledge surface claimed as "installed" must satisfy all three legs, verified in the same diff:
   - **(a) Stored per-agent.** Every deterministic ElizaOS memory id MUST include the agentId in its uuidv5 seed. `plugin-sql createMemory` dedupes by id **GLOBALLY** (`getMemoryById(id)` → silent return, before any agent/room check), so a non-agent-scoped id is claimed by whichever agent boots first and silently no-ops for every other agent — a fleet-wide defect that looks like success. Grep the id derivation; no agentId in the seed ⇒ BLOCKING issue.
   - **(b) A reader on EVERY consume path.** Grep for a consumer of the surface's `subtype` on BOTH the chat path (`knowledgeProvider`) AND the autonomous decide path (`buildDecisionPrompt`) — clause 3 covered decide; this adds chat. For a gateway-routed hosted framework (Hermes/OpenClaw via `openclaw-provider`, priority 100 over the OpenAI text provider), "read" means the retrieved content is **composed into the outbound prompt the external gateway receives** — verify with a mock-gateway probe asserting the skill text arrives on the wire, never from a written memory row alone. Injected-but-unread is scaffolding theater regardless of which table the rows sit in.
   - **(c) Refreshed on login.** Hosted: version/content-hash-checked self-heal on every runtime start. Connected: version/content-hash pointer re-delivered on every connect, with ingestion acknowledged where the protocol supports it.
   - Satisfying evidence phrase (goes in the PR body): "id includes agentId (file:line); subtype `<x>` read on chat (file:line) + decide (file:line) [+ gateway probe green]; refresh on runtime-start/connect (file:line)."

## MANDATORY: Game-flow changes propagate to all three operational-knowledge surfaces in the same diff

Any new game flow, world addition, or edit to a current mechanic (modes, buildings, currencies, quests, wager rules, casino/arcade games, table rules, connect flow, disconnect/timer behavior, leaderboard weights, paused features, etc.) MUST update **all three** in the same diff. PRs missing any are not mergeable.

**1. Nori the Town Guide's `knowledge[]`** — world-orientation surface for any visitor (hosted/connected agent or human).
- Path: `packages/agent-templates/src/locations/town-guide.ts` → `knowledge[]`, registered in `SYSTEM_AGENT_TEMPLATES`. Re-seeded by `ensureSystemAgents()` in `apps/api/src/services/system-npc-seeder.ts` on every API boot.
- Chat: `POST /api/chat/system/:slug` (lookup `getSystemAgent(slug)`; platform type `'system-agent'`; slug at `customization.slug`; no `location_agents` row; 3D click at `apps/web/src/lib/three/town-guide.tsx`). Rate limit: +1 ClawToken + 5 XP/turn, capped one per `(userId, slug)`/60s (`system-agent-reward-limiter.ts`). Logs `chatType: 'system-agent'` — does NOT inflate `/dash` teacher-chat metric (teachers = 10 residents only).
- Goes in `knowledge[]`: what ClawVille is, 4 modes, 10 buildings + teachers + focus, Moltbook connect flow, Milady sideload, ClawToken rules, leaderboard weights, casino/arcade games + table rules, quest/bounty state, tutorial. **Not in:** domain-specific skill knowledge (cron, RAG, MCP, Solana signing) — those live in the 10 residents. Rule: "point at the teacher, don't replace."
- Add new system agent: write template → register in `SYSTEM_AGENT_TEMPLATES` → ship; `ensureSystemAgents()` upserts on boot. Partial unique index `platform_agents_system_singleton` enforces one row per (userId, type='system-agent', slug).

**2. Connection SKILL.md** — protocol/operating manual for external/magic-link agents. HOW to connect and play, NOT in-world earned skill.
- Contains: auth handshake, WebSocket protocol, event/action schemas, current table rules, disconnect/timer behavior, advisor-mode contract, content-hash version.
- **CRITICAL:** fetched fresh on every connect with version tracking. Stale manual = connected agent playing a different game than hosted agents = playing field broken.
- **Distinct from** existing per-building `/api/agent/:sid/skills/:bid/skill.md` endpoints — those serve in-world earned teacher knowledge, NOT the protocol manual.
- **Endpoint EXISTS (corrected 2026-06-16):** the global connection SKILL.md endpoint + content-hash manifest ARE live in `apps/api/src/routes/skills.ts` (built by `skill-protocol.ts buildProtocolManual`) — `GET /api/skills/protocol/skill.md` serves the stable, token-free protocol manual carrying `PROTOCOL_VERSION` (currently **6**), and `GET /api/skills/manifest.json` is the single poll target exposing live per-skill content hashes (`contentHashOf`) so a connected agent can detect drift and re-pull. Both are partner-key gated (`requirePartnerKey('skills:read')` + 60/min). **Still TODO/best-effort:** EAGER-on-connect enforcement is pull-based — agents poll the manifest, there is no server push — and the hosted-agent runtime injection of #2 (surface #3 below, the `createMemory()` `subtype:'protocol-knowledge'` path) is not yet wired. Content updates are still required same-diff (rule binds).

**3. Hosted-agent runtime knowledge of #2** — server-side equivalent for hosted Milady/Hermes runtimes on our boxes.
- Same content as #2, different delivery: `createMemory()` injection via extension of `ensureSystemAgents()` (or sibling) into each hosted agent's ElizaOS runtime on restart. Metadata namespace `subtype: 'protocol-knowledge'` (distinct from `subtype: 'world-knowledge'`). After write, `agentOrchestrator.stopAgent()` so next chat reload picks up the new manual.

**NOT in this rule (separate category — earned/exportable per-agent skills):** gameplay knowledge accumulated through play (blackjack hand outcomes, basic-strategy mastery, count-tracking accuracy, teacher knowledge fetched by visiting a building). That's per-agent ElizaOS memory, written continuously during play via `createMemory()` for hosted agents and via optional ingestion of protocol-event payloads for connected agents. Per-agent state, not world-state — no same-diff requirement.

**Rationale:** the game's competitive premise is that agents with up-to-date manual knowledge play the right game, and accumulated earned-skill memory gives them an edge. Stale manuals or stale orientation break the playing field's fairness and measurability. Same-diff propagation across all three surfaces is the forcing function.

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
- `DB_POOL_MAX` — optional cap on postgres.js connections per process (`packages/database/src/index.ts`; default 10). **Set `4` in every local `.env.local`** (done 2026-07-18): local dev uses the Supavisor SESSION pooler (:5432) which hard-caps clients at pool_size 15 **shared with the staging ElizaOS adapter's derived session-mode pools** — a few concurrent/leaked local dev servers (api AND web each open a pool) exhaust it (`EMAXCONNSESSION` on every query). The client also sets `idle_timeout: 30` + `max_lifetime: 1h` so idle processes release slots. Deployed staging/prod app DATABASE_URLs are :6543 txn-mode (unaffected); leave `DB_POOL_MAX` unset there.
- `DB_CANARY_INTERVAL_MS` — database watchdog cadence (default 30000ms, floor 10000ms). Each shared-pool probe and its fresh-client discriminator has a separate 10s deadline.
- `DB_CANARY_EXIT_THRESHOLD` — consecutive shared-pool wedges before the watchdog alerts and exits for container restart (default 8, floor 1). A real DB outage resets this streak and never triggers an exit.
- `DB_CANARY_EXIT` — watchdog self-heal kill switch. Exit is enabled by default; normalized exact `false` keeps critical alerts active but disables the one-second grace + `process.exit(1)`.
- `DB_CANARY_DRIVER_STALL_MS` — warning threshold for an enrolled autonomy driver whose interval heartbeat stopped (default 300000ms). Counts house and user agents; intentional standby ticks still heartbeat.
- `AGENT_PAY_RESUME_POLL_MS` — agent-pay stuck-settling resume-worker cadence (default 300000 = 5 min, floor 60000). Forward-only recovery: captured signature chain-checked read-only then fulfilled via the idempotent machine; never re-signs/re-sends; ambiguous rows quarantine to `reconcile` + Telegram warning.
- `AGENT_PAY_BREAKER_THRESHOLD` — consecutive provider-wide PayAI facilitator failures before the new-outbound-settlement circuit opens (default 5, floor 1). Payment-specific rejections do not count; an open circuit returns the existing `payai_unavailable` HTTP 503 before wallet/RPC/facilitator work or pending-row creation.
- `AGENT_PAY_BREAKER_COOLDOWN_MS` — open-circuit cooldown before exactly one new outbound settlement is admitted as a half-open probe (default 600000 = 10 min, floor 10000). Success closes; a provider-wide failure re-opens. Existing-row fulfillment, resume, and reconcile paths remain ungated.
- `ELIZA_DATABASE_URL` — **optional EXPLICIT override** for the ElizaOS agent adapter's DB connection (`eliza-runtime.ts`). By DEFAULT (unset) the adapter DERIVES a SESSION-mode URL in code from the effective `DATABASE_URL` — `toSupabaseSessionModeUrl()` swaps the Supabase pooler port **:6543→:5432** (same host/creds/DB). Reason (2026-07-07): plugin-sql's per-agent schema migration takes a GLOBAL session-scoped advisory lock (`pg_advisory_lock`) that **orphans and never releases over the transaction-mode pooler (:6543)** → the next agent's migration blocks 90s → "Failed to start avatar agent runtime"; session mode (:5432) holds the lock on a stable backend and releases on disconnect. **Do NOT set this on Coolify to a hand-typed URL** — the Coolify env row is overridden at runtime by a baked `.env.local`, so a hand-set value silently drifted the adapter to a STALE DB ref (`wheuidgiyyccqyoppxoa` vs the real staging `mtpixvtclsjqjguouxes`); leave it UNSET so the code derives from the same DATABASE_URL the app actually runs on. Only set it for a non-Supabase deployment where the port-swap heuristic doesn't apply. The code-level `migrationsCompleted` guard (migrate once/process, `skipMigrations:true` after) is the primary protection regardless. See `ARCHITECTURE.md` "Last Audited" 2026-07-07.
- `GEMINI_API_KEY`: **REMOVED from the runtime entirely** (2026-06-16; the 2026-06-05 "fully UNUSED but retained for easy-revert" state is superseded — the dead reads + provider files are now scrubbed). No code reads it. Both text generation and embeddings run on OpenAI: text via `openai-text-provider` (`gpt-4o-mini` / `gpt-4o`, priority 95) and embeddings via `openai-embedding-provider` (`text-embedding-3-small`, 1536-dim `TEXT_EMBEDDING`, priority 100). The embeddings table was EMPTY (0 rows) at the swap, so no re-embed migration was ever needed. Do NOT set `GEMINI_API_KEY` on any box — it is a no-op. Anthropic removed 2026-04-10.
- `OPENAI_API_KEY`: backs **BOTH** text generation (`openai-text-provider`, priority 95) **AND** embeddings (`openai-embedding-provider`, priority 100) since 2026-06-05. Required for every non-OpenClaw runtime.
- **Embedding model + dimension are PINNED in code, NOT env-overridable** (2026-06-05). `openai-embedding-provider.ts` and `embed-text.ts` hard-code `text-embedding-3-small` / 1536-dim as literal constants in the request body AND the boot dimension-probe, so stored vectors and query vectors can never diverge and pgvector always uses the `dim_1536` column. `OPENAI_EMBEDDING_MODEL` / `OPENAI_EMBEDDING_DIMENSIONS` are no longer read. Changing the dimension routes embeddings to a different column and requires a re-embed migration, so it is a deliberate code edit, not an env tweak.
- `VANITY_ENCRYPTION_KEY` — 64-char hex. AES-256-GCM master key for `treasury_wallets` + `vanity_keypairs`. Must match on every decrypting machine.
- `FINGERPRINT_SECRET` — 64-char hex (32+ bytes). **Hard-required** — `apps/api/src/middleware/fingerprint.ts` throws at module load if missing or short, crashing API boot. `openssl rand -hex 32`. Salts the sha256 hash of `X-CV-Fingerprint` + IP /24 prefix on every event row. Server-only. Rotating invalidates every existing fp_hash.
- `CLAWVILLE_MERCHANT_WALLET_PUBKEY` — base58 pubkey of Phase 4 x402 merchant wallet.
- `PAYAI_API_KEY_ID` — optional PayAI facilitator merchant Key ID. **Both this and `PAYAI_API_KEY_SECRET` are required to enable auth; either unset/empty preserves the current anonymous free tier (10,000 settlements/month).** `@payai/facilitator` uses both credentials to generate and cache signed Bearer JWTs for verify/settle/supported.
- `PAYAI_API_KEY_SECRET` — optional PayAI facilitator merchant Key Secret (`payai_sk_…`). Required with `PAYAI_API_KEY_ID` beyond the anonymous free tier; server-only and never logged or exposed.
- `CORS_ORIGIN` — frontend URL(s) (prod `https://clawville.world`).
- `NEXT_PUBLIC_API_URL` — backend URL (prod `https://api.clawville.world`).
- `ADMIN_USER_IDS` — comma-separated UUIDs allowed on `/api/dashboard/*` + `/dash`. Parsed at module load; changes require redeploy. See `middleware/admin-only.ts`.
- `ITACHI_DEBUG_BOT_TOKEN` + `ITACHI_DEBUG_CHAT_ID` — itachi-debug Telegram bot for `alert-error.ts`. Missing ⇒ degrades to `console.warn`. Staged via tinker from `~/.itachi-api-keys`.
- `METRICS_MEASUREMENT_START` — ISO date for `/dash` "Measuring since …" banner. Default `2026-04-21`.
- `AGENT_SESSION_TICKET_TTL_SECONDS` — Phase 5 magic-link TTL (default 600, min 60, max 3600 — `session-ticket-service.ts`).
- `HATCHER_SESSION_WEBHOOK_URL` — optional, DORMANT by default (2026-06-12). When set, the API POSTs a signed `session.ended` notification (`reason: ttl_expired | disconnected`) to the partner on Hatcher-agent session expiry/disconnect (`hatcher-session-webhook.ts`). Must be https + on the `HATCHER_PROXY_ALLOWED_HOSTS` allowlist (re-validated every send). Fail-open: a bad/unreachable URL never blocks the sweep. Unset ⇒ no notify.
- `PARTNER_DAILY_REGISTRATION_CAP` — max NEW Hatcher agents registered per UTC day via `POST /api/partner/hatcher/agents` (default 50, floor 1; 2026-06-12). Re-register/PATCH of an existing agentId is never counted. Over cap ⇒ 429 `daily_registration_cap`.
- `AGENT_BODY_IDLE_DESPAWN_MS` — in-world body idle-despawn window (default 30 min = 1800000; floor 5 min; 2026-06-12, `agent-body-idle-sweeper.ts`). After this much inactivity an agent's BODY despawns to save sim CPU; the SESSION stays valid and the body re-spawns on next activity. Does NOT affect the 24h session TTL.
- `MESSAGE_MEMORY_RETENTION_DAYS` — ElizaOS conversation-transcript retention (default 7 days, floor 1 day, `0` = off; `message-memory-sweeper.ts`). Prunes stale `memories.type='messages'` rows only; teacher corpus, earned skills, protocol knowledge, and book rows under `type='knowledge'` are never touched.
- `INFERENCE_USAGE_REPORT` — hourly Telegram inference-usage report via the itachi-debug bot. Default: on iff `CLAWVILLE_ENV='production'`; exact `'on'` / `'off'` values override that default in any environment. The first process-lifetime report arrives about five minutes after boot (`since boot`), then subsequent reports contain hourly deltas. Also gates the 60s box-status watcher: per-box `✅/❌` reachability in every report + immediate Telegram alerts when a local box (or the openai endpoint) goes offline (2-check debounce) and when it recovers.
- `MODERATION_ENABLED` — chat content-guardrail kill switch (default `true`/ON). `false`/`0`/`off` ⇒ allow-all, no backend call. Server-side safety; no gameplay semantics. See `moderation-service.ts` (2026-07-09).
- `MODERATION_BACKEND` — moderation classifier backend selector (default `openai` = OpenAI `omni-moderation-latest`, called with the existing `OPENAI_API_KEY` — no separate key). Future `granite` (IBM Granite Guardian) registers via `registerModerationBackend`; unknown value fails OPEN (never blocks chat).
- `RESEND_API_KEY` — Resend SDK key for transactional emails (verify-email + reset-password). Optional in dev (console fallback prints the email payload to stdout); set in prod or Resend rejects all sends. Get from https://resend.com/api-keys.
- `FROM_EMAIL` — RFC 5322 From-address for transactional emails. Default `ClawVille <noreply@clawville.world>`. Sender domain MUST be verified in the Resend dashboard before prod will actually deliver — unverified sends bounce with 403.
- **Phase 5.1 env vars** (`CLOUDFLARE_WORKER_URL/_BEARER`, `CLAWVILLE_SERVICE_ISSUER_SK/_PUBKEY`, `SCAPE_HOSTED_SESSION_URL`, `SCAPE_WEB_ORIGIN`, `PARTNER_PUBKEYS`) — see `ARCHITECTURE.md §7`. Crash-loud rule: `FINGERPRINT_SECRET` + `CLOUDFLARE_WORKER_*` are hard-required on boot; missing ⇒ API refuses to start.
- **Wager program env vars** (`SOLANA_RPC_URL`, `WAGER_SETTLEMENT_AUTHORITY_PUBKEY`, `WAGER_SETTLEMENT_AUTHORITY_KEYPAIR_PATH`, `WAGER_PROGRAM_CLUSTER`) — see `ARCHITECTURE.md §13` (2026-05-13 entry). Devnet-only; mainnet requires a code change, not just `WAGER_PROGRAM_CLUSTER=mainnet`.
- **SAP on-chain rail env vars** (`SAP_ENABLED`, `SAP_ESCROW_ENABLED`, `SAP_USDC_ESCROW_ENABLED`, `SAP_PAYAI_SETTLEMENT_ENABLED`, `SAP_DRY_RUN`, `SAP_CLUSTER`, `SAP_RPC_URL`, `SAP_PROGRAM_ID`, `SAP_DISPUTE_WINDOW_SLOTS`, `SAP_BOUNTY_DISPUTE_WINDOW_SLOTS`, `SAP_BOUNTY_RESUME_POLL_MS`, `SAP_TREASURY_PUBKEY`, `SAP_ARBITER_PUBKEY`, `SAP_SETTLEMENT_MODE`) — `services/sap/sap-config.ts` + `docs/sap-integration.md`. **MAINNET is a TWO-LOCK gate (validation ladder: devnet-staging ✅ → mainnet-staging → prod ON):** LOCK 1 = the `SAP_ALLOW_MAINNET` CODE constant in `sap-config.ts` (**flipped TRUE 2026-07-10**, the reviewed config event; revert to `false` restores crash-loud devnet-only); LOCK 2 = `SAP_CLUSTER=mainnet` PER BOX. A box stays fully devnet unless it sets `SAP_CLUSTER=mainnet`, and real funds move only with `SAP_DRY_RUN=false` + the enable flags. On a mainnet box you MUST set a paid `SAP_RPC_URL` (Helius mainnet). "Flags off" is the DEFAULT-SAFE state, NOT a resting state — the target is prod fully ON.
- `USDC_BOUNTY_REWARD_MIN` — on-chain bounty reward floor in integer vCLAW units (1 vCLAW = $0.01). Default 5 vCLAW ($0.05); clamped to integer ≥ 1 (`resolveUsdcBountyRewardMin` in `routes/bounties.ts`, enforced per rail in `createBountySchema`'s `superRefine`). Staging may set `1` for a one-cent smoke. The in-game `vclaw` rail has a fixed 5-vCLAW floor. On-chain escrow converts with exact integer math: `tokenReward × 10^4` USDC base units.
- `CLAWVILLE_ENV` — explicit immutable deploy-environment signal (`'staging'` | `'production'` | unset). Set per-box in Coolify. The ONLY thing that unlocks the staging-only `ALLOW_TEST_PARTNER_PUBKEY` mock-Hatcher signer: `apps/api/src/services/partner-signature.ts` accepts the test key ONLY when `CLAWVILLE_ENV==='staging'` and THROWS AT MODULE LOAD (crash-loud, like `FINGERPRINT_SECRET`) if `ALLOW_TEST_PARTNER_PUBKEY` is set while `CLAWVILLE_ENV!=='staging'`, so a prod box carrying the test signer refuses to boot. `NODE_ENV` can't be the discriminator (it is `'production'` on BOTH Coolify boxes). **Staging box (app 3) MUST have `CLAWVILLE_ENV=staging` set alongside `ALLOW_TEST_PARTNER_PUBKEY` or staging boot fails.** Set 2026-06-12 (Codex review #1). See `ARCHITECTURE.md §13` (2026-06-12 Codex-fixes entry).
- `AUTONOMY_STANDBY_DEFAULT` — optional autonomy-driver boot default: `'on'` = standby and `'off'` = active. When unset, the default is standby only when `CLAWVILLE_ENV==='staging'`; production and an unset/other deploy environment default active. Resolution happens once at module load. Arm/standby changes are per-process memory only, so every API restart deliberately returns to this resolved default (the safe direction on staging); admins can still arm a bounded window or use standby as a production emergency brake. See `ARCHITECTURE.md` “Autonomy standby switch”.
- `ALLOW_TEST_PARTNER_PUBKEY` — STAGING-ONLY base58 ed25519 pubkey; additive mock-Hatcher test signer for the `hatcher` partner only. Gated by `CLAWVILLE_ENV==='staging'` (above); MUST NEVER be set on prod (the module-load throw enforces it). See `ARCHITECTURE.md §13`.
- **Meridian x402 fallback env (`MERIDIAN_*`, activated 2026-07-23 on BOTH boxes).** `MERIDIAN_FACILITATOR_URL` (`https://api.mrdn.finance`) + `MERIDIAN_API_KEY` (per-env org key, `pk_…`) + `MERIDIAN_PLATFORM_FEE_BPS` (default 0). ALL unset ⇒ Meridian fully disabled (provable no-op; pinned by tests). When set, custodial INBOUND settles (ct-topup / x402-checkout) fail over to Meridian on PayAI outage-class failures ONLY (5xx / timeout / free_tier_exhausted — never on payment-invalid). HARD CONSTRAINT: Meridian Solana settles ONLY to the org's dashboard-configured recipient wallet, which MUST equal `CLAWVILLE_MERCHANT_WALLET_PUBKEY` (runtime-asserted; wrong dashboard config ⇒ every Meridian settle refused). Their wire is x402 v1 + LEGACY transactions + required `description` (live-proven; fixtures pin it). Meridian takes 1% on-chain treasury fee ⇒ vCLAW credit uses NET (fee columns on `x402_settlement_receipts`/`agent_payments`, migration 0044). The `sk_` org secrets are dashboard/management-only — NEVER staged into runtime env. Full trail: `docs/x402-partner-alignment-specs-2026-07-22.md` + `ARCHITECTURE.md §13`.

- `OPENAI_API_KEY`: the `openai` endpoint of the **InferenceRouter** (`packages/agent-runtime/src/inference/`) — the single text-gen router that every non-OpenClaw path delegates to (`openai-text-provider` priority 95 for `TEXT_SMALL`/`TEXT_LARGE`; `npc-conversation-engine.ts` NPC banter). OpenAI is the reliable last-resort every route falls back to. Models via `OPENAI_SMALL_MODEL` (default `gpt-4o-mini`) / `OPENAI_LARGE_MODEL` (default `gpt-4o`) — these now define the `openai` endpoint's models, not a global.
- **Inference routing (`INFERENCE_*`, added 2026-07-06 — replaces the interim global `OPENAI_BASE_URL` hack).** The router owns named endpoints + per-consumer routes + health-based failover. **Never re-introduce `OPENAI_BASE_URL`** — that global routed EVERY agent (incl. the 10 teachers) to one URL with no failover; it is retired. Config (all optional; unset ⇒ pure OpenAI, identical to pre-router):
  - `INFERENCE_LOCAL_PRIMARY_URL` (e.g. `http://<tailnet-ip>:11434/v1`) + `INFERENCE_LOCAL_PRIMARY_MODEL` (default `qwen3:14b`) + optional `INFERENCE_LOCAL_PRIMARY_KEY` → adds the `local-primary` endpoint.
  - `INFERENCE_LOCAL_SECONDARY_URL`/`_MODEL`/`_KEY` (default model `qwen3.6:27b`) → adds `local-secondary`.
  - **Box↔slot assignment (founder ruling 2026-07-16 — SUPERSEDES the 2026-07-07 "27b = local-secondary" wiring):** the earlier setup had the two machines mislabeled. LIVE on both envs since 2026-07-16: `local-primary` = **the 27b/7900XTX desktop** (`100.75.223.14`, `qwen3.6:27b` — THE preferred box, maxed out and kept hot) and `local-secondary` = **johns-pc** (`100.76.57.60`, `qwen3:14b` — overflow/backup). Route CSVs list `local-primary,local-secondary,openai`, so slot names once again match preference order. The swap was ENV-ONLY (Coolify model setter, staging app 3 + prod app 2); no code change. Failover drilled live on staging 2026-07-16: prober DOWN-flag in ≤16s → decides on the secondary → concurrent burst degrades to OpenAI (<1s serves, zero failures) → readmit within one probe cycle of recovery.
  - **Local wire = Ollama-native `/api/chat` with `think:false`** (not `/v1`): `INFERENCE_LOCAL_*_PROVIDER` defaults to `ollama` (set `openai` for a non-Ollama OpenAI-compat box). This is LOAD-BEARING — qwen3 is a reasoning model, and on the fleet's complex decide() prompt it spends its whole token budget inside `<think>` (verified >50s → past the autonomy driver's 15s timeout → EMPTY decision). `think:false` turns that into a valid `[ACTION:]` in ~2s. Local endpoint timeout remains **60s** (`INFERENCE_LOCAL_TIMEOUT_MS`) for off-path cold warming; autonomy decisions explicitly cap each local attempt at 6s before continuing to the next endpoint. Do not assume a DOWN tailnet peer returns ECONNREFUSED: an offline Tailscale peer can blackhole packets until the timeout.
  - Route overrides (CSV of endpoint ids): `INFERENCE_ROUTE_TEACHER` / `_FLEET` / `_HOSTED_USER` / `_DEFAULT`. Baked defaults: **only `fleet` (our `is_house` agents) uses local** — `fleet=[local-primary,(local-secondary,)openai]`; `teacher`/`hosted-user`/`default` = `[openai]`. OpenAI is auto-appended as the ultimate fallback to any route. So the 10 residents (`location-agent`) + Nori (`system-agent`) can never land on a local box; only house-fleet agents do. Route order is preference order: the first healthy local absorbs work up to `INFERENCE_PRIMARY_MAX_INFLIGHT` (default 3), then overflow uses the next local; do not reorder or drop a local from configured routes — since the 2026-07-16 slot swap the preferred 27b box IS `local-primary` (see box↔slot assignment above). Both boxes carry `keep_alive` (`INFERENCE_LOCAL_KEEP_ALIVE`, default `60m`, `-1`=never unload), pre-warm on API boot, and warm again before a recovered breaker is closed.
  - `INFERENCE_PROBE_INTERVAL_MS` (default 15000) runs a background liveness check for each local endpoint; `INFERENCE_PROBE_TIMEOUT_MS` (default 3000) bounds each check. A failed check holds that local breaker open so live traffic skips it. Recovery is probe-owned: liveness must pass and the model must finish a generous 180s one-token warm before the breaker closes. The singleton prober starts beside `warmup()` during API boot and never auto-starts in the router constructor.
  - `INFERENCE_CLOUD_TIMEOUT_MS`/`INFERENCE_LOCAL_TIMEOUT_MS` (default 60000), `INFERENCE_FAIL_THRESHOLD` (default 3), `INFERENCE_COOLDOWN_MS` (default 30000). Route assignment: `resolveInferenceRoute(agent.type, isHouse)` in `agent-orchestrator.startAgent`; house-ness derived from `opts.isHouse` OR the platform_agents `config.houseAgentId` marker. Full spec: `docs/inference-router-spec.md` + `ARCHITECTURE.md` (Inference routing).

- **Tokenomics env vars (added 2026-07-07/08, economy v1 — full detail `.env.example` + `ARCHITECTURE.md` Tokenomics entries):**
  - `HELIUS_API_KEY` — CLV price-oracle primary feed (`clv-price-oracle.ts`); unset ⇒ keyless DexScreener fallback (oracle degrades gracefully, never blocks boot).
  - `CLV_ORACLE_POLL_MS` (default 60000, floor 15000) / `CLV_ORACLE_MAX_STALE_MS` (default 10 min — older snapshots are REFUSED as quotes).
  - `CLV_SWAP_EXECUTE` — **MUST NEVER be 'true'** (Codex-gated seam): live CLV swap execution refuses at MODULE LOAD (a flagged box won't boot, crash-loud like `FINGERPRINT_SECRET`). The swap executor is DRY-RUN only. The GoLive-executors slice (2026-07-07) added the FULLY-PLUMBED-BUT-DARK live path (`clv-swap-custody.ts` + `clv-swap-live.ts`: funding sweep merchant→swap-wallet, atomic claim, per-clip Jupiter USDC→CLV) — every live entrypoint re-asserts this gate default-OFF AND a mainnet/real-facilitator network guard (devnet/mock can NEVER reach a real send). **Boot wiring is CONDITIONAL (2026-07-08, Codex re-review):** flag unset/false ⇒ index.ts starts the dry-run worker (today's only reachable behavior); `'true'` ⇒ it selects `startClvSwapLiveWorker()` — a DEAD branch while the module-load throw stands. Opening the seam = remove ONLY that module-load throw (Codex-reviewed change; the boot wiring already switches on the flag — no crash-loop on the dry-run gate).
  - `CLV_SWAP_SLIPPAGE_BPS` (default 100, floor 1, cap 1000) / `CLV_SWAP_JUPITER_BASE_URL` (**HOST-ALLOWLISTED** 2026-07-08 — only `lite-api.jup.ag` default + `api.jup.ag` accepted; anything else warns + falls back to the default, so the swap wire can only ever point at Jupiter) / `CLV_SWAP_EXECUTING_STALE_MS` (default 300000, hard floor 180000 — a `clv_buy_queue` row stuck `'executing'` past this pages ops via `alert-error`, ALERT-ONLY, never auto-resumed) — DARK live-path knobs, read only behind the `CLV_SWAP_EXECUTE` seam; slippage drives BOTH the Jupiter quote AND the oracle-derived on-chain min-out floor.
  - `MOONPAY_API_KEY`/`MOONPAY_SECRET_KEY`/`MOONPAY_WEBHOOK_KEY` — card→USDC rail, **test-mode only** (`pk_test_` enforced; the live widget URL is a code constant, not env — going live is a Codex-reviewed code change).
  - `MARKETPLACE_SETTLE_ENABLED` — P2P marketplace settlement fulfiller, default OFF (triple-gated: quote, preflight, in-tx refusal).
  - `MARKET_DEED_TRANSFER_ENABLED` — **MUST stay unset/false** (GoLive executors, 2026-07-07): the DARK deed-transfer executor (`market-deed-transfer-executor.ts`) flips `land_parcels.owner_avatar_id` seller→buyer for SETTLED land_deed settlements (pure DB, ONE tx, land lock order, under-lock owner re-verify — a conflicted deed is TERMINAL, never forced). Not wired into index.ts boot; opening it is a Codex+land-reviewed change.
  - `MARKET_PAYOUT_EXECUTE` — **MUST stay unset/false** (GoLive executors, 2026-07-07): the DARK payout executor (`market-payout-executor.ts`) sends the seller's 95.56% + treasury's 4.44% CLV on-chain from the clv-swap wallet (Token-2022 TransferChecked, exact-integer floor at the EXECUTED C3 buy rate, sellerClv+rakeClv ≤ Σ recorded fills — never pays CLV that wasn't bought; capture-before-send; ambiguous ⇒ reconcile-never-retry; `deed_transferred_at` precondition — DEED FIRST, PAYOUT SECOND). E5 parity: human seller → stamped pubkey re-validated vs CURRENT `users.linked_wallet_pubkey`; agent seller → CURRENT custodial `avatars.wallet_address`; guests NEVER paid. Also guarded by the mainnet/real-facilitator network guard. Companion knobs: `MARKET_RAKE_TREASURY_PUBKEY` (rake destination pin — FAIL CLOSED, unset ⇒ nothing sends) and `MARKET_PAYOUT_STALE_MS` (resume-takeover threshold, default 300000, hard floor 180000).
  - `X402_CHECKOUT_SETTLING_STALE_MS` / `CT_TOPUP_SETTLING_STALE_MS` — durable-settle stale-claim thresholds (default 300000; **hard floor 180000** — must exceed the ~120s facilitator timeout or a live in-flight settle gets mis-reconciled).
  - `RECONCILE_APPLY` — **MUST NEVER be 'true'** (Codex-gated): the x402 reconciler is a DRY-RUN classifier; its apply path refuses to run.
  - `WALLET_WITHDRAW_ENABLED` — **MUST stay unset/false** (custodial wallet WITHDRAW, 2026-07-08, DARK): `POST /api/wallet/withdraw` + `services/wallet-withdraw-executor.ts` SIGN with the USER'S custodial avatar keypair and move REAL mainnet SOL/USDC/CLV to a self-custody destination (market-payout exactly-once discipline: atomic claim → capture-before-send → ambiguous ⇒ reconcile-never-retry; resume forward-only; `Idempotency-Key` REQUIRED; on-curve non-self destinations only; source keeps rent-exempt+fee SOL; mainnet endpoint guard). Flag OFF ⇒ typed 503 `withdraw_disabled`; `GET /api/wallet/balances` (read-only) is live regardless. Opening the flag is gated on the custody-model LEGAL REVIEW (`wallets.ts` JSDoc caveat) + the money-review chain — never an env flip alone. LEDGER-UNTOUCHED: never `claw-token-ledger` / `avatars.clawTokens` (NOT a cash-out). Companion knobs: `WALLET_WITHDRAW_STALE_MS` (resume-takeover threshold, default 300000, hard floor 180000) and `WALLET_WITHDRAW_RESUME_POLL_MS` (2026-07-09 — boot-wired resume-worker cadence, default 300000, floor 60000; the worker is DARK-GATED, starting ONLY when the withdraw flag is 'true', chain-checks stale 'sending' claims FORWARD-ONLY — never re-signs/re-sends a captured signature — and pages ops via `alertError` (warning, source `wallet-withdraw-resume`) for every row resolving to 'reconcile'). Daily caps REMOVED 2026-07-09 (founder decision) — the old `WALLET_WITHDRAW_DAILY_CAP_{SOL,USDC,CLV}` knobs are no longer read. CLV consent gate (2026-07-09): a CLV withdrawal that would drop the custodial balance below the avatar's stacked agent-subject LAND-HOLD requirement refuses 409 `hold_at_risk` (+ `holdAtRisk` payload) unless the body carries `acknowledgeHoldLoss: true` — informed consent, PRE-ROW (no row on refusal), FAIL-OPEN on the threshold-query error only; hold ENFORCEMENT stays with the land rent sweeper.

**Removed:** `ANTHROPIC_API_KEY` (ultrathink decommission). `OPENAI_BASE_URL` (interim local-inference hack, superseded by the InferenceRouter 2026-07-06 — do NOT reintroduce).

## Deployment — Hetzner + Coolify (Railway decommissioned)

**Two Hetzner VPS hosts (since 2026-05-23 migration):**
- **Production:** `$PROD_VPS_IP` (in gitignored `scripts/deploy/.env.deploy`), Hillsboro, Coolify 4.1, key `~/.ssh/clawville_hillsboro` (passphrase — `ssh-add` once into Windows ssh-agent). Serves `clawville.world` + `api.clawville.world`. Admin UI `https://coolify-new.clawville.world`.
- **Staging:** `$STAGING_VPS_IP`, Ashburn, Coolify 4.0, key `~/.ssh/clawville_deploy`. Serves `staging.clawville.world` + `api-staging.clawville.world`. Admin UI `https://coolify-staging.clawville.world`.

Both Traefik + Let's Encrypt, Cloudflare-proxied DNS, **separate Supabase Postgres per box (isolated 2026-06-16; staging `mtpixvtclsjqjguouxes`, prod `wheuidgiyyccqyoppxoa`)** — staging writes no longer touch prod; schema converges to prod via the CI migration gate (`migrate`→`deploy`) on the `staging → master` promotion (see `deploy-status.md`). Both pull from `github.com/ItachiDevv/ClawVille` via the same shared deploy key, auto-deploy on push. Web ~3–5 min, api ~2–3 min.

**Coolify app IDs:** prod api=2, prod web=3, staging api=3, staging web=4. UUIDs in `.env.deploy` as `API_APP_UUID`, `WEB_APP_UUID`, `STAGING_API_APP_UUID`, `STAGING_WEB_APP_UUID`.

### Deploy paths

- **Normal:** `git push origin staging` (or `master` per staging-first rule) — Coolify auto-builds.
- **Force-redeploy / missed webhook:** SSH in → `bash scripts/deploy/clawville-deploy.sh` (wraps api+web tinker).
- **Env-var add/update:** SSH in → tinker. **Encryption gotcha (2026-05-23):** NEVER write `environment_variables.value` via raw `DB::update()` + `\Crypt::encryptString()` — Coolify's model mutator re-encrypts on save; raw writes break `decrypt()` and crash builds with `unserialize()` exception. ALWAYS `$row->value = $plain; $row->save();`.
- **Skip-ahead-to-latest:** Coolify queue is FIFO — when you push B while A still building for the same app, kill A's PID and mark its `ApplicationDeploymentQueue` row `cancelled-by-user`. Never cancel the latest. Recipe in `docs/DEPLOY-HETZNER.md`. This Coolify beta has NO auto-cancel-superseded-builds feature — don't assume it; superseded builds run to completion (wasted server cost) unless killed manually.
- **Double-queued builds (RULE, 2026-06-10 — TWO sources, one still open):** every push created duplicate `ApplicationDeploymentQueue` rows per app (~10s apart, same commit). Source 1 FIXED: the repo had the same Coolify webhook registered twice (`gh api repos/ItachiDevv/ClawVille/hooks`; keep EXACTLY ONE per endpoint, delete extras via `gh api -X DELETE .../hooks/<id>`). Source 2 STILL OPEN: even with one webhook, a second row appears ~10s later with `is_webhook=f` — an internal Coolify trigger (poller-like) not exposed in `application_settings`. UNTIL ROOT-CAUSED: after every push, check the queue and cancel the duplicate same-commit row (`UPDATE application_deployment_queues SET status='cancelled-by-user' WHERE id=<dup>` + `docker rm -f <deployment_uuid container>`). Superseded/duplicate builds are pure server cost — never let them run to completion.
- **"Finished" ≠ live (RULE):** verify deploys by reading the CONTAINER, not the queue: `docker exec <app-container> env | grep SOURCE_COMMIT` must equal the pushed sha (+ bundle grep for a new string literal when in doubt). Queue rows can read `finished` while the container flip silently failed (no container, site 503) — recover by re-triggering via tinker (`Application::find(<id>)` + `queue_application_deployment`). Watchers must tolerate the flip gap (old container gone, new not yet up) — probe after a settle delay, not the instant the queue drains.
- **DB migrations:** `bun run db:push` from root before deploy if you touched `packages/database/src/schema/*.ts` — Coolify does NOT run migrations. Destructive needs `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true`.
- **`@clawville/database` local rebuild:** `cd packages/database && bun run build` for scripts importing the package (Coolify builds from source on deploy).

### Provisioning + emergency

Scripts actually in `scripts/deploy/` (verified 2026-06-16): `clawville-deploy.sh` (prod redeploy wrapper — api+web tinker), `clawville-staging-deploy.sh` (staging redeploy wrapper), `apply-rename-migration.sh`. The day-to-day deploy path is `bash scripts/deploy/clawville-deploy.sh` (see "Deploy paths" above). **NOTE:** the one-time provisioning scripts (`provision-hetzner.sh`, `setup-cloudflare-dns.sh`, `bootstrap-server.sh`, `add-zone-to-cloudflare.sh`) and `.env.deploy` are NOT in the repo — both Hetzner boxes are already provisioned, so those bootstrap scripts are not needed for normal operation. The historical bootstrap walkthrough in `docs/DEPLOY-HETZNER.md` documents what they did.

Emergency SSH: PROD `ssh root@$PROD_VPS_IP` (key in ssh-agent), STAGING `ssh -i ~/.ssh/clawville_deploy root@$STAGING_VPS_IP`. Container restart `docker restart <name>` · logs `docker logs --tail 200 <name>` · Coolify DB `docker exec coolify-db psql -U coolify -d coolify -c "<sql>"` (NOT the ClawVille app DB — that's Supabase) · full playbook `docs/DEPLOY-HETZNER.md`.

**Rollback (prod → staging):** staging box still has the prod containers/DB. Flip Cloudflare A records back to `$STAGING_VPS_IP` (~30s), then add prod FQDNs to staging Coolify apps (`Application::find(3|4)->fqdn = '…,https://clawville.world'` + redeploy).

### Browser verification after every deploy — MANDATORY

(1) Wait for Coolify (~3–5 min) or `curl -sS --ssl-no-revoke https://api.clawville.world/health`. (2) Open `https://clawville.world/game` via Chrome MCP. (3) Check buildings visible + not clipped, camera zoom, player spawn center, FPS > 50, no console errors. (4) If Chrome disconnected, tell user "I cannot verify — please screenshot". (5) NEVER claim a visual fix done without seeing it.

### Mobile + iPad verification — MANDATORY for EVERY UI/UX feature (set 2026-05-28 after iPad joysticks shipped covered 3× in a row)

Any change that adds/moves on-screen UI (HUD, button, panel, modal, joystick, prompt, toast, banner) is NOT done until verified at mobile AND iPad viewports — desktop-only checking is the #1 source of repeat regressions here. Run BEFORE claiming done:

1. **Viewport sweep** via `chrome-devtools` `emulate` `<w>x<h>x2,mobile,touch` at minimum: phone 390×844, iPad mini 744×1133, iPad Air 820×1180, iPad Pro 13 1024×1366 — **portrait AND landscape** (swap w/h + add `,landscape`).
2. **Per size, confirm:** (a) both joystick zones visible + NOT covered by any panel/sidebar/HUD; (b) no two fixed/absolute elements overlapping (gear vs Nori, prompt vs joystick, status-bar vs joystick); (c) the feature's own tap target is reachable (≥44px, not under Safari chrome); (d) any modal it opens fits the viewport and is dismissable.
3. **Touch-aware gating:** mobile/desktop visibility MUST use the canonical `useIsMobile()` hook (`maxTouchPoints > 1` + coarse-pointer), NEVER a bare Tailwind `md:` / `max-width` media query — those miss iPad Air/Pro/landscape (the exact bug that shipped covered joysticks). [[feedback_ipad_detection_maxtouchpoints]]
4. **Safe-area caveat:** devtools has NO `env(safe-area-inset-*)`, so any bottom-anchored element using safe-area math (joysticks, bottom prompts) CANNOT be fully proven in emulation — it needs a real-iPad screenshot from the user. State this explicitly; do not claim the safe-area lift verified from devtools alone.
5. **Interaction, not just layout:** force the feature's live state (walk to a building / open the modal / trigger the toast) — a component that returns `null` until `nearLocation` is set proves nothing rendered. Use click-to-move on the minimap or inject store state.

Skipping this = the change is not done, regardless of green build or desktop screenshot.

### Local + Windows gotchas

**Test locally FIRST:** `bun run build && bun run start` (prod bundle on :3000, Iris-Xe-safe) is the default test path for in-progress work — iterate on `localhost`, NOT staging (staging pushes clog the Coolify build cache; reserve them for sign-off-ready features). NEVER run `bun run dev` — Iris Xe crashes the WebGPU scene → PC restart (HMR only; the prod `start` bundle is fine).
Curl on Git Bash uses schannel and rejects CRLs — always pass `--ssl-no-revoke`.

## Game Modes

4 modes, gated by AUTH STATE. Full model: **`docs/agent-metaverse-model.md`** (ClawVille is an agent–human-economy metaverse, not just a game). State: `controlMode` in Zustand `game.ts` — `'explore' | 'npc' | 'player' | 'autonomous'`.

- **Not logged in** (no account) → **Explore** (floating spectator, free camera, no character ties) ↔ **NPC** (control a demo avatar to feel being a player). Economy is **DEMO** — currency/tokens not real; real-money surfaces (bounties, wallets, real-CT games) are **READ-ONLY** (enforce server-side).
- **Logged in ≡ agent connected** → **Controlled** (`player`; human drives the agent's avatar body + chats with their OWN agent via the bottom chatter bar) ↔ **Autonomous** (the agent drives itself at the user's scope). Economy is **REAL**, bound to the account's avatar.

**account ≡ agent ≡ avatar:** a magic-link agent connect **== account creation**; email signup **PROVISIONS** an agent (default = ClawVille-hosted ElizaOS/Milady-harness). No agent-less account in the target — the old "Player tier" migrates to **"agent-provisioning-pending"** (a migration, not a rename; lands in build phase P2 after provisioning works). Controlled vs Autonomous = human-driving vs agent-driving the SAME body.

**Autonomous is a FULL-SCOPE economic participant** (NOT "explores on its own"): full game scope via the connection SKILL.md, add/use in-world skills, a live **event streamflow** for continuity, run a rented store, act on chat-bar directives OR self-direct, and **PERSIST** when the user leaves (24h TTL; body idle-despawns + respawns; retire the 30-min orchestrator stop for connected agents). Currently BROKEN — audit `docs/agent-autonomy-audit-2026-06-30.md`; the P0 lifecycle-truth fix (`docs/agent-metaverse-p0-lifecycle-design.md`) is the first step.

**NPCs vs agents (do not conflate):** the scripted wander sim (`apps/web/src/stores/autonomy.ts` + `npc-simulation.ts planNpcBehaviors`) is the NPC town-liveliness layer — it **STAYS** for a few ambient wanderers and is **NOT** the agent-Autonomous engine. Most NPCs get **REPLACED** by hosted autonomous agents (internal infrastructure) so the economy flows with ongoing activity.

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
| Deploy — every push to `staging` / `staging → master` promotion (live state + what broke) | `deploy-status.md` |

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

Active gates as of 2026-04-21: `x402_payment_middleware`, `multi_agent_roster`. ~~`skill_marketplace` (bazaar, marketplace, auctions)~~ **— GATE DELETED 2026-07-02: the peer skill-commerce verticals (bazaar / marketplace / auctions / `published_skills`) were fully REMOVED from the codebase (prompt-injection risk — a sold/published skill is an injectable prompt), not un-paused.** See `improvements.md` §7 (if present).

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
