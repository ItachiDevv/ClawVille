# `.claude/workflows/` — common-operation runbooks

Each file in this directory is a step-by-step recipe for one common operation
in the ClawVille codebase. They exist so that:

1. **Humans** can hand a contributor / open-source PR a single link and they
   know what to do.
2. **Sub-agents** (`3da`, `blender07`, etc.) and **Codex audits** can read the
   matching runbook before acting, so they don't miss the doc updates that
   the `CLAUDE.md` "Same-diff doc updates" rule requires.

Every runbook ends with a "**Doc updates required**" checklist of the four
canonical docs (`WorldContent.md` / `3dStructure.md` / `GameFeatures.md` /
`ARCHITECTURE.md`) that must be staged in the same commit. Follow it.

## Inventory

| Runbook | When to use |
|---|---|
| [`ship-a-feature.md`](./ship-a-feature.md) | The end-to-end loop for any change. Read this first if you've never shipped to ClawVille. |
| [`add-a-building.md`](./add-a-building.md) | Adding a new building to the 10-slot ring (or swapping a GLB on an existing slot). |
| [`add-an-npc.md`](./add-an-npc.md) | Adding a new wandering NPC, building resident, or system agent. |
| [`add-a-route.md`](./add-a-route.md) | Adding a new Hono route under `apps/api/src/routes/`. |
| [`add-a-service.md`](./add-a-service.md) | Adding a new service under `apps/api/src/services/`. |
| [`add-a-gameplay-feature.md`](./add-a-gameplay-feature.md) | Adding a player-facing feature (UI, mode, mini-game, economy change). |

## When to add a new runbook here

If you find yourself walking the same multi-doc update sequence twice, write
a runbook for it. Keep them short (under 100 lines). Each one should:

- Name the trigger ("adding X")
- List preconditions
- Walk the code steps in order
- End with a checklist of doc updates required, by doc + section
