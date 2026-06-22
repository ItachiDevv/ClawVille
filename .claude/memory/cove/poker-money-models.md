---
name: poker-money-models
description: "MTT (play-money chips, CT only on buyin+prize) vs CASH (chips==CT 1:1, CT on every sit/leave) — different ledger-crossing points, same settle formula"
category: economy
confidence: high
date: 2026-06-21
---

# Poker money models — MTT vs CASH

Two products, SAME `PokerTableSim` engine but DIFFERENT singletons (`pokerMttSim` vs `cashTableSim` vs `pokerTableSim` WS demo — each manager EXCLUSIVELY owns `setHandCompleteFn` on ITS sim, never cross-wire).

**MTT (DEPLOYED on prod, `cove-poker-mtt.ts` mounted index.ts:311):**
- Tournament CHIPS are play-money (scaled by startingStack), NOT CT.
- CT crosses `claw-token-ledger` on exactly 2 flows: buy-in DEBIT `poker_mtt_buyin` at `registerEntrant` (atomic, in `db.transaction`, FOR UPDATE), prize CREDIT `poker_mtt_prize` at `settleTournament`; cancel/orphan path CREDITs `poker_mtt_refund`.
- Conservation: see [[conservation-and-idempotency-patterns]] (floor shares + fold remainder into 1st).
- `resolveRegisterSubject` = user|agent, **NO guest** (a CT buy-in has no demo mode). Agent plays AS ITSELF with real CT + real leaderboard placement (`activity.match.placed`).
- Agent ACTION surface wired (P5a, `PROTOCOL_VERSION=3`, commit `9065c284`): `poker_register/get_state/act/advise/connection` via `/api/agent/:sid/cove/poker/*`. Betting is a session-bound TOOL with a SERVER-derived avatarId, NEVER the free-text `[ACTION:]` parser (`enter_poker_room` is the only [ACTION] verb, navigation-only).

**CASH (LOCAL-ONLY, NOT deployed, `cove-cash-poker.ts` WIP `2259353e`):**
- chips == CT 1:1. CT crosses on SIT/REBUY debit `poker_cash_buy_in` (subject→escrow) + LEAVE cash-out credit `poker_cash_cash_out` (escrow→subject). Per-hand settle moves chips BETWEEN seats only — escrow UNCHANGED. RAKE=0 in P1.
- Seeded-agent chips REAL-CT-backed by a house-bank debit `poker_cash_house_seed` (reclaimed `poker_cash_house_reclaim`); a seeded provider with no `houseBankAvatarProvider` THROWS `seeded_agent_requires_house_bank` — explicit anti-faucet.
- `resolveSubject` = user|agent parity, no guest.
- **OPEN bugs:** no db.transaction ([[cash-poker-no-transaction-bug]]); no agent tool surface (E5 mandate #2); seeded+housebank providers unset in the singleton (no agent fill on prod). Must close ALL before cash ships.

**Note:** '404 on prod' from the prompt is a Hono trailing-slash artifact for MTT — `/api/cove/poker/mtt` works, `/mtt/` 404s. MTT IS live. Only CASH is genuinely unshipped. Related: [[cash-poker-no-transaction-bug]], [[poker-protected-partner-surface]].
