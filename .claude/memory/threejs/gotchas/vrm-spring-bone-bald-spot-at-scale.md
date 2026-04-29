---
title: VRM bald-spot — asset-level fix only; runtime patches are dead ends
category: gotcha
tags: [vrm, milady, hair, bald-spot, hairmodel, sketchfab-model, asset-rebake, skinned-mesh, walk-animation]
date: 2026-04-28
confidence: high
threejs_version: r182
---

## Summary

The Milady VRM bald-spot at the back-crown is **asset-level, not runtime**. The shipped fix is `scripts/bake-vrm-hair.mjs`, which converts `Hairmodel`/`Hatmodel` from plain `Mesh` (parented to the Head scene node) into `SkinnedMesh` fully weighted to `mixamorig:Head` (joint 29). All 8 `apps/web/public/avatars/milady-official-N.vrm` files were rebaked in commit `c2b7cd5` (2026-04-28). **Do not patch this in vrm-loader.ts.**

## Root Cause

`Hairmodel` and `Hatmodel` were authored as plain Meshes parented to the `Head` scene node. three-vrm drives animation via skinning matrices on the `Body` SkinnedMesh — **those matrices do not update scene-graph node positions**. So during walk animation:
- Body verts weighted to the head bone follow `headBone` rotation correctly.
- Hairmodel/Hatmodel stay frozen at their bind-pose scene-node offset.
- Result: hair detaches from the skull during head tilt → 24.5wu vertical gap visible from over-the-shoulder camera angles.

## The Fix (shipped)

`scripts/bake-vrm-hair.mjs` (Codex, 2026-04-28). For each file:
1. Compute `skinSpace = inv(IBM_head) * HairNodeTRS` — converts Head-local TRS → Body skin space.
2. Apply that transform to vertex positions and normals.
3. Add `JOINTS_0` (all verts → joint 29) and `WEIGHTS_0` (all verts → 1.0).
4. Assign the Body's skin to the hair nodes.
5. Clear hair node TRS to identity (verts now live in skin space).

Validation: `scripts/validate-vrm-load.mjs` loads each VRM via `GLTFLoader + VRMLoaderPlugin + MToonMaterialLoaderPlugin` and confirms hair nodes are skinned after bake.

To re-bake (e.g. after editing source VRMs): `bun scripts/bake-vrm-hair.mjs --apply`.

## Failed Runtime Approaches — DO NOT REPEAT

Two days of session work tried these. None work. If anything, applying them on top of the now-correctly-rigged VRMs will REGRESS the animation.

| Approach | Why it failed |
|---|---|
| Spring-bone stiffness ×80/120/30 | `springBoneManager.joints.size === 0` on these VRMs — there are no spring joints to tune |
| `Hairmodel.rotation.x += 0.15/0.22/0.18` after `rotateVRM0` | CDP measured crown vertex world Y changed only 1.4wu across the full range — geometry can't compensate for rigging |
| Scale Hairmodel × 1.06 | Same geometry, crown-back moves < 1wu |
| Inject scalp-cap sphere on `mixamorigHead` | Visibly clipped through hair as a black ball on top of every Milady |
| `Sketchfab_model.position.y += 0.218` static offset | Closed gap in rest pose only — hair stayed FROZEN during head tilt because it's still a plain Mesh |
| Runtime `headBone.attach(Hairmodel/Sketchfab_model/Hatmodel)` | Object3D.attach preserves world transform at moment of reparent → hair lands in wrong space, detached from skull during walk |
| Earlier hand-bake via Blender mesh→SkinnedMesh script | Produced corrupted GLB (`Malformed buffer data: -1`, missing texture blobs, page wouldn't load) |

Conclusion shared with all of these: **you cannot fix authored-as-Mesh hair from the runtime. The skinning matrices the head bone exposes never propagate to a non-SkinnedMesh.** The rebake script is the durable fix.

## What `vrm-loader.ts` MUST stay clear of

- No `Sketchfab_model.position.y` patches.
- No `Hairmodel.rotation.x` patches.
- No scalp-cap mesh injection.
- No `headBone.attach(hairMesh)`.
- The loader stays minimal: parse, normalise, register MToon, set frustumCulled=false. Anything else is asset work.

## If the bald spot reappears

1. Check that the .vrm files in `apps/web/public/avatars/` still have hair as `SkinnedMesh`. Run `bun scripts/validate-vrm-load.mjs apps/web/public/avatars/milady-official-1.vrm` — should report `Hairmodel: SkinnedMesh ✓`.
2. If a `.vrm.bak` was restored or someone replaced the files with originals, re-run `bun scripts/bake-vrm-hair.mjs --apply`.
3. Do NOT add a runtime patch. Fix the source files.

## Context

7 runtime iterations across 2026-04-26 to 2026-04-28 ALL failed before Codex shipped the asset bake. The .claude/plans/milady-vrm-reauthor.md plan document lists every prior attempt in its history table. Confidence is high because the fix is committed, validated, and the asset is the source of truth — not loader code.
