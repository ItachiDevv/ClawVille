---
title: KTX2Loader wiring for drei useGLTF with WebGPU support
category: pattern
tags: [ktx2, drei, useGLTF, KTX2Loader, WebGPURenderer, extendLoader, basis, transcoder]
date: 2026-04-11
confidence: high
threejs_version: r182
---

## Summary
Wire KTX2Loader into drei's `useGLTF` pipeline via a module-level singleton + Canvas component + `extendLoader` callback. Three.js r182 handles WebGPU format detection natively.

## Details

### Files structure

```
apps/web/public/basis/
  basis_transcoder.js    # copy from three/examples/jsm/libs/basis/
  basis_transcoder.wasm  # copy from three/examples/jsm/libs/basis/

apps/web/src/lib/three/
  ktx2-loader-setup.tsx  # singleton + KTX2LoaderSetup Canvas component
  use-gltf-ktx2.ts       # useGLTFWithKTX2 wrapper
```

### ktx2-loader-setup.tsx (key parts)

```tsx
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';  // NOT three-stdlib!
import type { GLTFLoader } from 'three-stdlib';

let _ktx2Loader: KTX2Loader | null = null;

export function extendLoaderWithKTX2(loader: GLTFLoader): void {
  if (_ktx2Loader) loader.setKTX2Loader(_ktx2Loader as any);  // as any: nominal type mismatch
}

export function KTX2LoaderSetup(): ReactNode {
  const { gl } = useThree();
  useEffect(() => {
    if (_ktx2Loader) return;
    const loader = new KTX2Loader();
    loader.setTranscoderPath('/basis/');
    loader.detectSupport(gl as any);  // handles WebGPURenderer via hasFeature()
    _ktx2Loader = loader;
  }, []);  // gl is stable — intentionally omitted
  return null;
}
```

### World3DCanvas.tsx wiring

```tsx
import { KTX2LoaderSetup } from '@/lib/three/ktx2-loader-setup';

// Inside SceneContents, before any GLB-loading children:
<PreCompilePipelines />
<KTX2LoaderSetup />
```

### useGLTFWithKTX2 usage

```tsx
import { useGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';

// Only for GLBs with KHR_texture_basisu (KTX2) textures:
const { scene } = useGLTFWithKTX2('/models/mymodel.glb');
```

### Transcoder WASM hosting

Copy from `node_modules/three/examples/jsm/libs/basis/`:
- `basis_transcoder.js` — JS wrapper (~57 KB)
- `basis_transcoder.wasm` — WASM transcoder (~527 KB)

Serve from `/basis/` (Next.js public folder). No headers config needed.

### detectSupport() WebGPU gotcha

three/addons KTX2Loader r182 checks `renderer.isWebGPURenderer === true` → uses `renderer.hasFeature('texture-compression-bc')` for BC7 on Iris Xe. three-stdlib's KTX2Loader (2.36.1) only has `renderer.extensions.has()` → crashes on WebGPU.

### dei useGLTF extendLoader timing

R3F's `useLoader` caches loader by class in `memoizedLoaders` (Map). The `extendLoader` callback is called on every `useLoader` invocation for that path (not once globally). Since `setKTX2Loader` stores the value on the GLTFLoader instance, setting it once means subsequent loads without extendLoader still have it set — but to be safe, always pass extendLoader to any KTX2-textured GLB load.

## Context
ClawVille cold-load optimization pass (2026-04-11). KTX2Loader is wired for future KTX2-compressed assets; the current 6 texture-heavy GLBs remain WebP-compressed because UASTC wire size is 4-5x larger.
