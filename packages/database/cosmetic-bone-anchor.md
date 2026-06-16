---
title: Cosmetic bone anchor — attach GLB accessory to avatar head bone
category: pattern
tags: [bone, anchor, hat, glasses, cosmetic, GLB, attach, VRM, rig, head-fit, axis-sign-safe]
date: 2026-06-07
confidence: high
threejs_version: r182
---

## Summary
Attach a GLB accessory (hat, glasses) to an avatar's head bone. Phase B adds `computeCosmeticHeadFit()` for proportion-aware, axis-sign-safe auto-placement across all humanoid VRM rigs. Legacy name-scan fallback preserved for non-humanoid GLB avatars.

## Details

### Phase B — auto-fit path (preferred for VRM rigs)

Use `computeCosmeticHeadFit(vrm, category, renderScale)` from `vrm-avatar-sizing.ts`:
- Gets raw head bone via `vrm.humanoid.getRawBoneNode('head')` — MUST be raw (NOT normalized) because cosmetics parent to the bone the animator drives
- Builds world-space AABB of head-bone subtree, SKIPPING `SkinnedMesh` nodes (their bind-pose bbox inflates wildly — see `gotchas/skinned-mesh-bbox-inflation.md`)
- Hat target = head-top + HAT_CLEARANCE_WU clearance; glasses = 0.25 below head-top + forward offset along `vrm.scene.getWorldDirection()`
- Converts to head-bone-LOCAL via `new Matrix4().copy(headBone.matrixWorld).invert()` — **axis-sign safe**, handles VRM0/VRM1/Mixamo/VRoid without hardcoded ±Z
- Returns `{ localPosition, localScale, headWidthWU }`
- Call at equip time (useEffect), NOT per frame — all allocs are local to the call

```ts
const fit = computeCosmeticHeadFit(vrm, category, vrmRenderScale);
const anchor = vrm.humanoid?.getRawBoneNode?.('head') ?? findHeadBone(parentObject);
const group = new THREE.Group();
group.position.copy(fit.localPosition);
group.position.x += nudgeOffsetXYZ[0];  // per-item assetMeta nudge on top
group.position.y += nudgeOffsetXYZ[1];
group.position.z += nudgeOffsetXYZ[2];
group.scale.setScalar(fit.localScale * nudgeScaleMult);
group.frustumCulled = false;
group.add(glbGroup);
anchor.add(group);
```

### Legacy path (non-humanoid / fallback)
When `vrm` is absent, use `findHeadBone(parentObject)` with the candidate scan below, then apply raw `assetMeta.offsetXYZ` offsets.

### findBone helper
```ts
function findBone(root: THREE.Object3D, boneName: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((child) => {
    if (found) return;
    if (child.name === boneName) { found = child; return; }
    if (child.name.toLowerCase() === boneName.toLowerCase()) { found = child; }
  });
  return found;
}
```

### Candidate bone names for head (legacy path, priority order)
```ts
const candidates = [
  'J_Bip_C_Head',    // VRM 0.x canonical
  'mixamorigHead',   // Mixamo sanitised (three.js strips ':')
  'mixamorig:Head',  // Raw Mixamo
  'Head',            // Standard glTF
  'head',            // lowercase variant
  'Bip001_Head',     // 3DS Max Biped
];
```

### assetMeta fields (applied on top of auto-fit in Phase B)
```jsonc
{
  "offsetXYZ":   [0, 0, 0],   // nudge on top of computed localPosition (bone-local)
  "scaleHint":   1.0,          // multiplier on top of computed localScale
  "rotationXYZ": [0, 0, 0],    // Euler in radians
  "boneAnchor":  null          // legacy only; unused in auto-fit path
}
```

### Player avatar wiring (player-avatar.tsx)
`rigType='universal'`, `vrm={vrm}`, `vrmRenderScale={vrmRenderScale}` passed to `<CosmeticLoader>`. The VRM instance from `useVRMInstance` and render scale from `computeVRMAvatarFit` are threaded through.

### frustumCulled = false
Always set on the wrapper Group and all children. T-pose bbox won't cover animated head position → disappears when camera is close/oblique.

### Dispose
On unmount: `anchor.remove(wrapper)`, traverse wrapper disposing all geometry + material. Cached base group in `GLB_CACHE` is NOT disposed — survives session.

### Fallback
No head bone found → attach to `parentObject` (avatar root). Asset appears, wrong height, but no crash.

## Context
Phase 3.3 → Phase B cosmetic render pipeline. `cosmetic-loader.tsx` `HatOrGlassesRenderer`. `computeCosmeticHeadFit` lives in `vrm-avatar-sizing.ts`. Phase B shipped 2026-06-07. Phase D: crustaceans + non-humanoid GLB rigs (future work).
