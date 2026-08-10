# Cove table room — Round 6 implementation report

Date: 2026-07-20

Branch: `feat/cove-3d-holdem`

Base: `2a1362d6`

## Outcome

Round 6 hardens the seated Hold'em room without changing the wager/money mutation path or any API wire shape. The seated room now has corrected upright card poses, a wider and safer first-person composition, one-step inline betting, a visual-only 20-second decision timer, the existing authenticated own-agent chat surface, and settle-only opponent reveal/muck behavior.

The requested `git pull --ff-only` freshness check was attempted before implementation. It could not fast-forward because this feature branch was already 40 commits ahead of and 222 commits behind its upstream; work therefore remained on the founder-specified `2a1362d6` base rather than merging unrelated history.

## R1 — recline diagnosis and root repair

The defect had three concrete contributors:

1. The Round-5 arm-track patcher wrote two quaternion values into samplers that still declared `CUBICSPLINE`. glTF cubic samplers require incoming tangent, value, and outgoing tangent for every key. The live Spine/Head tracks were therefore malformed and collapsed toward the inherited pelvis pose.
2. The chosen arms-crossed lap reference was not neutral: sampling hips-to-head at the authored frame measured **34.81° backward**. The crossed arms and coat silhouette hid it head-on. With the previous small authored offsets, the resulting side readings were about 47° for peek/rest, 46° for think, and 34° for watch.
3. The general VRM0 retarget policy reflects X/Z quaternion components. That policy is appropriate for the legacy full-body Meshy library, but it inverted the explicit torso pitch of these narrowly authored `cove_*` clips.

Root repair:

- The patcher now reads cubic samplers with the correct three-value stride/value offset, restores base channels safely, and rewrites repaired Spine/Head/arm samplers as `LINEAR`.
- Every CLYT-authored pose receives an absolute 67° forward Spine correction from the sampled base. The committed source clips and `_cove_sit.glb` were rebuilt.
- Retargeting has a narrow `cove_*` Spine/Head exception; the existing hips/arms and legacy Meshy policies remain unchanged.
- Hermes keeps its native `cove_watch` clip. A one-time 15° forward pelvis correction plus inverse thigh compensation removes its coat-led backward side read without changing the accepted leg pose.
- The cache key is bumped from `?v=3` to `?v=4`.

Post-repair measured hips-to-head lean is **13.67° forward** for all four authored Milady poses and **1.78° forward** for Hermes. All five figures were captured from both front and true side audit cameras; no front-only acceptance was used.

Structural call: a query-gated audit camera (`?poseSeat=1..5&poseView=front|side`) remains in the room so the real model, clip, retargeter, lighting, and `SeatedLookCamera` can be checked reproducibly. It does not activate in normal play.

## R2 — camera and near-seat staging

- Eye: `[0, 150, -145]` world units.
- Look target: `[0, 66, 78 * S]` (unchanged target intent).
- FOV: **68°** (from 62°, below the 75° cap).
- Yaw clamp: **±75°** (unchanged; widening/restaging made a larger clamp unnecessary).
- Seat 1 figure/chair: `(-64S, -34S)` / `(-72S, -44S)`.
- Seat 4 mirrors seat 1: `(64S, -34S)` / `(72S, -44S)`.
- Both near seats are approximately **132wu from the lens**, above the known ~100wu giant-head failure zone.

The same seat records drive figures, card fans, and badge anchors, so the moved neighbors' props and DOM badge reprojection stay aligned. Default view shows the entire table with both near neighbors at the frame edges; max-left/max-right views show seated people rather than screen-filling heads. Peek card fans remain visible.

## R3 — one-step inline betting

The seated flow no longer mounts `RaiseSlider` or opens a second screen. The action bar contains Fold, Check/Call, Min, ⅓ Pot, ½ Pot, Pot, All In, a range input, a direct numeric input, and the final Bet/Raise action.

UX decision: each preset is an immediate one-tap submission. The slider/direct input selects an amount and the adjacent Bet/Raise button submits it with one click; there is no confirm step. At submission, `computeRaiseOpen()` is re-derived from current live state and the amount is clamped to its exact legal min/max. `holdem-controller.ts` remains the sole mutation path and was not edited.

The capture exercise clicked **Min** once and the next state recorded `YOU BET 7`, verifying preset selection and submission are the same interaction. All controls measure at least 44px in every viewport below.

## R4 — 20-second decision timer

`HOLDEM_DECISION_SECONDS` is now **20**. Warning color begins below 8 seconds; danger/pulse begins below 4 seconds. Reaching zero still performs no action and mutates no game state.

## R5 — authenticated own-agent chat at the table

`AvatarChatBar` is reused through a small `surface="table"` mode; no second chat stack was created. `/cove/table` mounts it only when `useAuthMe()` returns a non-guest user. It is collapsed by default, fixed at the upper-left clear of the table HUD, capped at 360px wide/300px high, and always offers a 44px collapse control plus Escape handling.

Table mode disables the autonomous-world directive branch, so this surface chats only. It does not emit table actions or attach nonsensical world-position context. The existing route choice remains intact: owned/hosted avatars use `api.sendAvatarChat`, while connected OpenClaw sessions retain `api.openclawChat`. Keyboard verification showed typing `e` stayed in the input and did not trigger the table's E-to-stand hotkey; Escape collapsed the panel.

Authentication limitation: the isolated local debug profile did not contain a real agent-bound account. A temporary browser-only fetch harness verified the rendered logged-in surface and captured the exact reused request/response path, but was removed before commit. The observed request was `POST /api/avatars/me/chat` with `{"content":"Can you help me read this table?"}`, and the capture shows the sent message plus simulated agent reply. A live authenticated agent response remains unverifiable from this harness.

## R6 — settle-only showdown reveal and muck

The HUD publishes a display cue only after `phase === 'settled'` and settle narration playback has finished. The Three.js card layer additionally requires the cue's hand ID to match the stored settled hand. Faces reveal only when `settled.outcome.endedAt === 'showdown'`, and only for seats whose settled state is not folded.

Folded seats are copied into a transient muck mesh and fade over 650ms. Fold-out winners stay face-down; no opponent face is exposed merely because the hand settled. Both faces and backs use the existing 53-cell card atlas. The muck layer shares that atlas and changes only a preallocated material opacity scalar per frame. Peek-seat in-hand props already leave with the live-hand pose at settle, leaving narration plus revealed felt cards as the read. The human's DOM tray is unchanged.

Fairness boundary: no live-hand reveal key, public action log, API response, or settlement path changed. `publicActionLogFromPeek` was not touched.

## Viewport sweep

All entries were exercised in a forced live your-turn state with the collapsed chat pill. Bounds were read from the DOM after render. `No` means the listed surfaces did not intersect; every measured interactive target was at least 44px.

| Viewport | Orientation | Action bar | Timer | Chat pill | Legend | Any overlap | Min target |
|---|---|---:|---:|---:|---:|---|---:|
| 390×844 | portrait | 356×163 | 356×18 | 360×44 | 356×37 | No | 44px |
| 844×390 | landscape | 794×59 | 794×18 | 360×44 | 794×19 | No | 44px |
| 744×1133 | portrait | 710×163 | 710×18 | 360×44 | 710×19 | No | 44px |
| 1133×744 | landscape | 914×59 | 914×18 | 360×44 | 914×19 | No | 44px |
| 820×1180 | portrait | 770×59 | 770×18 | 360×44 | 770×19 | No | 44px |
| 1180×820 | landscape | 914×59 | 914×18 | 360×44 | 914×19 | No | 44px |
| 1024×1366 | portrait | 914×59 | 914×18 | 360×44 | 914×19 | No | 44px |
| 1366×1024 | landscape | 914×59 | 914×18 | 360×44 | 914×19 | No | 44px |

The emulated viewports verify layout, interaction, and CSS safe-area expressions. A physical-iPad safe-area screenshot was not available, so hardware notch/home-indicator behavior is not claimed.

## Verification gates

- Web TypeScript: **12 errors**, matching the requested/pre-existing baseline; no Round-6 file appears in the error list.
- API TypeScript: **0 errors**.
- Web tests: **52 pass / 4 known verifier failures**, matching baseline.
- Focused Hold'em bet-math tests: **14 pass / 0 fail**.
- Monorepo `bun run build`: **9/9 tasks successful**.
- Diff whitespace check: pass.
- Post-build cold restart: port **3001** killed and relaunched with `serve-3001.cmd`; `/cove/table` reopened from the production bundle with no browser page errors.
- GPU constraints: no drei Text/Billboard, no InstancedMesh+ShaderMaterial, and no per-frame object allocation added. UI remains DOM.

## Screenshot inventory

Pose verification (front and side for every seated figure):

- `r6-pose-seat1-front.png`, `r6-pose-seat1-side.png`
- `r6-pose-seat2-front.png`, `r6-pose-seat2-side.png`
- `r6-pose-seat3-front.png`, `r6-pose-seat3-side.png`
- `r6-pose-seat4-front.png`, `r6-pose-seat4-side.png`
- `r6-pose-seat5-front.png`, `r6-pose-seat5-side.png`

Acceptance captures:

- `r6-pov-default.png`
- `r6-pov-left-max.png`
- `r6-pov-right-max.png`
- `r6-betting-bar.png`
- `r6-chat.png`
- `r6-showdown.png`
- `r6-muck.png`

Viewport captures:

- `r6-viewport-390x844.png`
- `r6-viewport-844x390.png`
- `r6-viewport-744x1133.png`
- `r6-viewport-1133x744.png`
- `r6-viewport-820x1180.png`
- `r6-viewport-1180x820.png`
- `r6-viewport-1024x1366.png`
- `r6-viewport-1366x1024.png`

All 25 Round-6 screenshots were captured through the headed debug Chrome/CDP flow against the production bundle on port 3001. The showdown and muck images are from separately played hands: the former reached showdown and reveals only the remaining opponent; the latter ended by fold and reveals no opponent face.
