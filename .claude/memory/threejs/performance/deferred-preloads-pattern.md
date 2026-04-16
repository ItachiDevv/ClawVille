---
title: Deferred useGLTF.preload() via requestAnimationFrame
category: performance
tags: [cold-load, preload, useGLTF, drei, suspense, first-paint]
date: 2026-04-11
confidence: high
threejs_version: r170+
---

## Summary
Moving non-critical `useGLTF.preload()` calls out of module-evaluation scope and into a `requestAnimationFrame`-gated `useEffect` defers network requests until after first paint, without triggering Suspense errors.

## Details

**Problem:** Every `useGLTF.preload()` at module top-level fires at the moment the JS module is evaluated (usually during webpack/turbopack chunking, before the Canvas even mounts). This front-loads heavy network requests that compete with first-frame critical assets (buildings, player pet).

**Solution pattern:**

```tsx
// components/DeferredTerrainPreloads.tsx — rendered OUTSIDE the Canvas
import { useEffect, type ReactElement } from 'react';
import { useGLTF } from '@react-three/drei';

export function DeferredTerrainPreloads(): ReactElement | null {
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      useGLTF.preload('/models/coral-reef1.glb');
      // ... more non-critical assets
    });
    return () => cancelAnimationFrame(raf);
  }, []);
  return null;
}
```

**Mount it in the game page HUD layer** (not inside `<Canvas>`). It renders nothing but fires preloads after the first browser paint.

**Suspense safety:** components using `useGLTF(url)` must be inside `<Suspense fallback={null}>`. When the asset isn't cached yet, Suspense throws a Promise — the null fallback absorbs it cleanly. The component renders nothing until the asset resolves, then mounts normally. This is the correct behavior: users see first-frame content (buildings, sand, player) immediately, then decorations/NPCs fade in over the next ~1 second as assets load.

**Key constraint:** `requestAnimationFrame` is required (not just `useEffect` alone) to guarantee the call fires AFTER the browser has committed the first frame to screen. A bare `useEffect` fires synchronously after the commit but before the paint; `rAF` inside `useEffect` fires after paint.

**Measured impact on ClawVille (Intel Iris Xe / Hetzner prod):**
- Moves ~17 GLB preload requests (decoration + 10 NPC characters) out of the critical path
- Reduces concurrent network requests competing with buildings + lobster.glb at t=1132ms

## Context
ClawVille cold-load optimization pass (2026-04-11). Eliminated from the module-level critical path: 16 decoration GLBs + 10 character GLBs (including the 5.94 MB underwater-decorations.glb).
