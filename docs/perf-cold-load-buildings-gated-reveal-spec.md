# Buildings-gated reveal — spec (rev 3 FROZEN, 2026-08-20; R1 8+1 and R2 8+1 folded)

**Founder ruling (2026-08-20, session prf):** the slice-D proxy placeholder buildings are
DEAD — "we tried this once, it was a disaster; not a solution we're willing to use."
Chosen replacement (founder-selected): **no placeholders ever — the SeaLoadingScreen
holds until the 11 real streamed buildings are downloaded, parsed, uploaded, warmed,
AND visibly presented, then the world reveals complete.** Reveal MEASURED before
claimed. The 10s/45s fuses stay as fail-open (pop-in on slow nets, founder-accepted).

Branch: `perf/cold-load-diet` in cv-covefreeze, base `de14508c` (== origin/staging).

**Process note (rev 3):** Codex xhigh R1 (BLOCK, 8+1) and R2 (BLOCK, 8+1) are both
folded below. Blocker count plateaued → per the standing oscillation rule this rev is
FROZEN as spec+fix-list; the next Codex pass reviews the EMITTED CODE against it
(Rule E3 collaboration continues on the diff). R2 ledger: F8/F9 RESOLVED; F1–F7
partial residuals + NF1–NF9 all addressed by the rev-3 deltas marked [R2-NFn].

---

## 0. SUPERSESSION MAP vs frozen slice-D spec rev 5 [R1-F9 — RESOLVED]

This spec AMENDS `docs/perf-cold-load-rung4-sliceD-spec.md` (frozen rev 5). The
frozen gate evaluators (`--slice-d`, `--slice-e`) remain untouched historical
records; these rev-5 CLAUSES are superseded by founder ruling:

| Rev-5 clause | Status |
|---|---|
| Proxies are boot-core content / the streaming placeholder | SUPERSEDED — proxies deleted; nothing renders in a building spot until the real GLB presents |
| Building bytes/streams only post-reveal | SUPERSEDED — stage-A byte-fetch pre-reveal + stage-B mount/warm post-core-presentation (D1) |
| Overlay dismissal keys on BOOT_CORE_PRESENTED alone | SUPERSEDED — composite predicate (D3) |
| Guest reveal ≤5s watchdog assertion | SUPERSEDED — reveal rises by design; ship evidence = measured reveal + `bgrEvidence.valid` (D5) |
| "Deviation requires edit + re-review of rev 5" | Satisfied by this map + a banner at the top of rev 5 pointing here |

## 1. Current machinery — unchanged from rev 2 (verified in source)

Decorative release requires overlay-gone (first-paint) or 45s deadline;
BOOT_CORE_PRESENTED omits the overlay check; post-reveal stream eligibility =
release + milestone + overlay/curtain gone + visible. Buildings: module-scope
byte-warm + proxy→boundary→Suspense→DWA chain. Cohort: 16 ids, sticky terminals.
SeaLoadingScreen: `ready = forceReady || isBootCorePresented()`, 45s/10s fuses,
download/upload/compile bands. `deferred-warm.ts` compiles OUTSIDE the FIFO after
an `awaitBootCompileIdle()` snapshot — the root of R2-NF1.

## 2. Design (rev 3)

### D1 — TWO-STAGE building admission + FIFO-joined compiles [R1-F1, R2-NF1]

**Stage A — byte-fetch-only lane.** Eligible when the world boot epoch exists AND
tab visible (parks hidden; visibilitychange re-arms). Sole consumer: the
11-building `preloadKTX2Bytes` byte-warm (moved off the post-reveal queue; one
batch, no stagger), fired only in buildings mode `'glb'` (D6). Stamp
`__W3D_PHASES.bootBuildingsFetchKickAt`. Zero React/renderer/GPU work.

**Stage B — mount/parse/warm lane.** Building `released` flips admit only after
BOOT_CORE_PRESENTED has stamped at least once for the boot (own queue, staggered
one per idle tick, no quiet period, parks hidden, delivered-member remount
contract identical to the post-reveal lane). Stamp
`__W3D_PHASES.bootBuildingsStreamEligibleAt`. A renderer-generation bump (D4)
does NOT re-park stage B or revoke deliveries [R2-NF1 residual resolved
structurally by the FIFO change below, not by lifecycle policing].

**FIFO-joined compiles (the structural fix).** `warmDeferredObject`'s
compileAsync front no longer runs outside the chain after an idle SNAPSHOT — the
deferred-warm compile step is CHAINED through the renderer-wide boot-compile FIFO
(`chainBootCompile`), so ANY two compiles (boot, deferred rewarm, stage warm) are
totally ordered no matter which generation chains first. A watchdog-recovery boot
compile chained after a building rewarm simply waits behind it — slower recovery,
never corruption [R2-NF1: "every building compile must join the same FIFO rather
than snapshotting it"]. Upload/texture work in the warm stays outside the chain
(uploads were never the race). The FIFO's abort-on-failure + healing-render
semantics (slice E) apply unchanged.

Post-reveal lane (props/NPCs/land/legacy decorative): UNCHANGED, full predicate.

### D2 — settled (data) AND presented (render-proven) [R1-F3, R2-NF3]

1. **Data-settled (cohort, measurement, sticky):** `areBootBuildingsSettled()` =
   all 11 `building:*` terminal (`failed`/`ready-failopen` count). Stamp
   `__W3D_PHASES.bootBuildingsSettledAt` once, carrying
   `bootBuildingsSettledMode` + generation. Sticky across swaps (measurement
   only — NOT a reveal leg).
2. **Presented milestone (`BOOT_BUILDINGS_PRESENTED`) — the reveal leg,
   generation-keyed ack protocol [R2-NF3]:**
   - **Ack channel:** per-generation ack tokens `(cohortId, generation)` in
     `decorative-release.ts`. The milestone requires **11 live
     current-generation tokens** continuously while its two-frame counter runs;
     a generation bump clears all tokens.
   - **Success ack source:** `StreamedGLBBuilding` acks when BOTH hold for the
     CURRENT generation: (a) the visible tree has COMMITTED (commit effect on
     the DWA ready flip), and (b) the DWA warm for the current generation has
     completed — DWA is extended to invoke `onWarmResult` on EVERY warm
     completion (it already re-enqueues a warm per `gl` change) and the ack
     records the generation captured AT WARM COMPLETION, so a stale
     `ready=true` cannot pre-ack a generation whose warm hasn't finished, and a
     delayed old-generation effect populates only its own (cleared) generation.
   - **Failure ack source:** the boundary fallback is not bare `null` but a
     visually-null `<FailedBuildingAckProbe cohortId>` whose commit effect
     re-acks per generation (effect keyed on the observed generation) — a
     still-errored boundary re-acks after every bump without needing
     `componentDidCatch` to re-fire [R2-NF3].
   - **Unmount revocation:** ack tokens are revoked on probe unmount cleanup —
     an acked tree unmounting before the second qualifying frame drops the
     token and the counter resets [R2-NF3].
   - **Stamp:** two consecutive qualifying scene frames (same
     scene-`onAfterRender` chain as boot-core, `revealConditionHolds(false)`)
     while 11 current-generation tokens are live →
     `__W3D_PHASES.bootBuildingsPresentedAt` + `...PresentedGen`.

### D3 — SeaLoadingScreen: guarded dismissal + bands [R1-F6, R2-NF6, R2-NF8]

- Predicate: `ready = forceReady || (isBootCorePresented() &&
  isBootBuildingsPresented())` (both per current generation); buildings mode
  `'absent'` (D6) satisfies the buildings leg trivially.
- **Single guarded `beginDismiss(reason)` [R2-NF6]:** every dismissal path (45s
  fuse, 10s fallback, composite, forceReady) goes through one first-writer-wins
  entry that stamps `__W3D_PHASES.loadingDismissReason` +
  `loadingDismissedAt` + `loadingDismissGen` ONCE, terminally disposes both
  fuses AND stops the rAF poll — a later-satisfied composite can never launder
  a fuse dismissal during the 420ms fade.
- Bands: download 0–0.30, upload 0.30–0.70, compile 0.70–0.80, buildings
  0.80–0.97, ready 1.0. Buildings band opens only when `texturesReady &&
  canvasReady && isBootCorePresented()`; fill = **current-generation ack count
  / 11** [R2-NF8 — not sticky cohort terminals], so a post-swap band honestly
  rewinds is NOT allowed (ratchet keeps the displayed bar monotonic; the fill
  source just stops advancing until re-acks catch up). Mode `'absent'`: band
  auto-completes. Phase label `'building'` → "Building the town…".
- 45s fuse unchanged; 10s fallback unchanged in arming, warn copy names the
  missing leg(s).

### D4 — renderer-generation authority [R1-F4, R2-NF2]

- **Single choke point:** `observeBootRenderer(gl)` in `decorative-release.ts`,
  identity-latched (WeakRef/last-identity compare). Called from the ONE
  component that already lives on the render path every frame — the
  scene-`onAfterRender` notifier chain host (BootCorePresentedNotifier's
  seam) — passing the renderer actually executing the frame. This observes
  EVERY real replacement including the production `StageRendererHealth` bridge
  swap, because whatever renderer renders the stage scene IS the one observed;
  there is no second caller, so no double-bump [R2-NF2].
- A bump: clears BOTH presentation milestones + frame counters + ack tokens
  (D2); cohort terminals + settled stamp stay sticky (measurement). Stage-B
  deliveries are NOT revoked (compile safety is structural via D1).
- Milestone stamps carry their generation (`bootCorePresentedGen`,
  `bootBuildingsPresentedGen`, `loadingDismissGen`) so the probe snapshot can
  prove same-renderer provenance [R2-NF2].

### D5 — probe evidence validator [R1-F7, R2-NF7]

- Probe field-surfacing: none needed (whole-`__W3D_PHASES` snapshot). Historical
  `revealMs` semantics untouched; frozen gates untouched.
- **Additive, TESTED `bgrEvidence` computation in the probe report** [R2-NF7]:
  `{valid, reasons[]}` requiring: buildings mode `'glb'`,
  `loadingDismissReason==='composite'`, `bootBuildingsPresentedAt <=
  loadingDismissedAt`, and `bootCorePresentedGen === bootBuildingsPresentedGen
  === loadingDismissGen`. Fuse/fallback dismissals ⇒ `valid:false` with
  reasons. Ship singles must show `bgrEvidence.valid === true`; the rule is
  machine-enforced, not operator-dependent. (`validForPerformance` semantics
  are NOT redefined — `bgrEvidence` is a separate, additive verdict.)

### D6 — buildings mode: per-canvas, latest-wins [R1-F5, R2-NF5]

- `declareBootBuildingsMode(mode: 'glb' | 'absent')` called from the
  World3DCanvas buildings branch on every canvas mount (and on a runtime
  `buildingDetail` flip — re-declaration is LEGAL and latest-wins); canvas
  unmount resets the declaration to `'pending'`.
- The overlay predicate evaluates against the CURRENT declaration: `'glb'` →
  requires the presented milestone; `'absent'` → buildings leg trivially
  satisfied; `'pending'` → leg unsatisfied (fuses cap). An `'absent'`-era
  trivial satisfaction never carries into a later `'glb'` declaration — the leg
  is re-evaluated live, not latched [R2-NF5].
- Stage-A byte-warm fires only under a live `'glb'` declaration (moved behind
  it; no pointless 11-GLB download in absent modes).
- `bootBuildingsSettledAt` carries the mode at stamp time; `bgrEvidence`
  requires `'glb'` (D5) — no false evidence across mode transitions [R2-NF5].
- The cold-boot overlay exists only on first page load; SPA canvases re-declare
  and the predicate follows — no stale inheritance [R2-NF5].

### D7 — DELETE the proxy system + occluder gating [R1-F8 — RESOLVED design]

Remove: `BuildingProxy`, `BuildingProxyLabel`, proxy geometries/materials/
colors, `withLabel`, `building-proxy-label-*`. `!released` → `null`; boundary
fallback → `<FailedBuildingAckProbe>` (visually null, D2); Suspense fallback →
`null`; DWA without placeholder. `fullDetail=false` → `null` + comment.
`GLBBuilding`: `isOccluder` userData applied/removed in a commit effect keyed on
`attachmentVisible` (tag only while visible) so a hidden warming tree never
occludes labels; regression test against the world-labels occlusion scan.

### D8 — boot-inventory isolation + warm-draw hiding [R1-F2, R2-NF4]

- Root split: procedural treedome stays under boot-core `perf:buildings`; the 11
  streamed buildings mount under `perf:buildings-streamed`, a root that boot
  inventory, the texture-ready scan, drift detection, and the boot compile
  sweep all treat as KNOWN DEFERRED (excluded, never drift).
- **Warm-draw hiding [R2-NF4]:** every boot warm draw (`gl.render` inside the
  sync culling scope, including the healing render) saves `visible`, sets the
  streamed root `visible=false`, renders, restores — so delivered buildings on
  an SPA/watchdog warmup are neither uploaded nor compiled nor drawn by the
  boot-core warm; their own DWA rewarms (FIFO-chained, D1) own that work.

### D9 — docs + process (same-diff)

`3dStructure.md` (+ Last Audited), ledger entry with measured before/after,
`deploy-status.md`, `FOUNDER-REVIEW.md` entry (what to look at + feedback
wanted), rev-5 banner, memory topic update.

## 3. What must NOT change

Boot-compile FIFO semantics (extended to deferred warms, never bypassed) ·
post-reveal lane · decorative release contract · cohort fail-closed discipline ·
treedome · frozen gates · historical revealMs · no `bun run dev`.

## 4. Failure-mode matrix (rows entailed by the mechanisms above) [R2-NF9]

| Scenario | Behavior (mechanism) |
|---|---|
| Building 404s | boundary → `failed` terminal + FailedBuildingAckProbe acks per generation (D2) → milestone arms; empty spot; no hang |
| Warm fails open | terminal + visible commit + ack via warm-completion path |
| Slow net at __W3D_READY+10s visible | `beginDismiss('milestone-fallback')` first-writer-wins (D3); pop-in; `bgrEvidence.valid=false` |
| Hidden-tab boot | stage A parks; fuses visible-only; resume on foreground |
| Renderer swap pre-reveal (watchdog or StageRendererHealth) | `observeBootRenderer` bumps (D4) → milestones+acks cleared → DWA rewarms FIFO-chained (D1) → re-acks incl. failed members (D2) → re-stamp; overlay waits; generations recorded |
| Swap during warmup awaiting renderer init | any building compile chained first serializes BEFORE the later boot compile in the same FIFO — order safe, latency-only (D1) |
| SPA return post-reveal | overlay doesn't exist; delivered members remount instantly; warm draw hides streamed root during any later warmup (D8) |
| buildingDetail=false / staticWorldOnly / edit / meshlets | current declaration `'absent'` → leg trivial, band completes, byte-warm suppressed (D6) |
| absent→glb SPA transition | re-declaration; leg re-evaluated live; old trivial satisfaction can't leak (D6) |
| Composite satisfied during fuse fade | reason already stamped first-writer-wins; no laundering (D3) |
| forceReady | `beginDismiss('force-ready')` |

## 5. Test plan

Unit: stage-A (epoch+visible; hidden park; glb-mode-only byte-warm), stage-B
admission, FIFO-chained deferred compiles (a rewarm chained before a later boot
compile serializes it), ack protocol (dual-gate success ack; failed re-ack per
generation; unmount revocation; generation clear), presented milestone
(11 live tokens + 2 frames; reset/re-arm), guarded beginDismiss (first-writer-
wins on every path; fuse/poll terminal disposal), band ordering + ack-fraction
fill + absent auto-complete, occluder tag follows attachmentVisible, warm-draw
hiding save/restore, mode declaration lifecycle (latest-wins, pending on
unmount), `bgrEvidence` validator (all four conditions + failure reasons),
post-reveal lane unchanged. Existing suites green + tsc 0.

Live singles (quiet box, :3010 + :4001): guest + auth-VRM — no proxy geometry
ever, `bgrEvidence.valid===true`, honest measured revealMs, cohort 16/16, drift
0, zero console errors, cold /cove + /kelp scene-leak zero building bytes.
