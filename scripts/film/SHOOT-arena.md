> Worked example of a shot list (the ClawPump hackathon submission, staging, 2026-10-02). Every value (commits, framings,
> board figures, times) is as of that night: re-read the live state and re-rehearse before you reuse a line.
> The real takes were shot from this list by session FILMIT; the leaderboard reshoot used `scripts/film/reshoot.sh`.

# REAL SHOOT — ClawPump hackathon demo (staging, Trading Floor)

Written by filmitHelper, 2026-10-02 ~02:25Z, against staging web/api `2eaace16` (v5 part 2 + P15).
Run only after the owner says "go". Run every line from the worktree root
`C:\Users\itachi\Documents\Crypto\clawville\.worktrees\video-production` in Git Bash, one line per tool call.
Every `take` records the real Chrome window (ffmpeg gfxcapture, 1920x1080, 60 fps) and logs to `.film/rig.log`.

```bash
R="node scripts/film/film-rig.mjs"   # define once per shell call, or write it out in full
```

## Hard rules

- The film account gets ONE arena agent, forever. Only step 9 (REAL S5b + S7) may launch it, with `FILM_LAUNCH=GO`.
  Every other step keeps the guard on: it aborts any POST to `/api/floor/arena/me/launch` or `/me/seat`.
- `real-s7-launch.mjs` without `FILM_LAUNCH=GO` stops at Step 4, clicks Back and closes the modal (dry run).
- Never record the first-time backup modal (secret keys). `overlays.mjs` stops if it shows.
- A take name never repeats (the rig refuses to overwrite). On a retake, use `real-sN-2`, `real-sN-3`.
- Re-run `tf-prep.mjs` before every inside shot that says so: it reloads `/trading-floor` (spawn (0, 1170)) and installs
  the read-only scene hook the closed-loop moves need. Any reload drops the hook.
- Claude Code runs two Bash calls one after the other. Use `take` (rec + step together), never `rec` + `do` in parallel.

## 0. Pre-flight (not recorded)

| # | Command | Expect |
|---|---|---|
| 0.1 | `node scripts/film/film-rig.mjs chrome https://staging.clawville.world/game --fresh` | `chrome ready` with `inner 1920x1080`, `webgpu nvidia ampere`, a new expiry 120 min out (retained task, owned by YOUR session) |
| 0.2 | `node scripts/film/film-rig.mjs status` | 1 page, title `CV-CAPTURE`, keeper heartbeat fresh |
| 0.3 | `node scripts/film/film-rig.mjs do scripts/film/steps/look.mjs` | `reefRookie=true verifyBanner=false`. If logged out: `do scripts/film/steps/login.mjs` |
| 0.4 | `node scripts/film/film-rig.mjs do scripts/film/steps/overlays.mjs` | `check: fieldManual=false verifyBanner=false dailyModal=false` |
| 0.5 | `node scripts/film/film-rig.mjs do scripts/film/steps/me-check.mjs` | `{"status":200,"agent":null}` (the film account has NO agent yet) |
| 0.6 | `curl -s --ssl-no-revoke https://api-staging.clawville.world/health` | note the commit for the claim list |

## 1. S1 exterior + walk-in (best rehearsal: `reh-s1v2-1`, clean 0.0-4.6 s)

| # | Command |
|---|---|
| 1.1 | `S1_START_Z=2000 S1_TILT_KEY=ArrowDown S1_TILT_MS=350 node scripts/film/film-rig.mjs do scripts/film/steps/s1v2-setup.mjs` |
| 1.2 | look at `.film/takes/s1v2-start.dom.png`: building + "TRADING FLOOR" sign + dome, no NPC in front. If an NPC is in front or the camera is under the sand, run 1.1 again |
| 1.3 | `REAL_STEP=s1v2-exterior.mjs node scripts/film/film-rig.mjs take real-s1 22 scripts/film/steps/real-wrap.mjs` |

Rehearsal timings (footage, without the 1.5 s pre-roll): establishing hold 0-4.0 s, W 4.3 s, door prompt + E 6.4 s,
fade 6.8 s, dark "RIDING THE CURRENT..." 7.0-9.0 s, room 9.2 s. Traps: the camera dips under the sand while walking
(5.0-6.3 s in `reh-s1v2-1`): cut from the establishing hold to the curtain. The roof claw sits behind the
"Agent Training Active" HUD pill; the lower half is sand: punch in on the top 60%. One blank frame ~1.8 s after the
room appears on walk-in arrivals (`reh-s1-2` 11.033 s): cut around it. Nori and the town NPCs follow the avatar;
from z 2000 they are usually behind the camera.

## 2. S2 spawn view, all five standing (best: `reh-s2v2-1`, clean 0-7 s)

| # | Command |
|---|---|
| 2.1 | `node scripts/film/film-rig.mjs do scripts/film/steps/tf-prep.mjs` |
| 2.2 | `node scripts/film/film-rig.mjs do scripts/film/steps/s2v2-setup.mjs` (camera height +68 wu) |
| 2.3 | `REAL_STEP=s2-spawn.mjs node scripts/film/film-rig.mjs take real-s2 11 scripts/film/steps/real-wrap.mjs` |

## 3. S5a walk past the five (best: `reh-s5a-1`, D 1.1-6.0 s)

| # | Command |
|---|---|
| 3.1 | `node scripts/film/film-rig.mjs do scripts/film/steps/tf-prep.mjs` |
| 3.2 | `node scripts/film/film-rig.mjs do scripts/film/steps/s5a-setup.mjs` (to (-1250, -1000)) |
| 3.3 | `REAL_STEP=s5a-walk-five.mjs node scripts/film/film-rig.mjs take real-s5a 11 scripts/film/steps/real-wrap.mjs` |

## 4. S6 Runner's 30-minute report (best: `reh-s6-1`, report 10.8-16.3 s, rule changes 16.8-20.3 s)

| # | Command |
|---|---|
| 4.1 | `node scripts/film/film-rig.mjs do scripts/film/steps/tf-prep.mjs` |
| 4.2 | `REAL_STEP=s6-report.mjs node scripts/film/film-rig.mjs take real-s6 26 scripts/film/steps/real-wrap.mjs` |

Pick check: Runner had the best report at 02:15Z (contest +$32.49; "Tuner: no change, next check at 40 trades on these
rules (has 38)"). If Runner reaches 40 trades before the shoot, its report may show a real tuner decision: read it first
with `do scripts/film/steps/s6-scan.mjs`. Traps: "Recent trades" under the report lists a coin named "Nigerinu" (02:16Z):
mask it or keep it out of frame (owner rule: mask hate slurs). "Rule changes" shows the house tuner's v2 change AND the
team's v3 reset that reverted it: do not caption it as proof that tuning works.

## 5. S3 the big board, legible (best: `reh-s3-1`, clean 0-12 s)

| # | Command |
|---|---|
| 5.1 | `node scripts/film/film-rig.mjs do scripts/film/steps/tf-prep.mjs` |
| 5.2 | `node scripts/film/film-rig.mjs do scripts/film/steps/s3-setup.mjs` (to (0, 520), camera height -54 wu) |
| 5.3 | `HOLD_MS=12000 REAL_STEP=s2-spawn.mjs node scripts/film/film-rig.mjs take real-s3 16 scripts/film/steps/real-wrap.mjs` |

The whole board (header, five columns, footer) is ~930 px wide at 1080p; the live rows update during the hold.
Our avatar's head covers part of the Dip Hunter figure (its name capsule shows).

## 6. S11 contest banner + rules (best: `reh-s11-2`: banner 0-3.9 s, rules 4.5-10 s)

| # | Command |
|---|---|
| 6.1 | `node scripts/film/film-rig.mjs do scripts/film/steps/tf-prep.mjs` |
| 6.2 | `node scripts/film/film-rig.mjs do scripts/film/steps/arena-open.mjs` (Runner pop-up -> Watch its trades -> Back to the arena) |
| 6.3 | `REAL_STEP=s11-contest.mjs node scripts/film/film-rig.mjs take real-s11 13 scripts/film/steps/real-wrap.mjs` |

## 7. S10-before, the contest leaderboard (best: `reh-s10-dry-2`, clean 1.8-8 s)

| # | Command |
|---|---|
| 7.1 | `REAL_STEP=s10-board.mjs node scripts/film/film-rig.mjs take real-s10-before 12 scripts/film/steps/real-wrap.mjs` |
| 7.2 | `ACT="key:Escape:150" node scripts/film/film-rig.mjs do scripts/film/steps/act.mjs` (close the Exchange modal) |

Trap: the contest board lists test accounts (ParityAudit-324303 #3, LandTest2 #7, LandTest1 #10 at 02:19Z). Owner decision.

## 8. Safety check before the launch

| # | Command | Expect |
|---|---|---|
| 8.1 | `node scripts/film/film-rig.mjs do scripts/film/steps/me-check.mjs` | `"agent":null`. If an agent exists, STOP: the launch shot is gone for this account |

## 9. REAL S5b + S7: walk up to Runner, choose the style, change one rule, name, LAUNCH

| # | Command |
|---|---|
| 9.1 | `node scripts/film/film-rig.mjs do scripts/film/steps/tf-prep.mjs` |
| 9.2 | `node scripts/film/film-rig.mjs do scripts/film/steps/real-s7-setup.mjs` (to the head of the x -700 lane) |
| 9.3 | DRY first, same take shape: `node scripts/film/film-rig.mjs take real-s7-dry 45 scripts/film/steps/real-s7-launch.mjs` then repeat 9.1 + 9.2 |
| 9.4 | REAL: `FILM_LAUNCH=GO node scripts/film/film-rig.mjs take real-s7 55 scripts/film/steps/real-s7-launch.mjs` |
| 9.5 | `node scripts/film/film-rig.mjs do scripts/film/steps/me-check.mjs` (expect an agent named "Reef Rookie") |

What the take shows (dry timings from `reh-real-s7-dry-2`, step clock): pre-roll 1.5 s; W up the x -700 lane, the
Runner pop-up opens at ~6.1 s (Runner stays visible to the right of our avatar); 3 s on the card; "Choose this trading
style" ~9.2 s; Step 2 top hold 4.5 s (Paper trading / Live trading "Coming later" + the five locked rules); "Max open
positions" typed 5 -> 3 at 120 ms/char (~14.8 s); Next -> Step 3 (add-ons, all OFF); Next -> Step 4; name "Reef
Rookie" at 120 ms/char (~23.7 s); then (GO only) "Launch", the log line `POST /me/launch -> 201`, the success screen
("Reef Rookie is ready", "Setting up your ClawPump agent...") held 6 s, post-roll 1.5 s.
Change the rule with `REAL_FIELD_VALUE` (default 3). The alternative field is `exits.tp` (1.2 -> 1.3): edit `FIELD` in the step.

## 10. S8 sit at a free desk (seat 2 = UI desk 3, left wall, third desk from the door)

| # | Command |
|---|---|
| 10.1 | `node scripts/film/film-rig.mjs do scripts/film/steps/tf-prep.mjs` |
| 10.2 | `FILM_LAUNCH=GO node scripts/film/film-rig.mjs take real-s8 16 scripts/film/steps/real-s8-sit.mjs` |

`FILM_LAUNCH=GO` lets the seat write (`POST /me/seat`) through, which the agent needs to open positions. Rehearsal
(`reh-s8-1`, no agent): walk 4.2 s, E, panel after 1.49 s. With an agent the panel is "My trader"
(`[data-testid='arena-my-trader']`); the log must show `panel arena-my-trader` and `NET RESPONSE 200 POST .../me/seat`.

## 11. S9 the decision stream (no tf-prep: stay seated)

| # | Command |
|---|---|
| 11.1 | `FILM_LAUNCH=GO node scripts/film/film-rig.mjs take real-s9 126 scripts/film/steps/real-s9-stream.mjs` |

It scrolls to `[data-testid='arena-desk-stream']` ("Decision stream") and logs the stream every 15 s. NOT rehearsed
(the account has no agent). For a PLAYER agent the stream shows its own skip reasons only in this desk panel.

## 12. S10-after, the leaderboard with the "You" pill

| # | Command |
|---|---|
| 12.1 | `REAL_STEP=s10-board.mjs node scripts/film/film-rig.mjs take real-s10-after 12 scripts/film/steps/real-wrap.mjs` |

The step clicks "Back to the arena" when the leaderboard is not on screen (the desk view has that button,
`my-trader.tsx:359`), selects "Contest", and logs `you-pill=true|false`. NOT rehearsed with an agent.

## After every take

`node scripts/film/film-rig.mjs check <take>`: size 1920x1080, fps 60/1, unique frames, freezes, mean luma, 3 stills.
Look at the stills. `rig.log` has every event with ISO times; a step clock starts ~0.3 s after its `rec start` line.

## Chrome lifetime

The capture Chrome and its title keeper are retained launcher tasks: they survive the end of a turn, and they stop
120 minutes after `chrome --fresh` or when the owner session ends. Run 0.1 again before the 120 minutes end (the profile
keeps the login), then 0.4.

## UI text defects seen on camera (for the owner)

1. Runner pop-up and profile: "Contest: +$32.49realised P&L" (no space before "realised").
2. Launch Step 4: "Name your trader (optional, up to 32characters ..." (no space).
3. House agent reports mix "realized" (report text) and "realised" (UI).
