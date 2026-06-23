---
name: agent-session-resolver
description: "resolveAgentSession is the single shared resolver behind both write getSubject and read resolveSubject — ledgerCapable + bound userId/avatarId, X-Clawville-Agent-Session header"
category: pattern
confidence: high
date: 2026-06-21
---

# resolveAgentSession — the single shared agent resolver

`middleware/require-auth-or-agent.ts:249 resolveAgentSession(sessionId)` → `{ userId, avatarId, agentId, ledgerCapable }`. Header = `AGENT_SESSION_HEADER = 'X-Clawville-Agent-Session'`. This ONE resolver is reused VERBATIM by both the WRITE-path `getSubject` and the READ-path `resolveSubject` — that's what prevents write/read drift (the keystone, [[subject-keying-keystone]]).

**Gates (write path, fail-closed):** unknown/expired session → 401; `!ledgerCapable` → 403 `agent_session_not_ledger_authorized`; ledger-capable but no bound active avatar (missing userId/avatarId) → 403 `agent_session_has_no_active_avatar`. An agent is NEVER silently demoted to guest on a money path.

**Rebind re-validation (`:280-300`):** the resolver re-reads + re-validates `boundUserId === userId` on the frozen-flag path (see memory `agent-session-map-row-race` / `fail-closed-null-init-state` — a strict null check once killed freshly-minted Hatcher sessions; scope rejects to `present && mismatch`).

**Async trap:** BOTH `getSubject` and `resolveSubject` are ASYNC (the agent branch does a DB lookup). A sync call silently returns a Promise and breaks subject resolution — always `await`.

**Read-path is deliberately weaker:** `resolveSubject` checks `userId + ledgerCapable` but NOT `avatarId`, and soft-falls-through to guest for unknown/expired/unbound sessions (vs write's 401/403). Intentional — history is keyed on `userId`, reads never spend; worst case sees no rows. Don't 'tighten' it.

Related: [[subject-keying-keystone]], [[e5-parity-write-vs-read-gap]], [[guest-demo-isolation]].
