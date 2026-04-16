---
title: FPS-style follow camera with OrbitControls
category: pattern
tags: [camera, follow, orbit-controls, fps, 3rd-person, lerp, controlMode]
date: 2026-04-09
confidence: medium
threejs_version: r182
---

## Summary
3rd-person follow camera that lerps OrbitControls.target toward a character and enforces a radial follow distance — arrow key orbit angle is preserved.

## Details

The key insight: OrbitControls already owns the camera-to-target angle. A follow camera only needs to:
1. Lerp `controls.target` toward the character world position (smooth lag)
2. Rescale the camera-to-target offset vector to a fixed follow distance (no snapping — lerp the distance too)

All scratch vectors must be module-level constants to avoid per-frame allocation.

```typescript
// Module-level scratch objects (no GC pressure)
const _followOffset = new THREE.Vector3();
const _followTarget = new THREE.Vector3();

const FPS_FOLLOW_DISTANCE = 40; // units
const CHAR_TARGET_Y = 15;       // height of orbit target above ground plane

function FPSFollowCamera({ controlsRef }) {
  useFrame(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    // Resolve target position from store (getState = no subscription, zero cost)
    const { controlMode, petPosition, possessedNpcId } = useGameStore.getState();
    let gameX: number, gameY: number;
    if (controlMode === 'npc' && possessedNpcId) {
      const npc = useNpcStore.getState().npcs.find(n => n.id === possessedNpcId);
      if (!npc) return;
      gameX = npc.x; gameY = npc.y;
    } else {
      gameX = petPosition.x; gameY = petPosition.y;
    }

    // 2D game-space → Three.js world XZ (map center is 0,0)
    const worldX = gameX - HALF_W;
    const worldZ = gameY - HALF_H;

    // Lerp target (Y lerps toward character height constant)
    const tgt = controls.target;
    tgt.x += (worldX - tgt.x) * 0.1;
    tgt.y += (CHAR_TARGET_Y - tgt.y) * 0.1;
    tgt.z += (worldZ - tgt.z) * 0.1;

    // Enforce follow distance — lerp toward target distance to avoid snap
    _followOffset.subVectors(controls.object.position, tgt);
    const currentDist = _followOffset.length();
    if (currentDist > 0.001) {
      const lerpedDist = currentDist + (FPS_FOLLOW_DISTANCE - currentDist) * 0.1;
      _followOffset.multiplyScalar(lerpedDist / currentDist);
      _followTarget.copy(tgt).add(_followOffset);
      if (_followTarget.y < CAM_Y_MIN) _followTarget.y = CAM_Y_MIN;
      controls.object.position.copy(_followTarget);
    }

    controls.update();
  });
  return null;
}
```

## Camera routing pattern (controlMode-based)

```tsx
// In SceneContents — reactive selector so JSX re-renders on mode change
const controlMode = useGameStore((s) => s.controlMode);

{controlMode === 'explore'
  ? <WASDCameraController controlsRef={controlsRef} />
  : <FPSFollowCamera controlsRef={controlsRef} />
}
// Arrow key rotation is ALWAYS mounted
<ArrowKeyRotationController controlsRef={controlsRef} />
```

OrbitControls `minDistance` should be tight (20) in follow modes and wider (80) in free-cam mode. Since it's set at mount, it reads from the reactive selector.

## Context
ClawVille Step 3 of control system redesign. controlMode values: 'explore' (WASD free cam) | 'player' (FPS follow pet) | 'autonomous' (FPS follow pet, no WASD input) | 'npc' (FPS follow possessed NPC). The pattern co-operates cleanly with ArrowKeyRotationController which separately adjusts the spherical angle around the target each frame.
