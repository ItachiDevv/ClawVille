---
title: Arrow key e.key.toLowerCase() produces "arrowup" not "w" — no movement
category: gotcha
tags: [keyboard, arrow-keys, keydown, input, WASD]
date: 2026-05-18
confidence: high
threejs_version: r182
---

## Summary
`e.key.toLowerCase()` on arrow keys converts `"ArrowUp"` → `"arrowup"`, not `"w"`. Comparing against `"w"/"s"/"a"/"d"` silently produces no input.

## Details
Arrow key `e.key` values are multi-character strings: `"ArrowUp"`, `"ArrowDown"`, `"ArrowLeft"`, `"ArrowRight"`. Calling `.toLowerCase()` on them gives `"arrowup"` etc. — completely different from single-char WASD.

```ts
// BAD — arrow keys produce no movement
const k = e.key.toLowerCase();
if (k === 'w') keys.w = true; // "arrowup" !== "w" → never fires
```

Correct pattern — detect multi-char key names before lowercasing, map arrow variants explicitly:
```ts
// GOOD — single-char keys lowercased, multi-char preserved verbatim
const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
if (k === 'w' || k === 'ArrowUp')    keys.w = true;
if (k === 's' || k === 'ArrowDown')  keys.s = true;
if (k === 'a' || k === 'ArrowLeft')  keys.a = true;
if (k === 'd' || k === 'ArrowRight') keys.d = true;
```

Apply identically to both `keydown` and `keyup` handlers — a stale `true` after keyup is missed causes the avatar to keep moving when the key is released.

## Context
Casino interior `attachCasinoKeyListeners()` in `casino-interior.tsx`. Bug reported 2026-05-18 — arrow keys produced no movement at all. The world player-avatar avoids this by having separate `arrowup/arrowdown/arrowleft/arrowright` slots in `keyState` (used for altitude, not horizontal movement). The casino collapsed all four directions onto WASD slots, requiring the dual-name mapping.
