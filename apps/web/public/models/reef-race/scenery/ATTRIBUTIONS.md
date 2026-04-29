# Reef Race Scenery Props — Attributions

Mixed asset directory: trees are CC0 third-party from Quaternius (downloaded via poly.pizza). All other props (rocks, fence, grass) are procedurally generated original geometry.

## License

All files in this directory are usable under **CC0 1.0 Universal (Public Domain Dedication)**. Quaternius releases all assets as CC0 (no attribution legally required, but credited below as a courtesy and to track provenance for future re-derivation).

## Props

| File | Source | License | Tris | Size | Origin |
|---|---|---|---|---|---|
| `prop-tree-pine.glb` | **Quaternius — "Pine"** via [poly.pizza/m/79gmlLnweB](https://poly.pizza/m/79gmlLnweB) | CC0 | 765 | 89 KB | y_min=0, XZ centered |
| `prop-tree-leafy.glb` | **Quaternius — "Tree"** via [poly.pizza/m/9nvGuZlbpE](https://poly.pizza/m/9nvGuZlbpE) | CC0 | 724 | 63 KB | y_min=0, XZ centered |
| `prop-rock-1.glb` | Procedural (blender07) | CC0 | 80 | 9.1 KB | y_min=0 |
| `prop-rock-2.glb` | Procedural (blender07) | CC0 | 80 | 9.1 KB | y_min=0 |
| `prop-rock-3.glb` | Procedural (blender07) | CC0 | 80 | 9.1 KB | y_min=0 |
| `prop-fence.glb` | Procedural (blender07) | CC0 | 72 | 8.6 KB | y_min=0 |
| `prop-grass-tuft.glb` | Procedural (blender07) | CC0 | 7 | 4.6 KB | y_min=0 |

## Tree dimensions (authored size, scale=1.0)

| Tree | Height | XZ extent | Trunk Y | Canopy Y |
|---|---|---|---|---|
| Pine (conifer) | 10.24 wu | ±2.90 wu | 0..9.94 | 2.67..10.24 (overlap with trunk top by design — branches sprout) |
| Leafy (broadleaf) | 5.54 wu | ±1.86 wu | 0..3.62 | 2.14..5.54 (canopy wraps trunk top — natural shape) |

The `ScenerySpawner` in `apps/web/src/lib/three/scenery-spawner.ts` (or wherever — see `river-scene.tsx`) should use `scaleMin/scaleMax` ≈ 15-25 to reach the prior 200 wu visible footprint. Adjust per playtesting.

## Tree visual style

- **Pine**: textured low-poly conifer, dark bark trunk (128×128 webp baseColor), three layered cone canopies of pine needles (128×128 webp with alpha BLEND for fluffy edges). Stylized "Christmas tree" silhouette. 2 materials.
- **Leafy**: untextured low-poly broadleaf, two flat-color materials — brown trunk (#4F2410 sRGB approx) and green canopy (#266224 sRGB approx). Trunk branches in two stems with rounded canopy clusters. 2 materials, 0 textures.

## Optimization pipeline applied to Quaternius source

Source FBX2glTF outputs were processed via `gltf-transform` to:

1. **Bake transforms** into vertex positions (manual TRS matrix bake, since `flatten()` failed on FBX2glTF asset hierarchy with non-identity scale)
2. **Strip per-face normals** to enable position welding (FBX2glTF emits unique vertex per face for flat shading — preventing simplification)
3. **Weld + dedup** at 0.001 tolerance
4. **Simplify** via meshoptimizer (pine ratio 0.20, leafy ratio 0.40)
5. **Drop** vertex color attributes, normal/occlusion/emissive textures, metallic factor (forced 0)
6. **Texture compress** to webp at 128×128 (pine only; leafy is texture-free)
7. **Center XZ** + **shift to y_min=0** so trees sit on the ground when placed by spawner
8. **Regenerate flat normals** per-face by un-welding triangles + cross-product face normals

Pine uses `EXT_texture_webp` extension (supported by three.js GLTFLoader r158+).

## Procedural prop art direction

Styled after the Kagelok "The River" low-poly aesthetic:
- Flat-shaded / faceted geometry (no smooth shading)
- Above-ground river bank environment
- Colors: rock grey (#8c857a), wood pinkish-brown (#a6673a)

## Usage in Three.js

All props have origin at base (y=0). Load with `GLTFLoader`, place via `ScenerySpawner` at x ∈ [±400, ±900] relative to the spline, y=0 on the river bed/bank.

Flat shading is baked into normals. No animations, no skeletons. `frustumCulled = true` is safe — bounding boxes are accurate post-transform-bake.

## Re-derivation

To re-derive these tree GLBs from source:

```bash
# Direct CDN URLs from poly.pizza
curl -O https://static.poly.pizza/082c2026-56af-4e3f-bea7-9ae5de71101f.glb  # Pine
curl -O https://static.poly.pizza/36ada9ac-2071-49f7-9e09-cda4add8589b.glb  # Tree (leafy)
```

Then run the optimization pipeline (`/tmp/trees/process.mjs` from this session) — strip normals, weld, simplify, bake transforms, regen flat normals.
