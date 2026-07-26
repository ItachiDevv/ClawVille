# World stage P0a — what changed

## Files added

- `apps/web/src/components/three/world-stage/WorldStageCanvas.tsx`
  - One unkeyed R3F v9 Canvas with literal `frameloop="always"` at creation.
  - Per-canvas async WebGPU renderer promise with exact pre-init DPR sizing, an 8s init bound, and one force-WebGL retry on the same DOM canvas.
  - Persistent scene subtrees, persistent camera objects, the single frame scheduler, transition overlay, and physical-canvas mount instrumentation.
- `apps/web/src/components/three/world-stage/stage-store.ts`
  - Zustand slot registry with lifecycle status, monotonic generations, pending/active scene state, generation-checked readiness/camera/frame acknowledgements, frame counters, and stage-owned listener instrumentation.
- `apps/web/src/components/three/world-stage/stage-camera.ts`
  - Installs exactly one persistent per-scene `PerspectiveCamera` through the live R3F state and keeps all scene-camera aspects current on resize.
- `apps/web/src/components/three/world-stage/StageTransition.tsx`
  - Cancellable `idle → fadingOut → awaiting → fadingIn → idle` DOM transition.
  - Awaiting requires the requested generation's scene readiness, camera installation, and first controlled frame. A 20s timeout stays opaque and presents an error message.
- `apps/web/src/components/three/world-stage/use-scene-frame.ts`
  - `useSceneFrame(sceneId, callback)` registration plus one root `useFrame` scheduler. Only the active scene's callbacks run.
- `apps/web/src/app/perf/stage/page.tsx`
  - Server-side development/`?stage=1` guard. The route is not linked from navigation.
- `apps/web/src/app/perf/stage/stage-proof.tsx`
  - Resident `alpha` teal boxes and `beta` orange spheres, distinct cameras, a first-activation 1s warmup, rapid-switch buttons, and DOM instrumentation.

`3dStructure.md` was updated in the same diff with the P0a render architecture and isolation boundary.

## Renderer extraction

The optional `createWebGPURenderer` extraction from `World3DCanvas.tsx` was deferred. The live factory is coupled to world-only DPR, GPU-tier, reversed-depth, meshlet, warmup, and fallback behavior; its surrounding fallback currently creates a fresh canvas. Extracting that behavior would not be a zero-risk, byte-identical change and would conflict with P0a's same-DOM-canvas invariant.

P0a therefore duplicates the small renderer factory inside `WorldStageCanvas.tsx`, following the existing Kelp same-canvas/WeakMap pattern. Consolidation belongs in P1 after the live renderer fallback contract is made compatible.

## Deviations

There are no functional deviations from the P0a brief. The route uses a server guard plus a route-local client proof component so production-bundle query gating does not depend on `useSearchParams` or a Suspense boundary.

The listener panel reports a measured stage-owned count delta from a stable baseline. It is expected to remain `0` in P0a because the stage itself installs no window listeners; future stage listeners must use the counted helper in `stage-store.ts`.

## Driving the proof page

Production-bundle path:

```powershell
bun run build
bun run start
```

Open `http://localhost:3000/perf/stage?stage=1`.

Development mode also allows `/perf/stage` without the query flag, although the project-standard browser path remains the production bundle above.

1. Wait for `alpha` to pass through `warming` and settle at `resident`.
2. Click **Go beta**. The beta frame counter should advance while alpha's counter freezes.
3. Click **Go alpha**. Alpha resumes from its prior camera/scene state while beta freezes.
4. Rapidly alternate both buttons during `fadingOut` or `awaiting`; the latest generation must settle without an infinite black overlay.
5. Confirm `canvas remount counter` stays `1` and `window listener count delta` stays `0`.

## Verification

- `bun run build` from the repository root: green.
- `bunx tsc --noEmit` from `apps/web`: green.
- Browser verification is intentionally left to the reviewer per the P0a brief.
