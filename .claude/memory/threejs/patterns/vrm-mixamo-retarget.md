---
title: Mixamo → VRM humanoid retargeter
category: pattern
tags: [vrm, mixamo, retarget, animation, three-vrm, humanoid, milady]
date: 2026-04-21
confidence: high
threejs_version: r182 / @pixiv/three-vrm 3.5.2
---

## Summary
Retarget Mixamo AnimationClips to VRM humanoid skeletons by rewriting track names only (no keyframe data copying). Works at load time, not per-frame.

## Details

### Key files
- `apps/web/src/lib/three/mixamo-retarget.ts` — bone map + `retargetMixamoClip(clip, vrm)`
- `apps/web/src/lib/three/vrm-loader.ts` — Suspense-compatible VRM loader with module cache
- `apps/web/src/lib/three/vrm-character-animator.ts` — AnimationMixer per VRM, 3 clips, crossfade

### Critical gotchas

**rotateVRM0 must be called before use (not before retarget)**
- VRM 0.x faces +Z at rest. `VRMUtils.rotateVRM0(vrm)` adds `π` to `vrm.scene.rotation.y` → both VRM 0.x and 1.0 face -Z after this call.
- **This is the OPPOSITE of lobster.glb which faces +Z.**
- VRM facing formula: `atan2(vx, -vy)` vs GLB formula `atan2(vx, vy)`.
- Use separate `VRM_DIR_ROTATION` constants: `down: Math.PI, up: 0, right: Math.PI/2, left: -Math.PI/2, idle: Math.PI`.

**Track name format**
- Mixamo tracks: `mixamorig:Hips.quaternion`, `mixamorig:Spine.quaternion`
- After retarget: `<boneNode.name>.quaternion` (the actual Object3D name in the VRM scene)
- Only retarget `quaternion` and `position` tracks — skip `scale` tracks (interfere with rest-pose)

**Three-vrm v3.5.2 API**
- Use `humanoid.getRawBoneNode(vrmBoneName)` to get the actual scene Object3D for each bone
- `removeUnnecessaryJoints` is deprecated → use `combineSkeletons` instead
- No `deepCloneVRM` in this version → module-level cache (one VRM per path), one player pet

**VRM feet at Y=0**
- VRM spec mandates feet at origin. Skip `computeLocalMinY` / `pivotOffsetY` entirely.
- No yOffset hack needed for VRM path.

**No color tinting**
- MToon materials break under `MeshStandardMaterial.color.lerp()`. Skip `applyColorTint()` for VRM avatars.

### Mixamo bone name map (canonical)
```
Hips → hips, Spine → spine, Spine1 → chest, Spine2 → upperChest,
Neck → neck, Head → head,
LeftUpLeg → leftUpperLeg, LeftLeg → leftLowerLeg, LeftFoot → leftFoot,
RightUpLeg → rightUpperLeg, RightLeg → rightLowerLeg, RightFoot → rightFoot,
LeftShoulder → leftShoulder, LeftArm → leftUpperArm, LeftForeArm → leftLowerArm, LeftHand → leftHand,
RightShoulder → rightShoulder, RightArm → rightUpperArm, RightForeArm → rightLowerArm, RightHand → rightHand,
(+ 20 finger bones)
```

## Context
Implemented for 8 Milady Official VRM avatars in ClawVille (2026-04-21). Mixamo GLBs at `/avatars/animations/{idle,walk,run}.glb`. Scale=13 gives ~20.8wu visual height (smaller than sea-creature NPCs at 45wu — intentional for human-scale avatar in underwater world).
