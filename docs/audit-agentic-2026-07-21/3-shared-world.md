# Audit — Shared World Presence / Multiplayer (founder concern #3)

**Date:** 2026-07-21
**Checkout:** `C:/Users/itachi/Documents/Crypto/cv-audit`, detached at prod HEAD `ac12da229934365ffa545aedbce5165dd824093a`
**Method:** Read-only Codex CLI audit (`codex exec --sandbox read-only`) cross-checked against an independent manual read of the same files by the wrapper agent. All claims below carry file:line citations from the live checkout.

**Founder question audited:** "I haven't seen other agents in game, although I know they've been playing. Are all agents sharing one world? If I'm playing with my agent and my friend is at their house playing with their agent, can I see them in game?"

---

## (A) DEFINITIVE VERDICT

**PARTIALLY.**

The multiplayer path is genuinely wired into `/game`; it is **not** inert scaffolding:

- `/game` calls `useWorldStream`, joins a server room, opens that room's SSE stream, and uploads the local avatar's position at 5 Hz. [page.tsx:471](../../apps/web/src/app/game/page.tsx#L471) [use-world-stream.ts:302](../../apps/web/src/hooks/use-world-stream.ts#L302) [use-world-stream.ts:339](../../apps/web/src/hooks/use-world-stream.ts#L339)
- Received `players` snapshots are stored separately from NPCs and rendered as actual remote VRM/GLB avatars. [use-world-stream.ts:377](../../apps/web/src/hooks/use-world-stream.ts#L377) [stores/players.ts:132](../../apps/web/src/stores/players.ts#L132) [remote-players.tsx:115](../../apps/web/src/lib/three/remote-players.tsx#L115) [World3DCanvas.tsx:1963](../../apps/web/src/components/three/World3DCanvas.tsx#L1963)

Two independent users **can** see one another when they are in the same room.

Without `?room=`, sessions do **not** get private solo rooms — the registry auto-fills the fullest existing room below a 12-player soft threshold, only minting a new room when none qualifies. [room-registry.ts:637](../../apps/api/src/services/room-registry.ts#L637) [room-registry.ts:649](../../apps/api/src/services/room-registry.ts#L649)

That makes default co-location **common but not guaranteed**:
- A friend entering after the founder's room reaches 12 goes to a different room.
- If several rooms sit below 12, the friend joins whichever is fullest — not necessarily the founder's.
- The deterministic path is the shared Invite link: the live sidebar exposes the 4-char room code and copies `/game?room=CODE` to the clipboard. [sidebar-menu.tsx:323](../../apps/web/src/components/game/sidebar-menu.tsx#L323) [sidebar-menu.tsx:329](../../apps/web/src/components/game/sidebar-menu.tsx#L329) [sidebar-menu.tsx:360](../../apps/web/src/components/game/sidebar-menu.tsx#L360)

The larger claim — "all humans and agents share one authoritative world" — is **false** in the shipped architecture:
- Browser-controlled human/guest/agent-session players are strictly room-scoped. [npc-simulation.ts:928](../../apps/api/src/services/npc-simulation.ts#L928)
- Hosted autonomous agent bodies are copied into **every** room's snapshot rather than assigned to one room. [npc-simulation.ts:901](../../apps/api/src/services/npc-simulation.ts#L901) [npc-simulation.ts:1045](../../apps/api/src/services/npc-simulation.ts#L1045)
- Room state lives in one process's memory, not a shared backing service — multiple API processes would create separate presence universes. [room-registry.ts:226](../../apps/api/src/services/room-registry.ts#L226) [room-registry.ts:749](../../apps/api/src/services/room-registry.ts#L749)

**Answer to the founder:** you can see your friend and their browser avatar if you occupy the same room — use the live Invite link to guarantee that. Hosted autonomous agents are **not** coherently roomed with their owners: their bodies are broadcast globally into every room, so you should be seeing agent bodies wandering regardless of which room you land in. This is a hybrid room system, not one shared authoritative world.

---

## (B) WHAT IS ACTUALLY SHARED TODAY

### World API and auth
`/api/world` mounts with optional session middleware. [index.ts:314](../../apps/api/src/index.ts#L314) [world.ts:59](../../apps/api/src/routes/world.ts#L59) Surface: `POST /join`, `POST /leave`, `POST /position`, `POST /autonomy` + `GET /autonomy/status`, `GET /:roomId/stream`, admin `GET /rooms`. Identity precedence: Lucia human session → `X-Clawville-Agent-Session` → fingerprinted guest; an invalid agent-session header falls through to guest rather than failing closed. [world.ts:147-171](../../apps/api/src/routes/world.ts#L147)

### Room allocation
- Hard cap: **20** players in an explicitly-requested/invited room. [room-registry.ts:66](../../apps/api/src/services/room-registry.ts#L66)
- Soft auto-fill threshold: **12**. [room-registry.ts:79](../../apps/api/src/services/room-registry.ts#L79)
- Guests can join an existing invite code but cannot mint an unknown one (anti ID-space-pinning); authenticated callers can. [room-registry.ts:625](../../apps/api/src/services/room-registry.ts#L625)
- Players expire after 30s with no position update; empty rooms GC after 5 min. [room-registry.ts:82-83](../../apps/api/src/services/room-registry.ts#L82)

### Broadcast entity types

| Entity | What clients receive |
|---|---|
| Other human/guest/agent-session browser players | Room-scoped `PlayerSnapshot[]` from `RoomRegistry`, over `/api/world/:roomId/stream`, rendered as real remote VRM/GLB avatars. [room-registry.ts:280](../../apps/api/src/services/room-registry.ts#L280) [remote-players.tsx:157](../../apps/web/src/lib/three/remote-players.tsx#L157) |
| Scripted free-roaming NPCs | Only the IDs assigned to that room; one is swapped out per joining player, restored after they leave. [npc-simulation.ts:901](../../apps/api/src/services/npc-simulation.ts#L901) |
| Building-resident NPCs | Always present in every room (never swap-eligible). [npc-simulation.ts:910](../../apps/api/src/services/npc-simulation.ts#L910) |
| Hosted autonomous avatar-mode agents (`ocb-*`) | Registered as dynamic NPCs in the **shared global** simulation map, moved by the global tick, included in **every** room because their IDs fall outside the static free-roamer set that room-filtering checks. [npc-simulation.ts:1045-1055](../../apps/api/src/services/npc-simulation.ts#L1045) [npc-simulation.ts:901-919](../../apps/api/src/services/npc-simulation.ts#L901) |
| Idle autonomous bodies from `avatar-simulation-bridge` | One global map, appended to every room's snapshot with no room filtering. [avatar-simulation-bridge.ts:145](../../apps/api/src/services/avatar-simulation-bridge.ts#L145) |

`/api/npc/stream` (legacy) is still live — no room ID, no membership check, global-only snapshot, no player list — but the live `/game` route does **not** use it (it uses `useWorldStream`); `/perf` and `/arena` still do. [npc-sse.ts:8-18](../../apps/api/src/routes/npc-sse.ts#L8) [perf/page.tsx:3](../../apps/web/src/app/perf/page.tsx#L3)

### Bug found — autonomous-mode double-body
When a browser switches to Autonomous mode: the local `PlayerAvatar` unmounts and the `ocb-*` agent body renders instead; the position uploader keeps running (it only pauses for `explore` mode, not autonomous); and the room snapshot keeps emitting **both** the stale room-player record and the global `ocb-*` body. A peer in the same room therefore sees **two bodies for one owner** — the owner's own client hides this from itself only because it locally filters its own player ID. [World3DCanvas.tsx:2072](../../apps/web/src/components/three/World3DCanvas.tsx#L2072) [use-world-stream.ts:305](../../apps/web/src/hooks/use-world-stream.ts#L305) [stores/players.ts:94](../../apps/web/src/stores/players.ts#L94)

### Bug found — NPC restore-at-home is incomplete
Five seconds after a player leaves, the swapped-out NPC ID is re-added to the room roster, but its actual simulated position is never reset to home — it reappears wherever the global sim last left it, not where the plan specified. [room-registry.ts:540](../../apps/api/src/services/room-registry.ts#L540) [npc-simulation.ts:2785](../../apps/api/src/services/npc-simulation.ts#L2785)

### Regression found — the LOD/proxy safety net was deleted
The original Phase 1 plan called for a distance-LOD proxy (cheap capsule stand-in) for the 15th+ closest entity so full-VRM count never exceeds the Iris Xe budget regardless of room population. `3dStructure.md` itself records that the LOD orchestrator, LOD store, and remote-player proxy were since **deleted**, while real full-model remote rendering was kept. Every remote player renders as a full VRM/GLB today, uncapped. [remote-players.tsx:90](../../apps/web/src/lib/three/remote-players.tsx#L90) [3dStructure.md:1192](../../3dStructure.md#L1192)

---

## (C) MINIMAL ARCHITECTURE DELTA (not implemented — naming the fix, not writing it)

1. **Deterministic friend co-location.** Keep the Invite UI, but stop relying on "fullest room under 12" as the only path — add a persistent/social room choice that survives reload, in `RoomRegistry.pickOrCreateRoom` / `joinPlayer` and the join state in `useWorldStream`.
2. **Assign hosted agents to rooms.** Give `registerAgentBot` and `avatarSimulationBridge` a room identity (default: follow the owning human's room), and filter `ocb-*` bodies in `getRoomSnapshot` by that room instead of copying every hosted body into every room.
3. **Fix the autonomous-mode double-body.** On autonomy takeover, either suppress the stale room-player record or unify it with the `ocb-*` body as one authoritative entity — touchpoints: the autonomy transition, `RoomRegistry.getPlayerSnapshots`, the client uploader's mode gate.
4. **Give agents the same room-local perception humans get.** Agent perception (Hatcher world state, `buildHatcherWorldState`) is built from global simulation NPCs / "browser claws," not room-scoped `PlayerSnapshot`s — feed it the same-room human+agent view and drop cross-room hosted bodies from what an agent "sees."
5. **Move room state out of single-process memory before horizontal scaling.** `rooms`/membership/SSE fan-out are an in-process singleton; needed before running >1 API process, else you get separate presence universes.
6. **Restore the LOD/proxy layer** before increasing default room density, and wire `/perf` to the room stream (`useWorldStream`, not the legacy `useNpcStream`) so multiplayer draw-call/FPS load can actually be measured — today `/perf` cannot even populate room players to test this.
7. **Fix NPC restore-to-home** by coupling `RoomRegistry.tick`'s restore step to an explicit simulation position reset, not just a roster re-add.

## (D) CAP / PERF CONSTRAINTS

- Hard room cap 20 players; soft auto-fill threshold 12. [room-registry.ts:66,79](../../apps/api/src/services/room-registry.ts#L66)
- The free-roamer NPC set actually contains **15** entries, not the "14" the code comments claim (an extra `buildingId: ''` definition, Adinero, was added later without updating the comment). [npc-definitions.ts:109,347](../../apps/api/src/services/npc-definitions.ts#L109) [room-registry.ts:54](../../apps/api/src/services/room-registry.ts#L54)
- Swap-out keeps player+roamer count near 15 up to 15 players; players 16–20 add pure headcount since no roamers are left to swap.
- Hosted agent bodies and bridge avatars do **not** count toward the 20-player cap and are added globally — actual rendered-body density is unbounded by the room cap.
- No distance-based player visibility radius is enforced server-side (the plan called for 3500wu) — `getPlayerSnapshots` sends every room player regardless of distance.
- The deleted LOD/proxy layer (see B above) means there is currently no safety net between "room cap raised" and "Iris Xe frame budget blown."

---

## Phase-1 test-plan audit (plan vs. shipped)

| Plan checkbox | Status | Evidence |
|---|---|---|
| Two windows see each other + movement | **SHIPPED-AS-DESIGNED** | Works for distinct identities in the same room; client uploads + renders correctly. |
| 15-window co-visibility with LOD/proxy | **SHIPPED-BUT-BROKEN** | Default allocation splits at player 13 (soft cap 12); an explicit 15-player room renders all as full models — no proxy layer exists. |
| 20 players in room, 21st overflows | **SHIPPED-BUT-BROKEN** | True for explicit/invited rooms (hard-capped at 20); default/auto-fill joins instead start new rooms at 12 (tested distribution for 29 joins: 12/12/5). |
| Room deeplink joins the named room | **SHIPPED-AS-DESIGNED** | `?room=` → join body → Invite UI generates the URL; works as specified. |
| Leaving restores NPC at home after 5s | **SHIPPED-BUT-BROKEN** | Roster slot restores; simulated position does not reset to home. |
| Automated RoomRegistry tests | **SHIPPED-AS-DESIGNED** | Covers allocation, cap, spillover, replacement, restore. |
| Automated cross-room snapshot-filtering tests | **NOT-SHIPPED** | Existing tests check bearer/body-ID leakage, not room isolation or hosted-agent filtering. |
| 5-tab Iris Xe crash check | **NOT-SHIPPED** | No recorded test artifact; live renderer still instantiates full models per remote. |
| `/perf` multiplayer draw-call validation | **NOT-SHIPPED** | `/perf` still uses the legacy global NPC hook, can't populate room players. |
| FPS during join/leave | **NOT-SHIPPED** | No reproducible multiplayer FPS gate exists. |

**Bottom line:** the cross-user transport and rendering genuinely work — this is not scaffolding theater. But the shipped system is a **room-scoped human-presence layer** combined with **globally-replicated hosted agents**, missing the planned remote-avatar LOD/proxy safety net, and carrying two live bugs (autonomous-mode double-body, incomplete NPC restore-to-home).
