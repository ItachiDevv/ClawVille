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

## Fix — part 1: always-write, not transition-only

Use a `useRef<HTMLDivElement>(null)` attached to the inner `<div>` inside `<Html>`. In the same `useFrame` cull block that sets `group.visible`, imperatively set `labelRef.current.style.display = 'none'` (and restore to `'flex'` on un-cull). Zero React re-renders — purely imperative DOM mutation.

CRITICAL: write the style on EVERY frame, not just on the `group.visible` transition. Using a transition-only guard (`if (group.visible) {...}`) causes a secondary leak when the component re-renders (see Part 2 below).

```tsx
const labelRef = useRef<HTMLDivElement>(null);

// In useFrame cull block — always write, change-checked for cheapness:
if (camDistSq > NPC_CULL_DIST_SQ) {
  group.visible = false;
  const label = labelRef.current;
  if (label && label.style.display !== 'none') label.style.display = 'none';
  return;
}
group.visible = true;
{
  const label = labelRef.current;
  if (label && label.style.display !== 'flex') label.style.display = 'flex';
}
```

## Fix — part 2: JSX default must be `display: 'none'`

The `<div>` JSX default style must be `display: 'none'`, not `display: 'flex'`. Reason: if the component uses `memo()` and the prop object reference changes (e.g. because Zustand rebuilds the NPC array on every SSE snapshot), React re-renders the label div and re-applies the inline JSX style — overwriting whatever `useFrame` wrote. If the JSX default is `'flex'`, a re-render during culling restores visibility, and the transition-only guard then skips re-hiding because `group.visible` is already false. This is exactly the "ghost label" bug.

```tsx
<Html position={[0, 100, 0]} center ...>
  <div ref={labelRef} style={{ display: 'none', alignItems: 'center', ... }}>
    {npc.name}
  </div>
</Html>
```

`useFrame` is the single source of truth — it opens the label when the NPC enters range, closes it when it exits. The JSX default should be hidden so both first-mount and re-renders start from a safe state.

## Context
Part 1 discovered 2026-04-23 as a visual regression: wandering NPC name labels floated over empty world positions with no avatar mesh beneath them. Part 2 discovered 2026-04-23 follow-up: the transition-only guard left ghost labels after every SSE snapshot re-render of `memo()`-wrapped NPC components. Both fixes applied to `GLBNpcMesh` and `VRMNpcMesh` in `arena-npcs.tsx`. Same pattern applies to ANY drei `<Html>` inside a culled group rendered by a memo-wrapped component.
