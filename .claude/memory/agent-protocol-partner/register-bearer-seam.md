---
name: register-bearer-seam
description: "The register critical section (upsert + atomic sessionKeyHash + post-commit spawn) runs under withKeyedMutex(agentId) around ONE pg_advisory_xact_lock that re-reads the row; agent lock outer, cap lock nested on insert. Co-owned with auth (the GATE). Map/row race + null-init + no-uncommitted-bearer traps live here. FIXED."
category: gotcha
confidence: high
date: 2026-06-22
---

# Register bearer/TTL/hash seam (co-owned with auth-identity-session)

**Status: FIXED + LIVE.** This domain owns the REGISTER side (mint/rotate/evict); `auth-identity-session` owns the GATE (`validateLiveAgentSession`/`resolveAgentSession`). READ `.claude/memory/auth-identity-session/` before touching this.

## The race (map/row)
The in-mem `openClawBots` Map keys by **sessionId** (MANY per agentId); the row holds ONE `session_key_hash`. Concurrent registers → the later DB write wins the hash and the earlier 200-OK bearer is dead-on-arrival (the GATE's present&&mismatch teardown, `require-auth-or-agent.ts:166`), plus a duplicate avatar body.

## The fix (partner-hatcher.ts:806-974)
Wrap the WHOLE critical section in `withKeyedMutex(namespacedAgentId)` (`:848`, in-process — covers the post-commit Map spawn the DB lock can't) AROUND ONE `pg_advisory_xact_lock(agentLockKey)` tx (`:858`, cross-process) that **RE-READS the row after acquiring**. Agent lock OUTERMOST; cap lock (`dailyRegistrationLockKey`) nested ONLY on the insert branch (`:930`) — agent→cap order, deadlock-safe (distinct sha256-derived top-bit-cleared keys). Commit `sessionKeyHash` ATOMICALLY in the SAME upsert tx (`:913`). NOT a pg lock nested under the cap lock; NOT a hash write outside the tx.

## Fail-closed-null-init (GATE-side, co-owned)
`registerOpenClaw` is Map-live BEFORE the (historically non-fatal) hash persist. A strict null-hash reject would kill a freshly-minted session in that window. The GATE scopes the reject to `present && mismatch` ONLY: `if (bot.sessionKeyHash && bot.sessionKeyHash !== sha256Hex(sessionId))` (`require-auth-or-agent.ts:150-169`). NULL = not-yet-persisted fresh session → fall through to the TTL gate; rotation always writes a non-null hash, so the attack stays covered. The atomic write (`:913`) narrows the window further.

## Never surface an uncommitted bearer
- `persist_failed` (tx rolled back) ⇒ 503, NO sessionId (`partner-hatcher.ts:984-992`, `:1157-1172`).
- Override spawn failure ⇒ 409 `override_target_unavailable` (via `OverrideTargetUnavailableError` sentinel) or 503, NO sessionId.
- PATCH avatar-spawn failure ⇒ discard the minted id (`:1627-1632`).
- Commit-first-spawn-after: spawn the body AFTER the row+hash commit, inside the mutex, NOT inside the held tx.

## PATCH preservation + override compensation
PREFER reusing the live `preservedSessionId` so the partner's bearer survives a PATCH; only MINT (+ return `sessionExpiresAt`) when there's no live session (`:1422-1472`); `rotated===true` only on a fresh mint. On override re-register FAILURE, snapshot ALL body-defining + bearer-lifecycle fields under the tx BEFORE the update and compensate-write the prior hash back (Codex pass-7, `:1312-1338`/`:1576-1625`) — do NOT null the minted hash (that bricks the partner's prior restorable bearer).

→ [[hatcher-namespace-reserved]] [[eviction-on-ownership-rebind]]
