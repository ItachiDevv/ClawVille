---
title: useLayoutEffect not useEffect for VRM property mutations — closes 1-frame R3F race
category: gotcha
tags: [vrm, react, useLayoutEffect, useEffect, r3f, frame-race]
date: 2026-04-24
confidence: high
threejs_version: r170+
---

## Summary
Using `useEffect` to null/mutate VRM properties (e.g. `vrm.lookAt`, `vrm.expressionManager`) leaves a 1-frame race window where R3F's `useFrame` loop runs `vrm.update()` BEFORE the mutation fires.

## Details
R3F's frame loop runs inside a `requestAnimationFrame` callback. React's `useEffect` fires after the browser has painted — meaning on the first frame after mount, `vrm.update()` processes `lookAt` and `expressionManager` before the `useEffect` null-assignment has had a chance to run.

`useLayoutEffect` runs synchronously after React commits DOM mutations and BEFORE the browser paints. The R3F frame loop (rAF) is scheduled after the paint, so `useLayoutEffect` fires before any frame can call `vrm.update()`.

```tsx
// WRONG — 1-frame race:
useEffect(() => {
  (vrm as any).lookAt = null;
  (vrm as any).expressionManager = null;
}, [vrm]);

// CORRECT — closes the race:
useLayoutEffect(() => {
  (vrm as any).lookAt = null;
  (vrm as any).expressionManager = null;
}, [vrm]);
```

The dependency array is identical — only the hook name changes.

## Context
Surfaced in Sakura's review of the VRM wanderer PR. Applies to any one-time property mutation on a Three.js object that must be in effect before the first render frame. The `vrm.lookAt` and `vrm.expressionManager` fields have no `dispose()` method in three-vrm 3.5.2 — setting to `null` (not `undefined`) is the correct way to disable them.
