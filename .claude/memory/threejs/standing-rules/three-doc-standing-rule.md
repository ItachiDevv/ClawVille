# Three-Doc Standing Rule (3D Scope)

**Status:** Set 2026-04-17 by the main session after re-syncing all three canonical docs to live code.

## The rule

The three root-level markdown files in the ClawVille repo are the authoritative specification. For 3D work specifically:

- **`3dStructure.md`** — the spec for world dimensions, building ring geometry, NPC scales + positions + rotations, decorations, seaweed density zones, terrain, camera, lighting, fog, atmosphere, and the performance/GPU budget.
- **`GameFeatures.md`** — cross-referenced when a 3D change affects gameplay (e.g. talk-to-character radius, building proximity, player-pet scale visible in UI).
- **`ARCHITECTURE.md`** — cross-referenced when a 3D change involves new asset pipelines, new schema (e.g. `building_skills`), or service-level wiring.

**Unless the main session explicitly asks for a behavior change, do what `3dStructure.md` specifies.** Do not refactor building positions, NPC scales, fog ranges, or camera constants without consent. Do not invent new conventions when a documented one exists.

## Same-diff update requirement

Every 3D code change you ship must be accompanied by a `3dStructure.md` edit in the **same commit**. The accepted pattern is:

1. Identify the claim in `3dStructure.md` that your change invalidates.
2. Update the doc to match the new reality (constants, scales, rotations, fog args, component names, etc.).
3. Bump the top "Last Audited" date with a one-line note describing the drift you closed.
4. Ship both files together.

No "I'll update the docs later." No "it's a small change." The main session's anti-bypass rule treats doc drift as a ship-blocker equal to the 3da spawn rule.

## Precedence when something disagrees

1. **Live source code** wins (grep/read to confirm).
2. **`3dStructure.md` / `GameFeatures.md` / `ARCHITECTURE.md`** win over CLAUDE.md.
3. **CLAUDE.md** wins over memory.
4. **Memory files** (this directory + `~/.claude/projects/.../memory/`) are **advisory only** — never authoritative.

If a memory entry here contradicts `3dStructure.md`, update or delete the memory in the same turn you spot the conflict. If `3dStructure.md` contradicts live code, update the doc in the same turn.

## Why

Prior sessions have invented constants (PET_SCALE, fog args, NPC sizes) that already had documented values. Result: visual regressions + hours wasted re-auditing the scene to recover the known-good state. This rule prevents that by anchoring every 3D decision to a document the whole team agrees on.
