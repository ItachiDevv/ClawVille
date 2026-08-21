# FOR FOUNDER REVIEW

> The single shared queue of everything waiting on the founder's eyes in a DEPLOYED
> environment. Created 2026-08-20 on founder order, because "just push it and I'll
> test it later" is now the standing answer — this file is the "later".

## How this file works (rules for every session)

- **Every session that ships something needing founder feedback MUST append an entry
  here in the same push** (same discipline as `deploy-status.md`). Shipping without
  an entry = the feedback silently never happens.
- **Standing founder answer (2026-08-20): do NOT block a ship on a founder playtest.**
  Push it, list it here, keep moving. Only a founder DECISION that changes what gets
  built still blocks.
- One entry per reviewable thing. Categorize under the game-area heading. Keep each
  entry to: WHAT to look at, WHERE (env + exact path to reach it), WHAT FEEDBACK is
  needed, which session shipped it, date.
- **Founder verdicts:** mark ✅ + a note directly on the entry (or tell any session).
  The next session working that area absorbs the verdict into its docs and DELETES
  the entry. This file holds only OPEN items — it must stay short enough to walk
  through in one sitting.
- Decisions the founder owes (rulings, not playtests) live in the DECISIONS section
  at the bottom — same lifecycle.

---

## LAND

### Door-2 wallet proof feel-pass (LIVE on prod)
- **What:** the "send a small amount, we send it back" wallet-ownership check.
- **Where:** prod → `/game` → Land Office → declare a wallet → VERIFY MY WALLET →
  "START A TRANSFER CHECK". Costs ~$0.001 in network fees; the SOL comes back
  automatically. Door 1 (connect wallet + sign) is right beside it.
- **Feedback wanted:** does the flow feel clear and trustworthy? Plus judgment on 3
  cosmetic items: (1) countdown/check content sits below the modal fold on desktop;
  (2) refund wording differs between the active and verified states; (3) CHANGE
  WALLET greys out with no explanation when re-declaring the same address.
- Shipped by: land sessions (landUp2/land22/lnd), 2026-08-19.

### Autonomous material gathering (LIVE on prod — try the founder scenario)
- **What:** tell your agent "go collect as many materials as possible", switch to
  Autonomous, walk away 30 minutes, come back to a materials balance.
- **Where:** prod → `/game` → chatter-bar directive → Autonomous mode. The agent
  gets 48 seabed salvage nodes offered in its decision context; each claim yields
  materials (6-hour per-node cooldown, daily cap 120).
- **Feedback wanted:** does it actually behave the way you pictured? Directive
  phrasing that fails is a bug report we want.
- Shipped by: land gamification + salvage sessions, 2026-08-09.

### Autonomous yard-building (staging)
- **What:** tell your agent to decorate its HOME yard and watch it gather materials first when its balance is short, then place an exact server-suggested piece.
- **Where:** staging → `/game` → give the directive → Autonomous mode → watch the Activity Log and yard. The account needs a parcel WITH a home already built (placing the building itself is not an agent action yet) — `landtest3@staging.clawville.test / LandTest!2026` is pre-staged: home shack on parcel-starter-23, one placed path-stone, 42 materials banked.
- **Feedback wanted:** does the gather-then-build loop follow the instruction naturally, and is the placed piece a sensible visible choice?
- Shipped by: land session (lnd), 2026-08-20; adversarial review APPROVED 0-blocking, punch list applied same day.

## BOUNTIES / ECONOMY

### OOBE/SAP fully removed — bounty board on the single low-tier rail (staging)
- **What:** the on-chain escrow partner is gone end to end. USDC bounties now run
  ONLY the low-tier rail (custodial hold up to $50, PayAI payout); vCLAW bounties
  unchanged. All our on-chain funds were recovered first (house wallet now holds
  0.2218 SOL, up 0.157).
- **Where:** staging.clawville.world — post a small USDC bounty, claim it with a
  second account, approve, watch the payout; also glance at the landing page
  roadmap (OOBE naming stripped — approve the reworded two entries).
- **Feedback wanted:** bounty flow feels unchanged; roadmap wording OK.
- Session tier2/Fable, 2026-08-20.

### Roadmap + brand copy after the OOBE removal (staging) — wording check
- **What:** OOBE naming is gone from the site, and two roadmap entries that
  advertised capabilities we NO LONGER HAVE were reworded, not just de-named:
  "Agents go on-chain" no longer claims escrowed work (it now says what stayed
  true — real wallets, real USDC settling on mainnet, Covenant recording), and
  "Every agent, on-chain" dropped its "proven rails" phrasing.
- **Also:** three ALREADY PUBLISHED announcement banners (protocol-upgrades,
  agent-economy-live, agents-pay-agents) advertise on-chain escrow. I marked them
  DO NOT REPUBLISH in place rather than rewriting them, since they record what was
  actually announced at the time.
- **Where:** staging.clawville.world landing page → scroll to the roadmap.
- **Feedback wanted:** approve the two reworded entries, and confirm you are OK
  keeping the old banners as historical records (alternative: delete them).
- Session tier2/Fable, 2026-08-20.

---

## COVE

### Nori button reachable on phones (LIVE on prod via #271)
- **What:** on phones the top-centre Connect/status banner used to cover almost half of the
  pink Nori button (top-right) — taps on its left side did nothing. Nori is now a compact
  heart-icon circle on phones (full label stays on desktop/tablet).
- **Where:** staging → /game on a PHONE → tap the pink heart top-right; also check it still
  pulses when you walk up to Nori in the world.
- **Feedback wanted:** does the icon-only button read as "talk to Nori" without its label;
  is the tap comfortable.
- Shipped by: pokPlus, 2026-08-20.

### Phone poker: action buttons no longer drag your avatar (LIVE on prod via #270)
- **What:** on a phone, seated at the hold'em table, the movement joystick used to sit
  invisibly ON TOP of the Fold/Check/Call/Raise panel — taps on the upper buttons moved
  your character instead of playing the hand. The movement stick now disappears while
  you are seated at a table or inside any cove game, and the action panel always wins
  the tap. The camera stick stays.
- **Where:** prod → on a PHONE (or narrow window) → cove → sit at the hold'em
  table → play a hand. Also confirm walking still works fine before sitting and after
  standing up.
- **Feedback wanted:** do the buttons all respond on the first tap; does movement come
  back cleanly when you leave the table; any spot where you miss having the left stick
  while a game is open.
- Shipped by: pokPlus, 2026-08-20.

### Baccarat Walk Away from mid-shoe idle (LIVE on prod via #270)
- **What:** you can now cash out of baccarat between coups, not only right after a
  settle — the red Walk Away button shows whenever a shoe is open.
- **Where:** prod → cove → baccarat: deal one coup, press Next Coup (back to
  idle), then Walk Away. Seed reveals, table auto-closes ~1.4s later; Deal greys
  out during that window.
- **Feedback wanted:** does the exit feel right; any state where you feel trapped.
- Shipped by: pokPlus, 2026-08-20.

### Poker verify page tells the truth now (LIVE on prod via #270)
- **What:** poker rows in `/cove/history` get a real label, filter chip, and a
  verify page that says exactly what the server proved (seed commitment + outcome
  consistency) instead of "undefined Verifier" and a replay claim that never ran.
- **Where:** prod → play a hold'em cash hand → `/cove/history` → Verify on the
  poker row.
- **Feedback wanted:** copy check — does the fairness wording read clear and honest
  to a player (your muck ruling is baked into the copy).
- Shipped by: pokPlus, 2026-08-20.

### Idle empty tables self-close after 30 min (staging)
- **What:** an abandoned player-created cash table (nobody seated, no chips) now
  closes on its own after 30 minutes and frees your 3-table limit.
- **Where:** staging → create a cash table, leave it, come back 30+ min later —
  gone from the lobby, cap slot free.
- **Feedback wanted:** none required — listed so you know the behavior changed.
- Shipped by: pokPlus, 2026-08-20.

## WORLD / 3D

### Kelp camera fix (staging `fd99d61d`)
- **What:** cross-scene default-camera writers root-caused + fixed; kelp scene
  framing should be stable now.
- **Where:** staging → `/game`, enter the kelp area.
- **Feedback wanted:** founder eyes that the framing looks right (was: camera
  jumping between scenes).
- Shipped by: kelp session, 2026-08-08. Founder eyes owed since then.

## PERF

### Buildings-gated reveal — the new first boot (LIVE ON PROD via #271)
- **What:** your ruling absorbed — the gray placeholder buildings are DELETED
  (they had quietly reached prod as a #269 rider; #271 removes them). The
  loading screen now holds (with a moving "Building the town…" bar) until all
  11 real buildings are fully loaded, then the world reveals complete.
  Nothing fake ever shows. Measured live: ~6.5s cold reveal on prod
  (edge-warm; first-ever-visitor cold edge ~9.7s), busy-machine caveat.
- **Where:** **prod** → hard-refresh `clawville.world/game` (cold first load;
  try logged in and logged out). Watch the bar move through "Building the
  town…" and confirm the town appears finished — no gray boxes, no
  half-built spots, before OR after the reveal.
- **Feedback wanted:** does the hold feel right vs the old instant-but-
  incomplete reveal? Is the loading bar honest (never frozen)?
- Shipped by: cv-covefreeze perf session (prf), 2026-08-20; promoted #271
  same day on founder order ("this needs to be locked in").

### Slice-C wanderer pop-in (staging — owed since 08-11)
- **What:** wandering NPCs stream in a few seconds AFTER the world reveals.
- **Where:** staging → `/game`, watch the town for ~10s after reveal.
- **Feedback wanted:** is the pop-in acceptable?
- Shipped by: cv-covefreeze perf session, 2026-08-11.

### Mobile perf wave 1 phone feel-pass (staging)
- **What:** the phone render profile targets a steadier default 30 FPS, removes
  world shadows, and shortens draw distance while keeping the complete world,
  HUD, labels, and real buildings intact.
- **Where:** staging → `/game` on a PHONE. Try the default URL first, then compare
  `/game?fpscap=0` with the cap disabled; the default should load, feel steadier,
  show softer/no shadows, and fade distant scenery sooner.
- **Feedback wanted:** how the 30 FPS cap feels versus uncapped, whether the shorter
  draw distance feels too aggressive, and anything visually broken from any camera
  angle (especially a moving dark band/void at the horizon).
- Shipped by: cv-covefreeze mobile perf wave 1 session, 2026-08-20.

---

## DECISIONS OWED (rulings, not playtests)

- **ECONOMY — recovered 0.2218 SOL destination.** The OOBE wind-down returned the
  stake + rents to the prod house custodial wallet (`ESpn…sm3m`). Leave it there,
  or name a wallet to sweep it to.
- **LAND — Founders' Row: auction vs hold-only.** Surfaces + server currently say
  hold-only (10M CLV). If auction is intended, that is a server change to scope.
- **LAND — Prepay one-click confirm.** Approve/reject the one-click rent-prepay
  confirm UX.

---

*(Verdict log: none yet — delete entries as they are absorbed.)*
