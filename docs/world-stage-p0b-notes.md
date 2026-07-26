# Persistent world stage P0b notes

Date: 2026-07-25  
Scope: isolated `/perf/stage?stage=1` diagnostic only  
Branch baseline: `feat/world-stage-p0a` at `6e95b9dc`

P0b adds the Cove compatibility spike, shared renderer-health policy,
per-slot resource ledger, and scripted transition gate. It does not mount the
stage on `/game`, `/cove`, `/kelp`, `/arena`, or `/activity/**`, and it changes
no live route behavior.

## Cove-on-stage compatibility

**VERDICT: COMPATIBLE for the representative Cove render surface; no
material, texture, light, or shader repair was required in the spike.**

The spike mounts a clone of the production optimized interior asset,
`/models/cove/cove-interior-cleaned-v1-ktx.glb?v=6`, through the shared KTX2
loader setup. It therefore exercises the real room geometry, the GLB's PBR
materials, and all 12 textures found by the ledger. It adds representative
surfaces for Cove presentation that lives outside the GLB:

| Cove surface | Representative coverage |
|---|---|
| Baked room materials and KTX2 textures | Exact production optimized interior GLB, cloned and normalized around an in-room camera |
| Lit cabinet/prop surfaces | `MeshStandardMaterial`, including color, emissive intensity, roughness, and metalness |
| Canvas-authored signs | `CanvasTexture` on transparent, double-sided `MeshBasicMaterial`, with generated mipmaps |
| Cove light classes | Exactly three light objects/classes: ambient, hemisphere, and one non-shadowing point light |
| Motion under the stage scheduler | One rotating lit prop driven by `useSceneFrame('cove-spike', ...)` |

The representative mount intentionally excludes:

- the live `CoveInteriorScene` component itself, because it imports the
  route-owned Cove store, avatar/auth hooks, input listeners, camera controller,
  world-label DOM overlay, modal hit targets, FPS fallback state, and plain
  `three` types; mounting it would introduce live-route state and interaction
  side effects into a renderer-compatibility spike;
- the player VRM/GLB avatar, locomotion animator, room collision, camera clamp,
  E/touch controls, modal openers, invisible raycast hotspots, and label
  overlay, because those test migration plumbing and interaction parity rather
  than a Cove material/texture/light class;
- the fallback interior GLB, because P0b targets the normal optimized asset
  path; fallback residency and switching remain P1 integration work;
- Cove's scene-level fog and production-scale coordinates. Fog is
  renderer-scene state, not a material/texture/light class, and needs explicit
  slot ownership when real persistent scenes are introduced;
- the dead procedural `SlotCabinets` render path. Its implementation remains in
  the production Cove source, but the live `InteriorScene` does not mount it
  because the cabinets are baked into the GLB.

The 8-unit normalization and diagnostic camera inside the closed room are
deliberate compatibility framing, not production-camera composition approval.

### Backend evidence

| Lane | Automated render/transition evidence | Console evidence | Visual-evidence boundary |
|---|---|---|---|
| WebGPU (`?stage=1`, selected backend `webgpu`) | The optimized asset loaded; `cove-spike` repeatedly reached an idle completed transition; its active frame callback advanced; the ledger found 14 geometries and 12 textures; no transition or recovery error was recorded. | One `401 Unauthorized` resource error and one `THREE.Clock` deprecation warning. The 401 is the anonymous `auth-me` provider request mounted by the app layout, not a Cove asset or stage transition failure. | The headless probe proves loading, transition completion, callback activity, and a populated render graph. It is not a screenshot or human visual approval. |
| Forced WebGL (`?stage=1&webgl=1`, selected backend `webgl`) | The same asset met the same transition, callback, ledger, and zero-recovery observations. | The same anonymous-auth 401 and `THREE.Clock` warning; no additional WebGL material/shader warning was observed. | Same limit: scripted render evidence, not reviewer visual approval. |

An initial local screenshot exposed that the first camera framing showed the
representative sign/prop without proving the room surface and that the first
lighting draft exceeded the three-light cap. The implementation was corrected
to an in-room camera (`[0, -1.4, -2.4]`, looking at `[0, -1.4, 0]`) and exactly
three light objects before final evidence collection. Reviewer/Fable visual
sign-off remains pending and is not claimed here.

### Exact P1 Cove fix list

There is no P1 material/shader compatibility fix from this spike. Remaining P1
work is integration:

1. Change the real Cove render subtree and `CoveLighting` to the unified
   `three/webgpu` namespace, resolving loader/R3F types without changing the
   represented materials or light budget.
2. Replace Cove's route-local `useFrame` owners with
   `useSceneFrame('cove', ...)` so a resident hidden Cove slot performs no
   camera, avatar, FPS, or interaction-frame work.
3. Give Cove an explicit slot lifecycle: optimized/fallback asset warming,
   exact-generation ready acknowledgement, and teardown/eviction that does not
   dispose resources still shared by another GLTF consumer.
4. Move Cove camera pose, fog, background, and light activation into per-slot
   state. A hidden group cannot isolate scene-level fog/background, and hidden
   lights must not illuminate another active slot.
5. Keep Cove HUD, labels, modal controls, and human/agent economy behavior
   outside the persistent Canvas while preserving their stores and
   accessibility.
6. Exercise the real avatar, hotspots, fallback GLB, world-label projection,
   and return navigation under both backends, run the P1 gate, and obtain
   reviewer visual sign-off before any live route cutover.

## Renderer health policy: Kelp versus world stage

| Behavior | P0b disposition | World-stage policy |
|---|---|---|
| Canonical low-end GPU classification and DPR | Adopted | Imports `detectLowEndGpuClass()` from `gpu-tier.ts`; removes the P0a duplicate. |
| 8-second initialization timeout | Adopted | Disposes a timed-out renderer and swallows the abandoned promise's late rejection. |
| Async factory double-invocation guard | Adopted | One in-flight renderer promise per DOM canvas. |
| Initial WebGPU failure | Adopted | Makes one force-WebGL attempt on the same canvas. |
| Eight sustained WebGPU uncaptured errors | Adapted | Requests bounded in-place recovery instead of reloading the page. |
| WebGPU `device.lost` | Adapted | Ignores intentional `destroyed` loss; otherwise attempts one renderer recreation on the same canvas, then session-sticky force-WebGL if recreation fails. |
| Session-sticky WebGL lane | Adopted/adapted | Uses the stage-specific `world-stage-webgpu-unhealthy` key. |
| Canvas-adoption watchdog | Adapted | Keeps Kelp's 6-second `300x150` signature, but requests bounded same-canvas recovery rather than reload. |
| WebGL context loss/restoration | Added beyond Kelp | Prevents default loss handling, clears input, clamps the next delta, waits two seconds for restoration, and requests bounded recovery on timeout; restoration resyncs and invalidates. |
| `visibilitychange` / `pageshow` wake | Added beyond Kelp | Clears held input, clamps the next controlled delta, resyncs via R3F `setSize`, and invalidates once. |
| Listener lifetime | Adapted | Device/DOM listeners are removable and reflected in the stage listener diagnostics, including underflow detection. |
| Full-page reload loop | Intentionally dropped | Recovery stays on the same Canvas and is bounded: one like-for-like recreation, then one WebGL fallback where applicable. |
| Kelp route beacon/store and terminal overlay | Intentionally dropped for P0b | The isolated proof uses stage recovery/transition diagnostics. Production terminal UX is a P1 integration decision; no live failure UI changed. |
| Scene-specific `compileAsync` warmup | Intentionally dropped from renderer policy | Readiness is a slot concern; exact-generation warm/ready/first-controlled-frame remains the shared boundary. |

Recovery count/last reason are visible in the panel and probe snapshot. The
ordinary passing probes induced no recovery, so fault branches are implemented
but were not destructively simulated.

## Resource ledger accuracy

`resource-ledger.ts` walks each registered slot root and deduplicates resources
by object identity. The panel rounds `total` to one decimal MiB;
`window.__WORLD_STAGE_LEDGER()` returns unrounded bytes and counts.

Exact at the JavaScript resource boundary:

- geometry sums unique index, buffer-attribute, interleaved-buffer, and
  morph-attribute typed-array `byteLength`;
- compressed textures with populated mip data sum those compressed mip-array
  byte lengths;
- an uncompressed typed-array image uses its source `byteLength`;
- repeated references inside one slot are counted once.

Estimated:

- DOM image/canvas/video-like textures use
  `width * height * depth * channels * componentBytes`, with `4/3` added when
  Three is expected to generate a full mip chain;
- render targets use dimensions, format/type, depth, and sample count; depth
  textures currently use four bytes per sample;
- `exactCompressedMipBytes` means exact loaded compressed mip payload, not
  exact driver-resident VRAM.

Known error sources:

- GPU alignment/padding, format expansion/conversion, transient upload buffers,
  resolve attachments, and driver allocation granularity are invisible;
- shaders, bind groups, pipelines, renderer globals, animations, skeletons,
  decoder memory, CPU clones, and postprocessing outside the slot root are
  excluded;
- material/user-data discovery is bounded to four object levels;
- shared resources are counted in every slot that references them, so slot
  totals are gates but are not safely additive;
- compressed payload can differ from device-native residency after
  transcoding;
- backend-generated attributes can differ. The recorded Cove geometry payload
  was 17,873,160 bytes on WebGPU and 17,784,432 bytes on WebGL;
- missing dimensions contribute zero bytes and increment `unknownTextures`;
  both Cove records reported zero unknown textures.

Observed Cove ledger:

| Lane | Textures | Geometry | Render targets | Total |
|---|---:|---:|---:|---:|
| WebGPU | 10,595,302 B (10.104 MiB) | 17,873,160 B (17.045 MiB) | 0 B | 28,468,462 B (27.150 MiB) |
| WebGL | 10,595,302 B (10.104 MiB) | 17,784,432 B (16.961 MiB) | 0 B | 28,379,734 B (27.065 MiB) |

Both lanes report 10,245,776 exact compressed-mip bytes and 349,526 estimated
bytes across 14 geometries, 56 attributes, 12 textures, zero render targets,
and zero unknown textures.

## Automated transition probe

Harness: `apps/web/scripts/world-stage-probe.mjs`  
Outputs: `apps/web/scripts/world-stage-probe-summary.json` and
`apps/web/scripts/world-stage-probe-webgl-summary.json`

The Puppeteer harness uses installed Chrome headless at 1280x720/DPR 1, warms
all three slots, forces garbage collection when CDP exposes it, then cycles
`alpha`, `beta`, and `cove-spike` for 100 requested transitions. It exits 0/1
and writes the complete machine-readable result.

| Assertion/result | WebGPU | Forced WebGL |
|---|---:|---:|
| Overall | PASS | PASS |
| Completed transitions | 100 / 100 | 100 / 100 |
| Physical Canvas mounts | 1 | 1 |
| Hidden windows checked | 100 | 100 |
| Hidden frame/camera/store violations | 0 / 0 / 0 | 0 / 0 / 0 |
| Active callback-growth violations | 0 | 0 |
| Stage listener baseline -> end | 5 -> 5 (delta 0) | 4 -> 4 (delta 0) |
| Transition errors | 0 | 0 |
| Recoveries | 0 | 0 |
| Post-warmup heap | 67,973,061 -> 68,816,537 B (+1.241%) | 67,800,002 -> 68,546,946 B (+1.102%) |
| Heap threshold | <15%: PASS | <15%: PASS |

The WebGPU baseline has one additional listener because it owns the removable
device `uncapturederror` listener. The invariant is zero delta within each
lane.

Build verification:

- root `bun run build`: exit 0, 9/9 tasks; Next.js 16.2.3 compiled;
- `apps/web` `bunx tsc --noEmit`: exit 0.

### Deviations and limits

- The script default includes `webgpu=1` to bypass automatic low-end fallback
  for a forced-WebGPU gate. The saved WebGPU URL is `?stage=1` and its snapshot
  confirms backend `webgpu`; the other saved run explicitly uses `webgl=1`.
- Heap data was available in both runs. On a browser without
  `performance.memory`, the harness reports unavailability rather than failing,
  as allowed by the brief.
- Console/page errors are recorded but unrelated provider noise is not itself a
  probe assertion. Both summaries therefore remain PASS while retaining the
  anonymous-auth 401 and `THREE.Clock` warning.
- No device loss, uncaptured-error storm, WebGL context loss, or background-tab
  throttle was injected. The ordinary run verifies listener stability and
  transitions; destructive recovery fault injection remains a P1 test.
- The automated probe performs no screenshot comparison or human visual
  approval. Reviewer/Fable visual verification remains outstanding.
