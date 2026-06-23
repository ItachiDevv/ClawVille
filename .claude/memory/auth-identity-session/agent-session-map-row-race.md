---
name: agent-session-map-row-race
description: "Concurrent registers for one agentId race the in-mem Map (many sessionIds) vs the row (one session_key_hash) → dead bearer + duplicate body"
category: gotcha
confidence: high
date: 2026-06-22
---

# Agent-session Map/row register race

**Symptom:** an agent registers twice near-simultaneously (Hatcher register/PATCH, gateway `/connect`, legacy openclaw `/register`) and either (a) gets a 200-OK bearer that is dead on its first real-CT call, or (b) leaves TWO avatar bodies in the sim.

**Root cause:** the in-memory `openClawBots` Map is keyed by **sessionId** and holds MANY sessionIds per agentId, but the `openclaw_bots` row holds ONE `session_key_hash`. Two concurrent registers both clean stale sessions, both mint a bearer, both write a hash, both spawn a body. The later DB write wins the hash → the earlier bearer now mismatches the row (`validateLiveAgentSession` present&&mismatch teardown, `require-auth-or-agent.ts:166`) and is dead-on-arrival. Avatar mode leaves a duplicate body because the Map keys on sessionId, not agentId.

**Fix (FIXED + on prod):** wrap the WHOLE critical section (upsert + atomic hash + post-commit stale-cleanup + spawn) in an in-process per-agentId `withKeyedMutex(namespacedAgentId)`, wrapping a SINGLE `pg_advisory_xact_lock(agentLockKey)` tx that **re-reads the row after acquiring**. NOT a pg lock nested under the cap lock — the agent lock is outermost, the cap lock nested inside only on the insert branch. Restores use the `inFlightRestores` per-hash promise as the mirror (`openclaw-session-restore.ts:342`).

**Anchors:** `keyed-mutex.ts:8-16` (rationale: 'Both are required'); `partner-hatcher.ts:806-931` (register dual-lock: deadlock-safety, agent lock, atomic hash :913, nested cap lock); `agent-gateway.ts:576-586` (eviction-on-rebind); `require-auth-or-agent.ts:166` (the present&&mismatch teardown that races).

See [[per-subject-serialization-mutex-advisory]] (the fix pattern), [[fail-closed-null-init]] (why the teardown must be present&&mismatch, not null-reject).
