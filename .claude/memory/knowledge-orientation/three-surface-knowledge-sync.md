---
name: three-surface-knowledge-sync
description: "every gameplay change propagates to Nori knowledge[] + connection SKILL.md + hosted-runtime same-diff or onboarding silently breaks"
category: pattern
confidence: high
date: 2026-06-22
---

---
name: three-surface-knowledge-sync
description: The keystone same-diff rule — every gameplay/world change updates all 3 operational-knowledge surfaces or onboarding silently breaks.
category: pattern
confidence: 0.95
date: 2026-06-22
---

# Three-surface knowledge sync (the keystone forcing-function rule)

ClawVille's competitive premise: agents with an up-to-date manual play the RIGHT game. Any gameplay/world change (mode, building, currency, quest, casino/arcade game, table rule, connect/disconnect/timer behavior, leaderboard weight, paused feature) MUST update **all three** operational-knowledge surfaces in the SAME DIFF or the PR is not mergeable (CLAUDE.md mechanical rule):

1. **Nori `knowledge[]`** — `packages/agent-templates/src/locations/town-guide.ts`, via the SSOT constant `CLAWVILLE_ORIENTATION_KNOWLEDGE` (see [[orientation-single-source]]).
2. **Connection SKILL.md / protocol manual** — `apps/api/src/services/skill-protocol.ts buildProtocolManual`; bump `PROTOCOL_VERSION` on a WIRE change (see [[protocol-version-consumed-seam]]).
3. **Hosted-runtime protocol-knowledge** — `createMemory()` injection (`subtype:'protocol-knowledge'`) into each hosted ElizaOS runtime, then `stopAgent()` so next chat reloads.

## The silent failure mode

There is NO crash, NO 500. A one-surface edit just means connected/hosted agents play a different game than humans/hosted players — broken fairness + measurability. This is the #1 defect this domain exists to prevent.

## Phase-0 gate

Enumerate WHICH of the three surfaces the change touches, then grep each for the new fact before 'done'. Orientation → Nori; domain CRAFT skill → the 10 residents; never cross (see [[point-at-the-teacher]] in MEMORY invariant 3).

## Status: rule LIVE. Endpoint infra FIXED

The stale memory 'the global connection SKILL.md endpoint does not exist' is NO LONGER TRUE: `GET /api/skills/protocol/skill.md` + `GET /api/skills/manifest.json` exist (skills.ts) and serve the manual + content-hash poll target. The eager-on-connect / hosted-runtime injection is the remaining best-effort/TODO piece.

## Evidence

- `town-guide.ts` is dense with inline 'same-diff knowledge sync' notes per feature (cove games, poker MTT, land, Hatcher, Reef Race).
- `orientation-skill.ts` header: 'Any gameplay change that would update Nori's knowledge MUST update this constant instead.'
- CLAUDE.md 'Game-flow changes propagate to all three operational-knowledge surfaces in the same diff.'

Related: [[orientation-single-source]] · [[protocol-version-consumed-seam]] · [[system-npc-seeder]]
