# Contributing to ClawVille

Thanks for your interest. ClawVille is a 3D agent-development sandbox built on ElizaOS. We welcome PRs for bug fixes, performance improvements, new buildings/agents, additional skill books, and integration with new agent frameworks.

## Before you start

Read `CLAUDE.md` first. It documents the load-bearing project invariants and conventions. The four canonical docs:

- **`WorldContent.md`** — *what* renders in the open-world scene (manifest of buildings, NPCs, terrain, decorations, props).
- **`3dStructure.md`** — *how* the 3D scene is wired (coordinates, camera, lighting, GPU budget, animation, asset pipeline).
- **`GameFeatures.md`** — gameplay surfaces (modes, agent connect, economy, quests, UI, portals, activities).
- **`ARCHITECTURE.md`** — backend tech (routes, middleware, services, schema, events, deploy).

### The bidirectional sync rule

**If your change touches any code path tabulated in `CLAUDE.md` "Path → doc decision matrix", you must stage the matching doc update in the same commit.** Reverse holds: changing a manifest doc requires the corresponding code change. Mismatch is a bug.

This is enforced at the contributor/review level — there's no pre-commit hook or CI gate by design. Every contributor and reviewer is responsible.

### Workflow runbooks

For common operations, follow the runbook in `.claude/workflows/` — each one lists every doc update required:

- `.claude/workflows/add-a-building.md`
- `.claude/workflows/add-an-npc.md`
- `.claude/workflows/add-a-route.md`
- `.claude/workflows/add-a-service.md`
- `.claude/workflows/add-a-gameplay-feature.md`
- `.claude/workflows/ship-a-feature.md` (end-to-end: code → docs → typecheck → commit → push → Coolify → browser verify)

## Setup

```bash
bun install
cp .env.example .env.local   # fill in DATABASE_URL, OPENAI_API_KEY, etc.
bun run db:push
bun run db:seed
bun run dev
```

Web at `http://localhost:3000`, API at `http://localhost:4000`.

> **GPU note:** the WebGPU scene crashes Intel Iris Xe GPUs hard enough to require a PC restart. If you have an Iris Xe machine, do not run `bun run dev` locally — push to a branch and test against the deployed staging URL, or use a different machine for visual work.

## Branching + PRs

- Fork the repo, create a feature branch off `master`.
- One logical change per PR. Smaller diffs land faster.
- The PR description should reference any updated docs (`WorldContent.md`, `3dStructure.md`, `GameFeatures.md`, `ARCHITECTURE.md`, `CLAUDE.md`).
- CI runs build + type checks. Make sure `bun run build` is green locally before opening the PR.
- Coolify auto-deploys on merge to `master`. Until then, your branch only deploys if you manually trigger it.

## Commit messages

Conventional-commit-ish, scope-prefixed:

```
fix(reef-race): smooth drift steering and recovery
feat(buildings): add Krusty Krab knowledge book "MCP server primer"
perf(vrm): throttle spring-bone physics for idle NPCs
docs(architecture): document phase 5.1 wallet identity flow
```

## What's in scope for contributions

**Welcome:**
- New knowledge books (one PR per book; new content goes in `packages/agent-templates/src/locations/<slug>.ts`)
- New decorative geometry, shaders, performance improvements
- Bug fixes anywhere in the codebase
- New agent-framework integrations on top of `/api/agent/connect`
- Additional gameplay activities (mini-games beyond Reef Race) — discuss in an issue first
- Documentation improvements
- Test coverage

**Not in scope (yet):**
- Replacing the LLM backend — OpenAI is the only supported provider. Adding a second is a discussion, not a PR.
- Replacing ElizaOS — the runtime is load-bearing. See "ElizaOS is MANDATORY" in `CLAUDE.md`.
- Changes to the Milady plugin (`@clawville/app-clawville` on npm) — that lives in a separate repo.

**Discuss first:**
- Anything that changes the agent-onboarding contract (`POST /api/agent/connect`).
- Anything that changes the ClawToken economy formulas.
- Anything that adds a new top-level package or app.

## Working with `.claude/`

The `.claude/` directory contains AI-collaboration assets:

- `agents/3da.md` — Three.js / WebGPU subagent definition.
- `memory/threejs/` — ~90 markdown files documenting hard-won Three.js gotchas, patterns, and performance findings.
- `plans/` — historical implementation plans for major features.

If you use Claude Code, these activate automatically. If you don't, they double as developer documentation. **Per-user files (`settings.local.json`, `worktrees/`, `reports/`) are gitignored** — don't commit them.

When you fix a non-obvious 3D bug or land a notable pattern, consider adding a memory entry to `.claude/memory/threejs/{gotchas,patterns,solutions,performance}/` so the next contributor doesn't repeat the work. Format is documented in `.claude/agents/3da.md`.

## Testing

- Unit tests: `bun test` (Bun-native test runner).
- Type checks: `bun run build` (turbo runs all package builds, which includes typecheck).
- Browser smoke test for 3D / gameplay changes: deploy to a branch, open the staging URL, drive the affected feature in your real browser. There's no headless visual test rig.

## Code style

- TypeScript strict mode is non-negotiable.
- Kebab-case filenames, PascalCase React components.
- Zod on every API input boundary.
- `@/` path alias inside `apps/web`; `@clawville/*` for cross-package imports.
- Comments are sparingly used — only for the *why* of non-obvious code, never the *what*.

## Reporting bugs

Open an issue with:

1. What you did.
2. What you expected.
3. What happened.
4. Browser + GPU (matters more than you'd think — Iris Xe vs discrete is a real fork in this project).

For 3D / visual bugs, a screenshot + the value of `navigator.gpu` and `navigator.userAgent` is enormously helpful.

## Questions

Open an issue, label it `question`. Discord and Telegram channels exist for current contributors but are not the primary support surface — issues are.

Thanks for contributing.

## Agent team operating rules (moved verbatim from CLAUDE.md 2026-09-07)

> The mandate itself (which work runs as a collaborative agent team, and the dispatch shape) stays in `CLAUDE.md`. These are the compositions, coordination protocol, required prompt elements, skip rules, and 3da/Blender context.

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
