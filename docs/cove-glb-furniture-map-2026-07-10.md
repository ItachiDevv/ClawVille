# Cove GLB Furniture Map — the "what is a table" ground truth

**Date:** 2026-07-10 · **Method:** headless Blender 5.1.2 geometry forensics (up-facing-face height-band clustering + rendered visual verification) · **Analyst:** Fable 5 session
**Assets analyzed (byte-identical furniture geometry):**
- `apps/web/public/models/cove/cove-interior.glb` (origin/staging)
- `apps/web/public/models/cove/cove-interior-cleaned-v1.glb` (origin/staging — **the LIVE asset**, served as `cove-interior-cleaned-v1-ktx.glb?v=5` per `cove-interior.tsx`)

## Why this doc exists

The cove interior is ONE GLB whose meshes were merged **by material** at export: 13 mesh objects named `Material2`, `Material2.001`, `Material3`…`Material3.009`, `Material4`, with materials named `auto`, `auto_1`, … `material_1`. **No object is named "table", "chair", or "slot" — names carry zero semantics.** This is the root cause of the 2-month failure loop where the model could not tell a table from a chair from a lightbulb. Geometry analysis (not names) recovers the semantics. This doc IS that recovered semantics — treat it as ground truth for all cove 3D work.

## Coordinate spaces

- **GLB space (Blender import, Z-up):** numbers below are measured directly from the mesh. Floor plane at **z = −274.4**, ceiling at **z ≈ −71**. Room bbox: X ∈ [−963.2, −477.9] (width 485.4), Y ∈ [−508.1, +508.6] (length 1016.7), height 203.5.
- **Three.js world space:** `cove-interior.tsx` applies `computeAutoFit(scene, INTERIOR_TARGET_HEIGHT=2000)` → uniform **scale ≈ 1.967** (2000 / 1016.7 maxDim) and recenters on the bbox center (−720.56, +0.29, −172.67 in GLB space). Derived world positions below are marked DERIVED — verify with a runtime probe before betting gameplay code on them (axis-sign convention Y-up flip: worldX = (glbX+720.56)·s, worldY = (glbZ+172.67)·s, worldZ = −(glbY−0.29)·s).

## THE FOUR CARD TABLES (verified visually — oval felts, each ringed by a ~10-chair horseshoe)

All four sit in the **negative-Y half** of the GLB (the half opposite the slot banks). Tabletop plane at **GLB z ≈ −244.2/−244.3** (≈ 30 GLB-units ≈ 59 wu above the floor).

| Table | GLB center (x, y) | footprint (felt cluster) | DERIVED world (x, z) | RUNTIME-VERIFIED world (x, z) |
|---|---|---|---|---|
| **T1** (near-pair, left) | (−877.6, −150.0) | ~115 × 66 | ≈ (−309, +296) | **(−309, +296)** — confirmed, raycast hits felt at Y≈59.8 |
| **T2** (near-pair, right) | (−563.0, −150.0) | ~115 × 66 | ≈ (+310, +296) | **(+310, +296)** — confirmed, raycast hits felt at Y≈59.8 |
| **T3** (far-pair, left) | (−891.2, −325.8)* | ~142 × 176* | ≈ (−336, +641)* | **(−320, +620)** — nudged after boundary-sweep raycast |
| **T4** (far-pair, right) | (−549.4, −325.8)* | ~142 × 176* | ≈ (+337, +641)* | **(+320, +620)** — nudged after boundary-sweep raycast |

\* T3/T4 cluster bounds bled into adjacent corner geometry (walls/alcove); the original derived value used pure mirror symmetry with T1/T2 (x ≈ −877.6 / −563.0, y ≈ −290 ± 10 in GLB space). No independent measurement existed for T3/T4 at the time this doc was first written.

Cross-check: the `feat/baccarat-3d` fork's rebuilt layout (memory `cove-furniture-symmetry-workflow`) placed tables at world **x = ±300** — matches the DERIVED ±309/±310 above from the *original baked* tables. Two independent sources agree.

**2026-07-10 runtime verification (Slice 1 Phase-0 probe, `cove-interior.tsx` `TableProbeMarkers`, headless-Chrome raycast):** straight-down rays from Y=400 at T1/T2's DERIVED centers hit a flat surface at Y≈59.8-60.9 — matching the doc's own `TABLE_TOP_Y≈59` estimate almost exactly, confirming those two centers are correct as originally derived (do NOT "fix" T1/T2's Z to match the 2D hotspot Z of 331/335 — that hotspot measures where the PLAYER stood, pushed back by the table's own AABB collider, not the felt centroid; the two numbers were never measuring the same point). T3/T4's mirror-estimate centers, by contrast, never produced a felt-height hit in repeated single-shot probes; a follow-up boundary-sweep raycast (grid + edge search) found the real felt-height (Y≈59.8-63.3) hit region centered close to `(-320, 620)` / `(320, 620)` — only ~16-21wu from the original mirror estimate, i.e. within the sweep's own 40wu grid resolution, not a sign/axis error. `cove-interior.tsx`'s `_TABLE_AABBS` half-extents (128×100 for T3/T4) already exceed the measured felt half-width (~100×60) so the existing collider padding covers the shift with margin. T3/T4 get no interactive seats/camera in Slice 1 (collider-only) — a later slice building T3/T4 seats should re-verify with the same `TableProbeMarkers` tool (gate `?probe=1` or `NEXT_PUBLIC_COVE_DEBUG=1`) rather than trusting these further without a fresh check.

## THE FOUR SLOT BANKS (verified visually — closeup render shows cabinets + screens + red stools)

Positive-Y half. Each bank = **2 back-to-back rows of 6 slot cabinets** on a shared counter island, stools on both faces.

| Bank | GLB center (x, y) | counter-top z | cabinet-top z | DERIVED world (x, z) |
|---|---|---|---|---|
| B1 | (−826.6, +156.5) | −248.1 | −221.6 | ≈ (−209, −307) |
| B2 | (−614.0, +156.5) | −248.2 | −221.7 | ≈ (+210, −307) |
| B3 | (−826.6, +304.2) | −248.0 | −221.8 | ≈ (−209, −598) |
| B4 | (−614.0, +304.2) | −248.0 | −221.8 | ≈ (+210, −598) |

**Height discriminator (the reliable rule):** card-table tops live 20–35 GLB-units above the floor; slot-cabinet tops live 45–70 above. Anything flat + up-facing in those bands, clustered in XY, IS the furniture. This rule is how to re-derive the map after any GLB edit.

## Other structures

- **Bar/stage:** (−908.6, ≈0), top z −250.6, along the left (−X) wall mid-room; tall element at (−949.6, 0) top −217.2.
- **Entrance alcove:** right (+... GLB −478) wall mid-room, y ≈ 0 (round object + rectangular recess).
- **Floor rugs/platforms:** second floor-level band at z −273.3 (vs floor −273.75).
- `Material4` = 84k-vert **edges-only object, 0 faces** (`edge_color646464255`) — outline shell, ignore for collision/anchoring.
- `Material3.007` = 2-face full-room plane at z −273.3 (floor overlay). `Material3.009` = ceiling plane (y span 984).

## Which mesh objects hold what (for extraction/edit work)

- `Material3.001` (24.7k faces, spans whole room) — carries the **card-table felts** AND table rims + much furniture trim.
- `Material2.001` (125k faces, whole room) — main shell + big share of furniture bodies (also carries card-table surfaces in band −245).
- `Material2` + `Material3.002/.003/.005/.008` — bboxes confined to the slot-bank quadrant (X −895..−545, Y +139..+321): **slot bank cluster** (Material3.005 = cabinet tops at −218 band).
- `Material3.004`, `Material3.006` — full-room trim/detail layers that contribute to table region.
- **Implication:** a single table is NOT one object — it is faces scattered across ≥3 material-blob meshes. Any "select the table" operation must be **face-level by spatial region** (select faces whose world position falls inside a table's cylinder/box), not object-level. This is what the failed attempts never did.

## Evidence artifacts (session scratchpad, copy before scratchpad GC)

- `cove-forensics/p2_top_marks.png` — top-down floor plan, ceiling clipped, red = table-band clusters, orange = slot-top clusters
- `cove-forensics/p2_top_clean.png` — clean top-down floor plan (ovals + horseshoe chairs clearly visible)
- `cove-forensics/p2_table_closeup.png` — textured closeup (slot bank)
- `cove-forensics/table_map.json`, `inventory.json`, `color_legend.json` — raw measurements
- Scripts: `cove-forensics/pass1_inventory.py`, `pass2_tablemap.py` — rerunnable on any GLB revision

## How to use this for the 3D poker build (sit-at-table)

1. **Anchoring:** spawn the interactive `CasinoTable3D` layer (donor: recovered `laptop-clawville/feat/baccarat-3d`) AT the four table positions above — the baked felt becomes set dressing under the interactive layer, OR
2. **Face-level extraction:** select faces by spatial region (table cylinder) across `Material3.001`/`Material2.001`/`Material3.006`, separate → named objects (`CardTable_1..4`), re-export. Gives true per-table show/hide + seat raycast targets. The failed "instancing" attempt died because leftover welded geometry stayed behind on a `[0,0,0]` unlit material — face-level region selection with verified re-render (screenshot every step) avoids that.
3. Either way, seats: horseshoe chair positions are readable from the clean top-down render per table; derive seat transforms from the felt center + radius at 36° spacing on the open arc.

**PARITY note:** doc-only artifact (no code change). Human path and agent path unaffected; this map feeds the upcoming cove 3D build which carries its own parity gates.
