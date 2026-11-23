# BrainChain Office: 3D decomposition (read-only)

Team `brainchain-office`, Claude 3da manager. I did not edit any file, spawn agents, make paid calls, or change git state.

**Two limits on this plan:**
- The harness blocked Bash and WebFetch. I could not run tests, measure GLBs, or read BrainChain's public site.
- I calculated every coordinate below by hand from the source files. The placement test in T1 is the real authority for those numbers.

## 0. Summary of the decision

- **The office is a "prop-class venue", not a 13th ring building.** It works like the Kelp portal and Nori.
- **Do not add `brainchain-office` to `BUILDING_TILE_ZONES` or `buildingZones`.** That one change would:
  - turn on CT visit rewards (`avatar-visit-building`, capped at 10 per day), which is an economy change;
  - add the office to the boot reveal gate. `buildings-gated-reveal.test.ts` expects exactly 12 buildings, so this slows cold load;
  - push the resident 1300 wu in front of the office (`NPC_INSET_WORLD`);
  - change the lanes and seaweed for every building.
- **The teacher is the existing system agent** `SYSTEM_AGENT_TEMPLATES['brainchain-office']` (clawville_fit's choice). It talks like Nori, not like a ring resident.

## 1. Visual reference method and local assets

- **Rule:** AGENTS.md wants a Chrome MCP screenshot of `https://clawville.world/game` (prod `7dc9a0001`). The browser host is down, so no prod screenshot exists. Record "prod reference owed".
- **Substitute:** a local production bundle (`bun run build && bun run start`, then `localhost:3000/game`) built from the job's staging base. Take headless screenshots at the camera poses in §7. Label them "local build of staging lineage, not prod". Never run `bun run dev`.
- **Local images (old):** `docs/perf-fidelity-spike/*/game.png`, from June 2026. They predate the Trading Floor and the land scale-up. Use them for camera framing only.
- **Style references:**
  - The ring GLBs, mainly `models/trading-floor/trading-floor-exterior-opt1-mo-ktx.glb?v=2`. This is the closest Meshy-derived exterior.
  - The Daylight register in `branding/BRAND.md` §2A and §3.
  - `branding/assets/world/beach-banner-wide.jpg`.
- **Hero camera recipe:** memory `reference_clawville_ring_hero_camera`. Put the camera on the center-to-building axis.
- **BrainChain brand: unverified.** WebFetch was denied, and the research folder has no brand data. Before any image prompt, the lead must read BrainChain's public colors and symbol. The accent color in §3 is a placeholder.

## 2. Location

**Chosen site: the NNE wedge between Pineapple House (N, slot 0) and Chum Bucket (NNE, slot 1).**

- Office collider center: world `(720, −2800)`, which is game-px `(11984, 8464)`.
- Distance from the origin: about 2890 wu. Distance from spawn: about 3420 wu, inside fog near (5000).
- The site is in the default north-facing spawn view. The initial camera is at `[0, 600, 1300]` and looks at the origin.
- `rotY = 0`. The entrance faces +Z (south, toward the plaza and spawn), so the AABB stays exact.

**Hand-computed clearances (half-extents 240 × 210):**

| Obstacle | Source | Clearance |
|---|---|---|
| N lane (axis x = 0, half-width 400) | `DECO_LANE_HALF_WIDTH` | office min x 480: 80 wu |
| NNE lane (30° axis) | same | nearest corner (960, −2590): perpendicular 463.6, so 63 wu |
| visual-creation AABB (496 × 385 with buffer) | `BUILDING_EXTENTS` + 28 | 765 wu (Z) |
| code-development AABB (619 × 623) | same | 501 wu (X) |
| SpongeBob stand (0, −2860), talk 260 | `computeNpcPlacement` | 480 wu edge |
| Plankton stand ≈ (1432, −2489) | same | ≈ 483 wu edge |
| quest-bounty-pavilion (0, −1220) ± 280 | `PROP_COLLIDERS` | ≈ 1090 wu |
| Nearest wanderer homes: Ansem (0, −1884), Kyoko (1890, −1485) | `npc-definitions.ts` | > 700 wu |
| Land parcels: founder inner edge at Chebyshev 5312 | `land-parcels.ts` | > 2300 wu |

**Navigation evidence:**
- `pathfinding.ts` rasterizes every collider from `getServerColliders()`, plus 4 safety tiles (128 wu).
- `client-pathfinding.ts` reads `BUILDING_TILE_ZONES`. The client planner will not see the office, so the office must be in the client `PROPS` list too. The T1 test must confirm that the client click-to-move path goes around it.

**Other sites I rejected:**
- All 12 ring slots are taken.
- The gap between the ring and the parcels is only 274 wu.
- The founder-frame corners (≈ 6100, 6100) are at about 8.6k wu, in about 80% fog.
- The inner plaza is full of props.
- The mirror NNW site has only 352 wu of clearance to memory-rag.

**Constraints for the implementer:**
1. Validate the site at module load and in a test, as the Kelp pin does. Check:
   - ≥ 200 wu from every collider;
   - the full footprint stays out of every lane;
   - ≥ 460 wu from every resident stand;
   - the door is outside every other prompt band;
   - pathfinding from spawn to the door works, and from the door to all 12 buildings.
2. Decorations will move. `isDecorationSiteClear` reads `getAllColliders()`, and the RNG resamples on each rejection. Update the exact pins in both decoration test files (`arena-terrain-decorations.test.ts`, `arena-terrain-decorations-bounds.test.ts`, now 52 meshes and 148,444 triangles). Keep the budget at ≤ 56 meshes and ≤ 150k triangles.
3. Starting interaction geometry. Tests are the authority for these values.

| Item | Starting value |
|---|---|
| Door face | z = −2590 |
| Door prompt rectangle | \|x − 720\| ≤ 110, z ∈ [−2590, −2430] |
| Guide stand | (500, −2440), talk radius 220, collider 40 × 40 |
| Overlap rule | Door wins inside the rectangle. Tests prove a guide-only zone ≥ 120 wu deep. |
| Return spawn | (720, −2250), outside both prompts |
| Click-to-move | No auto-enter band. Click, tap, or E only (the Trading Floor rule). |

4. Fix the doc drift I found:
   - `3dStructure.md` §2h shows cron-automation as 850 × 498. The code says 823 × 720.
   - `WorldContent.md` §6 lists the old positions of the bazaar, the marketplace, and Nori.

## 3. Building art brief (Meshy, daylight world)

**Concept:** "BrainChain Office: the Work Desk". It is a small civic workshop where agents bring finished work and get it checked.
- It reads as a verification office: an intake counter, task boards, and a checked-seal beacon.
- It must not read as a bank: no columns, no vault door, no coins, no gold dome, no bull, no ticker.

**Silhouette and size:**
- Footprint about 460 (X) × 400 (Z). Main body about 480 tall.
- Rooftop beacon to about 760 (Y). This is the max dimension: `targetMaxDim ≈ 760`.
- Avatars are 179 wu tall.
- The shape is one chunky, rounded box with a soft stepped roof.

**Front (+Z):**
- One wide rounded-arch doorway, about 170 wide × 250 tall, with a deep recess for a dark shadow.
- A low counter ledge beside the door on the left (the guide stands there).
- Two blank recessed task-board panels on the facade. Labels come from the game's sign or label system.

**Roof beacon:** three thick linked rings (the chain) around a rounded node (the brain or worker). The node has a simple check-mark relief. All shapes must read at 3000 wu.

**Back and sides:** a simple stepped massing with two round porthole windows on each side and no fine detail. The back has a blank service door.

**Materials:** matte toy-like plastic or clay, like the ring buildings. Use large color blocks and soft bevels.

**Palette (placeholder until the BrainChain colors are verified):**

| Part | Color |
|---|---|
| Walls | Sand `#F8E0A8` |
| Roof and trim | Lagoon Teal `#80C0B8` |
| Base and door frame | Plank Wood `#8A4A20` |
| Beacon node | one partner accent (Electric Blue `#2890F8` as placeholder), with an emissive look |

**Exclusions:** no baked text, logos, or numbers. No glass transparency. No thin antennas, cables, plants, ground plane, or floating parts. Keep it symmetric left to right, except the counter.

## 4. Source image prompts (lead generates them)

Use one prompt core for all three views, so the geometry stays consistent:

> CORE: "Stylized 3D toy-like building, Pixar-grade soft clay render, single isolated object on plain light-grey seamless background, soft even studio daylight, no shadows on background, no ground plane. A small chunky civic workshop office: one rounded box body with soft bevels, sand-colored walls (#F8E0A8), soft stepped teal roof (#80C0B8), dark-brown wooden base trim and door frame (#8A4A20). Roof beacon: three thick interlocking chain rings around one rounded glowing node with a raised check-mark relief, accent color [BRAINCHAIN_ACCENT]. Large simple shapes, readable from far away. No text, no letters, no logos, no numbers, no signs with writing, no glass, no plants, no people, no vehicles, no coins, no columns, no vault."

| View | Add to the core |
|---|---|
| **3/4 (primary)** | "Three-quarter view from front-left, camera 30° above horizon, 35° left of front axis. Front shows one wide rounded-arch doorway with a deep dark recess, a low counter ledge left of the door, two blank recessed rectangular panels on the facade. Side shows two round porthole windows." |
| **Front** | "Orthographic-style straight front elevation, camera at mid-height, centered, symmetric. Same doorway, counter ledge left of door, two blank panels, beacon centered on roof." |
| **Back** | "Orthographic-style straight rear elevation. Plain stepped back wall, one small blank service door, beacon visible centered on roof, two porthole windows on each side edge visible." |

- Render all three at 1024 × 1024 with the same scale and the building centered. Fill about 80% of the frame height.
- Store the images and their prompts in `docs/research/brainchain-2026-11-09/3d/refs/`, with filenames `front.png`, `back.png`, `3q.png`. These match the `meshy-rest.mjs` input names.

## 5. Ownership and coupling (one owner for each file)

| Task | Owner | Files it may edit |
|---|---|---|
| **T1 World geometry** | world-presence implementer | NEW `packages/shared/src/constants/brainchain-office-world.ts` + `.test.ts` (center, extents, door, guide, exit, validation). `world-colliders-data.ts`: 2 `PROP_COLLIDERS`. `apps/web/src/lib/three/collision/world-colliders.ts`: mirrored `PROPS`. `arena-terrain-decorations.ts`: `ENTRANCE_CLEARINGS` + door. Both decoration tests (re-pin). One export line in `packages/shared/src/index.ts`; the lead applies it because clawville_fit shares that file. Check `merged-seaweed.tsx` for overlap; if seaweed overlaps, add the exclusion there. |
| **T2 Render** (E3: Codex authors, Claude reviews) | 3da implementer | NEW `apps/web/src/lib/three/brainchain-office.tsx` (GLB mount with `groundedYOffset`, frozen matrices, `WorldLabelsOverlay` label, invisible-material click box, guide figure that reuses an existing loaded character GLB). NEW `apps/web/public/models/brainchain/brainchain-office-exterior-v1-opt1-mo-ktx.glb` (served as `?v=1`). `World3DCanvas.tsx`: one `perf:brainchain-office` mount in tier 2 (after `BOOT_CORE_PRESENTED`). `asset-preload-manifest.ts`: audit list entry. Never add it to `BOOT_STREAM_COHORT_IDS`. |
| **T3 Approach and click** | UI implementer | `character-positions.ts`: zero-allocation `isBrainchainOfficeDoorProximate` / `isBrainchainGuideProximate`. `player-avatar.tsx` and `npc-controller.tsx`: the near-location ladder and the click-path target. NEW `brainchain-office-transition.ts`. `location-prompt-text.ts`, `location-hud.tsx`. `stage-navigation.ts`, `stage-scene-id.ts`, `WorldPresence.tsx`: add `/brainchain` and map it to the world scene so the Canvas stays mounted. `app/(world)/brainchain/page.tsx`. 2D: `use-game-loop.ts`, `PixiCanvas.tsx`, `minimap.tsx`, `world-map-modal.tsx` (marker and door). Guide talk opens the system-agent chat for slug `brainchain-office`. |
| **T4 Agent move** | world-presence implementer | `map-locations.ts`: one `AUTONOMY_ENTERABLE_PLACES` row with `center` = door approach, verb `move` (whitelisted already, so no executor change). `agent-autonomy-driver.ts`: `hasArrived` / `destinationLabel` for a center row, with a test. The knowledge owner handles the protocol version and manual text. |
| **T5 Meshy pipeline** | lead (images, Meshy), then the 3D implementer | NEW `scripts/brainchain/meshy-office.mjs`. It reuses the `meshy-rest.mjs` ledger and resume logic but uses building settings: `topology:'triangle'`, `target_polycount: 15000`, `enable_pbr:false`, no rig or animation. Raw outputs go to an ignored job directory inside the worktree; the lead confirms the `.gitignore` line. Task IDs go in the evidence index. |
| **T6 Docs** | one doc owner | `WorldContent.md` §1 and §6, `3dStructure.md` §2h and §9 (and the drift fixes), `GameFeatures.md` (new world flow). Same diff as the code. |

**Notes for other owners:**
- The guide joins `SYSTEM_AGENT_TEMPLATES`. Per `apps/api/src/index.ts:802-857`, the API warms every system agent at boot. The backend owner must check boot time and the ElizaOS init lock.
- E5 parity: humans use the chat panel. Agents use the system chat route and the move row. There is no CT reward, so the ledger does not change.

## 6. Performance budget

**Comparable building:** the Trading Floor exterior (the Meshy exterior with the largest max dimension, 1950): 430 KB, 14,225 triangles, 3 draws, 1024² ETC1S base color. The office is about 40% of that max dimension.

| Metric | Target |
|---|---|
| Office GLB | ≤ 12,000 triangles, ≤ 2 materials, so ≤ 2 draws after `mergeStaticMeshesByMaterial` |
| Textures | 1× 1024² ETC1S base color (+ optional 256² emissive), no normal map |
| File size | ≤ 350 KB |
| Guide figure | an existing model: 0 new bytes, its own draw count |
| Click box, labels | 0 draws |
| Frame totals | ≤ +5 draws, ≤ +15k triangles, ≤ +2 pipelines (current pipelines ≈ 115–120 against the ≤ 120 target, so record the value) |
| Texture memory | ≤ +1.5 MB |
| Boot | no change in loader dismissal time |
| Sustained FPS | at poses P1 and P2: ≥ baseline − 2 FPS over 60 s, same machine and build |

**Measurement commands:**
- `node scripts/read-glb-bbox.mjs <glb>`
- `npx @gltf-transform/cli inspect <glb>`
- `/game?perf=1` perf HUD: draws, triangles, pipes, heap
- `window.__W3D.gl.info.render.drawCalls`, `gl._pipelines.caches.size`
- `scripts/perf-fidelity-browser.ts`, if it still runs. Its path came from the doc; verify it.

Measure on WebGPU and on forced WebGL. Use Iris Xe hardware if you can; otherwise name the machine.

## 7. Screenshot loop and rollback

**One iteration:**
1. Check the GLB offline: bbox, footprint, origin, normals, UVs, triangles, textures.
2. Take a Blender front and 3/4 viewport screenshot and compare it with the reference.
3. Build the local production bundle.
4. Take screenshots at four poses:
   - P1: default spawn view;
   - P2: 900 wu south of the door;
   - P3: door close-up with the label and prompt;
   - P4: overhead view through `cameraFocusRequest`.
5. Also capture the perf HUD, 375 × 812 phone portrait, phone landscape, and iPad, in both renderer backends.
6. The lead looks at each image and records a pass or fail against the brief.
7. Codex and Claude review independently.

**Each version is one commit:** GLB + mount + constants, with a new filename suffix `-vN`. A served `?v=` value is never reused.

**When an iteration fails:**
- Revert only that commit.
- Keep the Meshy task IDs. Resume polling; do not submit again.
- Keep the provenance.

If the site itself fails (crowding, a pathfinding hole), revert T1 + T2 together and pick a new site from the T1 test. Never move a ring building.

No result is called "done" before the founder signs off (E4). Use "compiled and rendering, needs your eyes".

## 8. Review checklists

**A. Codex reviews this decomposition:**
- Recompute every clearance in §2 from the source. Confirm decorations, Kelp, Hydra, and parcels do not conflict.
- Confirm that the prop-class choice avoids visit rewards, the boot cohort, and the resident inset. Find any consumer that loops over colliders and would break.
- Confirm the `move` row works in `hasArrived`, or show that a new verb is needed.
- Confirm that mapping `/brainchain` to the world scene keeps the Canvas mounted.
- Confirm that file ownership has no overlap with clawville_fit, backend, or other agents' files.
- Confirm that the budget numbers match §9g.

**B. My review of the final implementation:**
- Server and client colliders match exactly. Placement asserts run at module load, and the test passes.
- Pathfinding works from spawn to the door and from the door to all 12 buildings, for the server and the client.
- Decoration pins are updated, and the decoration budget still holds.
- No drei `<Text>` or `<Billboard>`. No `InstancedMesh` + `ShaderMaterial`. No per-frame `new`. Proximity checks allocate nothing.
- The office is not in the boot cohort. Assets use `groundedYOffset`, frozen matrices, KTX2 + meshopt, and a new filename.
- Door and guide ladder works in player, NPC, click-to-move, and 2D modes. The return spawn is outside both prompts.
- Existing location IDs and earned skills are unchanged.
- I look at every screenshot myself.
- Measured numbers are within §6.
- Canonical docs change in the same diff.

## Gates still open

- Prod screenshot (browser host is down).
- BrainChain public palette check.
- Founder approval of the site and design (permanent placement is a founder choice; until then this site is the default).
- Codex review of this plan.

## Lead evidence update
Production screenshot captured and viewed through isolated Chrome on itachi222 at 2026-11-09T13:30Z. Reference: .brainchain-work/production-reference.png. Public BrainChain artwork uses charcoal and pink. The founder authorized routine design choices; no separate site approval is required when placement tests pass. Coordinates remain provisional until independent geometry checks pass. The office uses pink as a restrained partner accent. Claude source report above remains preserved as received.
