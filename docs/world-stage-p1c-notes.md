# Persistent world stage P1c implementation notes

**Last Audited:** 2026-07-26

Status: implementation complete; final serial release gates pending.

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

Final frozen gates (update with the real final run):

| Order | Gate | Result |
|---|---|---|
| 1 | root `bun run build` | PENDING |
| 2 | `apps/web: bunx tsc --noEmit` | PENDING |
| 3a | `apps/web: bun test` touched suites | PENDING |
| 3b | `apps/api: bun test` touched suites | PENDING |
| 4a | probe `--lane=synthetic` | PENDING |
| 4b | probe `--lane=synthetic --webgl` | PENDING |
| 4c | probe `--lane=routes` | PENDING |
| 4d | probe `--lane=soak` | PENDING |

Reviewer-owned gaps remain explicit: separate-account two-tab drive, same-account supersession drive, `/arena` legacy smoke, staging mock-Hatcher harness, onboarding smoke, hosted runtime probe, and founder/Iris-Xe visual sign-off.
