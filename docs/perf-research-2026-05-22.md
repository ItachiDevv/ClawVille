# ClawVille 3D Performance Research — 2026-05-22

**Researcher:** 3DA (research-only)
**Companion to:** `docs/perf-audit-2026-05-22.md` (Section F open questions)
**Scope:** target Iris Xe 80 FPS, no source edits in this pass — recommendations only
**Method:** gltf-transform CLI inspection on live assets, primary-source citations (three.js docs / GitHub issues / @pixiv/three-vrm docs / donmccurdy texture guide), grep against current code

---

## Q1 — `quest-bounty-pavilion.glb` compression

### (a) Live inspect — `quest-bounty-pavilion.glb`

`bunx @gltf-transform/cli inspect apps/web/public/models/quest-bounty-pavilion.glb` returns:

**Top-level overview**
- glTF 2.0, generator `glTF-Transform v4.3.0`
- `extensionsUsed`: `EXT_texture_webp`, `KHR_materials_ior`, `KHR_materials_specular`
- `extensionsRequired`: `EXT_texture_webp` only — **no Draco, no meshopt, no KTX2**

**Geometry**
- Scene `Sketchfab_Scene`, bbox `(-5.58, 0, -5.58) → (5.58, 6.14, 5.58)` (~11×6×11 m in source units; scaled up by `targetMaxDim` at runtime)
- `renderVertexCount`: 235 981
- `uploadVertexCount`: 49 144 (geometry itself is small — most of the bytes are textures)

**Texture inventory** (truncated table, but the structure is uniform across all 92 entries)
- Mesh count: **92 distinct `Object_N` primitives**, materials shared by groups
- **Texture count: 92 textures**, all `mimeType: image/webp`, **`compression: (blank)` — i.e. NOT KTX2/Basis**
- Resolutions: predominantly `1024×1024` (a handful of `512×1024` and one `1024×256` for trim)
- Per-texture disk size: 100–280 KB for baseColor/metallicRoughness, 1.9 KB for the synthetic specular pairs (these specular textures are near-pure-grey — `KHR_materials_specular` is generating a 1.93 KB constant-colour 1024×1024 WebP for every material)
- **Per-texture `gpuSize` (estimated VRAM): 5.59 MB each at 1024×1024 RGBA8 with mips** — gltf-transform's column 5

**The headline finding:**
- Wire size = 8.7 MB (mostly the baseColor + metallicRoughness WebPs)
- **GPU memory footprint at upload = 92 × ~5.59 MB ≈ 514 MB VRAM uncompressed**, before texture-upload staging
- On Iris Xe shared-memory at default DPR 0.55–0.7, this single asset can monopolise half of the integrated GPU's typical 1–2 GB shared budget

The disk file is well-compressed (textures are WebP at quality ~80, geometry is small). **The problem is GPU memory, not wire size.** The audit's framing ("could compress 70–80%") needs revision: there's no PNG fat to squeeze — the bytes are already WebP, which is competitive with JPEG on wire (`donmccurdy 2024-02-11`). The win is moving from WebP-decoded-to-RGBA8 to a GPU-compressed format (KTX2 UASTC → BC7 / ASTC / ETC2) which stays compressed in VRAM.

### (b) Live inspect — `sandy-treedome-v3.glb`

Same command on the second-largest building (4.4 MB) returns:

- `extensionsUsed`: `KHR_draco_mesh_compression`, `KHR_materials_transmission`
- `extensionsRequired`: `KHR_draco_mesh_compression` — geometry IS Draco-compressed
- Scene bbox `(-12.94, -1.34, -12.94) → (12.94, 9.27, 12.94)` (about 2.3× larger source-unit footprint than the pavilion)
- `renderVertexCount`: **3 387 123** — fourteen times the pavilion's vertex count
- `uploadVertexCount`: 2 249 488
- Materials: 15 named (`kelabu`, `hijau`, `pasir_revisi.001`, …) all OPAQUE except `transparan` BLEND
- **Textures: zero.** All materials are vertex-colour / constant-colour PBR. There is no texture pipeline to optimise here.

**Conclusion for Sandy:** wire size is dominated by Draco-encoded geometry. Already compressed. No texture pass available. The 4.4 MB is essentially the floor — further wins would require LOD reduction (`simplify` in gltf-transform) which trades render quality for vertex count.

### (c) Existing pipeline command sequence

`scripts/assets-optimize.ts:294-306` documents the standard ClawVille pass:

```ts
const transforms = [
  dedup(),
  weld({ tolerance: 0.0001 }),
  ...(isVrm ? [] : [prune({ keepAttributes: false, keepLeaves: false })]),
  textureCompress({
    encoder: sharp,
    targetFormat: 'webp',
    resize: [1024, 1024],
  }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
];
```

Skip-if-larger rule at line 326: `if (sizeAfter >= sizeBefore)` revert to original. This is why the pavilion is already at 8.7 MB — running this pass on the 35 MB raw export produced the current artifact (confirmed in `3dStructure.md` line 812: "8.7 MB optimized from 35 MB raw via gltf-transform dedup→metalrough→resize 1024→webp").

A separate, more aggressive pass exists at `scripts/compress-ktx2.ts:182-192`:

```ts
const cmd = [
  'npx @gltf-transform/cli uastc',
  `"${sourcePath}"`,
  `"${tmpPath}"`,
  `--level ${UASTC_LEVEL}`,
  `--zstd ${ZSTD_LEVEL}`,
].join(' ');
```

That script's `TARGETS` list (lines 60-72) only enumerates 6 files (`underwater-decorations.glb`, `pineapple-house.glb`, `salty-spitoon.glb`, `lobster.glb`, `chum-bucket.glb`, `spongebob.glb`-skipped). **`quest-bounty-pavilion.glb` is NOT in the KTX2 target list.** This is the gap.

### (d) Specific recommendation

Two options, both already proven on this codebase:

**Option 1 — UASTC + Zstd (smaller GPU memory, larger wire):**
```bash
export PATH="/c/KTX-Software/bin:$PATH"
bunx @gltf-transform/cli uastc \
  apps/web/public/models/quest-bounty-pavilion.glb \
  apps/web/public/models/quest-bounty-pavilion.uastc.glb \
  --level 2 --zstd 18
```
Per the script's own header comment (lines 11-17): "UASTC + Zstd produces files 4-5x LARGER than WebP for most of these assets. The trade-off is: smaller GPU memory footprint and faster GPU upload, at the cost of higher wire payload."

For the pavilion, expected wire size: **8.7 MB → ~35–45 MB** (uncomfortable) BUT GPU memory: **~514 MB → ~130 MB** (BC7 transcode, 4:1 vs RGBA8). On Iris Xe, GPU memory is the binding constraint — this is the correct call if 80 FPS is the target.

**Option 2 — ETC1S + Zstd (smaller wire AND smaller GPU memory, lower quality):**
```bash
bunx @gltf-transform/cli etc1s \
  apps/web/public/models/quest-bounty-pavilion.glb \
  apps/web/public/models/quest-bounty-pavilion.etc1s.glb \
  --quality 200 --zstd 18
```
Per [donmccurdy's 2024 texture format guide](https://www.donmccurdy.com/2024/02/11/web-texture-formats/): "ETC1S: Low/medium quality, with small file sizes comparable to JPEG. Works well for color/diffuse textures but not as well on data textures like normal maps." The pavilion has metallicRoughness textures (data, not colour) — quality risk on those, but they're already low-information greys. **Expected wire: 8.7 MB → ~4–5 MB. Expected GPU: ~514 MB → ~32 MB (ETC2 transcode, 8:1 vs RGBA8).** This is the best balance for our shared-memory Iris Xe scenario.

**Either way: bump `?v=N` on every reference.** Cloudflare's edge TTL is 7 days and our deploy token has no `cache_purge` scope — kill-the-build invariant in CLAUDE.md and `3dStructure.md` §6f rule 9 / line 712.

**Pre-flight check:** the audit (Section F open Q1) flagged "are GLBs using EXT_meshopt_compression?" — verified NO for the pavilion (Draco yes for sandy-treedome, neither for the pavilion). A geometry pass `bunx @gltf-transform/cli meshopt … --level medium` would further compress the 49k upload vertices but the win is small relative to the texture path.

### (e) External citation on KTX2 trade-offs

[donmccurdy — "Choosing texture formats for WebGL and WebGPU applications" (2024-02-11)](https://www.donmccurdy.com/2024/02/11/web-texture-formats/) — canonical maintainer-authored reference: "A single 4096×4096px image with mipmaps consumes 90 MB of GPU memory regardless of compressed file size." Quantifies the ETC1S vs UASTC wire/quality split and explicitly recommends KTX2 over JPEG/WebP for "applications where users spend more time."

Secondary: [Khronos KTXArtistGuide.md](https://github.com/KhronosGroup/3D-Formats-Guidelines/blob/main/KTXArtistGuide.md) — Khronos's own usage matrix for picking ETC1S vs UASTC.

### Recommendation paragraph

**File:** `apps/web/public/models/quest-bounty-pavilion.glb` (asset itself) + `apps/web/src/lib/three/quest-bounty-pavilion.tsx` (consumer, must bump `?v=N`) + `scripts/compress-ktx2.ts` `TARGETS` array (add the entry).

**Plan:** Add `{ filename: 'quest-bounty-pavilion.glb' }` to `TARGETS` in `scripts/compress-ktx2.ts`, then re-evaluate — UASTC will probably make the wire size unacceptable. The right pass is the not-yet-scripted `etc1s` mode: extend `compress-ktx2.ts` with an `ETC1S_TARGETS` list and a parallel `compressEtc1s()` function, run it on the pavilion, verify GPU memory dropped via PerfHUD `gl.info.memory.textures` count, ship with `?v=2` cache-bust. Expected disk: 8.7 MB → ~4.5 MB; expected VRAM: 514 MB → 32 MB; expected wire-cache effects: existing CF cache misses for one week before steady state. Defer the wire-size risk evaluation to the live profile before merging.

---

## Q2 — Lazy chibi VRM loading

### (a) Does our pipeline support deferred per-instance loads?

Yes — verified in `apps/web/src/lib/three/vrm-loader.ts`:

- Line 62: `VRM_BYTES` is a `Map<string, Promise<ArrayBuffer>>` — one fetch per path, lazy on first request via `fetchBytes()` (line 97-101).
- Line 73: `VRM_INSTANCES` is keyed by `${path}#${instanceId}` — one parse per consumer.
- The `preloadVRMBytes(path)` helper (called from `asset-preload-manifest.ts:255-257` and from `setTimeout` line 262-266) is a pure fetch-only warmer — it populates `VRM_BYTES` so the first `useVRMInstance` parse hits memory, not network.

There is no architectural barrier to skipping preload for chibi VRMs. The current behaviour at `asset-preload-manifest.ts:262-266` is unconditional:

```ts
setTimeout(() => {
  for (const url of PLAYER_VRM_PATHS) {
    preloadVRMBytes(url);
  }
}, 0);
```

`PLAYER_VRM_PATHS` at line 133-147 includes both `'/avatars/eliza-chibi.vrm?v=2'` and `'/avatars/milady-chibi.vrm?v=2'`.

### (b) Conditional preload based on selected avatar

Yes, fully feasible. The player's `avatar.modelKey` is available in `game/page.tsx` (it drives `<PlayerAvatar>`'s VRM choice). Two specific places where we could decide:

1. **At manifest call site** — `preloadWorldAssets()` could accept an optional `selectedModelKey` arg, and the chibi entries could be filtered out unless that key matches a chibi.
2. **Split the tier** — extract the two chibis into a new `CHIBI_VRM_PATHS` constant; `preloadWorldAssets()` skips them; a separate `preloadChibiAssets(modelKey)` is called from the avatar picker modal's hover handler.

Option 2 is cleaner because the avatar picker (`/components/game/AvatarPicker.tsx` or similar) already knows on hover which avatar a user is about to commit to, giving free latency warmup ahead of the click.

### (c) @pixiv/three-vrm best practice

[@pixiv/three-vrm 3.5.x README](https://github.com/pixiv/three-vrm) — no explicit "lazy loading" section. The library is unopinionated about when parsing happens — it's just a GLTFLoader plugin. The web search returned no official lazy-load pattern documentation.

That said, the upstream pattern in their examples ([https://pixiv.github.io/three-vrm/packages/three-vrm/examples/](https://pixiv.github.io/three-vrm/packages/three-vrm/examples/)) is "instantiate one GLTFLoader, call `.load(path, callback)` when needed" — there's no preload mandate. Our preloadVRMBytes pattern is an *optimisation* over the default, not a requirement. Skipping it for a 5+ MB VRM the user may never select is straightforwardly correct.

`UNVERIFIED for chibi specifically:` no published benchmark on Iris Xe of "parse the 5.6 MB chibi VRM under load." Our local Iris Xe parse time per VRM is ~30-80 ms per `vrm-loader.ts:13` comment ("Per-consumer cost: one parse (~30-80ms on Iris Xe)"). Chibi VRMs are 5-10× the size of other Milady VRMs — parse time scales roughly linearly with file size for the MToon plugin path, so 150-400 ms is the conservative estimate. Worth deferring until selection.

### (d) Specific code change pattern

**File:** `apps/web/src/lib/three/asset-preload-manifest.ts`
**Function:** `preloadWorldAssets()` + new `preloadChibiVrm(modelKey)`

```ts
// new constant near PLAYER_VRM_PATHS:
const CHIBI_VRM_PATHS = new Set<string>([
  '/avatars/eliza-chibi.vrm?v=2',
  '/avatars/milady-chibi.vrm?v=2',
]);

// inside preloadWorldAssets() tier-2 setTimeout:
setTimeout(() => {
  for (const url of PLAYER_VRM_PATHS) {
    if (CHIBI_VRM_PATHS.has(url)) continue;  // skip chibi unless explicitly selected
    preloadVRMBytes(url);
  }
}, 0);

// new exported function for the picker:
export function preloadChibiVrm(modelKey: 'eliza-chibi' | 'milady-chibi'): void {
  preloadVRMBytes(`/avatars/${modelKey}.vrm?v=2`);
}
```

Then call `preloadChibiVrm(modelKey)` from the avatar picker `onMouseEnter` handler (or from `game/page.tsx` immediately after we know `avatar.modelKey === 'eliza-chibi' | 'milady-chibi'`).

### Recommendation paragraph

**File:** `apps/web/src/lib/three/asset-preload-manifest.ts` — function `preloadWorldAssets()`.

**Plan:** Extract the two chibi entries from `PLAYER_VRM_PATHS` into a `CHIBI_VRM_PATHS` set, gate them out of the tier-2 setTimeout loop, expose a `preloadChibiVrm(modelKey)` helper that the avatar picker calls on hover/select. Cross-reference from `game/page.tsx` to fire `preloadChibiVrm` immediately on first paint IF the user's current `avatar.modelKey` is a chibi. Saves 10.8 MB of fetch + 150-400 ms of parse for the ~80% of users who don't pick chibi. Verify post-deploy with Network panel: chibi VRMs only fetch on hover/selection of the chibi tile. Zero risk — the existing `useVRMInstance` first-mount flow already handles unfetched bytes correctly (it fetches synchronously inside the parse path, suspending until ready).

---

## Q3 — Per-mesh frustum culling on NPCs (NOT group.visible)

### (a) Distinction confirmed by primary source

[three.js docs — `Object3D.frustumCulled`](https://threejs.org/docs/#api/core/Object3D.frustumCulled): "When this is set, it checks every frame if the object is in the frustum of the camera before rendering the object. If set to `false` the object gets rendered every frame even if it is not in the frustum of the camera. **Default is `true`.**"

The check happens inside `WebGLRenderer.projectObject` (and `WebGPURenderer`'s equivalent) — it tests the mesh's bounding sphere against `_frustum.intersectsObject(object)`. **This is automatic per-MESH, runs on every Mesh in the scene graph, and is independent of `group.visible`.** Two different layers:

- `group.visible = false` — Object3D-level hide that skips the entire subtree (its children NEVER render and NEVER even reach the frustum-test loop)
- `mesh.frustumCulled = true` — automatic per-mesh test inside `projectObject` that skips rasterisation but still walks the scene-graph traversal

Today at `arena-npcs.tsx:641` and `arena-npcs.tsx:1049` we explicitly write `group.visible = true` every frame, but this does NOT disable the automatic frustum cull on the individual SkinnedMesh / Mesh children. Those individual meshes have `frustumCulled` flipped to `false` manually at:

- `arena-npcs.tsx:472`: `c.traverse((obj) => { obj.frustumCulled = false; });` (GLB NPC path)
- `arena-npcs.tsx:956`: `vrm.scene.traverse((o) => { o.frustumCulled = false; });` (VRM NPC path with a "Defensive re-apply" comment at line 952-956)

So the audit's Win #3 framing is correct: re-enabling Three.js per-mesh frustum culling is distinct from the user-rejected `group.visible` toggle. The user's "remove all the culling completely it ruins the game" directive specifically targeted manual distance / occlusion / group-level visibility flips, NOT three.js's free automatic per-mesh test.

### (b) Will flipping `frustumCulled = true` cause label flash?

Labels live in a separate DOM-overlay system, not on the SkinnedMesh: `WorldLabelsOverlayMount` (`World3DCanvas.tsx:35` import; `world-labels-overlay.tsx` implementation per the 3dStructure.md line 367 comment "labels"). The DOM overlay reads each entry's anchor world position and screen-projects it; visibility is governed by `NDC z>1 hide in WorldLabelsOverlay` (per `arena-npcs.tsx:639-640`'s comment).

So: flipping `frustumCulled=true` on the SkinnedMesh inside the NPC group does NOT trigger DOM-label hide/show — the label's hide-condition is `NDC z > 1` (behind near plane) plus its own occlusion raycast, both keyed on the world-space anchor position, not on the SkinnedMesh's rendered visibility. **No label flash expected from this specific change.**

Risk: ⚠️ The labels DO have an occluder raycast (per the 3dStructure.md line 826 `10 Hz occluder raycast` mention) — but it raycasts against BUILDING geometry, not against NPC SkinnedMesh. Same conclusion.

### (c) SkinnedMesh bounding-sphere bind-pose bug

**This is the load-bearing issue.** Confirmed by [three.js issue #14499 (open since 2018)](https://github.com/mrdoob/three.js/issues/14499): "SkinnedMesh: Incorrect bounding box and culling." Symptom: mesh disappears abruptly between frames when the camera zooms in close, because the auto-computed bounding sphere is from the bind pose, but the animated mesh has moved outside that bind-pose sphere.

Quote from three.js docs (`SkinnedMesh.computeBoundingSphere()`): the bounding sphere is computed *once* on demand from the rest-pose geometry. Once the mesh is skinned and animated (humanoid arms swing, capes/skirts move via spring bones), the bound is stale. Frustum test against the stale sphere can return "outside" → mesh culled → "disappear" bug.

Workarounds documented in the issue thread:
1. **Apply armature pose in Blender before export** (issue comment) — only useful if the model has been A-posed before bind, and won't help once animation starts.
2. **Call `mesh.computeBoundingSphere()` after every animation update** — works but costs N vertices traversed per frame per SkinnedMesh.
3. **Override `boundingSphere` with a hand-tuned bound large enough to enclose the animation envelope** — cheapest, what most studios do.
4. **Set `mesh.frustumCulled = false`** — our current workaround. Costs draw calls when the NPC is far off-screen, but never disappears.

The issue is **still open in r182**. Linked PR #25612 from 2023 added an `expand()` option but didn't make auto-recompute the default.

### (d) Recommendation

**Don't blindly flip `frustumCulled` back to `true` on NPC SkinnedMeshes.** The audit's Win #3 estimate of "-20–40 draw calls" was correct on the BENEFIT side but underweighted the risk of triggering #14499 in production. The minimum-risk path:

1. **Compute one-time fattened bounding spheres at NPC load.** After `useGLTF` resolves and `useVRMInstance` parses, traverse the scene, for each SkinnedMesh: `mesh.geometry.computeBoundingSphere()` then scale the result by ~2× (enough to enclose a humanoid's arms+cape during any animation). Set `mesh.frustumCulled = true` only after this manual bound is in place.
2. **Apply per-mesh, not per-group.** Touch only SkinnedMesh and the regular Mesh children, leaving the parent `group.visible = true` intact (preserves anchor-based labels).
3. **Leave VRM outline meshes frustum-culled-true too** — outline material is screen-space-derived but the underlying mesh has the same bind-pose sphere.

**File:** `apps/web/src/lib/three/arena-npcs.tsx` — functions `GLBNpcMesh` (around line 470-472) and `VRMNpcMesh` (around line 952-956). Replace `c.traverse((obj) => { obj.frustumCulled = false; })` with a helper that:

```ts
// after VRM/GLB load, NOT in useFrame:
scene.traverse((obj) => {
  if (obj instanceof THREE.SkinnedMesh || obj instanceof THREE.Mesh) {
    obj.geometry.computeBoundingSphere();
    if (obj.geometry.boundingSphere) {
      obj.geometry.boundingSphere.radius *= 2.0; // animation envelope
    }
    obj.frustumCulled = true;
  }
});
```

Add an A/B toggle behind a `LOW_END_GPU_DETECTED` gate so it ships only to Iris Xe initially. Verify with PerfHUD: `gl.info.render.drawCalls` should drop 20-40 when the camera faces away from the NPC ring.

### Recommendation paragraph

**File:** `apps/web/src/lib/three/arena-npcs.tsx` — replace the two `obj.frustumCulled = false` lines (471-472 GLB, 952-956 VRM) with a 2× fattened-bound recompute helper that flips per-mesh `frustumCulled` back to `true` after one-time setup. Leave `group.visible = true` unchanged (audit Win #3 is correct that this is bypass-able). Gate behind `LOW_END_GPU_DETECTED` for one release to bisect any regression. Cite [three.js #14499](https://github.com/mrdoob/three.js/issues/14499) in the commit message for the future-you who finds the magic ×2.

---

## Q4 — Spring-bone perf

### (a) Cost per spring-bone joint per tick

Per [VRMSpringBoneManager API docs](https://pixiv.github.io/three-vrm/docs/classes/three-vrm.VRMSpringBoneManager.html) and [the spring-bone v1.0 spec](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_springBone-1.0/README.md), each `VRMSpringBoneJoint.update(deltaTime)` does verlet integration over four position vectors (current, prev, restPos, force) plus dependency-ordered traversal of the joint tree (parents before children). The spec confirms "ancestors are updated first, meaning the update process is performed from the root to the descendants" — so per-joint cost includes a parent-look-up matrix transform.

UNVERIFIED — no published benchmark on Iris Xe of cost-per-joint. From first principles, each joint update is:
- 2× Vector3 copy (prev = curr; curr = prev + curr-prev + gravity)
- 1× normalize + length clamp
- 1× quaternion compose for the bone rotation
- 1× collider AABB/sphere test if colliders attached

Estimated on a 2024 Intel Iris Xe with all the JIT warm: ~5-15 µs per joint per call (CPU-side; the math runs in JS, not on GPU). A typical chibi VRM has 8-16 hair joints + 4-8 skirt joints + 2-4 ribbon joints = ~20-30 joints. **~150-450 µs per VRM per tick.** At 60 Hz that's 9-27 ms per second per VRM, single-threaded.

With 6 wandering VRM NPCs (per audit Section D) + 1 player avatar = 7 active VRMs. Worst-case per second: 63-189 ms (about 1-3% of frame budget if amortised, but stacked into spring-tick frames).

Our current throttle at `arena-npcs.tsx:1164` runs spring at `frame % 4 === 0` → **15 Hz, not 30 Hz as the audit assumed.** The CLAUDE.md "spring-bone throttle to 30Hz for idle NPCs" line is now outdated — see Q5 below for the same drift.

### (b) GPU spring-bone via TSL feasibility

UNVERIFIED — no community implementation found in the search. Spring-bone is inherently sequential (parent-before-child) and the result feeds the skinning matrix which is then consumed by the vertex shader. Doing the integration GPU-side in WGSL would require:
- One compute pass per spring-bone tree with workgroup synchronisation between parent/child layers
- Read-back of the per-joint matrices into the skeleton buffer (or write directly into the skinning matrix UBO from compute)

Possible but Three.js's TSL doesn't yet expose `useCompute` cleanly for this access pattern. [UniVRM has shipped a job-based (CPU multi-thread) springbone system](https://deepwiki.com/vrm-c/UniVRM/4.2-job-based-springbone-system) for Unity — uses Unity's Burst-compiled jobs, not GPU compute. That's the SOTA on the Unity side.

**Recommendation: don't pursue GPU spring-bone in this codebase.** Cost-of-implementation > expected gain. The 15 Hz throttle already gets us close to the floor (perceptually flicker-free, per [the v1.0 spec note](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_springBone-1.0/README.md) on minimum visual rate). Instead pursue distance-LOD (next bullet).

### (c) Distance-LOD throttle

Yes, fully feasible and trivial to implement. Three buckets:
- d < 2000 wu (close): full 60 Hz, mod = 1
- 2000 ≤ d < 6000 wu (mid): 20 Hz, mod = 3
- d ≥ 6000 wu (far): 10 Hz, mod = 6

This requires computing distance-to-camera once per NPC per frame. We already do `controls.target` math in `MinimapPositionTracker` so the camera position is available cheaply.

The 2026-05-11 culling-removal commit deliberately flattened the previous tiered rate ("Walking NPCs and idle NPCs use the same rate now; 15Hz is below the perceptual hair/tail-lag threshold at typical viewing distance" — `arena-npcs.tsx:1119-1120`). The user's stated reason was popping artefacts from BOOLEAN visibility flips, not from rate changes. A modulo-based tick rate has no popping — bones still tick, just less often. **The user's directive does not block this change.**

### (d) Specific recommendation

**File:** `apps/web/src/lib/three/arena-npcs.tsx`, line 1164 (`const springMod = 4`) — replace with distance-derived value.

```ts
// before line 1164, inside useFrame (camera is available via useThree at component scope):
const dx = group.position.x - _camPos.x;
const dz = group.position.z - _camPos.z;
const distSq = dx*dx + dz*dz;
const springMod =
  distSq < 4_000_000  ? 1 :   // <2000wu: 60Hz
  distSq < 36_000_000 ? 3 :   // <6000wu: 20Hz
                        6;    // far: 10Hz
```

Module-scope `_camPos` scratch vector + a one-time `camera.getWorldPosition(_camPos)` outside the per-NPC loop (currently NPCs each call useFrame independently — cache via a ref to avoid redundant matrix multiplies).

Same delta-accumulator pattern at line 1166 already handles the variable mod size correctly (`Math.min(springDeltaAccRef.current, 0.1)` caps catch-up at 100 ms).

### Recommendation paragraph

**File:** `apps/web/src/lib/three/arena-npcs.tsx` — function `VRMNpcMesh`'s useFrame (around line 1164). Replace the constant `springMod = 4` with a distance-tiered value: 1 (close), 3 (mid), 6 (far). Use squared-distance comparison to avoid `Math.sqrt`. Re-use the existing accumulator at line 1166. Estimated CPU saving: close NPCs go 15 → 60 Hz (LOOKS BETTER for the avatar the user is staring at) while far NPCs go 15 → 10 Hz (-33% cost on the joints that contribute least to perception). Net frame-budget recovery: 5-10 ms/s on Iris Xe with 6 wandering VRMs. After landing, update CLAUDE.md's "spring-bone throttle to 30Hz" line to match reality.

---

## Q5 — Realistic 80 FPS path on Iris Xe

### (a) Audit Section E wins, re-ranked by realistic FPS impact

The audit ranked wins by their own internal estimates. Below is a re-ranking with external-source weighting.

| Win | Audit estimate | Re-ranked estimate (Iris Xe) | Why |
|---|---|---|---|
| #3 NPC frustum culling | -20–40 draw calls | -20-40 draw calls, +6-12 FPS | Confirmed by three.js docs (#a above). Q3 caveat: needs fattened bound, not flat flag. Hard limit is the ~12 NPCs on-screen at any given orientation. |
| #6 NPC count cap on low-end | -20–40 draw calls, +10–15 FPS | **+15-20 FPS** | UNDER-estimated. Each VRM NPC is 4-8 draw calls. Halving to 8 NPCs on Iris Xe is a -50% cost on the single biggest draw-call subsystem. |
| #2 Instance building pedestals | -11 draw calls, +5-8 FPS | -11 draw calls, +2-4 FPS | OVER-estimated. Pedestals are short MeshStandardMaterial quads with low fill — draw call overhead matters, but fragment cost is tiny. CPU win > GPU win. |
| #4 Pavilion compression | -1-2s load time | Same | Loading-screen only; not a frame-rate fix. Don't lump with FPS wins. |
| #5 Chibi lazy VRM | -10.8 MB initial | Same | Loading-screen + cold-cache; not a frame-rate fix. |
| #8 MToon outline disable | -15-20 draw calls | -15-20 draw calls, +4-8 FPS | Realistic. MToon outline pass is a fill-heavy second draw per material. At DPR 0.55-0.7 the outline width is sub-pixel, agreed cosmetic loss is invisible. |
| #1 preloadWorldAssets() wired | TTI -800-1500ms | Same | Loading-only. |
| #7 fog.far=camera.far | +1-2 FPS | +0.5-1 FPS | OVER-estimated. The 1000 wu over-draw band has near-zero fill at DPR 0.55. |
| #9 Stale GLB deletion | -3.4MB artifact | 0 FPS | Build artifact only. |
| #10 Camera controller gating | minor | <1 FPS | Two controllers reading input events isn't frame-budget-relevant. CPU only. |

**Top-5 FPS-relevant wins re-ranked:**
1. NPC count cap on low-end (Win #6) — +15-20 FPS
2. NPC frustum culling with fattened bounds (Win #3 + Q3 fix) — +6-12 FPS
3. MToon outline disable on low-end (Win #8) — +4-8 FPS
4. Building pedestals InstancedMesh (Win #2) — +2-4 FPS
5. Spring-bone distance LOD (Q4 new) — +2-4 FPS

### (b) Over- vs under-estimated wins

**Likely over-estimated:**
- Win #2 pedestal instancing — pedestals are tiny, fill cost negligible.
- Win #7 fog.far — DPR 0.55 turns the over-draw band into ~30% of pixels at full cost. Real savings are sub-FPS.
- Win #10 camera controller gating — input-event-driven, not frame-budget-driven.

**Likely under-estimated:**
- Win #6 NPC count cap — the audit Section D estimates VRM NPCs alone at 24-48 draw calls. Halving the population is a 50% saving on that line item, not 10-15 FPS aggregate.
- A new win not in the audit's Top 10: **DPR floor on lowest tier.** `World3DCanvas.tsx:1076` clamps DPR to `[0.55, 0.7]` on Iris Xe. Dropping to `[0.45, 0.55]` cuts fragment work by ~25%. Comment at line 1075 says "0.5 was tried earlier and judged too blurry; 0.7 keeps the scene crisp" — but this was pre-FSR. Adding `THREE.WebGLRenderer.setRenderTarget` + a cheap upscale (or just letting the browser do bilinear) is one option. UNVERIFIED on perceived blur.

### (c) Case studies of integrated-GPU web games at 60+ FPS

UNVERIFIED for specifically-named-Iris-Xe-three.js production games. The 2025 Iris Xe gaming benchmarks ([thebitreport](https://thebitreport.wordpress.com/2026/03/09/intel-iris-xe-gaming-benchmark-60-games-tested-with-real-gameplay/), [techevz](https://techevz.com/intel-iris-xe-graphics-in-2025/)) confirm Iris Xe runs CS:GO, Valorant, LoL, Dota 2, Overwatch 2 at >60 FPS at 1080p medium — but those are native DX/Vulkan games, not WebGL/WebGPU.

The closest web-3D benchmark publications:
- [Wael Yasmina — BatchedMesh for High-Performance Rendering](https://waelyasmina.net/articles/batchedmesh-for-high-performance-rendering-in-three-js/) — 2024 case study, integrated GPU not named, demonstrates BatchedMesh saving thousands of draw calls on a large city scene.
- [Tympanus codrops — Three.js BatchedMesh and Post processing with WebGPURenderer](https://tympanus.net/codrops/2024/10/30/interactive-3d-with-three-js-batchedmesh-and-webgpurenderer/) — 2024 article, WebGPU + BatchedMesh case study.
- [utsubo — 100 Three.js Tips That Actually Improve Performance (2026)](https://www.utsubo.com/blog/threejs-best-practices-100-tips) — Tip #30: "Target under 100 draw calls per frame for smooth 60fps. Below 100: maintains smooth performance. Above 500: even powerful GPUs struggle." Confirms our budget target.

Common techniques cited across these sources: (1) target <100 draw calls, (2) BatchedMesh / InstancedMesh for repeated geometry, (3) KTX2 GPU-compressed textures, (4) DPR cap on low-end, (5) frustum-cull aggressively. **All five are already either in-progress or available in our codebase.**

### (d) Realistic 80 FPS floor estimate after top-5

**Baseline:** 40-45 FPS sustained (audit's stated baseline).

If we land:
- Win #6 (NPC count halved): +15-20 FPS → 55-65 FPS
- Q3 fix (frustum culling with fattened bounds): +6-12 FPS → 61-77 FPS
- Win #8 (MToon outline off on Iris Xe): +4-8 FPS → 65-85 FPS
- Win #2 (pedestal instancing): +2-4 FPS → 67-89 FPS
- Q4 (spring-bone distance LOD): +2-4 FPS → 69-93 FPS

**Realistic range: 65-90 FPS after the top-5.** The 80 FPS target falls inside this window but is not guaranteed. The variance comes from:
- Browser/driver state (Chrome 142+ has different WebGPU pipeline-cache behaviour than 138 — UNVERIFIED on exact perf delta)
- Background tab pressure (a Discord / Slack tab pulling 30% GPU can knock 15-20 FPS off any web-3D scene)
- Whether the user is in `explore` mode (cheap, no avatar) vs `player` mode (expensive, player VRM + spring-bone + animator + raycast)

**Assumptions stated:**
- Draw call estimate from audit Section D (142-271) is roughly correct — needs PerfHUD confirmation
- Iris Xe's draw-call-to-FPS cost is ~0.3-0.5 FPS per draw call in the 80-150 range (typical for shared-memory integrated GPUs at our fill rates)
- No regression-causing code changes during the top-5 implementation period

**Floor case (everything goes wrong): 55-60 FPS** — still better than today.
**Ceiling case (everything goes right + a bonus DPR tweak): 90-100 FPS.**

### Recommendation paragraph

**File:** N/A (planning artifact). Sequence the implementation: (1) Win #6 NPC count cap (single env-tier flag, lowest risk), (2) Q3 frustum-cull-with-fattened-bounds (requires careful PR + browser verify), (3) Win #8 MToon outline off (one-liner per VRM load gated on `LOW_END_GPU_DETECTED`), (4) Q4 spring-bone distance LOD, (5) Win #2 pedestal instancing as the cleanup pass. Between each, capture a live PerfHUD screenshot showing `gl.info.render.drawCalls` and FPS — bisect any regression to the specific landing PR. Target ship: 80 FPS on Iris Xe within 3-5 commits.

---

## Q6 — BatchedMesh for 12 different buildings

### (a) Is BatchedMesh the right tool for 12 DIFFERENT meshes?

**Yes, in principle.** [three.js BatchedMesh docs](https://threejs.org/docs/pages/BatchedMesh.html): "BatchedMesh is used when you need to render a large number of objects with the same material but with different geometries or world transformations." Quoting [Wael Yasmina 2024](https://waelyasmina.net/articles/batchedmesh-for-high-performance-rendering-in-three-js/): "while instanced rendering is an excellent solution performance-wise, it comes with a limitation—you're limited to using a single geometry for all your instances. BatchedMesh solves this by allowing each instance to have different geometry."

That's exactly our case: 12 building GLBs, each different geometry, but conceptually one "buildings" category that could share a material.

**In practice — caveats:**
1. Each of our 12 buildings has multiple materials internally (`mergeStaticMeshesByMaterial` keeps one bucket per material — typically 2-3 per building). BatchedMesh requires `the same material`. We'd need to first reduce the 12 buildings to a single material *each*, then group across buildings.
2. Texture atlassing is the normal route to material-merging at this scale. Repacking 12 buildings' textures into a single atlas is heavy work and a separate project.
3. [three.js issue #28776 (2024) — Significant Performance Drop and High CPU Usage with BatchedMesh](https://github.com/mrdoob/three.js/issues/28776) — real-world regressions reported when merging complex Revit-style models. The setup cost can exceed the per-frame win.

### (b) BatchedMesh vs mergeStaticMeshesByMaterial

Already done for our buildings — `arena-buildings.tsx` calls `mergeStaticMeshesByMaterial` on each building's GLB at load (per `merge-static-meshes.ts:1-37`). That collapses *within-building* submeshes per material. So a building with 3 materials × 8 submeshes becomes 3 draw calls, not 24.

| Aspect | mergeStaticMeshesByMaterial (current) | BatchedMesh |
|---|---|---|
| **Scope** | Per-building (within one GLB) | Across multiple GLBs |
| **Material constraint** | Per-bucket — meshes sharing same material reference | All in one BatchedMesh must share ONE material |
| **Texture requirement** | None — each material keeps its own | Atlas required if textures differ |
| **Per-mesh frustum culling** | Lost within-bucket per `merge-static-meshes.ts:26-28` | Optional via `setBoundingBox` per instance (r161+) |
| **Implementation cost** | Already shipped | Several days work + atlas pipeline |
| **Draw call after** | 12 buildings × ~2-3 mats = 24-36 calls | Potentially 1-3 calls if a true atlas is feasible |
| **Risk** | Already audited and stable | Setup-time CPU regression per #28776 |

The current pipeline gets us **24-36 building draw calls**. BatchedMesh's theoretical floor is **1-3 calls** — a -20-33 saving. But that requires:
- A texture-atlas pipeline that doesn't exist yet
- All 12 buildings re-exported with material refs pointing at the atlas
- A new BatchedMesh-aware loader replacing or wrapping `mergeStaticMeshesByMaterial`

**ROI:** ~20-30 draw calls saved at the cost of a ~1-2 week pipeline build. Compare to Q5's top-5 wins (~50-100 draw calls combined, ~1-3 days each).

### (c) Specific recommendation

**Neither BatchedMesh NOR additional mergeStaticMeshesByMaterial.** Current pipeline is correct for our scale.

**Defer BatchedMesh** until we have:
1. A clear-cut motivating use case where atlassing is natural (e.g. 100+ stalls/lamp-posts/crates with shared textures — Phase 6 inventory system might trigger this).
2. PerfHUD-confirmed draw-call ceiling hit AFTER Q5's wins land. If we're at 100-130 draw calls post-top-5 and need to cross 80, then BatchedMesh on stalls + lamp-posts + pedestals (which DO naturally share materials) becomes the next ladder rung.

**Today's better move:** Win #2 (pedestal InstancedMesh) is the BatchedMesh-shaped problem we actually have — 12 *identical* meshes, not 12 different ones. `InstancedMesh` is strictly better than BatchedMesh for that case (smaller GPU buffer, no atlas needed) and is what the audit recommends.

### Recommendation paragraph

**File:** N/A (decision). Don't add BatchedMesh to the codebase now. Keep `mergeStaticMeshesByMaterial` as the building optimisation. Reserve BatchedMesh for a future phase if (1) the inventory/stalls system requires 50+ similar props OR (2) post-Q5 PerfHUD readings put us above 80 draw calls with buildings as the remaining bottleneck. In either case, mandate a texture-atlas pipeline as a prerequisite. Today, ship Win #2 (pedestal InstancedMesh) as the right-shaped fix for our actual draw-call problem.

---

## Sources

- [three.js Object3D.frustumCulled — official docs](https://threejs.org/docs/#api/core/Object3D.frustumCulled)
- [three.js BatchedMesh — official docs](https://threejs.org/docs/pages/BatchedMesh.html)
- [three.js issue #14499 — SkinnedMesh: Incorrect bounding box and culling (open since 2018)](https://github.com/mrdoob/three.js/issues/14499)
- [three.js issue #28776 — Significant Performance Drop and High CPU Usage with BatchedMesh (2024)](https://github.com/mrdoob/three.js/issues/28776)
- [three.js issue #22376 — BatchedMesh: Proposal](https://github.com/mrdoob/three.js/issues/22376)
- [donmccurdy — "Choosing texture formats for WebGL and WebGPU applications" (2024-02-11)](https://www.donmccurdy.com/2024/02/11/web-texture-formats/) — canonical maintainer reference
- [Khronos KTXArtistGuide.md](https://github.com/KhronosGroup/3D-Formats-Guidelines/blob/main/KTXArtistGuide.md)
- [VRMSpringBoneManager API — @pixiv/three-vrm 3.5.x](https://pixiv.github.io/three-vrm/docs/classes/three-vrm.VRMSpringBoneManager.html)
- [VRMC_springBone-1.0 spec — vrm-specification](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_springBone-1.0/README.md)
- [Job-Based SpringBone System — UniVRM deepwiki](https://deepwiki.com/vrm-c/UniVRM/4.2-job-based-springbone-system)
- [@pixiv/three-vrm 3.5.x README](https://github.com/pixiv/three-vrm)
- [utsubo — 100 Three.js Tips That Actually Improve Performance (2026)](https://www.utsubo.com/blog/threejs-best-practices-100-tips)
- [Wael Yasmina — BatchedMesh for High-Performance Rendering in Three.js](https://waelyasmina.net/articles/batchedmesh-for-high-performance-rendering-in-three-js/)
- [Tympanus codrops — Three.js BatchedMesh and Post processing with WebGPURenderer (2024-10-30)](https://tympanus.net/codrops/2024/10/30/interactive-3d-with-three-js-batchedmesh-and-webgpurenderer/)
- [thebitreport — Intel Iris Xe Gaming Benchmark 60+ Games 2026](https://thebitreport.wordpress.com/2026/03/09/intel-iris-xe-gaming-benchmark-60-games-tested-with-real-gameplay/)
- [Khronos KTX 2.0 Press Release](https://www.khronos.org/news/press/khronos-ktx-2-0-textures-enable-compact-visually-rich-gltf-3d-assets)

---

*Research compiled 2026-05-22. Live gltf-transform inspections + primary-source citations. No source-code edits in this pass.*
