# Film rig: capture ClawVille footage for demo and feature videos

This folder records the real WebGPU game in a real headed Chrome, drives it with scripted steps, and maps the footage
for the edit. It made the ClawPump hackathon submission (2026-10-02). The edit (Hyperframes) and the brief live in
`docs/video-production.md`. Local state (Chrome profile, takes, `rig.log`, account secrets) lives in the git-ignored `.film/`.

| File | Use |
|---|---|
| `film-rig.mjs` | The rig: Chrome, recorder, step runner, checks. |
| `steps/` | The step library. `lib.mjs` has the helpers; the other files are setups and shots. |
| `demo-accounts.mjs` | Staging only: create the demo players and the film account. |
| `SHOOT-arena.md` | Worked example: the full shot list of the hackathon shoot. |
| `reshoot.sh` | Worked example: a three-take reshoot in one command. |
| `shots-arena.json` | Code-checked controls, room geometry and shot facts (2026-10-02). |
| `arena-probe.mjs` | Logs the public arena API during a take. |

## 1. One-time setup

1. Use itachi222 (RTX 3080, ffmpeg 8.1 with `gfxcapture` + `h264_nvenc`, Chrome). Work from the worktree root.
2. Install the CDP client in the local folder: `cd .film && npm i playwright-core && cd ..`.
3. Accounts (staging only): `node scripts/film/demo-accounts.mjs demo` signs up, launches and seats the demo players.
   `node scripts/film/demo-accounts.mjs film` signs up the film account only (it launches ON CAMERA).
   `... status` prints each agent (no secrets). Passwords, cookies and the one-time wallet secret go to
   `.film/accounts/<key>.json` and are never printed.
4. Start Chrome, then sign in: `node scripts/film/film-rig.mjs chrome` and `node scripts/film/film-rig.mjs do login`.

## 2. Commands (`node scripts/film/film-rig.mjs <command>`)

| Command | What it does |
|---|---|
| `chrome [url] [--fresh]` | Starts (or reuses) the capture Chrome on CDP port 9333: kiosk, 1920x1080 at 0,0, `--use-angle=d3d11`, profile `.film/profile`. Also starts the title keeper. `--fresh` closes Chrome and starts it again under YOUR session. |
| `status` | Prints the browser, the pages, and the title-keeper heartbeat. |
| `rec <name> <s>` | Records the window to `.film/takes/<name>.mp4` (60 fps, h264_nvenc, cq 19). Never overwrites a take. |
| `do <step>` | Runs one step. `<step>` is a path, or a name in `steps/` (then `.film/steps/`), with or without `.mjs`. |
| `take <name> <s> <step>` | `rec` and the step together. The step starts at the `rec start` line (footage ~0.3 s). |
| `check <name>` | ffprobe size/fps, unique frames, freezes, mean luma, and 3 stills. LOOK at the stills. |

**One take = `take`.** Claude Code runs two Bash calls one after the other, never in parallel. So `rec` + `do` as two
calls do not overlap. Always use `take`.

## 3. The launcher trap (Chrome dies at the end of a turn)

- A hook blocks detached shells, so Chrome and the title keeper start through `~/.local/bin/itachi-dev.ps1`.
- The `dev-server-lifecycle.ps1` hook runs `-Action Stop` at the end of EVERY Claude turn and stops every task that is
  not retained. The rig passes `-RetainMinutes 120` (env `FILM_RETAIN_MINUTES`), so Chrome survives the turn.
- A retained task still stops 120 minutes after its start, and when the owner session ends. `chrome` prints the expiry.
  Run `chrome --fresh` before the expiry. The profile keeps the login.
- **One Chrome owner.** Only one session drives the capture Chrome. Hand it over in writing ("you own the Chrome now").
  The new owner runs `chrome --fresh` so the tasks belong to its own session.

## 4. Capture facts

- `gfxcapture` finds the window by an ECMAScript regex on the title (`^CV-CAPTURE`). The title keeper (a retained
  process with a CDP init script) pins `document.title = 'CV-CAPTURE'` across reloads. `rec` retries until the window exists.
- Output is 1920x1080, 60 fps (the monitors are 1080p; no 4K). A take is rarely 1920x1078: scale or pad it in the edit.
- CDP screenshots in this headed d3d11 Chrome DO show the WebGPU canvas. Use them (`screenshotDom`) for fast framing tests.
  Use only `rec` footage in the film.
- The game renders ~45-55 unique fps on the RTX 3080. A strafe can drop to ~32 unique fps: do not slow walks down in the edit.

## 5. Before every take

1. `do overlays` sets the first-time keys (`clawville-tutorial-seen`, `clawville-quest-intro-seen`,
   `clawville-activity-tutorial-skip-all`, `clawville-sidebar-collapsed`), reloads once if a key changed, and closes the
   daily modal and the verify banner. It STOPS if the secret-key backup modal shows. Never record that modal.
2. Room shots: `do tf-prep` opens `/trading-floor` (spawn (0,1170)) and installs a read-only three.js scene hook
   (`window.__THREE_DEVTOOLS__` init script). Closed-loop moves need it. Any reload drops it: run `tf-prep` again.
3. Clean plate: `HUD=off node scripts/film/film-rig.mjs do hud` hides every DOM element except the canvas (nothing is
   added). The style lasts until the next reload. `HUD=on` removes it.
4. Check the account: `do me-check` (expect the agent you plan to film).

## 6. Steps library (`steps/lib.mjs`)

| Helper | Use |
|---|---|
| `hold(page, keys, ms)` | Holds keys for a time. |
| `holdUntil(page, sleep, keys, pred)` | /game: holds keys until SONAR (`world = px - 11264`) passes `pred`. |
| `tfPlayer(page)`, `tfHoldUntil(...)` | Room: reads the avatar (`VRMHumanoidRig`) position from the scene hook; closed-loop moves. |
| `pressE`, `pressKey(page, sleep, key)` | Holds the key 150 ms. A CDP `press()` is shorter than a frame and the game misses it. |
| `guard(page, log, {allow})` | Aborts any POST to `/api/floor/arena/me/launch` or `/me/seat` and logs arena writes. `allow` only logs. |
| `waitFor`, `bodyText`, `panelText`, `clock` | DOM waits, text reads, and a step clock for the log. |
| `minimapClickWorld` | Minimap click-to-move. UNRELIABLE (walked the wrong way); prefer `holdUntil`. |

Steps take `{ page, browser, log, sleep, holdKey, press, clickText, waitText, screenshotDom, goto }`. Put every
tunable number in a named constant at the top of the file, so a room change is a one-line re-tune.

Shots (arena, see `SHOOT-arena.md` for order and timings): `s1v2-setup` + `s1v2-exterior` (street to walk-in),
`s2v2-setup` + `s2-spawn` (spawn view; `HOLD_MS` sets the hold), `s2b-*` (desk row), `s3-setup` / `s3close-setup` (board),
`s5a-*` (walk past the five house agents), `s5b-dry`, `s6-report` (+ `s6-scan` to pick the agent), `s7-dry`,
`real-s7-setup` + `real-s7-launch`, `real-s8-sit`, `real-s9-stream`, `s10-board`, `s11-contest`, `arena-open`.
`real-wrap` adds the 1.5 s pre-roll and post-roll around any step (`REAL_STEP=<file>`).

## 7. Safety (one-way actions)

- One arena agent per account, forever. A rehearsal launch kills the launch shot. Every step keeps the guard on.
- `real-s7-launch` clicks "Launch" ONLY with `FILM_LAUNCH=GO`. Without it, it stops at Step 4, clicks Back and closes.
  Run it once DRY first, then `me-check`, then the GO take. `real-s8-sit` also needs GO (the seat write lets the agent trade).
- Never print or record a password, a cookie, an agent key, or a wallet secret. Film staging unless the owner says otherwise.

## 8. Controls and geometry cheat sheet (re-check after any room change)

- **/game:** after a load the camera faces NORTH (W = -z). ArrowLeft/Right orbit 1.5 rad/s (180 deg = 2094 ms);
  ArrowDown lowers the camera (looks up), ArrowUp raises it. The wheel does not zoom. Walk ~550 wu/s.
  Trading Floor door (0,3360), due south; E works in the door band (z 3121..3362; below that E opens Pearl).
  Nori and town NPCs follow the avatar: start shots at z >= 2000.
- **Room (v5 part 2):** hall 3900 x 3300; spawn (0,1170) facing -z; walk 520 wu/s; arrows turn 1.25 rad/s; ArrowUp/Down
  change the camera HEIGHT (180 wu/s, -120..+150); no auto-follow. The dais blocks x -538..538, z -624..444 (use the
  x -700 lane). Seats at x ±1565 (index 2 = (-1565,500)). House agents at z -1350, x -1020..1020; the walk-up pop-up opens at
  250 wu, closes at 290, and Escape does not close it. Board 2550 wide on the back wall; legible from (0,520) with ArrowDown
  300 ms, or from the lane (-700,150) with ArrowRight 250 + ArrowDown 300 ms.
- **Modal test ids:** `floor-arena-section`, `arena-contest-banner`, `arena-contest-rules`, `arena-leaderboard`
  (+ `-row`), `arena-agent-profile`, `arena-launch`, `arena-launch-review`, `arena-field-<path>`, `arena-my-trader`,
  `arena-desk-stream`.

## 9. Deploy-aware filming

- Never record across a container swap: a load during the swap gives a blank page. Before a take, read both staging
  containers' `SOURCE_COMMIT` over SSH (runbook `docs/DEPLOY-HETZNER.md`). A green CI run is not proof.
- A staging web build can fail with exit 255 when the api and web build together. The pushing session re-queues the
  web build SOLO (Coolify app 4).
- Docs-only pushes do not deploy. A UI text change trips the coupling gate unless the same range touches
  `GameFeatures.md` and `skill-protocol.ts` (precedent `7d81b752`, plus `[skip-nori-update]`).
- During a shoot: one session owns GO / NO-GO, every other session holds pushes (a "staging freeze"), and the owner
  ends the freeze in writing.

## 10. Footage maps (for the editor)

1. Event times: each `rig.log` line minus the take's `rec start` line. A UI change shows ~+0.25 s after its log line.
2. Frame-exact events: `ffmpeg -ss T -i take.mp4 -vf "crop=...,scdet=threshold=X,metadata=mode=print:key=lavfi.scd.score"`
   on the region that changes (crop out the moving 3D scene). Put `-ss` before `-i`.
3. Blanks, curtains, under-ground cameras: a per-frame luma timeline (`signalstats` YAVG on a 96x54 scale); a one-frame
   drop > 20 is a blank frame.
4. Contact sheets: `fps=2,scale=384:216,tile=6x5`. LOOK at them for NPC crossings, half-open modals and wrong views.
5. Boxes: extract a full-size still, crop a region 1:1, and read the edges (+-6 px).
6. Write one `.film/maps/<take>.md` per take (events, clean ranges, keep-out lines, boxes, stills) and an index `FOOTAGE.md`.

## 11. Traps seen on 2026-10-02

- Two blank frames ~1 s after a walk-in arrival (not after a direct load).
- Launch Step 3 never showed: the modal stayed scrolled low after Next. Check every step change on a still.
- Content to keep out: test accounts on leaderboards, coin names that read as slurs, internal error lines
  ("Execution wallet setup failed ..."), and the staging host name in copy.
- The HUD pill covers the roof claw in /game; the camera dips under the sand when it walks with ArrowDown tilt.
- Live numbers change between takes (paper agents trade on their own): do not cut two takes as one moment.

## 12. Checklist for a new feature video

1. Brief + beat table in `docs/video-production.md`; claims with sources; the owner's rules.
2. Read the live state (both `/health`, both `SOURCE_COMMIT`s). Agree a staging freeze and one GO owner.
3. `chrome --fresh`, `do overlays`, `do login` / `me-check`.
4. Write steps in `steps/` (named constants, closed-loop moves, the guard). Rehearse each with `take reh-<shot>-N`,
   `check`, and stills. Fix, then write the shot list (copy `SHOOT-arena.md`).
5. Shoot `real-*` takes; `check` each; write the footage maps; hand them to the editor.
