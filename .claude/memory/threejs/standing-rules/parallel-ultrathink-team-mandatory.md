---
name: Parallel ultrathink team mandatory for 3D / Blender / long tasks
description: Solo agents are forbidden for 3D, Blender, or any task >5min/300LOC/3files. Always decompose into file-scoped slices and spawn parallel ultrathink agents. Orchestrator handles wiring + ship loop.
type: feedback
---

# Rule

Solo agents are forbidden for any of:

- 3D work (Three.js / R3F / shaders / GLB / post-proc / materials / cameras / TSL / WGSL / WebGPU)
- Blender pipelines (multi-asset exports, mesh edits, rigging)
- Any task estimated > 5 min agent runtime, > 300 LOC, or touching ≥ 3 files in different subsystems
- Anything the user described as "polish", "iterate", "rework", or "make it feel like X"

## Why

Solo agent on a 4-task brief = 12+ min sequential, mid-stream failures block everything. Four parallel file-scoped agents = max(individual runtime), independent failure modes. Documented 2026-04-29 after a session burned 30+ min on a serial 4-task brief and forced a kill-and-respawn.

## How to apply

1. **Decompose first** — break into N independent file-scoped or concern-scoped slices BEFORE spawning anything.
2. **One file per agent** — NO two agents may edit the same file. Use NEW files (`terrain-shader.tsx`, `racing-karts.tsx`, etc.) and have the orchestrator do final wire-up of imports + JSX.
3. **All N spawned in parallel** in a SINGLE message with multiple `Agent` tool uses (run_in_background where it fits the workflow).
4. **Every agent prompt** must contain the literal phrase **"use ultrathink reasoning before writing code"** in its first paragraph. The Agent tool has no thinking-mode flag — prompt text is the only channel.
5. **Orchestrator owns** planning, decomposition, cross-file wiring, build, push, deploy, browser verify (Playwright `mcp__playwright__*` or firecrawl hosted screenshot). Never delegate any step of the ship loop.

## Trigger checklist

- Task description mentions "polish" / "iterate" / "rework" / "make it feel like X" → team
- Estimated agent runtime > 5 min → team
- > 300 LOC across files → team
- ≥ 3 files in different subsystems → team
- 3D code under `apps/web/src/lib/three/**` / `apps/web/src/components/three/**` / `apps/web/public/models/**` → team (3da)
- Blender pipelines → team (blender07)

## Failure mode prevented

The 2026-04-29 session brief had 4 fixes (water foam edge / terrain shader / 1.4× corridor / animated karts). All four were independent (different files: river-scene.tsx water section / river-scene.tsx terrain section / track-layout.ts / NEW racing-karts.tsx). Spawned solo 3da → ate 30+ min mid-flight. Killed + re-decomposed into 3 parallel ultrathink agents on file-scoped slices → finished in ~max(individual runtime). Prefer the latter from the start.

## Non-team tasks (still allowed)

- Single-file < 300 LOC fix (small API route, one DB column, one React modal, env var)
- Single-file shader tweak < 50 LOC where overlap risk is zero

The bar: "would this realistically take a single agent > 5 min OR fan out across files?" If yes → team. If no → solo or inline.

## Source

Project CLAUDE.md `## MANDATORY: 3D / Blender / long tasks run as PARALLEL ULTRATHINK TEAMS`. Memory is advisory; CLAUDE.md is canonical. If they diverge, CLAUDE.md wins.
