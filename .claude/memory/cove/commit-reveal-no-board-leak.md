---
name: commit-reveal-no-board-leak
description: "Commit-reveal (serverSeedHash at open, seed revealed at close) + the no-board-leak rule: never serialize undealt/hidden cards in an in-progress response"
category: pattern
confidence: high
date: 2026-06-21
---

# Provably-fair commit-reveal + no-board-leak

**Commit-reveal (all cove games, `provable-rng.ts`):** `serverSeed=randomBytes(32) hex`; `serverSeedHash=sha256(serverSeed)` published at session/shoe open; serverSeed **REDACTED** while `status='open'` (`publicSession`/`publicShoe` null it) and revealed on EVERY `cove_game_events` row only at parent close. Engine re-derives every card from `(serverSeed, clientSeed, nonce, cursor)` via HMAC; the client NEVER sends cards/outcomes, only its decision + bet. Poker publishes `serverSeedCommitHash` in the public snapshot BEFORE the hand resolves (`poker-table-sim.ts:276`) — that's a true pre-commit, not a post-hoc reconstruction.

**NO BOARD-LEAK (hard rule — a whole bug class):**
- **Blackjack:** `/hand/current` + `/agent/decide` surface ONLY `dealerUpcard` (`peek.dealer.cards[0]`). The dry-run appends a synthetic 'stand' so the dealer plays out for bust/total math, but the hole card + playout NEVER hit the wire (`cove-blackjack.ts:2230-2256,2455` 'UPCARD ONLY — never the hole card'). isResolved-per-subhand is sent because a stood-21 and live-21 are byte-identical.
- **Hold'em:** `peekState` appends a synthetic 'fold' that resolves the hand and deals ALL 5 community cards internally, then TRUNCATES `peek.board` to `visibleBoardCountForStreet` (preflop 0/flop 3/turn 4/river 5) (`cove-holdem.ts:369-441`). Returning `peek.board` un-truncated re-opens the leak — this WAS the live bug `b23b4231` (preflop returned all 5 cards via fold-to-showdown peek). humanHole/toCall/currentBet are derived from the action LOG, not future bot actions.
- **Poker:** `state-for-agent` returns only the requesting subject's own view; hidden-state redaction is compile-enforced.

**LESSON (from memory `live-smoke-catches-audit-misses`):** the holdem board-leak passed multi-agent money-adversary audits and was only caught by LIVE staging smoke. ALWAYS smoke a provably-fair engine on staging asserting hidden-state invariants (board==street-count, no opponent cards mid-hand, seed null until close) before prod. Related: [[jsonb-verifier-false-negative]], [[staging-first-adversarial-discipline]].
