---
title: Arrow key orbital camera rotation via spherical coordinates
category: pattern
tags: [orbit-controls, camera, arrow-keys, spherical, wasd, input-separation]
date: 2026-04-09
confidence: high
threejs_version: r170+
---

## Summary
Separate WASD (pan/move) from arrow keys (orbital camera rotation) using THREE.Spherical to adjust theta/phi each frame.

## Details

Allocate scratch objects once at module scope — never inside useFrame:

```typescript
const _offset = new THREE.Vector3();
const _spherical = new THREE.Spherical();

const ARROW_ROT_SPEED = 1.5; // radians/second feels natural
const PHI_MIN = 0.1;
const PHI_MAX = Math.PI / 2.1; // match OrbitControls maxPolarAngle
```

In useFrame:

```typescript
const camera = controls.object;
_offset.subVectors(camera.position, controls.target);
_spherical.setFromVector3(_offset);

_spherical.theta += dTheta * ARROW_ROT_SPEED * delta; // ArrowLeft = +theta, ArrowRight = -theta
_spherical.phi   += dPhi   * ARROW_ROT_SPEED * delta; // ArrowUp = -phi (look up), ArrowDown = +phi
_spherical.phi    = Math.max(PHI_MIN, Math.min(PHI_MAX, _spherical.phi));

_offset.setFromSpherical(_spherical);
camera.position.copy(controls.target).add(_offset);
controls.update();
```

Key sign conventions:
- ArrowLeft → dTheta = +1 (positive theta = rotate left in Three.js right-hand Y-up)
- ArrowRight → dTheta = -1
- ArrowUp → dPhi = -1 (phi = polar angle from Y axis, smaller = looking more upward)
- ArrowDown → dPhi = +1

Use `e.preventDefault()` in keydown for arrow keys to prevent page scroll.

## Architecture note
Mount as a separate component `ArrowKeyRotationController` that always renders regardless of game mode (game vs arena). WASD controller narrows its local key state to only `w/a/s/d` — arrow keys are entirely absent from it.

In player-pet.tsx movement input, strip arrow keys so they never drive vx/vy:
```typescript
// Only WASD drives pet movement
if (keyState.w) vy = -1;
if (keyState.s) vy = 1;
if (keyState.a) vx = -1;
if (keyState.d) vx = 1;
```

Keep arrow keys in KeyState interface and event listeners if other systems need them — just don't read them for movement.

## Context
ClawVille — separated WASD (character/camera pan) from arrow keys (orbital view rotation). The shared module-level `_arrowKeys` object is written by a single event listener in ArrowKeyRotationController, avoiding duplicate listeners.
