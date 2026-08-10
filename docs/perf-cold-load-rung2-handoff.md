# Cold-Load Diet — RUNG 2 HANDOFF (written 2026-08-06, for a fresh session)

Self-contained brief for executing rung 2 of the cold-load diet ladder. Parent plan:
`docs/perf-cold-load-diet-2026-07-31.md` (workstreams §3.B + §3.C, sequencing §4 step 2).
Rung-1 closure record: plan doc "Rung-1 canary status" + `docs/perf-cold-load-diet-2026-08-04-rung1-audit.md`.

## 0. Where things stand (verified 2026-08-06)

- **Branch:** `perf/cold-load-diet` in worktree `C:\Users\itachi\Documents\Crypto\cv-covefreeze`,
  HEAD `e05183e0`, **25 commits ahead of origin/staging, deliberately UNPUSHED** — staging holds the
  kelp P3 + reef P4 promotion awaiting founder eyes. Do NOT push this branch to staging until that
  promotion clears. (The wager-sweep fix also rides this branch.)
- **Rung 1 verdict:** WebGPU lane **PASS** (n=12, all five metrics; reveal ub 0.016 < 0.140 limit).
  WebGL2 lane **FAIL by protocol** three times (first-batch bimodality → later shown to be RAM
  pressure; retest 4/5 with stable-window open; binding confirmatory batch exit 3 on evidence
  composition — 3 pairs `validForPerformance:false` from a late `_emotes2.glb?v=1` warm fetch, 7AB/3BA
  counterbalance fail). **No metric bound in ANY batch ever closed AGAINST the canary.** Recorded
  honestly; not re-run (predeclaration was binding). Evidence: `docs/perf-data/cold-load-rung1-2026-08-01/`
  incl. `evidence-ledger.json` (SHA-256 of all 49 pairs + build-identity attestation).
- **Key mechanism finding (audit finding 2):** the decorative release fires 0.4–3s (quiet) to
  4–17.7s (loaded machine) BEFORE paint-reveal. Rung 1 proved the RELEASE-SEAM mechanism, NOT a
  pre-reveal byte cut — `preRevealMB` unchanged. This does not block rung 2 (asset diets are byte
  cuts regardless of lane), but rung-3a widening for true post-reveal streaming needs release
  re-anchoring to actual first paint (founder call pending).
- **Local rig:** candidate web server on **:3010** (bundle `5d176d01`) + API on **:4001** were still
  running as of this writing. Baseline worktree (`cv-canary-baseline`) and :3011 are GONE. A fresh
  session should check `curl -s -o /dev/null -w "%{http_code}" http://localhost:3010/game` and
  restart via `bun run build && bun run start` in the worktree if needed (NEVER `bun run dev`).
- **Founder's word:** "then I'll compact and we can move on to rung 2." Rung 2 is authorized;
  same round rules apply (Codex gpt-5.6-sol at `model_reasoning_effort=xhigh` as adversarial
  teammate at every stage — plan critique → implementation → diff review).

## 1. What rung 2 IS

Per plan §4 step 2: **B/C diets on the largest FUTURE-POST-REVEAL assets FIRST** — bound their
post-reveal streaming cost before workstream A widens in rung 3. Two sub-workstreams:

- **B — geometry diets (census-first):** ansem + adinero VRMs, then chibi VRMs, shisha-oasis, and
  a >200KB-no-meshopt sweep.
- **C — texture diets (per-semantic ladder):** lobster_plush, spongebob, pearl, dutchman,
  pavilion's UASTC 512s, tekk normal map.

Rung 2 does **NOT** need the paired A/B statistical gate — plan §2: asset diets gate on
**per-asset screenshot A/B + probe ratchets** (byte deltas are deterministic; the statistical
machinery was for the timing-behavior canary). The WebGL2 lane verdict does not block this rung.

## 2. Current asset facts (re-measured 2026-08-06, disk bytes in `apps/web/public/`)

| Asset | Bytes on disk | Diet path |
|---|---|---|
| `avatars/ansem.vrm` | 2,905,444 | B: geometry census → RD ladder |
| `avatars/adinero.vrm` | 2,962,048 | B: geometry census → RD ladder |
| `avatars/biggie.vrm` | 3,163,024 | B: same class (added since plan was written — include in census) |
| `avatars/clytemnestra.vrm` / `cronus` / `helen` / `phanes` | 3.2–3.3MB each | B: same class — census-sweep candidates |
| `avatars/eliza-chibi.vrm` | 1,578,104 | B: VRM-safe meshopt (plan est. ~1.06→0.45 is stale — re-census) |
| `avatars/milady-chibi.vrm` | 1,667,288 | B: VRM-safe meshopt |
| `models/lobster_plush-ktx.glb` | 1,467,724 | C: normal-map drop / 256 UASTC |
| `models/characters/spongebob-ktx.glb` | 2,103,212 | C: normal-map drop / 512 UASTC |
| `models/characters/flying-dutchman-ktx.glb` | 1,055,524 | C (0.62MB normal inside per plan §3.C) |

NOTE: plan §3.B's per-asset numbers were from the 2026-07-31 census; several assets have since
been re-exported (chibi VRMs are ~1.6MB now, not ~1.06MB). **Step 1 below re-censuses everything —
never diet against stale numbers** (CLAUDE.md no-guessing rule).

## 3. Execution order

### Step 1 — Census (read-only, ~30 min)

1. Byte + accessor census of every asset in the table above plus `avatars/animations/ansem/`,
   `models/ansem-mesh/`, `models/ansem-sword-mesh/`, `models/ansem-turnaround/` (new uncommitted
   dirs in the MAIN repo `clawville/` — check whether they supersede the deployed ansem assets
   before dieting the old ones).
2. For ansem/adinero (plan §3.B item 1): accessor/meshopt byte census, exact-tuple weld dry-run,
   UV/hard-normal seam audit, quantization check, vertex-cache/overdraw analysis. Tooling:
   `gltf-transform inspect`, `scripts/decimate-vrm.ts` (exists, has a 38k–42k validation band to
   parameterize), `scripts/assets-optimize.ts` (the VRM-safe capture/reinject meshopt pipeline —
   stock glTF transforms strip `VRMC_vrm`; NEVER raw gltfpack on a VRM).
3. Produce a census doc (`docs/perf-cold-load-rung2-census-<date>.md`) with per-asset rows:
   current bytes, geometry/texture split, per-semantic texture inventory (which maps are UASTC vs
   ETC1S, resolutions), and the projected diet + projected bytes. **This is the M2-freeze input**
   (plan §2: M2 is frozen from MEASURED diet rows at the END of rung 2).
4. **Codex xhigh critique of the census + proposed ladder BEFORE any asset is mutated.**

### Step 2 — B: ansem/adinero RD ladder

- Sibling prototypes at 90k/60k/45k/38k tris → pick the visual knee.
- Judge on: idle/walk/run animation, shoulder/hand/face deformation, sword attachment (ansem),
  silhouette, promo closeups + grazing-light (ansem is the influencer showpiece).
- Acceptance per prototype: grounding/bounds unchanged; **all `VRMC_*` extensions preserved
  byte-for-byte in the JSON chunk**; real runtime load in the world (not just a parse).
- If no knee is acceptable: welding + attribute-precision wins alone still land ~30–40%.
- Meshy-first rule applies only to NEW assets; decimation of existing assets is pipeline work.

### Step 3 — C: texture ladder (per asset, in order)

For each heavy non-color map:
1. Try **dropping the normal map** at gameplay distance — test under grazing/MOVING light, not one
   static screenshot (stylized cartoon assets usually survive this).
2. Else **downsize to 512 (256 for lobster_plush) UASTC+zstd**.
3. **ETC1S for a normal map only after** an asset-specific orbit/grazing-light A/B passes.
4. ETC1S freely for masks/AO/roughness where not already.
- Pavilion atlasing: ONLY if grouping by material/colorspace/wrap/UV shows an actual win.
- Color maps untouched unless visibly oversized for footprint.

### Step 4 — Verification per asset (before commit)

1. **Screenshot A/B** old vs new at gameplay distance (+ closeup/grazing for promo assets), via
   agent-browser on the local :3010 stack. Founder eyes for anything borderline (E4: no "done"
   without sign-off on visual work).
2. **Runtime load check** in the world — asset mounts, animates, no console errors. For VRMs also
   confirm `computeVRMAvatarFit` grounding unchanged.
3. **Probe ratchet:** one strict probe run (`apps/web/scripts/cold-load-probe.mjs`) confirming the
   asset's wire bytes dropped by the census-projected amount and nothing else regressed. Parse the
   report and require **`validForPerformance:true`** (RIG DEFECT from rung 1: probe exit code only
   reflects the weaker `summary.valid` — never gate on exit code).
4. **Cache-bust:** every mutated asset ships under a **sibling filename** (preferred) or `?v=N`
   bump in EVERY reference — CF 7-day edge cache, no purge scope. Update the SW
   `ASSET_PATH_PREFIXES`/precache references in the same diff where applicable.
5. **Codex xhigh diff review** per batch of asset commits.

### Step 5 — M2 freeze + docs

- Sum the MEASURED diet rows → freeze M2 (plan §2: if rows don't close ≤11MB reveal / ≤22MB total,
  the targets MOVE to what the rows sum to — no un-named savings assumed).
- Same-diff doc updates: plan doc gets a "Rung-2 results" section; `3dStructure.md` for any
  visual/asset-pipeline change; memory topic `project_cold_load_diet_round.md` checkpoint.

## 4. Hard constraints (carried from rung 1 / round rules)

- **NEVER `bun run dev`** (Iris Xe WebGPU crash). Local testing = `bun run build && bun run start`.
- **Don't push to staging** until the kelp+reef promotion clears founder eyes.
- **Measurement tooling is FROZEN** — probe/gate/assert scripts don't change mid-measurement;
  tooling findings are advisory punch-list items.
- **No stale numbers:** every diet decision cites the fresh census, not the plan doc's July rows.
- **Codex xhigh at every stage** (founder override for this round; supersedes /copus-max default).
- **VRM safety:** only the capture/reinject pipeline in `scripts/assets-optimize.ts` touches VRMs.
- **Ops gotchas if any probe batches are needed:** Bash background tasks die at 10 min (detach via
  `Start-Process cmd`); TaskStop does NOT reap spawned bash trees (`taskkill /F /T /PID` + verify a
  single "batch start" log line); no manual agent-browser sessions during a batch; boot-hang flake
  ~15–25% clears on retry (fresh daemon + sleep 4 + 3s settle + 3 attempts/arm).
- **Deferred to rung 3 — do not touch here:** release re-anchoring to first paint, widening the
  `deferUntilDecorativeRelease` set, the WebGL2 fixed-rig question, the rig punch list
  (validForPerformance gating in collection scripts, machine mount stamp, evaluator
  counterbalance-chronology checks).

## 5. First command of the fresh session

```bash
cd /c/Users/itachi/Documents/Crypto/cv-covefreeze && git log --oneline -3 && \
curl -s -o /dev/null -w "web:%{http_code} " http://localhost:3010/game && \
curl -s -o /dev/null -w "api:%{http_code}\n" http://localhost:4001/health
```

Expect HEAD `e05183e0`, web:200, api:200. If servers are down, rebuild+start before Step 1's
runtime checks (census itself needs no server).
