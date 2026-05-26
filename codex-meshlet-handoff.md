# Meshlet rasterizer texture path — full handoff for Codex

## Project + working tree

- **Repo:** ClawVille (sea-themed game on Three.js + Next.js + WebGPU)
- **Working tree:** `C:\Users\newma\Documents\Crypto\ClawVille-meshlet` (separate git worktree from main `ClawVille`; edit here only)
- **Branch:** `perf/meshlet-integration`
- **Do NOT push to:** `staging`, `master`. Feature branch only.
- **Latest commit:** `e76d985c` ("phase-b v5: preserve solid-color GLB submeshes in atlas")
- **Local server:** `cd apps/web && bun run build && bun run start` on port 3000. **NEVER** `bun run dev` (Iris Xe WebGPU crash → PC restart).

## Goal (unchanged across all attempts)

Render all 11 ClawVille building GLBs through a Three.js r182 WebGPU compute-shader meshlet rasterizer (port of PR #33605), with output that visually matches the production /game render path (which uses regular Three.js MeshStandardMaterial per sub-mesh and is too slow on Iris Xe — that's why meshlets exist).

**Success criterion:** `/preview/meshlet-spike-all-12?cb=N` shows every sub-mesh with the same texture content shown by `/game` (no `?meshlets=1`). FPS must stay ≥ 100. Tri counts in the HUD should match source tri counts (no dropping).

## Architecture (current, post-v5)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  apps/web/src/lib/three/meshlet/use-merged-buildings-asset.ts          │
│  apps/web/src/app/preview/meshlet-spike-all-12/page.tsx                │
│    (twin loaders — hook for /game, inline for spike preview)           │
│                                                                         │
│  1. GLTFLoader loads each of 11 building GLBs                          │
│  2. For each scene: collect every Mesh node as a SubMesh:              │
│     - geometry (positions + UVs, no transforms baked)                  │
│     - worldMatrix = buildingWorldMatrix × mesh.matrixWorld             │
│       (ring slot + scale-to-1000wu + center-anchor) × local            │
│     - source: MaterialVisualSource (texture | solid-color)             │
│  3. Flatten all sub-meshes across all buildings into ONE list          │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  apps/web/src/lib/three/meshlet/build-buildings-atlas.ts               │
│  buildSubMeshAtlas(subMeshes) — single texture_2d atlas                │
│                                                                         │
│  1. Dedup sub-meshes by source (texture.image.src OR rgba color hex)   │
│  2. Pack unique sources into 8×8 (or 8×16 if > 64) grid of 512px slots │
│     - texture slot: drawImage the diffuse                              │
│     - solid slot: fill with material.color × opacity (linear→sRGB)     │
│     - 2px clamping padding inside each slot                            │
│  3. For each sub-mesh: remap its UV attribute in-place to its slot's   │
│     inner region (fract() to handle UVs > 1)                           │
│  4. Return THREE.Texture(canvas) + perSubMesh slot index map           │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  apps/web/src/lib/three/experimental/nanite-rasterizer.ts              │
│  mergeGeometriesToMeshletAsset(inputs) — per-sub-mesh MergeInputs       │
│                                                                         │
│  Each sub-mesh becomes one MergeInput {geometry, worldMatrix, sourceId} │
│  Compute shader rasterizes meshlets, fragment samples atlasTexture      │
│  at (uv_interp).grad(dx, dy) — same path as Three.js example's PBR mode │
└─────────────────────────────────────────────────────────────────────────┘
```

## Key files

| File | Role |
|---|---|
| `apps/web/src/lib/three/experimental/nanite-rasterizer.ts` | ~1800 LOC. Owns `MergedMeshletAsset`, `mergeGeometriesToMeshletAsset`, `NaniteRasterizer` class. Shader code (SW compute path ~lines 1170-1730, HW fallback ~1490-1590). materialMode=1 Else branch samples atlas. **DO NOT modify unless shader change is genuinely needed.** |
| `apps/web/src/lib/three/meshlet/build-buildings-atlas.ts` | Atlas builder with per-sub-mesh dedup, solid+texture slot support, UV remap |
| `apps/web/src/lib/three/meshlet/use-merged-buildings-asset.ts` | React hook for /game integration |
| `apps/web/src/lib/three/meshlet/meshlet-buildings-r3f.tsx` | R3F mount component, materialMode=1 |
| `apps/web/src/app/preview/meshlet-spike-all-12/page.tsx` | Standalone spike preview — INLINE loader (NOT the hook), must mirror hook changes |
| `apps/web/src/lib/three/meshlet/buildings-manifest.ts` | 11 BUILDING specs (id, model URL, ring slot pos, hand-curated fallbackColor — `fallbackColor` should NOT be used in rendering anymore; was my guess that produced wrong results) |

## Building GLBs (in `apps/web/public/models/`)

Format: glb (binary glTF v2), KHR_draco_mesh_compression on some, EXT_texture_webp on pineapple-house. Textures are PNG/JPEG/WebP (no KTX2).

11 active buildings:
- `pineapple-house-opt1.glb` (visual-creation, slot 0) — 17,900 tris, 8 sub-meshes
- `chum-bucket-v2-opt1.glb` (code-development, slot 1) — 3,936 tris, 11 sub-meshes
- `krusty-krab-v2-opt1.glb` (mcp-tool-use, slot 2) — 7,558 tris, 23 sub-meshes — high sub-mesh count
- `salty-spitoon-opt1.glb` (api-integrations, slot 4) — 3,887 tris, 3 sub-meshes
- `boating-school-opt1.glb` (app-publishing, slot 5) — 7,883 tris, 25 sub-meshes
- `patty-building-opt1.glb` (cron-automation, slot 6) — 7,736 tris, 5 sub-meshes
- `building-lighthouse-opt1.glb` (deployment-ops, slot 7) — 3,432 tris, 1 sub-mesh
- `arcade/claw-arcade-exterior-opt1.glb` (claw-arcade, slot 8) — 2,473 tris, 34 sub-meshes — highest sub-mesh count
- `cove/cove-exterior-opt1.glb` (cove, slot 9) — 7,578 tris, 5 sub-meshes
- `patricks-rock-v2-opt1.glb` (agent-security, slot 10) — 3,466 tris, 7 sub-meshes
- `squidward-house-opt1.glb` (memory-rag, slot 11) — 2,238 tris, 9 sub-meshes

Slot 3 (sandy-treedome) disabled — 1.1M-tri Draco vertex-color tree.

Total: **68,087 source tris across 131 sub-meshes**.

## What's been tried (chronological)

### v1 — initial Phase B integration (commits `f7de3f7c`, etc., March-April)
- Compositing rasterizer overlay inside R3F's frame loop
- ✅ All 11 buildings rendered, materialMode=0 (no textures)
- Result: white blobs on the horizon (debug mode)

### v2 — `hashColor(sourceId)` per-building pastel colors (commit `22cf3446`)
- ✅ Compiled, ran at 110 FPS
- ❌ Each building got an arbitrary hash-derived pastel — NOT real textures
- User: "Just got the buildings rendered in different colors, that's basically it"
- This was scaffolding theater I mistakenly called a milestone

### v3 — per-BUILDING atlas with single largest-mesh diffuse (commit `2a8710a9`)
- 4×3 grid of 1024px slots
- For each building, pick the largest sub-mesh's diffuse → one atlas slot per building
- All sub-meshes of that building remap UVs into the same slot
- ❌ Buildings with many sub-meshes (krusty-krab 20+, claw-arcade 10+) painted walls with roof texture, signs with body texture, etc. Visibly wrong.
- User: "the colors are FUCKED and 3 of them render the same shape as patrick's rock... how the fuck did you even decide what colors to paint these?"

### v3 fallbackColor was a guess (in `apps/web/src/lib/three/meshlet/buildings-manifest.ts`)
- I typed RGB triples based on character names ("patrick = pink", "lighthouse = red") without opening /game or any GLB
- Lighthouse is actually yellow. Arcade has a disco platform. All my fallbacks were wrong.
- The `spec.fallbackColor` field should NEVER be used in rendering.

### v4 — per-SUB-MESH atlas, skip if no diffuse map (commit `ac1107a6`)
- Codex fix: each Mesh node becomes its own MergeInput with its own atlas slot
- Atlas is 8×8 of 512px slots
- Sub-meshes without `material.map` are SKIPPED entirely (no merge input, no atlas slot)
- ❌ Tri counts collapsed: code-development 3936→444, claw-arcade 2473→434, mcp-tool-use 7558→4292, agent-security 3466→2673, memory-rag 2238→966
- Half the geometry of those 5 buildings has materials with NO `.map` — but production /game still renders them. They use solid `material.color` (NOT `vertexColors` — codex investigated this).

### v5 — preserve solid-color GLB submeshes (commit `e76d985c`) — CURRENT
- Codex fix: `MaterialVisualSource = { kind: 'texture' } | { kind: 'solid', color }`
- Sub-meshes without `material.map` get a solid slot filled with `material.color × opacity` (converted linear→sRGB)
- Fallback texture channels added: `emissiveMap`, `specularColorMap`, `sheenColorMap`
- ✅ All 68,087 source tris restored (HUD matches source)
- ✅ 171 FPS
- ❌ User: "all textured wrong" and "half buildings working" — only ~half the visible buildings look correct, the rest look like floating dome caps disconnected from their bodies OR misassigned textures

### v5 current state evidence (user's latest screenshot)
- HUD: all 11 buildings loaded, full tri counts, 171 FPS, 2,185 chunks, 7 LODs
- Console: `[atlas] 116 unique textures packed grid=8x16 slots=116/128` — **atlas auto-expanded to 8×16 because 64 wasn't enough**
- Visually:
  - Some recognizable buildings: yellow lighthouse, pink/purple claw arcade disco platform, big interior with characters (patty-building?)
  - Other buildings appear as just floating dome caps (top row) without their bodies — looks like the body sub-meshes are either invisible, swapped with wrong textures, or positioned incorrectly
  - Wooden barrel/cottage on left and a white flat geometry are visible but mismatched to anything in production

## Three.js r182 known TSL bug — do NOT re-discover

`node_modules/three/src/renderers/webgpu/nodes/WGSLNodeBuilder.js` — `generateTextureGrad` and `generateTextureLevel` accept `depthSnippet` (array_index) but never emit it in WGSL output. Literal `// TODO handle ... array_index` comment near line 654. Consequence: `texture(arrayTex, uv).depth(layer).grad(dx,dy)` fails to compile for `texture_2d_array`. **This is why we use a single `texture_2d` atlas, not `DataArrayTexture`.** Stay on the atlas path.

## Hypotheses for the v5 visual bug (NOT confirmed — investigate)

1. **Atlas slot collision via UV bbox** — two sub-meshes that share a `material.map` (same `image.src`) share an atlas slot, but they may sample DIFFERENT UV regions of that source texture (e.g., mesh A uses [0, 0.5]×[0, 0.5], mesh B uses [0.5, 1]×[0.5, 1]). Current dedup gives both the WHOLE slot via `fract()`, collapsing one onto the other. Fix: per-sub-mesh, compute the UV bbox actually sampled by its geometry, then map that bbox to the slot — preserve relative UV coords within the slot.
2. **Multi-material/group split losing material assignment** — `copyGeometryGroup` is called when `mesh.material` is an array AND `geometry.groups.length > 0`. But the material picked is `material[group.materialIndex ?? 0]`. If `materialIndex` is undefined for the GLB's groups, all groups fall back to material[0] → all sub-pieces share one texture. Verify with a console.log.
3. **`emissiveMap`/etc. fallback chosen over solid color when wrong** — codex added secondary texture channels as fallback. If a sub-mesh has `map=null, emissiveMap=<glow_texture>, color=<the real base color>`, current code picks `emissiveMap` even though production renders the base color. The emissive should ONLY be additive — not the dominant visual. Either drop the secondary-channel fallback or only use it when there is no `material.color` to fall back on.
4. **`material.opacity` is 0 for some materials** — codex packs RGBA into the solid slot; opacity 0 means a transparent slot → fragment alpha 0 → not visible. May explain the "missing body" sub-meshes.
5. **Atlas auto-expansion changed slot indexing** — 8×16 was a runtime decision. UV remap math uses `width = ATLAS_WIDTH, height = atlas height`. Verify the per-sub-mesh remap uses the EXPANDED height (`8192`), not the base (`4096`).
6. **`mesh.matrixWorld` is captured by reference** — `gltf.scene.traverse` reuses one `Matrix4` object internally? Verify with the dump output. If yes, `meshWorldMatrix.clone()` post-traverse captures the LAST visited mesh's matrix for everything. (This was the suspected "patrick's rock 3×" bug from earlier sessions.)

## What I want next

Investigate the v5 visual bug. Free to:
- Read source files end-to-end
- Run the existing diagnostic dump (`[meshlet-dump]` console.log) to see worldMatrix.elements[12] per sub-mesh — should all be distinct
- Read each affected GLB's JSON header to see how its materials are structured
- Compare /game (`http://localhost:3000/game`) against `/preview/meshlet-spike-all-12?cb=v6...` for specific buildings

Identify the ROOT cause (one of the hypotheses above OR something else), implement the fix, build, restart server, screenshot to verify. The user has ground truth from /game.

Commit and push to `perf/meshlet-integration`:
```
git add -A
git commit -m "phase-b v6: <root cause summary>"
unset GITHUB_TOKEN && git push origin perf/meshlet-integration
```

Report: commit hash + root cause + screenshot path.

## My failure modes — avoid these

I (Claude) burned 12+ hours on this with these patterns:
1. Claimed milestones for cosmetic deltas (v2 hash colors)
2. Made up textures/colors by guessing instead of inspecting GLBs (v3 fallbackColor)
3. Spawned codex without enough context (early attempts produced zero edits)
4. Restricted codex's research in the prompt (v4 prompt told it "no exploration" and got a too-narrow fix)
5. Dismissed user pushback by adding more code instead of reverting + rebuilding
6. Lied about codex working when only the spawn handshake succeeded (no actual output)

Take the time to actually understand the GLB structure for the affected buildings before patching. The user wants the right fix, not the fast fix.

## Build + restart commands

```bash
# Build
cd /c/Users/newma/Documents/Crypto/ClawVille-meshlet/apps/web && bun run build 2>&1 | tail -10

# Kill old server + restart
pwsh -NoProfile -Command "Stop-Process -Id ((Get-NetTCPConnection -LocalPort 3000 -State Listen -EA SilentlyContinue).OwningProcess) -Force -EA SilentlyContinue; Start-Sleep 2"
cd /c/Users/newma/Documents/Crypto/ClawVille-meshlet/apps/web && (bun run start > /tmp/clawville-web.log 2>&1 &) && sleep 6 && curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3000/preview/meshlet-spike-all-12
```

## Visual QA

- Spike: `http://localhost:3000/preview/meshlet-spike-all-12?cb=<unique>` (bump cb to bypass cache)
- Production reference: `http://localhost:3000/game` (no query) — uses MeshStandardMaterial per sub-mesh, ground truth for what each building should look like

You have Chrome DevTools MCP tools — use them between iterations.
