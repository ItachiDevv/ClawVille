---
title: MToonNodeMaterial + WebGPURenderer wiring for @pixiv/three-vrm 3.5.x
category: pattern
tags: [vrm, mtoon, webgpu, nodematerial, tsl, pixiv, three-vrm, materials]
date: 2026-04-23
confidence: high
threejs_version: r181+
---

## Summary

`@pixiv/three-vrm`'s default `MToonMaterial` is a plain GLSL ShaderMaterial that breaks silently on three 0.181+. The fix is to use `MToonNodeMaterial` (TSL-based) which is the library's official supported path for three 0.181+ and WebGPURenderer.

## Details

### Why regular MToon broke on three 0.181+

`MToonMaterial` extends Three.js `ShaderMaterial` with hard-coded GLSL. Starting around three 0.172–0.175, WebGPURenderer's internals changed enough that `MToonMaterial` either fails to compile or produces blank meshes. By three 0.181 (ClawVille's pinned version), VRMs loaded with the default loader produce blank canvases on `/game` and T-pose VRMs on routes using plain WebGLRenderer.

### Correct wiring — WebGPURenderer path

```ts
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { MToonMaterialLoaderPlugin } from '@pixiv/three-vrm-materials-mtoon';
import { MToonNodeMaterial } from '@pixiv/three-vrm/nodes';

const loader = new GLTFLoader();
loader.register((parser) =>
  new VRMLoaderPlugin(parser, {
    mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(parser, {
      materialType: MToonNodeMaterial,
    }),
  }),
);
```

**Key option names (confirmed from installed types):**
- `VRMLoaderPlugin` constructor option: `mtoonMaterialPlugin` (type: `MToonMaterialLoaderPlugin`)
- `MToonMaterialLoaderPlugin` constructor option: `materialType` (type: `typeof THREE.Material`)
- `MToonNodeMaterial` is NOT the same as `MToonMaterial` — it is in the `/nodes` subpath

### Import path resolution

`@pixiv/three-vrm` version 3.5.2 has a `./nodes` export that re-exports `MToonNodeMaterial`:

```ts
// Works — @pixiv/three-vrm has the `./nodes` export key in package.json
import { MToonNodeMaterial } from '@pixiv/three-vrm/nodes';

// Also works (more explicit) — requires @pixiv/three-vrm-materials-mtoon as direct dep
import { MToonNodeMaterial } from '@pixiv/three-vrm-materials-mtoon/nodes';
```

`MToonMaterialLoaderPlugin` is in the MAIN (non-nodes) subpath:

```ts
// Correct — main subpath
import { MToonMaterialLoaderPlugin } from '@pixiv/three-vrm-materials-mtoon';

// WRONG — nodes subpath only exports MToonNodeMaterial, NOT the loader plugin
import { MToonMaterialLoaderPlugin } from '@pixiv/three-vrm-materials-mtoon/nodes'; // NOT THERE
```

### Package dependency

`@pixiv/three-vrm-materials-mtoon` is a transitive dep of `@pixiv/three-vrm` but bun does NOT hoist it as a direct import target. You MUST add it as a direct dep:

```json
// apps/web/package.json
{
  "dependencies": {
    "@pixiv/three-vrm": "^3.5.2",
    "@pixiv/three-vrm-materials-mtoon": "^3.5.2"
  }
}
```

### MToonNodeMaterial is WebGPU-only — WebGL canvas fallback strategy

`MToonNodeMaterial` uses TSL (Three.js Shading Language). It compiles to:
- **WebGPU**: WGSL — works natively
- **WebGPURenderer with WebGL2 backend**: GLSL (TSL → GLSL transpiler built in) — works
- **Plain WebGLRenderer** (standard R3F Canvas default): NO TSL transpiler — does NOT work

**ClawVille's two canvases:**
- `World3DCanvas` (WebGPURenderer via `createWebGPURenderer` → `renderer.init()`) — MToonNodeMaterial works
- `SelectAgentCanvas` (plain WebGL R3F Canvas with `preserveDrawingBuffer` for toDataURL thumbnails) — MToonNodeMaterial does NOT work

**Fallback strategy for plain WebGL canvases:** display the VRM's `entry.preview` PNG on a `MeshBasicMaterial` + `PlaneGeometry(18, 28)` billboard inside the rotating platform group. Do NOT download the VRM binary on WebGL canvases at all.

```tsx
// Plain WebGL fallback — PNG billboard via useLoader
function VRMPreviewBillboard({ previewUrl }: { previewUrl: string }) {
  const texture = useLoader(TextureLoader, previewUrl);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.01,
    side: THREE.DoubleSide,
    depthWrite: false,
  }), [texture]);
  return (
    <mesh position={[0, 15, 0]} material={mat}>
      <planeGeometry args={[18, 28]} />
    </mesh>
  );
}
```

## Context

This pattern was implemented in ClawVille Phase 3b (2026-04-23) to fix:
- Blank canvas on `/create-agent` (SelectAgentCanvas — VRM loaded but MToon couldn't render under WebGL)
- T-pose VRMs and 1 FPS on `/game` (World3DCanvas — MToon shader compilation failures causing per-frame retries)

Files changed:
- `apps/web/src/lib/three/vrm-loader.ts` — added MToonNodeMaterial wiring
- `apps/web/src/components/three/SelectAgentCanvas.tsx` — removed VRM load, added PNG billboard
- `apps/web/package.json` — added `@pixiv/three-vrm-materials-mtoon` direct dep
