# Audit — Agent Lifecycle / Continuity / Directives (second-wave, NEW issues only)

**Date:** 2026-07-21
**Checkout:** `C:/Users/itachi/Documents/Crypto/cv-audit`, detached at prod HEAD `ac12da22`
**Lens:** the "Autonomous is a full-scope economic participant that PERSISTS" promise — directives, event-streamflow continuity, ElizaOS memory writes during play, provisioning/restore, crash/deploy resilience.
**Method:** read-only manual trace. Read the four prior Codex reports first (1-hosted-cadence, 2-connect-flow, 3-shared-world, 4-capability-parity); everything below is what they did NOT report.

Already-known (NOT re-reported here): 24h TTL not slid by driver activity; kick doesn't renew standby arm; driver start coupled to house seeding; missing-body wedge; non-atomic/no-grace takeover races + external REST bypassing human-control suppression; protocol/building-skill knowledge injected-but-unread by `decide()`; hosted autonomy dead-ends at the cove door; autonomous-mode double-body; NPC restore-to-home incomplete; signup fail-soft `{success:true}`.

---

## HIGH

### H1 — A directive never expires, survives mode switches, and RE-EXECUTES after every restart/deploy
**Files:** `agent-autonomy-state.ts:58-63,71-77` · `routes/avatars.ts:1304-1315,1386-1427,1390` · `agent-autonomy-driver.ts:394-396,521-522,1032-1051,1089-1093`

`config.currentDirective` is persisted with a `setAt` ISO timestamp (`buildDirectiveValue`, agent-autonomy-state.ts:58) that **nothing ever reads for expiry** — `readDirectiveBounded` / the consumption path never look at `setAt` or age. `clearAgentDirective` is called from **exactly one place** — the chat-bar `{clear:true}` branch (avatars.ts:1390); grep-verified that no deactivate, logout, Controlled-takeover, or 24h-TTL sweep clears it. Meanwhile `lastDirectiveSha` and `lastActedDirectiveSha` are **in-memory only**, reset to `null` on every registry (re-)seat (driver 394-395, 521-522).

Consequences, all directly on the task's directive questions:
- **Survives into the wrong mode / a later session:** a directive set during one Autonomous session persists on the platform-agent row through a Controlled interlude and re-activates unchanged when the user flips back to Autonomous days/weeks later.
- **Double-executed across restarts:** on every process restart/deploy the null shas make the SAME stale directive read as brand-new — it re-records `agent.directive.received` (driver 1046) + `agent.directive.acted` (driver 1091) and re-drives the directed activity, even though the human considered that instruction long done.
- It also permanently biases the semantic-RAG lesson/knowledge retrieval (`queryHint = directive.text`, driver 1053-1060) and the decision prompt's "Directive rule" (driver 1211) toward a goal the user has forgotten about.

**Fix direction:** consume `setAt` (TTL / "single-shot vs standing" flag), and clear the directive on deactivate/handback so it cannot leak into the next mode.

### H2 — The "Since you last acted" continuity summary is frozen at wake and never refreshes; there is no live event streamflow into decisions
**Files:** `agent-autonomy-driver.ts:1028,1358-1368,1382-1411,1225` · `agent-event-query.ts:57-79`

`recentEventSummary` is populated **exactly once per process lifetime per agent** by `seedFromCursorOnce` (guarded by `cursorSeeded`, driver 1358-1360; grep-confirmed the guard is only ever reset at initial entry construction, 391/517, never after). The seed advances the durable cursor to the wake-time `maxId` (driver 1366) so within-process events are never re-read. Yet that frozen string is rendered verbatim into **every** subsequent decision prompt as `Since you last acted: <summary>` (driver 1225).

For an agent that runs the full 24h TTL, the decision prompt keeps asserting "since you last acted" with data captured at boot — hours stale and actively mislabeled. The CLAUDE.md "live event streamflow for continuity" promise is met only as a **once-per-boot seed**, not a live feed; nothing the agent does or that happens to it during the session ever re-enters its context until the next process restart.

**Fix direction:** periodic re-seed (re-query since the last cursor + refresh `recentEventSummary` every N ticks) or an event-driven append, distinct from the cold-boot seed.

---

## MEDIUM

### M1 — The wake-seed's money-bearing whitelist is structurally unreachable by the only population that runs the seed
**Files:** `agent-stream-config.ts` (AGENT_STREAM_EVENT_TYPES) · `hosted-avatar-agent-session-plan.ts:83-93` · `agent-autonomy-driver.ts:1361,1390`

The seed reads `events.agentId === entry.agentId`, and for a hosted avatar-agent `entry.agentId` is the avatar-agent's `platform_agents.id` verbatim (`hostedAvatarAgentId`, plan.ts:83). The whitelist leads with `cove.blackjack/baccarat/holdem/slots.*` + `land.service.sold` as "the money-bearing catch-up events." But (a) hosted autonomous agents **cannot generate any cove settlement** — they dead-end at the cove door (report 4), and (b) **connected/external agents, who DO settle cove, never run the wake-seed** — the driver only drives hosted `userAgents`/`houseAgents`; connected agents get continuity only if they themselves pull `/events/replay`. So the seed's headline money events are dead for the hosted population that consumes it, and the connected population that produces them has no auto-continuity at all. The continuity mechanism and the money-event whitelist are aimed at two disjoint populations.

### M2 — In-memory teacher talk-cooldowns are wiped on every deploy, defeating the teacher-diet cost bound
**Files:** `agent-autonomy-driver.ts:344,1242-1255,973`

`talkCooldownUntil` is a private instance `Map` (driver 344), so every per-`(agent,building)` 1-hour teacher-turn cooldown is lost on process restart. After each deploy every cooldown reads as expired, so a fresh wave of teacher-turn LLM inference fires immediately for every enrolled agent. Money/leaderboard are still protected by DB daily caps (`creditBuildingRewardOncePerDay`, `agent.chat.turn` cap 50/day), but the **inference spend** that the "Staging Cost — Teacher Diet" work exists to bound is not — frequent deploys multiply teacher-turn LLM calls. Persist the cooldown (or derive it from the existing DB `building.visited` / `agent.chat.turn` rows) so it survives restart.

---

## LOW / observation

### L1 — `directive.set` event keying is fragile for multi-bot users
**File:** `routes/avatars.ts:1304-1315,1394-1411`

`directive.set` is logged with `agentId = resolveConnectedAgentId(user.id)` = the **most-recently-seen** `agentBots` row for the user. For a hosted-only user this equals `platformAgentId` (consistent). But a user who also has a separately-connected external bot seen more recently keys `directive.set` under the external agent's id, while the hosted autonomy machinery keys everything else under `platformAgentId`. Latent today (the seed doesn't read `directive.set`), but "most-recent bot wins" is an id-mismatch waiting to matter for replay/attribution.

---

## Checked and clean (no NEW defect)

- **Earned-skill lesson write/read is id-symmetric.** `recordEarnedSkillMemory` and `searchEarnedSkillMemories` both derive `roomId = generateRoomId(config.agentId, "earned-skill:"+avatarId)` and the same `entityId` (eliza-runtime.ts:752-757 / 822-824); the keyword fallback is likewise avatar-keyed with the same `subtype:'earned-skill'` filter (earned-skill-memory.ts:129-142/190-199). No write-to-unread-id bug. This closes the exact id-mismatch class the task flagged for the lesson path.
- **Hosted-autonomy `building.visited` / `agent.chat.turn` match the seed key.** Both are emitted with `agentId = entry.agentId = platformAgentId` (world-teacher-chat.ts:312-327/391-399 via driver 927/1001), so the agent's OWN visits/chats DO surface in a later restart's wake-seed.
- **Protocol/orientation "stale character config" has no live window.** Re-injection only runs on runtime start (orchestrator 258-259), but any `PROTOCOL_VERSION`/orientation change ships via a deploy = full API process restart = all in-process runtimes cold → fresh injection on lazy re-warm. No practical stale-manual window for hosted runtimes.
- **Provisioning-pending self-repairs on the web path.** A signup whose `provisionAvatarAgentForSignup` throws lands the account in `agent-provisioning-pending`, but the web client always routes to `/create-agent`, which calls the authed `provisionAvatarAgent` and creates the agent+avatar (avatars.ts:301-325). Only a programmatic API signup that never follows to `/create-agent` stays stuck — an API-consumer edge (consistent with report 2's fail-soft note).
- **In-memory directive preemption is sound.** The walk/linger interrupt (driver 895-900) falls through into the deciding branch in the same call; a second directive arriving mid-`decide()` is caught by the `inFlight` guard + the single post-cycle follow-up (driver 656-667); `directivePending` is consumed in the deciding branch (1033) and never silently dropped within a process.
