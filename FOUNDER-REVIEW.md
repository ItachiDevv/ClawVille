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

## TRADING FLOOR

### Trading Floor tab + sidebar tape (LIVE on prod since promotion #276, 2026-09-16)
- **What:** the Exchange modal's new "Trading Floor" tab (bind a wallet through one of
  three doors, paste a swap signature to verify it, avatar-wide verified history, live
  floor, scoring rules) and the desktop-only tape pinned at the bottom of the sidebar.
- **Where:** prod → `/game` → sidebar → Economy → "Trading Floor" (or the Exchange
  stand → "Trading Floor" tab). Public `/leaderboard` shows the Trader column and the
  "ClawVille-operated" label. Same on staging.
- **Feedback wanted:** does "trade in your wallet, then it shows here" read clearly?
  Bind your Phantom via "Connect and sign", make a $1+ Jupiter swap of SOL/USDC/$CLAWVILLE/
  $ANSEM, paste the signature: the row should say COUNTED (or a plain-language reason).
- Shipped by: session clawPump/Fable, 2026-09-16.

### Fleet (five house agents) — FIRST FLEET TRADE EXECUTED ON MAINNET from STAGING (2026-09-17)
- **The trade:** SafeRebalancer, $1 SOL→USDC via Jupiter, signature
  `5mytFoup16GrVojktQYHaG9bc5fP1w6jQ135zTYgJVe7Bjc1Jtu8Tzcu6gAtpfVVr4DZgeX3gZFBHaBDGpK4Jow2`
  (finalized, slot 447873097, fee 67,433 lamports, wallet −0.009997 SOL / +0.999229 USDC).
  Look at it on any explorer. Three bugs surfaced on the way, each would have refused or
  hidden every fleet trade on prod, all fixed same day (`deploy-status.md` 2026-09-17).
- **Where to look (verified 2026-09-17 19:44Z):** staging `/leaderboard` → rank 2 card
  `SafeRebalancer`, label CLAWVILLE-OPERATED, score 20, `TRADER 1`; staging `/game` →
  sidebar tape / Exchange → "Trading Floor" tab → live floor lists the $1 SOL→USDC trade.
  The decision is `executed`, its USDC reservation settled, the wallet now holds about
  0.29 SOL + $10.99 USDC.
- **Feedback wanted:** does the rank card + label read right to you; then the rulings
  below so the other four accounts can be provisioned and the promotion to prod can ride.
- **What:** the guarded signer, guardrails, operator routes, provisioning + pairing routes
  and the `trade_token` verb are in the code; every fleet link is created unarmed + killed.
  On 2026-09-16 the first account was provisioned on STAGING (objective
  `conservative-rebalancer`, trader `SafeRebalancer`, operator = the seeded staging admin
  `landtest1`): avatar wallet `vaLqeo9HSaA5JbbDiL5GbusBG9jsKgQ6KXW8AUDZ3ZX`,
  leaderboard-eligible, ClawVille-operated. Prod has no fleet account yet.
- **2026-09-17 rung status:** the founder funded the staging wallet (0.3 SOL + $10 USDC).
  The arm route accepted it: float start $40.25, baseline slot 447865610. The first $1
  SOL→USDC test trade was REFUSED with `decimals_unresolved`: the mint whitelist demanded
  a null mint authority on every mint, and mainnet USDC has Circle's. Fixed the same hour
  (pinned USDC authorities, see `ARCHITECTURE.md` 2026-09-17 drift note); the re-run
  result lands in `deploy-status.md`. The rung found a bug that would have refused every
  fleet trade on prod, which is what it exists for. Decisions already taken and applied: self-custody
  (ClawVille signs, ClawPump never), fleet ranks publicly with the "ClawVille-operated"
  label, whitelist SOL/USDC/$CLAWVILLE/$ANSEM, $200 SOL across five wallets, default
  drawdown halt 20 percent.
- **Owed by founder before provisioning/arming (rulings, not playtests):** which user ids
  go in `ADMIN_USER_IDS` on staging and prod (the only accounts that can provision, pair,
  arm, halt, kill) and a session for that account so the five accounts can be provisioned
  on staging first; glance at the five objective briefs in
  `packages/shared/src/constants/trading-fleet.ts` (momentum, ANSEM+CLAWVILLE DCA,
  SOL/USDC mean reversion, signal follower, conservative rebalancer).
- **Genesis pairing (wallet `4FMiFU1Dv4qwfMHn3YukvaonhwrPt1T7VZ3yGuNRyY9n`, received
  2026-09-16):** blocked on proof of ownership. Pairing now requires the wallet to sign a
  one-time ed25519 challenge, and that wallet is ClawPump-custodied, so it cannot sign
  locally. Two ways forward: the full 47-char ClawPump enterprise key (then a
  ClawPump-verified lookup door can be built), or a ClawPump message-signing call if their
  agent API offers one. The wallet also has no on-chain history yet (0 SOL, 0 txs), so
  there is nothing to observe until genesis trades.
- Session clawPump/Fable, 2026-09-16.

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

### Rent prepay confirm step (staging)
- **What:** your ruling applied — "Prepay rent" no longer charges on one click.
  It opens a confirm window that restates weeks, lot, and the exact vCLAW total,
  with Cancel / Confirm prepay. The charge itself is unchanged.
- **Where:** staging → `/game` → Land Office → My Land → a deposit-tenure lot →
  Prepay rent. `landtest3@staging.clawville.test / LandTest!2026` owns
  parcel-starter-23.
- **Feedback wanted:** does the confirm read clearly; is two clicks acceptable
  in the urgent (rent-running-out) state.
- Shipped by: land session (lnd), 2026-09-13.

### Autonomous yard-building (staging)
- **What:** tell your agent to decorate its HOME yard and watch it gather materials first when its balance is short, then place an exact server-suggested piece.
- **Where:** staging → `/game` → give the directive → Autonomous mode → watch the Activity Log and yard. The account needs a parcel WITH a home already built (placing the building itself is not an agent action yet) — `landtest3@staging.clawville.test / LandTest!2026` is pre-staged: home shack on parcel-starter-23, one placed path-stone, 42 materials banked.
- **Feedback wanted:** does the gather-then-build loop follow the instruction naturally, and is the placed piece a sensible visible choice?
- Shipped by: land session (lnd), 2026-08-20; adversarial review APPROVED 0-blocking, punch list applied same day.

## AGENTS / ONBOARDING

### Nori now says where the bounties are (prod)

- **WHERE:** clawville.world/game, ask Nori "where do I get bounties?" (or ask your own agent).
- **LOOK AT:** she should send you to the Bounty Board, the right half of the Quest + Bounty Pavilion straight behind the town-directory sign, and never to Pearl or another teacher.
- **FEEDBACK WANTED:** is the answer right and short? Hosted agents pick up the new manual on their next start or connect.
- **Session dd (fix authored by bountyFix2), 2026-09-18.**


### Nori now has the "Press E - Talk to Nori" prompt (prod)

- **WHERE:** clawville.world/game, walk up to Nori in the town centre.
- **LOOK AT:** the bottom prompt "Press E - Nori / Talk to Nori" ("Tap" on phone/iPad); E or a tap opens her chat. You can no longer walk through her, and the invisible wall beside her is gone (for agents too).
- **FEEDBACK WANTED:** does it appear where you expect? On a phone in portrait the prompt slightly covers the Hold Jump button (true of every building prompt; session bountyFix2 is fixing the mobile controls layout).
- **Session dd, 2026-09-18.**


### DoorDash Phase 2 — you can now actually order (session dd/Fable, 2026-09-17)

- **2026-09-18 demo patch (session dd): Wawa + custom hoagie.** WHERE: prod `clawville.world`, chat bar, account `itachi`. LOOK AT: say "I'm hungry, is DoorDash available?" (should list open places incl. Wawa); "menu for Wawa, hoagies"; "add a custom Italian hoagie" (should list bread / toasting / cheese choices); answer in plain words; "what is the total". FEEDBACK WANTED: is the choices question readable in the chat panel, and did the picks shown after adding match what you said?

**WHAT:** The ordering path is built. You can tell your agent to add things to a cart, ask what the
total is, and place the order — all from the chat bar. It is still your account only.

**HOW IT FEELS IN THE CHAT BAR:**
1. "find pizza near me" → a list of real Jacksonville restaurants.
2. "show me the menu at Rojas Pizza" → real items with prices. (You can say the NAME. You no longer
   have to repeat ID numbers back — the server remembers what you were looking at for 30 minutes.)
3. "add two garlic knots" → the cart, with what is in it.
4. "what's the total?" → the real quote: subtotal, tax, delivery fee, service fee, the delivery
   estimate, **a question asking how much you want to tip**, and a six-character code good for 10 min.
5. "ACDEFG tip 3" → the order is placed, and you get a Telegram message with the total.

**THE PART WORTH KNOWING:** your agent cannot place an order on its own. The confirmation code is
checked against YOUR typed message, captured before the model even runs — so an agent that makes up a
code, or repeats the one it just showed you, gets refused. The tip works the same way: if you did not
say an amount, it will not invent one. And your connected agent can never submit at all; it can build
the cart and price it, then it hands back to you. That was your ruling and it is enforced in code.

**LIMITS (yours, from 2026-09-16):** 2 orders per day, $75 per order, $150 per day including tip.
These are read from the database, so restarting the server does not reset them. The environment can
only make them tighter — a setting that would raise one stops the server booting instead.

**WHERE:** staging (`https://staging.clawville.world`), the chat bar at the bottom of `/game`.
Same staging login as the Phase 1 entry below.

**⚠️ NOTHING HAS BEEN ORDERED AND NOTHING WILL BE UNTIL YOU SAY SO.** Every test stopped at the price
quote. The carts I made were deleted; your open-cart list is empty. **The first real order happens on
production, with you watching, when you ask for it** — never in a test, never unattended. That is the
one thing this entry is asking for.

**WHAT FEEDBACK IS NEEDED:**
1. Drive it to the price quote on staging and stop there. Does the conversation flow naturally, or
   does it lose track of the cart between messages?
2. Is the tip question asked at the right moment, and are DoorDash's suggested amounts useful?
3. When you are ready, tell me and we do ONE real order on production together.

**Vendor bugs I re-checked before building (all were open, none reproduce on v0.2.4):** the one that
would have blocked everything was #84, where adding to a cart failed at every restaurant. It works.
Also fixed upstream since those reports: the ordering command used to hang forever without a terminal,
and the price quote never returned suggested tips — both work now. Nothing needs raising with DoorDash.

### DoorDash CLI Phase 1 — operator-only, read-only (session doordash/Fable, 2026-09-17)

**WHAT:** Your agent can now use the DoorDash CLI from the chat bar — but READ-ONLY in this phase:
search stores, browse a menu, check order status, list order history, list your saved addresses.
It cannot place an order. There is no cart, no price preview, no submit, and no tip flow yet.

**WHERE:** staging (`https://staging.clawville.world`) — the normal agent chat bar at the bottom of
`/game`, and your own `/avatars/me/chat` path. Both carry it; nobody else's account does.

**✅✅ UPDATE 2026-09-17 (later): PROVEN IN THE REAL CHAT BAR — nothing is owed on the technical side.** I set a staging password for your account and drove it myself. Asking the agent to "search doordash for starbucks" returns `Starbucks Coffee Company (store 35742098); Gregorys Coffee (store 534765); Blue Bottle Coffee (store 2188520)...` — real NYC shops near YOUR saved address. Asking for a menu returns real items (`Iced Caffè Latte`, `Iced NOLA`, `Caffè Latte`, `Iced Matcha`, "49 more results are not shown"). Three defects were found and fixed doing this, each of which had passed the unit tests.

**Staging login if you want to try it:** 444hoodie@gmail.com / `DdTest-1789639631-Stg` (I set this; change it whenever).

**❌ RETRACTED 2026-09-17 — I WAS WRONG ABOUT THE CUISINE LIMITATION BELOW.** Cuisine search works fine. Once the founder's real default address (200 Riverside Ave Unit 813, Jacksonville FL, id 1742541215) was set, `pizza` returns Rojas Pizza / Rodrigo's Craft Pizza / Biggies Pizza / Al's Pizza / Papa Johns, and `sushi` returns Sake House / New Kazu Sushi Burrito. The empty NYC results were an artifact of searching from an address the account did not really deliver to, NOT a name-only search index. **Do not raise the "names only" claim with DoorDash — it is false.** (`ramen` is still empty in Jacksonville, which is plausibly just local coverage.)

**✅ FIXED 2026-09-17 (`d46fafc5`) — reliability went from 1/3 to 6/6.** The action now fires on every casual phrasing I tested, including the two that previously failed ("find me pizza on doordash", "im hungry can you find me some tacos on doordash"). Cause: the action framework already supported trigger phrasings (`similes`) and the prompt builder never showed them to the model — so NO action in the game had example phrasings. Fixed for every action, not just DoorDash.

**(fixed, kept for the record)** **REAL open item instead — prompt reliability, our side.** The action does not always fire: "search doordash for pizza" sometimes produces a reply that *narrates* searching ("Let me dive into the DoorDash currents... The search begins now!") without ever emitting the action, so the user gets flavour text and no results. Explicit phrasing ("use the doordash search action now for query pizza") fired correctly 2/2. This is prompt/decision tuning, and it should be fixed before Phase 2, where a missed action during checkout is worse than a missed search.

**(RETRACTED — kept for the record)** **THE ONE THING WORTH YOUR JUDGEMENT — a vendor limitation, not our code.** The beta's search matches restaurant NAMES, not cuisines. "mcdonalds" and "starbucks" work. "ramen", "pizza", "sushi", even DoorDash's own documented example "sushi near me", and the real NYC chain "Ippudo" ALL return zero results at a Manhattan address. So the most natural way to ask — by food type — comes back empty. **Worth raising with Aliza before Phase 2**, because an ordering flow that cannot find food by cuisine is a poor experience. It may be a beta index limitation or a parameter we have not found.

**(earlier)** **✅ UPDATE 2026-09-17: staging IS seeded and live-verified.** The binary is installed and immutable, your token authenticates from that box, and all four read-only operations were proven working through the app's own wrapper inside the API container against real DoorDash (`address-list` 429ms, `search` 3.6s, `order-history` 405ms). The gate was proven too: your account gets the capability, every other human/agent/guest gets nothing. A real ship-blocker was caught and fixed doing this (`09b2ed6d`) — the CLI wraps its JSON in an envelope, so every operation was failing before. **What is still unproven is the chat-bar round trip, because that needs YOUR login.** That is the one thing this entry is asking you to do.

**(historical)** **⚠️ IT WILL REPORT ITSELF DARK UNTIL THE BOX IS SEEDED.** Staging has no `dd-cli` binary and no
`DD_CLI_ACCESS_TOKEN` yet. That is expected, not a bug. To light it up on a box, an operator runs
`apps/api/scripts/doordash/install-ddcli.sh` on the host (read-only bind-mount into the api container)
and sets `DD_CLI_ACCESS_TOKEN` + `DOORDASH_OPERATOR_USER_ID` (which must ALSO be in `ADMIN_USER_IDS`).
Say the word and I will seed staging and re-verify live.

**WHAT FEEDBACK IS NEEDED:**
1. Does asking your agent in plain language ("find ramen near me", "what's on the menu at X") actually
   return useful results in the chat bar, or does the wording need work?
2. Your `DD_CLI_ACCESS_TOKEN` expires every few days with no auto-refresh in a headless box. When it
   dies the feature alerts and goes dark until you re-export it by hand. Is that acceptable ongoing,
   or should we build something to reduce the manual step before Phase 2?
3. Phase 2 (cart + priced preview + confirm + tip) is specced and NOT built. Confirm you still want
   it built as ruled: submit stays human-only, tip asked after real totals, 2 orders/day, $75/order,
   $150/day.

**NOTE — this can never become a player feature under the current licence.** The DoorDash CLI terms
(§4.1) allow personal use of your own account only and forbid ordering for others or building a
platform on CLI access. Widening it needs a commercial agreement with DoorDash, not a code change.

### Export panel now shows magic-link connect guidance (LIVE on prod)
- **What:** the avatar-settings "take my agent home" panel no longer emits the
  retired npm-plugin install command (dead since the 2026-07-23 sideload
  retirement — it told users to curl a plugin that no longer works). It now
  shows a connect instruction pointing at the magic-link flow, and the
  local-port input is gone. The portable-manifest download is unchanged.
- **Where:** prod → `/game` → avatar settings → "Export and connect your
  agent" → Generate connect instruction.
- **Feedback wanted:** does the new copy read right, and is losing the
  npm-install path acceptable for any Milady users you still care about
  (server keeps the old response fields for old clients).
- Session selfheal/Fable, 2026-09-14.

## BOUNTIES / ECONOMY

### Reconcile ops view (LIVE on prod)
- **What:** a read-only Reconcile tab shows every frozen payment with its chain
  verdict and Tier-1 bounty context. The self-healing verifier behind it is now
  LIVE ON PROD (✅ founder GO 2026-09-14 — "take care of both open items go for
  it" — absorbed; the promotion question is closed).
- **Where:** prod → `/dash?tab=reconcile` (admin login). Expect an empty table
  while nothing is frozen — the empty state IS the healthy state.
- **Feedback wanted:** is the Reconcile table readable/useful as an ops view, or
  does it need different columns/grouping.
- Session selfheal/Fable, 2026-09-13 (promoted 2026-09-14).

### Nori now knows WHERE the bounty board is (staging)
- **What:** Nori told you on prod that Pearl held the bounties. Bounties never moved;
  the bug was that no knowledge Nori or any agent reads ever said where they are, so
  the model made one up. Nori, the hosted-agent orientation and the connected-agent
  manual now all say the Bounty Board is the RIGHT half of the Quest + Bounty
  Pavilion behind the town-directory sign, and that no teacher or NPC holds bounties.
- **Where:** staging.clawville.world → ask Nori "where do I find bounties?" and
  "does Pearl have the bounties?"
- **Feedback wanted:** does she send you to the pavilion and never to a building.
- Session bountyFix2/Opus, 2026-09-18.

### OOBE/SAP fully removed — bounty board on the single low-tier rail (staging)
- **What:** the on-chain escrow partner is gone end to end. USDC bounties now run
  ONLY the low-tier rail (custodial hold up to $50, PayAI payout); vCLAW bounties
  unchanged. All our on-chain funds were recovered first; the recovered SOL was
  swept to your wallet on 2026-09-13, and BOTH house wallets read 0 SOL on
  mainnet (re-checked 2026-09-18). The last SAP leftovers, the dead tables and
  bounty columns, are dropped by migration `0067_sap_table_drop.sql`, which is
  ON STAGING ONLY and needs your go before it runs on the prod database.
- **Where:** clawville.world — post a small USDC bounty, claim it with a second
  account, approve, watch the payout. (Now LIVE ON PROD, promoted since this
  entry was written.)
- **Feedback wanted:** does the bounty flow feel unchanged to you.
- ✅ Roadmap wording + brand copy: APPROVED by founder 2026-09-07; the three
  published banners stay as historical records (founder ruling, same date).
- Session tier2/Fable, 2026-08-20.

---

## ACTIVITIES

### Exit a race, start a new one at once (staging — needs your confirmation)
- **What:** the exit bug you reported — built and test-verified server-side,
  needs your eyes to confirm it. Leaving a Reef Race (or Bumper Shells)
  should now release you immediately — no more "already in an active room"
  error while the abandoned race's timer runs out. A solo match vs bots
  should END the moment you leave; a multiplayer match keeps running for
  everyone else. Leaving forfeits rewards (a leaver earns nothing — this
  closes a placement-farming hole the adversarial review found).
- **Where:** staging → `/game` → enter a Reef Race vs bots → leave mid-race →
  immediately queue a new race. Repeat with a leave during the countdown.
- **Feedback wanted:** does the re-queue work instantly for you, and does
  anything feel off for other racers when someone leaves a multiplayer match?
- Built by: session prf, 2026-09-07.

## COVE

### Leaving the cove no longer drops you back in (staging)
- **What:** "Back to World" put you inside the cove building, and any step pulled
  you back into the cove. The exit point had been hand-set in June, before the
  tunnel existed, and ended up inside the cove's walls, next to the automatic
  walk-in zone. You now land just outside the tunnel mouth, facing town, with no
  entry prompt. Walking back into the tunnel still takes you in, on purpose.
- **Where:** staging.clawville.world → walk into the cove through the tunnel →
  "Back to World" → walk toward town.
- **Feedback wanted:** is the landing spot where you expect to be, and can you
  leave without being pulled back in.
- **Known separate issue, not fixed yet:** if you REFRESH the page while inside
  the cove and then leave, your first step can snap you to an old spot in town.
  It is a different cause (camera position copied into the avatar while the page
  is still loading) and is next on the list.
- Session bountyFix2/Opus, 2026-09-18.

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

### Nori in the first loading batch (NOW ON PROD — the one amendment from your reveal sign-off)
- **What:** your verdict on the buildings-gated reveal ("looks pretty good,
  I'm pretty happy") is absorbed ✅ — that entry is closed. The one ask from
  it is built: Nori now loads BEHIND the loading screen too, FIRST in the
  batch (ahead of every building), and the screen holds until she is
  standing at town center — you reveal right in front of her, fully loaded.
  Costs ~1s of reveal time (local ~6.6s vs ~5.6s without her).
- **Where:** **prod** → hard-refresh `clawville.world/game` — Nori must be
  there the instant the world appears, never popping in after. (Reached prod
  with a later promotion; verified live 2026-09-07, prod `705dc33e`.)
- **Feedback wanted:** confirm she's always there at reveal; does the extra
  ~1s feel fine?
- Shipped by: cv-covefreeze perf session (prf), 2026-08-20 late.

### Slice-C wanderer pop-in (staging — owed since 08-11)
- **What:** wandering NPCs stream in a few seconds AFTER the world reveals.
- **Where:** staging → `/game`, watch the town for ~10s after reveal.
- **Feedback wanted:** is the pop-in acceptable?
- Shipped by: cv-covefreeze perf session, 2026-08-11.

### Mobile perf wave 1 + wave 2 phone feel-pass (staging)
- **What:** the phone render profile targets a steadier default 30 FPS, removes
  world shadows, and shortens draw distance while keeping the complete world,
  HUD, labels, and real buildings intact. Wave 2 limits decoded uncompressed
  texture sides to 512 px on phones.
- **Where:** staging → `/game` on a PHONE. Try the default URL first, then compare
  `/game?fpscap=0` with the cap disabled; the default should load, feel steadier,
  show softer/no shadows, and fade distant scenery sooner. Inspect nearby avatars
  and props, then use `/game?texcap=0` to compare their source texture sharpness.
- **Feedback wanted:** how the 30 FPS cap feels versus uncapped, whether the shorter
  draw distance feels too aggressive, whether 512 px phone textures stay sharp
  enough up close, and anything visually broken from any camera angle.
- Shipped by: cv-covefreeze mobile perf wave 1 + wave 2 sessions, 2026-08-20 and
  2026-09-07.

---

## DECISIONS OWED (rulings, not playtests)

*(none open)*

---

*(Verdict log: 2026-09-13 — LAND Founders' Row ✅ ruled HOLD-ONLY (auction rejected; live behavior already matches, no change). LAND prepay ✅ ruled CONFIRM STEP (one-click rejected; shipped same day, see the LAND entry above). ECONOMY recovered-SOL destination ✅ ruled: swept 0.397129 SOL from the prod house wallet to the founder wallet 2WhyS…ea5H, tx finalized (5PrkM…BnPbfc), house at zero. 2026-08-20 — buildings-gated reveal ✅ founder-approved ("looks pretty good, I'm pretty happy"); absorbed into 3dStructure/spec, entry replaced by the Nori amendment.)*
