# Cove table-room card-player pose report

Date: 2026-07-19
Branch: `feat/cove-3d-holdem`

## Result

The seated table roster now uses four authored, body-relative card-player poses instead of the arms-crossed hold. The poses are authored once on the clyt Meshy reference skeleton, stripped into build-input clips, merged into `_cove_sit.glb?v=3`, and transferred through the existing `retargetMeshyClip` hips-only position and Meshy arm-chain quaternion policies. This keeps the delivery proportion-immune: **author once, retarget everywhere = fluid for dynamically added avatars**. Hermes remains the established native full-GLB compatibility path.

## Authoring decisions

All clyt poses start from the seated/lap phase at approximately `t=0.20s`. Frames 1 and 2 key every selected deform bone identically, producing a nonzero-duration frozen clip. Non-hips position transfer is not used. A live-Milady arm-chain solve is converted back into clyt track space by `patch-cove-card-pose-arm-tracks.mjs`, the exact inverse of the existing Meshy rest-pose differential; this keeps one reference-rig source while avoiding character-specific assets.

| Pose | Torso/head | Arms and clearance decisions |
|---|---|---|
| `cove_peek` | Spine forward `8°`; head down `20°`. | Elbows remain at the sides at approximately `105°`; forearms converge below the chin with a small wrist gap. The held-card fan makes the hand use explicit without moving hands toward a chibi face. |
| `cove_think` | Spine forward `10°`; head down `8°`, roll `-6°`. | Right hand travels toward the upper chest/chin line at approximately `95°` elbow bend but retains generous head clearance; the left forearm uses the low thigh/lap chain. |
| `cove_watch` | Spine forward `25°`; head counter-pitch `-17°` to keep the gaze up. | Both arm chains are low and body-relative, with forearms/hands over the thighs rather than trying to reach the rim. Hermes uses the same `25°/-17°` torso/head treatment plus a `55°` local-X flex on both native forearms. |
| `cove_rest` | Spine forward `2°`; head level. | Both arm chains use the conservative low thigh/lap solution, elbows beside the torso and hands close to the hips. |

Structural call: the Blender-exported clyt clips retain authored torso/head and seated lower-body tracks, while the arm-chain keys are normalized-humanoid targets solved against the actual live retarget result and written back onto the clyt rig. This is still one shared clyt animation source, not a per-character override. Hermes is rebuilt from her uncompressed Meshy source because her defective VRM-native path cannot use the ordinary VRM transfer safely.

## Runtime assignment

Every frozen clip is sampled at `0.02s`.

| BOT_SEATS index | Figure | Pose/path |
|---:|---|---|
| 1 | `milady_official_2` | `cove_peek` from `_cove_sit.glb?v=3` |
| 2 | `milady_official_5` | `cove_think` from `_cove_sit.glb?v=3` |
| 3 | `hermes_female` | native `/models/hermes-sit-watch.glb` (`cove_watch`) |
| 4 | `milady_official_7` | `cove_peek` from `_cove_sit.glb?v=3` |
| 5 | `milady_official_4` | `cove_rest` from `_cove_sit.glb?v=3` |

The dealer remains on `idle`. `?hermesClip` and `?hermesSample` overrides remain supported.

## Peek-card props and state coupling

- After pose application and posed-bbox grounding, each peek figure samples its two raw hand-bone world positions once using module-scope vector scratch.
- Two static double-sided quads are placed at the midpoint, fanned by `±10°`, pitched `-14°`, and offset `30%` of card width to show a readable pair. Their procedural back matches the felt atlas palette and question-mark treatment.
- No per-frame card work, bone parenting, new fetch, or loop allocation was added.
- The same controller-backed public seats used by the badges gate the props: a peek seat must have a live non-idle/non-settled hand, non-folded status, public hole cards, and a valid hand sample.
- While those conditions hold, the seat index is passed to `TableCards3D` so its felt backs are suppressed. A folded/settled seat loses the hand props and returns to the existing felt-card treatment.
- Missing hand bones or non-finite samples return `null`; the seat is not suppressed, so the ordinary felt backs remain and nothing can appear at the origin.

Live headed verification observed seat 1/TESS fold while seat 4/CAL remained active: seat 1's hand props disappeared, seat 4 retained its in-hand treatment, and unrelated felt pairs remained rendered.

## Asset validation and optimization

- Each stripped clyt source is `15,504` bytes, has one `51`-channel animation, duration `0.083333s`, no mesh/skin, and zero endpoint-component mismatches between its two keys.
- `_cove_sit.glb` is `599,396` bytes and contains the six existing clips plus `cove_peek`, `cove_think`, `cove_watch`, and `cove_rest`. Existing `_emotes.glb` and Mixamo assets were not re-emitted.
- Hermes raw one-frame GLB: approximately `6.78 MB`; optimized meshopt/WebP result: `835,080` bytes. The result retains one mesh, one skin, one `72`-channel `cove_watch` animation, duration `0.041667s`, and identical endpoints.
- The stable Cove bundle URL was bumped from `?v=2` to `?v=3`.

## Grounding

Both VRM-retarget and native-Hermes paths apply the clip first, compute the posed `Box3`, and move the figure so `bbox.min.y` lands on the floor. Hidden-table iteration views showed feet on the floor with no floated or sunk figures after the new torso leans. The requested final table close-ups necessarily obscure feet and some thigh contact behind the rim; the authoring previews and hidden-table checks supplied that lower-body view.

## Evidence

Authoring previews (each clyt PNG contains front and three-quarter views):

- `posecheck-cove_peek-clyt.png`
- `posecheck-cove_think-clyt.png`
- `posecheck-cove_watch-clyt.png`
- `posecheck-cove_rest-clyt.png`
- `posecheck-cove_watch-hermes.png`

Headed debug-Chrome/CDP captures from the production build on `:3001`:

- `cardpose-wide.png`
- `cardpose-seat1.png` — peek, hands/card fan below chin; felt pair suppressed
- `cardpose-seat2.png` — think, raised hand clear of the oversized head
- `cardpose-seat3.png` — native Hermes watch lean, both arms lowered over lap/thighs
- `cardpose-seat4.png` — peek, chibi clearance and in-hand treatment
- `cardpose-seat5.png` — relaxed rest with low hands/elbows

The headed console had no page errors; only existing Three.js clock deprecation and shader-unroll warnings appeared.

## Verification

- `bun run build`: pass, 9/9 workspace packages.
- Web `bunx tsc --noEmit`: expected 12-error baseline (10 legacy plus 2 in untracked `codex-hipcheck-roster.ts`); no new card-pose errors.
- API `bunx tsc --noEmit`: pass, 0 errors.
- Web `bun test`: expected baseline, 52 pass / 4 pre-existing verifier failures.
- Final cold `next start` restart on `:3001`: HTTP 200 for `/cove/table`.

PARITY: visual-only pose staging; human/agent play, vCLAW settlement, and leaderboard behavior are unchanged.
