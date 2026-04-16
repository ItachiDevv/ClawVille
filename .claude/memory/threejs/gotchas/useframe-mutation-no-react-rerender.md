---
title: useFrame ref mutation does not trigger React re-render — must use useState
category: gotcha
tags: [r3f, useFrame, useRef, useState, react, rendering, floating-text]
date: 2026-04-13
confidence: high
threejs_version: r170+
---

## Summary
Mutating a `useRef` array inside `useFrame` does NOT cause React to re-render the component. JSX that reads `ref.current` directly will always display the initial value.

## Details
`FloatingTexts3D` originally kept `textsRef.current` as the sole source of truth and read it directly in JSX:
```tsx
const textsRef = useRef<FloatingTextInstance[]>([]);
// ... mutate in useFrame ...
const texts = textsRef.current; // STALE — always []
return <group>{texts.map(...)}</group>; // never renders anything
```

The fix: pair the ref (for mutation) with a `useState` (for re-render trigger). At the end of each `useFrame` tick, call `setTexts([...alive])` with a shallow copy so React sees a new array reference.

```tsx
const textsRef = useRef<FloatingTextInstance[]>([]);
const [texts, setTexts] = useState<FloatingTextInstance[]>([]);
// ... mutate textsRef.current in useFrame, then:
setTexts([...alive]);
```

Also add an early return: `if (textsRef.current.length === 0) return;` to avoid calling `setTexts` every frame when idle.

## Context
Caught during speech bubble / activity indicator audit (2026-04-13). FloatingTexts3D was completely non-functional — reward spheres never appeared. The renderTickRef counter pattern in the original code was also broken (incrementing a ref doesn't trigger renders either).
