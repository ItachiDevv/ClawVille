---
title: Hand-baking VRM via Blender mesh→SkinnedMesh script produces corrupted GLB
category: gotcha
tags: [vrm, blender, bake, glb, malformed-buffer, gltf-transform, asset-pipeline]
date: 2026-04-28
confidence: high
threejs_version: r182
---

## Summary

Running an arbitrary "convert this Mesh to a SkinnedMesh" script inside Blender on a meshopt-compressed VRM and re-exporting via raw glTF Binary export produces a corrupted file. Symptoms: `Malformed buffer data: -1` on load, missing texture blobs, page won't render. The correct approach is to operate on the GLB binary directly via `@gltf-transform/core` + meshopt extension, preserving VRM extension JSON — see `scripts/bake-vrm-hair.mjs`.

## Symptoms after a bad bake

When loaded via `GLTFLoader + VRMLoaderPlugin`:
- `Malformed buffer data: -1` thrown by GLTFLoader during parse.
- Texture blobs missing — embedded base color / MToon textures don't appear in `vrm.materials`.
- Three-vrm humanoid initialization fails because joint references are broken.
- The page either fails to render the avatar entirely or renders an untextured T-pose.

## Why Blender raw-export breaks this

VRMs use:
- `EXT_meshopt_compression` for vertex/index buffers.
- `EXT_texture_webp` for embedded textures.
- VRM extension JSON (`VRMC_vrm`, `VRMC_springBone`, etc.) at the glTF root.

Blender's default glTF Binary export does NOT preserve these extensions. The output is missing the meshopt header, the WebP blocks may be re-encoded as PNG (silently failing if Blender lacks the WebP plugin), and the VRM extension JSON is dropped entirely. Even if you write a Blender script to add JOINTS_0/WEIGHTS_0 attributes, the round-trip through `bpy.ops.export_scene.gltf` strips the VRM bones from a valid VRM.

## What WORKS — the shipped pipeline

`scripts/bake-vrm-hair.mjs` operates on the GLB binary directly:

```js
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization])
  .registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });

const doc = await io.read(inputPath);
// ...mutate the doc graph (add JOINTS_0/WEIGHTS_0, transform vertices, etc.)...
await io.write(outputPath, doc);
```

This preserves all glTF extensions (including the VRM extension JSON) and re-runs meshopt compression on the modified buffers.

## Validation harness

Always run `scripts/validate-vrm-load.mjs` against a re-baked VRM before shipping. It loads via the same Three.js + three-vrm + MToon stack the web app uses and reports:
- Malformed buffer / parse errors.
- Missing texture references.
- Hair node skinning state (Mesh vs SkinnedMesh).
- MToon material count.

## Don't do these

| Approach | Why it fails |
|---|---|
| Blender → glTF Binary export of edited VRM | Drops VRM extensions, breaks meshopt, may re-encode WebP |
| Manual JSON surgery on a decompressed glTF then re-zip | Likely to mis-align meshopt buffer offsets — produces `Malformed buffer data: -1` |
| Running a Python/JS script that touches the binary buffer at byte offsets you computed manually | One mis-counted byte = corrupted file |
| Blender VRM Addon export (without testing the `--meshopt` flag in your version) | Some addon versions strip meshopt; check output by loading via `validate-vrm-load.mjs` |

## Context

This trap was hit during the bald-spot saga 2026-04-26 → 2026-04-28. An earlier attempt to bake hair to SkinnedMesh through Blender scripting produced `milady-official-1.vrm` with `Malformed buffer data: -1` — restored from `.vrm.bak` in commit `b17343a`. The successful bake (commit `c2b7cd5`) used `@gltf-transform` directly. The lesson: for VRM operations that touch geometry or skinning, treat the .vrm as a glTF Binary you operate on programmatically, not a Blender scene.
