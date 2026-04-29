# Contributing to ClawVille

Thanks for your interest. ClawVille is a 3D agent-development sandbox built on ElizaOS. We welcome PRs for bug fixes, performance improvements, new buildings/agents, additional skill books, and integration with new agent frameworks.

## Before you start

Read `CLAUDE.md` first. It documents the load-bearing project invariants and conventions. The sister docs are:

- `3dStructure.md` — 3D world layout (canonical for visuals).
- `GameFeatures.md` — gameplay surface (canonical for features).
- `ARCHITECTURE.md` — tech stack, routes, DB tables, deployment.

If your change touches any of these surfaces, you must update the matching doc in the same PR.

## Setup

```bash
bun install
cp .env.example .env.local   # fill in DATABASE_URL, GEMINI_API_KEY, etc.
bun run db:push
bun run db:seed
bun run dev
```

Web at `http://localhost:3000`, API at `http://localhost:4000`.

> **GPU note:** the WebGPU scene crashes Intel Iris Xe GPUs hard enough to require a PC restart. If you have an Iris Xe machine, do not run `bun run dev` locally — push to a branch and test against the deployed staging URL, or use a different machine for visual work.

## Branching + PRs

- Fork the repo, create a feature branch off `master`.
- One logical change per PR. Smaller diffs land faster.
- The PR description should reference any updated docs (CLAUDE.md, 3dStructure.md, GameFeatures.md, ARCHITECTURE.md).
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
- Replacing the LLM backend — Gemini is the only supported provider. Adding a second is a discussion, not a PR.
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
