# Codex Round 10 Report

## Scope

- Branch/base: `feat/cove-3d-holdem` at `aa6933310588404bdc93e98dca136b74ee63a151`.
- Local-only single pass. Nothing was pushed.
- `apps/web/src/lib/cove/holdem-controller.ts` and all `apps/api/**` files are untouched.

## Chair measurement and placement

`cove-chair-clean.glb` was measured directly with a world-transform-aware triangle ray sweep at 0.05 source-unit increments, rather than inheriting the slot stool constant.

- Source bounds: y `-20.38519…20.38519`.
- Flat cushion surface: source y `-3.035`.
- Render scale: `2.9×`, matching the table's Y scale.
- Grounded world cushion height: `(-3.035 - -20.38519) × 2.9 = 50.315551wu` (`50.32wu`).
- Usable cushion depth at the center sweep: source z `-6.30…+7.85`.
- Cushion front-third pelvis point: source z `+3.13`, or `9.08wu` at render scale.

The approved body/card/badge centers remain unchanged. Each chair moves `9.08wu` backward along its seat facing, putting the pelvis on the cushion front third while pulling the backrest away from the torso. Chair yaw is exactly the body's `faceYaw`.

## Per-pose re-pin

- Authored Milady/Hatcher `cove_*` poses: after the frozen pose sample, raw hips now pin to `CHAIR_CUSHION_Y` instead of bbox floor-grounding.
- Sampled Hermes/scale-100 path: the existing normalized seated legs and relaxed upper-body correction run first, then raw hips pin to the same measured cushion.
- Chibi fallback: upright idle plus normalized seated legs run first, then raw hips pin to the same cushion.
- Rigless perch profiles: the group base now derives from `CHAIR_CUSHION_Y` plus the existing per-model `seatOffsetY`; registry-relative size/outward offsets are unchanged.
- Standing dealer: remains posed-bbox floor-grounded and does not receive a cushion pin.

## Default-view sightline verdict

PASS in `scripts/r10-default-view.png` at 1366×768 on the plain `/cove/table` route with `window.__cvCamOverride === undefined`.

- All five opponent heads and shoulders remain visible above/in front of their proper chair backs.
- The 12-o'clock chair stays behind the slightly left-biased center opponent; the standing dealer's head, shoulders, torso, and DEALER plate remain readable.
- The near-pair chair backs remain at the frame margins without masking either avatar, the felt, or the action surface.
- No dealer/seat/camera constant adjustment beyond the measured chair front-third offset was needed.

`scripts/r10-wide-side.png` is the 1366×768 isolated seat-3 side view with DOM overlays hidden. It shows the authored Milady hips on the cushion front third, backrest behind the torso, and the y=70 felt crossing the seated torso below the shoulders.

## Timer verification

- `HOLDEM_DECISION_SECONDS` is `10`; `HOLDEM_DECISION_MS` remains its only derived duration and every reset/progress consumer uses it.
- Browser evidence caught a fresh practice decision at `10s` in the primary screenshot.
- The existing 100ms DOM tick, no-auto-action behavior at zero, 600ms action playback, and ~3s next-practice-hand cadence are unchanged.
- Live cash-table countdown continues to use `deadlineMs`/`toActDeadlineMs`.
- `DEFAULT_TURN_CLOCK_MS` remains `25_000` in the API cash/tournament managers; no backend file changed.

## Verification evidence

- `bun run build`: PASS, 9/9 tasks.
- Build environment: `apps/web/.env.local` supplied `NEXT_PUBLIC_API_URL=https://itachi222.tail06a01b.ts.net:9444`; no process override was present.
- Built artifact grep: Tailscale endpoint present in 60 `.next` files; `localhost:4001` present in 0.
- Web TypeScript: documented 12-error baseline reproduced; no Round 10 file appears in the errors.
- Web tests: documented baseline reproduced exactly, 52 pass / 4 pre-existing slot-verifier fixture failures.
- Port 3003: old `node` listener stopped, `serve-3003.cmd` cold-started, Next ready in 358ms.
- Browser: meaningful content and expected action controls rendered, no Next error overlay, and `agent-browser errors` returned empty. Console contained existing Three.js deprecation/shader warnings plus context-loss logs from deliberate route/canvas navigation.
- Diff checks: no whitespace errors; no `holdem-controller.ts` or API diff.

## Screenshots

- `scripts/r10-default-view.png` — primary untouched default camera, proper chairs, all five opponents, readable dealer, and fresh 10s practice decision.
- `scripts/r10-wide-side.png` — secondary side contact/felt-height evidence.

## Not exhaustively verified

- The default production roster and the shared seating branches were verified, but every selectable rigless/chibi model was not recaptured individually in this single pass. Their placement uses the same measured cushion constant and unchanged per-model profile offsets.
- Real authenticated cash play was not mutated or exercised; its server-deadline path is out of scope and the backend/controller diff is empty.
- Founder visual sign-off remains the release gate; this report makes no push/deploy claim.
