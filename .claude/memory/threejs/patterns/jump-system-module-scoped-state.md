---
title: Jump system: module-scoped state + JumpTicker (charge-and-release + 3D swim + quicksink)
category: pattern
tags: [jump, physics, useFrame, module-scoped, zustand-avoidance, keyboard, space, charge, quicksink, swim-altitude, playerAltitude]
date: 2026-04-21
confidence: high
threejs_version: r170+
---

## Summary
Jump physics state lives in a plain module-scoped object (not Zustand). A dedicated `<JumpTicker />` component runs the physics tick mounted FIRST in the scene so all consumers read current-frame state. As of 2026-04-21, the system is charge-and-release with 6 phases (added `quicksink`), camera-tilt 3D swim via `playerAltitude`, and mid-air SPACE quick-sink.

## Details

**Why not Zustand:** per-frame `set()` at 60 Hz re-renders every subscribed component (HUD, minimap, modals). Module-scoped object is read directly by consumers without subscription cost. Mirrors `keyState` in `player-pet.tsx`.

**Why a dedicated component:** R3F runs `useFrame` hooks in mount order. If the tick ran inside `PlayerPet` (mounted last), `FPSFollowCamera` and `GLBNpcMesh` would read stale `heightOffset` from frame N-1 (~4.67 wu visible lag at peak thrust). Hoisting to `<JumpTicker />` mounted first fixes this.

**State object shape (current — charge-and-release + 3D swim, 2026-04-21):**
```ts
export type JumpPhase = 'grounded' | 'charging' | 'quick' | 'launch' | 'sinking' | 'quicksink';
export const jumpState = {
  phase:           'grounded' as JumpPhase,
  vz:              0,          // wu/sec, positive = up
  heightOffset:    0,          // wu above terrain (always >= 0)
  playerAltitude:  0,          // persistent swim altitude (wu, >= 0). Camera-tilt 3D swim.
  holdMs:          0,          // time SPACE continuously held this press
  chargeProgress:  0,          // 0..1 — charge-bar.tsx reads this via RAF
  lastSpaceDown:   false,
  spaceDown:       false,      // written by SPACE listener only
};
export const JUMP_QUICKSINK_VZ = -600; // wu/s constant descent
```

**Phase flow:**
- `grounded` → SPACE press → `charging` (pet stays on ground, no vz)
- `charging` + release before 200ms → `quick` (vz=120, tap jump ~33wu peak)
- `charging` + release at/after 200ms → `launch` (vz = sqrt(vzMinSq + (vzMaxSq-vzMinSq)*t), i.e. vz² interpolated linearly → peak altitude linear in charge progress. Peak range: 31→1531wu. Table: 0%=31wu, 25%=405wu, 50%=781wu, 75%=1156wu, 100%=1531wu)
- `charging` + held 1500ms → auto-launch at `vz=700` (max charge)
- `quick` → vz crosses 0 under QUICK_GRAVITY (-220) → `sinking` (smooth, no apex freeze)
- `launch` → vz crosses 0 under ASCENT_GRAVITY (-160) → `sinking` (smooth, no apex freeze)
- `quick` / `launch` / `sinking` + SPACE rising edge mid-air → `quicksink` (vz=-600, constant drop)
- `quicksink` → heightOffset=0 → `grounded`
- `sinking` → heightOffset=0 → `grounded`

**3D swim (playerAltitude):**
- `_playerCamForward.y = 0` line REMOVED in player-pet.tsx (GLB + VRM) and npc-controller.tsx.
- `worldVy = camForward.y * inputFwd` accumulated into `jumpState.playerAltitude` before XZ normalisation.
- Floor-clamped ≥ 0. No gravity. Persistent when input stops.
- Strafe (A/D) contributes nothing: `camRight.y ≈ 0` by cross-product math.
- Render-Y: `terrainY + 2 + bob + heightOffset + playerAltitude - pivotOffsetY`

**quicksink fires BEFORE switch statement** so it takes priority over all other transitions this frame.

**Key guardrails:**
- `resetJump()` does NOT reset `spaceDown` — physical keyup clears it.
- `keydown` has `isEditable(e.target)` guard — prevents SPACE triggering jump while typing.
- `keyup` has NO guard — must always clear `spaceDown`.
- No peak clamp — JUMP_PEAK_CLAMP removed. Camera lerps to CHAR_TARGET_Y + heightOffset.
- No apex-freeze — vz is allowed to naturally cross 0 under gravity, giving smooth arcs.

**Physics constants (verified 2026-04-21 via simulation):**
- Tap: peak ≈ 33.7 wu (spec 33), airtime ~1.1 s
- Barely charged (201ms): peak ≈ 32.3 wu — 0.31 wu from tap peak, discontinuity eliminated
- Full charge (700 wu/s): peak ≈ 1531 wu (spec ~1531)
- Auto-launch fires at frame ~93 (1488ms at 60fps, within spec 1500ms)
- Sink terminal: -150 wu/s (bumped from -55 to handle ~12s max-peak descents)
- Ascent gravity: -160 wu/s² (lighter than tap -220 to allow the large peak)
- `JUMP_MIN_CHARGED_VZ` = 100 wu/s (lowered from 250 on 2026-04-21 to eliminate 6× step at 200ms boundary)

**'charging' phase is NOT airborne. `playerAltitude > 0` IS airborne.** Consumers:
```ts
const airborne = (jumpState.phase !== 'grounded' && jumpState.phase !== 'charging')
              || jumpState.playerAltitude > 0;
```
This prevents bob suppression while on the ground or charging, but correctly suppresses
it when the pet is swimming above the floor.

**Charge bar UI.** `apps/web/src/components/game/charge-bar.tsx` — RAF loop, direct DOM mutation, zero React state. Reads `jumpState.holdMs` and `jumpState.phase` directly. Color: cyan → white at 95%.

**Idle rotation freeze in player-pet.tsx.** Skip the rotation lerp when `continuousRot === null` (no WASD input) — preserves last moved direction, no +Z snap on release.

**resetJump() wired into 5 game.ts paths:**
- `setControlMode`, `setHasAgent`, `setAgentConnection`, `resetStore`, `enterBuilding`
- Uses `require('@/lib/three/jump-state')` to avoid circular imports.

**FPSFollowCamera** reads `jumpState.heightOffset` each frame and adds it to `CHAR_TARGET_Y` in the lerp target. Camera position is also translated by the same delta each frame (prevTgt subtraction) so orbit geometry (angle, zoom, phi/theta) is preserved during high jumps. Without the camera-position translation, PHI clamps at PHI_MIN=0.1 during jumps above ~500wu and arrow-key rotation glitches. The `_followOffset` scratch vector that previously computed (but never applied) this delta was dead code and has been removed.

**arena-npcs.tsx** gates jump on `d.id === PLAYER_NPC_ID && controlMode === 'npc'` — wandering NPCs never jump.

## Context
Originally shipped 2026-04-17 (two-phase immediate-launch + thrust clamp). Rewritten 2026-04-21 to charge-and-release per user spec: hold SPACE on ground → charge bar → release to launch proportionally. Simulation verified all 3 scenarios pass. TypeScript build clean.

Updated 2026-04-21 (second patch): vz interpolation switched from linear to vz²-linear (square-root of linearly interpolated vz²). Reason: linear vz made peak altitude quadratic in t — at t=0.5, peak was only 46% of max (~706wu vs expected ~863wu midpoint). vz²-linear gives peak exactly linear in charge progress (midpoint=863wu confirmed by throwaway simulation script — all 5 samples within 0.32% of spec). FPSFollowCamera camera-position tracking added to prevent PHI clamp glitch at high jumps.

Updated 2026-04-21 (third patch): camera-tilt 3D swim + mid-air SPACE quicksink. `playerAltitude` field added to jumpState. `JumpPhase` extended with `'quicksink'`. `resetJump()` now resets `playerAltitude`. Verified: 6 simulation tests pass, TypeScript build clean.
