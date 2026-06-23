---
name: guest-demo-isolation
description: "Guests are demo-only — NEVER write avatars.clawTokens for a guest; balance lives on the session row and feeds nothing persistent"
category: gotcha
confidence: high
date: 2026-06-21
---

# Guest-demo isolation

Guests play with **demo CT only**. The balance is DERIVED from the session/shoe row (`slot_sessions.startingBalance + totalWon - totalStaked`, hardcoded 100 fun-CT at open) and **NEVER touches `avatars.clawTokens`** (`cove-slots.ts:770` 'we never write avatars.clawTokens for guests'). Guest play feeds NOTHING persistent — no ledger, no leaderboard, no `activity.match.placed`.

Real CT flows ONLY for `isLedgerSubject` (user|agent) via `claw-token-ledger` debit/credit on `avatar.id`. The DB check constraint `userId XOR guestFpHash` holds because a guest carries `guestFpHash` (userId null) and a ledger subject carries `userId` (guestFpHash null). **An agent must NEVER be routed to the guest tier** — both the XOR and the demo-balance accounting break, AND it's an E5 violation.

Guests are **403'd from every lifecycle/recovery/inspect endpoint** (session/close, session/current, session/:id, /hand/current) across all games — those are ledger-subjects-only.

**ACCEPTED RISK (low):** a fingerprint-rotating guest gets a fresh demo grant; the per-process hourly open-session cap (in-memory Map, reset on redeploy, no horizontal-scale — `cove-slots.ts:167,210`, `cove-blackjack.ts:60-72`) never durably trips. Safe TODAY (demo-only). **MUST add a durable per-subject grant ledger BEFORE the SOL/USDC real-money tier reuses this accounting.**

**Blackjack guest soft-lock fix (on prod, `843e16b9`):** a guest with a stuck `in_progress` hand was permanently locked; now guest-only auto-recovery under the shoe lock voids the orphan (demo stake forfeit) + opens a fresh shoe. Authed users are NEVER auto-voided. Related: [[subject-keying-keystone]], [[e5-parity-write-vs-read-gap]].
