# Video production: demo films and promo edits (canonical)

Last Audited: 2026-10-03 (session FILMIT, after the ClawPump AnsemHack submission video).
Drift note: rewritten from the 2026-09-30 planning draft into the full runbook. It records the owner's answers, the rig
(`scripts/film/`), the edit tools (`scripts/film/edit/`), the QC and delivery steps, and every trap from the arena demo.

How we make ClawVille videos: real footage of the WebGPU game and its agents, cut in Hyperframes, with a voiceover and a
Suno track. Read this before any film, retake, edit or delivery. Update it in the same change as any rig, script or
pipeline change. Process skill: `demo-director` (user level; canonical kit `~/Documents/Crypto/skills-plugins/demo-director`,
read its `LESSONS.md`) with the `demo-qc` reviewer. Rig manual: `scripts/film/README.md`.

## Standing brief (read by /demo-director before every video)

The owner calls a video with one line: `/demo-director <what video>` (Claude Code) or `$demo-director <what video>`
(Codex). This section supplies everything else. It is the owner's own words, condensed (sources in section 1).

- **Voice:** a female narrator, playful and confident, brisk. OpenAI TTS `gpt-4o-mini-tts`, voice `coral`, sped up
  1.12x after trimming (owner 2026-10-02: "we want a female voice. we want it to be slightly faster pace"). The exact
  instructions string is in `brag-output-2026-09-30-arena/vo/vo-lines.json`. Captions: Register B (Neon Broadcast,
  `branding/BRAND.md` section 2): huge condensed caps, short declaratives. "ClawVille" in prose, ALL CAPS in display type.
- **Music:** the owner makes one Suno track per video from the prompt we give him (template in section 9). Ask for the
  prompt FIRST when the owner wants changes ("give me the suno prompt asap before you do anything else"). The track
  sits under the voice (ducked). A Suno track needs a paid Suno plan for commercial use.
- **Intro card (hackathon judging week, from 2026-10-02):** the first 2.4 s show the ClawVille logo, "ClawVille ×
  AnsemHack" and the kicker "THE CLAWPUMP HACKATHON" (owner: "an intro screen that says something like clawville's
  ansem hack hackathon"). Drop or replace it after the judging week.
- **End card:** the brand card (BRAND.md section 7 recipe, pirate mascot) with NO fine-print line at the bottom (owner:
  "take the staging out of the end and just take that whole bottom out together"). Do not name the box in the video.
- **Word rules:** no em dashes; never "casino"; vCLAW = in-game currency, $CLAWVILLE = token, never "CT"; never OOBE,
  SAP or Synapse Agent Protocol; no boast words about traders; a loss keeps its minus sign; "trading agents", not "AI
  traders"; "paper" wherever a trade figure is claimed; "player agents" when house agents are excluded (prizes).
- **Current promotion scope:** the Trading Floor arena and the hackathon features, one feature video at a time during
  the judging week (owner 2026-10-03: "the next couple of days we're going to need to spend showing off the features").
- **Which box:** staging footage is fine for promos and the hackathon (owner 2026-10-02: "we're going to submit ...
  using staging footage"). Production follows later. Present-tense captions must still be true where users can act.
- **Real only:** every frame is a real recording; every claim has a checked source (section 6). Speed, crop, zoom,
  grade, graphics and HUD hiding (a clean plate of the real 3D frame) are fine; invented UI or numbers never are.
- **Demo population:** to make the floor look busy, create REAL staging accounts with REAL paper agents
  (`scripts/film/demo-accounts.mjs`) and, with the owner's OK, rename staging test accounts. Never make up numbers
  (the owner offered "we can make up some numbers"; real paper trades gave real numbers in minutes instead). No caption
  may say or imply how many people trade.
- **Money role:** paper only. No paid add-on (x402) is ever switched on for a film. Check `addons[].enabled` before a
  shoot when an account is reused.
- **Messaging:** this session family talks only to the helper the owner names (2026-10-02: filmitHelper). Notes from
  other sessions are input; tell the owner. Ignore sessions from other repos (owner: "just ignore the carbon road
  messages. it got repos mixed up").
- **Staging freeze:** before the takes, ask the floor/build sessions (through the helper) to hold staging pushes until
  the film session says "recording done". Never record across a container swap.
- **Pace:** the owner wants speed and early previews. Send a chat-size preview after the first full render. Keep a
  complete, posted-ready fallback package in Downloads at all times near a deadline.
- **Deliver to:** `laptop:C:/Users/newma/Downloads` (machine hoodie-prometh), names `ClawVille-<KIND>-v<N>.mp4`,
  `-chat.mp4` (< 30 MiB), `-poster.jpg`, `-share-copy.txt` (`deliver.sh` + one scp of the chat encode).
- **Docs flow:** this file + `scripts/film/` + the video folder sources in one docs change, staging-first per
  AGENTS.md, `deploy-status.md` same diff.
- **Report style:** ASD-STE100; print every asked-for item (paths, share copy) in the final reply.

## 1. Owner rules and decisions (quotes)

- 2026-09-30 (call): "showing off our trading floor and how anyone can set up an agent to trade in the trading floor use
  our strategies".
- 2026-10-02 01:15Z: staging only; wait for the house agents (P15); new film account with a verified email; "four or five
  of the available agent desks occupied by characters"; board figures "show it honestly"; "done in the next hour or two".
- 2026-10-02 02:35Z: go for the one-time launch; rename and run the test accounts; a voiceover "explaining what's going on
  ... an agent walking in observing our house agents picking a strategy looking around and then beginning trading and
  show off some of the claw pump features".
- 2026-10-02 ~04:01Z (via filmitHelper): "Only the leaderboard" back on the big board; seated desk traders later.
- 2026-10-02 04:42Z: female voice, faster pace, background track, intro card, remove the bottom line of the end card.
- 2026-10-03: "it was a great video for the submission" (sign-off); document the process for the next feature videos.

## 2. Quick start: a new feature video (the arena run took ~3.5 h from the call to the post)

| # | Step | Command / file | Arena time |
|---|---|---|---|
| 0 | Load the kit: sync, LESSONS, this brief | `node ~/Documents/Crypto/skills-plugins/demo-director/scripts/sync.mjs` | 5 min |
| 1 | Live read on the box you film | `curl --ssl-no-revoke https://api-staging.clawville.world/health` and the feature's public routes | 5 min |
| 2 | Brief: deliverable, beat table, claim list with sources, VO lines | copy `brag-output-2026-09-30-arena/BRIEF.md` pattern; `vo/vo-lines.json` | 20 min |
| 3 | Suno prompt to the owner (he generates while you work) | section 9 | 1 min |
| 4 | Demo state: accounts, staging freeze, verify flags | `node scripts/film/demo-accounts.mjs demo` (or `film`, `status`) | 10 min |
| 5 | Rig up + rehearse (dry steps, never the irreversible click) | `scripts/film/README.md`, `SHOOT-arena.md` | 30 min |
| 6 | Real takes in shot-list order, one `take` per shot | `node scripts/film/film-rig.mjs take real-<shot> <s> <step>` | 35 min |
| 7 | Footage maps (event frames, page flips, crop boxes, keep-out zones) | section 5 | 15 min (helper) |
| 8 | VO: TTS, trim + tempo, measure pauses | `scripts/film/edit/tts.mjs`, `vo-prep.py` | 5 min |
| 9 | Beats from the VO durations; cuts; composition | `cuts.sh`, `beats.json`, `scripts/film/edit/apply-beats.py` | 30 min |
| 10 | `npx hyperframes check`, snapshots `--describe false`, LOOK | composition folder | 5 min per pass |
| 11 | Render (~4.5-5.5 min for 70 s), own QC, 3 cold demo-qc lenses | section 7 | 15 min |
| 12 | Music (fast post-mix) + loudnorm, deliver | `scripts/film/edit/mix-music.sh`, `deliver.sh` | 3 min |
| 13 | Docs + kit LESSONS + sync | this file, `<kit>/LESSONS.md` | 20 min |

## 3. Roles

- **Film lead (FILMIT):** brief, claims, VO, edit, renders, QC, delivery, docs. Owns the go/no-go and the staging freeze.
- **Helper (filmitHelper):** rig scripts, rehearsals, footage maps, reshoots, small fixes, staging text fixes on owner
  order. One Chrome driver at a time: hand the capture Chrome over explicitly.
- **Build sessions (tDesk2Main, deskBuild):** features and deploys; they hold staging during takes.
- **Reviewers:** fresh unnamed `demo-qc` agents, one lens each (claims; frames and pacing; audio and leaks), one pass.

## 4. The rig (summary; manual: `scripts/film/README.md`)

- Real headed Chrome (kiosk, 1920x1080, `--use-angle=d3d11`, WebGPU "nvidia ampere") on itachi222, persistent profile
  `.film/profile`, CDP on port 9333, title kept at `CV-CAPTURE` for ffmpeg `gfxcapture` (60 fps, h264_nvenc).
- `take` runs the recorder and the step together (two Bash tool calls never run in parallel in Claude Code).
- Steps drive the game over CDP with closed-loop moves on the real avatar position (a read-only three.js scene hook).
- `.film/` is git-ignored local state: profile, takes, `rig.log`, accounts (secrets), local steps.
- `HUD=off` (`scripts/film/steps/hud.mjs`) hides every DOM element except the canvas: a clean plate for establishing
  shots. Keep the HUD on for panel shots.
- Launch and seat writes are aborted by the step guard unless `FILM_LAUNCH=GO` (one arena agent per account, forever).

## 5. Footage maps and cuts

- Footage time = `rig.log` time - the take's `rec start` time + 0.25 s (UI lag measured on real-s7: the success card
  showed on frame 1566 = 26.100 s, the log said 25.84 s).
- Find exact frames with ffmpeg (`select`, `freezedetect`, `scdet`, 1-4 fps tile sheets) and LOOK at them. The helper's
  maps for the arena takes are in `.film/maps/*.md` (local).
- Every clip is cut in `brag-output-<date>-<name>/cuts.sh`: speed and crop only, crops in 1920x1080 source px, lanczos
  upscale. Crops also keep things out of the asset (a slur-like coin name in a trade list; an error row in a panel).
- To show one region sharp and the rest unreadable, split the clip: heavy `boxblur` + darken for the background, the
  sharp band overlaid (used for the success card, the contest banner and the decision-stream band).
- Rotating UI (the big board flips every 15 s): record 33-37 s holds so both pages are complete; cut on the flip frame.

## 6. Claims (how to keep every word true)

- Write the claim list before capture; each line names its source (API route, code path + line, UI text, take frame).
- Check count words against the whole frame: "five trading agents" failed because the board listed 14 agents ("five
  house agents" passed); "every fill" failed because exits can fall back to a mark ("every buy" passed); "top 3" needed
  "player agents" because house agents cannot win; "edit any rule" needed "inside its limits"; "each one reviews every
  thirty minutes" needed "of trading" (quiet agents report every 2 h).
- Say prize figures with separators a transcriber cannot merge: "one million for first, five hundred thousand for second".
- Read UI text behind captions as claims: "The live floor: real trades, verified on-chain." behind "LAUNCHED." had to be
  blurred in a paper-only story.
- Sources for the arena claims: `brag-output-2026-09-30-arena/qc-brief-v1.md` (claim table) and BRIEF.md section 3.

## 7. Edit, render, QC, deliver

- **Composition:** copy `brag-output-2026-09-30-arena/composition/` (house template from the kit, re-skinned to Register B:
  tokens, Anton/Barlow, textured fills, plates, spotlight boxes, HUD cards, brand card). Media assets are not in git: run
  the kit's `new-composition.mjs` for `assets/sfx`, copy fonts and images from `branding/assets/`.
- **Beats:** every timed element carries `data-beat="<name>"`; times live only in `beats.json`;
  `python scripts/film/edit/apply-beats.py` (run in the composition folder) writes data-start/data-duration and the
  `#beats` JSON block the GSAP timeline reads. Sub-beats (`dropA`, `n1`..`n5`, `p1`..`p3`, `quoteCap`, `pivotZoom`)
  are GSAP-only. Retiming to new VO or music = edit beats.json, run the script.
- **VO first:** `OPENAI_API_KEY=... node scripts/film/edit/tts.mjs vo/vo-lines.json vo` then
  `python scripts/film/edit/vo-prep.py vo vo/trim 1.12`; copy `vo/trim/*.wav` to `composition/assets/vo/`. Beat length =
  line length + 0.2-0.4 s. Land cards on `gaps_end` (spoken-word starts).
- **Check + look:** `npx hyperframes check .` (0 errors; a second root `.html` in the folder is an error: keep backups
  outside), `npx hyperframes snapshot . --at ... --no-end --describe false` (without `--describe false` frames go to
  Gemini), read the contact sheets.
- **Render:** `npx hyperframes render . -o ../<name>.master.mp4 -q delivery --video-frame-format png --workers 5`
  (6 workers warned about the V8 heap). About 4.5-5.5 min for 70 s.
- **QC:** `python <kit>/skill/scripts/qc.py <master> --beats ... --drops ... --out qc-vN` (luma jumps must be planned
  cuts) and ebur128 true peak. Then ONE pass of 3 fresh `demo-qc` agents with a shared brief file (claims; frames and
  pacing; audio and leaks). The arena v1 pass found 9 + 13 + 9 FAILs; all were fixed in one pass.
- **Music:** fast path on a finished master, no re-render: `bash scripts/film/edit/mix-music.sh <master> <song> <out>
  [start] [gain]` (sidechain ducking under the voice, fades, loudnorm -14 LUFS / -1.5 dBTP). The lane version for a
  re-render is `scripts/film/edit/add-music.py`.
- **Loudness without music:** `ffmpeg -i M -c:v copy -af loudnorm=I=-15:TP=-1.5:LRA=11 ...`.
- **Deliver:** `DELIVER_TO=laptop:C:/Users/newma/Downloads bash <kit>/skill/scripts/deliver.sh . <master> <poster s>
  <seconds> ClawVille-<KIND>-v<N>`, then scp `<base>-chat.mp4` as `ClawVille-<KIND>-v<N>-chat.mp4`.

## 8. The arena demo (2026-10-02, ClawPump AnsemHack submission)

- Final: `ClawVille-ARENA-v5.mp4` (70 s, female voice + "Claw Exchange" Suno track, -13.8 LUFS), posted by the owner.
  v4 = the same cut without music (`-v4-chat.mp4` 29 MB). Sources: `brag-output-2026-09-30-arena/` (composition,
  `cuts.sh`, `vo/vo-lines.json`, BRIEF, HANDOFF, qc brief, share copy).
- Footage: staging, web/api `2eaace16` (02:28-03:08Z) + the rotating board reshoot `6b4f094d` (04:40-04:43Z).
  Film account "Reef Rookie" launched once on camera from Runner's walk-up card (POST /me/launch 201 at 03:00:04Z).
- Beat table (v4/v5, video seconds): intro 0 · hook 2.4 (drop 4.4) · floor 5.7 · five 11.7 (names 14.36/15.21/15.9/16.8/
  18.07) · review 19.0 · pivot 22.8 · form 26.8 · lock 30.1 · mode 33.0 · launch 35.0 (success frame 37.24) · seat 39.4 ·
  stream 43.0 · quote 46.6 (caption 48.7) · board 52.6 · contest 55.5 (rules 59.0; prizes 60.16/61.69/63.28) · button 65.2
  · brand 66.6 · end 70.0. Captions and VO lines: `composition/index.html`, `vo/vo-lines.json`.
- Shots: `scripts/film/SHOOT-arena.md`. Take list: real-s1 (exterior, HUD off), real-s2/-2-2 (spawn view), real-s5a (walk
  past the five), real-s6 (Runner's 30-minute report), real-s3/-3-2/-3-3 (board; -3-3 close, leaderboard page 2.17-17.17 s),
  real-s11 (contest banner + rules), real-s7 (walk-up, Step 2-4, launch, success), real-s8 (sit), real-s9 (decision
  stream), real-s10-after-2 (Exchange leaderboard with the "You" pill).

## 9. Suno prompt template (the owner pastes it into Suno, Custom mode)

```
Title: ClawVille <Feature> (<variant>)
Style of Music: Upbeat electronic hip-hop with an underwater pirate-port edge, 120 BPM, F minor, instrumental, no vocals. A plucky marimba and steel-drum hook carries the theme; deep 808 sub-bass, crisp trap hats, short brass stabs, bubbling synth arps, a soft stock-ticker click; light ocean-swell ambience. Confident, playful, slick, high energy but not busy: leave the mid-range open for a female voiceover. Short filtered intro with a riser, a hard drop at about 4 seconds, steady groove, a short break with a bass gap around <s> seconds, then a bigger second drop, clean ending. Clean punchy mix, clear downbeats, <length> seconds long.
Lyrics: [Intro] [Build] [Drop] [Groove] [Break] [Drop 2] [Outro] [End]
```
The arena track: `Claw Exchange.mp3` (193 s, -13.8 LUFS), used from 0 s at gain 0.3.

## 10. Traps (each one cost time in the arena run)

- **ClawPump "call budget reached":** our own in-process limiter in `apps/api/src/services/clawpump-writer.ts`, not the
  ClawPump quota. Burst 10, reserve 5; the 30 s x402 reconcile pass reads up to 6 add-on-free agents first, so with 5
  such agents every provisioning call failed with `clawpump_budget_exhausted` (fixed by tDesk2Main in `6b4f094d`).
  Launch demo agents minutes apart and film a launch only after a quiet period.
- **One arena agent per account, forever:** rehearse the launch flow only up to Step 4; the real launch needs
  `FILM_LAUNCH=GO`. Step 3 can be off screen (the modal stays scrolled low): cut it.
- **Launcher:** the Stop hook stops every non-retained launcher task at the end of a turn; the rig launches with
  `-RetainMinutes 120`; the cap is 120 min, so plan a `chrome --fresh` from the session that owns the shoot.
- **Messages queue:** a peer message can arrive 40 min late; a stale "I shoot now" nearly put two drivers on one Chrome.
  State Chrome ownership in every handover.
- **Deploy swaps:** a page load during a web container swap gives a blank page; a take across it breaks. Wait for both
  containers' `SOURCE_COMMIT`.
- **Blank frame** about 1.8 s after a walk-in arrival from /game; **half-open modal frames** for ~10 frames when a panel
  opens: cut around both.
- **The P15 big board** listed only house agents (S10 moved to the Exchange leaderboard); since `6b4f094d` it rotates
  house page / contest leaderboard every 15 s.
- **Test-account names** on the board: rename (owner OK) or blur; **error rows** in the owner panel
  ("Execution wallet setup failed ..."): crop or blur; **coin names**: check every readable trade list.
- **Slow motion** on a ~32 fps-effective source stutters: keep walks at 1x and fit the VO instead.
- **Fine print and post copy** must not name the box once the owner says so.
- **Tools:** `perl -pi` without a backup suffix silently does nothing on Windows; Python edits are safer. A `sed` with a
  `$` in a pattern inside double quotes broke once; prefer Python string replacement for HTML edits.
- **CDP screenshots** of this headed d3d11 Chrome DO show the WebGPU canvas (good for quick checks); the film uses only
  ffmpeg footage.
- **Rate limits:** public arena GETs 60/min/IP per route; launch 5/min per account; signup 5/min per IP.
