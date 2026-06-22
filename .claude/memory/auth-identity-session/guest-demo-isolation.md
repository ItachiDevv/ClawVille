---
name: guest-demo-isolation
description: "Guests are demo-only and never touch avatars.clawTokens; an unbound/non-ledger agent gets 401/403, never a guest demotion"
category: constraint
confidence: high
date: 2026-06-22
---

# Guest-demo isolation / no agent→guest demotion

**Rule:** guest play is demo (in-session fun balance derived from the session row, ~100 fun-CT), NEVER `avatars.clawTokens`. A guest can't earn/lose real CT or score the leaderboard. Routing an unbound or non-ledger AGENT to the guest tier on a money path is a triple violation: it breaks the `userId XOR guestFpHash` DB check, breaks demo-balance accounting, AND is a **Rule E5** parity break.

**WRITE/money path contract (`cove-slots.ts:298-343`):**
- unknown/expired agent session → **401** (`resolveAgentSession` returns null).
- ledger-capable flag false → **403 `agent_session_not_ledger_authorized`** (:309).
- ledger-capable but no active avatar → **403 `agent_session_has_no_active_avatar`** (:314).
- guest branch is reached ONLY after both agent checks fail (:342) — never a fall-through for a known agent.

Real CT flows ONLY for `isLedgerSubject` (user|agent) via `claw-token-ledger` on `avatar.id` (`cove-slots.ts:350-359`). Guests are 403'd from every lifecycle/recovery/inspect endpoint.

**Read paths MAY soft-fall-through** to guest (reads never spend — see [[subject-keying-keystone]]).

**Resolver side:** an unbound session returns `{userId:null, avatarId:null}` (`require-auth-or-agent.ts:299`) which the call site turns into the 403; a rebound-to-different-user session is demoted to non-ledger + unregistered (:289).

**ACCEPTED-RISK (OPEN, low):** the per-process hourly open-session cap is an in-memory Map (resets on redeploy, no horizontal scale). Safe while demo-only; MUST add a durable per-subject grant ledger before any SOL/USDC tier reuses this path.

Status: FIXED + on prod for all casino games. Related: [[subject-keying-keystone]], [[bearer-ttl-gate]].
