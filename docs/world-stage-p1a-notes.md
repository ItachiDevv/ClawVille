# World stage P1a implementation notes

Date: 2026-07-25  
Branch: `feat/world-stage-p0a`  
State: implemented and locally verified; awaiting Fable/Iris-Xe browser verification

## What moved

- `apps/web/src/app/game/{layout,page}.tsx` moved to
  `apps/web/src/app/(world)/game/`; `/game` is unchanged.
- `apps/web/src/app/(world)/layout.tsx` now mounts the client
  `WorldStageRoot` once for the route group.
- The game page no longer imports or mounts `World3DCanvas`. It retains the
  existing `SeaLoadingScreen`, streams, hydration, preloads, HUD, modals, and
  gameplay effects.
- `WorldScene`/`WorldSceneContents` is a shared export from
  `World3DCanvas.tsx`. The production stage and legacy `World3DCanvas` render
  the same scene subtree; there is no scene fork.
- The production manifest contains one scene, `world`, with camera
  `fov=50`, `near=1`, `far=11500`, `position=[0,600,1300]`.
- The module-level stage store and frame diagnostics reset before each
  physical production-stage mount. `/game` and `/perf/stage` therefore do not
  inherit one another's scenes, pending request, pause state, counters, or
  diagnostics.

## Behavior and ownership

The stage is the sole `/game` owner of Canvas, renderer construction, root
background/fog/clear/shadow state, persistent camera, and frameloop.
`WorldWarmup` uses a stage adapter: pause/resume requests call
`setRenderPaused`, while only the stage's Canvas controller touches R3F
`setFrameloop`. The initial on-created pause remains synchronous so no full
world frame can upload the scene before warmup.

The legacy canvas-ready self-heal (`kickRenderLoop`, including the `3f0dd4c3`
return-hang watchdog) remains active. This is important because GamePage's
mount gate can mount `SeaLoadingScreen` after the persistent layout begins
initializing; the watchdog reasserts `__W3D_CANVAS_READY` after any late reset,
and stage warmup republishes both readiness halves before its
generation-matched `ackReady`.

The page layer is pointer-transparent at its empty full-screen shell. Concrete
direct HUD/modal roots retain pointer events, while direct roots explicitly
marked `pointer-events-none` stay click-through and their explicit
`pointer-events-auto` controls remain interactive. This preserves the canvas
hit surface for OrbitControls, empty-world camera input, building/NPC/land
hitboxes, and mobile taps without disabling HUD buttons. The existing
programmatic fast-travel `clickPath` visuals remain; ground click-to-move was
already intentionally removed and is not resurrected by P1a.

The world's internal `useFrame` callbacks intentionally remain plain
`useFrame` in P1a. `world` is the only production slot and is always active
after boot. Converting these owners to `useSceneFrame` is P1b work before Cove
can become a simultaneously resident hidden slot.

## Canvas-level disposition

| Feature | P1a disposition | Reason / parity detail |
|---|---|---|
| World scene subtree | **SHARED / ADOPTED** | `WorldSceneContents` remains one implementation for stage and legacy Canvas. All scene geometry, gameplay controllers, and mount order are retained. |
| Async renderer factory | **ADOPTED into stage for `/game`** | Static `three/webgpu` namespace only; P0b per-DOM-canvas promise and health ownership remain. Legacy factory stays for arena/perf. |
| GPU query overrides | **ADOPTED** | `?webgpu=1` bypasses the low-end force-WebGL gate; `?webgl=1` forces WebGL; `?meshlets=1` implies WebGPU when available. |
| DPR | **ADOPTED with brief-directed split** | Stage low-end is exactly `[0.5,0.65]`, standard `[0.75,1]`. Current legacy code was `[0.55,0.7]` despite the brief calling `[0.5,0.65]` exact; legacy stays unchanged to avoid an arena/perf behavior change. |
| Reversed depth | **ADOPTED** | Every stage renderer generation uses `reversedDepthBuffer=!USE_MESHLET_BUILDINGS`; meshlets remain conventional depth. |
| Clear/background/fog/shadows | **ADOPTED as slot state** | Pending/active world owns `SKY_COLOR`, opaque clear, fog `5000..10500`, and shadows before compile/warm draw. Stable Color/Fog objects restore their prior root state on release. |
| `_roots` StrictMode guard | **ADOPTED** | Stage captures the exact root entry before the async factory's first await and restores it, only when absent, before native-loop invalidation on resume. |
| P0b renderer health | **ADOPTED / authoritative** | Device-loss, sustained uncaptured-error, one same-canvas recreation, session-sticky WebGL fallback, WebGL context loss/restore, wake input reset, delta clamp, R3F size resync, and visible-canvas adoption remain. The old world `reason==='unknown'` page reload is not used on `/game`. |
| Resize / first-paint healer | **ADOPTED** | P0b R3F-state resize path remains; `WorldWarmup` still runs the proven post-resume first-paint size sync. No bare post-paint DPR/size mutation was added. |
| `WorldWarmup` | **SHARED / ADOPTED** | LoadingManager barrier, commit opportunity, two zero-new scans, progressive upload, `compileAsync`, one controlled warm render, no-progress and absolute fuses, post-VRM compile, and 60-second gentle late-texture scans remain. |
| Legacy `__W3D_*` / progress flags | **ADOPTED** | `__W3D`, `__W3D_step`, optional renderer metrics, canvas-ready self-heal, upload totals/done, textures-ready, progress, and combined ready stay available; `SeaLoadingScreen` is unchanged. |
| Generation readiness | **ADOPTED** | Stage marks the matching world generation warming and calls `ackReady` only if scene/generation/request still match. |
| Adaptive PerfAudit/governor | **SHARED / ADOPTED** | `WorldScene` runs the same default adaptive flags and `?fast=1` behavior. Manual perf flags remain on legacy `/perf`. |
| VRM/texture diagnostic glue | **SHARED / ADOPTED** | `VRM_METRICS_ENABLED`, late bulk-VRM compile, `__R3F`, `__CV_STORES__`, and optional upload/renderer metrics remain in the shared warmup. |
| Meshlet experimental glue | **SHARED / ADOPTED** | `?meshlets=1` still swaps only building rendering, remains in-tree, forces WebGPU when available, and disables reversed depth. |
| KTX2/Meshopt setup | **SHARED / ADOPTED** | Both setup components retain their original order before compressed scene consumers. Stage's existing KTX2 setup is harmless belt-and-suspenders initialization. |
| DOM labels/resize bridge | **SHARED / ADOPTED** | `WorldLabelsOverlayMount`, NPC speech DOM, projection/ResizeObserver behavior, and all label gates remain in the shared subtree. |
| Cameras/controls | **SHARED scene logic + stage camera ownership** | Stage installs the exact world camera as `state.camera`; existing follow/WASD/arrow/OrbitControls mutate that same object. No JSX camera was added. |
| Lights and gameplay scene objects | **SHARED / ADOPTED** | Existing lights, fog gate, terrain, land, buildings, NPCs, player, click path, portals, FX, and perf-group names are unchanged. |
| Frameloop | **ADOPTED into stage** | Warmup never calls R3F `setFrameloop` on the stage path. Stage store owns pause intent; StageLoopController applies it and invalidates after native-root rearm. |
| Canvas mount/ledger probes | **ADOPTED** | Physical Canvas count, slot-root resource ledger, listener accounting, recovery counters, and frame diagnostics remain. |
| `ContextLostFallback` | **STAYS legacy, not newly mounted** | It was defined but not mounted before P1a. `/game` uses the stronger P0b recovery policy; this slice does not invent a new UI/error behavior. |
| Legacy `World3DCanvas` | **STAYS for arena/perf** | Default export, legacy renderer, legacy DPR `[0.55,0.7]`, arena camera `[0,560,1000]`, perf flags, and warmup behavior remain. |
| `/cove`, `/kelp`, `/arena`, `/activity/**` | **UNCHANGED** | No route, renderer, stream, server, or behavior change in this slice. Cove joins in P1b. |

## Verification evidence

### Build and TypeScript

- `bun run build`: PASS, 9/9 tasks; Next production build reports `/game` as
  dynamic (`ƒ`).
- `cd apps/web && bunx tsc --noEmit`: PASS, zero diagnostics.

### Force-dynamic cache guard

Against the rebuilt local production server:

```text
HTTP/1.1 200 OK
Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate
```

The nested moved `game/layout.tsx` still exports `dynamic='force-dynamic'`.

### Persistent-stage probes

Fresh JSON evidence:

- `docs/world-stage-p1a-probe-webgpu.json`
  - PASS, backend `webgpu`
  - 102/102 transitions; 3 warmups
  - Canvas mounts 1; hidden windows checked 102
  - hidden frame/camera/store/active-growth violations 0
  - listener delta 0; listener underflow 0
  - transition errors 0; renderer recoveries 0
  - post-warmup heap growth `0.015891` (1.589%, threshold 15%)
- `docs/world-stage-p1a-probe-webgl.json`
  - PASS, backend `webgl`
  - 102/102 transitions; 3 warmups
  - Canvas mounts 1; hidden windows checked 102
  - hidden frame/camera/store/active-growth violations 0
  - listener delta 0; listener underflow 0
  - transition errors 0; renderer recoveries 0
  - post-warmup heap growth `0.012076` (1.208%, threshold 15%)

Both lanes retain the already-documented anonymous-auth 401 resource error and
`THREE.Clock` deprecation warning. Neither is a new probe assertion failure.

## Deviations and explicit decisions

- The P1a brief said low-end DPR `[0.5,0.65]`, but that was a stale doc value —
  the checked-in legacy constant is `[0.55,0.7]`. Corrected in review (Fable,
  same slice): the stage now uses `[0.55,0.7]` / `[0.75,1]`, EXACT parity with
  live `World3DCanvas.tsx:140-141`. Live code wins over docs per repo
  precedence. `/game` resolution is unchanged by this migration.
- The stage transition timeout is 45 seconds for `/game`, not the P0 proof
  default 20 seconds, so it cannot fail before WorldWarmup's proven 40-second
  absolute fuse. `SeaLoadingScreen` remains the visible first-boot UX.
- The initial requested scene may render while `activeScene` is still null,
  behind the opaque loader/transition. This lets the controlled compile/warm
  draw see the real world subtree. Once a scene is active, ordinary hidden-slot
  visibility semantics are unchanged.

## Fable/Iris-Xe browser review

This implementation does not claim visual or interaction parity. Reviewer
should verify on the real `/game` route:

1. first cold boot shows one loading screen and hands off atomically to the
   rendered world (no blue/black intermediate frame, no 85-90% stall);
2. guest spawn and existing control-mode promotion;
3. WASD, arrow orbit, mouse orbit/zoom, and mobile joysticks;
4. empty-world pointer drag/tap, programmatic fast-travel path visuals, NPC
   clicks, building/stall/Cove interactions, and land sign hitboxes;
5. NPC/player/VRM animation, labels/speech projection, minimap, and HUD/modal
   clicks;
6. fog, background, lighting, shadows, camera follow, and far-plane appearance
   against the pre-P1a `/game`;
7. sustained FPS against the ~40-45 Iris-Xe baseline and clean console;
8. `/arena` smoke (legacy `World3DCanvas`);
9. `/game` -> `/perf/stage?stage=1` and back, confirming neither stage wedges.
