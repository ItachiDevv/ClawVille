---
title: Transparent ghost kart — shared module-scope geo/mat + fade loop
category: pattern
tags: [transparency, ghost, kart, opacity, fade, module-scope, reef-race, BoxGeometry]
date: 2026-04-24
confidence: high
threejs_version: r170+
---

## Summary

Pattern for a racing ghost kart: module-scope BoxGeometry + MeshStandardMaterial (transparent, depthWrite false), per-frame opacity fade driven by loop position, O(1) lerp with sequential scan.

## Details

### Module-scope shared geo + mat

```ts
const _ghostGeom = new THREE.BoxGeometry(W, H, L);
const _ghostMat  = new THREE.MeshStandardMaterial({
  color: '#a78bfa',
  transparent: true,
  opacity: 0.4,
  depthWrite: false,  // avoid Z-fight with live meshes
});
```

Created once at module scope — never disposed per-mount. Assigned to mesh imperatively in `useEffect` (NOT via JSX `geometry={}` / `material={}` props) to bypass R3F's auto-dispose.

### Scene graph (world-space XZ isolation)

```tsx
<group ref={groupRef}>                           // world XZ position + Y rotation
  <group scale={[KART_SCALE, KART_SCALE, KART_SCALE]}>
    <mesh ref={meshRef} position={[0, LOCAL_Y, 0]} />
  </group>
</group>
```

- `groupRef.position.x/z` = world coords (parent is scene root)  
- `LOCAL_Y = WORLD_Y / KART_SCALE` — converts world elevation to local space

### Lap-relative looping

```ts
const elapsedMs     = Date.now() - raceStartMs;
const pathDuration  = path[path.length - 1].t - path[0].t;
const loopMs        = elapsedMs % pathDuration;      // 0..pathDuration
const ghostMs       = path[0].t + loopMs;            // back into path t-space
```

GhostFrame.t is lap-relative (0..lapMs), so `% pathDuration` auto-loops regardless of when the PB was set.

### Fade at loop boundaries

```ts
let fadeAlpha: number;
if (loopMs < FADE_IN_MS) {
  fadeAlpha = loopMs / FADE_IN_MS;
} else if (loopMs > pathDuration - FADE_OUT_MS) {
  fadeAlpha = (pathDuration - loopMs) / FADE_OUT_MS;
} else {
  fadeAlpha = 1;
}
fadeAlpha = Math.max(0, Math.min(1, fadeAlpha));
_ghostMat.opacity = fadeAlpha * GHOST_MAX_OPACITY;
```

No store subscription for lap tracking — loop position is self-contained.

### O(1) sequential scan with path-identity guard

```ts
const _scan = { lastFrameIdx: 0, lastPathRef: null as GhostFrame[] | null };

function findGhostFrames(path, nowMs) {
  if (_scan.lastPathRef !== path) {
    _scan.lastPathRef = path;
    _scan.lastFrameIdx = 0;  // reset on new PB load
  }
  // ... guard lo: if path[lo].t > nowMs, reset lo=0 (after modulo wrap-around)
  if (lo > 0 && path[lo].t > nowMs) lo = 0;
  while (lo < path.length - 2 && path[lo + 1].t <= nowMs) lo++;
  // ...
}
```

The wrap-around guard (`path[lo].t > nowMs` resets to 0) is CRITICAL — without it, after `loopMs` wraps from pathDuration back to 0, `lo` still points to the end and the scan undershoots.

### localStorage settings gate

```ts
function readShowGhostSetting(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = localStorage.getItem('clawville.reef.showPBGhost');
    return raw === null ? true : raw !== 'false';
  } catch { return true; }
}
// Read once in useMemo([]) — not per-frame
const showGhost = useMemo(() => readShowGhostSetting(), []);
```

## Context

Implemented in `ReefRaceGhost.tsx` for Phase 4 §2 of the Reef Race rebuild. Replaces a dormant `sea_horse.glb`-based ghost with a low-draw-call BoxGeometry glider. Key invariants: depthWrite=false for transparency, groupRef at scene root for world-space XZ, frustumCulled=false on meshRef.
