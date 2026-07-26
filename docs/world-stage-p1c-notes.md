# Persistent world stage P1c implementation notes

**Last Audited:** 2026-07-26

Status: implementation complete; local release BLOCKED by the mandatory
60-loop soak plateau gate.

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

The route/soak harness owns a local in-process world/research transport because
the frozen execution contract says no local API or database is required. It
returns one stable join and one stable SSE, permits requested CORS headers,
quiesces tutorial/land reads, and reports any unhandled mock request. The final
soak reported `stubUnhandled: {}`, so the monotonic result is not a failed API
retry artifact. CDP garbage-collection sessions are explicitly detached.

Per the brief's “monotonic = STOP” rule and the user's same-failure retry cap,
the thresholds were not weakened and no out-of-scope leak fix was improvised.

Reviewer-owned gaps remain explicit: separate-account two-tab drive, same-account supersession drive, `/arena` legacy smoke, staging mock-Hatcher harness, onboarding smoke, hosted runtime probe, and founder/Iris-Xe visual sign-off.
