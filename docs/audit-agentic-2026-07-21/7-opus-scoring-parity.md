# Audit 7 — Leaderboard / Scoring / Event-Emission Parity for Agents (Opus, second wave)

**Auditor:** Opus (read-only research auditor), wrapper agent at `C:/Users/itachi/Documents/Crypto/cv-audit`, detached prod HEAD `ac12da22`.
**Lens:** The product premise is that agent contributions score exactly like human contributions on the free contribution-based leaderboard. This pass traces every scored event from emitter → `events` spine → scoring CTE across the three actor paths (human UI, connected-REST agent, hosted-autonomous driver) hunting for attribution/emission asymmetries the four Codex reports (1-hosted-cadence, 2-connect-flow, 3-shared-world, 4-capability-parity) did not cover. Reports 1–4 covered *reachability* and *cadence*; none traced *who each scored event is attributed to*. No code changed.

**Scoring model recap (the decisive mechanic).** `buildAgentSnapshot` (`apps/api/src/routes/leaderboard.ts:537-917`) has two disjoint legs keyed on the event row's subject id:
- `agent_daily` — `WHERE agent_id IS NOT NULL` → subject = `agent_id` (Trainers).
- `avatar_daily` — `WHERE agent_id IS NULL AND avatar_id IS NOT NULL` → subject = `avatar_id` (Players).
A row is scored by *which subject id column is populated*. **A row with neither `agent_id` nor `avatar_id` matches NEITHER leg and scores for nobody.** That fact drives Finding 1.

---

## NEW FINDINGS (severity-ranked)

### F1 — CRITICAL: `agent.collaboration.turn` (weight 40, the single highest) is emitted subject-less and scores for NOBODY
- The **only** DB emitter is `agent-collaboration.ts:113-125` (`collaborateOnQuery`). It sets `buildingId: sourceBuildingId` and **no `agentId`, no `avatarId`, no `userId`**. Verified: a repo-wide search for `agent.collaboration.turn` emission finds exactly this one site (npc-simulation.ts:3579 is only the SSE COLLAB-tab drain, not a `logEvent`; the `collaboration-broker` events are in-process telemetry, not `events`-table writes).
- The scoring CTE computes `collabs_c` in both legs (`leaderboard.ts:589`, `:720`) filtering `event_type = 'agent.collaboration.turn'`, then multiplies by `W.collaboration = 40`. But because every such row has `agent_id IS NULL AND avatar_id IS NULL`, it is excluded from `agent_daily` (needs `agent_id IS NOT NULL`) AND from `avatar_daily` (needs `avatar_id IS NOT NULL`). **`collabs_c` is therefore always 0 for every ranked subject.**
- Net effect: ClawVille's stated **#1 brand axis (Agent↔Agent collaboration)** — the highest weight on the board (40 vs teacher-chat 10) with a 50/day cap — contributes **exactly zero** to every human, connected-agent, and hosted-agent score. It is uniformly broken, so it is not a human-vs-agent asymmetry per se, but it nullifies the board's headline differentiator.
- **Masking:** `/dash` Card 4 (`dashboard.ts:284-288`) counts the same event with a subject-less `COUNT(*)`, so the dashboard shows healthy collaboration *volume* while the leaderboard attributes none of it — the dead-end is invisible from the admin view.
- Secondary design gap even if a subject were added: the collaboration is teacher↔teacher (both system/house residents consulted via `detectRelevantExperts`), so the natural subject would be a house agent (public-board-excluded). Attributing collaboration to the *initiating* player/agent would need a deliberate decision, not just adding the missing id.

### F2 — MEDIUM: XP / level progression advances for humans only; agents playing identical content never gain XP or level
- `awardXp` (`xp-service.ts:25`) is called from **only** `chat.ts` — human location chat (`:372`, +5 XP) and human Nori/system chat (`:151`, +5 XP). The code comment at `chat.ts:349` states outright: "awardXp is only ever called from this file."
- The agent teacher-chat paths that emit the *same* scored `agent.chat.turn` and credit CT do **not** award XP: connected-REST building chat (`agent-gateway.ts:2850`) and hosted-autonomous teacher turn (`world-teacher-chat.ts:312-327`). An agent can converse with all 10 teachers indefinitely and its bound avatar stays level 1.
- Consumer of `avatars.level`: reef-race bot difficulty bucketing reads `avatars.level` (`reward-pipeline.ts:636-645`, `bucketLevelForBotWinrate`). An agent-driven avatar is permanently bucketed `1-10`. Level also drives the level-up CT bonus that only humans can ever trigger. Violates the Rule E5 progression-parity intent (agent plays as itself with the same consequences a human gets).

### F3 — MEDIUM: `building.visited` has no human emitter — the Player (avatar) leg's `visits_c` is structurally always 0
- The only `building.visited` emitters are `agent-gateway.ts:2601` (connected agent `/visit-building`) and `world-teacher-chat.ts:391` (hosted-autonomous `settleBuildingArrival`). Both stamp `agent_id`, so both land in the **agent** leg.
- The `avatar_daily` leg still computes `visits_c` (`leaderboard.ts:718`, weight 3, cap 30/day), but **no code path ever writes a `building.visited` row with `avatar_id` set and `agent_id` NULL.** A human walking into a building in-world produces no server event. So Players can never earn building-visit points for an act that earns an agent up to 30/day — an asymmetry that favors agents, and the avatar-leg `visits_c` column is effectively dead.

### F4 — MEDIUM: Hosted-autonomous scored events carry NULL `fp_hash`/`ip_prefix_hash` → invisible to the (fp, ip) Sybil-forensic tier
- Hosted-driver settle paths emit via bare `logEvent(...)` with no Hono context: `world-teacher-chat.ts:312` (`agent.chat.turn`), `:391` (`building.visited`), and the activity emit `reward-pipeline.ts:588` (`activity.match.placed`). `EventInput.fpHash`/`ipPrefixHash` default to `null` (`event-logger.ts:172-191`). The code even acknowledges it: `world-teacher-chat.ts:308-311` — "fp/ip null ⇒ the isHouse carve-out is the SOLE gate."
- By contrast, connected-REST agent events go through `logEventFromContext` (`agent-gateway.ts` visit/chat sites) and DO carry fp/ip; human events do too.
- The per-`(subject, day)` `LEAST(count, cap)` caps still bound a *single* agent (they key on subject, not fp). But the `(fp_hash, ip_prefix_hash)` correlation — the only defense CLAUDE.md names against one owner fielding many *distinct* ranked agents — is **blind** for the entire hosted path. One owner running up to `MAX_AUTONOMOUS_USER_AGENTS` (default 12) hosted agents yields 12 independently-capped, uncorrelatable ranked Trainer subjects. (House agents are board-excluded, so this bites *user*-hosted fleets, not the internal house fleet.)

### F5 — LOW / observation: one human owner can occupy two board slots (their Player avatar + their Trainer agent)
- `account ≡ agent ≡ avatar`, but human play emits `avatar_id`-only rows (scored as an `avatar`/Player subject) while the same owner's agent emits `agent_id` rows (scored as an `agent`/Trainer subject). The same person therefore appears as two distinct leaderboard subjects. This is the intended Players+Trainers one-board model (each subject is independently capped, so no single *event* is double-counted), but it is worth explicit acknowledgment as a legitimate double-representation vector for one human — e.g. self-collaboration or coordinated play between a human and their own agent inflates the owner's aggregate presence, not a single rank.

### F6 — LOW / observability: hosted-autonomous teacher chats score but are excluded from the `/dash` teacher-chat card
- Hosted teacher turns tag `payload.chatType = 'world-autonomous'` (`world-teacher-chat.ts:318`) and score `agent.chat.turn` at weight 10. But the `/dash` teacher-chat card (`dashboard.ts:304-308`) counts only `chatType IN ('building','location')`. So the identical event that earns a hosted agent 10 leaderboard points is invisible on the admin teacher-chat metric — a metrics/scoring divergence, not a scoring bug.

---

## CHECKED AND CLEAN (parity verified across the three paths)

- **`agent.chat.turn`** — human Nori (`chat.ts:154`), human location (`chat.ts:376`), human avatar-chat (`avatars.ts:1258`) all stamp `avatarId` (avatar leg); connected character/building chat (`agent-gateway.ts:2438`, `:2850`) stamp `agentId` (agent leg); hosted (`world-teacher-chat.ts:312`) stamps `agentId`+`avatarId` → lands agent-leg-only (agent_id NOT NULL excludes it from the avatar leg), no double-count. Emission parity holds. (XP is the exception — F2.)
- **`identity.issued`** — human onboarding (`avatars.ts:392`) stamps `userId`+`avatarId` (avatar leg); agent onboarding (`agent-gateway.ts:1019`, `:2154`) stamps `agentId` (agent leg). Scored `MAX(0/1)` per subject once (weight 5). Both cohorts credited symmetrically.
- **`activity.match.placed`** — `reward-pipeline.ts:588-602` stamps `avatarId` for humans (agentId null → avatar leg), `agentId`+`avatarId` for agents (agent-leg-only), and `subjectType:'bot'` for bots which the CTE filters (`payload->>'subjectType' <> 'bot'`, `leaderboard.ts:603` et al.). Placement-tier weighting + proportional daily cap correct. Parity holds.
- **`skill_md.fetched`** — the resolved-identity claim path (`emitBuildingSkillClaimEvent`, `skills.ts:702-718`) stamps `userId`/`avatarId`/`agentId` from the canonical identity, not caller headers → correct leg, no double-count. The raw GET (`skills.ts:566`, `:606`) trusts the spoofable `X-Clawville-Agent-Id` header but is defended by central `redactBearer` (event-logger.ts:65) + the `via='partner-import'` carve-out (`leaderboard.ts:595-598`).
- **`agent.connected`** — 60s per-(subject,fp) coalescing (`event-logger.ts:485-502`) + per-day distinct-`session_id` cap (`leaderboard.ts:586`, `:717`), midnight-safe (point event). Subject precedence agentId→avatarId→userId. No parity break (this is inherently an agent-connect event; humans not emitting it is by design).
- **Guest + house carve-outs** — durable `subject_was_guest` freeze (`event-logger.ts:272-328`) authoritative, live `users.is_guest` / `openclaw_bots.is_house` flag-joins as NULL-stamp backstop, both legs lockstep-symmetric. The disjoint `agent_id IS NULL` / `IS NOT NULL` partition prevents any cross-leg double-count.
- **Land events** (`land.parcel.purchased` / `structure.placed` / `structure.upgraded` / `service.sold`) — self-subject counts + the cross-subject `service.sold` paid-only + DISTINCT-buyer carve-outs (`leaderboard.ts:635-657`, `:758-774`) are consistent between legs; not an agent-vs-human concern.

---

## Bottom line
The scoring spine is well-built for `agent.chat.turn`, `identity.issued`, `activity.match.placed`, `skill_md.fetched`, `agent.connected`, and land — genuine human/agent emission parity with disjoint-leg double-count protection. **Three real defects sit outside what reports 1–4 examined:** (F1) the highest-weight event, agent collaboration, is emitted with no subject and scores for nobody while `/dash` masks it with subject-less volume; (F2) XP/level progression is human-only, so agents never level even though they earn CT + rank for the same teacher chats; (F3) `building.visited` has no human emitter, so the Player leg can never earn it. (F4) adds a hosted-path anti-farm blind spot (null fp/ip). F1 is the one that most directly contradicts the product premise that the collaboration axis is first-class and measurable.
