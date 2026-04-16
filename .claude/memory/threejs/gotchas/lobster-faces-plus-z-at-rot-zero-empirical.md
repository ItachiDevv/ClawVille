---
title: lobster.glb faces +Z at rotation.y=0 — EMPIRICALLY VERIFIED 2026-04-16 (THIRD REWRITE — DO NOT CHANGE WITHOUT RUNNING OVERLAY)
category: gotcha
tags: [lobster, facing, rotation, atan2, clawville, model-orientation, empirical]
date: 2026-04-16
confidence: high
threejs_version: r170+
---

## HARD RULE — READ BEFORE TOUCHING THIS FILE

**If you are about to change this memory again, you MUST:**
1. Reproduce the empirical test with the live `window.__DEBUG_FACING` overlay (see below for how)
2. Capture the exact overlay values (`worldVx`, `worldVz`, `facingAngle`, `rotation.y`)
3. Take a clean side-view screenshot with ZERO camera orbit (camera must be at pure side angle)
4. Solve the linear system R(θ)·V = world_dir to identify V
5. Include those values in your commit message before touching any code

**Three sessions have been wrong about this axis. Armchair analysis is not allowed.**

---

## History of errors (this is the THIRD rewrite)

| Date | Claimed native forward | Basis | Status |
|------|----------------------|-------|--------|
| Pre 2026-04-16 | **-Z** | Code comments, old memory files trusting each other | WRONG |
| 2026-04-16 AM | **+X** | Debug overlay — but camera was orbited ~90°, screenshot misread | WRONG |
| 2026-04-16 late PM | **+Z** | Clean side-view screenshot, no camera orbit, head/claws visibly pointing -X during +Z movement | **CURRENT — CORRECT** |

---

## Summary

lobster.glb faces **+Z** at rotation.y=0. Proven by a clean unambiguous side-view screenshot on
2026-04-16 late PM: lobster moving +Z (screen-down), head/claws visibly pointing **left (-X world)**.

---

## Empirical test — 2026-04-16 late PM

**Observation (clean side-view, no camera orbit):**
- Lobster moving screen-down → +Z world direction
- Head/claws extend to the LEFT of the screen → -X world direction
- Camera was at a pure side angle, no accumulated orbit

**Current deployed formula at time of observation:** `atan2(-worldVz, worldVx)`

**Math check for each hypothesis at rotation.y produced by atan2(-1, 0) = -π/2 (for +Z movement):**

For forward = (sin θ, 0, cos θ) with θ = -π/2:
- **+X native** (V=(1,0,0)): rotated = (cos(-π/2), 0, -sin(-π/2)) = (0, 0, +1) = +Z. Lobster would face +Z = screen-down. Does NOT match visible -X head position.
- **+Z native** (V=(0,0,1)): rotated = (sin(-π/2), 0, cos(-π/2)) = (-1, 0, 0) = -X. Lobster faces -X = screen-left. **MATCHES visible observation.**
- -Z native → +X. Does not match.
- -X native → -Z. Does not match.

Only +Z native is consistent.

---

## Why the +X claim from the AM session was wrong

The AM debug overlay showed `worldVx=-0.214, worldVz=+0.977`, `facingAngle≈167.7°`. The math
solving R(167.7°)·V = world_dir(-0.977, -0.214) gave V=(1,0) = +X. **That math was correct for
the data** — but the data was generated with the OLD `atan2(-worldVx, -worldVz)` formula. That
formula introduced a rotation error equal to the difference between the true model axis and what
it assumed. The visual observation also had the camera orbited from its default position, which
made "upper-left on screen" map to a different world direction than a clean side-view would show.

The clean side-view eliminates all camera-relative ambiguity: when the camera is at a pure side
angle and the model moves +Z, the head VISIBLY points left (-X), proving +Z native.

---

## Correct invariants (+Z native, verified 2026-04-16 late PM)

### Formula for world-space velocity (npc-controller.tsx)
```typescript
// lobster.glb faces +Z natively (rotation.y=0 → head toward +Z)
const facingAngle = Math.atan2(worldVx, worldVz);  // NO negations
```

### Formula for screen-relative pixel-space input (player-pet.tsx)
```typescript
// vx = screen-right velocity, vy = screen-down velocity
// +Z native: screen-down (vy=+1) should face +Z (rot=0): atan2(+1, 0+1) → need atan2(vx, vy)
continuousRot = Math.atan2(vx, vy);
```

### DIR_ROTATION cardinal map (+Z native)
```typescript
// down:  vx=0,  vy=+1 → atan2(0,  +1) = 0        (+Z = native forward = screen-down)
// up:    vx=0,  vy=-1 → atan2(0,  -1) = PI        (-Z = screen-up)
// right: vx=+1, vy=0  → atan2(+1,  0) = PI/2      (+X = screen-right)
// left:  vx=-1, vy=0  → atan2(-1,  0) = -PI/2     (-X = screen-left)
// idle:  0 (faces +Z = toward default camera at positive +Z high angle position)
const DIR_ROTATION: Record<string, number> = {
  down: 0, up: Math.PI, right: Math.PI / 2, left: -Math.PI / 2, idle: 0,
};
```

---

## How to re-verify with the debug overlay

The `window.__DEBUG_FACING` overlay is live in `npc-controller.tsx`. To use it:

1. Open browser console on the deployed game (`https://clawville.world/game`)
2. Run: `window.__DEBUG_FACING = true; window.__FACING_DEBUG = {}`
3. Press S key (move screen-down = +Z world). Read `worldVx` and `worldVz` from the overlay.
4. Observe the model from a PURE SIDE ANGLE (orbit camera to exact 90° side position — no angle)
5. If head/claws point LEFT (-X world) when worldVz = +1: +Z native confirmed
6. Solve R(facingAngle)·V = (worldVx, worldVz) to recover V if still unsure

**Camera position matters enormously** — if the camera is at an angle, "head pointing left on
screen" maps to a different world direction. Always use a pure side-view (camera at exact ±X axis).

---

## Files implementing this invariant

- `apps/web/src/lib/three/npc-controller.tsx` line ~204: `atan2(worldVx, worldVz)`
- `apps/web/src/lib/three/player-pet.tsx` lines ~53-63: comment, DIR_ROTATION, `atan2(vx, vy)`
- `apps/web/src/lib/three/arena-npcs.tsx` lines ~51-55: comment + DIR_ROTATION
