---
name: humanoid-vrm-autofit
description: "Every humanoid VRM render site MUST use computeVRMAvatarFit() from apps/web/src/lib/three/vrm-avatar-sizing.ts — flat scale values (reg.scale, AVATAR_VRM_SCALE) are picker-only and break for any rig that doesn't share Milady's 1.6m bbox."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 735b5afc-95a7-4172-bd62-c10121462343
---

When mounting a VRM in any 3D scene (player avatar, NPC, picker, surf rider, future VRM render site), wire the primitive's `scale` and `position.y` from `computeVRMAvatarFit(vrm, speciesOrAnimatorId)` exported by `apps/web/src/lib/three/vrm-avatar-sizing.ts`. Do NOT use `reg.scale` (=13, picker-only) or any flat constant for the world-render path.

**Why:** ClawVille's VRMs come from two unit conventions: VRoid (Milady, m-scale, feet at Y=0, bbox≈2.2m) and Mixamo-rigged (Hermes/Tekk, cm-scale, hips at Y=0, bbox≈190cm). A flat scale value calibrated for one breaks the other — pre-fix `AVATAR_VRM_SCALE=112` rendered Milady at 179.2 wu but Hermes at the wrong on-screen size and feet buried below terrain. The auto-fit measures bbox at scale=1, scales to `VRM_AVATAR_TARGET_HEIGHT_WU = 179.2`, returns `offsetY = -box.min.y * scale` so feet land at world Y=0 regardless of rig pivot. Tekk's wing override (`SPECIES_TARGET_HEIGHT_WU.tekk = 230`) keeps the body at standard height while wings legitimately overshoot. Verified live 2026-05-14: 6 NPCs across all three families resolve to the same on-screen height.

**How to apply:** Adding a new humanoid VRM is now zero scale-tuning — register it in `agent-model-registry.ts` with `avatar_type: 'vrm'` and an optional `animatorId` (only needed if it'll get an SPECIES_TARGET_HEIGHT_WU override). The auto-fit handles the rest. If you see a humanoid rendering at wrong size, search for any flat scale literal at the primitive (`scale={[N, N, N]}` where N isn't from `computeVRMAvatarFit`) and replace. Doc: 3dStructure.md §6c. Related: [[mixamo-force-inplace]], [[vrm-facing-formula]].
