# Dedicated Hold'em table room — Codex implementation report

## Files added

- `apps/web/src/app/cove/table/page.tsx` — isolated route, table lifecycle, Back to Cove, controller + seated HUD.
- `apps/web/src/lib/three/holdem-table-room.tsx` — fixed-camera room canvas/scene, extracted shell/table/chairs, frozen bots/dealer, lighting, felt cards.
- `apps/web/public/models/cove-room-only.glb`
- `apps/web/public/models/cove-table-clean.glb`
- `apps/web/public/models/cove-chair-clean.glb`
- `apps/web/public/models/cove-stool.glb` (included as requested; not needed by the current scene).
- `docs/cove-table-room-redesign-2026-07-16.md` — founder contract supplied with the worktree.
- `codex-tableroom-report.md`

## Files changed

- `apps/web/src/app/cove/page.tsx` — observes the one-shot table-room entry intent and routes to `/cove/table`; explicit `?table=holdem` modal deep link is unchanged.
- `apps/web/src/lib/three/cove-interior.tsx` — T1 click/E request the room; old table/bust/card/camera/label mounts removed; blackjack, baccarat, slots, and the T1 banner remain.
- `apps/web/src/stores/cove.ts` — adds the one-shot room-entry flag/actions; existing `seatedTable` lifecycle remains the controller activation seam.
- `apps/web/src/lib/three/cove-table-cards.tsx` — placement-configured board/opponent atlas mesh; player-hole felt quads deleted.
- `apps/web/src/components/cove/holdem/SeatedHoldemHud.tsx` — private player hole-card DOM row plus mirrored public community-card row.
- `apps/web/src/lib/cove/holdem-controller.ts` — seated Close also stands, letting the room return to the cove; all network mutations remain here.
- `apps/web/src/lib/three/vrm-character-animator.ts` — public one-sample `applyFrozenPose()` path (`reset().play()`, one 0.0001 mixer/VRM/skeleton upload, no later tick).
- `GameFeatures.md`, `3dStructure.md` — same-diff audit entries, flow/cards/camera/static-pose details, and PARITY note.

## Calls made where the spec allowed judgment

- Kept the extracted room shell and added a dark procedural floor/back wall so the fixed frame stays deliberate even where the shell opens outside the camera.
- Furniture scale is explicit `2x`: the inspected raw table width is 86.6 units, so it reads at about 173 world units. The shell is centered/grounded at `0.5x`.
- Camera is `[0,104,158]`, FOV 52, looking at `[0,45,-5]`; no controls or fog.
- Five bot anchors use mirrored left/right pairs plus the far-center sixth-seat position; the player gap remains at the curve midpoint. Dealer stands behind the flat side.
- Chair cushion plane is 42wu. After the single sampled `sit_idle_m` pose, each raw hips bone is translated onto that plane. Dev assertions require hips within 1wu and both hands below their matching shoulders.
- Community cards are 8×11.2wu; opponent cards are 6.5×9.1wu. Player hole cards have no 3D code path.
- Back to Cove exits the room without inventing a new close request; Walk Away/Close uses the existing controller semantics and seated-state transition.

## Verification performed

- `cd apps/web && bunx tsc --noEmit` — exactly 12 baseline errors: 10 legacy plus the two expected `codex-hipcheck-roster.ts` errors; zero new errors.
- `bun run build` from repository root — pass, 9/9 packages; Next emits `/cove/table`.
- Rebuilt `apps/web` after the final scene adjustment — pass.
- Local production route `http://localhost:3010/cove/table` — loads; Back to Cove and Deal/stand HUD are in the DOM; all six VRM animators initialize; extracted asset requests complete; no page errors or framework overlay. Only existing Three.js deprecation/shader compiler warnings appeared.

## Reviewer visual steps

1. Run `bun run build && bun run start` (never `bun run dev`).
2. Open `http://localhost:3000/cove/table` directly. Confirm the semicircle table occupies roughly the lower half, player gap is closest to camera, five seated bots frame the curve, and the standing dealer is visible beyond the flat side.
3. Confirm figures never animate after their first pose; hips sit on cushions, chair backs do not cut torsos, and hands remain below shoulders.
4. Deal a guest and authenticated hand. Confirm player cards appear only in the DOM overlay, community cards appear both there and on felt, bot pairs stay backed until settled, and every action still goes through the existing HUD/controller.
5. From `/cove`, test T1 proximity + E and the Hold'em hotspot; both must enter `/cove/table` without a modal. Confirm `/cove?table=holdem` still opens the 2D modal. Recheck blackjack/baccarat/slots.
6. Run phone and iPad viewport sweeps; all action targets must stay at least 44px. A real iPad is still required for safe-area proof.

## Known gaps

- The available headless Chromium session rendered the route/controller correctly but captured the WebGL compositor as black even after a lit procedural wall was added; it produced no runtime/page errors. Therefore camera composition, asset orientation, and exact cushion appearance still need the reviewer’s headed-browser eyes rather than a misleading headless screenshot.
- The extracted `cove-stool.glb` is committed for asset completeness but unused.
