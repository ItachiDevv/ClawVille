---
name: npc-ghost-presence-userid-dedup
description: "The NPC-ghost / trailing-Visitor bug fix: room presence dedups by userId on fresh join (latest-login-wins) but EXCLUDES agents — an agent resolves AS owner userId so dedup would wrongly evict the human."
category: solution
confidence: high
date: 2026-06-22
---

---
name: npc-ghost-presence-userid-dedup
description: Room presence dedups by userId on a fresh join (latest-login-wins) EXCLUDING agents; this fixed the logout-leaves-NPC / trailing-Visitor ghost.
category: solution
confidence: 0.9
date: 2026-06-22
---

# NPC-ghost / trailing-Visitor — userId dedup with agent exclusion

**Symptom:** logging out left a stale duplicate body in the room, and a trailing 'Visitor' ghost lingered up to `STALE_PLAYER_MS` (~30s); a guest->authed flip could double the player.

**Root cause:** room presence was keyed by `sessionId` with NO userId dedup, so a relogin (new sessionId, same user) created a second presence.

**Fix (room-registry.ts:377-392):** on a fresh `joinPlayer`, evict any OTHER live presence sharing the same non-null `userId` (latest-login-wins) — BUT EXCLUDE `kind==='agent'`. An agent resolves AS its owner's `userId` via `world.ts resolvePresence:89`, so a naive userId-dedup would wrongly evict the human (and a co-present agent of the same owner). Agents key on a stable `a:<agentId>` sessionId (idempotent re-join). Guests (null userId) are never deduped — they're GC'd in `STALE_PLAYER_MS` and the client former-selves filter hides them. On ping-pong recovery, the fresh login wins and the recovery loser throws `PresenceSupersededError` (:203/:392).

**Keep the Visitor fallback** (`world.ts resolveAvatarMeta:123`) ONLY for genuinely null-userId presences. Purge an evicted session's `positionLastSeen` throttle entry (world.ts:310).

**Deployment:** FIXED — matches commit `95fdd487` in the project MEMORY index; present in this worktree. Related: `[[room-registry-state-machine]]` `[[multiplayer-presence-e5-parity]]` `[[never-leak-raw-sessionid]]`.
