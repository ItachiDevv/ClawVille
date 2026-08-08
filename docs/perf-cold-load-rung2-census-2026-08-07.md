# Cold-Load Diet — RUNG 2 CENSUS (2026-08-07)

Step-1 deliverable per `docs/perf-cold-load-rung2-handoff.md` §3. This is the **M2-freeze input**
(plan §2: M2 is frozen from MEASURED diet rows at the END of rung 2). No asset has been mutated.

**REV 2 (same day):** folds the Codex xhigh critique (VERDICT: REVISE, scratchpad
`codex-census-critique.out`). Key corrections: sandy-treedome REMOVED from scope (not served —
verified `ProceduralSandyTreedome` renders instead of the GLB, `arena-buildings.tsx:284-289` +
`:1592`); all dry-run rows relabeled **MODELLED** (non-shipping transform — see Dry-run caveats);
four BLOCKING pipeline gates added before any mutation (§Gates).

## Method

- Tool: `scripts/census-rung2.mjs` (NEW, read-only) — raw GLB chunk parse, **no decoders, no
  gltf-transform Document round-trip**, so every byte number is a TRUE WIRE BYTE:
  meshopt-compressed bufferViews are counted at `EXT_meshopt_compression.byteLength` (compressed),
  draco geometry at the draco bufferView size, KTX2 images at embedded size with codec read from
  the KTX2 header (`supercompressionScheme`) + DFD `colorModel` (163=ETC1S, 166=UASTC).
- Serving status from a repo-wide grep of `/models|/avatars` string literals in
  `apps/web/src` + `packages/shared/src` (118 unique refs). CAVEAT: template-built paths would be
  missed; per-asset probe runs in Step 4 are the final serving truth.
- Raw JSON blobs: scratchpad `census-vrms.json`, `census-glbs.json`, `census-sweep.json`.
- Dry-run estimators (read-only, in-memory, write NOTHING to `public/`):
  `scripts/weld-dryrun-rung2.mjs` (exact-tuple weld headroom) and
  `scripts/diet-dryrun-rung2.mjs` (weld+meshopt and simplify-ladder byte measurement using the
  simplify params from `decimate-vrm.ts:466`).
- **Dry-run caveats (Codex critique #2 — every "MODELLED" row inherits these):** the dry-run uses
  `meshopt(level:'high')` while BOTH shipping pipelines use `level:'medium'`
  (`assets-optimize.ts:319`, `decimate-vrm.ts:491`); it omits the shipping dedup/prune/texture
  sequence and VRMC reinjection; and on VRMs the generic `meshopt()` internal quantize PRUNED THE
  LIVE SKIN (chibis have exactly 1 skin, node-referenced — verified). So MODELLED rows are
  direction-and-magnitude estimates, NOT report-only shipping measurements. **M2 credit requires
  an exact-final-chain run onto a temporary sibling per asset.**
- **Census-tool precision caveats (critique #6/#7):** per-semantic byte splits are PROPORTIONAL
  APPORTIONMENTS of shared bufferViews, not independently measurable wire bytes; sparse accessors
  are ignored; tri counts assume mode 4; a shared image bufferView could double-count; the
  texture-slot map records one source per texture (basisu ?? webp ?? source) and does not
  inventory clearcoat/sheen/anisotropy slots. None of these bite on the named rung-2 assets
  (spot-checked independently by Codex — finding #15 confirms ansem + lobster_plush byte-exact).
- Disk bytes re-verified 2026-08-07 — identical to the handoff §2 table (no drift).

## Gates — BLOCKING before any asset mutation (from the Codex critique)

1. **VRM skin-safety gate (critique #1).** `meshopt()`'s internal quantize runs its own
   Skin/Accessor/Material prune (`@gltf-transform/functions` quantize.ts:182) — `assets-optimize.ts`
   skipping its explicit `prune()` does NOT protect against it, and `decimate-vrm.ts` uses the
   same wrapper. The dry-run demonstrably deleted the chibis' ONLY live skin. Before any VRM
   ships: make the meshopt cleanup safe/disabled for VRMs, hard-fail if the VRM JSON capture is
   empty, and validate post-pipeline equality of: complete `skins` array, joint-node map,
   inverse-bind accessors, and raw `VRMC_*` JSON. (The 7 live showpieces went through this
   pipeline and work — but that must be re-proven by the validator, not assumed.)
2. **Exact-chain report-only siblings (critique #2).** Every M2 row is credited ONLY from the
   exact shipping chain writing a temporary sibling, never from the dry-run estimator.
3. **Decimator parameterization + per-asset knees (critique #3).** `decimate-vrm.ts` hardcodes a
   38k–42k validation band and `error:0.01` with no CLI knobs; gltf-transform `simplify()` is
   POSITION-ONLY (attributes carried, not considered) — raised-error rungs can seam shoulders/
   hands invisibly to any byte metric. Parameterize band+error; judge a separate visual knee per
   showpiece; NEVER propagate ansem's recipe blindly.
4. **Texture-only KTX2 sibling tool (critique #8).** No existing script can drop/resize a normal
   slot inside an already-KTX2 GLB (`compress-ktx2.ts` rebuilds from PNG/WebP sources;
   `assets-optimize.ts` skips KTX2 images). C work needs a new semantic texture-only pipeline
   that preserves geometry/animation/skins/material params and the byte-identity of every KTX
   image outside the targeted slot.
5. **Runtime-structure equality for world GLBs (critiques #10/#11; amended by the tooling
   review).** Cove: assert primitive/material counts, node names/transforms, KTX image hashes,
   and cove hotspot/click-zone behavior — not just file size. Buildings: meshopt quantization can
   leave mixed UV typed arrays that silently break the runtime `mergeGeometries()` draw-call
   merge (documented in `compress-glb-targeted.ts:112`; merger live at `arena-buildings.tsx:1079`)
   — assert pre/post runtime merge counts per building. **Amendment (tooling review): gate-5
   visual verification must include FIXED-POSE/DEFORMATION comparison (for skinned assets) and
   MATERIAL appearance comparison — "it loads without errors" is NOT acceptance; screenshots A/B
   must cover an animated pose and a lit material view.**

## B — Geometry diets (VRMs + no-meshopt sweep)

### B1. The seven Meshy showpiece VRMs — one shared pathology

All seven are VRM1, single primitive, already meshopt, **~96–99% geometry by wire weight**
(each carries just ONE 1024² WebP baseColor/emissive texture, 25–122KB). The B diet for this
class is pure geometry; textures are a rounding error.

| Asset | Wire | Verts | Tris | Verts:Tris | GEO wire | TEX wire |
|---|---|---|---|---|---|---|
| ansem.vrm | 2.77MB | 193,946 | 118,167 | 1.64 | 2.72MB | 25KB |
| adinero.vrm | 2.83MB | 201,659 | 119,082 | 1.69 | 2.73MB | 67KB |
| biggie.vrm | 3.02MB | 203,275 | 118,759 | 1.71 | 2.90MB | 96KB |
| clytemnestra.vrm | 3.05MB | 212,423 | 118,332 | 1.80 | 2.92MB | 107KB |
| cronus.vrm | 3.18MB | 217,497 | 117,674 | 1.85 | 3.04MB | 117KB |
| helen.vrm | 3.03MB | 211,445 | 117,854 | 1.79 | 2.88MB | 118KB |
| phanes.vrm | 3.06MB | 214,332 | 117,734 | 1.82 | 2.92MB | 122KB |

**Vertex-split reality (MEASURED, 2026-08-07):** verts ≈ 1.6–1.85× tris. An exact-tuple weld
dry-run (`scripts/weld-dryrun-rung2.mjs`, in-memory, gltf-transform `weld()`) recovers almost
NOTHING: ansem −0.2% verts, adinero −0.1%. **The splits are real UV-island/hard-normal seams,
not duplicate tuples — weld is a dead end on this class.** Per-semantic wire (ansem): NORMAL
889KB + POSITION 825KB + UV 529KB + WEIGHTS 304KB + JOINTS 121KB; indices only 117KB.

**Quantization check (MEASURED):** ansem already carries `KHR_mesh_quantization` — POSITION/
NORMAL int16-normalized, UV uint16, JOINTS/WEIGHTS uint8 — plus meshopt. **The "attribute
precision" fallback win is already taken on this class.** Decimation is the ONLY remaining lever.

**RD-ladder byte dry-run (MODELLED, in-memory `simplify()` with the simplify params from
`decimate-vrm.ts:466` — error 0.01, lockBorder true — then meshopt high):**

| Requested tris | ansem realised | ansem bytes | adinero realised | adinero bytes |
|---|---|---|---|---|
| 90k | 89,999 | 1.907MB (−31.2%) | 90,712 | 1.926MB (−31.8%) |
| 60k / 45k / 38k | **89,499 (FLOOR)** | 1.901MB | **90,708 (FLOOR)** | 1.926MB |

**The error bound bites at ~76% ratio and FLOORS the simplifier at ~90k tris** — the 60k/45k/38k
rungs are unreachable at error 0.01 (and barely move at 0.001 → the floor is structural, likely
Meshy shell-soup component borders). Reaching deeper rungs requires raising `error` beyond 0.01
(a visual-risk decision that belongs to Step 2's screenshot judging), or component-aware
preprocessing. **Realistic MODELLED save at the reachable rung: ≈0.87MB/asset → ≈ 6.1MB across
the seven** (not the 12–15MB the pre-measurement projection hoped for). Step-2 will probe
raised-error rungs (e.g. 0.02/0.05) as prototypes; any deeper claim must come from those
prototypes' measured bytes + founder-eyed visuals.

**Ship path:** `scripts/decimate-vrm.ts` sibling prototypes (VRMC capture/reinject, 38k–42k
validation band needs parameterizing to the ~90k floor), judged on idle/walk/run,
shoulder/hand/face deformation, sword attach (ansem), promo closeups + grazing light. NEVER raw
gltfpack. NOTE: the dry-run's byte figures used the generic gltf-transform `meshopt()` transform,
whose internal prune removed a Skin on chibi-class files — the shipping pipeline (no prune for
VRMs) will land slightly ABOVE these estimates; treat them as floors ±5%.

### B2. Chibi VRMs — no meshopt at all

| Asset | Wire | Verts | Tris | GEO wire | Notes |
|---|---|---|---|---|---|
| eliza-chibi.vrm | 1.50MB | 24,256 | 39,998 | 1.43MB | **meshopt=false**; WEIGHTS 379KB > POSITION 284KB |
| milady-chibi.vrm | 1.59MB | 25,696 | 40,000 | 1.50MB | **meshopt=false**; WEIGHTS 401KB |

**MODELLED dry-run (weld+meshopt-high, in-memory): eliza-chibi 1.505 → 0.362MB (−76.0%),
milady-chibi 1.590 → 0.380MB (−76.1%).** Quantization check: chibis are RAW float32 on every
attribute (WEIGHTS float32 VEC4 = 16B/vert) with no meshopt — hence the huge mechanical win.
**BLOCKING caution (critique #1, verified):** the dry-run's `meshopt()` internal quantize DELETED
the chibis' ONLY live skin (1 skin, node-referenced) — and `assets-optimize.ts` calls the SAME
wrapper, so "the shipping chain is safe" is an assumption the skin-safety gate (§Gates 1) must
prove, not a fact. Numbers are optimistic (a retained skin + IBM adds bytes back): call it
**~0.45MB each (approximate), MODELLED save ≈ 2.1MB combined as a planning estimate**, credited
only after the exact-chain sibling run.

Handoff's stale-number warning confirmed: these are ~1.5–1.6MB now (plan's ~1.06MB row is dead).
Geometry is already sane (24–26k verts on 40k tris — welded); the weight is UNCOMPRESSED
attributes, with WEIGHTS/JOINTS oddly heavy (float32, possibly 2 influence sets). Diet =
**VRM-safe meshopt (+ weight quantization within the pipeline)**, no decimation needed.

### B3. tekk.vrm — geometry fine, texture heavy (crosses into C)

1.24MB wire: GEO 0.70MB (43k verts / 40k tris, meshopt) + **TEX 0.53MB**, of which the
**327KB 1024² WebP normal map** is the plan §3.C target. Diet = C-ladder on the normal map
(drop test under moving grazing light → else 512). Baseline color 204KB stays.
**Projection: save ≈ 0.33MB.**

### B4. >200KB no-meshopt sweep — SERVED assets only

Intersection of the sweep with the 118 runtime refs (dead siblings excluded, see §Punch-list):

| Asset | Wire | meshopt | Geometry facts | Projected diet |
|---|---|---|---|---|
| `models/cove/cove-interior-cleaned-v1-ktx.glb` | **17.96MB** | NO | **GEO 16.96MB RAW float32** — 495k verts / 197k tris, 12 prims; TEX only 0.99MB; exact weld recovers just 5.3% verts | weld + meshopt, **MODELLED dry-run: → 5.667MB (−68.4%, save 12.29MB)** — KTX2 pass-through + 12-prim split confirmed safe by critique #10, but ship gate demands equality of prim/material counts, node names/transforms, KTX hashes, AND cove hotspot/click-zone behavior (§Gates 5); on-demand cove-entry lane |
| ~~`models/sandy-treedome-v3-opt1.glb`~~ | 3.52MB | — | **REMOVED FROM RUNG 2 (critique #5, verified):** production renders `ProceduralSandyTreedome` and never loads the GLB (`arena-buildings.tsx:284-289` comment + `:1592` branch) — the config row is vestigial. No wire or GPU cost exists. (Dry-run had also shown the mechanical path grows it 3.52→8.13MB.) File moves to the dead-disk punch list |
| `models/shisha-oasis-ktx.glb` | 1.58MB | NO | GEO 1.40MB — 27k verts / 26.5k tris; UV 485KB ≥ POSITION 320KB (TEXCOORD_1 present; UVs out of [0,1] so quantize skips them) | weld + meshopt, **MODELLED dry-run: → 0.449MB (−71.6%, save 1.13MB)** |
| `models/pineapple-house-opt1-ktx.glb` | 1.17MB | NO | GEO 0.45MB (11.5k verts); TEX 0.71MB | weld+meshopt **MODELLED → 0.842MB (save 0.33MB)** + normal-map ladder on top |
| `models/octopus_toy-ktx.glb` | 0.79MB | NO | GEO 0.57MB incl TANGENT 164KB | weld+meshopt **MODELLED → 0.349MB (save 0.44MB, −56%)** |
| `models/jellyfish-ktx.glb` | 0.63MB | NO | GEO 0.48MB | weld+meshopt **MODELLED → 0.288MB (save 0.34MB, −55%)** |
| `models/sea_horse-ktx.glb` | 0.62MB | NO | GEO 0.35MB; UV 78KB > POSITION 59KB | weld+meshopt **MODELLED → 0.348MB (save 0.27MB, −44%)** |
| `models/sea-creatures/lobster/{base,animations/{idle,swim,hit}}-ktx.glb` | 1.76MB (4 files) | NO | **each file re-ships the SAME mesh (3.2k verts) + SAME 261KB textures**; only `otherBin` (the clip) differs | dedupe **VERIFIED SAFE**: `sea-creature-animator.ts:206` consumes ONLY `gltf.animations[0]` from each clip GLB (clips bind by node name to the base's skeleton; the file header even documents "animations/<state>.glb — one clip each") — the re-shipped mesh+textures are dead wire weight (critique #12 independently confirmed all four files byte-identical on mesh/images/IBM/11 node names/9-joint skeleton). Strip condition: a CUSTOM stripper retaining nodes, skeleton names, animation channels + samplers — generic `prune()` is UNSAFE here; runtime-test idle/swim/hit siblings. **save ≈ 1.2MB**; clip URLs carry `?v=2` today → bump to `?v=3`. Base weld+meshopt **MODELLED → 0.303MB (save 0.13MB)** |
| `models/krusty-krab-v2-opt1-ktx.glb` | 0.89MB | NO | — | weld+meshopt **MODELLED → 0.655MB (save 0.23MB)** |
| `models/chum-bucket-v2-opt1-ktx.glb` | 0.87MB | NO | — | weld+meshopt **MODELLED → 0.743MB (save 0.12MB)** |
| `models/arcade/claw-arcade-exterior-opt1-ktx.glb` | 0.80MB | NO | — | weld+meshopt **MODELLED → 0.722MB (save 0.07MB, −9%)** — marginal, texture-dominated |
| `models/patty-building-opt1-ktx.glb` | 0.71MB | NO | — | weld+meshopt **MODELLED → 0.466MB (save 0.24MB, −34%)** |
| `models/patricks-rock-v2-opt1-ktx.glb` | 0.66MB | NO | — | weld+meshopt **MODELLED → 0.563MB (save 0.10MB)** |
| `models/squidward-house-opt1-ktx.glb` | 0.61MB | NO | — | weld+meshopt **MODELLED → 0.537MB (save 0.07MB, −12%)** — marginal |
| `models/land-structures/fantasy-cottage/home.glb` | 0.39MB | NO | — | weld+meshopt **MODELLED → 0.087MB (save 0.31MB, −78%)** |
| `models/land-structures/driftwood-cabin/{home,shop}.glb` | 0.59MB (2) | NO | — | weld+meshopt **MODELLED → 0.212MB (save 0.38MB, −60/−67%)** |

**Batch total MODELLED (all 14 above): save 3.05MB; 2.91MB after skipping the marginals.**
Critique #11 ruling: the batch is NOT "low-risk mechanical" — meshopt quantization can leave
mixed UV typed arrays that silently break the runtime `mergeGeometries()` draw-call merge
(`compress-glb-targeted.ts:112` documents the failure; merger live at `arena-buildings.tsx:1079`)
— §Gates 5 requires pre/post runtime merge counts per building. **SKIP claw-arcade (−9%) and
squidward-house (−12%)**: below verification+cache-bust cost unless a measured runtime benefit
emerges.

## C — Texture diets (per-semantic ladder)

**The single dominant pattern: UASTC+zstd 1024² normal maps on stylized cartoon characters.**

**Critique #9 (verified by independent material inspection): none of the four normal maps is
metadata-dead** — all materials are lit PBR with normalScale 1 and tangent data present. Drop
tests are legitimate EXPERIMENTS, not deterministic savings. Two assets bias to the DOWNSIZE
fallback: **flying-dutchman** is alpha-blended with `KHR_materials_transmission` ≈0.433 (its
normal feeds the ghost's refraction look) and **pearl** is only ~4k tris (normals likely carry
most of her surface detail). All C work is BLOCKED on §Gates 4 (the texture-only KTX2 sibling
tool does not exist yet — `compress-ktx2.ts` can only rebuild from PNG/WebP sources and cannot
resize an existing UASTC map).

| Asset | Wire | TEX wire | Heavy maps (all 1024² UASTC+zstd unless noted) | Ladder + projection |
|---|---|---|---|---|
| `lobster_plush-ktx.glb` | 1.40MB | 1.38MB (99%) | normal **1,213KB** (87% of the whole file); MR 122KB + baseColor 80KB ETC1S | drop-normal test (plush toy, prime candidate) → else 256 UASTC per handoff → **save 1.1–1.2MB** |
| `characters/spongebob-ktx.glb` | 2.01MB | 1.75MB | normals **891KB + 519KB** (two prims); MR/AO + baseColor + emissive already ETC1S | drop/512-UASTC per map → **save 1.1–1.4MB** |
| `characters/pearl-ktx.glb` | 1.24MB | 1.10MB | normals **821KB + 136KB**; rest ETC1S, GEO only 44KB | drop/512 → **save 0.8–0.95MB** |
| `characters/flying-dutchman-ktx.glb` | 1.01MB | 0.86MB | normal **635KB**; baseColor 175KB + MR/AO 66KB ETC1S | drop/512 → **save 0.5–0.63MB** |
| `quest-bounty-pavilion-ktx.glb` | **3.99MB** | 3.36MB across **72 images** (all 512² or smaller — handoff's "UASTC 512s" confirmed) | 26 normal maps UASTC+zstd ≈ **1.30MB**; ~17 MR ≈ 0.79MB + ~17 AO ≈ 0.42MB + baseColor ≈ 0.80MB already ETC1S; 3 UNREFERENCED images (2.8KB, prune) | normals → ETC1S after orbit A/B (or drop per-material at gameplay distance) → **save 0.65–1.0MB**; MR+AO channel-pack only if the material/colorspace/wrap grouping shows a real win (plan rule) |
| `avatars/tekk.vrm` | 1.24MB | 0.53MB | normal **327KB** WebP (not KTX2) | drop test → **save ≈ 0.33MB** (counted once, in B3) |

Not needing C work: the seven showpiece VRMs (textures 25–122KB), chibis (64–78KB), shisha
(180KB all ETC1S), jellyfish/sea_horse/octopus (small or already ETC1S-dominant).

## Ansem supersedence check (handoff §3 Step 1 item 1 — CLOSED)

The new dirs (`models/ansem-mesh/`, `models/ansem-sword-mesh/`, `models/ansem-turnaround/` in the
main repo — also committed on origin/staging — and `avatars/animations/ansem/`) do **NOT**
supersede the deployed avatar. They are Meshy pipeline INTERMEDIATES (17–26MB rigged/anim dumps);
the canonical served assets remain `avatars/ansem.vrm` (2.77MB, the B1 diet target),
`avatars/ansem-sword.glb` (0.43MB, meshopt, referenced by `character-attachments.ts:38`), and
`avatars/animations/ansem/idle.glb` (36KB). **Decimation compatibility constraints:** the sword
attaches via the model-intrinsic attachment system (bone/node anchor — `character-attachments.ts`),
and external clips retarget onto the humanoid bone map — so the B1 prototypes must preserve the
node/skeleton graph and `VRMC_vrm.humanoid` byte-for-byte (which `simplify()` does: it never
touches nodes/skins), and the sword anchor + idle clip are part of the per-asset visual judging.

## Load-lane note

Rung 2 diets are byte cuts regardless of lane (handoff §1). For prioritization only: the cove
interior is on-demand (cove entry); characters/VRMs/decor stream in-world post-reveal; nothing
here is believed pre-reveal-critical. Step-4 probe ratchets will attach the actual lane per asset.

## M2 projection (sum of the rows above — MODELLED, pre-shipping-measurement)

| Bucket | Save | Basis |
|---|---|---|
| B1 seven showpiece VRMs | **6.1MB** at the reachable ~90k rung (more only if raised-error per-asset knees pass founder eyes) | MODELLED dry-run |
| B2 chibis | **≈2.1MB** (planning estimate) | MODELLED dry-run (−76% but skin was lost; exact chain sets the real row) |
| B3/C tekk normal | 0.33MB | census bytes, drop-test pending |
| B4 cove interior | **12.29MB** | MODELLED dry-run (−68.4%) |
| B4 shisha | **1.13MB** | MODELLED dry-run (−71.6%) |
| B4 small set + buildings + land structures + lobster base (12 assets, marginals skipped) | **2.91MB** | MODELLED dry-run batch |
| B4 lobster sea-creature dedupe | 1.2MB | census + loader wiring VERIFIED (clip GLBs consumed as animations[0] only) |
| C character normals (plush/spongebob/pearl/dutchman) | 3.50–4.18MB | census bytes; dutchman+pearl bias to downsize (critique #9) |
| C pavilion | 0.65–1.0MB | census bytes, per-map A/B pending |
| **Total** | **≈ 30.2–31.2MB** of served asset weight (fixed subtotal 23.96MB + B2 ≈2.10 + C characters 3.50–4.18 + pavilion 0.65–1.00; arithmetic per Codex re-verdict #2) — ALL MODELLED or census-derived, NONE yet shipping-measured |  |

M2 itself freezes ONLY from exact-shipping-chain rows (temporary siblings through the real
pipeline, §Gates 2) at the end of the rung — the table above only picks execution order (plan §2).

## Execution order (REV 2 — tooling gates first)

0. **Tooling gates (§Gates 1–4):** build the texture-only KTX2 sibling tool (gate 4) + harden the
   VRM pipeline with the skin/VRMC equality validator (gate 1) + parameterize `decimate-vrm.ts`
   (gate 3). Codex xhigh reviews the tooling diffs before first asset use.
1. **C characters** (lobster_plush → spongebob → pearl → dutchman): biggest win-per-effort, no
   rig risk. Drop-vs-downsize decided per asset by moving/grazing-light A/B; dutchman + pearl
   bias to downsize. Then tekk normal, pavilion.
2. **B2 chibis + B4 shisha/small set** through the HARDENED pipeline with exact-chain siblings.
3. **B1 ansem/adinero RD ladder** — sibling prototypes, per-asset visual knees, founder eyes;
   the other five showpieces each get their OWN knee (no blind recipe propagation).
4. **B4 cove interior weld+meshopt** (12.29MB modelled, on-demand lane) with the §Gates 5
   structure-equality + hotspot checks.
5. **B4 lobster dedupe** via custom stripper (nodes/skeleton/channels/samplers retained).
6. **B4 building batch** meshopt with pre/post runtime merge-count checks; claw-arcade +
   squidward-house SKIPPED as below-cost.

Each asset ships under a **sibling filename** (CF 7-day edge cache, no purge scope) with all refs
+ SW `ASSET_PATH_PREFIXES` updated same-diff, screenshot A/B + runtime load + probe ratchet
(`validForPerformance:true`, never exit code) before commit, Codex xhigh diff review per batch.

## Rung-2 results ledger (updated as rows land — M2 freezes from THESE rows)

**C-ladder normal-map drops — SHIPPED on the branch, FOUNDER SIGN-OFF 2026-08-08 ("Yes, those all
look good", after reviewing the A/B gallery incl. the lobster closeup weave loss; full drop chosen
over the 256 downsize):**

| Asset | Before | After | MEASURED save | Verification |
|---|---|---|---|---|
| lobster_plush → `-nonorm` | 1.400MB | 0.215MB | **1.185MB** | tool V1–V5 PASS; runtime fetch + Larry mounts (`730aeb1d`) |
| spongebob → `-nonorm` | 2.006MB | 0.629MB | **1.377MB** | 〃 + cold-wire trace (`0556d8f5`) |
| pearl → `-nonorm` | 1.242MB | 0.308MB | **0.935MB** | 〃 |
| flying-dutchman → `-nonorm` | 1.007MB | 0.387MB | **0.620MB** | 〃 |
| tekk → `tekk-nonorm.vrm` | 1.242MB | 0.922MB | **0.320MB** | 〃 + `vrm-pipeline-validate --expect-texture-diet` PASS (binding-exact S9/S9.VRM0) |
| **Batch total** | 6.90MB | 2.46MB | **4.44MB file-level (~4.3MB wire)** | all five fetched as siblings; zero old URLs on fresh cold loads |

Codex asset-batch diff review: no blocking findings, no omitted ref sites; validator/harness
findings folded (`8ac4b0d7`). Old files retained on disk (rollout-safe; cleanup rides the
dead-disk punch list). Remaining C: pavilion per-map A/B (0.65–1.0MB) + tekk was the last VRM row.

### B1 position-remap decimator prototypes (E3 co-authored, 2026-08-08)

**Root cause re-verified:** exact float32 POSITION remapping reduces Ansem's 193,946 uploaded
vertices to 59,183 canonical positions and Adinero's 201,659 to 59,577. No epsilon grid was
needed or used. This confirms that bitwise-identical positions are sufficient to reconstruct the
topology hidden by the exported triangle-corner splits.

`scripts/decimate-vrm.ts` now has an opt-in `--weld-islands` path. It builds a dense canonical
POSITION/index stream, calls `MeshoptSimplifier.simplifyWithAttributes()` on that position-only
topology, maps the result back through one representative source vertex per canonical position,
and runs `compactPrimitive()`. Base attributes and morph-target attributes are copied from the
surviving source tuples in their original typed-array representation; there is no interpolation.
The existing VRMC capture/reinject, WebP handling, meshopt re-encode, atomic write, and validation
table remain in the chain. The flag defaults OFF.

**Seam mitigation:** every canonical position whose originals differ in any `TEXCOORD_n` by more
than `2/65535` is passed to meshoptimizer as a vertex lock, alongside `LockBorder`. That locks
11,135 Ansem positions and 9,610 Adinero positions. The representative is the original vertex most
frequently referenced by the source index buffer, minimizing tuple substitution at split corners.
Skin data is not ambiguous here: measured JOINTS/WEIGHTS disagreement inside position groups is
zero for both assets.

**Measured prototype ladder (exact final-chain bytes):**

| Prototype | Ratio | Error cap / measured | Tris | Verts | Bytes | Save vs source | External validator |
|---|---:|---:|---:|---:|---:|---:|---|
| `ansem-w65k.vrm` | 0.5500681 | 0.0005 / 0.0001463 | 64,999 | 32,599 | 626,380 | 78.44% | only S3.0 FAIL |
| `ansem-w45k.vrm` | 0.3808173 | 0.0005 / 0.0003341 | 44,999 | 22,599 | 463,572 | 84.04% | only S3.0 FAIL |
| `ansem-w30k.vrm` | 0.2538783 | 0.0010 / 0.0008095 | 29,999 | 15,099 | 334,156 | 88.50% | only S3.0 FAIL |
| `adinero-w65k.vrm` | 0.5458429 | 0.0005 / 0.0001330 | 65,000 | 32,536 | 660,904 | 77.69% | only S3.0 FAIL |
| `adinero-w45k.vrm` | 0.3778900 | 0.0005 / 0.0002514 | 44,998 | 22,535 | 497,928 | 83.19% | only S3.0 FAIL |
| `adinero-w30k.vrm` | 0.2519272 | 0.0010 / 0.0005591 | 29,998 | 15,035 | 371,572 | 87.46% | only S3.0 FAIL |

Source bytes are 2,905,444 (Ansem) and 2,962,048 (Adinero). Every rung is inside its requested
band (±5%). For all six, `vrm-pipeline-validate.mjs --expect-quantize` reports exactly the
decimation-inherent S3.0 POSITION-count failure; S1, S2.0, S4, S5, S6, S7+S8, and S9–S13 pass.
`vrm-pipeline-validate.test.mjs` remains **9/9 PASS**.

**Default-path regression guard:** plain runs without `--weld-islands` still floor at 89,497
Ansem tris and 90,706 Adinero tris. Their outputs are byte-identical to the pre-change floor
prototypes: Ansem SHA-256 `12987DAA6DB619FA01CB783D72A66B2428BF81292DB7837CF3C9A62FCC17B9D5`;
Adinero `4E505F3042A04BA637CB43517EEF72F8E9A1E22ECBCFA5603DA17273836EDEE0`.

**Residual visual risk / no ship decision:** a canonical position can still have multiple valid UV
or hard-normal tuples. Locking prevents that position from moving during collapse, but the final
one-representative mapping cannot preserve every per-island tuple. In particular, nearly every
duplicate-position group has differing normals, so grazing-light shading and minority UV-island
corners can still change even though every emitted tuple is source-exact. The 30k rung also needs a
0.001 error cap (0.0005 stops Ansem around 36.7k). These are prototypes only: animated
idle/walk/run, shoulder/hand/face deformation, Ansem sword attachment, close-up texture seams,
and grazing-light normals still require founder-eyed A/B before choosing any per-asset knee.

## Punch-list (found during census — NOT rung-2 wire scope)

1. **~505MB of Meshy pipeline intermediates are COMMITTED and on origin/staging**:
   `models/ansem-mesh/` 205MB + `models/biggie-mesh/` 282MB + `models/ansem-sword-mesh/` 18MB
   (26MB rigged GLBs, 17–19MB per animation dump). Never fetched at runtime (only
   `/avatars/ansem-sword.glb` 0.43MB is served from that work). Bloats clone/build/deploy
   image, not the wire. Needs a founder-approved removal commit on staging (history is already
   rewritten-once; these landed post-scrub 2026-07-2x).
2. **Dead disk siblings** in `public/` shipped in the deploy image but never fetched: plain
   non-ktx twins (`shisha-oasis.glb`, `pearl.glb`, `quest-bounty-pavilion.glb`,
   `cove-interior.glb`, `sandy-treedome-v3.glb` 4.17MB, `claw-arcade-exterior.glb` 4.04MB,
   `spongebob.glb`, `lobster_plush.glb`, `flying-dutchman.glb`, …opt1 intermediates, `.bak`
   files) **+ `sandy-treedome-v3-opt1.glb` 3.52MB (referenced in config but never loaded —
   `ProceduralSandyTreedome` renders instead; removal must also delete the vestigial config row
   at `arena-buildings.tsx:289`)**. ~28MB+. Same treatment as (1) — kept OUT of M2 (critique #16).
3. `quest-bounty-pavilion-ktx.glb` carries 3 UNREFERENCED embedded images (trivial bytes) — prune
   opportunistically when the pavilion is next re-encoded.
4. Serving-ref extraction is literal-string based; any template-built asset path is invisible to
   it. Step-4 probes are the ground truth per asset.

## M2 FREEZE (2026-08-08 — rung 2 CLOSED)

Final measured rows (all founder-approved; every row live-verified on the local prod bundle):

| Batch | Save | Evidence |
|---|---|---|
| C normal-map drops (5 assets incl. pavilion) | 5.57MB | tool V1–V5 + 3-way A/B + founder sign-off |
| B2 chibis + shisha (real chain) | 3.23MB | validator + A/B identical |
| Cove interior (on-demand lane) | 14.70MB | structure equality + live-cove render |
| Building batch + all land structures | 3.05MB | boot-verified after the -mo-ktx naming fix + showroom dynamic-resolver fix |
| Lobster clip dedupe | 1.30MB | behavioral equivalence + PropertyBinding + mixer drive |
| Showpiece rollout (7 avatars @30k/35k, --weld-islands v2) | 16.80MB | per-asset validator + UV-integrity gate + founder rung choice |
| **Total** | **≈44.7MB** of served asset weight |  |

**Cold-load wire (fresh-profile, /game, decorative release + settle): 34.62MB (round start) →
22.74MB (rung-2 close)** — at the plan's ≤22MB M2 target within noise; the cove's 14.7MB rides
the cove-entry lane on top. Deferred to later rungs: probe-rig repair (Chrome 151), the
~505MB committed pipeline intermediates (founder call), sea-creature texture consolidation,
--expect-decimate validator mode.
