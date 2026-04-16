---
title: WebP texture compression for GLBs — gltf-transform + sharp, no toktx
category: performance
tags: [webp, ktx2, texture-compression, gltf-transform, glb, drei, three-stdlib, EXT_texture_webp]
date: 2026-04-11
confidence: high
threejs_version: r170+
---

## Summary
PNG textures embedded in GLBs can be converted to WebP with 70-89% wire-size reduction using `@gltf-transform/functions` + `sharp`. No loader changes required — `GLTFLoader` (three-stdlib) handles `EXT_texture_webp` by default.

## Details

### Why WebP instead of KTX2

KTX2/UASTC (via `@gltf-transform/cli etc1s/uastc`) requires `toktx` (KTX-Software), a system binary that must be installed separately. The `@gltf-transform/functions` programmatic API does NOT support KTX2 — it only supports `jpeg/png/webp/avif`. WebP achieves equivalent or better wire-size savings (80-89% vs PNG), and is supported by all modern browsers.

KTX2 would additionally reduce GPU memory (textures stay GPU-resident compressed). WebP does not — it decompresses to RGBA on GPU upload. For the ClawVille perf pass, wire savings were the primary goal so WebP was the right call.

### Programmatic approach (preferred, re-runnable)

```ts
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression, EXTTextureWebP } from '@gltf-transform/extensions';
import { textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';
import draco3d from 'draco3d';

const io = new NodeIO().registerExtensions([KHRDracoMeshCompression, EXTTextureWebP]);
// Draco decoder required to READ existing KHR_draco_mesh_compression files
const decoderModule = await draco3d.createDecoderModule();
const encoderModule = await draco3d.createEncoderModule();
io.registerDependencies({ 'draco3d.decoder': decoderModule, 'draco3d.encoder': encoderModule });

const document = await io.readBinary(fs.readFileSync('model.glb'));
document.createExtension(EXTTextureWebP).setRequired(true);
await document.transform(textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 82 }));
const outputBytes = await io.writeBinary(document);
```

### Required devDeps
```json
"@gltf-transform/core": "^4.3.0",
"@gltf-transform/extensions": "^4.3.0",
"@gltf-transform/functions": "^4.3.0",
"draco3d": "^1.5.7",
"sharp": "^0.34.5"
```

### GLTFLoader support (zero config)

`GLTFLoader` in three-stdlib 2.36+ auto-registers `GLTFTextureWebPExtension`:
```js
this.register(function(parser) {
  return new GLTFTextureWebPExtension(parser);  // line 26 in GLTFLoader.js
});
```
`detectSupport()` uses `new Image()` to probe WebP support via browser API. If EXT_texture_webp is `required` and the browser doesn't support WebP, it throws. All modern browsers support WebP.

### drei useGLTF — no changes needed

`useGLTF` uses three-stdlib's `GLTFLoader` which already has WebP support. No `extendLoader` callback needed.

### Real results — Pass 1 (ClawVille 2026-04-11)

| File | Before | After | Saved |
|---|---:|---:|---:|
| underwater-decorations.glb | 5.69 MB | 1.03 MB | -81.9% |
| characters/spongebob.glb | 3.26 MB | 511 KB | -84.7% |
| pineapple-house.glb | 3.46 MB | 544 KB | -84.6% |
| salty-spitoon.glb | 3.06 MB | 379 KB | -87.9% |
| lobster.glb | 1.73 MB | 195 KB | -89.0% |
| chum-bucket.glb | 1.76 MB | 606 KB | -66.4% |
| **TOTAL P1** | **18.96 MB** | **3.21 MB** | **-83.1%** |

### Real results — Pass 2 (ClawVille 2026-04-11)

| File | Before | After | Saved |
|---|---:|---:|---:|
| building-seashell.glb | 1.74 MB | 107 KB | -94.0% |
| patty-building.glb | 1.24 MB | 495 KB | -61.2% |
| jellyfish.glb | 1.19 MB | 652 KB | -46.4% |
| characters/gary.glb | 926 KB | 162 KB | -82.6% |
| characters/plankton.glb | 730 KB | 79 KB | -89.1% |
| characters/mrs-puff.glb | 634 KB | 241 KB | -62.1% |
| downtown-building.glb | 634 KB | 282 KB | -55.5% |
| boating-school.glb | 605 KB | 548 KB | -9.5% (24 small textures) |
| characters/karen.glb | 239 KB | 165 KB | -30.8% |
| **TOTAL P2** | **7.95 MB** | **2.73 MB** | **-65.6%** |

Note: boating-school.glb has 24 textures, each very small, so WebP overhead (file headers) offsets savings. Still worth compressing.

### Warning: WebP decode cost causes long-task regression

After WebP compression the post-mount GPU upload long task jumped from 225ms → 417ms because WebP decode+upload is more expensive than raw PNG upload. Mitigate with StaggeredTextureUpload (see staggered-texture-upload.md).

Quality setting 82 is excellent for stylised/cartoony assets.

### Draco geometry preservation

When reading a GLB that has `KHR_draco_mesh_compression`, gltf-transform DECODES the geometry internally (lossy round-trip if you re-encode Draco). However, the programmatic `textureCompress` transform only touches texture data — the geometry buffers pass through unchanged as the Draco extension data is preserved in the serialised output. You still need `draco3d` installed because NodeIO calls the decoder during the read phase.

### KTX2 path if toktx becomes available

Install KTX-Software 4.3.0+ (`brew install ktx-software` / pre-built binaries from GitHub releases), then:
```bash
bun x @gltf-transform/cli etc1s model.glb model-etc1s.glb --quality 128
# or
bun x @gltf-transform/cli uastc model.glb model-uastc.glb
```
UASTC = better quality, larger; ETC1S = smaller, lower quality. Both need a KTX2Loader wired up in GLTFLoader.

## Context
ClawVille cold-load optimization pass (2026-04-11). underwater-decorations.glb was the waterfall tail at 5.93 MB because its 8 PNG textures (all 1024×1024) comprised nearly 100% of the file. Draco pass saved only 74 KB (1.3%) because Draco compresses geometry, not textures.
