---
title: Zustand re-render storm — three-part fix (B5 + B6 + B7)
category: performance
tags: [zustand, react, re-render, useShallow, petPosition, NPC, memo, SSE, minimap]
date: 2026-04-24
confidence: high
threejs_version: r170+
---

## Summary
Three independent sources of React re-render storms in ClawVille, each with a targeted fix.

## Details

### B5 — useShallow on array-returning selectors
Any `useNpcStore((s) => s.npcs.filter(...).map(...))` returns a new array reference on every
store update, defeating shallow equality. Fix: `useShallow` from `zustand/react/shallow` wraps
the selector and does element-by-element comparison.

Also applies to multi-field object selectors where multiple store slices are needed:
```ts
// Before: three subscriptions, each re-renders independently
const npcs = useNpcStore((s) => s.npcs);
const combatLog = useNpcStore((s) => s.combatLog);
const connected = useNpcStore((s) => s.connected);

// After: one subscription, useShallow compares fields by value
const { npcs, combatLog, connected } = useNpcStore(
  useShallow((s) => ({ npcs: s.npcs, combatLog: s.combatLog, connected: s.connected }))
);
```

Direct array slice selectors (no transform) also benefit when paired with B7:
```ts
const allNpcs = useNpcStore(useShallow((s) => s.npcs));
```

### B6 — petPosition module ref + 10Hz throttled reactive write
`setPetPosition` was called 60Hz from `useFrame`, firing all React subscribers
(Minimap SVG rebuilds 60×/sec while walking). Fix: export a mutable module-scope ref
and throttle the reactive write to 10Hz.

```ts
// stores/game.ts
export const petPositionRef: { x: number; y: number } = { x: 2560, y: 2940 };
let lastReactiveWriteAt = 0;

setPetPosition: (x, y) => {
  petPositionRef.x = x;
  petPositionRef.y = y;
  const now = performance.now();
  if (now - lastReactiveWriteAt >= 100) {
    lastReactiveWriteAt = now;
    set({ petPosition: { x, y } });
  }
},
```

Per-frame consumers (player-pet.tsx, use-game-loop.ts, camera follow, MinimapPositionTracker
diff-check) switched to `petPositionRef` reads — zero React overhead, always current at 60Hz.
Reactive subscribers (Minimap) continue using the zustand field, now at ≤10Hz.

### B7 — NPC object identity preservation in updateFromSnapshot
`updateFromSnapshot` was rebuilding every NPC object every SSE tick (~10Hz), even for unchanged
NPCs. New object references broke `React.memo` bailout in `GLBNpcMesh`/`VRMNpcMesh`.

Fix: build the candidate object, then compare every flat field against `prev` with `Object.is`.
If equal, return `prev` (same reference). `npcFieldsEqual()` covers 18 fields + inventory array.

```ts
const candidate: NpcSpriteState = { ...built from snapshot... };
if (prev && npcFieldsEqual(prev, candidate)) {
  return prev; // preserve reference — React.memo sees no prop change
}
return candidate;
```

## Context
ClawVille had two re-render storms:
1. 60Hz: movement → `setPetPosition` → Minimap SVG rebuild every frame
2. 10Hz: SSE NPC snapshot → `updateFromSnapshot` → every NpcMesh re-renders

B5+B7 together eliminate the SSE storm. B6 eliminates the movement storm.
Filed as Pod 1 performance work (branch `pod1-zustand-wins`, commit `2419909`).
