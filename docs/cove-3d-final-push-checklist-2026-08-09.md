# Cove 3D Poker Rings — Final-Push Visual Checklist (2026-08-09)

**For the founder.** This is the walk-through list for signing off the live poker rings.
Everything below is already merged onto current staging (`feat/cove-3d-reland`, ~150 cove
commits + the 2-week staging catch-up), builds green, and is ready to deploy to
**staging.clawville.world** the moment this branch is pushed. Nothing goes to prod
(master) until you have walked this list.

## What is already verified mechanically (no eyes needed)

- Rebased/merged onto today's staging (land sprint, salvage, cold-load diet, kelp camera
  fix all included). 5 merge conflicts, all resolved and re-tested.
- Protocol manual version now **49** (staging was 48; the cove recovery contracts stack on top).
- Web typecheck **0 errors** · API typecheck **0 errors** · web build passes.
- Web tests 800 pass / 2 fail — both failures are **pre-existing staging land-domain
  pins** (`land-appearance-options`, `land-proximity`), identical on staging itself,
  untouched by this branch. Flagged to the land owner, not fixed from here.
- API cove suites all green (cash tables 26/26, fixtures 28/28, protocol 12/12).
  Full-suite red on this dev box is environment-only: pristine staging shows MORE
  failures (194) than this branch (115) under the same local conditions.
- Cove DB migrations renumbered **0057 + 0058** (branch-era 0025/0026 collided with
  staging's). Both idempotent; staging CI applies them on push.

## AGENT WALKTHROUGH RESULTS (2026-08-11, run against the DEPLOYED staging build)

A full scripted browser walkthrough was driven with the staging test accounts
(`scripts/staging-walkthrough*.mjs` — reusable). What is PROVEN live:

- **Two-player multiplayer hand, end to end:** one account created a private
  table (real one-time join code), the second joined via "Have a code?", the
  server dealt, BOTH clients acted through all four streets, the hand settled at
  showdown with exact pot math (Pot 40 vCLAW, net -20 loser), the next hand
  auto-dealt with the live ~20s server turn clock and raise-TO slider, and both
  players walked away with cash-out. 7/7 checks green.
- **Blackjack real-money hand:** bet 5 vCLAW, dealer 19 vs 14, "YOU LOSE Net -5,
  Rake 0", balance strip consistent, provably-fair commit + client seed shown.
- **Lobby:** all three tabs live with real data; restored stakes ladder verified
  on the Create tab; creator-cap error surfaces as human copy ("You already have
  the max open tables"); guest gets browse + no Deal button; 7-viewport sweep
  (phone + iPad, both orientations) green.
- **Fixes shipped from findings:** (1) seated players no longer see the
  misleading "Sit down to start the game" copy (now "You are seated — the game
  starts when another player joins."); (2) the dead "Seeded agents" knob was
  removed from the player create form — the server seats bots ONLY at house
  tables by design (house-bank drain guard; GameFeatures documents the P1 stub),
  so the control silently did nothing.
- **P1 backend follow-up (flagged, not fixed here):** abandoned EMPTY
  player-created tables never expire, so they accumulate against the 3-table
  creator cap forever (landtest1 is already capped from July tables). Needs an
  idle-empty-table sweeper in `cash-table-manager` — backend money-path round.

## 2026-08-16 FOUNDER REPORT TRIAGE — the "disastrous poker" screenshots were PROD, not staging

The founder's three screenshots (settle banner over an empty table, blinds 1/2 and
25/50, "Sit down to start the game." while seated) were taken on **production**
(`clawville.world/cove/table`), which still serves the **July build**: prod's house
ladder is the never-approved low **1/2** (20 buy-in — matches the shot's
"Stack 21 · Pot 3 · +1 net" exactly), mid 5/10, high **25/50**, and prod predates the
lobby rework, the seated-copy fix, and the scene work. Verified 2026-08-16: prod API
lists exactly those house tables; staging lists only the restored 10/20 / 50/100 /
250/500 ladder and has **no 25/50 table at all**.

Staging re-verified the same night (scripted browser, fresh profiles): lobby loaded
**5/5** times (guest + authed, all 5 house cards, correct ladder), auto-seat at the
low table worked, the seeded bots ACTED through all four streets hand after hand,
and the full scene rendered (dealer full-body, two bot avatars, badges, cards,
correct blinds). Screenshot: `scripts/` diag set + scratchpad `diag-room-after-watch.png`.

Real defects found and addressed on staging same night:
- **Seated figures despawned between hands** (`figureVisible` derived only from
  `live.seats`) — the exact "scene wasn't even loaded" look, worse on prod's July
  build. FIXED: figures + HUD badges now fall back to the persistent seat roster.
- **Expected 403 surfaced as an error**: `last-settled` 403s by design until your
  first settled hand; the room painted "… Retrying…". FIXED: 403 no longer notices.

## ✅ PROMOTION BLOCKER RESOLVED (2026-08-16) — house-table re-tier BUILT + a busted-seat sweep

The scaler pass now (1) releases abandoned BUSTED seats (0 chips, idle >10 min, no
live hand — 0-credit release via the existing idempotent cash-out; house AND player
tables; this also frees the founder's two stuck 0-chip prod seats from 08-13/14 that
kept bouncing him into dead rooms), and (2) retires open house tables whose stakes
no longer match their tier config — bots cash back to the house bank, tables close
only when a locked read proves zero escrow, and the deficit loop recreates the tier
at the approved ladder in the same pass. Humans with a NON-zero stack always block a
retire. Prod's house bank (97,909 vCLAW) covers the new-ladder seeded buy-ins
(22,200). On the promotion deploy, prod self-heals to 10/20 / 50/100 / 250/500
within one scaler pass — the two founder-seat tables clear on the first pass after
his 0-chip seats release. The FULL idle-table sweeper for tables/seats holding REAL
chips stays flagged P1 (it moves player money — separate reviewed round).

## THE VISUAL CHECKLIST — walk this on staging, in order

### 1. Hold'em ring — `/cove/table` (the headline)
- [ ] **Lobby rework (2026-08-10)**: Live Tables uses designed dark table cards; walk
      Browse, Create Table (house tier + private custom stakes/seeded agents), and Have
      a code?, confirm guests see the sign-in gate, copy the one-time private code, and
      confirm any table above six seats opens the classic 2D felt.
- [x] **House stakes — RESOLVED by founder ruling 2026-08-11 ("use the old ones"):**
      the original ladder is restored in config (low 10/20 blinds / 200 vCLAW buy-in,
      mid 50/100 / 1,000, high 250/500 / 5,000). New house tables and the Create tab
      now match the live table rows; the never-approved 10x-lower reland ladder is gone.
- [ ] **Default view on entry**: all 5 opponents seated on the proper table chairs
      (not the slot-machine stools), nobody hidden behind a chair back, dealer readable
      at the far side, name badges clear of the dealer.
- [ ] **Seating**: characters sit ON the cushions (no floating, no clipping through
      seats), facing the table.
- [ ] **Live table binding**: the room fronts the real multiplayer cash tables. Board,
      pot, seats, whose-turn and the countdown all come from the server. There is NO
      Deal button anywhere; hands start themselves.
- [ ] **Sit down and play a hand with real vCLAW** (staging balance): blinds post, raise
      slider is "raise TO" amounts, fold/check/call/raise all land, pot pays correctly.
- [ ] **Turn clock**: live seated play counts down 20 seconds from the server (agents
      quietly get +5s grace). Logged-out practice mode counts 10 seconds.
- [ ] **Leaving**: "Walk Away" while in a hand shows "Cashing out after this hand" and
      pays out at the hand boundary. "Close" appears only in logged-out practice.
- [ ] **Fold-win**: win a pot by everyone folding — the banner should NOT say showdown.
- [ ] **Logged-out practice**: fresh incognito visit auto-deals ~every 3s, no Deal
      button, no real money.

### 2. Blackjack 3D room
- [ ] Dealer hole card stays hidden until the dealer reveal beat — the felt must never
      leak the outcome early (this was the MAJOR-A program; the reveal now runs in
      committed steps).
- [ ] Naturals (blackjack off the deal) still paint a real hole-card beat.
- [ ] Balance changes only when the hand fully settles, not mid-reveal.
- [ ] "Walk Away" is locked during the settlement animation beats.
- [ ] Insurance: offered only on an ace up, expires at your first action.

### 3. Baccarat
- [ ] Coup plays out with staged truth (no early outcome flash), banner copy correct.
- [ ] Landscape phone: the table truth stays visible (G2.13 fix).

### 4. 2D fallback modals (same games, flat UI)
- [ ] Blackjack + baccarat 2D modals show the same staged reveal behavior as 3D
      (they share the reveal engine). Spot-check one hand each.

### 5. Mobile + iPad sweep (repo-mandated)
- [ ] Phone 390x844, iPad mini 744x1133, iPad Air 820x1180, iPad Pro 1024x1366 —
      portrait AND landscape: joysticks visible, action bar reachable, modals fit.
- [ ] **Real-iPad safe-area**: needs YOUR device screenshot — emulation cannot prove
      the bottom safe-area lift. (Only open P1 item from the July rounds.)

### 6. Known non-blockers (approved to ship as-is)
- Dealer is a static figure — the animated deal gesture is a planned follow-up round
  (Blender-authored, needs the 3D/Codex collaboration).
- Opponent avatars are a deterministic look derived from each player's id — real
  appearance sync needs a small backend surface later.
- The old 2D hold'em practice modal still exists with its own Deal button (separate
  surface); its fate is a later decision.

## After your sign-off — the prod push (mechanical, no eyes)

1. PR `staging -> master`; CI migration gate applies 0057/0058 to prod (idempotent).
2. Browser-verify `clawville.world/game` + the cove per the standard deploy rule.
3. **Expect prod cash hands = 0 at first**: house tables only deal while at least one
   real player is seated (Option B, by design). The rings go "live" the moment the
   first real player sits.
4. Prior pending prod migrations from the land pushes (0049-0056) ride the same
   promotion; their preflight notes in deploy-status.md still apply.

## Standing rules honored in this build

vCLAW everywhere in user-visible text (never the c-word for the venue — it is "the
cove" / "card tables"); server field names keep `*Ct`; `$Clawville` never conflated;
no drei Text/Billboard, no InstancedMesh+ShaderMaterial, no per-frame allocations.
