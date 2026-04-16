# NPC vs Character — two concepts, do not conflate

ClawVille has TWO distinct agent kinds in the world. Phase 6 locked in the
split. Future sessions: **do not rename "NPC" to "character" blindly** — the
terms mean different things.

## NPC (wandering / ambient)

- Wandering sea creatures, schools of fish, idle background life.
- No user-facing chat. No ElizaOS runtime. No persistent conversation memory.
- Code paths that keep the NPC name:
  - `apps/api/src/services/npc-simulation.ts`
  - `apps/api/src/services/system-npc-seeder.ts`
  - `apps/api/src/routes/npc-sse.ts`
  - `apps/web/src/lib/three/arena-npcs.tsx`
  - `apps/web/src/lib/three/npc-controller.tsx`
  - `apps/web/src/lib/three/npc-speech-bubbles.tsx`
  - `apps/web/src/stores/npc.ts` (`useNpcStore`)
  - `packages/shared/src/constants/npc-definitions.ts`
  - `packages/shared/src/constants/npc-activities.ts`
- User-facing copy tied to wandering NPCs stays NPC-vocab: hover tooltips on
  random sea creatures, ambient banter bubbles, `npc-simulation`-emitted
  thought-log entries, the "NPC Mode" spectator toggle in
  `control-mode-toggle.tsx` (the user takes control of a wandering NPC before
  connecting an agent — that is an NPC, not a character).

## Character (10 building residents)

- Spongebob, Patrick, Mr. Krabs, Squidward, Sandy, Gary, Plankton, Mrs. Puff,
  Karen, etc. — one resident per building.
- Has an ElizaOS runtime, an archetype, persistent per-(location, user) chat
  memory.
- Users chat with these characters via the chat panel after entering a
  building.
- User-facing copy uses the **character** term: chat panel headers, building
  tooltips, near-character prompts, quest text that targets a resident,
  tutorial steps about walking up to a building to chat, activity-feed entries
  emitted by the building-character runtime.

## Memory isolation (Phase 6, 2026-04-16)

- `characterRoomId(locationId, userId)` in `@clawville/agent-runtime` returns a
  v5 UUID under namespace `8f3b1b27-5f2a-4a8d-9c1d-2e7b4d1f6a9c`.
- `ElizaRuntime.processMessage` honors a caller-supplied `context.roomId`
  **only when it's a valid UUID** — legacy string roomIds
  (`pet-${petId}-${userId}`, `agent-gateway-${npcId}`, `${buildingId}-${sessionId}`)
  continue to be ignored and fall back to the internal
  `generateRoomId(agentId, userId)` derivation. This preserves every existing
  memory row; only building-character chat opts in to the new UUID scheme by
  passing through `characterRoomId()`.
- Cross-user character memory leak was already prevented pre-Phase 6 by the
  internal `generateRoomId(agentId, userId)` derivation (platformAgentId is
  location-specific, so each user at each location already got a distinct
  room). Phase 6 makes the scoping explicit and caller-controlled.

## What NOT to do

- Do NOT rename NPC code to character code (the DB tables, the service files,
  the React stores, the shared constants).
- Do NOT use "NPC" in user-facing chat-with-building-resident copy.
- Do NOT rename the "NPC Mode" control toggle — that spectator mode targets
  wandering NPCs, not building residents.
