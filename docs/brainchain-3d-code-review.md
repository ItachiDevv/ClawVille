# BrainChain Office: Claude 3da code review

**Verdict: BLOCKING ISSUES (3).** I did not approve the code. Three defects need code changes before approval. I did not edit, commit, or push any file. Bash was denied, so I ran no tests. I read the source, used binary grep on the GLBs, and looked at the images myself.

## BLOCKING ISSUES

**B1. Typing in any text field stops the movement frame (new regression).**
- **Where:** `apps/web/src/lib/three/world-input-guard.ts:8-11`. The function `isWorldInputBlocked()` returns true when `document.activeElement` is editable.
- **Callers that return early from the whole frame:**
  - `player/player-capability-controller.tsx:140`
  - `npc-controller.tsx:157`
  - `pixi/use-game-loop.ts:56`
- **What breaks:** On `/game`, focus in the chat bar stops click-path walking, gravity, `onAfterMove` proximity, and the client walk in `autonomous` mode. `player-avatar.tsx:276-284` confirms that autonomous mode runs this frame, so the avatar freezes while the human types to their own agent.
- **Fix:**
  - Use the frame-level early return only for `isWorldServicePanelPath(pathname)`.
  - For text focus, keep the existing keydown guards (`player-input.ts:88-92`, `npc-controller.tsx:96`). Do not skip the frame.
  - Add a test: a textarea has focus on `/game` and `clickPathIndex` still advances.

**B2. The guide approach point is too close to the edge of the talk circle.**
- **Where:** `packages/shared/src/constants/brainchain-office-world.ts:20-23`. The point `guide + (-200, +80)` is 215.4 wu from the guide. The talk radius is 220 wu, so the margin is 4.6 wu.
- **Why it fails:** The followers stop when they are less than 6 px from the waypoint. If the avatar comes from outside the circle, it can stop at 221 wu. Then `openBrainchainOffice(true)` returns false and nothing opens.
- **Fix:**
  - Move the point to about `guide + (-150, +100)`. That is 180 wu from the guide, with a 40 wu margin. By my hand calculation, it is walkable on the client grid: col 364, row 272.
  - Add a test like the door's 96 wu disc test. Every point within 12 wu of the approach must be in the guide zone and outside the door zone. Run the test on both planners.

**B3. The new Office path follower can overshoot a waypoint and move back and forth.**
- **Where:** `apps/web/src/lib/three/npc-controller.tsx:287-301`.
- **Why it fails:** `SPEED` is 550 px/s. Each frame the body moves 9.2 px at 60 FPS. With Shift held it moves 18.6 px, because the run multiplier is 2.025 and Shift does not clear the path. At the 40-45 FPS Iris Xe baseline, a walk step is 12.2-13.8 px. A step larger than 12 px can jump over the ±6 px arrival window. The body can then move back and forth at the waypoint.
- **Why the risk is higher now:** `client-pathfinding.ts` no longer smooths paths. Each 32 px tile is now a waypoint, so a path has many more waypoints.
- **Fix:**
  - Limit each frame's movement to the distance that remains to the waypoint.
  - Or count the waypoint as reached when its distance is less than or equal to this frame's step.
  - Find the walk speed in `player-avatar.tsx:322-362`. If its step can be more than 12 px, apply the same fix there, because minimap and autonomy-store paths also use that code.

## Required follow-ups (not blocking the code review)

- **N1. The texture has no mipmaps.**
  - `optimize-office.mjs:38` does not ask toktx for mipmaps, and `report.json` records `mipLevels: 1`. The WebGL probe also shows 1 level and 1,048,576 GPU bytes.
  - From spawn the building is about 3,400 wu away, so the atlas can shimmer when the camera moves.
  - I accept the provisional 700 KiB cap for this code review only. The condition: moving-camera captures at P1 and P2 must show no shimmer.
  - If it shimmers, add `--genmipmap`. That costs about 33% more bytes, and the lead must decide the cap again. The GPU size with mips is about 1.33 MiB, which is still within 1.5 MiB.
  - Close range is clean. The UASTC front and 3/4 images match the PNG control, and the 512 image shows the seams.
- **N2. The guide reuses Plankton.**
  - The resident Plankton stands at about (1430, −2486). That is 903 wu from the guide, so both figures can be on screen together.
  - The guide is scaled to 179 wu. The resident is about 94 wu tall.
  - The guide also renders when `showNpcs` is false.
  - The lead must make a visual decision. I recommend a different model that is already loaded.
  - The skeleton is safe: binary grep finds no `skins` or `JOINTS_0` in `plankton-ktx.glb`, so `clone(true)` is correct. It adds 1 draw and uses the same GPU texture as the resident.
- **N3. The Office bytes load first.**
  - `brainchain-office.tsx:24-27` preloads with priority `-Infinity`. This puts 697 KB, 3,133 wu away, before all nearer post-reveal content.
  - Fix: use `bootStreamPriority(BOOT_STREAM_TIER_PROPS, center.x, center.z)`.
- **N4. `BRAINCHAIN_OFFICE_EXIT_WORLD` is dead code.** No runtime code uses it, but `3dStructure.md:13` says a return position exists. Use the constant or delete it, and fix the doc line.
- **N5. Path search cost went up.**
  - The search limit changed from 6,000 to 80,000 expansions, and the keys are still strings.
  - Measure a minimap click on an unreachable point on Iris Xe. If it takes more than 50 ms, change to integer cell indices and typed arrays.
  - Memory is not a problem. The new grid is 496 KB of `Uint8Array`, which is smaller than the old 360×360 boolean arrays.
- **N6. Two different byte counts are in use.** The asset in the repo is 696,692 bytes (RDO2), not 665,580 bytes. Use one value everywhere.
- **N7. No test checks the land parcels.** By my calculation the margin is about 2,000 wu. Add a cheap assertion.

## What I confirmed

- **Model fit:** The model measures 588 × 694.6 × 486.4 wu inside the 600 × 500 collider. I recomputed this from the report bounds; the scale is 365.2.
- **GLB content:** 1 mesh, 1 primitive, 1 material, 11,311 triangles, and 1 draw. It uses meshopt, mesh quantization, and basisu.
- **Colliders:** The server and client use the same constants and assert placement when the module loads.
- **Lane clearance (my calculation):** 60 wu outside the N lane and 72 wu outside the NNE lane.
- **Residents:** SpongeBob's stand is 583 wu from the guide.
- **Door approach:** It is 24 wu outside the pathfinding halo and inside the door band.
- **Render rules:** There is no drei `<Text>` or `<Billboard>`. The proximity checks allocate nothing.
- **Loading:** The Office uses the post-reveal lane and is not in the boot cohort. No boot preloader reads the manifest entry.
- **Entry:** Crossing the band never enters automatically. Explore mode works the same way as the Trading Floor.
- **Agent arrival:** The 96 wu arrival radius fits inside the door band. `agent.visit` has no score weight.

## Gates still open (no visual evidence yet)

- `office-world-initial.png` is a blank dark frame. No actual world screenshot exists.
- Screenshots are needed at poses P1-P4, on phone and iPad in portrait and landscape, on WebGPU and on forced WebGL.
- The perf HUD numbers (draws, triangles, pipelines) are not measured.
- Sustained FPS over 60 s on Iris Xe or a named machine is not measured.
- The shimmer check from N1 is not done.
- The Codex review under E3 is not done.
- The founder has not signed off (E4).

I make no claim of overall 3D acceptance. Claude makes the final commit and push after all code and visual gates pass.
