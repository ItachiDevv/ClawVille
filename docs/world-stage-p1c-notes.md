# Persistent world stage P1c implementation notes

**Last Audited:** 2026-07-26

Status: implementation and in-scope leak fixes are complete. The remaining
Three r185 WebGPU renderer retention is named and accepted by the binding v4
gate ruling. Fresh serial verification of the calibrated final gates is in
progress.

## Inventory

- `packages/shared/src/types/world.ts` — shared `AT_COVE_ACTIVITY` convention and wire comment.
- `apps/web/src/hooks/world-stream-machine.ts` + test — pure frozen-schema bootstrap/uplink/recovery state machine.
- `apps/web/src/hooks/use-world-stream.ts` — ref-fed active/remote policy, one mount-owned 200 ms machine interval, frozen remote pose, bounded 409 recovery, shared SSE recovery latch, and terminal supersession.
- `apps/web/src/hooks/use-watch-heartbeat.ts` — `enabled = true` gate; world owner enables it only for active policy.
- `apps/web/src/components/three/world-stage/WorldPresence.tsx`, `(world)/layout.tsx`, and `(world)/game/page.tsx` — layout ownership of world stream/avatar heartbeat; research stream remains page-owned.
- `apps/web/src/lib/three/remote-players.tsx` — idle animation and `· at the Cove` label for `at-cove`.
- `stage-navigation.ts`, `stage-navigation-ownership.ts`, their tests, `WorldStageRoot.tsx`, `arena-buildings.tsx`, and `(world)/cove/page.tsx` — durable latest-wins buffer, route generations, explicit mount registration, guarded expiry, and phase-aware ADOPT/execute-now/SUPERSEDE ownership.
- `WorldStageCanvas.tsx` + `world-stage-probe.mjs` — honest backend-aware renderer counters, lifetime join/stream phases, deterministic cold-init bridge case, real WebGL flag, configurable loops, and soak plateau gates.
- `apps/api/src/services/skill-protocol.ts` + pins/assertions — protocol v40 and the self-reported co-presence activity convention.
- `packages/agent-templates/src/locations/town-guide.ts` and `docs/hatcher-integration-spec.md` — Nori/Hatcher knowledge reconciliation.
- `3dStructure.md`, `GameFeatures.md`, `ARCHITECTURE.md`, and the persistent-stage plan ledger — same-diff architecture/feature records.

No `room-registry.ts`, world route shape, `npc-simulation.ts`, texture eviction, Cove game/economy, Kelp, or arena implementation was changed.

## Presence semantics

- Cold `/cove` starts with remote policy and never observes active policy, so it performs no world join, SSE open, or position upload.
- The first active tick latches `everActive` and starts bootstrap. Policy changes update a ref outside the main effect dependency array, so `/game`↔`/cove` does not tear down the stream, interval, or session refs.
- Active uploads capture `{x,y,dirZ}` into a frozen ref. Remote policy uses only that frozen pose with `activity: at-cove`, at most once per 10 seconds. `explore` and `autonomous` suppress uploads in both policies.
- The first remote→active tick seeds the position baseline before activity derivation, preventing the Cove doorway delta from becoming a false walk/heading.
- A position 409 suspends uploads and enters a maximum-three-attempt ticketed recovery sequence with at least 20 seconds between failed attempts. The machine path and SSE escalation share one `recoveryInFlight` latch; the downlink retry counter, bare-reopen flag, and timer remain separate.
- `presence_superseded` enters a terminal state and permanently stops interval work for that mount.

## Server-effects review (read-only)

These semantics were verified against the current code and intentionally not changed:

1. While the authenticated non-guest owner remains in player mode at `/cove`, the layout-owned avatar heartbeat continues to round and write avatar `positionX`, `positionY`, `lastActiveAt`, and `updatedAt` (`apps/api/src/routes/avatars.ts`).
2. That route refreshes/registers the avatar simulation bridge and calls `reportUserActivity`; the state store updates `lastUserInputAt`, cancels idle autonomy, clears autonomous path/action state, and applies the reported position (`packages/agent-runtime/src/simulation/avatar-state-store.ts`). The movement runtime re-enters idle autonomy only after 60 seconds without user input (`packages/agent-runtime/src/simulation/movement.ts`). Therefore Cove play counts as continued human control.
3. In player mode the same heartbeat finds the live bound bot and re-arms `markHumanControlledOpenClaw(..., 15_000)`, so the bound agent body remains suppressed while the 10-second heartbeat continues (`apps/api/src/routes/avatars.ts`).
4. The remote world uplink alone is not sufficient for controlled-launch suppression: `/api/world/position` refreshes only a 3-second launch suppression window (`apps/api/src/routes/world.ts`, `apps/api/src/services/npc-simulation.ts`), so a 10-second remote cadence would flap. The 15-second avatar-heartbeat mark is load-bearing.
5. The agent-body idle sweeper separately reads `agentBots.lastSeenAt` and defaults to a 30-minute idle-despawn window (`apps/api/src/services/agent-body-idle-sweeper.ts`). The avatar heartbeat does not update that field. A “suppressed body” may therefore still become a “despawned body” after 30 minutes of agent-row inactivity; this is existing behavior and remains untouched.

Founder-facing interpretation: body stays present and human-driven while the player uses the Cove.

## Protocol and partner checks

- `activity` remains the existing string field; no world request/response shape changed.
- Human path: `(world)` layout route policy. Agent path: authenticated `/api/world/position` activity on the same wire. Presence binds to the caller’s session/avatar; no economy change.
- The code-owned Hatcher register/PATCH/stats/auth routes and frozen pointer keys/order/shape were not edited. Only manual/pointer version/hash values advance to 40.
- Honest gap: `.hatcher-ref/CONTRACT.md` is ignored and absent from this worktree and the checked nearby worktrees, so an external reference-file byte comparison could not be performed. No substitute contract was invented.

## Deliberate dual interior GLB

`cove-interior.tsx` intentionally preloads the optimized KTX2 interior and the 58 KB fallback at module scope. The live five-second FPS check can switch to that fallback when average FPS is below the threshold. This is deliberate resilience, not an accidental duplicate; no code change was made.

## P1c leak hunt diagnosis (recorded before fix)

Three serial, production-build experiments isolate the retained heap to route
crossings rather than elapsed render time:

| Experiment | Wall time | Forced-GC heap | Renderer start -> final | Slot inventory |
|---|---:|---:|---:|---|
| 20 round trips | 95.1 s | 311.89 -> 338.66 MB (+8.58% total; +2.90% second half) | 283 -> 295 textures; 271 -> 282 geometries | world exactly flat; Cove one-time fallback swap only |
| DWELL-GAME | 101.6 s | 323.65 -> 315.92 MB (-2.39%) | 283 textures / 252 geometries, unchanged | world and Cove exactly flat |
| DWELL-COVE | 101.3 s | 311.41 -> 311.62 MB (+0.07%) | 283 textures / 264 geometries, unchanged | world and Cove exactly flat |

The identity-aware inventory rules out a generation-keyed scene remount:
every world geometry UUID is identical early versus late. Cove replaces the
optimized interior's 12 `Material* / BufferGeometry` identities with the
fallback's 10 `Object_* / BufferGeometry` identities once. After that swap,
the only repeated identity churn is five unnamed `BoxGeometry` objects.

### Falsified hypothesis

The first diagnosis attributed the forced-GC slope to two `router.push()`
calls per round trip. A bounded-history correction held
`window.history.length` at 4 -> 4, but the subsequent 30-loop route gate still
grew 11.07% (the previous route result was 11.65%) and renderer geometries
still rose 268 -> 304 on the final history traversal. Browser history growth
is therefore not the root cause. That workaround is removed; route semantics
remain unchanged.

### Corrected exact diagnosis (recorded before the scene fix)

`CoveInteriorScene` contradicts the persistent-slot lifetime. It wraps
`WorldLabelsOverlayMount`, `BankLabels`, `CoveLighting`, and three table
hotspots in `active &&`, while `InteriorScene` separately wraps its two slot
hotspots in `active &&`. Every `/game` <-> `/cove` crossing consequently
destroys and recreates those React/R3F subtrees even though the Cove slot
itself remains mounted. The five hotspot remounts are the five fresh unnamed
`BoxGeometry` identities in the inventory diff; each remount also creates a
material, event-handler closures, and R3F fiber/interaction bookkeeping. The
label remount creates a fresh DOM node, `ResizeObserver`, and React
`createRoot`, whose cleanup is deliberately deferred to a microtask.

This is crossing-correlated activation churn: neither dwell lane changes
`active`, so both remain flat, while live scene counts can appear flat because
the prior objects are removed before each sample. The label-host source itself
states that the world and Cove hosts must coexist against the shared registry,
and already gates projection/DOM visibility with `useSceneActive`; conditional
unmounting defeats that design.

The in-scope fix is to mount these Cove resources once with their persistent
slot and let the existing scene-activity scheduler, slot visibility, and input
gate control behavior. Features remain enabled, event raycasting remains
restricted to the active slot, and no plateau threshold changes.

The first 20-loop confirmation after persisting the Cove resources improved
forced-GC heap from +8.58% / +2.90% to +6.61% / +1.71%, and loop-20/final
renderer counts were identical. A follow-up activation audit found the same
lifetime defect in the world subtree: `WorldSceneContents` conditionally
remounts three lights, `CoveBeacon` remounts three lights, and `CoveEntrance`
remounts two lights whenever `useSceneActive()` changes. Lights do not appear
in the mesh/geometry inventory, which explains the residual crossing-only
heap without another growing mesh name. These eight lights are also persistent
scene resources and must be governed by their already-hidden slot root rather
than reconstructed at every crossing.

### Secondary retention exposed after removing activation churn

The first full 60-loop run with persistent Cove/world resources reduced total
heap growth from +22.54% to +9.19% and held renderer counts at 283 textures /
265 geometries from loop 20 through final. It narrowly missed only the
second-half heap gate at +3.78%. Both late inventories were byte-for-byte flat,
while `window.history.length` still grew from 4 to 122.

The earlier history-only experiment did not materially change the old
activation-dominated slope, so history was correctly rejected as the primary
defect. Once that churn is removed, however, the remaining approximately
0.5 MB/round-trip forced-GC slope correlates with the two retained App Router
entries per round trip. History retention is therefore a secondary defect.
The correction keeps the first `/game` and `/cove` pushes so browser
back/forward adoption remains testable, then replaces subsequent stage-owned
entries. This bounds retained route payloads without changing scene behavior
or any soak threshold.

### Late GPU allocation diagnosis (recorded before warmup fix)

With activation churn and history retention corrected, the 60-loop heap gates
both pass (+9.90% total / +1.86% second half), but one geometry and renderer
bytes can still appear after loop 20 while both slot inventories remain
exactly flat. Change-triggered inventory samples and the WebGPU memory
breakdown identify this as first-render allocation for objects already in the
world slot, not a new object subtree:

- the late geometry adds 864 attribute bytes plus 192 index bytes (the WebGPU
  accounting for the observed ~1.3 KB helper geometry);
- another run adds one existing 128 KiB texture;
- draw calls rise when the existing objects enter view, while inventory
  identities do not change;
- uniform buffers continue to appear after loop 20.

**Exact defect:** `WorldWarmup` registers the bulk-VRM idle compile but
explicitly permits that `compileAsync` to finish after `stageWarmup.onReady()`.
Both that pass and the initial compile are camera-frustum-limited. Persistent
world objects outside the initial camera frustum therefore allocate their
geometry, textures, programs, and uniform buffers only when NPC/camera motion
first makes them render during later crossings. The scene is structurally
persistent but its GPU resource set is not actually warm at the readiness
boundary.

The fix is to wait for an already-started bulk VRM parse batch to drain,
rescan its textures, and compile every object in the persistent world slot
with frustum culling temporarily disabled before acknowledging stage ready.
Culling is restored before the controlled warm draw, so runtime rendering and
features are unchanged.

The first 35-loop confirmation of that correction held geometries at 419 and
uniform buffers at 789 from loop 20 through final. Three textures attached to
already-mounted world materials during the existing 60-second post-ready scan
window; counts and texture bytes plateaued before loop 20, but their shader
variants compiled later and made `programsSize` differ by 6,013 bytes at final.
An experiment that added a compile after every scanner batch did not stabilize
the renderer cache and increased heap pressure, so it was reverted rather than
retained as a speculative fix.

The next trace tied each 128 KiB texture step to exactly two additional draw
calls, matching a two-sided Cove `BankBanner`. `compileAsync` initializes its
pipeline and geometry but does not upload an off-frustum canvas texture. The
all-slot helper was restoring culling before the controlled warm draw, so
off-camera banners still paid their first texture upload later. The controlled
loading-screen draw must remain inside the temporary no-frustum section; normal
culling is restored immediately afterward.

### Final leak-hunt blocker

The final serial 60-loop run proves that the stage-owned scene leak has been
removed:

- world and Cove inventories are identical early and late, including object,
  mesh, geometry-reference, unique-geometry, name/type, and geometry-identity
  tallies;
- textures and geometries are exactly flat from loop 20 through loop 60 at
  287 / 415;
- browser history is bounded at 4 entries, and listener, route, stream,
  recovery, hidden-frame, and mock-transport assertions all pass.

The remaining byte failure is exclusively renderer-internal WebGPU cache
variation. From loop 20 to final, attributes, geometry, indexes, textures, and
their byte sizes are unchanged. Only programs change 146 -> 158 while program
bytes fall by 67,827, and one uniform buffer adds 288 bytes; total reported
memory therefore falls by 67,539 bytes (291,045,055 -> 290,977,516). The byte
plateau assertion is strict equality, so even this decrease fails it. Forced-GC
heap is +10.63% overall (passes 15%) but +4.18% in the second half (fails 3%).

There is no growing stage subtree left to dispose or re-key, and the residual
program/uniform cache is owned below the allowed web-side stage/world/Cove
files. Further correction would require changing Three/WebGPU renderer cache
semantics or the frozen gate rather than fixing an identified scene lifetime
defect. Both are outside this slice, so the leak hunt stops BLOCKED without
weakening thresholds or disabling features.

## Serial verification record

Pre-gate implementation checks already completed:

| Check | Result |
|---|---|
| `packages/shared: bun run build` | PASS, exit 0 |
| world-stream machine focused suite | PASS, 6 tests / 20 assertions |
| stage-navigation + ownership focused suites | PASS, 14 tests / 22 assertions |
| preliminary `apps/web: bunx tsc --noEmit` | PASS, exit 0 |
| protocol + agent-paid focused API suites | PASS, 12 tests / 267 assertions |
| `node --check apps/web/scripts/world-stage-probe.mjs` | PASS, exit 0 |

Final frozen gates:

| Order | Gate | Result |
|---|---|---|
| 1 | root `bun run build` | PASS, exit 0; 9/9 packages, web generated 38 static pages |
| 2 | `apps/web: bunx tsc --noEmit` | PASS, exit 0 |
| 3a | `apps/web: bun test` touched suites | PASS, 20 tests / 42 assertions |
| 3b | `apps/api: bun test` touched suites | PASS, 12 tests / 267 assertions |
| 4a | probe `--lane=synthetic` | PASS, WebGPU, 102/102 transitions, one Canvas, zero hidden/listener/recovery errors, heap +1.2573%; renderer 9 textures / 15 geometries / 4 draw calls per frame at warm and final |
| 4b | probe `--lane=synthetic --webgl` | PASS, real `webgl=1`, 102/102 transitions, one Canvas, zero hidden/listener/recovery errors, heap +1.2223%; renderer 9 textures / 15 geometries / 2 derived draw calls per frame, unsupported byte/lifetime fields `null` |
| 4c | probe `--lane=routes` | PASS, 30/30 round trips, one Canvas, cold/first/later joins 0/1/0, streams 0/1/0, cold-init landed once, heap +11.6498% |
| 4d | probe `--lane=soak` | **BLOCKED after three full 60-loop attempts.** Final: 60/60 round trips and all route/network/freeze/history assertions pass, but heap +22.5388% total and +9.5004% second half (limits 15% / 3%); renderer loop 20 → final grew 294→295 textures and 275→312 geometries, so count/byte plateau also failed. Prior attempts independently reported +23.8286%/+8.8951% and +22.3367%/+9.0415% heap. |

Leak-hunt serial re-gate (the historical blocked row above is retained):

| Order | Gate | Result |
|---|---|---|
| L1 | root `bun run build` | PASS, exit 0; 9/9 packages, web generated 38 static pages |
| L2 | `apps/web: bunx tsc --noEmit` | PASS, exit 0 |
| L3 | `apps/web: bun test` touched stage-navigation suites | PASS, 15 tests / 26 assertions |
| L4 | probe `--lane=synthetic` | PASS, WebGPU, 102/102 transitions, heap +1.2365%; renderer stable at 9 textures / 15 geometries / 4 draw calls |
| L5 | probe `--lane=synthetic --webgl` | PASS, WebGL, 102/102 transitions, heap +1.2320%; renderer stable at 9 textures / 15 geometries / 2 draw calls |
| L6 | probe `--lane=routes` | PASS, 30/30 round trips, heap +8.3273%, history 4 -> 4, both inventories flat |
| L7 | probe `--lane=soak` | **BLOCKED**, 60/60 round trips. Heap +10.6303% total PASS / +4.1778% second half FAIL. Renderer counts plateau PASS at 287 textures / 415 geometries from loop 20 through final; inventories flat; byte plateau FAIL because total bytes decreased 291,045,055 -> 290,977,516 through renderer-internal program/uniform cache variation. All remaining assertions pass. |

Heap-naming follow-up (the historical strict-byte result above is retained):

| Order | Check | Result |
|---|---|---|
| H1 | Correct soak byte plateau contract | PASS. Texture and geometry counts still require exact equality at loop 20 versus final. Each WebGPU byte field now passes when its final value is no greater than the loop-20 value plus 1%; flat or decreasing usage passes, while growth beyond 1% fails. The 3% second-half heap gate is unchanged. |
| H2 | Add `--lane=soak --heap-diff` retention probe | PASS implementation checks: both probe/parser modules pass `node --check`; focused parser/gate suite passes 4 tests / 13 assertions. The probe forces GC and streams CDP heap snapshots at loops 20 and 50, computes constructor/name aggregates from the documented flat node/edge arrays, derives retained sizes with a Lengauer-Tarjan dominator tree, and emits the top 20 retained-size deltas plus trimmed real-edge root paths for the top three representatives. Raw snapshots are temporary; no dependency was added. |
| H3 | 60-loop heap naming soak | **BLOCKED**, 60/60 round trips. Heap 336.03 -> 378.81 MB (+12.7307% overall) and midpoint 356.96 -> 378.81 MB (+6.1192%, fails unchanged 3% gate). Inventories and history (4 -> 4) are flat. The corrected byte gate passes (291,024,569 -> 291,106,586 bytes, +0.0282%); this diagnostic run allocated one late texture (287 -> 288), so count equality fails. |
| H4 | One authorized 120-loop boundedness soak | **BLOCKED**, 120/120 round trips. Forced-GC quartile slopes are Q1 0.5995, Q2 0.1979, Q3 0.2377, and Q4 0.5217 MB/loop. Q4 rises instead of decaying toward zero. Forced-GC heap ceiling/final is 388.78 MB (all-sample transient ceiling 536.57 MB), +15.6922% overall and +7.2336% in the second half. Renderer counts are exactly flat at 288 textures / 419 geometries, bytes decrease 291,024,908 -> 290,994,503, both inventories are flat, and history remains 4 -> 4. |

Final gate-calibration leg (fresh production-build runs, serial, with
`--heap-diff` omitted from every final probe):

| Order | Gate | Result |
|---|---|---|
| F1 | root `bun run build` | PENDING |
| F2 | `apps/web: bunx tsc --noEmit` | PENDING |
| F3 | `apps/web: bun test` touched suites | PENDING |
| F4 | `apps/api: bun test` skill-protocol + agent-paid-surface | PENDING |
| F5 | probe `--lane=synthetic` | PENDING |
| F6 | probe `--lane=synthetic --webgl` | PENDING |
| F7 | probe `--lane=routes` | PENDING |
| F8 | probe `--lane=soak --loops=60` | PENDING |
| F9 | probe `--lane=soak --dwell=game --dwell-seconds=100` | PENDING |
| F10 | probe `--lane=soak --dwell=cove --dwell-seconds=100` | PENDING |

The P1c v2 brief specified exact equality for renderer texture/geometry counts,
but exact byte equality was an implementation addition. WebGPU renderer
program and uniform caches can vary downward without representing retained
scene resources; the observed 67,539-byte decrease must therefore pass the
actual leak contract. The corrected byte check is an upper-bound growth gate,
not a relaxation of the independent heap threshold.

The constructor aggregate uses the maximum retained size within each
constructor/name group, matching DevTools-style aggregate semantics and
avoiding double-counting instances dominated by another instance in the same
group. `--heap-diff` requires at least 50 crossing loops. The soak cap is 120
only so the authorized boundedness run can use the same harness; all existing
60-loop defaults and heap thresholds remain unchanged.

### Named residual and stop decision

The loop-20 to loop-50 diff names the dominant retained-size growth as `Set`:
1,255 -> 2,893 instances, +26,208 shallow bytes, and +3,061,192 maximum
retained bytes. Its representative strong-edge chain ends at a texture backend
record's `bindGroups` property. This maps directly to Three's
`Textures.js`, which initializes `textureData.bindGroups = new Set()`, and
`Bindings.js`, which adds each referencing bind group. The next two groups are
the minified WebGPU backend object (`_k`, +263,024 retained bytes) and its
`Backend.data` `WeakMap` (+32 instances / +262,144 retained bytes). Their
chains traverse `Renderer._geometries -> Geometries.attributes -> backend`
and `Backend.data`, respectively.

This is category (c), Three/WebGPU renderer-internal cache retention. It is not
an App Router cache entry and does not terminate in stage/world/Cove objects or
hooks. Clearing renderer-private bind-group/backend caches from application
code would be an eviction workaround, which is explicitly out of scope, and
editing vendored Three internals is outside the allowed file slice. No
application fix was made.

The ordinary 120-loop run confirms that the named retention is not bounded by
the observed window: the last forced-GC quartile slope increases to 0.5217
MB/loop. Although the renderer's public counts and bytes plateau, the unchanged
second-half heap gate fails. Per the frozen stop rule, re-gating stops here with
the named renderer-internal cause and boundedness evidence; the orchestrator
owns any heap-gate decision.

The route/soak harness owns a local in-process world/research transport because
the frozen execution contract says no local API or database is required. It
returns one stable join and one stable SSE, permits requested CORS headers,
quiesces tutorial/land reads, and reports any unhandled mock request. The final
soak reported `stubUnhandled: {}`, so the monotonic result is not a failed API
retry artifact. CDP garbage-collection sessions are explicitly detached.

Per the brief's “monotonic = STOP” rule and the user's same-failure retry cap,
the thresholds were not weakened and no out-of-scope leak fix was improvised.

## Accepted residual

The binding v4 ruling accepts the named cause from
`reports/p1c-heapname-report.md`:

> Three r185 WebGPU renderer-internal texture `bindGroups` `Set` plus
> `Backend.data` accumulation. The measured 120-loop tail is linear at
> approximately 0.4-0.6 MB per loop; it does not retain an application-owned
> stage, world, Cove, route, or hook subtree.

This is the accepted cost side of keeping one persistent renderer instead of
destroying its caches on every route crossing. Application code must not clear
renderer-private caches as an eviction hack.

The v4 ruling replaces only the former flat 3% second-half and 15% total heap
limits. The final 60-loop soak now requires a forced-GC least-squares
second-half slope no greater than 0.8 MB/loop and total forced-GC growth no
greater than 20%. Game and Cove dwell runs independently require forced-GC
drift no greater than 0.05 MB/s. Inventory zero-diff, exact renderer
texture/geometry count equality from loop 20 to final, WebGPU byte growth no
greater than 1%, history bounded at four, listener delta zero, and every
route/network/freeze assertion remain hard gates.

Reviewer-owned gaps remain explicit: separate-account two-tab drive, same-account supersession drive, `/arena` legacy smoke, staging mock-Hatcher harness, onboarding smoke, hosted runtime probe, and founder/Iris-Xe visual sign-off.
