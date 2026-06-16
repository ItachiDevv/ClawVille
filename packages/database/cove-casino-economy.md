# Cove Casino — Economic Model & House-Edge Design

**Status:** design LOCKED 2026-05-29 (chat). Implementation **DONE 2026-05-29** (the three fixes + a CT-economy monitor landed; engine tests green, `tsc` clean on api + database). Still PENDING the §3 verification gate (re-run the edge sims to confirm the fixed numbers + UI/mobile audit) before any cove game is promoted to prod. This doc is the durable record of *why* each game is built the way it is, economically.
**Owner decision:** Itachi (2026-05-29). **Author:** orchestrator.

**Chosen params (implemented 2026-05-29):**
- **Baccarat:** banker WIN winnings = `floor(stake * 95 / 100)` (floor the PLAYER's winnings, house-favorable); commission = `stake - winnings` (the kept fraction, ≥ 1 at every stake). Player 1:1, Tie 8:1, P/B push on tie — UNCHANGED. `apps/api/src/services/baccarat-engine.ts` `settleBet`.
- **Hold'em:** pot rake = `min(floor(pot * 5 / 100), 5)` CT, removed before awarding, distributed across winning seats pro-rata (remainder to earliest seat), the human's raked payout credited to the stack. `computeHoldemRake` in `holdem-engine.ts`, applied at settle in `cove-holdem.ts` under the table FOR UPDATE lock.
- **Blackjack:** rake = `floor(max(0, totalPayout - totalBet) * 5 / 100)` (5% of NET WINNINGS, winners only; pushes/losses pay 0), credited payout reduced by the rake. `computeBlackjackRake` in `blackjack-engine.ts`, applied at settle in `cove-blackjack.ts` under the shoe lock.
- **CT-economy monitor:** admin-only `GET /api/cove/economy/summary?window={24h|7d|30d|all}` aggregates `cove_game_events` minted (Σpayout) vs burned (Σbet) → houseNet per gameType + a `faucets[]` alarm list. `apps/api/src/routes/cove-economy.ts` (FEATURE_GATE `cove_ct_economy_monitor`).
- All four are idempotent: the rake/commission is computed once at settle and stored in `outcomeJson` (+ the flat `payout`/`net` columns hold the post-rake credited figures); a settled-replay reads the stored figures and never re-rakes. **Back-compat (fixed 2026-05-29, fixer pass):** a hold'em hand SETTLED BY PRE-RAKE CODE stored no `humanRakedPayout`/`humanRakedNet`/`rake` in its `outcomeJson`. Both hold'em settled-replay return sites now route through `rakedFiguresFromOutcome(outcome)` in `cove-holdem.ts`, which falls back to the always-present GROSS `humanPayout`/`humanNet` (and `rake: '0'`) so a pre-rake row replays to the figures that player actually received — never `undefined`. The engine-side `SerializedHoldemHand` rake fields are now `optional` (matching the shared copy) so the undefined-read surfaces at compile time. Mirrors blackjack's `outcome.rake ?? '0'` posture. Regression-tested in `holdem-engine.test.ts` (pre-rake row → gross fallback; post-rake row → stored raked figures).

**Verifier back-compat (fixed 2026-05-29, fixer pass #2 — the BLOCKING regress finding):** the settle-replay fix above covered the CREDIT path, but the `/cove/history/:eventId/verify` deep-equal was UNCHANGED and re-serialized the replay with the new (now-fixed) serializers, then strict-`JSON.stringify`-compared against the STORED `outcomeJson`. Staging shares prod's Supabase DB, so PRE-FIX closed rows almost certainly exist and are reachable by `/verify` — and they would falsely report `verified:false` on a perfectly fair, correctly-settled historical hand: (1) **blackjack/hold'em** pre-rake rows stored no `rake`/`rakedPayout`/`rakedNet` (bj) or `rake`/`humanRakedPayout`/`humanRakedNet` (th), but the new serializers always emit them → extra keys on the expected side → mismatch on every net-win / every hand; (2) **baccarat** banker-win rows stored the OLD `payout`/`net`/`commission` VALUES (different from the new commission-floored formula at any non-multiple-of-20 stake). Fix: extracted pure DB-free helpers `blackjackOutcomesMatch` / `holdemOutcomesMatch` / `baccaratOutcomesMatch` (`apps/api/src/services/cove-verify-compat.ts`) and wired them into the three verify branches. The bj/th helpers strip the rake keys from BOTH sides when the stored row lacks them (compare only the gross fields the stored row carries); the baccarat helper compares every NON-monetary field strictly and accepts the stored `payout`/`net`/`commission` if they match EITHER the new formula OR the OLD formula recomputed from the coup's own `bet`/`stake`/`winner`. Post-fix rows still compare strictly (tampered rake / tampered gross / tampered card / tampered winner all still fail). Regression-tested in `cove-verify-compat.test.ts` (22 cases: pre-fix bj net-win / th fold+played / baccarat banker win at stakes 5/7/10/19/30/41 all → `verified:true`; tampered fields → `verified:false`; cursor/dealt metadata ignored). `engineVersion` was deliberately NOT bumped (a bump would itself break shoe-replay determinism for the bj/baccarat shared-shoe branches, which reconstruct from nonce 0).
**Related:** `cove-blackjack.md`, `cove-texas-holdem.md`, `cove-baccarat.md` (per-game build plans); `improvements.md §7` (CT economy / feature gates); brand priorities #3 (free leaderboard) + #4 (unified economy) in `CLAUDE.md`.

---

## 0. Core principle — two models, split per game

The cove has **two distinct economic models**, and each game is one or the other. Conflating them is what created the bugs below.

| Model | What it means | Who profits | ClawVille games |
|---|---|---|---|
| **House-banked** | Player vs the house. The edge is baked into the payouts/rules; volume + the house's deep bankroll make house profit a near-certainty. | The house (a CT treasury/sink). | Slots, Baccarat, *(vs-bot)* Hold'em, *(countered)* Blackjack |
| **Skill arena** | Players compete; best knowledge wins on identical/fair instructions. House does NOT bank the action — it takes a **rake** (a cut of the pot). | The rake (house) + the best player. | Blackjack (as a skill game), agent-vs-agent Hold'em (future) |

**The brand vision** (per Itachi 2026-05-29): *"not about teaching agents — about making them compete; whoever brings the best knowledge wins, given fair instructions."* → the cove trends toward **skill-arena** where skill exists, **house-banked** where it doesn't.

**Why this matters even for fun-money:** ClawTokens are the spine of the leaderboard (#3) + economy (#4) + the future real-money (SOL/USDC) tier. A game that lets a skilled agent **mint net CT** ("faucet") inflates the supply, distorts the board, and breaks the real-money tier. Every game must be a net **sink or neutral** to the house, never an uncontrolled faucet.

---

## 1. Per-game model + house edge

### Slots — house-banked ✅ (shipped, gated)
- ~94% RTP = **~6% house edge**, Monte-Carlo CI-gated (`rtp-gate.yml` + `scripts/casino/rtp-sim.ts`, 100k-spin band [92.5%, 95.5%]).
- Losses flow to the house sink. Reference implementation for the other games.

### Baccarat (Punto Banco) — house-banked. Edge is REAL but my commission code LEAKED it. 🐛→✅ FIXED 2026-05-29
- Pure chance, zero player decisions → can only be house-banked (no skill to compete on).
- **Correct edges:** Banker ~1.06% · Player ~1.24% · Tie ~14.4% (8:1).
- **BUG (as-built):** commission = `floor(stake × 5%)` rounds DOWN (player-favorable):
  - stake < 20 CT → `floor(<1) = 0` → **no commission → banker flips ~+1.2% for the *player*** (a faucet on small bets).
  - any non-multiple-of-20 → undercharged (stake 30 → floor(1.5)=1 = 3.3%, not 5%).
- **✅ FIX (DONE 2026-05-29):** banker winnings = `floor(stake × 95 / 100)` (round the *player's payout* down — house-favorable) instead of `stake − floor(commission)`; commission = `stake − winnings`. Restores the ~1.06% banker edge at **every** stake (commission ≥ 1 for any stake ≥ 1 — the faucet is closed). Verified by `baccarat-engine.test.ts` (stake 5/7/10/19/20/30/41/100/500 + a 1..500 property sweep). Re-sim to confirm aggregate edge (the edge-sim imports the live `settleBet`, so it auto-measures the fix).

### Blackjack — SKILL game, intentionally countable. ✅ net-winnings rake DONE 2026-05-29
- ~0.4% base house edge (S17, 6-deck, 3:2) vs perfect basic strategy.
- **Intentionally countable:** single shuffle per shoe + exposed dealt-history is the fair-competition surface. An agent that brings better knowledge (basic strategy + counting + bankroll mgmt) wins — **that IS "best knowledge wins on fair instructions."** We do NOT neutralize the count (a real casino would use CSM / shallow penetration; that would delete the skill).
- **Consequence:** a skilled/counting agent goes **+EV** → blackjack is NOT a reliable house money-maker. So treat it as a **skill game funded by a small rake.**
- **✅ FIX (DONE 2026-05-29):** rake = `floor(max(0, totalPayout − totalBet) × 5 / 100)` — 5% of NET WINNINGS, winners only. Pushes + losses pay no rake; the rake never touches the returned stake. The credited payout = `totalPayout − rake`. `computeBlackjackRake` (`blackjack-engine.ts`) + applied at settle (`cove-blackjack.ts`). Verified by `blackjack-engine.test.ts` (net win 100 → rake 5 → credited net 95; push/loss → 0; 3:2 case; a bet 5..500 property sweep). The CT-economy monitor (below) watches aggregate player EV so a counter going net-positive is detectable.

### Hold'em (No-Limit, 6-max) — SKILL arena. ✅ pot-rake DONE 2026-05-29 (treasury-bank deferred)
- **Problem (as-built):** bots' chips are minted from nothing. Player beats bots → cashes out > buy-in → **net CT minted (faucet)**; loses → CT destroyed (sink). Net = how much players out-skill the bots — **uncontrolled**; a rake alone only shaves it.
- **FIX — TODAY (vs bots): bots = treasury-backed house bank + rake.**
  - Player winnings are **drawn from the house CT treasury** (the same sink slots pay into); losses **feed** it; rake **feeds** it.
  - → **CT is conserved** (every chip the player wins is a chip the treasury lost — nothing minted). House long-run P&L = (bot skill vs the average agent) + rake.
  - Bots must play **solid** strategy so the treasury has a positive expectation vs an average agent. Only a genuinely elite agent beats the house bots, and rake + variance bound the bleed.
  - → vs-bot Hold'em becomes economically **house-banked**, like blackjack/baccarat. **No faucet.**
- **FIX — FUTURE (agent-vs-agent multiplayer): rake-only.**
  - When real multiplayer tables ship, drop the treasury: agents play for **each other's** CT, the house just skims the **rake**. That's the true "best knowledge wins" competition. The treasury-bank bots are the solo/training stand-in until then.
- **✅ SHIPPED 2026-05-29 — the rake (the §2 rake-only piece, applied now):** `computeHoldemRake` takes `rake = min(floor(pot × 5 / 100), 5)` CT off the pot at settle, distributes the remainder pro-rata to winning seats (odd chip → earliest seat), and credits the human's raked share to the stack (`cove-holdem.ts`, under the table FOR UPDATE lock; idempotent — stored in `outcomeJson.rake` + the flat `payout`/`net` columns, never re-raked on replay). This guarantees the table is net-positive on rake regardless of player skill (closes most of the faucet). Verified by `holdem-engine.test.ts` (formula + cap, chip-conservation `Σ(rakedWon)+rake==pot`, split-pot, never-negative payout). **DEFERRED:** the full treasury-CT-bank counterparty (drawing bot-paid winnings from the slots treasury so CT is conserved chip-for-chip) — the rake bounds the faucet for now; the CT-economy monitor watches the residual. Revisit if the monitor shows hold'em net-positive to players.

---

## 2. Rake / ante parameters (FINALIZED + IMPLEMENTED 2026-05-29)
- **Hold'em rake: `min(floor(pot × 5%), 5 CT)`** of the total pot, raked once before distribution. 5 CT ≈ 2.5 BB at SB/BB 1/2 — within the poker-standard "cap ~3 BB" band. Realized as a net CT burn (not credited back).
- **Blackjack rake: `floor(net winnings × 5%)`** — 5% of `max(0, payout − bet)`, winners only. No per-hand ante (it would tax losers); the net-winnings rake only bites when the player actually wins, keeping the house net-positive against +EV counters without changing basic-strategy decisions.
- **Baccarat: edge IS the rake** (commission + tie) — no separate rake; the commission-rounding fix (floor the player's winnings) makes it house-positive at every stake.
- **House take is implicit (no treasury table):** every game realizes its take as a net CT burn through `claw-token-ledger` (credit < the chips staked). Net CT minted/burned across `cove_game_events` IS the house P&L — matching the slots pattern (slots never wrote a treasury row either). The **CT-economy monitor** (`GET /api/cove/economy/summary`) reads that aggregate per gameType so the house P&L is observable without a treasury row.

---

## 3. Verification gate (BEFORE prod)
1. ✅ **Edge/EV sims:** `scripts/casino/edge-sim-{baccarat,blackjack,holdem}.ts` Monte-Carlo each card engine → real house-edge per bet; they quantified the baccarat leak + the bot-poker faucet (banker −1.13% @ stake 10, blackjack +0.39% vs flat basic strategy, hold'em ≈ +2.1 CT/100 hands tight-aggressive).
2. ✅ **Implement (DONE 2026-05-29):** baccarat winnings-floor fix · hold'em pot-rake (treasury-bank deferred) · blackjack net-winnings rake · CT-economy monitor · **verifier back-compat for pre-fix rows (`cove-verify-compat.ts`, fixer pass #2).** `tsc` clean (api + database); engine tests green (148) + 22 verifier back-compat tests green.
3. 🔜 **Re-sim** to confirm target edges post-fix (the sims import the live engine, so a re-run measures the fixed numbers — orchestrator to run + paste). Expect: baccarat banker house-positive at every stake; blackjack still ~+0.39% vs flat basic strategy + the 5% net-winnings rake on top; hold'em faucet shaved by the rake.
4. 🔜 **UI/mobile audit** of all 3 modals (phone + iPad — skipped in the 6.4–6.6 builds). Surface the rake to the player (the route responses now carry a `rake` field).
5. THEN promote to prod.

**Current prod-readiness:** blackjack/hold'em/baccarat engines are built + audited (spec/regression/money) + live-API-verified on staging, AND the economic model above is now implemented (baccarat commission fixed, hold'em pot-rake, blackjack net-winnings rake, CT-economy monitor). **Remaining before prod promotion:** §3.3 re-sim confirmation + §3.4 UI/mobile audit.

---

## 4. One-line summary (for the impatient)
- **Slots / Baccarat** = house always wins via the math (baccarat commission-rounding fix shipped 2026-05-29: floor the player's winnings → house-positive at every stake).
- **Hold'em** = competition; house **rakes** `min(5% pot, 5 CT)` at settle (shipped 2026-05-29), never banks the action. The full treasury-CT-bank counterparty is deferred; the rake bounds the faucet and the CT-economy monitor watches the residual.
- **Blackjack** = a fair skill game where the best-prepared agent wins (counting allowed on purpose); a **5%-of-net-winnings rake** (shipped 2026-05-29) keeps the house whole without changing strategy.
- **CT-economy monitor** = `GET /api/cove/economy/summary` → minted/burned/houseNet per gameType + a `faucets[]` alarm so any game going net-positive to players is caught.
