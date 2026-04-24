---
title: Mixamo → VRM retarget requires rest-pose-differential quaternion transform
category: gotcha
tags: [vrm, mixamo, animation, retarget, quaternion, t-pose, rest-pose]
date: 2026-04-23
confidence: high
threejs_version: r170+
---

## Summary

Naive clone+rename of Mixamo animation tracks onto VRM bone names produces a permanent T-pose. The keyframe quaternion values MUST be transformed into the VRM's rest-pose-relative coordinate frame before they are usable.

## Details

A Mixamo animation clip stores each bone's rotation as a quaternion relative to the Mixamo skeleton's rest pose (T-pose). A VRM skeleton has a different rest pose. If you simply rename a track from `mixamorigHips.quaternion` to `Normalized_J_Bip_C_Hips.quaternion` without transforming the values, the AnimationMixer applies Mixamo-T-pose-relative quaternions to VRM-rest-pose bones. The reference frames disagree, so the character freezes at whatever pose results from misinterpreting the identity rotation — which is T-pose.

### The required transform

For each source Mixamo rig node, compute at load time:

```ts
const restRotationInverse     = mixamoRigNode.getWorldQuaternion(...).invert();
const parentRestWorldRotation = mixamoRigNode.parent.getWorldQuaternion(...);
```

Then for every quaternion keyframe `q`:

```ts
q.premultiply(parentRestWorldRotation).multiply(restRotationInverse);
```

This converts `q` from Mixamo-rest-relative space into the coordinate frame the VRM AnimationMixer expects.

### VRM 0.x axis flip

VRMUtils.rotateVRM0 adds a π rotation to `vrm.scene`, inverting the X and Z axes of every bone. For VRM 0.x models (metaVersion starts with "0"), every even-indexed component in each XYZW tuple (indices 0, 2 of each group of 4) must be negated:

```ts
values.map((v, i) => (vrm0 && i % 2 === 0 ? -v : v))
```

### Mixer root must be vrm.scene

The corrected retargeter emits tracks keyed on `vrmNode.name` (e.g. `Normalized_J_Bip_C_Hips.quaternion`). VRMHumanoidRig (which contains all `Normalized_*` nodes) is a child of `vrm.scene`, so the mixer must be rooted at `vrm.scene` — NOT `normalizedHumanBonesRoot`. PropertyBinding resolves node names via `scene.getObjectByName()`, which searches the whole subtree.

The old workaround of rooting the mixer at `normalizedHumanBonesRoot` was ONLY necessary because the naive retargeter produced wrong quaternion values — it was papering over the real bug. Once the rest-pose transform is applied correctly, `vrm.scene` is the right root.

### Update order

mixer.update(delta) → vrm.update(delta). The mixer writes normalized bone poses; vrm.update propagates them to raw bones and runs spring-bone physics.

## Context

Diagnosed and fixed 2026-04-23 after multiple sessions of T-pose debugging. The fix is a direct port of Milady's MIT-licensed `retargetMixamoGltfToVrm.ts` from `milady-ai/milady/packages/app-core/src/components/avatar/`. The same algorithm is used by pixiv's canonical `humanoidAnimation/loadMixamoAnimation.js`.

Files changed:
- `apps/web/src/lib/three/mixamo-retarget.ts` — full rewrite
- `apps/web/src/lib/three/vrm-character-animator.ts` — cache now stores full GLTF ({scene, animations}), mixer re-rooted to vrm.scene

Canonical references:
- Milady: `milady-ai/milady packages/app-core/src/components/avatar/retargetMixamoGltfToVrm.ts` (MIT)
- pixiv: `@pixiv/three-vrm` examples `humanoidAnimation/loadMixamoAnimation.js` (MIT)
