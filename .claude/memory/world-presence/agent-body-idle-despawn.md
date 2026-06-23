---
name: agent-body-idle-despawn
description: "Agent-body idle-despawn removes only the in-memory body + persists metadata; it MUST NEVER touch session_expires_at/swept_at/key_hash — DESPAWN != EXPIRY, else the owner's held bearer becomes unrestorable."
category: constraint
confidence: high
date: 2026-06-22
---

---
name: agent-body-idle-despawn
description: Agent-body idle-despawn removes only the in-memory NPC + persists metadata; never touch the session TTL columns — DESPAWN != EXPIRY.
category: constraint
confidence: 0.9
date: 2026-06-22
---

# Agent-body idle-despawn is NOT session expiry

**What it does (agent-body-idle-sweeper.ts):** `sweepIdleAgentBodies:65` despawns an agent's in-world BODY after `AGENT_BODY_IDLE_DESPAWN_MS` (default 30min, 5min floor, :43-44) of inactivity to save sim CPU. It calls `npcSimulation.unregisterOpenClaw` (:130) — removing ONLY the in-memory Map entry + the in-world NPC — and persists ONLY `metadata(lastX/Y)` + `updated_at`.

**The frozen invariant (:11-23, regression-frozen comment):** it MUST NEVER write `session_expires_at` / `session_swept_at` / `session_key_hash`. Those are the SESSION sweeper's job. Clearing or advancing any of them makes the owner's still-held bearer unrestorable -> 404 mid-chat (the b453fb18 bug class). The session stays valid for its 24h TTL; the agent re-bodies on its next authenticated activity via `openclaw-session-restore` (which finds the row by `sha256(bearer)` + re-validates strictly-future expiry).

**Also:** skip a body whose row read failed (:98) — don't strand it. Wired at `index.ts:529` (`startBodyIdleSweeper`).

**Deployment:** present + correct (guarded) in this worktree. FIXED/guarded. Owner is ambiguous (likely co-owned with agent-protocol-partner) — coordinate. Related: `[[multiplayer-presence-e5-parity]]` `[[never-leak-raw-sessionid]]`.
