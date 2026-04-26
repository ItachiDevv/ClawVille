---
title: Reef Race fog-fade "black portal" when track scales up but fog distances don't
category: gotcha
tags: [fog, large-track, material-fog-false, reef-race, perspective-cam, track-visibility]
date: 2026-04-26
confidence: high
threejs_version: r170+
---

## Summary

When a racing track is scaled up but `FOG_NEAR`/`FOG_FAR` are not updated proportionally,
the far side of the track fades into the fog color and looks like a "black portal" that
only "loads" as the player drives toward it — identical to LOD pop-in even though the
geometry is fully in the scene.

## Details

**Track geometry:** Flat ribbon `BufferGeometry` — NOT chunked, NOT LOD'd. The entire
closed ellipse is always in the scene graph. The "lazy load" appearance is pure fog.

**Math (1.5× Reef Race scale-up, 2026-04-26):**
- Ellipse: A=1650, B=1050. Diameter across long axis ≈ 3300wu.
- Far side from player ≈ 2100wu. Chase cam 350wu behind → ~2450wu from camera.
- Old fog: near=1200, far=2700. At 2450wu → `(2450-1200)/(2700-1200) = 83%` fog weight.
  Far half of track was 83–100% fog color. Appears "not there yet."
- As player drives toward it, distance drops, fog weight drops → "portal" appears.

**Fix 1 — `material.fog = false` on track surface + guardrails:**

```ts
const _trackMat = new THREE.MeshStandardMaterial({
  color: '#1a6b3c',
  side: THREE.DoubleSide,
  fog: false,   // ← racing surface always fully visible, no distance fade
});

const _guardrailMat = new THREE.MeshStandardMaterial({
  color: '#e0e0e0',
  side: THREE.DoubleSide,
  fog: false,   // ← lane boundary always fully visible
});
```

Track + guardrails are the player's positional reference. They must be visible at all
distances regardless of what the fog is doing for depth cue on props/karts.

Coral/decoration materials keep `fog: true` — depth cue on surrounding props is fine and
desirable.

**Fix 2 — Push fog distances for the new track size:**

```ts
// reef-race-config.ts
FOG_NEAR = 2000  // props/karts crisp at normal racing distance (~350wu arm + 1000wu ahead)
FOG_FAR  = 4500  // far-side karts visible with soft haze; ≤ CAMERA_FAR ✓
CAMERA_FAR = 5000  // must be ≥ FOG_FAR (Iris Xe rule: fog.far > camera.far = FPS drop)
DIR_SHADOW_FAR = 4000        // shadow frustum must cover full track diagonal
DIR_SHADOW_CAM_BOUNDS = 4000 // same
```

## Fog-distance formula for an elliptical racing track

```
ellipse_long_axis  = 2 * A  (= 3300wu for 1.5× scale)
far_side_from_player ≈ A + B  (≈ 2700wu worst case)
camera_to_far_side  = far_side_from_player + camera_arm  (≈ 2700 + 350 = 3050wu)

FOG_NEAR = max(500, camera_arm * 3)       → ~1000–2000wu (keep nearby crisp)
FOG_FAR  = camera_to_far_side * 1.5       → gives soft haze even at worst case
CAMERA_FAR = FOG_FAR * 1.1                → always ≥ FOG_FAR
```

Adjust multipliers to taste; the invariant is `FOG_FAR ≤ CAMERA_FAR`.

## Context

Surfaced 2026-04-26 in Reef Race after the track was scaled 1.5× (A 1100→1650,
B 700→1050, half-width 150→300). The config had a prior fog bump (1800→2700) from
the scale-up commit but still wasn't far enough. The `fog=false` material trick is the
primary fix; pushing the fog distances is secondary but important so far-side karts
remain visible.

The user described it as "only a quarter of the track loads until you go through a black
portal" — the geometry was always there, just rendered as solid fog color.
