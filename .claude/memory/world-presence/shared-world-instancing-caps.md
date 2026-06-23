---
name: shared-world-instancing-caps
description: "Room caps (20 hard / 12 soft) + NPC-substitution + the single-threaded 200ms tick DoS bound + the Iris-Xe draw-budget ceiling that the hard cap encodes."
category: constraint
confidence: high
date: 2026-06-22
---

---
name: shared-world-instancing-caps
description: Room caps 20 hard / 12 soft + NPC-substitution + single-threaded-tick DoS bound + the Iris-Xe draw-budget ceiling.
category: constraint
confidence: 0.85
date: 2026-06-22
---

# Shared-world caps, the shared tick, and the draw budget

**Room caps (room-registry.ts):** `ROOM_MAX_PLAYERS=20`:66 (HARD — the VRM/draw-call ceiling, never breached by ANY join path incl. recovery), `ROOM_SOFT_CAP_PLAYERS=12`:79 (auto-fill target). The 12-20 band is reserved headroom for invited-friend joins. `pickOrCreateRoom`:596 is flexible-fill (cozy, never lone-spawn). **NPC-substitution:** a joining player swaps OUT an NPC (`swapOutNpcFor`:711), restored after `RESTORE_GRACE_MS` (5s) on leave.

**The hard cap IS the draw budget** — raising it is a 3da Iris-Xe budget pass, not a number bump. The client LOD orchestrator (`FULL_CAP=14`, EntityProxyMesh capsule demotion) backstops it.

**Single-threaded 200ms tick = shared DoS surface.** Every heavy op (A* ~6000 iters, broadcast to all clients) blocks ALL co-present users. Bounds that MUST hold:
- Cap per-reply actions (`MAX_HATCHER_ACTIONS_PER_REPLY=4`, npc-simulation.ts:100) — each move/enter runs A*, each talk broadcasts.
- BOUND every sessionId-keyed Map (purge on leave/GC/evict): world.ts:310 evict purge, :196 tick-subscriber purge, :188 position throttle, :205 join rate limit.
- Drain the collab broker EXACTLY ONCE per tick and share the array (npc-simulation.ts:2730) — a second drain returns [] and starves the other stream (the dead-COLLAB-tab single-drain rule).

**Iris-Xe bans on any sim-driven 3D** (the client consumes getRoomSnapshot): NO drei <Text>/<Billboard>, NO InstancedMesh+ShaderMaterial, NO per-frame new Vector3(). A new broadcast field driving a per-entity mesh is a budget change -> spawn 3da.

**Deployment:** caps + swap present; broader authoritative-shared-server vision is PARTIAL (multiplayer-phase1 — flag gaps to `.claude/plans/multiplayer-phase1.md`, do not claim full parity). OPEN (partial). Related: `[[room-registry-state-machine]]` `[[npc-entity-interpolation-contract]]`.
