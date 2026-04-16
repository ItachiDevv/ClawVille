---
title: Staggered GPU texture uploads via renderer.initTexture() to prevent post-mount long task
category: performance
tags: [texture-upload, initTexture, long-task, webp, gpu, iris-xe, rAF, WebGPURenderer, WebGLRenderer]
date: 2026-04-11
confidence: high
threejs_version: r170+ (WebGL), r182+ (WebGPU)
---

## Summary
After WebP texture compression, uploading all decoded RGBA8 textures to the GPU in one frame causes a 400ms+ long task on Iris Xe. `renderer.initTexture(tex)` can be called per-frame (N textures/rAF) to spread the cost.

## Details

### The problem
WebP textures are decoded CPU-side before GPU upload. With 20-30 textures in a scene, the batch upload block is 400-900ms on Iris Xe (regression vs uncompressed PNG because decode+upload costs more than upload alone).

### The API

`renderer.initTexture(texture)` — **synchronous**, exists on both renderers:
- **WebGLRenderer r170+**: `this.initTexture = function(texture)` (line 31660 in three.module.js)
- **WebGPURenderer r182+**: `initTexture(texture) { this._textures.updateTexture(texture); }` (line 59758)

`initTextureAsync()` was deprecated in r181 in favour of the synchronous `initTexture()`. Always call the sync version.

```tsx
// Safe guard — check before calling
if (typeof (gl as any).initTexture !== 'function') return;
(gl as any).initTexture(texture);
```

### Collection pattern
Walk scene with `scene.traverse`, check `obj instanceof THREE.Mesh`, collect all material texture slots:
```ts
const TEXTURE_SLOTS = ['map','normalMap','roughnessMap','metalnessMap','aoMap',
  'emissiveMap','lightMap','envMap','alphaMap','bumpMap','displacementMap',
  'clearcoatMap','clearcoatNormalMap','clearcoatRoughnessMap',
  'sheenColorMap','sheenRoughnessMap','transmissionMap','thicknessMap',
  'specularMap','specularColorMap'];
```
Deduplicate with a `Set<THREE.Texture>`. Same texture object can be referenced by many meshes.

### Timing
- Fire **2 rAF ticks after mount** (let compileAsync start first)
- **BATCH_SIZE = 2** textures/frame on Iris Xe (~4-8ms per WebP texture upload = ~8-16ms/frame)
- If any batch exceeds 20ms, warn and reduce BATCH_SIZE

### Full component (ClawVille pattern)
```tsx
const TEXTURE_UPLOAD_BATCH = 2;

function StaggeredTextureUpload() {
  const { gl, scene } = useThree();
  useEffect(() => {
    if (typeof (gl as any).initTexture !== 'function') return;

    let outerRaf: number, innerRaf: number;
    outerRaf = requestAnimationFrame(() => {
      innerRaf = requestAnimationFrame(() => {
        const seen = new Set<THREE.Texture>();
        scene.traverse((obj) => {
          if (!(obj instanceof THREE.Mesh)) return;
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const mat of mats) {
            for (const slot of TEXTURE_SLOTS) {
              const tex = (mat as any)[slot];
              if (tex instanceof THREE.Texture && !seen.has(tex)) seen.add(tex);
            }
          }
        });
        const unique = Array.from(seen);
        let i = 0, uploadRaf: number;
        function uploadBatch() {
          const end = Math.min(i + TEXTURE_UPLOAD_BATCH, unique.length);
          for (; i < end; i++) {
            try { (gl as any).initTexture(unique[i]); } catch {}
          }
          if (i < unique.length) uploadRaf = requestAnimationFrame(uploadBatch);
        }
        uploadRaf = requestAnimationFrame(uploadBatch);
      });
    });
    return () => { cancelAnimationFrame(outerRaf); cancelAnimationFrame(innerRaf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
```

## Context
ClawVille cold-load optimization pass 2 (2026-04-11). After WebP compression reduced wire size 83%, the post-mount long task jumped from 225ms (post-Draco) to 417ms because WebP decode+upload is more expensive than raw PNG upload. StaggeredTextureUpload component added to World3DCanvas alongside PreCompilePipelines to spread this cost.
