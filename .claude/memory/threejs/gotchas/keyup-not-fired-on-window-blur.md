---
title: Browser skips keyup when window loses focus mid-hold — module-scope key state strands true
category: gotcha
tags: [keyboard, input, focus, blur, npc-controller, player-pet, phantom-movement]
date: 2026-04-25
confidence: high
threejs_version: r170+
---

## Summary

If a key is held while the browser tab loses focus, the browser does NOT fire a `keyup` event. Module-scope keyboard state objects (`_keys`, `keyState`) stay `true` forever — causing characters to walk indefinitely after the user returns.

## Details

Both `npc-controller.tsx` and `player-pet.tsx` store key state in module-scope objects. The `onUp` handler has no target guard (intentional — ensures chat inputs don't strand keys). But the browser itself skips `keyup` when:
- The user alt-tabs / cmd-tabs while a key is held
- An OS dialog (file picker, print dialog) appears mid-hold
- `document.visibilitychange` fires (tab hidden by browser)

Chrome also throttles RAF to 1fps on hidden tabs (see `gotchas/chrome-background-tab-raf-throttle.md`), so when the user returns, the character may have teleported 550px (SPEED × 1s) before the next idle frame catches it.

**Fix:** Add `window.blur` and `document.visibilitychange` listeners to zero all key state:

```ts
const onBlur = () => resetKeys();
const onVisibility = () => { if (document.hidden) resetKeys(); };
window.addEventListener('blur', onBlur);
document.addEventListener('visibilitychange', onVisibility);
```

Apply this to every module-scope key state object — `npc-controller.tsx` and `player-pet.tsx` both needed it.

## Context

Surfaced as NPC-mode phantom movement bug 2026-04-25: user releases WASD, NPC keeps walking, visible at X_MIN=16 world boundary. Fixed in commit `2533ca6`.
