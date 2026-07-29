# Hold'em table-room Round 8 — default-view framing repair

Date: 2026-07-21

Branch: `feat/cove-3d-holdem`

Base: `f903d271b5d6a631c4a649456bdbc6d227ee9d16`

Publication: local only; nothing pushed

Status: implemented, built, and rendered locally; founder visual sign-off remains the shipping gate.

## Root cause and fix by requested item

### R8a — bigger table

- Root cause: the Round 7 table footprint left human-scale avatars too close to one another and too close to the default eye, even though its approved y=70 felt height was correct.
- Fix: `TABLE_FOOTPRINT_MULTIPLIER=1.34`, applied only to table X/Z. The table clone is now `[3.886, 2.9, 3.886]`; its Y scale, `TABLE_TOP_Y=70`, stool scale 1.45, stool top y=52, and seated hip pin are unchanged.
- The measured source bounds produce an approximately 337×193wu table footprint. Baked betting spots/chips grow with the table. Seat/stool/card/badge layout uses `TABLE_FOOTPRINT_SCALE=1.943`; board spacing derives from it while physical card dimensions remain avatar-scale. Peek-card fans continue to use sampled hand positions.
- Dealer animation/model is untouched. Position alone moves with the far rail from z=113.1 to z=151.6.

### R8b — far opponent arc

- Root cause: Round 7 bearings put seats 1/2 at −43.4/−46.0° and seats 4/5 at +43.4/+46.0°, so the foreground bodies fully occluded the outer bodies.
- Fix: the shared five-seat source is now a far 8/10/~12/2/4-o'clock arc:

| Engine seat | Approx. clock | XZ center (wu) | Default-eye bearing |
|---|---:|---:|---:|
| 1 | 8 | `(−181.7, −64.1)` | `−47.6°` |
| 2 | 10 | `(−181.7, 64.1)` | `−31.7°` |
| 3 | ~12 | `(−38.9, 128.2)` | `−6.2°` |
| 4 | 2 | `(181.7, 64.1)` | `+31.7°` |
| 5 | 4 | `(181.7, −64.1)` | `+47.6°` |

- Structural call: seat 3 is biased 38.9wu left of exact 12 o'clock so the centered standing dealer remains readable behind it. This remains visually a 12-o'clock seat.
- Minimum adjacent body-center spacing is 128.2wu. Minimum adjacent bearing separation is 15.9°. Body, stool, felt-card, and badge consumers all use the same seat objects.

### R8c — camera up/back

- Root cause: eye `[0,128,−150]`, look `[0,82,113.1]`, FOV 68 left the near pair only about 123wu away, making them loom while still failing to expose seats 2/5.
- Fix: default eye `[0,148,−230]`, look `[0,86,69.9]`, FOV 66. The lower aim preserves the at-table/felt read; the modestly narrower lens avoids fisheye expansion.
- The primary 1366×768 default capture shows all five heads and both shoulders, clear top chrome, readable table/board overlay, and no face behind the bottom HUD.

### R8d — table-ward badges

- Root cause: Round 7 world anchors and the additional ±42px projection nudge both pushed labels outboard; collinear seats then produced the Nita/Cal stack and hid Pip behind the foreground presentation.
- Fix: every opponent badge starts from its seat center and moves 75.4wu radially toward table center. The outboard screen-space nudge is deleted.
- Fixed above-felt heights are `25/34/5/34/25wu`. This symmetric stagger handles the only horizontally close outer/inner pairs without a per-frame layout solver; the center badge sits at the table rim beneath the center opponent's face.
- Captured live badge rectangles do not intersect. Closest pairs overlap only on X and are separated on Y: seats 1/2 have a 10px vertical gap; seats 4/5 have an 18px vertical gap.

### R8e — sampled seated pose

- Root cause: the Round 7 scale-100 fallback gave Hermes/Tekk reliable seated legs and hips but retained an awkward sampled upper body, including one hand near the face and the other hanging beside the knee.
- Fix: after sampling `sit_idle_m`, the scale-100 manual-seat path now adds an 8° tableward spine bias, a 5° head counter-bias, relaxed/mirrored upper arms, 78° forward forearm bends, and partially neutralized hands. Normalized leg bends and raw-hip pinning are unchanged.
- The resulting Hermes front/side evidence shows a level head, slight tableward read, upper arms down, and hands together toward lap/rail. Milady authored card poses remain as approved. Chibi fallback and every rigless perch profile remain unchanged.

## Default-view verdict against founder complaints

Primary evidence: `scripts/r8-default-view.png`, 1366×768, cold-started production bundle on port 3001, plain `http://localhost:3001/cove/table`, with `window.__cvCamOverride === null`.

- "Can't even see two people": repaired. All five opponents' heads and shoulders are fully visible.
- "More crowded / foreground looming": repaired in the default frame. Near seats are fully contained, do not crop at the frame edge, and do not cover any other opponent.
- "Bubbles still overlap": repaired. Five opponent rectangles are mutually non-intersecting in the captured live-hand state.
- "Bubbles should be toward the table": repaired. Cal/Nita move to the right of the left-side bodies; Vex/Tess move to the left of the right-side bodies; Pip sits below the center body at the table rim. No badge covers a face.
- "Make the table bigger / spread players": repaired with the 1.34× XZ footprint and 128.2wu minimum adjacent gap.
- "Move camera up so everybody is visible": repaired with eye y=148 and z=−230. Heads clear the top chrome and the bottom HUD clears every face.
- "Sitting poses aren't better": the sampled Hermes path is materially cleaner in front and side evidence; authored Milady and rigless paths were intentionally not reworked beyond re-anchoring.
- Community-card surface: the live default capture shows the five-slot board tray unobstructed and readable; felt backs/peek props remain tied to the new seats/hands.

## Evidence files

Primary, default camera:

- `scripts/r8-default-view.png`

Secondary, forced-camera roster/contact checks:

- `scripts/r8-spot-chibi-front.png`
- `scripts/r8-spot-chibi-side.png`
- `scripts/r8-spot-hermes_female-front.png`
- `scripts/r8-spot-hermes_female-side.png`
- `scripts/r8-spot-lobster-front.png`
- `scripts/r8-spot-lobster-side.png`
- `scripts/r8-wide-side.png`

Capture automation: `scripts/round8-audit.ts`. It captures the plain default route before assigning any `__cvCamOverride`, records default URL/override/overlay/badge rectangles, then uses forced cameras only for the named secondary shots.

## Verification

- `bun run build`: pass, 9/9 packages; final web production bundle compiled successfully.
- `cd apps/api && bunx tsc --noEmit --pretty false`: pass, 0 errors.
- `cd apps/web && bunx tsc --noEmit --pretty false`: expected 12-error baseline, none in Round 8 files.
- `cd apps/web && bun test`: expected baseline, 52 pass / 4 fail. The four failures remain the pre-existing slot verifier 55→54 / multiplier 20→18 fixture drift.
- `git diff --check` on all Round 8 text files: pass.
- Cold restart: old `next start` PID 37332 stopped; final production server PID 29288 listened on port 3001 and served the route.
- Browser smoke check: route loaded with meaningful content and no Next/Vite error overlay.
- CDP final default probe: plain URL, `cameraOverride:null`, table scene present, no error overlay, six badge nodes including seat 0, no browser console errors or exceptions.
- Iris Xe constraints: no drei Text/Billboard, no InstancedMesh+ShaderMaterial, and no new per-frame Three.js allocation. New vectors/quaternions are module-scope; badge anchor math runs at module initialization.
- `holdem-controller.ts`, dealer animation selection, API routes, wire types, and settlement files have no Round 8 diff.

## Unverifiable / deliberately not claimed

- No staging or production deploy was attempted; founder gate requires local-only work.
- No push was attempted.
- Real-device iPad safe-area behavior was not evaluated; Round 8 changes no HUD sizing or safe-area CSS, and the requested acceptance surface is the desktop default player camera.
- Final aesthetic shipping approval remains the founder's visual sign-off; this report records the local rendered evidence and does not claim deployment or shipping.

PARITY: display-only restage. Human and connected/hosted-agent avatar selections use the same table-room rendering path; agent API actions, subject resolution, leaderboard effects, settlement, and vCLAW ledger behavior are unchanged.
