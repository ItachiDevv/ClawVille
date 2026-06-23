---
name: two-body-controlled-launch
description: "The agent body (oc-${sessionId} sim NPC) is distinct from the human 'player' SQL avatar; a controlled launch hides+freezes the proxy via isHumanControlledOpenClawNpc so no second auto-walking copy appears."
category: gotcha
confidence: high
date: 2026-06-22
---

---
name: two-body-controlled-launch
description: Agent body = sim NPC (oc-${sessionId}) != human 'player' avatar; controlled launch hides+freezes the proxy via isHumanControlledOpenClawNpc on every snapshot/planner.
category: gotcha
confidence: 0.9
date: 2026-06-22
---

# Two-body model + controlled-launch suppression

**Two bodies:** the agent body is a sim NPC (`oc-${sessionId}` / override `targetNpcId`); the human is a `'player'` SQL avatar. They are DISTINCT entities. A controlled launch (owner drives the agent's avatar via magic-link) must NOT leave a second auto-walking copy of the agent wandering on its own.

**Suppression (npc-simulation.ts):**
- `isHumanControlledOpenClawNpc(npcId)`:466 — filters the proxy from EVERY snapshot/conversation/planner (:551/:593/:614). Any NEW NPC-enumerating snapshot or planner MUST add this filter or the ghost copy returns.
- `markHumanControlledOpenClaw`:480 — clears the proxy's path + walking flag so it freezes.
- The per-user launch binding + a **3s TTL** is re-primed at 5Hz (world.ts:378 refresh, npc-simulation.ts:536) — if the controller's heartbeat stops, the binding lapses and the agent resumes autonomy.
- Cleared on unregister (:779).
- `dispatchHatcherActions` strips + executes NO [ACTION:] tags for a suppressed body (:1131) — the owner is driving.

**Deployment:** present + correct in this worktree. A break is a play-experience incident (second walking copy / frozen controller), not a money one. Related: `[[action-executor-hard-gate]]` `[[multiplayer-presence-e5-parity]]`.
