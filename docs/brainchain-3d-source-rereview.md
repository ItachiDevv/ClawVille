**Verdict: BLOCKING ISSUES (2 new).** The B1, B2 and B3 corrections are correct in source. N2, N3, N4 and N7 are closed in source. N5 is only partly closed. The Float32 conversion is correct and I accept it. I did not edit anything and I did not run tests or a shell. The test counts below are the owner's numbers, not mine.

## New blockers (source defects)

**B4. Every grid waypoint now causes one idle frame.**
- **Cause:** `client-pathfinding.ts:220-230` now returns one waypoint per tile, so there is a waypoint every 32-45 wu. With the B3 cap, the body stops exactly on each waypoint. On the next frame, distance < 6 calls `advanceClickPath()` and returns with no movement (`player-avatar.tsx:328-355`).
- **Same defect in the other followers:** `npc-controller.tsx:297-303` and `use-game-loop.ts:176-182`.
- **Effect at 550 wu/s:** there are about 17 waypoints per second. That is about 1 idle frame in 4 at 60 FPS and 1 in 3 at 40-45 FPS.
- **What you see:**
  - The idle frame sends `moving=false` and direction `idle` to the animators (`player-avatar.tsx:609`, `:829-841`). The walk and idle animations alternate many times per second.
  - The real speed drops by 20-33%.
  - The store gets about 17 updates per second.
- **Fix:**
  - Merge collinear grid nodes in `reconstructPath`, and keep only the nodes where the direction changes. This cuts no corners, because each merged segment crosses the same cells.
  - In the three followers, when a waypoint is reached, advance and keep moving in the same frame with the remaining step.
  - Add tests:
    - A straight run of N tiles returns 2 points.
    - A multi-waypoint walk never reports `moving=false` before the last waypoint.

**B5. The Office labels show before the model warm completes, and they never fade.**
- **Where:** `brainchain-office.tsx:52-53`, `:88-93`, `:98-100`. The children are plain nodes, so `ready` never gets to the labels.
- **The rule:** the slice-D pattern says DOM labels are not hidden by the attachment group (`quest-bounty-pavilion.tsx:171-176`, `:433`).
- **Effect:**
  - During compile, which can take up to 20 s, two `pointerEvents="auto"` 44 px buttons float above an invisible building.
  - `fadeFar` is Infinity and `occlude` is false. The buttons show from any distance (spawn is about 3,400 wu away) and they show through buildings.
- **Fix:**
  - Use the render-prop `(ready) => <OfficeInner attachmentVisible={ready} …/>`.
  - Set `initialVisible` and `setVisible(ready)` on both labels.
  - Add `fadeNear`/`fadeFar`, for example the pavilion's 800/4500. The lead chooses the values.

## Re-review of earlier items

| Item | Result | Evidence |
|---|---|---|
| B1 | Closed | `world-input-guard.ts:14-16`. Callers: `player-capability-controller.tsx:142-143,203`, `npc-controller.tsx:157-158,267`, `use-game-loop.ts:56,79,165`. Test: `player-frame-contract.test.ts:364-380`. |
| B2 | Closed | The approach is (390, -2540), 180.3 wu from the guide. The 12 wu disc test is at `brainchain-office-world.test.ts:66-71`. Both planners pass 8 perimeter points (`brainchain-navigation.test.ts:46-60`). |
| B3 | Closed (but it exposes B4) | Step cap at `player-capability-controller.tsx:300`, `npc-controller.tsx:363-364`, and the Pixi `officeDistance`. Test: `:382-387`. |
| N2 | Source OK. The lead must decide the look. | The plush is one mesh and is scaled to fit the 80 wu box. `showGuide={showNpcs}` hides both the figure and the label. But resident Larry uses the same model at the same 96 scale (`arena-location-npcs.tsx:181`). The guide collider (`world-colliders-data.ts:284`) stays when NPCs are hidden, so it becomes an invisible block. |
| N3 | Closed | `brainchain-office.tsx:28,99` |
| N4 | Closed | No `EXIT_WORLD` remains. `3dStructure.md:13` and `WorldContent.md:9` agree. |
| N5 | Partly closed | The cold desktop sample is 53.6 ms, which is above 50 ms. Each call allocates a 4 MB `Float64Array` and a 0.5 MB `Uint8Array` (`client-pathfinding.ts:151,162`), plus one object for each heap node. Recommended fix: reuse module-level arrays with a generation stamp, and store connected-component labels once on the cached grid. Then an unreachable target fails in O(1). This must be measured in a browser. |
| N7 | Closed | `brainchain-office-world.test.ts:39-41` |

## Float32 conversion (`brainchain-office-geometry.ts`)

I accept it. The GLB contains only POSITION, NORMAL and TEXCOORD_0. It has no TEXCOORD_1, COLOR_0, TANGENT, JOINTS or morph targets, so all three quantized attributes are converted.
- `getComponent` handles normalized and non-normalized values.
- The node transforms stay on the cloned scene, and the cached source geometry and materials do not change.
- One clone serves each shared geometry, and `dispose` touches only the owned clones.
- The tests check every value, the transformed bounds, that the source arrays keep their types, and the disposal counts.
- `DeferredWarmAttachment` compiles the converted clone, and no warm path uploads the cached source.

Notes, not blockers:
- `original.clone()` copies the quantized arrays and then throws them away.
- The Float32 vertex buffers are not in the GPU budget.
- This is a workaround for the Office only. Other `-mo-ktx` assets may have the same WebGPU defect.

## Documents
- `compression-review.md:23` says the controls rule out UV quantization. Lines 65-68 say the opposite. Lines 24-26 still give the old 700 KiB cap. Mark lines 23-26 as WebGL-preview scope only, or replace them.
- `office-asset-provenance.json` matches the final asset: 963,764 bytes, SHA `9b5e6254…`, 11 mips. The BC7 sum of 1,398,128 bytes is correct.
- `3dStructure.md:3502-3505` documents the conversion.

## Open visual checks (root work, not source defects)
- No screenshots of the new bundle in the actual world exist. The raw-PNG and Float32 controls are only diagnostic controls.
- No moving-camera shimmer captures exist at P1/P2 with the mipped asset.
- Not checked: controls (click, E, joystick) in the world, the B4 animation in motion, and the phone/iPad matrix.
- Not measured: sustained FPS, draws, triangles, GPU bytes on Iris Xe (WebGPU and forced WebGL), and N5 timing in a browser.
- The E3 Codex review and the founder sign-off (E4) are not done.
