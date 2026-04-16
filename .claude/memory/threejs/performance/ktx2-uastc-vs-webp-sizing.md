---
title: KTX2 UASTC vs WebP wire size — UASTC is 4-5x larger for cartoon GLBs
category: performance
tags: [ktx2, uastc, webp, texture-compression, gltf-transform, wire-size, gpu-memory]
date: 2026-04-11
confidence: high
threejs_version: r182
---

## Summary
UASTC KTX2 textures are 4-5x larger than WebP on wire for cartoon/stylised GLB assets. ETC1S is wire-competitive with WebP but has lower visual quality.

## Details

Test results compressing 6 ClawVille GLBs from PNG (post-Draco) using `gltf-transform uastc --level 2 --zstd 18`:

| File | PNG source | WebP | UASTC KTX2 |
|------|---:|---:|---:|
| underwater-decorations.glb | 5.97 MB | 1.08 MB | 4.47 MB |
| pineapple-house.glb | 3.62 MB | 557 KB | 4.42 MB |
| salty-spitoon.glb | 3.21 MB | 388 KB | 3.99 MB |
| lobster.glb | 1.82 MB | 200 KB | 2.06 MB |
| chum-bucket.glb | 1.85 MB | 620 KB | 1.28 MB |

WebP total: ~3.37 MB. UASTC total: ~16.2 MB. UASTC is +381% vs WebP.

ETC1S comparison on 2 files:
- lobster: PNG 1.82MB → ETC1S 319 KB (smaller than WebP's 200 KB by a bit, but close)
- underwater-decorations: PNG 5.97MB → ETC1S 945 KB (smaller than WebP 1.08 MB!)

### Why UASTC is large

UASTC is a GPU block format — each 4×4 texel block encodes to 16 bytes. A 1024×1024 texture = 256×256 blocks = 65,536 blocks × 16 = 1 MB minimum per texture before supercompression. Zstd helps but can't overcome the fundamental floor. WebP's DCT-based codec achieves much higher compression ratios.

### Trade-offs

| Format | Wire size | GPU memory | Visual quality | Main-thread cost |
|--------|-----------|------------|----------------|-----------------|
| PNG | largest | largest (RGBA8) | lossless | Image.decode (sync) |
| WebP | smallest | largest (RGBA8 after decode) | excellent | createImageBitmap (async) |
| ETC1S | WebP-comparable | GPU-compressed | lower (banding) | WASM worker (off-thread) |
| UASTC | 4-5x WebP | GPU-compressed | excellent | WASM worker (off-thread) |

### When to use UASTC

- Assets where GPU memory pressure is the bottleneck (VR, mobile, many textures)
- When wire size is irrelevant (local/LAN serving)
- NOT for web games on metered connections where wire savings matter

### gltf-transform 4.3.0 parse bug

Files with BOTH `KHR_materials_clearcoat` AND `KHR_draco_mesh_compression` crash with:
`error: Cannot read properties of undefined (reading 'source')`

Affected: `characters/spongebob.glb`. Workaround: strip clearcoat before compressing, or wait for gltf-transform 4.4+.

## Context
ClawVille cold-load optimization pass (2026-04-11). User expected "similar wire savings" from KTX2 vs WebP — not true. WebP wins on wire; KTX2 wins on GPU memory. The long-task regression from WebP (513ms→992ms) is likely GPU upload time, not main-thread image decode (GLTFLoader already uses ImageBitmapLoader = off-thread WebP decode on Chrome/Edge).
