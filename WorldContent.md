# ClawVille — World Content Manifest

> **Strict rule:** every code change that adds, removes, repositions, rescales,
> recolors, or otherwise changes a rendered thing in the open-world scene MUST
> update this doc in the same diff. Reverse holds: changes to this doc require
> the corresponding code change. Mismatch is a bug.
>
> If you're an agent: the answer to "what's in the scene?" lives HERE, not in
> grep results. Update this when you touch any file listed in the "Source"
> column. Update the affected file when you change a row here.

**Last edit:** 2026-09-20 (Trading Floor **TRADE TAPE** — the recent trades render as objects in the hall, not only as text on the back wall). §2a gains a Trade tape row; the draw-call line moves 24 → an expected 25 (+1, the tape is one mesh for all 12 slabs) and is flagged as a projection owed a live re-measurement. Founder order: "your job was supposed to be displaying the trades in 3d ... it's really just to showcase performance". No asset bytes, no GLB, no new route — it reuses the board's own `useHouseTraders` query. Source: `lib/three/trading-floor/trading-floor-trade-tape{,-mesh}.ts{,x}`.

**Prior Last edit:** 2026-09-19 (Trading Floor interior **v2** — wall-side desks, chairs, seats, big board) — §2a rewritten from the live constants; it had been left on v1 through the whole v2 pass and was actively misleading. Corrected: the interior GLB row said `?v=1` with v1 bytes (336 KB / 6,881 tris / 3 textures) while the code serves `?v=2` (358 KB / 7,277 tris / 6 textures) — a stale cache-bust line is the failure class this project treats as kill-the-build. The six desks moved from free-standing aisles at x ±820 to the side walls at x ±1120 / `rotY ±π/2` with yaw-derived collider half-extents; the kiosk moved (0, −890) → (−300, −900) and then, in v3, shrank 470 → **300 wu tall** at **(−300, −980)** with half-extents 101/79 → 64.49/50.45; the four corner pillars became colliders. New rows for the chair row, the six seats and the sit flow, the live big board, the eight click volumes and the desk-face camera bound. Lights changed ambient 1.7 / hemi 1.35 / point 6.5 → ambient 0.85 / hemi 1.15 / directional 1.15. Measured draw calls 24/frame, 9 of them the room. Source: `lib/three/trading-floor/**`.

**Prior Last edit:** 2026-09-19 (Trading Floor becomes ENTERABLE) — §1 gains the `/trading-floor` stage-slot row; §2 row 6 swaps `patty-building.glb` → `trading-floor-exterior-opt1-mo-ktx.glb?v=2` at `targetMaxDim` 2200 → 1950 with the collider retuned 850×498 → 823×720 in both the web and shared tables; new §2a documents the interior hall, its props, hotspots, camera, lights, exit spawn and draw-call budget. Founder order 2026-09-19: "they would enter it like they enter the cove … a monitor almost to walk up to and manage trades." Source: `lib/three/trading-floor/**`, `components/three/world-stage/StageHostedTradingFloorScene.tsx`, `app/(world)/trading-floor/page.tsx`.

**Prior Last edit:** 2026-06-16 (Land Phase 1 / Slice A) — §1 scene-tree row added for land-parcels render layer. 176 for-sale parcel lots: fences (5 tier merged draws: founder=gold, a=sky-blue, b=sage-green, c=tan, starter=grey) + 1 sign-post draw + 1 sign-plank draw = 7 total added draw calls. Parcels at concentric radii 1760–8704wu; building ring at 4160wu excluded (no overlap). Source: `lib/three/land-parcels.tsx`. Store: `stores/land.ts`.

**Prior Last edit:** 2026-05-25 — §18a.f blackjack interactive-shell fix documented in GameFeatures.md. Prior: 2026-05-25 — Krusty Krab runtime GLTFLoader node key corrected to `The_Krusty_Krab` for both `childScaleOverrides` and `bodyAnchorChild`; the prior `"The Krusty Krab"` key was a no-op. Prior 2026-05-18 — Phase 6.2.2: MAX_FOOTPRINT 1800→2000wu. Node name bug fixed: `childScaleOverrides` + `bodyAnchorChild` keys for Squidward + Krusty Krab used underscore-sanitized names (silent no-ops — Three.js GLTFLoader does NOT sanitize); corrected to literal GLB names `"Squidward's House"` and `"The Krusty Krab"`. targetMaxDim bumps: messaging-channels 1000→2500 (Sandy dome ~820wu), api-integrations 1300→2500 (Salty Spitoon ~1209wu), cron-automation 1300→2200 (Patty Building ~1513wu), memory-rag 1400→1700 (childScale also 1.4→1.7). Sandy NPC T-pose fixed in `arena-location-npcs.tsx`. §2 slot table rows 2+3+4+6+11 updated. Prior 2026-05-18 — Body-anchor system: `bodyAnchorChild` field added; Squidward's House + Krusty Krab now anchor their building body's bbox center at the ring slot (fixes placement pushed-back bug from sign/pathway dominating full-GLB center). `pivotZBias: 180` removed from memory-rag (superseded by dynamic anchor). Size bumps: code-development 1000→1400, api-integrations 1000→1300, cron-automation 1000→1300. §2 slot table rows 1+2+4+6+11 updated. Prior 2026-05-18 — Differential child-scale: Squidward house body ×1.4, Krusty Krab restaurant ×1.5 vs stepping stones/sign. Both targetMaxDim 1000→1400. §2 slot table rows 2+11 updated. Prior 2026-05-18 — Phase 6.2.1: ring R=160→130 tiles (5120→4160wu — R=160 too spaced out). Arc spacing 2680→2178wu. All 12 building slot positions updated. §2 slot table updated. Prior 2026-05-18 — Phase 6.2: ring R=100→160 tiles (5120wu), grid 240→360 (11520wu). All 12 building slot positions updated. `targetMaxDim` normalization (max-dim) replaces `targetHeight` (Y-only) — uniform visual size across wide/squat and tall/narrow GLBs. NPC_INSET_WORLD 1000→1300wu (Patrick fix). Sandy Treedome DoubleSide transparent-mat fix. Town-center props spread to 800–1000wu ring: BazaarStall (-800,-2,300), MarketplaceStall (800,4,300), AuctionPodium (0,200,-1000). DECO_INNER_EXCLUSION_R 1500→800wu (scatter fills central plaza area). §2 slot table updated. Prior 2026-05-18 — Pass 3 fixes: MAX_FOOTPRINT 1500→1800; NPC_INSET_WORLD 600→1000; targetHeights bumped; Patrick's Rock ↔ Arcade City swap. Prior prior 2026-05-18: Phase 6.1 grid+ring expand, pedestal discs.

---

## 1. Top-level scene tree

Composes the entire R3F scene. Mounted by `SceneContents` in `apps/web/src/components/three/World3DCanvas.tsx`.

| Group | Component | What renders | Source |
|---|---|---|---|
| **Lighting** | inline JSX | 1 hemisphere + 2 directional + fog (4500→9000wu) | `World3DCanvas.tsx` ~778 |
| **Terrain** | `<ArenaTerrain>` | sand floor + decorations + (disabled landmarks) | `lib/three/arena-terrain.tsx` |
| **Land parcels** | `<LandParcels>` | 176 for-sale lots (fences + signs), 7 draw calls; Zustand store `stores/land.ts` defaults all available | `lib/three/land-parcels.tsx` |
| **Buildings** | `<ArenaBuildings>` | 12 themed building GLBs on a circular ring (R=130 tiles = 4160wu, 30° spacing; Phase 6.2.1 2026-05-18) | `lib/three/arena-buildings.tsx` |
| **Trading Floor interior** | `<StageHostedTradingFloorScene>` | lazy `/trading-floor` STAGE SLOT (not part of the open-world tree) — authored hall GLB + monitor/door hotspots + its own player and chase camera; see §2a | `components/three/world-stage/StageHostedTradingFloorScene.tsx` |
| **Wandering NPCs** | `<ArenaNpcs>` | 9 free-roaming NPCs (8 VRM + 1 GLB), SSE-driven positions | `lib/three/arena-npcs.tsx` |
| **Building residents** | `<ArenaLocationNpcs>` | 10 character NPCs, one per building | `lib/three/arena-location-npcs.tsx` |
| **Ground cover** | `<MergedSeaweed>` | TSL-animated seaweed, single merged mesh | `lib/three/merged-seaweed.tsx` |
| **Town center props** | 5 components | quest NPC, town guide, bazaar, marketplace, auction, directory sign | listed in §6 |
| **NPC overlays** | 3 components | speech bubbles, activity indicators, floating texts | listed in §7 |
| **Player avatar** | `<PlayerAvatar>` | conditional — player / autonomous mode only | `lib/three/player-avatar.tsx` |
| **Camera + input** | OrbitControls + 3 controllers | OrbitControls, WASD, FPS-follow, arrow-key rotation | `World3DCanvas.tsx` |
| **Invisible mounts** | 7 components | pipeline pre-compile, texture upload, KTX2/meshopt setup, jump ticker, label overlay mount, minimap tracker | `World3DCanvas.tsx` |

---

## 2. Buildings (12)

Loaded by `<ArenaBuildings>`. Each is a single GLB clone placed on a **true circular ring** — 12 buildings at 30° angular spacing, radius 130 tiles (4160wu) from center (0,0,0). Arc spacing ≈2178wu. Config: `BUILDING_MODELS` in `lib/three/arena-buildings.tsx`. Authoritative positions: `buildingZones[]` in `tilemap-data.ts`. Ring history: 56→68 tiles (2026-04-16) → 68→72 tiles (2026-05-13) → briefly square (2026-05-17 Phase 6.0.1) → true circle revert R=72 (2026-05-17) → Phase 6.1 R=100 on 240×240 grid (2026-05-18) → Phase 6.2 R=160 on 360×360 grid (2026-05-18) → Phase 6.2.1 R=130 on 360×360 grid (2026-05-18, R=160 too far from spawn).

Scale normalization: `computeBuildingScale` uses max(X,Y,Z) (`targetMaxDim`) — consistent visual cube size regardless of GLB aspect ratio. All buildings normalized to 1000–1400wu max-dim range.

Each building has a flat **stone pedestal disc** (radius=560wu, 15wu thick, color `0x8b7d6b`) rendered at y=−2 by `BuildingPedestal` in `arena-buildings.tsx`.

Phase 6.2.1 slot table (R=130 tiles, center tile (180,180)):
Slot geometry: cx=180+130×cos(θ), cy=180+130×sin(θ), θ=−π/2+slot×(π/6). Zone=(round(cx)−7, round(cy)−7), 14×14 tiles.

| Slot | Angle | cx,cy (tiles) | Zone id | GLB path | Renders | targetMaxDim | Notes |
|---|---|---|---|---|---|---|---|
| 0 | N | 180,50 | `visual-creation` | `pineapple-house.glb` | SpongeBob's pineapple house | 1100 | |
| 1 | NNE | 245,67 | `code-development` | `chum-bucket-v2.glb` | Bucket | 1400 | 1000→1400 (+40%); max-dim norm |
| 2 | ENE | 293,115 | `mcp-tool-use` | `krusty-krab-v2.glb` | Ship-restaurant | 1400 | childScaleOverrides: `The_Krusty_Krab` ×1.5 (runtime node name); bodyAnchorChild: `The_Krusty_Krab` (restaurant centers at slot, sign extends forward) |
| 3 | E | 310,180 | `messaging-channels` | `sandy-treedome-v3.glb` | Tree platform + glass dome | 2500 | 1000→2500; dome square XZ≈25.87, MAX_FOOTPRINT=2000 cap → ~820wu height; rotYOffset +π; DoubleSide transparent-mat fix |
| 4 | ESE | 293,245 | `api-integrations` | `salty-spitoon.glb` | Bar | 2500 | 1300→2500; km-scale GLB, after flat-base strip ~1209wu; rotYOffset -π/2 |
| 5 | SSE | 245,293 | `app-publishing` | `boating-school.glb` | Mrs. Puff's classroom | 1000 | rotYOffset +π/2 |
| 6 | S | 180,310 | `cron-automation` | `trading-floor/trading-floor-exterior-opt1-mo-ktx.glb?v=2` | **Trading Floor** (Pearl) | 1950 | **ENTERABLE 2026-09-19.** Asset swapped off `patty-building.glb` (2200 → 1950): scene bbox 1.290 × 1.29943 × 1.129, grounded at Y=0, entrance faces **+Z** at rotY 0 so slot 6 keeps `rotY: 3.142` with no `rotYOffset`. maxDim is the Y axis (the rooftop claw), not an XZ axis, so at 1950 the roofline lands at 1495wu — within 2% of the outgoing patty roofline — with XZ 1936 × 1694 and the MAX_FOOTPRINT=2000 cap DISENGAGED (2200 only matched by tripping the cap). Collider retuned 850×498 → **823×720** in BOTH `collision/world-colliders.ts` and `packages/shared/.../world-colliders-data.ts`. Click / tap / E walks the avatar to the north face, then the stage crosses to the `/trading-floor` interior slot (`triggerTradingFloorWalkIn`, §2a). **Re-themed 2026-09-19** from "Downtown Building" by founder order: the building BECAME the Trading Floor. The zone id stays `cron-automation` FOREVER — renaming it breaks owned book ids `cron-automation-basics`/`-advanced`, the `skill-tools-dispatcher.ts` key, stored `building.visited` events, earned-skill memories keyed on buildingId, and installed `~/.hermes/skills/clawville-cron-automation/` folders. Only `MAP_LOCATIONS.name`, its description and its icon changed. Pearl stays and her subject widens to scheduled trading; she points at the house-trader monitor inside and never runs it. Agent entry: `[ACTION: enter_trading_floor()]` (PROTOCOL_VERSION 66). |
| 7 | SSW | 115,293 | `deployment-ops` | `building-lighthouse.glb` | Lighthouse | 1400 | tallest landmark |
| 8 | WSW | 67,245 | `claw-arcade` | `arcade/claw-arcade-exterior.glb` | Arcade City — domed building | 1100 | 2 slots (60°) from casino — NOT adjacent. Interior / crane game: Phase 6.3. |
| 9 | W | 50,180 | `casino` | `casino/casino-exterior-cove.glb` | Predictive Gaming Cove — Mayan step-pyramid | 1300 | Entertainment district. box3Recenter=true. Interior: **6.0.2 SHIPPED** — `/casino` route. |
| 10 | WNW | 67,115 | `agent-security` | `patricks-rock-v2.glb` | Patrick's rock | 1100 | Adjacent to casino (slot 9). Max-dim prevents dome over-inflation. |
| 11 | NNW | 115,67 | `memory-rag` | `squidward-house.glb` | Easter-Island moai head | 1700 | 1400→1700; childScaleOverrides: "Squidward's House" ×1.7 (was ×1.4 with wrong underscore key — now literal name); bodyAnchorChild: "Squidward's House"; pivotZBias removed |

### 2a. Trading Floor interior (`/trading-floor` stage slot) — v2, 2026-09-19

The second enterable venue after the Cove. It is a **stage slot**, not a route-owned Canvas: `WorldStageRoot` owns the persistent camera, background, fog and capability mask; the `(world)/trading-floor` page is DOM/HUD only.

| Thing | Value | Source |
|---|---|---|
| Room GLB | `trading-floor/trading-floor-interior-opt1-mo-ktx.glb?v=2` — 358 KB (367,068 bytes), 7,277 tris, 8 meshes, 8 materials, 6 ETC1S textures | `lib/three/trading-floor/trading-floor-interior.tsx` |
| Scale | **NO auto-fit** — authored at 1 unit = 1 wu, mounted at the identity with every matrix frozen | same |
| Hall | 2600 (X) × 950 (Y) × 2200 (Z), wall thickness 60, doorway 360 × 500 on the **+Z** wall | `trading-floor-room.ts` |
| Props (mirrored as collision AABBs) | **6 console desks** against the SIDE walls at x ±1120, z −500 / 0 / 500, each 364 × 270 authored · holo dais (0, −60) 700 × 692 × 206 tall · monitor station (−300, **−980**) 129 × **300** × 101 · **4 corner pillars** at (±1110, ±910), 110 × 110. No two solids may overlap; `trading-floor-asset.test.ts` sweeps the whole set | `TRADING_FLOOR_SOLIDS` |
| Asset contract | the GLB publishes `extras = {screen, kiosk, room}` on its scene root, asserted exactly against the scene constants on every push | `trading-floor-asset.test.ts` |
| Kiosk rescale (v3) | 470 → **300 wu tall**, z −900 → **−980**, half-extents 101/79 → **64.49/50.45**, screenY 330 → **211** | the kiosk was shadowing the board. Moving it sideways cannot work: the seat-band rule wants \|x\| < 639 and clearing the board's x-span from the spawn wants \|x\| > 751, and those windows do not intersect. Shrinking it drops the worst shadow to 339, which is what let the board's bottom edge come down to 360. Every value is read off the shipped node `t=[-300, 150, -980] s=150`, not from that reasoning |
| Desk row | the GLB ships ONE `TradingFloorConsoleModule`; the scene instances it 6× as a single `InstancedMesh` (1 draw call) and removes the authored copy. `rotY ±π/2` — the prop faces +Z, so the −X wall takes +π/2 and the +X wall −π/2 to face the aisle. That yaw SWAPS the footprint to 270 × 364, so the collider half-extents are DERIVED from the yaw by `consoleHalfExtents`, never hand-written | `TRADING_FLOOR_CONSOLE_ROW` |
| Chair row | 6 × `TradingFloorChairModule` as a second `InstancedMesh` (1 draw call), placed from `TRADING_FLOOR_SEATS`, 128 × 175 × 122 each. **NOT colliders** — you stand on the seat point to take the seat, so a chair collider would block its own seat | `CHAIR_SLOTS` |
| Seats | 6, derived from the desk row: avatar stands at desk centre + 205 along the desk's facing axis, chair prop 120 wu further out at 325. Interact radius 200, hint radius 420. Cushion top 85 wu | `TRADING_FLOOR_SEATS` |
| Big board | **1700 × 520** plane on the −Z wall, bottom y **360** (top 880), z −1094, canvas 1024 × 313, `MeshBasicMaterial` + `CanvasTexture`. Scene-owned, NOT in the GLB — its content is live house-trader data. Counts and statuses only, never profit and loss. The rect is set by the kiosk's occlusion shadow, not by taste; the surround's top edge is `bottom + height + 68` = 948 against a 950 ceiling, so 520 is the maximum height at this bottom | `trading-floor-screen.tsx` · `SCREEN_*` in `build-interior.mjs` |
| Trade tape | **12 saturated slabs**, each **160 × 90**, in TWO lanes at x **±874** (slot 0 left, slot 1 right), y **420**, drifting z **−900 → +720** over **18 s** then wrapping. Green fill means realised gain, red means realised loss, cyan means buy, and slate means flat or unpriced. Dark text shows the source slot's short name (`GENESIS` or `RUNNER`) above side and money (`SELL +$6.97`, `SELL -$3.21`, `BUY $10.00`). No venue or mint labels. Same board query, ONE mesh, ONE atlas, normal blending, **1 draw call**. The lanes move down 100 wu and inward 16 wu; tests retain both desk and projected board margins. | `trading-floor-trade-tape-mesh.tsx` · rules in `trading-floor-trade-tape.ts` |
| Player | VRM/GLB router on the shared `usePlayerCapabilityController` + `TRADING_FLOOR_POLICY`; spawn (0, 780) facing −Z. Walkable Z is **asymmetric**: −1054 at the board wall but **+920** at the door (`TRADING_FLOOR_DOOR_APPROACH_Z`), so the chase camera keeps a 168 wu arm behind the player instead of ending up in front of them. The door still arms — 180 < the 240 interact radius | `trading-floor-interior.tsx` |
| Camera push-out | after the room clamp, the camera is pushed out of any solid it is inside, along the axis of least penetration, clearance 12 | the room clamp knows only the walls, so it parked the camera INSIDE the holo dais at full pitch-down. Local to the trading floor; the shared `room-camera.ts` is untouched | `pushCameraOutOfSolids` |
| Sitting | E or a seat click plays the COVE sit clips on a VRM avatar: `sit_stand_to_sit` → `sit_idle_m`, standing `sit_to_stand_m` → `idle`. Hips eased onto the 85 wu cushion. GLB avatars snap to the seat with no clip | `trading-floor-interior.tsx` · `_cove_sit.glb?v=4` |
| Camera | chase, fov 60, behind 520 / above 260, look Y 180, AABB-clamped to x ±985 (the DESK FACE, not the wall — the desks are 166 tall and the camera Y floor is 140) and z **−1054 to +1088**, asymmetric: neither end is the wall, because the camera must stay BEHIND the player's own ±1054 clamp or the rig inverts and the Exit prompt is culled behind the camera. Seated, the yaw eases to `π − facing` so the view is the desk, not the side wall | `TRADING_FLOOR_CAMERA` |
| Lights | 3, no shadows: ambient 0.85 + hemisphere 1.15 + one non-shadow **directional** 1.15 at (900, 1500, −1100). The point light it replaced measured 0.6% at the walls | `TradingFloorLighting` |
| Hotspots | **monitor** (E within 380wu, label from 760wu) opens the EXISTING Exchange modal on its Trading Floor tab · **door** (E within 240wu) publishes the exit intent · **6 seats** (E within 200wu). One ladder, stand > monitor > door > sit, shared by the E key and the touch USE button | `trading-floor-exit-intent.ts` · `activateTradingFloorUse` |
| Click volumes | 8 invisible boxes: monitor, door and one per seat. Zero draw calls — it is the MATERIAL that is invisible, not the object, so the raycast still lands | `TradingFloorHotspots` |
| Prompts | `WorldLabelsOverlay` DOM capsules — never drei `<Text>`/`<Billboard>`. ONE seat label, moved to the armed seat, not six registered with the overlay. The EXIT prompt is anchored at (270, 880) — head height, just past the player's stop — NOT on the door: at the door the camera is at 1088 and the door plane at 1100, so the door is behind the camera and out of frame | `world-labels-overlay.tsx` |
| Exit spawn | world (0, 2500), derived from Pearl's stand position: clear of BOTH the door prompt band and her talk radius | `character-positions.ts` |
| Mobile | two nipplejs zones + a 76 × 76 USE button (E has no phone equivalent), gated on `useIsMobile()`. All vertical geometry lives in `trading-floor-touch-layout.ts` and is swept by a unit test over safe-area insets {0, 34, 44}, because Playwright does not implement `env(safe-area-inset-*)`. The band shrinks to 160 px on short viewports so the button clears the camera zone on a notched phone in landscape | `components/trading-floor/TradingFloorMobileControls.tsx` · `trading-floor-touch-layout.ts` |

Draw calls, MEASURED with `renderer.info.render.drawCalls` on the WebGPU backend: **24 per frame** before the trade tape, of which **9 were the room** — walls, ceiling, floor slab, trim glow, holo dais, monitor kiosk, the instanced desk row, the instanced chair row and the big board. The trade tape adds exactly **one** (all 12 slabs are quads in a single `BufferGeometry` with a shared atlas), so the room is **10** and the frame is expected at **25**; the 25 is a projection from the +1 and is owed a live re-measurement. The other 15 are 12 Milady VRM submeshes plus overhead; the shared player avatar draws more than the whole room by itself, and reducing that is an avatar-pipeline change, not an interior one. Adding desks or chairs costs nothing: each row is one draw call at any count.

The exterior asset path appears in FOUR places besides `BUILDING_MODELS` — `asset-preload-manifest.ts`, `meshlet/buildings-manifest.ts`, `LandingScene.tsx` and `preview/meshlet-spike-all-12/page.tsx` — all swapped in the same diff. `boot-stream-cohort.ts` keys on the building ID, not the path.

**Strip rules** (run on every cloned building scene, `stripDecorativeMeshes` in `arena-buildings.tsx`):
- Prefix match `Skybox_` → strip (kills the blue hemisphere baked into Yanez assets)
- `BACKDROP_KILL_NAMES` set — currently empty
- `BACKDROP_KILL_MATERIALS` set — currently empty
- `DECORATIVE_PARENT_NAMES` parent match — `Flowers`, `Path`, `Skybox`, `Road`, `Sand`
- `stripGroundPlanes()` — geometric "flat at bottom 5%" check

---

## 3. NPC roster

### 3a. Wandering NPCs — 9 total

3 Milady VRMs + 3 Hermes/Tekk VRMs + 2 chibi VRMs + 1 lobster GLB. Server-driven positions via SSE; client smooths them. Code: `lib/three/arena-npcs.tsx`. Definitions: `packages/shared/src/constants/npc-definitions.ts` (or the demo NPCs in `stores/npc.ts` when SSE is disconnected). The web store filters retired IDs (`wanderer-marlin`, `wanderer-riptide`) as a partial-deploy guard. All VRM sizing is handled by `computeVRMAvatarFit()` from `lib/three/vrm-avatar-sizing.ts` — every humanoid renders at `VRM_AVATAR_TARGET_HEIGHT_WU = 179.2` regardless of native bbox unit convention.

| Species | Count | Asset |
|---|---|---|
| Milady VRM | 3 | `milady-official-{2,7,8}.vrm` (Vivi / Miu / Kyoko — distinct paths required, shared paths cause T-pose collisions) |
| Hermes VRM | 2 | `hermes-female.vrm` (Mira), `hermes-male.vrm` (Cyrus) |
| Tekk VRM | 1 | `tekk.vrm` — uses `SPECIES_TARGET_HEIGHT_WU.tekk = 230` so wings can overshoot the body silhouette |
| Chibi VRM | 2 | `eliza-chibi.vrm?v=2` (Eliza), `milady-chibi.vrm?v=2` (Mila) |
| Lobster GLB | 1 | `models/lobster.glb` (Driftwood) — homeX 3348, homeY 5112, W inner (Phase 6.2 scaled ×1.5 from Phase 6.1) |

> Table drift note (2026-07-22): counts/rows above predate the 8-Milady restore and Adinero (both live in `npc-definitions.ts` but missing here). Full reconciliation pending — `npc-definitions.ts` is authoritative. (Also 2026-07-22: `biggie` is a registry-only EXCLUSIVE avatar — manual per-account DB grant, deliberately NOT a wanderer and NOT in `AGENT_MODELS`; see `3dStructure.md` Last-edit entry.)

### 3b. Building residents — 10 total

One per building, named after the SpongeBob cast. Code: `lib/three/arena-location-npcs.tsx`. Models live under `apps/web/public/models/characters/`.

`spongebob, squidward, sandy, mr-krabs, plankton, patrick, larry, mrs-puff, pearl, flying-dutchman`

### 3c. Player avatar
Renders only in `controlMode === 'player' | 'autonomous'`. Single VRM/GLB driven by your account's selected model. Code: `lib/three/player-avatar.tsx`.

---

## 4. Terrain

Code: `lib/three/arena-terrain.tsx`.

| Item | Config | Code |
|---|---|---|
| Sand floor | `MAP_WIDTH × 3` × `MAP_HEIGHT × 3` = 15360² wu plane, 120×120 segs, TSL height-blend shader | `SandFloor` |
| Sand color ramp | 5-stop: ridge / high / mid / valley / deep | constants ~31 |
| Dune field | summed sin/cos waves + per-vertex noise | `createSandGeometry` |

---

## 5. Ground decorations (procedural scatter)

**Current state (Phase 6.2 2026-05-18):**
- `TARGET_COUNT = 60`
- `EXTENT_X = MAP_WIDTH * 1.4` half-range (scales with MAP_WIDTH; now 11520×1.4=16128wu half-range)
- `MAX_VISIBLE_DIST = 3800` — hard distance gate
- `DECO_INNER_EXCLUSION_R = 800wu` — reduced 1500→800 (Phase 6.2). The 1500wu clear area at center appeared as a "grey disc" of clean lighter sand. 800wu lets scatter fill the central plaza zone (town-center props are now at 800–1000wu radius so they coexist with decos). Ring buildings are at R=5120wu so decos at 800–3800wu band sit well inside the ring.
- 24 cluster centres, 280wu triangular-distribution radius per cluster
- Stable seed (`12345`) — positions don't change between reloads

Code: `MergedDecorationsInner` + `generateDecorations` in `arena-terrain.tsx`.

**Asset list** (`DECO_TYPES`, weighted random):
| Model | Weight | Scale range |
|---|---|---|
| coral-reef1.glb | 3 | 4–15 |
| coral-reef2.glb | 3 | 3–13 |
| coral-reef3.glb | 3 | 3–12 |
| kelp.glb | 3 | 6–15 |
| building-shell.glb | 5 | 2–12 |
| building-seashell.glb | 5 | 2–12 |
| building-anchor.glb | 4 | 3–14 |
| building-barrel.glb | 4 | 3–10 |
| building-chest.glb | 4 | 3–12 |
| building-lantern.glb | 3 | 4–12 |
| crayfish.glb | 3 | 3–10 |
| building-tower2.glb | 2 | 4–14 |

**Render strategy:** all entries → bucketed by `(3×3 grid cell, material UUID)` → `mergeGeometries` per bucket → one Mesh per bucket. Static, `matrixAutoUpdate=false`, default frustum-cull (tight per-bucket AABB).

---

## 6. Town center props (fixed at world origin)

Phase 6.2 positions (spread from original ≤600wu cluster to 800–1000wu ring):

| Component | What it renders | World position | Source |
|---|---|---|---|
| `<QuestNpc>` | Quest-giver NPC standee | (-110, -2, -60) — near center | `lib/three/quest-npc.tsx` |
| `<TownGuide>` | Nori the town-guide NPC | (0, -2, 240) — near center | `lib/three/town-guide.tsx` |
| `<TownDirectorySign>` | Wooden signboard | center (0, y, 0) — currently rendered TWICE in `World3DCanvas.tsx`; L773 diagnostic should be removed | `lib/three/town-directory-sign.tsx` |
| `<BazaarStall>` | `models/bazaar-fish-stall.glb` (400wu tall) | **(-800, -2, 300)** — west plaza ring | `lib/three/bazaar-stall.tsx` |
| `<MarketplaceStall>` | `models/marketplace-food-stall.glb` (450wu tall) | **(800, 4, 300)** — east plaza ring | `lib/three/marketplace-stall.tsx` |
| `<AuctionPodium>` | `models/auction-dome.glb` (380wu tall) + floating `jellyfish.glb` | **(0, 200, -1000)** — north plaza anchor | `lib/three/auction-podium.tsx` |
| `<BountyBoardObject>` | Bounty board (imported but only mounted by some flows) | varies | `lib/three/bounty-board-object.tsx` |

---

## 7. NPC overlays (DOM, screen-projected)

| Component | What it renders | Source |
|---|---|---|
| `<NpcSpeechBubbles>` | Chat bubble divs above NPCs from SSE event stream | `lib/three/npc-speech-bubbles.tsx` |
| `<ActivityIndicators>` | Pulsing spheres above NPCs in combat/conversation/dead | `lib/three/activity-indicators.tsx` |
| `<FloatingTexts3D>` | Token-earn float-ups | `lib/three/floating-text-3d.tsx` |
| `<WorldLabelsOverlayMount>` | The single-root projection useFrame that drives every label div above any anchor | `lib/three/world-labels-overlay.tsx` |

---

## 8. Disabled features (kept in the bundle, currently off)

These mount points exist but render nothing because of `{false && <X />}` gates.

| Component | Why disabled | Code |
|---|---|---|
| `<UnderwaterAtmosphere>` | Overdraw caustic plane — 8–15ms/frame on integrated GPUs even when occluded by other geometry. | `lib/three/underwater-atmosphere.tsx` |
| `<UnderwaterLightRays>` | 7 cone-shaft additive meshes — same overdraw issue. | `lib/three/underwater-light-rays.tsx` |
| `<UnderwaterDecorationsGlb>` | Authored for the old 2560² map; in the 5120² world it appears as a massive floating silhouette. | `arena-terrain.tsx` |
| `<FixedLandmarks>` | Submarine + shipwreck — same issue as UnderwaterDecorationsGlb. | `arena-terrain.tsx` |

To re-enable, flip the `{false && ...}` gates in `World3DCanvas.tsx` / `arena-terrain.tsx`. Each gated thing has a reason — read the comment before re-enabling.

---

## 9. Outstanding cleanups

Tracked here so they don't get lost across sessions:

- [ ] **Duplicate `<TownDirectorySign>` render** — `World3DCanvas.tsx` L773 was added as a diagnostic and should be removed. Net cost: 1 extra mesh tree.
- [ ] **`<BountyBoardObject>` import path** — verify it's actually mounted by any production flow; if not, drop the import.
- [x] **Decoration density per zone** — 2026-05-13: TARGET_COUNT 30→60, annulus 1500–3800wu. Audit script (`scripts/audit-decorations.mjs`) verifies placement.

---

## 10. Recent material changes

Compact log. Single line per change.

- 2026-09-20 — Trading Floor **TRADE TAPE** (commit pending). The house traders' recent verified trades render as 12 emissive slabs flying the hall in two lanes (x ±890, y 520, z −900 → +720 over 18 s, then wrapping) — green gain, red loss, cyan buy, slate where there is no figure; face shows the token name or the venue, never a mint. ONE mesh + ONE atlas = **+1 draw call**; reuses the board's `useHouseTraders` query, so no route, no fetch, no poller. Lane x is pinned on both sides by test (desk face 985 outboard; board-unoccluded-from-spawn inboard, a 1.08x projection rather than a clearance) and mutation-verified. New §2a row; draw-call line 24 → expected 25. No asset bytes, no GLB, no `?v=` bump. Full numbers in `3dStructure.md` §9h.
- 2026-09-19 — Trading Floor becomes the second enterable venue (commit pending). Exterior GLB swapped on slot 6 (`patty-building.glb` → `trading-floor-exterior-opt1-mo-ktx.glb?v=2`, `targetMaxDim` 2200 → 1950, collider 850×498 → 823×720 in the web AND shared tables). New `/trading-floor` stage slot mounts the authored interior hall with a walk-up monitor hotspot that opens the EXISTING Exchange modal on its Trading Floor tab — no second panel. New §2a; §1 gains the slot row; §2 row 6 rewritten.
- 2026-05-25 — Phase 6.4.0 interactive-shell fix documented in `GameFeatures.md` §18a.f (no scene/manifest changes here — blackjack is cove-interior, not world ring).
- 2026-05-25 — Krusty Krab runtime node key corrected to `The_Krusty_Krab` for `childScaleOverrides` + `bodyAnchorChild`; prior `"The Krusty Krab"` key did not match the loaded GLB node.
- 2026-05-18 — Phase 6.2.2: MAX_FOOTPRINT 1800→2000wu; node name bug (`The_Krusty_Krab`/`Squidward_s_House` → literal `"The Krusty Krab"`/`"Squidward's House"`) corrected — Three.js GLTFLoader does NOT sanitize, prior keys were silent no-ops; targetMaxDim messaging-channels 1000→2500, api-integrations 1300→2500, cron-automation 1300→2200, memory-rag 1400→1700; memory-rag childScale 1.4→1.7. Sandy NPC T-pose fixed (meshopt loader + explicit clipAction optionalRoot). §2 rows 2+3+4+6+11 updated.
- 2026-05-18 — Differential child-scale pass for Squidward house (`Squidward_s_House` ×1.4) and Krusty Krab (`The_Krusty_Krab` ×1.5). Both targetMaxDim 1000→1400. Stepping stones and Krusty Krab sign/pole remain at base scale. §2 rows 2+11 updated.
- 2026-05-18 — Phase 6.2: ring R=100→160 (5120wu), grid 240→360 (11520wu). All 12 building positions recomputed. `targetMaxDim` replaces `targetHeight` (max-dim vs Y-only normalization). NPC_INSET_WORLD 1000→1300wu. Sandy DoubleSide fix. DECO_INNER_EXCLUSION_R 1500→800wu. Town-center props spread to 800–1000wu ring. NPC home coords rescaled to Phase 6.2 world.
- 2026-05-18 — Concern 6.0.2: Casino interior scene shipped. No new open-world objects. Casino building onClick in `arena-buildings.tsx` now navigates to `/casino`. §2 casino row updated (interior status SHIPPED).
- 2026-05-18 — Phase 6.1: ring expanded R=72→100 tiles on 240×240 grid. BuildingPedestal stone disc added under each building. All 12 building cx/cy updated in slot table. NPC home coords scaled ×1.5.
- 2026-05-17 — Circle revert + Phase 6.0.1 casino+claw-arcade additions. Ring R=72 on 160×160, then square ring attempted + reverted.
- 2026-05-13 — Ring 68→72 tiles. Decoration retune: TARGET_COUNT 30→60, DECO_INNER_EXCLUSION_R 2700→1500.
- 2026-05-12 — Sandy's Treedome swapped to `sandy_tree_final.glb`. Krusty Krab + Chum Bucket restored from original GLBs (renamed -v2 to bust cache).
- 2026-05-12 — `WorldContent.md` created as new canonical doc (split from 3dStructure.md).
