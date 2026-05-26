---
title: WorldLabelsOverlay — single DOM overlay replaces 30+ drei Html portals
category: pattern
tags: [performance, dom, labels, npc, buildings, speech-bubbles, overlay]
date: 2026-05-09
confidence: high
threejs_version: r182
---

## Summary
One DOM overlay + one rAF projection pass replaces per-NPC/per-building drei `<Html>` portals. Eliminates ~30 React reconciler trees and ~30 per-frame CSS layout invalidations.

## Details

### Architecture
- `world-labels-overlay.tsx` — new file at `apps/web/src/lib/three/`
- Module-scope `Map<string, LabelEntry>` registry — no React state
- Module-scope `Vector3` scratch — zero per-frame allocations
- Single `useFrame` in `WorldLabelsOverlayMount`: one `getBoundingClientRect()` call, one `project(camera)` per label, one `transform` write when NDC moved ≥ 0.5px
- Behind-camera: NDC z > 1 → `display:none` (replaces manual `viewZ < 0` check)

### Consumer API

```tsx
// Hook — register a label
const { divRef, setVisible } = useWorldLabel({
  id: 'unique-stable-string',
  anchorRef: groupRef,           // RefObject<THREE.Object3D | null>
  offset: [0, 100, 0],          // world-unit offset from anchor
  initialVisible: false,         // true for always-on labels
});

// Portal — renders content into overlay
<WorldLabel divRef={divRef}>
  <div style={{ display: 'flex', ... }}>...</div>
</WorldLabel>

// Mount — add once in SceneContents (World3DCanvas.tsx)
<WorldLabelsOverlayMount />
```

### Key constraints
- Inner content div: do NOT set `display:'none'` on it — the overlay controls visibility on the OUTER `divRef` div
- For always-visible labels: `initialVisible: true`, never call `setVisible`
- For distance-culled labels: `initialVisible: false`, call `setVisible(bool)` in useFrame
- `pointerEvents='auto'` on `<WorldLabel>` for interactive labels (building click targets)

### Migration pattern for NPC cull logic
Old:
```tsx
const label = labelRef.current;
if (shouldHide) {
  if (label && label.style.display !== 'none') label.style.display = 'none';
} else {
  if (label && label.style.display !== 'flex') label.style.display = 'flex';
}
```
New:
```tsx
setLabelVisible(shouldShow);
```

### Files migrated (2026-05-09, commit f54331d)
- `arena-npcs.tsx` — GLBNpcMesh + VRMNpcMesh (initialVisible:false, setVisible in useFrame cull block)
- `arena-buildings.tsx` — GLBBuilding (initialVisible:true, pointerEvents='auto', no useFrame needed)
- `arena-location-npcs.tsx` — NpcMesh (initialVisible:showLabel, no useFrame needed)
- `npc-speech-bubbles.tsx` — SpeechBubble (groupRef added to position group; overlay NDC z>1 replaces viewZ calc)
- `World3DCanvas.tsx` — `<WorldLabelsOverlayMount />` added to SceneContents after `<JumpTicker />`

### Gotcha: overlay node readiness
`_overlayNode` is set in `useEffect` (after paint). `WorldLabel` calls `useOverlayReady()` which subscribes to `_overlayReadyListeners` so it re-renders when the overlay is ready. Labels render nothing on first frame (safe — no flash).

### Gotcha: EditableBuilding (edit-mode dev tool)
`EditableBuilding` still uses drei `<Html>` directly — it's gated behind `?edit=1` and out of scope. The `Html` import stays in `arena-buildings.tsx` for that component.

## Context
FPS optimization plan item #1. drei `<Html>` creates one DOM portal + one CSS transform write per frame per instance; 30+ instances = 30 reconciler trees. One overlay + one rAF projection pass is a 30x reduction in label-related DOM work per frame.
