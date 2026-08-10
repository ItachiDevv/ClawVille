# Cold-Load Diet — RUNG 3 HANDOFF (written 2026-08-08, for a fresh session)

Self-contained brief for rung 3: make the world REVEAL FAST. Rung 2 cut the bytes
(34.62 → 22.74MB cold wire, M2 frozen). Rung 3 cuts the WAIT: the loading screen still
gates on almost the whole world, and a measured ~13s GPU decode/upload/compile gap sits
after the network finishes. Parent plan: `docs/perf-cold-load-diet-2026-07-31.md` (§3.A,
§4 step 3). Rung-2 record: `docs/perf-cold-load-rung2-census-2026-08-07.md` (M2 FREEZE
section). Round memory: `project_cold_load_diet_round.md`.

## 0. Where things stand (verified 2026-08-08)

- **Branch:** `perf/cold-load-diet` in worktree `C:\Users\itachi\Documents\Crypto\cv-covefreeze`.
  ~52 commits ahead of `origin/staging`, deliberately UNPUSHED (staging holds the kelp+reef
  promotion awaiting founder playtest). CONTINUE ON THIS BRANCH.
- **Local rig:** web on :3010 (`bun run build && bun run start` from `apps/web`, PORT=3010),
  API on :4001. NEVER `bun run dev`. Files added to `public/` after server boot 404 — restart
  the server after adding assets.
- **Targets (plan §2):** dev-probe reveal ≤ 8s. Reveal-gated wire ≤ 10MB. Today: reveal fires
  ~14–16s locally; nearly all 22.74MB is pre-reveal.
- **Round rules:** Codex gpt-5.6-sol at `model_reasoning_effort=xhigh` is the adversarial
  co-author at EVERY stage (plan critique → implementation → diff review). Launch pattern
  (only one that survives this box): detached
  `Start-Process cmd /c "codex exec ... < prompt > transcript"` + a Monitor on the report
  file. Embed diffs INLINE in Codex prompts — its sandbox file reads flake
  (`CryptUnprotectData`).

## 1. What rung 3 IS

Three levers, in order:

### Lever 1 — Fix the release anchor (needs the founder decision FIRST)
The one-shot `decorative-release` controller (`apps/web/src/lib/three/decorative-release.ts`)
fires on warmup/stage-ready paths. Rung-1 audit finding 2: it fires **0.4–17.7s BEFORE the
world is actually visible**. So "deferred" assets start downloading inside the critical
window and compete with reveal-critical bytes. FIX: re-anchor the release to ACTUAL first
paint (first presented frame of the world scene). Ask the founder to confirm this anchor
change at session start — it was left as a pending founder call in rung 1.

### Lever 2 — Widen the deferred set (the big one)
Only ONE asset is release-deferred today (flying-dutchman, the rung-1 canary — mechanism
PROVEN, `deferUntilDecorativeRelease` in `arena-location-npcs.tsx` + `DeferredNpcPreloads`).
Work: classify the full boot inventory (`asset-preload-manifest.ts` tiers + the census doc)
into REVEAL-CRITICAL (terrain, spawn-visible buildings, player avatar, locomotion clips)
vs DEFERRABLE (far-side buildings, location NPCs, decorations, wandering VRMs, town props).
Then: (a) move deferrable preloads behind the release; (b) narrow the texture-ready reveal
scan — root cause 2 from the round: the reveal gates on the ENTIRE world inventory
including "Tier 3 deferred". The reveal must wait only for the reveal-critical set.
Candidate first slice: the 2.2MB `_emotes.glb` bundle sits on the critical path — split
locomotion (critical) from emotes (deferred) per the 9-point animation checklist in
`3dStructure.md §6f`.

### Lever 3 — Stagger the GPU work
The ~13s decode/upload/compile gap is real on real GPUs. The perf14 load-freeze work
already built safe post-reveal staggered texture uploads and `warmDeferredObject3D`
(compileAsync + culling save/restore). Route the newly deferred assets through that path
so their GPU cost lands AFTER first paint, throttled.

## 2. Verification — this rung is TIMING work, not byte work

Byte diets verified per-asset. Behavior changes need the STATISTICAL gate:

- **Step 0 (prerequisite): repair the probe rig.** `apps/web/scripts/cold-load-probe.mjs`
  returns "reveal never observed; backend not actual: null" on current Chrome 151 raw-CDP
  runs even though the world boots (4/4, windowed and minimized). The world stamps exist in
  the bundle. Root-cause and fix the probe's stamp/eval wiring. Tooling was FROZEN during
  rung 2; rung 3 unfreezes it because the probe IS the measurement for this rung. Codex
  reviews the repair diff.
- **Then:** paired A/B gate per behavior change: `apps/web/scripts/cold-load-paired-gate.mjs`
  (8 strict pairs/backend, AB/BA counterbalanced, exact binomial bound). Baseline = HEAD
  before the change, candidate = after. Budgets in plan §2b.
- **Watchdog matrix** for every release/defer change (rung-1 canary acceptance): normal boot,
  forced-error, fuses/ceilings, background tab, SPA return, world→activity→world.
- **Ops gotchas:** boot-hang flake ~15–25% (fresh daemon + retry, 3 attempts/arm); sweep
  `agent-browser`/probe chrome processes FIRST when boots fail mysteriously (35 leaked
  chromes faked a GPU failure in rung 2); Bash background tasks die at 10 min — detach via
  `Start-Process`; `taskkill //IM bun.exe` kills the API (restart:
  `cd cv-covefreeze && bun apps/api/src/index.ts`, PORT=4001 in root `.env.local`).

## 3. Punch list (do when touched, or explicitly defer)

1. `--expect-decimate` mode for `scripts/vrm-pipeline-validate.mjs` (S3 subset-relation
   instead of bijection) so decimation outputs stop carrying a permanently-red check.
2. Sea-creature texture consolidation for non-lobster species (same clip-dedupe pattern —
   `scripts/strip-clip-glb.mjs` exists and is proven).
3. The two skipped marginal buildings (claw-arcade −9%, squidward-house −12%) — only if a
   runtime merge benefit shows.
4. Repo hygiene (needs founder go-ahead, separate commit, NOT wire work): ~505MB committed
   Meshy intermediates (`ansem-mesh/` 205MB, `biggie-mesh/` 282MB, `ansem-sword-mesh/` 18MB)
   + ~28MB dead disk siblings incl. `sandy-treedome-v3-opt1.glb` and its vestigial config row
   (`arena-buildings.tsx:289`).
5. After rung 3 lands: FPS floor re-measure on the Iris Xe machine (the 30k avatars changed
   the GPU load), then the r186+ render round picks up from
   `project_perf_r185_round` memory.

## 4. Hard rules carried forward

- Sibling filenames are the cache-bust. KTX2 siblings MUST end exactly `-ktx.glb`
  (the boot preloader routes on that substring — `asset-preload-manifest.ts:259`; a wrong
  name black-screens boot).
- After ANY literal ref flip, grep for template-literal path constructors over the same
  directories (the land-showroom lesson).
- Bulk flip scripts must NEVER touch `docs/perf-data/`, `reports/`, or test fixtures
  (frozen evidence).
- No staging push until the kelp+reef promotion clears the founder (or the founder reorders).
- Iris Xe: no drei Text/Billboard, no InstancedMesh+ShaderMaterial, no per-frame Vector3.
- Same-diff docs: census/plan results ledger + `3dStructure.md` + memory topic checkpoint.

## 5. First commands of the fresh session

```bash
cd /c/Users/itachi/Documents/Crypto/cv-covefreeze && git log --oneline -3 && git status --short | head
curl -s -o /dev/null -w "web:%{http_code} " http://localhost:3010/game ; curl -s -o /dev/null -w "api:%{http_code}\n" http://localhost:4001/health
```

Expect HEAD at/after `ab50bac8`, clean-ish tree, web:200 api:200 (rebuild+restart if down).
Then: ask the founder the Lever-1 anchor question, and start with Step 0 (probe repair).
