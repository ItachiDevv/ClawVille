---
name: npc-entity-interpolation-contract
description: "NPC motion is entity-interpolation only — server 5Hz/220wu/s, client renders 1 tick behind; never raise the tick to fix perceived slowness (the real cause is the client interp stalling)."
category: gotcha
confidence: high
date: 2026-06-22
---

---
name: npc-entity-interpolation-contract
description: NPC locomotion is entity-interpolation only; server 5Hz/220wu/s, never raise the tick to fix 'slow/sliding' — fix the client interp.
category: gotcha
confidence: 0.9
date: 2026-06-22
---

# NPC locomotion = entity-interpolation ONLY

**Contract (3dStructure.md §6z:629-635):** the server emits position + heading at **5Hz** (`moveNpcs` baseStep=44 = 220wu/s = `REF_WALK_SPEED`, `npc-simulation.ts:1984`). The client renders **1 tick behind** via `renderX = prevX + (x-prevX)*alpha` (`stores/npc.ts` + `players.ts`). NEVER extrapolate / dead-reckon / exp-lerp.

**The trap:** a 'NPCs look slow / sliding / stepping / jittery' report tempts a server-side fix (raise baseStep / the tick rate). A 550wu/s raise WAS tried and reverted — big ticks glitch the interp. The 2026-06-10 all-nighter proved the perceived mismatch was the CLIENT interp stalling (an immutable-update memo bug in `players.ts`), not the server constants.

**Fix the CLIENT interp** (3da territory, Rule E3 Claude<->Codex 3D collaboration); keep the 5Hz server contract + the in-bounds clamp. Sentinel `ts===0` = demo/possessed NPC renders raw (no interp). Restored/seeded positions are clamped in-bounds via `resolveSafeSpawn` / the world.ts:167 out-of-bounds guard.

**Deployment:** present + correct in this worktree (comments at npc-simulation.ts:1984 warn 'fix the client interp instead'). INVARIANT. Related: `[[server-authoritative-client-interp]]` `[[shared-world-instancing-caps]]`.
