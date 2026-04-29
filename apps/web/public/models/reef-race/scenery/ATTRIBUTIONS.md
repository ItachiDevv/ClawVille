# Reef Race Scenery Props — Attributions

All props in this directory are **procedurally generated** in Blender by blender07 (Claude agent).
No third-party assets were used. All geometry is original.

## License

All files in this directory are released under **CC0 1.0 Universal (Public Domain Dedication)**.
No attribution required for redistribution or derivative works.

## Props

| File | Description | Method | Tris | Size |
|---|---|---|---|---|
| `prop-tree-pine.glb` | Low-poly pine tree, 3-tier cone stack + cylinder trunk, ~200 wu tall | Procedural Blender (cones + cylinder) | ~80 | 7.7 KB |
| `prop-tree-leafy.glb` | Low-poly broadleaf tree, 2 ico-sphere canopy blobs + trunk, ~200 wu tall | Procedural Blender (ico-sphere + cylinder) | ~140 | 8.0 KB |
| `prop-rock-1.glb` | Low-poly faceted rock, wide flat variant, ~50 wu | Procedural Blender (ico-sphere subdivided=2, scaled + flat bottom) | 80 | 9.1 KB |
| `prop-rock-2.glb` | Low-poly faceted rock, tall narrow variant, ~45 wu | Procedural Blender (ico-sphere subdivided=2, scaled + flat bottom) | 80 | 9.1 KB |
| `prop-rock-3.glb` | Low-poly faceted rock, wide slab variant, ~80 wu | Procedural Blender (ico-sphere subdivided=2, scaled + flat bottom) | 80 | 9.1 KB |
| `prop-fence.glb` | 4-rung wooden fence segment, ~150 wu wide, pinkish-wood color | Procedural Blender (cube primitives: 2 posts + 4 rails) | 72 | 8.6 KB |
| `prop-grass-tuft.glb` | Small tuft of 7 flat grass blades radiating from center, ~30 wu wide | Procedural Blender (flat triangle meshes) | 7 | 4.6 KB |

## Art Direction

Styled after the Kagelok "The River" low-poly aesthetic:
- Flat-shaded / faceted geometry (no smooth shading)
- Above-ground river bank environment (NOT underwater)
- Colors: pine green (#0d5914 approx), canopy green (#204e0d), wood pinkish-brown (#a6673a approx), rock grey (#8c857a approx)

## Usage in Three.js

All props have origin at base (y=0). Load with `GLTFLoader`, place via `ScenerySpawner` at x ∈ [±400, ±900] relative to the spline, y=0 on the river bed/bank.

Flat shading is baked into normals. No animations, no skeletons. `frustumCulled = true` is safe — bounding boxes are correct.
