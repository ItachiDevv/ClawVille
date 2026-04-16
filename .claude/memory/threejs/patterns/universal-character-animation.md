---
title: Universal procedural character animation for static GLBs
category: pattern
tags: [animation, procedural, GLB, character, NPC, static-mesh, softLerp, spatial-analysis]
date: 2026-04-09
confidence: high
threejs_version: r170+
---

## Summary
Architecture for driving any static GLB model with rich procedural animation — per-mesh secondary motion + group-level squash/stretch — without embedded skeletal data.

## Details

### Two-pass design
1. **Analyse once** — `analyseCharacter(root)` traverses all meshes, computes bounding boxes, sorts by volume, partitions into upper/lower/left/right/front/back/appendages buckets.
2. **Animate every frame** — `CharacterAnimator.update(group, elapsed, dt, isMoving)` drives group-level rotation/scale AND individual mesh rotations. No allocations in hot path.

### Key pattern: softLerp for all rotations
```typescript
function softLerp(current: number, target: number, speed: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-speed * dt));
}
```
This is framerate-independent and avoids snap/jitter compared to fixed lerp factors.

### Per-character-type motion signatures
Each type has a distinct physical "personality":
- **crab** — sideways rock (rotation.z), claw snap every ~4s (timed phase from `Math.floor(t/4)`)
- **lobster_plush** — exaggerated squash/stretch (±0.22 scaleY), floppy appendages
- **hermit_crab** — slow pendulum sway (speed 2), constrained breathing (shell weight)
- **anime** — subtle chest breathe (±0.025), hair in upper-third meshes, hem sway in lower meshes
- **jellyfish** — bell pulse via `easeInOutSine((sin+1)/2)`, tentacle depth-factor amplitude
- **octopus** — jet propulsion: half-wave pulse `jetPhase < PI ? sin : 0`, `easeOutElastic`
- **seahorse** — rigid float, tail curl wave propagates tip→base, dorsal flutter at 14–22 Hz

### Appendage detection
```typescript
const elongation = dims[0] / (dims[1] + 0.0001); // max / median
const appendages = all.filter(m => m.elongation > 2.5);
```
Catches legs, antennae, tentacles, tails without name matching.

### Integration in React Three Fiber
```tsx
// useMemo — build once per model+color change
const charAnimator = useMemo(() =>
  createCharacterAnimator(modelKey, clonedScene), [scene, modelKey]);

// useFrame — call every frame
charAnimator.update(animGroupRef.current, clock.elapsedTime, dt, isMoving);
```

### Routing: new vs legacy system
lobster and crayfish keep `LobsterAnimator` (full body-part discovery + combat states).
All 9 new models use `CharacterAnimator` via `MODEL_KEY_TO_TYPE` lookup.
The guard is `speciesInfo.key !== 'lobster' && speciesInfo.key !== 'crayfish'`.

## Context
Built for ClawVille's 9 new agent models (crustaceans, anime, sea creatures).
Wired into `SelectAgentCanvas.tsx` (idle preview) and `arena-npcs.tsx` (walk in world).
