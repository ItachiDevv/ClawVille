# BrainChain local browser evidence

Date:2026-11-09. Machine:itachi222. Browser:isolated Chrome156 through CDP9333.

## Latest private earnings check: 16:01 UTC

Strict production build web-build-earnings.log exited0 with CLAWVILLE_STRICT_TS=1.
The managed preview used task1523aed9-b90d-41d9-a305-a12cd64a61cb on itachi222.
The private-device probe exited0. Root viewed all eight screenshots after transition completion.
Sizes were390x844,744x1133,820x1180,1024x1366 and their landscape equivalents, at DPR2 with touch emulation.
All eight captures showed readable earnings content without horizontal overflow or overlapping controls.
Earnings buttons and selects measured at least48px high. Long transaction hashes wrapped inside the panel.
The probe covered separate wallet/stake balances, a readable unlock date, stale observations, receipt coverage and empty pagination.
A forced503 response displayed the observation error. The probe recorded zero browser exceptions.
Evidence: .brainchain-work/private-devices/report.json and adjacent screenshots.
The first capture attempt showed the transition overlay; those earlier captures do not count as visual evidence.
All private responses used synthetic browser fixtures. This proves neither real authentication nor live chain settlement.
Actual human/agent staging parity and real-iPad safe areas remain unverified.
Later identity-interface source changes require a new bundle and separate verification.

## World map and minimap: 16:12 UTC

The earlier preview process ended. Root confirmed both process IDs absent and port3000 refused connections before restart.
New preview taskd31a042f-53a4-46c3-af45-56336867a43d returned HTTP200 for /game.
Its rootPID is76596; supervisorPID is65920; loadID is86db5d44-6fb8-4f41-97c3-8c424c820e42.

Root opened the actual World Map button in a forced local player fixture.
Hovering the pink Office marker displayed BrainChain Office. Clicking it used the normal warp controller.
Position changed from12464,9164 to12024,8664. The map closed and nearLocation became brainchain-office.
The game stayed on /game. Root viewed office-map-open.png and office-map-warp.png.

Root then clicked the Office minimap marker through its pointer handler.
The path planner produced three waypoints and moved the player to11984,8656 after tile snapping.
The path cleared and nearLocation became brainchain-office. Root viewed office-minimap-walk.png.
Raw evidence: .brainchain-work/office-map-warp.json and office-minimap-walk.json.
These checks use forced local player state. They do not prove authenticated identity or server settlement.
Joystick, sprint, staging identity parity and real-iPad safe areas remain separate checks.

## Earlier checks and corrections

The production bundle compiles. An explicit web TypeScript check exits0.
The bundle build omitted CLAWVILLE_STRICT_TS=1, so it does not itself prove type validation.
The separate check supplies that evidence: .brainchain-work/web-typecheck-current.log.

The public Office renders at390x844,744x1133,820x1180 and1024x1366, in both orientations.
The device probe visits all six tabs at each size. All tabs report selected content and no document horizontal overflow.
The minimum measured tab height is49px. Touch detection reports true in each case.
Screenshots and the raw report reside in .brainchain-work/devices/.
The lead viewed the phone portrait/landscape and tablet examples.
Private account controls require a real authenticated session and remain unverified by these captures.
The public harness rejects private operations. It uses actual knowledge/status route implementations.
Real-iPad safe-area behavior remains a separate device check.
Inline Sign in links require a measured44px target check; the UI owner has that follow-up.

The first screenshots captured the transition overlay and are not acceptance evidence.
The corrected probe waits15seconds before capture. Do not infer visual success from DOM nodes behind an overlay.

The managed preview restart first failed with EADDRINUSE.
The retained old task survived the helper's Stop signal and served obsolete chunk references after the rebuild.
The lead verified its full process ancestry and stopped only its owned root72492.
Its descendants then exited, and a port3000 request failed before restart.
The replacement task a2942405-45ad-4507-9d0d-0418cbb03dcd starts the current bundle; root39188, supervisor25092.

The full game scene has not passed visual verification. Initial captures remained at0percent asset load with no world-ready marker.
A foreground-tab rerun investigates background frame throttling. No hardware FPS claim exists.
Actual Claude source review runs separately; it does not establish scene or founder acceptance.

## Verified scene controls and current preview

The foreground game tab now reaches the world-ready marker on itachi222.
The first WebGPU model showed severe texture corruption; the WebGL2 comparison rendered coherent surfaces.
The first Float32 comparison was invalid: the service worker returned the old696692-byte asset.
Network.setCacheDisabled alone did not bypass that response.
The evidence script now uses Network.setBypassServiceWorker before navigation.

The raw PNG control returned2971272bytes with SHA2567cbc9950491f5a63ac66f1b1772b1f6d16750ad14af1dbdd1069282d892962d8.
Scene inspection confirmed Float32 attributes and an uncompressed PNG texture.
The lead viewed world-office-webgpu-raw-verified.png: both facade sides have coherent colors and windows.
The model still has visible geometric facets. The close camera clips the roof.
This control does not establish acceptance of the compressed production asset.
The public model path currently contains this diagnostic control and must not ship in that state.
The source fixes and44px link changes still require a new production bundle.

Managed taska2942405 stopped before this resumed browser check.
The current preview uses taskb345ae90-c097-4ff0-949a-3ac51d3174c6, root28812, supervisor27852.
Its page serves the world scene. The full visual and sustained-performance checks remain open.

The corrected Float32 KTX control returned892396bytes with SHA256503e67b4400a6f4f6f90837dd9598d78b1e9365f7ca7b8f7997c7347cd862241.
Scene inspection confirmed Float32 positions, normals and UVs, with BC7 single-mip texture.
The lead viewed world-office-webgpu-float32-verified.png: both facade sides render coherent windows and colors.
The previous corrupted comparison therefore does not establish a KTX-only failure.
The world owner now isolates quantized attributes and adds mipmap review. Final asset selection remains open.


## Final mipmap bundle and further review

Strict production build web-build-final-world.log exited0, including TypeScript validation.
The new managed preview task is e2a54639-63e1-4c5e-9162-7c1fd92de48e, root59792, supervisor75080.
The browser loaded963764bytes with SHA2569b5e625433ef97fcf5bb65143ed117da53794282471458dccce12339154ae752.
Scene inspection confirmed Float32 positions/normals/UVs and11BC7 mip levels.
The lead viewed final close, context and distant screenshots. The previous severe facade corruption is absent.
The actual Office label opened /brainchain; Back to town returned /game with world-ready true.
These captures use Explore mode and do not establish authenticated approach or agent execution.

The foreground desktop WebGPU sample ran60seconds with small zoom changes every2seconds.
It recorded3601RAF frames, mean60.0005FPS, p9516.8ms,p9916.8ms and maximum18.1ms after the firstfive samples.
Observed draw calls ranged215–227. Raw timings: .brainchain-work/office-perf-result.json.
This is desktop evidence, not Iris Xe evidence or a before/after performance comparison.

Actual Claude source re-review accepts the Float32 workaround and closes B1–B3.
It identifies B4 waypoint idle frames and B5 labels visible before model warmup.
The world owner corrects both; this bundle therefore is not the final release candidate.
Source report: docs/brainchain-3d-source-rereview.md.

The latest background device screenshots again captured the transition overlay despite correct DOM dimensions.
Those screenshots are invalid visual evidence. The corrected device script now brings each tab to the foreground.
The new foreground matrix rerun is in progress. Do not infer visual acceptance from the old DOM-only report.
The44px minimum-width correction also requires the next bundle.

Foreground device rerun exec69193 exited0. All8screens show the actualOffice panel; thelead viewed every screenshot.
All6tabs per size have selected content, nohorizontaloverflow,49pxminimumtabheight and44pxminimumlinkheight.
Thepending44pxminwidthCSS requiresrebuild; thisreport doesnotassertwidthacceptance.


## B4/B5 bundle and actual demo walk

Strict build web-build-b4-b5.log exited0. Root reloaded the production bundle with service-worker bypass.
The world reports WebGPU and ready=true. Root viewed world-office-b4b5-close.png and world-office-b4b5-context.png.

Root selected NPC Mode through its button and placed the local demo NPC near the Office with the existing store helper.
Root then clicked the actual BrainChain Office label. The normal path planner and frame controller moved the NPC.
The four-point path ended at game coordinates12024,8664. Arrival took approximately1247ms.
Of302 observed animation frames,75 had an active path; none of those75 reported an idle direction.
The original label click opened /brainchain after arrival. Root viewed office-npc-arrival.png.
Raw evidence: .brainchain-work/office-npc-walk.json.
This proves the local demo NPC click-and-approach path. It does not prove bound-agent identity, real CT, keyboard entry, or joystick input.
Actual Claude B4/B5 source re-review remains in progress.

## New-bundle device verification

The new-bundle matrix exited0. Root viewed all8 public setup screenshots.
The six tabs selected their content at every size. No horizontal overflow or overlapping content appeared.
A separate DOM bounds check measured every main-panel link at each required size.
The minimum width and height were44px in all8cases; tabs remained49px high.
Evidence: .brainchain-work/devices/report.json and link-bounds.json.
This covers public and unauthenticated Office states, not private worker forms or real-iPad safe areas.

Actual Claude third source review found B6 (player coordinate frames) and D1 (arrival callback ordering).
Report: docs/brainchain-3d-b4b5-code-review.md. The NPC path evidence does not cover either affected player path.
The world owner now corrects these findings. This bundle is not the final release candidate.

## B6/D1 production-bundle player controller

Strict build web-build-b6-d1.log exited0 after the last source edit.
Actual Claude source review approved B6/D1: docs/brainchain-3d-b6d1-code-review.md.
The review does not establish all visual controls or founder acceptance.

Root forced local player mode and placed its body at12464,9164 through existing store helpers.
The production PlayerAvatar controller then followed the actual Office label click to12024,8664.
It arrived in1236.8ms and opened /brainchain. Root viewed office-player-arrival.png.
There were75active-path samples and zero identical consecutive active positions.
The initial probe used an absent direction field, so it does not prove animation-direction continuity.
Raw evidence:.brainchain-work/office-player-walk.json. This tests the actual renderer adapter but not authenticated avatar binding.

Root returned through Back to town and placed the player at the Office approach.
The game remained on /game until interaction. A150ms E key press then opened /brainchain.
An initial keydown/keyup pair in one JavaScript task was too brief for frame polling; it did not enter.
Keyboard script:.brainchain-work/office-player-key.js; screenshot:office-player-key-entry.png.
Minimap, world map, generic building entry, joystick, Shift sprint, private forms and IrisXe remain separate checks.

The actual player guide-label path also passed in the forced local fixture.
It used four waypoints, traversed42active frames without an idle movementDirection, and opened /brainchain#office-guide-heading.
Arrival took715.8ms and stopped within the6wu final tolerance at11659.9117,8723.4370.
Root viewed office-player-guide-arrival.png. Raw:.brainchain-work/office-player-guide.json.
This supplies direction evidence for that path, distinct from the earlier door probe's absent direction field.

## Private identity panel and current preview

Strict identity production build exited0. Log: .brainchain-work/web-build-identity.log.
The identity device run exited0 at2026-11-09T16:22:40Z.
Report: .brainchain-work/identity-devices/report.json.
The matrix covers390x844,744x1133,820x1180,1024x1366 and each landscape orientation at device scale2.
All8cases reported no horizontal overflow, idle transition state, and controls at least48px high.
No browser exceptions occurred. A forced503 displayed the expected unavailable-observation message.
Root viewed all8top captures and all8lower captures. Text remained readable without overlap.
The panel preserves exact decimal amounts, long addresses, stale records, frozen status, unknown loan terms, and four credit routes.

All private API responses were intercepted synthetic fixtures. These checks prove no real session, chain association, or available credit.
The fixture used a mainnet worker with requestedState running. Its worker footer is not evidence of permitted mainnet execution.
The identity freshness correction changed server code after this build; it did not change the web or shared UI source.
Independent correction review passed29tests/123assertions. Report: docs/brainchain-identity-credit-code-review.md.
Actual authenticated staging parity and real-iPad safe-area checks remain open.

The managed preview previously returnedHTTP200 on task93270ce2-4e79-49cf-8be1-205f5051f4f0.
Its recorded root70752 and supervisor74820 are now absent; the root recheck received connection refusal on port3000.
Start a new managed preview before further browser checks. Do not describe the earlier process as live.

## Movement and existing teacher regression

The managed preview was restarted from the desktop root checkout with the job's web directory in its launch envelope.
Task3f2db942-b120-4450-9416-a899f704da40, root67160, supervisor73196, loadc487fb6e-89ef-468d-98fb-9068df571672.
The root verified /gameHTTP200. This uses the existing strict identity build; no new source build is implied.

Actual CDP key events exercised KeyD for700ms from the same initial player position.
Normal movement covered394.13game units; Shift+KeyD covered779.625game units. Both ended idle on /game.
Evidence: .brainchain-work/office-input-report.json and office-input-evidence.mjs.

Actual CDP touch events exercised nipplejs and the production player controller at all8required device sizes.
The left joystick moved the player320.09–334.21game units during each350ms hold.
Every touch release restored joystickVelocity to{x:0,y:0}.
Root viewed all8screenshots. Both joystick zones remain visible and separate from the jump control.
Evidence: .brainchain-work/office-joystick-report.json and office-joystick-<width>x<height>.png.

The root also tested the existing code-development teacher interaction after the Office navigation change.
The player started at12695,8975, with nearLocation code-development and chatOpen false.
The actual E key handler opened the Plankton chat panel and retained /game.
Root viewed office-generic-entry.png. No message was sent, and no teacher response was claimed.
Evidence: .brainchain-work/office-generic-entry.json.

All movement checks use forced local player state. They do not prove authenticated identity, real CT, or server-authoritative presence.
Real-iPad safe areas, collision corners, before/after performance and final staging checks remain open.

## Office collider approaches

The root exercised four face approaches and four diagonal corner approaches with actual keyboard input.
Each case held movement for1100ms after initial fixture placement outside the shared solid footprint.
Face approaches stopped25game units outside the solid boundary. Diagonal approaches slid along a boundary.
All8final positions remained outside the Office AABB; the south approach retained the Office interaction target.
Root viewed all8captures. No final player position appeared inside the visible building.
Evidence: .brainchain-work/office-collision-report.json and office-collision-<direction>.png.
These are local player/controller checks, not server-authoritative movement or network reconciliation evidence.
The remaining visual release gaps include reachable2Dworld, before/after performance, real-iPad safe areas and final staging.

## Reachable 2D browser check, 17:21-17:25 UTC

The production web build exited0; log:.brainchain-work/web-build-2d.log.
This build predates later worker start-control and buyer audit corrections.
Managed preview38767d72-a17c-4d4a-bcc9-69c7e6d6edef serves localhost3000 on itachi222.
Root40052,supervisor70728,load67e28e70-ded8-479c-8ace-73bdfd913a41; /game returnedHTTP200.
Separate job-owned headless Chrome root33744 exposesCDP9333. Other browser sessions remain untouched.

The actual /game?view=2d&perf=1 page renders the Pixi world.
Root used the real guest NPC-mode button and keyboard movement, without injecting an authenticated account.
The NPC reached pixel12155,8681 after walking around a town-center obstacle.
After a short west movement, the E key opened /brainchain and the transition returned to idle.
Evidence:2d-office-approach-3.png,2d-office-enter.png,2d-office-enter.json in the ignored work directory.
Root viewed the world screenshots. The Office rectangle, guide marker and NPC are visible.

The first ten round trips retained the exact same canvas element.
A separate50-round-trip probe then exercised100 route transitions through the actual Back to town and E-key handlers.
All50 returns retained one identical canvas; every route transition reached idle.
Evidence:2d-hundred-transitions.json and its probe script.
This checks DOM canvas identity, not GPU allocation or listener counts.

Root found W1: a solid town-center obstacle has no corresponding 2D drawing.
From pixel12099,11754, north movement stops at12099,11484 while the screenshot shows empty ground.
The shared collider list includes town-center props; Pixi currently omits their footprints.
Evidence:2d-office-approach-2.png. The world owner received the finding.
Actual Claude source review remains pending.

These checks prove local guest navigation only. They do not prove authenticated agent identity, real CT, staging presence or Iris Xe performance.

### 2D touch and synthetic renderer failure

The eight required portrait/landscape sizes each displayed one120px movement joystick and no horizontal overflow.
Root viewed all eight captures. The joystick remained visible and separate from other controls.
Seven eastward touch probes moved the guest NPC; the last stopped at the collision boundary14213,8681.
A repeat at1366x1024 moved west from14213,8681 to13893,8681 with the actual touch handler.
Evidence:2d-joystick-report.json,2d-joystick-west-report.json and matching captures.
DOM coordinate samples prove movement, but this probe does not directly read released joystick velocity.

A separate tab forced all initial3D GPU context requests to fail.
The failure card contained Continue in2D. The probe then permitted GPU contexts and invoked the button through DOM click().
This programmatic click bypassed overlay hit testing. It did not prove the button was accessible to a user.
The 2D world rendered, the loading overlay cleared, and the stage reached idle with one canvas.
Root viewed the final capture. Expected synthetic3D context errors remain in the report.
Evidence:2d-forced-failure.json and2d-forced-failure-after.png.
This proves the recovery function under injected context refusal, not a usable pointer path or operation without WebGL.
Claude B1 found the loader covers this button until its fuse. A real pointer test is required after correction.

W1 also affects legacy2D building art: at14213,8681 the shared collider blocks movement before the visible KrustyKrab rectangle.
The correction must align visible footprints with all shared solid colliders.

### Corrected loader: actual pointer check

The corrected production web build exited0: .brainchain-work/web-build-2d-corrections.log.
The managed preview now uses taskda5b0a45-4384-4376-a06c-1ab61a5dd327, root73904, supervisor53276.
Root verified the previous preview root identity before stopping it.

The new test waits for document.elementFromPoint to hit the Continue in2D button, then uses a real browser mouse event.
The button passed hit testing40ms after the test observed the failure card.
The pointer click opened2D, left one canvas, and returned the transition to idle. Root viewed the final screenshot.
Evidence:2d-pointer-failure.json,2d-pointer-failure-after.png and2d-pointer-failure.mjs.
Expected injected GPU errors remain in the report. The result does not prove a device without WebGL can render Pixi.

The earlier guest-NPC minimap entry attempts timed out because the existing minimap intentionally ignores NPC and Explore clicks.
A separate synthetic account/avatar fixture exercised the actual Controlled-mode minimap click.
It walked to11984,8656 and displayed PRESS E / Enter BrainChain Office.
The probe incorrectly expected automatic entry, so its passed field isfalse. This is approach evidence only.
No authenticated server identity or settlement follows from that fixture.
Evidence:2d-player-minimap.json and2d-player-minimap.png. All API requests during that probe used synthetic responses.


## Solana selector and combined party build, 2026-11-09

The combined local production web build returned exit0. Log: .brainchain-work/web-build-party-solana.log.
Root opened the real Office purchase panel with intercepted synthetic account, knowledge and purchase responses.
No real session, wallet signing, payment or server parity was exercised.
The knowledge fixture predates the final curriculum and is not served-manual proof.

The selector chose Solana devnet at390x844,744x1133,820x1180,1024x1366 and each landscape orientation, device scale2 and touch enabled.
Each measured selector height was44CSS pixels. No document horizontal overflow or page exception occurred; one canvas remained.
Root inspected all eight screenshots. The selector and its explanatory text remained legible and unobstructed.
Screenshots: .brainchain-work/solana-devices/<width>x<height>.png.
The report preserves viewport dimensions separately from control dimensions; an initial report collision was corrected and rerun.
Real iPad safe areas and an actual browser wallet remain unverified.

The built Solana SDK marker chunk0m63z8jhnwxeg.js is216846bytes and did not appear among43observed script responses before any wallet action.
This supports delayed loading for the tested Office and Hire tab flow. It is not a before/after performance benchmark.
Evidence: solana-selector-browser-evidence.json beside this document.

The initial UI probe clicked the server-rendered tab before React handled events and timed out.
The corrected probe waited for the selected-tab state. That failure did not establish an application defect.


## B3a R1 actual-browser transition

Root exercised the compiled production page on itachi222 with synthetic intercepted identity, party and room responses.
The pointer selected the Office minimap marker. The avatar walked there, and the E key entered Office.
A party departure remained unresolved; the browser retried it during the walk.
Queue-status polling continued after the Office transition and received an exact assigned room.
The browser navigated to /activity/reef-race/assigned-room?shortCode=ABC123&view=3d.
The destination document was intercepted; no actual room or server session exists from this test.
No page exception occurred. Report:2d-party-office-browser-evidence.json.

The first probe assumed the avatar spawned beside Office and timed out at the proximity check.
The corrected probe used the real minimap and movement flow. This failure did not show a recovery defect.
Authenticated staging with a real party, PostgreSQL and assigned room remains required.
