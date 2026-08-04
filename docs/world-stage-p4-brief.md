# FROZEN SPEC v16 — P4: `/activity/[activityId]/[roomId]` (Reef Race + Bumper Shells) joins the persistent world stage

**Status:** FROZEN (v16, revised after Codex REJECT rounds 1-14 + the round-12 strip-deletion ruling and the round-14 residual ruling). Author: Copus Team (Opus 5 MAX).
**Framework anchor (v9, R8-B2):** `apps/web/package.json:40` requests `"next": "^16.2.0"`; the
lockfile resolves **`next@16.2.3`**. Every claim in this spec about FRAMEWORK behavior is stated
against that resolved version, because v8 asserted a Next history/hook behavior without checking it
and built three mechanisms on the false premise.
**Source-audit anchor:** `C:\Users\itachi\Documents\Crypto\cv-covefreeze`, branch
`feat/world-stage-p3-kelp`, commit **`a156e3c0`**. Every file:line claim in this spec was read at
that commit via `git show a156e3c0:<path>` and should be re-checked the same way.
**Baseline honesty (R3-m2, corrected):** v1-v3 said `a156e3c0 == origin/staging`. **That is no
longer true and the claim is withdrawn.** P3 implementation commits are landing on this same branch
concurrently (the worktree tip was `a99c84b9` at the round-3 audit), and `origin/staging` advanced
via the 2026-07-29 promotion merge. `a156e3c0` remains the **frozen source-audit anchor** for this
spec and is an ancestor of the tip; do NOT re-baseline these audits onto the moving tip, and expect
the implementer to rebase the diff, not the citations.
**Parent plan:** `docs/persistent-world-canvas-plan-2026-07-24.md` (ledger row P4).
**Stacked on:** **P3 v4** (`world-stage-p3-brief.md`, same directory; P3 v2 preserved at
`world-stage-p3-brief.v2.bak.md`). Every stacked API in this spec is quoted from **P3 v4**, not the
rejected P3 v2 shapes and not P3 v3. **The v3→v4 delta P4 depends on** (R2-m1): §2h rule 8 gains the
`stagePendingSceneId === null` conjunct (making rule 9 reachable) and rule 4's PROCEED/supersede
semantics are pinned; §2i becomes one-token-per-slot-generation with a live `isCurrent` ownership
ref and abort-without-`reportResetComplete`; §2e reads "Ten steps (0-9)"; and the inherited test
total is **97** (57 + 15 + 25). P4's `bufferedPathname` amendment (§1b) touches only rules 3 and 4
and disturbs none of that. P3-as-landed therefore provides: `lib/three/player/{player-input,
player-motion-policy,player-capability-mask,player-intent,player-capability-controller}`,
`lib/three/kelp-activation.ts`, `lib/three/kelp-walkin-guard.ts`,
`world-stage/{stage-renderer-status,StageSlotErrorBoundary,StageCanvasErrorBoundary,
stage-warmup-entry-manager}`, `readWorldStageNavigationSnapshot()`, `SlotCapabilityProvider`,
`PROTOCOL_VERSION` **42** (R9-m1: P3 v4 FROZE 41, but P3 LANDED as 42 after the wallet slice consumed 41 — this line states what P3 provides, so it tracks the landed value; the frozen-text quotes elsewhere keep 41), and `world-stage-probe.mjs --lane=routes --pair=cove|kelp`.

Every symbol, path, line number, and behavior claim below was read from the live tree.

---

## EXECUTIVE SUMMARY

1. **Reef Race cannot render inside the shared stage canvas.** The stage is always a
   `WebGPURenderer` (node pipeline; `forceWebGL` only selects its WebGL *backend*), and reef's
   headline water is a raw GLSL `ShaderMaterial` that three r185's node library has no mapping
   for — it degrades to a bare `NodeMaterial`. Reef's bloom is a WebGL-only `EffectComposer` that
   additionally seizes the canvas-global render loop. §0 is the forensics; Codex round 1
   independently verified this pillar as sound.
2. **P4 therefore ships the OVERLAY-SLOT model:** the ROUTE joins `app/(world)/`, an `activity`
   stage slot is registered with deliberately EMPTY in-canvas content, and both activities keep
   their own room-keyed `<Canvas>` in the page layer above a paused stage — reef `key={roomId}`, bumper `key={canvasKey}` (`${roomId}-${spectatorCamMode ?? 'chase'}`). Returning to `/game`
   becomes a fade; entering still boots the (small) activity canvas.
3. **FOUNDER-RULING EXCEPTION, stated here because it is a governance call and not a code
   consequence.** The activity input path (`useActivityInput.ts`) is a **30 Hz wire controller
   with latched one-shots**, not a per-frame avatar sampler; rebasing it onto P3's rAF-driven
   `player-input.ts` sampler would couple wire input rate to frame rate on the Iris Xe floor and
   would break the sub-send-interval tap latch. P3 v4 OQ-3's non-binding read was that the vehicle
   seam shares `player-input.ts`; this spec **partially** satisfies that: commit **P4d** extracts
   a genuinely neutral `attachHeldKeyListeners` primitive into `player-input.ts` that BOTH the
   avatar controller and the activity keyboard effect consume, while the key→action-bit mapping
   and the 30 Hz send loop stay activity-specific. **The founder may drop P4d and accept
   "shared reset registry only"** — that alternative is OQ-6.
4. Riskiest residual: two live GPU contexts during a match with the world's textures resident, on
   the Iris Xe floor. §6.9 measures it with an OS-level GPU counter; the named fallback is
   world-slot eviction.

---

## REVISION LEDGER — round 1 (Codex REJECT)

Every finding was independently re-verified against live code before acceptance. **There is no
DISAGREEMENT section**: all findings are real. One is **ADOPTED DIFFERENTLY** (with rationale),
and re-verification surfaced one additional defect the critique did not raise (marked SELF).

| # | Finding | Disposition |
|---|---|---|
| **B1** | `ActivityCanvasReadyProbe` as native `useFrame(...,2)` flips R3F's canvas-global `internal.priority` and disables Bumper's ONLY renderer → black canvas | **ACCEPTED.** Verified: the only positive-priority `useFrame` in the whole `activities/` tree is `surf-bloom.tsx:100` (`}, 1);`); reef's others are `-1`/`-2`; Bumper's three (`:148`, `:283`, `:425`) are all default. Probe moved to **priority 0** (§2c), counts two callbacks, keeps `queueMicrotask` — verified safe because `update()` in `events-358c3764.cjs.dev.js:16022-16046` runs the subscriber loop and the auto-render inside ONE synchronous function, so a microtask queued from a subscriber drains after the render. Added the `gl.info.render.calls > 0` draw assertion (§6.2). |
| **B2** | The return fade can reveal the still-mounted opaque activity page; voluntary WS leave timing is unbounded | **ACCEPTED**, with the exact mechanism now pinned: `StageHostedWorldScene.tsx:35-38` acks a RESIDENT world READY **synchronously** in the effect that observes the new generation (`warmedOnceRef.current` is true after the first visit), so the fade-in gate clears in ~1-2 frames while `router.push` at `WorldStageRoot.tsx:248` waits on an unbounded RSC/chunk commit. Froze the **outgoing-overlay handoff contract** (§2d): new `WorldStageScene.overlayOpaque`, a request-scoped `outgoingOverlay` store field, a fade-in gate extension scoped to the request that set it, and a 10 s force-clear. §8.4 restated truthfully. **P4-specific:** cove's page is transparent and canvas-free after P1b, kelp's after P3b-2 — the activity page is the FIRST held page that is opaque and canvas-bearing. |
| **B3** | A once-per-Canvas ack cannot satisfy a new generation (watchdog retry, same-scene request, renderer recovery) and has a cold-deep-link ordering hole | **ACCEPTED.** Verified `requestScene` mints a generation on EVERY request incl. same-scene (`stage-store.ts:167-179`), `retryStageScene` too (`:195-218`), and `ackReady` rejects non-matching generations (`:259-281`). Replaced the once-fired callback with a **room-scoped painted latch + a live subscription to `(pendingGeneration, recovery.count)`**, expressed as the pure ordered-rule function `decideActivityReadiness` (§2b, §5h). The subscription closes the cold-deep-link ordering hole by construction. |
| **B4** | The `next/dynamic` activity-scene chunk failure has no terminal ack and no page-owned recovery surface | **ACCEPTED.** Added `ActivitySceneErrorBoundary` in the page layer with a `retryNonce` remount, `.catch(log→rethrow)` on both dynamic factories (`page.tsx:45-93`), the failure panel registered as a **terminal branch** (readiness rule 3 ⇒ acks), and a matching activity-canvas `webglcontextlost` surface (§2i). *(v3: this row records the round-1 decision as taken; §2i's mechanism and the rule number were both revised in round 2 — see R2-B2/B2b/B2c and §5h, where the terminal rule is now rule 4.)* |
| **B5** | Frozen P4 was stacked on P3 **v2**'s rejected boundary API | **ACCEPTED.** Rebased on **P3 v4** throughout (v2 said "v3"; corrected in v3 per R2-m1). `StageSlotErrorBoundary` takes `resetKey={`${activityGeneration}:${recoveryCount}`}` (P3 v4 §2k — boundary shape at lines 728-748, the kelp registration's `resetKey` at line 761), never a React key; the activity runtime-crash DOM flag clears on the same `resetKey`; the exit guard consumes `readWorldStageNavigationSnapshot()` (P3 v4 §2h, snapshot export at lines 521-532) instead of inventing a second mechanism; the healthy-identity and recovery-reset tests are inherited (§6.2). |
| **B6** | `WorldStageRoutePath` rejects P4's own `/game?quickQueue=…` hrefs | **ACCEPTED.** Split into `WorldStagePathname` (what the parser returns) and `WorldStageHref` (what navigation accepts), with the runtime `new URL(...).pathname` parser as the sole authority and a URL matrix test (§2a, §6.2). Also propagated: `WorldStageNavigationSnapshot` gains `bufferedPathname`, and `decideKelpWalkIn` rules 3/4 switch to it — a declared P4-amends-P3 edit (§1b). |
| **M1** | The `suspended` presence state is not specified deeply enough to implement safely | **ACCEPTED as a finding; ADOPTED DIFFERENTLY as a fix.** Verified the critique's premise exactly: `WorldStreamMachineAction` has no stream action (`world-stream-machine.ts:26-31`) and `openStream` is a bootstrap/onerror side effect (`use-world-stream.ts:413-531`, `:554`). Rather than widen a P1c-landed, tested state machine, **P4 keeps `WorldPresencePolicy` at `'active' \| 'remote'` unchanged** and makes the downlink an orthogonal third parameter governed by the pure `decideWorldDownlink` (§2k, §5e). Rationale: strictly smaller blast radius, the machine's tested transitions are untouched, and it is independently revertable as commit **P4c**. Every question the critique listed is answered in §5e. |
| **SELF-A** | The critique's proposed widening would have introduced a latent bug it did not name: `decide()`'s TICK branch pushes `RESET_ACTIVE_POSITION` only when `state.previousPolicy === 'remote'` (`world-stream-machine.ts:93`). A `suspended → active` return would NOT reset `lastPosRef`, so the first `UPLOAD_ACTIVE` after returning from a match would compute movement against a stale pre-match anchor. | Moot under the adopted design (policy never leaves `'remote'`), and recorded here as evidence for the redesign rather than as a criticism. |
| **M2** | The per-room table omits page/HUD state that `Canvas key` never controlled | **ACCEPTED.** Verified `shortCode`'s `useState` initializer (`page.tsx:112-114`) does not re-run on a `roomId` change. Added an explicit **`ActivityRoomRuntime` subtree keyed `${activityId}:${roomId}`** (§2g) so isolation stops depending on undocumented App Router remount identity, extended §5c with every page/HUD row, and extended the probe's `roomIsolation` block (§6.6). **Retracted the false "AudioContext now better" claim** — `lib/activity-audio.ts` is already a module singleton and SPA navigation never unloads modules. |
| **M3** | Context-loss isolation and total GPU-memory measurement are not gated | **ACCEPTED.** Verified `readStageRendererCounters()` returns `texturesSizeBytes: null, memoryTotalBytes: null` on the WebGL backend (`WorldStageCanvas.tsx:512-522`) and that `performance.memory` is JS heap only. Added the OS-level GPU-memory lane, a max-live-context assertion across 30 re-keys, and independent `WEBGL_lose_context` drills on each canvas proving only the owning recovery domain reacts (§6.9, §6.11). |
| **M4** | The input conclusion is technically sound but does not satisfy the stated ruling; and the claimed executive-summary exception did not exist | **ACCEPTED.** Added a real `## EXECUTIVE SUMMARY` (above) carrying the exception verbatim, and specced commit **P4d** — the neutral `attachHeldKeyListeners` extraction into `player-input.ts` consumed by both controllers (§2l). The registry-only alternative is OQ-6 for an explicit founder ruling. |
| **M5** | Protocol propagation misses P3 v4's conventional-value assertion, and the four `hatcher-integration-spec.md` numbers are LIVE references that must not blindly rewrite historical ledger entries | **ACCEPTED.** §1e now widens the conventional-value assertion for `at-activity` and §7 states the preserve-history rule. |
| **m1** | "`grep` for `ShaderMaterial` in `three.webgpu.js` returns zero" is false — it is re-exported from core on line 7 | **ACCEPTED.** Verified both: line 7 imports `ShaderMaterial` from `./three.core.js`; the **quoted-literal** form `'ShaderMaterial'` (the `addMaterial` key form) has **count 0**. §0.1 restated precisely. |
| **m2** | The 35/11 plain-`three` import counts are not reproducible | **ACCEPTED.** Re-counted by import STATEMENT: reef **27** `from 'three';` + 10 `three/examples/*`; bumper **6** + 2; `activities/shared` **2**. The only `three/webgpu` string in the whole tree is the COMMENT at `BumperShellsScene.tsx:8`. §0.1 corrected and now cites the qualitative fact plus the verified zero. |
| **m3** | `RenderPass` does not necessarily keep a stale camera — the composer `useMemo` is keyed `[gl, scene, camera]` | **ACCEPTED.** Verified `surf-bloom.tsx:74`. Claim retracted from §0.2; it was never load-bearing (the canvas-global takeover is fatal on its own) and is moot under the overlay model. |

**Everything the critique verified CORRECT is carried forward untouched**, including: the `§0`
renderer pillars, `OrbitControls` DOM ownership (`BumperShellsScene.tsx:267`), page-unmount WS
cleanup (`useActivityWs.ts:311-333`), server-side duplicate-result suppression
(`reward-pipeline.ts:503-511`), `canvasMountCount` being stage-specific
(`WorldStageCanvas.tsx:686-700`), the pointer contract (`globals.css:274-285`), the two-segment
pathname parser's runtime safety, cold-deep-link asset isolation, and the force-dynamic layout
requirement.

**Scope delta vs v1:** three new pure modules (`activity-readiness.ts`,
`world-downlink-policy.ts`, plus the P4d primitive), one new page-layer boundary, one new
`WorldStageScene` field, one new store field + gate, an `ActivityRoomRuntime` keyed subtree, and
a P3-amending `bufferedPathname`. Commits: 2 → **4**.

**Scope delta v3 → v4** (all of it round-3 repair, none of it new feature):
a fourth pure module `stage-scene-id.ts` carrying `sceneIdForPathname` / `stagePathnameFromHref` /
the new `stageDestinationKey` / `roomKeyFromPathname` (§2a); destination-aware comparisons in
`WorldStageRoot`'s children-swap effect and `handleTransitionOpaque` plus one
`pendingDestinationKeyRef` (§2m, R3-B1 + SELF-C); an additive `leaveAndClose()` on `useActivityWs`
and the recovery surface reduced from three actions to two (§2d item 4, R3-B3); `pendingReopen` on
the downlink input, one `invalidateStream()` primitive, and a per-handler triple guard (§2k, R3-B2);
one deleted acceptance test and one retracted known-defect claim (R3-M1 + SELF-E); and a mechanical
diff-scope gate in §6.1. **Test count: deletes 1 and adds 17, net +16 — 129 → 145** (6 scene-id +
6 overlay/navigation + 5 downlink; R4-M1 corrected the two contradictory statements of this line).

**Scope delta v4 → v5** (all of it round-4 repair of v4 REGRESSIONS — see the round-4 ledger; no new
feature, no new commit, no protocol change):
`WorldStageRoot` gains an `openedMidpointRef` opaque-lineage record and the children-install rule is
rebuilt around it, because v4's `destinationKey === displayedKey` conjunct compared two operands
that are never in phase and would have wedged `/game`↔`/cove` and `/game`↔`/kelp` (§2m, R4-B1 +
SELF-F); pending equality and `decideStageNavigationOwnership` become scene **plus** destination, and
the superseded destination's parked navigation is cleared (§2m, §2n, R4-B2 — this is the one
genuinely additive change to a P3-landed shared file, declared in §1b); the downlink splits
`dropFailedSource()` from `invalidateStream()` and introduces an `activeRetryToken` so an ordinary
enabled error can still recover, with `pendingReopen` redefined as `activeRetryToken !== null` and
rule 2 gaining `!pendingReopen` so the 3s/6s/12s backoff is respected (§2k, R4-B3 + R4-B4). Test
count: **deletes 1 and adds 23, net +22 — 145 → 167** (6 R4-B1 overlay + 3 R4-B2 overlay + 9
downlink + a new 5-case ownership suite).

**Scope delta v5 → v6** (round-5 repair of two pre-existing ownership races, plus seven editorial
fixes; no new feature, no new commit, no protocol change, **no deletions**):
`WorldStageRoot` gains an `issuedCommitRef` recording every navigation the moment
`commitStageNavigation` issues it, so a router commit that lands after its destination was
superseded is recognised and ignored instead of re-minting a stale destination over a newer one
(§2m, R5-B1); `WorldDownlinkInput` gains `recoveryInFlight`, consumed by **rule 2 only**, and the
retry continuation distinguishes a BUSY recovery from a FAILED one by re-arming behind it rather
than bare-opening or returning (§2k, R5-B2 + SELF-G); the probe snapshot exposes
`committedStageNavigations` so §6.5's history test is implementable (R5-m2); and four prose
corrections land — the rejected tautology argument is reframed as an ownership-contract pin in both
surviving places (R5-m3), the retry-epoch passages stop calling an epoch "stale" that
`dropFailedSource` deliberately leaves alone (R5-m4), the CLOSE summaries name the retry token
(R5-m5), and the R4-B1 direction claim is narrowed to what §6.2 actually asserts (R5-m6). Test
count: **deletes 0 and adds 10, net +10 — 167 → 178** (4 overlay + 6 downlink; v6 declared 177, off
by one because SELF-G's two-case bullet carried no weight — R6-m1).

**Scope delta v6 → v7** (round-6 repair, and the round where two point fixes become two INVARIANTS —
see the round-6 ledger; no new feature, no new commit, no protocol change, no deletions):
v6's single `issuedCommitRef` slot is REPLACED by the **navigation issue ledger** (§2m-A,
INVARIANT N) — `navigationIssuesRef` + `navigationIssueSeqRef` + `currentIntentRef`, four operations
(`issueNavigation` / `supersedeIssuesExcept` / `settleIssue` / `retireStaleIssues`), settlement by
in-flight-preferred match, explicit `repairUrlToCurrentIntent` for the pathname-first path, and
retirement bounded by both count (8) and age (10 s) — because one slot cannot represent two
overlapping commits and C's own issuance overwrote B's record (R6-B1/B2). The reopen path gets
**INVARIANT R** (§2k-A): the `recoveryInFlight` check moves to the top of the `armRetry` timer body
above the escalate/bare branch, busy-waiting is bounded by `RECOVERY_WAIT_CEILING_MS = 30_000` after
which the lineage retires and ownership transfers to the rule-2 edge, and **all five open sites are
enumerated with a proof of obedience** including `bootstrap()`, which SELF-H proves unreachable
during recovery via the machine's `!hasSession` predicate. Plus three editorial fixes: the last v4
CLOSE marker (R6-m2), the v5/v6 attribution of `issuedCommitRef` in §9 (R6-m3), and the SELF-G
weight (R6-m1). Test count: **deletes 0 and adds 13, net +13 — 178 → 191** (6 overlay + 7 downlink).

**Scope delta v7 → v8** (round-7 repair; the round where both residual cores stop INFERRING what the
platform does not provide — see the round-7 ledger. No new feature, no new commit, no protocol
change):
navigation identity becomes **observable in the URL** — a reserved `__wsnav` nonce stamped in
`commitStageNavigation`, read via `useSearchParams()`, settled **by id** rather than by destination,
stripped with `history.replaceState` so it creates no second landing, with a bounded **tombstone
ring** so a retired or unknown nonce classifies `issued-stale` and can never mint over current
intent (§2m-A; R7-1, R7-2). Intent capture and repair move to the **complete** stage href through
`canonicalStageUrl`, because `page.tsx:112-114` seeds `shortCode` from the query and a pathname-only
repair destroys it (R7-3). Recovery becomes **bounded in code** — an `AbortController` with
`JOIN_TIMEOUT_MS = 15_000` plus an expiring `activeRecoveryLease` — so `recoveryInFlight` is
guaranteed to clear and v7's ownership transfer stops being nominal (§2k-A; R7-4). One newly-declared
same-diff requirement: `app/(world)/layout.tsx` gains `force-dynamic`, since it hosts
`WorldStageRoot` and has no route-segment config at the anchor (R7-1b). Test count: **corrects v7's
weighting from 191 to 212, then deletes 1 bullet (2 cases) and adds 18 — 212 → 228.**
**Scope delta v8 → v9** (round-8 repair; no new feature, no new commit, no protocol change):
`supersedeAllLiveIssues()` replaces the same-destination exemption so at most ONE issue is ever
`in-flight` (R8-B1); the nonce becomes `${documentEpoch}.${sequence}` held in a **module-scoped
lineage store** with a fifth `foreign` landing class, an explicit `resetStageNavigationLineage()`,
and an epoch/sequence that survive a real root remount (R8-B3); stripping is corrected against the
REAL `next@16.2.3` behavior — native history DOES re-enter `useSearchParams`, so the stale branch
never strips after issuing a repair and every other strip sits behind a one-shot
`suppressNextLandingRef` guard (R8-B2); recovery termination moves from `AbortController` to an
**independent deadline promise raced against the whole fetch-plus-body**, with a single lease-CAS
`settleRecovery` as the only writer of `recoveryInFlight` (R8-B4); and `commitStageNavigation` gains
`{history, countTowardStageHistory}` options so the repair's forced-replace/no-count contract becomes
implementable (R8-M1). Test count: **corrects the basis from 228 to 230, then deletes 2 bullets and
adds 14 — 230 → 242.**

**Scope delta v10 → v11** (round-10 repair; no new feature, no new commit):
the strip guard gains **causal identity** — a per-strip UUID marker merged into `history.state`,
suppressing only when BOTH `{href, marker}` match, because URL equality cannot tell the strip's own
rerun from a legitimate landing at the identical nonce-free URL (R10-B1); **bootstrap `/join` gets a
real algorithm** — a generic `withDeadline()` primitive plus a `joinBounded()` raw-shape wrapper and
a `bootstrapGeneration` inert-late guard, so the termination invariant holds on BOTH join paths while
recovery keeps its own lease CAS (R10-B2, option (b) frozen); the incompatible-algorithm sweep is run
with **grep discipline** over `navigationIssuesRef` / `navigationIssueSeqRef` / `currentIntentRef` /
`supersedeIssuesExcept` / `supersedeAllLiveIssues` / mount-reset phrasing, adding the lineage module
to §1, making ids `string`, exposing `getNavigationIntent()`, and routing every supersession/intent
write through `acceptNavigationIntent()` (R10-M1); stale-before-remount rejection is tested (R10-M2);
every recovery passage names `settleRecovery` as owner and the seven-cell assertion becomes *at most
one* transition (R10-M3); the second-arm wording is scoped to deadline-first (R10-m1); two protocol
references move to 43 (R10-m2); and the Bumper canvas-key claim is corrected to quote each activity's
exact key (R10-m3). Test count: **deletes 0 and adds 3 — 265 → 268.**

**Scope delta v11 → v12** (round-11 repair; ONE design decision, six mechanical fixes):
the strip guard becomes **serialized strip ownership** — a module-owned single-slot queue admitting at
most ONE outstanding strip, with a `STRIP_ACK_TIMEOUT_MS` bound and deterministic release, because a
single ref plus a per-entry marker cannot survive two `replaceState` calls mutating the SAME history
entry when React gives an effect no per-trigger snapshot (R11-1); the strip payload becomes **exactly**
`{__wsStrip: marker}`, since spreading `history.state` carries Next's `__NA` and makes patched
`replaceState` bypass the router restore entirely (R11-2, with both references cited at the call site);
bootstrap's wrapper is made anchor-compatible — existing raw union, `join(recovery = false, signal?)`,
parameterless `joinBounded()`, `bootstrap() → joinBounded()` — and the invented `bootstrapGeneration`
guard is REMOVED because the machine is already single-flight (R11-3); `withDeadline()` is documented
as **bootstrap-only**, since recovery must keep its two-producer race for the CAS refusal (R11-4); the
lineage module gets its §1 row (R11-5); two recovery-ownership passages move to the lease-CAS contract
(R11-6); and the Bumper canvas-key wording is corrected in every operative passage (R11-8). Test count:
**honest v11 basis 269; delete the redundant operation-first drive (−1); add four v12 cases (+4); net +3 → 272** (R12-2 corrected v12's "268 + 4" framing).

**Scope delta v12 → v13** (round-12 ORCHESTRATOR SCOPE RULING — a deletion round):
**in-session stripping is DELETED in full.** No `replaceState`, no marker, no `history.state`
payload, no outstanding/queued slots, no ack timeout, no popstate handling, no suppression guard,
and none of their tests. A component-issued URL keeps its `__wsnav` nonce for the life of its
history entry. Four consecutive rounds rejected three successive strip protocols — boolean guard,
URL equality, per-entry marker, serialized queue — each correct about the defect it fixed and each
surfacing a new lifecycle cell, most decisively that Next 16.2.3 uses
`preserveCustomHistoryState: **true**` for history traversals, so a traversal back to a marked entry
satisfies any `{href, marker}` test. The entire user-visible payoff was a tidier address bar.
**Landing classification, not stripping, carries correctness; v15's final six outcomes are defined exclusively by the seven-row table.** Due diligence recorded in the round-12
ledger: every one of the 26 query consumers at the anchor reads a NAMED key, there is no
exact-query-string comparison in the tree, `useActivityWs` reads `window.location` not at all, and
the RSC fetch already carried the nonce in v7-v12 — so the residual param is inert. Test count:
**deletes 10 and adds 0 - 272 -> 262**, the first round whose total goes down.

**Scope delta v13 -> v14** (round-13 PROVENANCE CONTRACT, frozen):
`issued-settled` now **FALLS THROUGH to normal processing** instead of returning - with stripping
deleted, v13's early return skipped children installation and request minting entirely. And the
beyond-horizon case is **pinned**: an own-epoch nonce below the live window and absent from the
tombstone ring classifies as **traversal / replay ⇒ normal arrival, nonce inert**. That rule is
frozen on the **ACCEPTED-RESIDUAL** branch rather than the serialization-proof branch - the round-13
ledger records why I declined to make a third framework claim load-bearing. Plus: the remaining
operative strip passages are deleted, the R12-DD due-diligence claim is narrowed to initial
navigation with the five full-query consumers named, the v12 arithmetic line is corrected, and the
two versioned Next citations are inlined. Test count: **deletes 4 and adds 6 - 262 -> 264.**

**Scope delta v14 -> v15** (round-14 propagation + the SECOND scope ruling):
the frozen provenance contract is **propagated into the machinery** - an explicit issue-recorded
**`issuedHighWater()`** predicate (NOT a scan of retained records: tombstones enter in settlement
order, so "below the minimum retained sequence" is not "evicted"), two new union variants
(`traversal`, `malformed`), a classifier that takes the high-water as part of the module snapshot it
already reads, the **seven-row table promoted to the single statement every passage defers to**, the
class count corrected in all three places, and both contradictory prose passages rewritten (R14-1).
The `=` boundary is **inclusive**, and `seq > issuedHighWater` is **malformed ⇒ fresh arrival**,
because a sequence we never minted was never a component-issued landing and R7-2's never-promote rule
governs only nonces we did issue (R14-1a/b). The residual's **"no money path" bound is WITHDRAWN** -
verified at the anchor that a stale install unmounts a live activity page, and the existing
leave→voluntary-forfeit→DNF→reward chain writes results, placements, and CT; the corrected bound says
the harm is an INVOLUNTARY trigger of that existing lifecycle (R14-2). Mandatory harm reduction: the
**probe is gated** behind `NEXT_PUBLIC_ENABLE_STAGE_PROBE`, removing the only scripted precursor
(R14-2b). Plus the four strip residues, the citation label, and the honest test-identity history.
Test count: **deletes 1 and adds 7 - 264 -> 270.**

**Scope delta v9 → v10** (round-9 repair; no new feature, no new commit):
one atomic **`acceptNavigationIntent(href)`** — supersede-all-live + record-intent in a single call —
invoked at all FOUR accepted-navigation sites including the handler's `ADOPT` branch, which mints
nothing and which v9 therefore never saw (R9-B1); the strip guard becomes an **exact-URL identity**
(`suppressStripHrefRef`) instead of a boolean that an unrelated landing could consume (R9-B2); the
lineage's document-scoped lifetime is **FROZEN** — it survives every root remount and stage reset and
is cleared only by document teardown, so `resetStageNavigationLineage()` has no production caller
(R9-B3); recovery settlement routes **BOTH race arms through the single lease-CAS** so the loser is
refused rather than abandoned, and **all dispatch is removed from `recoverWithTicket()`** leaving one
dispatch site (R9-B4); every superseded algorithm is REPLACED rather than annotated (R9-M1); the
protocol rebases **42 → 43** with an explicit re-read instruction, since the anchor is 40 and P3 is
not landed here (R9-m1); and the epoch becomes `crypto.randomUUID()` with an all-digits sequence
check (R9-m2). Test count: **deletes 0 and adds 23 — 242 → 265**, all of it the coverage round 9
found missing.

*(The count has been declared wrong across seven consecutive rounds — 86, 111, 129, and four
derivation/weighting errors — so §6.2 carries the per-suite sum, the running total, the delta
breakdown, a frozen counting rule, and the record of the re-audit. **Round 8's lesson is that a
weight audit which does not read every bullet's SETUP COUNT will keep missing two or three**, so
§6.2 step 9 now shows the full chain from the last independently verified figure rather than only
the latest delta.)*

---

## REVISION LEDGER — round 2 (Codex REJECT)

Every round-2 finding was re-verified against the live tree at `a156e3c0` before disposition. Three
are **ACCEPTED** as stated. One is **ADOPTED DIFFERENTLY** because the critique's *mechanism* is
factually wrong for this repo's Next build — the *defect* it points at is real and blocking, so the
finding is honored with a different fix and the evidence for the correction is quoted. One
sub-claim inside a MINOR is **REJECTED** with evidence. Re-verification also surfaced one further
defect the critique did not raise (**SELF-B**).

| # | Finding | Disposition |
|---|---|---|
| **R2-B1** | Readiness can acknowledge the wrong activity room: `decideActivityReadiness` knows the rendered `roomKey` but not the destination belonging to `pendingRequest`, so on activity→activity the OUTGOING room's painted latch (rule 4) or terminal branch (rule 3) acks the INCOMING room's generation, and the fade can start before B's Canvas paints | **ACCEPTED — the strongest finding in the round.** Verified the premise exactly: `requestScene` mints `{sceneId, generation, requestId}` with **no destination identity** (`stage-store.ts:141-190`), `retryStageScene` mints a NEW `requestId` too (`:172-231`), and the v2 readiness input carried only `roomKey`. v2's claim — carried in §2d contract item 1 and §5i rule 2 — that same-scene readiness "cannot happen before the commit" is therefore FALSE and is retracted in both places. Fix (§2b, §2m, §5h): a new store field **`activityTarget: { roomKey } \| null`**, written at BOTH the call sites that can mint an `activity` request in `WorldStageRoot` — the handler branch (`:181-212`, destination from `stagePathnameFromHref(navigation.to)`) and the pathname-first children-swap effect (`:105-134`, destination from `pathname`) — so back/forward, direct navigation, and handler-owned navigation are all covered. Readiness gains `targetRoomKey` and `terminalRoomKey`; a new rule 2 short-circuits to `'wrong-room'` and the terminal/painted rules (now 4 and 5) are room-scoped rather than keyed on a bare branch literal. Keyed by SCENE, not `requestId`, so a watchdog retry (new `requestId`, same destination) preserves it by construction. New WAIT reason `'wrong-room'`. |
| **R2-B2** | "The chunk boundary and retry contract cannot work as specified": the installed Next runtime captures dynamic-loader rejection internally (`loadable.shared-runtime.js:42-57`, `:109-126`), never throws it into the proposed boundary, and caches the loadable subscription (`:69-80`); the fix is to route `loading({error, retry})` into a failure component and invoke the supplied `retry` | **ADOPTED DIFFERENTLY — the defect is real and blocking; the cited mechanism and the proposed fix are both wrong for this repo.** Evidence, read this session: the activity page lives under `app/`, and Next aliases `next/dynamic` in the App Router layer to `next/dist/api/app-dynamic` (`apps/web/node_modules/next/dist/build/create-compiler-aliases.js:228`, inside `createAppRouterApiAliases`). That resolves to `shared/lib/app-dynamic.js` → `shared/lib/lazy-dynamic/loadable.js`, which is a thin `React.lazy` + `Suspense` wrapper. In that file `Loading` is rendered ONLY as the Suspense fallback, with **`error` hard-coded to `null` and no `retry` prop** — so `loading({error, retry})` **does not exist on this code path** and cannot be the fix. `loadable.shared-runtime.js` is the pages-router runtime (`shared/lib/dynamic.js`), which the App Router never reaches. Consequently the v2 claim that a rethrowing loader reaches `ActivitySceneErrorBoundary` is **correct** (React `lazy` rethrows `payload._result` during render once `_status === 2`; verified in the vendored React 19.2.5 initializer, `next/dist/compiled/react/cjs/react.development.js:462-533` — the row originally cited `:465-530`, corrected per R3-m2), and the round-2 conclusion "the transition still reaches watchdog/error because the boundary never receives the rejection" is **wrong**. What IS real — and is exactly the second half of the critique's own fix — is that the rejection is **permanently cached**: `dynamic()` is called at MODULE scope (`page.tsx:45-93`), so one `React.lazy` payload exists per module for the SPA's lifetime and a `retryNonce` remount re-throws instantly. This is already frozen doctrine upstream: **P3 v4 §8.13** states "`resetKey` clears `failed` but does not re-run a failed lazy CHUNK import… the chunk panel keeps its Reload action." v2 violated its own inherited limitation. Fix (§2i): the panel's PRIMARY action is **Reload** (`location.reload()`), matching P3 v4; a cheap best-effort **Try again** builds a FRESH dynamic instance per attempt via `useMemo(() => dynamic(...), [activityId, sceneAttempt])` inside the already-room-keyed `ActivityRoomRuntime`, which mints a fresh `React.lazy` payload and a fresh `import()`. Whether the BUNDLER re-issues a network request for a previously-failed chunk is bundler-dependent (`next.config.mjs:74` configures `turbopack`) and **I did not verify it**, which is precisely why Reload is primary — see §8.12. |
| **R2-B2b** | The retry-readiness rules are internally contradictory: retry clears `terminalBranch`/`paintedRoomKey` but not `ackedKey` and mints no new generation, so rule 2 returns `already-acked` (or rule 1 `no-pending-request`) — the specified test "after retry, readiness returns `WAIT:'not-painted'`" cannot pass | **ACCEPTED.** Traced against v2's own §5h: correct in both branches. Two fixes: (a) the ack key gains a page-owned **`attemptNonce`** (`${generation}:${recoveryCount}:${attemptNonce}`) so a page-owned recovery attempt genuinely REVOKES a prior ack — closing "acknowledged readiness cannot be revoked"; (b) the false test is **replaced**, not patched: by the time a user can click Retry the terminal ack has already completed the transition, so the truthful assertion is `WAIT:'no-pending-request'` with the page's own `loading` fallback covering the gap, PLUS a new test for the case that actually matters (a retry while a NEW generation is pending must return `WAIT:'not-painted'`). |
| **R2-B2c** | The context-loss portion lacks a reliable activity-canvas handle: a parent effect querying the wrapper can run while the dynamic fallback is still mounted and never re-run when the Canvas appears | **ACCEPTED.** v2 said "the `ActivityRoomRuntime` registers a `webglcontextlost` listener on the activity canvas element" without saying how it obtains one. Fix (§2c, §2i): `ActivityCanvasReadyProbe` — which is already inside the Canvas and already reports paint — additionally publishes `gl.domElement` through a new `onCanvas(el)` prop, and the page attaches the listener to THAT element. The handle can therefore only exist once the Canvas exists, and it is re-published on every Canvas remount. |
| **R2-B3** | The 10 s force-clear creates a half-committed route and can force-forfeit a live match: it unmounts the activity page (emitting voluntary `leave`), clears the gate, and lets the transition finish even when the App Router navigation never committed — recreating the exact condition §2d exists to prevent | **ACCEPTED, in full.** The critique is right that a timer must not itself tear down. Fix (§2d item 4, §5i): at `OUTGOING_OVERLAY_COMMIT_TIMEOUT_MS` the overlay entry flips to `status:'timed-out'`, **the cover is RETAINED, nothing is unmounted, no `leave` is emitted, and the fade stays held at `awaiting`**. The page renders an explicit recovery surface. The destination stage is never exposed before navigation teardown commits. The 45 s stage watchdog therefore remains the outer bound and can no longer be pre-empted by a forfeit. **⚠ SUPERSEDED IN PART BY R3-B3:** this row's v3 remedy specified THREE actions — Retry, **Stay**, and a Hard navigate whose `leave` supposedly rode "the existing `pagehide` beacon". Round 3 falsified both: Stay cannot cancel an issued App Router navigation, and no activity `pagehide` beacon exists. **The frozen surface is the two-action one in §2d item 4** (Hard navigate + `leaveAndClose()`, then Retry). The hold-and-surface principle above — a timer reports, it never tears down — is unchanged and remains correct. |
| **R2-M1** | Orthogonal downlink does not close every stream-opening path: `bootstrap()` (`:533-555`), `rejoinWithTicket()` (`:267-295`), and the queued `onerror` timeout (`:474-530`) call `openStream` directly; §5e's claim that clearing the existing timer neutralizes an already-queued handler is FALSE; closing SSE drops the `land` channel with no re-invalidation; `pagehide` has no `pageshow` counterpart | **ACCEPTED, every leg.** Verified each call site at the quoted lines, and verified `es.addEventListener('land', …)` → `invalidateQueries({ queryKey: LAND_PARCELS_QUERY_KEY })` at `:470-472`. The v2 §5e answer "an already-queued `onerror` is neutralized because CLOSE clears `retryTimeout`" is **wrong** — a queued handler runs AFTER the clear and SCHEDULES A NEW timer at `:510`, resurrecting the stream. Fix (§2k, §5e): a closure-scoped **`streamEpoch`** incremented on every `CLOSE` and on effect teardown; `openStream(roomId, epoch)` captures it and every one of its handlers (`open`, `snapshot`, `land`, `onerror`) and every retry callback returns early when `epoch !== streamEpoch`. `bootstrap()` and `rejoinWithTicket()` complete their session/room/ticket work but **skip `openStream` when the live downlink ref is false** — so a 409 recovery during a match still repairs membership without opening SSE. The `OPEN` edge invalidates `LAND_PARCELS_QUERY_KEY` so SSE-only state that changed during the suspension is refetched. A `pageshow` listener with `event.persisted === true` resets membership refs (`sessionIdRef`/`roomIdRef`/`setLocalSessionId(null)`/`clearPlayers()` + `es?.close()`), which re-arms the machine's `!hasSession && everActive` BOOTSTRAP branch (`world-stream-machine.ts:99-109`) instead of leaving a bfcache-restored page holding a dead session until a later 409. **⚠ SUPERSEDED IN PART BY R3-B2:** "incremented on every `CLOSE`" was not enough, because `onerror` nulls `es` first so the disabled tick never emits a `CLOSE`; and neither `rejoinWithTicket` nor `handleSuperseded` rotated the epoch when they replaced the source. **The frozen mechanism is §2k's**: `pendingReopen` in the CLOSE rule, one `invalidateStream()` primitive that every source-drop routes through, rotation inside `openStream`, and a per-handler epoch + `downlinkEnabledRef` + `es === source` triple guard. The `bootstrap`/`rejoin` skip, the `OPEN`-edge land invalidation, and the `pageshow` reset above are unchanged and remain correct. |
| **R2-M2** | §2h reverses P3 v4's buffered-navigation supersession rule: P4 RETURNS when a live buffered navigation targets a different destination, while calling that equivalent to P3 rule 4 — which says the opposite (PROCEED and supersede). Returning makes Leave/Play Again a no-op during the handler-install buffer window | **ACCEPTED.** Read P3 v4 §2h rule 4 verbatim: `nav.bufferedTo !== null && nav.bufferedTo !== '/kelp' && nav.bufferedExpiresAt! > nowMs` ⇒ **PROCEED** ("a new kelp request supersedes a buffered other-destination request"). v2's `navigateOut` guard is the inverse and would drop a real click. **The guard is REMOVED** (§2h); `requestWorldStageNavigation` overwrites the buffer, which is the same ownership rule kelp follows. §6.2 gains the dropped-click regression test. |
| **R2-m1(a)** | P4 repeatedly says it is stacked on P3 **v3**; the frozen dependency is **v4** | **ACCEPTED.** All 20 occurrences corrected; the header now enumerates the v3→v4 delta and confirms the `bufferedPathname` amendment does not disturb rule 8's `stagePendingSceneId === null` conjunct, rule 9, or the token lifecycle. |
| **R2-m1(b)** | The §6.2 headings total **96**, not the declared 86 | **ACCEPTED.** v2's headings summed 14+16+7+11+13+7+9+9+8 = 94, +2 kelp = **96**; "86" was arithmetically wrong. v3 then re-derived inline and declared **111** — which was *itself* wrong: v3's own headings summed **129**, caught by round 3 (R3-m1). **v4's authoritative total is 145**, derived per-suite in §6.2 with every heading equal to its own bullet sum and a written-out running sum. This row is the third correction to the same number; the derivation now lives beside the bullets so it can be checked by inspection rather than by trust. |
| **R2-m1(c)** | `_renderedPoseByAvatar` is declared unfixed, yet P4a requires a test that it does not grow across 30 room changes | **ACCEPTED.** The assertion was incoherent with the tracked-not-fixed disposition. Restated as a **measured known-defect baseline**: record its size after 30 room changes and assert it MATCHES the same measurement on `origin/staging`. It is a drift detector, not a growth bound. **⚠ SUPERSEDED by R3-M1 / SELF-E (R4-M2): the baseline test is DELETED because the alleged defect is FALSE.** `ReefRacePlayer.tsx:1056-1064` sets and identity-guard-deletes the entry in one `[entity.avatarId]` effect, so the map is bounded by live rendered players. Round 4 independently re-verified this at the anchor. The row is annotated rather than rewritten so the audit trail of what round 2 asked for survives; §6.1's diff-scope gate is what replaces it. |
| **R2-m1(d)** | The "full reset surface" omits `LobbyLanding` local/poll/form state, `ActivityMobileControls`, surge/speed-line state, and the new readiness/boundary states | **ACCEPTED IN PART; the surge leg is REJECTED.** Verified and ADDED to §5c: `LobbyLanding` carries nine `useState`s plus a 3 s poll timer ref (`lobby-landing.tsx:169-181`, `:277-285`) and `ActivityMobileControls` carries `boostFlash`/`powerupFlash` plus nipplejs manager refs (`activity-mobile-controls.tsx:82-88`) — both are genuinely per-room and both were missing. The new readiness/boundary state rows are added too. **REJECTED — surge/speed-line state was already present:** v2 §5c carries the row "Surge snapshot + `turboBubbleActiveUntil` · `reef-race-speed-surge.tsx:34-35` · `ReefRaceSurgeDriver` effect keyed `[roomId]`, resets on entry AND cleanup (`:175-184`)". |
| **R2-m1(e)** | It incorrectly says runtime keying resets `next/dynamic` loading/error state; that state lives in the cached loadable subscription | **ACCEPTED.** True of v2 (module-scope `dynamic()`, verified `page.tsx:45-93`). The R2-B2 fix makes the claim true by construction — the dynamic component is now built inside the keyed `ActivityRoomRuntime` — so §5c's row is rewritten to say so and to name the mechanism rather than asserting the outcome. |
| **R2-m1(f)** | P4d's custom `clawville:activity-action` string is not in `WindowEventMap`; `extra` should use the string-typed `addStageEventListener` | **ACCEPTED.** Verified: `addStageWindowListener<K extends keyof WindowEventMap>` (`stage-store.ts:471-482`) cannot accept the custom type, while `addStageEventListener(target: EventTarget, type: string, listener: EventListener, …)` (`:484-500`) can. §2l now routes `extra` through `addStageEventListener(window, …)`; both still increment `windowListenerCount`, so §6.6's dual-measure assertion is unaffected. No `WindowEventMap` augmentation. |
| **R2-m1(g)** | Commit structure: P4a and P4c are not independently green as specified | **ACCEPTED as the acceptance bar.** P4a's blockers (R2-B1, R2-B2, R2-B2b, R2-B3) and P4c's (R2-M1) are fixed above; §9 restates the per-commit green criterion explicitly, and the specific tests the critique said "should fail under the frozen implementation" are the ones replaced. |
| **SELF-B** | The v2 timeout called `noteRecovery('outgoing-overlay-commit-timeout')`, which increments `recovery.count` (`stage-store.ts:440-446`). That counter is a COMPONENT OF the readiness ack key (§2b) and is asserted zero by the probe's `zeroRecoveries` gate and by §6.11's activity-context-loss drill. A navigation stall would therefore spuriously re-arm every slot's ack key and falsify two independent gates. | Fixed with the R2-B3 rewrite: the timeout records `status:'timed-out'` on the overlay entry itself and the probe reads that. **`noteRecovery` is no longer called from this path.** Recorded as evidence for the redesign, not as a criticism of the critique. |

*(Round 3 CLOSED nine of these fourteen rows: R2-B2, R2-B2b, R2-B2c, R2-M2, R2-m1(a), R2-m1(d)
incl. an explicit concession of its surge sub-claim, R2-m1(e), R2-m1(f), and SELF-B. The five it
reopened are dispositioned in the round-3 ledger below.)*

**Everything round 2 verified CORRECT is carried forward untouched**, including: the overlay-slot
renderer decision; priority-0/default `useFrame` not changing `internal.priority`; the resident-world
synchronous-ack race; SELF-A's stale-anchor observation and the orthogonal policy that avoids it;
`WorldStagePathname` vs `WorldStageHref`; the `bufferedPathname` amendment's compatibility with P3
v4; `ActivityRoomRuntime` keying as the right room-isolation boundary (including its finding that
party/matchmaking continuation is owned by the `/game` lobby and server room state, not by activity
page state); the corrected §0.1 import counts and the precise `ShaderMaterial` statement; the P3 v4
`resetKey` boundary contract; and OS-level GPU memory plus independent context-loss drills as the
right gates for the two-context model. Round 2's own "normal heartbeat behavior is sound" and
"P4d can be zero-behavior-change for the world controller" readings are also carried forward.

---

## REVISION LEDGER — round 3 (Codex REJECT, freeze gate)

Every round-3 finding was re-verified at the anchor with `git show a156e3c0:<path>` before
disposition. **All five reopened rows are ACCEPTED**; one is ADOPTED DIFFERENTLY in the *remedy*
(not the finding), where the report offered a choice and neither option was honest as written.
Re-verification surfaced one further defect the report did not raise (**SELF-C**), and one
correction to the report's own reachability framing (**SELF-D**).

| # | Finding | Disposition |
|---|---|---|
| **R3-B1** | Pathname-first activity A→B bypasses request minting AND readiness. `WorldStageRoot.tsx:105-134`'s `destinationAlreadyOpaque` and its request-suppression clause are both SCENE-level, so with activity A active and nothing pending, a pathname change to activity B swaps `displayedChildren` immediately and skips `requestStageScene`. v3 §2m/§2b claimed both navigation paths were structurally covered; they were not. | **ACCEPTED, and worse than reported (see SELF-C).** Verified at the anchor: `destinationAlreadyOpaque = activeScene === sceneId && phase ∈ {awaiting, fadingIn, idle}`, and `completeTransition` leaves the store at `pendingRequest: null` + `transition.phase: 'idle'` (`stage-store.ts:348-372`) — so at REST after any activity crossing that condition is unconditionally true for every activity pathname. Suppression fires too: `pendingRequest === null && activeScene === sceneId` makes the `!(…)` clause false ⇒ no request. Fix (§2m, rewritten): a `stageDestinationKey(pathname)` helper makes BOTH conditions destination-aware, A is retained via `pendingRouteChildrenRef` until the opaque midpoint, `activityTarget` is written, and a new activity generation is minted. **⚠ SUPERSEDED IN PART BY R4-B1: the "byte-identical for `/game`, `/cove`, `/kelp` by construction" claim in this row's v4 remedy is FALSE and is retracted.** The v4 remedy made both conditions destination-aware by comparing `destinationKey === displayedKey`, and argued that was a tautology for slots without sub-identity. It is not: `activeScene` advances at the opaque midpoint while `displayedPathRef` advances at children-install, so the two operands are never in phase and the conjunct wedges every handler-owned crossing. **The frozen remedy is §2m's `openedMidpointRef` opaque-lineage rule** (plus scene+destination pending equality). What this row got RIGHT and v5 keeps: the defect diagnosis (pathname-first A→B mints nothing), the destination-key concept, retaining A via `pendingRouteChildrenRef` until the midpoint, writing `activityTarget`, and minting a new generation. §6.2's back/forward A→B test survives; its "non-activity scope pin" was the false tautology's evidence and is DELETED, replaced by three real handler-owned crossing tests. |
| **SELF-C** | Re-verification found a SECOND failure mode in the same code that the report did not name. Had `transition` been null at rest, `destinationAlreadyOpaque` would be FALSE while suppression still fired — B's children parked in `pendingRouteChildrenRef` with **no request that can ever reach an opaque midpoint**: a permanent wedge, not a skipped fade. The live code takes the first branch because `completeTransition` keeps `phase:'idle'` rather than nulling `transition`. | Recorded because it constrains the FIX: repairing only one clause converts a silent skip into a hang, so the install rule and the suppression rule must change **together**, and §6.2 asserts that a request is actually MINTED — not merely that the swap was deferred. **This conclusion survives round 4 unchanged and v5 honors it**, but note the v4 pairing it originally described (both clauses made destination-aware via `destinationKey === displayedKey`) was itself wrong — see R4-B1. In v5 the opacity clause is not made destination-aware at all; it is REPLACED by the `openedMidpointRef` lineage rule, while the suppression clause becomes scene+destination pending equality. Same "change them together" constraint, different pair. |
| **SELF-D** | The report frames browser back/forward A→B as the trigger. Re-verification says reachability is narrower in one direction and broader in another, and the spec should say so rather than inherit an unexamined claim. | **Reachability restated honestly in §2m.** NARROWER: I could not construct an A→B-adjacent history stack from shipped call sites — every Leave/Play-Again path routes through `/game` (`page.tsx:294`, `:304`, `:364`) — and `decideStageNavigationHistoryMethod` (`stage-navigation-ownership.ts:13-17`) returns `'push'` only for the first two stage navigations and `'replace'` thereafter, compressing the stack further. BROADER, and this is what keeps it a blocker: the bypass is a property of the *pathname-change effect*, not of history. It fires on ANY activity→activity pathname change while nothing is pending — including §2h's `if (!requested) router.push(to)` legacy fallback (which runs whenever the stage handler is not yet installed) and the direct A→B crossing §2d/§5i rule 2 already reasons about. A frozen spec claiming structural coverage it does not have is a defect independent of today's reachability. |
| **R3-B2** | The downlink epoch still permits retry resurrection: live `onerror` closes and nulls `es` BEFORE scheduling the retry (`use-world-stream.ts:474-477` → `:510-529`), so the next disabled tick sees `wanted=false, open=false` ⇒ `NONE` ⇒ `closeStream()` never runs ⇒ `streamEpoch` is never bumped ⇒ the queued callback still owns the current epoch and reopens SSE mid-match. v3's "dispatch error, then run CLOSE" test does not reproduce the real path because there is no CLOSE. Also `rejoinWithTicket()` replaces the source at `:285-294` without epoch rotation. | **ACCEPTED in full; all four remedies adopted.** Verified every quoted line at the anchor. Fix (§2k, §5e): (1) `WorldDownlinkInput` gains `pendingReopen` and the CLOSE rule becomes `!wanted && (open \|\| pendingReopen)` — firing the edge with `es === null` is the actual repair; (2) every handler and every retry/recovery callback checks BOTH its captured epoch AND `downlinkEnabledRef.current`; (3) `streamEpoch` rotates on every source replacement — `openStream` bumps it and `rejoinWithTicket`'s teardown routes through the same `invalidateStream()` helper — plus each handler carries an `es === capturedSource` ownership guard; (4) the test is rewritten to the REAL ordering (error → `es=null` → disable → tick → timer fires). Timing note that makes (1) reliable rather than lucky: `RETRY_DELAY_BASE = 3000` (`:23`) against a 200 ms machine tick, so the disabled tick precedes the earliest retry by roughly fifteen ticks — but (2) and (3) are the correctness guarantee, not the schedule. |
| **R3-B3** | Timeout recovery overstates its guarantees: `commitStageNavigation` retains no cancellation handle (`WorldStageRoot.tsx:165-176`), so **Stay** cannot cancel an issued `router.push` and a late commit can still unmount a live match; and **Hard navigate**'s claimed activity `pagehide` leave beacon **does not exist** — `useActivityWs`'s only graceful leave is its effect cleanup (`:311-333`), while the `use-world-stream.ts:559-577` beacon leaves the WORLD room. | **ACCEPTED — both legs verified, and the spec was wrong.** Grepping `pagehide\|beforeunload\|visibilitychange` over `useActivityWs.ts` at the anchor returns **nothing**; the cleanup at `:311-333` is the only `{type:'leave'}` sender. Next's App Router exposes no cancellation for an issued client navigation, so **Stay is REMOVED** — I will not spec a supersession mechanism I cannot test. Fix (§2d item 4, §5i): the surface offers **Hard navigate** (primary, guaranteed teardown) and **Retry** (secondary, best-effort), and `useActivityWs` **exports a new idempotent `leaveAndClose()`** invoked before `location.assign`. That is a declared, deliberate change to a file §1f previously listed as untouched — **§1a** gains the row (the recovery surface is P4a, not P4b) and §1f is corrected. Honest bound restated in §5f/§8.4: `leaveAndClose()` is best-effort at document teardown; the server records a VOLUNTARY forfeit only if it actually receives the frame. Verified at the anchor: the hub's `handleMessage` `case 'leave'` sets `ws.data.internalCloseCode = 1000` and calls `safeClose(ws, 1000, …)` (`activity-ws-hub.ts:402-404` — note the in-file comment at `:325` attributes this to "the route `onMessage` handler", which is where the frame ARRIVES; the assignment itself is in the hub), and the close handler branches on it at `:327-330`. If the frame is lost, the close is ordinary and the player falls into the existing `RECONNECT_GRACE_MS = 10_000` window (`:103`) ending in a `'timeout'` forfeit (`:333-343`) — **strictly gentler than an immediate voluntary forfeit**, so the failure direction is safe. |
| **R3-M1** | The `_renderedPoseByAvatar` drift-baseline test is not implementable: it measures private module state with no pinned value and no diagnostic, while §1f forbids touching `ReefRacePlayer.tsx`. | **ACCEPTED; ADOPTED DIFFERENTLY between the report's two options — and see SELF-E, which removes the reason the test existed at all.** The report offers "pinned test diagnostic" or "manual probe, removed from the total". I take **neither verbatim**: adding an export to `ReefRacePlayer.tsx` purely to observe something P4 does not touch is an unforced change to a file this spec promises is untouched, and a manual probe with no pinned value is unfalsifiable. **The test is DELETED from §6.2.** What replaces it is the guarantee that actually holds — P4 changes nothing in `ReefRacePlayer.tsx`, so its runtime behavior is unchanged **by construction at the diff level** — enforced by a mechanical **diff-scope gate** in §6.1: `git diff --name-only` must touch no file under `activities/reef-race/` except `ReefRaceScene.tsx`. Binary, implementable, and it delivers what the test was reaching for. |
| **SELF-E** | Re-verifying R3-M1 against the source showed the *underlying defect claim is false*. §5c called `_renderedPoseByAvatar` a leak ("nothing clears it; grows with every distinct avatar seen") and §7 carried a punch-list item for it. At the anchor the map is written and deleted by ONE effect: `_renderedPoseByAvatar.set(entity.avatarId, pose)` at `ReefRacePlayer.tsx:1058` inside `useEffect(..., [entity.avatarId])`, whose cleanup at `:1059-1063` does `if (_renderedPoseByAvatar.get(entity.avatarId) === pose) _renderedPoseByAvatar.delete(entity.avatarId)`. The identity guard exists precisely to make a same-avatarId remount hand ownership to the newer instance rather than double-delete. The map is therefore bounded by LIVE rendered players, not by distinct avatars ever seen. | **The claim is RETRACTED.** §5c's row is rewritten from "⚠ PRE-EXISTING, tracked NOT fixed" to "NOT a defect — verified paired set/delete", and §7's punch-list item (b) is **removed** rather than renewed. Rule E6.1 forbids untracked deferrals; it does not require tracking a defect that does not exist, and leaving a punch-list entry pointing at correct code costs the `reef` owner a real investigation for nothing. Recorded as a full row (not a footnote) because v1-v3 shipped this false claim in two sections and round 3 inherited it while arguing about how to TEST it — the lesson is that "how do we test this known defect" is the wrong question until the defect is verified to exist. |
| **R3-m1** | Test-total declarations disagree: §6.2 sums 129 while ledger row R2-m1(b) still says 111. | **ACCEPTED**, and 129 is confirmed as the correct v3 figure (I re-summed v3's headings independently: 18+23+8+18+14+11+11+15+9+2 = 129). R2-m1(b) is corrected in place. The v4 repairs then change the count again, so the declaration is re-derived rather than copied: **129 − 1 deleted + 17 added = 145**. Deleted (one only): the `_renderedPoseByAvatar` baseline (R3-M1 + SELF-E). Added (**corrected per R5-m1** — this enumeration previously summed to 16 because it omitted the `leaveRef` case): **6 scene-id** `stageDestinationKey` cases + **6 overlay/navigation** cases (five pathname-first A→B per R3-B1/SELF-C, **plus the §2g `leaveRef` handle-lifetime case**) + **5 downlink** epoch/ownership cases (R3-B2) = **17**. The Stay and Hard-navigate cases are **rewritten in place, not deleted** — booking a substitution as a delete-plus-add is how the earlier totals drifted, so it is called out explicitly. **145 is authoritative**, derived per-suite in §6.2 with each heading equal to its own bullet sum, and re-summed after the last v4 edit. |
| **R3-m2** | Out-of-scope prose drift: §5f still bounds back/forward teardown by `OUTGOING_OVERLAY_COMMIT_TIMEOUT_MS`, contradicting §8.4; §5d's final column is still labelled "v2 (frozen)"; the `a156e3c0 == origin/staging` claim is stale; the React citation `:465-530` stops before the actual `throw payload._result`. | **ACCEPTED, all four.** §5f's row restated to match §8.4 (no teardown ceiling); §5d's column relabelled; the baseline claim withdrawn and replaced by the honest anchor statement in the header; the React citation corrected to **`:462-533`** — verified at the anchor that `lazyInitializer` opens at `:462` and `throw payload._result;` sits at `:533`. |
| **R3-m3** | P4a and P4c remain non-green (R2-m1(g) reopened) because B1/B3 and M1 remain open. | **ACCEPTED as the acceptance bar.** R3-B1/B2/B3 are repaired above; §9's per-commit green criterion keeps its wording and is now actually satisfiable. |

**Round 3's verified-correct list is carried forward**, notably: that the ADOPTED-DIFFERENTLY
`next/dynamic` correction is right and round 2's mechanism was the pages-router runtime applied to
an App Router page; that P3 v4 stacking matches exactly (rule 8's `stagePendingSceneId === null`,
one ownership token per slot generation, inherited tests 97 = 57 + 15 + 25); that §1b's amendment
touches only `decideKelpWalkIn` rules 3 and 4; that destination identity is the right repair
concept; that `attemptNonce` fixes the revocation contradiction; that the published `gl.domElement`
closes the listener-timing hole; that removing the `navigateOut` veto restores P3 v4 supersession;
and that round 2's surge sub-claim was wrong and is conceded.

**P3 v4 stacking is UNDISTURBED by every v4 edit — checked deliberately, because round 3 verified it
matched and a repair round is exactly when that quietly breaks.** The v4 changes touch
`WorldStageRoot`'s children-swap effect, `handleTransitionOpaque`, the stage store's `activityTarget`
field, `use-world-stream.ts`, `useActivityWs.ts`, and §6.2. **None of them touch** `decideKelpWalkIn`
(§1b's amendment still changes only rules 3 and 4, still to `bufferedPathname`, and rule 4 still
PROCEEDs/supersedes), rule 8's `stagePendingSceneId === null` conjunct, rule 9's reachability, §2i's
one-ownership-token-per-slot-generation lifecycle, or the inherited P3 test total of **97 = 57 + 15
+ 25** (§6.2's 270 is P4's own new tests and is disjoint from it). The one place a v4 edit comes near
P3 is `stageDestinationKey`, which returns `'kelp'` for `/kelp` — identical to `sceneIdForPathname`,
so every kelp comparison in the stage root is unchanged by construction and §6.2's non-activity scope
pin asserts it empirically.

**What v4 adds beyond the report:** SELF-C (the wedge that a half-repair of R3-B1 would create),
SELF-D (the honest reachability restatement), and **SELF-E** — the discovery that
`_renderedPoseByAvatar` was never leaking, which retires a false claim v1-v3 carried in two sections
and a punch-list item the `reef` owner would have investigated for nothing. Round 3 asked how to test
that defect; the correct answer turned out to be that there is no defect.

---

## REVISION LEDGER — round 4 (Codex REJECT, freeze gate)

Every round-4 finding was re-verified at the anchor with `git show a156e3c0:<path>` before
disposition — the `cv-covefreeze` working tree is being mutated by the P3 implementer and was not
read. **All four blockers are ACCEPTED and all four are v4 REGRESSIONS I introduced**, not
pre-existing defects the earlier rounds missed. Two of them (R4-B1, R4-B3) are the same mistake in
two different subsystems: a round-3 repair that was made *total* when it needed to be *scoped*, so
it broke the healthy path it was supposed to leave alone. That pattern is called out at the bottom
of this ledger because it is the reusable lesson, not the individual bugs.

| # | Finding | Disposition |
|---|---|---|
| **R4-B1** | The `destinationKey === displayedKey` conjunct wedges EVERY handler-owned stage crossing, not just activity A→B. At the anchor `onOpaque` fires BEFORE activation, the router commit is issued from inside it, and App Router children arrive later while `displayedPathRef` still names the outgoing page — so the conjunct is false at the only moment the swap could happen, the children park, and the sole opaque callback has already fired. The "tautology for non-activity slots" claim is false because `activeScene` changes before `displayedPathRef`. | **ACCEPTED — and this is the most serious error in any round of this spec, because it is a v4 REGRESSION that would have broken `/game`↔`/cove` and `/game`↔`/kelp`, two crossings that work today.** Verified verbatim at `StageTransition.tsx:66-79`: the activate timer runs `onOpaque?.(request)` **then** `state.activateScene(request)` **then** `setTransitionPhase(request.requestId, 'awaiting')`, and `activateScene` is what assigns `activeScene: request.sceneId` (`stage-store.ts:299-302`). `WorldStageRoot.tsx:248` issues `router.push` from inside that callback, so children commit strictly afterwards. At the children commit `activeScene` is already the destination while `displayedPathRef.current` is still the outgoing pathname — the two operands I compared **are never in phase**. Fix (§2m, rewritten a second time): a `openedMidpointRef` records `{requestId, destinationKey}` when a request reaches the opaque midpoint, and children whose destination matches that record install IMMEDIATELY behind the cover. Displayed-key equality is retained only for a destination genuinely already on screen, where it reduces to the existing `pathAlreadyDisplayed` check. §6.2 adds handler-owned **`game→cove`, `game→kelp`, `game→activity`** and activity A→B tests that model the real router-after-midpoint ordering, plus a late-commit-after-`idle` case. **Direction coverage, stated precisely (R5-m6 narrowed this claim):** the UNIT suite covers the three outbound directions only; the REVERSE crossings are covered by `--lane=routes --pair=cove\|kelp` (30 round-trip loops each, §6.4) and §6.5's browser gate. That split is deliberate — the install rule is destination-keyed and direction-agnostic, so three reverse unit cases would exercise the same branch with different string literals while inflating the declared total. |
| **SELF-F** | Why the false tautology survived my own review, recorded because the argument form is the defect and it will recur. I wrote: "`stageDestinationKey` returns the scene id for every slot without sub-identity, so `destinationKey === displayedKey` is the same equality as `activeScene === sceneId` restated." Both halves of that sentence are true **in isolation**; the inference is invalid because the two equalities are evaluated against state that advances on **three different clocks** — `activeScene` at the midpoint, `displayedPathRef` at children-install, and `pathname` at router commit. | **A "tautology by construction" argument is only sound when both operands are derived from the SAME state at the SAME instant.** Where they are not, the claim must be demoted to a hypothesis and pinned by a test. v4 did exactly the opposite: it used the tautology argument to justify *removing* the empirical check ("byte-identical by construction, not by testing") and kept only a weak scope pin, which is why nothing in §6.2 caught it. **v5 rule, applied throughout:** any conjunct added to shared transition code is pinned by a test that models the real callback ordering, and no cross-clock equality is asserted as a tautology. The one place v5 *does* claim a tautology (the ownership conjunct, R4-B2) is explicitly justified by both operands deriving from the same `sceneId` in the same expression — see that row. |
| **R4-B2** | Same-scene destination supersession is still scene-blind. If activity B is pending and pathname C arrives, no C request is minted (both map to scene `activity`), `pendingDestinationKeyRef` stays B, the B midpoint rejects parked C, and B can never paint because the router children are C. `stage-navigation-ownership.ts:19-36` has the same defect: a same-scene/different-room request is `ADOPT` or `EXECUTE_NOW`, never `SUPERSEDE`. | **ACCEPTED, both legs.** Verified the ownership function at the anchor — it branches on `input.pendingRequest.sceneId !== input.targetSceneId` and nothing finer. Verified the suppression conjunct is still `state.pendingRequest?.sceneId !== sceneId`. Fix (§2m, §2n): (a) pending equality becomes **scene AND destination key**, so a same-scene/different-destination pathname mints a superseding request — `requestScene` already handles same-scene supersession correctly (it skips the abandon branch and bumps generation + requestId, `stage-store.ts:143-190`); (b) `decideStageNavigationOwnership` gains `targetDestinationKey` / `pendingDestinationKey` and returns `SUPERSEDE` on mismatch; (c) the parked navigation belonging to the superseded destination is CLEARED on the pathname-driven path — verified necessary because `takeParkedNavigationForOpaque` (`stage-navigation-lineage.ts:25-47`) matches only `requestId`/`retryOfRequestId`, and a supersession mints a fresh `requestId` with no `retryOfRequestId`, so the old parked entry would be orphaned rather than rekeyed by `rekeyParkedNavigationForRetry` (`:7-23`). The handler path self-heals by overwrite. §6.2 adds B→C-before-midpoint, B→C-after-midpoint, the parked-navigation clear, and a new 5-case ownership suite. |
| **R4-B3** | `invalidateStream()` makes legitimate retries stale. If `onerror` routes through it and it bumps `streamEpoch`, the retry callback's captured epoch is stale BY CONSTRUCTION on every ordinary enabled error, so normal SSE recovery is permanently dead — and the disabled-resurrection test passes trivially because ALL retries are dead. | **ACCEPTED — the second v4 overcorrection, and the critique's reasoning is exactly right.** v4 wrote two rules that cannot both hold: "`invalidateStream()` is the ONLY `es = null` in the effect" and "every handler and retry callback checks its captured epoch". `onerror` must drop the source *and* schedule a reopen; making it invalidate kills its own continuation. Fix (§2k, rewritten): split invalidation from source death. `dropFailedSource(source)` closes and nulls the source **without** touching the epoch or the retry lineage; a distinct **retry token** (`activeRetryToken`) is minted when the retry is armed and captured by the timer and by the post-`await` continuation; `invalidateStream()` (CLOSE, `rejoinWithTicket` replacement, `handleSuperseded`, teardown) nulls the token, which is what makes those paths kill an in-flight retry. Source-handler inertness no longer depends on the epoch at all on the error path — the `es !== source` ownership guard already covers it. §6.2 adds the **positive** test the critique asks for: an enabled error opens exactly ONE replacement source, after the delay and not before. |
| **R4-B4** | Rule 2 bypasses the existing exponential backoff. After an ordinary enabled `onerror` the input is `{wanted:true, open:false, pendingReopen:true}`; rule 1 does not match and rule 2 does, so the 200 ms tick calls `OPEN`, skipping `RETRY_DELAY_BASE = 3000` and the 3s/6s/12s escalation, while the armed retry stays armed and rapid tick-driven opens can consume `MAX_RETRIES`. | **ACCEPTED.** Verified the backoff at `use-world-stream.ts:483-489` (`RETRY_DELAY_BASE * 2^(retries-1)`, capped at `RETRY_DELAY_MAX`) and `MAX_RETRIES = 20` (`:22`). v4 added `pendingReopen` to rule 1 and did not consider rule 2, which is the same scoping failure as R4-B1/B3 in miniature. Fix (§2k): **rule 2 requires `!pendingReopen`**. `pendingReopen` is redefined as `activeRetryToken !== null` rather than `retryTimeout !== null`, which is what pins the marker across the ASYNCHRONOUS ticket-recovery branch — once the timer fires, `retryTimeout` is null while `recoverWithTicket()` is still awaiting, and the old definition would have let a tick race the in-flight rejoin. §6.2 pins that window explicitly. |
| **R4-M1** | The §6.2 delta derivation contradicts itself: R3-m1 says "17 added" then enumerates 6+5+5 = 16, omitting the `leaveRef` case; §6.2 says "adds 16" while enumerating 6+6+5 = 17. | **ACCEPTED.** Both statements are corrected to the same wording — **"deletes 1 and adds 17, net +16"** — enumerated as 6 scene-id + 6 overlay/navigation + 5 downlink. The v4→v5 step is stated in the same form so the two rows can be compared directly. |
| **R4-M2** | The R2-m1(c) ledger row still says the pose map will be measured against `origin/staging`, contradicting SELF-E. | **ACCEPTED.** The row is annotated in place rather than rewritten, so the audit trail of what round 2 asked for survives alongside the correction. |
| **R4-M3** | The §6.5 real-history test does not pin its history-stack precondition. A→game→B yields adjacent A/B entries only after the stage's first two push navigations are consumed; a fresh document traverses B↔game instead. | **ACCEPTED.** Verified `decideStageNavigationHistoryMethod` at `stage-navigation-ownership.ts:13-17`: `committedStageNavigations < 2 ? 'push' : 'replace'`. §6.5 now asserts the committed-navigation count before traversing and uses a deterministic `history.go(-2)` / `history.go(+2)` procedure, so the lane cannot silently test the wrong pair. |
| **R4-m3(g)** | P4a and P4c cannot be independently green under v4 semantics. | **ACCEPTED as the acceptance bar**, fourth round running. P4a's blockers are R4-B1/B2, P4c's are R4-B3/B4; each is repaired above. §9's criterion is unchanged in wording and is now satisfiable. |

**The pattern behind R4-B1 and R4-B3, stated once.** Both are round-3 repairs that were correct in
intent and **over-scoped in application**: a guard meant to distinguish two activity rooms was
applied to every slot on a code path where its operands are out of phase; a guard meant to kill a
resurrected stream was applied to the path that legitimately resurrects it. In both cases the
narrow, correct version was available and I chose the total version because it read as simpler.
**v5's counter-measure is structural, not attitudinal:** every guard added in v5 names the exact
path it applies to and the exact path it must NOT apply to, and §6.2 carries a test for the
must-not path — the handler-owned crossings for R4-B1, the positive enabled-error recovery for
R4-B3. A guard with no negative test is how both of these shipped.

**Round 4's verified-correct list is carried forward:** SELF-E is confirmed correct by an
independent anchor check (`ReefRacePlayer.tsx:506,1056-1064` — one setter, one identity-guarded
cleanup delete, no other write site); R3-B3 is complete, with the `UseActivityWsResult` seam
(`useActivityWs.ts:62-66`) and return site (`:336-340`) confirmed as a clean additive extension
point; the server forfeit semantics are accurate; `pendingReopen` correctly detects the disabled
error→null→tick hole (it is simply not sufficient for enabled retries); `stageDestinationKey`
correctly distinguishes rooms A and B and survives into v5 unchanged — only its INTEGRATION was
wrong; P3 v4 stacking matches exactly (rule 8's `stagePendingSceneId === null`, rule 9 reachable,
rule 4 PROCEED/supersede, one generation token with live ownership, inherited tests 97 = 57 + 15 +
25); and all four R3-m2 prose corrections are present.

---

## REVISION LEDGER — round 5 (Codex REJECT, freeze gate)

Every round-5 finding was re-verified at the anchor with
`git -C C:\Users\itachi\Documents\Crypto\clawville show a156e3c0:<path>` before disposition; the
`cv-covefreeze` worktree was not read. **Both blockers are ACCEPTED.** Neither is a v5 regression —
they are pre-existing races that only became reachable once v5 introduced destination-aware
supersession (blocker 1) and a retry lineage (blocker 2). Round 5 closed R4-B1, R4-B3, and R4-M2
mechanically and verified 167 numerically correct; the remaining work is two narrow ownership gaps
and seven editorial fixes.

| # | Finding | Disposition |
|---|---|---|
| **R5-B1** | An already-issued B router navigation can reverse a B→C supersession. Once `handleTransitionOpaque` takes and clears `navigationRef` and `commitStageNavigation` issues `router.push`, the eventual commit has NO lineage. B reaches opacity → B's push is issued → C arrives and correctly SUPERSEDEs → the stale B commit lands → the pathname effect sees incoming B against pending C, clears C's parked navigation and re-mints B. Stale B defeats newer C. | **ACCEPTED.** Verified the ownership gap verbatim: `handleTransitionOpaque` (`WorldStageRoot.tsx:228-250`) does `navigationRef.current = taken.remaining` — which `takeParkedNavigationForOpaque` sets to `null` on a match (`stage-navigation-lineage.ts:38-46`) — and then calls `commitStageNavigation`, which issues `router.push`/`router.replace` (`:165-176`) and records nothing. From that instant until the commit lands, the in-flight navigation is invisible to every guard v5 added. §5i already concedes an issued App Router navigation cannot be cancelled, so v5's own machinery had no way to recognise the late commit as stale. Fix (§2m, new `issuedCommitRef`): `commitStageNavigation` — the single choke point through which EVERY issued navigation passes, including the `EXECUTE_NOW` branch that has no request — records `{destinationKey, superseded:false}`; any later mint for a different destination flips `superseded`; and the pathname effect early-returns on a landing commit whose destination matches a superseded record, installing nothing, minting nothing, and clearing nothing. The URL self-heals when C's own commit is issued at C's midpoint. I took the critique's first option (lineage) over its second (serialize C until B settles) because serialization adds latency to every crossing to fix a race, and "wait for something we cannot observe finishing" is not implementable — the App Router gives no settle callback. §6.2 adds the four cases below. |
| **R5-B2** | Ticket recovery has multiple reopen owners. (a) Disable → rule 1 `CLOSE` → `invalidateStream()` clears the retry token while `/join` recovery intentionally continues → re-enable before `/join` resolves → rule 2 sees `pendingReopen === false` and bare-opens the OLD room. (b) An armed SSE escalation timer fires during a busy 409 recovery; `rejoinWithTicket()` returns `null` when busy (`:267-269`) and `recoverWithTicket()` collapses busy into ordinary failure (`:354-363`), so v5 bare-opens while the real recovery owns `/join`. | **ACCEPTED, and leg (b) is worse at the anchor than the critique states.** Verified `rejoinWithTicket` opens with `if (cancelled \|\| recoveryInFlight) return null;` (`:267-268`). Verified `recoverWithTicket` (`:354-363`) opens with **the same guard** — `if (cancelled \|\| recoveryInFlight) return null;` — so when it is busy it returns `null` **without dispatching `RECOVERY_FAILED` at all**; the machine is never told, and the caller sees a bare `null` identical to a genuine rejoin failure. Busy and failed are indistinguishable from the outside. Fix (§2k, §5e): `WorldDownlinkInput` gains **`recoveryInFlight`**, consumed by **rule 2 only** — folding it into `pendingReopen` or rule 1 would make rule 1 emit `CLOSE` on every tick of a suspended-with-recovery-in-flight window, since `closeStream()` cannot clear a flag it does not own. Separately, the retry continuation distinguishes busy from failed by checking `recoveryInFlight` **after** the await and **re-arming** rather than bare-opening or dropping the reopen. §6.2 adds six cases. |
| **SELF-G** | Re-verifying R5-B2 surfaced a wedge in the naive form of the leg-(b) fix that the critique did not name. The obvious repair is "if `recoveryInFlight` after the await, return early." That leaks: the continuation returns WITHOUT clearing `activeRetryToken`, so `pendingReopen` stays true; if the real recovery then FAILS, `rejoinWithTicket` returns `null` without invalidating anything, and nothing ever clears the token — rule 2 is suppressed permanently and the downlink never reopens. | **The frozen fix is RE-ARM, not return.** On a busy result the continuation calls `armRetry(roomId, delay, shouldEscalate:false)`, which mints a fresh token (replacing the leaked one) and re-queues behind the real recovery. If that recovery succeeds, its `openStream` nulls the token and the re-armed timer's own token check makes it inert; if it fails, the re-armed timer runs normally and the existing `retriesRef`/`MAX_RETRIES` ceiling bounds the loop. Recorded as a full row because "return early on a busy resource" is the intuitive fix and it silently converts a race into a permanent outage — the same class of over-correction as R4-B1 and R4-B3, caught this time before freezing. |
| **R5-m1** | R4-M1 remains contradictory at line 187: it claims "17 added" while enumerating 6 + 5 + 5 = 16. | **ACCEPTED.** The enumeration was missing the `leaveRef` handle-lifetime case, which lives in the overlay bucket. Corrected to **6 scene-id + 6 overlay/navigation (incl. `leaveRef`) + 5 downlink = 17**, matching §6.2 step 4 exactly. |
| **R5-m2** | §6.5's history test reads `committedStageNavigations` from `__WORLD_STAGE_PROBE__`, but no file-list or probe-schema change exposes it; and earlier actions in the same lane may already have pushed the counter into replace mode. | **ACCEPTED, both halves.** Verified the anchor probe snapshot (`WorldStageRoot.tsx:253-296`) exposes `pathname`, `historyLength`, `activeScene`, `transitionPhase`, … and **no navigation counter**. §1a's `WorldStageRoot` row and §3's probe schema now expose `committedStageNavigations`, and §6.5 runs the history case in a **fresh context starting on A with count 0**, asserting 1 then 2 after A→game→B before `go(-2)`/`go(+2)`. |
| **R5-m3** | The rejected tautology argument survives at §2a and in §6.2's scene-id suite, the latter still describing "§2m's added conjunct" that v5 deleted. | **ACCEPTED.** Both are reframed: the identity cases are retained, but they now pin the **ownership contract** (§2n's dead branch and `pendingDestinationKeyRef` equality — same-expression, same-instant) rather than a cross-clock opacity comparison. SELF-F's rule is applied to the prose, not only to the code. |
| **R5-m4** | §2k's retry prose contradicts its own pseudocode: `dropFailedSource()` deliberately leaves `streamEpoch` unchanged, yet three passages call the retry continuation's epoch "stale" or say it "has moved on." | **ACCEPTED.** The epoch after `dropFailedSource` may be **current or later rotated** — it is simply not the continuation's ownership proof. All three passages restated: the token is authoritative; the epoch is neither checked nor assumed. |
| **R5-m5** | The CLOSE summaries at §2k and §5e still use v4's marker, claiming that clearing `es` and `retryTimeout` makes `pendingReopen` false. | **ACCEPTED.** In v5+ that requires clearing `activeRetryToken`. Both restated as "`closeStream` → `invalidateStream` clears the source, the timer, **and the retry token**." |
| **R5-m6** | The R4-B1 ledger row claims bidirectional `game↔cove` / `game↔kelp` / `game↔activity` unit tests, while §6.2 adds only the three `/game`→destination directions. | **ACCEPTED; claim NARROWED rather than padded.** The unit suite covers the three outbound directions; reverse crossings are covered by the `--lane=routes --pair=cove\|kelp` round-trip lanes and §6.5's browser gate, which drive 30 loops in both directions. Adding three near-identical reverse unit cases would inflate the total without testing a distinct code path — the install rule is destination-keyed and direction-agnostic. The ledger row now says which layer covers which direction. |
| **R5-m7** | §6.2 labels its reconciliation "in four steps" but numbers five. | **ACCEPTED.** Now "in five steps" (six after v6's own step is added). |
| **R5-m3(g)** | P4a and P4c remain non-green. | **ACCEPTED as the acceptance bar**, fifth round running. P4a's blocker is R5-B1, P4c's is R5-B2; both are repaired above. |

**Round 5's verified-correct list is carried forward**, and it is the largest yet: the anchor opacity
ordering is exactly `onOpaque → activateScene → awaiting`; the v5 midpoint predicate handles ordinary
handler-owned crossings in both directions, activity A→B, and late commits after `idle`;
pathname-first A→B at rest parks and mints; B→C before the midpoint is covered on both paths;
destination mismatch correctly converts `ADOPT`/`EXECUTE_NOW` to `SUPERSEDE`; ordinary continuously
enabled SSE errors recover once after the intended backoff (R4-B3 closed); the disabled-edge error
path stays dead absent a re-enable race; rejoin replacement, `handleSuperseded`, teardown, and
explicit CLOSE all have concrete invalidation sites; **167 is numerically correct** — suites, running
sum, and the v4→v5 delta all reconcile independently; and P3 v4 stacking remains exact (rule 4
PROCEED/supersede, rule 8's `stagePendingSceneId === null`, rule 9 reachable, one token per requested
generation, inherited tests 97 = 57 + 15 + 25).

**What the last two rounds have in common, since it now predicts where the next defect will be.**
R4-B1, R4-B3, R5-B1, and R5-B2 are all **ownership gaps at a hand-off boundary** — a value that is
authoritative on one side of a callback, an await, or a router call, and unowned on the other. v6
adds the two remaining hand-offs (`commitStageNavigation` → router commit;
`recoverWithTicket` → its own busy guard) to the same discipline the earlier rounds applied to
midpoint→children and error→retry. A reviewer looking for a sixth defect should look for the next
boundary where something is issued and then forgotten.

---

## REVISION LEDGER — round 6 (Codex REJECT, freeze gate)

Every round-6 finding was re-verified at the anchor with
`git -C C:\Users\itachi\Documents\Crypto\clawville show a156e3c0:<path>`. **Both blockers are
ACCEPTED, and the report's framing is accepted with them: these are the third and second reports
respectively on the SAME two areas, and the reason is that v5 and v6 both patched the reported
INSTANCE instead of designing the mechanism.** v7 therefore does not add another guard to either
area. It states an INVARIANT for each, builds a mechanism that can express it, and enumerates every
site that must obey it with a proof for each. Where a site is safe for a reason other than an
explicit check, the reason is written down rather than assumed.

| # | Finding | Disposition |
|---|---|---|
| **R6-B1** | `issuedCommitRef` is overwritten exactly when C reaches its midpoint. At the anchor C's `onOpaque` issues C BEFORE the transition becomes `awaiting` (`StageTransition.tsx:66-79`), so `{B, superseded:true}` becomes `{C, superseded:false}` and the pinned "release stalled B after C is awaiting" test cannot pass — late B re-mints B and supersedes C. | **ACCEPTED. The single-slot design was wrong in principle, not merely under-guarded.** One slot cannot represent two overlapping in-flight commits, and B and C overlap **by construction**: C's commit is issued from inside the same callback that would have to preserve B's record. v6 also had no retirement model, so a never-landing record persisted until reset. Fix (§2m, rewritten): a **navigation issue ledger** — an append-only bounded list of `{id, destinationKey, href, issuedAt, status}` records with explicit issue / supersede / settle / retire operations (§2m-A). Settlement matches **the issue a landing belongs to** (by destination key, preferring an in-flight record over a superseded one) rather than "whatever occupies the ref". |
| **R6-B2** | Pathname-first C has neither URL repair nor safe lineage retirement. §2m's claim that "C's own navigation repairs the URL" holds only for handler-owned C: a pathname-first C mints through the children effect and places nothing in `navigationRef`, so C's midpoint issues no router navigation and a late B leaves the URL at B while the stage shows C. And a never-landing superseded record can swallow a later legitimate traversal to the same destination. | **ACCEPTED, both halves, and the second half is the sharper one.** Verified that the pathname-first mint path never touches `navigationRef` — it is the children-swap effect, which has no navigation to park. Fix: (a) **explicit URL repair** at the stale-landing early return, driven by a `currentIntentRef` that both mint sites write, issued as a `router.replace` that is itself registered in the ledger and deliberately does NOT increment `committedStageNavigationsRef` (so §6.5's push/replace threshold is undisturbed); (b) **retirement is bounded twice** — by count (`MAX_TRACKED_NAVIGATION_ISSUES = 8`) and by age (`NAVIGATION_ISSUE_TTL_MS = 10_000`, deliberately equal to `OUTGOING_OVERLAY_COMMIT_TIMEOUT_MS` so the spec has ONE horizon for "this commit is not coming"); and (c) **the swallow is prevented by settlement ORDER, not by retirement** — `settleIssue` prefers an in-flight record over a superseded one, so a later legitimate B traversal settles its own live issue even while a stale superseded B is still in the ledger. Retirement alone would have left a 10 s window in which the swallow was still reachable. |
| **R6-B3** | "Busy → re-arm" is only a delay, not exclusive ownership. When the re-armed timer expires, the `!shouldEscalate` branch bare-opens **without** checking `recoveryInFlight`; and the anchor `/join` fetch has no timeout, so any recovery longer than the re-arm delay recreates the original race. | **ACCEPTED, and the anchor fact is worse than "no timeout" suggests.** Verified `join()` (`use-world-stream.ts:140-146`): a bare `await fetch(...)` with **no `AbortController`, no `signal`, and no deadline** — it can hang for as long as the network holds the socket. So "wait one backoff delay and then assume the recovery is done" is not a bound, it is a guess. Fix (§2k, rewritten as an invariant): **while `recoveryInFlight` is true, no path other than the recovery itself may open a source.** The check moves to the ONE place every timer-driven open passes through — the top of the `armRetry` timer body, before the escalate/bare branch — and every other open site is enumerated with a proof (§2k-A). Busy-waiting is bounded by a wall-clock ceiling after which the retry lineage RETIRES and ownership transfers to the rule-2 tick edge, which is itself `!recoveryInFlight`-guarded. |
| **SELF-H** | Enumerating the open sites for R6-B3 surfaced one the critique did not name and that I had never justified: `bootstrap()`'s `openStream` at `:554`. It is guarded by `downlinkEnabledRef` but by nothing recovery-related. | **Proven safe, and the proof is now written down instead of assumed.** `bootstrap()` runs only from the machine's `BOOTSTRAP` action, whose branch requires `!input.hasSession` (`world-stream-machine.ts:90-100`). A ticketed recovery only ever runs for an EXISTING session, and `rejoinWithTicket` does not clear `sessionIdRef` — it assigns the new id on success (`:274`) and leaves the old value untouched on failure — so `hasSession` is true for the entire duration of any recovery and `BOOTSTRAP` cannot be emitted during one. **This is exactly the class of reasoning v5 and v6 skipped**: a site is not safe because nobody has reported it, it is safe because a stated predicate makes it unreachable. §2k-A carries the proof per site so a future reviewer can check it rather than re-derive it. |
| **R6-m1** | The declared total is **178**, not 177, under the spec's own counting rule: SELF-G's bullet contains two cases (recovery success, then a repeat with recovery failure) but carries no `**(2)**` weight, while §6.2 requires explicit weighting for multi-case bullets. | **ACCEPTED — and this is the sixth consecutive round with an arithmetic defect, so the remedy is a procedure, not a number.** The weight is added. More importantly, before re-summing I re-audited **every** bullet in §6.2 for un-weighted multi-case prose, not only the one reported; that audit is recorded under §6.2's derivation so the next round can check the procedure rather than re-derive the total. The corrected v6 figure is 178 and v7 builds from there. |
| **R6-m2** | §2k still derives `pendingReopen:false` from clearing only `es` and `retryTimeout` in one remaining summary. | **ACCEPTED.** That passage now names `activeRetryToken` as the field idempotence depends on, matching the two already corrected in v6. |
| **R6-m3** | §9 lists `issuedCommitRef` among the **v5** repairs; it is v6-introduced. | **ACCEPTED.** Removed from the v5 sentence; the v6/v7 attribution below it was already correct. |
| **R6-m3(g)** | P4a and P4c remain non-green. | **ACCEPTED as the acceptance bar**, sixth round running. P4a's blockers are R6-B1/B2, P4c's is R6-B3; all three are repaired above. |

**Why this round is structured as invariants and not fixes.** Rounds 4, 5, and 6 produced six
blockers across exactly two areas, each one an adjacent race in the same subsystem the previous
round had just patched. The pattern is not carelessness about the reported case — each reported case
was fixed correctly — it is that a point fix has no way to say what the NEXT case is. v7 replaces
both point fixes with a named invariant, a mechanism able to represent it, and an exhaustive site
table:

- **§2m-A — the navigation-lineage invariant.** *Every router navigation this component issues is
  represented by exactly one ledger record until it lands or retires, and a landing settles the
  record it belongs to.* Sites: two mint sites, one issue site, one settle site, one repair site,
  two retirement rules.
- **§2k-A — the reopen single-owner invariant.** *At any instant at most one actor may open an
  EventSource, and while `recoveryInFlight` is true that actor is the recovery.* Sites: five, each
  with an explicit proof of obedience.

If a round-7 defect exists in either area, it should be expressible as "site X violates invariant Y"
— and if it is not, the invariant itself is wrong and should be replaced rather than patched.

**Round 6's verified-correct list is carried forward:** rule 2 correctly requires
`!recoveryInFlight`; rule 1 correctly excludes it, preventing repeated `CLOSE`; `join()` converts
fetch/JSON rejection to `null`; `rejoinWithTicket` clears `recoveryInFlight` via `finally` on both
paths; a busy `recoverWithTicket()` returns `null` without emitting `RECOVERY_FAILED`; the
stale-B-before-C-midpoint case was guarded (failure began only once another issue overwrote the
record); R4-B1 and R4-B3 stay closed; the R4-M1/R5-m1 enumeration is reconciled; the R4-M3/R5-m2
probe exposure and fresh-history procedure are complete; and **P3 v4 stacking remains exact** —
rule 4 PROCEED/supersede, rule 8's `stagePendingSceneId === null`, rule 9 reachable, §2i's one token
per requested generation with live ownership and abort-without-report, inherited tests
97 = 57 + 15 + 25.

---

## REVISION LEDGER — round 7 (Codex REJECT, freeze gate)

Every round-7 finding was re-verified at the anchor with
`git -C C:\Users\itachi\Documents\Crypto\clawville show a156e3c0:<path>`. **All four blockers are
ACCEPTED and all four remedies are adopted as the critique specifies them.** The meta-lesson is
accepted too and is the organising idea of v8: rounds 5-7 all failed because **the spec inferred
identity or liveness that the platform does not provide**. v7 asserted a per-issue `id` no landing
could read, and asserted an ownership transfer to an actor gated on a flag that could never clear.
v8 stops inferring: navigation identity is **carried in the URL** where a landing can read it, and
recovery liveness is **bounded in code** by an abort deadline instead of assumed.

| # | Finding | Disposition |
|---|---|---|
| **R7-1** | INVARIANT N claims a per-issue identity no landing can observe. `settleIssue` accepts only `destinationKey`, so the ledger `id` is internal bookkeeping. With B₁ superseded by C and a later legitimate B₂ issued while B₁ is outstanding, both landings present only destination B and settlement always prefers B₂'s in-flight record — nothing distinguishes them. The §6.2 test covered only two DIFFERENT destinations, where destination identity trivially suffices. | **ACCEPTED — the identity was invented, exactly as charged.** Fix (§2m-A, rewritten): a reserved query nonce **`__wsnav`** is appended to every component-issued URL inside `commitStageNavigation`, and settlement is **by nonce, not destination**. The landing reads it through `useSearchParams()` — which forces a second, previously unstated change (see R7-1b). Stripping is `window.history.replaceState`, NOT `router.replace`, so it creates no second landing and no unregistered navigation; `URLSearchParams.delete` removes only our key, so user query and hash survive by construction. A landing with **no** nonce is classified `unissued` (genuine browser traversal or deep link) and takes the fresh-arrival path unchanged. §6.2 adds the same-destination out-of-order tests. |
| **R7-1b** | Surfaced while adopting R7-1's fix, not reported: `WorldStageRoot` lives in `app/(world)/layout.tsx`, and that file has **no `dynamic` export** at the anchor. | **A same-diff requirement, now declared (§1a).** `useSearchParams()` in a client component opts its subtree into client-side rendering unless the route is dynamic or the read sits under `Suspense`. `(world)/game/layout.tsx` and `(world)/cove/layout.tsx` are force-dynamic, and §1a already adds one for `/activity` — but the GROUP layout that actually hosts `WorldStageRoot` is not. v8 adds `export const dynamic = 'force-dynamic';` to `app/(world)/layout.tsx`. Verified at the anchor that the file contains only the `WorldPresence` + `WorldStageRoot` wrapper with no route-segment config. Had this been missed, the nonce read would have silently changed the rendering mode of every route in the group. |
| **R7-2** | Retirement destroys provenance: a landing after age or count retirement settles as `null` and becomes a fresh pathname arrival, so a stale B can mint over a completed C. The §6.2 age-retirement test PINNED that unsafe behavior. Retirement is also lazy (never runs on idle time alone), and ledger/sequence cleanup on reset is unspecified. | **ACCEPTED, every leg, and the pinned-unsafe-test charge is the one that stings.** Fix (§2m-A): retirement no longer deletes — it moves the record to a bounded **tombstone ring** carrying `{id, status}`. A landing whose nonce matches no live record but is component-issued is classified **`issued-stale`**, never `unissued`, so it is repaired against current intent and **can never mint**. A nonce older than the tombstone ring is classified `issued-stale` too — the conservative direction, because the worst outcome of that choice is a redundant repair, whereas the worst outcome of guessing `unissued` is the R7-2 defect. **Correctness therefore no longer depends on retirement timing at all**, which dissolves the lazy-retirement objection rather than answering it: age retirement is demoted to explicitly-labelled memory hygiene, and both rings are count-bounded so idle time cannot grow them. Reset and unmount clear the ledger, the tombstones, and `currentIntentRef` — but deliberately **do NOT reset the nonce sequence**, since a restarted sequence could re-issue an id that a surviving tombstone still describes. The unsafe test is REPLACED, not patched. |
| **R7-3** | Pathname-first intent captures `href: pathname`, discarding search and hash, while `WorldStageHref` explicitly supports both — and `repairUrlToCurrentIntent` compares pathname only, so a stale landing with the right path and wrong query reads as "already correct". Material because `page.tsx:112-114` seeds `shortCode` from search params. | **ACCEPTED.** Verified `const [shortCode, setShortCode] = useState<string \| null>(searchParams?.get('shortCode') ?? null)` at `page.tsx:112-114` — a repair that drops the query genuinely destroys a room's join identity. Fix (§2m-A, §2a): both mint sites capture the **complete** stage href (pathname + search + hash, minus our own nonce), and repair compares **canonical full URLs** through one `canonicalStageUrl()` helper used on both sides. §6.2's test now asserts exact URL equality and explicit query preservation instead of pathname equality. |
| **R7-4** | INVARIANT R still dead-retries when `/join` never settles: after the 30 s ceiling the lineage retires, but rule 2 is itself gated on `!recoveryInFlight`, which never clears — so ownership transfers to an actor that can never act. Zero opens, forever. | **ACCEPTED — the ownership transfer was nominal and the critique's phrasing is exactly right.** v7 bounded the WAIT but not the thing being waited on. Verified again that `join()` is a bare `await fetch(...)` with no `AbortController`, no `signal`, and no deadline (`use-world-stream.ts:140-146`). Fix (§2k-A): recovery itself becomes bounded in code — an `AbortController` with **`JOIN_TIMEOUT_MS = 15_000`**, plus an **expiring recovery lease** so a late completion that somehow survives the abort is inert. `rejoinWithTicket`'s existing `finally` then guarantees `recoveryInFlight` clears within the timeout, `RECOVERY_FAILED` transitions exactly once, and rule 2 becomes able to act. **Ordering is now an invariant:** `JOIN_TIMEOUT_MS < RECOVERY_WAIT_CEILING_MS`, so the ceiling is a backstop that should never fire — and §6.2 tests the permanently-unresolved cell rather than assuming eventual settlement. The self-contradictory v7 test (a "never resolving" setup that later resolves) is rewritten. |
| **R7-5** | The declared total fails v8's own frozen counting rule. Printed weights sum to 191 and the delta reconciles, but the conservative recount is ≥ 207: readiness's ten terminal values weighted (4), overlay's `/cove`+`/kelp` unweighted, downlink's `!hasSession`/`!hasRoom` and `persisted` true/false unweighted, and held-key hiding ~16 cases in 9. The claim that all 155 bullets were audited is not supported. | **ACCEPTED, and the process claim is withdrawn.** My round-6 audit scanned for a *lexical* cue list rather than applying the semantic rule I had just frozen, so it found four candidates and missed every one of these. That is a weaker check than advertised and I said otherwise. v8 re-audits **every** bullet against the rule "N distinct setups ⇒ weight N", corrects each defect by **weighting** it (never by arguing the minimum down), and the four named suites move exactly as the critique derives. The re-audit is scripted and its output is quoted in §6.2 so the next round can re-run it rather than trust a claim. |
| **R7-m1** | §9's rollout rows are stale relative to v7: P4a does not name the ledger, exact settlement, intent repair, or retirement lifecycle; P4c does not name the top-of-timer guard or the wait ceiling. | **ACCEPTED.** Both rows rewritten against the v8 designs. |
| **R7-m1(g)** | P4a and P4c remain non-green. | **ACCEPTED as the acceptance bar**, seventh round. P4a's blockers are R7-1/2/3, P4c's is R7-4; all are repaired above. |

**What changed in method, and why it should end this cycle.** Rounds 5, 6, and 7 each produced a
narrower version of the same two defects, and the reason is now legible: every remedy up to v7 was
built on a fact the runtime does not expose. v7's ledger id existed only in memory, so no landing
could cite it. v7's ownership transfer named an actor whose gate no one could open. **v8 replaces
both inferences with things the platform actually provides** — a query parameter the browser carries
through every navigation, and an `AbortSignal` that makes a hung fetch terminate. Neither is clever;
both are checkable at the call site. If round 8 finds a defect here it should be a defect in the
*contract* (wrong param name, wrong timeout ordering, a missed strip site), not another invented
guarantee.

**Round 7's verified-correct list is carried forward:** the ledger correctly preserves overlapping
DIFFERENT-destination records; a superseded different-destination landing inside the retention
window installs and parks nothing; registered URL repair does not increment
`committedStageNavigationsRef`; all anchor `openStream` sites are represented in §2k-A; **SELF-H's
bootstrap proof is valid and CLOSED**; the finite-recovery top-of-timer guard closes R6's double-open
race, and the five-site reopen walk passes for every finite-recovery cell; R6-m2 and R6-m3 are fully
corrected; and **P3 v4 stacking remains exact for the seventh consecutive round** — rule 4
PROCEED/supersede, rule 8's `stagePendingSceneId === null`, rule 9 reachable, §2i's one token per
requested generation with live `isCurrent` ownership and abort-without-report, inherited tests
97 = 57 + 15 + 25, with no drift in the declared-unchanged passages.

---

## REVISION LEDGER — round 8 (Codex REJECT, freeze gate)

Every round-8 finding was re-verified at the anchor with
`git -C C:\Users\itachi\Documents\Crypto\clawville show a156e3c0:<path>`. **All four blockers and
both majors are ACCEPTED.** One of them — B2 — is the first finding in eight rounds that overturns a
**factual premise** rather than a design choice, and it is the most important thing in this ledger:
I asserted a Next.js behavior without checking the version I was writing against.

| # | Finding | Disposition |
|---|---|---|
| **R8-B1** | Same-destination ordering is non-total. `supersedeIssuesExcept(destinationKey)` deliberately leaves same-destination records in flight, so B1 `?shortCode=OLD` and B2 `?shortCode=NEW` with no intervening C are BOTH `in-flight`; a late B1 classifies `issued-live`, settles, and can restore OLD over NEW. The v8 tests always insert C, which marks B1 stale and hides the case. | **ACCEPTED.** The "same destination is not a supersession" rule came from R6-B2 and was right about SCENE identity and wrong about ISSUE identity: two navigations to the same destination with different queries are two different intents. Fix (§2m-A): the operation becomes **`supersedeAllLiveIssues()`** — every new intent and every new issue supersedes ALL older live records, same destination included. At most one record is `in-flight` at any instant, which is the property that makes "the newest intent wins" total rather than case-by-case. §6.2 adds B1/B2 orderings **with distinct query values and no intervening C** — the exact shape the v8 suite could not fail. |
| **R8-B2** | The strip design rests on a FALSE premise. The anchor pins Next `^16.2.0` and the lockfile resolves **16.2.3**, and Next documents that native `pushState`/`replaceState` **do** synchronize `usePathname`/`useSearchParams`. So §2m-A's "`useSearchParams()` does not observe `replaceState`" is wrong: stripping re-runs the effect. Unsafe for stale B — the repair schedules registered C, the strip synchronously rewrites the URL to nonce-free B, the hook re-runs before C lands, B classifies `unissued`, and fresh-mints over C. | **ACCEPTED, and this is the finding I am least comfortable with, because it is a fact I could have checked and did not.** Verified `"next": "^16.2.0"` at `apps/web/package.json:40` and `"next@16.2.3"` in the lockfile. Everything I built on the false premise is rebuilt: **(a) the stale branch never strips when it issued a repair** — the registered replacement overwrites the URL and carries its own nonce, so the stale one leaves with it; **(b)** when the stale branch issues no repair (URL already equals intent) it strips behind an explicit **one-shot re-entry guard** (`suppressNextLandingRef`), set immediately before `history.replaceState` and consumed at the top of the effect; **(c)** the healthy branch strips behind the same guard. The guard is now the mechanism, not an accident of ordering — v8's healthy path happened to be harmless only because `restingOnDestination`/`pendingMatchesDestination` suppressed the mint, which is exactly the "benign by accident" this round exists to reject. The dishonest "consumed nonce still visible" test is DELETED and replaced by a no-nonce-rerun test. |
| **R8-B3** | Nonce provenance and root lifetime are invented. Any positive integer is accepted as locally issued, so a URL from a nonce-bearing component URL and opened from a bookmark in a NEW document is falsely treated as ours; a settled-nonce replay returns without stripping; `useRef(0)` cannot stay monotonic across a real `WorldStageRoot` unmount/remount, contradicting the v8 claim and its own test; and `stage-store.ts:454-468` resets store state only — it cannot clear component refs. | **ACCEPTED, every leg.** Verified `resetStage: () => set((state) => createInitialState(state.stageEpoch + 1))` — store/epoch state, with no channel to component-local refs. Fix (§2a, §2m-A): the nonce becomes **`${documentEpoch}.${sequence}`**, where `documentEpoch` is a random id minted ONCE PER DOCUMENT and the whole lineage (epoch, sequence, ledger, tombstones, intent) lives in a **module-scoped namespace**, not in hooks — so it survives root unmount/remount and is fresh in a new document by construction. Classification gains a fourth class, **`foreign`**: a nonce whose epoch is not ours is stripped and treated as a genuine fresh arrival, which is the correct reading of a bookmarked URL. Same-document unknown ids stay `issued-stale`. An explicit `resetStageNavigationLineage()` is called beside `resetStageStore()` and clears ledger/tombstones/intent but deliberately **not** epoch or sequence. |
| **R8-B4** | The lease never independently expires. It is set before `await join(true)` and cleared only in that call's `finally`, so if fetch or body parsing survives the abort — the precise late-completion case the lease claims to handle — the await stays pending, the lease never expires, `recoveryInFlight` never clears, and the permanent dead retry is back. The two v8 tests cannot both pass. And the `finally` clears `recoveryInFlight` OUTSIDE the lease guard, so an expired lease 1's late `finally` can clear lease 2's ownership. | **ACCEPTED — the abort was doing the job the spec claimed the lease was doing, and neither was independent.** Fix (§2k-A): the complete fetch-plus-body operation is **raced against an independent deadline promise**, so termination does not depend on the fetch honoring `AbortSignal` at all — `controller.abort()` is demoted to cleanup, exactly as the critique frames it. Every settlement path — success, failure, timeout, `superseded`, and any late completion — goes through **one lease-owned CAS helper**, and `recoveryInFlight`, the lease, the machine dispatch, the ref writes, and any `openStream` all happen **inside** its `activeRecoveryLease === lease` guard. §6.2 tests late `JoinResponse` and late `{superseded:true}` separately, plus the lease-1-cannot-clear-lease-2 case. |
| **R8-M1** | The repair's forced-replace contract is not implementable: `commitStageNavigation({to})` at the anchor ALWAYS increments `committedStageNavigationsRef` and picks the method through the normal threshold; the request type exposes no repair mode. | **ACCEPTED.** Verified `WorldStageRoot.tsx:165-176` verbatim — `committedStageNavigationsRef.current += 1` is unconditional and `decideStageNavigationHistoryMethod` chooses the method. v8 asserted behavior the code cannot produce. Fix (§2m-A): a second parameter `commitStageNavigation(navigation, { history: 'replace', countTowardStageHistory: false })`, defaulting to `{history:'auto', countTowardStageHistory:true}` so every existing call site is byte-identical. §6.2 tests both the emitted nonce and the unchanged counter. |
| **R8-M2** | 228 is still undercounted; the semantic minimum is **230**. The kelp amendment's first bullet covers two amended rules (§1b requires rules 3 AND 4) and the held-key equivalence bullet covers both consumers; neither is weighted. The ownership bullet "Either destination key null/omitted" is ambiguous. | **ACCEPTED.** Both weights applied (kelp 2→3, held-key 16→17), giving the honest pre-v8-change basis **191 + 23 = 214** and a corrected v8 total of **230**. The ambiguous ownership bullet is **narrowed to "both omitted"** — one configuration, one case — rather than enumerated, because the other configurations are not reachable from `WorldStageRoot`, which is the only caller. |
| **R8-MOD** | v7 algorithms linger in current implementation guidance: §1 still says `settleIssue` prefers in-flight over superseded; §6.2 retains destination-based settlement language; §2k says `/join` has no bound in present tense; §7's `ARCHITECTURE.md` row omits the v8 contracts; §9 instructs destination-preferred settlement and says the ceiling is the bound. | **ACCEPTED.** Every named passage is rewritten to the v9 contracts, and the sweep was widened past the named lines — a spec whose file list and rollout rows describe a superseded algorithm is a spec an implementer will build from. |

**The lesson I am taking from R8-B2, stated plainly.** Rounds 5-7 were failures of *design totality*; this
one includes a failure of *verification*. I wrote "`useSearchParams()` does not observe
`replaceState`" as a load-bearing premise, built three mechanisms on it, and never opened
`package.json` to see which Next I was writing against — while spending the same round verifying
line numbers in `use-world-stream.ts` to the digit. **The anchor discipline this spec applies to
repository code was not applied to the framework contract.** v9 therefore cites the resolved
framework version (`next@16.2.3`) next to every claim about framework behavior, and §8 records the
remaining framework-behavior assumptions I have NOT verified so a reviewer can aim at them.

**Round 8's verified-correct list is carried forward:** `canonicalStageUrl()` preserves query/hash
while excluding only `__wsnav`; B1/C/B2 with an intervening C is distinguishable by nonce;
retired and count-evicted same-document records safely become `issued-stale`; both rings are
count-bounded and the lazy TTL is honestly memory hygiene; nonce stamping occurs after buffering so
P3's `bufferedPathname` amendment is not disturbed; the five stream-open categories are complete;
for finite recovery the top-of-timer guard, retry token, rule-2 guard, and bootstrap's `!hasSession`
predicate prevent double-open and repeated CLOSE loops; the rollout rows close R7-m1; and **P3 v4
stacking remains exact for the eighth consecutive round** — rule 4 PROCEED/supersede, rule 8's
`stagePendingSceneId === null`, rule 9 reachable, §2i's one reset-bearing token per requested
generation with live `isCurrent` and abort-without-report, inherited tests 97 = 57 + 15 + 25.

---


## REVISION LEDGER — round 9 (Codex REJECT, freeze gate)

Verified at the anchor with `git -C C:\Users\itachi\Documents\Crypto\clawville show a156e3c0:<path>`.
**All four blockers, both majors, and both minors are ACCEPTED.** Milestone worth recording: **R8-M2
is CLOSED** — every §6.2 heading matched its explicit weights and the 230→242 reconciliation verified
correct, the first fully clean count in nine rounds. Round 9 is explicit that this was an arithmetic
pass and not a coverage pass, and the missing coverage below is added rather than folded into 242.

| # | Finding | Disposition |
|---|---|---|
| **R9-B1** | "Newest intent wins" is not total at the handler→issue hand-off. `currentIntentRef` updates only inside request-minting; the handler's same-destination `ADOPT` path does not mint; issuance neither records the issued href as the newest intent nor uses the module sequence. So B2 (same destination, NEW query) can be adopted and issued while current intent stays OLD, and a late stale B1 repairs to OLD — defeating the newer intent. | **ACCEPTED.** Verified `WorldStageRoot.tsx:198-203`: the `ADOPT` branch writes `navigationRef.current = {requestId, navigation}` and returns — it does not mint, so nothing in v9 ever saw it as a new intent. Fix (§2m-A): one atomic module operation **`acceptNavigationIntent(href)`** — canonicalize the full href, `supersedeAllLiveIssues()`, record the intent — invoked at **all four** accepted-navigation sites (`EXECUTE_NOW` `:194`, `ADOPT` `:198-203`, the `SUPERSEDE` fallthrough `:206`, and the pathname-first mint `:132`), and again inside `issueNavigation`, which now takes its id from `nextNavNonce()`. Because supersession and intent-recording happen in ONE call, they cannot drift apart — which is what the two-step v9 version permitted. The contradictory test demanding "TWO outstanding in-flight issues" is rewritten to one superseded plus one in-flight. |
| **R9-B2** | The one-shot boolean strip guard can swallow a legitimate navigation. Next guarantees native `replaceState` synchronizes the hooks but NOT that its rerender is the next effect execution, so a real router landing arriving first consumes the boolean and is ignored. Especially reachable from `foreign`, which strips and then falls through and may mint. | **ACCEPTED, and my §8 disclosure made this worse rather than better** — I wrote that the ordering was unverified and then claimed the guard was "safe either way", which is precisely the kind of hedge that hides a defect. It is not safe either way: a boolean cannot tell WHICH landing it is suppressing. Fix (§2m-A): the guard stores **the exact expected nonce-free URL** (`suppressStripHrefRef.current = strippedHref`); at effect entry it suppresses only when the observed full URL equals that string, and on mismatch it clears the stale guard and processes the navigation **normally**. Identity, not a counter — the same correction R7-1 applied to navigation identity, now applied to the guard. Cleared on explicit lineage reset. |
| **R9-B3** | Root remount can kill a navigation that must survive: v9 preserves epoch and sequence across remounts but calls `resetStageNavigationLineage()` on mount, so an issue outstanding across a remount lands as same-document-unknown ⇒ `issued-stale` ⇒ repair has no intent ⇒ it strips and returns, and B is lost. The spec left the choice to implementation, so it was not freeze-ready. | **ACCEPTED, and ONE semantic is now FROZEN** — the critique offered two and v9's failure was leaving the choice open. **Frozen: the navigation lineage is DOCUMENT-scoped. It survives every root remount and every stage reset, and is cleared only by document teardown** — which mints a new `documentEpoch`, making every prior nonce `foreign` by construction. That is the semantic the epoch already implied; v9 contradicted it by clearing on mount. Verified the mount effect at `WorldStageRoot.tsx:99-103` is `resetStageStore(); resetStageFrameDiagnostics(); setStageReady(true)` — the lineage call is simply removed from it. `resetStageNavigationLineage()` remains exported **for test isolation only**, and §2m-A says so rather than leaving a caller to be inferred. Rejected option (b) (a reset-adoptable set) because it adds a third record state and a second bounded ring to reach the same outcome. |
| **R9-B4** | Lease settlement is neither single-CAS nor exactly-once. Only the `Promise.race` winner reaches `settleRecovery` — the loser's late resolution is abandoned, not refused by the CAS as claimed; and the anchor's unchanged `recoverWithTicket()` dispatches `RECOVERY_OK/FAILED` a SECOND time off the returned room id, so every settlement cell double-dispatches. | **ACCEPTED, both legs, and the settlement walk is right in all seven cells.** Verified `recoverWithTicket` at `use-world-stream.ts:354-362`: it awaits `rejoinWithTicket()` and then dispatches on `roomId ? 'RECOVERY_OK' : 'RECOVERY_FAILED'` — v9 added a dispatch inside `settleRecovery` and left that one in place. Fix (§2k-A): **both producers call the CAS** — the join arm and the deadline arm each call `settleRecovery(lease, outcome)` and resolve a shared deferred, so the later one is genuinely REFUSED by the guard rather than dropped; the deadline timer is cleared when the operation wins; and **all recovery dispatch is removed from `recoverWithTicket()`**, leaving `settleRecovery` as the single dispatch site. The refusal path opens nothing **because `openStream` lives inside the guarded helper** — that is now stated explicitly, since "what happens to a source a late success opened" was the critique's specific question and the answer is that it never opens one. |
| **R9-M1** | Current implementation guidance still contains mutually exclusive algorithms — the file-list row names the module store then instructs `navigationIssuesRef`/`supersedeIssuesExcept`; nonce ids are typed `number`; the issuance block stamps `String(++navigationIssueSeqRef.current)`; two test bullets still describe destination-preferred settlement; and the recovery row still specifies v8's abort-plus-lease. | **ACCEPTED, and the instruction is taken literally: REPLACE, do not annotate.** v9 annotated superseded passages and left the old code readable as guidance; an implementer builds from the code block, not the footnote. Every current-contract block and file-list row is rewritten to the v10 algorithm. Historical ledger prose keeps the old names, clearly labelled as history. |
| **R9-M2** | Adversarial coverage is incomplete despite correct arithmetic: the B1/B2 tests do not land both issues in BOTH orders through completion; and there is no test for a legitimate navigation arriving while the strip guard is armed, an outstanding issue landing after a real root remount, or same-destination distinct-query handler paths through `ADOPT` and `EXECUTE_NOW`. | **ACCEPTED**, and the requirement that these cannot hide inside 242 is honored — §6.2 re-derives to **265**. |
| **R9-m1** | The protocol base is stale: P4 pins 41→42, but P3 landed as **42** after the wallet slice consumed 41. | **ACCEPTED with a stated limitation.** Rebased to **42→43** everywhere P4 makes a live change, and the four `hatcher-integration-spec.md` references and three test pins move with it. **What I could and could not verify:** the anchor has `PROTOCOL_VERSION = 40` (`skill-protocol.ts:372`), and P3 is not landed at the anchor, so I cannot confirm 42 from this tree — the 42 base is round 9's report, accepted on its authority. **The implementer must re-read the landed constant before editing it**, and §1c now says so instead of asserting a number I did not see. |
| **R9-m2** | Epoch collision resistance is weaker than the "fresh by construction" wording: `Date.now().toString(36) + Math.random().toString(36).slice(2,8)` is ~31 random bits for documents created in the same millisecond. | **ACCEPTED.** Now `crypto.randomUUID()`, and the sequence suffix is validated with an all-digits test rather than permissive `parseInt` (which accepts `"7abc"` as 7). The claim and the mechanism now match. |

**What round 9 changes about how I write this spec.** R9-M1 is the second consecutive round to find
superseded algorithms sitting in current guidance, and R9-B2 found a hedge — "unverified but safe
either way" — standing in for a design decision. Both are the same failure: **leaving the old thing
readable, or the new thing optional, instead of deciding.** v10 replaces rather than annotates,
freezes one semantic where round 9 offered two, and removes the §8 hedge that concealed R9-B2.

**Round 9's verified-correct list is carried forward:** Next 16.2.x does integrate native
`pushState`/`replaceState` with `usePathname`/`useSearchParams`; `canonicalStageUrl()` preserves
pathname, query, and hash while removing only `__wsnav`; **no-strip-after-repair is correct as
designed** and closes round 8's nonce-free window; the document epoch correctly distinguishes
bookmarked/reloaded nonces from same-document unknown ids; settled replay is now stripped;
`{history:'replace', countTowardStageHistory:false}` is the right API shape; **R8-M2's arithmetic is
CLOSED**; the ownership-ambiguity minor is CLOSED; and **P3 v4 stacking remains exact for the ninth
consecutive round** — rule 4 PROCEED/supersede, rule 8's `stagePendingSceneId === null`, rule 9
reachable, §2i's one reset-bearing token per requested generation with live `isCurrent` and
abort-without-report, inherited tests 97 = 57 + 15 + 25 — with no unrelated feature-scope drift.

---


## REVISION LEDGER — round 10 (Codex REJECT, freeze gate)

Verified at the anchor with `git -C C:\Users\itachi\Documents\Crypto\clawville show a156e3c0:<path>`.
**Everything is ACCEPTED.** Round 10 judges the B1/B3/B4 core designs SOUND and the arithmetic and
P3 stacking correct; what blocks the freeze is two design decisions and a document-hygiene debt that
has now been raised three times. Both decisions are made below, and the hygiene sweep was done with
**grep discipline** rather than by following the reported line list, because following the list is
what left residue the last two rounds.

| # | Finding | Disposition |
|---|---|---|
| **R10-B1** | URL equality is not causal identity. `observed === suppressStripHrefRef.current` is identical for the hook rerun caused by stripping AND for a legitimate router/history landing at the same pathname, query, and hash with no nonce — the latter is returned from without classification, installation, or minting. The v10 test only commits a DIFFERENT URL, and the "equality proves ownership" assumption is false. The `foreign` branch has the same ambiguity. | **ACCEPTED — and this is the third time the same mistake has been made in this one guard.** v8 used a boolean (a counter), v10 used a URL (a value), and neither is an IDENTITY: two different causes can produce the same URL exactly as two different landings could consume the same boolean. Fix (§2m-A): a unique **strip marker** is merged into `history.state` alongside the replaced URL, and the effect suppresses only when **BOTH** `{href, stripMarker}` match — `window.history.state?.__wsStrip === suppressStripRef.current.marker`. `history.state` is the one channel that travels with the specific history entry the strip created, so a same-href router landing carries a different (or absent) marker and is processed normally. §6.2 adds the exact-same-href/no-nonce landing and the rapid-successive-strips cases. |
| **R10-B2** | Bootstrap `/join` bounding has no algorithm: the deadline/deferred machinery lives only inside `rejoinWithTicket()`, but §2k-A and a test claim bootstrap is bounded too, while at the anchor `bootstrap()` awaits plain unbounded `join()` (`:533-554`) and expects the RAW result, not `JoinOutcome`. | **ACCEPTED. Option (b) is FROZEN — a generic timed raw-join wrapper — and the total stays 265 before R10-B1's additions.** Reasoning for the choice rather than deleting the claim: the anchor's bootstrap `/join` can hang exactly as the recovery one could, and §2k-A's whole argument is that termination must not depend on a fetch honoring anything. Bounding recovery but leaving bootstrap unbounded would make the spec's own invariant true only on the path that happened to be reported. Fix (§2k-A): a generic `withDeadline(op, ms)` returns `{settled: T} \| {timedOut: true}`; `joinBounded()` wraps the RAW `join()` and maps a timeout to `null`, which is the shape `bootstrap()` already handles (`join()` already converts fetch/JSON rejection to `null`); and a `bootstrapGeneration` counter makes a late completion inert without borrowing the recovery lease. **Recovery keeps its own lease CAS unchanged** — the two paths share the deadline primitive, not the ownership model. |
| **R10-M1** | Current lineage guidance still contains incompatible algorithms — the §1a row, the module JSDoc's mount caller, direct `supersedeAllLiveIssues()` + `currentIntentRef` assignment instead of `acceptNavigationIntent()`, `number` ids against a string-returning `nextNavNonce()`, repair reading `currentIntentRef` though the module owns intent, reset-on-mount prose, two tests demanding reset/unmount clearing against a preservation test, rollout and troubleshooting rows, and no §1 file-list row for the new module. | **ACCEPTED, third request, and the method is what changed.** Rounds 8 and 9 both fixed the reported lines and both left residue, because a reported line list is a sample. v11 ran a grep sweep for `navigationIssuesRef`, `navigationIssueSeqRef`, `currentIntentRef`, `supersedeIssuesExcept`, `supersedeAllLiveIssues`, and mount-reset phrasing, and reconciled **every** hit — classifying each as current guidance (rewritten) or historical ledger prose (left, labelled). `stage-navigation-lineage-store.ts` gets its §1 row; ids are `string` everywhere; the module exposes `getNavigationIntent()` so no consumer reaches for a ref; every direct supersession/intent mutation is replaced by `acceptNavigationIntent()`; and `resetStageNavigationLineage()` is TEST-ISOLATION-ONLY with the mount-caller JSDoc deleted. |
| **R10-M2** | Stale-before-remount rejection is untested: §6.2 proves a LIVE issue survives a remount but never lands an issue that was SUPERSEDED before it. | **ACCEPTED, and the critique's own replacement is taken — the obsolete weight-2 reset/unmount bullet becomes the weight-2 stale-before-remount bullet, so the count is unchanged.** The store already distinguishes these correctly; what was missing was the proof that it does. |
| **R10-M3** | Recovery prose and tests contradict the CAS code: several passages still assign ownership to the old `rejoinWithTicket()` try/finally, one says `recoverWithTicket()` dispatches failure, and two tests are written against the superseded shape — one expects `Promise.race` to return `{kind:'timeout'}` where v10 returns a deferred, and one requires "exactly one transition" in all seven cells although `cancelled-before-settlement` correctly produces zero. | **ACCEPTED.** Every current passage now names `settleRecovery` as owner. The seven-cell assertion becomes **"at most one transition — exactly one for an accepted non-cancelled settlement, zero for cancellation and for a refused loser"**, which is what the code does and what v10's wording forbade. |
| **R10-m1** | Second-arm wording conflicts with timer cancellation: the spec says the losing arm always reaches the CAS, but if the join operation wins it clears the deadline timer, so the deadline arm never calls it. | **ACCEPTED — a real inconsistency in my own prose.** Restated precisely: **deadline-first** leaves the join arm to execute the CAS refusal; **operation-first** cancels the deadline so there is no second arm at all. The refusal test is scoped to deadline-first. |
| **R10-m2** | Two protocol references still say 42 where the P4 bump reads 42→43. | **ACCEPTED.** Both corrected. |
| **R10-m3** | The Bumper canvas-key claim is inaccurate: `Canvas key={roomId}` does not survive verbatim for both activities — Bumper uses `${roomId}-${spectatorCamMode ?? 'chase'}`. | **ACCEPTED.** Verified `BumperShellsScene.tsx:633,638` at the anchor. The claim becomes "room-keyed canvas recreation survives", with each activity's exact key quoted — reef `key={roomId}` (`ReefRaceScene.tsx:746`), bumper `key={canvasKey}` where `canvasKey = \`${roomId}-${spectatorCamMode ?? 'chase'}\``. §5b already described bumper's spectator re-key correctly, so this was a §0.5 summary drifting from a body section — worth noting as its own failure mode. |

**On the guard that has now been wrong three times.** v8: a boolean. v10: a URL. Both failed the same
way — they encoded *something about* the event instead of *which* event. The lesson generalises past
this guard and is the same one R7-1 taught for navigation identity: **when two causes can produce
identical observable state, the discriminator must be minted by the cause, not derived from the
state.** `history.state` is that mint here, as the URL nonce was there. If round 11 finds a defect in
this guard, the question to ask first is whether the marker is genuinely per-strip and genuinely
travels with its history entry.

**Round 10's verified-correct list is carried forward:** `acceptNavigationIntent()` is internally
synchronous and atomic; `commitStageNavigation()` routes repair issuance through acceptance and nonce
registration; canonicalization preserves pathname, non-owned query, and hash while removing only
`__wsnav`; no-strip-after-repair remains correct; document-scoped issue/status preservation is
coherent and bounded; the forced-replace/no-history-count API is correct; the recovery CAS prevents a
refused late success from opening a source because `openStream` is inside its guard; **the declared
265 and the 242→265 chain are correct**; and **P3 v4 stacking is exact for the tenth consecutive
round** — rule 4 PROCEED/supersede, rule 8's `stagePendingSceneId === null` keeping rule 9 reachable,
§2i's one reset-bearing token per requested generation with live `isCurrent` and abort-without-report,
P4 changing only rules 3 and 4 to compare `bufferedPathname`, inherited 97 = 57 + 15 + 25.

---


## REVISION LEDGER — round 11 (Codex REJECT, freeze gate)

Verified at the anchor with `git -C C:\Users\itachi\Documents\Crypto\clawville show a156e3c0:<path>`.
**Everything is ACCEPTED.** Round 11 leaves exactly ONE design decision — overlapping strips — and
classifies every other finding as "(b) one correct mechanical fix". The grep sweep passed. The
decision is frozen below with its lifecycle comparison.

| # | Finding | Disposition |
|---|---|---|
| **R11-1** | Rapid successive strips still lack causal identity. One mutable `suppressStripRef` plus a per-entry marker cannot be total: strip 2 overwrites BOTH the ref and the SAME history entry before strip 1's queued rerun executes, so effect 1 reads live `{href2, M2}`, matches, and consumes strip 2's marker — then effect 2 sees no guard and processes strip 2's nonce-free URL as `unissued`. React gives an effect no per-trigger state snapshot. | **ACCEPTED. FROZEN: serialized strip ownership** (§2m-A). A module-owned single-slot queue admits **at most ONE outstanding strip**; a second strip request is QUEUED and applied only when the first is consumed, times out, or is invalidated. **Why this over the other two options the critique offers:** a *per-navigation captured-state channel* would need React to hand the effect a snapshot of the state that triggered it, which is exactly the thing round 11 proves does not exist — it would have to be simulated with another mutable channel and lands back in the same class of bug. *Persistent markers with popstate cleanup* keeps N markers alive across history entries, so its lifecycle is unbounded in history depth and the cleanup rules are the hard part; that is more surface than the problem deserves. **Serialization removes the concurrency instead of tracking it** — with at most one outstanding strip, "which strip does this rerun belong to" has only one possible answer. It costs nothing because strips are rare (only nonce landings), and its lifecycle is three deterministic transitions that §6.2 drives directly. The false claim at v11:2675-2677 is deleted, its test is rewritten, and the overlapping-strips ordering is pinned. |
| **R11-2** | Spreading `history.state` bypasses Next's synchronization wrapper: `{...(window.history.state ?? {}), __wsStrip: marker}` carries Next's `__NA: true`, and in Next 16.2.3 patched `replaceState` delegates straight to the native method when `data?.__NA \|\| data?._N`, so the router restore that re-runs `useSearchParams` NEVER FIRES and the guard stays armed. | **ACCEPTED — and this is a second framework-behavior error of exactly the R8-B2 kind**, three rounds after I wrote that framework claims must be version-checked. I checked THAT `replaceState` synchronizes; I did not check what the wrapper does with the payload I pass it. Fix (§2m-A): pass **only** `{__wsStrip: marker}`. Next's wrapper copies its own internal keys, and normal navigations use [`preserveCustomHistoryState: false`](https://github.com/vercel/next.js/blob/v16.2.3/packages/next/src/client/components/segment-cache/navigation.ts#L645-L652) while [history traversals use `true`](https://github.com/vercel/next.js/blob/v16.2.3/packages/next/src/client/components/segment-cache/navigation.ts#L676-L693) — the traversal value is exactly why every marker scheme failed (R12-1). Both references are now cited **in the spec body** — These two versioned `segment-cache/navigation.ts` references are cited inline — so a future edit that "helpfully" preserves existing state has the reason to hand. |
| **R11-3** | Bootstrap option (b) is not anchor-compatible as transcribed: undefined `JoinResult`; `bootstrapGeneration` used but never declared; `joinBounded(requestedRoom?)` calling `join(requestedRoom, signal)` while the anchor is `join(recovery = false)` deriving the room internally from `?room`; the anchor fetch takes no signal. | **ACCEPTED.** Verified all four at the anchor: `async function join(recovery = false): Promise<JoinResponse \| {superseded: true} \| null>` (`:121-123`), the room derived internally from `window.location.search` (`:124-127`), the fetch with no `signal` (`:141-146`), and `bootstrap()` calling bare `join()` (`:534`). Fix (§2k-A): use the **existing raw union**, widen to `join(recovery = false, signal?: AbortSignal)` and thread it into the fetch, make `joinBounded()` **parameterless** calling `join(false, controller.signal)`, and have `bootstrap()` call it. **`bootstrapGeneration` is REMOVED entirely** — the critique is right that returning `null` on a mismatch would make outer `bootstrap()` dispatch `BOOTSTRAP_FAILED`, which is not inert, and that the machine is already single-flight (`world-stream-machine.ts:99-108`). A post-timeout raw result merely loses the completed race. **I invented a guard for a problem the machine already solves** — the same over-correction reflex as SELF-G, caught here by the critique instead of by me. The bootstrap-timeout test is extended to release attempt 1 after attempt 2 succeeds. |
| **R11-4** | `withDeadline()` is falsely described as shared with recovery. Bootstrap uses it; recovery deliberately uses SEPARATE deadline and operation producers so both arms can reach `settleRecovery` and the late arm can be explicitly refused. | **ACCEPTED.** The two paths share `JOIN_TIMEOUT_MS` and the bounded-termination POLICY, **not the settlement primitive** — and conflating them would have invited an implementer to "simplify" recovery onto `withDeadline()`, which would destroy the CAS refusal R9-B4 exists for. All four passages corrected, and §1d now requires `bootstrap() → joinBounded()` rather than claiming a shared raw `join()` bounds it automatically. |
| **R11-5** | The promised §1 row for `stage-navigation-lineage-store.ts` is still absent; the implementation block does not satisfy a file-list entry. | **ACCEPTED.** Row added, naming document-scoped module ownership, string ids, the bounded rings, `acceptNavigationIntent()`, `getNavigationIntent()`, nonce generation, classification/settlement, the serialized strip queue, and test-isolation-only reset. |
| **R11-6** | Two operative recovery passages still say `rejoinWithTicket`'s try/finally owns `recoveryInFlight`, contradicting the `settleRecovery` sole-owner contract. | **ACCEPTED.** Both rewritten to the lease-CAS contract; try/finally survives only where explicitly labelled anchor/historical. |
| **R11-7** | Declared 268 is semantically 269: the deadline-first bullet carries a second imperative ("assert separately that OPERATION-FIRST…") with no `(2)` weight, and operation-first timer cancellation is ALREADY separately tested. | **ACCEPTED, and taken the way the critique recommends** — the redundant imperative is REMOVED from the deadline-first bullet rather than weighted, because the assertion already exists in its own bullet and duplicating it would inflate the count for no coverage. The basis stays **268**. |
| **R11-8** | The Bumper canvas-key claim remains wrong in four operative passages, though one passage is correct. | **ACCEPTED.** All four aligned to the corrected wording, quoting reef's `key={roomId}` and bumper's `key={canvasKey}` separately. *(R10-m3 was reported closed on the strength of one fixed passage; it was not. Fixing the cited line and not its siblings is the same sampling error R10-M1 punished.)* |
| **R11-9** | Cosmetic: duplicated "exports `resetStageNavigationLineage()`" wording. | **ACCEPTED**, one occurrence deleted. |

**The one thing I want on the record about R11-2.** Round 8 taught me to version-check framework
claims, and I wrote that lesson into §8. Round 11 found a framework error anyway — because I
verified the *behavior* (`replaceState` synchronizes) and not the *contract* (what the wrapper does
with the payload). Checking that an API does what you want is not the same as checking that your
call reaches it. Both references are now inline in §2m-A rather than in a ledger row, because the
next person to touch that line needs them at the call site, not in the history.

**Round 11's verified-correct list is carried forward:** the grep sweep PASSES (remaining old-ref
hits are revision history or explicitly-labelled "fails against" commentary); operative ids are
strings; repair uses `getNavigationIntent()`; `acceptNavigationIntent()` is synchronous and atomic;
module-owned lineage preserves live-vs-superseded across remount and reset and is count-bounded; the
stale-before-remount test covers both remount forms; recovery's lease CAS is sound and a refused late
success cannot open a source; bootstrap timeout maps correctly onto the existing
`BOOTSTRAP_FAILED`/exponential-retry handoff once the signatures are fixed; and **P3 v4 stacking is
exact for the eleventh consecutive round** — rule 4 PROCEED/supersede, rule 8's
`stagePendingSceneId === null` keeping rule 9 reachable, one reset-bearing token per requested
generation with live `isCurrent` and abort-without-report, P4 amending only rules 3 and 4 to compare
`bufferedPathname`, inherited 97 = 57 + 15 + 25, protocol 42→43 with the anchor disclosed as 40.

---


## REVISION LEDGER — round 12 (Codex REJECT → ORCHESTRATOR SCOPE RULING)

Verified at the anchor with `git -C C:\Users\itachi\Documents\Crypto\clawville show a156e3c0:<path>`.
Round 12 REJECTED the serialized strip protocol as non-total across timeout, history traversal,
remount, and intervening-landing schedules — the **fourth consecutive round** the strip lifecycle has
failed, and the third distinct protocol to fail. **The orchestrator's ruling is to DELETE in-session
stripping entirely rather than design a fifth.** That ruling is executed here, and the due-diligence
check that could have overturned it is recorded below.

| # | Finding | Disposition |
|---|---|---|
| **R12-1** | Serialized strip ownership is not a total protocol. Nine lifecycle cells, of which several are non-total: there is no timer owner so expiry is only checked on a later effect that may never come; Next 16.2.3 uses `preserveCustomHistoryState: **true**` for history traversals, so returning to the marked entry satisfies `{href, marker}` and swallows a legitimate traversal; queued work can rewrite a URL accepted after it was queued; module state survives remount so a new root can consume an old acknowledgement; and the headline ordering test contradicts the pseudocode, because requesting strip 2 requires live location to have already moved. | **ACCEPTED — and the ruling is to DELETE, not to redesign.** The report is right on every cell; I checked the traversal one specifically, since `preserveCustomHistoryState: true` inverts the exact assumption the marker scheme rests on. **In-session stripping is removed in full**: no `replaceState`, no marker, no `history.state` payload, no outstanding/queued slots, no `STRIP_ACK_TIMEOUT_MS`, no popstate cells, no suppression guard, and none of their tests. Component-issued URLs keep their `__wsnav` nonce for the life of the history entry. **The trade, stated plainly:** the visible cost is a residual `__wsnav=<epoch>.<seq>` query parameter on component-issued activity URLs — cosmetic, and it disappears on the next normal navigation, which replaces the URL anyway. The benefit is deleting a lifecycle that four rounds and three protocols could not freeze. Boolean → URL → marker → serialized queue: each was correct about the defect it fixed and each surfaced a new cell, which is the signature of machinery whose complexity exceeds its payoff. |
| **R12-DD** | **Due diligence — the one thing that could have overturned the ruling.** A persistent nonce is only acceptable if it breaks nothing functional. Checked all three named risks at the anchor. | **VERDICT: no functional breakage; the ruling stands.** **(a) RSC / client-cache keying.** Not a delta at all: the nonce is stamped on the URL the router NAVIGATES TO, so any cache-keying or refetch consequence already occurred in v7-v12 — stripping ran AFTER the landing via `replaceState`, which performs no navigation and no RSC fetch. Deleting the strip changes zero fetch behavior; the question is a property of the nonce (accepted since round 7), not of keeping it. **(b) Exact-query-string readers.** `git grep` over `apps/web/src/app`, `hooks`, and `world-stage` returns **26 query consumers and every one reads a NAMED key** via `.get('…')` — `shortCode` and `invite` (`page.tsx:113,138`), `room` (`use-world-stream.ts:126`), `stageColdInit` (`WorldStageRoot.tsx:138`), `meshlets`/`webgpu`/`webgl` (`WorldStageCanvas.tsx:59,112,120`), `table` (cove), `quickQueue` (game), and the preview/auth pages. **There is not one exact-query-string comparison, `toString()` equality, or whole-search parse in the tree**, so an unknown `__wsnav` is inert everywhere. **(c) Activity WS join/rejoin.** `useActivityWs` reads `window.location` **not at all** — `wsUrl` is built from `NEXT_PUBLIC_API_URL` + `activityId` + `roomId` (`:96-103`). The world-stream `join()` reads only `?room` by name. |
| **R12-2** | The v11→v12 arithmetic does not reconcile from the mandated honest 269 basis: v12 says "adds 4, deletes 0" from 268, but round 11 established v11 was semantically 269 because of the undeclared operation-first drive, which v12 then removed. | **ACCEPTED.** Step 12 and the scope delta are rewritten as **honest v11 basis 269; delete the redundant operation-first drive (−1); add four v12 cases (+4); net +3 → 272** — and v13 then re-derives on top of the strip deletions. |
| **R12-3** | Operative prose still carries the v11 overlapping-marker algorithm ("each strip overwrites the ref and an earlier rerun sees a mismatch"), contradicting serialization; and the `ARCHITECTURE.md` row documents only the per-strip `{href, marker}` guard. | **ACCEPTED, and superseded by the ruling** — both passages are DELETED rather than corrected, along with everything else describing a strip. |
| **R12-4** | One framework claim lacks a directly supporting inline citation: the existing `app-router.tsx:331-371` reference does not show the normal-navigation `preserveCustomHistoryState: false` assignment. | **ACCEPTED and recorded, though the claim it supports is now moot.** The `segment-cache/navigation.ts#L645-L652` (normal, `false`) and `#L676-L693` (traversal, `true`) citations are preserved in this ledger row **because the traversal value is precisely why the marker scheme could not work** — a future reader proposing to reinstate stripping needs that fact, and it should not vanish with the machinery. |

Current landing behavior is defined exclusively by the seven-row frozen provenance table in the round-14 ledger; this passage adds no alternate classification rule.

| Landing | Behavior (unchanged from v12) |
|---|---|
| in-flight nonce | `settleIssue(id)`, fall through and install |
| superseded | repair to current intent; mint nothing |
| retired, same document, tombstone retained | `issued-stale` → repair; mint nothing |
| absent, own epoch, `seq <= issuedHighWater` | `traversal` → fall through, normal arrival (v15, R14-1) |
| absent, own epoch, `seq > issuedHighWater` | `malformed` → fall through, FRESH arrival (v15, R14-1b) |
| settled tombstone (back/forward re-presenting a nonce-bearing entry) | already-pinned replay semantics; return |
| foreign epoch (bookmark, reload, shared link) | fresh arrival — **the nonce is simply IGNORED**, not stripped; classify and proceed |

**On the scope-ruling precedent.** The founder-taste rule is that scope rulings prefer deleting
unfreezable machinery over polishing cosmetics. This is a clean instance: four rounds of adversarial
review bought a state machine whose entire user-visible payoff was a tidier address bar, on URLs the
user reaches through in-app navigation rather than by reading. I should have proposed the deletion
myself around round 10, when the second protocol failed and the pattern was already visible.

**Round 12's verified-correct list is carried forward:** the bare `{__wsStrip: marker}` payload core
was CLOSED (now moot); bootstrap transcription, `withDeadline()` ownership, the lineage §1 row, the
recovery-owner prose, the Bumper key wording, and the duplicate-export wording are all CLOSED; the
operative grep passes for obsolete lineage refs, number ids, direct supersession writers, generation
guards, and old recovery ownership; the anchor bootstrap/join citations all match; and **P3 v4
stacking is exact for the twelfth consecutive round** — rule 4 PROCEED/supersede, rule 8's
`stagePendingSceneId === null` keeping rule 9 reachable, §2i's one reset-bearing token per requested
generation with live `isCurrent` and abort-without-report, P4 amending only rules 3 and 4 to use
`bufferedPathname`, inherited 97 = 57 + 15 + 25, protocol 42→43 with the anchor disclosed as 40.

---


## REVISION LEDGER — round 13 (Codex REJECT → PROVENANCE CONTRACT FROZEN)

Verified at the anchor with `git -C C:\Users\itachi\Documents\Crypto\clawville show a156e3c0:<path>`.
Round 13 found that deleting stripping exposed a real ambiguity underneath it: once a provenance
tombstone is evicted, a persistent same-document nonce cannot distinguish an intentional
replay/back-traversal from a genuinely late superseded landing. **The contract below is FROZEN, on
the ACCEPTED-RESIDUAL branch, and the reason for choosing that branch over the serialization proof
is the most important thing in this ledger.**

| # | Finding | Disposition |
|---|---|---|
| **R13-1** | Persistent-nonce classification is not total. The operative `issued-settled` action still says "Strip (guarded) and return", and without the strip-triggered rerun that early return skips children installation and request minting (`WorldStageRoot.tsx:105-134`), leaving URL B visible while the stage sits on C. Changing it to fall through fixes only the window in which B's tombstone survives: beyond the 32-tombstone horizon, an intentional traversal and a genuinely late superseded commit present **the identical observable nonce and URL**. | **ACCEPTED. Contract frozen in three parts.** **(1) The flagged defect first:** `issued-settled` now **FALLS THROUGH to normal processing** — a back/forward to a settled entry is a legitimate traversal to a real destination and must install and mint like any arrival. **(2) Within the horizon**, per-status handling is unchanged: live in-flight → settle; tombstoned-settled → fall through; tombstoned-superseded or retired → repair to current intent. **(3) Beyond the horizon** — own-epoch nonce below the live window and absent from tombstones — classify as **HISTORY TRAVERSAL / same-document replay ⇒ process as a normal arrival, nonce inert.** |
| **R13-1b** | Which justification branch: serialization-proven, or accepted-residual? | **ACCEPTED-RESIDUAL — chosen deliberately, and I want the reasoning on the record.** The serialization branch would justify the beyond-horizon rule by proving a late superseded commit is not physically realizable: reaching eviction takes 32 subsequent resolved issues, and if App Router discards a superseded navigation's transition rather than delaying it, a commit cannot land after dozens of later commits. **I checked what I could and stopped short of claiming it.** Verified at the anchor that `commitStageNavigation` (`WorldStageRoot.tsx:165-176`) calls `router.push`/`router.replace`, and that Next 16.2.3's app-router wraps navigation in `React.startTransition` (`app-router.js:240`). **That is suggestive and it is not proof.** "Wrapped in a transition" does not establish "a superseded transition's commit can never land after dozens of later commits" — that is a claim about React's scheduler interacting with Next's segment cache, and establishing it rigorously needs more than a grep. **I have asserted framework behavior without adequate verification twice in this review (R8-B2's `replaceState` synchronization, R11-2's wrapper-bypass payload), and both became blockers.** Making a third, stronger framework claim the load-bearing justification for a freeze would be the same mistake a third time. So the rule is identical either way, and its justification is an explicitly accepted residual instead of a proof I cannot stand behind. **If a reviewer establishes the serialization property with real evidence, this row upgrades from residual to proof and nothing else in the spec changes.** |
| **R13-1c** | The residual itself, stated so it can be judged rather than discovered. | **ACCEPTED RESIDUAL:** a hypothetical superseded commit landing more than 32 subsequent accepted navigations late would be classified as a traversal and would **install its stale destination as though the user had navigated there**. **Bounded harm:** a wrong-but-valid page the user can navigate away from — no money path (§5f's WS/reward lifecycle is untouched), no crash, no data loss, and no security surface. **Zero known repro schedule:** no shipped call site produces 32 accepted navigations while an earlier commit remains unsettled, and I could not construct one. **Why this is the right trade:** the alternative — treating beyond-horizon nonces as stale — breaks deep history and same-document replay for *every* user who bookmarks or back-buttons far enough, which is a certain, reachable, everyday defect traded against a hypothetical one. Choosing the certain harm to avoid the hypothetical one would be the wrong direction. **SUPERSEDED BY R14-2/R14-2a: the former 'no money path' bound is withdrawn.** |
| **R13-2** | The operative strip deletion is not total: twelve enumerated locations still describe stripping, guards, or the obsolete one-shot lifecycle. | **ACCEPTED.** All twelve rewritten or deleted, including the whole obsolete §strip-lifecycle subsection, the two surviving guard tests, the obsolete URL-equality guard algorithm in §8, and the rollout row that still mandated guarded `history.replaceState`. `requestNonceStrip` was already clean; the prose now matches it. |
| **R13-3** | 262 sums numerically but the deletion reconciliation is not freeze-valid: the current 73 still contains three strip-dependent cases, so the claim that every strip test was deleted is false; and the v12 delta line still reads "adds 4, deletes 0" from 268. | **ACCEPTED, both legs.** The three surviving strip cases are deleted, the false claim is corrected, and the v12 line is replaced with the honest chain. §6.2 re-derives below. |
| **R13-4** | The due-diligence query/cache conclusion is overstated. Five call sites DO parse or forward the whole query/href, and deleting post-landing `replaceState` changes what is stored in the history entry, so "zero fetch behavior" is unproven for later popstate. | **ACCEPTED — and this correction matters more than its severity suggests, because it was MY overstatement.** I wrote "not one whole-search parse in the tree" from a targeted grep of three directories; round 13 read all 463 files under `apps/web/src` and found five. **Narrowed:** the no-breakage claim now covers **initial navigation only**, and the five full-query consumers are documented by name — `hatcher-launch-handler.tsx:218-249` (parses and reserializes query+hash), `lobby-landing.tsx:390-395` (copies the full href into an invite URL — **the one with a real user-visible consequence: a shared activity invite now carries `__wsnav`**), `SupportLauncher.tsx:92-100` (full href as ticket context), `(world)/game/page.tsx:379-385` (reconstructs the href minus `quickQueue`), and `public-enter-destination.ts:18-30`. None break; the invite-link one is cosmetic leakage and is recorded as a known cost of the round-12 ruling. The "zero fetch behavior" assertion is withdrawn for popstate and retained only where it was actually established. |
| **R13-5** | R12-4's promised citations are named but not linked. | **ACCEPTED.** Both versioned links added inline. |

Current landing behavior is defined exclusively by the seven-row frozen provenance table in the round-14 ledger; this passage adds no alternate classification rule.


**Round 13's verified-correct list is carried forward:** `useActivityWs.ts:94-103` builds its URL
solely from the API base, `activityId`, and `roomId`; `use-world-stream.ts:121-138` reads only named
`?room`; initial router navigation already carried `__wsnav` and stripping was post-landing; foreign
epoch remains mechanically distinguishable; a live or tombstoned superseded landing with a different
current intent remains repairable; bootstrap transcription, `withDeadline()` ownership, the lineage
§1 row, recovery-owner prose, the Bumper canvas keys, and the duplicate-export wording are all
CLOSED; and **P3 v4 stacking is exact for the thirteenth consecutive round** — rule 4
PROCEED/supersede, rule 8's `stagePendingSceneId === null` preserving rule 9, one token per
generation with live `isCurrent` and abort-without-report, inherited 97 = 57 + 15 + 25, P4 amending
only rules 3 and 4 to `bufferedPathname`, protocol 42→43 with the anchor's 40 separately disclosed,
and no unrelated scope drift.

---


## REVISION LEDGER — round 14 (Codex REJECT → SECOND ORCHESTRATOR SCOPE RULING)

Verified at the anchor with `git -C C:\Users\itachi\Documents\Crypto\clawville show a156e3c0:<path>`.
Round 14 raised two **(a)** blockers, both legitimate: the frozen provenance table was never
propagated into the operative machinery, and the accepted residual's "no money path" bound is
**false**. Both are resolved here — the first by a full propagation with an explicit high-water
predicate, the second by a corrected harm statement plus a **mandatory harm reduction** under the
orchestrator's second scope ruling.

| # | Finding | Disposition |
|---|---|---|
| **R14-1** | The frozen contract is not total. The ledger table froze beyond-horizon-traversal, but `classifyNavLanding` takes no sequence input, `NavLandingClass` has no traversal variant, the operative `issued-stale` row classifies EVERY absent nonce as stale (directly overlapping the new rule), prose in two places still says unknown ⇒ stale, a test pins the OPPOSITE of the new traversal tests, "six landing classes" persists in three places, and **no predicate defines the window boundary**. | **ACCEPTED in full — the contract lived only in a ledger table, which is exactly the failure mode R9-M1/R10-M1 punished, and I repeated it.** Freezing a rule in prose and not propagating it into the classifier is indistinguishable, to an implementer, from not freezing it. Fixed as ONE coherent propagation: an explicit **`issuedHighWater`** predicate (below), a sixth union variant, a classifier signature that takes the high-water as part of the module snapshot it already reads, the seven-row table promoted to **the single statement every other passage defers to**, the class count corrected in all three places, both contradictory prose passages rewritten, the contradictory overflow test DELETED, and boundary tests pinned at, below, and above the mark. |
| **R14-1a** | The high-water predicate itself — and the subtlety that makes the obvious version wrong. | **FROZEN: `issuedHighWater` is a monotonic counter recorded at ISSUE time**, module-owned with the same lifetime as `documentEpoch` (survives root remount, fresh per document). It is **not** derived from a scan of retained records, and round 14 proved why: tombstones enter in **settlement/retirement order, not sequence order**, so sequence 2 can settle and be evicted while older superseded sequence 1 is still retained — "below the minimum retained sequence" is therefore NOT equivalent to "provenance evicted." A scan-derived window would mis-classify exactly the interleaving the ring makes reachable. The rule, with the `=` case decided explicitly: **own-epoch && absent && `seq <= issuedHighWater` ⇒ TRAVERSAL/REPLAY** (fall through, nonce inert). The boundary is **inclusive** because `seq === issuedHighWater` with no record means the most recently issued nonce has already settled and been evicted — a legitimate traversal to the newest entry. |
| **R14-1b** | The malformed action — own-epoch && absent && `seq > issuedHighWater`. | **FROZEN: fresh arrival, foreign-style, nonce inert.** One-sentence justification: a sequence we never minted was never a component-issued landing at all — it is a fabricated, corrupted, or hand-edited URL, indistinguishable from any URL we did not issue — so it gets the treatment we already give those, and **R7-2's never-promote-to-fresh rule does not apply because that rule governs nonces we actually issued.** (Repairing instead would override a user who hand-edited their own URL, which is the wrong direction for a nonce that carries no provenance to protect.) |
| **R14-2** | The residual's "no money path" bound is FALSE. A stale install while the player is in a live activity unmounts the activity page → `useActivityWs` cleanup sends `leave` → the hub marks it voluntary → immediate `notifyForfeit` with no grace → DNF placement → the reward pipeline writes results, placement events, and CT. | **ACCEPTED — the bound was wrong and I withdraw it.** I verified the chain end to end at the anchor rather than taking it on report: `useActivityWs.ts:311-333` sends `{type:'leave'}` in cleanup; `activity-ws-hub.ts:402-405` sets `internalCloseCode = 1000`; `:323-342` branches to `notifyForfeit(room, avatarId, 'voluntary')` **with no reconnect grace**; and `activity-room-manager.ts:1093-1117` routes simulation placements into `issueRewardsForRoom`, whose header comment states it "writes `activity_results` rows + credits non-bot tokens + emits `activity.match.placed` events, all in one composed DB transaction." **My §5f-is-untouched reasoning was a category error:** P4 creates no new money path, but the residual *triggers* an existing one, and "the flow already exists" is not the same as "the harm is not economic." |
| **R14-2a** | **SECOND ORCHESTRATOR SCOPE RULING — the residual remains ACCEPTED, in corrected form only.** Same standing as the round-12 strip deletion; round 15 may re-audit the corrected bound's HONESTY against the anchor, but the trade itself is ruled. | **The corrected harm bound, replacing R13-1c's withdrawn sentence:** Worst case, the stale install involuntarily unmounts a live activity and triggers the existing voluntary-leave → forfeit → DNF → reward lifecycle—the same consequence as pressing Back mid-match. P4 creates no new money path and does not alter conservation. Precursor reachability: constructible only via the now-gated dev probe (R14-2b) or a human performing 33 navigations while one route commit hangs. The final React/Next scheduler leg **remains unproven in both directions** — I did not prove it occurs, and round 14 did not prove it cannot. |
| **R14-2b** | **MANDATORY harm reduction — gate the probe.** Round 14 showed the only constructible precursor runs through `window.__WORLD_STAGE_PROBE__.navigate`, which is unguarded at the anchor and which **P4 widens to activity-capable hrefs**. | **ACCEPTED and specified.** Verified the anchor exposes `navigate?: (to: '/game' \| '/cove') => boolean` inside the `stageReady` effect (`WorldStageRoot.tsx:253-262`) with no environment guard. v15 requires the **activity-widened** probe to be **disabled on production** behind `NEXT_PUBLIC_ENABLE_STAGE_PROBE`, following the established client-gating pattern in this repo (`NEXT_PUBLIC_ENABLE_DEV_QUEUE`, `NEXT_PUBLIC_COVE_DEBUG` — `NODE_ENV` cannot discriminate, since it is `'production'` on both Coolify boxes). The probe stays live on local and staging where §6.4-§6.6 lanes run; §6.2 pins the gate. **With the probe gated, "zero known repro schedule" stops being a hopeful phrase and becomes a statement about what a human would have to do by hand.** |
| **R14-3** | 264 sums correctly but the test IDENTITIES do not reconcile: the true v13→v14 delta was −5/+7, not −4/+6; the R3-B1 pathname-first A→B mint test and the live-issue-across-remount coverage were silently dropped; the contradictory overflow-stale test remains; and two "that same traversal" references lost their antecedent. | **ACCEPTED, and the silent drops are the part worth owning.** My v14 deletion pass matched on words rather than identities and removed two tests I never accounted for — the same over-matching that cost me two downlink bullets in v14, caught that time by the re-sum and missed this time because the total still balanced. **A balanced total is not evidence that the right tests are present.** All four recipe steps applied verbatim: the R3-B1 standalone mint test is restored (its absent antecedent is why "that same traversal" dangled twice), the overflow test is deleted, the R8-B3 remount drive is expanded to land an outstanding pre-unmount issue as `issued-live` and settle/install it (weight stays 1), and the identity history below is written honestly. |
| **R14-4** | Four strip residues remain. | **ACCEPTED**, all four replaced with the critique's exact wording. |
| **R14-5** | The two versioned links are correct but the following sentence misnames their source file. | **ACCEPTED**, replaced verbatim. |

**The frozen provenance contract — THE single statement; every other passage defers to this table.**

| # | Nonce state | Class | Action |
|---|---|---|---|
| 1 | own epoch, live record `in-flight` | `issued-live` | `settleIssue(id)`, fall through, install |
| 2 | own epoch, tombstone `settled` | `traversal` | fall through — normal arrival |
| 3 | own epoch, live record `superseded` | `issued-stale` | repair to current intent; mint nothing |
| 4 | own epoch, tombstone `superseded` / retired | `issued-stale` | repair to current intent; mint nothing |
| 5 | own epoch, **absent && `seq <= issuedHighWater`** | `traversal` | fall through — normal arrival, nonce inert |
| 6 | own epoch, **absent && `seq > issuedHighWater`** | `malformed` | fall through — **fresh arrival**, nonce inert (R14-1b) |
| 7 | foreign epoch | `foreign` | fall through — fresh arrival, nonce ignored |

Rows 1-4 are record-first and take precedence; 5 and 6 are reached only when no record and no
tombstone exist. **Six distinguishable outcomes, not five** — the count is corrected everywhere it
appeared.

**What I am taking from this round.** R14-1 and R14-3 are the same failure at two altitudes: I froze
a decision in a ledger table and did not carry it into the machinery, and I deleted tests by text
match and did not check identities. Both passed a numeric check — the table read as a decision, the
total read as balanced — while the operative artifact disagreed with itself. **The check that would
have caught both is the same one: for every frozen statement, name the operative site that
implements it, and for every deleted test, name what it covered.** That discipline is now applied
here and stated so round 15 can hold me to it.

**Round 14's verified-correct list is carried forward:** `issued-settled` fall-through reaches the
anchor's normal-processing block (`WorldStageRoot.tsx:117-126`, minting at `:128-133`); within
retained provenance, live in-flight settles, superseded repairs, settled replay falls through;
foreign epoch is mechanically distinguishable and cannot match an own-epoch stored id; the
beyond-horizon problem does not spill into foreign-epoch or retained-record cases; R13-4 and R13-5
are CLOSED with their cited ranges matching; and **P3 v4 stacking is exact for the fourteenth
consecutive round** — rule 4 PROCEED/supersede, rule 8's `stagePendingSceneId === null` preserving
rule 9, §2i's one reset-bearing token per requested generation with live `isCurrent` and
abort-without-report, inherited 97 = 57 + 15 + 25, P4 amending only rules 3 and 4 to
`bufferedPathname`, protocol 42→43 with the anchor's 40 separately disclosed, and no scope drift.

---


## 0. THE FINDING THAT DETERMINES THIS PHASE

The parent plan's Phase-4 row assumes the activity scenes can become slots inside the shared stage
canvas the way cove (P1b) and kelp (P3b-2) did. **They cannot, and the reason is the renderer.**

### 0.1 The stage canvas is a node-material renderer; reef is a raw-GLSL scene

- The stage builds `new THREE.WebGPURenderer({ … forceWebGL })` from
  `import * as THREE from 'three/webgpu'` (`WorldStageCanvas.tsx:23`, `:195-201`) and calls
  `extend(THREE as any)` with that namespace (`:47`). `forceWebGL: true` selects the **WebGL
  backend of `WebGPURenderer`** — still the node pipeline. No stage configuration yields a classic
  `WebGLRenderer`.
- Cove and kelp were authored against that namespace (`cove-interior.tsx:40`,
  `kelp-realm-scene.tsx:5-6`); the P1b brief's cove fix-list item 1 was literally "unify its
  imports to `three/webgpu`" (`docs/world-stage-p1b-brief.md:35`).
- The activities are the opposite. Counted by import STATEMENT (m2): `activities/reef-race`
  has **27** `import … from 'three';` plus 10 `three/examples/*`; `activities/bumper-shells` has
  **6** plus 2; `activities/shared` has **2**. **Zero** files import `three/webgpu` or
  `three/tsl` — the single textual match in the tree is the COMMENT at
  `BumperShellsScene.tsx:8`.
- Reef's central visual is a **raw GLSL `ShaderMaterial`**: `surf-ribbon.tsx:67` imports drei's
  `shaderMaterial` factory, `:149` defines `_waterVert` and `:367` `_waterFrag` as `/* glsl */`
  template literals, `:760-799` builds `SurfWaterMaterial`, `:800` registers it.
  `river-scene.tsx:78-91` mounts `<SurfRibbon />` unconditionally and `ReefRaceScene.tsx:660`
  mounts `<RiverScene showDemoKarts={false} …/>` unconditionally in gameplay.

**three r185 has no node mapping for `ShaderMaterial`.** `three/build/three.webgpu.js:86728-86740`
is the complete `addMaterial` registration list — Phong, Standard, Physical, Toon, Basic, Lambert,
Normal, Matcap, LineBasic, LineDashed, Points, Sprite, Shadow. **Precise claim (m1):** the
identifier `ShaderMaterial` IS present in that bundle, re-exported from `./three.core.js` on line
7; what is absent is the **quoted-literal key** `'ShaderMaterial'` — `grep -c "'ShaderMaterial'"
three.webgpu.js` returns **0**, i.e. no `addMaterial(..., 'ShaderMaterial')` mapping exists.
`NodeLibrary.fromMaterial` (`:56572-56594`) resolves by `material.type` and returns `null` when
unmapped; the consumer at `:53530-53540` then does:

```js
let nodeMaterial = renderer.library.fromMaterial( material );
if ( nodeMaterial === null ) {
  error( `NodeBuilder: Material "${ material.type }" is not compatible.` );
  nodeMaterial = new NodeMaterial();
}
```

On the stage renderer the surf water would **silently render as a bare default `NodeMaterial`** —
no Gerstner displacement, no crest/foam/caustics, no palette, no sun reflection — plus one console
error. The "glowing floating water ribbon" that `river-scene.tsx` calls "THE WORLD" becomes a flat
grey band, on **both** backends.

### 0.2 Reef's bloom is a WebGL-only composer that also seizes the canvas render loop

`surf-bloom.tsx:41` imports `EffectComposer`, `RenderPass`, `UnrealBloomPass` from `three-stdlib`
(classic `WebGLRenderer` passes). `:55-62` guards the composer on `gl.isWebGLRenderer`;
`WebGPURenderer` does not set that flag, so bloom disappears on the stage in both backends.

Worse, `:89-100` runs `useFrame(() => { … composer.render() … }, 1)`. In R3F 9.5.0 the
positive-priority subscription is **canvas-global**:
`@react-three/fiber/dist/events-358c3764.cjs.dev.js:1102` does
`internal.priority = internal.priority + (priority > 0 ? 1 : 0)` on subscribe, and `update()` at
`:16022-16046` gates the automatic render on it —
`if (!state.internal.priority && state.gl.render) state.gl.render(state.scene, state.camera)`.
Therefore:

- A **native** `useFrame(cb, 1)` inside the stage canvas disables the stage's automatic render for
  **every** slot while the reef subtree is mounted — and `StageSceneSlot` keeps a slot mounted once
  its status leaves `'unrequested'`/`'evicted'` (`WorldStageCanvas.tsx:875-889`), so world/cove/kelp
  would go black after the first activity visit.
- Converted to `useSceneFrame(cb, 1)`, the priority is used only for intra-scene dispatch ordering
  (`use-scene-frame.ts:33-45`, `:174-182`) and never reaches `internal.priority`;
  `StageFrameScheduler` itself subscribes at the **default** priority (`:164`), so R3F keeps
  auto-rendering and the composer output is overwritten every frame at 2× GPU cost.

*(v1 additionally claimed `RenderPass` would hold a stale camera. **Retracted (m3)** — the composer
`useMemo` is keyed `[gl, scene, camera]` at `surf-bloom.tsx:74`, so a root-camera swap rebuilds it.
The claim was never load-bearing.)*

### 0.3 What is NOT the problem

The "two THREE instances" hazard documented in `BumperShellsScene.tsx:3-27` does not apply.
`three/package.json` maps `"."` → `./build/three.module.js` and `"./webgpu"` →
`./build/three.webgpu.js`, and **both bundles import from the same `./build/three.core.js`** (line
6 of each). Core classes are a single shared identity. That matters concretely because
`NodeLibrary.getLightNodeClass` is keyed by the **constructor** (`three.webgpu.js:43925` →
`:56650`) and still resolves for a plain-`three` light. Built-in materials and lights would survive
the move; only `ShaderMaterial` and the classic composer do not.

### 0.4 The cost of unblocking §0.1 + §0.2 properly

Porting `_waterVert` + `_waterFrag` (~440 lines of GLSL across `surf-ribbon.tsx:149-760`) to TSL,
replacing `UnrealBloomPass` with three/webgpu's post-processing node graph, and re-verifying every
reef material and instanced draw on the node pipeline is a **shader rewrite of the game's headline
visual**. It is Rule E3 work with a high probability of visible regression on the exact surface the
founder signed off on in the fun pass, and it has nothing to do with killing the return loading
screen.

### 0.5 FROZEN DECISION — the OVERLAY-SLOT model

**P4 moves the ROUTE into `app/(world)/` and registers an `activity` stage slot whose in-canvas
content is deliberately EMPTY. Reef Race and Bumper Shells keep rendering in their own
room-keyed `<Canvas>` — reef `key={roomId}`, bumper `key={canvasKey}` — mounted in the page layer above the stage canvas.**

| Crossing | Today | After P4 |
|---|---|---|
| `/game` → `/activity/…` | world canvas destroyed, WebGPU device lost, world textures freed | stage canvas + world slot **survive**; stage fades out; activity canvas cold-boots behind the opaque overlay; fade in |
| `/activity/…` → `/game` | **full cold boot** behind `SeaLoadingScreen` | **fade only.** World slot resident and warm; `SeaLoadingScreen` never mounts. |
| Play Again (`/game?quickQueue=…`) | full cold boot | fade (requires the §2a href contract + the `WorldStageRoot.tsx:184` query strip) |

The founder's stated target — "leaving the Cove, Kelp Forest, or Reef Race back to `/game` replays
the full loading screen" (plan lines 15-20) — is fully met. Entering still boots a canvas, but the
**small** one (reef's budget is ≤70 draw calls / ≤220k tris, `ReefRaceScene.tsx:28`) instead of
destroying the **large** one (world textures ~491 MB measured, plan line 41). §8.1 states this
asymmetry as the headline limitation.

**Constraint-2 dividend:** **room-keyed canvas recreation survives** — reef keeps `key={roomId}`
(`ReefRaceScene.tsx:746`) and bumper keeps `key={canvasKey}` where
`canvasKey = \`${roomId}-${spectatorCamMode ?? 'chase'}\`` (`BumperShellsScene.tsx:633,638`), so
everything that keying reset keeps being reset, including bumper's spectator-mode re-key. *(R10-m3:
v10's summary said `key={roomId}` survives "verbatim" for both, which §5b already contradicted — a
summary drifting from its own body section.)* §5c enumerates
the whole surface as a *proof of preservation* — and now also covers the page/HUD state that
keying never controlled (M2).

The in-canvas slot model is **sequenced, not cancelled**: OQ-1 carries it with owners and a
deadline, per Rule E6.1.

---

## 1. File-by-file change list

`NEW` = created · `DEL` = deleted · `MOVE` = path change.

### 1a. P4a — route joins the group + the empty slot + readiness + handoff

| File | Change |
|---|---|
| `MOVE apps/web/src/app/activity/[activityId]/[roomId]/page.tsx` → `apps/web/src/app/(world)/activity/[activityId]/[roomId]/page.tsx` | Shell rewrite (§2g), `ActivityRoomRuntime` keying (§2g), readiness wiring (§2b), exit routing (§2h), scene boundary (§2i). |
| `MOD apps/web/src/app/(world)/layout.tsx` | **v8 (R7-1b) - a same-diff requirement, not optional hardening.** Add `export const dynamic = 'force-dynamic';`. Verified at the anchor that this file contains ONLY the `WorldPresence` + `WorldStageRoot` wrapper with **no route-segment config**. §2m-A puts `useSearchParams()` inside `WorldStageRoot`, which lives here, and a client `useSearchParams()` opts its subtree into client-side rendering unless the route is dynamic or the read sits under `Suspense`. Without this line the nonce read would silently change the rendering mode of every route in the group. |
| `NEW apps/web/src/app/(world)/activity/layout.tsx` | `export const dynamic = 'force-dynamic';` + pass-through, same shape as `app/(world)/cove/layout.tsx`. **Also fixes a pre-existing defect:** `/activity/…` is a `'use client'` page with no `generateStaticParams` and **no force-dynamic guard in its ancestry** — `app/layout.tsx` does not set `dynamic`, and the only two force-dynamic layouts under `app/` are `(world)/cove/layout.tsx` and `(world)/game/layout.tsx`. Once it is a group member, stale edge-cached HTML would boot the SHARED stage from an obsolete chunk graph. Cache-Control evidence is a §6.6 gate, captured **before and after**. |
| `DEL apps/web/src/app/activity/` | Empty after the move. |
| `NEW apps/web/src/app/(world)/activity/[activityId]/[roomId]/activity-readiness.ts` | Pure `decideActivityReadiness` + types (§2b). No React, no THREE. |
| `NEW apps/web/src/app/(world)/activity/[activityId]/[roomId]/activity-readiness.test.ts` | §6.2. |
| `NEW apps/web/src/app/(world)/activity/[activityId]/[roomId]/ActivitySceneErrorBoundary.tsx` | Page-layer boundary + Reload/Try-again for the two `next/dynamic` scene chunks and for activity-canvas context loss (§2i). |
| `NEW apps/web/src/app/(world)/activity/[activityId]/[roomId]/ActivityHandoffRecovery.tsx` | The R2-B3 recovery surface shown when the outgoing-overlay handoff times out. **v4 (R3-B3): two actions — Hard navigate (primary) and Retry (secondary). Stay is GONE** (§2d item 4). Renders ABOVE the still-live activity page; unmounts nothing. |
| `MOD apps/web/src/hooks/useActivityWs.ts` | **v4 (R3-B3) — a declared change to a file v3 listed as untouched.** Adds an idempotent `leaveAndClose(): void` to the hook's return value: it sets `intentionallyClosedRef.current = true`, clears the ping/reconnect timers, sends `{type:'leave'}` when `readyState === OPEN`, calls `ws.close(1000, 'hard-nav')`, and **nulls `wsRef.current`** so the existing effect cleanup (`:311-333`) becomes a no-op if it later runs — that null is what makes it idempotent and what prevents a double-`leave`. Reason: the recovery surface's Hard navigate calls `window.location.assign(href)`, and grepping `pagehide\|beforeunload\|visibilitychange` over this file at the anchor returns **nothing** — the effect cleanup at `:311-333` is the ONLY `{type:'leave'}` sender, and a document navigation is not guaranteed to run it. **No other behavior changes**; the effect, its deps (`:334`), reconnect, ping, and frame handling are untouched. |
| `NEW apps/web/src/lib/three/activities/shared/ActivityCanvasReadyProbe.tsx` | ~50 LOC. **Priority-0** native `useFrame` (B1), two-frame count, `queueMicrotask` ack, `gl.info.render.calls > 0` assertion in dev, and `onCanvas(gl.domElement)` publication for the context-loss listener (§2c, R2-B2c). |
| `NEW apps/web/src/components/three/world-stage/StageHostedActivityScene.tsx` | Empty slot host + `StageIdlePause` (§2f). |
| `MOD apps/web/src/components/three/world-stage/WorldStageRoot.tsx` | `ACTIVITY_SCENE_ID`; the prefix branch in `sceneIdForPathname` (§2a); `LazyStageHostedActivityScene`; a fourth `scenes` entry with `overlayOpaque: true` and the P3 v4 `resetKey` boundary (§2e); the outgoing-overlay handoff + its 10 s **hold-and-surface** timeout (§2d); **the v11 navigation lineage (§2m-A): `useSearchParams()` in the children-swap effect deps; `commitStageNavigation(nav, options)` stamping `${documentEpoch}.${seq}` from `nextNavNonce()`; `acceptNavigationIntent()` as the ONLY writer of supersession+intent, called at all four accepted-navigation sites INCLUDING the handler `ADOPT` branch (`:198-203`), which mints nothing; `getNavigationIntent()` read by the repair; `settleIssue(id)` by string id; the six landing classes; and **NO stripping — a component-issued URL keeps its `__wsnav` nonce for the life of its history entry (v13, R12-1)**; the `openedMidpointRef` opaque-lineage install rule and scene+destination pending equality (§2m); `navigationRef.current = null` on a pathname-driven supersession; the probe's `committedStageNavigations` field; **`:184` query strip**; `stageColdInit` widened; probe `navigate` typed `WorldStageHref`. **No component-local lineage refs — the module owns issues, tombstones, epoch, sequence, and intent (R10-M1).** |
| `MOD apps/web/src/components/three/world-stage/WorldStageCanvas.tsx` | `WorldStageScene` gains `overlayOpaque?: boolean` (§2d). No other change. |
| `MOD apps/web/src/components/three/world-stage/stage-store.ts` | New `outgoingOverlay: { pathname: string; href: string; requestId: number; status: 'holding' \| 'timed-out' } \| null` + `setOutgoingOverlay` / `markOutgoingOverlayTimedOut(requestId)` / `clearOutgoingOverlay(requestId)`; new `activityTarget: { roomKey: string } \| null` + `setActivityTarget` / `clearActivityTarget` (§2m). Both cleared by `resetStage()`. **`noteRecovery` is NOT called from either path** (SELF-B). `requestScene`/`retryStageScene`/`completeTransition` are otherwise untouched. |
| `MOD apps/web/src/components/three/world-stage/StageTransition.tsx` | (a) `sceneKind` map gains `'activity'`; (b) the fade-in gate gains `&& (outgoingOverlay === null \|\| outgoingOverlay.requestId !== pendingRequest.requestId)` — **request-scoped, so cove/kelp/world requests are provably unaffected** (§6.2 pins this). |
| `MOD apps/web/src/components/three/world-stage/stage-watchdog-machine.ts` | `WatchdogSample['sceneKind']` gains `'activity'`. The `sceneKind === 'world'` ceilings block is untouched. |
| `MOD apps/web/src/lib/three/activities/reef-race/ReefRaceScene.tsx` | ONE change: `<ActivityCanvasReadyProbe roomKey={…} onPainted={…} />` mounted last inside `SceneContents`, after `<SurfBloom />` (`:718`). **No renderer, material, shader, camera, or postprocessing change.** |
| `MOD apps/web/src/lib/three/activities/bumper-shells/BumperShellsScene.tsx` | Same probe mount after `<PreCompilePipelines />` (`:566`), **plus** the §5c pre-existing fix: reset `_hitCheckScratch.lastHitCount` / `_elimCheckScratch.lastElimCount` when `useActivityStore.getState().roomId` changes (Memory RULE 6). |
| `MOD apps/web/scripts/world-stage-probe.mjs` | `--pair` gains `activity`; new `--lane=activity-exit`; new `--lane=activity-gpu` (§6.9/§6.11). |
| `MOD apps/web/.env.example` | **v16 (R14-2b/R15-3).** Add `NEXT_PUBLIC_ENABLE_STAGE_PROBE=` with the comment *"Set to 1 only for local/staging probe builds; leave unset in production."* This is the ONLY env var the diff adds (§4). |
| `NEW apps/web/src/components/three/world-stage/stage-navigation-lineage-store.ts` | **v12 (R11-5) — the promised row.** Module-scoped (NOT hooks) owner of the whole navigation lineage, so it survives a real `WorldStageRoot` unmount/remount and is fresh only per document: `documentEpoch` (`crypto.randomUUID()`) + monotonic `sequence` + `nextNavNonce()` producing **string** ids `${documentEpoch}.${seq}`; the bounded rings (`MAX_TRACKED_NAVIGATION_ISSUES = 8` issues, `MAX_NAVIGATION_TOMBSTONES = 32` tombstones) and the single `intent`; `acceptNavigationIntent(href)` — the ONLY writer of supersession + intent — and `getNavigationIntent()`; `classifyNavLanding()` and `settleIssue(id)` (by id, never by destination); `retireStaleIssues()` (hygiene only); **No strip state of any kind (v13, R12-1)** — in-session stripping is deleted, so the module owns no marker, queue, outstanding slot, or ack timeout. Exports `resetStageNavigationLineage()` for **test isolation only — no production caller** (§2m-A's frozen document-scoped semantic). |
| `NEW apps/web/src/components/three/world-stage/stage-scene-id.ts` | **v4 addition (R3-B1 consequence).** The three pure pathname helpers — `sceneIdForPathname`, `stagePathnameFromHref`, and the new `stageDestinationKey` (§2a, §2m) — live here rather than inside `WorldStageRoot.tsx`, which is where `sceneIdForPathname` sits today (`:59-64`, module-private). Reason, stated because v3 hid it: `stage-scene-id-for-pathname.test.ts` was already declared, but importing those helpers from a `.tsx` component module drags R3F and `three/webgpu` into a plain unit test. A pure sibling module is the same shape P3 v4 already uses for `stage-navigation.ts`. `WorldStageRoot.tsx` imports from here; no behavior change. |
| `NEW apps/web/src/components/three/world-stage/stage-scene-id-for-pathname.test.ts` | §6.2 (24 cases, incl. the six `stageDestinationKey` cases). |
| `NEW apps/web/src/components/three/world-stage/stage-outgoing-overlay.test.tsx` | §6.2. |
| `NEW apps/web/src/app/(world)/activity/.../activity-room-runtime.test.tsx` | §6.2. |

### 1b. P4a — navigation contract (amends P3-landed code; declared)

| File | Change |
|---|---|
| `MOD apps/web/src/components/three/world-stage/stage-navigation.ts` | `WorldStagePathname` + `WorldStageHref` (§2a); `WorldStageNavigationRequest['to']: WorldStageHref`; **`WorldStageNavigationSnapshot` gains `bufferedPathname: WorldStagePathname \| null`** derived by the same parser, alongside the existing `bufferedTo` (whose type widens from P3 v4's `'/game' \| '/cove' \| '/kelp' \| null` to `WorldStageHref \| null`). |
| `MOD apps/web/src/lib/three/kelp-walkin-guard.ts` | **P4 amends P3.** Rules 3 and 4 (P3 **v4** §2h) compare `nav.bufferedPathname` instead of `nav.bufferedTo` — rule 3 `=== '/kelp'`, rule 4 `!== null && !== '/kelp'`. Rationale: once hrefs may carry a query, an href comparison is fragile; kelp never navigates with a query today so this is a **no-op behavior change** that removes a future trap. **Rule 4's PROCEED/supersede verdict is preserved exactly** (R2-M2); rule 8's `stagePendingSceneId === null` conjunct, rule 9, and §2i's token lifecycle are untouched. Declared here rather than buried; §6.2 adds the `'/kelp?x=1'` case. |
| `MOD apps/web/src/lib/three/kelp-walkin-guard.test.ts` | The two amended rules + the query case. |
| `MOD apps/web/src/components/three/world-stage/stage-navigation-ownership.ts` | **v5 (R4-B2) — a declared amendment to a P3-landed shared file.** `decideStageNavigationOwnership` gains two OPTIONAL inputs, `targetDestinationKey` and `pendingDestinationKey`, and one new branch returning `SUPERSEDE` when both are non-null and unequal (§2n). Inserted after the existing `pendingRequest.sceneId !== targetSceneId` check, before the `fadingOut ⇒ ADOPT` check. Both inputs default to `null`, so an unchanged caller gets the anchor's behavior exactly; `WorldStageRoot` is the only caller. `decideStageNavigationHistoryMethod` (`:13-17`) is **untouched**. Reason: at the anchor (`:19-36`) ownership is scene-only, so a `navigateOut` to activity room C while room B is pending returns `ADOPT` or `EXECUTE_NOW` and never mints a C request — the handler-side twin of the pathname-side R4-B2 defect. |
| `NEW apps/web/src/components/three/world-stage/stage-navigation-ownership.test.ts` | §6.2 (5 cases). Covers the two new SUPERSEDE verdicts, the unchanged same-destination verdicts, and the null-input fallthrough. |

### 1c. P4b — presence + protocol

| File | Change |
|---|---|
| `MOD packages/shared/src/types/world.ts` | `export const AT_ACTIVITY = 'at-activity' as const;` beside `AT_COVE_ACTIVITY` (`:18`) and `AT_KELP_ACTIVITY` (P3); extend the `activity` comment (`:46`). |
| `MOD apps/web/src/components/three/world-stage/WorldPresence.tsx` | Pathname → `{ policy, remoteActivity }`: `/game` → `active`; `/cove` → `remote`+`AT_COVE_ACTIVITY`; `/kelp` → `remote`+`AT_KELP_ACTIVITY`; `/activity/:a/:r` → **`remote`**+`AT_ACTIVITY`; any other in-group path → `remote`+`'idle'`. **`WorldPresencePolicy` is NOT widened** (M1). |
| `MOD apps/web/src/lib/three/remote-players.tsx` | `adaptPlayer()` (`:49-55`): `AT_ACTIVITY` → `direction:'idle'` + name suffix `' · in an activity'`. |
| `MOD apps/api/src/services/skill-protocol.ts` | Co-presence section (~`:864`) lists `at-activity`; `PROTOCOL_VERSION` **42 → 43** (R9-m1 rebase: P3 landed as 42 after the wallet slice consumed 41). **⚠ The implementer MUST re-read the landed constant before editing it** — the anchor has `PROTOCOL_VERSION = 40` (`skill-protocol.ts:372`) and P3 is not landed at the anchor, so 42 is round 9's report accepted on its authority, not a value I verified in this tree. **PROTECTED partner surface — §6.8, OQ-2.** |
| `MOD apps/api/src/services/__tests__/skill-protocol-onboarding.test.ts` | Version pins at lines **28 and 181** → 43, **and widen P3's conventional-value assertion to include `at-activity`** (M5). |
| `MOD apps/api/src/routes/__tests__/agent-paid-surface.test.ts` | Version pin at `:42` → 43. |
| `MOD docs/hatcher-integration-spec.md` | Update the **four LIVE** references (prose + the JSON example) to 43. **Historical version-ledger entries are appended to, never rewritten** (M5). |

### 1d. P4c — world-stream downlink suspension (independently revertable)

| File | Change |
|---|---|
| `NEW apps/web/src/hooks/world-downlink-policy.ts` | Pure `decideWorldDownlink` (§2k). |
| `NEW apps/web/src/hooks/world-downlink-policy.test.ts` | §6.2. |
| `MOD apps/web/src/hooks/use-world-stream.ts` | Third optional positional parameter `downlinkEnabled = true`, delivered by a ref exactly like `policyRef` (`:70-72`). The edge is applied inside `runMachineTick` (`:400-411`) — which already runs on the existing 200 ms interval — so **the main effect's dependency array (`:583-592`) MUST NOT grow**. `uploadRemotePosition()` (`:343-352`) reads P3's `remoteActivity` ref. **R2-M1 additions:** a closure-scoped `streamEpoch` guarding `openStream` and all four of its handlers plus every retry callback (`:413-531`); a `downlinkEnabledRef` check before the `openStream` calls in `bootstrap()` (`:554`) and `rejoinWithTicket()` (`:294`); `LAND_PARCELS_QUERY_KEY` invalidation on the `OPEN` edge (pairs with the `land` listener at `:470-471`); and a `pageshow`-persisted membership-reset listener beside the existing `pagehide` beacon (`:564`, cleanup `:570`). **R3-B2 additions (v4), as corrected by R4-B3/B4 (v5):** TWO primitives, not one — `invalidateStream()` for the stream being closed/replaced/superseded/torn down (the three inline source-drops at `rejoinWithTicket` (`:285-292`), `handleSuperseded` (`:186-190`), and the teardown (`:572-573`) route through it), and `dropFailedSource(source)` for the error path, which drops the source WITHOUT touching the epoch or the retry lineage. `streamEpoch` rotates inside `openStream` on every source construction; each LISTENER carries the epoch + `downlinkEnabledRef` + `es === source` triple guard; a distinct `activeRetryToken` minted by `armRetry` is the retry continuation's liveness proof (checked again after the `recoverWithTicket()` await); and the `decideWorldDownlink` input gains `pendingReopen` = `activeRetryToken !== null`, consumed by rule 1 (fire CLOSE when `onerror` already nulled `es`) **and** rule 2 (never pre-empt an owed reopen). **R5-B2 additions (v6):** the input also gains `recoveryInFlight`, read from the anchor's existing closure flag already threaded into `runMachineTick` (`:400-411`) and consumed by **rule 2 only**; and the escalation continuation re-checks `recoveryInFlight` after the `recoverWithTicket()` await, RE-ARMING behind a busy recovery instead of bare-opening the old room — because at the anchor a busy call returns a bare `null` identical to a failure (`:354-355`, `:267-268`), and a plain early return would leak the retry token (SELF-G). **R7-4 additions (v8):** the whole fetch-plus-body is wrapped as `joinWithBody()` and raced against an **independent `JOIN_TIMEOUT_MS = 15_000` deadline timer** (the anchor fetch at `:140-146` has no signal and no deadline); **BOTH arms call the single lease-CAS `settleRecovery`**, so the later one is refused rather than abandoned (R9-B4); **all recovery dispatch is removed from `recoverWithTicket()`** so exactly one dispatch site exists; and `AbortController` is demoted to cleanup - together these guarantee `recoveryInFlight` CLEARS, without which v7's ownership transfer to rule 2 was nominal and produced a permanent zero-open dead retry. `JOIN_TIMEOUT_MS < RECOVERY_WAIT_CEILING_MS` is a pinned invariant. **Declared scope:** `bootstrap()` is changed to call `joinBounded()` (R11-4: the raw `join()` does NOT bound it automatically), so the deadline bounds that path too - a strict improvement, but a behavior change stated rather than buried. **R6-B3 additions (v7):** the `recoveryInFlight` check moves to the TOP of the `armRetry` timer body, above the escalate/bare branch, so the `!shouldEscalate` bare reopen can no longer fire underneath a live recovery; busy-waiting is bounded by `RECOVERY_WAIT_CEILING_MS` after which the lineage clears `activeRetryToken` and RETIRES, handing ownership to the `!recoveryInFlight`-guarded rule-2 edge; and §2k-A enumerates all five open sites with a proof for each, including `bootstrap()`, which is unreachable during recovery because the machine's `BOOTSTRAP` branch requires `!hasSession` (SELF-H). |
| `MOD apps/web/src/components/three/world-stage/WorldPresence.tsx` | Passes `downlinkEnabled={pathname is not an activity path}`. |
| `MOD apps/web/src/hooks/world-stream-machine.ts` | **NOT CHANGED.** Listed explicitly so a reviewer can confirm the machine is untouched. |

### 1e. P4d — shared held-key listener primitive (independently revertable; the ruling-compliance commit)

| File | Change |
|---|---|
| `MOD apps/web/src/lib/three/player/player-input.ts` | Adds the neutral `attachHeldKeyListeners(config)` primitive (§2l) and re-implements `attachPlayerKeyListeners(policy)` on top of it with byte-identical behavior. |
| `MOD apps/web/src/hooks/useActivityInput.ts` | The keydown/keyup/pointerdown/custom-action attachment block (`:533-548`) is re-expressed through `attachHeldKeyListeners`. **The 30 Hz send loop (`:572-683`), the key→action-bit mapping, the one-shot latch, `recomputeReefKeyboardDir`, and `selfInputBus` publishing are UNCHANGED.** |
| `NEW apps/web/src/lib/three/player/held-key-listeners.test.ts` | §6.2 — equivalence against the pre-extraction behavior for both consumers. |

### 1f. Deliberately NOT changed

`surf-ribbon.tsx` · `surf-bloom.tsx` · `terrain-shader.tsx` · `water-surf.tsx` · `river-scene.tsx` ·
`ReefRacePlayer.tsx` · every other file under `activities/**` except the two scene roots ·
`stores/activity.ts` · `components/game/reef-race-hud.tsx` ·
`bumper-shells-hud.tsx` · `activity-mobile-controls.tsx` · `lobby-landing.tsx` ·
`activity-results-modal.tsx` · `lib/activity-audio.ts` · `hooks/world-stream-machine.ts` ·
**the entire `apps/api` activity vertical** (`services/activity/**`, `routes/activities*`) ·
`packages/shared` activity types.

**Corrected in v4 (R3-B3):** `hooks/useActivityWs.ts` was on this list in v1-v3 **and that was wrong
as of the Hard-navigate design** — it now carries the additive `leaveAndClose()` (§1a, §2d item 4).
Nothing else in it changes, and §6.7's real-race row diff plus the §5f lifecycle table are the gates
that prove it. `ReefRacePlayer.tsx` stays on the list and §6.1's diff-scope gate now enforces that
mechanically rather than by promise (R3-M1).

---

## 2. Exact TypeScript signatures

### 2a. Pathnames vs hrefs — B6

```ts
// stage-navigation.ts

/** What the parser RETURNS. One entry per stage slot. */
export type WorldStagePathname =
  | '/game'
  | '/cove'
  | '/kelp'                                    // P3
  | `/activity/${string}/${string}`;           // P4

/**
 * What navigation ACCEPTS. A stage pathname, optionally carrying a query and/or hash
 * (`/game?quickQueue=reef-race` is a live P4 target — see §2h).
 * This type is a GUARDRAIL, not the authority: `sceneIdForPathname` is applied to
 * `new URL(to, window.location.origin).pathname` at runtime, and that parse is
 * authoritative. §6.2 carries the URL matrix.
 */
export type WorldStageHref =
  | WorldStagePathname
  | `${WorldStagePathname}?${string}`
  | `${WorldStagePathname}#${string}`;

export interface WorldStageNavigationRequest {
  to: WorldStageHref;
  onMidway?: () => void;
  onExpired?: () => void;
}

/** P3 v4 §2h shape (lines 521-532), PLUS the P4 field. */
export interface WorldStageNavigationSnapshot {
  readonly mounted: boolean;
  readonly handlerInstalled: boolean;
  readonly bufferedTo: WorldStageHref | null;
  /** NEW (P4): `bufferedTo` reduced by the authoritative parser. Query/hash stripped. */
  readonly bufferedPathname: WorldStagePathname | null;
  readonly bufferedExpiresAt: number | null;
}
export function readWorldStageNavigationSnapshot(): WorldStageNavigationSnapshot;
```

```ts
// stage-scene-id.ts — pure. No React, no THREE. (v4: extracted from WorldStageRoot.tsx,
// where `sceneIdForPathname` is module-private at :59-64 today — see §1a for why.)
export const ACTIVITY_SCENE_ID = 'activity';

/**
 * Maps a PATHNAME (never an href) to its stage slot id, or null.
 * `/activity/:activityId/:roomId` maps to `activity`; ANY other depth returns null so a
 * future `/activity/:a/:r/replay` page can live OUTSIDE the group without claiming the slot
 * (the same rule `/cove/history` and `/cove/verify` follow).
 */
export function sceneIdForPathname(pathname: string): string | null {
  if (pathname === '/game') return WORLD_SCENE_ID;
  if (pathname === '/cove') return COVE_SCENE_ID;
  if (pathname === '/kelp') return KELP_SCENE_ID;
  const segments = pathname.split('/');
  if (
    segments.length === 4 &&
    segments[1] === 'activity' &&
    segments[2].length > 0 &&
    segments[3].length > 0
  ) {
    return ACTIVITY_SCENE_ID;
  }
  return null;
}

/** The ONE place an href becomes a pathname. Used by the nav handler, the snapshot, and the page. */
export function stagePathnameFromHref(href: string): string {
  return new URL(href, window.location.origin).pathname;
}

/**
 * NEW in v4 (R3-B1). The DESTINATION a pathname names, at finer granularity than the slot id.
 * For every slot whose pathname carries no sub-identity this returns the scene id itself.
 *
 * WHAT THAT IDENTITY DOES AND DOES NOT BUY (restated in v6 per R5-m3). It makes §2n's ownership
 * branch DEAD for `/game`, `/cove`, and `/kelp`, because there both destination keys are produced
 * by this function from pathnames of the same slot inside ONE expression — same operands, same
 * instant. It does NOT license comparing a destination key against anything derived from
 * `activeScene`, `displayedPathRef`, or the router pathname: those advance on different clocks, and
 * v4 wedged every handler-owned crossing by assuming otherwise (R4-B1, SELF-F). Use this key for
 * OWNERSHIP questions ("is the pending/issued request for the same destination?"), never for
 * OPACITY questions ("has the cover gone down for this destination?") — §2m's `openedMidpointRef`
 * answers the latter.
 *
 * Returns `null` for a pathname that is not a stage route at all.
 */
export function stageDestinationKey(pathname: string): string | null {
  const sceneId = sceneIdForPathname(pathname);
  if (sceneId === null) return null;
  if (sceneId !== ACTIVITY_SCENE_ID) return sceneId;      // '/game' → 'world', etc.
  const segments = pathname.split('/');                    // ['', 'activity', a, r]
  return `${ACTIVITY_SCENE_ID}:${segments[2]}:${segments[3]}`;
}

/** `/activity/:activityId/:roomId` → `${activityId}:${roomId}`; anything else → null. (§2m) */
export function roomKeyFromPathname(pathname: string): string | null {
  const segments = pathname.split('/');
  if (segments.length !== 4 || segments[1] !== 'activity') return null;
  if (!segments[2] || !segments[3]) return null;
  return `${segments[2]}:${segments[3]}`;
}

/**
 * NEW in v8 (R7-1). The reserved query key that carries OBSERVABLE navigation identity.
 * Chosen for three properties: double-underscore prefix so it cannot collide with a gameplay
 * param (`shortCode`, `invite`, `quickQueue` are the live ones); stable across the app so one
 * classifier consumes it; and never read by any page — only §2m-A produces and consumes it.
 */
export const NAV_NONCE_PARAM = '__wsnav';

/**
 * Canonical comparable form of a stage URL: pathname + search + hash, with OUR nonce removed
 * from both sides of any comparison. R7-3: comparing pathnames alone let a stale landing with
 * the right path and the wrong query read as "already correct", and `page.tsx:112-114` seeds
 * `shortCode` from the query, so that is a real loss of room identity — not cosmetic.
 */
export function canonicalStageUrl(href: string): string {
  const url = new URL(href, window.location.origin);
  url.searchParams.delete(NAV_NONCE_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * v9 (R8-B3). The nonce is `${documentEpoch}.${sequence}`, NOT a bare integer.
 *
 * v8 accepted any positive integer as locally issued, which meant a URL from a nonce-bearing component URL and
 * re-opened from a bookmark in a NEW document was classified as ours and routed down the stale
 * branch instead of the cold-arrival path. The epoch makes provenance decidable: a nonce either
 * belongs to THIS document or it does not.
 *
 * `documentEpoch` is minted once per document at module load — module scope, deliberately NOT a hook
 * — so it survives `WorldStageRoot` unmount/remount and is fresh on reload, back-forward-cache
 * restore into a new document, or a bookmark open.
 */
export interface NavNonce { readonly epoch: string; readonly seq: number; }

export function parseNavNonce(search: string | URLSearchParams): NavNonce | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const raw = params.get(NAV_NONCE_PARAM);
  if (raw === null) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const suffix = raw.slice(dot + 1);
  // v10 (R9-m2): all-digits, not permissive parseInt — `parseInt('7abc')` is 7, which would accept a
  // corrupted or hand-edited nonce as valid.
  if (!/^[0-9]+$/.test(suffix)) return null;
  const seq = Number.parseInt(suffix, 10);
  if (!Number.isSafeInteger(seq) || seq <= 0) return null;
  return { epoch: raw.slice(0, dot), seq };
}
```

```ts
// stage-navigation-lineage-store.ts — NEW module (v9, R8-B3). Module scope, not hooks.
//
// WHY A MODULE AND NOT REFS. `navigationIssueSeqRef = useRef(0)` cannot stay monotonic across a real
// `WorldStageRoot` unmount/remount — the ref is re-created at 0 — so v8's "the sequence is
// monotonic for the document" claim was false and its own test could not pass. And the anchor's
// `resetStage()` (`stage-store.ts:454-456`) only does
// `set((state) => createInitialState(state.stageEpoch + 1))`: it resets STORE state and has no
// channel to component-local refs, so it could never have cleared the ledger either.
// v10 (R9-m2): `crypto.randomUUID()` — v9 used Date+Math.random, ~31 random bits among documents
// created in the same millisecond, which is small but is NOT the "fresh by construction" the prose
// claimed. The claim and the mechanism now match.
export const documentEpoch: string = crypto.randomUUID();

let sequence = 0;
export function nextNavNonce(): { id: string; seq: number } {
  const seq = ++sequence;
  return { id: `${documentEpoch}.${seq}`, seq };
}

/**
 * v10 (R9-B1). THE atomic accepted-navigation operation. Supersession and intent-recording happen
 * in ONE call so they cannot drift apart — v9 did them in two places and the handler's ADOPT branch
 * reached neither, which is how a newer intent could be defeated by an older stale landing.
 *
 * Called at ALL FOUR accepted-navigation sites in `WorldStageRoot` — `EXECUTE_NOW` (:194),
 * `ADOPT` (:198-203), the `SUPERSEDE` fallthrough (:206), and the pathname-first mint (:132) —
 * and again inside `issueNavigation`.
 */
export function acceptNavigationIntent(href: string): { destinationKey: string; href: string } {
  const canonical = canonicalStageUrl(href);
  for (const issue of issues) if (issue.status === 'in-flight') issue.status = 'superseded';
  intent = {
    destinationKey: stageDestinationKey(new URL(canonical, location.origin).pathname) ?? '',
    href: canonical,
  };
  return intent;
}

/**
 * TEST ISOLATION ONLY — see the frozen semantic below; there is NO production caller. Clears the
 * ledger, the tombstones, and the current intent, and deliberately NOT `documentEpoch` or
 * `sequence`, because a restarted sequence could re-mint an id that a surviving in-flight browser
 * navigation still carries. (R10-M1: v10's JSDoc mandated a mount caller three lines above the
 * paragraph that denies one.)
 */
/**
 * v10 (R9-B3) — FROZEN SEMANTIC: the lineage is DOCUMENT-scoped. It survives every root remount and
 * every stage reset, and is cleared ONLY by document teardown, which mints a new `documentEpoch` and
 * makes every prior nonce `foreign` by construction.
 *
 * v9 called this from `WorldStageRoot`'s mount effect, which discarded a legitimate issue that was
 * outstanding across a remount: it landed same-document-unknown, classified `issued-stale`, found no
 * intent to repair to, and was LOST. The mount effect (`WorldStageRoot.tsx:99-103`) is
 * `resetStageStore(); resetStageFrameDiagnostics(); setStageReady(true)` and v10 adds nothing to it.
 *
 * THIS FUNCTION HAS NO PRODUCTION CALLER. It exists for test isolation only, and saying so is the
 * point — v9 left a caller to be inferred, and the inference was wrong.
 */
export function resetStageNavigationLineage(): void { issues = []; tombstones = []; intent = null; }

/**
 * v15 (R14-1a). THE window predicate. Recorded at ISSUE time, module-owned, same lifetime as
 * `documentEpoch` — survives root remount, fresh per document, never reset by
 * `resetStageNavigationLineage()`.
 *
 * WHY NOT a scan of retained records: tombstones enter in SETTLEMENT/RETIREMENT order, not sequence
 * order. Sequence 2 can settle and be evicted while older superseded sequence 1 is still retained,
 * so "below the minimum retained sequence" is NOT equivalent to "provenance evicted" and a
 * scan-derived window mis-classifies exactly the interleaving the ring makes reachable.
 *
 * `issuedHighWater === sequence` by construction — it is the same counter `nextNavNonce()` bumps,
 * exposed under a name that says what the classifier uses it for.
 */
export function issuedHighWater(): number { return sequence; }
```

**Two keys, deliberately, and they are NOT interchangeable.** `stageDestinationKey` is
**scene-scoped** (`'activity:reef-race:A'`, `'world'`, `'cove'`) and is what `WorldStageRoot`
compares when deciding whether a pathname change is a real crossing — it must be total over every
stage pathname or the comparison degrades to the scene-level bug R3-B1 found. `roomKeyFromPathname`
is **activity-only** (`'reef-race:A'`) and is what the readiness contract (§2b `roomKey`,
`targetRoomKey`, `terminalRoomKey`) and `activityTarget` (§2m) speak in. Collapsing them into one
string would either put a `world`/`cove` sentinel into `activityTarget` or force the page to parse a
prefix off its own room identity; §6.2 pins both shapes independently.

**Required same-diff fix at `WorldStageRoot.tsx:184`:** the installed handler currently calls
`sceneIdForPathname(navigation.to)` on the raw href. `'/game?quickQueue=reef-race'` fails the
`=== '/game'` equality, the handler returns `false`, and Play Again silently falls through to the
`!requested` branch — cold-booting the world, the exact defect P4 exists to remove. It becomes
`sceneIdForPathname(stagePathnameFromHref(navigation.to))`. §6.2 pins it in both directions.

`stageColdInit` (`WorldStageRoot.tsx:136-163`) widens from the `'/game' | '/cove'` allow-list to
`sceneIdForPathname(stagePathnameFromHref(target)) !== null`.

### 2b. Readiness — B3

Readiness for the `activity` slot means **"the destination the user will actually look at is
painted"**. That signal originates outside the stage canvas, must survive a Canvas that does not
remount, and must re-fire for every new generation and every renderer recovery.

```ts
// activity-readiness.ts — pure. No React, no THREE, no store import.

export type ActivityTerminalBranch =
  | 'lobby'            // <LobbyLanding> (page.tsx:373-386)
  | 'avatar-loading'   // FullScreenStatus "LOADING AVATAR…" (:309-311)
  | 'no-avatar'        // FullScreenStatus (:313-321)
  | 'not-live'         // FullScreenStatus (:323-331)
  | 'unsupported'      // FullScreenStatus (:333-341)
  | 'room-error'       // FullScreenStatus (:343-351)
  | 'resolving-room'   // FullScreenStatus "RESOLVING ROOM…" (:353-355)
  | 'closed'           // MATCH EXPIRED panel (:357-368)
  | 'scene-chunk-error'// ActivitySceneErrorBoundary panel (§2i)
  | 'canvas-lost';     // activity-canvas webglcontextlost panel (§2i)

export interface ActivityReadinessInput {
  /** `${activityId}:${roomId}` of the room the page is CURRENTLY rendering. */
  readonly roomKey: string;
  /**
   * R2-B1. `${activityId}:${roomId}` the LIVE stage request is FOR, read from the store's
   * `activityTarget` (§2m), else null. Readiness may only speak for the destination.
   */
  readonly targetRoomKey: string | null;
  /** Live pending stage request generation for slot `activity`, else null. */
  readonly pendingGeneration: number | null;
  /** Live `useStageStore().recovery.count`. A renderer recovery must be able to re-ack. */
  readonly recoveryCount: number;
  /**
   * R2-B2b. Page-owned recovery counter — incremented by a chunk Try-again, a canvas-lost
   * retry, and a handoff Retry. Folded into the ack key so a page-owned attempt REVOKES a
   * prior acknowledgement for the same generation.
   */
  readonly attemptNonce: number;
  /** roomKey whose Canvas has painted at least one frame, else null. The LATCH. */
  readonly paintedRoomKey: string | null;
  /** The non-Canvas terminal branch currently rendered, else null. */
  readonly terminalBranch: ActivityTerminalBranch | null;
  /**
   * R2-B1. The roomKey the terminal branch belongs to, else null. Terminal state is
   * ROOM-SCOPED, never a bare branch literal — a status panel from the outgoing room must
   * not acknowledge the incoming room's generation.
   */
  readonly terminalRoomKey: string | null;
  /** `${generation}:${recoveryCount}:${attemptNonce}` already acked, else null. */
  readonly ackedKey: string | null;
}

export type ActivityReadinessDecision =
  | { readonly kind: 'ACK'; readonly generation: number; readonly ackKey: string }
  | {
      readonly kind: 'WAIT';
      readonly reason:
        | 'no-pending-request'
        | 'already-acked'
        | 'wrong-room'          // R2-B1
        | 'not-painted';
    };

export function decideActivityReadiness(i: ActivityReadinessInput): ActivityReadinessDecision;
```

**Ordered rules — first match wins.** Each row is a §6.2 test (table in §5h).

**Wiring (this is the part that closes the ordering hole).** The page runs the decision in a
`useEffect` whose dependency array contains **all nine inputs**, with `targetRoomKey`,
`pendingGeneration`, and `recoveryCount` read through live `useStageStore` selectors:

```ts
const pendingGeneration = useStageStore(
  (s) => (s.pendingRequest?.sceneId === 'activity' ? s.pendingRequest.generation : null),
);
const recoveryCount = useStageStore((s) => s.recovery.count);
const targetRoomKey = useStageStore((s) => s.activityTarget?.roomKey ?? null);
```

On a cold deep-link the page's effect runs BEFORE `WorldStageRoot`'s parent effect creates the
request (React runs child effects first), so the first evaluation returns
`WAIT:'no-pending-request'`; the selector subscription then re-fires the effect the moment the
request appears. On a watchdog silent retry or a same-scene request the Canvas is already painted
**and the destination is unchanged**, so rule 5 ACKs immediately without any Canvas remount. On a
renderer recovery `recoveryCount` changes, minting a new `ackKey`, so the slot can be re-acked.
On a page-owned recovery attempt `attemptNonce` changes, which likewise mints a new `ackKey` —
that is how an acknowledgement becomes revocable (R2-B2b).

**R2-B1, stated as the invariant this closes.** On activity A → activity B the store mints B's
generation while A is still displayed and A observes it through the subscription. Without
`targetRoomKey`, A's `paintedRoomKey === roomKey` satisfied the old rule 4 and A acknowledged B's
generation immediately — and a terminal branch in A did the same under the old rule 3. Because the
empty stage slot supplies the camera and controlled-frame acknowledgements at the midpoint, the
fade could then complete before B's Canvas ever painted. Rules 3 and 5 now BOTH require
`roomKey === targetRoomKey`, and rule 2 short-circuits to `'wrong-room'` before either is reached,
so the outgoing room is structurally unable to speak for the incoming one.

**What v3 got wrong here, and what makes the claim true in v4 (R3-B1).** v3 asserted this "holds
identically for handler-owned navigation and for pathname-first back/forward/direct navigation,
because §2m writes `activityTarget` on both request-minting paths." Round 3 falsified the second
half: on a pathname-first activity→activity change **no request is minted at all** — the
suppression clause at `WorldStageRoot.tsx:129-134` is scene-level, so there is no generation for
readiness to speak about and no site at which `activityTarget` would be written. Readiness was never
reached, correct or otherwise. The repair is upstream of this section, in §2m: the children-swap
effect becomes destination-aware, mints a real generation, and writes the target. **This section's
guarantees are conditional on that repair**, and §6.2 asserts the MINTING (not merely the deferred
swap), because a half-repair that only fixed the opacity test would hang instead of skipping
(SELF-C).

`paintedRoomKey` is set by the probe (§2c) and **cleared on room change, on `webglcontextlost`, and
on every `attemptNonce` bump**, so a new room — or a retried one — genuinely waits for its own paint.

### 2c. The readiness probe — B1

```tsx
// ActivityCanvasReadyProbe.tsx
export function ActivityCanvasReadyProbe(props: {
  /** `${activityId}:${roomId}`, reported back so a late paint from a stale room is ignorable. */
  readonly roomKey: string;
  /** Called exactly once per Canvas mount, after the SECOND composed frame. */
  readonly onPainted: (roomKey: string) => void;
  /**
   * R2-B2c. Publishes `gl.domElement` on mount and `null` on unmount, so the page owns a handle
   * to the EXACT activity canvas for its `webglcontextlost` listener (§2i item 4). A parent
   * effect that queried the wrapper could run while the `next/dynamic` fallback was still
   * mounted and would never re-run when the Canvas later appeared; publishing from INSIDE the
   * Canvas makes the handle exist iff the Canvas exists, and re-publishes on every remount.
   */
  readonly onCanvas: (element: HTMLCanvasElement | null) => void;
}): null;
```

Frozen implementation contract:

1. **`useFrame(cb)` with NO priority argument.** Passing any positive priority increments the
   canvas-global `internal.priority` (`events-358c3764.cjs.dev.js:1102`) and disables R3F's
   automatic render (`:16041`). Reef survives that only because `surf-bloom.tsx:100` manually
   renders; **Bumper has no manual render owner** — its three `useFrame`s (`BumperShellsScene.tsx:148`,
   `:283`, `:425`) are all default-priority and none of them render — so a positive-priority probe
   would leave Bumper's canvas permanently black. This is the exact trap §0.2 documents.
2. Count frames; on the **second** callback, `queueMicrotask(() => props.onPainted(props.roomKey))`.
   `update()` (`:16022-16046`) runs the subscriber loop and the auto-render inside ONE synchronous
   function, so a microtask queued from a subscriber drains **after** the render — and on reef,
   after `SurfBloom`'s priority-1 composer render too.
3. In development, assert `(gl as unknown as { info?: { render?: { calls?: number } } }).info
   ?.render?.calls` is `> 0` at ack time and `console.error` otherwise. Three's `WebGLRenderer`
   resets `info.render` at the start of each `render()`, so a nonzero value in the same-frame
   microtask proves a draw actually reached the framebuffer. §6.2 makes this a hard assertion under
   test for Bumper.
4. Idempotent: fires once per mount; the `paintedRoomKey` latch (§2b) provides persistence.
5. `onCanvas(gl.domElement)` in a mount effect, `onCanvas(null)` in its cleanup (R2-B2c). This is
   the ONLY sanctioned way the page obtains the activity canvas element; querying the DOM wrapper
   from a parent effect is explicitly forbidden and §6.2 pins the failure mode.

### 2d. The outgoing-overlay handoff contract — B2

**Mechanism being closed.** At the opaque midpoint `WorldStageRoot.tsx:228-249` calls
`router.push(...)`, but `displayedChildren` still holds the OUTGOING page until the
`[children, pathname, stageReady]` effect (`:105-134`) observes the committed route. Independently,
`StageTransition.tsx:186-207` starts fading in as soon as the destination is ready — and a resident
world is ready almost immediately, because `StageHostedWorldScene.tsx:35-38` acks synchronously
when `warmedOnceRef.current` is true:

```ts
state.setSceneWarming(WORLD_SCENE_ID, generation);
if (warmedOnceRef.current) {
  state.setRenderPaused(false);
  state.ackReady(WORLD_SCENE_ID, generation);
}
```

So the cover can lift onto the still-mounted, **opaque, canvas-bearing** activity page. This is
P4-specific: cove's page is transparent and canvas-free after P1b, and kelp's after P3b-2.

```ts
// WorldStageCanvas.tsx
export interface WorldStageScene extends StageCameraDefinition {
  content: ReactNode;
  appearance?: { /* unchanged */ };
  capabilities?: Partial<PlayerCapabilityMask>;   // P3 v4
  /**
   * NEW (P4). True when this slot's PAGE renders an opaque, full-viewport surface above the
   * stage canvas. Only `activity` sets it. A transition AWAY from such a route must not
   * complete its fade-in until the outgoing page has actually unmounted.
   */
  overlayOpaque?: boolean;
}
```

```ts
// stage-store.ts — additive
interface StageStore {
  /* … */
  outgoingOverlay: {
    pathname: string;
    /** The full destination href, retained so the R2-B3 recovery surface can re-issue or
     *  hard-navigate to the SAME target the stalled request was for. */
    href: string;
    requestId: number;
    status: 'holding' | 'timed-out';
  } | null;
  setOutgoingOverlay: (entry: {
    pathname: string; href: string; requestId: number;
  }) => void;
  /** R2-B3 + SELF-B: records the stall as DATA. Unmounts nothing, emits no `leave`, and does
   *  NOT call `noteRecovery` — `recovery.count` is a readiness ack-key component and a probe
   *  gate, so a navigation stall must not touch it. */
  markOutgoingOverlayTimedOut: (requestId: number) => void;   // no-op if requestId differs
  clearOutgoingOverlay: (requestId: number) => void;          // no-op if requestId differs
}
```

**Contract, in order:**

1. `WorldStageRoot.handleTransitionOpaque(request)` — BEFORE `commitStageNavigation` — if
   `sceneIdForPathname(displayedPathRef.current)` resolves to a slot with `overlayOpaque === true`
   **and** `request.sceneId` differs from it, call
   `setOutgoingOverlay({ pathname: displayedPathRef.current, href: taken.navigation.to,
   requestId: request.requestId })`.
   *Same-scene activity→activity is deliberately excluded* — **and, unlike v2, that exclusion is now
   actually sound.** v2 justified it by claiming the new room's paint "cannot happen before the
   commit"; R2-B1 falsified that. The real guarantee is §2b's destination binding: on
   activity→activity the outgoing room's `roomKey !== targetRoomKey`, so it cannot acknowledge
   readiness at all, and the gate is unnecessary rather than merely optimistic.
2. `StageTransition`'s fade-in gate gains
   `&& (outgoingOverlay === null || outgoingOverlay.requestId !== pendingRequest.requestId)`.
   **Request-scoped**, so a cove/kelp/world request — which never sets the field — is provably
   unaffected (§6.2 pins this). The gate does NOT consult `status`: a timed-out overlay keeps
   holding the cover, which is the whole point of R2-B3.
3. `WorldStageRoot`'s children-swap effect calls `clearOutgoingOverlay(requestId)` once
   `displayedPathRef.current` no longer equals the recorded pathname. React swaps the subtree in
   one commit, so the activity page unmounts, `useActivityWs`'s cleanup runs, and the `leave` frame
   goes out at that exact moment.
4. **Bounded failure — HOLD AND SURFACE, never tear down (R2-B3).**
   `OUTGOING_OVERLAY_COMMIT_TIMEOUT_MS = 10_000`. On expiry `WorldStageRoot` calls
   `markOutgoingOverlayTimedOut(requestId)` and `console.warn`s. **Nothing is unmounted, no `leave`
   is emitted, the cover is retained, and the transition stays held at `awaiting`.** The activity
   page observes `status === 'timed-out'` for its own `requestId` and renders
   `<ActivityHandoffRecovery>` above itself with **two** actions:

   | Action | Behavior | What is guaranteed |
   |---|---|---|
   | **Hard navigate** (PRIMARY) | `await`-free sequence: call the new idempotent `leaveAndClose()` on the activity WS (§1a) — reached through the page-level handle §2g publishes, since the hook lives inside the room-keyed subtree and this surface does not — then `window.location.assign(href)`. | Teardown of the document IS guaranteed. The `leave` FRAME is **best-effort** — see the bound below. |
   | **Retry** (secondary) | Bump `attemptNonce` (revoking any ack, §2b) and re-issue `requestWorldStageNavigation({ to: href })` with the stored href. | Nothing beyond "the client navigation is attempted again". Labelled as such in the UI copy. |

   **v3's third action, "Stay", is REMOVED (R3-B3).** It claimed to abandon the crossing and settle
   the fade back onto the live match. Verified at the anchor: `commitStageNavigation`
   (`WorldStageRoot.tsx:165-176`) calls `router.push`/`router.replace` and **retains no handle**,
   and Next's App Router exposes no cancellation for an issued client navigation. So "Stay" could
   only mutate the stage store; the stalled navigation would remain live and could commit afterwards,
   unmounting the match **after** the cover had been released — the precise failure §2d exists to
   prevent, re-introduced by the button meant to avoid it. A spec must not offer an action whose
   headline promise it cannot implement or test. *(What IS still true, and is what the copy should
   say instead: the match is never torn down by the stall. Nothing unmounts, no `leave` is emitted,
   and the sim keeps running behind the cover. The player is not forfeited by waiting — they simply
   cannot see the match while the cover holds.)*

   **The `leave`-frame bound, stated honestly (R3-B3).** v3 claimed Hard navigate emitted `leave`
   "through the existing `pagehide` beacon". **No such beacon exists.** Grepping
   `pagehide|beforeunload|visibilitychange` over `useActivityWs.ts` at the anchor returns nothing;
   its only `{type:'leave'}` sender is the effect cleanup at `:311-333`. The `pagehide` beacon at
   `use-world-stream.ts:559-565` leaves the **world** room, not the activity match. Hence
   `leaveAndClose()`. Its real guarantee:
   - It queues the frame on an OPEN socket **before** `location.assign`. Delivery is still
     best-effort at document teardown — a browser may discard buffered WS bytes.
   - If the server RECEIVES it, `handleMessage`'s `case 'leave'` sets
     `ws.data.internalCloseCode = 1000` (`activity-ws-hub.ts:403`) and the close handler branches to
     `notifyForfeit(room, avatarId, 'voluntary')` (`:327-328`) — immediate forfeit, as today.
   - If it is LOST, the close is ordinary, the player enters the existing
     `RECONNECT_GRACE_MS = 10_000` window (`:103`) and forfeits as `'timeout'` (`:341-342`).
   **The failure direction is safe:** losing the frame is strictly GENTLER than an immediate
   voluntary forfeit, and it is exactly the treatment a crashed tab already receives. §6.5's stall
   drill asserts the frame on the happy path; nothing in this spec asserts it is guaranteed.

   **Why v2's force-unmount was unsafe, kept for the record:** it emitted a voluntary `leave` — an
   *immediate* forfeit with no grace — for a navigation that had not committed, then lifted the
   cover onto a half-committed route with a stale URL and no destination page or HUD. A timer may
   report a stall; it may not resolve one on the player's behalf.
5. `resetStage()` clears the field; so does `WorldStageRoot` unmount.

**Why gate rather than tear down at the midpoint.** Detaching the activity page at the opaque
midpoint would emit `leave` for a navigation that has not happened yet — and if the navigation then
fails, the player is force-forfeited while still nominally in the match. Gating means the `leave`
fires exactly when the page really goes away. §8.4 states the resulting bound honestly.

### 2e. Slot registration — rebased on P3 v4 (B5)

```ts
{
  sceneId: ACTIVITY_SCENE_ID,               // 'activity'
  overlayOpaque: true,                      // §2d
  // Never rendered through — the activity canvas owns the picture. Values mirror reef's so a
  // future OQ-1 in-canvas migration does not change the projection.
  // reef-race-config.ts:302 CAMERA_NEAR = 1; :312 CAMERA_FAR = 34000; :322 CAMERA_OFFSET.
  camera: { fov: 60, near: 1, far: 34_000, position: [0, 260, -360] },
  appearance: {
    // reef-race-config.ts:342 FOG_COLOR '#0c1a2e'; ReefRaceScene.tsx:654 uses the same literal.
    background: 0x0c1a2e,
    fog: undefined,           // nothing is drawn in this slot
    shadows: false,
  },
  // P3 v4's mask. Every AVATAR capability is off: this scene has no walking avatar.
  capabilities: {
    move: false, sprint: false, jump: false, verticalSwim: false,
    emotes: false, interact: false, clickPath: false, cameraOrbitKeys: false,
  },
  content: (
    <Suspense fallback={null}>
      <StageSlotErrorBoundary
        // P3 v4 §2k (boundary shape lines 728-748; kelp's own registration line 761):
        // a resetKey PROP with getDerivedStateFromProps, NEVER a
        // React key. A key bound to generation would remount the healthy subtree on every
        // request; recovery.count is included because renderer recovery bumps only that
        // counter (stage-store.ts:440-446) and without it a failed boundary stays failed.
        resetKey={`${activityGeneration}:${recoveryCount}`}
        onRuntimeError={handleActivityRuntimeCrash}   // logs + DOM surface, NO beacon lane
      >
        <LazyStageHostedActivityScene />
      </StageSlotErrorBoundary>
    </Suspense>
  ),
}
```

The `WorldStageRoot`-level activity runtime-crash DOM flag clears on the **same** `resetKey`,
exactly as P3 v4 specifies for kelp.

### 2f. The empty slot host

```tsx
// StageHostedActivityScene.tsx
export default function StageHostedActivityScene(): null;
```

1. On `requested && generation > 0` → `setSceneWarming('activity', generation)`
   (`StageHostedCoveScene.tsx:35-40` shape).
2. On `requested && cameraInstalled && generation > 0` →
   `warmStageSlotRenderer({ slotId: 'activity', gl, compile: undefined,
   directWarm: () => { gl.render(scene, camera); }, isCurrent })` — the per-slot re-key P3b-1
   landed. There is no geometry to compile; the direct warm proves the renderer is alive for this
   generation. **It does NOT call `ackReady`** — the page does, via §2b.
3. Renders `null`. **No lights, no meshes, no `useSceneFrame` subscriptions.** A hidden-slot probe
   must see zero `activity` frame invocations at all times, active or hidden (§6.2).

**`StageIdlePause`.** Once `activeScene === 'activity' && transition.phase === 'idle'`, call
`setRenderPaused(true)`; `StageLoopController` (`WorldStageCanvas.tsx:841-860`) then sets
`setFrameloop('never')`. Release needs no code: `requestScene` unconditionally sets
`renderPaused: false` (`stage-store.ts:190`), and the host's effect cleanup clears it too
(`StageHostedCoveScene.tsx:114-117` shape). **Pausing before `idle` would stop
`StageFrameScheduler` before it can ack `firstControlledFrame` and deadlock the transition at the
45 s watchdog** — §6.2 has a regression test that fails if the guard is removed.

### 2g. The moved page shell + room-runtime keying — M2

```tsx
// The ONE root, replacing all four `<main position:fixed inset:0 background:'#…'>` shells
// (reef :391-398, bumper :419-425, the LobbyLanding path :373-386, FullScreenStatus :465-481).
<div className="game-container" style={{ background: 'transparent', overflow: 'hidden' }}>
  <ActivityRoomRuntime key={`${activityId}:${roomId}`} … />
</div>
```

`globals.css:274-285` ships exactly the rule this must satisfy:

```css
.world-stage-page-layer,
.world-stage-page-layer > .game-container { pointer-events: none; }
.world-stage-page-layer > .game-container > * { pointer-events: auto; }
.world-stage-page-layer > .game-container > .pointer-events-none { pointer-events: none; }
```

Verified interactions, unchanged from v1: the activity `<Canvas>` wrapper becomes a direct child
and inherits `pointer-events: auto` (required — `BumperShellsScene.tsx:267` constructs
`OrbitControls(camera, gl.domElement)` in spectator `'free'` mode); `ReefRaceHud` sets
`pointerEvents:'none'` INLINE on its own root (`reef-race-hud.tsx:1196-1203`) so clicks still pass
through to the canvas and its interactive children keep their own settings — **no HUD change**;
`ReefRaceSpeedLinesOverlay` is already `pointerEvents:'none'` (`reef-race-speed-surge.tsx:320`);
`ActivityMobileControls` gates on `useIsMobile()` (`activity-mobile-controls.tsx:31,81`);
`LobbyLanding` and `FullScreenStatus` keep their opaque backgrounds — they are full-screen
destinations, not overlays.

**`ActivityRoomRuntime` (M2).** Everything below the `<div className="game-container">` root moves
into a subtree keyed `${activityId}:${roomId}`, so a room change is a **remount**, not a
reconciliation. This replaces v1's reliance on undocumented App Router remount identity. Inside the
key live: the store-reset effect (`page.tsx:157-162`), `setSelfAvatarId` (`:166-168`), the
shortCode/participant-gate fetch and its `useState` (`:112-116`, `:173-197`) — **verified: the
`useState(searchParams?.get('shortCode') ?? null)` initializer at `:112-114` does NOT re-run on a
`roomId` change, so without the key a stale shortCode from room A would be sent as room B's auth
frame** — `lobbyGate` (`:131-137`), the spectator-cam bridge (`:235-249`), **the `useMemo` that
CONSTRUCTS the `next/dynamic` scene component** (§2i item 1 — moved here from module scope
`page.tsx:45-93`, which is what actually makes its loading/error state room-resettable; R2-m1(e)),
`LobbyLanding` and its 3 s poll timer, `ActivityMobileControls` and its joystick managers, the HUD,
the results modal, the chat log, `useActivityWs`, `useActivityInput`, the published activity-canvas
handle, and the readiness latch (`paintedRoomKey`, `terminalBranch`/`terminalRoomKey`, `ackedKey`,
`attemptNonce`, `sceneAttempt`).

**Outside the key** (page-level, deliberately): the `use(params)` unwrap, the audio-unlock listeners
(`:254-270` — the AudioContext is a module singleton, so re-registering per room would be pointless
churn), the readiness effect's stage subscriptions, and `<ActivityHandoffRecovery>` (§2d item 4 —
it must outlive a room-keyed subtree because it exists precisely when a crossing has stalled).

**The one seam that crossing creates, and how it is closed (v4).** `useActivityWs` lives INSIDE the
key; `<ActivityHandoffRecovery>` lives OUTSIDE it, yet its Hard navigate action must call
`leaveAndClose()`. The recovery component therefore cannot hold the hook. Frozen mechanism —
**the same publication pattern R2-B2c established for the canvas handle**: `ActivityRoomRuntime`
publishes the hook's `leaveAndClose` upward through a page-level
`useRef<(() => void) | null>` in a mount effect and writes `null` in its cleanup, and
`<ActivityHandoffRecovery>` reads `leaveRef.current?.()` at click time. The handle then exists **iff
a live WS owner exists**, and is re-published on every room remount. Two properties this buys, both
of which a naive prop-drill or context read would lose: a stalled crossing whose room subtree has
already unmounted calls nothing rather than a stale closure, and `leaveAndClose`'s own idempotence
(§1a) makes a double-click harmless. *(Called out explicitly because "the recovery surface outlives
the keyed subtree" and "the recovery surface must talk to something inside the keyed subtree" are in
tension, and v3 specified the first without noticing it would need the second.)*

### 2h. Exit routing — via the P3 v4 nav snapshot (B5, B6, R2-M2)

```ts
const navigateOut = useCallback((to: WorldStageHref) => {
  const requested = requestWorldStageNavigation({
    to,
    onExpired: () => {
      if (typeof window === 'undefined') return;
      if (sceneIdForPathname(window.location.pathname) !== 'activity') return;
      router.push(to);
    },
  });
  if (!requested) router.push(to);
}, [router]);
```

Applied identically at `handleLeave` (`page.tsx:292-295`), `handlePlayAgain` (`:303-305`),
`handleLobbyCancelled` (`:144-151`), the four `FullScreenStatus` actions (`:318`, `:328`, `:338`,
`:348`), and the `status === 'closed'` requeue (`:357-368`).

**There is no `onMidway`.** Cove and kelp teleport the world avatar to the matching door; an
activity is entered from a matchmaking queue, has no world-position semantics, and today's
`router.push('/game')` (`:294`) leaves the avatar where it stood. Preserving that is the
zero-behavior-change choice (OQ-3).

**Play Again targets `/game?quickQueue=…`** (`:304`, `:364`, `:406`), which is why §2a splits
`WorldStageHref` from `WorldStagePathname` and why `WorldStageRoot.tsx:184` must strip the query.
`usePathname()` excludes the query, so `sceneIdForPathname` on the *pathname* is correct;
`requestWorldStageNavigation` passes `to` verbatim to `router.push`, so the query survives.

**There is NO buffered-navigation guard on `navigateOut` (R2-M2).** v2 carried a one-line check that
RETURNED when `nav.bufferedPathname` named a different live destination, and described it as
"matching P3 v4 §2h rule 4's supersede semantics from the caller side." That was backwards: P3 v4
rule 4 reads `nav.bufferedTo !== null && nav.bufferedTo !== '/kelp' && nav.bufferedExpiresAt! >
nowMs` ⇒ **PROCEED** — "a new kelp request supersedes a buffered other-destination request." A
returning guard would silently swallow Leave and Play Again for the whole handler-install buffer
window. **The guard is deleted.** `requestWorldStageNavigation` overwrites the buffer, which is
exactly the ownership rule every other stage caller follows, and §6.2 carries the dropped-click
regression test. The activity route still **consumes** `readWorldStageNavigationSnapshot()` rather
than inventing a second mechanism — it is read for diagnostics and by the §2d recovery surface, not
as a veto.

### 2i. Page-layer failure surfaces — B4

```tsx
// ActivitySceneErrorBoundary.tsx
interface ActivitySceneErrorBoundaryProps {
  /** `${activityId}:${roomId}:${sceneAttempt}`. A change clears `failed`. Same shape as P3 v4's
   *  StageSlotErrorBoundary resetKey — a PROP with getDerivedStateFromProps, never a React key. */
  readonly resetKey: string;
  readonly onFailed: (branch: 'scene-chunk-error') => void;
  readonly onTryAgain: () => void;   // bumps sceneAttempt + attemptNonce
  readonly onReload: () => void;     // location.reload()
  readonly children: ReactNode;
}
```

**Which `next/dynamic` this actually is (R2-B2 — the correction that drives the rest of §2i).** The
activity page lives under `app/`, so Next's App-Router alias applies:
`createAppRouterApiAliases` maps `next/dynamic` → `next/dist/api/app-dynamic`
(`apps/web/node_modules/next/dist/build/create-compiler-aliases.js:228`), which is
`shared/lib/app-dynamic.js` → `shared/lib/lazy-dynamic/loadable.js`. That module is a thin
`React.lazy` + `Suspense` wrapper: `const Lazy = lazy(() => opts.loader().then(convertModule))`, and
`opts.loading` is rendered **only as the Suspense fallback**, with props
`{ isLoading: true, pastDelay: true, error: null }`. **There is no `retry` prop and `error` is
hard-coded `null`** — the pages-router `loadable.shared-runtime.js` error/retry channel exists in
the package but the App Router never reaches it (`shared/lib/dynamic.js` is the pages entry). Two
consequences, both load-bearing:

- A rejected loader **does** surface as a render-time throw, because React `lazy` rethrows its
  cached rejection (`payload._status === 2` ⇒ `throw payload._result`; vendored React 19.2.5,
  `next/dist/compiled/react/cjs/react.development.js:462-533` — **corrected from v3's `:465-530`,
  which stopped three lines short of the actual throw**; verified this session that
  `function lazyInitializer(payload) {` opens at `:462`, the rejection callback sets
  `payload._status = 2; payload._result = error` at `:496-497`, and `throw payload._result;` is
  `:533`) and `Suspense` does not catch errors. So `ActivitySceneErrorBoundary` DOES receive the
  failure.
- That rejection is **cached forever**. `dynamic()` is called at MODULE scope today
  (`page.tsx:45-93`), so one `React.lazy` payload exists per module for the SPA's lifetime and any
  remount re-throws instantly. This is already frozen doctrine one phase up — **P3 v4 §8.13**:
  "`resetKey` clears `failed` but does not re-run a failed lazy CHUNK import… the chunk panel keeps
  its Reload action."

1. Both scene components are built **per attempt, inside the room-keyed `ActivityRoomRuntime`**:

   ```ts
   const SceneComponent = useMemo(
     () =>
       dynamic(
         () =>
           import(/* the activityId-selected module */).catch((err) => {
             console.error('[activity] scene chunk failed', err);
             throw err;
           }),
         { ssr: false, loading: SceneLoadingFallback },
       ),
     [activityId, sceneAttempt],
   );
   ```

   A new `sceneAttempt` mints a new `Loadable`, hence a new `React.lazy` payload, hence a fresh
   `import()` call. On the happy path this costs nothing: the module registry already holds the
   loaded module, so a re-`import()` of an already-resolved chunk resolves from cache with no
   network request. Because the `useMemo` lives inside the `${activityId}:${roomId}` key, a room
   change also mints a fresh instance — which is what makes §5c's "keying resets the dynamic
   loading/error state" row TRUE rather than aspirational (R2-m1(e)).
2. The boundary's failure panel is a **terminal branch** (`'scene-chunk-error'`) tagged with its
   `roomKey`, so `decideActivityReadiness` rule 4 ACKs (destination permitting) and the fade lifts
   onto a visible, honest panel instead of hanging behind the cover until the 45 s card.
3. **The panel's actions, in the order they are presented.**
   - **Reload** (PRIMARY): `location.reload()`. This is the guaranteed recovery and it matches P3
     v4's frozen chunk-panel contract.
   - **Try again** (secondary, best-effort): bumps `sceneAttempt` (fresh dynamic instance, `failed`
     cleared via `resetKey`) and `attemptNonce` (revoking any readiness ack, §2b), and clears
     `terminalBranch`/`paintedRoomKey`.
   Whether a fresh `import()` re-issues a NETWORK request for a chunk whose previous fetch failed is
   a property of the bundler's chunk-loading runtime, **not** of React — `next.config.mjs:74`
   configures `turbopack` and **I did not verify its failed-chunk retry semantics**. That is exactly
   why Reload is primary and "Try again" is labelled as the cheap first attempt. §8.12 states this
   as a residual.
4. **Readiness after a retry — the v2 test was unpassable (R2-B2b).** v2 promised
   "after retry, readiness returns `WAIT:'not-painted'`". With `ackedKey` uncleared and no new
   generation, §5h rule 2 returns `'already-acked'`; if the terminal ack already completed the
   transition, rule 1 returns `'no-pending-request'`. Both are corrected: the ack key now carries
   `attemptNonce`, so a Try-again genuinely revokes the acknowledgement, and the truthful assertions
   are (a) with no pending request ⇒ `WAIT:'no-pending-request'` while the dynamic `loading`
   fallback covers the gap, and (b) with a pending generation ⇒ `WAIT:'not-painted'` until the fresh
   Canvas paints. §6.2 carries both.
5. **Activity-canvas context loss.** The `ActivityRoomRuntime` attaches its `webglcontextlost`
   listener to the element published by `ActivityCanvasReadyProbe`'s `onCanvas` (§2c, R2-B2c) —
   never to a DOM query on the wrapper, which can run while the dynamic fallback is still mounted
   and never re-run once the Canvas appears. On loss it `preventDefault()`s, clears
   `paintedRoomKey`, and renders the `'canvas-lost'` terminal branch (room-scoped) with the same
   Reload / Try-again pair. This is a distinct recovery domain from the stage's: stage listeners are
   attached to the exact stage canvas (`WorldStageCanvas.tsx:797-800`, `tracked(stageCanvas,
   'webglcontextlost', …)`), so neither canvas's loss reaches the other's handler. §6.11 drills both
   directions.

### 2j. Presence

```ts
export const AT_ACTIVITY = 'at-activity' as const;                      // packages/shared
// UNCHANGED from P3 v4 — the policy union is NOT widened (M1):
export function useWorldStream(
  policy: WorldPresencePolicy,          // 'active' | 'remote'
  remoteActivity?: string,              // P3 v4
  downlinkEnabled?: boolean,            // P4c, default true
): void;
```

### 2k. Downlink suspension — M1, ADOPTED DIFFERENTLY

```ts
// world-downlink-policy.ts — pure.
export type WorldDownlinkAction = 'OPEN' | 'CLOSE' | 'NONE';
export interface WorldDownlinkInput {
  /** Caller wants the SSE downlink open. */
  readonly wanted: boolean;
  /** An EventSource is currently held (`es !== null`). */
  readonly open: boolean;
  /**
   * NEW in v4 (R3-B2), REDEFINED in v5 (R4-B4). A reopen is owed: `activeRetryToken !== null`.
   *
   * Live `onerror` closes and NULLS `es` (`use-world-stream.ts:476-477`) BEFORE arming the retry
   * timer (`:510`), so between those two points `open` is false while a reopen is pending. Without
   * this field the wanted→disabled tick sees `{wanted:false, open:false}` ⇒ `NONE`, `closeStream()`
   * never runs, nothing is invalidated, and the queued callback reopens SSE mid-match.
   *
   * v4 defined it as `retryTimeout !== null`, which is TRUE only while the timer is ARMED. Once the
   * timer fires, `retryTimeout` is null while `recoverWithTicket()` is still awaiting — a window in
   * which a tick could race the in-flight rejoin. `activeRetryToken !== null` spans BOTH the armed
   * window and the async continuation with one marker (R4-B4).
   */
  readonly pendingReopen: boolean;
  /**
   * NEW in v6 (R5-B2). A ticketed `/join` recovery is executing: the closure flag `recoveryInFlight`,
   * which the anchor already computes and already passes into `runMachineTick`
   * (`use-world-stream.ts:400-411`). **In v12 its sole writer is `settleRecovery`'s lease CAS
   * (§2k-A)** — the anchor's `rejoinWithTicket` try/finally is ANCHOR behavior, replaced by this
   * diff (R11-6).
   *
   * Consumed by RULE 2 ONLY, deliberately. Folding it into `pendingReopen` — or into rule 1 —
   * would make rule 1 match on every tick of a suspended window that has a recovery in flight,
   * because `closeStream()` cannot clear a flag it does not own, so `CLOSE` would be re-emitted
   * five times a second for the life of the `/join`.
   */
  readonly recoveryInFlight: boolean;
  /** A world session exists (`sessionIdRef.current !== null`). */
  readonly hasSession: boolean;
  /** A room id is known (`roomIdRef.current !== null`). */
  readonly hasRoom: boolean;
}
export function decideWorldDownlink(i: WorldDownlinkInput): WorldDownlinkAction;
```

Rules (§5e carries the full table with every question answered), **first match wins**:

| # | Condition | Action |
|---|---|---|
| 1 | `!wanted && (open \|\| pendingReopen)` | `CLOSE` |
| 2 | `wanted && !open && !pendingReopen && !recoveryInFlight && hasSession && hasRoom` | `OPEN` |
| 3 | otherwise | `NONE` |

**Rule 1's `pendingReopen` disjunct is the v3→v4 delta and it is load-bearing.** v3 read
`!wanted && open`. Firing the CLOSE edge **with `es === null`** is the actual repair: `closeStream()`
is what invalidates the retry lineage, and that invalidation is what makes the queued callback inert.
Idempotence survives because `closeStream() → invalidateStream()` clears **the source, the retry
timer, AND `activeRetryToken`** — so the next tick reads `{open:false, pendingReopen:false}` ⇒
`NONE`. *(R5-m5: v4/v5 phrased this as "clears `es` and `retryTimeout`", which was the v4 marker; in
v5+ `pendingReopen` is `activeRetryToken !== null`, so the token is the field that has to be cleared
for idempotence to hold.)*

**Rule 2's `!recoveryInFlight` conjunct is the v5→v6 delta (R5-B2).** Without it, a ticketed `/join`
recovery that is still awaiting has no way to stop the tick edge from opening a source underneath
it. The reachable sequence: a recovery starts and awaits `/join`; the downlink is disabled; rule 1
emits `CLOSE`, whose `invalidateStream()` clears the retry token **while the recovery intentionally
continues** (it is not cancellable); the downlink re-enables before `/join` resolves; rule 2 now sees
`{wanted:true, open:false, pendingReopen:false}` with valid old session/room refs and **opens the OLD
room**. If the recovery then succeeds it replaces that source; if it fails, the premature source
survives as the live stream. The flag is read from the anchor's existing closure variable, which is
already threaded into `runMachineTick` (`:400-411`) — no new state.

**Rule 2's `!pendingReopen` conjunct is the v4→v5 delta and it protects the existing backoff
(R4-B4).** After an ordinary ENABLED error the input is `{wanted:true, open:false,
pendingReopen:true}`. Rule 1 does not match (the stream is wanted). Under v4, rule 2 DID match — so
the next 200 ms tick would call `OPEN`, skipping `RETRY_DELAY_BASE = 3000` (`use-world-stream.ts:23`)
and the `RETRY_DELAY_BASE * 2^(retries-1)` escalation capped at `RETRY_DELAY_MAX` (`:483-489`), while
the armed retry stayed armed. At five ticks per second against `MAX_RETRIES = 20` (`:22`) that burns
the whole retry budget in about four seconds and then gives up permanently. **The tick edge must
never pre-empt a reopen that the retry lineage already owns.**

*Timing note, offered as context and NOT as the correctness argument:* `RETRY_DELAY_BASE = 3000`
against the 200 ms machine tick means a disabled tick precedes the earliest retry by roughly fifteen
ticks. **The guarantee is not that schedule** — it is `pendingReopen` on both rules, plus the retry
token, plus `downlinkEnabledRef`, plus source ownership below, each of which holds under any
interleaving.

Applied inside `runMachineTick` (`use-world-stream.ts:400-411`), which already runs on the existing
200 ms interval — so **no new timer and no growth of the main effect's dependency array
(`:583-592`)**. `WorldStreamMachineState`, `WorldStreamMachineAction`, `WorldPresencePolicy`, and
`decide()` are **untouched**.

**`decideWorldDownlink` governs only the tick edge; the epoch governs everything else (R2-M1).**
Three other live paths call `openStream` directly — `bootstrap()` (`:554`), `rejoinWithTicket()`
(`:294`), and the `onerror` retry timer (`:520`, `:527`) — so an edge-only design leaves the stream
reopenable while suspended. Frozen additions, all inside the existing effect closure:

**v4's version of this block was internally inconsistent and is REPLACED (R4-B3).** v4 declared one
primitive, `invalidateStream()`, required every source drop to route through it, and had it bump
`streamEpoch`; it simultaneously required the retry callback to check its captured epoch. Those rules
cannot all hold: `onerror` must drop the source **and** schedule the reopen, so routing it through
`invalidateStream()` makes its own continuation stale before it is even armed. Every ordinary enabled
error would return early and **normal SSE recovery would be permanently dead** — and the
disabled-resurrection test would still pass, because a design in which no retry ever runs trivially
satisfies "no retry runs while disabled". v5 separates the two ideas that v4 conflated: a source
**dying** is not the stream being **invalidated**.

```ts
let streamEpoch = 0;                       // closure-scoped, beside `es` and `retryTimeout`
let retryTokenSeq = 0;
let activeRetryToken: number | null = null;   // non-null ⇔ a reopen is OWED (armed or in flight)
const downlinkEnabledRef = useRef(true);      // written like policyRef (:70-72)

/**
 * The source DIED and a retry legitimately owns the reopen. Error path ONLY.
 * Does NOT touch streamEpoch and does NOT clear the retry lineage — that is the whole point.
 * Handler inertness for the dead source is provided by the `es !== source` ownership guard,
 * which does not need the epoch.
 */
function dropFailedSource(source: EventSource): void {
  if (es !== source) return;               // a newer source already owns the slot
  source.close();
  es = null;
}

/**
 * The stream is INVALIDATED: closed, replaced, superseded, or torn down. Every such site routes
 * through this — CLOSE (`closeStream`), `rejoinWithTicket`'s replacement (`:285-292`),
 * `handleSuperseded` (`:186-190`), and effect teardown (`:572-573`). Nulling the retry token is
 * what makes those paths kill an armed OR in-flight retry continuation.
 */
function invalidateStream(): void {
  streamEpoch += 1;
  activeRetryToken = null;
  es?.close();
  es = null;
  if (retryTimeout) { clearTimeout(retryTimeout); retryTimeout = null; }
}

/** The CLOSE action. Adds the store/flag reset on top of invalidation. */
function closeStream(): void {
  invalidateStream();
  retriesRef.current = 0;
  lastAttemptWasBareReopen = false;
  setNpcConnected(false);
  clearPlayers();
}

/**
 * Arms the backoff retry. The token is the continuation's proof that it is still wanted.
 * `deferredSince` is the wall clock at which this lineage FIRST began waiting on a recovery;
 * it bounds busy-waiting (INVARIANT R, below).
 */
function armRetry(
  roomId: string,
  delayMs: number,
  shouldEscalate: boolean,
  deferredSince: number | null = null,
): void {
  const token = ++retryTokenSeq;
  activeRetryToken = token;
  retryTimeout = setTimeout(() => {
    retryTimeout = null;                   // the token, not the timer, is the live marker now
    if (cancelled || activeRetryToken !== token || !downlinkEnabledRef.current) return;

    // ── INVARIANT R, enforced ONCE for every timer-driven open ────────────────────────────
    // This check is deliberately ABOVE the escalate/bare branch. v6 put the equivalent check
    // only in the post-await continuation, so the `!shouldEscalate` branch bare-opened
    // underneath a live recovery (R6-B3). There is no bound on how long `/join` may take —
    // the anchor fetch has no AbortController and no deadline (`:140-146`) — so "wait one
    // backoff delay and assume it finished" is a guess, not a bound.
    if (recoveryInFlight) {
      const since = deferredSince ?? Date.now();
      if (Date.now() - since >= RECOVERY_WAIT_CEILING_MS) {
        // Bounded: stop deferring and RETIRE this lineage. Ownership transfers to the rule-2
        // tick edge, which is itself `!recoveryInFlight`-guarded, so it opens only once the
        // recovery actually settles. Exactly one owner at every instant.
        activeRetryToken = null;
        return;
      }
      armRetry(roomId, delayMs, shouldEscalate, since);   // re-arm, preserving the escalation intent
      return;
    }

    if (!shouldEscalate) { lastAttemptWasBareReopen = true; openStream(roomId); return; }
    lastAttemptWasBareReopen = false;
    void recoverWithTicket().then((rejoinedRoomId) => {
      // An await is a suspension point: re-check EVERYTHING that could have changed across it.
      if (cancelled || rejoinedRoomId !== null) return;   // success already reopened, or we are gone
      // `null` is AMBIGUOUS at the anchor — busy and failed are indistinguishable (see below).
      if (recoveryInFlight) { armRetry(roomId, delayMs, shouldEscalate, deferredSince ?? Date.now()); return; }
      if (activeRetryToken !== token || !downlinkEnabledRef.current) return;
      lastAttemptWasBareReopen = true;
      openStream(roomId);
    });
  }, delayMs);
}

function openStream(roomId: string): void {
  if (cancelled || retriesRef.current >= MAX_RETRIES) return;
  activeRetryToken = null;                 // the owed reopen has been performed
  streamEpoch += 1;                        // rotate on EVERY source construction
  const epoch = streamEpoch;
  const source = new EventSource(url, { withCredentials: true });
  es = source;
  /**
   * The SAME three-part guard opens every LISTENER — `open`, `snapshot`, `land`, and `onerror`:
   *
   *   if (epoch !== streamEpoch) return;              // superseded generation
   *   if (!downlinkEnabledRef.current) return;        // suspended mid-flight
   *   if (es !== source) return;                      // not the live source (ownership)
   *
   * `onerror` then calls `dropFailedSource(source)` and `armRetry(...)` rather than
   * `invalidateStream()`. The retry CONTINUATION deliberately does NOT check the epoch. After
   * `dropFailedSource` the epoch is UNCHANGED, and it may later rotate if some other path opens or
   * invalidates a source — so it is neither reliably current nor reliably stale, and is simply not
   * this path's ownership proof. `activeRetryToken` is (R5-m4).
   */
}
```

### 2k-A. THE REOPEN SINGLE-OWNER INVARIANT — R6-B3

> **INVARIANT R.** At any instant at most ONE actor may open an `EventSource`, and while
> `recoveryInFlight` is true that actor is the recovery itself. Every other path must defer
> (bounded) or retire.

v6 checked `recoveryInFlight` in one place — the post-`await` continuation — which is not the same
as enforcing an invariant. **Every open site is enumerated below with the reason it obeys.** A site
that is safe for a structural reason rather than an explicit check has that reason written down, so
a reviewer can verify it instead of re-deriving it (SELF-H).

| # | Open site | Anchor | How it obeys INVARIANT R |
|---|---|---|---|
| 1 | **rule-2 tick edge** (`decideWorldDownlink` ⇒ `OPEN`) | `runMachineTick` (`:400-411`) | **Explicit:** rule 2 requires `!recoveryInFlight` (§2k rules table). This is also the site that RECEIVES ownership when a retry lineage retires at the ceiling. |
| 2 | **retry timer, bare-reopen branch** (`!shouldEscalate`) | `:527` | **Explicit, and this is the R6-B3 repair:** the `recoveryInFlight` check sits at the TOP of the timer body, above the branch, so the bare reopen is unreachable while busy. v6 checked below this point and left the branch open. |
| 3 | **retry timer, escalation branch** | `:519-524` | **Unreachable while busy** — the same top-of-body check short-circuits before `recoverWithTicket()` is ever called. Belt-and-braces, the post-`await` continuation re-checks, because the downlink or the recovery state can change across the await. |
| 4 | **recovery completion** (`rejoinWithTicket` success ⇒ `openStream`) | `:294` | **This IS the sanctioned owner.** It is guarded by `downlinkEnabledRef` (so a suspension still suppresses it) but deliberately NOT by `recoveryInFlight` — the open happens INSIDE `settleRecovery`, which is the sole owner and the sole writer of that flag (R10-M3: v10's prose here still credited a `rejoinWithTicket` try/finally), so guarding it would deadlock the only actor allowed to open. |
| 5 | **`bootstrap()`** | `:554` | **Structurally unreachable during a recovery, and this is proven, not assumed (SELF-H).** `bootstrap()` runs only from the machine's `BOOTSTRAP` action, whose branch requires `!input.hasSession` (`world-stream-machine.ts:90-100`). A ticketed recovery only ever runs for an EXISTING session, and `rejoinWithTicket` never clears `sessionIdRef` — it assigns the new id on success (`:274`) and leaves the old value untouched on failure — so `hasSession` is true for the whole recovery and `BOOTSTRAP` cannot be emitted. It keeps its existing `downlinkEnabledRef` guard for the suspension case. |

**Bounded busy-wait.** `RECOVERY_WAIT_CEILING_MS = 30_000`. The bound is wall-clock rather than a
retry count, and it does NOT consume `retriesRef`/`MAX_RETRIES` — waiting for another actor is not a
failed attempt. At the ceiling the lineage clears `activeRetryToken` and returns, which makes
`pendingReopen` false and hands ownership to rule 2.

#### The recovery itself must terminate — R7-4

**v7 bounded the WAIT but not the thing being waited on, and that made the ownership transfer
nominal.** Verified again at the anchor: `join()` is a bare `await fetch(...)` with no `AbortController`, no
`signal`, and no deadline (`use-world-stream.ts:140-146`) — **that is the ANCHOR state; v9 adds the
independent deadline race below**, so present-tense claims that `/join` is unbounded describe the
code before this diff, not after it. So if `/join` never
settles: the lineage retires after 30 s, `pendingReopen` goes false, **`recoveryInFlight` stays true
forever**, rule 2 is gated on `!recoveryInFlight` and returns `NONE` forever, recovery completion
never runs, and no `EventSource` ever reopens. No double-open — and no open at all. A permanent dead
retry is not an ownership model.

v8 bounds the recovery in code, with two mechanisms doing two different jobs:

**v8's version of this did not actually terminate, and R8-B4 is right about why.** v8 set the lease
before `await join(true)` and cleared it in that call's `finally` — so if the fetch or its body
parsing ignored or outlived the abort (the precise late-completion case the lease existed for), the
await stayed pending, the `finally` never ran, the lease never expired, `recoveryInFlight` never
cleared, and the permanent dead retry was back. The abort was doing the terminating and the lease was
doing nothing independent. v8 also cleared `recoveryInFlight` **outside** the lease guard, so an
expired lease 1's late `finally` could clear lease 2's ownership and permit an open underneath it.

v9 makes termination independent of the fetch honoring anything, and routes every settlement through
one guarded helper:

```ts
const JOIN_TIMEOUT_MS = 15_000;          // MUST be < RECOVERY_WAIT_CEILING_MS — see the ordering rule
let recoveryLeaseSeq = 0;
let activeRecoveryLease: number | null = null;

type JoinOutcome =
  | { kind: 'joined'; data: JoinResponse }
  | { kind: 'superseded' }
  | { kind: 'failed' }
  | { kind: 'timeout' };

async function rejoinWithTicket(): Promise<string | null> {
  if (cancelled || recoveryInFlight) return null;
  recoveryInFlight = true;
  const lease = ++recoveryLeaseSeq;
  activeRecoveryLease = lease;

  // v10 (R9-B4). BOTH producers call the CAS. v9 used `Promise.race` and only the WINNER reached
  // `settleRecovery` — the loser's late resolution was abandoned, not refused, so the promised
  // "a late completion returns here and is refused" was not what the code did.
  let resolveDone: (v: string | null) => void;
  const done = new Promise<string | null>((r) => { resolveDone = r; });

  const controller = new AbortController();
  // The deadline is an INDEPENDENT timer, not a signal the fetch may honor. It settles even if the
  // fetch and its body never settle at all.
  const deadlineTimer = setTimeout(() => {
    controller.abort();                                  // abort is CLEANUP, not the guarantee
    resolveDone(settleRecovery(lease, { kind: 'timeout' }));
  }, JOIN_TIMEOUT_MS);

  // joinWithBody() = the ENTIRE anchor `join()` body incl. `await res.json()`, wrapped to return a
  // JoinOutcome instead of throwing. Wrapping the whole operation is the point: covering only the
  // fetch would leave a hung body parse unbounded.
  void joinWithBody(true, controller.signal).then(
    (outcome) => { clearTimeout(deadlineTimer); resolveDone(settleRecovery(lease, outcome)); },
    ()        => { clearTimeout(deadlineTimer); resolveDone(settleRecovery(lease, { kind: 'failed' })); },
  );

  // v11 (R10-m1) — precisely which arm reaches the CAS second:
  //   DEADLINE-FIRST: the join arm still resolves later, calls settleRecovery, and is REFUSED by
  //     the guard; its `resolveDone` is a no-op on an already-resolved promise. The refusal is real.
  //   OPERATION-FIRST: the join arm clears `deadlineTimer`, so the deadline arm never fires and
  //     there is no second call at all.
  // v10 said "whichever arm is SECOND always reaches the CAS", which contradicted its own timer
  // cancellation. Only the deadline-first ordering has a second arm.
  return done;
}

/**
 * v10 (R9-B4). The anchor's `recoverWithTicket` dispatched RECOVERY_OK/FAILED off the returned room
 * id (`use-world-stream.ts:354-362`) while v9 ALSO dispatched inside `settleRecovery` — every
 * settlement cell double-dispatched. All dispatch is removed from here; `settleRecovery` is the
 * single dispatch site. The busy early-return still dispatches nothing, which is correct.
 */
async function recoverWithTicket(): Promise<string | null> {
  if (cancelled || recoveryInFlight) return null;
  return rejoinWithTicket();
}

/**
 * (3) The ONLY place recovery state changes. Nothing outside this function clears the lease, clears
 * `recoveryInFlight`, dispatches a machine transition, writes membership refs, or opens a source.
 * A late completion belonging to an expired lease returns here and is inert BY CONSTRUCTION.
 */
function settleRecovery(lease: number, outcome: JoinOutcome): string | null {
  // ← THE single gate, and the single dispatch site. A refused call returns before every effect
  //   below it — including `openStream`, which is why "what happens to the source a late success
  //   opened" has the answer: it never opens one. Opening lives INSIDE the guard by design.
  if (activeRecoveryLease !== lease) return null;
  activeRecoveryLease = null;
  recoveryInFlight = false;                          // INSIDE the guard (v8 had it outside)
  if (cancelled) return null;
  if (outcome.kind === 'superseded') { handleSuperseded(); return null; }
  if (outcome.kind !== 'joined') {
    transitionMachine({ type: 'RECOVERY_FAILED', now: Date.now() });   // exactly once
    return null;
  }
  sessionIdRef.current = outcome.data.id;
  roomIdRef.current = outcome.data.roomId;
  roomTicketRef.current = outcome.data.roomTicket ?? roomTicketRef.current;
  setLocalSessionId(outcome.data.id);
  setRoomId(outcome.data.roomId);
  invalidateStream();
  retriesRef.current = 0;
  if (downlinkEnabledRef.current) openStream(outcome.data.roomId);
  transitionMachine({ type: 'RECOVERY_OK', now: Date.now() });
  return outcome.data.roomId;
}
```

| Mechanism | Job | Why the others do not cover it |
|---|---|---|
| **Independent `deadline` promise raced against fetch+body** | guarantees the recovery SETTLES, whatever the network does | v8 relied on `AbortController`; a fetch or body parse that ignores or outlives the signal leaves the await pending forever (R8-B4) |
| **`settleRecovery` lease CAS** | makes every late completion inert and gives `recoveryInFlight` exactly one writer | v8 cleared the flag in a `finally` outside the guard, so an expired lease could clear a live lease's ownership |
| **`AbortController`** | cleanup — releases the socket after the deadline wins | demoted from "the termination guarantee", which is what it was doing in v8 while the lease got the credit |

**Ordering is an invariant, not a coincidence:** `JOIN_TIMEOUT_MS (15 s) < RECOVERY_WAIT_CEILING_MS
(30 s)`. The recovery always resolves — success, failure, or abort — before the retry lineage
retires, so **the ceiling is a backstop that should never fire in practice**. §6.2 pins the ordering
directly, so a future tuning edit that inverts it fails a test rather than silently restoring the
dead-retry state.

**At-most-once failure (R10-M3).** On a deadline win, the timeout outcome reaches **`settleRecovery`**, which dispatches `RECOVERY_FAILED` **once** — `recoverWithTicket()` no longer dispatches at all (v10 removed it; v10's prose here still said otherwise). A cancelled settlement dispatches **zero** times by design, which is why the assertion is *at most one*, not *exactly one*. The busy early-return still dispatches nothing, which is correct: busy is
not a failure.

#### Bootstrap is bounded too — the algorithm, not just the claim (R10-B2)

v10 asserted that bootstrap was bounded because it shares `join()`, but the deadline machinery lived
**inside `rejoinWithTicket()`** and never touched bootstrap's call path. At the anchor `bootstrap()`
awaits plain `join()` (`:533-554`) and expects its RAW result, not the `JoinOutcome` the recovery
wrapper produces. **Frozen: option (b) — a generic timed wrapper, so the invariant holds on both
paths rather than only the reported one.**

```ts
/**
 * BOOTSTRAP-ONLY (R11-4). Recovery deliberately does NOT use this: it needs SEPARATE deadline and
 * operation producers so BOTH arms reach `settleRecovery` and the late arm is explicitly refused
 * (§2k-A). The two paths share `JOIN_TIMEOUT_MS` and the bounded-termination POLICY — never the
 * settlement primitive. Collapsing recovery onto this helper would destroy the CAS refusal.
 */
async function withDeadline<T>(op: Promise<T>, ms: number):
    Promise<{ settled: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<{ timedOut: true }>((r) => {
    timer = setTimeout(() => r({ timedOut: true }), ms);
  });
  try { return await Promise.race([op.then((settled) => ({ settled })), deadline]); }
  finally { clearTimeout(timer!); }
}

/**
 * v12 (R11-3): anchor-compatible. The anchor is `async function join(recovery = false)` returning
 * `JoinResponse | { superseded: true } | null`, deriving the requested room INTERNALLY from
 * `?room` (`use-world-stream.ts:121-127`), with a fetch that takes no signal (`:141-146`).
 * So: widen `join` to `(recovery = false, signal?: AbortSignal)`, thread `signal` into the fetch,
 * and make this wrapper PARAMETERLESS. `bootstrap()` calls `joinBounded()` instead of `join()`.
 */
async function joinBounded(): Promise<JoinResponse | { superseded: true } | null> {
  const controller = new AbortController();
  const outcome = await withDeadline(join(false, controller.signal), JOIN_TIMEOUT_MS);
  if ('timedOut' in outcome) { controller.abort(); return null; }
  return outcome.settled;
}
```

Three properties, each deliberate:

1. **The RAW shape is preserved.** `join()` already converts fetch/JSON rejection to `null`
   (`:158-166`), so `bootstrap()` handles `null` today and needs no change beyond calling
   `joinBounded`. The `JoinOutcome` mapping stays private to recovery.
2. **No generation guard is needed, and v11's was actively wrong (R11-3).** Returning `null` on a
   generation mismatch would make outer `bootstrap()` dispatch `BOOTSTRAP_FAILED` — that is not
   inert. The machine is **already single-flight**: `BOOTSTRAP` requires `!bootstrapInFlight` and
   `bootstrapAttempts < MAX_BOOTSTRAP_ATTEMPTS` (`world-stream-machine.ts:99-108`), so a second
   attempt cannot start until the first resolves the flag. A raw result arriving after its deadline
   simply loses the completed race and is dropped. **The mechanism is REMOVED**; §6.2 proves the
   property instead by releasing attempt 1 after attempt 2 has succeeded.
3. **`recoverWithTicket`'s lease CAS is untouched and MUST stay separate (R11-4)** — `settleRecovery`
   remains the single dispatch site and the single writer of `recoveryInFlight`, and recovery keeps
   its own two-producer race so a late arm can be refused rather than dropped.

**Declared scope.** This bounds a path P4 does not otherwise touch: a very slow but eventually
successful bootstrap `/join` now fails at 15 s and retries through the machine's existing bootstrap
backoff (`world-stream-machine.ts:99-108`, `bootstrapRetryAt`/`MAX_BOOTSTRAP_ATTEMPTS`) instead of
hanging forever. That is a strict improvement, stated rather than buried, and it lands in the
independently-revertable **P4c**.

**Why the ceiling is still not just a longer guess.** It hands off to a rule gated on the same flag,
and that flag is now guaranteed to clear. Worst case is a delayed reopen; never a concurrent one, and
— after R7-4 — never a permanent absence of one.

**`null` from `recoverWithTicket()` is ambiguous at the anchor, and that ambiguity is the second half
of R5-B2.** Read this session:

```ts
// use-world-stream.ts:354-363, verbatim at a156e3c0
async function recoverWithTicket(): Promise<string | null> {
  if (cancelled || recoveryInFlight) return null;     // ← BUSY, and the machine is never told
  const roomId = await rejoinWithTicket();
  if (cancelled) return null;
  transitionMachine({ type: roomId ? 'RECOVERY_OK' : 'RECOVERY_FAILED', now: Date.now() });
  return roomId;
}
```

`rejoinWithTicket` carries the same `if (cancelled || recoveryInFlight) return null;` guard
(`:267-268`). So a busy recovery returns a bare `null` **without dispatching `RECOVERY_FAILED` at
all** — indistinguishable from a genuine rejoin failure at the call site. v5's continuation treated
that `null` as failure and bare-opened the old room while a real `/join` was in flight. Re-checking
`recoveryInFlight` after the await is what separates the two cases, and it needs no change to either
anchor function.

**SELF-G — why the continuation RE-ARMS instead of returning.** The intuitive repair,
`if (recoveryInFlight) return;`, leaks: it exits without clearing `activeRetryToken`, so
`pendingReopen` stays true and rule 2 stays suppressed. If the real recovery then FAILS,
`rejoinWithTicket` returns `null` without invalidating anything, nothing ever clears the token, and
**the downlink never reopens** — a race converted into a permanent outage. Re-arming mints a fresh
token that replaces the leaked one and re-queues behind the recovery. If that recovery succeeds, its
`openStream` nulls the token and the re-armed timer's own token check makes it inert; if it fails,
the re-armed timer runs normally, bounded by the existing `retriesRef` / `MAX_RETRIES` ceiling.
*(The critique's alternative — share or await the existing recovery promise — is also sound, but it
means exposing a promise handle the anchor does not currently keep, and the re-arm reuses machinery
this spec already specifies and tests.)*

**The guard each path uses, and why they differ.**

| Path | Liveness proof | Why not the others |
|---|---|---|
| `open` / `snapshot` / `land` / `onerror` listeners | epoch **+** `downlinkEnabledRef` **+** `es === source` | These belong to a specific live source; all three are cheap and fail independently. |
| retry continuation (timer body and post-`await` body) | `activeRetryToken` **+** `downlinkEnabledRef` **+** `!cancelled` **+** `recoveryInFlight` (busy ⇒ re-arm) | **It must NOT check the epoch.** `dropFailedSource` leaves `streamEpoch` untouched, so the captured epoch is still current at that instant and may rotate later for unrelated reasons — it carries no information about whether THIS reopen is still wanted. Treating it as an ownership proof either way is exactly the R4-B3 confusion (R5-m4). |
| tick edge (`decideWorldDownlink`) | `pendingReopen` = `activeRetryToken !== null` | Prevents the edge from pre-empting a reopen the retry lineage already owns (R4-B4). |

**Why the three listener guards, when any one looks sufficient.** They fail independently:
`downlinkEnabledRef` alone loses to a handler that captured a stale source but runs while the
downlink is legitimately re-enabled; the epoch alone loses to a callback that never reads
`downlinkEnabledRef` and reopens during a suspension that produced no epoch bump (the v3 hole);
source ownership alone loses to two sources sharing an epoch. Cheap, no shared failure mode.

**Token lifecycle, stated exhaustively because R4-B3 and R4-B4 both live in its gaps.**

| Event | `activeRetryToken` | `pendingReopen` |
|---|---|---|
| `armRetry` | `= ++retryTokenSeq` | true |
| timer fires, bare-reopen branch | nulled by `openStream` | false |
| timer fires, escalation branch, `recoverWithTicket()` **awaiting** | **unchanged (non-null)** | **true** — this is the window v4's `retryTimeout !== null` definition missed (R4-B4) |
| escalation succeeds (rejoin reopened) | nulled by `openStream` inside `rejoinWithTicket` | false |
| escalation fails, fallback reopen | nulled by `openStream` | false |
| escalation fails **while disabled** | stays non-null (continuation returns early) | true — and rule 1 then fires `CLOSE`, which nulls it. Self-healing, no leak. |
| `CLOSE` / rejoin replacement / `handleSuperseded` / teardown | nulled by `invalidateStream()` | false |

One consequence worth stating: `rejoinWithTicket()` failing during a suspension leaves the token set
until the next tick emits `CLOSE`. That is at most one 200 ms tick of a stale `pendingReopen`, during
which rule 2 is suppressed — the safe direction, since the alternative is opening SSE mid-match.

| Path | Frozen behavior |
|---|---|
| `CLOSE` (tick edge) | `closeStream()`. **Fires when `es` is null but a retry is armed** (rule 1's `pendingReopen`) — that is the R3-B2 repair. Idempotent: `closeStream() → invalidateStream()` clears the source, the retry timer, **AND `activeRetryToken`** — since `pendingReopen` is `activeRetryToken !== null`, the token is the field idempotence actually depends on (R6-m2; this was the last passage still carrying v4's marker). The next tick reads `{open:false, pendingReopen:false}` ⇒ `NONE`. |
| `OPEN` (tick edge) | `openStream(roomIdRef.current!)` **plus** `queryClient.invalidateQueries({ queryKey: LAND_PARCELS_QUERY_KEY })`. The `land` channel is SSE-only (`:470-471`), so anything that changed during the suspension must be refetched on reopen or in-world for-sale state stays stale until the next organic invalidation. |
| `bootstrap()` completion (`:533-554`) | Session/room/ticket refs and store writes happen exactly as today; **`openStream` at `:554` is skipped when `!downlinkEnabledRef.current`**. A bootstrap that lands mid-match therefore establishes membership (which the 10 s uplink needs) without opening SSE. |
| `rejoinWithTicket()` completion (`:285-294`) | Refs, `setLocalSessionId`, `setRoomId`, timer cancel and `retriesRef` reset all run. **Its inline `es?.close(); es = null;` + `clearTimeout` block at `:285-292` is REPLACED by `invalidateStream()`** — v3 left this source replacement unrotated, so a handler queued by the *previous* source shared the *new* source's epoch (R3-B2's second leg). Then `openStream` is called only when `downlinkEnabledRef.current` is true. This is the 409-recovery path, reachable mid-match from the 10 s remote heartbeat. |
| `handleSuperseded()` (`:176-199`) | **v4 addition, found while verifying R3-B2:** it too does an inline `es?.close(); es = null;` + `clearTimeout` (`:186-190`), so it is a third unrotated drop. It routes through `invalidateStream()` as well. v3's claim that `closeStream()` was "the only closer" was false — three other sites close the source. |
| queued `onerror` (`:474-531`) | Returns immediately on any of the three LISTENER guards. When it does run, it calls **`dropFailedSource(source)` — not `invalidateStream()`** (R4-B3) — then `armRetry(...)`, preserving the existing `recoveryInFlight` early-return, the `retriesRef.current++`, the `MAX_RETRIES` check, and the two-step bare-reopen/escalate decision exactly as at the anchor. **v2's §5e answer was wrong**: clearing `retryTimeout` does not neutralize a handler that is already queued — it runs after the clear and SCHEDULES A NEW timer at `:510`, resurrecting the stream. |
| retry continuation (`:510-529`) | Guarded by `activeRetryToken` + `downlinkEnabledRef` + `!cancelled`, **and re-guarded after the `recoverWithTicket()` promise resolves** (`:517-524`), where the busy check and the fallback bare reopen live. **It deliberately does not check `streamEpoch`**, which `dropFailedSource` leaves unchanged and which therefore proves nothing about this reopen's ownership either way (R4-B3, wording corrected per R5-m4). |
| effect teardown (`:567-582`) | `cancelled = true` as today, plus `invalidateStream()` so neither a listener nor a retry continuation that survives teardown can act. |

**bfcache (R2-M1).** `pagehide` sends `/world/leave` including on bfcache entry (`:559-565`), but
there is no restore counterpart, so a restored page holds a dead `sessionIdRef` until a later 409 or
SSE failure discovers it. P4 adds a `pageshow` listener registered alongside `pagehide`: when
`event.persisted`, run `closeStream()`, null `sessionIdRef`/`roomIdRef`, `setLocalSessionId(null)`,
and `clearPlayers()`. That re-arms `decide()`'s `!hasSession && everActive` BOOTSTRAP branch
(`world-stream-machine.ts:99-109`) on the next 200 ms tick, so membership is rebuilt explicitly
rather than discovered by failure. A non-persisted `pageshow` is a no-op (the effect re-ran anyway).
Scope note: this is pre-existing behavior, but P4 is what first gives an ACTIVITY page a world
session, so it lands here rather than being logged and walked past.

### 2l. The shared held-key primitive — M4 (commit P4d)

```ts
// player-input.ts (P3-landed module; additive)
export interface HeldKeyListenerConfig {
  /** 'code' → event.code (activity + kelp); 'key' → event.key.toLowerCase() (world). */
  readonly keyIdentity: 'code' | 'key';
  /** 'isEditable' skips keydown when the target is an input/textarea/contentEditable. */
  readonly keyTargetGuard: 'isEditable' | 'none';
  /** Return true to preventDefault this keydown. */
  readonly onKeyDown: (identity: string, event: KeyboardEvent) => boolean;
  /** keyup is DELIBERATELY not target-guarded — preserves today's behavior in both consumers. */
  readonly onKeyUp: (identity: string, event: KeyboardEvent) => void;
  /** Registered through `registerInputReset` (blur / visibilitychange / focus / pageshow). */
  readonly onReset: () => void;
  /**
   * R2-m1(f). Attached with `addStageEventListener(window, type, listener, options)`
   * (`stage-store.ts:484-500`), whose `type` is a plain `string`, NOT
   * `addStageWindowListener` (`:471-482`), whose `K extends keyof WindowEventMap` rejects the
   * custom `'clawville:activity-action'` type the mobile controls dispatch
   * (`activity-mobile-controls.tsx:63`). No `WindowEventMap` augmentation is added — a global
   * interface merge to satisfy one call site is a worse trade than using the string-typed
   * helper that already exists. Both helpers increment `windowListenerCount` identically, so
   * §6.6's dual-measure assertion is unaffected.
   */
  readonly extra?: ReadonlyArray<{ type: string; listener: EventListener; options?: AddEventListenerOptions }>;
}
export function attachHeldKeyListeners(config: HeldKeyListenerConfig): () => void;
```

`attachPlayerKeyListeners(policy)` (P3) is re-implemented on top of it with byte-identical
behavior; `useActivityInput`'s attachment block (`:533-548`) consumes it with
`keyIdentity: 'code'`, `keyTargetGuard: 'isEditable'` (matching `:306-314`), and `extra` carrying
`pointerdown` + `clawville:activity-action`. **Everything downstream of the listeners is
unchanged**: the key→bit switch, `oneShotBitsRef`, `recomputeReefKeyboardDir`, the 30 Hz
`setInterval`, and `selfInputBus` publishing.

Side benefit: routing the activity's listeners through the stage helpers makes them visible to
`windowListenerCount`, which §6.6's leak gate currently has to work around with a raw
`getEventListeners(window)` delta.

### 2m. Destination identity for the activity slot — R2-B1

```ts
// stage-store.ts — additive, alongside `outgoingOverlay` (§2d)
interface StageStore {
  /* … */
  /**
   * `${activityId}:${roomId}` the live `activity` stage request is FOR. Keyed by SCENE, not by
   * `requestId`: a watchdog silent retry mints a NEW `requestId` and generation
   * (`stage-store.ts:172-231`) for the SAME destination, so a requestId-keyed target would be
   * lost exactly when readiness needs it most.
   */
  activityTarget: { roomKey: string } | null;
  setActivityTarget: (target: { roomKey: string }) => void;
  clearActivityTarget: () => void;   // called when a non-activity scene is activated
}
```

**Both request-minting paths write it — this is the part that must not be half-done.**
`WorldStageRoot` is the only file that mints an `activity` request, and it does so from two places:

| Path | Where | Destination source |
|---|---|---|
| Handler-owned navigation (Leave, Play Again, `navigateOut`, cold-init) | the installed handler at `WorldStageRoot.tsx:181-212` — all three branches (`EXECUTE_NOW`, `ADOPT`, and the `requestStageScene` fallthrough at `:206`) | `roomKeyFromPathname(stagePathnameFromHref(navigation.to))` |
| Pathname-first (browser back/forward, direct URL entry, cold deep link, and §2h's `if (!requested) router.push(to)` fallback) | the children-swap effect at `:105-134`, whose `requestStageScene(sceneId)` call at `:132` is the request | `roomKeyFromPathname(pathname)` |

`roomKeyFromPathname` is specified in §2a alongside the other pure pathname helpers.
`clearActivityTarget()` runs when a non-`activity` scene is activated and from `resetStage()`.

---

#### The pathname-first path does not mint a request at all today — R3-B1

v3 wrote the table above and claimed both paths were covered. **The second row was false**, and
this is the round-3 blocker. Read at the anchor, the children-swap effect is scene-level in *both*
of its decisions:

```ts
// WorldStageRoot.tsx:111-134, verbatim at a156e3c0
const destinationAlreadyOpaque =
  state.activeScene === sceneId &&
  (state.transition?.phase === 'awaiting' ||
    state.transition?.phase === 'fadingIn' ||
    state.transition?.phase === 'idle');

if (pathAlreadyDisplayed || destinationAlreadyOpaque) {
  displayedPathRef.current = pathname;
  pendingRouteChildrenRef.current = null;
  setDisplayedChildren(children);
} else {
  pendingRouteChildrenRef.current = { pathname, children };
}

if (
  state.pendingRequest?.sceneId !== sceneId &&
  !(state.pendingRequest === null && state.activeScene === sceneId)
) {
  requestStageScene(sceneId);
}
```

With activity A resident and nothing pending, a pathname change to activity B evaluates as:

- `sceneIdForPathname('/activity/x/B')` ⇒ `'activity'`, which **equals** `state.activeScene`.
- `completeTransition` leaves the store at `pendingRequest: null` and `transition.phase: 'idle'`
  (`stage-store.ts:347-372`) — it nulls the request but keeps the transition object — so
  `destinationAlreadyOpaque` is **unconditionally true at rest after any activity crossing**. B's
  children are swapped in immediately, behind no cover.
- The suppression clause: first conjunct `undefined !== 'activity'` ⇒ true; second
  `!(null === null && 'activity' === 'activity')` ⇒ **false**. No request is minted.

So there is no generation, `activityTarget` is never written, `decideActivityReadiness` is never
consulted, and the fade never runs. Readiness was not returning the wrong answer — **it was never
asked.**

**SELF-C — why the fix must change BOTH conditions together.** The two clauses fail in opposite
directions, and repairing one alone is worse than repairing neither. Had `transition` been null at
rest (it is not, but nothing in the store's contract promises it stays non-null), the same traversal
would take `destinationAlreadyOpaque === false` while suppression still fired: B's children park in
`pendingRouteChildrenRef` with **no request that can ever reach an opaque midpoint**, and
`handleTransitionOpaque` — the only consumer — never runs. That is a permanent wedge behind a cover,
not a skipped fade. §6.2 therefore asserts the request is **MINTED**, not merely that the swap was
deferred. *(v5 note: SELF-C's conclusion holds and is honored — the install rule and the suppression
rule are still changed together — but v4's particular pairing was itself wrong. R4-B1 below replaces
the install rule entirely; SELF-C's requirement that §6.2 assert MINTING rather than deferral is
unchanged and is now joined by the inverse assertion, that a handler-owned crossing installs rather
than parking.)*

**SELF-D — reachability, stated honestly rather than inherited.** The report frames this as browser
back/forward. Re-verification says the truth is narrower in one direction and broader in another,
and a frozen spec should say which.

- **NARROWER than reported.** I could not construct an A→B-adjacent history stack from shipped call
  sites: every Leave / Play-Again / status-panel path routes through `/game`
  (`page.tsx:148`, `:294`, `:304`, `:318`, `:328`, `:338`, `:348`, `:364`, `:406`), and
  `decideStageNavigationHistoryMethod` (`stage-navigation-ownership.ts:13-17`) returns `'push'` only
  for the first two stage navigations and `'replace'` thereafter, compressing the stack further.
- **BROADER than reported, and this is what keeps it a blocker.** The bypass is a property of the
  *pathname-change effect*, not of history. It fires on ANY activity→activity pathname change while
  nothing is pending — including §2h's `if (!requested) router.push(to)` legacy fallback, which runs
  whenever the stage handler is not yet installed, and the direct A→B crossing that §2d item 1 and
  §5i rule 2 already reason about explicitly. A frozen spec that claims structural coverage it does
  not have is a defect independent of today's reachability, and a future Play-Again that targets a
  room directly turns it into a live one.

#### Why v4's repair was WRONG, and what the real ordering is — R4-B1

**v4 replaced the scene-level opacity test with `… && destinationKey === displayedKey`, where
`displayedKey = stageDestinationKey(displayedPathRef.current)`, and argued that this was a tautology
for `/game`, `/cove`, and `/kelp`. That argument is invalid and the conjunct wedges every
handler-owned crossing in the app.** The anchor ordering, read verbatim this session:

```ts
// StageTransition.tsx:66-79 — the activate timer, verbatim at a156e3c0
const activateTimer = window.setTimeout(() => {
  const state = useStageStore.getState();
  if (state.stageEpoch !== requestEpoch ||
      state.pendingRequest?.requestId !== request.requestId) return;
  onOpaque?.(request);                                    // 1. WorldStageRoot commits router here
  state.activateScene(request);                           // 2. activeScene := request.sceneId
  state.setTransitionPhase(request.requestId, 'awaiting'); // 3. phase := 'awaiting'
}, fadeDurationMs);
```

`activateScene` is the sole writer of `activeScene` (`stage-store.ts:299-302`), and
`WorldStageRoot.tsx:248` issues `router.push`/`router.replace` from inside step 1. So a handler-owned
`/game` → `/cove` proceeds:

| When | `activeScene` | `displayedPathRef.current` | `pathname` (router) |
|---|---|---|---|
| request minted, `fadingOut` | `world` | `/game` | `/game` |
| step 1 — `onOpaque`, `router.push('/cove')` issued | `world` | `/game` | `/game` |
| step 2-3 — activate + `awaiting` | **`cove`** | `/game` | `/game` |
| App Router children commit (later) | `cove` | **`/game`** | **`/cove`** |

At the final row v4 evaluates `activeScene === 'cove'` ✓ but `destinationKey ('cove') ===
displayedKey ('world')` ✗. `destinationAlreadyOpaque` is false, the incoming children park, the
pending request suppresses another mint, and **the sole opaque callback has already fired** — so
nothing ever swaps them in. `/game`↔`/cove` and `/game`↔`/kelp` work today and would break.

**The three clocks.** `activeScene` advances at the midpoint, `displayedPathRef` advances at
children-install, and `pathname` advances at router commit. v4's tautology argument silently assumed
the first two were the same clock. See SELF-F in the round-4 ledger — the argument FORM is the
defect, and v5 does not use it anywhere except where both operands provably derive from one
expression (§2n).

#### The v5 repair — opaque lineage, not displayed-key equality

The question the effect actually needs to answer is **"have we already gone opaque FOR THIS
DESTINATION?"** — not "is this destination on screen?". v5 records that directly.

```ts
// WorldStageRoot.tsx — one new ref beside displayedPathRef (:72)
const openedMidpointRef = useRef<{ requestId: number; destinationKey: string } | null>(null);
```

Written at the TOP of `handleTransitionOpaque(request)`, before anything else in that callback, so
the record exists by the time the router commit it triggers lands:

```ts
openedMidpointRef.current = {
  requestId: request.requestId,
  destinationKey: pendingDestinationKeyRef.current ?? request.sceneId,
};
```

A silent watchdog retry re-arms the whole activate cycle (`retryStageScene` sets `fadingOut` and
mints a new `pendingRequest`, so `StageTransition`'s effect re-runs and `onOpaque` fires again), which
rewrites the record with the retry's `requestId` — so exact `requestId` equality below is sufficient
and no `retryOfRequestId` special case is needed.

The children-swap effect's install condition becomes:

```ts
const destinationKey  = stageDestinationKey(pathname);              // §2a
const pathAlreadyDisplayed = displayedPathRef.current === pathname; // existing, unchanged
const midpoint = openedMidpointRef.current;
const phase = state.transition?.phase;

const installNow =
  pathAlreadyDisplayed ||
  (midpoint !== null && midpoint.destinationKey === destinationKey && (
      // (a) behind the cover, for the destination this transition already went opaque for
      (state.pendingRequest?.requestId === midpoint.requestId &&
       (phase === 'awaiting' || phase === 'fadingIn')) ||
      // (b) a late router commit that lands after the fade already completed
      (state.pendingRequest === null && state.activeScene === sceneId)
  ));
```

| Clause | Covers | Why it cannot over-fire |
|---|---|---|
| `pathAlreadyDisplayed` | the destination genuinely already on screen; cold mount (`displayedPathRef` is initialised to `pathname` at `:72`) | exact pathname equality |
| (a) | **every handler-owned crossing** — the row that v4 broke. Children arrive during `awaiting`/`fadingIn` for the destination whose midpoint already fired | requires the midpoint's destination key AND the live request id AND a mid-transition phase |
| (b) | a slow router commit that lands after `completeTransition` (phase `idle`, `pendingRequest` null) — the case v3's `'idle'` phase value quietly covered and which a naive rewrite would wedge | requires the midpoint record to still name THIS destination, so activity A→B at rest fails it (the record names A) |

**Displayed-key equality is gone, and it reduces to something already present.** `stageDestinationKey`
is injective over stage pathnames — `/game`/`/cove`/`/kelp` map by exact equality and
`/activity/:a/:r` maps to `activity:a:r` — so for two stage pathnames `destinationKey === displayedKey`
holds **iff** `pathname === displayedPathRef.current`, which is exactly `pathAlreadyDisplayed`. v4's
conjunct was therefore not only mis-phased, it was redundant with a check the effect already had.

**Activity A→B at rest still parks, which is the R3-B1 fix, preserved.** With A resident, nothing
pending: `pathAlreadyDisplayed` false; the midpoint record names `activity:x:A` ≠ `activity:x:B`, so
neither (a) nor (b) fires. B parks, the suppression rule below mints, and B is installed at its own
midpoint through the existing parked-children path.

`openedMidpointRef` is cleared by `resetStage()`/root unmount and whenever a new request is minted,
so a stale record can never authorise the wrong children. (The destination-key comparison already
rejects it; clearing is belt-and-braces and costs one line.)

#### Pending equality is scene AND destination — R4-B2

The anchor's suppression clause is scene-blind in the same way:

```ts
state.pendingRequest?.sceneId !== sceneId &&
!(state.pendingRequest === null && state.activeScene === sceneId)
```

If activity B is pending and pathname C arrives, `'activity' !== 'activity'` is false ⇒ no C request.
C parks, `pendingDestinationKeyRef` still names B, B's midpoint rejects parked C, and B can never
paint because the router children are C. v5 replaces the clause with two explicitly-named predicates:

```ts
const pendingMatchesDestination =
  state.pendingRequest !== null &&
  state.pendingRequest.sceneId === sceneId &&
  pendingDestinationKeyRef.current === destinationKey;

const restingOnDestination =
  state.pendingRequest === null &&
  state.activeScene === sceneId &&
  pathAlreadyDisplayed;                 // the injective reduction above

if (!pendingMatchesDestination && !restingOnDestination) {
  if (sceneId === ACTIVITY_SCENE_ID) setActivityTarget({ roomKey: roomKeyFromPathname(pathname)! });
  // INVARIANT N (§2m-A): every in-flight issue for a DIFFERENT destination is now abandoned.
  // Mark, never delete — the record must survive until that commit actually lands, so the
  // effect can recognise the landing as stale rather than as a fresh arrival.
  // v11 (R10-M1): ONE call. `acceptNavigationIntent` supersedes every live issue AND records the
  // newest intent atomically — v10 still performed those as two separate statements here, which is
  // exactly the drift R9-B1 was about. It also captures the COMPLETE href (R7-3): `page.tsx:112-114`
  // seeds `shortCode` from the query, so a pathname-only intent destroys the room's join identity.
  acceptNavigationIntent(`${pathname}${window.location.search}${window.location.hash}`);
  pendingDestinationKeyRef.current = destinationKey;
  openedMidpointRef.current = null;
  navigationRef.current = null;         // see below — supersession orphans the parked navigation
  requestStageScene(sceneId);
}
```

**The identical block runs at the OTHER mint site** — §2n's handler `SUPERSEDE` fallthrough
(`WorldStageRoot.tsx:206`) — with `href: navigation.to` instead of `pathname`. Both are required and
neither is optional: R6-B1's interleaving starts with a handler-owned C, and R6-B2's starts with a
pathname-first C. **These are the only two sites in the component that mint a stage request**, which
is what makes "every abandoned issue is marked" checkable rather than hopeful.

`requestScene` already handles same-scene supersession correctly: the abandon branch is skipped
(`abandonedRequest.sceneId !== sceneId` is false), and it still bumps `generation`, mints a new
`requestId`, and resets `transition` to `fadingOut` (`stage-store.ts:143-190`). The superseded
generation's late `ackReady` is rejected by the store's existing generation matching.

#### An ISSUED router commit needs lineage too — R5-B1

Clearing the parked navigation closes only half the ownership gap. The other half opens the moment
`handleTransitionOpaque` hands off to the router:

```ts
// WorldStageRoot.tsx:239-249, verbatim at a156e3c0
if (!taken.navigation || navigationRef.current !== pendingNavigation) return;
navigationRef.current = taken.remaining;      // null on a match — the parked entry is GONE
commitStageNavigation(taken.navigation);      // → router.push/replace (:165-176), records nothing
```

From that line until App Router commits, **the in-flight navigation is invisible to every guard this
spec adds.** The failing interleaving:

| # | Event | State afterwards |
|---|---|---|
| 1 | B reaches its opaque midpoint | `openedMidpointRef = {B}`, parked nav taken and cleared |
| 2 | `router.push(B)` issued | **nothing records that B is in flight** |
| 3 | Handler-owned C arrives, destination mismatch ⇒ `SUPERSEDE` (§2n) | C minted + parked; `pendingDestinationKeyRef = C`; `openedMidpointRef` cleared |
| 4 | B's commit lands | pathname effect runs with `pathname = B` |
| 5 | v5's rules evaluate | `pendingMatchesDestination` false (pending is C) ⇒ **mint B**, clear C's parked navigation, repoint `activityTarget` to B |

Stale B defeats newer C. The pathname-driven variant fails identically when B's issued commit lands
after a pathname-first C. §5i already concedes an issued App Router navigation cannot be cancelled,
so v5 had no way to recognise step 4 as stale.

### 2m-A. THE NAVIGATION-LINEAGE INVARIANT — R6-B1 + R6-B2

> **INVARIANT N.** Every router navigation this component issues is represented by exactly one
> ledger record from the moment it is issued until it either LANDS or RETIRES. A landing settles
> **the record it belongs to** — never "whatever currently occupies a slot". A superseded record
> that lands installs nothing and repairs the URL to the stage's current intent.

**v6 used a single `issuedCommitRef` slot and it cannot express this invariant.** B and C overlap
**by construction**: at the anchor, C's `onOpaque` calls `commitStageNavigation(C)` BEFORE the
transition becomes `awaiting` (`StageTransition.tsx:72-78`), so the very act of issuing C overwrites
B's `{destinationKey: B, superseded: true}` with `{destinationKey: C, superseded: false}`. A late B
then matches nothing and re-mints B over C. v6's own pinned test could not have passed. This is not
a missing guard; one slot cannot hold two in-flight commits, so v7 replaces the slot.

#### The ledger, the tombstones, and the nonce — v8 (R7-1, R7-2, R7-3)

```ts
// WorldStageRoot.tsx
interface StageNavigationIssue {
  readonly id: string;              // `${documentEpoch}.${seq}` — the nonce carried in the URL,
                                    // OBSERVABLE at landing. (R10-M1: v10 typed this `number`
                                    // while `nextNavNonce()` returned a string.)
  readonly destinationKey: string;
  readonly href: string;            // the COMPLETE user-facing stage href, no nonce (R7-3)
  readonly issuedAt: number;
  status: 'in-flight' | 'superseded';
}
type NavigationTombstone = { readonly id: string; readonly status: 'settled' | 'superseded' };

// v9 (R8-B3): the lineage lives in `stage-navigation-lineage-store.ts` at MODULE scope, NOT in
// hooks — refs are re-created at their initial value on a real WorldStageRoot unmount/remount, so
// v8's "monotonic for the document" claim was false and the store's `resetStage()` could never have
// reached them. Named here as the module's exported state:
//   issues: StageNavigationIssue[]        // bounded MAX_TRACKED_NAVIGATION_ISSUES
//   tombstones: NavigationTombstone[]     // bounded MAX_NAVIGATION_TOMBSTONES
//   documentEpoch: string                 // minted once per DOCUMENT (§2a)
//   sequence: number                      // monotonic for the document, survives root remount
//   intent: { destinationKey: string; href: string } | null   // the COMPLETE href

const MAX_TRACKED_NAVIGATION_ISSUES = 8;
const MAX_NAVIGATION_TOMBSTONES     = 32;
const NAVIGATION_ISSUE_TTL_MS       = 10_000;   // hygiene ONLY — see "Retirement" below
```

**Why a URL nonce and not the in-memory `id` v7 used (R7-1).** v7 assigned an `id` and then settled
by `destinationKey`, so the id was bookkeeping no landing could cite. The failing state is two
outstanding issues for the SAME destination: B1 issued, superseded by C, then a legitimate B2 issued
while B1 is still outstanding. Both landings present only "destination B", and any destination-keyed
rule must guess between them. **App Router exposes no navigation identity**, so the identity has to
travel somewhere the browser preserves across a commit — and the URL is the only such channel
available to a client component.

#### Issuing: `commitStageNavigation` stamps the nonce

```ts
// v10 (R9-M1 + R9-B1 + R8-M1). This REPLACES the v8/v9 block outright — no numeric ids, no hook
// refs, no one-argument signature.
const commitStageNavigation = useCallback((
  navigation: WorldStageNavigationRequest,
  options: StageCommitOptions = {},
) => {
  // (1) R9-B1: ONE atomic op — supersede every live issue AND record the newest intent.
  acceptNavigationIntent(navigation.to);
  // (2) R9-M1: the id comes from the module sequence, as `${documentEpoch}.${seq}`.
  const { id } = nextNavNonce();
  const target = new URL(navigation.to, window.location.origin);
  target.searchParams.set(NAV_NONCE_PARAM, id);
  const issuedHref = `${target.pathname}${target.search}${target.hash}`;

  retireStaleIssues();
  pushIssue({
    id,
    destinationKey: stageDestinationKey(target.pathname) ?? '',
    href: canonicalStageUrl(navigation.to),   // stored WITHOUT the nonce, for repair (R7-3)
    issuedAt: Date.now(),
    status: 'in-flight',
  });                                          // count-evicts the oldest to a tombstone

  navigation.onMidway?.();
  // (3) R8-M1: the options are real. Defaults reproduce the anchor exactly.
  const method = options.history === 'auto' || options.history === undefined
    ? decideStageNavigationHistoryMethod(committedStageNavigationsRef.current)
    : options.history;
  if (options.countTowardStageHistory !== false) committedStageNavigationsRef.current += 1;
  if (method === 'push') router.push(issuedHref); else router.replace(issuedHref);
}, [router]);
```

This remains the single choke point every issued navigation passes through — the `EXECUTE_NOW`
branch (`:194`), the midpoint commit (`:248`), cold-init, and the repair below.

#### Landing: classify by nonce, then act

`WorldStageRoot` reads `const searchParams = useSearchParams();` and adds it to the children-swap
effect's dependency array, so the effect re-runs on a **query-only** commit — which is exactly the
B1/B2 same-pathname case that no pathname-keyed effect could ever observe. *(This is what forces the
`(world)` layout to be dynamic — see R7-1b and §1a.)*

```ts
type NavLandingClass =
  | { kind: 'issued-live'; issue: StageNavigationIssue }
  | { kind: 'issued-stale' }      // OUR epoch: superseded or tombstoned-superseded ONLY (NOT absent)
  | { kind: 'traversal' }        // OUR epoch: settled tombstone, OR absent && seq <= issuedHighWater
  | { kind: 'malformed' }        // OUR epoch: absent && seq > issuedHighWater — never minted (R14-1b)
  | { kind: 'foreign' }           // v9 (R8-B3): a nonce from a DIFFERENT document
  | { kind: 'unissued' };         // no nonce at all
```

Current landing behavior is defined exclusively by the seven-row frozen provenance table in the round-14 ledger; this passage adds no alternate classification rule.

**The unknown-nonce case is the R7-2 repair, and its direction is chosen deliberately.** A nonce
carrying OUR epoch that we can no longer describe (aged out, count-evicted, or older than the
tombstone ring) classifies `issued-stale`, never `unissued`. So a component-issued landing can only
ever be *repaired against current intent*, never promoted to a fresh arrival. The cost of being wrong
in this direction is one redundant `router.replace`; the cost of the other direction is the R7-2
blocker. The epoch is what lets v9 apply that conservative rule **only** to this document's nonces,
so a foreign one is no longer swept up by it.

#### The five operations

| Operation | Called from | Behavior |
|---|---|---|
| **`issueNavigation`** (inlined above) | `commitStageNavigation` | **`acceptNavigationIntent(navigation.to)` FIRST** (supersedes every live record AND records the intent), then mint `${documentEpoch}.${seq}` via `nextNavNonce()`, register the new record `in-flight`, and count-evict the oldest to a tombstone |
| **`acceptNavigationIntent(href)`** | ALL FOUR accepted-navigation sites **and** `issueNavigation` — it is the ONLY way supersession or intent is written | **v11 (R10-M1), the merge of two v9/v10 operations.** Canonicalizes the full href, marks every `in-flight` record `'superseded'` — **including same-destination records** (R8-B1: exempting them let a late B1 restore an older query) — and records the intent, in ONE synchronous call. At most ONE record is `in-flight` at any instant, and intent can never lag the supersession that accompanied it |
| **`getNavigationIntent()`** | `repairUrlToCurrentIntent` | **v11 (R10-M1):** the module OWNS the intent, so consumers read it through this rather than reaching for a component ref |
| **`classifyNavLanding(nonce)`** | the pathname effect, once per run | **the SEVEN-row frozen table in the round-14 ledger — that table is the single statement; this row and every other passage defer to it.** Pure over `{issues, tombstones, nonce, documentEpoch, issuedHighWater}`. **`issuedHighWater` is part of the module snapshot the classifier already reads**, so purity is unchanged (R14-1) |
| **`settleIssue(id)`** | the `issued-live` branch | removes the record **by id** and pushes a `'settled'` tombstone. **Destination is not consulted** — that was R7-1 |
| **`retireStaleIssues()`** | `commitStageNavigation`, and once per pathname-effect run | moves records older than the TTL to `'superseded'` tombstones. **Hygiene only** — see below |

#### Explicit URL repair — full-URL, both paths (R6-B2 + R7-3 + R8-M1)

```ts
function repairUrlToCurrentIntent(): boolean {
  const intent = getNavigationIntent();          // v11 (R10-M1): the module owns intent
  if (!intent) return false;
  if (canonicalStageUrl(intent.href) === canonicalStageUrl(window.location.href)) return false;
  commitStageNavigation(
    { to: intent.href as WorldStageHref },
    { history: 'replace', countTowardStageHistory: false },   // v9 (R8-M1)
  );
  return true;   // the caller uses this to distinguish repaired from unrepaired stale landings
}
```

**R8-M1 — the forced-replace contract is now implementable.** v8 called plain
`commitStageNavigation({to})` and claimed it forced `replace` and skipped the counter. The anchor
does neither: `WorldStageRoot.tsx:165-176` runs `committedStageNavigationsRef.current += 1`
unconditionally and picks the method through `decideStageNavigationHistoryMethod`. v9 pins an
explicit second parameter:

```ts
interface StageCommitOptions {
  readonly history?: 'auto' | 'push' | 'replace';   // default 'auto' = the anchor threshold
  readonly countTowardStageHistory?: boolean;       // default true
}
const commitStageNavigation = useCallback(
  (navigation: WorldStageNavigationRequest, options: StageCommitOptions = {}) => { /* … */ },
  [router],
);
```

Defaults reproduce the anchor exactly, so every existing call site is byte-identical; only the repair
passes options. The counter must stay untouched because `decideStageNavigationHistoryMethod`
(`stage-navigation-ownership.ts:13-17`) switches from `push` to `replace` at 2 and §6.5's history
test pins that threshold. §6.2 asserts both the emitted nonce and the unchanged counter.

**Both mint sites capture the COMPLETE href** (R7-3):

| Accepted-navigation site | argument to `acceptNavigationIntent(href)` |
|---|---|
| handler `EXECUTE_NOW` (`:194`) | `navigation.to` — already complete |
| handler `ADOPT` (`:198-203`) | `navigation.to` — **mints nothing, which is why v9 missed it (R9-B1)** |
| handler `SUPERSEDE` fallthrough (`:206`) | `navigation.to` |
| children-swap effect (`:132`) | `pathname + window.location.search + window.location.hash` |

The function canonicalizes internally, so no call site can forget to.

v7 stored the bare `pathname` on the second row, so a repair could silently drop `?shortCode=…`.
Since `page.tsx:112-114` initialises `shortCode` from the query, that is a real loss of the room's
join identity, not a cosmetic URL difference.


#### Retirement is hygiene, not correctness (R7-2)

v7 made correctness depend on retirement timing and then had to answer "retirement is lazy, so it
never runs on idle time alone." **v8 removes the dependency instead of answering the objection.**
Because an absent own-epoch nonce classifies by the `issuedHighWater` predicate rather than by what the rings happen to retain (R14-1a), a record that is never retired and a record that
retired an hour ago produce the SAME safe outcome. So:

- **Age retirement (`NAVIGATION_ISSUE_TTL_MS`) is explicitly labelled memory hygiene.** It is lazy —
  it runs only on issue or on a pathname-effect run — and that is now harmless, and said plainly
  rather than defended.
- **Both rings are count-bounded** (`8` issues, `32` tombstones), so idle time cannot grow them
  regardless of when hygiene runs.
- **Eviction tombstones rather than deletes**, so count pressure cannot resurrect the R7-2 defect
  through the back door.

#### Reset and unmount (R7-2)

**v9 (R8-B3) — the reset channel is now explicit, because the store one does not exist.** The anchor's
`resetStage()` is `set((state) => createInitialState(state.stageEpoch + 1))` (`stage-store.ts:454-456`):
it resets STORE state and has no channel to component-local refs, so v8's claim that it cleared the
ledger was unimplementable. v9 exports **`resetStageNavigationLineage()`** from the lineage module and
exports `resetStageNavigationLineage()` for **test isolation only — there is NO production caller** (R10-M1: v10 mandated a mount caller here and denied one in the module JSDoc; the frozen
semantic below is the denial). It clears **issues, tombstones, and intent**, and deliberately does
**NOT** touch `documentEpoch` or `sequence`
— a restarted sequence could re-mint an id that a surviving in-flight browser navigation still
carries, letting a pre-reset landing settle a post-reset record.

Because that state is module-scoped, a real `WorldStageRoot` unmount/remount **preserves** the epoch
and the sequence by construction, which is the property v8 asserted and could not deliver. §6.2 tests
a genuine unmount/remount rather than a simulated one.


**Why not the critique's alternative — serialize issuance until the previous commit settles.** App
Router exposes no settle callback for an issued client navigation (the same fact §5i concedes), so
"wait until B settles" is not observable and would have to be approximated with a timer that gates
every crossing. The ledger costs one array and four pure operations, and it degrades to exactly the
anchor's behavior when nothing overlaps.

**Non-superseded crossings are untouched**, which §6.2 pins with an explicit negative case: with no
supersession the ledger holds one record, it settles `'in-flight'`, and the install/mint rules run
exactly as in v5.

**Why `navigationRef.current = null` is required and not defensive.**

**Why `navigationRef.current = null` is required and not defensive.**
`takeParkedNavigationForOpaque` matches only `parked.requestId === request.requestId ||
parked.requestId === request.retryOfRequestId` (`stage-navigation-lineage.ts:25-47`), and a
supersession mints a fresh `requestId` with `retryOfRequestId` **undefined**, so
`rekeyParkedNavigationForRetry` (`:7-23`) will not rekey it either. Left in place, a navigation
parked for the superseded destination is orphaned: it matches nothing, survives until the root
unmounts, and would commit a stale href if some later request happened to reuse the id. On the
PATHNAME-driven path the router has already moved, so committing that href would fight the user's own
back/forward — clearing is the correct semantic, not merely the safe one. On the HANDLER path no
clear is needed: the handler overwrites `navigationRef.current` with the new `{requestId, navigation}`
pair in the same turn.

**Equivalence with the anchor for `/game`, `/cove`, `/kelp` — argued from ONE expression, not across
clocks.** For those slots `stageDestinationKey ≡ sceneId` and `pendingDestinationKeyRef` is written
from that same mapping at the same call site, so `pendingRequest.sceneId === sceneId` ⇒
`pendingDestinationKeyRef.current === destinationKey`; `pendingMatchesDestination` collapses to the
anchor's first conjunct. And `restingOnDestination`'s added `pathAlreadyDisplayed` is redundant for
them, because for a non-activity slot `activeScene === sceneId` at rest already implies the pathname
is that slot's single pathname. Both operands come from the same expression evaluated at the same
instant — which is precisely the property v4's opacity argument lacked. §6.2 pins it empirically
anyway (SELF-F: no cross-clock equality is asserted as a tautology, and every added conjunct gets a
negative test).

**`pendingDestinationKeyRef` — one new ref, written at every mint.** `StageRequest` carries only
`{sceneId, generation, requestId}` (`stage-store.ts:170-172`), so the request itself cannot answer
"which room". Rather than widen a P1b-landed store shape for a `WorldStageRoot`-local question, the
root keeps a plain `useRef<string | null>` set to `stageDestinationKey(targetPathname)` at **both**
`requestStageScene` call sites — the handler's fallthrough (`:206`) and the children-swap effect
(`:132`) — immediately before the call. It is `WorldStageRoot`-private, is not read by the page, and
is not part of the readiness contract; `activityTarget` remains the store-level, page-readable
destination identity. Two mechanisms because they have two different consumers and two different
lifetimes: the ref answers "which parked subtree may be swapped in **for this request**", while
`activityTarget` answers "which room may acknowledge readiness **for this scene**", and R2-B1
already established that the second must be scene-keyed so a watchdog retry preserves it.

`handleTransitionOpaque`'s parked-children match keeps the v4 shape — the existing scene check AND
`stageDestinationKey(pendingRoute.pathname) === pendingDestinationKeyRef.current` (`:230-236`) — so
a parked destination C is never swapped in to satisfy a request for B.

Covering only the handler path would leave back/forward, direct navigation, and the §2h fallback
destination-blind, so §6.2 tests both minting paths independently, asserts a real request on the
pathname-first one, and — new in v5 — carries the handler-owned crossings for all four slot pairs
with the real router-after-midpoint ordering.

### 2n. Navigation ownership is scene AND destination — R4-B2 (amends P3-landed code; declared)

```ts
// stage-navigation-ownership.ts — the v5 signature. Two additive optional inputs.
export function decideStageNavigationOwnership(input: {
  targetSceneId: string;
  /** NEW (P4 v5): `stageDestinationKey(targetPathname)`, or null when unknown. */
  targetDestinationKey?: string | null;
  /** NEW (P4 v5): `pendingDestinationKeyRef.current`, or null when unknown. */
  pendingDestinationKey?: string | null;
  pendingRequest: StageRequest | null;
  transitionPhase: StageTransitionPhase | null;
}): StageNavigationOwnership;
```

The anchor body (`:19-36`) is unchanged except for ONE new branch, inserted immediately after the
existing `pendingRequest.sceneId !== targetSceneId ⇒ SUPERSEDE` check and before the `fadingOut ⇒
ADOPT` check:

```ts
if (
  input.targetDestinationKey != null &&
  input.pendingDestinationKey != null &&
  input.pendingDestinationKey !== input.targetDestinationKey
) {
  return 'SUPERSEDE';
}
```

**What this fixes.** At the anchor a `navigateOut('/activity/x/C')` issued while activity B is
pending returns `ADOPT` during `fadingOut` — parking C's navigation onto B's `requestId`, so B's
midpoint commits a router push to C while the stage activates B's slot with `activityTarget` still
naming B — or `EXECUTE_NOW` during `awaiting`, pushing to C with no new request at all. Both leave
readiness bound to B while the page renders C. `SUPERSEDE` sends the handler down its existing
`requestStageScene` fallthrough (`WorldStageRoot.tsx:206`), which mints a real C request and parks C's
navigation against C's `requestId`.

**Tautology, and this one is sound.** Reaching the new branch implies
`pendingRequest.sceneId === targetSceneId`. For `/game`, `/cove`, and `/kelp`,
`stageDestinationKey(p) === sceneIdForPathname(p)` by definition (§2a), and both keys are produced by
that same function from pathnames of the same slot — so they are equal and the branch is dead. Unlike
v4's opacity claim, both operands here are derived from `sceneId` **within one expression**, with no
dependence on when `activeScene` or `displayedPathRef` advanced. §6.2's new ownership suite still
pins it with an explicit unchanged-verdict case, per SELF-F.

Both new inputs are optional and default to `null`, so a caller that does not pass them gets the
anchor's behavior exactly. `WorldStageRoot` is the only caller.

---

## 3. JSON schemas for persisted state

**Server-persisted state: NONE.** No table, column, route, or wire field changes. The activity WS
protocol, the room lifecycle, `reward-pipeline.ts issueRewardsForRoom` (`:307`) and its one
`activity.match.placed` per participant (`:298`, credited only after the unique result insert at
`:503-511`), and the leaderboard scoring CTE (`routes/leaderboard.ts:601-616`) are untouched.

**Probe gating — MANDATORY (v15, R14-2b).** The whole `__WORLD_STAGE_PROBE__` install effect is
wrapped in `if (process.env.NEXT_PUBLIC_ENABLE_STAGE_PROBE !== '1') return;`. At the anchor the probe
is installed unconditionally inside the `stageReady` effect (`WorldStageRoot.tsx:253-262`) and
exposes `navigate?: (to: '/game' | '/cove') => boolean` — **and P4 widens that to activity-capable
`WorldStageHref`**, which round 14 showed is the only constructible precursor to the accepted
residual (33 probe navigations while one route commit hangs, evicting the tombstone ring). Gating it
removes the scripted path and leaves only a manual one.

`NODE_ENV` cannot be the discriminator — it is `'production'` on both Coolify boxes — so this follows
the repo's established client-gating pattern (`NEXT_PUBLIC_ENABLE_DEV_QUEUE`, `NEXT_PUBLIC_COVE_DEBUG`).
The flag is set on local and staging, where the §6.4-§6.6 verification lanes run, and unset on
production. §6.2 pins both directions.

**Probe snapshot addition (R5-m2).** `__WORLD_STAGE_PROBE__.snapshot()` (`WorldStageRoot.tsx:253-296`)
gains ONE field beside the existing `pathname` / `historyLength` / `activeScene` / `transitionPhase`:

```ts
committedStageNavigations: committedStageNavigationsRef.current,   // number
```

It is read straight from the ref the root already maintains (`:84`, incremented in
`commitStageNavigation` at `:171`) and is the counter `decideStageNavigationHistoryMethod`
(`stage-navigation-ownership.ts:13-17`) switches on at 2. §6.5's history test asserts it before
traversing; without it that test names a field the anchor does not expose and is not implementable.
No other probe field changes.

| Browser key | Store | Shape | Change |
|---|---|---|---|
| `world-stage-webgpu-unhealthy` | `sessionStorage` | `'1'` | Unchanged. Governs the STAGE renderer only; the activity canvas is a plain R3F WebGL renderer and never reads it. |
| `clawville-tutorial-seen` | `localStorage` | `'true'` | Unchanged (probe fixture). |

Probe summary deltas:

```jsonc
// world-stage-activity-exit-summary.json → summary.activityExit
{
  "fixtureTraffic": { "GET /api/auth/me": 0, "GET /api/avatars/me": 0, "GET /api/auth/me/agent-session": 0 },
  "stageProbeIdentityStable": false,
  "stageCanvasMountCount": 0,
  "activityCanvasMountCount": 0,
  "maxLiveCanvases": 0,
  "pointerContract": {
    "centerHitIsActivityCanvas": false, "leaveButtonClickable": false,
    "hudRootPassesThrough": false, "mobileActionButtonsClickable": null
  },
  "entryLoader":  { "appeared": false, "appearedWhileNotReady": false, "topmostAtCenter": false, "maxAriaValue": 0, "disappearedBeforeReady": false, "samples": 0 },
  "returnLoader": { "…same shape…": null },
  "overlayHandoff": {
    "activityPageUnmountedBeforeFadeIn": false,
    "outgoingOverlayStatus": null,
    "outgoingOverlayTimedOut": true,
    "recoverySurfaceShown": false,
    "recoveryActionCount": 0,
    "leaveFrameObservedBeforeFadeIn": false,
    "leaveFrameEmittedByTimeout": true,
    "hardNavigateLeaveFrameSent": false
  },
  "readiness": {
    "ackedOnFirstEntry": false, "ackedAfterSilentRetry": false,
    "ackedAfterRecoveryCountBump": false, "ackedOnTerminalBranch": false,
    "targetRoomKeySetOnHandlerNav": false, "targetRoomKeySetOnPathnameNav": false,
    "outgoingRoomNeverAckedIncomingGeneration": false,
    "pathnameFirstMintedNewGeneration": false
  },
  "downlink": {
    "sseBytesDuringDwell": null, "openStreamCallsWhileDisabled": null,
    "landInvalidatedOnReopen": false, "extraJoinsOnResume": null,
    "closeEmittedWithNullSource": false, "opensWhileRecoveryInFlight": null
  },
  "roomIsolation": {
    "activityCanvasRekeyedOnRoomChange": false, "activityStoreResetOnRoomChange": false,
    "selfBusesResetOnRoomChange": false, "shortCodeResetOnRoomChange": false,
    "lobbyGateResetOnRoomChange": false, "spectatorStateResetOnRoomChange": false,
    "wsSocketIdentityChangedOnRoomChange": false
  },
  "worldFrozenWhileActivityActive": { "framesStart": 0, "framesEnd": 0, "cameraStart": [], "cameraEnd": [] },
  "stagePausedWhileActivityIdle": false,
  "returnEvidence": { "pathname": "", "sentinelSurvived": false, "ready": false, "loaderAbsent": false, "transitionIdle": false, "hitTest": {} }
}

// world-stage-activity-route-summary.json — the routes schema with summary.pair === "activity".
// world-stage-activity-gpu-summary.json    — §6.11 (OS GPU counter + context drills).
```

---

## 4. New env vars / config

**NONE — confirmed by inspection.** No file in §1 adds a `process.env` read. The only tunables
introduced are TypeScript constants beside their consumers: `OUTGOING_OVERLAY_COMMIT_TIMEOUT_MS =
10_000`, `NAVIGATION_ISSUE_TTL_MS = 10_000` and `MAX_TRACKED_NAVIGATION_ISSUES = 8` (§2m-A),
`RECOVERY_WAIT_CEILING_MS = 30_000` and `JOIN_TIMEOUT_MS = 15_000` (§2k-A), `MAX_NAVIGATION_TOMBSTONES = 32` and the `NAV_NONCE_PARAM = '__wsnav'` reserved query key (§2a, §2m-A), the slot camera/appearance, the capability mask, and `--pair=activity`. **`JOIN_TIMEOUT_MS < RECOVERY_WAIT_CEILING_MS` is a pinned ordering invariant** (§2k-A): the recovery must always settle before the retry lineage retires, or the ceiling hands ownership to an actor that cannot act (R7-4). **`NAVIGATION_ISSUE_TTL_MS` is deliberately equal to
`OUTGOING_OVERLAY_COMMIT_TIMEOUT_MS`** — both answer "when do we stop expecting a router commit to
arrive", and having two different horizons for one question is how a spec grows contradictory
timeouts. If one is ever tuned, the other moves with it. `.env.example` and the
`CLAUDE.md` env table gain **exactly one** entry: **`NEXT_PUBLIC_ENABLE_STAGE_PROBE`** (§2m-A, R14-2b) — the single new debug env gate this diff introduces, and the only new `process.env` read. `.env.example` carries `NEXT_PUBLIC_ENABLE_STAGE_PROBE=` with the comment *"Set to 1 only for local/staging probe builds; leave unset in production."* **Local and staging CLIENT BUILDS must receive `NEXT_PUBLIC_ENABLE_STAGE_PROBE=1` at BUILD time** — it is inlined by Next at build, not read at runtime, so setting it only in a shell after the build leaves the probe absent and every §6.4-§6.6 lane red. **Post-build checks:** on local and staging assert `typeof window.__WORLD_STAGE_PROBE__ === 'object'`; on production assert it is `undefined`. **No user-facing rollout flag** — per
[[feedback_no_dark_flags_in_prod]], §9's per-commit revert is the rollback mechanism.

One pre-existing env fact this spec depends on but does not change:
`NEXT_PUBLIC_REEF_RACE_USE_SPLINE` is read at `page.tsx:133`, `ReefRaceScene.tsx:87`,
`reef-race-hud.tsx`, and `reef-race-self-bus.ts`, is **absent from `.env.example`**, and I could
not read the Coolify values. It selects whether entry lands on `LobbyLanding` or straight into the
race (`page.tsx:131-137`), which changes which branch the fade lifts onto. §6.9 drives both
settings; OQ-4 requires confirming the box value before promotion.

---

## 5. Decision tables

### 5a. Where does each activity render?

| Option | Reef | Bumper | Verdict |
|---|---|---|---|
| **A — in-canvas stage slots** | Water renders as a bare `NodeMaterial` (§0.1); bloom gone (§0.2); the render loop either stops for every slot or double-renders. Needs a ~440-line GLSL→TSL port + a postprocessing rewrite. | Plausible: no `ShaderMaterial`, no postprocessing. Would still need slot-scoped `OrbitControls` and module-scratch. | **REJECTED** for reef — a shader rewrite of the headline visual disguised as a render migration. Rejected for bumper because hard constraint 1 makes the route move all-or-nothing and a split treatment forks the page into two lifecycle models. |
| **B — route joins the group; both keep their room-keyed `<Canvas>` above a paused stage** | Byte-identical rendering. | Byte-identical rendering — clears NO-REGRESSION by construction. | **CHOSEN.** |
| **C — leave the route outside the group** | — | — | REJECTED: leaving the group destroys the stage layout, so the return cold boot survives. |

**Note on the two dead GLSL modules.** `terrain-shader.tsx:199` and `water-surf.tsx:312` call
`extend()` at module scope but nothing in the prod reef graph imports them —
`river-scene.tsx`'s header records their removal in the 2026-06-23 SURF ROAD rebuild. Not deleted
by this diff (a reef-domain call), but recorded in §7 so an OQ-1 port does not budget for them.

### 5b. Bumper Shells treatment

| Question | Answer |
|---|---|
| Does bumper change at all? | Two hunks: the priority-0 `<ActivityCanvasReadyProbe>` (§2c), and the §5c scratch-counter fix. `canvasKey = \`${roomId}-${spectatorCamMode ?? 'chase'}\`` (`:633`) is untouched, including its spectator-mode re-key. |
| Does it meet "NO REGRESSION"? | Yes, structurally — renderer, camera, materials, lights, shake, flash overlay, particles and `OrbitControls` all run in the same plain `WebGLRenderer` as today. **B1 was the one way v1 broke this**, and it is fixed at the root. §6.2's draw-call assertion makes a recurrence a red test. |
| Why not promote bumper to a real slot now? | It would fork one `page.tsx` into two lifecycle models and double the isolation surface for a scene whose cold boot is already cheap (≤30 draw calls / ≤60k tris, `BumperShellsScene.tsx:26`). **Tracked:** OQ-1 sequences bumper FIRST for the in-canvas model, ahead of reef, because it needs no shader work. |

### 5c. Per-room state — the full reset surface (M2)

**Inside the activity canvas — reset by the room-keyed `<Canvas>` exactly as today (reef `key={roomId}`, bumper `key={canvasKey}`):** whole scene graph, GPU
buffers and pipelines, WebGL context, `ChaseCamera` history/`lastRotRef`/`pregameSnappedRef`/
`dampedLookAt` (`ReefRaceScene.tsx:289-297`), screen-shake refs (`:614`,
`BumperShellsScene.tsx:607`), the `OrbitControls` instance (constructed `:267`, disposed `:258`,
`:278`), the `PreCompilePipelines` rAF (`ReefRaceScene.tsx:221-228`, `BumperShellsScene.tsx:110-117`),
the bumper flash timer (`:611-629`), and `forgetTKey('cam')`'s elevation-cache eviction
(`ReefRaceScene.tsx:306-310` → `reef-race-elevation.ts:246`, cache at `:75`).

**Outside the canvas — each row with its reset owner:**

| State | Live source | Today | After P4 | Verdict |
|---|---|---|---|---|
| `useActivityStore` (entities, pickups, scores, events, reef slices, `finishedRacers`, …) | `stores/activity.ts:731-857` | `page.tsx:157-162`, keyed `[roomId]` | identical, now ALSO inside the `ActivityRoomRuntime` key | unchanged |
| `selfAvatarId` | `stores/activity.ts:868` | `:166-168`; preserved across `reset` (`:916`) | identical | unchanged |
| WebSocket + ping loop + reconnect timers | `useActivityWs.ts:121-334`; deps `[wsUrl, shortCode, sessionToken]` (`:334`) | room change ⇒ new `wsUrl` ⇒ cleanup sends `leave` + close (`:311-333`) | identical; §5f is the full table | unchanged |
| Keyboard/pointer/custom listeners + 30 Hz loop | `useActivityInput.ts:533-539`, `:572-683` | page unmount; `registerInputReset` unregistered `:549` | identical (P4d re-expresses the attachment only) | unchanged |
| `selfInputBus` / `selfPoseBus` / `selfWrongWay` | `reef-race-self-bus.ts:60`, `:68`, `:90` | reset at `useActivityInput.ts:681`, on self-player teardown, `:110` | identical | unchanged |
| Surge snapshot + `turboBubbleActiveUntil` | `reef-race-speed-surge.tsx:34-35` | `ReefRaceSurgeDriver` effect keyed `[roomId]`, resets on entry AND cleanup (`:175-184`) | identical | unchanged |
| **`shortCode` / `shortCodeError`** | `page.tsx:112-116` | ⚠ **`useState` initializer does NOT re-run on `roomId` change.** A direct `/activity/A → /activity/B` would send room A's shortCode as room B's auth frame ⇒ hub close 4001. Not reachable today only because every shipped Play-Again path routes through `/game` first. | **FIXED by the `ActivityRoomRuntime` key** (§2g) | ⚠ pre-existing latent bug, closed |
| **`lobbyGate`** | `page.tsx:131-137` | same class — `useState` initializer, room-independent | fixed by the key | ⚠ closed |
| **`spectatorCamMode` / `spectatorTargetAvatarId`** | `page.tsx:235-249` | same class | fixed by the key | ⚠ closed |
| **`next/dynamic` loading/error state** | `page.tsx:45-93` | ⚠ **NOT a React-key-resettable class.** `dynamic()` is called at MODULE scope, so the `React.lazy` payload (and its cached rejection) lives for the SPA's lifetime; no key of any kind resets it. v2's "fixed by the key" claim was FALSE (R2-m1(e)). | **FIXED by MOVING the construction**, not by keying alone: §2i builds the component with `useMemo(() => dynamic(…), [activityId, sceneAttempt])` INSIDE the `${activityId}:${roomId}`-keyed runtime, so the lazy payload is now component-scoped and both a room change and a Try-again mint a fresh one. | ⚠ closed, by a different mechanism than v2 claimed |
| **HUD / results-modal / chat-log component state** | `reef-race-hud.tsx`, `activity-results-modal.tsx`, `bumper-shells-hud.tsx` | same class | fixed by the key | ⚠ closed |
| **`LobbyLanding` local state** — `phase`, `lobby`, `players`, `error`, the four `form*` fields, `submitting`, and the 3 s poll timer ref | `lobby-landing.tsx:169-181`, poll rescheduled at `:277-285` | ⚠ same class — nine `useState`s plus a live `setTimeout` chain that would carry room A's lobby snapshot and its in-flight poll into room B | fixed by the key (the component unmounts, its cleanup clears the timer) | ⚠ **ADDED in v3 (R2-m1(d))**, closed |
| **`ActivityMobileControls` state** — `boostFlash`, `powerupFlash`, and the nipplejs `JoystickManager` refs | `activity-mobile-controls.tsx:82-88` | ⚠ same class; a stale joystick manager bound to the previous room's container | fixed by the key | ⚠ **ADDED in v3 (R2-m1(d))**, closed |
| **Readiness + boundary state** — `paintedRoomKey`, `terminalBranch`/`terminalRoomKey`, `ackedKey`, `attemptNonce`, `sceneAttempt`, the published canvas handle | §2b, §2c, §2i | n/a (new) | all live inside the keyed runtime, so a room change resets every one of them; §2b additionally room-scopes them so a stale value cannot speak for a new room even before the remount lands | ⚠ **ADDED in v3 (R2-m1(d))**, new + tested |
| `_renderedPoseByAvatar` | `ReefRacePlayer.tsx:506` (decl), `:1056-1064` (lifecycle) | **NOT a leak — v1-v3 said it was, and that was wrong (SELF-E).** Read at the anchor: one `useEffect(..., [entity.avatarId])` does `_renderedPoseByAvatar.set(entity.avatarId, pose)` at `:1058` and its cleanup at `:1059-1063` does `if (_renderedPoseByAvatar.get(entity.avatarId) === pose) _renderedPoseByAvatar.delete(entity.avatarId)`. The identity guard is there so a same-avatarId remount hands ownership to the newer instance instead of double-deleting. The map is bounded by LIVE rendered players. | same | **CLAIM RETRACTED.** Not a defect, so nothing to fix, track, or measure. The §7 punch-list item is REMOVED (not renewed), and §6.2's baseline test is DELETED (R3-M1 asked how to test it; SELF-E answers that the premise was false). What replaces it is §6.1's diff-scope gate, which proves the honest thing: P4 does not touch `ReefRacePlayer.tsx` at all. |
| `_hitCheckScratch` / `_elimCheckScratch` | `BumperShellsScene.tsx:80-81` | ⚠ stale ring-buffer indices survive a room change, suppressing early hit/elim VFX and the knockout sound in the next match | **FIXED here** (Memory RULE 6) — the only behavior change P4 makes inside an activity scene | ⚠ closed |
| Audio context + buffers | `lib/activity-audio.ts:78-85` module singleton | never reset; unlocked once per document (`page.tsx:254-270`) | **identical** | unchanged. **v1's "now better" claim is RETRACTED (M2):** the singleton already survives SPA navigation today, so P4 changes nothing here. |
| `clientSpline`, `_pregameVantage` | `reef-race-spline-instance.ts`, `ReefRaceScene.tsx:126-138` | never reset (static track) | unchanged | fine |
| Stage slot generation for `activity` | `stage-store.ts:143-193` | n/a | new per room change; readiness handles it (§2b) | new, tested |

### 5d. Input-sharing classification — the ruling

**Technical finding (unchanged, and the critique agreed):** the activity is a
**vehicle/wire-input controller**, not an avatar controller. Its input is sampled by a fixed 30 Hz
`setInterval` (`useActivityInput.ts:574`, `SEND_INTERVAL_MS = 1000/30` at `:46`) with latched
one-shots (`oneShotBitsRef` at `:132`, cleared once per send at `:599`) so a tap shorter than the
send interval is not lost; direction is kart-relative off the RENDERED heading
(`recomputeReefKeyboardDir` `:78-101`, `selfPoseBus` freshness `:239-244`) for reef and world-axis
for bumper; and the result is published to `selfInputBus` for client prediction (`:659-663`).
Rebasing that onto P3's rAF sampler would couple wire rate to frame rate on the Iris Xe floor —
which is also anti-cheat-relevant (the server rejects >60 Hz with `error: input_rate`,
`useActivityInput.ts:9-11`).

**Governance disposition (M4).** P3 v4 OQ-3's non-binding read was that the vehicle seam shares
`player-input.ts`. v1 declared the ruling satisfied by the shared `registerInputReset` registry
alone — a governance call, not a code consequence. This spec does not make that call unilaterally:

| Layer | v1 | v4 (frozen) |
|---|---|---|
| Focus-loss reset registry | already shared (`useActivityInput.ts:539` imports `@/lib/three/input-reset`) | unchanged — still shared |
| DOM listener attach/detach + editable-target guard + key identity | duplicated | **SHARED via `attachHeldKeyListeners` in `player-input.ts` (commit P4d, §2l)** |
| Key→action-bit mapping, one-shot latch, 30 Hz send loop, kart-relative direction, `selfInputBus` | activity-specific | activity-specific (unchanged) |
| Capability mask | all-false for `activity` | unchanged — an all-false mask is the honest encoding of "no walking avatar in this scene" |

The exception is stated in the EXECUTIVE SUMMARY. **P4d is droppable**; OQ-6 records the
registry-only alternative for an explicit founder ruling.

### 5e. Presence + downlink — M1 answered in full

| Route | policy | downlink | uplink | uploaded `activity` | world-side render |
|---|---|---|---|---|---|
| `/game` | `active` | open | motion-driven | `idle`/`walking` | normal |
| `/cove` | `remote` | open | 10 s | `AT_COVE_ACTIVITY` | idle + `· at the Cove` |
| `/kelp` | `remote` | open | 10 s | `AT_KELP_ACTIVITY` | idle + `· at the Kelp Forest` |
| `/activity/…` | `remote` | **closed (P4c)** | 10 s | `AT_ACTIVITY` | idle + `· in an activity` |

Why suspend the downlink: `useWorldStream`'s `EventSource` delivers a snapshot every 200 ms
(`use-world-stream.ts:427-462`), each parsed and reconciled on the main thread into the resident
world subtree. Today `/activity` has **no** world stream at all. Joining the group without P4c
would silently add a 5 Hz parse + player reconcile to a latency-sensitive race — a performance
regression against Priority #1 introduced by a migration whose purpose is performance.

**Every question raised across rounds 1 and 2, answered:**

| Question | Frozen answer |
|---|---|
| Is `CLOSE` emitted once on the edge or every tick? | Once. `closeStream() → invalidateStream()` clears the **source, the retry timer, AND `activeRetryToken`**, so the next tick reads `{open:false, pendingReopen:false}` ⇒ `NONE`. *(R5-m5: earlier versions said "clears `es` and `retryTimeout`" — that was v4's marker. Since `pendingReopen` is `activeRetryToken !== null`, the token is the field idempotence actually depends on.)* Idempotence is a §6.2 test. |
| **Can a ticketed `/join` recovery be raced by the tick edge? (R5-B2)** | Not in v6. Rule 2 requires `!recoveryInFlight`. The race it closes: recovery awaits `/join` → downlink disables → rule 1's `CLOSE` clears the retry token while the recovery continues (it is not cancellable) → downlink re-enables before `/join` resolves → rule 2 would otherwise see `{wanted:true, open:false, pendingReopen:false}` with valid old refs and open the OLD room, which the recovery then either replaces or leaves stranded as the live stream. |
| **Why is `recoveryInFlight` on rule 2 only, and not in `pendingReopen`?** | Because `closeStream()` cannot clear it — it is owned by `settleRecovery`'s lease CAS (R11-6; the anchor's `rejoinWithTicket` try/finally is replaced by this diff). If it fed rule 1, then during a suspended window with a recovery in flight rule 1 would match on every 200 ms tick and re-emit `CLOSE` for the life of the `/join`. Rule 2 is the only rule that must defer to it. |
| **How is a BUSY recovery told apart from a FAILED one?** | By re-checking `recoveryInFlight` after the await. It cannot be told apart from the return value: `recoverWithTicket()` and `rejoinWithTicket()` both open with `if (cancelled \|\| recoveryInFlight) return null;` (`:354-355`, `:267-268`), so a busy call returns a bare `null` **and never dispatches `RECOVERY_FAILED`** — identical to a genuine failure at the call site. On busy the continuation RE-ARMS rather than returning, because returning would leak the retry token and permanently suppress rule 2 if the real recovery later failed (SELF-G). |
| **Does the CLOSE edge fire when `onerror` has already dropped the source? (R3-B2)** | **Yes in v4; NO in v3, which is the blocker round 3 found.** Live `onerror` does `es?.close(); es = null;` at `:476-477` and only then arms the retry at `:510`. Under v3's `!wanted && open` rule the wanted→disabled tick read `{wanted:false, open:false}` ⇒ `NONE`, `closeStream()` never ran, `streamEpoch` was never bumped, and the queued callback — still holding the current epoch — reopened SSE mid-match. v4's rule 1 is `!wanted && (open \|\| pendingReopen)` with `pendingReopen = retryTimeout !== null`, so the edge fires **with `es === null`**. That is the repair; the guards below are what make it total. |
| How are pending SSE retry timers cancelled? | `closeStream()` → `invalidateStream()` clears the closure `retryTimeout` and drops `es`, then resets `retriesRef.current = 0` and `lastAttemptWasBareReopen = false` (closure/ref state at `use-world-stream.ts:474-531`) **and bumps `streamEpoch`** — see the next rows for why the timer clear alone is not enough, and why the epoch alone is not either. |
| **Can a handler from a REPLACED source act on the new one? (R3-B2)** | Not in v4. `rejoinWithTicket()` replaces the source inline at `:285-294` and `handleSuperseded()` at `:186-190`; v3 rotated the epoch at neither, so a callback queued by the previous source shared the successor's epoch. v4 routes every drop through `invalidateStream()` (epoch++) and `openStream` bumps again on construction, so no two sources ever share an epoch. Each handler additionally checks `es === source` — belt and braces on a path that has been wrong twice. |
| **Can a handler run while the downlink is suspended but its epoch is current?** | No. Every listener and every retry continuation checks `downlinkEnabledRef.current`, and the escalation branch re-checks **after** `recoverWithTicket()` resolves (`:517-524`) because an await is a suspension point across which the downlink can be disabled. |
| **Does an ORDINARY enabled SSE error still recover? (R4-B3)** | **Yes in v5; NO in v4, which is the blocker round 4 found.** v4 required every source drop to route through `invalidateStream()` AND required the retry callback to check its captured epoch — so `onerror` invalidated its own continuation and every enabled retry returned early. Normal SSE recovery would have been permanently dead, and the disabled-resurrection test would still have passed, because "no retry runs while disabled" is trivially satisfied when no retry ever runs. v5 splits `dropFailedSource()` (source died, retry owns the reopen) from `invalidateStream()` (stream is over), and the continuation's liveness proof is `activeRetryToken`, not the epoch. §6.2 carries a **positive** test — an enabled error opens exactly one replacement source, after the delay and not before — which is the test whose absence let this through. |
| **Can the 200 ms tick pre-empt the exponential backoff? (R4-B4)** | Not in v5. Rule 2 requires `!pendingReopen`, so while a reopen is owed the edge returns `NONE`. Under v4 the tick would have called `OPEN` immediately after any enabled error, skipping `RETRY_DELAY_BASE = 3000` and the `2^(retries-1)` escalation (`:483-489`) and burning `MAX_RETRIES = 20` (`:22`) in roughly four seconds at five ticks per second. |
| **What covers the window after the retry timer fires but before the rejoin resolves?** | `pendingReopen` is `activeRetryToken !== null`, not `retryTimeout !== null`. The timer nulls itself when it fires; the token stays set across the `recoverWithTicket()` await and is cleared only by `openStream` (the reopen happened) or `invalidateStream()` (the stream is over). One marker, both windows — the v4 definition covered only the armed window (R4-B4). |
| Does resume reopen without resetting room identity/ticket? | Yes. `OPEN` calls `openStream(roomIdRef.current)` directly; `sessionIdRef` and `roomTicketRef` are untouched, so no `/join` is spent — important because the server budget is 3 per 60 s per IP (`:494-495`). |
| Cold `/activity` where `everActive` is false and no world membership exists? | Nothing happens. `decide()` gates `BOOTSTRAP` on `everActive` (`world-stream-machine.ts:99-109`), which is set only by an `'active'` policy tick (`:91-92`). So a cold activity deep-link opens no stream, joins no room, and uploads nothing. On the first exit to `/game`, policy becomes `'active'`, `everActive` flips, bootstrap runs, `openStream` follows — the normal first-boot path. |
| How is an `onerror` racing the intentional close distinguished? | **v2's answer was WRONG and is retracted (R2-M1); v3's TEST for it was also wrong and is retracted (R3-B2).** v2 claimed clearing `retryTimeout` neutralizes an already-queued handler — it does not: the queued handler runs AFTER the clear, falls through `if (recoveryInFlight) return`, and **schedules a NEW timer at `:510`** whose callback reopens the stream. The discriminator is the **`streamEpoch`** captured by `openStream` (§2k). v3 then specified the test as "dispatch the error event, **then run CLOSE**, then let the queued handler run" — but on the real path there **is no CLOSE**, because `onerror` nulled `es` first. §6.2's test is rewritten to the ORDERING THAT ACTUALLY OCCURS: dispatch the error ⇒ `es = null` ⇒ disable the downlink ⇒ let the 200 ms tick run (which now emits `CLOSE` via `pendingReopen`) ⇒ let the retry timer fire. It must open nothing. |
| What stops `bootstrap()` or a 409 recovery from opening SSE mid-match? | The `downlinkEnabledRef` check immediately before the `openStream` calls at `:554` and `:294` (§2k). Both functions still complete their session/room/ticket work, so membership and the 10 s uplink are unaffected; only the SSE open is skipped. |
| SSE-only state that changes while suspended? | The `land` channel (`:470-471`) is the only one. The `OPEN` edge invalidates `LAND_PARCELS_QUERY_KEY`, so a parcel bought during a match is reflected on return instead of surviving as stale for-sale signage. |
| bfcache restore? | A `pageshow` listener with `event.persisted === true` closes the stream and nulls the membership refs, re-arming the machine's BOOTSTRAP branch on the next tick (§2k). Without it a restored activity page keeps a dead session until a later 409 or SSE failure discovers it. |

Leave is still emitted only on unmount and `pagehide` (`:563-577`), so this remains a behavior
IMPROVEMENT over today, where entering an activity leaves the world room and the body despawns.

### 5f. Authoritative WS lifecycle — money integrity

**Frozen rule: `useActivityWs` stays owned by the PAGE.** WS teardown is economically load-bearing:
`{type:'leave'}` (`useActivityWs.ts:319`) sets `internalCloseCode = 1000`
(`activity-ws-hub.ts:402-405`), and the close handler branches on it —
`if (data.internalCloseCode === 1000) { this.notifyForfeit(room, avatarId, 'voluntary'); return; }`
(`:326-330`) — **immediate forfeit, no grace**, versus a `RECONNECT_GRACE_MS = 10_000` timer for any
other close (`:103`, `:333-343`). `notifyForfeit` calls `getReefSim().forfeit(...)` for a live reef
room (`:949-961`). Moving the hook into a resident slot would delete the voluntary-forfeit path.

**v4 amendment (R3-B3).** The hook gains exactly one thing: an idempotent `leaveAndClose()` that
performs the SAME cleanup sequence the unmount path already performs (`:311-333`), callable
explicitly, and nulls `wsRef.current` so the effect cleanup cannot double-send. It exists because a
document navigation (`location.assign`) is not guaranteed to run React cleanup and this file has no
`pagehide` handler — verified by grep at the anchor. It adds no new lifecycle, no new close code,
and no new server behavior; it makes an existing one reachable from one new caller.

| Scenario | Today | After P4 | Server consequence |
|---|---|---|---|
| Enter from `/game` | page mounts → `wsUrl` derived (`:96-103`) → `open()` → auth on `onopen` (`:190-191`) | identical | identical |
| Race runs | 1 Hz ping after the first server frame (`:194-206`); 30 Hz input | identical | identical |
| Leave to world | page unmounts → cleanup → `leave` → close 1000 | **the page unmount is now GATED to occur before fade-in completes (§2d)** | voluntary forfeit, as today |
| Re-enter the same room | new mount, new WS, `reset(roomId)`, `/state` participant gate (`:173-197`) | identical | identical |
| Different room (Play Again) | `roomId` change ⇒ `wsUrl` change ⇒ old socket `leave`+close, new opens; stale-socket guards at `:199`, `:248` | identical, plus the `ActivityRoomRuntime` remount (§2g) and a same-scene stage generation bump | identical |
| Browser back/forward | route change ⇒ page unmount/mount | the outgoing page is held until the commit, and the fade cannot complete before it unmounts (§2d). **There is NO teardown ceiling** — `OUTGOING_OVERLAY_COMMIT_TIMEOUT_MS` reports a stall, it does not resolve one (R2-B3). v3's row still cited it as a bound; corrected here (R3-m2). | leave arrives later than today — see §8.4 for the honest bound, which is deliberately open-ended |
| **Stalled crossing, player picks Hard navigate** (new in v4) | n/a | `leaveAndClose()` queues `{type:'leave'}` on the OPEN socket and closes 1000, then `location.assign` tears the document down | **Best-effort.** Frame received ⇒ `internalCloseCode = 1000` (`activity-ws-hub.ts:403`) ⇒ immediate `'voluntary'` forfeit (`:327-328`), as today. Frame lost ⇒ ordinary close ⇒ the existing `RECONNECT_GRACE_MS = 10_000` window (`:103`) ⇒ `'timeout'` forfeit (`:341-342`). The lost-frame outcome is strictly GENTLER, so the failure direction is safe. |
| Mid-race network disconnect | `onclose` non-fatal ⇒ `scheduleReconnect()` within a 10 s grace (`:282-307`) | identical | 10 s grace then `'timeout'` forfeit — identical |
| Fatal close (4001/4003/4004) | `status='closed'` ⇒ MATCH EXPIRED panel (`:357-368`) | identical, and the panel is now a readiness terminal branch so the fade lifts onto it | identical |

**Integrity claim, with scope.** `issueRewardsForRoom` (`reward-pipeline.ts:307`) and its one
`activity.match.placed` per participant (`:298`) run entirely server-side, keyed by room, and are
anchored by the unique result insert (`:503-511`) so a duplicate suppresses both the mint and the
event. P4 changes no API route, wire type, or WS frame. The reward and leaderboard paths are
therefore unchanged **provided** the WS lifecycle above is unchanged — which page-ownership
guarantees and §6.7 verifies with a real race row-diffed against `origin/staging`.

### 5g. Postprocessing scoping — plan contract 6

| Object | Where | Scope after P4 |
|---|---|---|
| `EffectComposer` | `surf-bloom.tsx:62`, `useMemo` keyed `[gl, scene, camera]` (`:74`) | inside the reef `<Canvas>`; disposed at `:82-84` |
| `RenderPass(scene, camera)` | `:63` | same; the composer rebuilds on any of its three keys |
| `UnrealBloomPass` | `:64-71`, params pushed per frame from `WATER_TUNING` (`:91-96`) | same |
| `composer.setPixelRatio(min(dpr,1.5) * 0.5)` | `:81` | same |
| `useFrame(…, 1)` render takeover | `:100` | **confined to the activity canvas.** Its R3F root owns its own `internal.priority`; the stage's stays 0 (or is paused). This is how Option B satisfies contract 6 — postprocessing cannot leak onto world/cove/kelp frames because it is not in their canvas. |
| Bumper postprocessing | none (`BumperShellsScene.tsx:23`) | n/a |

### 5h. Readiness rules — B3 + R2-B1 + R2-B2b (ordered; first match wins)

| # | Condition | Decision | Why |
|---|---|---|---|
| 1 | `pendingGeneration === null` | `WAIT:'no-pending-request'` | Nothing to ack. Covers the cold-deep-link ordering hole: the subscription re-fires when the request appears. Also the honest answer after a chunk Try-again whose terminal ack already completed the transition (R2-B2b). |
| 2 | `targetRoomKey !== null && roomKey !== targetRoomKey` | `WAIT:'wrong-room'` | **R2-B1.** This room is not the destination — it may not acknowledge, by ANY route. Placed above the terminal and painted rules so neither can be reached by an outgoing room. |
| 3 | `ackedKey === \`${pendingGeneration}:${recoveryCount}:${attemptNonce}\`` | `WAIT:'already-acked'` | Idempotence. Because `attemptNonce` is in the key, a page-owned recovery attempt revokes the ack rather than being swallowed here (R2-B2b). |
| 4 | `terminalBranch !== null && terminalRoomKey === roomKey` | `ACK` | A lobby / status panel / MATCH EXPIRED / chunk-error / canvas-lost render is a legitimate destination; the fade must lift onto it. Room-scoped: a terminal branch belonging to another room is inert (R2-B1). |
| 5 | `paintedRoomKey === roomKey` | `ACK` | The Canvas for THIS room has composed, and rule 2 has already established it IS the destination. Fires for a watchdog retry / renderer recovery / same-destination generation **without a Canvas remount** — the v1 defect. |
| 6 | otherwise | `WAIT:'not-painted'` | New room, Canvas not yet painted. |

**`targetRoomKey === null` is deliberately permissive** (rule 2 no-ops): it means no `activity`
request has been minted through §2m yet, which happens only before the first activity crossing of a
session. Rules 4 and 5 still require the page's own `roomKey` to own the signal, so the failure mode
of a missing target is "waits for its own paint", never "acks for someone else".

### 5i. Outgoing-overlay handoff — B2 + R2-B3 (ordered)

| # | At | Condition | Action |
|---|---|---|---|
| 1 | `handleTransitionOpaque(request)` | displayed path's slot has `overlayOpaque` AND `request.sceneId` differs | `setOutgoingOverlay({ pathname, href, requestId })` **before** `commitStageNavigation` |
| 2 | `handleTransitionOpaque(request)` | same-scene (`activity → activity`) | no gate needed — §2b rule 2 makes the outgoing room structurally unable to ack the incoming destination (R2-B1; v2's justification for this row was unsound and is replaced) |
| 3 | fade-in gate | `outgoingOverlay?.requestId === pendingRequest.requestId` | hold at `awaiting`, **regardless of `status`** |
| 4 | children-swap effect | `displayedPathRef.current !== outgoingOverlay.pathname` | `clearOutgoingOverlay(requestId)`; the activity page has unmounted and `leave` has gone out |
| 5 | +10 s | still `status: 'holding'` | `markOutgoingOverlayTimedOut(requestId)` + `console.warn`. **Unmounts nothing, emits no `leave`, clears no gate, and does NOT call `noteRecovery` (SELF-B).** The page renders `<ActivityHandoffRecovery>` (**two** actions, §2d item 4). |
| 6 | recovery: **Hard navigate** (primary) | user action | `leaveAndClose()` on the activity WS (§1a), then `window.location.assign(href)`. Document teardown is guaranteed; the `leave` FRAME is best-effort and its loss degrades to the 10 s reconnect grace (§5f, §8.4). |
| 7 | recovery: **Retry** (secondary) | user action | bump `attemptNonce`; `requestWorldStageNavigation({ to: href })` with the stored href. Best-effort by construction — it re-attempts, it does not cancel. |
| 8 | ~~recovery: **Stay**~~ | — | **REMOVED in v4 (R3-B3).** `commitStageNavigation` (`WorldStageRoot.tsx:165-176`) keeps no handle on the issued `router.push`/`replace` and the App Router exposes no cancellation, so "Stay" could only mutate the stage store while the stalled navigation stayed live and could commit afterwards — unmounting the match **after** the cover was released, which is the exact failure §2d exists to prevent. Nothing replaces it: the match is already never torn down by the stall, so waiting is safe and needs no button. |
| 9 | `resetStage()` / root unmount | any | clear |

---

## 6. Offline smoke-test plan

All local runs use `bun run build && bun run start`. **`bun run dev` is never run.**

### 6.1 Build + typecheck

- [ ] `bun run build` — exit 0.
- [ ] `bun run typecheck` — 12/12 packages, 0 errors.
- [ ] **B6 explicit:** `navigateOut('/game?quickQueue=reef-race')` typechecks under
      `WorldStageHref`, and the three existing `requestWorldStageNavigation` call sites (cove page,
      kelp page, `arena-buildings.tsx navigateToCove()`) compile with **zero edits** — the widening
      must be a pure superset.
- [ ] **NEW — the diff-scope gate (R3-M1).** `git diff --name-only <merge-base> HEAD` must list
      **exactly one** path under `apps/web/src/lib/three/activities/reef-race/`, namely
      `ReefRaceScene.tsx`, and **exactly one** under `.../bumper-shells/`, namely
      `BumperShellsScene.tsx`. Any other file in either directory fails the gate. This is the
      mechanical form of §1f's promise, and it is what replaces the deleted
      `_renderedPoseByAvatar` baseline test: rather than measure private module state to infer that
      reef behaves the same, prove that reef's code is byte-unchanged. Binary, cheap, and it can be
      wired as a CI check or run by hand before push. *(It is a diff assertion, not a unit test, so
      it is counted in §6.1 and NOT in §6.2's 270.)*

### 6.2 New unit tests (270)

**Derivation, stated inline so the arithmetic is checkable at a glance (R2-m1(b), R3-m1):**

`stage-scene-id-for-pathname` **24** + `activity-readiness` **31** + `ActivityCanvasReadyProbe`
**8** + `stage-outgoing-overlay` **81** + `stage-navigation-ownership` **5** +
`stage-activity-slot` **15** +
`ActivitySceneErrorBoundary` **11** + `activity-room-runtime` **11** + `world-downlink-policy`
**64** + `held-key-listeners` **17** + `kelp-walkin-guard` **+3** = **270**.

Running sum, in the order listed: 24 → 55 → 63 → 144 → 149 → 164 → 175 → 186 → 250 → 267 → **270**.

**Every heading below equals the sum of its own bullets**, and any bullet that describes more than
one case carries an explicit **(n)**. That is the mechanical property that failed in v1, v2 **and
v3** — three consecutive rounds — so the running sum is written out above and each suite heading is
checkable against its own bullets by inspection rather than by trust.

**Honest reconciliation, in fifteen steps.**

1. **v2's declared 86 was wrong.** Its own §6.2 headings summed to 14+16+7+11+13+7+9+9+8 = 94,
   plus the 2 kelp amendment cases = **96**. Round 2's recount to 96 is correct and is accepted.
2. **v2's headings were themselves short of v2's own bullets**, in four suites: scene-id declared
   14 for 18 bullet-cases, readiness 16 for 17, slot 13 for 14, downlink 9 for 10. Counting v2's
   bullets rather than v2's headings gives **103** — that is the true like-for-like baseline.
3. **v3 added 26 net cases, all round-2 repair work**, and 103 + 26 = **129** — but v3's *header*
   declared 111, and its ledger row declared 111 too. Round 3 recounted the headings to 129 and was
   right. The v3 breakdown, kept because the suites still carry those cases: readiness +6, probe +1,
   overlay +7 net, boundary +4, room-runtime +2, downlink +5, held-key +1 = 26.
4. **v4 deletes 1 and adds 17, net +16.** R4-M1 corrected this line: v4 stated it two different
   ways — "17 added" enumerated as 6+5+5 = 16 in the ledger row, and "adds 16" enumerated as
   6+6+5 = 17 here. The correct pairing is **deletes 1, adds 17, net +16**, and both statements now
   use that form.
   - **−1 room-runtime** — the `_renderedPoseByAvatar` baseline is DELETED (R3-M1, and SELF-E showed
     the defect it measured does not exist). **v4's only deletion.**
   - **±0 overlay rewrites** — v3's `Stay` case becomes the "Stay is gone" case, and v3's Hard
     navigate case is rewritten against `leaveAndClose()` instead of the non-existent `pagehide`
     beacon. Two cases in, two cases out: **no effect on the count**, which is exactly the kind of
     substitution that produced the wrong totals in earlier rounds when it was mis-booked as a
     deletion plus an addition.
   - **+6 scene-id** — `stageDestinationKey`: three no-sub-identity slots, two distinct activity
     rooms, one non-stage null (R3-B1).
   - **+6 overlay/navigation** — pathname-first A→B mints a request, A is retained to the midpoint,
     B's paint gates the fade, the (v5-deleted) non-activity scope pin, the parked-children
     destination match (R3-B1 + SELF-C), and the §2g `leaveRef` handle-lifetime case carried as the
     second case on the rewritten Hard-navigate bullet.
   - **+5 downlink** — `pendingReopen` CLOSE, the epoch+enabled dual guard, source ownership,
     `rejoinWithTicket` epoch rotation, `handleSuperseded` epoch rotation (R3-B2).

   6 + 6 + 5 = **17 added**, 1 deleted, net **+16**, and 129 + 16 = **145**. Per suite: scene-id
   18→24, overlay 18→24, room-runtime 11→10, downlink 15→20.

5. **v5 deletes 1 and adds 23, net +22**, all round-4 repair of v4 regressions:
   - **−1 overlay** — the "non-activity scope pin (the tautology)" case is DELETED, because the
     tautology it asserted is FALSE (R4-B1/SELF-F). It is replaced by real handler-owned crossing
     tests rather than patched. **v5's only deletion.**
   - **+9 overlay** — R4-B1: three handler-owned crossings under the real router-after-midpoint
     ordering **(3)**, handler-owned activity A→B, the late-commit-after-`idle` case, and the
     midpoint-is-destination-scoped case; R4-B2: B→C before the midpoint, B→C after the midpoint,
     and the cleared parked navigation.
   - **+5 ownership** — an entirely new suite for `decideStageNavigationOwnership` (R4-B2): two new
     SUPERSEDE verdicts, the unchanged same-destination verdicts **(2)**, and the null-input
     fallthrough.
   - **+9 downlink** — R4-B4: the `!pendingReopen` rule-2 pin, ticks-during-backoff, and the
     async-window `pendingReopen` case; R4-B3: the POSITIVE enabled-error recovery test, the
     token-invalidated-by-every-stream-ending-path cases **(4)**, and the post-`await` re-guard.

   9 + 5 + 9 = **23 added**, 1 deleted, net **+22**, and 145 + 22 = **167**. Per suite: overlay
   24→32, ownership 0→5, downlink 20→29; the other eight suites are unchanged.

6. **v6 deletes 0 and adds 10, net +10**, all round-5 repair of two pre-existing ownership races:
   - **+4 overlay** — R5-B1: the stale-commit-before-C's-midpoint headline case, the same landing
     after C's midpoint, the pathname-driven variant, and the never-superseded negative case.
   - **+6 downlink** — R5-B2: rule 2 defers to `recoveryInFlight`, `recoveryInFlight` is not folded
     into rule 1, disable→CLOSE→re-enable during recovery on the success path and on the failure
     path, armed escalation colliding with a 409 recovery, and SELF-G's busy⇒re-arm case.

   4 + 6 = **10 added**, **0 deleted**, net **+10**, and 167 + 10 = **177** *as v6 declared it*.
   **v6's declaration was wrong by one (R6-m1):** SELF-G's bullet described two cases — recovery
   success, then a repeat with recovery failure — but carried no `**(2)**` weight, so the downlink
   suite was 36 not 35 and the correct v6 total is **178**. v7 builds from 178.

7. **v7 deletes 0 and adds 13, net +13**, all round-6 repair, plus the one weight correction above:
   - **+6 overlay** — INVARIANT N (§2m-A): stale B lands after C is ISSUED (the case v6 could not
     pass), pathname-first URL repair, C completes while B never lands, a later legitimate B
     traversal after that non-landing, bounded retirement by age and by count **(2)**, and the
     settlement-identity pin. *(Three v6 bullets were REWRITTEN in place onto the ledger — headline
     stale-B, stale-B-after-midpoint, and the pathname-driven variant — which is net 0.)*
   - **+7 downlink** — INVARIANT R (§2k-A): the bare-reopen branch refuses while busy (the v6 hole),
     multiple expiries during one unresolved recovery, exactly one recovery-owned open on success,
     exactly one fallback open after failure, the busy-wait ceiling and ownership transfer, the
     escalation branch being unreachable while busy, and SELF-H's `bootstrap()` proof.

   6 + 7 = **13 added**, **0 deleted**, net **+13**, and 178 + 13 = **191** *as v7 declared it*.

8. **v8 first CORRECTS v7's weighting, then adds.** Round 7 showed the v7 total obeyed its printed
   weights but not the frozen counting rule, and that my round-6 "all 155 bullets audited" claim was
   not supported — it scanned a lexical cue list instead of applying the rule. The v8 re-audit is
   scripted (it prints every bullet with its weight; the output is what produced the numbers below)
   and **every defect is fixed by weighting UP, never by arguing a minimum down**:

   | Suite | v7 declared | Corrected | Weight defects fixed |
   |---|---:|---:|---|
   | activity-readiness | 23 | **31** | ten terminal values were **(4)** → **(10)**; same-scene request and cold-deep-link ordering are two drives each |
   | outgoing overlay | 42 | **44** | `/cove`+`/kelp` scope pin; "surface appears" own-vs-other `requestId` |
   | stage-activity-slot | 14 | **15** | pause-ordering builds a second variant that must FAIL |
   | activity-room-runtime | 10 | **11** | `LobbyLanding` room-change and unmount are two setups |
   | world-downlink-policy | 43 | **45** | `!hasSession`/`!hasRoom`; `persisted` true/false |
   | held-key-listeners | 9 | **16** | code/key, both guards, both consumers, true/false, and four reset events |

   **+21 from weighting alone**, so the honest v7 figure is 191 + 21 = **212**. Four of these six
   were named by round 7; the other two (slot, room-runtime) I found in the re-audit.

   Then v8's own changes — **deletes 1 bullet (weight 2) and adds 18**:
   - **−2 / +14 overlay** — DELETED: v7's "bounded retirement" bullet, which asserted a retired
     landing settles as `null` and becomes a fresh arrival, i.e. it **pinned the R7-2 defect**.
     ADDED: retired-and-count-evicted both stale **(2)**, tombstone-ring overflow, reset/unmount
     cleanup **(2)**, the three same-destination B₁/B₂ orderings, unissued-landing unchanged **(2)**,
     strip-preserves-URL, `issued-settled` idempotence, full-URL repair, and same-path-wrong-query.
   - **+4 downlink** — R7-4: `/join` that never settles is bounded and recovers; a late completion
     is inert; the `JOIN_TIMEOUT_MS < RECOVERY_WAIT_CEILING_MS` ordering pin; and the declared
     bootstrap-scope case.

   14 + 4 = **18 added**, 1 bullet (**2** cases) deleted, net **+16**, and 212 + 16 = **228**
   *as v8 declared it*.

9. **v9 corrects the basis TWICE more, then adds.** Round 8 found two weights v8's own re-audit still
   missed — both real, both in bullets whose text enumerates two setups:

   | Suite | v8 | Corrected | Weight defect |
   |---|---:|---:|---|
   | kelp-walkin-guard | +2 | **+3** | §1b amends **two** rules (3 and 4); the first bullet covers both |
   | held-key-listeners | 16 | **17** | the equivalence bullet asserts both consumers |

   So the honest pre-v9 basis is 228 + 2 = **230**, and the full chain from the last independently
   verified figure is: **v7 printed 191 → +23 reweighting → 214 → v8 deletes 2, adds 18 → 230.**
   *(191 + 23 = 214 is round 8's derivation and it is accepted verbatim; v8's own step-8 table
   accounted for 21 of those 23.)*

   One bullet is **narrowed rather than weighted**: the ownership suite's "Either destination key
   null/omitted" becomes "**Both** omitted", because `WorldStageRoot` is the only caller and it
   passes both or neither, so the mixed configurations are unreachable. That keeps the suite at 5
   and removes the ambiguity instead of inventing coverage for a state that cannot occur.

   Then v9's own changes — **deletes 2 bullets (1 case each) and adds 14**:
   - **−1 / +10 overlay** — DELETED: v8's "`issued-settled` idempotence" bullet, which asserted that
     `history.replaceState` does not update `useSearchParams()` — **false on `next@16.2.3`** (R8-B2).
     ADDED: the strip-re-enters guard, no-strip-after-repair, the three R8-B1 same-destination cases,
     the four R8-B3 provenance/lifetime cases, and the R8-M1 commit-options case.
   - **−1 / +4 downlink** — DELETED: v8's single "late `/join` completion is inert" bullet, which
     could not honestly coexist with the permanently-pending test. ADDED: late success and late
     `{superseded:true}` as separate branches, the independent-deadline case with a signal-ignoring
     fetch, and lease-1-cannot-clear-lease-2.

   10 + 4 = **14 added**, 2 bullets (**2** cases) deleted, net **+12**, and 230 + 12 = **242**.
   Per suite: overlay 56→65, downlink 49→52, held-key 16→17, kelp +2→+3; the other seven suites are
   unchanged. **Round 9 verified this independently — every heading matched its explicit weights and
   the 230→242 chain reconciled. It is the first fully clean count in nine rounds, and the basis for
   step 10 needs no correction.**

10. **v10 deletes 0 and adds 23** — all of it the adversarial coverage round 9 found missing, which
    it explicitly said could not hide inside 242:
    - **+12 overlay** — R9-B1: the four `acceptNavigationIntent` call sites **(4)** and the
      same-destination handler paths through `ADOPT` and `EXECUTE_NOW` **(2)**; R9-B2: the
      legitimate-landing-while-armed case and the own-rerun/one-shot pair **(2)**; R9-B3: an
      outstanding issue landing after a real root remount, and the frozen document-scoped semantic
      **(2)**. *(Four bullets were REWRITTEN in place at net 0 — the impossible two-live test, both
      B₁/B₂ orders now driven to completion, and two stale destination-settlement passages.)*
    - **+11 downlink** — R9-B4: both arms through the CAS with the refusal executing, a refused late
      success opening no source, the seven-cell exactly-once settlement walk **(7)**, the single
      dispatch site, and the deadline-timer clear.

    12 + 11 = **23 added**, **0 deleted**, net **+23**, and 242 + 23 = **265**. **Round 10 verified
    this independently — every heading matched its explicit weights and the 242→265 chain
    reconciled, with no arithmetic REOPEN.**

11. **v11 adds 3, deletes 0**, all of it round-10 coverage:
    - **+2 overlay (R10-B1)** — a legitimate landing at the IDENTICAL nonce-free URL is not
      swallowed, and rapid successive strips do not cross-suppress. These are exactly the cases a
      URL-equality guard could never fail, which is why it needed causal identity.
    - **+1 overlay (R10-M2)** — the obsolete `resetStageNavigationLineage()`-clearing bullet
      (weight 1) is REPLACED by the stale-before-remount bullet (weight **2**): issue B, accept C,
      remount, land B ⇒ `issued-stale`, no mint, repair C, complete C — repeated across a
      `resetStageStore()` epoch bump.
    - **±0 overlay (R10-M1)** — the contradictory "reset and unmount CLEAR the lineage" bullet is
      rewritten to assert PRESERVATION, keeping its weight of 2. It demanded the opposite of the
      frozen semantic and would have made the R9-B3 remount repair untestable.
    - **±0 downlink (R10-M3, R10-m1)** — the `Promise.race`-shape test is rewritten against the
      deferred; "exactly one transition in all seven cells" becomes "at most one — exactly one for
      an accepted non-cancelled settlement, zero for cancellation and for a refused loser"; and the
      CAS refusal test is scoped to deadline-first with a separate operation-first assertion.

    2 + 1 = **3 added**, **0 deleted**, net **+3**, and 265 + 3 = **268**. **Round 11 confirmed
    the printed headings sum to 268, and flagged that one bullet carried a second undeclared drive —
    see step 12.**

12. **v12 adds 4, deletes 0**, and resolves the flagged bullet by REMOVING its duplicate imperative
    rather than weighting it (R11-7), so the 268 basis is unchanged:
    - **+3 overlay (R11-1, R11-2)** — the v11 "rapid successive strips" bullet is REWRITTEN as the
      serialized-protocol suite: overlapping strips are queued not applied (driving the exact
      ordering round 11 found), the queued strip is released on acknowledgement, and a rerun that
      never arrives cannot wedge the queue. Plus a new payload test asserting `replaceState`
      receives **exactly** `{__wsStrip: marker}` — no `__NA`, no `_N`, nothing spread.
    - **+1 downlink (R11-3)** — the bootstrap-timeout bullet gains a second drive and weight **(2)**:
      release attempt 1's raw result AFTER attempt 2 succeeds and assert no late ref write, no
      second `BOOTSTRAP_OK`, no second source. This replaces the removed `bootstrapGeneration`
      mechanism, proving the property the machine's existing single-flight guard already provides.
    - **±0 downlink (R11-7)** — the deadline-first CAS bullet loses its redundant "assert separately
      that OPERATION-FIRST…" imperative; that assertion already exists in its own bullet.

    **The honest basis is 269, not 268 (R12-2/R13-3).** v12 deletes the redundant operation-first
    drive (−1) and adds four cases (+4), net **+3** from the honest v11 basis 269 → 272. Round 11 established that v11 was semantically 269
    because the deadline-first bullet carried an undeclared operation-first drive. v12 REMOVED that
    drive rather than weighting it, which is a deletion of one semantic case. So:

    **honest v11 basis 269 − 1 (the removed operation-first drive) + 4 (the v12 cases) = 272.**
    Net **+3**, not +4 from 268. Per suite: overlay 80→83, downlink 63→64.

13. **v13 deletes 10 and adds 0** — the round-12 scope ruling, executed:
    - **−10 overlay** — every test of in-session stripping is DELETED with the machinery: the
      serialized-queue trio (queued-not-applied, release-on-acknowledgement, ack timeout), the
      payload assertion, the same-href and no-nonce-rerun cases, the settled-replay strip, the
      foreign-branch strip, and the two v10-era guard cases. **Landing classification, not stripping, carries correctness; v15's final six outcomes are defined exclusively by the seven-row table.**
      *(R13-3: v13 claimed EVERY strip test was deleted; three survived and are removed in v14, and
      the provenance contract adds six cases the deletion exposed.)*
    - **±0 everywhere else.** The deletion removes no correctness: stripping ran AFTER a landing was
      already classified and never decided anything.

    **0 added, 10 deleted, net -10**, and 272 - 10 = **262**. Per suite: overlay 83->73; the other
    ten suites are unchanged. *(The first round whose total goes DOWN.)* **R13-3 correction: three
    strip-dependent cases SURVIVED this pass, so "every strip test was deleted" was false; v14
    removes them.**

14. **v14 deletes 4 and adds 6** - the round-13 provenance contract:
    - **-4 overlay** - the three strip-dependent cases R13-3 caught (the no-strip test, the weight-2
      one-shot guard test, and the stale-strip assertion inside an operative test), plus the obsolete
      guard case in the section-8 algorithm.
    - **+6 overlay** - the frozen contract: settled back/forward BEFORE eviction (the flagged
      `issued-settled` defect - it must FALL THROUGH, not return), settled back/forward AFTER
      eviction, same-document saved-URL replay under both horizon states **(2)**, a late superseded
      landing within the horizon still repairing, and the accepted residual asserted as SPECIFIED
      behavior rather than left to be discovered.

    6 - 4 = net **+2**, and 262 + 2 = **264**. Per suite: overlay 73->75; the other ten suites are
    unchanged. **R14-3 correction: that -4/+6 history is WRONG.** The true v13->v14 identity was
    **-5/+7**: removed were the repaired-stale no-strip test (1), the one-shot guard test (2), the
    live-issue-across-remount test (1), and the R3-B1 pathname-first A→B mint test (1); added were
    the six contract cases plus the foreign-epoch pin (7). **Two of those removals were silent** —
    I deleted them by text match without accounting for what they covered, and the total still
    balanced, which is exactly why a balanced total is not evidence the right tests are present.

15. **v15 deletes 1 and adds 7** - round-14 propagation and the residual ruling:
    - **-1 overlay** - the tombstone-overflow-is-stale test, which contradicted the frozen traversal
      contract (R14-1).
    - **+1 overlay** - the R3-B1 pathname-first A→B mint test **RESTORED**; it is the antecedent two
      later bullets refer to as "that same traversal", and its absence is why they dangled (R14-3).
    - **+3 overlay** - the `issuedHighWater` boundary in all three regions: below, **at** (inclusive),
      and above the mark **(3)** (R14-1a).
    - **+1 overlay** - the predicate is issue-recorded, not scan-derived: the settle-and-evict-2-while-
      1-is-retained interleaving that a minimum-retained-sequence scan gets wrong (R14-1a).
    - **+2 overlay** - the probe gate, both directions **(2)** (R14-2b).
    - **±0** - the R8-B3 remount drive is EXPANDED in place (land an outstanding pre-unmount issue as
      `issued-live`, settle, install, then check epoch/sequence); weight stays 1 (R14-3).

    7 - 1 = net **+6**, and 264 + 6 = **270**. Per suite: overlay 75->81; the other ten suites are
    unchanged.

**The weight audit — v7's version was too weak and the claim is withdrawn (R7-5).** v7 said "every
bullet was scanned"; what it actually did was grep for a lexical cue list (*then repeat*, *(a)…(b)*,
…) rather than apply the semantic rule it had just frozen. That found four candidates and missed six
real defects, four of which round 7 then named. **v8 replaces the claim with a reproducible
artifact:** a script prints every bullet in §6.2 with its current weight, and each is judged against
the rule below by reading the bullet, not by pattern-matching its wording. The six corrected suites
are tabled in step 8 above. A round-9 reviewer should re-run that dump rather than trust this
paragraph — the lesson of R7-5 is that an audit claim is worth nothing without the output.

**The counting rule, stated so it can be applied mechanically:**

> A bullet counts as **N** cases when it requires **N distinct setups or drives**. Multiple
> assertions about the outcome of ONE drive are ONE case, however many clauses they contain.

By that rule "produces a NEW `requestId` AND a new generation" is one case (one drive, two
assertions), while SELF-G's "…then repeat with the real recovery FAILING" is two (two drives). Any
bullet whose prose contains a second imperative — *then repeat*, *and again*, *(a)…(b)*, *for each
of* — needs an explicit weight.

**Neither v6 nor v7 deletes anything** — both are additions only, which is why their
"deletes N, adds M, net +K" lines are the simplest of the seven. Round 5 verified 167 independently
(suites, running sum, and the v4→v5 delta all reconciled), and round 6 verified the v6 arithmetic
and corrected it to **178**; **191 is that figure plus v7's thirteen.** Round 6 also confirmed the
running sum and the per-suite reconciliation, so the only figure v7 introduces from scratch is its
own delta.

**Two of v5's additions exist precisely because their absence caused a regression**, which is the
pattern SELF-F names: the handler-owned crossing tests (v4 added a conjunct to shared transition code
with no negative test) and the POSITIVE enabled-error recovery test (a "nothing happens while
disabled" assertion passes trivially in a design where nothing ever happens). Both are marked in
their suites with what they fail against.

The per-suite headings above are the contract; this prose is the audit trail for how they moved.

**`stage-scene-id-for-pathname.test.ts` — URL matrix + destination keys (24)**

*(Bullets carry an explicit case count wherever one bullet describes several cases, so the bullet
sum equals the heading — R2-m1(b).)*

- [ ] `/game`, `/cove`, `/kelp` → their ids. **(3)**
- [ ] `/activity/reef-race/abc`, `/activity/bumper-shells/abc` → `'activity'`. **(2)**
- [ ] `/activity`, `/activity/reef-race`, `/activity/a/b/c`, `/activity//abc` → `null`. **(4)**
- [ ] `/cove/history`, `/cove/verify`, `/game/x` → `null` (the sub-routes stay outside the group).
      **(3)**
- [ ] **B6 matrix:** `stagePathnameFromHref` maps `/game?quickQueue=reef-race`,
      `/game#x`, `/activity/reef-race/abc?shortCode=Q7X3RT`, and
      `/activity/reef-race/abc?invite=X#y` to the right pathnames, and each then maps to the right
      slot id. **(4)**
- [ ] Trailing-slash inputs (`/game/`, `/activity/reef-race/abc/`) return `null` rather than a
      wrong id. **(2)**
- [ ] **R3-B1 — `stageDestinationKey` is the identity for no-sub-identity slots:** `/game` →
      `'world'`, `/cove` → `'cove'`, `/kelp` → `'kelp'`, i.e. it EQUALS `sceneIdForPathname` for all
      three. **What this pins (restated in v6 per R5-m3): the OWNERSHIP contract** — it is the
      property that makes §2n's new SUPERSEDE branch dead for the P1b/P3 routes and makes
      `pendingDestinationKeyRef` equality collapse to the anchor's scene check, both of which compare
      operands produced by this function inside one expression. **It pins nothing about opacity.**
      v4 read this same identity as licence for a cross-clock `destinationKey === displayedKey`
      comparison and wedged every handler-owned crossing (R4-B1); v5 deleted that conjunct, so any
      prose here describing "§2m's added conjunct" is obsolete. **(3)**
- [ ] **R3-B1 — activity rooms are distinguishable:** `stageDestinationKey('/activity/reef-race/A')`
      is `'activity:reef-race:A'` and differs from the same call for room `B`, while
      `sceneIdForPathname` returns `'activity'` for both. **(2)**
- [ ] **R3-B1 — non-stage pathname:** `stageDestinationKey('/leaderboard')` returns `null` — it is
      total only over stage pathnames, and a caller must treat `null` as "not a stage route". *(The
      malformed activity depths are already covered above; `stageDestinationKey` delegates to
      `sceneIdForPathname` for them, so re-asserting each would be duplicate coverage.)* **(1)**

**`activity-readiness.test.ts` — B3 + R2-B1 + R2-B2b (31)**

- [ ] One test per §5h rule. **(6)**
- [ ] **Silent retry:** Canvas already painted for `roomKey`, destination unchanged;
      `pendingGeneration` bumps ⇒ `ACK` with the NEW generation, no remount. *(The v1 defect.)*
- [ ] **Renderer recovery:** same generation, `recoveryCount` bumps ⇒ new `ackKey` ⇒ `ACK`.
- [ ] **Same-scene request:** activity→activity generation bump with a stale `paintedRoomKey` ⇒
      `WAIT`; after the new paint in the new room ⇒ `ACK`. **(2)** *(R7-5: two drives.)*
- [ ] **Cold deep-link ordering:** first evaluation with `pendingGeneration === null` ⇒ `WAIT`;
      re-evaluation after the request appears ⇒ `ACK`. **(2)** *(R7-5: two drives.)*
- [ ] Stale-room paint (`paintedRoomKey` = old room) never acks.
- [ ] Each of the ten `ActivityTerminalBranch` values acks under rule 4, folded into parameterized
      tests. **(10)** *(R7-5: weighted (4) through v7 — ten values are ten setups.)*
- [ ] Purity: identical inputs ⇒ identical outputs; the module holds no state.
- [ ] Double evaluation with the same inputs acks exactly once.
- [ ] **R2-B1, painted route:** activity A → activity B. `roomKey = A`, `paintedRoomKey = A`,
      `targetRoomKey = B`, `pendingGeneration` = B's ⇒ `WAIT:'wrong-room'`, NOT `ACK`.
      *(Fails against v2.)*
- [ ] **R2-B1, terminal route:** same setup with `terminalBranch = 'closed'` and
      `terminalRoomKey = A` ⇒ `WAIT:'wrong-room'`, NOT `ACK`. *(Fails against v2.)*
- [ ] **R2-B1, target survives retry:** `targetRoomKey` unchanged across a generation +
      `requestId` bump ⇒ the destination room still `ACK`s (pins that the target is scene-keyed,
      not requestId-keyed).
- [ ] **R2-B2b, revocation:** with a pending generation and a prior `ackedKey`, bumping
      `attemptNonce` ⇒ `WAIT:'not-painted'` (the ack is genuinely revoked). *(Fails against v2,
      which returned `'already-acked'`.)*
- [ ] **R2-B2b, corrected post-retry assertion:** with `pendingGeneration === null` (the terminal
      ack already completed the transition), a Try-again ⇒ `WAIT:'no-pending-request'`.
      *(This REPLACES v2's unpassable "after retry ⇒ `not-painted`".)*
- [ ] **Permissive null target:** `targetRoomKey === null` ⇒ rule 2 no-ops and the page still
      waits for its own paint; it never acks on another room's behalf.

**`ActivityCanvasReadyProbe` — B1 + R2-B2c (8)**

- [ ] **The probe registers with NO priority**: after mount, the R3F root's `internal.priority`
      is `0`. *(Fails against v1's `useFrame(cb, 2)`.)*
- [ ] **Bumper draw assertion:** in a Bumper-shaped canvas (no manual render owner),
      `gl.info.render.calls > 0` at ack time.
- [ ] **Reef ordering:** in a canvas that also has a priority-1 manual renderer, the ack microtask
      runs AFTER that renderer's callback.
- [ ] Fires on the second frame, not the first.
- [ ] Fires exactly once per mount even across 100 frames.
- [ ] Reports its own `roomKey`.
- [ ] Unmount before the second frame ⇒ never fires.
- [ ] **R2-B2c:** `onCanvas` publishes `gl.domElement` on mount and `null` on cleanup, and the
      published element is the same node the R3F root rendered.

**`stage-outgoing-overlay.test.tsx` — B2 + R2-B1 + R2-B3 + R2-M2 + R3-B1/B3 + R4-B1/B2 + R6-B1/B2 + R7-1/2/3 + R8-B1/B2/B3/M1 + R9-B1/B2/B3 + R10-M1/M2 + R13-1 + R14-1/2/3 (81)**

- [ ] Leaving an `overlayOpaque` route sets `outgoingOverlay` before `router.push` is called.
- [ ] Fade-in is held at `awaiting` while it is set for the current `requestId`.
- [ ] Fade-in proceeds once the children swap clears it.
- [ ] **Scope pin:** a `/cove` and a `/kelp` request are unaffected — `outgoingOverlay` is never set
      and the fade-in gate behaves byte-identically to P3-as-landed. **(2)** *(R7-5: two route
      setups.)*
- [ ] A stale `outgoingOverlay` from a superseded request does not block a NEW request
      (`requestId` mismatch).
- [ ] Same-scene `activity → activity` does NOT set it (§5i rule 2).
- [ ] `resetStage()` clears it.
- [ ] **The money-timing pin:** with a mock WS, the `leave` frame is observed BEFORE
      `transition.phase` reaches `fadingIn`. *(Fails against v1.)*
- [ ] **R2-B3 — the timeout holds:** at 10 s the entry flips to `status:'timed-out'`, the outgoing
      children are **still mounted**, the fade is **still held at `awaiting`**, and the mock WS has
      recorded **no `leave` frame**. *(Fails against v2, which unmounted and forfeited.)*
- [ ] **R2-B3 — the surface appears:** the page renders `<ActivityHandoffRecovery>` once
      `status === 'timed-out'` for its OWN `requestId`, and does NOT render it for a different
      `requestId`. **(2)** *(R7-5: two setups.)*
- [ ] **R3-B1 — pathname-first A→B MINTS a request (restored, R14-3).** With activity A resident and
      `{pendingRequest: null, transition.phase: 'idle'}`, a pathname change to activity B produces a
      NEW `requestId` AND a new `activity` generation. *(This is the antecedent two later bullets
      refer to as "that same traversal"; v14 dropped it silently while the total still balanced —
      which is why a balanced total is not evidence the right tests are present.)*
- [ ] **R3-B1 — A is retained:** across that same traversal `displayedChildren` still holds A until
      the transition reaches the opaque midpoint, at which point `handleTransitionOpaque` swaps in
      the parked B. *(Fails against v3, which swapped B in immediately behind no cover.)*
- [ ] **R3-B1 — B's paint gates the fade:** on that traversal the fade-in does not complete until
      B's Canvas reports painted; `activityTarget.roomKey` is B's throughout, and A's readiness
      decisions for B's generation are all `WAIT:'wrong-room'`.
- [ ] **R4-B1 — handler-owned crossings install behind the cover.** Drive the REAL anchor ordering
      for each pair — `requestScene` ⇒ 250 ms ⇒ `onOpaque` (which issues the router commit) ⇒
      `activateScene` ⇒ `awaiting` ⇒ **then** the App Router children commit — and assert the
      incoming children are INSTALLED, not parked, and that the fade completes. Pairs:
      `/game`→`/cove`, `/game`→`/kelp`, `/game`→`/activity/reef-race/A`. **(3)**
      *(All three FAIL against v4, whose `destinationKey === displayedKey` conjunct is false at the
      children commit because `displayedPathRef` still names `/game`. This is the negative test
      whose absence let a regression into two working routes — SELF-F.)*
- [ ] **R4-B1 — handler-owned activity A→B** under the same ordering installs B behind the cover.
- [ ] **R4-B1 — late commit after `idle`:** a router commit that lands AFTER `completeTransition`
      (phase `idle`, `pendingRequest` null, `activeScene` already the destination) still installs,
      via the midpoint record's second clause. *(The case v3's `'idle'` phase value covered
      implicitly and which a naive lineage rewrite would wedge.)*
- [ ] **R4-B1 — the midpoint record is destination-scoped:** children whose destination does NOT
      match `openedMidpointRef.current` are PARKED, not installed, even during `awaiting`.
- [ ] **R4-B2 — B→C before the midpoint:** with activity B pending in `fadingOut`, a pathname commit
      for room C mints a SUPERSEDING request (new `requestId` AND new generation), parks C, and
      leaves B unable to ack (its generation is stale). *(Fails against v4, where both map to scene
      `activity` so no request is minted and B can never paint against C's children.)*
- [ ] **R4-B2 — B→C after the midpoint:** same assertion with B in `awaiting`; additionally the
      superseded generation's late `ackReady` is rejected by the store.
- [ ] **R4-B2 — the superseded parked navigation is cleared:** on a pathname-driven supersession
      `navigationRef.current` is null afterwards, so B's parked href is never committed at C's
      midpoint. *(Pins the `takeParkedNavigationForOpaque` / `rekeyParkedNavigationForRetry`
      analysis in §2m: a fresh `requestId` with no `retryOfRequestId` can be neither matched nor
      rekeyed, so an uncleared entry is orphaned.)*
- [ ] **R6-B1 — stale B lands BEFORE C's midpoint (the headline case).** Stall B's router commit;
      drive B to its opaque midpoint (so `router.push(B)` is issued and `navigationRef` is cleared);
      supersede to C via the handler; release B's commit **before** C reaches its midpoint. Assert:
      the landing classified `issued-stale` BY NONCE (a stale landing never calls
      `settleIssue`, which settles in-flight records only — R9-M1), `pendingRequest` is still C,
      `pendingDestinationKeyRef` is still C, C's parked navigation is intact, `activityTarget` still
      names C, no B request was minted, and `displayedChildren` still holds the ORIGIN page. Then let
      C complete and assert C installs. *(Fails against v5.)*
- [ ] **R6-B1 — stale B lands AFTER C is ISSUED.** Same setup, but let C reach its midpoint (so
      `commitStageNavigation(C)` runs and registers C's own issue) BEFORE releasing B. Assert B's
      record is STILL present and still `'superseded'`, and that the landing is ignored. **This is
      the case v6 could not pass** — issuing C overwrote B's single-slot record, so late B matched
      nothing and re-minted (R6-B1). *(Fails against v6.)*
- [ ] **R6-B1 — stale B lands AFTER C COMPLETES:** release B once C has fully installed and the
      transition is `idle`. B installs nothing, is not parked, and does not re-mint. *(Parking B
      would leave it eligible for swap-in at a later midpoint — the same defect one step on, which
      is why the early return parks nothing.)*
- [ ] **R6-B2 — pathname-first C ends with URL AND displayed destination both C.** B issued; a
      pathname-first C mints through the children effect (placing NOTHING in `navigationRef`); late B
      lands. Assert the stale landing triggers `repairUrlToCurrentIntent()`, that it calls
      `router.replace` with C's href, that the repair is REGISTERED in the ledger (its own landing
      settles as `'in-flight'`, not `null`), that `committedStageNavigationsRef` is UNCHANGED by it,
      and that the run ends with `window.location.pathname === C` and C displayed. *(Fails against
      v6, which claimed the URL self-heals via "C's own navigation" — true only for handler-owned C.)*
- [ ] **R6-B2 — C completes while B NEVER lands:** drive the whole C crossing to `idle` without ever
      releasing B. C installs normally; B's superseded record simply remains until retirement; no
      timer, error, or stuck cover results.
- [ ] **R6-B2 — a later legitimate B traversal succeeds after that non-landing.** With the stale
      superseded B record still in the ledger (inside its TTL), navigate genuinely to B. Assert its
      landing settles the NEW in-flight record — not the stale superseded one — and that B installs
      normally. *(This is the swallow R6-B2 names; it is closed by `settleIssue`'s in-flight-first
      NONCE IDENTITY — the stale record and the new traversal's record carry different ids, so no
      match order is involved (R9-M1: v9 still credited in-flight-first match ORDER, which
      nonce-by-id settlement eliminated). The test runs while the stale record is still present.)*
- [ ] **R7-2 — a retired or count-evicted nonce is `issued-stale`, NEVER `unissued`.** (a) Age out a
      record past `NAVIGATION_ISSUE_TTL_MS`, then land it. (b) Count-evict a record past
      `MAX_TRACKED_NAVIGATION_ISSUES`, then land it. In BOTH, assert the landing repairs to current
      intent and **mints nothing**. **(2)** *(This REPLACES v7's "bounded retirement" bullet, which
      asserted the landing settles as `null` and becomes a fresh arrival — i.e. it PINNED the R7-2
      defect. A conservative unknown-nonce classification is what makes both cases safe.)*
- [ ] **R14-1a — the high-water boundary, all three regions.** With no record and no tombstone for
      the landing nonce: (a) `seq < issuedHighWater()` ⇒ `traversal`, falls through, installs;
      (b) `seq === issuedHighWater()` ⇒ `traversal` — the **inclusive** boundary, reached when the
      most recently issued nonce has already settled and been evicted; (c) `seq > issuedHighWater()`
      ⇒ `malformed` ⇒ **fresh arrival**, nonce inert. **(3)** *(Fails against v14, which had no
      predicate at all and whose `issued-stale` row swept every absent nonce into repair.)*
- [ ] **R14-1a — the predicate is issue-recorded, not scan-derived:** drive the interleaving round 14
      named — settle and evict sequence 2 while older superseded sequence 1 is still retained — and
      assert `issuedHighWater()` is unchanged by eviction, so a landing for sequence 1 still
      classifies from its retained record and a landing for sequence 2 classifies `traversal`.
      *(A minimum-retained-sequence scan gets both of these wrong.)*
- [ ] **R14-2b — the probe is gated on production.** With `NEXT_PUBLIC_ENABLE_STAGE_PROBE` unset,
      assert `window.__WORLD_STAGE_PROBE__` is `undefined` after mount; with it `'1'`, assert the
      probe installs and `navigate` accepts an activity `WorldStageHref`. **(2)** *(Removes the only
      scripted precursor to the accepted residual — round 14 showed 33 probe navigations during a
      hung route commit evict the tombstone ring.)*
- [ ] **R13-1 — settled back/forward, BEFORE eviction:** land a component-issued B, let it settle,
      then traverse back to B's nonce-bearing entry while its `'settled'` tombstone survives. Assert
      it classifies **traversal**, FALLS THROUGH, and installs — not an early return. *(Fails against
      v13, whose `issued-settled` returned and skipped installation entirely.)*
- [ ] **R13-1 — settled back/forward, AFTER eviction:** same traversal once 32 subsequent resolved
      issues have evicted B's tombstone. Assert it classifies **beyond-horizon ⇒ traversal**, falls
      through, and installs — NOT `issued-stale`, and no repair fires.
- [ ] **R13-1 — same-document saved-URL replay, before and after eviction:** re-present a saved
      nonce-bearing URL in the same document under both horizon states; both process as normal
      arrivals. **(2)**
- [ ] **R13-1 — a late SUPERSEDED landing within the horizon still repairs:** with B superseded and
      its record or tombstone still present, a late B landing repairs to current intent and mints
      nothing. *(The half of the contract the beyond-horizon rule deliberately does not cover; this
      pins that the horizon window still protects newer intent.)*
- [ ] **R13-1c — the accepted residual, asserted as SPECIFIED behavior not as a bug:** a superseded
      landing whose provenance has been evicted installs its destination as a normal arrival. The
      test documents the residual so a future reader meets it as a decision rather than discovering
      it as a defect.
- [ ] **R13-1 — foreign-epoch cold arrival is unchanged:** a nonce from another `documentEpoch`
      classifies `foreign` and takes the fresh-arrival path with the nonce inert.
- [ ] **R10-M1 — reset and unmount PRESERVE the lineage; only the sequence guarantee is inherited.**
      (a) `resetStage()` and (b) root unmount each leave `issues`, `tombstones`, and `intent`
      **intact** — the frozen document-scoped semantic — and in both a navigation issued afterwards
      still receives a **strictly greater** nonce than any issued before. **(2)** *(R10-M1: v10's
      version of this bullet demanded the OPPOSITE — that reset and unmount EMPTY the lineage — which
      directly contradicted the preservation tests a few bullets below and would have made the
      R9-B3 remount repair untestable. A restarted sequence remains forbidden for the original
      reason: it could re-issue an id a surviving in-flight browser navigation still carries.)*
- [ ] **R7-1 — same-destination, B₁ lands first.** B₁ issued, superseded by C, then a legitimate B₂
      issued while B₁ is outstanding; release **B₁**. It classifies `issued-stale` by nonce, repairs,
      and mints nothing. *(Fails against v7, whose destination-keyed settlement always matched B₂'s
      in-flight record — the two landings were indistinguishable.)*
- [ ] **R7-1 — same-destination, B₂ lands first:** same setup, release **B₂**. It classifies
      `issued-live`, `settleIssue` removes **B₂'s record by id**, and it installs normally.
- [ ] **R7-1 — same-destination, both land (B₂ then B₁):** B₂ installs; the later B₁ is stale and
      disturbs neither the installed children nor the recorded intent.
- [ ] **R7-1 — an unissued landing is unchanged.** (a) A back/forward traversal and (b) a cold deep
      link both arrive with NO `__wsnav`, classify `unissued`, and take the fresh-arrival path
      exactly as in v7. **(2)** *(The negative test: the nonce mechanism must not touch genuine
      browser navigation.)*
- [ ] **R8-B1 — same destination, B₁ lands late, NO intervening C.** B₁ issues
      `/activity/reef-race/B?shortCode=OLD`; B₂ then issues `/activity/reef-race/B?shortCode=NEW`
      with no other destination in between; release **B₁**. Assert `acceptNavigationIntent()` marked
      B₁ superseded at B₂'s acceptance, that B₁ classifies `issued-stale`, and that the URL ends on
      `shortCode=NEW`. Then **land B₂ as well and drive the repair to completion**, asserting the run
      ends with B₂ installed and the address bar on `shortCode=NEW`. *(Fails against v8, whose
      `supersedeIssuesExcept(destinationKey)` left both records `in-flight`, so B₁ settled
      `issued-live` and restored OLD. R9-M2: v9 released only B₁ and never landed B₂ or its repair.)*
- [ ] **R8-B1 — the same pair in the other order, also to completion:** release **B₂** first — it
      classifies `issued-live`, settles by id, and installs with `shortCode=NEW` — **then release the
      late B₁** and assert it classifies `issued-stale`, repairs back to `shortCode=NEW`, and mints
      nothing. *(R9-M2: v9 stopped after B₂ and never landed late B₁ or its corrective repair.)*
- [ ] **R9-B1 — same destination, distinct query, through the HANDLER.** Drive the same B₁/B₂ pair
      through `decideStageNavigationOwnership` rather than the pathname effect, once where it returns
      **`ADOPT`** and once where it returns **`EXECUTE_NOW`**. Assert `acceptNavigationIntent` ran on
      BOTH — so current intent is `shortCode=NEW` in both — and that a late B₁ repairs to NEW.
      **(2)** *(Fails against v9: the `ADOPT` branch at `WorldStageRoot.tsx:198-203` only overwrites
      `navigationRef` and mints nothing, so v9's intent update — which lived inside minting — never
      ran and a late B₁ repaired to OLD.)*
- [ ] **R9-B1 — `acceptNavigationIntent` is called at every accepted-navigation site:** `EXECUTE_NOW`
      (`:194`), `ADOPT` (`:198-203`), the `SUPERSEDE` fallthrough (`:206`), and the pathname-first
      mint (`:132`). For each, assert that after the call every previously live issue is
      `'superseded'` AND the recorded intent equals the canonical accepted href — the two effects are
      one operation and neither can be observed without the other. **(4)**
- [ ] **R9-B3 — the frozen document-scoped semantic:** the lineage survives (a) a root remount and
      (b) a `resetStageStore()` epoch bump, and `resetStageNavigationLineage()` has **no production
      caller** — assert the mount effect is exactly `resetStageStore()` + `resetStageFrameDiagnostics()`
      + `setStageReady(true)`. **(2)**
- [ ] **R8-B1 — at most one record is ever `in-flight`:** after any sequence of mints and issues,
      assert the ledger contains at most a single `in-flight` record. *(The general property; a
      design that re-introduced a same-destination exemption passes both cases above only by luck
      and fails this one.)*
- [ ] **R8-B3 — a REAL unmount/remount preserves an OUTSTANDING issue, not just the counters
      (expanded, R14-3).** Issue B, unmount `WorldStageRoot`, remount it, then land B: assert it
      classifies **`issued-live`** (not stale, not traversal), settles by id, and installs — and only
      then that the next issued nonce carries the SAME `documentEpoch` with a strictly greater
      sequence. *(v14 narrowed this to the epoch/sequence assertion alone, dropping the coverage that
      actually proves the document-scoped lineage does its job.)* *(Fails against v8's `useRef(0)`, which is re-created at zero — the claim its
      own test asserted and could not satisfy.)*
- [ ] **R10-M2 — a STALE issue stays stale across a remount.** Issue B, then
      `acceptNavigationIntent(C)` so B becomes `'superseded'`; remount `WorldStageRoot`; land B.
      Assert it classifies **`issued-stale`** (not `issued-live`, not `unissued`), mints nothing,
      repairs to C, and that C then completes. **Repeat the whole sequence across a
      `resetStageStore()` epoch bump.** **(2)** *(This REPLACES v10's `resetStageNavigationLineage()`
      clearing test, which asserted a mount caller the frozen semantic denies. §6.2 previously proved
      only that a LIVE issue survives a remount — never that a superseded one stays rejected, which
      is the half that protects a newer intent.)*
- [ ] **R8-M1 — the repair's commit options are real:** `repairUrlToCurrentIntent()` calls
      `commitStageNavigation(nav, { history: 'replace', countTowardStageHistory: false })`; assert
      `router.replace` (never `push`) was used, that the emitted URL carries a fresh `__wsnav`, and
      that `committedStageNavigationsRef` is **unchanged** across the repair. *(Fails against v8,
      which called the plain one-argument form while claiming both behaviors; the anchor increments
      unconditionally at `WorldStageRoot.tsx:171`.)*
- [ ] **R7-3 — full-URL intent and repair:** a pathname-first C carrying `?shortCode=NEW#frag` is
      superseded-then-stale-landed; assert the repair restores the **exact** URL string including
      query and hash. *(Fails against v7, which stored `href: pathname` and compared pathnames, so
      the repair dropped `?shortCode=NEW` — and `page.tsx:112-114` seeds `shortCode` from it.)*
- [ ] **R7-3 — same path, wrong query is NOT "already correct":** a stale landing whose pathname
      matches current intent but whose query differs IS repaired. *(v7's pathname-only comparison
      returned early here.)*
- [ ] **INVARIANT N — settlement identity:** with ONE `'superseded'` record and ONE `'in-flight'`
      record for DIFFERENT destinations, each landing resolves against its OWN id — the in-flight one
      settles and installs, the superseded one repairs and mints nothing. *(R9-B1 rewrite: v9 demanded
      "TWO outstanding in-flight issues", which contradicts the at-most-one-live invariant and was
      therefore unpassable.)* *(The
      general property v6's single slot could not express; a design that regressed to "settle
      whatever is newest" would pass every case above except this one.)*
- [ ] **R6-B1 — the healthy path is untouched (the negative test):** a crossing with no supersession
      holds exactly one ledger record, settles it `'in-flight'`, never calls
      `repairUrlToCurrentIntent`, and runs the midpoint/install rules exactly as in v5. *(SELF-F's
      discipline: every new mechanism gets a test for the path it must NOT affect.)*
- [ ] **R3-B1 — parked-children destination match:** with destination C parked in
      `pendingRouteChildrenRef` and a request whose recorded destination key is B,
      `handleTransitionOpaque` does NOT swap C in. *(Pins the third of the three comparisons; a
      fix that changed only the first two would pass every test above and still show the wrong
      page at the midpoint.)*
- [ ] **R2-B3 — Retry:** bumps `attemptNonce` and re-issues `requestWorldStageNavigation` with the
      STORED `href` (query preserved); a subsequent successful commit clears the overlay and the
      fade completes normally.
- [ ] **R3-B3 — Hard navigate**, two cases. (a) It invokes `leaveAndClose()` on the activity WS
      **before** `location.assign(href)` (assert ordering, not just occurrence), the mock WS records
      exactly ONE `{type:'leave'}` frame with close code 1000, and a subsequent effect-cleanup run
      sends no second frame (idempotence via the nulled `wsRef`). *(Replaces v3's "emits no
      synthetic leave", which was written against a `pagehide` beacon that does not exist.)*
      (b) **Handle lifetime:** with the room-keyed subtree already unmounted, the published
      `leaveRef` reads `null`, Hard navigate calls nothing and still performs `location.assign` —
      no throw, no stale closure. *(Pins the §2g publication seam; a prop-drill or context read
      would fail this case.)* **(2)**
- [ ] **R3-B3 — Stay is gone:** the rendered `<ActivityHandoffRecovery>` exposes exactly TWO
      actions, Hard navigate first; no control mutates `outgoingOverlay` without either navigating
      or re-requesting. *(Fails against v3, which rendered three.)*
- [ ] **SELF-B:** the timeout does NOT call `noteRecovery` — `useStageStore().recovery.count` is
      unchanged across the whole stalled crossing, so the probe's `zeroRecoveries` gate and the
      readiness ack key are both unpolluted. *(Fails against v2.)*
- [ ] **R2-M2 — dropped-click regression:** with a live buffered navigation to a DIFFERENT
      destination, `navigateOut('/game')` still issues its request and supersedes the buffer
      (matching P3 v4 §2h rule 4). *(Fails against v2's returning guard.)*
- [ ] **R2-B1 — handler path:** a `navigateOut('/activity/reef-race/B')` sets
      `activityTarget.roomKey === 'reef-race:B'` before the request is observable.
- [ ] **R2-B1 — pathname-first path:** a back/forward traversal that lands on
      `/activity/reef-race/B` without going through the handler ALSO sets
      `activityTarget.roomKey === 'reef-race:B'` (via the children-swap effect).
- [ ] **R2-B1 — retry preservation:** a watchdog `retryStageScene` (new `requestId` + generation)
      leaves `activityTarget` unchanged.

**`stage-navigation-ownership.test.ts` — R4-B2, NEW in v5 (5)**

- [ ] Same scene, DIFFERENT destination key, phase `fadingOut` ⇒ `SUPERSEDE`. *(At the anchor this
      returns `ADOPT`, parking C's navigation onto B's `requestId`.)*
- [ ] Same scene, DIFFERENT destination key, phase `awaiting` ⇒ `SUPERSEDE`. *(At the anchor this
      returns `EXECUTE_NOW`, pushing to C with no request at all.)*
- [ ] Same scene, SAME destination key ⇒ verdicts unchanged from the anchor: `ADOPT` during
      `fadingOut`, `EXECUTE_NOW` otherwise. **(2)** *(The negative test SELF-F requires: the new
      branch must be dead for `/game`, `/cove`, and `/kelp`, asserted rather than argued.)*
- [ ] **Both** destination keys omitted ⇒ the anchor's behavior exactly, so a caller that supplies
      neither is unaffected. *(R8-M2 narrowed this from the ambiguous "either ... null/omitted":
      the mixed configurations are unreachable, because `WorldStageRoot` is the only caller and it
      passes both or neither.)*

**`stage-activity-slot.test.tsx` (15)**

- [ ] The `activity` slot registers zero `useSceneFrame` callbacks — `readStageFrameInvocations()`
      never contains an `activity` key, active or hidden.
- [ ] `setSceneWarming('activity', g)` fires on `requested && generation > 0`.
- [ ] `warmStageSlotRenderer({ slotId:'activity' })` is called with `compile: undefined` and a
      `directWarm`, and does not collide with the `cove`/`kelp` entries (P3b-1's per-slot re-key).
- [ ] `ackReady` is NOT called by the slot host.
- [ ] **Pause ordering:** `setRenderPaused(true)` is not called until `transition.phase === 'idle'`;
      a variant that pauses at `'awaiting'` must FAIL the transition, proving the guard is
      load-bearing. **(2)** *(R7-5: the variant is a second build.)*
- [ ] A subsequent `requestScene('world')` clears `renderPaused` with no explicit un-pause
      (pins `stage-store.ts:190`).
- [ ] The host's effect cleanup also clears it.
- [ ] `StageIdlePause` does not fire while `activeScene !== 'activity'`.
- [ ] **P3 v4 boundary — inherited:** `resetKey={\`${generation}:${recoveryCount}\`}` clears
      `failed` via `getDerivedStateFromProps`; a generation bump does NOT remount a HEALTHY child
      (assert child instance identity across the bump); a `recovery.count` bump alone DOES clear a
      failed boundary. **(3)**
- [ ] The `WorldStageRoot` activity runtime-crash DOM flag clears on the same `resetKey`.
- [ ] A rejected `lazy(import())` for `StageHostedActivityScene` renders the stage chunk panel and
      does not wedge the transition (the terminal ack still fires).
- [ ] `sceneKind` for a pending `activity` request is `'activity'`, and the world-only ceilings are
      not applied.

**`ActivitySceneErrorBoundary` — B4 + R2-B2 + R2-B2b + R2-B2c (11)**

- [ ] A rejected `next/dynamic` reef chunk renders the panel, calls `onFailed('scene-chunk-error')`
      **with its `roomKey`**, and readiness ACKs so the fade lifts. *(Also pins the corrected
      mechanism claim: the App-Router `lazy`-based loadable DOES throw the rejection into the
      boundary — round 2's "the boundary never receives it" reading is what fails here.)*
- [ ] Same for bumper.
- [ ] **R2-B2 — the caching fact:** remounting the boundary WITHOUT bumping `sceneAttempt`
      re-throws immediately with the same cached error and issues no new `import()`. *(This is the
      real v2 defect; it fails against v2's `retryNonce`-remount-only retry.)*
- [ ] **R2-B2 — Try again:** bumping `sceneAttempt` produces a NEW dynamic component type
      (component identity changes), clears `failed` through `resetKey`, clears `terminalBranch` and
      `paintedRoomKey`, bumps `attemptNonce`, and calls the loader again.
- [ ] **R2-B2 — Reload is primary:** the panel renders Reload first and its handler calls
      `location.reload()`; the test asserts ordering/labelling, matching P3 v4 §8.13's frozen
      chunk-panel contract.
- [ ] **R2-B2b:** after a Try-again with no pending stage request, readiness returns
      `WAIT:'no-pending-request'` and the dynamic `loading` fallback is what covers the gap.
- [ ] **R2-B2b:** after a Try-again WITH a pending generation, readiness returns
      `WAIT:'not-painted'` until the fresh Canvas paints.
- [ ] `webglcontextlost` on the activity canvas is `preventDefault()`ed, clears `paintedRoomKey`,
      and renders `'canvas-lost'` tagged with its `roomKey`.
- [ ] **R2-B2c:** the context-loss listener is attached to the element delivered by
      `onCanvas`, and a control that instead queries the wrapper during the parent effect finds
      **no canvas** while the dynamic fallback is mounted — the exact hole the published handle
      closes.
- [ ] A stage-canvas context-loss event does NOT reach the activity boundary.
- [ ] An activity-canvas context-loss event does NOT reach stage recovery (pins the
      canvas-targeted listeners at `WorldStageCanvas.tsx:797-800`).

**`activity-room-runtime.test.tsx` — M2 + R2-m1(d) (11)**

- [ ] Changing `roomId` remounts the subtree (child instance identity changes).
- [ ] `shortCode` is re-initialized from the new room's search params — **the v1 latent bug**;
      assert the WS auth frame carries the NEW room's shortCode.
- [ ] `lobbyGate` resets to its initializer for the new room.
- [ ] `spectatorCamMode` / `spectatorTargetAvatarId` reset.
- [ ] `useActivityStore.reset(roomId)` runs for the new room.
- [ ] Both self buses reset.
- [ ] `_hitCheckScratch`/`_elimCheckScratch` reset on a store `roomId` change (the §5c fix); a hit
      arriving as the first event of the new match DOES fire its burst.
*(v3's `_renderedPoseByAvatar` baseline bullet is **DELETED**. R3-M1 was right that it was not
implementable — private module state, no pinned value, no permitted diagnostic — and SELF-E then
showed the defect it was measuring **does not exist**: `ReefRacePlayer.tsx:1056-1064` sets and
deletes the entry in one effect. §6.1's diff-scope gate proves the thing that is actually true and
actually matters here, which is that P4 does not touch that file.)*
- [ ] **R2-m1(d):** `LobbyLanding`'s nine local state fields reset for the new room AND its 3 s
      poll timer is cleared on unmount (no timer from room A survives into room B). **(2)**
      *(R7-5: room-change and unmount are two setups.)*
- [ ] **R2-m1(d):** `ActivityMobileControls`'s `boostFlash`/`powerupFlash` reset and its nipplejs
      manager is destroyed and re-created against the new room's container.
- [ ] The audio-unlock listeners are registered once at page level, not per room.

**`world-downlink-policy.test.ts` — M1 + R2-M1 + R3-B2 + R4-B3/B4 + R5-B2 + R6-B3 + R7-4 + R8-B4 + R9-B4 + R11-3 (64)**

- [ ] The three rules, with `pendingReopen: false` throughout (the v3 shape, preserved). **(3)**
- [ ] **R3-B2 — the missing-CLOSE hole:** `{wanted:false, open:false, pendingReopen:true}` ⇒
      `CLOSE`. *(Fails against v3's `!wanted && open` rule, which returned `NONE` here — this single
      input is the whole blocker.)*
- [ ] `OPEN` is suppressed while `!hasSession` or `!hasRoom`. **(2)** *(R7-5: two inputs.)*
- [ ] **R4-B4 — the backoff pin:** `{wanted:true, open:false, pendingReopen:true, hasSession:true,
      hasRoom:true}` ⇒ `NONE`, NOT `OPEN`. *(Fails against v4's rule 2, which had no
      `!pendingReopen` conjunct — this single input is the whole blocker.)*
- [ ] `CLOSE` is emitted once, then `NONE` on every subsequent tick — asserted with
      `{open:false, pendingReopen:false}` after `closeStream()` has cleared BOTH (idempotence).
- [ ] Cold `/activity`: `everActive === false` ⇒ `decide()` emits no `BOOTSTRAP`, so no stream, no
      join, no upload (pins `world-stream-machine.ts:99-109`).
- [ ] `active → (activity) → active` round trip: no `/join` is spent on resume.
- [ ] **R3-B2 — the racing-error test, rewritten to the REAL ordering.** Drive exactly what the
      live code does: (1) dispatch the `EventSource` error so `onerror` runs `es?.close(); es = null`
      (`use-world-stream.ts:476-477`) and arms `retryTimeout` (`:510`); (2) set
      `downlinkEnabled = false`; (3) run one 200 ms machine tick — it must emit `CLOSE` **even
      though `es` is already null**, via `pendingReopen`; (4) advance timers past
      `RETRY_DELAY_BASE` so the queued callback fires. Assert it opens no stream and schedules no
      new timer. *(v3 specified step 3 as "THEN run CLOSE", which cannot happen on this path because
      there is no CLOSE to run — round 3's exact objection. v2's earlier version asserted the timer
      clear was sufficient, which round 2 correctly said should fail.)*
- [ ] **R3-B2 — dual guard:** a handler whose captured epoch is CURRENT but which runs while
      `downlinkEnabledRef.current === false` mutates nothing and opens nothing.
- [ ] **R3-B2 — source ownership:** a handler belonging to a source that has since been replaced
      (`es !== capturedSource`) mutates no stream state even when its epoch matches.
- [ ] **R3-B2 — `rejoinWithTicket()` rotates the epoch:** its source replacement routes through
      `invalidateStream()`, so a callback captured before the rejoin is stale afterwards. *(Fails
      against v3, which replaced the source inline at `:285-294` with no rotation.)*
- [ ] **R3-B2 — `handleSuperseded()` rotates the epoch:** same assertion for the inline drop at
      `:186-190`. *(This site was not named in any critique; found while verifying R3-B2, and it is
      why v3's "closeStream is the only closer" claim was false.)*
- [ ] **R4-B3 — POSITIVE: an ordinary ENABLED error recovers.** With the downlink enabled, dispatch
      an `EventSource` error; assert `openStream` is called **exactly once**, that it happens at
      `RETRY_DELAY_BASE` and not before, and that the replacement source receives live events.
      *(Fails against v4, where `onerror` routed through `invalidateStream()` and so invalidated its
      own continuation — every enabled retry died. This is THE test whose absence let R4-B3 through:
      the disabled-resurrection test passes trivially in a design where no retry ever runs.)*
- [ ] **R4-B4 — ticks during the backoff open nothing:** across the ~15 machine ticks that elapse
      before `RETRY_DELAY_BASE`, `openStream` is called **zero** times; at timer expiry it is called
      exactly once.
- [ ] **R4-B3 — the retry token is invalidated by every stream-ending path:** for each of `CLOSE`,
      `rejoinWithTicket` replacement, `handleSuperseded`, and effect teardown, an armed retry
      continuation that fires afterwards opens nothing. **(4)**
- [ ] **R4-B4 — `pendingReopen` spans the async recovery window:** after the timer fires and while
      `recoverWithTicket()` is still awaiting, `retryTimeout` is null but `pendingReopen` is still
      true, so a tick in that window returns `NONE` rather than racing the in-flight rejoin.
      *(Fails against v4's `retryTimeout !== null` definition.)*
- [ ] **R4-B3 — the post-`await` re-guard:** disabling the downlink while `recoverWithTicket()` is
      in flight makes the fallback bare reopen a no-op, and the next tick's `CLOSE` clears the
      still-set token (the self-healing row in §2k's lifecycle table).
- [ ] **R5-B2 — rule 2 defers to a live recovery:**
      `{wanted:true, open:false, pendingReopen:false, recoveryInFlight:true, hasSession:true,
      hasRoom:true}` ⇒ `NONE`, NOT `OPEN`. *(Fails against v5, whose rule 2 had no
      `!recoveryInFlight` conjunct — this single input is the whole first leg.)*
- [ ] **R5-B2 — `recoveryInFlight` is NOT folded into rule 1:**
      `{wanted:false, open:false, pendingReopen:false, recoveryInFlight:true}` ⇒ `NONE`, so a
      suspended window with a recovery in flight does not re-emit `CLOSE` on every 200 ms tick.
- [ ] **R5-B2 — disable → CLOSE → re-enable during recovery, SUCCESS path:** start a ticketed
      recovery; disable (rule 1 fires `CLOSE`, clearing the retry token); re-enable before `/join`
      resolves; assert `openStream` is called **zero** times while `recoveryInFlight` is true, and
      exactly once — by the recovery itself — when `/join` resolves.
- [ ] **R5-B2 — the same sequence, FAILURE path:** `/join` rejects; assert no source was opened
      during the recovery, and that once `recoveryInFlight` clears, rule 2 is free to `OPEN` again
      (the flag must not latch).
- [ ] **R5-B2 — armed escalation collides with a 409 recovery:** arm the SSE escalation; start a
      position-409 recovery; let the timer fire. `recoverWithTicket()` returns `null` **because it is
      busy** (`:354-355`), the continuation must NOT bare-open, and `openStream` is called zero times
      while the real recovery owns `/join`. *(Fails against v5, which read that `null` as failure.)*
- [ ] **SELF-G — busy ⇒ re-arm, not return:** in the same collision, assert a NEW retry token is
      minted (the continuation re-armed) and that when the real recovery SUCCEEDS the re-armed timer
      is inert. Then repeat with the real recovery FAILING and assert the re-armed timer runs and
      reopens exactly once. *(A plain early return passes the previous bullet but wedges here: the
      leaked token keeps `pendingReopen` true forever and rule 2 never fires again.)* **(2)**
      *(R6-m1: this bullet always described two cases and was mis-counted as one in v6.)*
- [ ] **R6-B3 — the bare-reopen branch refuses while busy (the v6 hole).** Arm a NON-escalating
      retry, start a recovery, and let the timer expire. Assert `openStream` is called **zero**
      times and the lineage re-armed. *(Fails against v6, whose `recoveryInFlight` check sat only in
      the post-`await` continuation, leaving the `!shouldEscalate` branch to bare-open.)*
- [ ] **R6-B3 — multiple expiries during ONE still-pending recovery ⇒ zero opens.** With `/join`
      pending (not yet resolved, and with fake timers held **below** `JOIN_TIMEOUT_MS`), let the
      retry timer expire repeatedly across several backoff windows. Assert `openStream` is called
      **zero** times throughout. *(R7-5 wording fix: v7 described this setup as "never resolving"
      while the two bullets after it resolved and rejected that same `/join` — a contradiction. The
      genuinely-never-resolving case is now its own test below, where it belongs.)*
- [ ] **R6-B3 — then exactly ONE recovery-owned open on success:** resolve `/join`; assert exactly
      one `openStream`, issued by the recovery itself (site 4), not by any timer.
- [ ] **R6-B3 — or exactly ONE fallback open after failure:** reject `/join` instead; assert
      `recoveryInFlight` clears and exactly one open follows, from the re-armed timer.
- [ ] **INVARIANT R — the busy-wait ceiling and ownership transfer.** Hold the recovery unresolved
      past `RECOVERY_WAIT_CEILING_MS`. Assert the lineage RETIRES (`activeRetryToken` becomes null,
      so `pendingReopen` is false), that **no open happens while `recoveryInFlight` is still true**,
      and that once it clears, rule 2 opens **exactly once**. *(Pins the hand-off: ownership moves
      from the retry lineage to the tick edge; it is never shared and never dropped.)*
- [ ] **INVARIANT R — the escalation branch is unreachable while busy:** with a recovery in flight,
      an ESCALATING timer expiry does not call `recoverWithTicket()` at all (the top-of-body check
      short-circuits first), so no second `/join` is attempted. *(Distinct from the post-`await`
      re-check, which covers the state changing ACROSS an await that was already entered.)*
- [ ] **SELF-H — `bootstrap()` cannot open during a recovery**, and for the stated structural
      reason: with a session present, drive the machine and assert it emits no `BOOTSTRAP` while
      `recoveryInFlight` (pins `world-stream-machine.ts:90-100`'s `!hasSession` predicate, plus that
      `rejoinWithTicket` never clears `sessionIdRef` on either path).
- [ ] **R7-4 — `/join` that NEVER settles is bounded and recovers.** Start a ticketed recovery whose
      `/join` promise is never resolved or rejected by the test at all. Advance past
      `JOIN_TIMEOUT_MS` and assert, in order: the `AbortController` fires; `recoveryInFlight`
      **clears**; `RECOVERY_FAILED` is dispatched **exactly once**; and **exactly one** reopen
      follows. *(Fails against v7, where the retry lineage retired at 30 s but rule 2 stayed gated
      on a `recoveryInFlight` that never cleared — zero opens, forever. This is the permanently
      unresolved cell v7's suite omitted.)*
- [ ] **R8-B4 — a late SUCCESS is inert:** after the deadline wins, resolve the original `/join` with
      a full `JoinResponse`. Assert `settleRecovery` returns on the lease guard — no
      `sessionIdRef`/`roomIdRef`/`roomTicketRef` write, no `RECOVERY_OK`, no `openStream`.
- [ ] **R8-B4 — a late `{superseded:true}` is inert, and separately:** the same setup resolving with
      the supersede sentinel calls **no** `handleSuperseded()`, so a stale recovery cannot tear down
      a live session. *(v8 tested one late-completion shape; these are different branches of
      `settleRecovery` and only one of them was covered.)*
- [ ] **R8-B4 — the deadline is INDEPENDENT of the abort:** with a `joinWithBody` that ignores
      `AbortSignal` entirely and never settles, assert the DEFERRED `done` promise still resolves
      at `JOIN_TIMEOUT_MS` — the deadline arm calls `settleRecovery(lease, {kind:'timeout'})` and
      resolves it — that `recoveryInFlight` clears, and that one reopen follows. *(R10-M3 wording
      fix: v10 asserted a `Promise.race` return value, but v10's own code returns a deferred.)* *(Fails against v8,
      whose termination depended on the fetch honoring the signal — the exact case its lease claimed
      to cover.)*
- [ ] **R9-B4 — the DEADLINE-FIRST ordering drives the CAS refusal.** With the deadline winning,
      instrument `settleRecovery` and assert it is called TWICE — once by the deadline arm and once
      by the late join arm — with the second returning on `activeRecoveryLease !== lease`. *(R10-m1: v10 claimed the loser *always* reaches the
      CAS, contradicting its own timer cancellation. The OPERATION-FIRST single-call assertion lives
      in its own bullet below — R11-7 removed the duplicate imperative from here rather than
      weighting it, since duplicating an existing assertion inflates the count without adding
      coverage.)* *(Fails
      against v9, where only the `Promise.race` winner reached the helper and the loser's late
      resolution was silently abandoned, so the promised refusal never ran.)*
- [ ] **R9-B4 — a refused late SUCCESS opens no source**, and for the stated structural reason:
      `openStream` is inside the guard, so a refused call returns before reaching it. Assert zero
      additional `EventSource` constructions after the refusal. *(The critique's specific question —
      "what happens to a source a late success opened" — has the answer that it never opens one.)*
- [ ] **R9-B4 — AT MOST ONE machine transition, ONE flag clear, and AT MOST ONE source open, per
      settlement cell** — **exactly one transition for an accepted non-cancelled settlement, and ZERO
      for cancellation and for a refused loser** (R10-M3: v10 demanded exactly one in all seven,
      which `cancelled-before-settlement` correctly contradicts by returning at the `cancelled`
      guard). Walk all seven: deadline-first; join-success-first; join-rejection;
      superseded-first; disable-during-wait; lease-1-late-after-lease-2-starts; and
      cancelled-before-settlement. **(7)** *(Fails against v9 in six of the seven: `settleRecovery`
      dispatched AND the unchanged `recoverWithTicket` dispatched again off the returned room id
      (`use-world-stream.ts:354-362`), so every settling cell double-dispatched.)*
- [ ] **R9-B4 — `recoverWithTicket()` no longer dispatches:** assert the only `RECOVERY_OK` /
      `RECOVERY_FAILED` call site in the module is inside `settleRecovery`.
- [ ] **R9-B4 — the deadline timer is cleared when the operation wins:** after a fast successful
      `/join`, advance fake timers past `JOIN_TIMEOUT_MS` and assert no timeout settlement is
      attempted and no second transition occurs.
- [ ] **R8-B4 — lease 1 cannot clear lease 2's ownership:** let lease 1 time out, start lease 2, then
      resolve lease 1's original promise. Assert `recoveryInFlight` is still true (lease 2 owns it)
      and that no source opened underneath lease 2. *(Fails against v8, which cleared
      `recoveryInFlight` in a `finally` OUTSIDE the lease-equality guard.)*
- [ ] **R7-4 — the timeout ordering is pinned, not incidental:**
      `JOIN_TIMEOUT_MS < RECOVERY_WAIT_CEILING_MS` asserted directly, AND in the
      never-settles run above the `RECOVERY_WAIT_CEILING_MS` branch is never reached. *(A future
      tuning edit that inverts the two constants must fail a test rather than silently restore the
      dead-retry state.)*
- [ ] **R7-4 + R11-3 — bootstrap is bounded, and a late raw result is harmless.** (a) A
      `bootstrap()` `/join` that hangs aborts at `JOIN_TIMEOUT_MS`, `joinBounded()` returns `null`,
      and the machine takes its existing `BOOTSTRAP_FAILED` / exponential-retry handoff
      (`world-stream-machine.ts:99-108`) rather than hanging forever. (b) **Release attempt 1's raw
      result AFTER attempt 2 has already succeeded**, and assert there is no late
      `sessionIdRef`/`roomIdRef` write, no second `BOOTSTRAP_OK`, and no second source open. **(2)**
      *(R11-3: v11 added a `bootstrapGeneration` guard for (b); it was undeclared AND wrong —
      returning `null` on a mismatch would have made `bootstrap()` dispatch `BOOTSTRAP_FAILED`, which
      is not inert. The machine is already single-flight, so the mechanism is removed and this test
      proves the property directly.)*
- [ ] **R2-M1:** `bootstrap()` resolving while `downlinkEnabled === false` writes
      `sessionIdRef`/`roomIdRef`/`roomTicketRef` and the store, and calls `openStream` **zero**
      times.
- [ ] **R2-M1:** `rejoinWithTicket()` resolving while disabled repairs membership (refs + store +
      timer cancel + `retriesRef` reset) and calls `openStream` **zero** times — the 409 path a
      10 s remote heartbeat can trigger mid-match.
- [ ] **R2-M1:** the `OPEN` edge invalidates `LAND_PARCELS_QUERY_KEY` exactly once.
- [ ] **R2-M1:** `pageshow` with `persisted: true` closes the stream, nulls the membership refs,
      and the next 200 ms tick emits `BOOTSTRAP`; with `persisted: false` it is a no-op. **(2)**
      *(R7-5: two inputs.)*
- [ ] **R2-M1:** effect teardown bumps `streamEpoch`, so a callback that survives teardown opens
      nothing.
- [ ] Unmount while suspended runs the normal cleanup exactly once.
- [ ] **`world-stream-machine.ts` is byte-unchanged** (a snapshot assertion on the exported
      `WorldStreamMachineAction` union and `WorldPresencePolicy`).

**`held-key-listeners.test.ts` — M4 / P4d (17)**

- [ ] `keyIdentity:'code'` vs `'key'` produce the right identity string. **(2)**
- [ ] `keyTargetGuard:'isEditable'` skips keydown on input/textarea/contentEditable; `'none'` does
      not. **(2)**
- [ ] **keyup is never target-guarded** for either consumer — avatar controller and activity
      keyboard effect (preserves today's behavior). **(2)**
- [ ] `onKeyDown` returning `true` calls `preventDefault`; `false` does not. **(2)**
- [ ] `onReset` is registered through `registerInputReset` and fires on each of blur,
      visibilitychange, focus, and pageshow. **(4)**
- [ ] `extra` listeners attach and detach with the same lifetime.
- [ ] **R2-m1(f):** `extra` attaches through `addStageEventListener(window, type, …)` — the
      string-typed helper — so the custom `'clawville:activity-action'` type compiles and a
      `CustomEvent` dispatched by `ActivityMobileControls` still reaches `onCustomAction`. The test
      also asserts NO `WindowEventMap` augmentation was added (a type-level check that
      `addStageWindowListener('clawville:activity-action', …)` still does NOT compile).
- [ ] Attach/detach is balanced (net `windowListenerCount` delta 0), and the `extra` listeners are
      counted by `windowListenerCount` exactly like the key listeners.
- [ ] **Equivalence:** a recorded key sequence produces byte-identical `actionBits`, `oneShotBits`,
      and `dir` output before and after the extraction — asserted for BOTH consumers, the avatar
      controller and the activity keyboard effect. **(2)** *(R8-M2.)*

**`kelp-walkin-guard.test.ts` (+3, the declared P3 amendment)**

- [ ] Rules 3 and 4 evaluate on `bufferedPathname`. **(2)** *(R8-M2: 1b amends TWO rules.)*
- [ ] A buffered `'/kelp?x=1'` still blocks (would have slipped through an href comparison).

### 6.3 Existing suites — no regression

- [ ] `bun test apps/web` — all world-stage suites (P3-as-landed count + these),
      `world-stream-machine.test.ts`, `kelp-walkin-guard.test.ts`, every activity-adjacent suite.
- [ ] `bun test apps/api` — `skill-protocol-onboarding.test.ts` and `agent-paid-surface.test.ts` at
      pin 43; **`services/activity/__tests__/*` must pass byte-unchanged** — if any activity server
      test needs editing, the diff has left render-only scope and must stop.
- [ ] **Known pre-existing failure, NOT this diff:** the 4 cove slots-`verifier.test.ts` cases that
      fail identically on clean staging (`world-stage-watchdog-reland-notes.md`). Re-confirm with a
      stash before attributing anything.

### 6.4 Inherited probe lanes — both backends

- [ ] `--lane=synthetic` (WebGPU) and `--lane=synthetic --webgl` — PASS.
- [ ] `--lane=retry-adoption` — PASS (4/4).
- [ ] `--lane=loader` — PASS (7/7). **The first-visit loader lane must stay green.**
- [ ] `--lane=routes --pair=cove` (30 loops) — identical assertion set to today.
- [ ] `--lane=routes --pair=kelp` (30 loops, P3) — no regression.
- [ ] `--lane=kelp-exit` (P3) — no regression.
- [ ] **These three lanes are promoted to the R4-B1 regression gate (v5).** Run them with **P4a
      applied alone** and byte-diff their committed summary JSON against the pre-P4 baseline. v4
      would have wedged `/game`↔`/cove` and `/game`↔`/kelp` (R4-B1) and no lane in the v4 spec was
      designated to notice; these already exist and cost nothing extra. Any diff is a hard stop.
- [ ] `--lane=soak --loops=60` — counts plateau, WebGPU byte growth ≤1%, second-half slope
      ≤1.0 MB/loop, total ≤20%.
- [ ] `--lane=soak --dwell=cove --dwell-seconds=180` — drift ≤0.05 MB/s.

### 6.5 NEW `--lane=activity-exit`

One `/game` → `/activity/reef-race/<fixture>` → `/game` round trip with full evidence. The lane
stubs the activity REST/WS surface the same way `apiStubLane` already stubs `/api/auth/me`
(`world-stage-probe.mjs:25-38`).

- [ ] `stageProbeIdentityStable` — `window.__WORLD_STAGE_PROBE__` is the SAME object before and
      after (proves no layout remount).
- [ ] `oneStageCanvasAcrossRoundTrip` — `stageCanvasMountCount === 1` (this counter is
      stage-specific, `WorldStageCanvas.tsx:686-700`).
- [ ] `activityCanvasMountedOnce` — exactly one `<canvas>` inside `.game-container` on the activity
      route, zero after the return.
- [ ] `maxLiveCanvases === 2` during dwell and `1` after the return (M3).
- [ ] `entryLoaderNeverAppeared` and **`returnLoaderNeverAppeared`** — the phase's headline
      assertion.
- [ ] `activityNavigationStayedSameDocument`.
- [ ] `worldFramesFrozenWhileActivityActive` / `worldCameraFrozenWhileActivityActive`.
- [ ] `stagePausedWhileActivityIdle` — `renderPaused === true` once `transitionPhase === 'idle'`,
      `false` after the return.
- [ ] **B2 evidence:** `activityPageUnmountedBeforeFadeIn === true`,
      `leaveFrameObservedBeforeFadeIn === true` (the stub WS records the frame),
      `outgoingOverlayTimedOut === false` on the happy path.
- [ ] **R2-B3 evidence — the stall drill.** With the router commit deliberately stalled past 10 s:
      `outgoingOverlayStatus === 'timed-out'`, `recoverySurfaceShown === true`,
      **`leaveFrameEmittedByTimeout === false`** (the stub WS records NO frame),
      `transitionPhase` still `'awaiting'`, the activity canvas still present, and
      `useStageStore().recovery.count` unchanged. Then drive **each of the two** recovery actions
      once and assert the §5i rows 6-7 outcomes — including, for Hard navigate, that the stub WS
      recorded a `{type:'leave'}` frame BEFORE the document navigation
      (`overlayHandoff.hardNavigateLeaveFrameSent === true`). Assert also that the surface renders
      exactly two actions: **v3's Stay must not be present** (R3-B3).
- [ ] **B3 evidence:** `readiness.ackedOnFirstEntry`; and with a forced watchdog silent retry,
      `readiness.ackedAfterSilentRetry`; with a forced `noteRecovery`,
      `readiness.ackedAfterRecoveryCountBump`; with the fixture forced to the lobby branch,
      `readiness.ackedOnTerminalBranch`.
- [ ] **R2-B1 evidence:** `readiness.targetRoomKeySetOnHandlerNav` and
      `readiness.targetRoomKeySetOnPathnameNav` both true; and on a driven activity→activity
      crossing, `readiness.outgoingRoomNeverAckedIncomingGeneration === true` (the outgoing room's
      decision log contains only `'wrong-room'` waits for the incoming generation).
- [ ] **R3-B1 evidence — in the browser, on real history, with its precondition PINNED (R4-M3).**
      Drive `/activity/reef-race/A` → `/game` → `/activity/reef-race/B`. **Before traversing, assert
      the history precondition rather than assuming it:** `decideStageNavigationHistoryMethod`
      (`stage-navigation-ownership.ts:13-17`) returns `'push'` only while
      `committedStageNavigations < 2` and `'replace'` thereafter, so on a FRESH document the two
      activity entries are NOT adjacent — a bare `back()`/`forward()` pair traverses B↔`/game`
      instead of A↔B, and the lane would silently test the wrong crossing while still passing.
      **Run it in a FRESH browser context** (R5-m2) — earlier actions in the same lane will have
      pushed the counter past 2 and silently put every later navigation into `replace` mode, which
      changes which two entries are adjacent. Procedure: open a fresh context directly on
      `/activity/reef-race/A`; assert `snapshot().committedStageNavigations === 0` (the field added
      in §3); navigate A→`/game` and assert it is now `1`; navigate `/game`→B and assert `2`. Only
      then traverse **deterministically** with `history.go(-2)` to reach A and `history.go(+2)` to
      return to B. Assert on the A→B leg:
      `readiness.pathnameFirstMintedNewGeneration === true` (a NEW `activity` generation exists),
      the outgoing page was retained until the opaque midpoint, and
      `entryLoader.appearedWhileNotReady === false`. **This is the assertion v3 could not have
      passed** — no request was minted at all — so it is the lane's proof that the §2m repair is
      live, not just that the store fields exist.
- [ ] **R4-B1 evidence — handler-owned crossings, in the browser.** Drive `/game`→`/cove`,
      `/game`→`/kelp`, and `/game`→`/activity/reef-race/A` through the stage handler (Leave /
      Play Again / door), and assert each one FADES: the destination page is installed, the
      transition reaches `idle`, and `entryLoader.appeared === false` for cove/kelp. **These three
      crossings work on `origin/staging` today and would break under v4** (R4-B1), so they are run
      as a REGRESSION gate against the pre-P4 baseline, not merely as new-feature coverage.
- [ ] **Pointer contract:** `document.elementFromPoint(centerX, centerY)` on the activity route is
      the ACTIVITY canvas; the Leave button and the mobile A/B buttons each return themselves at
      their own centre; the `ReefRaceHud` root does NOT capture the centre hit (its inline
      `pointerEvents:'none'` still wins over `.game-container > *`).
- [ ] `zeroTransitionErrors`, `zeroRecoveries` (other than the deliberately forced ones).
- [ ] `returnEvidence` — pathname `/game`, sentinel survived, world slot `ready`, loader absent,
      `[data-stage-transition="idle"]`, centre hit is the STAGE canvas again.
- [ ] Paint evidence captured in a dedicated `?webgl=1` visit only — headless WebGPU screenshots
      come back as one solid colour, so only WebGL is falsifiable (the reviewer's 2026-07-28
      finding, preserved).

### 6.6 NEW `--lane=routes --pair=activity`

30 `/game` ↔ `/activity/reef-race/<fixture>` round trips with the P1b cove gate shape. `--pair`
defaults to `cove`, so today's invocation and committed JSON stay byte-identical.

**Parameterization required (do not half-do this):** the cold-boot URL, the destination scene id,
the `routes.cacheControl` key names, the network `phase` labels, the loop destination pathnames,
the `runColdInitProbe` origin and `stageColdInit` target, the `bothSlotInventoriesCaptured` slot-id
pair, the output path, and the post-warmup heap threshold.

- [ ] `exactlyRequestedRoundTrips` — 30 / 60.
- [ ] `oneStageCanvas` across all 60 crossings.
- [ ] `hiddenFramesFrozen`, `hiddenCamerasFrozen`, `hiddenStoresFrozen` (≥60 hidden windows).
- [ ] `activeCallbacksAdvance` on `/game`.
- [ ] `returnsSkipSeaLoadingScreen`.
- [ ] `listenerDeltaZero`, `listenerAccountingNeverUnderflowed`. **Plus** a raw
      `getEventListeners(window)` delta of zero across the 30 loops — required because the
      activity's own listeners bypass `windowListenerCount` unless P4d lands; with P4d the two
      measures should agree, which is itself an assertion.
- [ ] `zeroTransitionErrors`, `zeroRecoveries`.
- [ ] `coldActivitySkipsWorldAssets` — a cold deep-link fetches ZERO `WORLD_ONLY_ASSET_PATTERN`
      matches.
- [ ] `activityCacheControlNonCacheable` — captured **before and after** the §1a layout fix, so the
      pre-existing defect is documented rather than silently repaired.
- [ ] `oneInitialWorldStream`, `noRouteCorrelatedStreamReopens`, and — for P4c —
      `worldStreamClosedWhileInActivity` (zero SSE bytes during the dwell) plus
      `positionUploadsContinue` (one `POST /api/world/position` per ~10 s carrying `at-activity`)
      plus `noExtraJoinsOnResume` (the `/join` budget is 3 per 60 s per IP).
- [ ] **R2-M1 in the browser:** during the dwell, force a `/position` 409 (stub response) and assert
      the rejoin repairs membership with **zero** SSE bytes (`downlink.openStreamCallsWhileDisabled
      === 0`); on the return crossing assert `downlink.landInvalidatedOnReopen === true` and
      `downlink.extraJoinsOnResume === 0`.
- [ ] **R3-B2 in the browser:** force the SSE endpoint to error at the moment of entry (stub a 500
      on `/api/world/:room/stream`) so `onerror` nulls the source and arms a retry, THEN complete
      the crossing into the activity. Assert `downlink.closeEmittedWithNullSource === true` (the
      CLOSE edge fired via `pendingReopen`) and `downlink.openStreamCallsWhileDisabled === 0` for
      the whole dwell, including past `RETRY_DELAY_BASE`. *(This is the exact live sequence v3's
      unit test could not reproduce; running it in the browser as well is deliberate, because the
      failure was a property of real handler scheduling rather than of the pure policy.)*
- [ ] `stageHistoryBounded` (delta ≤2, final ≤4); `browserHistoryUsesStage` (back AND forward).
- [ ] `sceneInventoriesExactZeroDiff` for `world`; the `activity` slot inventory is asserted **EMPTY
      at all times** (the structural check that the empty slot stayed empty).
- [ ] Heap plateau ≤15% after warmup, forced GC.
- [ ] `roomIsolation.*` — every field in the §3 schema, including `shortCodeResetOnRoomChange` and
      `wsSocketIdentityChangedOnRoomChange`.

### 6.7 Race-integrity check — a REAL match

The money gate; not satisfiable by unit tests.

- [ ] Against a locally-running API, drive ONE complete Reef Race from `/game`: queue → room →
      countdown → race → finish → results modal.
- [ ] Assert from the DATABASE (not the UI): exactly one `activity.match.placed` row with the
      correct `placement`; the CT credit appears exactly once; PB/daily-best rows written as today.
- [ ] Run the SAME race on `origin/staging` and **diff the resulting rows. Identical is the pass
      condition.** A difference means the migration touched the money path and the diff stops.
- [ ] Mid-race Leave: assert `event.player_left` with `reason:'voluntary'` and a sim forfeit,
      confirming §5f survived the §2d gating.
- [ ] Repeat once for Bumper Shells.

### 6.8 PROTECTED partner-surface gate

Binding because `skill-protocol.ts` is in the diff (P4b):

- [ ] `.hatcher-ref/CONTRACT.md` freshness checked FIRST; refresh from the public repo if stale.
- [ ] Mock-Hatcher harness end-to-end on **staging** (`apps/api/scripts/hatcher/run-mock-e2e.md`):
      register → stats → 401 → DELETE, plus `contract-probe`. GREEN from harness output, not `tsc`.
- [ ] `docs/hatcher-integration-spec.md`: the **four LIVE** references updated to 43; historical
      version-ledger entries preserved (M5).
- [ ] The conventional-value assertion includes `at-activity` (M5).
- [ ] Codex adversarial pass on the manual + version change.
- [ ] Invariants re-asserted unchanged: no signing, SSRF-allowlist, `ALLOW_TEST_PARTNER_PUBKEY`,
      session/bearer, or wallet-path change.
- [ ] `apps/api/scripts/agent-onboarding-smoke.ts` against staging (Rule E6.3).

### 6.9 Browser drive — Iris Xe desktop floor, prod bundle

**Both `NEXT_PUBLIC_REEF_RACE_USE_SPLINE=true` and unset** (§4, OQ-4):

- [ ] Cold `/game`; queue into Reef Race; the crossing is a **fade**, not `SeaLoadingScreen`.
- [ ] The race renders **identically to `origin/staging`** — side-by-side screenshots of the water
      ribbon (Gerstner displacement, crest foam, tropical palette), the neon rail bloom, the cosmic
      void dome, ramps, boost portals, and the kart. **Any visual difference is a blocking
      failure.**
- [ ] Console: **zero** occurrences of `NodeBuilder: Material "ShaderMaterial" is not compatible.`
      (the §0.1 canary — its appearance means reef somehow entered the stage canvas).
- [ ] **B1 in the browser:** a full Bumper Shells match renders (not black) — the arena, shells,
      pickups, particles, and the chase camera. Record `gl.info.render.calls` from the console.
- [ ] Controls: W thrust, A/D carve, S coast, Space/Shift jump, Q item, click item, mobile A/B.
- [ ] Leave to world ⇒ **fade**, world instantly live, no loader, avatar where it was left.
- [ ] Play Again ⇒ **fade** (the §2a href contract + `WorldStageRoot.tsx:184` strip, in the
      browser), new room boots, previous room's HUD state gone.
- [ ] Round trip ×5; FPS on `/game` after the fifth return ≥ the current 40–45 floor.
- [ ] Deep-link cold `/activity/reef-race/<real room>` with zero world asset fetches; the first exit
      runs the world's ONE first boot **with** the loader (expected and correct).
- [ ] Bumper spectator `free`/`follow`/`action`; `OrbitControls` drag works (the pointer-contract
      check that matters most for bumper).
- [ ] `?webgl=1`: the stage falls back to the WebGL backend and the round trip still fades; the
      activity canvas is unaffected (it was always WebGL).
- [ ] `/cove` and `/kelp` round trips still fade both ways.

### 6.10 Mobile / iPad sweep — MANDATORY

`chrome-devtools` `emulate <w>x<h>x2,mobile,touch`, portrait AND landscape at 390×844, 744×1133,
820×1180, 1024×1366:

- [ ] `ActivityMobileControls` A/B buttons visible, ≥44 px, not covered by the HUD, the results
      modal, or the wait-at-finish overlay.
- [ ] The Leave button is reachable at every size.
- [ ] No two fixed/absolute elements overlap.
- [ ] **Interaction, not layout:** drive a live match and confirm the A/B buttons dispatch
      `clawville:activity-action` and move the kart.
- [ ] Gating uses `useIsMobile()`; grep the diff and reject any bare `md:`/`max-width` gate on new
      code.
- [ ] `LobbyLanding` and `FullScreenStatus` fit and are dismissable at every size.
- [ ] **Stated limitation:** devtools has no `env(safe-area-inset-*)`, so bottom-anchored controls
      CANNOT be proven in emulation — a real-iPad screenshot from the founder is required.

### 6.11 NEW `--lane=activity-gpu` — the co-residency + context-loss gate (M3)

The named JS-side metrics are insufficient: `readStageResourceLedger()` is a scene-resource
ESTIMATE (`resource-ledger.ts:128-140`, byte estimation `:244-313`),
`readStageRendererCounters()` returns `texturesSizeBytes: null` and `memoryTotalBytes: null` on the
WebGL backend (`WorldStageCanvas.tsx:512-522`), the activity canvas's `renderer.info` reports
object/call counts rather than bytes, and `performance.memory` is JS heap. On Iris Xe the budget is
unified/shared GPU memory.

- [ ] Record an **OS-level GPU shared-memory counter with process attribution** (Windows ETW /
      `Get-Counter "\GPU Process Memory(*)\Shared Usage"`) at: idle `/game`, during an activity
      dwell, and after the return + forced GC. Record peak and plateau, and the same three points
      on `origin/staging`. **Report the deltas honestly.**
- [ ] `maxLiveContexts === 2` during dwell; `=== 1` within 5 s of the return (retirement proof).
- [ ] Across 30 room re-keys, live contexts never exceed 2 (no accumulation).
- [ ] **Independent loss drills:** force `WEBGL_lose_context` on the ACTIVITY canvas ⇒ the
      `'canvas-lost'` page panel appears, retry recovers, and `useStageStore().recovery.count` is
      UNCHANGED. Force a stage recovery (`health.requestRecovery('drill')`) while an activity is
      active ⇒ the stage recovers, `recovery.count` bumps, and the resident activity page **re-acks
      readiness** (the §2b path that only this drill exercises).
- [ ] If race FPS during the dwell regresses below the pre-migration measurement, the world-slot
      eviction tier (§8.2) becomes a BLOCKING prerequisite rather than a follow-on.

---

## 7. Docs to update in the SAME diff

| Doc | Edit |
|---|---|
| `3dStructure.md` | New "P4 activity cutover" block: the OVERLAY-SLOT model and **why** — the `ShaderMaterial`/`NodeLibrary` incompatibility with the `three.webgpu.js:86728-86740` citation and the precise m1 phrasing. Record that reef/bumper import plain `'three'` **by design** and MUST NOT be "unified to `three/webgpu`" the way cove was. Record the reef camera/fog constants mirrored into the slot. Bump "Last Audited". |
| `GameFeatures.md` | Leaving an activity is a fade; the body stays present tagged "in an activity"; Play Again is a fade. |
| `ARCHITECTURE.md` | `/activity/[activityId]/[roomId]` group membership; the `activity` slot; `overlayOpaque` + the outgoing-overlay handoff **and its hold-and-surface timeout (two recovery actions, no Stay)**; the `activityTarget` destination-identity field, the `stageDestinationKey` destination-aware routing rule, and **the `openedMidpointRef` opaque-lineage rule that governs when route children install (§2m) — document the three-clock ordering (`onOpaque` → `activateScene` → router commit) explicitly, because it is the non-obvious fact that makes displayed-path comparison wrong here**; **the `__wsnav` nonce contract — `${documentEpoch}.${sequence}` (`crypto.randomUUID()` epoch) minted in a MODULE-scoped lineage store whose DOCUMENT-scoped lifetime is frozen (survives root remount and stage reset; cleared only by document teardown), settled by id, six landing classes incl. `foreign` for a bookmarked URL, the atomic `acceptNavigationIntent()` at all four accepted-navigation sites so at most one issue is live AND intent can never lag behind it, **the deliberate ABSENCE of in-session stripping** — component-issued URLs retain `__wsnav` for the life of the history entry and the six landing classes carry all correctness (v13 scope ruling: four rounds and three protocols failed to make a strip lifecycle total, most decisively because Next 16.2.3 uses `preserveCustomHistoryState: true` for history traversals, so a traversal to a marked entry satisfies any marker test); a boolean guard can be consumed by an unrelated landing, and a URL-equality guard cannot tell a same-href landing from the strip's own rerun — R10-B1), and `commitStageNavigation`'s `{history, countTowardStageHistory}` options used only by the repair. INVARIANT N and the navigation issue ledger (§2m-A) — every issued router navigation is one record until it lands or retires; a landing settles the record it belongs to; a superseded landing installs nothing and repairs the URL. Note that an issued App Router navigation cannot be cancelled, so recognition-plus-repair is the only available remedy, and document the count/age retirement bounds**; `decideStageNavigationOwnership`'s destination inputs (§2n); the probe's new `committedStageNavigations` field; **R14-2b: the probe is GATED — `window.__WORLD_STAGE_PROBE__` is installed only when `process.env.NEXT_PUBLIC_ENABLE_STAGE_PROBE === '1'`, so the activity-widened `navigate` is absent on production**; `useActivityWs.leaveAndClose()` and its best-effort bound; `AT_ACTIVITY`; the downlink-suspension parameter **plus the `dropFailedSource()` / `invalidateStream()` split, the `activeRetryToken` retry lineage, `pendingReopen` on BOTH downlink rules, **INVARIANT R and the five-site open table (§2k-A) — while `recoveryInFlight`, only the recovery may open a source; `recoveryInFlight` on rule 2 ONLY (with the reason it must not reach rule 1); the busy-vs-failed ambiguity in `recoverWithTicket()`; the bounded busy-wait ceiling and the ownership transfer to the tick edge; **the INDEPENDENT `deadline` promise raced against the whole fetch-plus-body (not an `AbortController` alone) and the single lease-CAS `settleRecovery` through which every settlement passes**; and the `bootstrap()` unreachability proof**, the `OPEN`-edge land invalidation, and the `pageshow` membership reset**; `PROTOCOL_VERSION` 43. |
| `docs/persistent-world-canvas-plan-2026-07-24.md` | Execution-ledger row **P4**. **Correct the Phase-4 row itself** — its "3–5 days per activity" estimate assumed in-canvas slots; record that the in-canvas model is blocked on a shader port and re-scope. Rule-E6 punch-list entries: (a) OQ-1 in-canvas slot migration, owners `reef` + `world-stage`, deadline **2026-10-01**; (b) OQ-6 input-ruling decision if P4d is dropped, owner `world-stage`, deadline **2026-09-15**. **v4: the former item (b), `_renderedPoseByAvatar` unbounded growth, is DELETED rather than renewed — SELF-E verified the map is set and deleted by one effect (`ReefRacePlayer.tsx:1056-1064`), so there is no defect to track. Record the retraction in the ledger row so a later reader does not resurrect it from v1-v3 of this spec.** |
| `docs/world-stage-p4-notes.md` (NEW) | What moved; the AS-BUILT readiness + handoff behavior; the activity-route listener inventory; deviations from this spec; reviewer checklist; the §6.11 measured GPU numbers. |
| `deploy-status.md` | At push time: CURRENT STATE + honest DEPLOY LOG entry + `SCHEMA: synced`. |
| `docs/hatcher-integration-spec.md` | The four LIVE references to 43; **historical version-ledger entries appended to, never rewritten** (M5). |

**PARITY note required in the commit/PR body (Rule E5):** *"human path:
`/activity/[activityId]/[roomId]` via matchmaking — URL, REST, and WS flows unchanged; agent path:
unchanged — the activity vertical exposes no `[ACTION:]` verb and this diff touches no API route,
wire type, or settlement path; settlement binds to the same server-side `issueRewardsForRoom`
avatar resolution as before. The only agent-visible change is the `at-activity` co-presence
convention documented in the protocol manual at PROTOCOL_VERSION 43."*

---

## 8. Honest limitations and residual risk

1. **Entry is still a canvas cold boot — only the RETURN is a fade.** Walking into an activity
   mounts a fresh room-keyed `<Canvas>`; the user sees the stage's opaque overlay ("WARMING
   SCENE") instead of `SeaLoadingScreen`, and it lifts when the activity composes its first frame.
   The half the plan called the problem is fully solved; the entry half is OQ-1. **This asymmetry
   must be stated to the founder in these terms before sign-off — do not let "P4 done" imply
   activity entry became a fade.**

2. **Two GPU contexts are alive during a match and the world's textures stay resident.** Today at
   `/activity` the world canvas is destroyed and its ~491 MB of textures are freed. §6.11 measures
   the real cost with an OS-level counter (the JS-side metrics cannot see it). If it regresses race
   FPS, the mitigation is the plan's contract-4 low-end tier — evict the world slot while an
   activity is active — which is structurally supported (`WorldStageCanvas.tsx:875-889`) and would
   restore today's cold-boot-on-return for low-end devices only. **I am not claiming it will not be
   needed.**

3. **`renderPaused` for the whole duration of a match is a new stage state with no field
   precedent.** It is exercised today only by `pauseOnCreate` at boot and by the cove warm window.
   The health bridge's listeners, `resync`, and the 6 s adoption watchdog are effects and keep
   running while paused, and §6.11 now drills a stage recovery **while paused with an activity
   active** — the path v1 left unverified.

4. **The `leave` frame's timing is CHANGED, and here is the honest bound — restated for v4.** v1
   claimed "≤250 ms"; that was wrong, because the socket cleanup runs when the held page actually
   unmounts, not at the opaque midpoint. v2 claimed a hard `10 s` ceiling by force-unmounting at the
   timeout — which round 2 correctly identified as a voluntary FORFEIT of a live match for a
   navigation that never committed. v3 removed the ceiling but claimed two guarantees it did not
   have, and round 3 was right about both. **v4's bound, stated without a guarantee I cannot test:**
   - **Normal crossing:** `250 ms fade-out + App-Router commit latency`, and the fade cannot
     complete before `leave` fires. Unchanged, and it is the case that matters 99% of the time.
   - **Stalled crossing:** no ceiling, deliberately. The timeout only reports. The cover holds, the
     match stays live, nothing unmounts, no `leave` is emitted.
   - **Stalled crossing, Hard navigate:** `leaveAndClose()` queues the frame on an OPEN socket
     before `location.assign`. **Delivery is best-effort at document teardown, not guaranteed.** If
     lost, the player takes the ordinary close path and the existing `RECONNECT_GRACE_MS = 10_000`
     window (`activity-ws-hub.ts:103`) ends in a `'timeout'` forfeit rather than a `'voluntary'`
     one — strictly gentler, so the failure direction is safe. §6.5 asserts the frame on the happy
     path; nothing here asserts it always arrives.
   - **Stalled crossing, Retry:** best-effort by construction. It re-attempts the navigation; it
     cannot cancel the first one, because `commitStageNavigation` (`WorldStageRoot.tsx:165-176`)
     keeps no handle and the App Router exposes no cancellation.
   - **What v3's "Stay" implied and v4 does not:** that a player could decline the crossing and be
     sure the stalled navigation would never commit. That was never implementable. The action is
     removed. What remains true is that the match is not torn down by waiting.

   **Trade stated plainly:** v4 chooses "a stalled player keeps playing behind a cover, with two
   honestly-labelled exits" over "a stalled player is forfeited on a timer" and over "a stalled
   player is offered an exit that lies." The residual is that a player who ignores the surface sits
   behind an opaque cover indefinitely; the 45 s stage watchdog still surfaces its own error card
   underneath, and §6.5's stall drill exercises the whole path.

5. **Pre-existing activity defects, dispositioned.** FIXED here: bumper's stale
   `_hitCheckScratch`/`_elimCheckScratch` across a room change; the `shortCode`/`lobbyGate`/
   spectator-state room bleed (closed structurally by the `ActivityRoomRuntime` key); the missing
   force-dynamic guard on `/activity`. **RETRACTED (SELF-E):** `_renderedPoseByAvatar`'s "unbounded
   growth" was never real — `ReefRacePlayer.tsx:1056-1064` sets and deletes the entry in one effect,
   so the map is bounded by live rendered players. v1-v3 of this spec carried the false claim in
   §5c and §7 and round 3 inherited it while debating how to test it; both the claim and its
   punch-list item are gone. Nothing is now listed as "tracked, not fixed". All the real ones are
   pre-existing on `origin/staging` — confirm with a stash before attributing any to this diff.

6. **`NEXT_PUBLIC_REEF_RACE_USE_SPLINE`'s production value is unknown to me.** OQ-4 requires
   confirming it on both boxes before promotion; §6.9 drives both settings locally.

7. **`PROTOCOL_VERSION` 43 pulls the PROTECTED partner surface into a render migration.** Real
   scope: one manual string, one constant, three test pins (one of them widened), one spec
   reconcile, one staging harness run. It is isolated in commit **P4b** so the founder can drop it
   without touching the migration.

8. **I did not read `ReefRacePlayer.tsx` in full** (2,967 lines). I read its `useFrame`
   registrations (`:947`, `:1771`, priority `-2` at `:2902`), its module state (`:506`), and — new
   in v4, and the read that produced SELF-E — the full `_renderedPoseByAvatar` lifecycle effect at
   `:1046-1064`. That is enough to establish that Option B leaves the file entirely untouched, that
   it makes no renderer-level assumption beyond the plain-`three` materials already covered, and
   that the leak three versions of this spec asserted does not exist. Under Option A it would need a
   full read. A reviewer should confirm nothing in it reaches for the stage canvas or
   `three/webgpu`. §6.1's diff-scope gate is what mechanically holds the "untouched" promise.

9. **The `activity-exit`, `routes --pair=activity`, and `activity-gpu` lanes need fixtures that do
   not exist yet** — an activity room-state + WS stub, and OS-level GPU counter plumbing into the
   probe. That is new probe work with its own bug surface. If a fixture proves expensive, the honest
   fallback is to run the lane against a locally-running API and say so in the notes — **not** to
   weaken the assertions.

10. **P4 delivers zero rendering improvement, by design.** Bloom, water, and every reef visual are
    preserved by NOT moving them. Nobody should read "reef joined the world stage" as "reef now
    shares the world's renderer"; §7's `3dStructure.md` entry exists specifically to prevent that
    misreading later.

11. **The children-swap effect and `handleTransitionOpaque` are the single highest-risk hunk in
    this phase, and v4 already broke them once.** The outgoing-overlay gate is request-scoped so
    cove/kelp/world provably never see it, and §6.2 pins that. v3 added a shared-store field
    (`activityTarget`, §2m). v4 then rewrote the children-install rule around
    `destinationKey === displayedKey` — **and that change would have wedged `/game`↔`/cove` and
    `/game`↔`/kelp`, two crossings that work on `origin/staging` today**, because `activeScene`
    advances at the opaque midpoint while `displayedPathRef` advances at children-install and the
    two are never in phase (R4-B1). v5 replaces it with the `openedMidpointRef` lineage rule.

    **What a reviewer should actually check here, in order.** (a) Drive the three handler-owned
    crossings and confirm they still fade — that is the regression v4 would have shipped, and §6.2
    plus §6.5 both gate it. (b) Confirm the install rule never compares `pathname` against
    `displayedPathRef` except through the existing `pathAlreadyDisplayed` equality; any *derived*
    comparison of those two is the R4-B1 shape returning. (c) Check the `null` handling:
    `stageDestinationKey` returns `null` for a non-stage pathname, and a `null === null` comparison
    must not read as "same destination" — the effect early-returns on `!sceneId` before any
    comparison, so verify that early return survives the edit. (d) Confirm
    `openedMidpointRef` is cleared on mint and on reset, so a stale record cannot authorise the
    wrong children.

    **Honest statement of confidence.** This hunk has now been specified wrong twice and repaired
    twice under adversarial review — v4 compared operands that are never in phase (R4-B1), and v5
    left an issued router commit with no lineage at all (R5-B1). The v6 rules are derived from the
    anchor ordering quoted verbatim in §2m rather than from arguments about equivalence, and every
    clause has a test that fails against the version it replaces — but **none of it has been run.**
    Treat the handler-owned crossing tests and the stale-commit test as the gate, not the prose.

    **Six blockers across rounds 4-6, two areas, one shape.** Every one was a value authoritative on
    one side of a hand-off and unowned on the other: midpoint→children, error→retry,
    `commitStageNavigation`→router commit, `recoverWithTicket`→its own busy guard, C's issuance
    over B's record, and the timer's bare branch under a live recovery. Rounds 5 and 6 each patched
    the reported instance and each produced the next adjacent race. **v7 stops doing that** — §2m-A
    and §2k-A state an invariant, build a mechanism able to express it, and enumerate every site with
    a proof. A round-7 defect in either area should be expressible as "site X violates invariant Y";
    if it cannot be, the invariant is wrong and should be replaced rather than patched.

    **FRAMEWORK-behavior assumptions I have NOT verified (new in v9, after R8-B2).** Round 8
    overturned a Next.js premise I asserted without opening `package.json`, so the remaining ones are
    listed rather than left implicit. All are stated against the resolved **`next@16.2.3`**:
    (a) that `useSearchParams()` returns a NEW object identity per navigation, which is what makes it
    a usable effect dependency — I am relying on documented behavior, not a read of the runtime;
    (b) ~~that the hook sync is synchronous with respect to the calling effect~~ — **RESOLVED, and the
    hedge that stood here was itself the defect (R9-B2).** v9 wrote "the guard is safe either way",
    which was false: a boolean guard cannot tell WHICH landing it is suppressing, so an unrelated
    navigation committing first consumed it. v10 does not need the ordering fact at all — the guard
    stores the exact expected URL and compares identity, so a mismatched landing clears the stale
    guard and proceeds. **Where a framework-ordering guarantee is unavailable, carry identity rather
    than a hedge;** (c) that a `force-dynamic` group layout is sufficient for a client
    `useSearchParams()` without an additional `Suspense` boundary. **Each is checkable in an
    afternoon against the installed package, and each should be checked before implementation
    rather than during review** — that is the whole lesson of R8-B2.

    **The hand-offs in this diff I still have NOT proven**, stated so a reviewer can aim: the
    `queueMicrotask` between the readiness probe's second frame and `onPainted` (§2c); the gap
    between `setActivityTarget` and the page's selector subscription observing it (§2b); and the
    `leaveRef` publication between the room-keyed subtree and the page-level recovery surface (§2g).
    All three are same-tick and I believe they are safe — but "I believe" is exactly what preceded
    the last four findings, and none of them has an invariant written down the way §2m-A and §2k-A
    now do.

12. **Chunk-retry recovery is bounded by the bundler, and I did not verify that bound.** §2i mints a
    fresh `React.lazy` payload per attempt, which is what makes "Try again" meaningful at the React
    layer. Whether the underlying chunk loader re-issues a NETWORK request for a chunk whose
    previous fetch failed is a property of the bundler runtime; `next.config.mjs:74` configures
    `turbopack` and **I did not read its chunk-loading error path**. So "Try again" is specced as
    best-effort and **Reload is the primary, guaranteed action** — the same conclusion P3 v4 §8.13
    already reached for the kelp chunk panel. If a reviewer establishes the bundler's semantics
    either way, §2i's action ordering should be revisited with that evidence.

13. **The bfcache membership reset is new behavior on a shared hook.** The `pageshow`-persisted
    reset (§2k) affects EVERY route that mounts `useWorldStream`, not just `/activity`. It is
    strictly a repair — today a bfcache-restored page holds a session the server already released
    — but it is a behavior change outside the migration's nominal blast radius, it lands in the
    independently-revertable P4c, and §6.2 pins both the `persisted: true` and `persisted: false`
    branches.

14. **Round 2's B2 mechanism was wrong and I am relying on my own reading instead.** The critique
    cited `loadable.shared-runtime.js` (the pages-router runtime); the App Router aliases
    `next/dynamic` elsewhere (`create-compiler-aliases.js:228`). I verified the alias, the
    `lazy`-based `lazy-dynamic/loadable.js`, and React's rejection caching this session, and §2i
    quotes each. A reviewer who disagrees should re-run exactly those three reads before touching
    §2i — the whole retry design hangs off them.

---

## 9. Migration / rollout + revert story

### Rollout

One PR on `feat/world-stage-p4-activity`, stacked on merged P3, as **four independently-verifiable
commits** (mirroring P3 v4's structure):

| Commit | Scope | Verified by |
|---|---|---|
| **P4a** |NO in-session stripping — component-issued URLs retain `__wsnav` for the life of the history entry (v13 scope ruling)| §6.1 (incl. the diff-scope gate) – §6.6, §6.9, §6.11 |
| **P4b** | Presence: `AT_ACTIVITY`, `WorldPresence`, `remote-players`, `PROTOCOL_VERSION` 43 + pins + spec | §6.2 presence pins · §6.8 PROTECTED harness gate |
| **P4c** | Downlink suspension: `decideWorldDownlink` (with `pendingReopen` on BOTH rules) + the `downlinkEnabled` parameter + the `dropFailedSource()`/`invalidateStream()` split + `activeRetryToken` + `recoveryInFlight` on rule 2 + **the TOP-of-timer ownership guard and the `RECOVERY_WAIT_CEILING_MS` hand-off (§2k-A, INVARIANT R)** + **bounded recovery: an INDEPENDENT `deadline` promise raced against the entire fetch-plus-body + the single lease-CAS `settleRecovery` that is the only writer of `recoveryInFlight` + `AbortController` as cleanup (R7-4, R8-B4)** + the busy⇒re-arm continuation + `streamEpoch` + the triple guard on every listener + the `OPEN`-edge land invalidation + the `pageshow` membership reset | §6.2 downlink suite (64) · §6.6 stream assertions incl. the R3-B2/R4-B3 browser drills |
| **P4d** | Shared `attachHeldKeyListeners` primitive (the ruling-compliance extraction), with `extra` routed through the string-typed `addStageEventListener` | §6.2 equivalence suite · §6.9 controls drive |

**"Independently green" is the acceptance bar for each row (R2-m1(g)), and it means:** the commit
builds, `bun run typecheck` is clean, ITS OWN §6.2 suites pass, and every previously-green suite
still passes — with the commit applied alone on top of merged P3. Round 2 judged P4a and P4c not
green because of R2-B1/B2/B2b/B3 and R2-M1 respectively; round 3 reopened the same two rows because
R3-B1/B3 kept P4a open and R3-B2 kept P4c open; **round 4 reopened them a third time** because
R4-B1/B2 kept P4a open and R4-B3/B4 kept P4c open. The v5 repairs: P4a gets the `openedMidpointRef`
opaque-lineage install rule, scene+destination pending equality, destination-aware ownership, and
and the cleared parked navigation (§2m, §2n); P4c gets the `dropFailedSource()`/`invalidateStream()`
split, `activeRetryToken`, and `!pendingReopen` on rule 2 (§2k).

**Round 5 reopened them a fourth time** — R5-B1 kept P4a open and R5-B2 kept P4c open — and v6
responded with the single-slot `issuedCommitRef` (§2m) and `recoveryInFlight` on rule 2 plus a
busy⇒re-arm continuation (§2k). **Round 6 reopened both a fifth time**, because a single slot cannot
represent two overlapping commits (R6-B1/B2) and a re-arm is a delay rather than ownership (R6-B3).
**v7 replaces both point fixes with invariants:** P4a gets INVARIANT N and the navigation issue
ledger (§2m-A); P4c gets INVARIANT R and the five-site enumeration (§2k-A). The difference that
matters for this criterion: a reviewer can now check "does every site obey the stated invariant?"
rather than "has every reported race been patched?"

**The property that makes "independently green" mean something is that the decisive tests fail
against the version they replace, and §6.2 names which version for each.** The six that matter most:
`{wanted:false, open:false, pendingReopen:true} ⇒ CLOSE` fails against v3; "pathname-first A→B mints
a request" fails against v3; the three handler-owned crossing tests fail against v4; the positive
enabled-error recovery test fails against v4; **the stale-issued-commit test fails against v5**; and
**`{recoveryInFlight:true} ⇒ NONE` fails against v5**. Every one of them exists because its absence
let a real defect read as green — a guard with no negative test, a "nothing happens" assertion with
no "something happens" counterpart, and now a hand-off with no record of what was handed off
(SELF-F, SELF-G). P4b was already structurally isolated; P4d needed only the `WindowEventMap`
correction, which §2l applies.

**Additional pre-merge gate for P4a, because it now touches code every route depends on:** run the
inherited `--lane=routes --pair=cove` and `--pair=kelp` lanes and the `--lane=kelp-exit` lane
**with P4a applied alone**, and diff their committed JSON against the pre-P4 baseline. Those lanes
already exist (§6.4) and they are the cheapest mechanical proof that the §2m rewrite did not break
a working crossing. A byte-diff in the cove or kelp summary is a hard stop, not a tuning exercise.

1. Nothing is pushed until all four are green locally, including §6.7's real-race row diff.
2. Merge → `staging`; push; verify the container `SOURCE_COMMIT` equals the pushed sha (queue rows
   lie); update `deploy-status.md` same-diff.
3. Run the PROTECTED-surface harness gate (§6.8) against `api-staging`.
4. Founder eyes on `staging.clawville.world`: a full Reef Race round trip, Play Again, the
   side-by-side water/bloom comparison, a full Bumper match (the B1 proof), and a real-iPad
   screenshot. **The §8.1 entry-vs-return asymmetry is stated in the sign-off request, in plain
   language.**
5. Only then: `gh pr create --base master --head staging` and merge.

**No user-facing rollout flag** — per-commit revert is the rollback mechanism. *(The one env gate this diff adds, `NEXT_PUBLIC_ENABLE_STAGE_PROBE`, is a debug gate, not a rollout control: it is unset in production by design and gates only the verification probe.)*

### Revert story — per symptom

| Symptom | Revert | Why it is safe |
|---|---|---|
| Any visual difference in the race (water, bloom, karts, void) | **The whole PR**, and re-open this spec | Option B's premise is byte-identical rendering; a delta means a §0.3 assumption was wrong and no partial revert is trustworthy. |
| **Bumper canvas is black** | **The `<ActivityCanvasReadyProbe>` mount in `BumperShellsScene.tsx`** first | This is B1's failure signature; the probe is the only new frame subscriber in that canvas. Readiness then falls back to terminal branches only, which is degraded but not black. |
| Race FPS regressed on the Iris Xe floor | **P4a**, or land the world-slot eviction tier first | Confirms §8.2; the route returns to its own top-level page and the world is destroyed on entry again. |
| Fade lifts onto the old activity page, or the cover never lifts | **The `outgoingOverlay` hunks in `stage-store.ts`, `StageTransition.tsx`, `WorldStageRoot.tsx`** (and `ActivityHandoffRecovery.tsx`) | Isolated and request-scoped; reverting restores today's (racy) behavior without touching the migration. |
| Fade lifts before the DESTINATION activity room has painted (activity→activity) | **The `activityTarget` hunks (§2m) plus readiness rules 2/4/5** — but treat this as a hard stop, not a revert-and-ship | This is R2-B1's exact signature. If destination binding is failing, readiness is speaking for the wrong room and no other gate catches it; re-open this spec. |
| **Activity A→B via back/forward shows B instantly with no fade, or hangs behind a cover that never lifts** | **The `stageDestinationKey` / `openedMidpointRef` hunks in the children-swap effect and `handleTransitionOpaque` (§2m)** — and treat it as a hard stop | The two symptoms are the two halves of R3-B1/SELF-C: an instant swap means the install rule is still scene-level; a permanent hang means the rules were changed partially. They must move together, so a partial revert of this hunk is not safe either — revert all of §2m or none. |
| **`/game`↔`/cove` or `/game`↔`/kelp` stops fading after P4a — the destination page never appears, or the cover never lifts** | **The `openedMidpointRef` install rule (§2m)**, immediately, and treat it as a hard stop | **This is the exact R4-B1 signature and it is a REGRESSION on routes that work today.** It means the install rule is once again gated on something that has not advanced by the time route children commit — most likely a comparison against `displayedPathRef`. Do not patch it forward: §2m's ordering table is the reference, and §6.2's three handler-owned crossing tests plus §6.5's browser regression gate exist specifically to catch this before it ships. |
| **World stream never recovers after a transient SSE error while ON `/game`** (no reopen, `npcConnected` stays false) | **P4c**, immediately | **This is the R4-B3 signature** — the retry continuation is being invalidated by the same primitive that handles the error. Reverting P4c restores an always-open downlink with the anchor's backoff. Check that `onerror` calls `dropFailedSource()` and NOT `invalidateStream()`, and that the continuation's guard is `activeRetryToken`, never `streamEpoch`. |
| **`/join` budget exhausted, or `MAX_RETRIES` burned within seconds of an SSE blip** | **P4c** | **The R4-B4 signature** — rule 2 is firing while a reopen is owed, so the 200 ms tick is racing the 3s/6s/12s backoff. Confirm rule 2 carries `!pendingReopen` and that `pendingReopen` is `activeRetryToken !== null`, not `retryTimeout !== null`. |
| **A crossing lands on the WRONG destination after two rapid navigations** (URL and stage disagree, or the stage settles on the older target) | **The navigation issue ledger (§2m-A)** — hard stop | **The R5-B1 / R6-B1 signature.** An issued router commit is being treated as a fresh arrival instead of a superseded one. Check, in order: `issueNavigation` is called from `commitStageNavigation` (not at the midpoint — the `EXECUTE_NOW` branch has no request); every accepted navigation — including the handler's `ADOPT` branch, which mints nothing — routes through **`acceptNavigationIntent()`**, the single writer of supersession AND intent, so at most one record is ever `in-flight` and intent can never lag it (R8-B1 + R9-B1); `settleIssue` matches **by nonce id**, never by destination (R7-1); the nonce carries `${documentEpoch}.${seq}` so a foreign-document nonce is classified `foreign` and treated as a fresh arrival (R8-B3); and the stale-landing early return **parks nothing** — parking the stale children re-creates the defect one step later at the newer destination's midpoint. **If the symptom is that the URL is wrong but the stage is right**, the failure is `repairUrlToCurrentIntent`, not the ledger. |
| **The address bar shows the OLD room while the stage shows the new one, after a back/forward or direct-URL crossing** | **`repairUrlToCurrentIntent` + `getNavigationIntent()` (§2m-A)** | **The R6-B2 signature, and it is specifically the pathname-first path** — that path mints through the children effect and parks no navigation, so nothing issues a corrective commit unless the repair does. Check `getNavigationIntent()` returns the full canonical href the accepted navigation recorded. Verify the repair goes through `commitStageNavigation(nav, {history:'replace', countTowardStageHistory:false})` — an unregistered `router.replace` lands with no nonce and is mistaken for a fresh arrival — and that it does NOT increment `committedStageNavigationsRef`, which would move the push/replace threshold §6.5 pins. |
| **World stream opens the OLD room during a reconnect, or two sources race after a 409** | **P4c** | **The R5-B2 signature.** Either rule 2 is missing `!recoveryInFlight`, or the escalation continuation is reading `recoverWithTicket()`'s `null` as failure when it means BUSY. Both `recoverWithTicket` and `rejoinWithTicket` return a bare `null` when busy without dispatching `RECOVERY_FAILED`, so the continuation must re-check `recoveryInFlight` after the await. |
| **World stream never reopens again after a failed ticket recovery** (permanently silent, no retries) | **The busy-branch of the retry continuation (§2k-A)** | **The SELF-G signature** — the continuation returned early on a busy recovery instead of re-arming, leaking `activeRetryToken`. `pendingReopen` is now stuck true and rule 2 can never fire. Confirm the busy branch calls `armRetry(...)` rather than `return`, and that the ceiling path clears `activeRetryToken` before returning. |
| **A second SSE source opens underneath a slow `/join`** (two streams, duplicate snapshots, or a `/join` budget burn during a reconnect) | **P4c — the `armRetry` timer body (§2k-A site 2)** | **The R6-B3 signature.** The `recoveryInFlight` check has drifted BELOW the escalate/bare branch, so the `!shouldEscalate` bare reopen fires underneath a live recovery. It must sit at the TOP of the timer body. **And check that §2k-A's independent `deadline` promise still races the WHOLE fetch-plus-body** — if that regressed to an `AbortController` alone, a fetch that ignores the signal leaves `recoveryInFlight` set forever and the ceiling hands ownership to an actor that cannot act (R8-B4). Walk §2k-A's five-site table and confirm each site still obeys INVARIANT R. |
| An activity page shows a stuck cover with a Hard-navigate/Retry panel | **Not a bug — that is §2d item 4 reporting a stalled App Router commit.** Capture the console warn + `outgoingOverlay` and investigate the navigation, not the stage | The alternative (v2's force-unmount) forfeits a live match, which is strictly worse. Note there is no "Stay" — R3-B3 removed it because it could not actually prevent a late commit. |
| A world stream stays open during a match, or reopens mid-match | **P4c** | The `streamEpoch` + `downlinkEnabledRef` guards are all in that commit; reverting restores an always-open downlink, which is today's `/game` behavior. |
| Transition hangs entering an activity | **P4a** | The readiness machine is the only new gate on the fade. |
| Play Again cold-boots the world | Re-apply the `WorldStageRoot.tsx:184` query strip (§2a) — do NOT revert the phase | One line, isolated, pinned in both directions. |
| Stage stays black after returning | **The `StageIdlePause` hunk in `StageHostedActivityScene.tsx`** | Cheapest single change that can cause it. |
| Remote players missing / world presence odd | **P4c**, then **P4b** | The downlink suspension is the only thing that closes the stream; the tag is a leaf. |
| Activity controls feel different / inputs dropped | **P4d** | The extraction is the only thing that touched the live input path; everything downstream is unchanged. |
| A player forfeits when they should not, or a placement is wrong | **The whole PR**, immediately, and re-run §6.7's row diff | Money path. No fix-forward on staging. |
| Partner/protocol complaint | **P4b** only | Isolated by design. |

If the first attempt breaks in a way not listed, revert to the last green sha rather than fix
forward on staging, and re-open this spec with the failure recorded.

---

## 10. Open questions

**OQ-1 — When does the in-canvas slot model land, and in what order?** FROZEN RECOMMENDATION:
**Bumper Shells first, Reef Race second, both AFTER P4 ships.** Bumper needs no shader work (§5b)
and would prove the in-canvas activity slot end to end — camera, per-room reset without the `key`,
`OrbitControls` ownership, spectator-mode re-key — at a fraction of reef's risk. Reef then needs the
GLSL→TSL port of ~440 shader lines plus a node-graph bloom replacement, scoped and estimated on its
own as a Rule-E3 collaboration with 3da. Tracked with owners and a **2026-10-01** deadline in the
plan ledger (§7) — a tracked entry, not a code comment (Rule E6.1).

**OQ-2 — Presence tag vs protocol scope. FROZEN CHOICE: ship the tag.** `AT_ACTIVITY` requires
`PROTOCOL_VERSION` 42 → 43 and the full partner mandate. The alternative — emitting `'idle'` —
leaves a player in a live race appearing as a motionless untagged avatar, strictly worse than the
cove and kelp treatment. Isolated in **P4b**, so the founder can drop that commit.

**OQ-3 — Should leaving an activity teleport the world avatar?** Specced NO (§2h). Cove and kelp
teleport because the player walked through a door; an activity is entered from a queue, so there is
no matching door — but the founder may want the avatar parked at an "arena entrance" landmark. A
gameplay decision, not a migration decision; ~10 lines of `onMidway` if wanted.

**OQ-4 — What is `NEXT_PUBLIC_REEF_RACE_USE_SPLINE` on the boxes?** Absent from `.env.example` and
unreadable from here. It changes which branch the entry fade lifts onto. **Must be confirmed on
staging and prod before promotion**; §6.9 drives both locally regardless.

**OQ-5 — Should `/activity` sub-paths ever exist inside the group?** `sceneIdForPathname` returns
`null` for any depth other than exactly `/activity/:a/:r` (§2a), so a future
`/activity/:a/:r/replay` would live outside the group and cold-boot — the same rule `/cove/history`
follows. Flagged so the constraint is a decision, not an accident.

**OQ-6 — The input ruling (M4).** P4d extracts a neutral `attachHeldKeyListeners` into
`player-input.ts` consumed by both the avatar controller and the activity keyboard effect, while the
30 Hz send loop and action-bit mapping stay activity-specific (§5d). The alternative is an explicit
founder ruling that "shared focus-reset registry only" satisfies the unified-capability directive
for a vehicle/wire controller, in which case **P4d is dropped**. This spec does not make that call
unilaterally; it ships the compliant version and asks. Tracked in the plan ledger with a
**2026-09-15** deadline if P4d is dropped.

---

## REVISION LEDGER — round 15 (FREEZE — APPROVE-WITH-FIXES applied verbatim)

Round 15 returned **APPROVE-WITH-FIXES**: no unresolved design decision, the seven-row provenance
contract total and internally consistent, `issuedHighWater` coherent (module-scoped, no landing/counter
race, survives remount and `resetStageStore()`), the malformed choice safe, the corrected residual
honest against the anchor, the gate patterns real, and **270 plus the identity chain reconciled on
independent recount**. Per the loop protocol the four required fixes were applied **verbatim** and the
spec is **FROZEN at v16**. No round 16.

| Fix | What changed | v16 location |
|---|---|---|
| **1 — duplicate classification passages** | Three alternate behavior tables DELETED, each replaced by the report's exact sentence: *"Current landing behavior is defined exclusively by the seven-row frozen provenance table in the round-14 ledger; this passage adds no alternate classification rule."* Every "six-row"/"SIX-row" label → **seven-row** (three sites), while **"six distinguishable outcomes" is retained**. Both "always … untouched" claims rewritten to the report's exact sentence: *"Landing classification, not stripping, carries correctness; v15's final six outcomes are defined exclusively by the seven-row table."* | §round-12 ledger (~L749), §round-13 ledger (~L798), §2m-A landing table (~L2880); labels at ~L250, ~L839, ~L2900; claims at ~L227 and ~L3660 |
| **2 — withdrawn residual bound** | R13-1c annotated **"SUPERSEDED BY R14-2/R14-2a: the former 'no money path' bound is withdrawn."** The ruled wording installed **verbatim** as the operative bound. The four surviving `no money path` strings are all historical — the v14→v15 scope delta, the superseded-marked R13-1c row, and the two round-14 finding statements that quote the defect being corrected. | R13-1c row (~L792); ruled wording in the R14-2a row (~L833) |
| **3 — probe-gate build/deploy coherence** | `.env.example` added to §1 scope with `NEXT_PUBLIC_ENABLE_STAGE_PROBE=` and the report's comment. §4 rewritten: declares this single new debug env gate as the only new `process.env` read, requires **local and staging CLIENT BUILDS to receive the flag at BUILD time** (Next inlines it at build — a post-build shell export leaves the probe absent and every §6.4-§6.6 lane red), and adds **post-build checks** (local/staging assert the global is an object; production asserts `undefined`). "No feature flag" → **"no user-facing rollout flag"** in §4 and §9. | new §1a row (before the lineage-store row, ~L1035); §4 (~L3200); §9 rollback (~L4880) |
| **4 — antecedent ordering** | The restored R3-B1 pathname-first A→B mint bullet MOVED to immediately before the "A is retained" bullet, so the two "that same traversal" references now follow their antecedent. Weight unchanged. | §6.2 overlay suite (~L3835) |

**Nothing else moved.** Total remains **270**, overlay remains **81**, no re-derivations, no new
content beyond the four fixes. The §6.2 two-direction probe-gate test remains weight 2.

**Closing note on the review.** Fifteen rounds, thirteen of them rejections, across two orchestrator
scope rulings. The defects that survived longest were never arithmetic — they were **decisions frozen
in prose but not carried into the machinery** (R9-M1, R10-M1, R14-1) and **claims asserted about
things I had not opened** (R8-B2 and R11-2 on framework behavior, R13-4 on the query-consumer sweep,
R14-2 on the forfeit chain). Both classes pass a numeric check while the artifact disagrees with
itself, which is why the closing discipline in this spec is: *for every frozen statement, name the
operative site that implements it; for every claim about code you did not write, cite the line you
read.*
