# Cove Hold'em Table Room — redesign (2026-07-16)

**Trigger:** founder live-test verdict on the in-cove felt experience: 1/10.
Direct quotes driving this spec: avatars "none … in a regular seated
position … essentially zombie looking, and moving when we just needed them
sitting in an idle position — we don't even need a sitting down animation";
hole cards "exposed to the entire table, when they should just show as their
own overlay, specific to the user"; "the goal is to have the 3d table
function like the modal overlay background — it has a semi circle shape for
a reason, there would normally be a dealer there on the side of the flat
table"; "we can even have it render as a separate 'arena' or room because
this can't even support the multiple lobbies workflow as it is now"; "the
modal still popped up … before you even actually were able to sit down".

**Supersedes:** the in-cove seated experience (Slice 1/2 sit-at-T1, P2/P2.1
felt card projection, sit_stand_to_sit + sit_idle loops, TableSeatCamera,
TableSitLabel). The shared hold'em controller, SeatedHoldemHud action
buttons, card atlas, and ALL server/money paths are KEPT.

## Design

### D1 — Dedicated table room (new route, own canvas)
`/cove/table` — its own small scene, NOT the walkable cove interior.
- Room shell: `public/models/cove-room-only.glb` (2.3MB, extracted from
  `laptop-clawville/feat/baccarat-3d`; if it fights the framing, a simple
  procedural backdrop wall + floor is acceptable v1).
- Table: `public/models/cove-table-clean.glb` (1.2MB semicircle) at scene
  origin, FLAT side away from camera.
- Chairs: `public/models/cove-chair-clean.glb` placed BY CODE around the
  curve — exact anchors by construction, no raycast measurement ever again.
- Reference for the route/lobby pattern:
  `laptop-clawville/feat/baccarat-3d:apps/web/src/app/cove/poker/cash/[tableId]/page.tsx`
  and its inline CasinoTable3D in that branch's cove-interior.tsx (~1512).
- The scene component takes `tableId` (today always the caller's single T1
  session) → multi-lobby later is "mount the room with a different id",
  no redesign.

### D2 — Staged like the modal background
- Camera FIXED (no controls): player-seat POV at the middle of the CURVE,
  table filling roughly the lower half of frame, dealer side + far seats in
  view. This is "the modal overlay background", in 3D.
- DEALER at the flat side: one VRM standing statically (frozen idle frame —
  see D3). That is what the flat side is for.
- 5 bot players seated around the curve left/right of the player POV, all
  facing table center. Player's own avatar not rendered (first person).
- Lighting: simple three-point over the table; no cove fog/atmosphere.

### D3 — Static poses, zero animation
- NO sit-down transition. NO idle loop. NO movement.
- Seated bots: play `sit_idle_m` frame at t=0 ONCE (numerically verified
  hands-below-shoulders at t=0), then never tick the mixer again. Frozen
  mocap frame = natural static seated pose, zero per-frame cost.
- Dealer: standing `idle` frame at t=0, frozen the same way.
- Chairs placed so pelvis lands on cushion by construction (we own the
  chair transform; hip height from the frozen clip's own hip track).

### D4 — Cards
- **Player hole cards: PRIVATE SCREEN OVERLAY** — reuse the modal's
  `PokerCard` components in a DOM row above the action HUD. NEVER rendered
  on the felt. This is the founder's core correction.
- Community cards: ON the felt (public info, real-table semantics), small
  and real-proportioned, laid in front of the dealer position — AND
  mirrored in the DOM overlay row for legibility (modal parity).
- Bot hole cards: small face-down backs on the felt in front of each bot;
  revealed faces only at showdown (existing controller state already
  drives this). Reuse the TableCards3D atlas/quad builder with new
  placement math; the hole-card felt quads are DELETED.

### D5 — Flow (no modal in the 3D path)
- In the cove: walking to T1 + E (or felt click) → navigate to
  `/cove/table`. The 2D HoldemModal NEVER opens from the 3D flow.
- The modal remains ONLY for the `?table=holdem` deep link (2D fallback).
- Leaving the room (Walk Away / Close / Escape after settle / explicit
  "Back to Cove" button) → back to `/cove`. Same controller close/walk-away
  semantics as today — no new money path.

### D6 — What gets stripped from cove-interior.tsx
`Table3D` + `TableSeatedBust*`, `TableCards3D` mount, `TableSitLabel`,
`TableSeatCamera`, `_updateTableSitProximity` sit-arming (E at T1 now
navigates), the seated-suppression special cases. The 2D hotspots/banners
from the 2026-07-16 identity swap stay (T1 = TEXAS HOLD'EM), but the
hold'em hotspot click navigates to `/cove/table` instead of opening the
modal. Blackjack/baccarat/slots untouched.

## Kept invariants
- `holdem-controller.ts` is the ONLY state/mutation owner (modal, room,
  HUD all pure consumers). No new fetch paths, no settlement change, E5
  parity untouched (server-side unchanged).
- vCLAW naming, no "casino" in user-facing copy ("table room").
- Iris Xe rules: no drei Text/Billboard, no InstancedMesh+ShaderMaterial,
  no per-frame allocations; frozen poses make this scene near-zero anim
  cost by construction.
- Same-diff docs: GameFeatures §18a.g + 3dStructure entry + this doc.

## Phases
- **A (Codex):** route + scene (room/table/chairs/camera/lighting) +
  frozen-pose busts & dealer + felt board/bot-backs + overlay hole-card row
  + entry/exit wiring + cove strip. One commit.
- **B (Fable review + browser verify):** visual pass at the fixed camera,
  numeric pose check (hands below shoulders, pelvis on cushion), full
  guest + authed hand E2E, viewport sweep, demo video for founder.
