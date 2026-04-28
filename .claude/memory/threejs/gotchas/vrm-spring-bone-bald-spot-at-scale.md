---
title: VRM bald-spot — static geometry gap in Sketchfab_model hair strands; fix is position.y offset
category: gotcha
tags: [vrm, milady, hair, bald-spot, hairmodel, sketchfab-model, object-1003, walk-animation, head-bone, static-gap]
date: 2026-04-27
confidence: high
threejs_version: r170+
---

## Summary

The Milady VRM bald-spot at the back-crown is a **static geometry gap** baked into the VRM files. It is NOT spring-bone lag, NOT skinning error, NOT head-bone rotation. The `Sketchfab_model` group (hair tendrils) only reaches `headBoneY+21wu`; the actual scalp crown sits at `headBoneY+44wu`, leaving a 24.5wu gap. Fix: `Sketchfab_model.position.y += 0.218` at load time.

## CDP Measurements (2026-04-27, clawville.world/game live)

Scene graph structure (confirmed via CDP traverse):
- `mixamorigHead` (Bone)
  - `Hairmodel` (plain **Mesh**, pos.y=0.2069, scale=0.3209) — the top bun
  - `Sketchfab_model` (Group, pos.y≈0.1285–0.1345, scale≈0.1879)
    - `Object_1003` (plain Mesh, 2001 verts) — hair accessory
    - `Object_1003_1` (plain Mesh, 5059 verts) — lower hair tendrils
- `Eyes` (SkinnedMesh, at scene root)
- `Body_36338mesh002` (SkinnedMesh, at scene root)

Gap measurements (15 samples, full walk animation range hRx −0.047…+0.004 rad):
- Hairmodel crown-back world Y: `headBoneY + 59wu` (always covers scalp top ✓)
- Object_1003_1 crown-back world Y: `headBoneY + 21wu`
- Scalp crown-back world Y (body mesh, head-bone-weighted verts, boneInverse transform): `headBoneY + 44wu`
- **Gap = 24.5wu, constant across all animation frames**

After fix (`+0.218`):
- Object_1003_1 crown-back: `headBoneY + 44.7wu`
- Scalp crown-back: `headBoneY + 44.0wu`
- **Gap = 0.6wu** — essentially flush

## Why Previous Approaches Failed

All 7 prior iterations targeted the wrong cause:

| Approach | Why it failed |
|---|---|
| Spring-bone stiffness ×80/120/30 | `springBoneManager.joints.size === 0` — no spring joints in these VRMs |
| `rotation.x += 0.15/0.22/0.18` on Hairmodel | CDP proved crown vertex moves only 1.4wu for full 0→0.22 rad range |
| Scale Hairmodel up × 1.06 | Same geometry, crown-back moves < 1wu |
| Scalp cap sphere on mixamorigHead | Clipped through Hairmodel and rendered as visible black ball on top |

None of these addressed that `Object_1003_1` is the SHORT strands and they need to move UP, not that the bun needs to tilt.

## Fix (vrm-loader.ts, after rotateVRM0)

```ts
// Hair-strands gap fix — CDP measured 2026-04-27.
// Sketchfab_model contains the lower hair tendrils (Object_1003 + Object_1003_1).
// Their crown-back only reaches headBoneY+21wu; scalp is at headBoneY+44wu.
// Offset = 24.4wu / headBoneScale(112) = 0.218 local units.
vrm.scene.traverse((obj) => {
  if (obj.name === 'Sketchfab_model') {
    obj.position.y += 0.218;
    obj.updateMatrix();
  }
});
```

Applied BEFORE the MToon outline-disable traverse. Safe for all VRM variants (1–8) — the position.y varies slightly (0.1285–0.1345) but the gap is always 24.4wu so the offset is invariant.

## Head Bone Scale Context

`VRM_NPC_SCALE = 112`. The head bone inherits this scale. All "local units" in the head-bone frame are amplified 112× in world space.
- 0.218 local units × 112 = 24.4wu
- headBone.scale.x = 1.000 (scale is at the NPC group level, not individual bones)

Wait — the 112× amplification comes from the NPC GROUP scale, not the bone scale. The head bone's `scale.x = 1.000` in its own local frame. The group that holds `vrm.scene` has scale 112. Any offset on `Sketchfab_model.position.y` is in VRM local space (scale 1) then scaled 112× by the parent group. So 0.218 * 112 = 24.4wu world offset — confirmed by the CDP measurement.

## What Does NOT Exist in These VRMs

- No VRM spring-bone joints (`springBoneManager.joints.size === 0` — confirmed on multiple variants)
- No separate Hair armature hierarchy (all hair is plain Mesh, not SkinnedMesh)
- `Hairmodel` and `Sketchfab_model` are both non-skinned Meshes/Groups parented to the head bone — they follow rigidly with zero lag at any animation frame

## Context

7th iteration on this bug. `VRM_NPC_SCALE=112`. 5 Milady NPCs in world. Fix shipped in commit `2d26729` 2026-04-27.
