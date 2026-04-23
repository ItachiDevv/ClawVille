# Two Three.js Instances: NodeMaterial + Plain WebGLRenderer = `.replace()` Crash

**Discovered:** 2026-04-23
**Surface:** `/create-agent` avatar picker (SelectAgentCanvas)
**Symptom:** Per-frame flood of `TypeError: Cannot read properties of undefined (reading 'replace')` at `new WebGLProgram(...)` → `Object.acquireProgram`. Canvas renders black for any scene containing a TSL NodeMaterial.

## Root cause

`three/webgpu` and plain `three` are **two separate pre-bundled copies** of Three.js. The `three` package's `exports` map:
- `.` → `build/three.module.js` (~631 KB, no NodeMaterial knowledge)
- `./webgpu` → `build/three.webgpu.js` (~1.99 MB, contains WebGPURenderer + TSL)

When a file does `import * as THREE from 'three/webgpu'` AND uses any `*NodeMaterial` (`MeshBasicNodeMaterial`, `PointsNodeMaterial`, etc.), those material CLASSES are defined in `three.webgpu.js`. R3F's default Canvas creates a `WebGLRenderer` from **plain three** — a different module instance. Plain `WebGLRenderer` has zero knowledge of NodeMaterial. `NodeMaterial.vertexShader` is `undefined` by design (node system generates shaders at compile time inside the backend). `WebGLPrograms.acquireProgram` reads `material.vertexShader` → `WebGLProgram` constructor calls `.replace()` on `undefined` → crash.

## Why GLB models don't crash

Standard materials (`MeshStandardMaterial`, `MeshBasicMaterial`) are `ShaderMaterial` subclasses with a valid `vertexShader` STRING. Plain `WebGLRenderer` compiles them fine.

## Fix pattern

**Any scene rendered by the default R3F Canvas (WebGLRenderer) MUST import from plain `three` and use plain materials only.** TSL NodeMaterials, `three/webgpu` imports, and `extend(THREE as any)` (which registers node materials into R3F's catalogue) can ONLY coexist with a `WebGPURenderer` scene.

SelectAgentCanvas.tsx is the canonical before/after — see commit around 2026-04-23 that replaced:
- `MeshBasicNodeMaterial` + TSL `colorNode` → `MeshBasicMaterial` with plain props
- `PointsNodeMaterial` + TSL `positionNode/colorNode/opacityNode/sizeNode` → `PointsMaterial`
- Dropped `UnderwaterAtmosphere` + `UnderwaterLightRays` from the picker (both use `three/webgpu` internally, so they're WebGPURenderer-only and unsafe on a WebGL canvas).

## Rule of thumb

Before adding any `import * as THREE from 'three/webgpu'` or `from 'three/tsl'` to a new file, verify the Canvas downstream is a **WebGPURenderer**. If it's the default R3F Canvas (WebGLRenderer), don't use TSL or three/webgpu — use plain three.

Failing this rule produces a silent but continuous per-frame console flood + blank canvas. Easy to miss until a user reports "the 3D preview is empty."

## Related

- `seaweed-meshbasic-webgpu.md` — similar hazard with `three-stdlib` classes not coexisting with three/webgpu.
- `three-stdlib-ktx2loader-webgpu-broken.md` — pattern of three-addons classes failing under the three/webgpu namespace.
- `webgpu-instancedmesh-shadermaterial.md` — Iris Xe WebGPU instability that may matter for Phase 3b (VRM on WebGPURenderer via MToonNodeMaterial).

## References

- 3da audit report 2026-04-23 session (root-cause breakdown of WebGLPrograms.acquireProgram reading `vertexShader = parameters.vertexShader`, then WebGLProgram calling `.replace()` on it).
- Library compat research 2026-04-23: three@0.182.0 also removed `unpackRGBAToDepth()` from ShaderChunk, which separately breaks MToon's WebGL path. That's a **second, independent** root cause affecting /game VRMs under WebGLRenderer.
