# BrainChain world-source checkpoint

Last Audited: 2026-11-09. Owner: actual Claude, team brainchain-office, world release owner.
Worktree: `.worktrees/brainchain-plan`, branch `docs/brainchain-plan`. This is a local commit. No push occurred.

## What this checkpoint is

This commit records the reviewed BrainChain Office world integration and the reviewed 2D/party corrections as source.
It is a world-source checkpoint. It is not a shipped integration and not a standalone release.
The asset checkpoint `26e5814f40ae03b1dc26839ef17006e6a408243f` already holds the Office GLB, its provenance and `packages/shared/src/constants/brainchain-office-world.ts`. This commit does not change the GLB.

Source reviews that this checkpoint relies on:

- `docs/brainchain-3d-b6d1-code-review.md`: actual Claude approved B6 and D1 as source only. This review record is still untracked in the worktree and is not part of this commit.
- `docs/brainchain-2d-party-correction-claude-review.md`: actual Claude approved the five 2D blockers, R1 and the R2 kick/rejoin correction.
- `docs/brainchain-2d-party-root-review.md`: root reproduced R2 and approved the narrow correction.

## Committed paths (73 files)

World stage, 3D and shared world geometry:

- `apps/web/src/components/three/World3DCanvas.tsx`
- `apps/web/src/components/three/world-stage/WorldPresence.tsx`
- `apps/web/src/components/three/world-stage/WorldStageRoot.tsx`
- `apps/web/src/components/three/world-stage/stage-navigation.ts`
- `apps/web/src/components/three/world-stage/stage-navigation.test.ts`
- `apps/web/src/components/three/world-stage/stage-scene-id.ts`
- `apps/web/src/components/three/world-stage/stage-scene-id-for-pathname.test.ts`
- `apps/web/src/components/three/world-stage/world-presence.test.ts`
- `apps/web/src/lib/three/arena-buildings.tsx`
- `apps/web/src/lib/three/arena-terrain-decorations.ts`
- `apps/web/src/lib/three/arena-terrain-decorations.test.ts`
- `apps/web/src/lib/three/arena-terrain-decorations-bounds.test.ts`
- `apps/web/src/lib/three/asset-preload-manifest.ts`
- `apps/web/src/lib/three/basis-transcoder-prefetch.test.ts`
- `apps/web/src/lib/three/brainchain-office.tsx`
- `apps/web/src/lib/three/brainchain-office-geometry.ts`
- `apps/web/src/lib/three/brainchain-office-geometry.test.ts`
- `apps/web/src/lib/three/brainchain-office-labels.test.ts`
- `apps/web/src/lib/three/brainchain-office-transition.ts`
- `apps/web/src/lib/three/character-positions.ts`
- `apps/web/src/lib/three/collision/world-colliders.ts`
- `apps/web/src/lib/three/kelp-forest-transition.ts`
- `apps/web/src/lib/three/merged-seaweed.tsx`
- `apps/web/src/lib/three/navigation-path-step.ts`
- `apps/web/src/lib/three/navigation-path-step.test.ts`
- `apps/web/src/lib/three/npc-controller.tsx`
- `apps/web/src/lib/three/player-avatar.tsx`
- `apps/web/src/lib/three/player/player-capability-controller.tsx`
- `apps/web/src/lib/three/player/player-frame-contract.test.ts`
- `apps/web/src/lib/three/player/player-input.ts`
- `apps/web/src/lib/three/venue-walk-in.ts`
- `apps/web/src/lib/three/world-input-guard.ts`
- `apps/web/src/lib/three/world-input-guard.test.ts`
- `apps/web/src/lib/world-frame-interaction.ts`
- `apps/web/src/lib/world-frame-interaction.test.ts`
- `apps/web/src/lib/world-renderer-mode.ts`
- `apps/web/src/lib/world-renderer-mode.test.ts`
- `packages/shared/src/constants/map-locations.ts`
- `packages/shared/src/constants/world-colliders-data.ts`
- `packages/shared/src/constants/brainchain-office-world.test.ts`
- `packages/shared/src/index.ts` (only the `brainchain-office-world` export line)

2D renderer host, movement and world scale:

- `apps/web/src/components/pixi/PixiCanvas.tsx`
- `apps/web/src/components/pixi/WorldStage2DHost.tsx`
- `apps/web/src/components/pixi/WorldStage2DHost.test.tsx`
- `apps/web/src/lib/pixi/brainchain-navigation.test.ts`
- `apps/web/src/lib/pixi/client-pathfinding.ts`
- `apps/web/src/lib/pixi/pixi-world-scale.ts`
- `apps/web/src/lib/pixi/pixi-world-scale.test.ts`
- `apps/web/src/lib/pixi/use-camera.ts`
- `apps/web/src/lib/pixi/use-game-loop.ts`
- `apps/web/src/lib/pixi/use-game-loop.test.ts`

Game HUD, page and 2D party recovery:

- `apps/web/src/app/(world)/game/page.tsx`
- `apps/web/src/app/perf/stage/stage-proof.tsx`
- `apps/web/src/components/game/activity-lobby-modal.tsx`
- `apps/web/src/components/game/activity/activity-2d-recovery.tsx`
- `apps/web/src/components/game/activity/activity-2d-recovery.test.tsx`
- `apps/web/src/components/game/activity/activity-request.ts`
- `apps/web/src/components/game/activity/use-party.ts`
- `apps/web/src/components/game/location-hud.tsx`
- `apps/web/src/components/game/location-prompt-text.ts`
- `apps/web/src/components/game/minimap.tsx`
- `apps/web/src/components/game/mobile-controls.tsx`
- `apps/web/src/components/game/sidebar-menu.tsx`
- `apps/web/src/components/game/world-map-modal.tsx`

API activity queue (reviewed B3a and R2 correction only):

- `apps/api/src/services/activity/activity-queue.ts`
- `apps/api/src/services/activity/__tests__/activity-queue.test.ts`
- `apps/api/src/routes/activities.ts` (party batch admission and `matchedActivityId` on queue status)

Documents:

- `3dStructure.md`: cron-automation footprint drift fix, Office review notes, 2D adapter sections.
- `WorldContent.md`: Office geometry section, stale town-prop coordinates, Office review notes.
- `GameFeatures.md`: only "2D town access", the 2D review correction and "2D party recovery correction".
- `ARCHITECTURE.md`: only "Activity party cancellation and 2D recovery".
- `FOUNDER-REVIEW.md`: the BrainChain 2D town and 2D party recovery review entries.
- `docs/brainchain-world-source-checkpoint.md`: this file.

## Test correction in this checkpoint

`apps/web/src/lib/three/basis-transcoder-prefetch.test.ts` failed on the reviewed `page.tsx` source.
Its regex required the mount effect to call `preloadWorldAssets()` with no inner block.
The reviewed source now calls it only when the renderer is 3D, so the 2D path loads no world GLBs.
The test now requires that 3D gate. Application behavior did not change.

## Checks run on itachi222 for this checkpoint

All checks ran on the shared working tree, not on an isolated checkout of this commit.

| Check | Result |
|---|---|
| `packages/shared` `brainchain-office-world.test.ts` | 5 pass, 0 fail, 212 assertions |
| Web pure world group (12 files: stage navigation, scene id, presence route, frame interaction, renderer mode, path step, Office geometry, Office labels, terrain decorations x2, Pixi scale, BrainChain navigation) | 89 pass, 0 fail, 5,378 assertions |
| `player-frame-contract.test.ts` | 26 pass, 0 fail, 41 assertions |
| `world-input-guard.test.ts` | 3 pass, 0 fail, 17 assertions |
| `use-game-loop.test.ts` | 9 pass, 0 fail, 19 assertions |
| `WorldStage2DHost.test.tsx` (Pixi mock) | 2 pass, 0 fail, 186 assertions |
| `activity-2d-recovery.test.tsx` (jsdom, mocked HTTP) | 8 pass, 0 fail, 20 assertions |
| 29 existing web suites that import changed files, one process each | 600 pass, 0 fail, 69,085 assertions after the test correction (first run: 1 fail in `basis-transcoder-prefetch.test.ts`) |
| `apps/api` `activity-queue.test.ts` (mocked database) | 42 pass, 0 fail, 106 assertions |
| `apps/api` `activities-party.test.ts` | 4 skip: needs `DATABASE_URL`; not run against the shared fixture |
| Web `tsc --noEmit` (incremental, full working tree) | exit 0 |

Earlier evidence that this checkpoint did not repeat: the web production build and the separate web typecheck in `.brainchain-work/web-build-configured-authority.log`. That log covers the full working tree, not this commit alone.
No package output was built. No `bun run dev` ran. No browser check ran: the browser host is unavailable.

Line endings: 12 new web files keep the CRLF or trailing-whitespace bytes that review read, for example `apps/web/src/lib/three/venue-walk-in.ts` and `apps/web/src/lib/world-renderer-mode.ts`. This checkpoint does not normalize them.

## Dependencies outside this commit

This checkpoint depends on uncommitted application integration in the same worktree:

- `apps/web/src/app/(world)/brainchain/` holds the Office DOM page that `/brainchain` navigation opens. It contains the Office panel, so it stays outside this world scope.
- `packages/shared/src/index.ts` still exports `constants/brainchain` and `constants/brainchain-purchase` only in the working tree. The world files use no symbol from those modules.
- The Office Guide system agent, the knowledge surfaces and the agent action routes stay in the separate backend and knowledge work.

A build of this commit alone is not proved.

## What this checkpoint does not prove

- Staging deployment, `SOURCE_COMMIT`, health and authenticated staging parity for humans and bound agents.
- Final browser checks on the new production bundle: real-player 3D walks, 2D Office entry, two-client party recovery and a real pointer on Continue in 2D.
- Device checks: the phone and iPad matrix, and a real iPad safe-area screenshot.
- Performance: Iris Xe sustained FPS, draw calls and GPU bytes on WebGPU and forced WebGL.
- PostgreSQL commit and crash behavior of the queue correction. The queue tests use a mocked transaction model.
- The E3 Codex review pass on the 3D work.
- Mainnet money, settlement and production acceptance.

PARITY: human path: Office world entry and 2D/3D navigation; agent path: bound-avatar navigation and reviewed world action routes; settlement: existing avatar resolution, authenticated staging proof still pending.
