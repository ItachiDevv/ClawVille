---
name: project-cove-interior-glb
description: cove-interior.glb mesh inventory, Three.js→Blender name mapping, artifact locations for cleanup session 2026-05-22
metadata:
  type: project
---

# Cove Interior GLB — Mesh Inventory

GLB path: `C:/Users/newma/Documents/Crypto/ClawVille/apps/web/public/models/cove/cove-interior.glb`
Fallback: `cove-interior-fallback.glb` in same dir.

## Three.js → Blender name mapping

GLTFLoader names objects `<MeshName>_<primitiveIndex>`. In Blender post-import:

| Three.js name | Blender object | Material | GLB mat[idx] | Notes |
|---|---|---|---|---|
| Material4_0 | Material4 | edge_color646464255 | mat[0] | alpha=BLEND, baseColor=[1,1,1,0] — fully transparent |
| Material2_0 | Material2 | auto | mat[1] | alpha=OPAQUE, 1024 tex |
| Material2_1 | Material2.001 | material_1 | mat[2] | **baseColor=[0,0,0,1] SOLID BLACK, no texture** |
| Material3_0 | Material3 | auto_1 | mat[3] | alpha=BLEND |
| Material3_1 | Material3.001 | auto_3 | mat[4] | **CHAIR STUMPS artifact** |
| Material3_2 | Material3.002 | auto_4 | mat[5] | |
| Material3_3 | Material3.003 | auto_16 | mat[6] | |
| Material3_4 | Material3.004 | auto_20 | mat[7] | **PILLAR artifact lives here** |
| Material3_5 | Material3.005 | auto_24 | mat[8] | |
| Material3_6 | Material3.006 | auto_29 | mat[9] | |
| Material3_7 | Material3.007 | auto_34 | mat[10] | alpha=BLEND, 2-face floor quad |
| Material3_8 | Material3.008 | auto_44 | mat[11] | |
| Material3_9 | Material3.009 | auto_58 | mat[12] | |

## Artifact locations (from island analysis 2026-05-22)

### Artifact 1 — Two stray pillars
- Blender object: **Material3.004** (Three.js Material3_4)
- Material: auto_20 (OPAQUE, 1024 texture)
- Pillar cluster positions in world space:
  - LEFT pillar: center X≈-811, Y≈-230, Z≈-200 to -270
  - RIGHT pillar: center X≈-630, Y≈-230, Z≈-200 to -270
- These appear as many tiny disconnected polygon islands (2-face each) forming a pillar silhouette
- Material3.004 has 5122 faces total across 4010 disconnected islands
- The pillars are sub-geometry within this mesh — cannot delete just the pillars without editing the mesh

### Artifact 2 — Chair stump ring
- Blender object: **Material3.001** (Three.js Material3_1)
- Material: auto_3 (OPAQUE, 1024 texture)
- Two clusters visible from top-down: left cluster and right cluster of spiky/jagged shapes
- center: (-713, 1.2, -248.8), dims: (456, 700, 50)
- Spans from Y=-348 to Y=352, Z from -274 to -224
- This is the ENTIRE chair-stump mesh — deleting the whole object removes all stumps
- If there's good geometry in this mesh too, partial deletion needed

### Artifact 3 — Roulette dark spot
- Most likely candidate: **Material2.001** (Three.js Material2_1)
- Material: material_1 = pure black, baseColor=[0,0,0,1], NO TEXTURE, OPAQUE
- This is a 125k-face mesh that renders solid black — very large interior furniture mesh
- The dark spot near room center is exposed black-material geometry from this mesh
- The roulette table that was removed may have been covering a portion of Material2.001
- Secondary candidate: **Material3.007** — a 2-face floor quad spanning full room
  - alpha=BLEND material (auto_34) with 512x1024 texture
  - Faces downward (normal = -Y) — normally invisible from above
  - Z position: -273.3 (floor level), covers full room footprint

## Room coordinate space (Blender world after GLB import)

- Room X: -962 to -478 (width ≈ 484)
- Room Y: -508 to 508 (length ≈ 1016)
- Room Z: -274 to -71 (height ≈ 203)
- Room center: (-720, 0, -172)
- Floor: Z ≈ -274
- Ceiling: Z ≈ -71

## Export requirements

Draco compression: level 6, position quant 14, normal quant 10, texcoord quant 12.
Replace both `cove-interior.glb` AND `cove-interior-fallback.glb`.
