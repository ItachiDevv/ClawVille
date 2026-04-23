---
title: drei Html DOM portal ignores parent group.visible — labels float over empty space
category: gotcha
tags: [drei, Html, DOM portal, visibility, culling, LOD, NPC labels]
date: 2026-04-23
confidence: high
threejs_version: r170+
---

## Summary
Setting `group.visible = false` in a Three.js scene does NOT hide DOM elements rendered by drei's `<Html>` component. Labels float over empty world space while the 3D mesh is invisible.

## Details
drei `<Html>` uses a React DOM portal that attaches a `<div>` to the canvas parent element outside the Three.js scene graph. The Three.js `Object3D.visible` flag controls whether the WebGL renderer skips the subtree — it does not affect the DOM portal at all.

The drei Html `useFrame` only hides the DOM when the `occlude` prop is used and the anchor point is behind an occluder mesh. Without `occlude`, the DOM div stays `display: block` regardless of parent visibility.

**Root cause in ClawVille:** `arena-npcs.tsx` distance-LOD culled NPC groups with `group.visible = false` when `camDistSq > 1200² wu`. All 10 building-ring NPCs live at ~2176wu from world center — beyond the cull threshold at startup. Their 3D meshes disappeared but their `<Html>` name labels persisted as floating text over empty map positions.

## Fix
Use a `useRef<HTMLDivElement>(null)` attached to the inner `<div>` inside `<Html>`. In the same `useFrame` cull block that sets `group.visible`, imperatively set `labelRef.current.style.display = 'none'` (and restore to `'flex'` on un-cull). Zero React re-renders — purely imperative DOM mutation.

```tsx
const labelRef = useRef<HTMLDivElement>(null);

// In useFrame cull block:
if (camDistSq > NPC_CULL_DIST_SQ) {
  if (group.visible) {
    group.visible = false;
    if (labelRef.current) labelRef.current.style.display = 'none';
  }
  return;
}
if (!group.visible) {
  group.visible = true;
  if (labelRef.current) labelRef.current.style.display = 'flex';
}

// In JSX:
<Html position={[0, 100, 0]} center ...>
  <div ref={labelRef} style={{ display: 'flex', ... }}>
    {npc.name}
  </div>
</Html>
```

## Context
Discovered 2026-04-23 as a visual regression: wandering NPC name labels (Crusty, Pebbles, Marlin, etc.) floated over empty world positions with no avatar mesh beneath them. The fix was applied to both `GLBNpcMesh` and `VRMNpcMesh` in `arena-npcs.tsx`. Same pattern applies to ANY drei `<Html>` component inside a visibility-toggled group.
