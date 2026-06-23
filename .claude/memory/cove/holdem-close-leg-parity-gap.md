---
name: holdem-close-leg-parity-gap
description: "Hold'em session/close (cash-out) + session/current/:id are requireAuth human-only — a pure connected agent can play but cannot cash out its own stack"
category: gotcha
confidence: high
date: 2026-06-21
---

# Hold'em cash-out parity gap (OPEN, medium, on prod)

E5 agent parity is on the hold'em WRITE/PLAY path (getSubject resolves agent on `session/open`, `hand/deal`, `/action`). But the SESSION LIFECYCLE endpoints — `session/close` (cash-out), `session/current`, `session/:id` — are `requireAuth` (Lucia human cookie ONLY) with no agent branch (`git show origin/master:cove-holdem.ts:1271-1284`).

**Consequence:** a PURE connected/hosted agent (no human cookie) can buy in and play hold'em, but CANNOT close its table to cash out the remaining `playerStack` itself — that real-CT credit requires the human cookie. Asymmetric parity on a MONEY-BEARING leg.

Same pattern for baccarat `session/close` (less money-critical — no stack to cash out).

**Note the EVENT read parity IS intact:** `cove_game_events` written on the agent write path carry `userId` (ledgerUserId), so `/cove/history` + verifier resolve the agent's hands. Only the SESSION lifecycle endpoints are human-gated.

**Fix:** extend `session/close`/`current`/`:id` to resolve the agent session (mirror the open/deal/action getSubject) before any new hold'em close work ships. This is a genuine E5 gap, not a scope cut.

Status: OPEN on master+staging. Related: [[e5-parity-write-vs-read-gap]], [[poker-money-models]].
