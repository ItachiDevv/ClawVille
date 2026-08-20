# Cold-Load Diet — Plan (2026-07-31)

> Round mandate (founder, 2026-07-31): slim the cold first visit. Codex gpt-5.6-sol at
> ULTRA-HIGH reasoning (`xhigh`, verified accepted by CLI v0.144.3) is the adversarial teammate
> at every stage (plan critique → implementation → diff review).
>
> Status: **v3 — Codex delta re-review of v2 returned APPROVE-WITH-CHANGES
> (`perf-cold-load-diet-2026-07-31-adversarial-review.md`): rung 0 cleared immediately; rung 1
> cleared only after the re-review's findings 1–3 are incorporated (done in this v3) and M0
> freezes numeric per-backend budgets (finding 5). Rungs 2–5 stay result-gated; finding 6 adds a
> VRM sub-canary before ambient-VRM widening. v1's full 12-finding review is preserved at commit
> `619abc8c`.**
> Branch: `perf/cold-load-diet` off `origin/staging` (`57a425a7`).
> Runs independently of the pending kelp+reef staging→master promotion.

## v1 → v2 changelog (what the adversarial review changed)

1. Workstream A's boundary redesigned: from "which scan discovered the texture" to **scene
   membership + per-object detached warmup before commit** (review §4 seam adopted wholesale).
2. **Fail-open redesigned**: one-shot `decorativeReleased` controller with an absolute deadline;
   deferral can never become permanent omission (v1's copy-the-DeferredNpcPreloads-pattern risk).
3. **VRM deferral corrected**: it is a demand-boundary + preload-removal change, not a path list.
   Ansem is BOTH a player-capable model and a wanderer — shared-URL demand from the local player
   or a remote must win naturally. v1's "parse-at-mount prevents T-pose" claim was FALSE
   (animator init + attachment fetch are async post-commit); the detached warmup must await
   animator+attachment and evaluate the initial pose before visible mount.
4. **Arithmetic corrected**: deferring all 15 VRMs (12.19MB) + 12 location GLBs (6.71MB) +
   ansem-sword (0.35MB) + per-character anim files (~0.4MB) leaves **~15.0MB pre-reveal**, not
   v1's implied ~13.6. v1's "~21MB" figure and its emote-bundle credit were wrong (emotes are
   demand-loaded on first emote, never on the reveal path). Targets restaged accordingly (§2).
5. **Fade-in DELETED** — it contradicted this round's own no-material-change constraint (shared
   material caches; transparent-variant compiles). Deferred objects mount **atomically** after
   their detached warmup completes.
6. **Per-semantic texture policy** replaces blanket "UASTC→ETC1S for non-color": per asset, try
   dropping the normal map first, then 512 UASTC+zstd, ETC1S for normals only after a
   grazing/moving-light A/B passes. ETC1S remains fine for masks/AO/roughness.
7. **Ansem diagnosis corrected**: 193,946 vertices for 118k tris (near-split indexed topology +
   attribute entropy), no morph targets, tiny animation. Census + weld dry-run + rate-distortion
   ladder BEFORE any decimation; the existing `scripts/decimate-vrm.ts` validates a 38k–42k band
   (parameterize it; v1's flat "35k" was arbitrary).
8. **Service-worker workstream added** (v1 hand-waved "SW-covered"): precache does NOT cover the
   town props / player VRMs / location NPCs; URL-parity test + explicit upgrade policy required.
9. **Sequencing replaced** by the instrumentation-first canary ladder (§4).
10. **Phase instrumentation added as step 0** — the "13s shrinks proportionally" claim is a
    hypothesis; the in-code phase timers (`World3DCanvas.tsx:1844-1953`) exist but were not
    exported to the probe. Iris Xe runs the **WebGL2** path (not WebGPU), so the warm-draw cost
    model differs on the floor hardware; the probe must record the backend.

---

## 1. Measured baseline (2026-07-31, staging `57a425a7`)

Method: fresh-profile (cold, 0 service-worker hits) CDP probe against
`https://staging.clawville.world/game`, recording every network response (wire bytes), the reveal
moment (`__W3D_READY` + `.claw-loading-overlay` gone), and longtasks. Probe: scratchpad
`coldload/cold-load-probe.mjs`; reports `report-cold1.json` (headless) + `report-cold2-headed.json`
(headed). Box: dev desktop (fast GPU, ~40Mbps). Founder's Iris Xe floor is strictly worse on both
axes and uses the WebGL2 renderer path.

**Headline: 34.62MB cold wire, 505 requests, reveal at 20.5s (headed) / 21.6s (headless). 100% of
bytes land BEFORE reveal. Network completes ~7.5s; the remaining ~13s is decode/parse/
staggered-upload/compile — its phase composition is NOT yet measured (step 0 below).**

### By asset class (wire, all pre-reveal)

| Class | Requests | MB | Notes |
|---|---|---|---|
| GLB | 108 | 20.47 | 19 files >0.3MB = 17.6MB; 89 small = 2.85MB |
| VRM | 15 | 12.19 | all wanderer/player VRMs, tier-1 preload at +1.1s |
| JS | 63 | 1.58 | out of scope this round |
| WASM/FONT/CSS/HTML | 10 | 0.38 | fine |
| API/OTHER | 308 | ~0.01 | 288 zero-byte (blobs, 6x /login RSC prefetch) |

### Deferral arithmetic (exact, from report-cold1)

| Set | MB |
|---|---|
| Baseline pre-reveal | 34.62 |
| − 15 VRMs | 12.19 |
| − 12 location character GLBs | 6.71 |
| − ansem-sword.glb | 0.35 |
| − per-character anim files (hermes/tekk/chibi/ansem idle-walk-run) | 0.40 |
| **= post-A reveal-gated floor (before diets)** | **~14.97** |

### Top offenders + anatomy (local file inspection)

| MB (wire) | Asset | Anatomy |
|---|---|---|
| 3.58 | `quest-bounty-pavilion-ktx.glb?v=4` | 3.36MB across **66 KTX2** (16 UASTC-zstd 512s, 46 ETC1S 512s, misc); 0.57MB geom; 79k tris, 26 meshes. STAYS reveal-gated → diet target |
| 2.61 | `ansem.vrm?v=1` | 2.72MB geometry: **193,946 verts / 118k tris** (near-split topology + attribute entropy), 1 mesh, 24-joint skin, no morphs, tiny anim. Already meshopt |
| 2.61 | `adinero.vrm?v=1` | same shape: 119k tris, 2.74MB geometry |
| 1.92 | `characters/spongebob-ktx.glb` | 1.75MB tex (2 UASTC 1024 = 0.87+0.51) |
| 1.40 | `lobster_plush-ktx.glb?v=2` | 1.38MB tex on **1k tris**; one UASTC 1024 = 1.18MB |
| 1.21 | `tekk.vrm?v=2` | 0.53MB webp tex (0.32 normal) + 0.70MB geom |
| 1.19 | `characters/pearl-ktx.glb` | 1.10MB tex (0.80 UASTC 1024) |
| 1.06×2 | chibi VRMs | 1.43MB geometry each, **NO meshopt**, 40k tris |
| 0.97 | `characters/flying-dutchman-ktx.glb` | 0.86MB tex (0.62 UASTC 1024) |
| 0.91 | `shisha-oasis-ktx.glb?v=2` | 1.40MB local geom, **NO meshopt** (brotli → 0.91 wire). STAYS reveal-gated → diet target |

### Systemic root causes

1. **UASTC non-color maps** (P1b quality choice): 4-8x ETC1S wire cost, dominant texture bytes in
   pavilion/spongebob/pearl/dutchman/lobster_plush. The documented P1 "tune qlevel if load
   regresses" debt has measurably regressed load.
2. **The reveal gates on the entire world inventory**: `__W3D_READY = __W3D_CANVAS_READY &&
   __W3D_TEXTURES_READY`; the texture scan covers the whole boot scene. "Tier 3 deferred"
   components only shift preload timing — mounted meshes' `useGLTF()` calls are the real demand,
   and they mount from boot (the 4,600-unit resident threshold covers the whole 4,160-unit
   building ring from spawn).

## 2. Targets (v2 — staged, fixture-defined)

Fixture for all ratchet numbers: dev-desktop probe, fresh profile, guest session, no remote
players, default avatar. Worst-case variants (Ansem as local avatar; populated room) are REPORTED
alongside but not part of the ratchet. Founder Iris Xe (WebGL2 path) is the floor and is verified
separately before any promotion talk.

- **M0 (instrumented baseline):** phase timestamps + renderer backend + CF cache state exported;
  today's 34.62MB / 20.5s re-confirmed under the fixture. M0 also delivers TWO frozen artifacts
  (re-review findings 4+5, both prerequisites for rung 1):
  (a) the **URL-level ledger** — per-URL `before / after / lane / saving` rows for M1, M2-reveal,
  and queue-drained-total, with the animation rows derived from the §A role split; **A deferral
  is never credited toward total-session savings**;
  (b) **numeric per-backend acceptance budgets** — worst-frame ms, longtask ms, the exact
  stable-frame calculation, and queue-drain deadline, frozen separately for the desktop backend
  AND the WebGL2 path (Iris proxy) before any behavior change.
- **M1 (post-A):** reveal-gated wire **≤15.6MB** (revised from 15.5 at the delta re-review:
  the honest post-exclusive ledger — guest fixture keeps its own body VRM reveal-gated — computes
  **15.541MB**, and the threshold must sit above the arithmetic it gates); per-phase reveal-time
  improvement measured; both backends inside their M0 budgets.
- **M2 (post-A+B/C): PROVISIONAL ≤11MB reveal-gated / ≤22MB total-session** — the currently-named
  diets do NOT close these numbers (~11.2MB reveal; only ~6.5-7MB of the 12.6MB total-session
  savings needed). **Freeze point (per the delta re-review): M2 is frozen from MEASURED diet
  rows — actual sibling-artifact sizes fed to the ledger's diets input — at the END of rung 2,
  before rung 3 widening starts. If the measured rows don't close ≤11/≤22, the targets move to
  what the rows sum to.** No un-named savings may be assumed at any point.
- **Reveal time target: provisional until M0 phase data exists.** The 8s dev-probe number from v1
  is downgraded to a hypothesis; M0 decides what the compile/warm floor actually is per backend.
- **Zero conditional omission** (every NPC still appears; timing-only), zero visual regression at
  gameplay distance (per-asset screenshot A/B; promo assets get closeups + grazing-light checks),
  second-visit warm path not regressed (SW parity, §3-SW).

## 3. Workstreams

### Step 0 — Instrumentation (before ANY behavior change)

- Export the existing phase timers (LoadingManager barrier, VRM parse drain, stable scans,
  texture slices, scene compile, warm draw — `World3DCanvas.tsx:1844-1953`) + renderer backend
  (WebGPU vs WebGL2) onto a window global the probe collects.
- Probe additions: request initiators, `resourceChangedPriority`, response protocol,
  `CF-Cache-Status`/`Age`, loader first-paint, canvas first present, overlay-gone, first 10 stable
  frames, worst frame in the 10s post-reveal, first/all ambient NPCs visible, post-queue drained.
- Re-run baseline under the fixture → M0 report. This settles the "13s proportionality"
  hypothesis and sets the reveal-time target.

### A. Reveal-gate scope cut — the §4 replacement seam from the adversarial review (adopted)

Deferred set: explicitly tagged static ambient wanderer NPCs, the 12 location character GLBs,
ansem-sword, spawn-distant decorations if cheaply separable. NEVER deferred: local player's
avatar (any model incl. ansem), possessed NPC, autonomous avatar bodies, real remote players,
buildings, town props, terrain.

**Animation-clip role split (re-review finding 2 — resolves the v2 contradiction):** the shared
base locomotion set (`/avatars/animations/idle|walk|run.glb`) is invariant critical and stays
reveal-priority. Character-specific clip files (`hermes-*/`, `tekk-male/`, `chibi/`, `ansem/`)
are deferred to the post lane **iff their only live consumers are deferred ambient NPCs**; the
moment a critical consumer (local player, remote, possessed, autonomous) needs the same clip URL,
its demand wins and the fetch goes reveal-priority. The rung-0 accounting script derives the
credited ~0.40MB from this rule (URL × consumer-role join), not from a hand list.

Design (per review §4, steps 1-8 — implementer treats these as the spec):
1. One-shot `decorativeReleased` controller owned by the persistent world scene; released on
   normal warmup-gate resume, 40s safety resume, stage-ready path, or an independent absolute
   deadline ≤ the 45s loader ceiling. Never resets on stage transitions. `markWorldReadyIfUploadsDone`,
   the 60s canvas-ready reassert loop, and the 40s fuse are UNTOUCHED.
2. Texture scheduler refactored to lanes (`reveal` | `post`): one serialized queue, one active
   resolver, per-lane `seen`/total/done. Only the reveal lane publishes
   `__W3D_TEXTURE_UPLOAD_TOTAL/DONE`. Post metrics get new names; no relationship to `__W3D_READY`.
3. Event-driven `warmDeferredObject3D(object, renderer, camera, liveScene)` — exact sequence
   (re-review finding 1; deviations are defects): (a) for VRMs, construct the SOLE owning
   `VRMCharacterAnimator`, await clips + configured attachment, evaluate the mixer once at t=0
   (first visible frame is posed — no T-pose), and RETAIN that animator as the component's
   animator (never construct a second post-commit); (b) traverse the COMPLETE detached object,
   queueing every texture through the post lane; (c) save each mesh's `frustumCulled`, disable,
   then await `renderer.compileAsync(object, camera, liveScene)`, restoring all flags in a
   `finally` (off-frustum materials must not stay cold); (d) cache the promise/status by
   object+renderer; (e) Suspense wrapper; (f) bounded no-progress + absolute ceilings whose
   timeout resolves fail-open to VISIBLE (never suspended forever).
4. Remove the blanket wanderer `preloadVRMBytes()` calls from `asset-preload-manifest.ts` AND the
   module-scope preloads in `arena-npcs.tsx`. Shared player/wanderer URLs fetch early only on
   real critical demand.
5. `arena-npcs.tsx`: keep the full live roster subscribed; split RENDERING into critical vs
   tagged-ambient IDs; ambient renders after `decorativeReleased` through the warm resource;
   derive the deferred list from the CURRENT store at release (never a snapshot).
6. `arena-location-npcs.tsx`: apply `decorativeReleased` in the parent BEFORE any child that
   calls `useGLTF`; `DeferredNpcPreloads` consumes the same release signal (or is removed).
   Same for any deferred terrain decoration.
7. Atomic mount after warmup — NO fade (out of scope under this round's constraints).
8. Tests/instrumentation asserting: reveal counters freeze at release; post counters can't touch
   loader progress/readiness; every deferred ID eventually mounts (normal/error/timeout);
   current SSE positions used; shared-URL priority preserved; stage return neither re-gates nor
   omits; no deferred URL starts before `decorativeReleasedAt` unless a critical consumer shares
   that exact URL (probe-asserted, not comment-asserted).

### B. Geometry diets (census-first)

- **ansem/adinero**: (1) accessor/meshopt byte census, exact-tuple weld dry-run, UV/hard-normal
  seam audit, quantization check, vertex-cache/overdraw analysis; (2) sibling prototypes on a
  rate-distortion ladder (90k/60k/45k/38k tris) → pick the visual knee (idle/walk/run,
  shoulder/hand/face deformation, sword attachment, silhouette, promo closeups); (3) parameterize
  `scripts/decimate-vrm.ts`'s 38k–42k validation band. Acceptance per prototype: grounding/bounds
  unchanged, all `VRMC_*` extensions preserved byte-for-byte in the JSON chunk, and a real
  runtime-load check in the world (not just a parse). Ansem is the influencer showpiece: if no
  knee is acceptable, welding + attribute-precision wins alone still land ~30-40%.
- **chibi VRMs**: meshopt via the repo's VRM-safe capture/reinject pipeline
  (`scripts/assets-optimize.ts` — stock glTF transforms strip `VRMC_vrm` data; never raw gltfpack
  on a VRM). ~1.06 → ~0.45MB each.
- **shisha-oasis**: meshopt pass (plain GLB, no VRM constraint). ~0.91 → ~0.5MB wire.
- **Sweep**: GLBs >200KB wire without `EXT_meshopt_compression` get the appropriate-pipeline
  meshopt pass.

### C. Texture diets (per-semantic, per-asset ladder)

For each heavy non-color map (lobster_plush 1.18MB, spongebob 0.87+0.51, pearl 0.80,
dutchman 0.62, pavilion's 16 UASTC 512s, tekk 0.32 webp normal):
1. Try **dropping the normal map** at gameplay distance (stylized cartoon assets; test under
   grazing/moving light, not one static screenshot). Removal wins wire + upload + sampler count.
2. Else **downsize: 512 (256 for the plush) UASTC+zstd** — preserves normal fidelity, cuts texels 4×.
3. **ETC1S for a normal map only after** an asset-specific orbit/grazing-light A/B passes.
4. ETC1S freely for masks/AO/roughness where not already.
- Pavilion atlasing: ONLY after grouping images by material/colorspace/wrap/UV compatibility shows
  an actual win; 66 files alone doesn't prove an atlas helps.
- Color maps untouched unless visibly oversized for their on-screen footprint.

### SW — service-worker parity (new workstream; binds A and B/C)

**Role-aware cache sets (re-review finding 3 — a flat "cover everything" precache would have the
SW fetch deferred bytes at install time and undo workstream A):**
- **Invariant boot-core precache** (small): buildings, town props, shared locomotion, terrain
  cores — including every mutated `?v=N`/sibling URL of these.
- **Demand-cached** (runtime cache-first, NEVER install-precached): player-capable VRMs and other
  demand-dependent assets — membership depends on the session's avatar/room.
- **Post-release ambient set** (location NPCs, ambient wanderer VRMs, deferred clips):
  **explicitly FORBIDDEN from install precache**; runtime-cached only after `decorativeReleasedAt`.
- URL-parity automation validates each URL's assigned ROLE (boot-core vs demand vs post-release),
  not mere presence in one master list; manifest/runtime/attachment/SW references move together.
- The rung-1 clean-install assertion REJECTS any SW-initiated deferred request before release.
- Explicit upgrade policy, tested: bump the cache namespace and measure the one-time refill, OR
  prune superseded URLs without deleting warm assets. Verify: clean install → first reveal → post
  queue drain → second navigation; and old-build cache → new SW activation → navigation.

### D. Fanout + misc (evidence-gated, last)

- Only act on the 89-small-GLB fanout / 6x `/login` RSC prefetch if step-0's
  initiator/priority/protocol data shows they delay critical requests. No refactor on request
  count alone. For `/login`: find the emitting Next.js prefetch at its source, run a
  disable-A/B, and KEEP the change only if critical request start times or reveal improve —
  else revert.

## 4. Sequencing (canary ladder — replaces v1's A-then-B/C)

0. Step-0 instrumentation + exact URL-ledger accounting script + fixture definition + frozen
   per-backend numeric budgets → M0. **Cleared unconditionally by the re-review.**
1. **A canary on ONE location GLB** proving: counter-lane isolation, detached upload+compile
   (full §A.3 sequence incl. frustum-culling save/restore), all watchdog ceilings, stage
   world→activity→world return, and the clean-install SW assertion (no SW-initiated deferred
   fetch before release). **Pass requires BOTH backends inside their M0 budgets — the WebGL2
   path (Iris proxy, forced locally) runs at the canary, not at promotion time; the
   founder-hardware run remains the final floor check.**
2. **B/C on the largest future-post-reveal assets FIRST** (ansem/adinero/spongebob/plush…) so
   their post-reveal streaming cost is bounded before A widens.
3a. Widen A to the location-NPC class, re-probing reveal + the post-reveal budgets per backend.
3b. **Ambient-VRM SUB-CANARY** (re-review finding 6) before the VRM class widens: ONE ambient
   wanderer VRM through the full warm seam with throttled animation/attachment responses,
   frame-by-frame first-visible capture (no T-pose/rest-pose frame), and a shared
   critical-demand variant (Ansem as local avatar while ansem-wanderer is deferred; single
   network fetch for the shared URL).
3c. Widen A to the ambient wanderer VRM class, then decorations — re-probing per class, both
   backends inside budgets each time.
4. B/C on still-gated core (pavilion, shisha, buildings per the M0 ledger) → M2.
5. D only with step-0 evidence.

Every mutated asset ships under a NEW `?v=N` or sibling filename (CF 7-day edge cache, no purge);
sibling names preferred (auto-bust).

### Rung-1 canary status (2026-07-31)

- **Part 1 (`42437ec7`):** `decorative-release.ts` one-shot controller, released from all four
  World3DCanvas ready paths + 45s absolute deadline armed at warmup start.
- **Part 2 (this commit pair):** `flying-dutchman-ktx.glb` (0.97MB) gated behind the release in
  `arena-location-npcs.tsx` — `deferUntilDecorativeRelease` on the `api-integrations` slot stops
  the parent before the `NpcMesh` `useGLTF` demand, and `DeferredNpcPreloads` defers the same
  model's preload to the release (models shared with non-deferred slots stay immediate). Verified
  locally on a strict-evidence run (`validForPerformance:true`, backend `webgpu` actual): release
  19228ms (`stage-ready`) → dutchman fetch +1.5ms after, zero pre-release bytes, reveal 19.7s,
  NPC mounts post-release (DOM label present — MANUAL observation at the time, not
  machine-recorded; automated mount evidence added in the 2026-08-04 audit fold). Assertion tool:
  `apps/web/scripts/cold-load-canary-assert.mjs <report.json> flying-dutchman` (exit 0/3/2).
  **Precision (2026-08-04 audit finding 2): the deferral is past the READINESS RELEASE, not past
  paint-reveal** — across all 36 candidate runs the fetch starts after the release but 0.4–3.1s
  (WebGPU/retest) to 4–17.7s (first bimodal WebGL2 batch) BEFORE reveal, so `preRevealMB` is
  unchanged by this canary. What rung 1 proves is the RELEASE-SEAM MECHANISM (deferral out of
  the warmup/readiness critical path, no stranding, no perf cost) — not a pre-reveal byte
  reduction. Rung-3a widening that intends post-REVEAL streaming must first re-anchor the
  release (or add a second seam) to actual first paint.
- **Instrumentation gap found+fixed while validating (tooling commit):** the ACTUAL-backend stamp
  lived only in World3DCanvas's legacy `createWebGPURenderer` — a path stage-hosted routes never
  run (the /game world renders through `WorldStageCanvas initializeStageRenderer` under
  `WorldStageRoot`). Every probe run on the committed code stamped only the module-eval
  `'-requested'` value → "backend not actual" invalids. Fix: stamp the actual backend at the
  single stage-renderer choke point (initial + both recovery paths), and make the module-eval
  `'-requested'` stamp non-clobbering (the stage can init before that chunk evaluates). The
  committed g-batch artifacts carry actual backends, so the working tree that produced them had
  this stamping live; it was lost before commit — treat probe evidence as tied to the exact
  BUILT bundle, not the branch (deferred punch-list item "build-ID attestation" covers this).
- **Codex xhigh canary diff review: VERDICT APPROVE** (no blocking/major behavior defects; the
  one MINOR — shared preload cancellation handles — and the assert-tool advisory — failed fetch
  counting as loaded — were folded in `ef63cc4d`; report archived in the adversarial-review doc).

### Rung-1 paired A/B verdict (2026-08-01 batch; baseline `7ddf319e` :3011 vs candidate `1dda54eb` :3010)

24 usable strict pairs (12/backend, 6 AB / 6 BA each, 0 drops after the hardened daemon recipe;
build identity attested by grepping served chunks for the canary flag — present only in the
candidate). Gate outputs + manifests committed under `docs/perf-data/cold-load-rung1-2026-08-01/`
(raw per-run reports remain on the dev box scratchpad referenced by the manifests).

- **WebGPU: PASS at n=12 (exit 0, all five metrics).** Candidate faster at the median on every
  ratio metric: reveal −2.1% (ub 0.016 < 0.140), worst-frame −2.6% (ub 0.130), stable-window
  −10.9% (ub 0.072), pre-reveal longtasks −2.2% (ub 0.050); frame-count diff bound 2 ≤ +2.
  Candidate faster reveal in 9/12 pairs; spread [−0.126, +0.073].
- **WebGL2: formal FAIL by the frozen still-open-at-12 rule — NOT evidence of regression.**
  Medians: worst-frame −0.4% (candidate faster), pre-reveal longtasks −34.5% (candidate much
  faster), reveal +3.6%, stable-window +9.9%; frame-count PASS. The bounds (0.32–3.28 in log
  space vs the 0.140 limit) are dominated by the lane's bimodal identical-code variance —
  within-pair reveal log-ratios span [−0.343, +0.457] with 6 negative / 6 positive, and the
  BASELINE arm alone drew both ~21s and ~35s reveals in the same session (the M0 vrmBulk
  9.6–35.4s variance). A 0.97MB reveal-set removal has no mechanism to slow this lane; the
  instrument simply cannot resolve a 15% effect inside ±40% noise on this box. **Disposition is
  a founder call above the frozen rules:** accept the WebGPU pass + WebGL2 noise analysis as
  rung-1 evidence, or demand gate closure on a quieter box / bigger n for the WebGL2 lane
  before widening (rung 3a). We did NOT re-run lanes until green.

### Rung-1 WebGL2 RETEST (2026-08-01 late, founder-authorized, NEW-RAM environment)

Founder call on the noise-fail above: **"retest — I added more ram today"** (a RAM upgrade on the
dev box, i.e. a legitimate environmental change, NOT a reroll of the same conditions). Fresh rig
rebuilt and re-attested (baseline `7ddf319e` :3011, candidate HEAD :3010, canary-marker chunk grep
discriminates the ports), then:

- **4-run baseline noise probe first:** reveals 18.6 / 20.9 / 22.7 / 25.2 s — the old ~31–35s slow
  mode NEVER appeared. The bimodality was RAM pressure from concurrent sessions, as the founder
  suspected. (`noise-probe-rt.log`)
- **Fresh 12-pair counterbalanced batch (6 AB / 6 BA, 0 drops, strict validity):**
  `manifest-webgl2-rt.json` + `gate-webgl2-rt-n12.json` + `pairs-webgl2-rt.txt` in this dir.
- **Result: 4 of 5 metrics now formally PASS** — reveal median −2.3% (ub 0.019 « 0.140!), worst-frame
  +3.2% (ub 0.103), pre-reveal longtasks −2.3% (ub 0.025), frame-count diff bound 1 ≤ +2. The
  noise-fail thesis is CONFIRMED: same code, same gate, quieter box ⇒ bounds close decisively.
- **Remaining open: `stableWindowStartMsAfterReveal` (formal FAIL, ub 0.269).** Median is candidate-
  FASTER (−2.5%); 9/12 pairs within ±0.20; the bound is held open by 3 positive pairs, one a freak:
  p10's baseline revealed at 26.2s (slowest run of the batch) so late that its post-reveal window
  read "instantly stable" at 503ms vs the normal 6–10s band → +2.56 log-ratio against a normal
  6.5s candidate (`report-rt-p10-baseline-freak.json`). Two causal notes: (a) this metric is a
  threshold-crossing detector and inherently jumpier than the ratio metrics; (b) the post-RELEASE
  window is where the canary DELIBERATELY moves the 0.97MB fetch+decode (the release lands 0.4–3s
  before paint-reveal on this rig — audit finding 2), so a small settle cost near reveal is the
  intended trade of the diet — and even so the median favors the
  canary (as it did on WebGPU, −10.9%). Canary behavior re-verified on the outlier candidates
  (dutchman fetch +0–20ms after release, canary-assert exit 0 on p5/p10/p11).
- **Batch-ops note:** the first launch double-ran (a TaskStop'd background instance survived and
  fought the detached relaunch — each probe's daemon-kill murdered the other's browsers). Both
  trees killed, state cleaned, verified single-instance before the counted batch.

We again did NOT re-run until green. Founder disposition on the single remaining stable-window
bound (accept the median-faster + freak-pair analysis, or extend that one metric) gates rung 3a.

### Rung-1 WebGL2 CONFIRMATORY BATCH — PREDECLARATION (2026-08-04, committed BEFORE any data read)

The 2026-08-04 Codex adversarial audit (VERDICT: REJECT — full report folded below) found the
in-flight "extend the open metric to n=18" plan to be OPTIONAL STOPPING (evaluating at n=18 after
seeing the n=12 result inflates the false-pass rate to ~5.4%, and updating only the failed metric
is selective endpoint updating). Its prescribed valid rescue: **a fresh fixed-size confirmatory
batch with no interim decision.** This section IS that predeclaration, committed before any
metric value from the new pairs has been read:

- **Sample:** pairs 13–24 from the retest rig (12 fresh counterbalanced pairs, 6 AB / 6 BA,
  same hardened recipe, same attested servers :3011=`7ddf319e` / :3010=HEAD-bundle). Pairs 13–15
  were collected before this predeclaration but NO metric value from them has been read (only
  scheduler "PAIR OK" events); no selection or filtering has been applied to them.
- **Evaluation: EXACTLY ONCE at n=12, all five metrics together** (no per-metric carve-out),
  via the unmodified `cold-load-paired-gate.mjs` with the currently-frozen bounds (incl. the
  prospective 40s webgl2 reveal sanity bound — legitimate for NEW batches per audit finding 4).
- **Disposition is binding:** gate exit 0 ⇒ WebGL2 lane PASSES rung 1. Any other exit ⇒ the
  WebGL2 lane verdict for rung 1 is FAIL, recorded as such with no further batches this rung.
- The earlier n=12 retest batch retains its own recorded verdict (fail on stable-window); this
  confirmatory batch does not amend it — it is a new, independently-evaluated sample.
- **Collection amendment (2026-08-04 18:58, OUTCOME-BLIND, committed before collection):** slot
  p20 dropped (baseline boot-hang flake ×3), so the scheduler delivered pairs 13–19, 21–25 =
  7 AB / 5 BA — a composition the frozen gate rejects (|#AB−#BA| ≤ 1). One additional BA pair
  (p26) is collected to restore balance; the single binding evaluation runs over ALL usable
  pairs (n=13, 7 AB / 6 BA). This amendment is derived ONLY from scheduler PAIR OK/DROPPED
  events (which carry no metric values); no outcome data has been read.

**CONFIRMATORY RESULT (2026-08-04 19:4x, the single binding evaluation — RECORDED AS-IS):
gate exit 3 ⇒ per the predeclaration, the WebGL2 lane rung-1 verdict is FAIL.** No metric was
ever evaluated: the gate dropped 3 of 13 pairs (p14-cand, p18-base, p22-cand) as
`validForPerformance:false` — every one for the same reason, "network never quiesced within
capture" (a late `_emotes2.glb?v=1` emote-warming fetch at t≈93s + late blob churn kept the
capture window from going quiet) — leaving 7 AB / 3 BA, which fails the counterbalance rule.
Root cause is a RIG DEFECT: the collection scripts gate an arm on probe EXIT CODE (`valid`),
while the gate filters on the stricter `validForPerformance`; the mismatch first bit tonight
because the emote-warm fetch straddled the capture window in 3/26 runs. Punch-list (rig, before
any future batch): collection must parse the report and require `validForPerformance:true`,
not exit 0. **We did NOT patch-and-re-run; the binding disposition stands.** Full rung-1
metric picture for the founder: across every batch and both backends, NO metric bound ever
closed AGAINST the canary — the WebGL2 lane fails on protocol/composition grounds only
(first batch: environmental bimodality; retest: one jumpy detector metric, median
candidate-faster; confirmatory: evidence-validity composition).

**Mount evidence (audit finding 3, automated, same evaluation session):** on the live candidate
build (`:3010`, `?webgl=1`), scene-graph inventory via `__WORLD_STAGE_PROBE__.sceneInventory()`
showed 2 `defaultMaterial` meshes pre-release (samples at 6.5s/9.1s/14.56s), release fired at
14554ms (`warmup-complete`), the dutchman fetch started +25ms later (the ONLY new model fetch),
and a third `defaultMaterial` mesh appeared in the world scene — the before/after mount delta,
machine-read. (The DOM label check is distance-gated at spawn and stays false — the label div
is not a reliable mount signal; scene-inventory delta is.)

### 2026-08-04 Codex adversarial audit fold (gpt-5.6-sol xhigh, VERDICT: REJECT — full report `docs/perf-cold-load-diet-2026-08-04-rung1-audit.md`)

Dispositions, finding by finding:

1. **BLOCKING (n=18 extension = optional stopping): ACCEPTED.** The extension-as-planned was
   abandoned unevaluated; the predeclared confirmatory batch above is the audit-prescribed valid
   rescue. Its single evaluation is binding either way.
2. **MAJOR (post-release ≠ post-reveal): ACCEPTED — claims corrected in place** (canary-status +
   retest sections). Rung 1 proves the release-seam mechanism, not a pre-reveal byte reduction.
   Rung-3a design note recorded: re-anchor (or add a second seam at) actual first paint before
   any widening that intends post-reveal streaming.
3. **MAJOR (assert proves fetch, not mount): ACCEPTED.** Automated mount evidence added same-day:
   a DOM-level check against the live candidate build (label text present after release; see the
   confirmatory-batch results block). Punch-list: a machine-recorded mount stamp consumed by
   `cold-load-canary-assert.mjs` lands with the rung-2 tooling window (tooling is otherwise
   frozen per the founder course-correction).
4. **MAJOR (30→40s recalibration outcome-dependent): ACCEPTED with clarification.** The first
   WebGL2 batch's recorded verdict is FAIL under BOTH the original 30s bound and the paired
   bounds — the recalibration never flipped any recorded verdict. 40s stands prospectively
   (finding's own disposition) and binds the retest + confirmatory batches, whose candidate
   reveals are all < 26.4s regardless.
5. **MAJOR (no durable build/evidence attestation): PARTIALLY FOLDED NOW** — a SHA-256 + summary
   ledger of every referenced raw report plus a build-identity block (commits, BUILD_IDs, served
   canary-marker grep) is committed with the confirmatory results; full manifest-embedded
   attestation remains on the frozen-tooling punch list.
6. **MINOR (evaluator counterbalance/reuse enforcement): punch list** (tooling frozen). The
   audit itself verified chronological AB/BA execution + 72 unique SHA-256 contents externally.
7. **MINOR (45s deadline armed at warmup start, not page boot): punch list** — mitigated today
   by the stage's 40s init fuse; no mid-rung code change.
8. **ADVISORY (commit-range wording): corrected** — the rung-1 core is the 9 commits
   `42437ec7~1..5d176d01` (inclusive of `42437ec7`, the release controller); the branch
   additionally carries 3 earlier probe/statistics commits from the measurement phase.

## 5. Verification protocol

- Probe re-runs per rung (headless + headed) on local prod build (`bun run build && bun run start`,
  free port); staging probe after push. Ratchets: `preRevealMB`, `revealMs`, phase timings,
  post-reveal 10s worst-frame SLO, ambient-NPCs-visible times, post-queue-drained time.
- Screenshot A/B per touched asset (gameplay distance; promo closeups; grazing light for any
  normal-map change).
- A-specific: the §A.8 assertion suite + the review's enumerated scenario matrix (normal
  completion, forced warmup error, no-progress fuse, 40/45/60s ceilings, background tab /
  no-requestIdleCallback, SPA return, world→activity→world, live roster swap during deferral,
  Ansem-as-local-avatar while ansem-wanderer deferred, NPC possession, autonomous bodies, remote
  joins, parse rejection/retry, single-fetch for shared URLs).
- Founder-hardware floor verify before any promotion talk. E4 binds throughout.
- Same-diff docs: `3dStructure.md` (assets/loading), this doc (results per milestone),
  `deploy-status.md` on any staging push.

## 2b. M0 FROZEN BUDGETS (v2 — refrozen 2026-07-31 from VALIDITY-GATED probe-v2 reports)

Source reports (committed under `docs/perf-data/cold-load-m0-2026-07-31/`): the batch-v7
`report-g-*` files — 4 local runs (2/backend, fresh profile + fresh browser daemon per attempt;
page-clock reveal; interval-overlap frame windows; corrected byte split; fail-closed validity)
+ the STAGING wire baseline `report-g-staging-g1-a1.json` (reveal 20.6s / 34.62MB pre-reveal,
`backendWaived: true`, wire-valid only — the deployed bundle predates the backend stamp; only a
NULL backend is waivable, flag-explicit) and its ledger. Superseded batches (e-, f-, v3b) live
in git history at `bb00fbd5` / `9bb12da2`.

Measured baseline (localhost serving — network done ≤1.6s, so these isolate compute/pipeline):
- **WebGPU**: reveal 17.7 / 18.1 s · worst frame in the 10s post-reveal window 1.43 / 1.89 s ·
  stable window starts +2.4 / +3.6 s · frames>100ms in window 3 / 4 · pre-reveal longtasks 3.0 / 4.0 s
- **WebGL2 (`?webgl=1`, Iris-proxy on desktop GPU)**: reveal 21.7 / 23.9 s · worst frame
  8.25 / 9.84 s · stable window +9.1 / +10.0 s · frames>100ms 2 / 4 · pre-reveal longtasks 5.6 / 9.0 s
  (a prior v2 run measured 14.6 s — the ceiling below keeps that headroom)
- The corrected byte split reports pre/post = 36.4/0 MB — the v2 phantom post-reveal residual is
  gone; earlier host-clock and v2-probe numbers are superseded by these reports.
- Boot-hang note: the intermittent silent hang is a measurement-rig flake (dominated by browser-
  daemon accumulation, §5b.2; one residual fresh-daemon occurrence observed against staging) —
  batch policy: fresh daemon per attempt + retry, hang rate logged per batch.

**Acceptance model (amended after batch v7): PAIRED comparison is the PRIMARY gate; absolute
ceilings are outer sanity bounds only.** Batch v7 — identical code to the batch that froze the
first ceilings — breached them on 4/4 local runs purely from machine load (a 12h-loaded dev box
vs a quiet one: WebGL2 reveal 27.3-27.5s vs the 25s ceiling). Absolute ceilings from an n=2
quiet-machine sample cannot gate code changes on a shared box. Therefore:

- **Primary gate (paired A/B — MACHINE-ENFORCED by `apps/web/scripts/cold-load-paired-gate.mjs`):**
  every canary/widening batch runs COUNTERBALANCED interleaved baseline↔candidate sessions
  (AB BA AB BA…, fresh daemon+profile per run; |#AB−#BA| ≤ 1). Acceptance per backend requires
  **≥8 complete pairs** whose reports are all `validForPerformance: true` (which itself demands
  complete metric evidence — frames, stable window, longtasks, quiescence) and
  `backendWaived: false`; per ratio metric (reveal, worst-frame, stable-window-start, pre-reveal
  longtasks) the **exact one-sided 95% upper confidence bound on the median within-pair log-ratio
  (binomial order statistic) must be < log(1.15)**; frames>100 uses paired differences with the
  same bound against +2. A bound that does not close below 12 pairs returns INCONCLUSIVE
  (extend), never a silent pass; still open at 12 pairs ⇒ FAIL.
- **Outer sanity bounds** (union of ALL valid runs across batches f+g; a candidate exceeding
  these is rejected regardless of pairing):
| Metric | WebGPU | WebGL2 |
|---|---|---|
| reveal (local fixture, page clock) | ≤ 22s | ≤ 40s |
| worst frame in the 10s post-reveal window | ≤ 4s | ≤ 12s |
| stable-window start after reveal | ≤ 6s | ≤ 15s |
| frames >100ms in the 10s window | ≤ 6 | ≤ 5 |
| pre-reveal longtask total | ≤ 6.5s | ≤ 25s |
| post-queue drain (once the post lane exists) | ≤ 60s after reveal | same |

Union maxima observed (batches f+g, all `validForPerformance`): WebGPU reveal 20.5s / worst
3.23s / stable 4.95s / f100 5 / ltPre 5.31s; WebGL2 27.5s / 10.85s / 13.24s / 4 / 23.27s.

**WebGL2 reveal sanity bound recalibrated 30s → 40s (2026-08-01, rung-1 canary batch):** the
canary batch's BASELINE arm — identical pre-canary code — breached 30s in 4/8 pairs
(31.3–34.8s) in the same session that measured 21–26s on other draws; the lane is bimodal on
this box (the M0 vrmBulk 9.6–35.4s variance), so 30s sat INSIDE the identical-code
environmental ceiling — exactly the failure mode that demoted absolute ceilings to sanity
bounds in the first place. 40s stays above the observed baseline max while still catching true
pathology; regression detection remains the paired statistics' job. Evidence:
`manifest-webgl2.json` pairs 3/4/5/6 baseline reports (scratchpad canary batch).
"Stable window" = first contiguous 3s run of frames all ≤100ms from reveal
(`frameMetrics.stableWindowStartMsAfterReveal`, interval-overlap inclusion).

## 5b. Defects discovered during M0 setup (2026-07-31, local full-stack)

1. **API-failure boot = permanent black "WARMING SCENE".** A fresh visitor whose API calls fail
   (observed with a web build lacking a working API URL) hangs forever on the stage's black
   'awaiting' overlay: the SeaLoadingScreen force-dismisses at 45s but the stage warmup has no
   fail-open to any usable state, and the world scene never mounts. Class-match with the
   re-review's finding 2 (gate/lifecycle failure behind a dismissed loader). Not introduced by
   this round — needs a fix ticket independent of the diet.
2. **Intermittent cold-boot hang — ROOT-CAUSED to the measurement rig, NOT the product.**
   The silent stage-canvas-never-mounts hang (zero page errors, world chunk never evaluates)
   tracked agent-browser DAEMON accumulation on the dev box: hang probability climbed with
   successive browser launches from one daemon (batch v4: 6/6 hangs late in the day), and a
   daemon restart immediately produced a green run on the same build/URL. Staging probes on
   fresh daemons were always green. Mitigation baked into the batch runner (daemon restart per
   attempt). The rung-1 canary watchdog matrix still covers the symptom class, but no product
   fix is owed here.
3. **`vrmBulkMs` ≈ 30.9s observed on a local WebGPU boot** (first phase-instrumented run): the
   bulk VRM parse+compile is a dominant reveal-time component when all 15 VRMs arrive
   near-simultaneously (fast network = worst case). Direct quantitative support for deferring
   ambient VRMs in workstream A. Also: that boot completed via the stage-ready publication path,
   not the classic full-sequence path — phase stamps now cover all four publication sites
   (classic, stage-ready, resume fail-open incl. reason, defensive fallback).

## 6. Non-goals

- JS bundle work, route code-splitting.
- Material/shader/instancing changes (incl. fade-ins — deleted in v2), Iris-Xe-risk classes.
- Multiplayer/authoritative-server gap; kelp/reef promotion (separate track).
- Second-visit warm-path optimization beyond not regressing it.

---

## Rung-3 results ledger (2026-08-09, session perf4.4 — commits `997962dc` + `c824d928` on `perf/cold-load-diet`, LOCAL/unpushed)

**Shipped in the slice:** first-paint release anchor (Lever 1) · deferral widened to 10 location-NPC slots + 12 scatter decorations + 8 land-ring props, crayfish quest-giver deliberately shared-critical (Lever 2) · staggered distance-ordered consumption into a one-at-a-time warm queue (idle-slice texture uploads → compileAsync → fallback-only zero-scissor warm) with a 1.5s first-drain quiet period (Lever 3) · probe longtask boundary = app-authored release stamp (reason-aware). Four Codex xhigh rounds (SHIP-WITH-CHANGES · BLOCK ×2 · implementation); every finding applied incl. the land-ring deferral leak, the missed-release race, and the WebGPU direct-warm blue-flash guard.

**WebGPU lane (final clean batch: 12 pairs, n=11 usable, 0 invalid):**
- revealMs: **PASS** — median −11.8% (12.93s→11.62s), upper bound −6.0% (confidently faster).
- framesOver100In10s: **PASS** (paired diff bound 1 ≤ 2).
- Pre-reveal wire: 22.82 → **19.50MB** (−3.32MB).
- preRevealLongtaskMs, SYMMETRIC boundary (both arms at polled reveal): **PASS** — median −2.8%, bound +6.0%.
- preRevealLongtaskMs, per the FROZEN asymmetric released-boundary definition: OPEN (+49% median) — **unpassable by construction** for a first-paint-released candidate: its counted window includes the reveal-adjacent warmup longtask that the baseline's ~1.1s-earlier boundary excludes. AMENDMENT PROPOSED (founder decision): boundary = polled reveal for BOTH arms.
- worstFrame / stableWindow: OPEN — medians ≈ +4.7%/+4.6% but bounds 0.36/0.18 vs 0.14 (per-run maxima noise at n=11 on the shared box).

**WebGL2 lane (12 pairs, n=11 usable, 0 invalid): formal FAIL on ONE sanity breach** (pair-2 candidate framesOver100 = 6 vs bound 5). Distribution: the lane is bimodal on BOTH arms (reveals 14.7–26.6s); the giant compile frame lands in/out of the 10s window by mode, making the count/max metrics a mode lottery (precedent: this lane's reveal bound was already recalibrated 30→40s for the same reason, 2026-08-01). Pairwise reveal favors the candidate 8/12; both candidate modes are faster than the corresponding baseline modes (fast ≈15–17 vs 17–19s; slow ≈21–23 vs 24–27s). RECALIBRATION QUESTION for the founder alongside the boundary amendment.

**Plan targets NOT yet reached:** reveal 11.6s vs the ≤8s target; pre-reveal wire 19.5MB vs ≤10MB. The dominant remaining row is the 15 wandering/player VRMs (12.19MB, tier-1) → Lever-2 slice 2 (needs its own pop-in acceptance since wanderers are spawn-adjacent).

**Rig lessons burned in this rung (memory: feedback_windows_pid_kills_and_batch_health):** anti-occlusion flags are mandatory on probe Chromes (occluded windows park the boot on the first rAF await — task 6 holds the product-side decision); never taskkill by stored PID; kill by profile basename + smoke-test the kill; per-pair server health checks; every batch gets a health watcher AND a 10-min progress reporter.

---

## Rung-4 slice-A results (2026-08-09, session perf4.5 — instrumentation only, on `perf/cold-load-diet` with the §5b gameplay lane in-tree)

**Acceptance MET: 3/3 fully valid webgpu solo runs (fresh profile, anti-occlusion flags, committed runner `apps/web/scripts/cold-load-ab-runner.sh` solo mode), full decomposed waterfall captured.** Evidence: `docs/perf-data/cold-load-rung4-sliceA-2026-08-09/report-{1,2,3}-B.json`. Reveals 14.68 / 13.87 / 13.13s (this is a SOLO baseline on the current tree — attribution evidence, not a paired comparison).

**The 3.8s pre-warmup head, now attributed (medians of 3):**

| Phase | At (ms) | Span |
|---|---|---|
| stage-root effect (persistent-stage tree committed) | ~250 | 0.25s of Next boot/hydration |
| /game page chunk eval + first render + mounted effect | ~290 | ~40ms after stage root |
| renderer factory invoked (gl factory) | ~950 | **~660ms** React commit → Canvas mount |
| canvas size ready (`waitForCanvasSize` resolves) | ~1280 | **~330ms** waiting for layout size |
| `renderer.init` start→end | 1280→1430 | **~150–200ms** — adapter/device is CHEAP |
| world chunk (`World3DCanvas`) module eval | ~1530 | ~100ms after init |
| `warmupStartAt` | ~3940 | **~2.4s** component-mount/preload-registration span — the head's biggest single opaque block |

Then the known tail: barrier 55–362ms · vrmBulk **6.4–8.7s** (still the dominator) · scans ~75ms · second compile 33/1324/1298ms (high variance — run 1's raced ahead of textures) · warm render ~20ms · warmupDone ~12.6s.

**Slice-F decision input (per handoff §2 slice F):** `renderer.init` is 150–200ms, far under the ~1s threshold — do NOT touch adapter/device init. The head is JS/mount-bound: the ~660ms commit→factory span plus the ~2.4s post-chunk mount span are where a boot-shell split would bite; slice F stays on the menu but gates on re-measurement after slice D (the boot-core gate reshapes both spans).

**Runner bug fixed while committing it (in the script now as a comment):** capturing a function's stdout via `$(launch_chrome ...)` blocks until the backgrounded Chrome EXITS if Chrome inherits the substitution pipe — Chrome must be launched `>/dev/null 2>&1 &` inside the function. The first batch attempt hung a full run on this.

---

## Rung-4 FOUNDER DECISIONS (2026-08-10 — all four open items resolved)

1. **§2b longtask boundary → SYMMETRIC (amended).** `preRevealLongtaskMs` is classified up
   to the POLLED reveal on BOTH arms. The rung-3 release-stamp boundary was unpassable by
   construction for a first-paint-released candidate (its stamp sits after reveal, widening
   its counted window vs baseline; +49% median on identical-quality runs vs −2.8% symmetric).
   Implemented in `cold-load-probe.mjs longtaskBoundaryMs` (release stamp still captured as
   evidence, never the boundary); probe tests updated. The dual-reporting requirement from the
   rung-3 ledger is retired — symmetric is now THE metric.
2. **WebGL2 lane → RECALIBRATE.** Count/worst-frame bounds for the WebGL2 lane are to be
   derived from identical-code baseline distributions (precedent: the 30→40s reveal
   recalibration), gating on medians with full distributions published. No more grinding
   reruns against the mode lottery. ACTION for the next WebGL2 batch: recompute the frame
   count/max sanity bounds from that batch's identical-code baseline arm before evaluating
   the candidate.
3. **Background-tab boot → option (a): pause the overlay fuse while hidden.** The boot
   still parks on its first rAF await (browser-friendly, unchanged); the SeaLoadingScreen
   45s force-dismiss now counts only VISIBLE time (visibilitychange-driven arm/pause with a
   remaining-budget resume), so foregrounding a parked boot finds the overlay intact.
   Implemented in `sea-loading-screen.tsx`. Option (b) (boot while hidden) explicitly
   rejected — it re-enters the hidden-WebGPU-init flake class.
4. **Proxy-world first impression → JUDGE LIVE AT SLICE D.** No screenshot pre-pass; the
   founder playtests the real BOOT_CORE_PRESENTED first impression on staging as part of
   slice D's acceptance (E4). Slice D's gate therefore includes the founder playtest
   round-trip — plan its schedule accordingly.

## Rung-4 slice-B results (2026-08-11, session perf4.5 — SW precache stand-down, sw.js v10→v11, staging A/B)

Shipped to staging as merge `8c40b38b` (slice-B code commit `50a22ba9`); both containers
verified on the sha; staging serves `CACHE_VERSION = 'v11'` (bundle grep).

**Before/after — 3 cold runs each vs `https://staging.clawville.world/game`, fresh
home-path profiles, polled-reveal-v2 boundary, all 6 runs `validForPerformance` (wire
ledger honestly incomplete — SW-routed rows report 0 upstream bytes at the page target;
punch-listed SW-target CDP attachment is the structural fix):**

| arm | sw.js | reveals (ms) | median | swEvidence |
|---|---|---|---|---|
| before | v10 (install-time precache) | 12642 / 12471 / 11772 | **12471** | v10 activated, cacheProbeOk |
| after | v11 (deferred signal precache) | 12898 / 12518 / 12067 | **12518** | v11 activated, cacheProbeOk |

- **Reveal: flat (+47ms median, run noise is ±400ms).** Expected shape for a COLD first
  visit: v10's install precache fired at window.load, which on a cold run lands near/after
  the reveal, so it never contended with tier-1 on THIS measurement. Slice B's wins are
  structural, not cold-reveal: (1) no 7.8MB `no-store` re-download per CACHE_VERSION bump,
  (2) no install-time contention on repeat/mid-session loads where the SW is already
  active, (3) versioned roster entries now ride the HTTP cache instead of bypassing it.
- **v11 upgrade path proven live:** all 3 after-runs show the new worker activated +
  controlling + the `clawville-assets-v11` cache populated via the page-signaled
  precache→ack handshake (the run starts cold, registers v11, reveals, then the deferred
  signal fires — cacheProbeOk=true at capture end means the roster landed post-reveal, as
  designed). The v10→v11 cache migration was separately live-verified pre-ship (84-asset
  v10 profile → v11 holds all entries, no offline gap).
- **Acceptance:** slice B never promised a cold-reveal win — its gate was "no reveal
  regression + precache still functions + upgrade migrates". All three hold. Evidence:
  `docs/perf-data/cold-load-rung4-sliceB-2026-08-11/{before,after}/report-{1,2,3}.json`.

## Buildings-gated reveal (2026-08-20, session prf — FOUNDER RULING: proxies DEAD; the overlay holds for the 11 real buildings)

Spec: `docs/perf-cold-load-buildings-gated-reveal-spec.md` (rev 3 FROZEN;
Codex xhigh spec rounds R1 BLOCK 8+1 / R2 BLOCK 8+1 both folded — blocker
count plateaued so per the oscillation rule the spec froze and the SAME
critic reviewed the emitted diff). Founder killed the slice-D proxy
placeholder look outright ("we tried this once, it was a disaster") and
chose: **no placeholders ever — SeaLoadingScreen holds until the 11 real
streamed buildings are downloaded, warmed, and visibly presented.**

**What shipped (incl. the impl-review B1-B9 fix round — Codex xhigh
BLOCK 9+3 on the first emitted diff, all folded):** proxy system deleted
from `arena-buildings.tsx`; two boot-critical stream lanes (stage A
byte-fetch-only behind the overlay, stage B mount/warm latched at first
core presentation, FORCE-OPENED by every fuse dismissal so a
core-milestone regression pops buildings in raw instead of stranding them
[B7]); world-boot + deferred + hosted-stage compiles CHAINED through the
boot-compile FIFO with a shared poisoned-renderer registry (a timed-out
compile poisons its renderer BEFORE the chain releases, and every chained
task RE-CHECKS the registry at in-chain dispatch time [B1 + fix-NF1], so
release never enables same-renderer overlap; cosmetic/activity compile
paths remain outside — tracked R3-2 arbiter follow-up); rejected compiles
heal via the direct warm INSIDE the chained critical section, exactly
once, and a heal that itself fails poisons the renderer [fix-NF4];
composite overlay dismissal (core presented AND buildings presented via an
ack protocol PAIRED per building-mount instance — commit + additive
renderer-identity warm set + durable failed marker in one instance record
[B4/B5 + fix-NF2/NF3] — plus two qualifying frames, two consecutive ticks
[B6]) through one first-writer-wins `dismiss(reason)`;
identity-latched renderer-generation authority; the streamed buildings
under their OWN SIBLING root (never nested in the scanned boot-core root
[B2]) with draw-time ROOT-level hiding across every warm/healing render
[B3]; occluder tags gated on visibility; owner-keyed mode declaration
(SPA canvas overlap safe [B6]); a "Building the town…" progress band fed
by the live token count; FAIL-CLOSED `bgrEvidence` validator (mode glb +
composite reason + presented ≤ dismissed + all generation stamps PRESENT
and equal — absence rejects [B8]). 10s/45s fuses stay fail-open
(founder-accepted pop-in on slow networks).

**Honest numbers (functional verification, NOT quotable perf — founder-
active box at ~71% CPU, localhost:3010):** guest reveal **5624ms** / auth
player-VRM **6625ms**, both `bgrEvidence.valid` (composite dismissal),
cohort 16/16 warmed / 0 failopen / 0 failed, drift 0, compile failures 0,
cold /cove + /kelp zero building bytes, suite 933+24 green, tsc 0. Timeline
(guest): building byte-fetch kicks 1526ms (behind the overlay) → core
presented 2661ms → buildings settled 5154ms → presented 5184ms → dismissed
5200ms. Context: old prod full-load boot ≈ 9-10s; slice-D staging was
~3.4s WITH proxies (dead by ruling). A quiet-box + real-network staging
measurement is owed before any perf claim.

**Supersession:** slice-D spec rev 5 partially superseded (banner + BGR
spec §0 map). The frozen `--slice-d`/`--slice-e` gate evaluators are
untouched historical records. E4 gate: FOUNDER STAGING PLAYTEST of the new
boot (loading screen → complete town, no gray boxes ever) — entry filed in
FOUNDER-REVIEW.md.

## Rung-4 slice E results (2026-08-19, session prf — compile-overlap EXPERIMENT measured out; the HARDENING ships; ROUND CLOSED)

Spec: `docs/perf-cold-load-rung4-sliceE-spec.md` (rev 3 + §8 outcome; Codex xhigh
rounds R1 8-blocking / R2 8-blocking / R3 3-blocking — every finding folded or
tracked). Slice E ran as an honest EXPERIMENT with a fail-closed gate, and the
gate said no:

**Rev 1 — width-4 pooled compileAsync:** measured compile wall 1279→643-818ms
across lanes, but Codex R1 PROVED r185 concurrency unsafe (WebGPU error scopes
are device-wide LIFO; the shared RenderList/LightsNode mutates per front while
cove chunks carry real point lights; WebGL2 readiness polls read the shared
materialProperties.currentProgram). Killed pre-ship. The ~500ms it measured is
the prize an UPSTREAM three batch-compile primitive would buy (declared
follow-up).

**Rev 2/3 — serial-early (one compileAsync in flight, kicked at warmupStart to
overlap the dep wait + scans):** 12-pair authenticated batch (`batch4`,
baseline dc44a10d8ca8 vs candidate 807b4fc52a8c, arm-isolated rig): paired
compile improvement **median +193ms** (range −262…+748, 11 valid pairs) —
below the 300ms ship bar; candidate tail median **1322ms** > the 1000ms
ceiling; presented paired diff +241ms — real but modest. Physics: the early
compile CONTENDS with the phases it hides behind and returns most of the
overlap. Formal gate verdict: **fail** (also 9/12 valid at the evidence layer
— the known cold-start SW flake + two post-settle-stability breaches under
ambient load). **The early kick was REVERTED. No perf claim ships.**

**What SHIPS (hardening-only, mode `group-serial-1`, compile at the slice-D
post-scans position):** the R1/R2/R3 correctness fixes to latent slice-D-era
defects — renderer-wide boot-compile FIFO across warmup generations +
deferred/stage warms gated on boot-compile idleness; abort-on-failure with an
in-chain healing render (a throwing compileAsync front leaves renderer state
unrestored); ATOMIC sync frustum-culling windows (the async wrapper held
across awaits could leave the world uncullable if a watchdog resumed
mid-compile); (uuid → subtree-signature) compile coverage (an empty-then-
populated root like activity-indicators is recompiled, not silently laundered
into the warm draw); generation-guarded stamps; the honest stamp schema
(requested/dispatched/settled/failed/renderables + wall/tail/hidden with
exact invariants). Rig: per-arm CDP ports + verified port-free waits (the
cross-arm stale-chrome class), runner-derived build SHAs, the `--slice-e`
evaluator retained as the experiment's frozen record.

**Ship evidence (post-reduction singles, quiet box, all green):** guest
presented 2439ms (slice-D watchdog 2590) · auth VRM 3074ms (slice-D median
3359) · GLB player 3046ms (3290) · webgl2 2897ms · cold /cove + /kelp zero
building bytes · drift 0 / failed 0 / coverage exact on every lane · suite
567 green, tsc 0. Two PRE-EXISTING land pin-test failures reproduce on
pristine dc44a10d (staging-merge drift) — filed to the land domain, not
slice-E debt.

**Also root-caused this session:** the itachi-env sync hook was overwriting
`.env.example` (and `.env.local`) in every checkout with a corrupt 1-line
remote v7 on session events — fixed at the source (v8 pushed). Harness
background tasks clamp at 10 minutes — three batches died to it before the
detached-launch recipe; memorialized.

**ROUND CLOSE:** rung 4 ends here. A(§instrumentation)+B(SW)+§5b on prod;
C+D+E on staging. Remaining follow-ups: upstream three batch-compile
primitive (+ the renderer-keyed compile arbiter across boot/stage/cosmetic
paths, R3-2) · WebGL2 lane distributions · the cold-start SW flake class ·
mobile-class probe lane + field telemetry (founder: "flag later"). E4 gates
UNCHANGED: founder staging playtests — slice-D proxy-world first impression +
slice-C wanderer pop-in.

## Rung-4 slice-D results (2026-08-17, session perr4.5 — the boot-core gate; AUTHENTICATED 12-pair webgpu gate PASS)

Spec: `docs/perf-cold-load-rung4-sliceD-spec.md` (FROZEN rev 5 — Codex xhigh
spec rounds 19/15/8/2/SHIP, implementation rounds I1 10 / I2 7 / I3 1 /
I4 SHIP-no-findings). Loading screen dismisses on BOOT_CORE_PRESENTED (an
explicit whitelist of procedural boot content + the resolved boot ACTOR);
buildings/props/NPCs/land stream after eligibility through the per-epoch
warm queue (buildings proxy->warmed atomic swap).

**Headline gate (authenticated VRM player, landtest1 storage-state fixture,
12 counterbalanced pairs, fail-closed --slice-d schema): VERDICT PASS,
12/12 usable.** Baseline = branch merge-base 8b9ee2a8 (slice-C state).

| Metric | Result | Bound |
|---|---|---|
| bootCorePresentedAt (candidate, absolute) | **median 3359ms** | <=5000ms PASS |
| framesOver100In10s (paired diff, 95% UB) | **1** | <=2 PASS |
| candidate revealMs (report-only) | median 3823ms (3773-4017) | — |
| baseline revealMs (report-only) | median 9170ms (8814-10068) | **-58%** |
| streamSettled after reveal | median 9516ms (8920-10058) | <15000 window |
| landSettled after reveal | median 5892ms (5628-6503) | <15000 window |
| worstFrame log-ratio (report-only) | median -1.17 | candidate ~3x BETTER |

Every candidate run: drift 0, cohort 16/16 all ready-warmed (0 fail-open,
0 failed), land failures 0/0/0, actor ordering resolved<=ready<=presented,
storage-state injected, phasesAtWindow snapshot judged. Pair 4's first
candidate run hit the known post-reveal network-quiesce flake (1/24 runs,
slice-C-era class) — the PAIR was re-run per the zero-defect rule (both
arms, BA order preserved), never topped up.

**Watchdog singles (same build):** guest (actor `none`, reveal 3072ms,
presented 2590ms, ordering PASS) · authenticated GLB player (landtest2
lobster — the I1-flagged gap — actor `player-glb`, reveal 3779ms,
presented 3290ms, ordering PASS) · cold `/cove` + `/kelp` scene-leak
asserts (ZERO world-building GLBs fetched; eligibility never fires outside
the world — `cold-load-scene-leak-probe.mjs`). Covered by UNIT tests
rather than live singles (328 suite green): mode transitions
before/after closure, pre-closure same-kind resource swap, avatar
transient-error pendency, loader-remount / stage-before-loader epoch
safety, deadline progress-freeze, hidden-tab queue parking, member-keyed
late-mount delivery, post-settle stable coverage proofs (incl. all three
Codex false-pass counterexamples). Deferred to the staging playtest:
NPC-possession and autonomous live boots (kinds unit-covered; autonomous
is gate-equivalent to `none` by design), SPA round-trip feel.

Evidence: `docs/perf-data/cold-load-rung4-sliceD-2026-08-17/` (24 pair
reports + manifest + gate-verdict + 2 watchdog reports). Rig additions:
probe `--storage-state`/`--expect-boot-actor`/`phasesAtWindow(@15s +
actual-time stamp)`; gate `--slice-d` (exactly-12, zero-defect,
player-vrm headline hard-required, `--watchdog-lane` for other kinds);
`cold-load-auth-state.mjs` fixture minter; `SLICE_D_WINDOW_MS = 15000`
recorded as the deliberate §4b widening (stream settles ~9.5s post-reveal
by design — the 10s window predates streaming). NIT declared: land trio
priorities use tier offsets (tier, +1, +2) instead of tier+distSq — three
far, world-wide sets; within-tier ordering has no measured effect.

**REMAINING GATES: founder proxy-world playtest on staging (E4 — the
proxy look is a product decision) + the slice-C wanderer pop-in playtest
still owed from 2026-08-11.**

## Rung-4 slice-C results (2026-08-11, session perf4.5 — ambient VRMs out of the pre-reveal lane, local webgpu paired gate)

Commit `4f7cc6ea` on `perf/cold-load-diet` after FIVE Codex xhigh adversarial
rounds (r1 5-blocking / r2 3-blocking / r3 2-blocking / r4 1-blocking /
r5 SHIP). Only the player VRM parses in the boot lane; 13 wanderer VRMs +
remote player bodies release-defer through the stagger/warm queues (full
design + round history in `3dStructure.md`, slice-C entry).

**12-pair counterbalanced webgpu gate (baseline `b34aa58c` :3011 vs slice C
:3010, fresh home-path profiles, polled-reveal-v2): VERDICT PASS, 11 usable
pairs** (1 dropped — candidate quiesce flake: the deferred wanderer fetches +
v11 SW precache legitimately extend post-reveal network activity past the
capture's quiesce budget on some runs; benign, run-level, both batches showed
exactly 1/12):

| metric | median log-ratio (B/A) | ≈ effect | gate |
|---|---|---|---|
| revealMs | −0.276 | −24% (A med 12827ms → B med 9668ms, **−3.0s**) | pass |
| worstFrameMsIn10s | −0.926 | −60% | pass |
| stableWindowStartMsAfterReveal | −1.019 | −64% (post-reveal stabilizes ~3× sooner) | pass |
| preRevealLongtaskMs | −0.227 | −20% | pass |
| framesOver100In10s | upperBoundDiff 0 | no regression | pass |

- Quiet-pair candidate profile: reveal 9.0–10.0s, pre-reveal longtasks
  ~2.1–2.6s, stable window ~0.5–0.9s, framesOver100 = 1. `vrmBulkMs` ABSENT;
  `vrmPreRevealAmbientParses`/`PlayerParses` stamp explicit 0/0 on a guest
  boot (acceptance: ambient 0, player ≤ 1).
- A first full batch ran into box contention mid-batch (4 lingering Codex
  xhigh processes + 18 automation chromes → CPU 99%; baseline reveals hit
  30s, three candidate runs breached §2b sanity bounds). The quiet re-run
  after killing the offenders passed everything — the breaches tracked the
  environment, not the candidate. Both batches archived? Only the passing
  quiet batch is archived (`docs/perf-data/cold-load-rung4-sliceC-2026-08-11/`,
  24 reports + manifest + gate-verdict.json); the contended batch remains in
  `cold-load-runs/sliceC-pairs-webgpu/` locally, evidence of the rig rule
  ("verify codex PIDs dead after done" — they weren't).
- Punch list adds: (a) probe quiesce budget vs deliberately-deferred
  post-reveal work — slice D's boot-core capture should treat the staggered
  tail as expected, not as non-quiescence; (b) world-labels-overlay orphan
  occlude-list slots from suspended-retry registrations (Codex r5 nit,
  pre-existing class); (c) epoch-token-per-parse-job (subsumes two accepted
  telemetry residuals) in slice D's instrumentation.
- REMAINING slice-C gate item: the wanderer pop-in is spawn-adjacent — the
  FOUNDER playtest on staging is part of this slice's acceptance (E4); not
  done until that sign-off.
