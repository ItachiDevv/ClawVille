# Claude 2D integration decomposition

Source: actual Claude read-only review, 2026-11-09. Session 3e49509f-140d-4602-8c11-15ad1acddec1.

I read the code with Read, Grep and Glob only. I ran no tests or builds, and I edited no files. Every finding below comes from reading the source. I state no runtime result.

## Verdict

The 2D world cannot be reached today. Mounting `PixiCanvas` is not enough. Five blocking traps (T1–T5) make it unusable even after a mount. The plan below adds a 2D host to the existing stage. It keeps the 3D path the default and leaves it unchanged.

## What the code shows

- **No mount.** `app/(world)/layout.tsx:14-15` mounts only `WorldPresence` and `WorldStageRoot`. `WorldStageRoot.tsx:797-809` always mounts `WorldStageCanvas`. Nothing imports `PixiCanvas`.
- **Failure screen is a dead end.** When both WebGPU and WebGL fail, `WorldStageRoot.tsx:827-846` shows "couldn't start the 3D view" with only a Reload button. This is the natural place to switch to 2D.
- **Navigation needs scene acknowledgements.** `/game` and `/brainchain` both map to the `world` scene (`stage-scene-id.ts:9-11`). With no pending request, ownership is `SUPERSEDE` (`stage-navigation-ownership.ts:29-31`). That starts a stage request. `StageTransition.tsx:204-228` fades in only after three acknowledgements for that generation: scene ready, camera installed, first controlled frame. With no canvas, nobody sends them. The watchdog then fails the transition. The Office "Back to town" button (`brainchain-office.tsx:131-135`) and `openBrainchainOffice` both use this path.
- **Presence belongs to the route, not the renderer.** `WorldPresence.tsx:21-58` picks the policy from the pathname. `use-world-stream.ts:110` uploads `avatarPositionRef` in game pixels. `world-presence-controller.ts:373` uploads only in `player` and `npc` modes. The 2D path keeps server position identity only if it writes the same ref, in the same pixel frame, under the same mode rules.
- **The 3D proximity source is richer than the 2D one.** `player-avatar.tsx:381-399` checks the Office door and guide, the nearest resident, Cove, Trading Floor, Kelp and Nori's `nearGuide`. The E key (`:297-315`) and path completion (`:333-340`) send each of these to its own transition.

## Blocking traps

1. **T1 – The scale makes the world invisible.** `PixiCanvas.tsx:335` uses `max(view/MAP)`. The map is 22,528 px (`tilemap-data.ts:19-23`). At 1440×900 the scale is about 0.064. The 72 px avatar and the 40 wu guide dot draw at under 5 screen pixels. The camera clamp (`use-camera.ts:45-48`) then pins the camera at 0, so it never follows.
2. **T2 – The ground costs too much to build.** `PixiCanvas.tsx:340-355` draws 495,616 tiles into one `Graphics`, each a rect plus two or three blade strokes. That is over 1.5 million path commands at mount, on the weakest devices. I did not measure the cost. It must still be replaced: one solid fill plus one `TilingSprite` from a small texture.
3. **T3 – Control modes are ignored.** `use-game-loop.ts` always moves the player's avatar.
   - In `npc` mode, the 3D controller moves the possessed NPC and then mirrors it (`npc-controller.tsx:312-315`, `:391-392`). The 2D loop does not.
   - The spectator branch (`:61-108`) writes `setAvatarPosition`, which also writes `avatarPositionRef`. Explore mode would teleport the real body.
   - Input is not blocked in `autonomous` mode.
4. **T4 – The 2D proximity and click rules do not match 3D.**
   - 2D uses zone-box containment (`use-game-loop.ts:237-256`), not resident proximity.
   - The E key (`:133-145`) handles no Nori, Cove or Trading Floor.
   - The click-path follower handles only Office targets (`:169-184`), so minimap clicks, label walks and venue walk-ins do not move the 2D avatar.
   - A building click calls `enterBuilding` from any distance (`PixiCanvas.tsx:400-404`). This skips proximity.
5. **T5 – Bundle and lifecycle leaks.**
   - `triggerCoveWalkIn` and `triggerTradingFloorWalkIn` live in the R3F module `arena-buildings.tsx:293-304`. If the 2D path imports them, it loads the 3D buildings module.
   - `game/page.tsx:378` preloads all world GLB/VRM files even in 2D.
   - `SeaLoadingScreen` (`page.tsx:653`) waits for `__W3D_*` flags. In 2D it reaches only the 45 s fuse. It has a `forceReady` prop (`sea-loading-screen.tsx:297`).

Non-blocking defects. Fix them in the same diff:
- `PixiCanvas.tsx:575-576` and `use-camera.ts:27` read the 10 Hz throttled `avatarPosition` (`game.ts:880-889`), so the avatar steps 10 times per second. They should read `avatarPositionRef`.
- Footsteps make a new `Graphics` every 120 ms (`:624-648`). Use a fixed pool.
- NPC sprites are never removed when an NPC leaves (`:665-699`), so departed players stay on screen.
- Sprite lookup ignores `MODEL_KEY_TO_LEGACY_SPECIES` (`agent-model-registry.ts:333`), so every model key falls back to `cat`.
- In NPC mode, the player sprite and the possessed NPC both draw, which duplicates the body.
- Pixi `^8.2.6` might have no canvas backend. I did not check the installed version. If WebGL is also missing, only the DOM Office page stays reachable. The door/guide/map requirement then stays explicitly unmet for that device class.

## Renderer selection and life cycle

- **Choose the mode once, before the stage mounts.** Order: the `?view=2d|3d` query (also written to sessionStorage), then the sticky sessionStorage value, then the default `3d`. Do not probe the GPU first: a probe creates a second context. Do not auto-select 2D by device class; that is a founder decision on performance.
- **Switch at runtime with a reload.** A user toggle reloads with `?view=…`. This keeps the one-canvas-per-session invariant and leaves the 100-transition probes valid.
- **The failure path switches in place.** The failed canvas has no live resources. The overlay gets "Continue in 2D". It sets the sticky value and mounts the 2D host, which takes over the pending `world` request.
- **The 2D host is a stage adapter, not a new pipeline.** It registers scenes and mounts `PixiCanvas` once at stage-root level, so the Pixi app survives `/game` ↔ `/brainchain`.
  - For each pending `world` request it calls `setSceneWarming`, then (after the first Pixi frame) `ackReady`, `ackCameraInstalled` and `ackFirstControlledFrame`, in that order. `ackFirstControlledFrame` requires the camera acknowledgement for the same generation.
  - In 2D, a request for a non-world scene is refused before any fade. A new pure predicate `isStageSceneAvailable(sceneId)` does this check. The Cove, Trading Floor and Kelp triggers call it and show a "needs the 3D view" toast. A cold load of `/cove`, `/kelp` or `/trading-floor` in 2D shows a DOM notice with "Back to town".
- **Input exclusivity.** In 2D, none of the 3D scene content mounts: no player controller, no NPC controller, no WASD camera, no follow camera. The Pixi keyboard is the only world input. The right (orbit) joystick hides in 2D. The 2D camera must take the same warp snap signal as the 3D follow camera (`warp-overlay.tsx:60-75`; I did not read the signal name).
- **Server position identity.**
  - `player`: write `avatarPositionRef` in game pixels.
  - `npc`: `moveNpc` the possessed NPC, then call `setAvatarPosition`.
  - `explore`: move a separate camera-target ref and never `avatarPositionRef`.
  - `autonomous`: take no input and follow `autonomousBodyId` from the NPC store.
  - Presence code stays unchanged.

## Decomposition (one deliverable per task, disjoint files)

| Task | Deliverable | Only files the owner may edit |
|---|---|---|
| A. Mode and host | Resolver, 2D host, root selection, failure button, probe reports backend `2d` | new `apps/web/src/lib/world-renderer-mode.ts` + `.test.ts`; new `apps/web/src/components/pixi/WorldStage2DHost.tsx` + `.test.tsx`; `apps/web/src/components/three/world-stage/WorldStageRoot.tsx` |
| B. Shared interaction | Pure proximity, E-edge and path-completion dispatch taken out of the player avatar, with no behavior change; walk-in triggers moved into a module without three.js; `arena-buildings.tsx` re-exports them | new `apps/web/src/lib/world-frame-interaction.ts` + `.test.ts`; new `apps/web/src/lib/three/venue-walk-in.ts`; `apps/web/src/lib/three/arena-buildings.tsx`; `apps/web/src/lib/three/player-avatar.tsx`; `apps/web/src/lib/three/kelp-forest-transition.ts` (availability guard) |
| C. 2D loop | Control-mode rules, generic click-path follower (6 wu final tolerance, completion after proximity, idle when blocked), shared dispatch, ref-based camera with fixed zoom | `apps/web/src/lib/pixi/use-game-loop.ts` + new `use-game-loop.test.ts`; `apps/web/src/lib/pixi/use-camera.ts` |
| D. Pixi scene | Fixed zoom (about 2,000–2,400 wu across), tiled ground, building click walks there, hit areas ≥44 CSS px, sprite pooling, stale NPC removal, legacy species map, one body per mode | `apps/web/src/components/pixi/PixiCanvas.tsx`; new `apps/web/src/lib/pixi/pixi-world-scale.ts` + `.test.ts` |
| E. HUD | `forceReady` from 2D first frame, no 3D preload in 2D, right joystick hidden, 2D/3D toggle (reload) | `apps/web/src/app/(world)/game/page.tsx`; `apps/web/src/components/game/mobile-controls.tsx`; `apps/web/src/components/game/sidebar-menu.tsx` |
| F. Docs and evidence | Same-diff docs and the browser evidence script | `3dStructure.md`, `GameFeatures.md`, `README.md`, `FOUNDER-REVIEW.md`; ignored `.brainchain-work/` scripts |

Order: B starts first, then A and C (they need B's dispatch), then D and E, then F. Under E3, Codex implements and a separate Claude reviewer reviews; the lead commits. There is no agent-visible behavior change, so there is no `PROTOCOL_VERSION` bump. PARITY note: the human 2D path uses the same routes and stores; the agent path stays unchanged (MCP/hosted); settlement binds through the unchanged server resolvers.

## Acceptance tests (none run yet)

Unit:
- **Resolver precedence.** The mode does not change mid-session.
- **Host acknowledgements.** For a pending `world` request, the acknowledgements arrive in order and the transition completes. After 30 `/game` ↔ `/brainchain` round trips there is one Pixi app mount and no listener delta. A non-world request in 2D returns `false` and leaves no stuck overlay.
- **Shared interaction.** A table test gives the same inputs to the 3D adapter and the 2D loop. Both must produce the same `nearLocation`, `nearGuide` and `nearCharacter`. The E dispatch must be correct for the Office, the guide, Cove, Trading Floor, Kelp, a building and Nori. Existing `player-frame-contract.test.ts` and `navigation-path-step.test.ts` must still pass.
- **Loop mode matrix.** `player` moves the ref. `npc` mirrors the NPC. `explore` leaves the ref unchanged. `autonomous` ignores input. A generic minimap path enters a building. A blocked path goes idle.
- **Scene.** The ground builds a constant number of display objects. The Office and guide hit areas are ≥44 CSS px at 390×844. The pool size stays constant after N ticks.

Browser (production bundle, `?view=2d` and forced renderer failure):
- Office door and guide by click and by E, then return to town.
- Minimap walk and World Map warp.
- Joystick at the 8 required sizes, portrait and landscape.
- Intercepted presence uploads must equal `avatarPositionRef` in game pixels.
- A Cove trigger in 2D must show the honest notice.
- The existing 3D stage probes must pass unchanged with the default mode.
- An Iris Xe 2D FPS sample.

Open: a real-iPad safe-area check. A no-WebGL device keeps only the DOM Office. Record that as unmet for that device class.
