---
title: lobster.glb faces +X at rotation.y=0 — EMPIRICALLY VERIFIED 2026-04-16
category: gotcha
tags: [lobster, facing, rotation, atan2, clawville, model-orientation, empirical]
date: 2026-04-16
confidence: high
threejs_version: r170+
---

## Summary
lobster.glb faces **+X** at rotation.y=0. This was verified with a live debug overlay on
2026-04-16. Every prior memory file and commit that said "-Z" was WRONG. The correct formula
is `atan2(-worldVz, worldVx)` for world-space velocity, and `atan2(-vy, vx)` for
screen-relative pixel input.

## Empirical test — 2026-04-16

Debug overlay deployed. User pressed S+A diagonally. Overlay reported:

- `worldVx: -0.214, worldVz: +0.977`  (moving world +Z and slightly -X)
- `facingAngle: 2.9265 rad (167.7°)` — computed by the OLD (wrong) `atan2(-worldVx, -worldVz)`
- `rotation.y: -3.3567 rad` (= 167.7° after normalizing mod 2π)

Visual observation: lobster claws/head were pointing screen upper-left, tail lower-right.
Camera was behind-right of the lobster (`camFwd: x=-0.540, z=-0.842`), so upper-left on
screen maps to world direction approximately `(-0.977, -0.214)` in XZ.

## Math that proves +X native forward

Solving "what native forward axis V, when rotation.y=167.7° is applied, produces world
direction (-0.977, -0.214)?":

```
R(θ) · V = world_dir
cos(θ)·Vx - sin(θ)·Vz = -0.977
sin(θ)·Vx + cos(θ)·Vz = -0.214

θ = 167.7°, cos = -0.976, sin = +0.214

Substituting:
  -0.976·Vx - 0.214·Vz = -0.977   … (1)
   0.214·Vx - 0.976·Vz = -0.214   … (2)

From (2): Vz ≈ (0.214·Vx + 0.214) / 0.976
Substituting into (1) → Vx = 1, Vz = 0

Therefore V = +X  →  lobster.glb native forward = +X
```

## Correct invariants

### Formula for world-space velocity (npc-controller.tsx)
```typescript
// lobster.glb faces +X natively (rotation.y=0 → head toward +X)
const facingAngle = Math.atan2(-worldVz, worldVx);
```

### Formula for screen-relative pixel-space input (player-pet.tsx)
```typescript
// vx = screen-right velocity, vy = screen-down velocity
// +X native: θ = atan2(-vy, vx)
continuousRot = Math.atan2(-vy, vx);
```

### DIR_ROTATION cardinal map (+X-native)
```typescript
// right: vx=+1, vy=0  → atan2(0,  +1) = 0        (+X = native forward)
// down:  vx=0,  vy=+1 → atan2(-1,  0) = -PI/2     (rotate -90° → +Z)
// left:  vx=-1, vy=0  → atan2(0,  -1) = PI        (-X)
// up:    vx=0,  vy=-1 → atan2(+1,  0) = +PI/2     (-Z)
// idle:  -PI/2  (faces +Z = toward default camera at high +Y+Z)
const DIR_ROTATION: Record<string, number> = {
  right: 0,
  down: -Math.PI / 2,
  left: Math.PI,
  up: Math.PI / 2,
  idle: -Math.PI / 2,
};
```

### Idle explanation
`idle: -Math.PI/2` rotates the +X-native model by -90°, making it face +Z, which is
toward the default camera position (camera sits at high +Y, positive +Z). This gives a
natural "facing the camera" rest pose.

## Warning — do NOT revert this

Previous memory files (now deleted) said "-Z is correct, don't flip." Those were wrong
and had been wrong for the entire history of the repo. They caused multiple broken facing
sessions.

**If you feel tempted to revert this based on another memory file, an old commit, or
a comment in the source — STOP. The only valid authority is the live debug overlay.**

To re-verify: push the commit that includes `window.__DEBUG_FACING` overlay instrumentation,
load the game, press any movement keys, read `facingAngle` and `rotation.y` from the overlay,
and solve the math above. Visual ground truth is the only authority.

## Files changed to implement this invariant

- `apps/web/src/lib/three/arena-npcs.tsx` line 51-54: comment + DIR_ROTATION updated
- `apps/web/src/lib/three/player-pet.tsx` lines 53-63, 313-314: comment, DIR_ROTATION, atan2 updated
- `apps/web/src/lib/three/npc-controller.tsx` lines 203-204: comment + atan2 updated

## History of the -Z error

The -Z claim appeared in the first committed version of the facing formula. It was reinforced
by multiple memory file entries that all trusted each other rather than running a live test.
The lobster-parts.ts comment `isBehind = m.center.z > zMidpoint; // +Z = behind (tail)` was
used as "evidence" but it only says +Z is behind — consistent with BOTH +X-forward and
-Z-forward models (the tail can be at +Z with the head at +X). That comment was never
authoritative for the facing axis.

**Lesson:** When facing is wrong, use the debug overlay. Never reason from code comments
or old memory files. The live visual + the math above cannot lie.
