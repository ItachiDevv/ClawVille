# Rung-4 Slice D — Boot-core gate: FROZEN spec REV 5 (2026-08-17)

Status: **FROZEN — Codex xhigh round 5 VERDICT: SHIP** (rounds: 19 → 15 →
8 → 2 → 0 findings; both round-4 actor-coverage blockers verified RESOLVED,
no new flaw). Implementation binds to this revision; deviations require a
spec edit + re-review of the touched section.

Rev-5 history: rounds 1-4 findings and their resolutions are tagged
throughout ([F#] round 1, [R2-F#], [R3-F#], [R4-F#]). Rev-5 changes [R4-F#]: claims/commits carry
`(kind, resourceKey)` via claimToken — only the token matching the current
resolution closes the gate / stamps readiness / credits progress (stale =
telemetry-only) [R4-F1]; `requiresDeferredAttach` open-gate semantics
corrected — open gate ⇒ RAW mount (on-time actor mounts visible and closes
the gate; the exact state table is inlined in §2a) [R4-F2]. Earlier tags
retained.

Rev-4 changelog: R3-F1 → epoch GATE-COVERAGE struct
(`{closed, coveredKind, coveredResourceKey, committed}`) +
`requiresDeferredAttach(epoch, kind, resourceKey)` — ANY actor resource that
did not participate in the closed gate (normal `none`/autonomous closure,
timeout closure, post-closure kind/resource replacement) routes through
DWA/placeholder; R3-F2 → texture claims happen at EXECUTION time with a
`ClaimHandle{token, promise, complete, fail}` (never at enqueue — the
serialized single-active warm queue would deadlock on cross-priority
owner-waits); waiters retry after owner failure; token guards
self-reentrancy; R3-F3 → land tracker includes hydration GENERATIONS
(pending at request start, revision bump on start AND terminal; settlement
prohibited while any request in flight; initial hydration pending or
completing outside the window invalidates the run); R3-F4 → land stamps
success/fallback/failure counts; measurement validity requires ZERO land
data fail-opens and ZERO GLB/source failures (product fallbacks stay);
R3-F5 → coordinator closure requires AUTHORITATIVE avatar settlement for
authenticated users (`use-avatar` surfaces error state; confirmed
401/not-found ≠ transient 5xx/network — transient stays pending until the
epoch deadline, then the uncovered-actor DWA route applies); R3-F6 → ONE
epoch-owned deadline terminalizes + FREEZES progress membership (late
results update telemetry only, never TOTAL; DONE never counts excluded
units; a render-throw VRM rejection terminalizes via the deadline, not via
a commit that can never happen); R3-F7 → `bootActorResolvedAt` stamped for
ALL kinds at resolution/closure; `bootActorReadyAt` (commit) only for body
kinds; the §5 ordering assertion is CONDITIONAL on body kinds; R3-F8 →
epoch existence is a coordinator-closure precondition via a
subscription/useSyncExternalStore bridge (GamePage mounts as a sibling of
the lazy world; the 8s deadline anchors to epoch start across warmup
restarts). Implements
`docs/perf-cold-load-rung4-handoff.md` §Slice D. Founder decisions in force:
§2b symmetric boundary · proxy-world look judged LIVE (E4) · background-tab
= visibility fuse (a).

Rev-3 changelog (round-2 finding → change):
R2-F1 → scene-level `onAfterRender` chain (Group sentinel never fires —
verified against three r185 `Renderer.js:1784/3088/3128/3654`);
R2-F2 → epoch from a render-time idempotent world-lifecycle latch, replayable
actor state; R2-F3 → single coordinator closes registration, claims never
resolve, `autonomous-remote` kind modeled; R2-F4 → `perf:player-avatar`
RENAMED `perf:boot-actor`, possessed body physically split out of ArenaNpcs,
`perfNonRendered` ownership class for the 180 sign hitboxes; R2-F5 →
`bootGateClosedWithoutActor` late-attach route through DWA; R2-F6 → full
module-scope preload audit with disposition table; R2-F7 → per-epoch
boot-stream queue + own quiet period + visibility parking; legacy-consumer
claim narrowed honestly; R2-F8 → cohort seeded with 16 static IDs, exact
cardinality in the gate; R2-F9 → renderer-keyed atomic texture claim
scheduler; R2-F10 → land completion tracker + stamp inside the measured
window (first scope cut repaired); R2-F11 → `readyFailopen == 0` required
for valid measurement; R2-F12 → stable search after
`max(streamSettledAt, landSettledAt)`, 95% upper-bound statistic retained;
R2-F13 → authenticated lane MANDATORY fail-closed, probe `--storage-state` +
`--expect-boot-actor`, absolute `bootActorReadyAt`; R2-F14 → per-unit
terminal promises for progress; R2-F15 → unlike-event ratio removed.

## 0. Goal and baseline

Reveal today (slice C live): ~9.7s median local webgpu. Pre-reveal weight to
remove: 11 GLB buildings (one all-or-nothing Suspense), 3 town props,
land trio GLB demand, TownGuide + QuestNpc, two whole-scene compiles, the
global LoadingManager barrier. Acceptance: `bootCorePresentedAt` ≤ 5s median
(authenticated 12-pair gate, §5); frame gate holds; watchdog matrix (§6);
founder proxy-world playtest (E4).

## 1. Boot-core definition

**Visual set at reveal:** sand floor · fog/lights · 11 building PROXIES +
procedural treedome · land parcel frames/signs (+ sign hitboxes, non-rendered)
· cove beacon + entrance · kelp portal · seaweed/kelp ambient · town
directory sign · click-to-move (player mode) · the ACTIVE BOOT ACTOR (§2a).

**Boot-deferred set** (streams per §2e; priorities = distSq from static boot
camera (0,600,1300), constants in `decorative-release.ts`):

| Tier | Content | Priority | Warm path |
|---|---|---|---|
| BUILDINGS | 11 GLBBuildings | `distSq − 1e14` | DWA + placeholder proxy |
| PROPS | BazaarStall, MarketplaceStall, QuestBountyPavilion | `distSq − 1e13` | DWA |
| LAND | LandShowroom, LandStructures, LandKitPieces | `distSq − 1e12` | release-gate + **land completion tracker** [R2-F10] |
| NPC (existing tier) | TownGuide, QuestNpc | `distSq` | DWA (topology §4c) |

## 2. The gate

### 2a. Boot-actor contract [F1][F2][R2-F3][R2-F5]

New module `boot-actor.ts`, epoch-keyed (§2c), replacing the LoadingManager
barrier:

- **Single coordinator.** ONE hook (`useBootActorCoordinator`, mounted in
  GamePage) has EXCLUSIVE authority to resolve the actor and close
  registration. It observes auth state + avatar query + `controlMode` and
  closes when ALL have settled (auth resolved AND avatar query non-loading
  AND the promotion effect's synchronous mode write applied — it runs after
  those effects by hook order and re-runs on their deps). Resolution kinds:
  `none` (guest/explore) · `player-vrm` · `player-glb` (from
  `avatar.modelKey`/registry `avatar_type`) · `npc-body` (possessed demo) ·
  `autonomous-remote` (body is a server-streamed `ocb-` roster entity —
  gate-equivalent to `none`; the body streams post-release exactly as
  slice C ships today, and the follow camera already tolerates its absence)
  [R2-F3]. Mode changes BEFORE closure REPLACE the pending resolution;
  closure is one-shot per epoch.
- **Loaders claim, never resolve — with exact resource identity [R4-F1].**
  PlayerAvatar inner components (VRM + GLB) and the possessed-body branch
  call `registerBootActorClaim(epoch, kind, resourceKey) → claimToken`
  (resourceKey = the exact model path) at render, and
  `notifyBootActorCommitted(claimToken)` from their post-Suspense passive
  effects. ONLY the token matching the coordinator's CURRENT resolution
  `(kind, resourceKey)` can close the gate, stamp `bootActorReadyAt`, or
  credit a progress unit; a stale token's completion (same-kind resource
  swap before closure — real: VRM inner remounts by `reg.path`, and an
  avatar response can replace the modelKey) is telemetry-only. Claims are
  REPLAYABLE epoch STATE (module map keyed by token), not consumed
  one-shots — a warmup-effect restart re-reads them [R2-F2]. VRM-class
  actors additionally await the existing bulk-parse drain contract
  (compile proof); the whitelist compile covers the group once [F19].
- **Gate await:** `awaitBootCoreDependencies(epoch)` = clips settled (§2d
  units) + actor resolution + (if kind ∈ {player-vrm, player-glb,
  npc-body}) actor committed. Overall 8s cap, fail-open, per-dep stamps +
  `bootActorKind` + ABSOLUTE `bootActorReadyAt` (performance.now at commit;
  distinct from the `bootCoreDepMs.*` durations) [R2-F13].
- **Gate coverage — the general late-actor rule [R2-F5][R3-F1][R4-F2]:**
  closure records `{closed: true, coveredKind, coveredResourceKey,
  committed}` per epoch (coveredResourceKey = the actor's model path; null
  for `none`/`autonomous-remote`/timeout closures). Exact semantics — the
  OPEN gate means RAW mount (the on-time actor must mount visible and
  commit so the gate CAN close; routing it through DWA's hidden group
  would stamp readiness while invisible and cycle presentation against
  warming):

  ```ts
  function requiresDeferredAttach(epoch, kind, resourceKey): boolean {
    const coverage = getGateCoverage(epoch);
    if (!coverage.closed) return false;          // on-time path: RAW
    return !coverage.committed
      || coverage.coveredKind !== kind
      || coverage.coveredResourceKey !== resourceKey;
  }
  ```

  Player/NPC inner components consult it (in addition to
  `isDecorativeReleased()`): a body mounting after a `none` closure, a
  timeout closure, or a post-closure kind/resource replacement (mode
  switch, avatar model change) attaches through DWA/placeholder — never
  raw. Unit tests cover BOTH legs: on-time body mounts raw and closes the
  gate; post-closure/uncovered body defers. The §6 watchdog rows assert
  the routes, including the pre-closure same-kind `path-A → path-B` swap
  (A's stale token cannot close coverage for B) [R4-F1].
- **Closure requires authoritative avatar settlement [R3-F5]:** for an
  authenticated user the coordinator closes only on a SETTLED avatar
  answer — confirmed not-found/401 (close `none`) or success (close body
  kind). `use-avatar` is extended to surface error state (today it
  swallows every error into `avatar: null`); a transient 5xx/network error
  keeps the resolution PENDING until the epoch deadline, which then closes
  uncovered (fail-open) — the late successful retry routes through
  `requiresDeferredAttach`.
- **Stamps [R3-F7]:** `bootActorResolvedAt` at resolution/closure for ALL
  kinds; `bootActorReadyAt` at commit for BODY kinds only. The measurement
  ordering assertion (§5) is conditional on body kinds.
- **Epoch precondition [R3-F8]:** epoch existence (created by the lazy
  world's render latch) is a closure PRECONDITION, bridged to the
  coordinator via subscription (`useSyncExternalStore`) so a coordinator
  mounted before the world exists re-runs when the epoch appears; the 8s
  deadline anchors to EPOCH START and survives warmup-effect restarts.

### 2b. Scoped scans/compile/warm-draw [F4][F5][R2-F4]

`BOOT_CORE_CHUNKS`: `terrain`, `buildings`, `land-parcels`,
`land-salvage-nodes`, `kelp-forest`, `seaweed`, `kelp-forest-portal`,
`cove-beacon`, `cove-entrance`, `town-directory-sign`, `boot-actor`,
`click-to-move`, `land-founder-apartments`, `land-ring-decorations`.

- **Chunk topology changes [R2-F4]:** `perf:player-avatar` is RENAMED
  `perf:boot-actor`. The possessed/demo body is physically SPLIT out of
  ArenaNpcs: a new `BootActorBody` mount inside the `perf:boot-actor` group
  renders the `PLAYER_NPC_ID` body (ArenaNpcs skips that id); ambient
  ancestors are never whitelisted, so hide/drift semantics stay sound.
  `LandParcelSignHitboxes` root gets `userData.perfNonRendered = true`
  (they are `visible=false` click targets, 180 meshes) and mounts under the
  land-parcels group; the inventory SKIPS `perfNonRendered` subtrees.
- **Inventory:** traversal from the registered world-slot root; collects
  perfChunk nodes + mesh-bearing subtrees under NO chunk (excluding
  perfNonRendered). Non-whitelisted mesh-bearing roots → hidden
  (save/restore) across scans/compile/warm-draw [F4], stamped as
  `bootCoreDriftChunks` (probe-invalidating) + console.warn.
- Scans traverse whitelisted groups only; ONE compile loop, once per group;
  shared texture-slot constant with `deferred-warm.ts` [F19]. Warm draw
  runs with the drift set hidden.
- `ClickToMove` gets `perf:click-to-move` + its per-frame `slice()`/array
  allocation fix (RULE 6 drive-by) [F5].

### 2c. BOOT_CORE_PRESENTED — epoch-owned, render-proven [F6][F7][R2-F1][R2-F2]

- **Epoch:** acquired by a render-time idempotent latch in
  `WorldSceneContents` (the proven `beginWorldVrmParseEpoch` pattern —
  replay-safe), NOT in the restartable warmup effect. The warmup effect
  ADOPTS the current epoch; renderer-generation restarts reuse it; all
  milestone/dep/claim state is per-epoch module state with getters [R2-F2].
- **Render proof [R2-F1]:** chain the STAGE SCENE's `onAfterRender`
  (three r185 common `Renderer` fires the scene-level callback after
  render completion — `Renderer.js:1784`; Groups never receive object-level
  callbacks). Install: save prior handler, wrap, restore on teardown.
  Qualification per firing: world slot ACTIVE + expected world camera +
  current epoch + predicate. Live-verify both backends before any batch —
  a silent sentinel strands the overlay on the 10s fallback, which the
  fault-injection watchdog case must catch.
- **Predicate:** shared `revealConditionHolds({ requireSeaOverlayGone })` —
  boot-core variant keeps `!document.hidden`, `__W3D_READY`, and the
  stage-curtain check; omits only the sea overlay [F6]. 2 consecutive
  qualifying post-render firings → stamp `bootCorePresentedAt` + module
  flag (window mirrors are write-only telemetry).
- `SeaLoadingScreen` reads module getters; its mount re-zero never touches
  milestone/dep state [F7]. Armed from ALL resume paths; unit tests:
  stage-before-loader, loader remount, epoch adoption across warmup restart.

### 2d. SeaLoadingScreen + progress units [F8][F18][R2-F14]

- Dismissal: `forceReady || isBootCorePresented()`; bounded fallback —
  `__W3D_READY` true + milestone unstamped for >10s of VISIBLE time
  (visibility-fuse pattern, terminal, disposed on dismissal) → warn +
  dismiss. 45s visibility fuse unchanged.
- Download band units with REAL terminal signals [R2-F14]:
  `vrm-character-animator.ts` exports THREE per-clip settled promises
  (allSettled; rejection = terminal fail-open unit, DONE still increments);
  `boot-actor.ts` exposes actor-byte-fetch settled + actor-commit as two
  units. **One epoch-owned deadline governs membership [R3-F6]:** TOTAL is
  exposed at coordinator closure (5 for body kinds, 3 otherwise) and
  membership FREEZES at the epoch deadline — unresolved fetch/commit units
  terminalize as timed-out/failed at that moment (a render-throw VRM
  rejection, which never reaches a commit effect, terminalizes THIS way),
  DONE increments on any terminal outcome, late results update telemetry
  only and never mutate TOTAL, and DONE can never count a unit excluded
  from TOTAL. Counters epoch-keyed. Tests: late registration, per-unit
  rejection, deadline terminalization + freeze, epoch swap.

### 2e. Boot-stream eligibility — per-epoch, visibility-parked [F8][R2-F7]

`onBootStreamEligible(listener, priority)` in `decorative-release.ts`:

- Eligibility = decorative release fired AND `BOOT_CORE_PRESENTED` stamped
  AND sea overlay + stage curtain actually gone AND `!document.hidden`.
  Fail-open: release fired + 10s VISIBLE time without milestone → eligible.
- **Own per-epoch queue** with its OWN first-drain quiet period (1.5s from
  eligibility, not from the legacy global `firstDrainDelayDone` flag — that
  flag can be consumed by legacy consumers while hidden) [R2-F7]. Delivery
  PARKS while `document.hidden` (drain checks visibility; re-arms on
  `visibilitychange`).
- Scope honesty [R2-F7]: LEGACY rung-3/slice-C consumers keep shipped
  plain-release behavior INCLUDING the hidden-tab 45s deadline path —
  unchanged, invisible-content-while-throttled, accepted when shipped. The
  watchdog background-tab assertion covers SLICE-D consumers only (§6
  wording matches).

## 3. Streaming consumers

- `DeferredWarmAttachment` `placeholder` prop (sibling outside the hidden
  group). Success path = atomic swap (warmed before visible). Warm
  FAIL-OPEN keeps product fail-open (content shows, may hitch once) but is
  stamped `readyFailopen` per unit and REJECTS the measurement run
  (`readyFailopen == 0` required for validity — a fail-open on the probe
  box is investigated, never averaged away) [R2-F11].
- Per-building `<BuildingStreamBoundary>` ErrorBoundary → PERMANENT proxy on
  load rejection, reported `failed` (terminal) to the cohort [F11]. Same
  for props/NPCs.
- Labels: proxy label = distinct id (`building-proxy-label-*`); real label
  hidden via `attachmentVisible` until flip; real click/raycast gated on
  attachment; proxy handles clicks meanwhile [F10].
- **Preload audit [F3][R2-F6]:** module-scope demand audit with disposition,
  implemented as a table in the results ledger. Known set: buildings loop
  (arena-buildings) → behind eligibility; manifest tier-1 buildings loop →
  behind eligibility; TownGuide `useGLTF.preload` → REMOVED;
  bazaar/marketplace/pavilion byte-warms → behind eligibility; QuestNpc
  crayfish preload (`quest-npc.tsx:48`) → behind eligibility;
  `player-avatar.tsx:142` unconditional lobster preload → replaced by
  actor-resolved demand (coordinator kind drives which bytes warm);
  `arena-npcs.tsx:382` default-species preload → behind eligibility (the
  possessed body is a Milady VRM per `npc.ts:806` — the lobster warm is not
  actor-critical). Implementation greps ALL of
  `useGLTF.preload|preloadKTX2Bytes|preloadVRMBytes` at module scope in
  world-reachable modules and disposes each; the ledger table is the proof.
  Boot fetch order: clips + resolved actor bytes first; decorative bytes
  only after eligibility.
- Topology surgery for internal-Suspense components (TownGuide, QuestNpc,
  props): split outer logic vs `<XInner>` resource child; boundary →
  Suspense → DWA → inner; internal boundaries deleted [F9].

## 4. Cohort + land tracker + texture scheduler

### 4a. Stream cohort [F13][R2-F8]

`boot-stream-cohort.ts`, seeded at EPOCH START with the exact 16 static IDs
(11 buildings + 3 props + town-guide + quest-npc). Wrappers mark
`mounted → loading → warm-pending → terminal(ready-warmed |
ready-failopen | failed)` via commit effects (never render-time — React may
abandon renders). Registration closure is the SEED (static), not a timer.
`streamSettledAt` stamps when all 16 are terminal. Gate validity requires
`terminalCount == 16` with exact ID equality + per-terminal-kind counts
stamped. A `showNpcs=false` boot simply never settles → run invalid →
surfaced as rig misconfig, never a silent pass.

### 4b. Land completion tracker [R2-F10][R3-F3][R3-F4]

The land trio (no DWA) reports a `landSettledAt` stamp built from
HYDRATION GENERATIONS, not workload sampling [R3-F3]: every initial AND
refresh data request marks pending at REQUEST START (revision bump) and
terminal at completion (revision bump); settlement is PROHIBITED while any
request is in flight. Per component: LandStructures = hydration generation
terminal + every slot boundary resolved; LandShowroom = all slot
boundaries resolved; LandKitPieces = public-pieces hydration generation
terminal + source loads settled + merge revision quiescent ≥1s (an empty
pre-hydration snapshot can no longer stamp — the initial request opened a
generation before the component could look settled). One combined stamp
(max), revision-aware until probe capture ends. An initial hydration still
pending, or completing outside the window, INVALIDATES the run.

**Failure accounting [R3-F4]:** the tracker stamps
`land: { dataOk, dataFailed, glbOk, glbFallback, glbFailed }`. Product
behavior keeps every fallback (primitives for failed GLBs, nothing for
failed sources). MEASUREMENT validity requires `dataFailed == 0`,
`glbFallback == 0`, `glbFailed == 0` — a lighter-than-real land workload
can never serve as ship evidence. Both stamps must land inside the
measured window (§5); if the dev box cannot fit land inside 10s, the
window is widened DELIBERATELY as a recorded rig change, never silently.

### 4c. Texture claim scheduler [F12][R2-F9][R3-F2]

Extend `deferred-warm.ts`'s existing renderer-scoped pattern
(`WeakMap<renderer, …>`) into an ownership scheduler with claims taken at
EXECUTION time only — NEVER at enqueue [R3-F2]: a claim held by a queued
(not yet active) job in the single-active serialized warm queue would let
a higher-priority job await an owner that can never run (deadlock).
Protocol: when a job (DWA warm executing in the active slot, or a scanner
upload pass — the two systems run on independent schedulers, so an
execution-time await never blocks the owner's own queue) is about to
upload a texture it calls `tryClaim(renderer, texture)` →
`ClaimHandle { token, promise, complete(), fail() }` when acquired, or the
existing owner's `promise` to await instead of double-uploading. The token
guards self-reentrancy (an owner re-checking its own claim is recognized,
never self-awaited). `fail()`/cancellation releases the claim and REJECTS
the promise; waiters observing a rejected owner RETRY their own claim.
Renderer replacement gets fresh ownership automatically (WeakMap key).

## 5. Measurement — fail-closed [R2-F12][R2-F13][R2-F15][F15][F16]

- Probe additions: `--storage-state <file>` (pre-navigation CDP
  cookie/localStorage injection) + `--expect-boot-actor <kind>`. A run is
  INVALID unless `bootActorKind` matches AND `bootActorResolvedAt` is
  finite; for BODY kinds additionally
  `bootActorReadyAt ≤ bootCorePresentedAt` [R2-F13][R3-F7] —
  `none`/`autonomous-remote` runs assert resolution ordering only
  (`bootActorResolvedAt ≤ bootCorePresentedAt`), since they have no commit.
- **Headline lane (MANDATORY for SHIP): authenticated VRM player**, 12
  counterbalanced pairs, local API `:4001` fixture account. If the
  authenticated fixture cannot be established, the slice is BLOCKED — no
  guest substitution [R2-F13]. Secondary evidence: 3-run authenticated GLB
  lane; watchdog singles cover guest, npc-body, autonomous.
- Candidate run validity: finite `bootCorePresentedAt`, `streamSettledAt`,
  `landSettledAt`; drift empty; cohort 16/16 exact; `failed == 0`;
  `readyFailopen == 0`; land `dataFailed == glbFallback == glbFailed == 0`
  with no hydration pending at capture end [R3-F3][R3-F4];
  `(max(streamSettledAt, landSettledAt) − revealMs) ≤ window; §2b
  symmetric bounds (`polled-reveal-v2`).
- PRIMARY: candidate `bootCorePresentedAt` median ≤ 5000ms.
- Frame gate: retain the existing one-sided 95% upper-bound statistic on
  paired `framesOver100` diffs (NOT sample median) [R2-F12]; stable-3s
  search runs only AFTER `max(streamSettledAt, landSettledAt)` and the
  interval must fit inside `[reveal, reveal + window]` [R2-F12][F15];
  absence = run-level frame-gate fail.
- NO candidate-vs-baseline unlike-event ratio anywhere; report candidate
  `streamSettledAt − revealMs` and `landSettledAt − revealMs`
  distributions + absolute bounds only [R2-F15].
- Pairs: exactly 12 usable; an invalid run invalidates its PAIR; pairs
  re-run counterbalanced [F16]. Rig hard rules unchanged.

## 6. Watchdog matrix

| Case | Assertion |
|---|---|
| Authenticated VRM player (headline) | actor claims/commits; `bootActorReadyAt ≤ bootCorePresentedAt`; body visible at reveal |
| Authenticated GLB player | same, kind `player-glb` |
| Guest explore | kind `none`; 3-unit progress; reveal ≤ 5s |
| NPC possessed body | kind `npc-body` under `perf:boot-actor`; compiled once |
| Autonomous | kind `autonomous-remote`; reveal unblocked; body streams post-release (slice-C shipped behavior) |
| Mode transition before closure | resolution replaced, single closure |
| Pre-closure same-kind resource swap (VRM path-A → path-B) | A's stale claimToken is telemetry-only; gate closes only on B's own commit [R4-F1] |
| Mode transition after closure (any: none→player, player→npc, avatar model change) | new body's `(kind, resourceKey)` is uncovered → `requiresDeferredAttach` routes it through DWA/placeholder [R3-F1] |
| Avatar query transient failure at boot | resolution stays pending → deadline closes uncovered; the retry's body attaches via DWA [R3-F5] |
| Forced warmup error / renderer recovery | milestones armed on error paths; overlay dismisses; stream runs |
| Background-tab boot | milestone parks; SLICE-D streams park (per-epoch queue visibility gate); legacy consumers keep shipped behavior (declared) [R2-F7] |
| SPA round-trips | epoch survives; monotonic; no re-gate/re-stream |
| Loader remount / stage-before-loader | module getters unaffected [F7] |
| Cold `/cove`, `/kelp` | no gate code; no building bytes before their reveals (eligibility never fires there — probe network assert) |
| Warm cache | fast path unchanged semantics |
| Parity | render-timing only; PARITY note in commit body |

## 7. Files touched

As rev 2 plus: `boot-actor.ts` coordinator/claims · `BootActorBody` split in
`arena-npcs.tsx` · `land-parcels.tsx` (hitbox ownership) · land trio settled
stamps · `deferred-warm.ts` claim scheduler · probe `--storage-state`/
`--expect-boot-actor` · gate statistics preserved. Tests: milestone/epoch,
coordinator closure + replacement, cohort cardinality, claim scheduler,
label ownership, progress units. `3dStructure.md` same-diff;
`deploy-status.md` at push.

## 8. Declared boundaries (revised — both round-2 objections absorbed)

- Land trio: release-gated WITHOUT per-resource warms, BUT with the
  hydration-generation tracker + failure accounting inside the measured
  window + stable-search-after rule — both escape hatches closed (late
  work [R2-F10][R3-F3], missing/lighter work [R3-F4]). Per-resource warms
  remain the follow-up if the frame gate fails on land.
- Legacy consumers: plain-release semantics preserved EXPLICITLY including
  their hidden-tab deadline behavior (shipped in rung 3/slice C); the
  strong background invariant binds slice-D consumers only [R2-F7].
- Proxy visual styling unchanged — founder judges live (E4).
- Slice E boundary unchanged.
