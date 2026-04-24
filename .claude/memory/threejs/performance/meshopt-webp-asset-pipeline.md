---
title: meshopt + WebP asset optimization pipeline (C6)
category: performance
tags: [gltf-transform, meshopt, webp, vrm, glb, compression, pipeline, assets]
date: 2026-04-24
confidence: high
threejs_version: r170+
---

## Summary

`bun run assets:optimize` (scripts/assets-optimize.ts) runs a gltf-transform pipeline on all GLBs/VRMs in public/models and public/avatars. 45.9 MB → 14.5 MB (-68%) as of C6.

## Details

**Pipeline:** dedup → weld(0.0001) → [prune if not VRM] → textureCompress(WebP, max 1024) → meshopt(medium)

**VRM gotcha — CRITICAL:** gltf-transform strips unknown extensions including `VRM`, `VRMC_vrm`, etc. from the root `extensions` object. Must capture these before transformation from the raw GLB JSON chunk and re-inject after `io.write()`. See `reinjectVrmExtensions()` in the script.

**VRM gotcha — skip prune:** VRM0 blendShapeMaster references morph targets by INDEX. prune() reshuffles morph indices, breaking face expressions. VRMs skip the prune step.

**Temp path gotcha — CRITICAL:** gltf-transform NodeIO determines output format from file extension. Writing to `file + '.c6tmp'` produces JSON GLTF, not binary GLB. The correct temp extension is `file + '.c6tmp.glb'`. This was discovered the hard way in C6 session — the first run produced 48 corrupt files.

**Draco decode:** Files with KHR_draco_mesh_compression must have draco3d registered via `io.registerDependencies({'draco3d.decoder': decoderModule, 'draco3d.encoder': encoderModule})`. The `draco3d` package is already in devDependencies.

**No-gain pattern:** Some files with heavy Draco geometry + no large textures get LARGER after meshopt (meshopt can't beat Draco's geometry quantization). The script skips files where `sizeAfter >= sizeBefore`.

**Already-meshopt skip:** Files with `EXT_meshopt_compression` in `extensionsRequired` are skipped (auction-dome.glb, bazaar-fish-stall.glb, marketplace-food-stall.glb already had this from a prior pass).

**MeshoptDecoder registration:** New `apps/web/src/lib/three/meshopt-loader-setup.tsx` registers MeshoptDecoder at module import time AND inside a Canvas component (belt-and-suspenders). Imported in World3DCanvas.tsx alongside KTX2LoaderSetup.

## C6 size results (2026-04-24)

- guide.glb: 11.4 MB → 1.1 MB (-90%)
- guide-rigged.glb: 5.7 MB → 1.3 MB (-77%)
- flying-dutchman.glb: 2.1 MB → 333 KB (-85%)
- pearl.glb: 2.0 MB → 322 KB (-84%)
- 8 Milady VRMs: 11.7 MB total → 2.4 MB total (-80%)
- Total bundle: 45.9 MB → 14.5 MB (-68%)

No-gain files (kept original): building-chest, jellyfish, octopus_toy, pineapple-house, salty-spitoon, sea_horse — all have Draco-compressed geometry + small or no textures.

## Context

Discovered in C6 FPS phase. Asset loading was the dominant contributor to initial page-load time and first-frame GPU texture upload spike. meshopt + WebP delivers 68% wire savings with no visual difference on Intel Iris Xe (cartoon models tolerate WebP lossy compression well at 1024px max).
