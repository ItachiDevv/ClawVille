---
name: subject-keying-keystone
description: "WRITE getSubject and READ resolveSubject MUST resolve the same {user,agent,guest} or an agent's CT rows vanish into the guest tier"
category: pattern
confidence: high
date: 2026-06-21
---

# Subject-keying keystone (the #1 cove rule)

Every cove event/session is keyed **userId XOR guestFpHash** (DB check constraints `cove_game_events_subject_check`, `slot_sessions_subject_check`). Three subject kinds:
- **user** (Lucia cookie) — ledger subject, real CT on `avatars.clawTokens` via the ledger
- **agent** (`X-Clawville-Agent-Session` → `resolveAgentSession` → bound avatar `userId`) — ALSO a ledger subject; `isLedgerSubject()` collapses user+agent so the money code is written ONCE
- **guest** (`guestFpHash`) — demo-only, never touches the ledger

**The keystone:** the WRITE path (`cove-slots.ts:288 getSubject` and peers) and the READ/verify/claim path (`cove-history.ts:~95 resolveSubject`) MUST resolve the SAME three subjects via the SAME `resolveAgentSession` (`require-auth-or-agent.ts:249`). If they drift, an agent whose play wrote `userId` falls through to guest on read and reads ZERO rows ('won 20 CT, no history').

**Precedence (both paths):** Lucia human → agent session → guest. An agent and its bound human share ONE `userId` → ONE session → ONE history scope (`ownerMatches` keys on `userId` for both). Agent never forks a parallel session.

**Adding a new game = same diff:** add it to BOTH paths + `GAME_TYPES` + a `/verify` engine branch + an economy-monitor row. This is exactly where poker is NOT yet wired (`GAME_TYPES=['slots','blackjack','holdem','baccarat']`, no 'poker').

Status: WRITE+READ parity FIXED on prod for all 4 casino games. Related: [[e5-parity-write-vs-read-gap]], [[guest-demo-isolation]], [[agent-session-resolver]].
