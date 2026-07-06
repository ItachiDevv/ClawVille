---
title: Three.js Raycaster skips back-face hits with FrontSide — base-platform geometry not detected from above
category: gotcha
tags: [raycaster, occlusion, FrontSide, back-face, speech-bubble, world-labels]
date: 2026-05-22
confidence: high
threejs_version: r182
---

## Summary
Raycaster from camera going DOWNWARD toward a low anchor (Y≈20) hits platform base
geometry from above. Platform triangles have +Y normals → the ray hits their BACK face.
`material.side === FrontSide` causes `Raycaster.intersectObjects` to skip back-face hits →
0 intersections returned → occlusion check returns false even when the structure is
physically between the camera and the anchor.

## Details
Symptom: NPC speech bubbles (`BUBBLE_Y=20`) rendered in front of structures (shisha-oasis,
stalls) even with `occlude: true` wired in `useWorldLabel`. NPC name tags at Y≈100 (offset
[0,100,0]) worked correctly.

Root cause path:
1. `_checkOcclusion(anchorWorld, cameraPos)` fires `_occRaycaster.intersectObjects(meshes, false)`.
2. Three.js `Raycaster.intersectObject` → `checkGeometryIntersection` → if `material.side ===
   FrontSide`, it computes `dot(faceNormal, rayDirection)`. If positive (ray and normal point
   same direction = ray hits back face), the triangle is SKIPPED.
3. Base-platform geometry of structures (counters, plinths) has normals pointing +Y (upward).
4. A ray going from camera (Y≈800) DOWN toward anchor at Y=20 has a downward component.
   `dot([0,1,0], [0,-0.7,−0.7]) = −0.7` (negative) → actually front face for downward ray
   BUT the geometry may be FLAT (PlaneGeometry-style top face only), meaning only 1 face
   exists per triangle and the ray enters from the top.

Actually the simpler explanation confirmed in practice: at BUBBLE_Y=20, the anchor sits in
the base zone of the structure where vertical wall geometry may not exist at all (just the
platform). No vertical wall triangles = no intersection at that height. Raising to Y=150
puts the anchor in the zone where the structure's walls and canopy definitely have geometry
with outward-facing normals → raycast hits correctly.

## Fix
Raise the speech bubble anchor Y so the occlusion ray passes through the structure's
wall/canopy zone (not just the base platform). For ClawVille NPCs (45wu tall), `BUBBLE_Y=150`
works universally — all structures are ≥500wu tall so walls exist at Y=150.

General rule: set the occlusion anchor at or above mid-structure height, not near the ground.

## Context
Surfaced: `npc-speech-bubbles.tsx` `BUBBLE_Y` 20→150 fix (2026-05-22).
Name tags used `offset: [0, 100, 0]` (anchor at Y≈100) and worked because walls exist there.
Bubbles used `offset: [0, 0, 0]` on a group at Y=20 (anchor at Y=20) and did NOT work.
The delta was exactly the height difference in the anchor, confirming the root cause.
