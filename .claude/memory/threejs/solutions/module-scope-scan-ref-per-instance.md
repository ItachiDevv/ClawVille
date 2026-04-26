---
title: Module-scope sequential scan ref — move to useRef for per-instance isolation
category: solution
tags: [ref, useRef, module-scope, shared-state, ghost, reef-race, scan-index]
date: 2026-04-26
confidence: high
threejs_version: r170+
---

## Summary

A module-scope `_scan = { lastFrameIdx, lastPathRef }` shared across all component instances corrupts multi-instance state. Move it into a `useRef` inside the component and pass it as a parameter to the helper function.

## Details

**Symptom:** `GhostInner` had a module-scope cursor for an O(1) amortised sequential scan:

```ts
// WRONG — shared across all instances
const _scan = { lastFrameIdx: 0, lastPathRef: null as GhostFrame[] | null };

function findGhostFrames(path, nowMs) {
  if (_scan.lastPathRef !== path) { _scan.lastPathRef = path; _scan.lastFrameIdx = 0; }
  // ... mutates _scan.lastFrameIdx
}
```

If two `GhostInner` mounts exist simultaneously (race remount, Suspense fallback re-render, fast navigation), `_scan.lastFrameIdx` from instance A gets read as the starting cursor for instance B — causing it to scan from the wrong position, returning stale or impossible frame brackets, producing ghost teleports or incorrect fade timing.

**Fix:** Define a `ScanState` interface, put the initial value in a `useRef` inside the component, and pass `scanRef.current` into the helper:

```ts
interface ScanState {
  lastFrameIdx: number;
  lastPathRef: GhostFrame[] | null;
}

function findGhostFrames(
  scan: ScanState,   // <-- per-instance, passed by the caller
  path: GhostFrame[],
  nowMs: number,
): { a: GhostFrame; b: GhostFrame; alpha: number } | null {
  if (scan.lastPathRef !== path) {
    scan.lastPathRef  = path;
    scan.lastFrameIdx = 0;
  }
  // ... mutates scan.lastFrameIdx only
}

function GhostInner({ path, raceStartMs }: GhostInnerProps) {
  const scanRef = useRef<ScanState>({ lastFrameIdx: 0, lastPathRef: null });

  useFrame(() => {
    const frames = findGhostFrames(scanRef.current, path, ghostMs);
    // ...
  });
}
```

The identity check `scan.lastPathRef !== path` still works exactly as before — it just reads from `scanRef.current` instead of the shared module constant.

**Key insight:** Any mutable cursor / accumulator that belongs to a single component lifecycle MUST live in a `useRef`, not at module scope. Module scope = process-global = shared across every mounted instance of the component.

## Context

Caught in a ReefRaceGhost.tsx audit 2026-04-26. At most one ghost is mounted in normal operation, so the bug was latent. It would surface on race remount (key change on the Canvas triggers unmount+remount), Suspense boundary re-suspension, or if spec ever allows multiple ghosts.

The pattern is reusable: any O(1) sequential scan state for a ring buffer or sorted list should follow this shape.
