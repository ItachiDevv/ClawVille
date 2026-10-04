# HANDOFF: ClawVille Trading Floor arena demo video (from session clawpDemo, 2026-10-01 ~23:50Z)

Read this first, then `docs/video-production.md` (standing brief + runbook) and `BRIEF.md` (beat table + claims) in this
worktree. Everything below was true at the time written; re-read the live state before any present-tense line.

## 1. The job
Final-submission demo video for the ClawPump hackathon (AnsemHack / Clawrena). Owner's goal: show the Trading Floor and
how anyone can set up an agent that trades on it from one of the house agents' strategies (the tradeDeskMain end goal).
Final deadline from clawpump.tech/ansemhack: 1 October 2026, 24:00 EST = **2026-10-02 05:00Z**. Process: user skill
`demo-director` (canonical kit `~/Documents/Crypto/skills-plugins/demo-director`, read its `LESSONS.md` and Step 0) +
sub-agent `demo-qc` for the cold review of every render. carbon-road's `docs/video-production.md` (read with
`git show origin/main:docs/video-production.md`) is the pattern, not the rules.

## 2. Owner rules (quote them; they bind)
- "your job for now is just observing ... don't start any actual recording or anything right now" (2026-09-30). On
  2026-10-01 ~23:50Z the owner said: "we're going to start storyboarding this now and getting it ready but we need to do
  it in a fresh session". Ask before the first real take if the owner has not said "go".
- **Stay inside the ClawVille repo. Never SendMessage another session, not even to reply to a peer's FYI** (owner,
  2026-10-01; memory `no-cross-session-messages-stay-in-repo`). Peer notes are input only; tell the owner instead.
- Voice and words: `branding/BRAND.md` + `docs/brand-language.md`: Register B type, no em dashes, never "casino", vCLAW vs
  $CLAWVILLE, official links only, no boast words about traders (state the figure; a loss keeps its minus sign). Say
  "trading agents", not "AI traders"; say "paper" wherever a trade figure shows.
- Music: the owner sends the ClawVille track. Yami-ichi is Shinjuku's theme, not ours. Run `music-map.py` on it.
- Real only: every frame is a real recording; every claim has a checked source (BRIEF §3).
- Capture: WebGPU client, record the real headed Chrome window with ffmpeg `gfxcapture` (MCP screenshots cannot see the
  WebGPU canvas); never `bun run dev`; long rigs through the managed launcher (a hook blocks detached shells).

## 3. What exists (all local, nothing committed or pushed)
- Worktree `ClawVille/.worktrees/video-production`, branch `docs/video-production` (from origin/staging a2a073a7).
- `docs/video-production.md`: standing brief (ASK fields), what is live where (dated updates), owner rules, roles,
  rig plan + camera notes + shot list S1-S13 (S2/S2b room beats), traps.
- `scripts/film/arena-probe.mjs`: read-only take logger (public arena API -> `arena.jsonl`); passed 11/11 on a local
  mock and ran against live staging. Rate budget: 60 req/min/IP per route, shared with the filmed browser.
- `brag-output-2026-09-30-arena/BRIEF.md`: deliverable, scope gate, 19 claims with sources, beat table v0 (70 s, 120 BPM
  placeholder), 30 s social cut, decision Q11, delivery plan, share copy draft.
- `brag-output-2026-09-30-arena/composition/`: Hyperframes project from the house template, re-skinned to Register B
  (tokens, Anton/Barlow, textured headline fills via drop-shadow filters, brand card with the pirate mascot). All 14
  beats' graphics are built; every footage slot is a labelled `.placeholder`. `npx hyperframes check` = 0 errors. Agent
  cards use the served template taglines (cut only). No music lane yet.
- Private storyboard page for the owner: https://claude.ai/artifact/VoNmp2nz38eUS3VsLeVabk (v11; source
  `brag-output-2026-09-30-arena/storyboard/arena-storyboard.html` + `storyboard/frames/`; from a new session publish
  with `url` after `action: read`).
- No film rig yet (`film-rig.mjs` not written): write it against the live UI.

## 4. Live state at 23:46Z (re-read before use)
- Production `d69d4cbe` (PR #307): arena live (protocol 79, 10 desks), interior **v4** (solid gold claws, walnut desks,
  leather chairs, amber CLAW TERMINAL screens). Contest board earlier had house rows only.
- Staging `ed47c8e1`: interior **v5 part 1** (green plinth claws, avatar sits on the chair, "My trader" ~1.5 s after E,
  Escape keeps the seat, no camera flips, left-drag turns the camera). Staging board lists test accounts
  (ParityAudit-324303, LandTest1, LandTest2).
- Planned, not built: part 2 (room 1.5x, house agents standing at the big screen, walk-up template choice = founder P15,
  velvet ropes, water + coral). It would be the best "use its template" shot if it lands in time.
- Contest "Trading Arena Week 1": 2026-09-30 22:00Z to 2026-10-05 03:59:59Z, prizes 1,000,000 / 500,000 / 250,000
  $CLAWVILLE, paid by hand after review; eligibility needs one qualifying closed trade in the window.
- House agents were all down on paper in the contest window at the last reads (prod 16:18Z: Mid-Cap Climber +$6.92 was
  the only plus). This is open question Q11.

## 5. Claim traps already found
- Tuner: auto-applies only after >= 20 closed trades + a split check (D27); the only `house-tuner` row (Runner
  2026-09-30 18:01Z) was reverted by the admin template v2 reset: do not film it alone as proof. Founder P16 wants
  30-60 min tuning later. Caption fallback: "EVERY 30 MINUTES / IT REVIEWS ITS TRADES." without the tune line.
- Founder P14: house agents can be switched to LIVE by the founder: read each house agent's mode before "paper" lines.
- Exits: film only from builds with D23 (TP needs a confirming quote); check every filmed exit's reason vs P&L sign;
  never film an `unresolved` close as the result.
- Public events of a PLAYER agent carry only entry/exit/param_change/status; skip reasons are in the owner's own desk
  panel only (film that).
- Paid add-ons only after the build's D18 check and `paymentsEnabled` on the filmed box; otherwise "FREE DISCOVERY FEED."
- Hard rules are FIVE (D26 dropped the $5k liquidity floor).
- TV legibility limit from the spawn (P6): get the camera near the board for close-ups.
- `npx hyperframes snapshot` sends frames to Gemini unless `--describe false`.

## 6. Open questions for the owner (11; the storyboard page has the recommendations)
1 music track · 2 where it goes / length cap (the post can double as the owed contest announcement) · 3 which room and
box (recommended: production now; re-shoot the template beat if part 2 lands) · 4 which account launches the filmed
trader (one agent per account; it enters the contest) · 5 voice + hook (A "FIVE TRADING AGENTS. ONE FLOOR." -> "NOW
MAKE IT SIX.") · 6 brand card content + links · 7 paid x402 feed on camera or picker only · 8 ClawPump dashboard shot ·
9 delivery place/names (laptop Downloads, ClawVille-ARENA-v<N>) · 10 the three garbled kickoff lines · 11 how to show
the house agents' losses on the board (recommended: honest, button "THE HOUSE IS DOWN. YOUR MOVE.").

## 7. Next steps for the fresh session
1. demo-director Step 0 (sync the kit, read LESSONS.md, read the standing brief in `docs/video-production.md`).
2. Re-read live state (both `/health`, arena `/templates`, `/contest`, `/leaderboard?window=contest`, house modes).
3. Get the owner's answers (at least 1, 3, 4, 11) and the go; pin the beat table to the track.
4. Write `scripts/film/film-rig.mjs` (headed Chrome, gfxcapture, shot list, rig.log); rehearse; take the shots.
5. Edit (replace placeholders), render, own QC + demo-qc, deliver (poster, chat encode < 30 MiB, share copy, laptop copy),
   docs PR (CI green, merged; deploy-status same diff), append lessons to the kit's LESSONS.md, sync the kit.
