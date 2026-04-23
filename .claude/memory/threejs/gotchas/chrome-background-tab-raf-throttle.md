---
title: Chrome throttles RAF to ~1fps in background tabs — misleads CDP bone probes
category: gotcha
tags: [cdp, animation, debug, requestAnimationFrame, visibility, three-vrm]
date: 2026-04-23
confidence: high
threejs_version: r170+
---

## Summary
When the Chrome game tab is hidden (backgrounded), `requestAnimationFrame` throttles to ~1fps. CDP bone probes over 2-4s intervals will show the same quaternion value even if the animation IS running correctly.

## Details

### The misleading pattern
CDP probe at T=0: `hips.quaternion = (-0.023842, -0.010628, -0.014791, 0.999550)`
CDP probe at T=2s: `hips.quaternion = (-0.023842, -0.010628, -0.014791, 0.999550)` — unchanged!
CDP probe at T=4s: same — unchanged!

Conclusion: "animation is broken" — WRONG. The tab is just backgrounded.

### How to detect it
```javascript
// In CDP eval — check visibility
JSON.stringify({hidden: document.hidden, visibilityState: document.visibilityState})

// Or: count RAF frames over 3s (should be ~180 at 60fps if foregrounded)
// background tab gives ~3 frames in 3s (1fps throttle)
```

### The actual behavior
- Background tab: RAF runs at 1fps. AnimationMixer.update() only advances by 1 delta per second. Bones ARE moving, just slowly.
- Foreground tab: RAF runs at 60fps. Full animation.

### How to verify animation IS working (despite background throttle)
1. Check `document.hidden === false` — if true, bring tab to foreground first
2. Look for non-identity bone quaternions (84/126 non-identity = animation poses loaded)
3. Check `console.warn` for retarget failures — 0 warnings = retarget succeeded
4. Take a screenshot — the frozen CDP probe doesn't mean frozen render

### Context
Surfaced 2026-04-23 during VRM T-pose fix verification. After fixing `getRawBoneNode` → `getNormalizedBoneNode` and `normalizeMixamoName` regex, CDP bone probes still showed static values. The game tab was `visibilityState: "hidden"` — Chrome throttled RAF to 1fps, causing CDP 2s-interval samples to catch the same animation frame each time.
