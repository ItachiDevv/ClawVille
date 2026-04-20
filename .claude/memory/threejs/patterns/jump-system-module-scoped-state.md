---
title: Module-scoped jump state + dedicated JumpTicker component
category: pattern
tags: [jump, physics, useFrame, module-scoped, zustand-avoidance, keyboard, space]
date: 2026-04-17
confidence: high
threejs_version: r170+
---

## Summary
Jump physics state lives in a plain module-scoped object (not Zustand). A dedicated `<JumpTicker />` component runs the physics tick mounted FIRST in the scene so all consumers read current-frame state.

## Details

**Why not Zustand:** per-frame `set()` at 60 Hz re-renders every subscribed component (HUD, minimap, modals). Module-scoped object is read directly by consumers without subscription cost. Mirrors `keyState` in `player-pet.tsx`.

**Why a dedicated component:** R3F runs `useFrame` hooks in mount order. If the tick ran inside `PlayerPet` (mounted last), `FPSFollowCamera` and `GLBNpcMesh` would read stale `heightOffset` from frame N-1 (~4.67 wu visible lag at peak thrust). Hoisting to `<JumpTicker />` mounted first fixes this.

**State object shape:**
```ts
export const jumpState = {
  phase: 'grounded' as JumpPhase,  // 'grounded' | 'quick' | 'thrusting' | 'sinking'
  vz: 0,           // wu/sec, positive = up
  heightOffset: 0, // wu above terrain (always >= 0)
  holdMs: 0,
  thrustActivated: false,
  lastSpaceDown: false,
  spaceDown: false, // written by SPACE listener only
};
```

**Key guardrails:**
- `resetJump()` does NOT reset `spaceDown` — if user holds SPACE across mode transition, the listener's next keyup clears it. Resetting in resetJump would desync.
- `keydown` has `isEditable(e.target)` guard — prevents SPACE triggering jump while typing in chat.
- `keyup` has NO guard — must always clear `spaceDown` so it doesn't get stranded.
- Peak clamp (`JUMP_PEAK_CLAMP=140`) keeps avatar below y=150 caustic atmosphere plane.
- Apex-freeze on `thrusting→sinking`: `vz=0` (not preserved) — preserving +280 would overshoot 871 wu past clamp.

**Physics constants (verified 2026-04-17):**
- Tap: peak ≈ 33.69 wu (spec 33), airtime ≈ 1.10 s (spec 1.09)
- Hold: peak clamped at ~141.53 wu (1 DT overshoot from discrete integration, fires correctly)
- Sink terminal: -55 wu/s, gravity -45 wu/s², descent ≈ 3.15 s

**resetJump() wired into 5 game.ts paths:**
- `setControlMode`, `setHasAgent`, `setAgentConnection`, `resetStore`, `enterBuilding`
- Uses `require('@/lib/three/jump-state')` to avoid circular imports (same pattern as npc store require at line 275)

**FPSFollowCamera** reads `jumpState.heightOffset` each frame and adds it to `CHAR_TARGET_Y` in the lerp target so the avatar stays on-screen during power jumps.

**arena-npcs.tsx** gates jump on `d.id === PLAYER_NPC_ID && controlMode === 'npc'` — wandering NPCs never jump.

## Context
Shipped 2026-04-17 as part of the SPACE jump system (§17 GameFeatures.md, §3 3dStructure.md). Three-round audit completed before implementation.
