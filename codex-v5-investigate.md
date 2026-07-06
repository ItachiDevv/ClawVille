Working dir already set. Branch: perf/meshlet-integration. Latest commit: ac1107a6.

## What just happened

Previous codex pass shipped a "skip sub-mesh if material.map is null" rule. That works for sub-meshes that genuinely lack textures, but it threw away too much. Tri counts collapsed for buildings that DO render correctly in /game (the production Three.js path):

Building          | tris after my rule | tris in source/full
code-development  | 444                | 3936
claw-arcade       | 434                | 2473
mcp-tool-use      | 4292               | 7558
agent-security    | 2673               | 3466
memory-rag        | 966                | 2238

So roughly half the geometry of those buildings has materials whose `.map` is null at the moment my code checks, but the texture IS rendered in the production path. Reasons this could be true (you investigate, don't guess):

- The GLB sub-mesh uses vertex colors (geometry.attributes.color) instead of a texture.
- The sub-mesh has a multi-material array and only some indices have maps; my code reads material[0].
- The sub-mesh uses a texture from a different glTF channel (emissiveMap, metallicRoughnessMap with bake) and material.map is null but a different map IS the dominant visual.
- The texture is async loaded (GLTFLoader returns scene before all textures resolve) and material.map is null at the instant we check, but populates later.
- The mesh's material is a `MeshBasicMaterial` or some non-standard material where the texture lives on a different property.
- Some other glTF extension (KHR_materials_*) where the texture is on an extension object.

## Your job

1. Investigate the actual GLB structure for these 5 buildings. Free to read source files, dump material/geometry info, write throwaway diagnostic code, console.log everything. NO restrictions on research depth this time.

2. Once you understand WHY each affected sub-mesh has no `.map`, design the right fix. Options I can think of (not exhaustive):
   - If vertex colors: support a per-mesh "vertex color mode" — atlas slot becomes solid sampled-from-vertex-colors OR the merged geometry carries the color attribute through to a separate shader path. Easier: bake vertex colors into a 1×1 texture per mesh, use as the diffuse.
   - If multi-material with map on index N: pick the first material with a map, not material[0].
   - If async load race: await all textures before building the atlas. Texture.image is null until the JPEG/PNG decodes — texture has a .onLoad callback or you can resolve via `await new Promise(r => tex.image.addEventListener('load', r))`.
   - If on a different glTF channel: look at emissiveMap as a secondary fallback.

3. Implement the fix. Build. Verify the spike preview shows tri counts comparable to source (within ~5-10% — losing some non-textured decoration meshes is fine, losing half is not).

4. Commit + push to perf/meshlet-integration:
   ```
   git add -A
   git commit -m "phase-b v5: <one-line summary of root cause + fix>"
   unset GITHUB_TOKEN && git push origin perf/meshlet-integration
   ```

5. NOT to staging/master. NOT to main ClawVille worktree.

## Files

- apps/web/src/lib/three/meshlet/build-buildings-atlas.ts
- apps/web/src/lib/three/meshlet/use-merged-buildings-asset.ts
- apps/web/src/app/preview/meshlet-spike-all-12/page.tsx
- apps/web/src/lib/three/experimental/nanite-rasterizer.ts (only if shader change is needed)
- Building GLBs at: apps/web/public/models/*.glb (use a node script with `gltf-pipeline` or just `cat` the JSON header to inspect material structure)

## Build + restart

```
cd apps/web && bun run build 2>&1 | tail -10
pwsh -NoProfile -Command "Stop-Process -Id ((Get-NetTCPConnection -LocalPort 3000 -State Listen -EA SilentlyContinue).OwningProcess) -Force -EA SilentlyContinue; Start-Sleep 2"
cd apps/web && (bun run start > /tmp/clawville-web.log 2>&1 &) && sleep 6
```

## Visual QA URL

`http://localhost:3000/preview/meshlet-spike-all-12?cb=<unique>` — bump cb each iteration

You have Chrome DevTools MCP tools. Use them. After every build cycle, screenshot to verify, take the spike HUD tri counts as ground truth.

## Reference (what good looks like)

The production /game render path uses standard Three.js with `MeshStandardMaterial` per sub-mesh. That's what the user sees in /game without `?meshlets=1`. Open it in Chrome to compare textures.

Earlier in this session I (Claude) shipped four wrong versions: hash colors, per-building atlas, per-sub-mesh atlas with guessed solid color fallback, and the current "skip if no map" rule. All of them produced visibly wrong output. The user is at the end of their patience. Take the time to actually understand the problem before patching.

## Report

When done: commit hash, root cause in one sentence, screenshot path, and a tri-count table comparing source vs rendered.

If you hit a blocker, report it with exact command + exact error. Don't sit silent.
