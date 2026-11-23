Source: actual Claude re-review. Session d342ec64-335d-47be-b718-0927584fbb87

**Verdict: BLOCKING ISSUES. One finding remains, a gap in B3.** B1, B2, B4 and W1 pass in the source. The checks in the brief also pass in the source.

I used Read, Grep and Glob only. I ran no tests, builds or browsers. I did not see the owner's test or typecheck output (15 tests and 89 assertions, 2 tests and 186 assertions, tsc 0).

## Remaining blocking finding

**B3a. A 2D player who is a party member can still get a no-show.**
- The guard at `apps/web/src/components/game/activity-lobby-modal.tsx:970` protects only this client's own queue request.
- At `:1138-1139`, `onCreateParty={createParty}` and `onJoinParty={joinByCode}` have no guard. A 2D player can create or join a party.
- A 3D party leader then queues the whole party on the server. The 2D member's poll changes the phase to `queuing` (`:940-945`). On a match, the lobby calls `router.push('/activity/...')` (`:948-958`).
- The 2D stage then refuses `/activity`, so the room gets a no-show. That is the same B3 failure.
- A party that the player joined in 3D also persists after the switch to 2D, because the switch reloads the page.
- Minimal fix, in the same file:
  1. Wrap `onCreateParty` and `onJoinParty` in `allowWorldActivityQueue(...)` with the same toast. Pass the arguments through.
  2. In the effect at `:940-945`, add a check: if `!isStageSceneAvailable('activity')` and `party` is set, do not set `queuing`. Show the toast and call `leave()`. Then check that the server takes a member out of the party queue when that member leaves.
  3. Add a test in the style of `apps/web/src/lib/world-renderer-mode.test.ts:27-44` for the two party handlers.

## Corrections that pass (source only)

- **B1:**
  - `page.tsx:3` imports `useSyncExternalStore`. `page.tsx:342` subscribes to the renderer-failure store, and `page.tsx:658` passes `shouldReleaseWorldLoader(...)` to the loader.
  - That function returns true on any failure (`lib/world-renderer-mode.ts:49-51`).
  - When `forceReady` changes, the loader effect runs again (`sea-loading-screen.tsx:420`). Its first tick dismisses with the reason `force-ready` (`:297`, `:312`), then fades out in 420 ms.
  - "Continue in 2D" leaves the failure value set, so the loader stays closed. The 3D card hides in 2D (`WorldStageRoot.tsx:844`).
  - The root's old forced-failure test used a DOM click and did not refute B1. A real pointer test is still owed.
- **B2:**
  - In Autonomous mode, `use-game-loop.ts:36-39` copies the body into the ref when the gap is more than 2 px. This runs before the route check, so it also works with a service panel open.
  - The store clears `autonomousBodyId` in the same `set` as the mode change (`stores/game.ts:802`). At the switch, the ref holds the body position from the last Autonomous frame.
  - Explore still does not write the ref. The test at `use-game-loop.test.ts:67-77` covers Autonomous on `/brainchain`, then Player.
  - At 10 FPS on a service page, the ref can be up to about 100 ms behind the body.
- **B3 (solo and sidebar):** the guard is the first statement in each handler (`activity-lobby-modal.tsx:970`, `sidebar-menu.tsx:759`). It runs before audio priming, guest creation, setting the queueing flag, or the fetch. The `?quickQueue` auto-queue path goes through the same `handleQueue`, so it is also guarded.
- **B4:** `venue-walk-in.ts` has no mojibake now. `arena-buildings.tsx` has no orphan store or ref import, and its `:236` comment names `venue-walk-in.ts`.
- **W1:**
  - `pixiSolidFootprint` (`lib/pixi/pixi-world-scale.ts:9-12`) maps each non-walkable `Collider2D` AABB 1:1. It uses `WORLD_CENTER_PX`, the same center that `clampMovement2D` uses.
  - Collision geometry did not change (`world-colliders.ts:248-349`, `:394-440`).
  - The Map key cannot drop a collider, because no collider IDs repeat between the buildings and the props.
  - In Pixi 8.17.1, stroke `alignment: 1` means "inside" (`FillTypes.d.ts:241-256`). So the outer edge of each visible box is exactly the solid edge.
  - Building art scales to fit inside its footprint (`PixiCanvas.tsx:103-108`). The solid layer goes in at index 1, above the ground and below the art and labels.
  - The test values are correct. The marketplace-stall bottom edge is at 11434, plus 50 gives 11484. The mcp-tool-use left edge is at 14263, minus 50 gives 14213.
- **Persistent Pixi:**
  - The host stays mounted on all 2D routes (`WorldStageRoot.tsx:812-814`).
  - On a route other than `/game`, the ticker runs at 10 FPS (`PixiCanvas.tsx:149`). Only `/game` and `/brainchain` map to the world scene (`stage-scene-id.ts:9-11`).
  - Keyboard and joystick: the loop stops on a non-world route, on a service panel, while paused, or during a transition (`use-game-loop.ts:42`).
  - Pointer: on an unsupported route, the z-50 opaque card covers the canvas (`WorldStageRoot.tsx:869`). On `/brainchain`, `canAct()` uses `isWorldInputBlocked()`, which checks the service-panel path (`world-input-guard.ts:8-11`).
- **3D default, server identity and queue economics:** I found no change to them in these paths.

## Non-blocking item

- `apps/web/src/app/(world)/activity/[activityId]/[roomId]/page.tsx:200` shows `ENTERING ACTIVITYâ€¦`, which is a mojibake ellipsis. I cannot run git, so I do not know if this diff added it. Change it to `…` or `...`.

## Visual and runtime evidence still owed (not run)

- The new pointer test for B1: force a 3D failure, then click "Continue in 2D" with a real pointer within about 1 s.
- A browser check that the outlined boxes match the stop points at (12099, 11484) and (14213, 8681).
- A party test: a 2D member and a 3D leader, after the B3a fix.
- The baseline browser items in my earlier report are still owed.