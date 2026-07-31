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
- **M1 (post-A):** reveal-gated wire **≤15.5MB** (arithmetic floor ~14.97 under the §A animation
  role split; 15.37 if the split under-delivers — the ledger decides); per-phase reveal-time
  improvement measured; both backends inside their M0 budgets.
- **M2 (post-A+B/C): PROVISIONAL ≤11MB reveal-gated / ≤22MB total-session** — the re-review
  showed the currently-named diets sum to ~11.2MB reveal and only ~6.5-7MB of the 12.6MB
  total-session savings needed. These targets are ratified or revised AT M0 by the ledger: either
  the rung-0 ledger names the additional still-gated core savings (building texture/geometry
  rows are candidates but are NOT yet quantified) and enough eventual-stream diets to close, or
  the targets move to what the named rows actually sum to. No un-named savings may be assumed.
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

## 5b. Defects discovered during M0 setup (2026-07-31, local full-stack)

1. **API-failure boot = permanent black "WARMING SCENE".** A fresh visitor whose API calls fail
   (observed with a web build lacking a working API URL) hangs forever on the stage's black
   'awaiting' overlay: the SeaLoadingScreen force-dismisses at 45s but the stage warmup has no
   fail-open to any usable state, and the world scene never mounts. Class-match with the
   re-review's finding 2 (gate/lifecycle failure behind a dismissed loader). Not introduced by
   this round — needs a fix ticket independent of the diet.
2. **Intermittent healthy-API cold-boot hang (local).** With API + web both healthy on
   localhost, one of two fresh-profile cold boots deadlocked the same way (world scene module
   never evaluated — the stage never mounted it); the next identical run booted fine. Staging
   fresh-profile probes are 2/2 green. Suspected race in the stage/session handshake that fast
   local networks make more likely. M0 runs will record the hang rate; the rung-1 canary's
   watchdog matrix must cover it.
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
