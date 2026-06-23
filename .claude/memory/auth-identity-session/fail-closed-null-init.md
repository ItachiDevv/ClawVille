---
name: fail-closed-null-init
description: "A fail-closed bearer/hash gate that rejects on a NULL column locks out a legit not-yet-persisted freshly-minted session — scope reject to present && mismatch"
category: gotcha
confidence: high
date: 2026-06-22
---

# Fail-closed null-init lockout

**Symptom:** a freshly-minted partner session 401/teardown's on its FIRST real-CT call even though it was just registered.

**Root cause:** a fail-closed gate on a NULLABLE column (`session_key_hash`) that rejects on NULL. The partner register/PATCH path calls `registerOpenClaw` (Map-live) BEFORE persisting `session_key_hash`, and that persist is EXPLICITLY non-fatal (try/catch, 'won't survive a restart'). A strict `bot.sessionKeyHash !== sha256Hex(sessionId)` would turn that documented-non-fatal failure FATAL — killing a just-minted session in the register→persist window (the 910→928 window) or whenever the non-fatal persist threw.

**Fix (FIXED + on prod):** scope the reject to **present && mismatch** only — `if (bot.sessionKeyHash && bot.sessionKeyHash !== sha256Hex(sessionId))` (`require-auth-or-agent.ts:166`). A NULL hash is NEVER a rotation-stale bearer: a null-hash Map entry can only have been registered by THIS process (the Map empties on restart; every restart-restore matches the row by `sessionKeyHash === sha256Hex(incoming)`, so a restored entry always has a non-null hash). So null = not-yet-persisted fresh session → fall through to the TTL gate. The rotation attack stays fully covered because rotation ALWAYS writes the new bearer's non-null hash.

**General rule:** a fail-closed gate on a nullable column must reject `present && mismatch`, NEVER on null — null is a not-yet-initialized state, not a tampered one (unless the column is non-nullable by construction).

**Anchors:** `require-auth-or-agent.ts:150-169` (null-hash carve-out comment + the :166 guard); `partner-hatcher.ts:913` (atomic hash in the upsert that now narrows the window). Pairs with [[bearer-ttl-gate]], [[agent-session-map-row-race]].
