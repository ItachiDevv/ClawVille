# 3D Architect — Knowledge Base

## Standing Rule (read first)
- [Three-Doc Standing Rule](standing-rules/three-doc-standing-rule.md) — Abide by `3dStructure.md` for all visual/3D decisions; `GameFeatures.md` for gameplay; `ARCHITECTURE.md` for tech stack. Unless the main session tells you to change behavior, do NOT deviate from what these docs specify. Every 3D code change requires a same-diff update to `3dStructure.md` (and a "Last Audited" bump). Live code > doc > CLAUDE.md > memory; memory is advisory only. Set 2026-04-17.

## Gotchas
- [VRM MToon materials break under MeshStandardMaterial color lerp](gotchas/vrm-color-tinting-mtoon-breaks.md) — skip applyColorTint() entirely for VRM avatars; store petColor in Zustand but do not apply visually
- [MeshBasicNodeMaterial ignores scene fog — backdrop renders as hard wall](gotchas/meshbasicnodematerial-ignores-fog.md) — backdrop must be past camera.far or have its own opacityNode distance fade; fog does not apply
- [terrainYRef init 0 causes 4-unit spawn float](gotchas/terrain-yref-init-zero-causes-spawn-float.md) — init to -2 (sand floor Y) so pet spawns flush; 0 causes visible 200ms drift down
- [InstancedMesh + ShaderMaterial crashes WebGPU](gotchas/webgpu-instancedmesh-shadermaterial.md) — silent crash, zero console errors
- [drei Text/Billboard crashes Intel Iris Xe](gotchas/intel-iris-drei-text-crash.md) — hard GPU crash on integrated graphics
- [Vegetation must use MeshBasicMaterial on WebGPU](gotchas/seaweed-meshbasic-webgpu.md) — ShaderMaterial vertex animation fails silently
- [three-stdlib KTX2Loader.detectSupport() crashes on WebGPU](gotchas/three-stdlib-ktx2loader-webgpu-broken.md) — uses renderer.extensions.has() (WebGL only); use three/addons KTX2Loader instead
- [lobster.glb faces +Z at rotation.y=0 — THIRD REWRITE 2026-04-16 late PM](gotchas/lobster-faces-plus-z-at-rot-zero-empirical.md) — +Z proven by clean side-view screenshot (no orbit); formula: atan2(worldVx,worldVz); DIR_ROTATION: down=0,up=PI,right=PI/2,left=-PI/2,idle=0; +X claim from AM session was WRONG (camera orbited)
- [Camera-relative movement breaks on mobile with OrbitControls](gotchas/camera-relative-movement-breaks-on-mobile-orbitcontrols.md) — touch orbiting accumulates ~180° over 10s, inverts camForward.xz; use camera-relative for keyboard (fixed 2026-04-21), disable OrbitControls touch rotation if mobile inversion recurs
- [holdMs zeroed on release kills charge classifier — always reads 0](gotchas/holdms-reset-on-release-kills-classifier.md) — `holdMs = spaceDown ? holdMs+dt*1000 : 0` zeros holdMs in the same frame as release; classifier reads 0, quick branch always fires; fix: accumulate while held only, reset on new press in `case 'grounded'`
- [Local MAP_WIDTH/MAP_HEIGHT constants cause silent sync bugs](gotchas/local-constants-vs-imports-sync.md) — arena-terrain, arena-npcs, merged-seaweed all had local duplicates; import from tilemap-data.ts
- [Location NPC village center tile coords must match grid center](gotchas/location-npc-village-center-tile-coords.md) — must always be MAP_COLS/2, MAP_ROWS/2; current is (80,80) for the 160x160 grid
- [applyStationaryIdleAnimation must NOT add Math.PI to rotation.y](gotchas/location-npc-double-pi-facing.md) — inner animGroup gets +PI stacked on outer facingRotY (which already has +PI); NPCs face 180° wrong
- [arena-location-npcs JSDoc said +Z model but code was -Z](gotchas/location-npc-comment-mismatch.md) — comment mismatch fixed 2026-04-13; code was always correct; SpongeBob GLBs assumed -Z
- [NPC terrain-raycast stagger — seed MUST be integer](gotchas/synchronized-terrain-raycasts-spike.md) — idToSeed() returns FLOAT; (frame + float) % N === 0 never fires; must Math.round(seed)
- [useFrame ref mutation does not trigger React re-render](gotchas/useframe-mutation-no-react-rerender.md) — mutating useRef inside useFrame is invisible to React; pair with useState + setTexts([...alive]) to trigger renders
- [useMemo geo/mat passed as props needs explicit useEffect dispose](gotchas/usememo-geo-mat-needs-dispose.md) — R3F only auto-disposes intrinsic attach syntax; geometry={geo} material={mat} props require manual useEffect cleanup
- [Date.now() in render body is stale — bubbles never auto-expire](gotchas/stale-date-now-in-render.md) — Date.now() in JSX is only fresh on re-renders; add a 1s setInterval tick state to force re-renders for expiry checks
- [Box3.setFromObject() inflates bbox on SkinnedMesh scenes](gotchas/skinned-mesh-bbox-inflation.md) — bind-pose world matrix can inflate Y by 60-100x; traverse only non-SkinnedMesh nodes with geometry bbox + matrixWorld instead
- [Building GLB normalization must use height (size.y), not max(w,h,d)](gotchas/building-normalization-use-height-not-maxdim.md) — wide/squat buildings get width as max-dim, crushing height to 210-416 instead of 800; always normalize by size.y
- [Decorative child meshes inflate XZ bbox and trigger MAX_FOOTPRINT cap](gotchas/decorative-meshes-inflate-xz-bbox.md) — Flowers/Path groups in pineapple-house.glb bloat XZ to 1852wu, triggering footprint cap and shrinking height to 432; fix: stripDecorativeMeshes() before stripGroundPlanes()
- [Building GLB pivot offset — geometry far from scene origin (XZ rotation-aware + Y grounding fix)](gotchas/building-glb-pivot-offset-far-from-scene-origin.md) — inner group carries ALL three offsets: -pivotOffsetX/Z (XZ centering, rotation-safe) and -pivotOffsetY (Y grounding: bbox.min.y*scale); cures floating (min.y>0), underground (min.y<0), and XZ drift at any rotY
- [stripGroundPlanes full-bounds must use non-skinned bbox](gotchas/strip-ground-planes-skinned-mesh-inflation.md) — setFromObject inflates fullHeight for scenes with rigged nodes, causing real structural geometry to be wrongly stripped as a "ground plane"
- [NPC bbox normalization must use bbox.max.y not size.y](gotchas/npc-scale-bbox-max-y-not-size-y.md) — size.y inflates h when geometry extends below pivot; use max.y for above-pivot visual height; also tighten CLAMP_MAX to CH/0.5; make scaleOverride unconditional
- [GLB pivot not at feet — characters render underground](gotchas/pivot-not-at-feet-y-offset.md) — humanoid/anime GLBs pivot at waist; at NPC_SCALE=50 the offset is 25-75 world units underground; fix: measure localMinY * scale and subtract from position.y each frame
- [PET_SCALE must be calibrated against actual GLB bbox — never assume from comments](gotchas/pet-scale-vs-glb-native-height.md) — lobster.glb native height=1.12; PET_SCALE=20 gave 22.4 wu (2× smaller than NPC 45 wu); verify with GLTF accessor bounds before setting flat scale constants

## WebGPU
- [WebGPU renderer setup with fallback](webgpu/renderer-setup-fallback.md) — detection, init, WebGL fallback pattern

## Performance
- [Fog density directly controls fragment count on Iris Xe](performance/fog-density-iris-xe-regression.md) — fog far > camera.far wastes GPU; pushing 1200/6400→1800/9000 dropped FPS 90→50 on Iris Xe; always keep fog far ≤ camera.far
- [Draw call reduction techniques](performance/draw-call-batching.md) — instancing, merging, LOD, measurement targets
- [Deferred useGLTF.preload() via rAF](performance/deferred-preloads-pattern.md) — move non-critical preloads post-paint; rAF inside useEffect; Suspense fallback={null} absorbs cache-miss throws
- [compileAsync eliminates post-mount pipeline hitch](performance/compile-async-precompile.md) — call AFTER first R3F commit (not in onCreated); rAF-gate inside child component; no-op guard for WebGL
- [Draco compression results + drei auto-decode](performance/draco-compression-results.md) — texture-heavy GLBs barely compress; geometry-heavy get 5-20%; drei DRACOLoader is zero-config

## Patterns
- [Jump system: module-scoped state + JumpTicker](patterns/jump-system-module-scoped-state.md) — charge-and-release (2026-04-21): hold SPACE on ground → charge bar fills → release proportional launch (tap=33wu, full charge=1531wu); 5 phases: grounded/charging/quick/launch/sinking; no apex-freeze, no peak clamp; 'charging' is not airborne; idle rotation freeze preserves last facing
- [drei Html for NPC labels and speech bubbles](patterns/drei-html-npc-labels-bubbles.md) — DOM overlay, safe on Iris Xe; use for all NPC name labels and chat bubbles (never use drei Text/Billboard)
- [ClawVille world proportion constants](patterns/clawville-world-proportions.md) — canonical building ring coords, heights, camera, seaweed exclusion radii — updated 2026-04-15 for 160x160 square map (5120x5120)
- [NPC possession WASD controller](patterns/npc-possession-controller.md) — WASD drives possessed NPC, wander skips it via lazy-require circular-dep workaround
- [Arrow key orbital camera rotation](patterns/orbit-controls-arrow-key-rotation.md) — spherical coords to rotate OrbitControls view; separate WASD pan from arrow key orbit
- [FPS-style follow camera with OrbitControls](patterns/fps-follow-camera-orbit-controls.md) — lerp target + enforce radial distance; controlMode routing; scratch vectors to avoid GC
- [TSL MeshStandardNodeMaterial sand terrain](patterns/tsl-node-material-sand.md) — colorNode/roughnessNode/normalNode + vertexColor() + positionLocal height-tint pattern
- [TSL underwater atmosphere](patterns/tsl-underwater-atmosphere.md) — caustic plane (MeshBasicNodeMaterial + AdditiveBlending + uv()), depth backdrop (gradient via uv().y mix), dust particles (PointsNodeMaterial + positionNode fract drift)
- [TSL volumetric light rays](patterns/tsl-volumetric-light-rays.md) — open-ended CylinderGeometry cones + AdditiveBlending + sin(time) pulsing opacityNode, 7 draw calls, zero CPU
- [Multi-variant merged seaweed with per-blade TSL amplitude](patterns/merged-seaweed-multivariant.md) — 3 blade shapes, cluster distribution, aAmplitude attribute drives per-variant sway in TSL, two-wave oceanic motion

- [Mixamo → VRM retarget pipeline](patterns/vrm-mixamo-retarget.md) — bone name map + track rewrite at load time, VRMCharacterAnimator crossfade, VRM faces -Z (opposite of lobster), no tinting, feet at origin
- [VRM wandering NPC pattern](patterns/vrm-wandering-npc.md) — VRMNpcMesh in arena-npcs, VRM_NPC_SCALE=28 (45wu target), VRM_DIR_ROTATION, no pivot offset, no tint, single-instance-per-path cache constraint, preload at module scope
- [Universal procedural character animation](patterns/universal-character-animation.md) — spatial mesh analysis + per-type motion profiles, softLerp hot path, routes 9 new GLBs while preserving LobsterAnimator
- [Companion NPC pattern](patterns/companion-npc-pattern.md) — passive NPC beside primary; same NpcMesh with showLabel=false; seed+17 for staggered raycasts; rotYOffset field on NpcModelConfig corrects +X-forward GLBs (Gary=-π/2)
- [KTX2Loader wiring for drei useGLTF with WebGPU support](patterns/ktx2-loader-wiring.md) — singleton + Canvas component + extendLoader; basis WASM from three/examples/jsm/libs/basis; three/addons KTX2Loader required (not three-stdlib)

- [WebP texture compression for GLBs](performance/webp-texture-compression.md) — gltf-transform+sharp converts PNG→WebP in GLBs (83% P1 / 66% P2 wire savings); includes long-task regression warning
- [KTX2 UASTC vs WebP wire size](performance/ktx2-uastc-vs-webp-sizing.md) — UASTC is 4-5x LARGER than WebP on wire for cartoon GLBs; ETC1S is wire-comparable but lower quality; UASTC only wins on GPU memory
- [Staggered GPU texture uploads via initTexture()](performance/staggered-texture-upload.md) — renderer.initTexture(tex) per-frame (2/rAF) spreads 400ms+ WebP decode+upload long task; works on both WebGL r170 and WebGPU r182

## Solutions
- [mergeGeometries dispose-after-merge is safe — data is copied](solutions/merge-geometries-dispose-order-safe.md) — mergeAttributes() uses TypedArray.set() to copy; dispose only removes GPU buffers; merged geo is independent
- [Lobster model facing + correct atan2 formula + screen-relative movement](solutions/camera-relative-joystick-input.md) — lobster.glb faces +Z (THIRD REWRITE 2026-04-16 late PM — clean side-view); use atan2(vx,vy); DIR_ROTATION down=0,up=PI,right=PI/2,left=-PI/2,idle=0; movement SCREEN-RELATIVE
- [Avatar scale-down pass 2026-04-16](solutions/avatar-scale-down-2026-04-16.md) — PET_SCALE 55→33, TARGET_NPC_HEIGHT 120→75, CHARACTER_HEIGHT 140→90, SPEED 200→320; HARD_MAX and scaleOverride must update proportionally when target heights change

- [Full movement audit 2026-04-14 — screen-relative verified correct](patterns/full-movement-audit-2026-04-13.md) — screen-relative movement confirmed; camera-relative revert documented; -Z model formulas verified
