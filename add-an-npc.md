# Add an NPC

Three kinds:
- **Wandering NPC** — moves around the world map, server-driven via SSE.
- **Building resident** — fixed at a building's entrance, one per building.
- **System agent** — world-wide, not tied to a building (today only `town-guide` aka Nori).

## A. Wandering NPC

1. **Decide the species.** GLB sea-creature (lobster, crab, hermit, crayfish) or Milady VRM.
   - VRM: must use a DISTINCT path (`milady-official-N.vrm`) — the vrm-loader caches one VRM per path, sharing causes T-pose collisions on the SkinnedMesh tree.
2. **Add to `packages/shared/src/constants/npc-definitions.ts`** (the server-side roster) AND/OR `DEMO_NPCS` in `apps/web/src/stores/npc.ts` (the demo-mode fallback that runs when SSE is disconnected). Both should match.
3. **No Three.js code change required** — `arena-npcs.tsx` reads the roster and routes by species (`MODEL_REGISTRY[species].avatar_type === 'vrm' ? <VRMNpcMesh> : <GLBNpcMesh>`).
4. **Server sim** picks up the new entry from the constants file at API boot.
5. **Browser verify** that the new NPC appears at its starting position.

### Doc updates required (same diff)

- [ ] **`WorldContent.md §3a`** — add to the wandering-NPC roster table.
- [ ] **`3dStructure.md §6a or §6b`** — only if you added a new SPECIES (not a new NPC instance). New species = new animator wiring.
- [ ] **`packages/agent-templates/src/locations/town-guide.ts`** — town guide should be able to point new players at the wandering NPCs ("Look for Driftwood the lobster near the eastern reef").

## B. Building resident

1. **Add the character template** at `packages/agent-templates/src/locations/<character-slug>.ts`. Format mirrors the existing 10 templates.
2. **Wire it in** `packages/agent-templates/src/locations/index.ts` (or the central registry).
3. **3D anchor:** `apps/web/src/lib/three/arena-location-npcs.tsx` reads the `LOCATION_NPC_DEFINITIONS` constant. Add an entry with `locationId`, `modelKey`, `name`, scale + position.
4. **API boot** runs `ensureSystemNpcs()` from `system-npc-seeder.ts` — idempotent, will create the new character row on next deploy. No manual DB write needed.
5. **Browser verify** the character stands outside the building and is clickable (opens `<ChatPanel>` with that character as the chat target).

### Doc updates required (same diff)

- [ ] **`WorldContent.md §3b`** — add to the building-resident list.
- [ ] **`GameFeatures.md §12e`** — only if proximity / talk-radius behavior changes.
- [ ] **`ARCHITECTURE.md §4`** — `system-npc-seeder` entry — only if the seeder logic itself changed.

## C. System agent (world-wide, no building)

1. **Write the template** at `packages/agent-templates/src/locations/<slug>.ts`. Use `town-guide.ts` as a reference. The `knowledge[]` array MUST cover the full canonical ClawVille knowledge — modes, buildings, economy, connect flow.
2. **Register the slug** in `SYSTEM_AGENT_TEMPLATES` (`packages/agent-templates/src/index.ts`).
3. **3D anchor:** add a dedicated component (mirror of `<TownGuide>` at `apps/web/src/lib/three/town-guide.tsx`) and mount it inside `World3DCanvas.tsx`.
4. **Chat surface:** the chat lands on `POST /api/chat/system/:slug` automatically — no new route. Lookup via `getSystemAgent(slug)`.
5. **Rate-limited reward:** `system-agent-reward-limiter.ts` already enforces 1 token per 60s per `(userId, slug)`. New system agents inherit this.
6. **Boot seeder:** `ensureSystemAgents()` in `system-npc-seeder.ts` runs every boot; it upserts new templates idempotently.

### Doc updates required (same diff)

- [ ] **`WorldContent.md §1` + §6** — add a row for the new component + new town-center prop if it has a 3D anchor.
- [ ] **`ARCHITECTURE.md §2`** (chat route note) + **`§4`** (system-npc-seeder).
- [ ] **`GameFeatures.md §11a`** if it gets a new UI surface; **§12** if it changes NPC sim behavior.
- [ ] **`CLAUDE.md`** — the "System agents are MANDATORY" section already covers the contract; add the new slug to the list if it's load-bearing.

## Watch out for

- VRM avatars: distinct paths only. Sharing paths = SkinnedMesh tree collision = T-pose forever.
- Animation system: lobster/crayfish use `LobsterAnimator`; everything else uses `createCharacterAnimator(key, scene)`. New species need a `MODEL_REGISTRY` entry + a matching animator branch.
- Town Guide's `knowledge[]`: when you add or rename anything in the world, Nori's knowledge MUST be updated same diff. Stale Nori = broken onboarding.
