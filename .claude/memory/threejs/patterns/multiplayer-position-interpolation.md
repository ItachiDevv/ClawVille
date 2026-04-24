---
title: Client-side multiplayer position interpolation (15Hz → 60fps)
category: pattern
tags: [multiplayer, interpolation, netcode, useFrame, performance, bumper-shells]
date: 2026-04-24
confidence: high
threejs_version: r170+
---

## Summary
Eliminate teleport jitter when server snapshots arrive at 15Hz but the renderer runs at 60fps.

## Details

**Problem:** At 15Hz server update rate, each frame directly setting `group.position.x = entity.x`
causes the mesh to sit still for 66ms then snap to the new position — visible teleporting at 60fps.

**Pattern:** Render-behind interpolation.

```ts
// Constants
const INTERP_DELAY_MS = 100;    // 1.5× snapshot interval (66.67ms) — ensures a future snapshot
const INTERP_HISTORY_SIZE = 4;  // 4 × 66ms = 265ms window — comfortably past the delay

interface SnapRecord {
  t: number;   // performance.now() when received
  x: number;
  z: number;   // sim y → Three.js z
  rot: number; // NaN when velocity is zero (no facing update)
  vx: number;
  vz: number;  // sim vy → Three.js vz
}

// Per-component refs (no per-frame allocations):
const historyRef = useRef<SnapRecord[]>([]);
const lastEntityRef = useRef<BumperShellEntity | null>(null);
const lastRotRef = useRef(0); // last rendered rotation (rotation fallback)

// In useFrame — detect new entity object by identity, push snapshot:
if (entity !== lastEntityRef.current) {
  lastEntityRef.current = entity;
  const hasVelocity = entity.vx !== 0 || entity.vy !== 0;
  const snap = {
    t: performance.now(),
    x: entity.x,
    z: entity.y,
    rot: hasVelocity ? Math.atan2(entity.vx, entity.vy) : NaN,
    vx: entity.vx,
    vz: entity.vy,
  };
  historyRef.current.push(snap);
  if (historyRef.current.length > INTERP_HISTORY_SIZE) {
    historyRef.current.splice(0, historyRef.current.length - INTERP_HISTORY_SIZE);
  }
}

// Interpolate:
const renderTime = performance.now() - INTERP_DELAY_MS;
// find bracket [a, b] such that a.t <= renderTime <= b.t
// clamp t to [0,1] — never extrapolate
const t = Math.max(0, Math.min(1, (renderTime - a.t) / (b.t - a.t)));
interpX  = a.x  + (b.x  - a.x)  * t;
interpZ  = a.z  + (b.z  - a.z)  * t;
// ... vx, vz same
// Rotation — shortest angle lerp (avoids spinning through 0/2π):
function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  return a + diff * t;
}
// Skip NaN (zero-velocity) frames — fallback to lastRotRef.current
```

**Key points:**
- Use `entity !== lastEntityRef.current` (object identity) to detect new snapshots. The activity
  store builds a new entity object on every `snapshot.delta`, so identity change = new snapshot.
- `performance.now()` is the receive time — good enough; server `t` field not needed.
- `NaN` for rotation when velocity is zero — prevents snapping back to 0 during idle frames.
- `lastRotRef` persists the last rendered rotation for zero-velocity fallback.
- Clamp interpolation t to [0,1] — never extrapolate past the newest snapshot.
- Startup case (only 1 snapshot in buffer): snap directly to it, no interpolation.
- No `new Vector3()` or any object allocation in useFrame — all primitives.

## Context
Implemented in `BumperShellsPlayer.tsx` (chunk #13, 2026-04-24).
Server sends `snapshot.delta` at 15Hz. Render at 60fps. INTERP_DELAY_MS=100 gives
1.5× the 66.67ms interval — comfortably within the 4-snapshot window.
