# QC brief: ClawVille Trading Floor arena demo v1 (2026-10-02)

File: `C:\Users\itachi\Documents\Crypto\clawville\.worktrees\video-production\brag-output-2026-09-30-arena\arena-v1.master.mp4`
(1920x1080, 30 fps, 71.5 s). ClawPump hackathon final submission, posted on X tonight. NO MUSIC YET (voice + SFX only;
the owner's Suno track goes in later). Composition: `composition/index.html`, beats `composition/beats.json`,
clips `cuts.sh`, voice script `vo/vo-lines.json`. Real footage: staging.clawville.world, web/api 2eaace16, recorded
2026-10-02 02:28-03:07 UTC by the film rig (`.film/takes/real-*.mp4`, maps `.film/maps/*.md`, log `.film/rig.log`).

Known and already fixed for v1.1 (do not report): the stream beat's first ~0.2 s (42.4-42.7 s) is dark (clip started
inside a scroll).

## Owner rules (binding)
- Every frame real (speed, crop, zoom, grade, graphics OK; no invented UI, numbers or receipts). Every claim checked.
- No em dashes. Never "casino". vCLAW = in-game currency, $CLAWVILLE = token, never "CT". Never OOBE / SAP.
- No boast words about traders ("winning", "profitable", "beats the market"). A loss keeps its minus sign.
- Say "trading agents" not "AI traders". Say "paper" wherever a trade figure is claimed.
- Demo accounts on the board are team-made real accounts with real paper agents: no caption may say or imply how many
  people trade.
- Content: a coin named "Nigerinu" must never be readable (real-s6 "Recent trades" list). The line "Execution wallet
  setup failed (clawpump_budget_exhausted)" should not be readable (it is a real staging bug, not a claim).
  No secret keys, wallet secrets, emails, or local-time zone chips.

## Beat table (video seconds) with the voice line under each
| t | beat | footage | caption | VO |
|---|---|---|---|---|
| 0-3.6 | hook | real-s1 exterior (HUD hidden, blurred) | CLAWVILLE · THE TRADING FLOOR / FIVE TRADING AGENTS. ONE FLOOR. (drop 2.0) | "This is the ClawVille Trading Floor." |
| 3.6-10 | floor | real-s2 spawn view, five house agents under the big board | THE BIG BOARD / EVERY HOUSE AGENT ON THE BIG BOARD. / paper trades at live market quotes | "Five house trading agents trade here in public, on paper, at live market quotes." |
| 10-18 | five | real-s5a walk past the five (1x) | cards on each spoken name 12.35/13.4/14.19/15.24/16.81: GENESIS, RUNNER, DIP HUNTER, MID-CAP CLIMBER, LATE BLOOMER + cut taglines | "Each one runs its own strategy. Genesis. Runner. Dip Hunter. Mid-Cap Climber. Late Bloomer." |
| 18-22 | review | real-s6 Runner "Latest 30-minute report" (crop y 110-690) | EVERY 30 MINUTES / IT REVIEWS ITS TRADES. | "Every thirty minutes, each one reviews its own trades." |
| 22-26 | pivot | real-s7 walk-up pop-up, push onto "Choose this trading style" | LIKE ONE? USE ITS STYLE. | "Like one? Walk up, and choose its trading style." |
| 26-28.33 | form | real-s7 Step 2: Max open positions typed 5 -> 3 | THE TEMPLATE / EDIT ANY RULE. | "Change any rule you like." |
| 28.33-31.8 | lock | real-s7 Step 2 top: the five hard rules card | EVERY AGENT / SAFETY RULES STAY LOCKED. | "The safety rules stay locked for every agent." |
| 31.8-33.8 | mode | real-s7 Step 2: "Paper trading" / "Live trading Coming later" | PAPER ONLY. FOR NOW. | "Paper only, for now." |
| 33.8-36.04 | launch | real-s7 Step 4: name "Reef Rookie", Launch click | (none) | "Launch, and your agent joins the floor." (starts 35.5) |
| 36.04-38.8 | launchHit | real-s7 success card "Reef Rookie is ready · Paper trading · Setting up your ClawPump agent..." (first success frame = 36.04) | LAUNCHED. | (cont.) |
| 38.8-42.4 | seat | real-s8 walk to desk 3, sit, My trader opens | TAKE A SEAT / IT TRADES WHILE IT SITS HERE. | "Take a desk. It trades while it sits there." |
| 42.4-49 | stream | real-s9 band: SCAN "Scanned 1555 coins: 0 passed..." + STATUS "Sat down at desk 3. New entries are on." | DECISION STREAM / EVERY DECISION, LIVE. | "Every decision streams live. It scans free feeds, ClawPump signals among them, and every fill is priced by a live ClawPump swap quote." (to 52.7) |
| 49-52.9 | quote | real-s3 big board + footer "PAPER: $20 A POSITION, 2.5% BUY + 1% SELL COSTS..." | EVERY PAPER FILL / LIVE CLAWPUMP SWAP QUOTES. | (cont.) |
| 52.9-56.5 | board | real-s10-after-2 Exchange "Arena leaderboard" (Contest), snap to "#4 Reef Rookie You" | YOU VS THE HOUSE. | "Then it's you, against the house." |
| 56.5-66.6 | contest | real-s11 banner (56.5-60) then "Contest rules" (60-66.6) | TRADING ARENA · WEEK 1 / TOP 3 BY PAPER P&L WIN $CLAWVILLE. / 1ST 1,000,000 (62.05) 2ND 500,000 (63.47) 3RD 250,000 (65.24) $CLAWVILLE | "Trading Arena, week one. The top three paper results win one million, five hundred thousand, and two hundred fifty thousand ClawVille tokens." |
| 66.6-68.4 | button | real-s3 board dimmed | PULL UP A CHAIR. | "Pull up a chair." |
| 68.4-71.5 | brand | graphics | CLAWVILLE × CLAWPUMP / THE TRADING FLOOR IS OPEN. / 5 house agents · 5 templates · paper contest / clawville.world · @Clawville_World / fine print "recorded on staging.clawville.world, 2 Oct 2026 · paper trades priced from live ClawPump quotes" | "ClawVille dot world." |

Planned hard cuts / flashes (s): 2.0, 3.6, 10.0, 12.35, 13.4, 14.19, 15.24, 16.81, 18.0, 22.0, 24.9 (push), 26.0,
28.33, 31.8, 33.8, 36.04, 38.8, 42.4, 49.0, 52.9, 53.8 (snap), 56.5, 60.0, 66.6, 68.4. Fade to black 70.6-71.5.

## Claims and their sources (checked by the editor; verify what you can)
1. Five house trading agents, paper, active: `GET https://api-staging.clawville.world/api/floor/arena/house-board` (each `mode: "paper"`, `status: "active"`); the big board columns read PAPER.
2. "paper trades at live market quotes" / "every fill is priced by a live ClawPump swap quote": code `apps/api/src/services/floor-arena/pricing.ts` on origin/staging line ~12 ("Fills: ClawPump backend POST /swap/quote ... the same quote a live buy would take"); exits read "via quote"; contest rules panel: "Every paper buy costs 2.5% and every paper sell costs 1% on top of the live quote".
3. "It scans free feeds, ClawPump signals among them": `apps/api/src/services/floor-arena/discovery-hub.ts` source `clawpump:signals` (with DexScreener, GeckoTerminal); a demo entry at 02:44:51Z read "via clawpump:signals".
4. Five names + taglines: `GET /api/floor/arena/templates` taglines, cut only (never reworded).
5. "Every thirty minutes, each one reviews its own trades": the "Latest 30-minute report" card on the house profile ("Written 9m ago", tuner line).
6. "Choose its trading style": the P15 pop-up button "Choose this trading style".
7. "Edit any rule" / "Change any rule you like": Step 2 "Change any rule inside its limits." (note: inside its limits).
8. "Safety rules stay locked for every agent": Step 2 card "Every arena agent follows these rules ... No one can turn these off".
9. "Paper only, for now": "Live trading / Coming later"; server refuses live mode.
10. "LAUNCHED." / "your agent joins the floor": POST /me/launch 201 at 03:00:04Z; success card "Reef Rookie is ready".
11. "It trades while it sits there": My trader "Your agent opens new positions while it holds the desk."; Step 4 "Your agent opens new positions only while it sits at a Trading Floor desk."
12. "Every decision, live": the film agent's own Decision stream (SCAN + STATUS).
13. "You vs the house": leaderboard row "#4 Reef Rookie You" with House pills on other rows.
14. Contest: `GET /api/floor/arena/contest` "Trading Arena Week 1", prizes 1,000,000 / 500,000 / 250,000 $CLAWVILLE; "top three paper results": rules "Best realised paper P&L wins" (house agents cannot win; prize needs a qualifying closed trade).
15. "The Trading Floor is open": the arena is live on production clawville.world (d69d4cbe) since 2026-10-01; footage is staging (fine print says so).

## Report format
PASS/FAIL per item with exact timestamps (video seconds). For each FAIL: what is wrong, why (rule or source), and the
smallest fix. Read-only: do not edit any file.
