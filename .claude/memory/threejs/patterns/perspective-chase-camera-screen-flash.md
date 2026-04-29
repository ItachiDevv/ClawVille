---
title: Perspective chase camera with velocity yaw + DOM screen flash
category: pattern
tags: [camera, chase, perspective, velocity, screen-flash, hit-feedback, shake, useFrame]
date: 2026-04-24
confidence: high
threejs_version: r170+
---

## Summary

Velocity-derived perspective chase camera for competitive multiplayer, plus a DOM-layer screen-edge
red flash for self-hit feedback. No React state in the hot path.

## Details

### Canvas setup

Pass the perspective camera via the Canvas `camera` prop — do NOT set it imperatively in a child:

```tsx
<Canvas
  camera={{ fov: 55, near: 1, far: 2500 }}
  shadows
  gl={{ antialias: false }}
  dpr={[1, 1.5]}
>
```

### ChaseCameraController

Mount as a child component inside the Canvas. Reads entity state from a Map (not array.find).

```tsx
// Module-scope scratch — NEVER allocate inside useFrame
const _chaseDesiredPos = new THREE.Vector3();
const _chaseLookAt    = new THREE.Vector3();
const _chaseShake     = new THREE.Vector3();

function ChaseCameraController({ selfPetId, entities, shakeRef }) {
  const { camera } = useThree();
  const cameraYawRef = useRef(0); // last known yaw — dead-reckon when stopped

  useFrame((_, delta) => {
    const self = selfPetId ? entities.get(selfPetId) : null;
    if (!self || !self.alive) return;

    const vx = self.vx ?? 0;
    const vz = self.vy ?? 0; // NOTE: server y = Three.js z
    const speed = Math.sqrt(vx * vx + vz * vz);

    // Only update yaw when moving — dead-reckon otherwise
    if (speed > 20) cameraYawRef.current = Math.atan2(vx, vz);

    const sin = Math.sin(cameraYawRef.current);
    const cos = Math.cos(cameraYawRef.current);

    // Chase arm: behind in velocity direction
    _chaseDesiredPos.set(
      self.x - sin * CHASE_CAM_DISTANCE,
      CHASE_CAM_HEIGHT,
      self.z - cos * CHASE_CAM_DISTANCE,
    );

    // Look-ahead: slightly ahead of player
    const lookAhead = Math.min(speed * 0.3, CHASE_CAM_LOOK_AHEAD);
    _chaseLookAt.set(
      self.x + sin * lookAhead,
      ARENA_HEIGHT / 2 + 30,
      self.z + cos * lookAhead,
    );

    // Exp-decay lerp (frame-rate independent)
    const alpha = 1 - Math.exp(-CHASE_CAM_LERP_ALPHA * delta);
    camera.position.lerp(_chaseDesiredPos, alpha);

    // Camera shake — add AFTER lerp so it doesn't interfere with smoothing
    const shakeAmp = shakeRef.current;
    if (shakeAmp > 0.1) {
      const elapsed = performance.now() * 0.001;
      const decay = shakeAmp * Math.exp(-SHAKE_DECAY * delta);
      shakeRef.current = decay;
      _chaseShake.set(
        Math.sin(elapsed * SHAKE_FREQ * Math.PI * 2) * shakeAmp,
        Math.cos(elapsed * SHAKE_FREQ * Math.PI * 2) * shakeAmp * 0.5,
        0,
      );
      camera.position.add(_chaseShake);
    } else {
      shakeRef.current = 0;
    }

    camera.lookAt(_chaseLookAt);
  });

  return null;
}
```

### Camera shake threading

`shakeRef = useRef(0)` in the parent component — mutable ref, NOT React state.
Written from `HitEventProcessor` (or any event handler) in useFrame.
Read by `ChaseCameraController` in the same frame. Zero re-renders.

```tsx
// Parent
const shakeRef = useRef(0);

// On self-hit event:
shakeRef.current = SHAKE_MAX_DISPLACEMENT; // e.g. 18wu
```

### DOM screen-edge red flash

Layer a position:absolute div ON TOP of the Canvas (not inside Three.js). This avoids
alpha-sorting, draw-call budget, and GPU compatibility concerns entirely.

```tsx
export default function ActivityScene() {
  const [flashOpacity, setFlashOpacity] = useState(0);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const handleSelfHit = useCallback(() => {
    shakeRef.current = SHAKE_MAX_DISPLACEMENT;
    clearTimeout(flashTimerRef.current);
    setFlashOpacity(0.45);
    flashTimerRef.current = setTimeout(
      () => setFlashOpacity(0),
      FLASH_DURATION_S * 1000,
    );
  }, []);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Canvas ...>
        <SceneContents onSelfHit={handleSelfHit} shakeRef={shakeRef} />
      </Canvas>

      {/* Red screen-edge flash — DOM layer, zero draw calls */}
      <div
        aria-hidden
        style={{
          position: 'absolute', inset: 0,
          pointerEvents: 'none',
          background: 'radial-gradient(ellipse at center, transparent 40%, rgba(200,0,0,0.7) 100%)',
          opacity: flashOpacity,
          transition: flashOpacity > 0
            ? 'opacity 0.05s ease-in'
            : `opacity ${FLASH_DURATION_S * 0.8}s ease-out`,
        }}
      />
    </div>
  );
}
```

### Fog calibration for perspective cam

When switching from orthographic to perspective, recalibrate fog:
- Ortho fog was set to dissolve at a distance matching the ortho camera pull-back — wrong for perspective.
- Perspective cam sees real world distances. Arena radius = R. Chase cam arm = D.
- Rule of thumb: `FOG_NEAR = R * 1.8` (dissolve just beyond arena edge); `FOG_FAR = FOG_NEAR * 2`.
- For ClawVille Bumper Shells (R=500, D=420): FOG_NEAR=900, FOG_FAR=1800.

### Shadow tuning for perspective cam

- Shadow map size 512 → 1024 for soft PCF shadows visible from the perspective angle.
- `DIR_SHADOW_CAM_BOUNDS = ARENA_RADIUS * 1.12` covers disc + some margin.
- `DIR_SHADOW_FAR = 1200` — deeper than ortho needs (perspective sees more vertical depth).

## Context

Built for Bumper Shells full rebuild 2026-04-24. Replaced a static OrthographicCamera.
The DOM flash pattern is reusable for any "self-damage" feedback (health games, racing collision, etc.).
