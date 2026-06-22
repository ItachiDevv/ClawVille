---
name: avatar-simulation-bridge-dormant
description: "CORRECTION: avatar-simulation-bridge is NOT dormant — it is wired (routes/avatars.ts heartbeat) and credits REAL CT via claw-token-ledger on idle-avatar building visits; treat any change as money-adjacent."
category: gotcha
confidence: high
date: 2026-06-22
---

---
name: avatar-simulation-bridge-dormant
description: CORRECTION — avatar-simulation-bridge is LIVE + ledger-touching in this worktree, NOT dormant scaffolding; deleting it breaks human idle-avatar autonomy + a real CT credit path.
category: gotcha
confidence: 0.85
date: 2026-06-22
---

# avatar-simulation-bridge is LIVE, not dormant (correction)

**The stale claim:** the project MEMORY index says 'AvatarSimulationBridge is DORMANT scaffolding' (connection-lifecycle topic). In worktree `cv-agents-wave23` this is **FALSE** — verified by grep + read.

**Evidence it is wired + load-bearing:**
- `npc-simulation.ts:346` instantiates `avatarAutonomyManager = new AvatarSimulationBridge()` and surfaces `getAutonomousAvatars()` in every snapshot (:559/:620).
- `routes/avatars.ts:1035-1060` heartbeat resolves `npcSimulation.avatarAutonomyManager` and calls `bridge.register({...})` + `bridge.reportUserActivity(user.id, x, y)`.
- `avatar-simulation-bridge.ts:158` `tick()` credits **REAL CT** via `creditClawTokens({ reason:'autonomous_visit', source:'simulation' })`:72-79 on building arrival. So it TOUCHES the `claw-token-ledger`.

**Implication:** any change to the bridge is **money-ADJACENT** — loop in the `token-economy` owner + an adversarial pass. NEVER write `avatars.clawTokens` directly. Do NOT delete it as 'dead scaffolding' or cite the stale dormant claim. NOTE: the register caller (`routes/avatars.ts`) is an auth/leaderboard-owned file = a CONSUMER seam, not world-presence-owned — coordinate cross-domain on heartbeat/register-contract changes.

**Deployment:** LIVE on prod + staging (heartbeat path). OPEN correction for the cross-project memory. Related: `[[map-locations-ssot]]`.
