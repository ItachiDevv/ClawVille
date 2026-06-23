---
name: subject-keying-keystone
description: "WRITE getSubject and EVERY READ/history/verify path must resolve the SAME {user,agent,guest} via the SAME resolveAgentSession or an agent's CT rows vanish into the guest tier"
category: pattern
confidence: high
date: 2026-06-22
---

# Subject-keying keystone (the #1 cross-domain rule)

Every cove event/session is keyed **userId XOR guestFpHash** (DB check `cove_game_events_subject_check`). Three subject kinds:
- **user** (Lucia cookie) — ledger subject, real CT on `avatars.clawTokens` via the ledger.
- **agent** (`X-Clawville-Agent-Session` → `resolveAgentSession` → bound avatar `userId`) — ALSO a ledger subject; `isLedgerSubject()` collapses user+agent so money code is written ONCE.
- **guest** (`guestFpHash`) — demo-only, never touches the ledger.

**The keystone:** the WRITE path (`cove-slots.ts:288 getSubject` + peers) and EVERY READ/verify/claim path (`cove-history.ts:136 resolveSubject`) MUST resolve the SAME three subjects via the SAME `resolveAgentSession` (`require-auth-or-agent.ts:249`). If they drift, an agent whose play wrote `userId` falls through to guest on read and reads ZERO rows ('won 20 CT, no history' — the live **2026-06-21 prod slots/history defect**, write resolved {user,agent,guest} but read only {user,guest}).

**Precedence (both paths):** Lucia human → agent session → guest, keyed on `userId` (`ownerMatches`). An agent + its bound human share ONE userId → ONE session → ONE history scope; the agent never forks a parallel session.

**Read is DELIBERATELY weaker than write:** `resolveSubject` soft-falls-through to guest on unknown/expired/non-ledger/unbound (reads never spend; worst case zero rows). The WRITE path 401/403s instead. Do NOT tighten reads to throw (`cove-history.ts:117-130` documents the deliberate softness).

**Adding a new game = same diff:** BOTH paths + `GAME_TYPES` + a `/verify` engine branch + an economy-monitor row.

**DRIFT vs older memory (CORRECTED 2026-06-22):** poker IS now wired — `cove-history.ts:89 GAME_TYPES = ['slots','blackjack','holdem','baccarat','poker']`. Earlier notes claiming 'no poker in GAME_TYPES' are STALE.

Status: write+read parity FIXED on prod for all casino games. Related: [[guest-demo-isolation]], [[bearer-ttl-gate]], [[async-resolver-await]].
