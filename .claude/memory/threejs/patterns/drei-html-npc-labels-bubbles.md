---
title: drei <Html> for NPC name labels and speech bubbles
category: pattern
tags: [html, overlay, npc, labels, speech-bubbles, iris-xe, drei]
date: 2026-04-13
confidence: high
threejs_version: r170+
---

## Summary
Use drei `<Html>` for all NPC text overlays (name labels, speech bubbles) — it is DOM-rendered, not GPU-rendered, so it is completely safe on Intel Iris Xe.

## Details

### Name labels (static, attached to character group)
```tsx
import { Html } from '@react-three/drei';

// Inside the NPC group JSX — position relative to group origin
<Html
  position={[0, CHARACTER_HEIGHT + 5, 0]}
  center
  distanceFactor={400}
  style={{ pointerEvents: 'none' }}
  zIndexRange={[10, 100]}
>
  <div style={{
    background: 'rgba(8, 20, 38, 0.78)',
    border: '1px solid rgba(100, 200, 255, 0.25)',
    borderRadius: 6,
    padding: '2px 8px',
    color: '#fff',
    fontWeight: 700,
    fontSize: 11,
    whiteSpace: 'nowrap',
    userSelect: 'none',
  }}>
    {name}
  </div>
</Html>
```

### Speech bubbles (from NPC store chatBubbles, positioned at world coords)
- Read `chatBubbles` and `npcs` from `useNpcStore`
- Build `Map<npcId, NpcSpriteState>` for O(1) lookup
- Position: `worldX = npc.x - HALF_W`, `worldZ = npc.y - HALF_H`, Y = fixed height (20 units)
- Filter `b.expiresAt > Date.now()`, cap at 10 bubbles
- Key on `${npcId}-${expiresAt}` to avoid stale React keys

### distanceFactor tuning
- `400` = building-scale labels (large objects, readable at distance)
- `300` = NPC labels (medium objects)
- Higher distanceFactor = smaller at a given distance

### Arena-location-npcs note
The `CHARACTER_HEIGHT` constant is `20`, and `npcScale` varies per character. The Html `position` is in the group's local space (before npcScale is applied), so `CHARACTER_HEIGHT + 5` in local units will be scaled by npcScale in world space. This means the label appears at the correct scaled height automatically.

### Wandering NPCs (arena-npcs.tsx)
The outer group uses `scale={[NPC_SCALE, NPC_SCALE, NPC_SCALE]}` (NPC_SCALE=8). The label is at `position={[0, 2, 0]}` in local space, which becomes 16 world units above the group origin (which itself sits 2 units above terrain). The label renders above the character's head correctly.

## Context
Implemented 2026-04-13 to add NPC name labels and SSE chat bubble display to the Three.js 3D world. Previously these only showed in PixiJS 2D fallback. The key insight: `<Html>` is a DOM overlay pinned to a 3D position — it never creates GPU geometry, making it the only safe text solution for Iris Xe integrated graphics. Never use drei `<Text>` or `<Billboard>` (both crash Iris Xe hard).
