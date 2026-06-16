# Phase 6.7 — Cove Game History + Provable-Fair Verifier (cross-game)

**Status:** PLANNING — not implemented. Plan-first per CLAUDE.md Rule E1; user approved "yes draft plans thoroughly with ultrathink and implement" 2026-05-27.
**Date:** 2026-05-27
**Branch:** `staging`.
**Depends on:**
- Slots verifier infra (already shipped — `apps/web/src/lib/casino/verifier.ts`, `apps/web/src/app/casino/verify/page.tsx`, `apps/web/src/app/casino/verify/[sessionId]/page.tsx`). Pattern to mirror across all four games.
- Each game's real engine + commit-reveal RNG: slots ✅ (already live), blackjack 6.4.1 ⚠ (currently client-side mock per 6.4.0 fix — needs server-authoritative migration), Hold'em 6.5.1 (planned), Baccarat 6.6.1 (planned).
- ElizaOS memory write path for hosted-agent skill memories (same write site as the event-persistence path — they share the engine completion hook).
**Blocks:** real-money tier for all four games — without a verifiable per-event history, players can't audit losses, regulator/court can't reconstruct disputes.

---

## 0. Decisions locked 2026-05-27

| # | Decision | Locked? |
|---|---|---|
| 1 | **Single unified table `cove_game_events`** (NOT per-game tables). Game-agnostic shell with a typed `outcomeJson` jsonb column carrying game-specific payload. Trade-off accepted: less SQL-type-safety in exchange for one schema migration, one query API, one UI render path. | ✅ |
| 2 | **Per-event commit-reveal hash chain.** Every gameplay event writes both `serverSeedHash` (committed at session/shoe open) and — after shoe/session closes — `revealedServerSeed` (the preimage). Verifier replays the engine deterministically: `(revealedServerSeed, clientSeed, nonce, betAmount) → outcome` and asserts `sha256(revealedServerSeed) === serverSeedHash` AND `engineReplay(...) === storedOutcome`. | ✅ |
| 3 | **Pre-reveal events show ONLY the hash** (locked, unverifiable until shoe closes). Post-reveal events show the full chain + green/red verified badge. This is the standard provably-fair UX (Stake / BC.Game / Roobet pattern). | ✅ |
| 4 | **History API is owner-only** by default — players see only their own. ADMIN_USER_IDS can query any user's history for support / dispute resolution. No public history feed (privacy + leaderboard manipulation risk). | ✅ |
| 5 | **Verifier runs CLIENT-SIDE only** for non-fraud cases — pure replay in the user's browser, deterministic engine ports of slots' `verifier.ts` for each game. Server-side `/verify` endpoint exists as fallback for disputes (uses the same engine code, returns canonical verdict). | ✅ |
| 6 | **History retention: 90 days for free tier**, indefinite for trainers who opt-in to memory export (paid). Free-tier rows older than 90d move to compressed cold storage (`cove_game_events_archive` table, slower queries, still verifiable). | ✅ |
| 7 | **Wager-program tx signatures** stored in the same row when real-money tier ships. Verifier links to Solscan for the on-chain settlement; player can prove `payout = ledger - escrow` from chain data + engine replay. | ✅ |
| 8 | **History UI lives at `/cove/history`** (player-facing) and `/dash/cove-history?userId=...` (admin). Default view: most recent 50 events across all games. Filters by game type, date range, win/loss, real/fun money. | ✅ |
| 9 | **Per-row deep-link to verifier** — `/cove/verify/:eventId` resolves to the correct per-game verifier (slots, blackjack, holdem, baccarat). One route, runtime dispatch on `gameType`. | ✅ |
| 10 | **Event write path is the engine completion hook** — same code path that writes per-agent ElizaOS memory ALSO writes the history row (one DB transaction, both succeed or both rollback). No drift possible. | ✅ |
| 11 | **No partial events** — Hold'em mid-hand actions (fold/check/call/raise per street) are NOT written as separate rows. One row per HAND. The row's `outcomeJson` contains the full action sequence as a sub-array. Reduces row volume by ~5×. | ✅ |
| 12 | **Real-money rows are immutable + replicated** — additional WAL replication to a cold-storage bucket for legal hold. Free-money rows live only in primary DB. | ⚠ — defer details to 6.7.4 |

---

## 1. PRODUCTION reference (per Rule E1)

`apps/web/src/lib/casino/verifier.ts` + `apps/web/src/app/casino/verify/page.tsx` + `apps/web/src/app/casino/verify/[sessionId]/page.tsx` already implement slots verification (port of `apps/api/src/services/provable-rng.ts` + `slot-engine.ts` to browser via WebCrypto, byte-identical replay). This is the canonical pattern — extend it to cover the other three games + add the unified history-list UI.

History UI reference: industry standard Stake-style provably-fair history table. Columns: timestamp, game, bet, payout, outcome, verify-button. Click row → drawer or full page with hash chain + replay.

---

## 2. SMALLEST visible diff that proves correctness (per Rule E1)

**The binary screenshot test (Phase 6.7.0 — schema + slots integration only):**
1. Player loads `/cove/history`.
2. Sees a table with their most recent 50 slot spins (slots is already real + committing; we just project its existing `slot_spins` data into the new unified shape).
3. Each row shows: timestamp, "Slots", bet, payout, win/loss outcome, "Verify" button.
4. Click Verify on a row → routes to the existing `/casino/verify/[sessionId]` page filtered to that specific spin.
5. Existing verifier replays the spin and renders green check.

If 50 historical slot spins render + one verify-link works end-to-end → 6.7.0 slice correct. Each subsequent game (6.7.1 blackjack, 6.7.2 Hold'em, 6.7.3 baccarat) extends the same UI as their engines ship persistence.

---

## 3. GRANULARITY (per Rule E1)

| Concern | Granularity | Why |
|---|---|---|
| Event row | **Per hand / per coup / per spin** | One atomic gameplay unit per row. Hold'em multi-action hands collapse into a single row with action-sequence in outcomeJson. |
| Shoe / session | **Per shoe** (slots: per session, blackjack/baccarat: per 8-deck shoe, Hold'em: per shuffle) | One commit-reveal pair per shoe; all events sharing a shoe verify against the same revealed seed. |
| Verifier API | **Per event** (`/api/cove/history/:eventId/verify`) AND **per shoe** (`/api/cove/history/shoe/:shoeId/verify-all`) | Per-event is the common case; per-shoe is for bulk audits + dispute support. |
| History fetch | **Paginated by event row**, default 50, max 200 per page | Standard infinite-scroll pattern; matches Stake/BC.Game UX. |
| Memory write | **Per hand for hosted agents** (already established in blackjack 6.4.1 plan) | Same transaction as the history-row write. |

---

## 4. PHASING

### Phase 6.7.0 — Unified schema + history list UI + slots backfill
- **DB:** `cove_game_events` table (id, userId, gameType, sessionId, shoeId, betAmount, payout, outcomeJson, serverSeedHash, revealedServerSeed nullable, clientSeed, nonce, txSignature nullable, createdAt). Indexes: `(userId, createdAt DESC)`, `(shoeId)`, `(userId, gameType, createdAt DESC)`.
- **Slots integration:** add a write to `cove_game_events` in `apps/api/src/routes/casino-slots.ts` `POST /spin` handler — same transaction as the existing `slot_spins` insert. Backfill historical `slot_spins` rows into `cove_game_events` via a one-shot migration script (`scripts/casino/backfill-slot-history.ts`).
- **API:** `GET /api/cove/history?game=&limit=&cursor=` (owner-only via Lucia session); `GET /api/cove/history/:eventId/verify` (runs engine replay server-side, returns `{verified, expected, stored}`).
- **Frontend:** `/cove/history` page — table of recent events with filters + verify deeplink. `/cove/verify/:eventId` route — auto-dispatches to per-game verifier component.
- **Same-diff doc updates:** ARCHITECTURE.md §8 (new table), GameFeatures.md (history section), Nori knowledge (point at /cove/history).
- **Screenshot test:** 50 historical slot spins render at /cove/history; verify-link round-trips.

### Phase 6.7.1 — Blackjack engine real (depends on Phase 6.4.1) + blackjack history
- **PREREQ:** flip blackjack from client-side mock (current 6.4.0 state) to server-authoritative.
  - Vendor `mhluska/blackjack-simulator` as `packages/cove-blackjack-engine` (already in 6.4.1 plan).
  - Replace `apps/web/src/components/cove/blackjack/BlackjackModal.tsx` client-side mock deck with WebSocket calls to backend `POST /api/cove/blackjack/{deal,hit,stand,double,split,surrender}`.
  - Commit-reveal RNG per shoe (8 decks); inject revealed seed via `seedRNG()` into vendored engine.
- **History integration:** every hand resolution writes one `cove_game_events` row with `gameType='blackjack'`, `outcomeJson={playerHand, dealerHand, actionSequence, outcome, payout}`.
- **Verifier extension:** new `apps/web/src/lib/cove/blackjack-verifier.ts` — same WebCrypto port pattern as slots' verifier.ts, replays a hand given `(revealedServerSeed, shoeIdx, betAmount, actionSequence)`.
- **Same-diff doc updates.**

### Phase 6.7.2 — Hold'em engine real (depends on Phase 6.5.1) + Hold'em history
- **PREREQ:** Hold'em engine ships per the cove-texas-holdem.md updated 6.5.1 (real engine, skip mock).
- **History integration:** one row per hand. `outcomeJson` captures all street actions per seat + showdown reveals + side pots.
- **Verifier extension:** new `apps/web/src/lib/cove/holdem-verifier.ts` — replays a hand from shuffled deck + action sequence. Multi-seat verification (each seat's hole cards derivable from shuffle).

### Phase 6.7.3 — Baccarat engine real (depends on Phase 6.6.1) + baccarat history
- **PREREQ:** Baccarat in-house engine ships per cove-baccarat.md updated 6.6.1.
- **History integration:** one row per coup. `outcomeJson={playerHand, bankerHand, winner, sideBets, payouts}`.
- **Verifier extension:** new `apps/web/src/lib/cove/baccarat-verifier.ts` — deterministic replay from shoe seed + coup index.

### Phase 6.7.4 — Real-money rows: tx-signature linkage + legal-hold replication
- After any game's 6.X.4 real-money tier ships, history rows for real-money events include `txSignature`.
- UI: clickable Solscan link per real-money row.
- Cold-storage replication: WAL-shipping to S3/R2 bucket for 7-year legal hold (or whichever retention rule applies in target jurisdictions).

### Phase 6.7.5 — Polish + admin dashboard + dispute workflow
- `/dash/cove-history?userId=...` admin view with same UI but cross-user.
- Dispute workflow: player flags an event, admin opens server-side verifier, signs a verdict, writes to `cove_disputes` table.

---

## 5. TEAM composition + `team_name` per phase

Same parallel-impls pattern that worked on the blackjack fix + Hold'em shell.

| Phase | Team name | Composition |
|---|---|---|
| 6.7.0 schema + slots + UI | `cove-history-base-2026-05-28` | `impl-schema` (general-purpose, Drizzle migration + backfill script) · `impl-api` (general-purpose, history fetch + per-event verify route) · `impl-ui` (3da, history table + verifier deeplink + 4-game dispatch in `/cove/verify/:eventId`) + `combined-audit` (general-purpose, spec/regress/adversary blocked on all 3) |
| 6.7.1 blackjack real + history | `cove-history-blackjack-2026-05-29` | `impl-engine` (general-purpose, vendor mhluska + commit-reveal injection) · `impl-modal-ws` (3da, swap client-mock for WebSocket-driven server-authoritative) · `impl-verifier` (general-purpose, blackjack-verifier.ts + history write integration) + `combined-audit` |
| 6.7.2 Hold'em history | `cove-history-holdem-2026-05-30` | Lighter — Hold'em engine + commit-reveal already shipped in 6.5.1. Just `impl-verifier` (Hold'em-verifier.ts + history write at hand completion) + `impl-ui` (Hold'em-specific row renderer + replay UI) + `combined-audit`. |
| 6.7.3 baccarat history | `cove-history-baccarat-2026-05-31` | Same shape: `impl-verifier` + `impl-ui` + `combined-audit`. |
| 6.7.4 real-money linkage | `cove-history-realmoney-2026-06-01` | `impl-tx-link` · `impl-cold-storage` + `solana-auditor` (mandatory — tx signature trust path) + `combined-audit` + reconciler-manager. |
| 6.7.5 admin + dispute | `cove-history-admin-2026-06-02` | `impl-admin-ui` · `impl-dispute-workflow` + `combined-audit`. |

Every prompt MUST include: literal "use ultrathink reasoning before writing code", addressable team name + role + other members, blocking deps via task `addBlockedBy`, hard constraints from CLAUDE.md (Iris Xe, same-diff doc updates, three-surface knowledge sync, Rule E4 language ban).

---

## 6. REVERT plan per phase

- **6.7.0:** revert single PR. Slots continue working (slot_spins table untouched — cove_game_events is a parallel write). UI route deleted. Backfill script idempotent — safe to re-run after revert.
- **6.7.1:** revert flips blackjack back to client-side mock (current 6.4.0 state). History rows for blackjack stop accumulating. Existing rows remain queryable but no new ones.
- **6.7.2 / 6.7.3:** verifier deleted; history continues to receive raw outcomeJson but no UI per-game replay. Engine still running.
- **6.7.4:** real-money linkage removed; rows lose `txSignature` column write. On-chain settlement still works (separate path).
- **6.7.5:** admin UI deleted; dispute workflow disabled.

DB schema: additive only. No DROPs. Reverts NEVER drop columns or tables — disable writes only.

---

## 7. Same-diff doc updates per phase

| Phase | Nori `knowledge[]` | Connection SKILL.md | Hosted skill memory inj | `3dStructure.md` | `GameFeatures.md` | `ARCHITECTURE.md` |
|---|---|---|---|---|---|---|
| 6.7.0 | Add /cove/history flow | n/a yet | n/a yet | n/a | History page section + verifier explainer | New table `cove_game_events` + routes |
| 6.7.1 | Blackjack flips server-side (PvP-with-house update) | NEW: blackjack protocol bindings | NEW BAKE: blackjack protocol | n/a | Blackjack real-engine section | New WebSocket route + DB columns |
| 6.7.2 | Hold'em history + verifier | UPDATE: Hold'em events include hand-replay payload | UPDATE | n/a | Hold'em history section | Hold'em-verifier route |
| 6.7.3 | Baccarat history + verifier | UPDATE: baccarat coup events | UPDATE | n/a | Baccarat history section | Baccarat-verifier route |
| 6.7.4 | Real-money tx-link in history | UPDATE | UPDATE | n/a | Tx-linkage section | tx-signature column + cold-storage replication |
| 6.7.5 | Dispute workflow surface | UPDATE | UPDATE | n/a | Admin section | `/dash/cove-history` route + `cove_disputes` table |

Skip any column = unmergeable PR per the three-surface rule.

---

## 8. Open / deferred

- **Public leaderboard tied to history data** (e.g. "longest banker streak this week") — deferred. Privacy + leaderboard manipulation concerns; needs separate design.
- **Real-time WebSocket push of new events** to active history view — defer to 6.7.5+. Polling 30s is fine for now.
- **CSV / JSON export of history** for tax / personal records — defer. Can add in a 6.7.6 polish phase if requested.
- **Multi-shoe verification batch** (verify all events in one shoe in a single click) — defer to 6.7.5.
- **Mobile-first responsive history UI** — defer; desktop-first since /cove is desktop-first.
- **Self-exclusion + responsible-gambling controls tied to history** (e.g. "set a daily loss limit, system enforces from event log") — deferred indefinitely; major compliance scope, separate roadmap.

---

## 9. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| `outcomeJson` schema drift across games breaks query/render | high | Per-game discriminated-union TypeScript types in `@clawville/shared/types/cove-history.ts`; Zod-validate on write AND on render to prevent drift |
| Backfill script duplicates rows on rerun | medium | `slot_spins.id` becomes `cove_game_events.sessionId + nonce` deterministic key; ON CONFLICT DO NOTHING |
| Verifier WebCrypto port drifts from server engine | high | Same byte-identity test pattern as slots `verifier.test.ts` — fixture-driven, must pass before merge |
| Hash-chain reveal exposes user's session seed to other users via timing | medium | `revealedServerSeed` only readable on owner's authenticated request; public verify endpoint takes seed+clientSeed in request body, doesn't expose stored seed for OTHER players' rows |
| Cold-storage replication missed → legal-hold gap | medium | WAL-shipping monitoring + alert; 6.7.4 ships with monitor in same PR |
| History UI floods low-end browsers | low | Paginate 50/page; lazy-render row drawers; pre-compute verify status server-side, don't replay on every page-load |
| `cove_game_events` table grows unbounded | medium | 90-day archive policy; partitioned by month after year 1 |
| Connected agent reads other players' history via memory bleed | medium | Per-agent ElizaOS memory namespace strictly scoped to that agent's events — verified by the existing namespace pattern; audit confirms in adversary-lens |
| Engine version drift after verifier deploys → old rows fail verification | high | Pin engine versions; rows store `engineVersion` column; verifier loads the matching version's replay code; old rows verify against their original engine |

---

## 10. Approval gate

User said "yes draft plans thoroughly with ultrathink and implement" 2026-05-27 — approves Phase 6.7.0 dispatch. Subsequent phases gate on visual sign-off (Rule E4) of the prior phase + the dependent game's real engine landing (6.4.1, 6.5.1, 6.6.1).

Orchestrator commits + pushes per the staging-first push flow. Hold'em + Baccarat + Game History tracks can run in parallel where dependencies allow.
