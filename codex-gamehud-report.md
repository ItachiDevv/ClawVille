# Hold'em gameplay visibility — single-pass implementation report

Date: 2026-07-17
Branch: `feat/cove-3d-holdem`

## Calls made

- Used two commits: Part A isolates the fairness-sensitive server/shared wire change; Part B contains the client playback/UI, docs, and this report.
- Attempted the mandated `git pull --ff-only` first. It safely refused because this feature branch tracks `origin/staging` and is intentionally diverged (`ahead 35, behind 189`). I did not merge 189 staging commits into the scoped feature branch and preserved every pre-existing dirty/untracked evidence file.
- Kept `holdem-controller.ts` as the only request/mutation owner. No client fetch path, ledger path, settlement rule, seed handling, or bot-card exposure was added.
- Used DOM overlays only. `holdem-table-room.tsx` and its static R3F camera/render loop were not changed; no drei Text/Billboard, shader, or per-frame projection was introduced.
- Added an additive-wire rolling-deploy guard (`publicActionLog ?? []`) so a newer web process does not crash during a brief old-API overlap.

## Files changed

Part A:

- `apps/api/src/routes/cove-holdem.ts`
- `apps/api/src/routes/__tests__/cove-holdem-resync.test.ts`
- `packages/shared/src/types/cove-holdem.ts`
- `GameFeatures.md` (§18a.g public-live-state audit)

Part B:

- `apps/web/src/lib/cove/holdem-controller.ts`
- `apps/web/src/components/cove/holdem/SeatedHoldemHud.tsx`
- `apps/web/src/components/cove/holdem/RaiseSlider.tsx`
- `apps/web/src/components/cove/holdem/HoldemModal.tsx`
- `apps/web/src/lib/cove/holdem-bet-math.ts`
- `apps/web/src/lib/cove/__tests__/holdem-bet-math.test.ts`
- `GameFeatures.md` (§18a.g gameplay visibility + Last Audited)
- `codex-gamehud-report.md`

## Fairness truncation implemented

`peekState()` still appends a synthetic human `fold` so the deterministic engine can resolve a mid-hand script. That engine run contains real history followed by the sentinel and seed-derived future bot continuation. `publicActionLogFromPeek(log)` scans backward to the last human entry and returns only `log.slice(0, lastHumanIndex)`.

This makes the public log exactly the already-revealed prefix: blind posts, recorded real human actions, and deterministic bot responses through the current human decision point. It excludes the sentinel and every entry after it. The existing board prefix truncation remains unchanged. `peekState()` attaches the safe log, and `buildInProgressHandView()` is now the single response builder for fresh deal, deal replay, client-visible `/action`, and both resync reads. Other direct engine peeks are internal legality/terminal probes and never serialize a client response.

All-in edge: the engine marks seat 0 `allin` when its stack reaches zero, skips it on later betting rounds, and completes from the recorded actions alone. `isHandTerminal()` therefore returns true and the route settles; no reachable in-progress peek has a last real all-in entry mistaken for the sentinel. The helper still fails closed if that invariant ever changes: it may under-report one human action, but cannot reveal post-fold continuation.

`deriveHoldemPublicSeats(log)` is the shared canonical reducer. Because each log amount is cumulative per street, it replaces a seat's prior value on the same street and sums only the final value per street for `totalCommitted`. Arithmetic remains `bigint` until decimal-string output.

## Client behavior

- Six player identities are visible: five camera-anchored bot badges plus the bottom-center `YOU` badge in the private-card panel. Badges show live `BET n`, grey `FOLDED`, and D/SB/BB chips.
- The HUD diffs the controller's new target log against the rendered prefix. It plays each new action at 600ms cadence, flashes the acting badge, blocks all controls, and inserts FLOP/TURN/RIVER events before that street's first action.
- Board cards are gated by the playback street. All-in runouts with no later-street action entries still enqueue the missing FLOP/TURN/RIVER reveals.
- Settlement is hidden until playback completes. It distinguishes all-fold, showdown, side/split-pot outcomes; names winner(s), includes `handCategoryName`, pot details where applicable, and always gives the player's signed net.
- `BLINDS {smallBlind}/{bigBlind} vCLAW` is persistent at idle/live/settled. Naming is vCLAW throughout.
- Live pot is derived from public per-seat total commitments. `RaiseSlider` now shows min/max and Min, 3BB, ½ Pot, Pot buttons. Presets are total-street commitments, computed with bigint pot/blind/current-commit strings and clamped into the legal slider range.

## Anchor derivation

Using the static table-room camera (`CAM_EYE`, `CAM_LOOK`, vertical FOV 62) and `BOT_SEATS`, I projected a world torso sample at y=105 into a 16:9 perspective camera once. Raw normalized centers were approximately Tess `(112.0%, 88.4%)`, Vex `(112.9%, 57.4%)`, Pip `(90.1%, 42.0%)`, Cal `(-12.9%, 57.4%)`, Nita `(9.9%, 42.0%)`. The near-side bodies genuinely project beyond the frustum, so anchors are safely clamped while retaining order: Tess `(92%,72%)`, Vex `(92%,57%)`, Pip `(90%,42%)`, Cal `(8%,57%)`, Nita `(10%,42%)`; a final CSS `clamp(52px, x%, 100% - 52px)` prevents the fixed-width badges from crossing a narrow viewport edge. `YOU` uses the bottom-center private-card panel anchor. These are constants; there is no runtime Three.js import or per-frame allocation.

## Tests and results

- `packages/shared: bun run build` — pass.
- API focused fairness/engine/betting suites — 84 pass, 0 fail, 3921 assertions.
- API `bunx tsc --noEmit` — 0 errors.
- Web Hold'em bet-math suite — 14 pass, 0 fail (including three preset tests).
- Web `bunx tsc --noEmit` — exactly the required 12-error baseline: 10 legacy tracked errors plus 2 in untracked `codex-hipcheck-roster.ts`; no Hold'em error.
- Full `apps/web bun test` — 52 pass, exactly 4 pre-existing `verifier.test.ts` fixture failures; all new tests pass.
- Root `bun run build` — 9/9 package builds pass, including Next `/cove/table` and API bundle.
- `git diff --check` — pass.

Browser verification used the production bundle at `http://localhost:3001/cove/table` with the current API on `:4001`:

- Desktop: room loaded, idle BLINDS chip visible, a restored live hand showed correct seat folds/bets/SB/BB; calling disabled all buttons during replay and visibly flashed successive actions.
- Raise surface: slider exposed min/max plus Min/3BB/½ Pot/Pot and 44px buttons.
- Settlement: folding played the remaining actions before showing `Everyone else folded — Vex takes 8 vCLAW` and `Your net: -2 vCLAW`.
- 390×844 phone and 820×1180 iPad emulation: controls/banner remained readable and tappable; real-iPad safe-area lift cannot be proven in emulation.
- Browser page errors: none. Console contained only pre-existing Three.js Clock deprecation and shader-unroll warnings.

## Protocol-manual finding

`apps/api/src/services/skill-protocol.ts` mentions the `cove.holdem.hand.settled` event and documents tournament Hold'em, but it does not document the six-seat Cove Hold'em REST in-progress response shapes or `publicActionLog`. Per instruction, I did not edit `skill-protocol.ts` and did not bump `PROTOCOL_VERSION`; that response-shape propagation remains for review.

## How to verify

1. Run the production bundle (never HMR): API on the worktree's configured port and web on `3001`, then open `http://localhost:3001/cove/table`.
2. Confirm the idle `BLINDS 1/2 vCLAW` chip, then Deal.
3. Watch SB/BB posts and bot actions flash at their badges. Confirm controls remain disabled until `PLAYING ACTIONS…` clears.
4. Call/raise through a street and verify the street toast precedes the new board cards; folded seats stay grey and current-street bets update.
5. Open Raise and verify min/max plus Min/3BB/½ Pot/Pot.
6. Finish or fold the hand. The complete action delta must play before an explicit all-fold/showdown/split-pot banner appears with the player's net.
