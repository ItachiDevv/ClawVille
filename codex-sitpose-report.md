# Table-room sit-pose swap report

Date: 2026-07-18

Branch: `feat/cove-3d-holdem`

Starting HEAD: `08262d8d936e81b2f7a35644f10e9674474a437f`

## Result

All five seated figures in `/cove/table` now use Meshy's `Sit_on_Chair_Arms_Crossed` clip. The four Milady VRMs use the existing Meshy-to-VRM retarget path; Hermes uses the clip baked natively on her own Meshy rig. The standing dealer remains on `idle` and is not part of the seated-pose swap.

The source clip duration is `2.4333333969s`. I selected `0.20s` for the stable hands-in-lap hold and `1.20s` for the stable crossed-arms hold, both away from the loop transition.

| Engine seat | Figure | Runtime path | Clip | Sample | Held phase |
|---|---|---|---|---:|---|
| 1 | `milady_official_2` | `FrozenFigure` / Meshy→VRM | `sit_on_chair_arms_crossed` | 0.20s | hands in lap |
| 2 | `milady_official_5` | `FrozenFigure` / Meshy→VRM | `sit_on_chair_arms_crossed` | 1.20s | arms crossed |
| 3 | `hermes_female` | `FrozenGlbFigure` / native rig | `Armature\|Sit_on_Chair_Arms_Crossed\|baselayer` | 0.20s | hands in lap |
| 4 | `milady_official_7` | `FrozenFigure` / Meshy→VRM | `sit_on_chair_arms_crossed` | 1.20s | arms crossed |
| 5 | `milady_official_4` | `FrozenFigure` / Meshy→VRM | `sit_on_chair_arms_crossed` | 0.20s | hands in lap |

## Retarget and bundle work

1. Ran `scripts/strip-meshy-anim-mesh.mjs` on `clyt-armscrossed.glb`.
   - Raw: 13,508,392 bytes.
   - Stripped build input: 46,856 bytes.
   - Result: 25 nodes, 1 animation, 0 meshes, 0 skins.
2. Added the stripped input as `apps/web/animations-src/cove-sit/sit_on_chair_arms_crossed.glb`.
3. Extended `scripts/build-cove-sit-bundle.mjs` and rebuilt only `_cove_sit.glb`.
   - Bundle: 527,292 → 569,232 bytes.
   - Six clips validate; the new clip has 72 channels and duration 2.4333333969s.
4. Registered `sit_on_chair_arms_crossed` in `ANIM_PATHS` and `MESHY_ANIM_NAMES`, so it uses the existing `retargetMeshyClip` implementation with `hips-only` position output and the Meshy arm-chain quaternion policy.
5. Added route-local `preloadClips([TABLE_SIT_POSE])` warming.
6. Versioned the mutated asset URL as `_cove_sit.glb?v=2` for Cloudflare/service-worker cache busting.

No edits were made to `mixamo-retarget.ts`, `_emotes.glb`, `idle.glb`, `walk.glb`, `run.glb`, or any existing per-character roster clip. `_emotes.glb` remains SHA-256 `C0498446518D8625A08923F7BC3F44BE9B9CB220387218152338E2A575E07CAA`.

## Hermes native asset and bounded optimizer attempt

Copied the native bake to `apps/web/public/models/hermes-sit-arms-crossed.glb`, then made the single allowed targeted attempt with `scripts/assets-optimize.ts`.

- Before: 6,806,104 bytes.
- After: 1,398,892 bytes (`-79%`).
- Optimized SHA-256: `5975ADD8B4E499D51DBA315FF9F3194E6AF307964535F9A7744DF354510913DA`.
- Structural comparison passed: 26 nodes, 1 mesh, 1 skin, skinned node `char1`, `JOINTS_0`/`WEIGHTS_0` retained, 72 channels retained, duration unchanged at 2.4333333969s.

The optimized asset shipped. The existing `?hermesClip=f` and `?hermesSample=<seconds>` comparisons still work; `?hermesClip=<model path/name>` is also accepted.

## Grounding check

PASS. Both figure paths still sample the new pose before computing the bounding box, then translate by the posed `bbox.min.y`, preserving the feet-on-floor invariant despite the more compact pose. The headed default view shows no floating or below-floor body silhouette. The table occludes the feet in this required camera, so the evidence is the executed posed-bbox path plus the visible body placement rather than a direct foot close-up.

## Verification evidence

- `bun run build`: PASS — 9/9 workspace builds successful; web production bundle compiled and `/cove/table` prerendered.
- `bunx tsc --noEmit -p apps/web/tsconfig.json`: expected 12-error baseline; 0 errors in `holdem-table-room.tsx` or `vrm-character-animator.ts`.
- Cold restart: killed the prior port-3001 listener and launched the fresh build through `serve-3001.cmd`; `/cove/table` returned HTTP 200.
- Browser asset requests: `_cove_sit.glb?v=2` HTTP 200 / 569,232 bytes; `hermes-sit-arms-crossed.glb` HTTP 200 / 1,398,892 bytes.
- Headed Chromium at 1600×1000: route rendered, seated poses visible, no page errors. Console contained only the pre-existing Three.js Clock deprecation and shader unroll warnings.
- Screenshot: `sitpose-wide.png`, SHA-256 `9F1B1899846DAD40CD638E46ADC1AB00E863F01044E8DC756F6E9A59D56F680F`.

## Decision calls

- The mandatory `git pull --ff-only` was attempted first but safely aborted because this feature branch is 38 commits ahead and 195 behind `origin/staging`. I did not merge/rebase unrelated staging history into the founder-specified `08262d8d` base.
- Used 0.20s/1.20s as the two held phases based on the measured 2.4333s clip duration and the vetted preview description; no extra animation variants were introduced.
- Retained the standing dealer's `idle` because the mandate applies to seated figures and a chair sit would be incorrect for that role.
- No collaborators were used, per the hard rule.

PARITY: visual-only pose staging. Human and connected-agent game paths, vCLAW settlement, and leaderboard behavior are unchanged.
