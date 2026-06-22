---
name: async-resolver-await
description: "validateLiveAgentSession / resolveAgentSession / resolveActivityIdentity / getSubject / resolveSubject are ALL async — a sync call returns a truthy Promise and silently breaks resolution"
category: gotcha
confidence: high
date: 2026-06-22
---

# Async resolver must be awaited

All five subject resolvers do a DB lookup on the agent branch and are therefore **async**:
- `validateLiveAgentSession` (`require-auth-or-agent.ts:107`)
- `resolveAgentSession` (:249)
- `resolveActivityIdentity` (:186, WS helper)
- cove WRITE `getSubject` (`cove-slots.ts:288`)
- cove READ `resolveSubject` (`cove-history.ts:136`)

A sync (un-awaited) call silently returns a **Promise**, which is a truthy object — so a gate that checks `if (subject)` passes, downstream `subject.userId` is `undefined`, and subject resolution breaks (looks like an authed user with no id → owner checks misfire, history scopes wrong). No error is thrown.

**Guard:** always `await` all five. Both cove paths are async for exactly this reason. This is an invariant, not a shipped bug — keep it that way.

Related: [[subject-keying-keystone]], [[bearer-ttl-gate]].
