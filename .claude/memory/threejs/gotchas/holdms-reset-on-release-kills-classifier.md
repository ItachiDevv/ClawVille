---
title: holdMs zeroed on release makes charge-release classifier always read 0
category: gotcha
tags: [jump, input, holdMs, charging, release, state-machine, player-pet]
date: 2026-04-21
confidence: high
threejs_version: r170+
---

## Summary
If you reset `holdMs = 0` in the same expression that handles both held and released states
(`holdMs = spaceDown ? holdMs + dt*1000 : 0`), then on the frame SPACE is released,
`spaceDown` is already `false` — so `holdMs` is zeroed BEFORE any downstream code reads it.
The release-classifier's `if (holdMs < THRESHOLD)` is always true (0 < any threshold),
making the quick-tap branch fire unconditionally and the scaled-launch branch unreachable.

## Details

### The broken pattern
```ts
// WRONG — zeroes holdMs in the same frame as release
jumpState.holdMs = spaceDown ? jumpState.holdMs + dt * 1000 : 0;
const risingEdge = spaceDown && !jumpState.lastSpaceDown;
jumpState.lastSpaceDown = spaceDown;

case 'charging':
  if (!spaceDown) {
    // holdMs is ALWAYS 0 here — the ternary above just zeroed it
    if (jumpState.holdMs < THRESHOLD) { /* always fires */ }
    else { /* never reached */ }
  }
```

### The fix
Accumulate only while held; reset on the NEW PRESS (not on release):
```ts
// CORRECT
const risingEdge = spaceDown && !jumpState.lastSpaceDown;
jumpState.lastSpaceDown = spaceDown;
if (spaceDown) jumpState.holdMs += dt * 1000; // accumulate while held; never zero on release

case 'grounded':
  if (risingEdge) {
    jumpState.phase = 'charging';
    jumpState.vz = 0;
    jumpState.holdMs = 0; // reset here, on the new press
  }
```

On the release frame: `spaceDown=false` → the `if (spaceDown)` guard skips the increment.
`holdMs` retains the accumulated value from the previous held frames.
The release-classifier then reads the correct accumulated `holdMs`.

### Why this is subtle
- The order of operations matters: if `holdMs` reset precedes the classifier read in the
  same function call, the classifier always sees 0.
- The fix moves the reset to a different frame (the next press frame), making accumulation
  and reset temporally disjoint.
- `resetJump()` (called on mode transitions) still resets holdMs to 0 — that's correct and
  separate from the per-frame accumulation logic.

## Context
ClawVille `jump-state.ts`. Discovered 2026-04-21 as the root cause of "partial charge gives
same height as tap." Verified via simulation script: 500ms hold fired `quick` path (vz=120)
instead of `launch` path (vz≈338) before fix; all 4 test cases pass after fix.
