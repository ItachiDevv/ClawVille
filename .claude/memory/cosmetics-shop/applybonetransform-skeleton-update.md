---
name: applybonetransform-skeleton-update
description: "FIXED/respected in current code: Box3.setFromObject / applyBoneTransform on a freshly-parsed VRM reads zero boneMatrices -> near-origin verts -> giant-avatar fallback scale unless skeleton.update() runs first (updateMatrixWorld is not enough). Trap = regressing it in a new fit path."
category: gotcha
confidence: high
date: 2026-06-22
---

---
name: applybonetransform-skeleton-update
description: "skeleton.update() must precede applyBoneTransform/setFromObject on a SkinnedMesh; updateMatrixWorld alone leaves boneMatrices zero -> giant-avatar fallback. FIXED in current code."
category: gotcha
confidence: 0.95
date: 2026-06-22
---

## Symptom
A cosmetic fit (or avatar fit) computes a wildly wrong scale -- the avatar/cosmetic balloons to a fallback giant size (e.g. ~169x) -- nondeterministically by load timing.

## Root cause
`Box3.setFromObject` / `applyBoneTransform` on a freshly-parsed `SkinnedMesh` reads STALE/ZERO `boneMatrices` unless `skeleton.update()` runs first. `updateMatrixWorld()` alone does NOT compute `boneMatrices`. Zero boneMatrices => verts collapse near origin => measured `size.y ~= 0` => the code falls back to a giant default scale. The tell is non-determinism by load order (equip-on-load race).

## Current state: FIXED / respected
`vrm-avatar-sizing.ts` (3da-owned, consumed by cosmetics) calls `skeleton.update()` BEFORE every `applyBoneTransform`/`setFromObject` at all 5 sites: `:141-156` (computeVRMAvatarFit, with documenting comment), `:453`, `:499`, `:579`, `:711`.

## The trap = regressing it
Any NEW path that walks a SkinnedMesh bbox (a new cosmetic-category fit, a re-fit on rig swap, an NPC cosmetic fit) MUST replicate the `sm.skeleton.update()` guard. Never skip it.

## State
**FIXED/respected** in `vrm-avatar-sizing.ts`; the open risk is a new fit path omitting it. Global lesson: `feedback_applybonetransform_needs_skeleton_update`.

Related: [[proportion-aware-autofit]].
