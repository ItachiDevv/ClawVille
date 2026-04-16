---
title: Date.now() in render body is stale — bubbles never auto-expire
category: gotcha
tags: [react, zustand, speech-bubbles, expiry, Date.now, stale-closure]
date: 2026-04-13
confidence: high
threejs_version: r170+
---

## Summary
`Date.now()` called in a React component render body is only fresh when the component re-renders. If the zustand store stops updating (idle server, demo mode), expiry checks against `now` will always use the timestamp from the last render.

## Details
`NpcSpeechBubbles` originally did:
```tsx
const now = Date.now(); // stale — only fresh when store changes
const activeBubbles = chatBubbles.filter((b) => b.expiresAt > now ...);
```

A 6-second chat bubble would stay on screen indefinitely once the NPC simulation went quiet, because `now` never advanced past the last render.

Fix: add a 1-second `setInterval` tick via `useEffect` that bumps a counter state, forcing a re-render so `now` is always within ~1s of the real time:
```tsx
const [tick, setTick] = useState(0);
useEffect(() => {
  const id = setInterval(() => setTick((t) => t + 1), 1000);
  return () => clearInterval(id);
}, []);
const now = Date.now();
void tick; // read it so the linter doesn't strip it
```

## Context
Caught during speech bubble audit (2026-04-13). Bubbles with 6-8 second lifetimes were tested to persist indefinitely in demo mode.
