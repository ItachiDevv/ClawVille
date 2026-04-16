---
title: Draco GLB compression — real-world results and drei auto-decode
category: performance
tags: [draco, gltf-pipeline, compression, drei, DRACOLoader]
date: 2026-04-11
confidence: high
threejs_version: r170+
---

## Summary
`gltf-pipeline` with Draco level 10 achieves 5-20% size reduction on geometry-heavy GLBs. Texture-heavy GLBs (like underwater-decorations.glb) compress very little. drei's `useGLTF` auto-decodes Draco with no config required.

## Details

### drei DRACOLoader — zero config required
`useGLTF` (from `@react-three/drei`) automatically:
1. Creates a `DRACOLoader` and sets `decoderPath = 'https://www.gstatic.com/draco/versioned/decoders/1.5.5/'`
2. Attaches it to every `GLTFLoader` instance via `setDRACOLoader(d)`

No `setDecoderPath` call, no explicit DRACOLoader import — it just works.

### Real compression numbers (ClawVille 2026-04-11)

| File | Before | After | Saved | % |
|---|---:|---:|---:|---:|
| underwater-decorations.glb | 5.76 MB | 5.69 MB | 74.6 KB | 1.3% |
| pineapple-house.glb | 3.98 MB | 3.46 MB | 535 KB | 13.1% |
| characters/spongebob.glb | 4.09 MB | 3.26 MB | 849 KB | 20.3% |
| salty-spitoon.glb | 3.24 MB | 3.06 MB | 191 KB | 5.7% |

**Why underwater-decorations.glb barely compressed (1.3%):** The 5.9 MB is dominated by embedded textures, not geometry. Draco only compresses mesh data. For texture-heavy GLBs, KTX2/Basis compression is the correct tool.

**Why spongebob.glb compressed best (20.3%):** Character models have dense, compressible vertex geometry (positions, normals, UVs) with relatively few textures.

### Draco options used
```ts
{
  compressionLevel: 10,       // max entropy coding
  quantizePositionBits: 14,   // sub-mm precision for normal scales
  quantizeNormalBits: 10,     // imperceptible quantization error
  quantizeTexcoordBits: 12,   // good UV precision, avoids seams
  quantizeColorBits: 8,       // lossless 8-bit per channel
}
```

### Tooling
```bash
bun add -D gltf-pipeline  # add at monorepo root
bun run scripts/compress-glbs.ts
```

Script does: backup → compress → validate GLB magic (0x46546C67) → write in-place → report.

### Backup location
`apps/web/public/models/.draco-backup/<filename>` — preserved original. Script skips re-backup if it already exists.

### Key gotcha
If a GLB is already Draco-compressed or is texture-only, `gltf-pipeline` may output a file that is LARGER than the input. Always check `sizeAfter >= sizeBefore` and keep the original in that case.

## Context
ClawVille cold-load optimization pass (2026-04-11).
