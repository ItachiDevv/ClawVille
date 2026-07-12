# Cove GLB Furniture Map — the "what is a table" ground truth

**Date:** 2026-07-10, updated 2026-07-11 (T1 chair-seat measurement, see below) · **Method:** headless Blender 5.1.2 geometry forensics (up-facing-face height-band clustering + rendered visual verification) for the original table/slot map; in-game raycast grid sweep (live rendered asset, not a separate Blender pass) for the 2026-07-11 chair-seat addition · **Analyst:** Fable 5 session
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

## T1 chair-seat MEASURED ground truth (added 2026-07-11, Slice 2 posture postmortem)

The "36° spacing on the open arc" guidance in step 3 above was **wrong** — it was never checked against the baked chairs. The Slice 1 sit-at-table build used that arc formula to synthesize T1's 6 seat positions, and calibrated the seated hip height as a fraction of AVATAR height. Both were conceptually wrong, not just imprecise: the room-scale knob (2026-07-11, `3dStructure.md` §10c) scales the whole room INCLUDING the baked chairs, while avatars stay a fixed size — "seat height ≈ half of avatar hip height" stopped holding the moment the knob moved off its original value. The founder + team-lead caught it on a seated screenshot at knob=2800: bust heads hid behind chair backs, and one bust sat visibly on the floor beside her chair.

**Fixed by measurement**, not re-estimation — an in-game raycast grid sweep (temp diagnostic component, removed after data capture) at `INTERIOR_TARGET_HEIGHT=2800`:

- **Seat height:** a real, consistent, room-scaled flat surface at world Y≈56.6wu (knob=2800), found across many XZ points near T1, traced to mesh `Material3001` (same material this doc already flagged as carrying "much furniture trim"). A second, LOWER surface at Y≈44.9wu (`Material2001`) also exists at the same XZ columns — a visual marker check (two colored spheres rendered at both candidate heights, screenshotted against the real chair mesh) confirmed 56.6 is the cushion top; 44.9 is likely the chair's structural base/frame underneath. Converted to GLB-space height-above-floor: **`GLB_CHAIR_SEAT_TOP_Z ≈ -253.85`** (floor is -274.4, so ≈20.55 GLB-units above floor) — this independently matches a `-253.9/-256.7` GLB-Z band cited separately during review, corroborating the measurement from two directions.
- **Seat XZ positions:** a second, finer local sweep (±60wu, 8wu step) around each of the arc-formula's 6 hypothesis points found the real nearby chair-seat centroid for every seat (n=7-33 confirming hits each). Offsets from the old arc-formula guess ranged 10-58wu — confirming the formula was in the right neighborhood but not accurate enough to seat a VRM cleanly. Measured GLB-space centers (captured at knob=2800, converted via the standard `glbToWorldX/Y` fit-scale math so they re-derive correctly at any future knob value):

| Seat | GLB X | GLB Y | Role |
|---|---|---|---|
| 0 | -821.39 | -144.92 | Local player's own seat |
| 1 | -844.63 | -125.64 | Bust |
| 2 | -876.51 | -116.78 | Bust |
| 3 | -906.29 | -126.00 | Bust |
| 4 | -942.49 | -145.24 | Bust |
| 5 | -932.03 | -171.39 | Bust |

Bust yaw = `atan2` facing T1's felt center from each seat's own measured position (not a fixed per-slot angle).

**Implication for T2-T4:** the arc-formula ring (`_buildTableSeats` in `cove-interior.tsx`) is still used there since no slice has built their seats/camera yet — but it should NOT be trusted at face value when that work starts. Repeat this SAME in-game raycast measurement pass for each table before shipping seats, rather than assuming the formula (proven wrong once already) is close enough.

**PARITY note:** doc-only artifact (no code change in this section — the code lives in `apps/web/src/lib/three/cove-interior.tsx`, its own diff). Human path and agent path unaffected; this map feeds the cove 3D build which carries its own parity gates.

## T1 chair-seat front-edge data (added 2026-07-11, Slice 2c postmortem — backrest-through-torso fix)

Founder verdict on Slice 2b: "the seats are still cutting through the middle of the avatar body" — confirmed on screenshots, clearest on the mid purple-haired bust and the skull-shirt bust. Root cause: the seat centroids above (§ "T1 chair-seat MEASURED ground truth") are the AVERAGE of every raycast hit across the full cushion depth — a seated pelvis belongs near the cushion's FRONT THIRD, not its middle. Sitting at the centroid put the torso too far back, into the tall backrest.

**Fixed by a second measurement pass** (`ChairFrontEdgeSweep`, temp diagnostic component, removed from `cove-interior.tsx` after data capture): for each of the 6 seats, sampled a line along the seat's own toward-table direction (the same unit vector `faceYaw` already uses) to find where seat-height-band raycast hits START (back edge, toward the backrest) and STOP (front edge, toward the table):

| Seat | measured cushion depth (wu, knob=2800) | forward offset applied (wu, knob=2800) | note |
|---|---|---|---|
| seat0 (player) | ~44-48 | 13.3 | consistent with the other non-outlier seats |
| seat1 | ~44-48 | 9.3 | consistent |
| seat2 | ~44-48 | 13.3 | consistent |
| seat3 | ~44-48 | 13.3 | consistent |
| seat4 | 64 (outlier) | 50.7 | its centroid was already the WEAKEST measurement in the prior pass (n=7 raycast hits vs 20-33 for the others) — the large offset compensates for a centroid that sits well toward the back of the true cushion, not a different chair shape |
| seat5 | ~44-48 | 8.0 | consistent |

Offset formula: `frontEdge − depth/3` (front-third rule, per team-lead instruction). Stored as `T1_SEAT_FORWARD_OFFSET_GLB` in `apps/web/src/lib/three/cove-interior.tsx` — GLB-space units divided by `FIT_SCALE`, so the array re-derives correctly at any future `INTERIOR_TARGET_HEIGHT` knob value, not hardcoded world-space numbers. Applied by offsetting each measured centroid toward the table along the seat's existing toward-table unit vector, keeping offset direction and bust facing (`faceYaw`) guaranteed consistent.

**Visual verification (2026-07-11):** confirmed via the seated player-POV screenshot (4 busts visible across the felt, torsos and heads clearly above their chair backrests, no burial) and a north-side third-person angle (3 more busts visible up close, same result). Seats 0/1/2/3/5 verified at close range; seat1/2/3's near-side view and the north-side view together cover all 5 bust seats at least once.

**Reachability caveat (discovered live, 2026-07-11):** the player-movement boundary clamp (`BOUNDS_X ≈ 537` world units at knob=2800, in `COVE_ROOM_BOUNDS`) combined with the T1 table AABB (`_TABLE_AABBS`) and the dealer-station AABB (`_DEALER_CENTER_X/Z`) leaves no walkable corridor close enough to stand directly beside seat4's measured position — its real world X sits past the west movement boundary. Seat4 was verified from a medium-distance third-person angle (no visible clipping, legs/torso readable) rather than a point-blank close-up like the other 5 seats. This is a genuine geometry/collision constraint, not a skipped verification step — flagging for whoever next touches T1's collision volumes or west-wall bound, since it also blocks any future feature that wants the player standing directly at seat4.

**PARITY note:** doc-only artifact (no code change in this section — the code lives in `apps/web/src/lib/three/cove-interior.tsx`, its own diff). Human path and agent path unaffected.
