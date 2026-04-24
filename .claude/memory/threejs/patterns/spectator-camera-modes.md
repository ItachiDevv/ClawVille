---
title: Spectator camera modes — follow/free/action in activity scenes
category: pattern
tags: [camera, spectator, OrbitControls, PerspectiveCamera, bumper-shells, activity]
date: 2026-04-23
confidence: medium
threejs_version: r170+
---

## Summary

Activity scenes that need spectator cameras (follow / free orbit / action auto-target)
use a dual-canvas strategy: active play uses the static ortho canvas, spectators get
a PerspectiveCamera canvas. ONE camera per client — no extra shadow frusta.

## Details

### Key architectural decision

R3F Canvas `orthographic` prop is STATIC — cannot swap between ortho/perspective after
mount. Solution: branch on `spectatorCamMode` prop to render different `<Canvas>` elements.
Use `key={roomId + '-' + mode}` on Canvas to force context recreation on mode switches.

```tsx
if (spectatorCamMode) {
  return (
    <Canvas key={`${roomId}-${spectatorCamMode}`}
      camera={{ fov: 55, near: 1, far: 1500, position: [0, 900, 600] }}
      shadows gl={{ antialias: false }} dpr={[1, 1.5]}>
      <SpectatorCamera mode={spectatorCamMode} targetPetId={spectatorTargetPetId} entities={entities} />
      {/* ... rest of scene ... */}
    </Canvas>
  );
}
// Active play: static ortho canvas
return <Canvas orthographic ...>
```

### SpectatorCamera component

Module-scope scratch vectors (zero allocations):
```ts
const _camTargetPos  = new THREE.Vector3();
const _camDesiredPos = new THREE.Vector3();
const _camLookAt     = new THREE.Vector3();
const _entityPos     = new THREE.Vector3();
const FOLLOW_OFFSET  = new THREE.Vector3(0, 400, 350); // above + behind
```

Frame-rate independent lerp: `alpha = 1 - Math.exp(-CAMERA_LERP_ALPHA * dt)` where
`CAMERA_LERP_ALPHA = 4.0`.

OrbitControls for 'free' mode — created/disposed on mode change in useEffect:
```ts
useEffect(() => {
  if (mode === 'free') {
    const oc = new OrbitControls(camera, gl.domElement);
    oc.minDistance = 600; oc.maxDistance = 1500; oc.enablePan = false;
    orbitRef.current = oc;
  } else {
    orbitRef.current?.dispose();
    orbitRef.current = null;
  }
  return () => { orbitRef.current?.dispose(); };
}, [mode, camera, gl]);
```

'action' mode retargets every 3s to alive entity closest to arena center:
```ts
actionTimerRef.current += dt;
if (actionTimerRef.current >= 3.0) {
  let bestDist = Infinity;
  for (const e of entities.values()) {
    if (!e.alive) continue;
    const distSq = e.x * e.x + e.y * e.y;
    if (distSq < bestDist) { bestDist = distSq; bestId = e.petId; }
  }
  actionTargetRef.current = bestId;
  actionTimerRef.current = 0;
}
```

### Props added to BumperShellsScene

```ts
export type SpectatorCamMode = 'follow' | 'free' | 'action';

export interface BumperShellsSceneProps {
  roomId: string;
  selfPetId?: string | null;
  spectatorCamMode?: SpectatorCamMode;         // undefined = active-play static ortho
  spectatorTargetPetId?: string | null;         // 'follow' mode target
}
```

## Context

Bumper Shells arena (chunk #12a). Spec: `3d-spec.md §1.5`. The static ortho camera must
be preserved for active players — Iris Xe perf budget assumes one fixed frustum. Spectators
only need a camera switch after elimination, which is when they have a UI overlay showing.
The SpectatorCamSelector UI (3 buttons) is owned by the non-3D agent and passes the mode prop.
