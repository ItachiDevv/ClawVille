---
name: bearer-ttl-gate
description: "validateLiveAgentSession is THE single fail-closed liveness gate; Map membership is never sufficient, NULL TTL = expired, restore obeys the identical rule"
category: pattern
confidence: high
date: 2026-06-22
---

# Bearer/TTL liveness gate (the single source of truth)

`validateLiveAgentSession(sessionId)` (`require-auth-or-agent.ts:107`) is THE one liveness gate every bearer-trusting path routes through (cove `getSubject`/`resolveSubject`, gateway perceive/move/chat, Milady→Lucia exchange, world presence). Live ONLY when:
1. sessionId is in the in-memory `openClawBots` Map, OR restorable from the row on a Map-miss (:116 → `restoreAgentSessionFromRow`).
2. the `openclaw_bots` row exists.
3. `session_expires_at` is NON-NULL and strictly `> now`.

**Map membership ALONE is NEVER sufficient** — the DB row's `session_expires_at` is the source of truth (the in-mem Map outlives the DB TTL: the sweeper marks expiry but doesn't unregister the Map entry; auth-lens fix #4). A **NULL `session_expires_at` = EXPIRED** (:131); on expiry the stale body is `unregisterOpenClaw`'d so the next call short-circuits.

**Rotation invalidation (R2-2):** on a live Map hit, require the present bearer hash to equal the row's CURRENT `session_key_hash` — `sha256Hex(sessionId) === bot.sessionKeyHash`, but **present && mismatch only** (:166, see [[fail-closed-null-init]]). A rotated-away bearer (a later /connect or register/PATCH wrote a new hash) mismatches → teardown → null, so it can't keep spending the victim's CT.

**Restore obeys the IDENTICAL rule** (`openclaw-session-restore.ts:356` TTL, :365 swept gate) — it can NEVER grant liveness the primary gate would refuse, never mints a new sessionId, never slides the TTL, never grants new ledger capability. `inFlightRestores` coalesces concurrent same-agent restores (:342).

**Bearer is a real-CT credential:** persist/log ONLY the sha256 — full `sha256Hex` → `session_key_hash`, 16-hex `sessionDigest` → logs/ledger metadata (`session-digest.ts:29,:57`). A digest is NEVER accepted as auth.

Status: FIXED + on prod. Related: [[ledger-rebind-revalidation]], [[fail-closed-null-init]], [[async-resolver-await]].
