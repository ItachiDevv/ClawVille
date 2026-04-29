---
title: VRM per-instance cache — useVRMInstance(path, instanceId)
category: pattern
tags: [vrm, cache, suspense, react, instance-isolation, vrm-loader, scene-clone]
date: 2026-04-28
confidence: high
threejs_version: r182
---

## Summary

`useVRMInstance(path, instanceId)` is the canonical VRM loading hook for ClawVille. It uses a **two-tier cache**: shared `VRM_BYTES` (one fetch per path) plus per-instance `VRM_INSTANCES` (one fully-disjoint VRM per `(path, instanceId)`). This replaces the older "share one parsed VRM, clone vrm.scene per visible avatar" pattern, which corrupts animation state when two consumers share the same path.

Live API at `apps/web/src/lib/three/vrm-loader.ts`. Consumers: `arena-npcs.tsx` (VRMNpcMesh), `player-pet.tsx` (PlayerPetVRMInner), `components/three/SelectAgentCanvas.tsx` (PlatformModelVRM).

## Why scene-cloning a shared VRM is wrong

A `VRM` object owns more than `vrm.scene`: `vrm.humanoid`, `vrm.springBoneManager`, `vrm.lookAt`, `vrm.expressionManager`, the `AnimationMixer` plumbing, normalized bone references, etc. Cloning `vrm.scene` with `SkeletonUtils.clone()` produces an independent skinned graph but the surrounding VRM helpers still point at the ORIGINAL scene's bones. If two visible instances both update animation state through their own animator, they fight over the same humanoid normalised bones — the second instance to render wins and the first goes T-pose / freezes.

This is exactly what Codex flagged as Critical #1: when player and NPC both happen to use `milady-official-7.vrm`, the player overlapping with NPC `milady-miu` corrupted both animations.

## The two-tier cache

```ts
// Tier 1: shared bytes — one fetch per path
const VRM_BYTES = new Map<string, Promise<ArrayBuffer>>();

// Tier 2: per-instance parsed VRM — keyed by `${path}#${instanceId}`
const VRM_INSTANCES = new Map<string, InstanceEntry>();

export function useVRMInstance(path: string, instanceId: string): VRM | null {
  // Suspense throw protocol — re-parse from cached bytes if instance not loaded yet
  // (parseAsync receives a fresh ArrayBuffer.slice(0) so each parse is independent)
}
```

**Per-instance parse is intentional.** GLTFLoader.parseAsync allocates new geometries, materials, bone hierarchies, mixers, spring-bone managers per call. The shared-bytes layer dedups the network/disk work; the per-instance layer guarantees zero shared mutable state between visible avatars.

## Consumer pattern

```tsx
function VRMNpcMesh({ npc, vrmPath }: { npc: NPC; vrmPath: string }) {
  const vrm = useVRMInstance(vrmPath, npc.id);

  useEffect(() => {
    return () => disposeVRMInstance(vrmPath, npc.id);
  }, [vrmPath, npc.id]);

  if (!vrm) return null;
  // ... render vrm.scene ...
}
```

**Critical:** every consumer MUST call `disposeVRMInstance(path, instanceId)` on unmount. The shared `VRM_BYTES` entry stays alive (cheap to keep an ArrayBuffer); only the parsed instance is freed.

For module-scope warm-up: `preloadVRMBytes(path)` fetches without parsing. Call this from any module that ships a list of paths used soon.

## What instanceId should be

- For NPCs: use `npc.id` from the registry — guaranteed unique per visible avatar.
- For player pet: use the literal string `'player-pet'`.
- For pickers / preview canvases: use `'picker'` or another fixed string.

Do **NOT** use React's `useId()` — it triggers re-suspension loops in Suspense throw/retry, causing infinite "loading" flickers or cache-miss thrash. Use a stable identifier you control.

## Test harness

`scripts/test-vrm-loader.ts` (18 assertions, all green): mocks fetch + GLTFLoader + meshoptimizer + three-vrm via `mock.module`. Verifies:
- Two instances on same path are disjoint.
- Same `(path, instanceId)` returns the cached VRM.
- `disposeVRMInstance` evicts the parsed instance but keeps shared bytes.
- Concurrent loads dedup the byte fetch.
- `preloadVRMBytes` warms without parsing.

Run via `bun test scripts/test-vrm-loader.ts`.

## When NOT to use this

If you're rendering a VRM in an offscreen Node-side test or a one-shot screenshot script, you can call `loadVRMInstance(instanceId, path)` imperatively — the same code path, just no Suspense throw. The hook form is for React render trees only.

## Context

Shipped commit `a59cb9f` (2026-04-28) as the fix for Codex Critical #1. Verified live by user: "The movement is working fine" — both player and overlapping NPCs animating independently with no T-pose. The earlier alternative (per-consumer cache via `useId()`) shipped and was reverted in `0e04dc6` because Suspense-throw + React-generated id created infinite suspension cycles.
