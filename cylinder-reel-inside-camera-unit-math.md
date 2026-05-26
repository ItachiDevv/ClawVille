---
title: CylinderGeometry slot reel — camera inside cylinder when radius computed from strip circumference
category: gotcha
tags: [slot, cylinder, camera, unit-math, modal, planar-reels]
date: 2026-05-19
confidence: high
threejs_version: r182
---

## Summary

`CYLINDER_RADIUS = (STRIP_LEN × CELL_WU) / (2π)` with STRIP_LEN=84, CELL_WU=1.0 gives radius 13.37wu. A camera at z=6 is INSIDE the cylinder — renders transparent black. The fix is planar reels (PlaneGeometry + UV scroll), not exotic camera placement.

## Details

The cylinder design intended one face per strip cell. With 84 cells each 1.0wu wide, circumference = 84wu, radius = 13.37wu. Five such cylinders with REEL_SPACING=1.3 overlap into one tangled mass, and the camera at z=6 is 7wu inside them.

**Option B (planar reels) — what actually works:**
- `PlaneGeometry(CELL_WU, CELL_WU * 3)` per reel (1wu wide × 3wu tall)
- Texture is a vertical strip: `TEX_W = TILE_PX`, `TEX_H = STRIP_LEN * TILE_PX`
- `wrapT = RepeatWrapping`, `repeat.y = 3 / STRIP_LEN`, `offset.y` scrolls the strip
- Spin animation = tween `texture.offset.y`, no mesh rotation
- Landing formula (with flipY=true default): `offset.y = 1 - (p + 1.5) / STRIP_LEN`
- Camera: `position [0,0,5]`, `fov 65` → viewport at z=0 = 6.37wu wide, comfortably containing 5 reels at 1.0wu spacing (4.0wu span)

**UV math:**
CanvasTexture flipY=true: canvas y=0 → UV v=1. UV v = 1 - k/STRIP_LEN maps to canvas row k.
Middle cell p: UV centre = 1 - p/STRIP_LEN. We want middle at v = offset.y + 1.5/STRIP_LEN.
→ offset.y = 1 - (p + 1.5) / STRIP_LEN.

**DECEL phase gotcha:** compute `decelAbsTarget` once when transitioning STEADY→DECEL (at the transition frame, not inside the DECEL case). Using an inline "compute if not yet computed" check inside DECEL is fragile.

**Motion blur:** during ACCEL/STEADY, `repeat.y = (3 + BLUR_EXTRA) / STRIP_LEN` compresses more cells into the window height = vertical motion blur illusion. Restore at DECEL.

## Context

Shipped in SlotReels3D.tsx at commit replacing the broken cylinder approach (commit be14553). Modal canvas = 480×360px. The cylinder approach passed tsc + audits but rendered transparent black in production.
