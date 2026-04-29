---
name: Collaborative ultrathink team mandatory for 3D / Blender / long tasks
description: A "team" is multiple agents working SEQUENTIALLY on the SAME concern (Implementer → Auditor → Fix loop), not N agents working on N different concerns in parallel. The audit step is the point.
type: feedback
---

# Rule

Solo agents are forbidden for any of:

- 3D work (Three.js / R3F / shaders / GLB / post-proc / materials / cameras / TSL / WGSL / WebGPU)
- Blender pipelines (multi-asset exports, mesh edits, rigging)
- Any task estimated > 5 min agent runtime, > 300 LOC, or touching ≥ 3 files in different subsystems
- Anything the user described as "polish", "iterate", "rework", "make it feel like X", or with quality verbs ("elite", "high standards", "professional")

## What "team" means (corrected 2026-04-29 — earlier rule was wrong)

A team is **multiple agents working SEQUENTIALLY on the SAME concern**. Each agent uses ultrathink. The team produces ONE output per concern by stacking perspectives.

**Wrong pattern (parallelization, not collaboration):** spawn 4 agents in parallel where each agent does a different file's work alone. No audit. No second perspective. Each agent works in isolation. This is what I did the first time and the user explicitly corrected.

**Right pattern (collaboration):**

For each concern (a coherent file or scoped change):

1. **Implementer agent** (ultrathink) — drafts the code; reports diff + key decisions
2. **Auditor agent** (ultrathink) — reviews against requirements + Iris Xe gotchas + memory + the user's quality bar; returns APPROVED or BLOCKING ISSUES
3. If BLOCKING ISSUES: Fixer agent (or implementer via SendMessage) applies feedback; re-audit; loop until APPROVED
4. Orchestrator commits the approved concern

Optional third role for high-stakes work: **Reconciler / Critic** — independently re-implements the same concern from scratch, then compares both implementations and recommends one.

## Concerns: sequential or parallel across?

- Independent concerns (different files, no shared state) → each concern's team can run in parallel with other concern-teams
- Concerns that share state or build on each other → sequence them
- Default to sequential when in doubt — the audit step is what we're paying for, not throughput

## Trigger checklist

- 3D code under `apps/web/src/lib/three/**` / `apps/web/src/components/three/**` / `apps/web/public/models/**` → team
- Blender pipelines → team
- Task description mentions "polish" / "iterate" / "rework" / "make it feel like X" / "elite" / "high standards" → team
- Estimated agent runtime > 5 min → team
- > 300 LOC across files → team
- ≥ 3 files in different subsystems → team

## Every agent prompt MUST include

The literal phrase **"use ultrathink reasoning before writing code"** (or "before reviewing code" for auditors) in its first paragraph. Agent tool has no thinking-mode flag — prompt text is the only channel.

## Orchestrator responsibilities (never delegated)

- Decompose into concerns
- Run per-concern Implementer → Auditor → Fix → Re-audit loop
- Wire across concerns after each is approved
- Build / push / manual Coolify deploy / browser-verify (Playwright or firecrawl hosted screenshot when Iris Xe can't render)

## Failure modes prevented

- Solo-agent-per-file → no audit → bugs ship that the agent didn't see
- Parallel-split misread as "team" → no collaboration, just throughput → same as solo from a quality standpoint, just faster
- The Implementer-Auditor loop catches: forgotten constraints, missed Iris Xe gotchas, incorrect uniform naming, off-by-one in geometry, wrong sign convention, etc.

## Single-file ≤ 300 LOC tasks

Trivial work may skip teams. Bar: "would the cost of getting this wrong justify a second agent's review?" If yes → team. If no → solo.

## Source

Project CLAUDE.md `## MANDATORY: 3D / Blender / long tasks run as COLLABORATIVE ULTRATHINK TEAMS`. Memory is advisory; CLAUDE.md is canonical. If they diverge, CLAUDE.md wins.
