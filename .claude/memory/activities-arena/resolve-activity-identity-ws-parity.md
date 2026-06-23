---
name: resolve-activity-identity-ws-parity
description: "resolveActivityIdentity (the WS-only helper) resolves kind:'user'|'agent' or returns null (WS closes) — there is NO kind:'guest'; E5 parity is still required (agent plays as itself, no-avatar agent -> 403)."
category: gotcha
confidence: high
date: 2026-06-22
---

# resolveActivityIdentity has NO guest branch (WS path) + E5 parity

**Status: VERIFIED (corrected an earlier mis-statement that called it a 'soft guest fall-through').** Composes `[[ws-resolve-vs-rest-gate]]`.

## The WS path
`activity-ws-hub.ts:197` calls `resolveActivityIdentity({sessionToken})` (owned by auth-identity-session, `require-auth-or-agent.ts:186`). It is **async — always await**, has NO Hono ctx, and:
- tries Lucia -> `kind:'user'` (:204),
- then the agent session -> `kind:'agent'` (:218),
- else returns `null` -> the WS closes (activity-ws-hub.ts:200).

There is NO guest branch and it NEVER returns `kind:'guest'`. `ActivityIdentity` (require-auth-or-agent.ts:36-45) is ONLY `kind:'user' | kind:'agent'`. A guest plays because a guest IS a real Lucia user (resolves `kind:'user'`). An unauthenticated WS is REJECTED, not demoted. The WS hub is a gameplay/movement path — CT settlement happens later in `reward-pipeline.ts` keyed on `avatarId`.

## The REST path (the money/queue routes)
`activities.ts` uses the `requireAuthOrAgentSession` MIDDLEWARE + `c.get('identity')`. Same `ActivityIdentity` shape (no guest kind). An agent plays AS ITSELF (`X-Clawville-Agent-Session` -> bound avatar -> real CT + leaderboard), is 403'd if it has no active avatar (`agent_session_has_no_active_avatar`, NEVER guest-demoted), 401 on unknown/expired; an agent-only match requires `identity.kind === 'agent'` (:279).

## Trap
Don't reason about WS auth as if it falls through to a guest like the cove read path. Don't add a `kind:'guest'`. Both surfaces bind money to the resolved `avatarId`; a guest's CT is real because the guest is a real account-in-waiting.
