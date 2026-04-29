---
title: VRM NPC grounding — no +2 baseline offset, no pivotOffsetY
category: pattern
tags: [vrm, npc, grounding, jump, playerAltitude, terrainY, pivotOffsetY, player-pet]
date: 2026-04-25
confidence: high
threejs_version: r170+
---

## Summary

VRMNpcMesh and player-pet VRM branch both ground at `currentTerrainY + bob + jumpY` with
no `+ 2` baseline offset and no `- pivotOffsetY`. GLBNpcMesh needs `+ 2 - pivotOffsetY`;
VRM does not.

## Details

GLBNpcMesh Y formula:
```ts
group.position.y = currentTerrainY.current + 2 + bob + jumpY - pivotOffsetY;
```
- `+ 2`: compensates for VRM spec not applying here — GLB pivots may sit above feet.
- `- pivotOffsetY`: per-species offset = `localMinY * npcScale`; corrects models whose
  pivot is not at the foot contact point.

VRMNpcMesh Y formula:
```ts
group.position.y = currentTerrainY.current + bob + jumpY;
```
- No `+ 2`: VRM spec mandates feet at Y=0 (foot contact point IS the origin).
- No `- pivotOffsetY`: same reason — origin is already at the floor.

Verified against `player-pet.tsx` VRM branch (line 402, 2026-04-25):
```ts
group.position.y = terrainYRef.current + bob
                 + jumpState.heightOffset + jumpState.playerAltitude;
```
No additional constant. Feet sit flush.

## Jump block in VRMNpcMesh

Ported from GLBNpcMesh with the two differences above. `isMoving` is already declared
higher in the same useFrame — do NOT re-declare it. All three of
`isPossessedPlayerNpc`, `airborne`, `jumpY`, `bob` are new locals scoped to this
component's useFrame closure.

```ts
const isPossessedPlayerNpc =
  d.id === PLAYER_NPC_ID &&
  useGameStore.getState().controlMode === 'npc';
const airborne = isPossessedPlayerNpc &&
                 (jumpState.phase !== 'grounded' && jumpState.phase !== 'charging'
               || jumpState.playerAltitude > 0);
const jumpY = isPossessedPlayerNpc
  ? (jumpState.heightOffset + jumpState.playerAltitude)
  : 0;
const bob = (isMoving && !airborne) ? Math.sin(clock.elapsedTime * 4.0 + seed) * 0.6 : 0;
group.position.y = currentTerrainY.current + bob + jumpY;
```

Bob frequency (`* 4.0 + seed`) and amplitude (`* 0.6`) match GLBNpcMesh identically.

## Context

Added 2026-04-25 when porting NPC-mode default avatar from 'lobster' (GLB) to
'milady_official_1' (VRM). VRMNpcMesh had no jumpState integration — jump silently
broke. Fix: port the GLB block, drop the GLB-specific offsets, verify against
player-pet.tsx VRM grounding as the canonical reference.
