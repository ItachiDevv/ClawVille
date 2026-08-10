# Cold-Load Diet — RUNG 4 HANDOFF: THE BOOT-CORE GATE (written 2026-08-09, for a fresh session)

Self-contained spec for rung 4: replace the all-or-nothing world-ready gate with a
BOOT-CORE gate so a coherent spawn view PRESENTS in ~4–7s and the rest of the world
streams in. Synthesis + evidence: `docs/perf-cold-load-bigjump-plan-2026-08-09.md`
(three independent tracks — phase telemetry, Codex xhigh audit, Spettro/Kimi K3 —
one verdict). Rung-3 record: the results ledger at the bottom of
`docs/perf-cold-load-diet-2026-07-31.md`. Round memory: `project_cold_load_diet_round.md`.

## 0. Where things stand (verified 2026-08-09)

- **Staging is the checkpoint:** rungs 1–3 live at `e4dffa04` (+ docs `7615c0e7`),
  merged with the land-v47 sprint. Browser-verified: first-paint release, 553→640
  mesh stream-in post-reveal, kelp camera fix intact.
- **Branch:** `perf/cold-load-diet` in worktree `C:\Users\itachi\Documents\Crypto\cv-covefreeze`
  — now MERGED WITH staging (fork-point pain is over; keep merging staging in early
  and often). Baseline worktree for A/B: `C:\Users\itachi\Documents\Crypto\cv-perf-baseline`
  (detached; re-point it at the rung-4 fork commit before the first gate).
- **Local rig:** web `:3010` (candidate) + `:3011` (baseline) via
  `bun run build && bun run start`, API `:4001`. NEVER `bun run dev`.
- **Founder gates pending from rung 3** (do not silently resolve): §2b longtask-boundary
  amendment, webgl2 sanity-bound recalibration, background-tab boot decision (task 6),
  checkpoint playtest. Rung 4 does not need them resolved to START (slices A–C), but
  slice D's acceptance requires the §2b decision because it REDEFINES the reveal event.
- **Measured 11.6s waterfall (medians, 11 valid runs):** 3.8s pre-warmup head
  (hydration+renderer init+registration) · 0.2s barrier · 5.6s "vrmBulk" (13-VRM
  main-thread parse queue tail + the FIRST hidden whole-scene compile) · 1.1s second
  whole-scene compile · ~1.0s fade/settle. Staging real-network reveal ≈18s (SW
  precache contention adds seconds that localhost hides).

## 1. What rung 4 IS

Two new milestones replace the single `__W3D_READY` conjunction:

- **`BOOT_CORE_PRESENTED`** — an explicit boot-core `Object3D` has loaded, uploaded,
  compiled, and PRESENTED one frame. This dismisses the loading screen.
- **`WORLD_STREAMING`** — everything else enters the rung-3 machinery
  (`onDecorativeReleaseStaggered` → `DeferredWarmAttachment` → `deferred-warm.ts`
  one-at-a-time GPU warm queue). The rung-3 slice IS the enabling infrastructure.

**Boot core (in):** stage renderer + solid background/fog/lights (no texture skybox
exists) · procedural `SandFloor` (terrain heightfield must init — collision) · the
player's own body + locomotion clips (player/NPC modes; explore = camera only) ·
town sign/collision/interaction anchors · the EXISTING two-mesh `BuildingProxy` for
ALL 12 building slots (`arena-buildings.tsx:703`, activated via `fullDetail={false}`,
currently defaulted ON at `PerfAudit.ts:19`) · at most ONE spawn-adjacent quest/guide
asset if product demands (founder call; default OUT).

**Out of boot (streams):** 11 real building GLBs (Sandy is procedural) · 3 town-prop
GLBs · ALL 13 ambient VRMs + wandering lobster · land showroom/ring/kit content ·
decorations (already deferred) · emote bundle.

## 2. Slices, in order, each independently gated

### Slice A — INSTRUMENT FIRST (no behavior change)
Add phase stamps: module-eval → GamePage first render/effect → stage-root effect →
renderer factory start → canvas-size ready → `renderer.init` start/end → world chunk
eval → boot-core commit → `bootCoreCompileMs` → `bootCoreFirstPresentedAt`, plus
per-avatar `?perf=1` VRM stamps already in `vrm-loader.ts:914`. Extend the probe to
capture the new stamps ALONGSIDE the existing reveal (old reveal becomes
`streamSettledMs`-adjacent evidence; keep both). Acceptance: one clean 3-run batch
showing the full decomposed waterfall; the 3.8s head attributed to named phases.
This decides whether slice F is worth doing and BASELINES every later slice.

### Slice B — Service-worker precache stand-down (small, independent, real-network win)
Today: 22 URLs / 7.8MiB fetched concurrently at `window.load` with `cache:'no-store'`
(`sw.js:170`, registration `sw-register.tsx:61`), duplicating 14–15 tier-1 fetches.
Fix: install an EMPTY asset cache and populate from runtime requests, OR defer
registration/precache until `BOOT_CORE_PRESENTED` (once slice D lands; until then,
defer to the decorative release). Preserve offline coverage list; do not drop the
`ASSET_PATH_PREFIXES` runtime caching. Acceptance: fresh-profile run shows ZERO
duplicate URL fetches pre-reveal; staging (real network) reveal delta measured
before/after with 3 runs each (expect seconds; localhost will show ~nothing).
CAUTION: SW changes ride `updateViaCache:'none'` + version bump discipline
(`3dStructure.md §6f`); a broken SW is a 7-day CF-edge regression — test the
update path (old SW → new SW) explicitly.

### Slice C — Ambient VRMs fully out of the pre-reveal lane (worth ~5s alone)
Facts: 13 ambient VRM paths (`asset-preload-manifest.ts:118` — the "6 paths" comment
at :298 is WRONG, fix it), all parsed main-thread pre-reveal via `arena-npcs.tsx:1658`
mounts; fetches bypass the LoadingManager (`vrm-loader.ts:731`) so a FAST network
JOINS the reveal gate and a slow one misses it (inversion). Change: only the PLAYER
VRM parses in the boot lane; ambient bodies mount post-paint by camera distance
through the stagger/warm queues (same pattern as location NPCs — reuse, don't fork).
Wanderers are spawn-adjacent: the pop-in is the most visible in the game, so
**founder acceptance screenshot/playtest is part of this slice's gate** (E4).
Acceptance: `?perf=1` shows pre-reveal ambient parse count = 0, player ≤ 1;
`vrmBulkMs` absent or player-only; paired gate (webgpu lane) green on the
like-for-like reveal event; wanderer pop-in founder-approved.

### Slice D — The boot-core gate proper (the jump)
Build the explicit boot-core `Object3D` list; the warmup gate scans/compiles/uploads
ONLY it (never `scene`); drop the global `DefaultLoadingManager`-idle barrier (scope
a manager or count boot-core loads explicitly); `BOOT_CORE_PRESENTED` fires after its
first PRESENTED frame (reuse the rung-3 two-consecutive-frame + visibility predicate
from `decorative-release.ts` — same discipline, new milestone). The decorative
release then anchors to boot-core-presented (it already anchors to first paint —
verify the predicate chain composes, don't duplicate it). Proxies→real GLB swaps go
through `DeferredWarmAttachment` and swap ATOMICALLY (no half-textured pops).
SeaLoadingScreen dismisses on the new milestone; its 45s force-dismiss and the
armDecorativeDeadline ceiling remain.
Acceptance: `bootCoreFirstPresentedAt` ≤ 5s median on the local webgpu lane
(12-pair gate, like-for-like events per §3 below); post-reveal frame gate
(framesOver100 diff ≤ 2 vs pre-rung-4 baseline) holds; watchdog matrix (§4) passes;
founder playtest of the proxy-world first impression (E4 — this changes the first
thing every player sees; the proxy look is a PRODUCT decision).

### Slice E — Per-object compile migration (kills both whole-scene compiles)
Replace `compileAsync(scene, camera)` at `World3DCanvas.tsx:1938` (pre-textures,
wasted, hidden in vrmBulk) and `:1991` with per-object upload→
`compileAsync(object, camera, scene)` as boot-core members commit (streamed content
already does this via the warm queue). One renderer warm in flight ever. Culling
save/restore per object, not scene-wide. Acceptance: zero whole-scene compiles in a
normal boot (assert via instrumentation); boot-core compile tail < 500–800ms; no
first-use hitch when streamed objects attach (frame gate).

### Slice F — Boot-shell thinning (ONLY if slice A shows the head is JS-bound)
GamePage statically imports the full HUD/modal tree (~3.25MiB reachable) before the
canvas effect. Split: minimal boot shell (loader + canvas + core stores) →
post-first-paint HUD mount. Do NOT touch adapter/device init unless slice A shows
`renderer.init` > ~1s. Acceptance: head phase reduction measured ≥ 300ms or the
slice is abandoned (no speculative churn).

## 3. Measurement protocol (per slice; the rig rules are hard-won — follow ALL)

- Paired A/B gate per behavior slice: 12 counterbalanced pairs, fresh profile per
  run, `apps/web/scripts/cold-load-paired-gate.mjs`. **Like-for-like events only:**
  once slice D redefines reveal, compare `bootCoreFirstPresentedAt` (new) between
  arms only if BOTH arms stamp it; against pre-rung-4 baselines compare the OLD
  reveal event to itself (`streamSettled`) AND report the new event separately.
  Never compare boot-core-presented against full-world reveal in one ratio.
- §2b longtask boundary: pending founder amendment — until decided, report BOTH the
  frozen asymmetric metric and the symmetric polled-boundary metric side by side.
- **Rig hard rules (memory `feedback_windows_pid_kills_and_batch_health`):** probe
  Chromes launch with `--disable-backgrounding-occluded-windows
  --disable-renderer-backgrounding` (occluded windows park the boot — that "flake"
  was never a flake) · NEVER kill by stored PID — kill by profile BASENAME match and
  SMOKE-TEST the kill before any batch · `free_probe_port` before launch ·
  `ensure_server` health check per pair · every batch gets a health watcher AND a
  ~10-min progress reporter (founder cadence requirement — no silence-until-done).
  The hardened runner from rung 3 is at scratchpad `ab-runner-final.sh` — copy its
  patterns into a committed script this rung (punch item).
- No builds/tests during a running batch (contention corrupted runs twice).
- WebGL2 lane after webgpu; its bounds are a known mode-lottery (see ledger) —
  report distributions, don't grind reruns hoping.

## 4. Watchdog matrix (every slice that touches the gate or streaming)

Normal cold boot · forced renderer error → recovery lane · 45s fuses/ceilings ·
background-tab boot (parks by design; deadline covers; foregrounding resumes) · SPA
world→kelp→world and world→activity→world (stage keeps scenes RESIDENT — no remount
mitigations, verified) · cold `/cove` and `/kelp` boots (world never activates —
nothing world-deferred may leak into their reveal paths) · guest + logged-in +
agent-connected modes (PARITY: render-timing only — any gate touching agent-visible
state is out of scope for this rung and needs its own review).

## 5. Codex + Spettro operating pattern

- Codex gpt-5.6-sol `model_reasoning_effort=xhigh` adversarial at EVERY stage (spec
  critique before slice D especially). Launch pattern (only survivor on this box):
  detached `Start-Process cmd /c "codex exec ... < prompt > transcript"` +
  `--output-last-message` verdict file + a Monitor on it. Embed diffs INLINE in
  prompts (sandbox file reads flake). Expect BLOCKs; they found real bugs 2/4 rounds.
- Spettro/Kimi K3 for outside-view audits only: force TARGETED reads (whole-file
  reads blow the CF 524 gateway) and append-to-disk-per-turn (headless discards
  inline analysis).
- Fable (orchestrator): decomposes, freezes specs, verifies, owns ship. My own code
  gets Codex review like anyone's — the missed-release race proved why.

## 5b. FOUNDER PLAYTEST FOLLOW-UPS (2026-08-09 — checkpoint APPROVED "okay it looks great"; these are the only notes. Small, run them as a parallel lane BEFORE or alongside Slice A; they are gameplay fixes, not perf work — dispatch per domain: reef items → the reef domain patterns, kelp item → the shared player controller)

1. **Reef Race: whirlpool items don't work.** Founder: "whirlpool items don't seem to really work." Reproduce in a live race first (drive it — do the pickups apply no effect, a wrong effect, or no visual?); the item/boost system lives in the shared activities protocol (`packages/shared/src/activities/protocol.ts` activeBoosts edge-triggering) + the reef scene item handling (`apps/web/src/lib/three/activities/reef-race/`). Server-authoritative: check BOTH the sim applies the effect AND the client presents it. Fix = whatever the reproduce shows; verify in a real staged race.
2. **Reef Race: widen the track, same structure.** Founder wants more lateral room without changing the course layout. The track is spline-based (`packages/shared/src/reef-race/spline.ts` + track constants); widen the drivable width/collision margins, NOT the spline path. Watch the couplings: start-grid row spacing, boost-pad/item placement lateral positions, rip-current lane widths, bot racing lines, and the anti-cheat lateral bounds — all may key off track width. (Standing preference on file: wide 4-player competitive course, validate width/lanes/overtaking before polish.)
3. **Reef Race: urchin spin must not change final heading.** The spin disorient is approved, but the racer must exit the spin with the SAME heading they entered with (today they end up facing wrong directions). Find the urchin contact handler in the reef sim (server-authoritative contact per R18c) — make the spin purely presentational/rotational during its duration and restore the pre-contact heading (or continuously preserve the underlying velocity heading) at spin end. Verify: hit an urchin at speed mid-corner, confirm exit heading continues the racing line on BOTH self-prediction and remote views.
4. **Kelp forest: enable sprint.** The kelp slot mounts with `sprint: false` in its capability mask (`WorldStageRoot.tsx` kelp scene `capabilities`) — flip to true. The shared controller + `KELP_POLICY` already handle sprint generically (capability-masked per the unified-controller ruling — do NOT re-implement movement). Check `KELP_REALM_PLAYER_SPEED_WU_PER_SEC` × run multiplier against corridor width/camera feel, and that the run animation triggers (state.running flows to the animator). Founder feel-check on the result.

Each item: reproduce → fix → verify live in a staged run → Codex review batch (one review for the lane is fine — they're small). Same-diff docs where behavior changes (`3dStructure.md` for reef/kelp mechanics).

## 6. Punch list (carried + new)

1. Commit the hardened A/B runner as `apps/web/scripts/cold-load-ab-runner.sh`.
2. Fix the "6 paths" lie at `asset-preload-manifest.ts:298` (slice C does it).
3. Emote bundle split (2.2MB, 9-point animation checklist) — pairs well with slice C.
4. Sea-creature texture consolidation (proven clip-dedupe pattern).
5. Repo hygiene ~505MB Meshy intermediates — founder go-ahead required, separate commit.
6. FPS floor re-measure on Iris Xe AFTER rung 4 (then the r186+ render round).
7. Marginal buildings (claw-arcade/squidward) only if a runtime merge benefit shows.

## 7. First commands of the fresh session

```bash
cd /c/Users/itachi/Documents/Crypto/cv-covefreeze && git log --oneline -3 && git status --short | head
git fetch origin staging && git log --oneline -1 origin/staging   # merge staging in EARLY if it moved
curl -s -o /dev/null -w "web:%{http_code} " http://localhost:3010/game ; curl -s -o /dev/null -w "api:%{http_code}\n" http://localhost:4001/health
```

Expect HEAD at/after the rung-4 handoff commit, clean tree. Then: read
`docs/perf-cold-load-bigjump-plan-2026-08-09.md`, confirm the founder's §2b/webgl2/
task-6 decisions (ask if still open), and start with Slice A.

---

## 8. DRAFT KICKOFF PROMPT (founder: paste after your checkpoint playtest, edit freely)

> Cold-load rung 4 (boot-core gate) + founder playtest follow-ups. Read
> `docs/perf-cold-load-rung4-handoff.md` in
> `C:\Users\itachi\Documents\Crypto\cv-covefreeze` (branch `perf/cold-load-diet`,
> continue on it) and execute it. The rung-3 checkpoint is APPROVED on staging
> (2026-08-09). Start with the §7 health check, then the §5b playtest follow-up
> lane (reef whirlpool items broken · widen reef track keeping structure · urchin
> spin must restore heading · enable sprint in kelp), then Slice A
> (instrumentation). Decisions: §2b boundary amendment [symmetric / keep frozen],
> webgl2 bounds [recalibrate / quiet-box reruns], background-tab boot [option
> a/b/c], proxy-world first impression [I'll judge at slice D / pre-approve
> BuildingProxy look]. Codex xhigh adversarial at every stage; 10-minute progress
> reports on anything long-running. (Staging→master promotion is handled by a
> separate session — do not promote from this one.)
