I reviewed the code read-only with Read, Grep and Glob. I ran no shell command and edited no file. The test counts and the TypeScript result are your reports. I did not run them.

**Source verdict: APPROVED for B6 and D1. I found no new blocker.** This is a source verdict only. It is not overall completion and it is not founder acceptance.

## B6: mixed coordinate frames — closed

- **Origin values:** `player-avatar.tsx:331` is the only place in production that makes a `navigationPath`. It passes `originX: HALF_W, originZ: HALF_H`. A search of `apps/web/src` found no other producer.
- **Path space:** `player-capability-controller.tsx:308` adds the origin to the centred start position. The helper then works in game pixels, which is the same frame as `store.clickPath`.
- **Clamp:** the callback at `:309-310` subtracts the origin before `clampMovement` and adds it back to the result. Map bounds and `clampMovement2D` get centred values, as before.
- **Commit:** `:313-314` subtracts the origin before `commitPosition`, and `commitPosition` adds `HALF_W` again (`player-avatar.tsx:260-264`). The round trip only adds float error of about 1e-12, which is far below the 1e-4 turn tolerance.
- **Initial direction:** the direction at `:325-329` uses the waypoint minus `avatarPositionRef`. Both are in pixels, so the frames agree. The budget is always above zero because the fallback direction is (1, 0).
- **Test `player-frame-contract.test.ts:405-432`:**
  - It catches the old defect. It uses origin 11264, centred values below zero, and an exact pixel arrival check. It also checks that every clamp coordinate is below zero.
  - With the old code, the helper would aim about 11 k wu off and would not arrive in 10 frames, so the test would fail.

## D1: completion before proximity — closed

- The controller stores `completeNavigation` at `:321` and calls it at `:380`, after `onAfterMove`.
- `onAfterMove` calls `setNearLocation`, which is a synchronous Zustand write (`player-avatar.tsx:393`). `onComplete` reads `useGameStore.getState().nearLocation` (`:339`), not the old `store` object. So a last step that enters a building's proximity now runs `enterBuilding`.
- **Test check:** with speed 10 and a 0.1 s frame, the path finishes on frame 3, and `near` first becomes true on that same frame. With the old order, `entered` would be false. The check `events.slice(-2) === ['proximity','complete']` also confirms the order.
- **Autonomy:** autonomy can also call `enterBuilding` (`autonomy.ts:262`). Its `!game.currentLocation` guard stops a double entry.

## Shared helper, final tolerance and direction — correct

- **Final-only tolerance:** `navigation-path-step.ts:11` uses 6 wu only for the last point. Turns use 0.0001, so a turn cannot cut a corner. The test at `navigation-path-step.test.ts:30-37` checks both cases.
- **Intermediate nodes:** they are cell centres. Generic colliders have 4 safety tiles of padding, and the guide collider has 50 wu (`world-colliders-data.ts:284`). So exact intermediate arrival is possible for a 25 wu chibi and a 50 wu humanoid.
- **Office door:** stopping up to 6 wu short is safe. The door zone holds the full 96 wu disc (`brainchain-office-world.test.ts:59-62`), and the guide approach has 12 wu of margin.
- **Last moved segment:** `vx` and `vy` change only when `traveled > 0` (`:18`). The test at `:40-44` checks this.
- **Blocked player frame:** `:317-320` sets `moving=false`, direction `idle`, and `worldVx/Vz=0`. Facing does not change. The test at `:434-456` checks this.
- **Multi-segment frame:** in the same test, the direction is `down` and the facing vector is (0, 1).
- **NPC follower:** a blocked frame keeps its facing (`npc-controller.tsx:355`). The direction becomes idle because the camera input is 0.
- **Pixi follower:** `:182`, `:197` and `:219` can open the Office only once per frame.
- **`3dStructure.md:3507` and `:3516-3521`:** these lines now agree with the source.

## Non-blocking notes (none is a regression)

1. **A blocked path stays active.** This is from the earlier review, and the 6 wu tolerance only partly fixes it. If a collider stops the avatar at a turn, or more than 6 wu from the last point, `clickPath` stays set. The avatar then stands idle until manual input. The old follower walked in place in the same case. Venue walk-ins (`arena-buildings.tsx:230-236`) send a straight line with no A*, so they are the most likely case.
2. **Test gap.** No test runs the real `useWorldPlayerController` adapter. That means the `onComplete` closure with real `HALF_W` and real proximity is not tested. The harness proves the controller contract only. A future edit that drops `originX` at `player-avatar.tsx:331` would pass every current test.
3. **Order change on the kelp portal (checked, not a defect).** On the completion frame, the portal check in `onAfterMove` now runs before the old completion closure. `triggerKelpForestWalkIn` clears the path itself (`kelp-forest-transition.ts:34`). The second trigger goes through `decideKelpWalkIn`, which I expect blocks it. Real map layout cannot make one last step cross the portal and also enter another building's proximity.

## Visual checks still needed (not source defects)

None of these is covered yet. The NPC demo walk (75 active frames, 0 idle frames) does not test the player's coordinate conversion.

- **Main 3D player, in the new production bundle:** walk to the Office door, the guide, a label button, the minimap, the world map and a venue walk-in. Each walk must arrive at the right world point, show no walk/idle alternation, and open or enter.
- **Generic building:** one autonomy or minimap walk where the last step enters a building's proximity and `enterBuilding` fires.
- **Blocked and corner cases:** a blocked path must show idle with steady facing, and a multi-segment turn must show the correct facing, in motion.
- **Controls:** click, E, joystick and Shift sprint on the real player.
- **Devices:** the phone and iPad matrix in the world, portrait and landscape. A real iPad is still needed for safe areas.
- **Private forms:** the 8 public screenshots and the 44×44 link checks do not cover them.
- **Iris Xe:** sustained FPS, draw calls, triangles and GPU bytes, on WebGPU and on forced WebGL.
- **E3 Codex pass:** still needed.