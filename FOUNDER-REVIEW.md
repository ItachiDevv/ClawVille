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

## COVE

### Baccarat Walk Away from mid-shoe idle (staging)
- **What:** you can now cash out of baccarat between coups, not only right after a
  settle — the red Walk Away button shows whenever a shoe is open.
- **Where:** staging → cove → baccarat: deal one coup, press Next Coup (back to
  idle), then Walk Away. Seed reveals, table auto-closes ~1.4s later; Deal greys
  out during that window.
- **Feedback wanted:** does the exit feel right; any state where you feel trapped.
- Shipped by: pokPlus, 2026-08-20.

### Poker verify page tells the truth now (staging)
- **What:** poker rows in `/cove/history` get a real label, filter chip, and a
  verify page that says exactly what the server proved (seed commitment + outcome
  consistency) instead of "undefined Verifier" and a replay claim that never ran.
- **Where:** staging → play a hold'em cash hand → `/cove/history` → Verify on the
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

### Buildings-gated reveal — the new first boot (staging)
- **What:** your ruling absorbed — the gray placeholder buildings are DELETED.
  The loading screen now holds (with a moving "Building the town…" bar) until
  all 11 real buildings are fully loaded, then the world reveals complete.
  Nothing fake ever shows. Local check: ~5.6-6.6s reveal on a busy machine;
  old prod boot is ~9-10s.
- **Where:** staging → hard-refresh `/game` (cold first load; try logged in
  and logged out). Watch the loading bar move through "Building the town…"
  and confirm the town appears finished — no gray boxes, no half-built spots.
- **Feedback wanted:** does the longer hold feel right vs the old instant-but-
  incomplete reveal? Is the loading bar honest (never frozen)?
- Shipped by: cv-covefreeze perf session (prf), 2026-08-20.

### Slice-C wanderer pop-in (staging — owed since 08-11)
- **What:** wandering NPCs stream in a few seconds AFTER the world reveals.
- **Where:** staging → `/game`, watch the town for ~10s after reveal.
- **Feedback wanted:** is the pop-in acceptable?
- Shipped by: cv-covefreeze perf session, 2026-08-11.

---

## DECISIONS OWED (rulings, not playtests)

- **LAND — Founders' Row: auction vs hold-only.** Surfaces + server currently say
  hold-only (10M CLV). If auction is intended, that is a server change to scope.
- **LAND — Prepay one-click confirm.** Approve/reject the one-click rent-prepay
  confirm UX.

---

*(Verdict log: none yet — delete entries as they are absorbed.)*
