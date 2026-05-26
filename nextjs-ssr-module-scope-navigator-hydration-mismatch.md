---
title: Module-scope navigator/window in statically-imported client components causes React #418
category: gotcha
tags: [nextjs, ssr, hydration, navigator, window, dynamic-import, react-418, FORCE_WEBGL]
date: 2026-05-21
confidence: high
threejs_version: r182
---

## Summary

Any `'use client'` module that evaluates `navigator.userAgent` or `window.*` at module scope (not inside `useEffect`) will produce React error #418 hydration mismatch when statically imported into a Next.js page. Server renders the constant as one value (undefined/false), client evaluates it as another (iOS/non-WebGPU browser), tree diverges, React tears down and rebuilds.

## Details

Next.js server-renders `'use client'` components to produce the initial HTML shell. Module-scope code runs on BOTH server and client. Guards like `typeof navigator !== 'undefined'` return `false` on the server (navigator is undefined), and may return a browser-specific value on the client. Any JSX branch that depends on the module-scope constant produces different output server vs client → React #418.

**The ClawVille instance (2026-05-21):**

```ts
// arena-terrain.tsx — module scope, evaluated on server AND client
const FORCE_WEBGL_TERRAIN =
  (typeof navigator !== 'undefined' && !('gpu' in navigator));

function SandFloor() {
  const sandMat = useMemo(
    () => FORCE_WEBGL_TERRAIN
      ? new THREE.MeshStandardMaterial({ ... })   // plain material — server never hits this
      : createSandMaterial(),                      // TSL NodeMaterial — server always returns this
    [],
  );
  ...
}
```

On server: `FORCE_WEBGL_TERRAIN = false` → `createSandMaterial()` (NodeMaterial).
On client (Chrome without WebGPU): `FORCE_WEBGL_TERRAIN = true` → plain `MeshStandardMaterial`.
React sees a different component tree → #418 → full client re-render → loader resets to 0%.

**Symptom:** "loaded, went to loading screen, then loaded again" — the hydration error triggers a full client-side tree teardown and rebuild.

## Fix

Convert the static import to `dynamic({ ssr: false })`. This prevents the module from running on the server at all. Safe when the component only runs `useEffect` (no meaningful server output):

```ts
// BEFORE (wrong — causes #418):
import { DeferredTerrainPreloads } from '@/lib/three/arena-terrain';

// AFTER (correct — module never runs on server):
const DeferredTerrainPreloads = dynamic(
  () => import('@/lib/three/arena-terrain').then(m => ({ default: m.DeferredTerrainPreloads })),
  { ssr: false, loading: () => null },
);
```

## Rule

Any file that:
1. Has module-scope `navigator.*` / `window.*` / `document.*` usage (even guarded by `typeof X !== 'undefined'`)
2. AND is statically imported (not behind `dynamic({ ssr: false })`) into a Next.js page or layout

...will cause hydration mismatches when the computed value differs between server and client environments. This includes ALL of the Three.js renderer detection constants (`FORCE_WEBGL`, `FORCE_WEBGL_TERRAIN`, `LOW_END_GPU_DETECTED`, `IOS_SAFARI`, `WEBGPU_ABSENT`).

The 3D canvas itself (`World3DCanvas`) is correctly behind `dynamic({ ssr: false })`. The problem occurs when utility modules that CONTAIN the same browser-detection logic are statically imported elsewhere.

## Related

- `webgpurenderer-catch-path-plain-webglrenderer-dual-instance.md` — related renderer fix
- `ios-safari-webgpu-navigator-gpu-undefined.md` — FORCE_WEBGL origin
