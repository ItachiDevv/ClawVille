---
name: per-subject-serialization-mutex-advisory
description: "A section mutating BOTH the DB row AND a process-local Map needs BOTH withKeyedMutex AND pg_advisory_xact_lock — never just one"
category: pattern
confidence: high
date: 2026-06-22
---

# Per-subject serialization: mutex + advisory (BOTH, never one)

The canonical fix for any section that mutates BOTH a DB row AND a process-local Map (npc-sim bodies, in-mem session caps).

- **`pg_advisory_xact_lock(key)` alone** serializes the DB tx across processes but the `registerOpenClaw` Map mutation happens AFTER the tx commits and is process-local → two same-process requests still both spawn a body.
- **A JS mutex alone** serializes the in-process Map but leaves the cross-process DB write racing.
- **Both required:** `withKeyedMutex(subjectKey)` (covers the post-commit in-mem spawn) AND `pg_advisory_xact_lock` inside it (cross-process; **re-read the row after acquiring**). Commit the bearer hash in the SAME tx as the row (atomic). **Commit-first-spawn-after:** the advisory lock guards only the DB write; the body spawn runs post-commit inside the mutex — a held-tx (spawn-then-commit) can leave a phantom ledger-capable body if commit fails.
- **Deadlock rule:** outer lock first ALWAYS (agent → cap), nest inner, never reversed.
- `withKeyedMutex` is **NON-reentrant** (`keyed-mutex.ts:24`) — calling it for the same key from inside a holder self-deadlocks. The critical sections are flat; keep them so.

**Anchors:** `keyed-mutex.ts:1-69` (FIFO promise-chain, GC-on-drain, 'Both are required' :16); `partner-hatcher.ts:806-931` (deadlock-safety + commit-first comments, agent lock, nested cap lock); the restore mirror is `inFlightRestores` (`openclaw-session-restore.ts:112,:342`).

Status: FIXED + on prod. Solves [[agent-session-map-row-race]].
