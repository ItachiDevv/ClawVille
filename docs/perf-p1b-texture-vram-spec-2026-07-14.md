# P1b — Texture VRAM reduction: NPC/prop KTX2 coverage + VRM cross-instance texture dedupe

**Status: FROZEN SPEC 2026-07-14 (Fable). Implementer: Codex. Branch: `perf/p1b-texture-vram` (worktree `C:/Users/itachi/Documents/Crypto/cv-perf14`, based on staging `3fb56999`).**

## Measured baseline (live staging probe 2026-07-14, scene texture census via CDP)

Total estimated texture VRAM in the /game scene: **~491MB** (269 unique textures, renderer reports 276). Attribution:

| Bucket | Est. VRAM | Root cause |
|---|---|---|
| 32× 1024² uncompressed (map/normal/rough/ao/emissive) | 170MB | `/models/characters/*.glb` (11 location-NPC teacher models: spongebob, gary, squidward, flying-dutchman, pearl, mrs-puff, mr-krabs, plankton, karen, sandy, patrick) never added to `scripts/compress-ktx2.ts` TARGETS |
| 55× 512² uncompressed | 73MB | Same characters + `quest-bounty-pavilion-ktx.glb` interior ("GGLP_Display_Reconstruction": ~40 ao/normal/roughness/specular maps) + building non-color maps — the P1 script only compresses `baseColorTexture`/`emissiveTexture`, never non-color slots |
| VRM per-instance duplicates (Image_0 ×5, Image_3 ×3, normal ×3, 9 ×2, texture_diffuse ×2, Image_1 ×2, ao_met_rough ×3 …) | ~70MB | `vrm-loader.ts` parses a fully disjoint VRM per (path, instanceId) — N NPCs wearing the same file hold N copies of every texture and pay N GPU uploads |
| Compressed world textures (24× 1024² C + 29× 512² C etc.) | ~50MB | Already optimal (P1) |

VRM files themselves are already optimized (all textures 1024² WebP; full-library uncompressed VRAM only ~145MB) — the old "~317MB VRM textures" figure is stale; do NOT re-encode the VRM files.

**Safety fact (verified):** nothing in the app ever ticks `expressionManager`/`lookAt` (`vrm-character-animator.ts` `updateMixerOnly` only ticks the mixer; zero call sites for `expressionManager`), and nothing mutates `texture.offset` on VRM materials. Cross-instance texture sharing is safe.

## Prong A — extend the KTX2 pipeline to characters + non-color slots

### A1. `scripts/compress-ktx2.ts`
1. Add to `TARGETS`: the 11 `/models/characters/*.glb` above (NOT `sandy-static-backup.glb`).
2. Extend slot coverage: keep `baseColorTexture`/`emissiveTexture` → ETC1S (QLEVEL 192, as today). ADD non-color slots — `normalTexture` → **UASTC** (ETC1S wrecks normals); `metallicRoughnessTexture`, `occlusionTexture`, spec-gloss variants → ETC1S is acceptable (roughness banding is invisible on these cartoon assets) or UASTC if simpler to implement uniformly. Use `@gltf-transform/cli` `uastc`/`etc1s` with `--slots` patterns; the existing WebP→PNG remap must apply to the new slots too.
3. Regenerate ALL existing TARGETS so already-shipped `-ktx.glb` files gain compressed non-color maps (this is where the pavilion's 40 uncompressed 512² maps go away).
4. Characters output NEW sibling paths `characters/<name>-ktx.glb` (new URL → no cache-bust needed). Regenerated EXISTING `-ktx.glb` files keep their path ⇒ **MANDATORY cache-bust: bump/add `?v=N` on every code reference to every regenerated file** (grep `apps/web/src` for each filename; also check `asset-preload-manifest.ts` and `sw.js` behavior). Missing this = silent 7-day stale asset on prod (Cloudflare edge cache cannot be purged; see CLAUDE.md kill-the-build invariants).
5. Preserve: skinned meshes, animations (characters are animated — verify clips survive the round-trip, e.g. assert `animations.length` unchanged via a post-pass parse check script), EXT_meshopt_compression, and KHR_materials variants. `toktx` is in PATH (scoop shim).

### A2. `arena-location-npcs.tsx`
1. Point the 11 model paths at the new `-ktx.glb` files.
2. **Fix the preload mismatch at ~line 815**: `useGLTF.preload(models[index], undefined, undefined, extendLoaderWithMeshopt)` must use the same `extendLoaderWithMeshoptAndKTX2` extension as the render-path `useGLTF` (line ~428). A KTX2-textured GLB parsed by the non-KTX2 preload loader hard-fails the parse and poisons the drei cache.
3. Check every other reference to `/models/characters/` (grep whole web app incl. preload manifests) and update consistently.

### A3. Landing/vignette users
Any other component loading a regenerated GLB (e.g. `quest-bounty-pavilion.tsx`, `bazaar-stall.tsx`, `marketplace-stall.tsx`, `arena-buildings.tsx`, cove files, `BuildingVisitVignette.tsx`) — confirm the loader has KTX2 attached (most use `useGLTFWithKTX2` already) and bump `?v=`.

## Prong B — VRM cross-instance texture dedupe (`vrm-loader.ts`)

Keep the per-instance parse architecture (skeleton/humanoid correctness depends on it — do NOT switch to scene cloning). Share only textures:

1. Module-level canonical cache: `Map<string, { tex: THREE.Texture; refs: number }>` keyed `${path}#tx${gltfTextureIndex}`. Get the glTF texture index for each `THREE.Texture` via `gltf.parser.associations` (Map entries `{ textures: <index> }` in three r185). If associations don't yield an index for a texture, leave that texture per-instance (fail open, never crash).
2. In `loadInstance` after `normaliseVRM`: traverse `vrm.scene` materials; for every texture-valued material property, if a canonical entry exists → assign the canonical texture to the slot, `refs++`, and `dispose()` the fresh duplicate (it has never uploaded — dispose is free). Else register the fresh texture as canonical with `refs = 1`.
3. Track per-instance which canonical keys it references (store on the instance entry). `disposeVRMInstance` must NOT let `VRMUtils.deepDispose` destroy shared textures other instances still use: replace `deepDispose` with a local `disposeVRMSceneSharedAware(scene, sharedTexSet)` that disposes geometries/materials but calls `texture.dispose()` only for non-shared textures; for shared ones decrement `refs` and dispose+evict when `refs === 0`. Apply the same in ALL deepDispose call sites in this file (stale-gen paths at loadInstance guards, `_vrmClearAllCaches`).
4. Edge cases: (a) the stale-gen post-parse dispose paths run BEFORE dedupe registration or after — make the order explicit so refcounts can't leak; (b) `_vrmClearAllCaches` clears the canonical map after disposing; (c) two concurrent first-parses of the same path racing to register the same key — last-wins is fine but the loser's texture must be disposed and refs must stay consistent (registration happens on the single-threaded main thread between awaits — just do the whole swap synchronously after parse).
5. MToon materials: same traversal (their texture props enumerate via `Object.entries` like the metrics collector at `collectVRMSceneCounts` — reuse that enumeration pattern).
6. Do NOT share textures across different paths even if content-identical. Do NOT share render targets or anything without an association index.

Win: repeated NPCs of the same VRM stop duplicating VRAM AND stop re-uploading textures at late spawn (the residual "quick freeze" the founder saw on Iris Xe) — the canonical texture is already on the GPU.

## Constraints (kill-the-build)
- No `InstancedMesh + ShaderMaterial`, no drei `<Text>`/`<Billboard>` (Iris Xe).
- TypeScript strict; no `any` beyond existing patterns.
- `?v=` cache-bust on every mutated-in-place asset (A1.4).
- Same-diff doc update: `3dStructure.md` (texture pipeline / perf section) — one paragraph on the extended KTX2 slot coverage + VRM texture dedupe, bump "Last Audited".
- Do not touch `World3DCanvas.tsx` warmup logic, reversed-depth, or meshlet LOGIC (rasterizer, visibility buffer, loaders). **AMENDMENT 2026-07-14:** `?v=` version-string bumps on asset URLs inside `meshlet/buildings-manifest.ts` are REQUIRED by A1.4 and explicitly allowed — the no-touch rule covers meshlet code paths, not asset-version data. URL-version edits only; no other changes in that file.

## Proof expected from implementer
1. `bun run scripts/compress-ktx2.ts` output table (per-file before/after sizes, converted counts, zero errors).
2. Post-pass parse-check evidence that character animations survive (clip counts per file).
3. `cd apps/web && bunx tsc --noEmit` clean (or repo-standard typecheck) + `bun run build` succeeds from repo root.
4. List of every regenerated `-ktx.glb` and the matching `?v=` bumps (file:line).
5. Brief note on Prong B refcount invariants (where refs++/-- happen) for review.

## Verification after implementation (Fable, not Codex)
Local prod bundle (`bun run build && bun run start` :3010) + CDP probes: texture census expected **~491MB → ~250MB**; visual parity screenshots (Patrick, Karen, Dutchman, pavilion interior, wandering VRM NPCs); load probe (no new long tasks); steady probe (0-1/600 >33ms). Then staging + founder eyes (Rule E4).
