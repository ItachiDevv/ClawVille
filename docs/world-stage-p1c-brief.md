# Persistent world stage P1c brief v2 (RE-FROZEN 2026-07-26 after Codex REJECT — implement exactly; deviations require orchestrator sign-off)

Author: Fable (planner/reviewer). Critique: Codex gpt-5.6-sol (R1 REJECT, all findings
verified and folded in below). Implementer: Codex per /copus-max pipeline.

**BASE (history-rewrite aware):** create branch `feat/world-stage-p1c` off
`staging@dbc231d5` in worktree `C:/Users/itachi/Documents/Crypto/cv-covefreeze`
(already checked out on new-history staging, up to date with origin; P1b is in
this history as `52fad9b0`). The OLD branch `feat/world-stage-p0a` (`15bc89e5`)
is pre-purge history: NEVER check out, merge, or push it.

Parent plan: `docs/persistent-world-canvas-plan-2026-07-24.md` (ledger row P1c).

## Scope (four items)

1. **Presence continuity** — world stream + avatar heartbeat move from the
   `/game` page to a `(world)`-group owner with a route-aware
   `worldPresencePolicy`. Founder default: body stays present, tagged
   "at the Cove", low-rate uplink, no leave on the in-group crossing.
2. **First-navigate hardening** — buffered navigation bridge with DURABLE
   ownership semantics (v1's design could drop an accepted request — fixed).
3. **Leak soak lane** — `--lane=soak` (60 loops, plateau gates) + probe
   upgrades (network-phase assertions, honest renderer counters).
4. **Dual interior GLB download** — RESOLVED AS DELIBERATE, documentation
   only (`cove-interior.tsx:374-380` preloads the 58 KB fallback for the live
   FPS auto-switch at `:1880-1885`). No code change.

NON-scope: no `room-registry.ts` / `world.ts` route changes; no
`npc-simulation.ts` edits; no texture eviction; no cove game/economy changes;
no kelp/arena migration. `useResearchStream()` STAYS page-owned on `/game`
(v1 moved it; critique showed that expands cold-Cove SSE lifetime for a HUD
that only renders on /game — reverted).

## Item 1 — presence continuity

### 1a. Owner component

NEW `apps/web/src/components/three/world-stage/WorldPresence.tsx` (client,
renders null), mounted by `app/(world)/layout.tsx` beside `WorldStageRoot`
(NOT inside the Canvas). Owns:

- `useWorldStream(policy)` — policy from `usePathname()`: `/game` →
  `'active'`, other in-group paths → `'remote'`.
- `useAvatarHeartbeat(enabled)` — gates exactly as `game/page.tsx:492` today
  (`isAuthenticated && !isGuest && !!avatar` via cached `useAuthMe()` +
  `useAvatar()`).

`app/(world)/game/page.tsx` deletes its `useWorldStream()` and
`useAvatarHeartbeat(...)` calls + unused imports. `useResearchStream()`
REMAINS on the page.

### 1b. `useWorldStream(policy: 'active' | 'remote')`

**Hard constraint:** the main effect's dependency array
(`use-world-stream.ts:541-550`) MUST NOT grow. Policy arrives via a ref
updated on every render. A `/game`↔`/cove` crossing never tears down SSE,
intervals, or session refs.

**Extract the uplink/bootstrap decision logic into a PURE module**
`apps/web/src/hooks/world-stream-machine.ts` — no timers, no fetch, no React:
`decide(state, input) → { actions, nextState }` — and unit-test it with plain
bun tests (`world-stream-machine.test.ts`). The hook wires timers/fetch/SSE
to the machine. Required machine behavior (Codex BLOCKER 1 fix):

- **One 200 ms interval, started on MOUNT** (not gated on bootstrap), owning
  ALL of: bootstrap triggering, active uploads, remote heartbeats, bounded
  409 recovery retries.
- Latches: `everActive`, `bootstrapInFlight`, `bootstrapRetryAt`,
  `recoveryInFlight`, `nextRecoveryAt`, `superseded`.
- **Join gating:** bootstrap fires only once `policy === 'active'` has been
  observed (`everActive`), respecting existing backoff. Cold `/cove`: no
  join, no SSE, no uploads. `?room=` deeplink unaffected (joins happen on
  /game where it lands).
- **Remote uplink:** at most one POST per 10 s
  (`REMOTE_PRESENCE_INTERVAL_MS = 10_000` < server `STALE_PLAYER_MS` 30 s,
  `room-registry.ts:82`), body `{ x, y, dirZ, activity: AT_COVE_ACTIVITY }`
  from a frozen ref captured on every ACTIVE-mode send. Corrected rationale:
  the cove scene keeps its own private `posX/posZ` refs
  (`cove-interior.tsx:1217-1219,1456-1457`) and does NOT write
  `avatarPositionRef`; the only cove-side shared write is the exit-midpoint
  reposition (`app/(world)/cove/page.tsx:~110-124`) — the frozen ref
  protects against that mid-remote write and any future cove code.
- **Remote→active transition:** on the first active tick, reset `lastPosRef`
  to the current position BEFORE activity derivation — the ~360 px
  entry/exit door delta must NOT produce a synthetic 'walking' + false
  heading (Codex MAJOR 1).
- **409 recovery must not depend on SSE onerror** (Codex BLOCKER 1: the
  membership gate runs only at stream OPEN — `world.ts:570-584` — an
  already-open stream survives GC, so "SSE will eventually error" is false).
  Recovery: suspend uploads, then bounded ticketed-rejoin retries from the
  machine's `nextRecoveryAt` (exp backoff, join-budget-aware ≥20 s spacing,
  capped attempts), interval keeps running throughout. `presence_superseded`
  sets `superseded` — cancels interval work permanently (existing
  `handleSuperseded` semantics preserved).
- **controlMode gates** (`use-world-stream.ts:310-311`) apply in both
  policies: nothing uploads in `explore`/`autonomous`.
- **Watch heartbeat gated:** `useWatchHeartbeat` currently fires whenever
  connected+visible (`use-watch-heartbeat.ts:35-73`) — at the cove that
  falsely signals a watching banter audience and spends paid inference
  (Codex MAJOR 3). Add an `enabled` param; pass `policy === 'active'`. Its
  own effect may depend on the gate (it is a separate hook/effect — the
  main-effect deps constraint is untouched).
- **Leave semantics unchanged:** unmount + `pagehide` beacon as today
  (`use-world-stream.ts:517-539`); unmount now means leaving the (world)
  group entirely.

`AT_COVE_ACTIVITY = 'at-cove'` lives in **`packages/shared`** (beside the
wire type at `packages/shared/src/types/world.ts:44`, update that comment),
imported by the hook, `remote-players.tsx`, and the protocol manual (Codex
MINOR 1). Rebuild the shared package if scripts consume dist.

### 1c. "at the Cove" display

`remote-players.tsx` `adaptPlayer()`: `activity === AT_COVE_ACTIVITY` →
`direction: 'idle'` (today any non-'idle' string walk-animates,
`remote-players.tsx:48-50`; `isRunning` is already false for it). Name label:
`player.name + ' · at the Cove'` (verified safe: store identity is id-based,
React keys are `p.id`, labels render via `arena-npcs.tsx:972,1609`,
`whiteSpace: 'nowrap'`). Never the word "casino" in user-facing text.

### 1d. Protocol manual + partner-surface obligations (Codex MAJOR 4+5 — full list)

- `skill-protocol.ts` co-presence section (~line 854): document `activity`
  as free-form ≤32 chars, **self-reported conventional** values `idle`,
  `walking`, `running`, `at-cove` ("clients render an 'at the Cove' presence
  tag"; it is a convention, not location-authoritative — Codex MINOR 2).
- **`PROTOCOL_VERSION` 39 → 40** (`skill-protocol.ts:364-369`; 39 is
  current, not 38) with a one-line rationale comment.
- Update the three literal test pins:
  `apps/api/src/services/__tests__/skill-protocol-onboarding.test.ts:28,169`
  and `apps/api/src/routes/__tests__/agent-paid-surface.test.ts:42`.
- ADD assertions to `skill-protocol-onboarding.test.ts` covering the
  co-presence activity semantics (the four conventional values + 32-char
  free-form rule + display meaning).
- `docs/hatcher-integration-spec.md`: reconcile to 40 at the four
  current-value locations (`:29,154,351,364` — stale at 38; v39 was the
  PayAI count-cap bump), fix the hardcoded example at `:221`, add a drift
  note for both 39 and 40.
- **Nori town-guide knowledge** (three-surface rule): extend the shared-room
  line in `packages/agent-templates/src/locations/town-guide.ts:~67` — other
  players at the cove stay visible in town with an "at the Cove" tag.
- **PARITY note** (commit body): "human path: (world)-layout route policy;
  agent path: authenticated `/api/world/position` activity (same wire);
  presence binds to caller's session/avatar; no economy change."
- `.hatcher-ref/CONTRACT.md` comparison: wire shapes unchanged — record the
  check in the notes doc.

### 1e. Server-effects review (documented in notes doc — READ-ONLY, code out of scope)

Record verbatim-verified semantics (Codex MAJOR 2): while at `/cove` in
player mode the moved heartbeat keeps (a) writing avatar position +
`lastActiveAt` (`avatars.ts:1488-1497`), (b) refreshing the sim bridge and
cancelling idle-autonomy (`avatar-state-store.ts:148-174`,
`movement.ts:29-46`), (c) re-arming the 15 s bound-agent suppression
(`avatars.ts:1556-1579`) — i.e. **cove play counts as continued human
control** (the founder-approved "body stays present, human-driven" reading;
surfaced to founder in the ship report). Also record: the 10 s remote world
uplink alone would let the 3 s controlled-launch suppression flap
(`world.ts:452-459`) — the 15 s avatar heartbeat is the load-bearing
suppressor; and the agent-body sweeper's 30-min `agentBots.lastSeenAt`
distinction (`agent-body-idle-sweeper.ts:34-45,81-125`) is untouched by this
heartbeat — "suppressed body" can still become "despawned body" after 30 min
idle; that is existing behavior, note it, change nothing.

## Item 2 — first-navigate hardening (durable-ownership design, Codex BLOCKER 2)

Root cause confirmed: module-level `navigationHandler` null until
WorldStageRoot's second effect pass; ALSO the pathname effect seeds the
initial scene request BEFORE the install effect runs, so a naive
buffer-flush hits the handler's busy branch and is swallowed.

Design — **`true` means durable ownership**:

- `stage-navigation.ts`: single-slot buffer (latest-wins) + 5 s expiry +
  install-generation counter. Stage presence is signaled by EXPLICIT
  registration: WorldStageRoot calls `markWorldStageMounted()` /
  `markWorldStageUnmounted()` (from a top-level effect that runs before the
  gated install; unmount cleanup unregisters). No `document.querySelector`.
- `requestWorldStageNavigation`: handler installed → delegate. No handler
  but stage marked mounted → buffer `{ request, expiresAt, generation }`,
  dev-warn, return `true`. Stage not mounted → return `false` (legacy
  contract).
- `installWorldStageNavigationHandler`: bump generation, then flush any
  non-expired buffer in a `queueMicrotask` ONLY if this handler is still the
  installed one at flush time; on generation mismatch keep the buffer for
  the next install (expiry still bounds it).
- **Handler busy branches must not swallow owned requests** (WorldStageRoot
  `:106-127` rework): when `pendingRequest` exists —
  - same scene as the navigation target → ADOPT: bind `navigationRef` to the
    existing request's `requestId` (its opaque midpoint then runs `onMidway`
    + `router.push`);
  - different scene → SUPERSEDE: `requestScene(target)` (the store already
    abandons a different pending request, `stage-store.ts:142-160`) and bind
    `navigationRef` to the new request.
  - `transition.phase === 'error'` → supersede likewise (a navigation click
    is a legitimate recovery).
  Return `true` only when `navigationRef` is bound (or the request stored);
  otherwise `false`.
- Expiry: buffer carries the request; on expiry WITHOUT flush, invoke
  `request.onExpired?.()` if provided; the two production callers pass
  `onExpired: () => router.push(to)` so an accepted-but-never-flushed
  navigation still lands (their existing `if (!requested) router.push`
  fallbacks stay for the `false` path).

## Item 3 — probe + soak (Codex MAJOR 6 + MINOR 3 folded in)

`apps/web/scripts/world-stage-probe.mjs`:

- **Full-lifetime request listener** attached before first `page.goto`
  (today's listener only runs during cold-asset collection and filters to
  GLB/KTX2/VRM — `:276-292`). Count by phase: POST `/api/world/join`, GET
  `/api/world/:room/stream`. Assert: cold-`/cove` joins = 0; first `/game`
  visit joins = 1; joins after first = 0; no route-correlated extra stream
  GETs.
- `navigateAndWait()` must assert the stage bridge returned `true`
  (`:163-173` currently ignores it).
- Parameterize `--loops` for the routes lane (default 30) and add
  `--lane=soak` (default 60, cap 100), writing
  `world-stage-soak-summary.json`.
- Renderer counters via `__WORLD_STAGE_PROBE__.snapshot()`: expose
  `info.memory.textures`, `info.memory.geometries`, `info.memory.texturesSize`,
  `info.memory.total`, and BOTH `info.render.calls` (cumulative) and
  `info.render.drawCalls` (per-frame) under honest names — r185 common Info,
  `Info.js:55-137`.
- Heap: force GC (`--expose-gc` / CDP `HeapProfiler.collectGarbage`) before
  BOTH the mid-loop and final samples; soak plateau gates:
  - all existing route-lane assertions;
  - textures + geometries counts equal at loop 20 vs final;
  - second-half heap growth ≤ 3%;
  - report total post-warmup growth → the P1b +12.5% gets its verdict
    (plateau = warmup tail; monotonic = STOP, leak hunt takes priority).

## Item 4 — docs same-diff

`3dStructure.md` (presence continuity + deliberate dual-GLB note),
`GameFeatures.md` (crossing keeps your body in world; "at the Cove" tag),
`ARCHITECTURE.md` (layout-owned stream, at-cove convention, v40),
`docs/hatcher-integration-spec.md` (per 1d), plan ledger P1c row,
NEW `docs/world-stage-p1c-notes.md` (inventory, 1e review, serial
verification record template, honest gaps), `deploy-status.md` on push
(orchestrator). Bump "Last Audited" everywhere touched.

## Verification gates (Codex runs 1-5 serially, records in notes; Fable re-runs all)

1. root `bun run build` exit 0; `apps/web` `bunx tsc --noEmit` exit 0.
2. `bun test` — new `world-stream-machine.test.ts` (cold-cove no-join, first
   active flip bootstraps, remote cadence, remote→active idle tick, 409
   bounded recovery, supersession terminal) + updated skill-protocol tests +
   existing suites touched.
3. Probe: `--lane=synthetic` WebGPU + `--webgl` PASS; `--lane=routes` PASS
   with new phase/network assertions.
4. `--lane=soak` (60) PASS all plateau gates.
5. `apps/api` tests for skill-protocol/agent-paid-surface green.
6. (Fable) two-tab drive with SEPARATE accounts/contexts in one room (Codex
   MINOR 4 — same-account joins evict): A sees B tagged "at the Cove" while
   B is at `/cove`, B returns and walks normally. Separate same-account
   check: supersession toast, no ping-pong. Plus `/arena` legacy smoke.
7. (Fable/staging) mock-Hatcher harness green + `agent-onboarding-smoke.ts`
   + `hosted-skill-runtime-probe.ts` (all bind: `skill-protocol.ts` touched).

## Working rules

- NO browser-automation MCP tools in the Codex run. Steps serial; wip
  snapshot commit before risky steps; markers `p1c-impl.done` /
  `p1c-impl.blocked` + report file in the scratchpad reports dir.
- No pushes, no live/spending/secret commands; Fable owns commit/push/deploy.
- `bun run dev` BANNED; local verify = `bun run build && bun run start`.

---

## v3 ADDENDUM (RE-FROZEN after Codex R2 — BINDING; supersedes conflicting v2 text above)

R2 confirmed the Item 1b machine design and the basic buffer design as sound
(see `verified correct` list in the R2 report). The following seven fixes are
mandatory amendments:

1. **Navigation ordering vs history (R2 BLOCKER 1).** The buffer entry is
   `{ request, fromPathname, routeGeneration, expiresAt }`. WorldStageRoot
   advances a route generation on every `pathname` change (registered into
   stage-navigation). At flush AND at expiry: if the route generation moved
   since buffering and the current pathname is not already the request's
   target, DISCARD silently (no navigation fallback) — the newest intent
   across stage requests and browser pathname changes always wins.
2. **Phase-aware ADOPT (R2 BLOCKER 2).** The one `onOpaque` fires ~250 ms
   into `fadingOut` only (`StageTransition.tsx:40`). Handler busy branch:
   - same scene AND transition phase `fadingOut` → ADOPT (bind
     `navigationRef` to the existing requestId);
   - same scene AND phase `awaiting`/`fadingIn`/`idle-pending` → midpoint is
     already past: run `onMidway?.()` immediately, `router.push(to)`,
     return `true` (no navigationRef);
   - different scene → SUPERSEDE via `requestScene(target)` + bind;
   - phase `error` (check FIRST) → always SUPERSEDE with a new request.
   Return `true` only when a future consumer is proven (adopted-in-fadingOut,
   executed-immediately, or new-request bound).
3. **Per-caller expiry fallback (R2 MAJOR 1).** The world-side cove entrance
   is module-scoped with no router (`arena-buildings.tsx:97,103`): its
   `onExpired` uses `useTransitionStore.getState().triggerTransition({ to:
   '/cove' ... })` (its current legacy fallback); the cove exit page caller
   uses guarded `router.push('/game')`. BOTH `onExpired` callbacks verify
   their origin route is still current before firing (rule 1 already
   discards on route movement — this is defense in depth).
4. **Machine schema frozen (R2 MAJOR 2).** State: `everActive`,
   `previousPolicy`, `nextRemoteAt`, `bootstrapInFlight`,
   `bootstrapAttempts`, `bootstrapRetryAt`, `recoveryAttempts`,
   `nextRecoveryAt`, `uploadsSuspended`, `superseded`. Async completions
   re-enter as typed events: `BOOTSTRAP_OK/FAILED`, `POSITION_409`,
   `RECOVERY_OK/FAILED`, `SUPERSEDED`. **One recovery arbiter:** the
   machine's 409 recovery and the existing SSE onerror escalation share the
   existing single `recoveryInFlight` latch — never two concurrent ticketed
   joins. `retriesRef`, `lastAttemptWasBareReopen`, and the SSE retry timer
   remain the separate downlink subsystem (NOT moved into the machine).
5. **Navigation tests (R2 MAJOR 3).** NEW `stage-navigation.test.ts`:
   handler-null buffering, generation mismatch, strict-mode
   install/cleanup/install, expiry (fires vs route-moved discard),
   latest-wins, unmount. Phase-aware ADOPT/SUPERSEDE helper extracted pure +
   unit-tested. Probe: add a deterministic cold-init hook that issues a
   bridge navigation BEFORE handler installation and asserts the final route
   lands exactly once (covers the handler-null window the routes lane never
   exercises).
6. **Backend-aware renderer counters + real `--webgl` (R2 MAJOR 4).**
   WebGL's `render.calls` is per-frame and has no
   `drawCalls`/`texturesSize`/`memory.total` (split already documented at
   `World3DCanvas.tsx:930`). Snapshot: WebGPU → lifetime calls, per-frame
   drawCalls, byte counters; WebGL → per-frame `drawCallsFrame`, unsupported
   fields `null`; record `backend` beside every sample; plateau gates skip
   byte fields on WebGL. Wire `--webgl` to actually swap `webgpu=1` →
   `webgl=1` in the probe URL (today the flag is parsed but unapplied —
   `world-stage-probe.mjs:9,19`).
7. **`useWatchHeartbeat(enabled = true)` (R2 MINOR 1)** — default parameter
   so the legacy no-arg caller `use-npc-stream.ts:14` keeps `/arena`/`/perf`
   behavior; effect deps `[connected, enabled]`.

Gate 2 additionally includes `stage-navigation.test.ts` + the ADOPT/SUPERSEDE
helper tests. Everything else in v2 stands.

---

## v4 GATE RULING (orchestrator, 2026-07-26, after the heap-naming evidence — BINDING)

Evidence: reports/p1c-heapname-report.md — the residual soak heap growth is
Three r185 WebGPU renderer-internal texture `bindGroups` Set + `Backend.data`
accumulation (Sets 1,255→2,893 loops 20→50; retainer chains terminate in
renderer privates; nothing ours). 120-loop tail slope ~0.4-0.6 MB/loop, linear.
This is the accepted cost-side of the persistent-renderer architecture (the
legacy per-route canvas freed renderer caches by paying the reload), external
to this codebase, and NOT fixable in-scope (clearing renderer privates =
banned eviction hack).

**Final soak gate set (replaces the flat 3%/15% heap gates ONLY; all other
gates unchanged and still exact):**
- scene inventories: exact zero diff (unchanged)
- renderer texture+geometry COUNTS: exact equality loop 20 vs final
  (unchanged; the final gate run must NOT enable --heap-diff — snapshot
  instrumentation may perturb late textures)
- WebGPU byte counters: final ≤ loop20 × 1.01 (v3-corrected, unchanged)
- history bounded 4, listener delta 0, all route/network/freeze assertions
  (unchanged)
- JS heap (forced-GC): second-half PER-LOOP SLOPE ≤ 0.8 MB/loop AND total
  growth ≤ 20% over 60 loops — calibrated: renderer-internal floor measured
  ~0.45 MB/loop; the original app leak ran >1.2 MB/loop and also failed the
  count/inventory gates. DWELL runs (game + cove) must stay ≤ 0.05 MB/s
  drift (time-correlated leaks still fail hard).

**Tracked follow-up (plan-ledger entry, not a code comment):** re-measure the
bindGroups growth on the next three.js upgrade (r186+ — check upstream
bind-group lifecycle fixes) and fold renderer-cache eviction into the already
planned low-end texture-eviction tier. Review trigger: P3 (kelp joins stage)
or the three upgrade, whichever first.
