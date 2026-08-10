# Adversarial audit report — cold-load diet rung 1

Audit target: `perf/cold-load-diet` at `5d176d0171058442eb4397126e33500caf69d8ec`.

## Findings

1. **BLOCKING — WebGL2 formally failed; the post-hoc n=18 extension cannot rescue the rung under the declared acceptance protocol.**

   The committed retest gate’s overall verdict is `fail`; `stableWindowStartMsAfterReveal` has upper bound `0.269362`, exceeding the `0.139762` limit ([gate-webgl2-rt-n12.json](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/docs/perf-data/cold-load-rung1-2026-08-01/gate-webgl2-rt-n12.json:2), [lines 19–24](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/docs/perf-data/cold-load-rung1-2026-08-01/gate-webgl2-rt-n12.json:19)).

   This is exactly the terminal condition defined by the frozen protocol: `EXTEND_PAIRS = 12`, and a bound still open at that cap becomes `fail` ([cold-load-paired-gate.mjs](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/scripts/cold-load-paired-gate.mjs:23), [lines 153–155](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/scripts/cold-load-paired-gate.mjs:153), [plan lines 412–420](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/docs/perf-cold-load-diet-2026-07-31.md:412)). The later proposal to “extend that one metric” contradicts that rule ([plan lines 350–365](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/docs/perf-cold-load-diet-2026-07-31.md:350), [extension script](/C:/Users/itachi/AppData/Local/Temp/claude/C--Users-itachi-Documents-Crypto-clawville/aa839a38-c6cb-48bb-9086-3a7b55129d0a/scratchpad/coldload/run-batch-canary-rt-ext.sh:1)).

   It also introduces optional stopping. From the implemented order-statistic calculation, the critical ranks are 10/12 and 13/18 ([cold-load-paired-gate.mjs](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/scripts/cold-load-paired-gate.mjs:35)). At the null boundary, a “pass at n=12, otherwise try again at n=18” rule has false-pass probability `14153/262144 = 5.399%`, not 5%. If only the failed metric is updated while the four n=12 passes are frozen, that is selective endpoint updating; the executable gate instead recomputes all five metrics together ([cold-load-paired-gate.mjs](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/scripts/cold-load-paired-gate.mjs:141)).

   A valid rescue requires either a fresh fixed-size confirmatory batch with no interim decision or a predeclared alpha-spending/confidence-sequence procedure.

2. **MAJOR — The canary is deferred past the readiness release, but not past the probe-defined reveal.**

   The canonical canary report records release at `19228 ms`, Dutchman request start at `19229.547 ms`, and reveal at `19746 ms`: the asset starts correctly after release but 516 ms before reveal ([report summary](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/docs/perf-data/cold-load-rung1-2026-08-01/report-canary-gpu-a5.json:24), [request record](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/docs/perf-data/cold-load-rung1-2026-08-01/report-canary-gpu-a5.json:11480)). The same report records `preRevealMB: 36.4` and `postRevealMB: 0` ([report-canary-gpu-a5.json](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/docs/perf-data/cold-load-rung1-2026-08-01/report-canary-gpu-a5.json:34)).

   Independent inspection of every candidate report referenced by the three manifests found all 36 Dutchman requests before reveal:

   - WebGPU: 0.570–2.000 seconds before reveal.
   - Initial WebGL2: 4.094–17.726 seconds before reveal.
   - WebGL2 retest: 0.407–3.081 seconds before reveal.

   Artifacts: [manifest-webgpu.json](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/docs/perf-data/cold-load-rung1-2026-08-01/manifest-webgpu.json), [manifest-webgl2.json](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/docs/perf-data/cold-load-rung1-2026-08-01/manifest-webgl2.json), [manifest-webgl2-rt.json](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/docs/perf-data/cold-load-rung1-2026-08-01/manifest-webgl2-rt.json).

   Therefore “removed from the reveal-readiness gate” is supported; “instead of loading pre-reveal” or “post-reveal deferral” is not.

3. **MAJOR — The canary assertion does not prove that the NPC mounts or that omission is impossible.**

   The assertion claims to prove “never stranded/omitted,” but it only checks for a successful request and request-start ordering ([cold-load-canary-assert.mjs](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/scripts/cold-load-canary-assert.mjs:5), [lines 40–74](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/scripts/cold-load-canary-assert.mjs:40)). The independent deferred preloader is sufficient to produce that successful request ([arena-location-npcs.tsx](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/src/lib/three/arena-location-npcs.tsx:883)), even if `LocationNpc` remained behind its `!released` render gate ([arena-location-npcs.tsx](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/src/lib/three/arena-location-npcs.tsx:753), [line 783](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/src/lib/three/arena-location-npcs.tsx:783)).

   The plan says the DOM label was observed, but no mount/label field exists in the committed report ([plan lines 294–297](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/docs/perf-cold-load-diet-2026-07-31.md:294)). There is also no automated normal/error/timeout/SPA-remount assertion despite those scenarios being required by the plan ([plan lines 374–378](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/docs/perf-cold-load-diet-2026-07-31.md:374)).

   Static review found the monotonic state and late-subscriber handling plausible, but the claimed behavior evidence cannot detect the central omission failure mode.

4. **MAJOR — The WebGL2 30s→40s sanity recalibration was outcome-dependent and cannot be applied retroactively to the same batch.**

   The new threshold is explicitly chosen above the already-observed baseline maximum ([cold-load-paired-gate.mjs](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/scripts/cold-load-paired-gate.mjs:60), [plan lines 435–442](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/docs/perf-cold-load-diet-2026-07-31.md:435)). Commit `7c581ce7` was authored at 22:40 EDT, after the first eight WebGL2 pairs had been observed. Three first-eight candidates had also already exceeded the original 30s rule—34.083s, 34.479s, and 34.641s—so the change materially benefited the candidate, not merely the baseline ([manifest-webgl2.json](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/docs/perf-data/cold-load-rung1-2026-08-01/manifest-webgl2.json)).

   The baseline results are credible evidence that 30s was a bad environment ceiling. The legitimate disposition is: the observed batch fails the old frozen bound; 40s may be frozen prospectively for a new batch. The later RAM retest is unaffected because its candidate reveals were all well below 30s.

5. **MAJOR — Build identity and raw evidence are not durably attested.**

   The manifests contain only backend, order, and machine-local temporary report paths; they carry no baseline/candidate commit, bundle ID, artifact digest, hardware fingerprint, or runner version ([manifest-webgl2-rt.json](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/docs/perf-data/cold-load-rung1-2026-08-01/manifest-webgl2-rt.json:1)). The gate reads only each report’s `summary` and never verifies target port, commit, bundle, or variant identity ([cold-load-paired-gate.mjs](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/scripts/cold-load-paired-gate.mjs:219)).

   The plan acknowledges that the evidence is tied to a served bundle rather than an attested branch and defers build-ID attestation ([plan lines 298–307](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/docs/perf-cold-load-diet-2026-07-31.md:298)). It later claims a served-chunk grep distinguished the builds, but no grep output or chunk digest is committed ([plan lines 312–317](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/docs/perf-cold-load-diet-2026-07-31.md:312)).

   The raw files resolved during this audit, but the committed repository alone cannot reproduce the gates or prove which commits generated the reports.

6. **MINOR — Counterbalance and reuse enforcement are weaker than the stated protocol.**

   The evaluator validates only legal `AB|BA` tokens and aggregate count balance; it does not verify alternating chronological execution or compare `capturedAt` timestamps ([cold-load-paired-gate.mjs](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/scripts/cold-load-paired-gate.mjs:112), [lines 135–138](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/scripts/cold-load-paired-gate.mjs:135)). Report reuse detection compares path strings only, so copying identical content to another filename evades it ([cold-load-paired-gate.mjs](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/scripts/cold-load-paired-gate.mjs:205)).

   This did not invalidate these artifacts: independent checks found exact chronological AB/BA execution and 72 unique SHA-256 report contents.

7. **MINOR — The “absolute 45s deadline” is not anchored to the loader’s deadline.**

   `armDecorativeDeadline()` starts a new 45-second timer when invoked ([decorative-release.ts](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/src/lib/three/decorative-release.ts:68)), but it is not armed until the warmup effect reaches line 1898 ([World3DCanvas.tsx](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/src/components/three/World3DCanvas.tsx:1891)). `SeaLoadingScreen` starts its separate 45-second timer at its own mount ([sea-loading-screen.tsx](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/src/components/game/sea-loading-screen.tsx:140), [lines 177–187](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/src/components/game/sea-loading-screen.tsx:177)).

   Thus the controller’s comment that it cannot outwait the loader is not strictly true. The stage’s separate 40-second fuse mitigates this ([World3DCanvas.tsx](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/src/components/three/World3DCanvas.tsx:1831)), and the module timer still prevents permanent stranding, but it is not a page-boot-absolute deadline.

8. **ADVISORY — The declared commit range is internally inconsistent.**

   `git rev-list --count 42437ec7..5d176d01` returns 8, not 12, and normal Git range syntax excludes `42437ec7` itself—the commit that introduced the release controller ([plan attribution](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/docs/perf-cold-load-diet-2026-07-31.md:286)). The last 12 commits through HEAD include `42437ec7` plus three earlier probe/statistics commits. This audit included the current controller despite the malformed range.

## Checks that survived attack

- Re-running all committed manifests reproduced the artifacts exactly:

  - WebGPU: PASS, exit 0, five metrics pass.
  - Initial WebGL2: FAIL, exit 3, four ratio metrics fail.
  - WebGL2 retest: FAIL, exit 3, stable-window metric fails.

- `medianUpperBoundIndex` itself is correctly implemented for a fixed sample: ranks are 7/8, 10/12, and 13/18 ([cold-load-paired-gate.mjs](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/scripts/cold-load-paired-gate.mjs:41)). The paired count-difference implementation matches its stated median-difference rule ([cold-load-paired-gate.mjs](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/scripts/cold-load-paired-gate.mjs:164)).

- All 72 counted reports had `validForPerformance:true`, `backendWaived:false`, the requested actual backend, finite metrics, one successful Dutchman request, and no path/content reuse.

- The retest’s counted navigations all began after the 22:11:34 restart; the first inferred navigation start was approximately 22:11:43.9. No contaminated double-instance run was found in the manifest.

- The release controller is monotonic, late subscriptions fire synchronously, and preload timer/idle handles are canceled on unmount ([decorative-release.ts](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/src/lib/three/decorative-release.ts:26), [lines 90–96](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/src/lib/three/decorative-release.ts:90), [arena-location-npcs.tsx](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/src/lib/three/arena-location-npcs.tsx:890)). Raw reports showed exactly one Dutchman fetch per run, so no observed double-fetch.

- Backend stamping is diagnostics-only: application code does not read `__W3D_BACKEND`; the stage stamps after successful initialization and on recovery ([WorldStageCanvas.tsx](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/src/components/three/world-stage/WorldStageCanvas.tsx:210), [line 246](/C:/Users/itachi/Documents/Crypto/cv-covefreeze/apps/web/src/components/three/world-stage/WorldStageCanvas.tsx:246)). No Iris-Xe shader, material, DPR, geometry, or kill-list invariant was changed.

- Relevant tests passed: 42/42. Web TypeScript passed with `tsc --noEmit --incremental false`. The working tree remained clean.

The code-level deferral is credible, but rung 1 has not met its own cross-backend acceptance rule, and the planned extension is not valid confirmatory evidence under the frozen statistical method.

VERDICT: REJECT