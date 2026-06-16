# Phase 6.6 — Cove Baccarat (Punto Banco, in-house engine + skill loop + wager escrow)

**Status:** PLANNING — not implemented. Plan-first per CLAUDE.md Rule E1; code lands after user approval ("yes thoroughly plan them, but you can implement them" — 2026-05-27 is the approval anchor).
**Date:** 2026-05-27
**Branch:** `staging` (main checkout — no worktree).
**Depends on:**
- `clawville_wager` Anchor program (already merged).
- Cove interior GLB + click-hotspot pattern (Phase 6.4 blackjack established).
- Bidirectional skill-memory loop infra (Phase 6.4.1 hosted, Phase 6.4.2 connected).
- A free table mesh in the cove OR a new prop placeholder for the baccarat table (probe-and-pick same as blackjack).
**Blocks:** none (sibling to Hold'em — independent track).

---

## 0. Decisions locked by chat 2026-05-27

| # | Decision | Locked? |
|---|---|---|
| 1 | **No engine donor — built in-house.** Best OSS candidate (`open-baccarat/open-baccarat`) is a full Next.js app with i18n + DB layer; extraction cost > rewrite cost. Engine is ~200 LOC of pure TS including the third-card lookup tableau. | ✅ |
| 2 | Game variant: **Punto Banco** (the global standard — no player decisions after betting, fixed drawing rules). NOT Chemin de Fer (player-decision variant) — out of scope. | ✅ |
| 3 | Game lives in the cove at the **open floor area between poker tables and player spawn**. Position locked via `[BJ-POS]` probe 2026-05-27: `_BACCARAT_CENTER_X = 285`, `_BACCARAT_CENTER_Z = 584`. Since no GLB mesh exists at that spot, **add a programmatic placeholder** in 6.6.0 (felt-green box at table height + 4 chairs) — swap for a real mini-baccarat GLB mesh in 6.6.5. Sign label "BACCARAT". | ✅ |
| 4 | **Three primary bet types: Player / Banker / Tie.** Plus three optional side bets: Player Pair / Banker Pair / Perfect Pair. House edges: Player 1.24% · Banker 1.06% (with 5% commission on banker wins) · Tie **8:1 payout** (14.36% house edge — flag as "high house edge" in UI) NOT 9:1. Pair bets ~11%. | ✅ |
| 5 | **Single-player vs house** model — no PvP. Multi-seat at the same table is OPTIONAL (each player bets independently against house — different from poker). For 6.6.0 ship single-seat only; multi-seat in 6.6.3. | ✅ |
| 6 | **Same three-participant-type protocol as blackjack:** hosted-loopback · connected-WebSocket · house-bot (just deals + applies tableau). Player vs house only — agent skill is bet-pattern selection, not in-coup decisions. | ✅ |
| 7 | **Bidirectional skill loop:** baccarat is mostly luck — agents earn skill memories on bet-selection patterns ("avoid Tie", "banker streak detection — superstition, no real edge", "side-bet variance is large"). Memory subskill tags: `bet-selection`, `bankroll-discipline`, `side-bet-avoidance`. | ✅ |
| 8 | **Modes + agent role:** identical to blackjack/Hold'em. `mode: 'control' \| 'autonomous'`, `agent_role: 'decider' \| 'advisor'`. Advisor timer 8s/15s. | ✅ |
| 9 | **Disconnect policy (real money):** since the only player decision is the bet (placed BEFORE the coup), disconnect mid-coup is non-issue — coup resolves automatically per drawing rules and pays out per the placed bets. Disconnect BEFORE placing bet at coup-start = sit out, no bet committed. Heartbeat ping every 5s. | ✅ |
| 10 | **Currencies:** ClawTokens (fun-money) + SOL + USDC (real-money via `clawville_wager` Anchor program). Per-coup escrow at bet-place time. | ✅ |
| 11 | **RNG:** provably-fair commit-reveal shuffle per shoe. Baccarat uses an **8-deck shoe** by convention (416 cards), reshuffled when ≥75% penetration. Server commits `(server_seed + shoe_id)` hash at shoe start, reveals at shoe end. Use the same `mulberry32` injection pattern as blackjack/Hold'em. | ✅ |
| 12 | **Outbound stream:** bet options pre-coup, player+banker hands as dealt (no hidden cards in baccarat — full reveal), drawing-rule applied, outcome + per-bet settlement. Side-bet outcomes resolved at the same time. | ✅ |
| 13 | **Inbound external-skill claim:** observable play only (option C). Agent plays N coups, we measure bet-type distribution + side-bet frequency, write baseline memory entry. | ✅ |

---

## 1. PRODUCTION reference (per Rule E1)

`apps/web/src/components/cove/blackjack/BlackjackModal.tsx` for modal shell + bet-slider UI. `apps/api/src/routes/cove-blackjack.ts` (stub) for route file shape. Baccarat is the same shape with four deltas:
- **(a) No in-coup decisions** — bet → reveal → outcome. Simpler state machine: `idle → betting → dealing → resolved`.
- **(b) Six bet types** instead of one (Player/Banker/Tie + 3 pair side bets). UI = chip-on-felt placement instead of a single bet slider.
- **(c) Always full reveal** — both hands shown face-up as dealt. No hole card to hide.
- **(d) Side-bet payouts** resolve at the same time as the main bet (Player Pair / Banker Pair / Perfect Pair are independent of the main outcome).

---

## 2. SMALLEST visible diff that proves correctness (per Rule E1)

**The binary screenshot test:**
1. Player loads `/cove`, walks to the baccarat table (position captured via `[BJ-POS]` probe).
2. Click table → modal opens with mini-baccarat layout (felt + 3 main bet zones + 3 side-bet chips + bankroll).
3. Player drags chip(s) onto Banker. Clicks DEAL.
4. Player hand dealt face-up (2 cards), Banker hand dealt face-up (2 cards). Tableau applied — third card drawn if rules call for it.
5. Outcome banner ("BANKER WINS 7 vs 5 · pays 0.95×bet").
6. ClawToken bankroll updates. NEXT COUP button → re-bet.

If that one coup plays cleanly + payouts match the published tableau + bankroll moves correctly, the slice is correct.

---

## 3. GRANULARITY (per Rule E1)

| Concern | Granularity | Why |
|---|---|---|
| Engine state | **Per-coup** (`new Coup()` per round) | Stateless engine; each coup is independent given the shoe |
| Shoe state | **Per-shoe** (~80 coups before reshuffle at 75% penetration) | Standard mini-baccarat — RNG commit covers the entire shoe |
| RNG seed commit | **Per-shoe** | One commit covers ~80 coups; verifier shows entire shoe |
| Escrow / wager-program ix | **Per-coup** | Simpler than poker session-buyin; bet is placed and resolved within one coup |
| Memory write | **Per-coup** with bet-pattern aggregation every 20 coups | Per-coup memory has thin signal (baccarat is luck-heavy); aggregate is the useful unit |
| Table state | **Per-table** (long-lived if multi-seat in 6.6.3, otherwise per-session) | Single-seat in 6.6.0–2 means session = table |
| Chat-bar agent context | **Per-coup transcript + last-20 coup bet history** | Coaching is "you bet Tie 4 times in 10 coups — that's −14% EV" |

---

## 4. PHASING

### Phase 6.6.0 — Sign-only placeholder ✅ SHIPPED 2026-05-27
- Blue "BACCARAT" sign at (285, 280, 584) — placed alongside Blackjack (red) and Hold'em (white). NO hotspot, NO modal, NO mock route. Visual placeholder only so the cove reads as a 3-game venue.
- **Status: visual placeholder live in local + uncommitted (will commit alongside spawn-point update).**

### Phase 6.6.1 — Real in-house engine + hotspot + modal + history (SKIP-MOCK consolidation per user 2026-05-27)
**Combines what was previously planned as 6.6.0 + 6.6.1 + 6.7.3 — no separate mock-only phase, real backend from day 1. The visual sign already exists; this phase ships the click hotspot, the modal, the engine, the ledger writes, and the history persistence in one slice.**
- Build `packages/cove-baccarat-engine` from scratch:
  - `shoe.ts` — 8-deck shoe + mulberry32 reshuffle hook
  - `coup.ts` — deal 2 to player, 2 to banker, apply tableau (Wikipedia canonical rules)
  - `tableau.ts` — fixed lookup table for third-card draws (~30 LOC)
  - `payouts.ts` — Player 1:1, Banker 0.95:1, Tie 8:1, Pairs 11:1
  - `index.ts` — public API: `createShoe(seed) → coup(shoe, bets) → { playerHand, bankerHand, winner, payouts, shoeAfter }`
- **3D hotspot** — add `BaccaratTableHotspot` at (285, 100, 584) (same invisible-box pattern as blackjack/Hold'em). Mount in `cove-interior.tsx` alongside the existing BACCARAT sign.
- **2D modal** — `apps/web/src/components/cove/baccarat/BaccaratModal.tsx` with useReducer state machine: `idle → betting (player drags chips onto Banker/Player/Tie + 3 side bets) → dealing (animate 2+2 card reveal, third-card if tableau says so) → resolved (outcome banner + payouts breakdown + NEXT COUP + WALK AWAY)`.
- **Real backend route** `apps/api/src/routes/cove-baccarat.ts` — `POST /session/open` (init 8-deck shoe + commit serverSeedHash), `POST /coup` (Zod-validated bets, server runs engine, returns coup outcome + bet-by-bet payouts + nonce), `POST /session/close` (reveal serverSeed, archive shoe).
- **DB schema** — `cove_baccarat_sessions` (shoe state, commit/reveal), `cove_baccarat_coups` (per-coup: bets array, player+banker hands, winner, payouts, nonce within shoe).
- **ClawToken ledger** — bet debit + payout credit via `claw-token-ledger.transferClawTokens()` per coup. Atomic transaction wraps engine + ledger + history write.
- **History write** (per Phase 6.7) — every coup writes `cove_game_events` row with `gameType='baccarat'`, `outcomeJson={playerHand, bankerHand, winner, bets, payouts}`. Same transaction as ledger ops.
- **Hosted-agent memory write** — per-coup narrative + structured metadata into player's avatar ElizaOS memory via `elizaRuntime.createMemory()` with `metadata.subtype: 'game-skill'`, `metadata.skill: 'baccarat'`, `metadata.subskill: 'bet-selection' | 'side-bet-avoidance' | ...`. Same transaction.
- **Chat advisor** — reads recent coup history from memory, surfaces EV warnings ("you bet Tie 4 of last 10 coups = −14% EV").
- **Commit-reveal verifier** — extend `/cove/verify/:eventId` (from Phase 6.7) to dispatch to baccarat. New `apps/web/src/lib/cove/baccarat-verifier.ts` (WebCrypto port of `coup.ts` + `tableau.ts` — byte-identical replay given revealed shoe seed + coup nonce).
- **Same-diff doc updates per the three-surface rule:** Nori knowledge (real baccarat available), 3dStructure.md (hotspot at 285/584), GameFeatures.md (replace shell description with real-engine section + bet types + EV table + history link), Connection SKILL.md (baccarat events: `coup-start`, `bets-locked`, `cards-dealt`, `coup-resolved`, `shoe-reshuffled`), hosted-agent runtime knowledge bake.
- **Screenshot test:** click hotspot at (285, 584) → modal opens with 3 main + 3 side bet zones → drag chip onto Banker → DEAL → real engine deals + applies tableau → outcome banner with real payout math (×0.95 for banker, ×8 for tie) → ClawToken bankroll moves via ledger → coup row appears in `/cove/history` → verify-link round-trips green.

### Phase 6.6.2 — Connected-agent protocol (depends on Phase 6.4.2 SKILL.md infra)
- Define baccarat-specific event schema (`coup-start`, `bets-locked`, `cards-dealt`, `coup-resolved`, `shoe-reshuffled`).
- WebSocket handler at `/ws/cove/baccarat/:tableId` via `bun-ws-adapter`.
- `memory_recommendation` payload in `coup-resolved` event for connected agents to optionally ingest.
- Heartbeat + reconnect (simpler than Hold'em since no in-coup state to preserve).
- Skill-test-on-entry: agent plays 20 coups, observed bet distribution written as baseline memory.

### Phase 6.6.3 — Multi-seat table (optional)
- Up to 7 betting positions at one table sharing the same shoe.
- Each player bets independently; outcomes resolve simultaneously.
- Lobby UI to find open tables.
- Defer if /dash shows single-seat is preferred by players.

### Phase 6.6.4 — Real-money tier (SOL + USDC)
- New wager-program ix: `init_baccarat_coup_sol/spl`, `settle_baccarat_coup_sol/spl`. Simpler than Hold'em (per-coup not per-session).
- TS client regen via Codama.
- Wallet-adapter modal at bet-place.
- Side-bet payouts wrapped in same settle ix (variable-output payout array).

### Phase 6.6.5 — Polish + leaderboard + 3D table mesh upgrade
- If 6.6.0 used a placeholder, swap for a real mini-baccarat GLB mesh (Polyhaven CC0 or commission).
- Bead-plate / scorecard display showing recent coup history (Player/Banker/Tie pattern visualization).
- Baccarat leaderboard: lifetime PnL, longest banker streak, worst tie-bet ROI.

---

## 5. TEAM composition + `team_name` per phase

Same parallel-impls pattern as blackjack fix + Hold'em plan.

| Phase | Team name | Composition (parallel) |
|---|---|---|
| 6.6.0 visual shell | `cove-baccarat-shell-2026-05-27` | `impl-felt` (3da, felt + 3-zone + 3-side-bet UI) · `impl-modal` (3da, state machine + chip drag + animation) · `impl-route-docs` (general-purpose, mock route + 3 doc updates + table-position probe) + `combined-audit` (3da, blocked on all 3) |
| 6.6.1 engine + memory | `cove-baccarat-engine-2026-05-28` | `impl-engine` (general-purpose, shoe + coup + tableau + payouts from scratch) · `impl-modal-wire` (3da, replace mock with real engine) · `impl-memory-ledger` (general-purpose, ClawToken ledger + memory write) + `combined-audit` |
| 6.6.2 protocol + WS | `cove-baccarat-protocol-2026-05-29` | `impl-ws` (general-purpose) · `impl-protocol` (general-purpose, schema in @clawville/shared) · `impl-modal-ws` (3da, modal → WS) + `combined-audit` |
| 6.6.3 multi-seat (optional) | `cove-baccarat-multiseat-2026-05-30` | `impl-table-state` · `impl-lobby` · `impl-modal-multiseat` + `combined-audit` |
| 6.6.4 real money | `cove-baccarat-real-money-2026-05-31` | `impl-anchor` (general-purpose) · `impl-ts-client` · `impl-modal-wallet` + `solana-auditor` (mandatory) + `combined-audit` + reconciler-manager (custody = high-stakes) |
| 6.6.5 polish + mesh | `cove-baccarat-polish-2026-06-01` | Light team: `impl-mesh-bead-plate` + `combined-audit` |

Every prompt MUST include: literal "use ultrathink reasoning before writing code", addressable team name + role + other members, blocking deps, hard constraints from CLAUDE.md.

---

## 6. REVERT plan per phase

- **6.6.0:** revert single PR. Cove unaffected. Modal + hotspot + mock route deleted. If a placeholder table mesh was added to cove-interior.tsx, remove the constants block + hotspot mount.
- **6.6.1:** keep `packages/cove-baccarat-engine` vendored (just imports). Revert wiring + ledger calls. Mock from 6.6.0 still works.
- **6.6.2:** WebSocket route deleted; modal falls back to single-player from 6.6.1.
- **6.6.3:** multi-seat code deleted; single-seat from 6.6.2 still works.
- **6.6.4:** devnet-only first → IDL rollback safe. Wallet-adapter modal removed. Fun-money from 6.6.1 still works. In-flight coups settle via existing auto-resolve path.
- **6.6.5:** trivial — visual polish only.

---

## 7. Same-diff doc updates per phase

| Phase | Nori `knowledge[]` | Connection SKILL.md | Hosted skill memory inj | `3dStructure.md` | `GameFeatures.md` | `ARCHITECTURE.md` |
|---|---|---|---|---|---|---|
| 6.6.0 | New game in cove (stub) | n/a yet | n/a yet | New hotspot mesh/placeholder + position | New game section + bet-type explainer | n/a (mock route) |
| 6.6.1 | Skill loop (EV warnings) | n/a yet | NEW BAKE | n/a | Engine + payout tables | New routes + DB tables + engine package |
| 6.6.2 | Connected-agent flow | UPDATE manifest + baccarat events | UPDATE | n/a | Connected-agent section | WebSocket route + event/action schema |
| 6.6.3 | Multi-seat flow | UPDATE (multi-seat events) | UPDATE | n/a | Multi-seat section | Multi-seat routes |
| 6.6.4 | Real-money tier | UPDATE (settle + side-bet payout) | UPDATE | n/a | Real-money section | Wager-program ix + TS client |
| 6.6.5 | Polish-only sweep | Version bump | Version bump | NEW (real GLB if swap) | Bead-plate + leaderboard section | Leaderboard route |

Skip any column = unmergeable PR per the three-surface rule.

---

## 8. Open / deferred

- **Chemin de Fer / Banque variants** (player-decision baccarat) — deferred indefinitely. Punto Banco only.
- **Squeeze animation** (the dealer slow-reveal flourish) — defer to 6.6.5 polish.
- **Custom commission rates** (some tables offer 0% commission on banker with adjusted Tie payout) — deferred. Standard 5% only.
- **Mini-baccarat → big baccarat differentiation** — visual only; same engine. Skip in plan.
- **Bead-plate prediction tools** ("the dragon", "the cockroach") — defer to 6.6.5. Note in docs that these are superstitions with no real edge.
- **Asian-market UI translations** (baccarat is huge in 亚洲) — deferred to localization sprint.

---

## 9. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Third-card tableau implemented wrong | medium | Reference Wikipedia canonical table + cross-check with Wizard-of-Odds expected values; unit-test every tableau branch (~30 cases) |
| Tie bet 8:1 vs 9:1 confusion | medium | Lock to 8:1 in plan §0 #4; assert in payouts.ts test |
| Banker 5% commission rounding (player loses 0.001 per CT bet on small wagers) | low | Round-down to nearest 0.01 CT; document in payout table |
| Side-bet variance scares casual players | medium | UI badge: "high variance" on side-bet zones; default to main bets only |
| RNG seed predictability | low | Commit-reveal per shoe; same as blackjack/Hold'em |
| Memory write per coup = low signal | medium | Aggregate per-20-coup window, write summary memory only; raw coup data dropped after |
| Skill loop is unconvincing for baccarat | medium | Lean into "the skill IS bankroll discipline" framing; agent learns to avoid Tie / side bets over time |
| Placeholder mesh in 6.6.0 looks ugly | low | Use a clean green-felt box at table height; commit to real mesh swap in 6.6.5 |

---

## 10. Approval gate

User approval anchor 2026-05-27 covers Phase 6.6.0 dispatch immediately after this doc lands. Subsequent phases gate on user visual sign-off (Rule E4) of the prior phase's deploy.

Orchestrator commits + pushes per the staging-first push flow. Hold'em and Baccarat are independent tracks — can run their phases in parallel (separate teams, separate team_names) when team-capacity allows.
