# Add a building (or swap an existing GLB)

## Preconditions

- The new GLB exists at `apps/web/public/models/<slug>.glb`. Measure it with `scripts/read-glb-bbox.mjs` first — you need its bbox + footprint to decide on `scaleOverride` / `yOffset` / `rotY`.
- If you're swapping a GLB on an existing slot (not adding a new one), rename the file with a `-v2` / `-v3` suffix to bypass the 1-year immutable browser cache. See `3dStructure.md §13` for prior swaps.

## Steps

1. **Drop the GLB** at `apps/web/public/models/<slug>.glb` (or `<slug>-v2.glb` on a swap).
2. **Wire it in `apps/web/src/lib/three/arena-buildings.tsx`** — add an entry to `BUILDING_MODELS`:
   ```ts
   '<zone-id>': {
     model: '/models/<slug>-v2.glb',
     yOffset: 0,
     rotY: <radians>,
     rotYOffset: <optional>,
     scaleOverride: <optional, only for EXT_mesh_gpu_instancing GLBs>,
   },
   ```
3. **Strip pass.** If the source GLB has any Sketchfab portfolio cruft, extend `stripDecorativeMeshes()` in the same file:
   - Yanez Designs assets have a `Skybox_*` mesh → already caught by the `Skybox_` prefix rule in `DECORATIVE_NAME_PREFIXES`.
   - Per-building dome backdrops with non-Skybox names → add to `BACKDROP_KILL_NAMES`.
   - Orphan domes parented to `Sketchfab_Scene` directly → add their material name to `BACKDROP_KILL_MATERIALS`.
4. **Typecheck + ship.** Use [`ship-a-feature.md`](./ship-a-feature.md).
5. **Browser verify** at the zone position. Check: building visible, no floating dome backdrop, sits on terrain at y=-2, faces the village center, label projected above.

## Doc updates required (same diff)

- [ ] **`WorldContent.md §2`** — building roster table. New row OR update the existing slot's GLB column.
- [ ] **`3dStructure.md §2`** — only if you changed the scale / pivot / ring radius / `MAX_FOOTPRINT` / target-height logic. Pure GLB swaps don't touch this.
- [ ] **`packages/agent-templates/src/locations/town-guide.ts`** — if the building's name, location, or theme changed. Nori's knowledge[] must mention every building.
- [ ] **GameFeatures.md §4** — if the building is a knowledge-book shop, ensure its 2 books still exist in `packages/shared/src/constants/knowledge-books.ts`.

## Watch out for

- Building's `Object_5`-sized inner mesh (>500k verts) — usually a transparent glass dome the artist baked in. Either strip it explicitly or accept that it'll show as a faint translucent shell.
- `bbox.min.y` not at the geometry floor — set `yOffset` to the negative of the floor height post-scale, OR fix the GLB to have its origin at the floor. See `3dStructure.md §2` "Y correction" for the math.
- Multiple buildings can render as identical blue domes if they're all using one re-compressed lossy GLB — verify with `md5sum` against the originals in `~/Downloads/` before swapping.
