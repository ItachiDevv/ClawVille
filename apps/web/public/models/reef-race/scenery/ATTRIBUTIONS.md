# Reef Race Scenery Props — Attributions

Mixed asset directory: trees + cliff rocks are CC0 third-party from Quaternius (downloaded via poly.pizza). Small props (prop-rock-{1,2,3}, fence, grass) are procedurally generated original geometry.

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
| `cliff-rock-1.glb` | **Quaternius — "Rock Large"** via [poly.pizza/m/54jZKTAt5p](https://poly.pizza/m/54jZKTAt5p) | CC0 | 222 | 12.5 KB | y_min=0, XZ centered, transforms baked |
| `cliff-rock-2.glb` | **Quaternius — "Rock Medium"** via [poly.pizza/m/s1OJ3bBzqc](https://poly.pizza/m/s1OJ3bBzqc) | CC0 | 342 | 14.5 KB | y_min=0, XZ centered, transforms baked |
| `cliff-rock-3.glb` | **Quaternius — "Rock Medium"** via [poly.pizza/m/KZdEP3uUpa](https://poly.pizza/m/KZdEP3uUpa) | CC0 | 244 | 10.6 KB | y_min=0, XZ centered, transforms baked |

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

### Cliff rock optimization pipeline (cliff-rock-{1,2,3}.glb)

Source FBX2glTF GLBs from Quaternius (poly.pizza CDN) processed via `@gltf-transform/core` + custom Node.js script:

1. **Bake node transforms** — Rock Large had `scale=[100,100,100]` on its mesh node; baked into vertex positions (same TRS→mat4 approach as trees)
2. **Strip all textures** — Atlas PNG textures (512×512 and 1024×1024) removed; replaced with flat color `baseColorFactor=[0.54, 0.48, 0.40, 1]` (sandy gray-brown)
3. **Weld** at 0.001 tolerance + dedup
4. **Center XZ** + **shift y_min=0** so rock base sits at ground level

CDN source URLs (for re-derivation):
```bash
curl --ssl-no-revoke https://static.poly.pizza/c14651f6-9ef8-41e8-8aca-cafed61d9ca2.glb -o rock-large.glb
curl --ssl-no-revoke https://static.poly.pizza/be5fef3a-4fa1-4d08-b2d4-82e02284588d.glb -o rock-medium-A.glb
curl --ssl-no-revoke https://static.poly.pizza/aaf0aaa7-c244-430a-908b-2ac57567d81c.glb -o rock-medium-B.glb
```

### Cliff rock dimensions (at scale=1.0, post-bake)

| File | Height | XZ extent | Notes |
|---|---|---|---|
| `cliff-rock-1.glb` | 3.29 wu | ±3.85 wu X / ±3.72 wu Z | Large boulder, dramatic silhouette |
| `cliff-rock-2.glb` | 2.26 wu | ±1.73 wu | Medium, angular |
| `cliff-rock-3.glb` | 1.90 wu | ±1.71 wu | Medium, rounder |

At `SCALE_MIN=50 / SCALE_MAX=70`:
- Rock-1 height: 165–230 wu (spans 200wu canyon with one boulder)
- Used in `<RockyCliffs />` (`rocky-cliffs.tsx`) — 3 rows per cross-section, merged to 2 draw calls

## Procedural prop art direction

Styled after the Kagelok "The River" low-poly aesthetic:
- Flat-shaded / faceted geometry (no smooth shading)
- Above-ground river bank environment
- Colors: rock grey (#8c857a), wood pinkish-brown (#a6673a)

## RockyCluster usage (rocky-cluster.tsx)

`rocky-cluster.tsx` (Implementer 2 — scattered boulder approach) reuses the existing
`prop-rock-{1,2,3}.glb` from this directory. No new GLB assets are needed.

| GLB | Role in cluster | Scale range | Approx world height |
|---|---|---|---|
| `prop-rock-1.glb` | Structural base boulders (medium-large) | 1.8–4.0 | 90–200 wu |
| `prop-rock-2.glb` | Gap-fill rocks (small-medium) | 1.0–2.2 | 50–110 wu |
| `prop-rock-3.glb` | Foreground scatter (tiny-small) | 0.5–1.2 | 25–60 wu |

Scale estimation based on native rock prism native-height ~50wu at scale=1.0. Actual
heights depend on GLB bbox — verify with `@gltf-transform/cli inspect` if needed.

Instance count: ~408 total across 3 InstancedMesh draw calls (136 per variant).
Tris: ~32 640 (within Iris Xe 80k visible budget).

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
