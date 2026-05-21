---
title: Per-cell-plane drum wheel for slot machine reels
category: solution
tags: [slot, drum, planes, orthographic, animation, texture-swap]
date: 2026-05-19
confidence: high
threejs_version: r182
---

## Summary
12 PlaneGeometry quads orbiting X-axis at DRUM_RADIUS=1.5wu gives the cherry-charm slot-drum aesthetic with fully readable symbols.

## Details
**Why cylinder baked-texture failed:** 84 cells × 4° arc = each cell occupies ~4° of arc on the cylinder surface. At any reasonable camera distance the cells were unreadable streaks.

**Why planar scroll failed:** scrolling a texture on a flat plane looks static and 2D — no depth illusion.

**What works:** Per-cell planes on a virtual drum wheel.
- 12 `PlaneGeometry(0.76, 0.76)` quads per reel
- Arranged in circle around X-axis (horizontal axle — drum rolls vertically so symbols scroll up/down)
- `DRUM_RADIUS = 1.5wu`, `STEP = 2π/12 = 30°`
- Face k at `position=[0, R*sin(k*STEP), R*cos(k*STEP)]`, `rotation.x = k*STEP`
- Face 0 at angle=0 faces camera directly (+Z) = mid symbol
- Faces ±1 at ±30° = top/bot symbols, slightly angled = curvature illusion
- Side faces (±2..±5) visible at oblique angles = depth

**Texture architecture:**
- ~11 shared 128×128 `CanvasTexture` objects (one per unique symbol ID)
- Each plane has its own `MeshBasicMaterial` holding a `.map` pointer
- Back-crossing swap: when face passes angle≈π (hidden at back), update `mat.map = symbolTextures[nextStripId]` + `mat.needsUpdate = true`
- Zero texture rebuilding per frame — only JS reference swap

**Landing math:**
- `findStripPosition(strip, top, mid, bot)` → strip position `p`
- `drumStop = round(p * 12 / 84) % 12`
- `targetRot = current + forwardDelta` where `desiredAngle = (12 - drumStop) % 12 * STEP`
- Sign: `drum.rotation.x = theta` puts face k at world angle `k*STEP + theta`. To land face `drumStop` at front (world angle 0): `theta = -drumStop*STEP = (12-drumStop)*STEP mod 2π`

**Camera:**
- `OrthographicCamera left=-8.5, right=8.5, top=2.2, bottom=-2.2`
- 5 reels × 3.2wu spacing = 15.8wu span, fits in 17wu ortho width
- Ortho eliminates perspective distortion across reel width — all drums same apparent size

**Iris Xe budget:** 60 plane meshes + 10 bezel rings = 70 meshes. Fine.

## Context
Phase 6.1.8, commit df53dd3, ClawVille casino slot modal. Verified by live-verifier in prod at 1280×800 — described as "the best of three drum approaches". Spin + win celebration tested end-to-end (+31 CT win confirmed).
