---
title: Two visible VRMs sharing one parsed instance corrupts animation
category: gotcha
tags: [vrm, cache, animation, t-pose, scene-clone, codex-critical-1, humanoid, springbone]
date: 2026-04-28
confidence: high
threejs_version: r182
---

## Summary

When two visible avatars share one parsed `VRM` object (e.g. via `scene.clone(true)` or `SkeletonUtils.clone()` on a shared `vrm.scene`), their animations corrupt each other. One avatar T-poses, freezes mid-animation, or inherits the other's pose. This is **Codex Critical #1** in the ClawVille codebase. Fix: per-instance VRM via `useVRMInstance(path, instanceId)` — see `patterns/vrm-per-instance-cache.md`.

## Why this happens

A VRM object is more than `vrm.scene`. It owns:
- `vrm.humanoid` — normalized bone references used by retarget code
- `vrm.springBoneManager` — physics joints with mutable state
- `vrm.lookAt` / `vrm.expressionManager` — head/face controllers
- AnimationMixer plumbing tied to specific Object3Ds in the scene graph

Cloning `vrm.scene` produces a new skinned graph, but the VRM helpers above still hold references to the ORIGINAL scene's bones. When two animators (one per visible avatar) both update the humanoid through retarget code, the second update wins. Symptoms:
- Player goes T-pose when an NPC using the same `.vrm` enters the scene.
- One avatar freezes at the bind pose while the other walks.
- Spring-bone state oscillates as both physics steps fight for the same joints.

## Reproduction (the scenario that exposed Critical #1)

ClawVille has 5 wandering NPCs using `milady-official-2/3/4/7/8`. The user can also pick the same VRM as their player-pet. When the player walks past wandering NPC `milady-miu` (which uses `milady-official-7`) and they overlap, both animations corrupt.

## Don't fix this with disjoint paths

A tempting workaround is "force the player to a different VRM than any NPC uses." This is brittle: future content can re-collide, and the bug remains latent. The real fix is per-instance VRM at the cache layer.

## The fix

`useVRMInstance(path, instanceId)` — see `patterns/vrm-per-instance-cache.md`. Two-tier cache:
- Shared `VRM_BYTES` (one ArrayBuffer fetch per path)
- Per-instance `VRM_INSTANCES` (one fully-disjoint VRM per `(path, instanceId)`)

Each visible avatar gets its own parsed VRM with its own humanoid, springBoneManager, mixers — guaranteeing zero shared mutable state.

## What used to be in vrm-loader.ts

Before commit `a59cb9f` (2026-04-28), the loader had a single `Map<path, Promise<VRM>>` cache. Consumers called `scene.clone(true)` (or `SkeletonUtils.clone()`) on the shared `vrm.scene`. This is the corruption pattern — never reintroduce it.

## Failed alternative: per-consumer cache via useId()

An earlier attempt used React's `useId()` as the instance key. This caused infinite Suspense suspension cycles because `useId` is stable across re-renders BUT Suspense throw/retry re-runs the render and the cache-miss-then-parse-then-suspend pattern doesn't terminate cleanly. Reverted in commit `0e04dc6`. Use a stable explicit ID (npc.id, 'player-pet', 'picker') — never useId.

## Context

Codex audit (2026-04-28) flagged this as Critical #1 with the explicit recommendation: "design useVRMInstance(path, instanceId) — do not clone only vrm.scene and keep a shared VRM object." The recommendation was implemented in commit `a59cb9f` and verified live: player + overlapping NPC both animate independently.
