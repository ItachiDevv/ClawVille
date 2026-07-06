---
title: Conditional early-return in page component causes loader to remount and reset
category: gotcha
tags: [react, loading-screen, suspense, ios, mobile, page-composition]
date: 2026-05-20
confidence: high
threejs_version: r182
---

## Summary

A conditional `if (isLoading) return <SeaLoadingScreen />` before the main render path causes the entire React tree to unmount and remount when the loading state resolves — including a fresh `SeaLoadingScreen` that starts from 0%, producing a "loaded twice" appearance.

## Details

In `apps/web/src/app/game/page.tsx`, the page had this pattern:

```tsx
// Early return while auth/avatar loading
if (isLoading || authLoading || miladyEmbed.exchanging) {
  return (
    <div className="game-container">
      <SeaLoadingScreen />   // ← instance A
    </div>
  );
}

// Main layout
return (
  <div className="game-container">
    <SeaLoadingScreen />     // ← instance B (fresh mount on transition)
    <World3DCanvas mode="game" />
    ...
  </div>
);
```

When `isLoading` transitions from `true` to `false`, React sees two completely different trees. It unmounts the early-return tree (including `SeaLoadingScreen` instance A, which had animated to ~40-92% progress) and mounts the full layout tree (including `SeaLoadingScreen` instance B with fresh state at 0%).

On iOS this is especially visible because:
1. Auth/avatar fetch takes 200-800ms → user sees loader animate to 40-60%
2. Fetch resolves → loader resets to 0% (new instance B mounts)
3. Canvas boots, TSL shaders compile, `__W3D` fires → loader fades out
4. Total appearance: "loaded twice"

**The fix:** remove the conditional early-return entirely. The `World3DCanvas` is safe to mount immediately — it renders nothing visible while auth is loading and the single `SeaLoadingScreen` covers the viewport. Auth-gated UI (avatar stat bar, chat panel, etc.) are already guarded by `hasAvatar` / `agentConnected` checks and correctly render empty while loading.

```tsx
// ✅ Correct — single loader persists through auth resolution
const hasAvatar = !!avatar; // false while loading → auth-gated UI hidden

return (
  <div className="game-container">
    <SeaLoadingScreen />
    <World3DCanvas mode="game" />
    {hasAvatar && <ChatPanel />}
    ...
  </div>
);
```

## Context

Surfaced on iOS Safari 2026-05-20 after the forceWebGL fix (cc26908) which made iOS actually reach the canvas boot phase. On desktop the auth fetch is fast enough (~50ms) that the loader reset was imperceptible. On iOS with slower JS evaluation, the transition from loader-A (mid-progress) to loader-B (0%) was clearly visible as a "reload" flash.

**Generalizable rule:** Any loading state that guards a full tree swap will reset all sibling component state. Prefer gating individual UI elements on loading flags rather than returning early with a different tree shape.
