# Steady-State VRM Performance Handoff

Date: 2026-06-10

> ## ⚠️ CURRENT IMPLEMENTATION STATE (verified against code 2026-06-10 — READ BEFORE ACTING)
>
> A code-level re-review found most of this doc's workstream items are ALREADY shipped or were tried-and-reverted on this exact codebase. Do not burn lab cycles re-proving them:
>
> 1. **`VRMUtils.combineSkeletons` — previously SHIPPED and REVERTED** (commit `314bd1ca`): it orphans raw humanoid bones (`parent === null`) and the Mixamo retargeter (`getNormalizedBoneNode`) produces a frozen T-pose. Rationale comment lives in `vrm-loader.ts` (`normaliseVRM`). Expected payoff is LOW anyway — Verse-Engine skeleton.update batching (3dStructure.md §6d) already captures the main win. If ever re-tested: apply inside `normaliseVRM` BEFORE animator construction (the animator caches Skeleton objects), and run the equip-on-load cosmetic fit regression. Cosmetic bone anchors WOULD survive (verified vs three-vrm 3.5.2 source — it rebinds meshes to new Skeletons but never detaches Bone nodes).
> 2. **`VRMUtils.removeUnnecessaryVertices` — ALREADY SHIPPED**: runs on every VRM load in `normaliseVRM`. `removeUnnecessaryJoints` was also shipped then dropped (`a7d4bf60`, deprecated upstream). Measure only; nothing to implement.
> 3. **Spring/expression/mixer budgets — ~80% SHIPPED**: distance-tiered spring throttle 30/15/7.5Hz (Win B), full mixer+spring skip past 5000wu (Phase 1.5), lookAt/expressionManager never ticked for NPCs (only the local player runs `vrm.update()`). The genuinely-new levers: (a) steady-state per-frame instrumentation (mixer vs spring vs matrixWorld vs skeleton-flush split — NONE exists; all current metrics are load-time), (b) narrowing the per-VRM `scene.updateMatrixWorld(true)` to the humanoid subtree.
> 4. **MToon/WebGPU (`MToonNodeMaterial`)** — versions support it (three-vrm 3.5.2 + three 0.182) but the `@pixiv/three-vrm/nodes` import is REJECTED by Turbopack (`THREE_WEBGPU.tslFn`) — recorded in `vrm-loader.ts` imports. Also: world avatars are mostly standard glTF-PBR (not MToon) and Iris Xe runs the WebGL2 backend. Last priority stands; the gate is bundler compatibility, not package versions.
> 5. **Instance/cache** — two-tier bytes+instance cache already built; parse queue + generation-counter cancellation + player priority lane shipped 2026-06-10 (3dStructure.md §9f). The remaining shared-immutable-parse idea conflicts with the palette cosmetic's material mutation — share geometry/textures only, clone materials, and regression-test palette equip on two same-path avatars.
> 6. **Static-scene items** — MToon outline-off and `mergeStaticMeshesByMaterial` building merging are already live; remaining: cross-building material dedup, prop instancing (InstancedMesh with standard node materials is allowed — only InstancedMesh+ShaderMaterial is banned).
> 7. **Measurement reality check**: the 8 committed browser runs contain ZERO steady-state numbers — `__FIDELITY_FRAME_SAMPLES__` is read by the harness but never written by anything. Build the ready-gated RAF sampler FIRST (wait `__W3D_READY && __W3D_TEXTURES_READY`, settle, then sample) before claiming any steady-state result.

This is a handoff brief for a 3D-focused performance pass. The goal is not to optimize the loading screen or produce a lower-fidelity mode. The goal is to improve in-game performance after the world has loaded while preserving ClawVille's play quality, UI, labels, buildings, avatars, cosmetics, and pixel-art/low-res aesthetic.

## Primary Goal

Improve steady-state `/game` performance assuming the intended initial asset set is already loaded.

Benchmark target:

- Page: `/game`
- Scenario: player standing in town center after initial load completes
- Assets: real buildings and real avatars visible
- UI: all functional HUD, demo quests, player panels, minimap, labels, and action buttons present
- Renderer quality: no DPR quality clamp as a default optimization
- LOD/proxy policy: no primitive replacement buildings, no cylinder avatars, no fake triangle structures

The core question is: **how much frame time can we recover while keeping the game visually and functionally intact?**

## What Is Not The Main Target

Do not spend this pass primarily on network caching, Cloudflare cache behavior, or lazy loading after play begins.

Those matter, but they are separate from the current ask. Cloudflare helps repeated network fetches. The loading screen should be responsible for hiding preload/render readiness work before the user can play. If the screen stays blue until resize, treat that as a loading/render readiness bug, not the main steady-state performance target.

## Current Evidence

Previous fidelity spike data showed serious load/readiness stalls:

- Staging baseline around `356` calls and `700,488` triangles.
- `37` long tasks totaling roughly `23s`.
- Max single long task around `9.958s`.
- Asset audit scanned `182` GLB/VRM assets, `123` referenced assets, about `58.23 MB` referenced bytes, and about `47.27 MB` embedded textures.

These numbers explain bad first-load behavior, but this pass should focus on the steady-state game loop after load completion.

## Hard Constraints

Do not ship any change that wins FPS by making the game worse.

Forbidden:

- Replacing buildings with primitive triangles, boxes, billboards, or obvious proxy geometry.
- Replacing far characters with cylinders, pills, capsules, or colored sticks.
- Removing screen buttons, demo quests, player panels, minimap, labels, or functional HUD.
- Default DPR clamping as a primary optimization.
- Hiding labels/effects as the main optimization in this pass.
- Breaking VRM metadata, avatar identity, cosmetics attachment points, emotes, expressions, walk/run animation, or materials.
- Running blind asset conversion on shipping files without validators and browser visual QA.

Any optimization must be reversible and must include before/after metrics plus visual verification.

## Main Workstream: VRM Runtime Optimization

VRM bottlenecks are the best target for this pass because ClawVille needs real avatars and cosmetics. We need better VRM runtime behavior, not fake character substitutes.

Investigate and benchmark these paths:

1. `@pixiv/three-vrm` `VRMUtils.combineSkeletons`
   - Official docs say combining skeletons reduces per-frame bone matrix calculations.
   - Test only in a lab path first.
   - Must preserve animation playback, emotes, humanoid bones, cosmetics attachment points, and runtime avatar state.

2. `VRMUtils.removeUnnecessaryVertices`
   - Official docs describe reducing unnecessary morph texture / VRAM cost.
   - Validate mesh appearance, expressions, and face/morph behavior before accepting.

3. Spring bone and expression update budgets
   - Measure cost of spring bone simulation, look-at, expression manager, and animation mixers separately.
   - If expensive, test update throttling for non-focused avatars while preserving full visual identity.
   - Do not visibly freeze nearby avatars or active conversation targets.

4. MToon / WebGPU material path
   - Research whether the current material path is expensive under WebGPU.
   - `@pixiv/three-vrm` v3 documents WebGPU compatibility through `MToonNodeMaterial`.
   - Prototype only if the installed package/runtime versions support it cleanly.

5. Avatar instance/cache behavior
   - Avoid reparsing the same VRM multiple times.
   - Verify whether duplicate avatars can share immutable parsed/source data safely.
   - Do not share mutable skeleton, expression, or cosmetic state between distinct live avatars.

Relevant official docs:

- `VRMUtils`: https://pixiv.github.io/three-vrm/docs/classes/three-vrm.VRMUtils.html
- `@pixiv/three-vrm` module docs: https://pixiv.github.io/three-vrm/docs/modules/three-vrm.html

## Cosmetics And VRM State Requirements

Cosmetics are load-bearing. Any VRM optimization must preserve:

- humanoid bone map
- named bones / attachment anchors used for hats, accessories, auras, tools, or future cosmetics
- material assignments needed for skins/outfits
- expression manager behavior
- morph targets and face animation
- spring bones where visually important
- idle, walk, run, talk, and emote clips
- per-avatar mutable state isolation
- `VRMC_vrm` metadata when modifying VRM binaries

If an optimization changes the scene graph, produce a compatibility map showing where existing attachment points moved or how they are aliased.

## Secondary Workstream: Static Scene Draw Calls

This is acceptable only if visual output remains the same.

Allowed:

- Merge safe static same-material meshes.
- Consolidate duplicate materials where values/textures are equivalent.
- Instance repeated props or decorations.
- Reduce per-object material churn.
- Preserve all intended buildings and props.

Not allowed:

- Replacing buildings with simpler visible models.
- Removing props purely for perf.
- Changing building silhouette or gameplay-readable landmarks.

Measure draw calls, pipeline count, material count, and frame time before/after.

## Secondary Workstream: Render Loop And JS Churn

Profile steady-state JavaScript work without removing gameplay surfaces.

Look for:

- per-frame allocations in Three.js update loops
- unnecessary Zustand/React updates from world state
- perf HUD or minimap update frequency issues
- repeated vector/quaternion allocations
- animation mixer updates for avatars that are idle/far/noninteractive
- expensive raycasts or collision checks that can be scheduled less often

Allowed optimizations should preserve behavior while doing less work.

## Lower Priority: KTX2

KTX2 is useful, but it is not the primary target for this steady-state pass unless texture upload or GPU memory remains a measured bottleneck during play.

Known blockers:

- Stock `gltf-transform uastc` stripped `VRMC_vrm` from a VRM lab file.
- Current WebP-packed GLBs are not good direct KTX2 inputs. A lab conversion skipped WebP textures, removed meshopt, and produced a larger no-KTX output.

Only continue KTX2 through a source-asset lab:

- Use pre-WebP PNG/JPEG source GLBs, such as `.webp-backup`, where available.
- Write variants under `docs/perf-fidelity-spike/variants/`.
- Validate `KHR_texture_basisu` exists for GLB variants.
- Validate `VRMC_vrm` remains for VRM variants.
- Do not overwrite runtime assets until browser metrics and screenshots pass.

## Explicitly Skip For This Pass

- Label culling.
- HUD removal or collapse.
- Demo quest/player panel changes.
- DPR clamp tuning as the main fix.
- Building/character primitive proxy LOD.
- Engine rewrite.
- Network/cache/loading-screen optimization, except to document bugs discovered while measuring.

## Measurement Plan

Create a reproducible benchmark that starts after initial load completion.

Required metrics:

- RAF FPS average, p10, p1
- JS frame time average, p95, p99
- GPU/render frame time if available
- draw calls
- triangles
- material count / pipeline count
- live skinned mesh count
- live skeleton count
- total bone matrices updated per frame, if practical
- animation mixer update time
- spring bone/expression update time
- React commit count during idle gameplay
- memory and texture memory proxy metrics where available

Required capture states:

- town center idle
- walking near buildings
- NPC mode with several avatars visible
- active conversation target nearby
- cosmetics-equipped avatar if available

## Success Criteria

A candidate optimization is acceptable only if all are true:

- Functional UI is unchanged.
- Buildings remain visually recognizable and real.
- Avatars remain real VRM avatars, not primitive proxies.
- Cosmetics attachment/state still works.
- Idle, walk, run, talk, and emote behavior still works.
- No default DPR quality downgrade.
- No new blue-screen/render readiness regression.
- Browser screenshots or video confirm visual parity.
- Metrics show a meaningful steady-state gain.

Suggested minimum bar:

- At least `15%` lower p95 frame time in the benchmark scene, or
- At least `20%` lower animation/VRM update cost if the change is VRM-specific, with no visual regression.

## Suggested Execution Order

1. Build or reuse the steady-state benchmark harness.
2. Capture baseline after load completion.
3. Add VRM cost instrumentation around mixer, spring bone, expression, and skeleton updates.
4. Prototype `VRMUtils.combineSkeletons` on one representative avatar in isolation.
5. Validate animations, emotes, cosmetics anchors, and expressions.
6. If clean, test with multiple live avatars in the town scene.
7. Prototype `removeUnnecessaryVertices` separately.
8. Investigate MToon/WebGPU material path only after measuring material/shader cost.
9. Separately evaluate static scene draw-call reductions without visual changes.
10. Produce a blocker matrix and do not merge if any visual/gameplay gate fails.

## Expected Deliverables

- A markdown report with baseline and candidate metrics.
- A list of accepted, rejected, and risky optimizations.
- Screenshots or short clips for each accepted candidate.
- Code diffs only for accepted candidates.
- Validator notes for VRM/cosmetics compatibility.
- Clear rollback instructions.

## Prompt For The Next 3D Agent

Use this prompt when handing the task to another model:

```text
You are working on ClawVille, a Three.js/WebGPU browser game with VRM avatars, cosmetics, and a 3D town. Your task is a steady-state in-game performance pass, not a loading-screen pass and not a lower-fidelity mode.

Assume initial assets are loaded. Optimize `/game` while the player stands in town center with real buildings, real avatars, labels, minimap, demo quests, player panels, and all functional HUD intact.

Do not use primitive proxy buildings, cylinder avatars, default DPR clamps, label culling, HUD removal, or gameplay feature removal. Do not break VRM metadata, cosmetics anchors, expressions, emotes, walk/run animation, or per-avatar state isolation.

Start by measuring steady-state frame cost and VRM runtime cost. Prioritize `@pixiv/three-vrm` runtime optimizations like `VRMUtils.combineSkeletons`, `removeUnnecessaryVertices`, spring bone/expression/mixer update budgets, and MToon/WebGPU material path research. Also consider static scene draw-call reduction only when visuals remain identical.

Every candidate must include before/after metrics and screenshot/video verification. Reject changes that improve FPS by degrading play quality.
```
