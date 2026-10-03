# BRIEF - Trading Floor arena demo (2026-09-30 plan; FINAL 2026-10-02)

Status: DONE. Posted by the owner as the ClawPump AnsemHack submission: `ClawVille-ARENA-v5.mp4` (70 s, female voice,
"Claw Exchange" Suno track). Owner sign-off 2026-10-03: "it was a great video for the submission". The final beat table,
process and traps are in `docs/video-production.md` sections 2-10; this file keeps the planning history (sections 4b-5a
are v1, superseded by the v4/v5 table in the runbook).

## 1. Deliverable
- Type: main demo (hackathon final submission) + an optional 30 s social cut from the same footage.
- Length: about 70 s (main), 30 s (social). Platform: X (16:9, 1920x1080, 30 fps). ASK: where the
  video goes (X post, the Clawrena form, the stream) and any length cap. The live page
  (clawpump.tech/ansemhack, read 2026-09-30 ~12:00Z) names no video rule and no length cap; final
  deadline "1 October 2026, 24:00 EST (UTC-5)" = 2026-10-02 05:00Z; judging 28 Sept to 7 Oct.
- The ONE thing a viewer must believe: in ClawVille anyone can walk onto the Trading Floor, watch
  five house trading agents compete in public, pick one agent's strategy as a template, and launch
  their own trading agent from the floor in about a minute.
- Voice: ClawVille Register B (Neon Broadcast) type over real game footage: huge condensed caps,
  short declaratives, playful and confident, no persona. ASK (see docs/video-production.md).
- Music: the ClawVille track from the owner (not yet received). Yami-ichi is Shinjuku's theme, not
  ours. All times below assume 120 BPM (one bar = 2.0 s), drop A at video 2.0, drop B at 34.0, the
  loudest phrase at 50.0. Re-pin every time after `music-map.py` reads the real track.

## 2. Scope gate (read 2026-09-30 ~12:00Z; re-read before capture)
- Current promotion scope: the Trading Floor arena (paper contest), owner 2026-09-30.
- Inside scope: yes.
- What is live where (read on the real boxes today):
  - production `api.clawville.world`: `/health` commit `61fdcffc` (master, PR #304, 2026-09-28).
    The 3D Trading Floor building, big board and flying trade chips are in master (commit
    `10575a98` "player trading and agent launch read Coming soon; watching the house bots stays
    live"). `/api/floor/house-traders`: Genesis and ClawVille Runner both `not-yet-running`.
    `/api/floor/arena/templates`: 404.
  - staging `api-staging.clawville.world`: `/health` commit `c56ef074`.
    `/api/floor/house-traders`: Genesis `live-observed` (62 verified trades, realised -$18.12),
    ClawVille Runner `live-observed` (14 verified, realised +$6.14). `/api/floor/arena/templates`: 404.
  - the arena itself: IN BUILD on `feat/trading-floor-arena` (worktree
    `.worktrees/trading-floor-arena`, uncommitted, base `a2a073a7`), session tradeDeskMain.
- UPDATE 2026-09-30 14:31Z (read by the probe + curl): the arena is LIVE ON STAGING. `api-staging` `/health`
  commit `315abf26` (the arena commit "Trading Arena paper contest ... protocol 74"). `/templates`: 5 templates
  and 5 house agents, all `active`; the engine started about 14:29Z; open paper positions Genesis 4, Runner 2,
  Dip Hunter 5, Mid-Cap Climber 0, Late Bloomer 0; no closed trade yet, so every realised figure is $0.
  `/addons`: `paymentsEnabled: true`, the two Nansen feeds ($0.01 and $0.05). `/contest`: "Trading Arena Week 1",
  22:00Z 2026-09-30 to 03:59:59Z 2026-10-05, prizes 1,000,000 / 500,000 / 250,000 $CLAWVILLE. During the deploy
  flip (about 14:29-14:31Z) the routes answered 200 and 404 in turn (old and new containers); stable after.
  Production is unchanged (`61fdcffc`, arena 404).
- UPDATE 2026-10-01 05:52Z: staging runs `9b3c1f93` (arena protocol 76, interior v3 "The Claw Exchange", the
  stall fix); production unchanged (`61fdcffc`, no arena). Deadline: 2026-10-02 05:00Z.
- UPDATE 2026-10-01 16:18Z: PRODUCTION HAS THE ARENA. `api.clawville.world` `/health` = `b8d52ab6` (PR #305,
  merged 13:30Z): arena (protocol 77) + interior v3 "The Claw Exchange"; NOT interior v4. Production contest board
  (house rows only, no test accounts): Mid-Cap Climber +$6.92 (4 trades), Late Bloomer -$2.29 (2), Runner -$15.57
  (3), Dip Hunter -$18.35 (14), Genesis -$105.81 (17). Staging serves `31480fb0` (protocol 78); interior v4
  (`50ae7644`..`91608cd8`: solid 3D gold claws on a lighter marble plinth with gold lines, walnut-and-brass desks with
  phones and keyboards, rounded leather chairs, monitor banks on stands with amber "CLAW TERMINAL" screens, a brass
  door with glass doors; layout, seats, camera, board and tape unchanged) was deploying to staging at 16:18Z and may
  reach production in the next promotion (relayed by session coolerDesk2; commits checked in git). Re-check S2, S2b
  and S8 against the room on the box we film.
- UPDATE 2026-10-01 23:46Z: production = `d69d4cbe` (PR #307, merged 22:46Z; protocol 79; 10 desks) with interior v4
  (solid gold claws, walnut desks, leather chairs, CLAW TERMINAL screens). Staging = `ed47c8e1` with interior v5 part 1
  (plinth claws GREEN like the roof claw; the sit rebuilt: the avatar sits on the chair, "My trader" opens ~1.5 s after
  E, Escape keeps the seat; spring-arm camera with no flips; left-drag or one-finger drag turns the camera). Part 2 is
  planned, not built (room 1.5x larger, 10 desks, the Trading Monitor on the door wall, the five house agents standing
  in front of the big screen, velvet ropes, shallow water + coral; relayed by session coolerDesk3, matches founder
  decision P15 in the arena spec). Founder decisions 2026-10-01 evening (arena spec §8): P14 the founder switches each
  HOUSE agent between paper and live himself and the board shows the mode -> check every house agent's mode before any
  "paper" caption; P15 big screen shows all five house agents side by side, house agents stand at the big screen, a
  player picks a template by walking up to one (the best S5 beat once built); P5 a dedicated ClawPump agent per player
  with deposit/withdraw (in build); P16 30-60 min self-tuning via shadow trades (planned, not built).
- Can real users do what the video shows, today? YES on production since 2026-10-01 13:30Z (arena + v3 room).
- Gate: capture waits for (1) the arena on production (or the owner's "staging is fine, it's a
  demo"), (2) the five house agents running long enough to show trades, P&L and at least one real
  30-minute rule change, (3) the owner's track. The owner decides (1).

## 3. Claims (every sentence on screen or in the post; draft, none checked yet)
| # | Claim (draft words) | Source that must prove it | Checked |
|---|---|---|---|
| 1 | FIVE TRADING AGENTS. ONE FLOOR. | `GET /api/floor/arena/templates` (5 house agents) + the board frame. Staging 14:31Z: 5 house agents, all active (API only; the board frame not seen yet) | partly |
| 2 | paper trades at live market quotes | spec D3 (ClawPump `/swap/quote` fills + 2.5% / 1.0% haircut); the filmed positions' fill sources are `quote` or `quote_confirmed` (the D4 fallback books at a confirmed current quote after the Codex r3/r4 fixes, no longer at a mark); check every filmed trade | no |
| 3 | EVERY TRADE ON THE BIG BOARD. | the board frame (arena leaderboard + tape) during the take | no |
| 4 | the five template lines (one per agent) | `FLOOR_ARENA_TEMPLATES[].tagline` as the UI shows it; shorten only by cutting words, never adding. The composition cards now use the served taglines (staging 14:31Z), cut down | partly |
| 5 | EVERY 30 MINUTES / IT REVIEWS ITS TRADES. / (IT CAN TUNE A RULE.) | a real 30-minute report on a public house profile (D21; the first one arrived 2026-09-30 15:03Z, Runner). The tune line only with a real change or suggestion on screen: since D27 the tuner auto-applies only after >= 20 closed trades on the current params plus a split check (filter changes only), and the house agents were reset to template v2 (migration 0072), so a real change may not exist at filming time. Fallback: drop the tune line and the box. Note (2026-10-01 06:10Z): the only `house-tuner` row so far is Runner 2026-09-30 18:01Z (`filters.chg5m_max` 41.48 -> 20.74), which D27 judged unsupported and the admin template v2 reset replaced; do not film it as the proof unless the reset row shows with it. Prefer a post-D27 tuner change | partly |
| 6 | LIKE ONE? USE ITS TEMPLATE. | the profile's template button frame | no |
| 7 | EDIT ANY RULE. | the params form frame (an edited field) | no |
| 8 | SAFETY RULES STAY LOCKED. | `FLOOR_ARENA_HARD_RULES` shown read-only on the form. Served labels (staging `9b3c1f93`, 2026-10-01 05:52Z), FIVE since D26 dropped the $5k liquidity floor: "LP burned or locked (95% or more)", "Mint authority revoked", "Freeze authority revoked", "Token-2022: no transfer fee or risky extension", "Pool reserves present" | partly |
| 9 | FREE DISCOVERY FEED. / optional paid x402 feeds | "Paid add-ons" + "No paid add-ons. Your agent reads the shared free discovery feed." (UI). The paid half only after the build's D18 check passes (one real $0.01 Nansen call through the REST x402 wrapper on staging) AND `FLOOR_ARENA_ADDON_PAYMENTS_ENABLED` is on where we film; otherwise the caption is "FREE DISCOVERY FEED." alone | no |
| 10 | PAPER ONLY. FOR NOW. | "Coming later" on the live option (UI); D11 `live_not_available` | no |
| 11 | LAUNCHED. / ITS OWN CLAWPUMP AGENT. | `GET /api/floor/arena/me` `provision_state='ready'` + `clawpump_agent_id` for the filmed agent; optional: ClawPump `GET /agents/:id`. The ClawPump name is `CV Arena · <name> #<12-char id suffix>` on production (8 -> 12 after the Codex r2 fixes) and `CV Arena (staging) · ...` on staging (build D16): a staging take shows "staging" wherever that name appears | no |
| 12 | IT TRADES WHILE IT SITS HERE. | UI line "Your agent opens new positions only while it sits at a Trading Floor desk. Exits always run." (D7) | no |
| 13 | EVERY DECISION, LIVE. | "Decision stream" frames of the FILM ACCOUNT'S OWN desk panel (owner view). After the Codex r2 fixes the PUBLIC events of a player agent carry only entry / exit / param_change / status, so skips and their reasons are owner-only and the probe cannot log them: read them off the recording | no |
| 14 | a result headline on the exit row (only the real figure) | the exit event + `floor_arena_positions.pnl_mult` of that trade; use only a resolved exit (fill source `quote` or `quote_confirmed`, non-null P&L). After the Codex r5 fix a position can close as `unresolved` with NULL P&L after 30 min of quote failures; never film that one as the result. Also: on staging `315abf26` a `tp` exit booked a LOSS (the trigger used the DexScreener mark, the sell quote was lower; build status 14:47Z, decision D23). Film exits only from a build that contains D23 (`fcc60ed2` or later) and check that every filmed exit's reason matches the sign of its P&L | no |
| 15 | YOU VS THE HOUSE. | the board frame with the filmed agent's row beside house rows. The TV reads the CONTEST window; at 2026-10-01 05:52Z every house agent was down on paper there (-$2.32 to -$61.97) and staging also listed test accounts (ParityAudit-324303, LandTest1, LandTest2). Figures stay as shown (a loss keeps its minus sign); see decision Q11 | no |
| 16 | TRADING ARENA · WEEK 1 / TOP 3 BY PAPER P&L WIN $CLAWVILLE / 1,000,000 · 500,000 · 250,000 | `GET /api/floor/arena/contest` + the "Prizes" UI; owner 2026-09-30: "yes we will pay this out as a real reward in real clawville tokens" | no |
| 17 | NOW MAKE IT SIX. | the board shows the filmed agent as a sixth row (five house + one) | no |
| 18 | fine print: one real session · date · clawville.world | the take's rig log | no |
| 19 | (optional) EVERY REPORT BECOMES ITS MEMORY. | D29: every FULL 30-minute report of a player agent is stored as an earned-skill lesson of the owner's avatar (warm ElizaOS runtime, else `npc_memories`), and owner chat folds up to 3 Trading Floor lessons in; one API log line names the store. Proof for the take: that log line for the film agent, or the lesson visible in its chat. This is the owner's "self-learning" end goal | no |

Words that must not appear: em dashes (BRAND.md §8); "casino"; "CT" for vCLAW; OOBE, SAP, Synapse
Agent Protocol; any link but the official ones (BRAND.md §8).
Overclaims to avoid, and why:
- "AI traders" / "AI decides": entries and exits are rules (params); only the 30-minute review uses a
  model. The existing Genesis note says "Rules only, no AI decisions." Say "trading agents".
- "profitable", "wins", "beats the market": Late Bloomer loses about the round-trip cost
  (TEMPLATES_2026-09-30.md §2.5); all evidence is in-sample, small n.
- "live trading" without "paper": the contest is paper only (D11).
- "real money", "real trades": fills are paper at quoted prices.
- "anyone" / present tense: only after the arena is live on production (scope gate).
- a prize claim not shown by the contest UI of the day.

## 4. Footage
None yet. Planned takes and shots: docs/video-production.md section 3 (the shot list S1-S13).

## 4b. Owner decisions and live read (2026-10-02 01:06-01:35Z, session filmit lead)
- Owner (01:15Z): "we're going to do it on staging ... we're going to submit our demo ... using staging footage." Wait
  for the house agents to be visible (P15) before capture: "i'll give you guys the go when the sessions working on it
  are finished." The X post goes out tonight; production can follow tomorrow morning.
- Owner: film account = a new account I create, email verified (no verify banner), ready to fund. Board: "show it
  honestly", but with more rows: "four or five of the available agent desks occupied by characters for the sake of the
  video ... whether we set them up as real accounts or not." Length: "done in the next hour or two."
- Live read 01:06Z: staging `ed47c8e1` (v5 part 1), production `d69d4cbe` (v4). No `mode` field in the public arena
  API on either box: every house agent is paper (P14 live switch not deployed). Staging contest board: Runner +$27.24,
  ParityAudit-324303 +$8.92, Mid-Cap Climber -$1.26, LandTest2 -$13.94, LandTest1 -$55.08, Late Bloomer -$85.68, Dip
  Hunter -$109.66, Genesis -$284.71. Add-ons `paymentsEnabled: true` on both.
- Done 01:31-01:34Z (staging, `scripts/film/demo-accounts.mjs`): five REAL demo accounts, each with a real paper agent
  launched from a template and seated by the API: Kelp Capital (genesis, max hold 1200 s, desk index 1), Coral Quant
  (dip-hunter, 3), Tidepool Trader (late-bloomer, 5), Deep Blue Desk (midcap-climber, 7), Brine Fund (genesis, max
  mcap $200k, 9). Their trades are real paper trades on the same engine. Film account "Reef Rookie"
  (`cv-film-...@clawville.guest`), no arena agent yet, `email_verified` set true in the staging DB (owner request),
  confirmed by `/api/auth/me`.
- Gap 1: no build renders a figure at a desk for a seated arena agent (staging, p15-int, tfx-v5 read 01:25Z). P15 shows
  only the five house agents at the big screen. Desk characters need build work.
- Gap 2: every demo launch got `provision failed: clawpump_budget_exhausted` (the arena writer's own ClawPump call
  bucket: 60 a minute, burst 10; retry after 10 min, max 5 tries; "Paper trading continues"). The film launch must run
  when the bucket is full, or the "ITS OWN CLAWPUMP AGENT." line drops.
- Claim trap: the demo accounts are team-made. No caption may say or imply how many people trade ("players",
  "traders joined"); the board shows names and figures only.

- 01:57Z: staging web + API = `2eaace16` (v5 part 2 room, P15 house agents at the big screen + walk-up pop-up, P5
  withdraw). `/house-board` serves `mode: "paper"` for all five house agents (02:00Z): source for every "paper" line.
  The P15 big screen shows only the five house agents (one column each, every column "PAPER"), so S10 moves to the
  Exchange "Arena leaderboard" (the film row gets a "You" pill). Claim 2 checked 02:08Z: demo exits read "via quote"
  (`fillSource: "quote"`), entries carry the quote's price impact.
- Rehearsals (filmitHelper, 02:05Z, rig `scripts/film/film-rig.mjs`, takes in `.film/takes/reh-*`): login + overlays,
  S1, S2, S2b, S5a, S5b-dry (pop-up "Choose this trading style"), S8, S7-dry to "Step 4 of 4" (Launch never clicked;
  the film account still has no agent). On-camera UI defects for the build session: "+$32.49realised" (pop-up, no
  space), "up to 32characters" (launch step 4, no space); one blank frame ~1.8 s after the walk-in arrival (cut around).

## 5a. Beat table v1 (2026-10-02 01:40Z; staging, v5 part 2 room + P15 house agents; ~56 s; 120 BPM placeholder until the track arrives)
| Video (s) | Beat | Real source (shot) | Caption | Effect | Sound |
|---|---|---|---|---|---|
| 0-4 | Hook | S1 exterior: the building, its green claw; 0.4x -> 1x at 2.0 | kicker "CLAWVILLE · THE TRADING FLOOR"; 2.0 slam "FIVE TRADING AGENTS." / "ONE FLOOR." | letterbox opens, flash, shake | build -> drop A |
| 4-9 | The floor | S2 spawn view of the part 2 room: the five house agents standing at the big screen, the board above | "EVERY TRADE ON THE BIG BOARD." (4.6) + sub "paper trades at live market quotes" (6.4) | zoom-through at the door (cut the curtain), slow push | whoosh |
| 9-16 | The five | S5a walk past the five standing house agents / the big screen's five panels; 1.4 s each | NAME slam + tagline cut (served text) | glitch cut per name | stamp |
| 16-19 | They review | S6 a house profile: "Latest 30-minute report" | "EVERY 30 MINUTES" / "IT REVIEWS ITS TRADES." (tune line only with a real post-D27 change on screen) | typewriter on the report line | ticks |
| 19-22 | Pivot | S5b walk up to one house agent -> the pop-up -> its template button | "LIKE ONE? USE ITS TEMPLATE." | hold wide, snap 1.8x on the button | riser |
| 22-28 | The form | S7 one field typed on camera, then the five locked hard rules | "EDIT ANY RULE." (22.4) / "SAFETY RULES STAY LOCKED." (25.6) | box on the field; glow boxes on 2 rules | keys |
| 28-30 | Mode | S7 mode: "Paper" on, live "Coming later" | "PAPER ONLY. FOR NOW." | bass gap, low-pass sweep | riser |
| 30-34 | Launch | S7 the Launch click; the success frame | "LAUNCHED." on the success frame (drop B); "ITS OWN CLAWPUMP AGENT." only if provision reaches ready on camera | lime flash, RGB burst, shake | drop B |
| 34-38 | Take a seat | S8 walk to a free desk, E, sit; "My trader" opens | "IT TRADES WHILE IT SITS HERE." | push-in | whoosh |
| 38-42 | The stream | S9 "Decision stream" of the film agent (owner view) | "EVERY DECISION, LIVE." + box on one real skip reason | box, tape-stop | tick |
| 42-46 | On the board | S10 the Exchange "Arena leaderboard" (Contest window): "House" pills, the demo rows, the film row with the "You" pill (the P15 big screen lists only the house agents) | "YOU VS THE HOUSE." | wide hold, snap to the film row | stamp |
| 46-51 | The contest | S11 contest panel: "Prizes", "Paper trading only" | "TRADING ARENA · WEEK 1" / "TOP 3 BY PAPER P&L WIN $CLAWVILLE." / 1,000,000 · 500,000 · 250,000 | gold gloss | bell |
| 51-53 | Button | S3 board wide, dimmed | "PULL UP A CHAIR." | slam, flash | hit |
| 53-56 | Brand card | graphics | "THE TRADING FLOOR" / "IS OPEN." (true: the arena is live on production since 2026-10-01 13:30Z) + clawville.world | mascot, gloss, black fade 55.1-56 | bell, fade |
Planned flashes / hard cuts (s): 2.0, 4.0, 9.0, 10.4, 11.8, 13.2, 14.6, 16.0, 19.0, 22.0, 28.0, 30.0, 34.0, 38.0, 42.0,
46.0, 51.0, 53.0. Fade: 55.1-56.0. Dropped from v0 (time): the add-on picker beat ("FREE DISCOVERY FEED."), the
tuner proof box, the honest-wait strip and the film agent's own exit figure (back in if a real exit lands during S9),
"NOW MAKE IT SIX." (false with the demo and test rows on the board).

## 5. Beat table (v0, SUPERSEDED by 5a; 70 s; times pinned to a 120 BPM placeholder)
| Video (s) | Beat | Real source | Caption (words) | Effect | Sound |
|---|---|---|---|---|---|
| 0-4 | Hook | S1 exterior: the town, then the Trading Floor building and its green claw; rate 0.4x -> 1x at 2.0 | kicker types "CLAWVILLE · THE TRADING FLOOR"; on 2.0 slam "FIVE TRADING AGENTS." / "ONE FLOOR." | letterbox opens on 2.0, white flash, shake, RGB split | build -> drop A |
| 4-10 | The floor | S2 v3 spawn view (twin Golden Claws, the gold-framed board) then S2b desk-row walk (monitor rigs, wall screens, the LED ticker with PAPER figures, chips) | "EVERY TRADE ON THE BIG BOARD." (4.6) + sub "paper trades at live market quotes" (6.2) | zoom-through at the door (glitch 3.9), slow push | whoosh |
| 10-18 | The five | S5 five profiles, 1.6 s each (or the board cards) | agent NAME slam + a short line from its UI tagline | stepIn per card, glitch cut every 1.6 s | stamp per card |
| 18-22 | They tune | S6 a house profile: "Latest 30-minute report" then "Rule changes" | kicker "EVERY 30 MINUTES" / "IT REVIEWS ITS TRADES." / "IT CAN TUNE A RULE." | typewriter on the report line; spotlight box on one from -> to row | ticks |
| 22-24 | Pivot | S5 the template button on one profile | "LIKE ONE? USE ITS TEMPLATE." | snap zoom 1.8x on the button (hold wide first) | riser starts |
| 24-31 | The form | S7 params form: one field edited (typed on camera), then the locked hard rules | "EDIT ANY RULE." (24.4) / "SAFETY RULES STAY LOCKED." (27.6) | box on the edited field; boxes on 2 locked rules | keypress |
| 31-34 | Feed + mode | S7 add-on picker, then the mode switch ("Paper trading" on, live "Coming later") | "FREE DISCOVERY FEED." (31.0) / "PAPER ONLY. FOR NOW." (32.5) | bass gap under 32-34, low-pass sweep | riser |
| 34-38 | Feature flash | S7 the Launch click on 34.0; "Setting up your ClawPump agent..." -> ready | "LAUNCHED." slams on the success frame; "ITS OWN CLAWPUMP AGENT." (35.4) + the real agent id decoding from block glyphs | white + lime flash, RGB burst, shake | drop B |
| 38-44 | Take a seat | S8 the avatar walks to a free desk, E, sits; "My trader" opens | "IT TRADES WHILE IT SITS HERE." (39.0) | push-in; seat ease | whoosh |
| 44-52 | The stream | S9 "Decision stream": skips with reasons, an entry; the honest wait (a 20x strip, "~N MIN LATER"); the exit row | "EVERY DECISION, LIVE." (44.4) / the real exit figure slams on its row frame (~50.0) | box on one skip reason; tape-stop into the skip; desaturate the wait | tapestop, loudest phrase at 50 |
| 52-56 | On the board | S10 the big board with the filmed agent's row; its chip flies | "YOU VS THE HOUSE." | wide hold, snap to the row | stamp |
| 56-62 | The contest | S11 contest panel: "Prizes", "Paper trading only", the window | "TRADING ARENA · WEEK 1" / "TOP 3 BY PAPER P&L WIN $CLAWVILLE." | gold gloss sweep on the prize rows | bell |
| 62-64 | Button | S3 board wide, dimmed | "NOW MAKE IT SIX." | slam, flash, shake | taiko |
| 64-70 | Brand card | graphics (BRAND.md §7 recipe) | "THE TRADING FLOOR" / "IS OPEN." (only if live on prod) + pills + footer link bar + fine print | pirate mascot hero, gloss, black fade 69.1-70 | bell, fade |

### 5b. Social cut (v0, 30 s, same footage; 120 BPM placeholder: drop A at 2.0, the next phrase at 18.0)
| Video (s) | Beat | Real source | Caption | Effect |
|---|---|---|---|---|
| 0-4 | Hook | S1 | "FIVE TRADING AGENTS." / "ONE FLOOR." on 2.0 | letterbox opens, flash, shake |
| 4-7 | The floor | S2 | "EVERY TRADE ON THE BIG BOARD." | zoom-through |
| 7-10 | The five | S5, 0.6 s each | the five NAMES only | glitch cut on each half beat |
| 10-12 | Pivot | S5 button | "LIKE ONE? USE ITS TEMPLATE." | snap zoom |
| 12-15 | The form | S7 | "EDIT ANY RULE." | box on the typed field |
| 15-18 | Mode | S7 | "PAPER ONLY. FOR NOW." | riser, bass gap |
| 18-20 | Launch | S7 success frame | "LAUNCHED." on 18.0 | lime flash, shake |
| 20-23 | Seat + stream | S8, S9 | "IT TRADES WHILE IT SITS HERE." | push-in |
| 23-26 | Contest | S11 | "TOP 3 BY PAPER P&L WIN $CLAWVILLE." + the three figures | gold gloss |
| 26-27.5 | Button | S3 dimmed | "NOW MAKE IT SIX." | slam |
| 27.5-30 | Brand card | graphics | as the main video | black fade 29.2-30 |

Planned flashes and hard cuts (s): 2.0, 3.9 (glitch) / 4.0, 10.0, 11.6, 13.2, 14.8, 16.4, 18.0,
22.0, 24.0, 34.0, 38.0, 44.0, ~50.0, 52.0, 56.0, 62.0, 64.0.
Planned fades: 69.1-70.0 (black layer over everything).
Hook alternates (owner picks): "FIVE TRADING AGENTS. ONE FLOOR." -> button "NOW MAKE IT SIX." ·
"WATCH THEM TRADE." -> "THEN COPY ONE." -> button "YOUR SEAT IS OPEN." · "THE TRADING FLOOR IS OPEN."
-> button "PULL UP A CHAIR."

## 5c. Decision for the owner (Q11, 2026-10-01): the board shows losses
The TV reads the contest window. At 05:52Z on staging every house agent was down on paper there (Mid-Cap
Climber -$2.32, Runner -$14.86, Dip Hunter -$21.62, Late Bloomer -$31.08, Genesis -$61.97), and three staging
test accounts sat on the same board. Truth rules forbid changing or hiding a figure. Options:
A) show it and frame the board beat as a challenge (button "THE HOUSE IS DOWN. YOUR MOVE."), recommended;
B) keep board shots wide, so figures are not readable, and let the player's own row carry the result;
C) film on production after promotion, where the board starts fresh (no test accounts), and take whatever it
shows at that time. C combines with A or B.

## 6. Deliver (proposed; ASK)
- Master: `brag-output-2026-09-30-arena/arena.master.mp4` (poster frame 0 from the LAUNCHED frame).
- Chat encode: `arena-chat.mp4` (< 30 MiB, two-pass).
- Destination: `laptop:C:/Users/newma/Downloads`, names `ClawVille-ARENA-v<N>.mp4` + `-poster.jpg` +
  `-share-copy.txt`.
- Share copy draft (claims unchecked; it can double as the contest announcement post, which the build's
  FOUNDER-REVIEW entry lists as owed): "Five trading agents run the ClawVille Trading Floor, on paper,
  in public. Pick the one you like, start from its template, and launch your own from the floor.
  Trading Arena Week 1 runs until Sunday Oct 4, 11:59 PM EDT: top 3 by paper P&L win
  1,000,000 / 500,000 / 250,000 $CLAWVILLE."
- Contest window (build spec D6 + FOUNDER-REVIEW, 2026-09-30): 6 PM EDT Wed 2026-09-30 (22:00Z) to
  11:59:59 PM EDT Sun 2026-10-04; paper P&L of positions opened and closed in the window; $20 per
  position; one agent per account; no guests; house agents shown, not eligible; paid by hand after an
  abuse review.
- Path for the takes (FOUNDER-REVIEW, 2026-09-30): `/game` -> walk to the Trading Floor (south of the
  ring) -> E at the door -> `/trading-floor`; the back-wall TV; E at a desk to sit; E at the kiosk opens
  the Exchange modal's Trading Floor tab with the Trading Arena section at the top.
- Docs: `docs/video-production.md` (standing brief, live-where, rig, footage maps, beat tables,
  traps) + `scripts/film/`, one docs PR, CI green, merged (kickoff).

## 7. Review log
| Round | Reviewer | FAILs | Fixed in |
|---|---|---|---|
| 1 | demo-qc | | |
