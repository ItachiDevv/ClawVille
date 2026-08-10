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

## THE VISUAL CHECKLIST — walk this on staging, in order

### 1. Hold'em ring — `/cove/table` (the headline)
- [ ] **Lobby rework (2026-08-10)**: Live Tables uses designed dark table cards; walk
      Browse, Create Table (house tier + private custom stakes/seeded agents), and Have
      a code?, confirm guests see the sign-in gate, copy the one-time private code, and
      confirm any table above six seats opens the classic 2D felt.
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
