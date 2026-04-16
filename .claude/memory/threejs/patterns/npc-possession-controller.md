---
title: NPC possession WASD controller with wander skip
category: pattern
tags: [npc, possession, wasd, zustand, controlMode, wander, circular-dep]
date: 2026-04-09
confidence: medium
threejs_version: r182
---

## Summary
Route WASD to move a possessed NPC in 'npc' controlMode, skipping autonomous wander for that NPC.

## Details

### Component: `npc-controller.tsx`
- Rendered unconditionally inside SceneContents — guards itself with `if (controlMode !== 'npc' || !possessedNpcId) return` inside `useFrame`.
- Module-level key state object (same pattern as player-pet.tsx) — no closure allocations per frame.
- Calls `useNpcStore.getState().moveNpc()` directly (not via hook) — zero React re-render overhead.
- Speed 200 units/sec (matches player-pet.tsx SPEED).
- Direction mapping: w=up (vy=-1), s=down (vy=+1), a=left (vx=-1), d=right (vx=+1) in 2D game-space.
- Idle guard: only writes direction='idle' to store when NPC's current direction !== 'idle', avoiding every-frame state writes.

### Store: `moveNpc(id, x, y, direction)`
Updates `prevX`/`prevY` (for interpolation) + `x`/`y`/`direction` atomically via `set()` + `.map()`.

### Wander skip
`tickDemoNpcs` uses `require('@/stores/game').useGameStore.getState().possessedNpcId` (lazy require — not ES import) to avoid circular module dependency. If the NPC id matches, return npc unchanged.

### Auto-select on mode switch
`setControlMode('npc')` reads `useNpcStore.getState().npcs[0]?.id` via lazy require. Clears `possessedNpcId` to null when switching to any other mode.
`toggleControlMode` now calls `get().setControlMode(next)` so the auto-select logic always runs.

## Context
ClawVille Step 4 of control system redesign. The lazy `require()` pattern is the right solution for two Zustand stores that need to read each other at runtime without creating circular ES module import deps. Both `game.ts` and `npc.ts` use this pattern.
