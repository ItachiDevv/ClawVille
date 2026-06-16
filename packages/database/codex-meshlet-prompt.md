# Per-sub-mesh atlas for meshlet rasterizer — implement

## Goal

Make the ClawVille 11 building GLBs render through the Three.js r182 WebGPU meshlet compute rasterizer with textures that match the production /game (regular Three.js) render path. Each sub-mesh must show its own correct diffuse texture — not the largest sub-mesh's texture applied to everything (which is what commit 2a8710a9 currently does).

The rasterizer exists because Three.js MeshStandardMaterial path is below 60 FPS on Intel Iris Xe with the full ClawVille scene. FPS is non-negotiable. The fix must not regress FPS.

## Working tree

`C:\Users\newma\Documents\Crypto\ClawVille-meshlet` (separate git worktree from main ClawVille — do not edit the main ClawVille tree).
Branch: `perf/meshlet-integration`. Do NOT push to staging or master.

## Current broken state (commit 2a8710a9)

- `apps/web/src/lib/three/meshlet/build-buildings-atlas.ts` packs ONE diffuse texture per building (`pickLargestMeshDiffuse`) into a 4×3 grid of 1024px slots = 4096×3072 atlas.
- `apps/web/src/lib/three/meshlet/use-merged-buildings-asset.ts` (the /game hook) and `apps/web/src/app/preview/meshlet-spike-all-12/page.tsx` (the spike preview) both call `collectAndMergeGeometries(gltf.scene)` which flattens all sub-meshes of one GLB into ONE BufferGeometry — losing sub-mesh boundaries.
- The flattened geometry is passed to `mergeGeometriesToMeshletAsset` with one `MergeInput` per BUILDING (11 inputs, each with `sourceId` 0..10 pointing into the 12-slot atlas).

Visually: krusty-krab's roof, walls, sign, windows all get painted with the same wood-grain texture; salty-spitoon, claw-arcade, etc. look wrong; only buildings with truly one dominant mesh (patrick's pink rock, cove's stained dome) look OK.

## Target design — per-sub-mesh

### Pipeline change

For each loaded GLB, instead of flattening, enumerate every Mesh node in the scene. Each Mesh becomes its own `MergeInput` to `mergeGeometriesToMeshletAsset`:

```
For each gltf.scene of each building:
  scene.traverse((node) => {
    if (!node.isMesh) return;
    if (!node.geometry || !node.material) return;
    Collect this node's:
      - geometry (positions, uvs)
      - mesh.matrixWorld (the sub-mesh's transform within the GLB)
      - material.map (the THREE.Texture reference) and material.color
  })
```

Then for each sub-mesh: compute the FULL world matrix = buildingWorldMatrix (ring slot translation + scale-to-1000wu + center-anchor) × mesh.matrixWorld. Bake into vertex positions during collection (same approach as the existing `collectAndMergeGeometries`).

The building-level worldMatrix is computed from the SCENE bbox (currently done in both `use-merged-buildings-asset.ts` and `meshlet-spike-all-12/page.tsx`). Compute it ONCE per building, then apply to every sub-mesh of that building.

### Atlas — dedup textures by reference

Walk all sub-meshes and build `Map<THREE.Texture, slotIndex>`. Each unique texture gets one slot. Sub-meshes that share a texture share a slot. Sub-meshes without a diffuse texture (material.color only) get assigned to an aggregate "solid color" slot keyed by hex color.

Expected unique-texture count: 30–50 (krusty-krab has ~20 unique, others have 3–8 each, with some sharing).

### Atlas dimensions

Use 8×8 grid of 512px slots = 4096×4096 atlas, 64-slot capacity. If you actually find more than 64 unique textures across all 11 buildings, bump to 4096×8192 (128 slots) and warn. Fits the Iris Xe 8192px adapter cap.

Padding: 2px inside each slot, replicated edge bands top/bottom to prevent bilinear/mipmap leak (same pattern as current `build-buildings-atlas.ts`).

### UV remap

For each sub-mesh: remap its vertex UVs from [0,1]² into its assigned slot's inner region. Apply `fract()` first so UVs > 1 (tiled textures) collapse into the slot. Same math as the current per-building remap, just keyed per-sub-mesh.

### Per-sub-mesh MergeInput

Each sub-mesh becomes:

```ts
{
  geometry: subMeshGeometry,           // positions + remapped uvs, world matrix baked in
  worldMatrix: new THREE.Matrix4(),    // identity — already baked
  sourceId: i,                          // unique index, 0..N-1 where N <= 4096 (12-bit cap)
  color: subMeshColor,                  // hash-color fallback for materialMode=0
}
```

(Alternative if simpler: pass the world matrix in `worldMatrix` and DON'T bake it during collection. The existing `mergeGeometriesToMeshletAsset` will bake it. Either way works as long as the math is consistent.)

### Shader — no change needed

`apps/web/src/lib/three/experimental/nanite-rasterizer.ts` already supports materialMode=1 sampling a single `texture_2d` atlas with `texture(atlasTexture, uv).grad(dx, dy)`. The shader code is correct as-is. ALL the per-mesh information is encoded in (a) the remapped UVs the shader already samples, and (b) the sourceId encoded in meshletTriangleArray's high bits which the shader already extracts.

DO NOT touch the shader unless you're certain you need to.

## r182 TSL known bug — do NOT re-discover

`node_modules/three/src/renderers/webgpu/nodes/WGSLNodeBuilder.js` `generateTextureGrad` and `generateTextureLevel` accept `depthSnippet` param but never emit it → `texture(arrayTex, uv).depth(layer).grad(dx, dy)` fails to compile with `no matching call to textureSampleGrad`. Literal `// TODO handle ... array_index` comment at line ~654.

This is why we use a single `texture_2d` ATLAS, not `texture_2d_array`. Stay on the atlas path. The shader code already does the right thing.

## Files to modify

1. **`apps/web/src/lib/three/meshlet/build-buildings-atlas.ts`** — rewrite to accept per-sub-mesh inputs, dedup textures by reference, build the atlas with one slot per unique texture, remap each sub-mesh's UVs to its texture's slot. The exported function signature should change to something like:

```ts
export function buildSubMeshAtlas(subMeshes: SubMeshInput[]): {
  texture: THREE.Texture;
  uniqueTextureCount: number;
  perSubMesh: { id: string; slotCol: number; slotRow: number }[];
}
```

where `SubMeshInput` carries `{ id, geometry, diffuse, fallbackColor }`.

2. **`apps/web/src/lib/three/meshlet/use-merged-buildings-asset.ts`** — replace the current flow with the per-sub-mesh enumeration. Build a flat list of sub-meshes across all 11 buildings, call `buildSubMeshAtlas`, then pass the per-sub-mesh inputs to `mergeGeometriesToMeshletAsset`.

3. **`apps/web/src/app/preview/meshlet-spike-all-12/page.tsx`** — apply the same change to the inline loader (lines ~278-360). The spike page must mirror the hook so the visual QA matches production.

DO NOT modify `apps/web/src/lib/three/experimental/nanite-rasterizer.ts` unless absolutely necessary. The shader and merge function should accept the per-sub-mesh inputs without change.

## Build + verify loop

```bash
cd /c/Users/newma/Documents/Crypto/ClawVille-meshlet/apps/web
bun run build 2>&1 | tail -8
```

Then kill any running server and restart:
```bash
# Find PID listening on 3000:
pwsh -NoProfile -Command "Stop-Process -Id ((Get-NetTCPConnection -LocalPort 3000 -State Listen -EA SilentlyContinue).OwningProcess) -Force -EA SilentlyContinue; Start-Sleep 2"
# Start prod server:
cd /c/Users/newma/Documents/Crypto/ClawVille-meshlet/apps/web
(bun run start > /tmp/clawville-web.log 2>&1 &)
sleep 6
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3000/preview/meshlet-spike-all-12
```

NEVER use `bun run dev` — crashes Iris Xe.

## Visual success criterion

`http://localhost:3000/preview/meshlet-spike-all-12?cb=N` (bump N each iteration) must show:
- All 11 buildings visible at ~100 FPS (we had 110 FPS in the broken per-building atlas — must not regress)
- Each building's sub-meshes show their CORRECT distinct textures, e.g.:
  - Krusty-krab: brown wood roof + tan stucco walls + the orange "Krusty Krab" sign + windows
  - Claw-arcade: pink tower body + distinct window panels + cyan accent details
  - Boating-school: orange/red staircase sections distinct from wall paneling
  - Cove: stained-glass dome panes distinct from supporting beams
- No big magenta blocks (that's the unused atlas slot or a fallback indicator)
- Slot count printed to console: `[atlas] N unique textures packed (T solid-color)`

You have Chrome MCP tools available. Use them. After every build + restart cycle, navigate Chrome to the spike page with a fresh cb=, sleep 14s, take a screenshot, and read console messages. Compare against the production /game (no `?meshlets=1`) to confirm textures match.

## When to commit

Once the spike-all-12 screenshot shows correct per-sub-mesh textures and 80+ FPS:

```bash
cd /c/Users/newma/Documents/Crypto/ClawVille-meshlet
git add -A
git commit -m "phase-b v4: per-sub-mesh atlas — each sub-mesh renders its correct diffuse"
unset GITHUB_TOKEN && git push origin perf/meshlet-integration
```

DO NOT push to staging or master.

## Output requirements

When you finish (or if you hit a wall):
1. Final commit hash on `perf/meshlet-integration`
2. Screenshot of working spike-all-12 page (any path under `C:\Users\newma\AppData\Local\Temp\` is writable)
3. Atlas stats: how many unique textures, what slot grid, what % capacity
4. FPS reading from the spike HUD
5. Any remaining defects with their root cause

If you hit a blocker you cannot resolve, STOP immediately and report which exact command failed with which exact error. Do not sit silent — partial progress with a clear blocker is more useful than 30 minutes of nothing.
