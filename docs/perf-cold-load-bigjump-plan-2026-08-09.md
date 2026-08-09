# Cold-load BIG JUMP — three-track investigation synthesis (2026-08-09)

Founder charge: "games way heavier load much faster — we're missing something." Three independent tracks (Fable phase-telemetry analysis · Codex gpt-5.6-sol xhigh code audit · Spettro/Kimi K3 outside view, report at scratchpad/spettro-kimi-coldload-report.md) reached the SAME verdict.

## The verdict
The bottleneck is the DEFINITION OF READY. Today `__W3D_READY` = "the whole world is parsed + uploaded + compiled + warm-rendered" (12 buildings, 3 town props, 13 ambient VRMs — not 6, the manifest comment lies — all textures, two WHOLE-SCENE compileAsync passes with culling disabled, one before textures even upload). It should be "a coherent spawn view has PRESENTED one frame." Measured waterfall of the 11.6s median (11-run medians, candidate arm): 3.8s pre-warmup head (hydration + renderer init + registration) · 0.2s barrier · 5.6s "vrmBulk" (= VRM parse queue tail + the FIRST hidden whole-scene compile) · 1.1s second whole-scene compile · ~1.0s fade/settle.

## Ranked attack plan (Codex ranking, cross-verified; payoffs non-additive — #1 subsumes much of #2/#3)
1. **BOOT-CORE GATE (the jump, est. −4.5–7.0s → 4–7s reveal).** Two milestones: `BOOT_CORE_PRESENTED` (stage renderer + solid bg/fog/lights + procedural SandFloor + player body w/ locomotion + town sign/collision/anchors + the EXISTING BuildingProxy for all 12 slots) then `WORLD_STREAMING` (everything else through the rung-3 DeferredWarmAttachment/queues — the slice we just shipped IS the enabling infrastructure). Boot gate scans/compiles an explicit boot-core Object3D, never `scene`; no global loader-idle wait. Proxies swap to real GLBs post-warm, atomically. Acceptance: first presented core frame ≤5s + no regression on the post-reveal frame gate.
2. **Ambient VRMs out of the pre-reveal lane entirely** (est. −2.5–5.5s isolated; mostly inside #1). 13 ambient VRMs parse main-thread pre-reveal today (fetch outside the LoadingManager → a fast network JOINS the gate, slow network misses it — an inversion). Keep only the player parse in boot; mount ambient bodies by camera distance post-paint. Prove with `?perf=1` per-avatar fetch/queue/parse/normalise stamps: pre-reveal ambient parse count must be ZERO.
3. **Kill both whole-scene compiles → per-object warming** (est. −0.7–1.8s WebGPU, −2–4s WebGL2). First compile (World3DCanvas:1938) runs BEFORE textures upload and hides un-stamped inside vrmBulk; second (1991) repeats the whole scene. Replace with per-object upload→compileAsync(object, camera, scene) as objects commit (the deferred-warm overload already does exactly this). Never two renderer warms in flight.
4. **Thin the /game boot shell + instrument renderer init** (est. −0.2–0.9s; decides whether the 3.8s head hides more). GamePage statically imports the whole HUD/modal tree pre-canvas (~3.25MiB reachable across 25 chunks). Split: tiny boot shell → post-first-paint HUD. Add phase stamps module-eval→first-render→factory→size→init→chunk-eval→core-commit; only touch adapter/device if init >~1s.
5. **SW precache races the first load** (localhost −0–0.3s; REAL NETWORK est. −1–5s — staging measured 18s reveal vs 11.6 local). 22 URLs / 7.8MiB fetched concurrently with `cache:'no-store'` at window.load (~215ms), duplicating 14-15 tier-1 fetches. Fix: empty install cache + runtime population, or register after BOOT_CORE_PRESENTED.

## Discarded/deprioritized (evidence)
KTX2 already workered · meshopt workerization low-leverage vs streaming · HTTP priorities can't fix a compute tail · OffscreenCanvas = high-risk rewrite, doesn't remove pipeline creation · 420ms fade = small win · demand-rendering irrelevant (canvas already paused). Kimi's "upload slices throttled" claim was WRONG (fastMode already active pre-reveal — Spettro-session verified).

## Funding recommendation (Codex, endorsed)
If one initiative: **#1 with #2 as its first streamed tier**, #5 as the cheap companion (real-network win). Retaining the full-scene gate while shaving more bytes will never produce game-class 3–5s first playability.

## Status
Rungs 1-3 shipped to staging `e4dffa04` (checkpoint live). This plan is the proposed rung 4 — NOT started; awaiting founder go-ahead + the §2b/webgl2 protocol decisions in the rung-3 ledger.
