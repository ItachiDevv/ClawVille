Source: actual Claude read-only review, session7bb0d6aa-9fd7-4790-8c16-cb0087eea05b.

# Independent 3da review: BrainChain 2D tasks A–E

**Verdict: BLOCKING ISSUES.** There are 3 runtime defects and 1 source-hygiene defect.

I used Read, Grep and Glob only. All findings come from the source. I ran no tests, builds or browser checks, and I make no visual claim. The owner reports typecheck 0 and green tests, but I did not see that output.

## Blocking issues

**B1. The "Continue in 2D" button stays hidden for up to 45 s on `/game`.**
- Cause: `SeaLoadingScreen` portals into `<body>` at `zIndex: 9999` (`components/game/sea-loading-screen.tsx:431`, `:518`). The renderer-failure card sits at `z-50` in the stage root (`WorldStageRoot.tsx:844-868`), so the loading screen covers it.
- On a 3D failure, `forceReady` is `rendererMode === '2d' && pixiFrame` (`page.tsx:656`), which stays false. No code dismisses the loader on a renderer failure: Grep finds `getStageRendererFailure` only in WorldStageRoot and stage-renderer-status.
- Repro: force WebGPU and WebGL init to fail, then cold-load `/game`. The loader stays until its 45 s visible-time fuse. Only after that can the user click "Continue in 2D".
- Fix (task E, `page.tsx`): read the failure with `useSyncExternalStore(subscribeStageRendererFailure, getStageRendererFailure, getStageRendererFailureServerSnapshot)`. Then pass `forceReady={(rendererMode === '2d' && pixiFrame) || failure !== null}`. Add a test.

**B2. After Autonomous mode, the server position jumps back to an old spot.**
- In 3D, `MinimapPositionTracker` copies the autonomous body into `avatarPositionRef` five times a second (`World3DCanvas.tsx:1376-1384`).
- In 2D, `use-game-loop.ts:37` returns in mode `none` and never updates the ref. The camera follows the body, but the ref keeps the position from before Autonomous.
- On a switch back to `player`, presence uploads again (`world-presence-controller.ts:373`) and sends that old position. The server body then teleports back.
- Fix (task C, `use-game-loop.ts`): in Autonomous mode, find the NPC with `autonomousBodyId`. If it is more than 2 px from the ref, call `setAvatarPosition(body.x, body.y)`. Keep the rule that Explore never writes the ref. Add a test: Autonomous → ref equals the body, then Player starts from the body position.

**B3. In 2D, a player can join an activity queue but never reach the activity.**
- How it happens: a 2D player opens a building portal, then the lobby, then queues. When a match is found, the lobby calls `router.push('/activity/...')` (`activity-lobby-modal.tsx:951-956`). The sidebar Bumper Shells quick-queue does the same (`sidebar-menu.tsx:801-802`).
- The 2D refusal (`WorldStageRoot.tsx:147`, `:812`, `:828`) applies only after this push. The activity page never mounts, so the matched room gets a no-show. That affects other humans and agents in the room. The push also unmounts and destroys the Pixi app.
- This breaks the plan rule "refused before any fade".
- Fix: check `isStageSceneAvailable('activity')` before a queue starts, in `handleQueue` and in the sidebar quick-queue. If it is false, show the same "needs the 3D view" toast and do not queue. These files are outside tasks A–E, so the lead must assign an owner.

**B4. Source hygiene from the walk-in move (task B).**
- `lib/three/venue-walk-in.ts:8-30` has 15 mojibake sequences (`â€”`, `âˆ’`). The em dashes and minus signs were double-encoded when the code moved. Restore the original characters or use plain ASCII.
- `lib/three/arena-buildings.tsx:62`: the `useGameStore, avatarPositionRef` import is now unused (an orphan from the move). Delete it.
- `lib/three/arena-buildings.tsx:237`: the comment says "COVE_DOOR_PX above", but that constant now lives in `venue-walk-in.ts`. Update the comment.

## Checks that pass (source only)

- **Acknowledgements:**
  - The host sends warming, ready, camera, then frame, all for the same generation (`WorldStage2DHost.tsx:7-16`).
  - The frame acknowledgement goes after Pixi's render: it runs at priority `LOW-1`, and the render runs at `LOW` (`PixiCanvas.tsx:157`).
  - A non-world request gets no acknowledgement.
- **Route return:** the host mounts once at stage-root level. On `/brainchain`, `isWorldFrameBlocked` stops movement.
- **Control modes:**
  - `player` writes the ref.
  - `npc` moves the possessed NPC with `moveNpc`, then calls `setAvatarPosition`.
  - `explore` moves only `exploreCameraTarget`.
  - Autonomous ignores input. The E and Escape edges are read before any early return.
- **Interaction:**
  - Shared proximity puts the Office door and guide first, as the B6D1 fixes require.
  - Path completion runs after the proximity update.
  - A building click walks to its resident, so the distance bypass is gone.
  - Cove, Trading Floor and Kelp show the toast before they set any pending state.
- **Map, touch and terrain:**
  - Map coordinates: `WORLD_CENTER_PX` = 11264 = `MAP_WIDTH/2`.
  - Marker hit areas are at least 44 CSS px. The Office is about 168×140 CSS px at 390×844.
  - The ground is one `TilingSprite`.
  - Dust uses a fixed pool, departed NPCs are removed, and the legacy species map is used.
  - Only one player body draws, because `PLAYER_NPC_ID` exists only in NPC mode.
- **Warp:** the camera snaps through `consumeCameraFocus`.
- **3D default path:** I see no 3D-mode change except one. The transition overlay now hides while a 3D renderer failure shows.

## Non-blocking items (fix in the same diff if possible)

1. `use-game-loop.ts:66` writes `clickPathIndex` on every frame, so every store subscriber runs each frame. Write it only when the value changes.
2. `PixiCanvas.tsx:72` (`walkTo`) leaves out wanderers in NPC mode, but the loop includes them (`use-game-loop.ts:41`). Pass `controlMode === 'npc'`.
3. Pixi keeps rendering at full rate behind the DOM Office page.
4. three.js still loads in 2D:
   - `WorldStageRoot` imports `WorldStageCanvas` statically.
   - `page.tsx` imports `arena-npcs` and `asset-preload-manifest`.

   Trap T5 is met only as the plan scoped it.
5. A browser Back or Forward to a venue in 2D destroys the Pixi app and makes a new one.
6. Explore minimap: in 3D, the minimap dot follows the camera in Explore. The plan says Explore in 2D must never write the ref, so the dot stays on the body. The lead must choose one rule.
7. The sidebar `icon="View"` puts text into the emoji slot. It needs a visual check.
8. Test gaps against the acceptance list:
   - No E-dispatch table for Office, guide, Cove, Trading Floor, Kelp, a building and Nori.
   - No 3D-vs-2D proximity parity table.
   - No root-level test for 30 round trips with a listener-count check.
   - No test that the mode stays fixed mid-session.
   - No Office/guide hit-area test at 390×844.
   - No test that the dust pool size stays constant.

## Not verified (runtime evidence still owed)

None of the browser acceptance items has run yet:
- Office door and guide, by click and by E, then the return to town.
- Minimap walk and World Map warp.
- Joystick at the 8 required sizes, portrait and landscape.
- Presence uploads compared with `avatarPositionRef`.
- The Cove notice in 2D.
- The 3D stage probes with the default mode.
- An Iris Xe 2D FPS sample.
- The real-iPad safe-area check.