# Mobile Perf Wave 1 — device classes + phone render profile

**Date:** 2026-08-20 · **Founder approval:** all four decisions approved this session
(30 FPS cap on phones — "give it a shot, I'll try it"; pulled-in draw distance on
phones — yes; phone-tier textures — yes (wave 2); shadows off on phones — yes).
**Branch:** `perf/cold-load-diet` (cv-covefreeze worktree, on origin/staging).
**Authors:** Fable (spec/verify/ship) · Codex (implement) · 3da (review) — per Rule E3.

## Problem

There is no mobile render path. `detectLowEndGpuClass()` (`apps/web/src/lib/three/gpu-tier.ts:101-123`)
returns `true` for ANY coarse-pointer device, folding every phone/tablet into the
Iris-Xe desktop bucket. That flag does exactly three things: forces WebGL2
(`world-stage/WorldStageCanvas.tsx:130-136` — measured 4-5× worse worst-frame than
WebGPU on the same machine), clamps DPR to [0.55, 0.7] (`:65-67`), and starts the
quality governor at tier 1 (ground cover off). Everything else — ~160 draw calls /
700k tris, 14+ animated VRMs, shadows, no FPS management — is byte-identical to
desktop. iPhone 12/13-class and mid Androids are unplayable.

## Deliverable — one diff, five parts

### 1. Device-class module (replaces the single boolean as the render gate)

New `apps/web/src/lib/three/device-class.ts`:

```ts
export type DeviceClass = 'phone' | 'tablet' | 'desktop-low' | 'desktop-capable';
export function detectDeviceClass(): DeviceClass
```

- SSR-safe (`typeof window === 'undefined'` → `'desktop-capable'`, matching today's
  fail-open default direction for capable machines; render-affecting consumers all
  evaluate client-side at module load like today's constants).
- `phone`: touch device (`pointer: coarse` matchMedia OR `navigator.maxTouchPoints > 1`)
  AND `Math.min(screen.width, screen.height) < 768` CSS px.
- `tablet`: touch device, not phone (covers iPad incl. the Mac-UA iPad case via
  maxTouchPoints — same signal as `use-is-mobile.ts`).
- `desktop-low`: not touch, and the existing WebGL probe renderer string matches the
  Intel patterns in `gpu-tier.ts` (`looksIntel`).
- `desktop-capable`: everything else.
- Debug override: `?devclass=phone|tablet|desktop-low|desktop-capable` wins over
  detection (needed for desktop verification and CDP emulation).
- `detectLowEndGpuClass()` KEEPS its current behavior for any caller we don't touch
  this wave; the world-stage constants below switch to `detectDeviceClass()`.
  Desktop behavior must be BYTE-IDENTICAL after this diff: `desktop-low` maps to
  everything `LOW_END_GPU` did on non-touch machines; `desktop-capable` unchanged.

### 2. Backend split — phones/tablets get WebGPU when they have it

In `world-stage/WorldStageCanvas.tsx` (and mirror the same logic in the legacy
`World3DCanvas.tsx` constants so /perf stays consistent):

- `FORCE_WEBGL` today: `IOS_SAFARI || WEBGPU_ABSENT || unhealthyFlag || (!FORCE_WEBGPU && LOW_END_GPU) || ?webgl=1`.
- New: replace the `LOW_END_GPU` term with `deviceClass === 'desktop-low'`.
  Phones/tablets with `navigator.gpu` (Android Chrome, iOS 26 Safari) now get
  WebGPU. Devices without it hit `WEBGPU_ABSENT` and fall back exactly as today.
- KEEP unchanged: iOS-Safari term (black-canvas fix 2026-05-20 — `WEBGPU_ABSENT`
  covers old iOS, but keep the explicit term as belt-and-suspenders), the
  session-storage unhealthy flag, `?webgl=1` / `?webgpu=1` overrides, the silent
  Three.js WebGPU→WebGL2 init fallback, `stampStageColdLoadBackend`.
- ⚠️ TRAP — seaweed: `World3DCanvas.tsx` gates `<MergedSeaweed />` (18,000 blades)
  on `!FORCE_WEBGL`. If phones stop forcing WebGL, that gate would newly ENABLE
  18k animated blades on phones. Gate ground cover on device class too: phone and
  tablet NEVER mount MergedSeaweed / kelp ambient regardless of backend (keep the
  initial quality tier 1 for phone/tablet as it is today for `LOW_END_GPU`).
- ⚠️ TRAP — the Chromium integrated-GPU swap-chain rotation rationale
  (`World3DCanvas.tsx` comment near the createWebGPURenderer block) applies to
  desktop integrated GPUs; that is why `desktop-low` keeps forcing WebGL. Do not
  "simplify" it away.

### 3. Phone render profile (tablet = milder subset)

All keyed on `deviceClass`; desktop values untouched. Add a small
`WORLD_DEVICE_PROFILE` table (same file as the device-class module or a sibling)
so the knobs live in ONE place, not scattered:

| Knob | phone | tablet | desktop (both) |
|---|---|---|---|
| shadows (`WorldStageRoot.tsx:621` world appearance) | `false` | `false` | `true` |
| FPS cap | 30 | none | none |
| fog near/far + camera.far | pulled in (see below) | desktop | desktop |
| `NPC_LOD_FAR_DIST_SQ` (`arena-npcs.tsx:165`) | 2600² | 3600² | 5000² |
| spring-bone LOD tiers (`arena-npcs.tsx` ~:1572) | one notch coarser | as today | as today |
| active full-rate NPC mixers | 8 nearest; rest tick mixer at ~15 Hz | as today | as today |
| `MAX_VISIBLE_CHUNKS` + land-kit budget (`land-kit-pieces.tsx:84`, ~:1056) | 2 chunks / ≤30 draws / ≤120k tris | 3 chunks | 4 / 60 / 250k |
| resident GLB streaming radii (mount 4600² / unmount 5200²) | 3200² / 3800² | as today | as today |
| DPR range | [0.55, 0.7] (unchanged) | [0.55, 0.7] (unchanged) | unchanged |
| ground cover / seaweed / kelp ambient | never | never | as today |

**FPS cap mechanics.** `frameloop="always"` + `StageFrameScheduler`
(`world-stage/use-scene-frame.ts:213`) own the frame; READ that file before
choosing the mechanism, and implement the cap so BOTH the R3F render and the
stage-scheduled per-frame work skip together (a cap that skips gl.render but
still runs all useFrame JS saves almost nothing). Timestamp-gated
(accumulate elapsed, render when ≥ 1000/30 ms) — NOT frame-count-based, so 120 Hz
phones cap correctly. All dt consumers must tolerate ~33 ms deltas (entity interp
is damped-lerp on dt — fine; verify nothing assumes 16 ms). Escape hatch
`?fpscap=0` (off) / `?fpscap=60` for A/B on the founder's phone. No per-frame
allocations in the gate.

**Fog / draw-distance mechanics.** Desktop world fog is [5000, 10500]. Phone
target: fog ≈ [2600, 6000], `camera.far` just beyond fog-far — BUT first read the
actual skydome/backdrop/ocean-plane radii in the world scene and clamp
`camera.far` ≥ the enclosing dome radius OR scale the dome down on phone.
⚠️ Known burn (memory `feedback_threejs_far_plane_dark_void`): a far plane inside
the room/dome diagonal = "dark border that moves with the camera". Verify
visually in browser at multiple camera angles before calling it done. Frustum
culling must key on view-space z (memory: perf r185/14 rule), which it already
does — do not re-derive.

**NPC mixer cap mechanics.** Keep it simple and allocation-free: each frame the
NPC layer already computes camera dist-sq per NPC; on phone, full 60 Hz
`mixer.update` only for the 8 nearest non-far NPCs (possessed/player NPC always
full rate), everyone else accumulates dt and ticks at ~15 Hz. Do NOT add a sort
allocation per frame — reuse the existing distance pass / a preallocated array.

### 4. Boot fixes (device-independent, phones benefit most)

- **Service worker eviction:** `apps/web/public/sw.js:147-166` re-reads every cached
  response body (`res.clone().arrayBuffer()`) inside the eviction loop → tens of MB
  of ArrayBuffer churn after EVERY asset write near the 60 MB cap, during the boot
  fetch burst. Replace with an IndexedDB-free in-cache byte ledger: store per-entry
  byte size once at write time (e.g. a `Content-Length`-first, body-read-fallback
  size recorded in a ledger entry keyed by URL — a small JSON blob in the same
  cache or a Cache header on a synthetic entry), evict oldest using the ledger,
  keep totals incrementally. Bump `CACHE` version. MUST NOT change the v11
  page-signaled deferred-precache protocol (`sw.js:75-93, :191`).
- **Dead Draco loader:** `apps/web/src/hooks/use-gltf-ktx2.ts:40` passes
  `useDraco: true` → drei spins a DRACOLoader against the gstatic CDN on every
  boot. FIRST verify no shipped GLB uses it: script-scan `apps/web/public/models/**`
  + `public/avatars/**` for `KHR_draco_mesh_compression` in the JSON chunk; if zero
  (expected), set `useDraco: false`. If any hit, leave it and report.

### 5. Same-diff docs

- `3dStructure.md`: new "Device classes + mobile render profile" section (the
  table above, file pointers, the seaweed/backend trap), bump Last Audited.
- `FOUNDER-REVIEW.md`: entry — what to test on a phone (staging URL /game; expect:
  loads, steadier feel, softer shadows gone, shorter draw distance; try
  `?fpscap=0` vs default 30), what feedback is wanted (feel of 30 cap, draw
  distance, anything visually broken).
- `deploy-status.md`: ledger entry at push time (orchestrator does this).

## Hard constraints (Kill-the-build — repeat offenders)

- NO drei `<Text>`/`<Billboard>` in world scenes. NO `InstancedMesh + ShaderMaterial`.
  NO per-frame `new Vector3()`/object allocation in any `useFrame`.
- NO runtime `gl.setPixelRatio()` outside R3F's resize path (deleted
  `AdaptiveRendererDpr` blanked the WebGPU swapchain). DPR stays a static Canvas prop.
- NO proxy/placeholder buildings, NO HUD collapse, NO label culling (founder-banned).
- NEVER `bun run dev`. Local verify = `bun run build && bun run start`.
- Desktop (`desktop-low`, `desktop-capable`) render behavior must be UNCHANGED by
  this diff — every new branch keys on phone/tablet.
- Zod/TS strict; kebab-case files.

## Verify loop (before "ready for founder")

1. `bun run build` green (apps/web at minimum).
2. `bun run start` on :3000 → desktop pass: /game renders identically (visual spot
   check via browser), `?devclass=phone` pass: shadows gone, fog pulled in with NO
   dark-void band at any camera angle, FPS cap active (PerfHUD ~30), seaweed absent,
   world still fully playable.
3. CDP mobile emulation (Emulation.setDeviceMetricsOverride width 390 mobile:true,
   NOT --window-size — Chrome clamps below ~500px) for layout + touch-path sanity.
4. sw.js: cold load with DevTools → no repeated multi-MB arrayBuffer churn;
   cache still populates; deferred precache still fires.
5. Real-phone verdict = founder (FOUNDER-REVIEW entry). Do not claim "done".

## Out of scope (wave 2+, already founder-approved where noted)

Phone-tier 512² textures (approved), KTX2 for VRM textures + shared VRM texture
cache + location-NPC GLB compression (491→~250 MB VRAM), VRM precache, mobile
field-telemetry probe lane, PixiJS 2D fallback revival (not planned).
