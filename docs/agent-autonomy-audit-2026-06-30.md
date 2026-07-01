# ClawVille Autonomous Agent / NPC Audit — Synthesis (recovered)

> **CORRECTION (2026-06-30, founder):** the audit's original recommendation to DELETE `apps/web/src/stores/autonomy.ts` is **RETRACTED**. That scripted client loop is the **NPC town-liveliness sim** and STAYS (for a reduced set of ambient wanderer NPCs). It is NOT the agent-Autonomous engine (the real, broken thing this audit found). The corrected target model + build plan supersede this audit's recommendations: **`docs/agent-metaverse-model.md`** (+ Codex review `docs/agent-metaverse-review-codex-2026-06-30.md`). This doc remains valid as the current-state EVIDENCE.
>
> **Recovered 2026-07-01** (condensed) after the original 74KB synthesis was lost when the `newma` sandbox was reset. The unique, empirically-verified content — the live staging verification below — is reproduced in full. The system-map/defect detail is captured in `docs/agent-metaverse-model.md §5–§7`.

Produced by a 10-agent static audit workflow (8 subsystem auditors + integration trace + synthesis), then verified live against staging (read-only).

## 1. Executive summary

- **Biggest reason "autonomous" doesn't work:** the user-reachable toggle drives a FAKE engine, and the REAL engine is unreachable. Flipping to "Autonomous" starts a client-only scripted loop (`apps/web/src/stores/autonomy.ts`) — proximity + `Math.random()` goal scorer emitting canned `BUILDING_THOUGHTS`, ZERO network/ElizaOS/LLM/CT/leaderboard. **[Founder correction: that loop is the NPC town-liveliness sim — keep it for NPCs; it is NOT the agent-Autonomous engine.]**
- The real ElizaOS engine (`AvatarSimulationBridge` + `SimulationRuntime`) has **no live registration source**: the only trigger is `POST /api/avatars/me/heartbeat`, and the two web wrappers `api.sendHeartbeat`/`api.sendAvatarHeartbeat` have **zero callers in `apps/web`**. The store stays empty; the planner has effectively never run.
- Even if it ran, nobody would see it: the server broadcasts `snapshot.autonomousAvatars`/`browserClaws`, but the client consumes only `snapshot.npcs` — a repo-wide grep of `apps/web` for those two field names returns **0 matches**.
- Connected agents (the "every NPC = real agent" model) have **no goal-directed cognition loop**; the only autonomous brain call is a side-effect of random small-talk pairing; movement uses the scripted `planNpcBehaviors`; `[ACTION:]` tags execute only for `hatcher-proxy` and even those movement verbs are dead-on-arrival (emitted while `inConversation`, which `moveNpcs` skips, then path-wiped).
- Autonomy and economy are mutually exclusive today: full parity (CT + leaderboard + memory) fires ONLY on the authenticated self-driven REST/tool path — i.e. exactly when the agent is NOT being driven autonomously.
- The lifecycle layer silently zombifies agents: the 24h sweeper stops the Eliza runtime but never removes the in-world body; after any restart, bodies/sessions (RAM-only) vanish but `GET /session-status` still reports `connected:true` from the DB row while every bearer route 401/404s. **Most likely concrete cause of "autonomous agents not functioning."**
- Cohesion problem: 5+ parallel agent/NPC systems with no shared abstraction.
- Headline recommendation: collapse into ONE agent abstraction (provisioned brain → session → bound avatar/body → server perceive→decide→act tick → generalized `[ACTION:]` executor → atomic CT/event/memory parity). Keep the Hatcher cognition wire + `[ACTION:]` executor. Full target: `docs/agent-metaverse-model.md`.

## 2. Live Verification Results — 2026-06-30 (staging `api-staging.clawville.world` + its dedicated Supabase DB)

Static findings checked against running code + the live staging server + the staging DB (read-only).

### Code-certain (the path literally cannot fire — no env needed)
- **VC1 ✅ Heartbeat never sent.** `api.sendHeartbeat`/`api.sendAvatarHeartbeat` defined (`apps/web/src/lib/api.ts:395,579`) with **zero call sites** in `apps/web`.
- **VC2 ✅ Server autonomous feeds unread.** `autonomousAvatars`/`browserClaws` → **0 matches** in `apps/web`.
- **VC3 ✅ The toggle engine is networkless.** `apps/web/src/stores/autonomy.ts` has **0** `fetch`/`honoRequest`/`/api/`/`EventSource`.
- **VC4 ✅ Connected agents bypass the user-avatar bridge.** `bridge.register`/`avatarAutonomyManager` appear ONLY in `apps/api/src/routes/avatars.ts` (the dead heartbeat path).
- **VC5 ✅ Restart-desync is structurally inevitable.** Bearer gate `validateLiveAgentSession` requires the in-memory `npcSimulation.isValidAgentSession` (`require-auth-or-agent.ts:94`); `registerOpenClaw` is called only at connect/reconnect (no boot rehydration); `session-status` reads the DB row (`agent-gateway.ts:1125`). After any API restart: in-memory registry empty → every bearer route 401, while `session-status` returns `connected:true` on the still-future 24h TTL.

### Live staging (running server + DB, all history)
- **VC6 ✅ Live snapshot** (`GET /api/npc/state`): `autonomousAvatars: 0`, `browserClaws: 0`. Only **15 scripted NPCs** alive (7 walking, 6 idle, 2 socializing) in the 18432 world (e.g. Miu at x≈10642). `GET /api/openclaw/active` = `{"bots":[]}`.
- **VC7 ✅ Ledger — the autonomous engine has never credited CT.** Across all **82** `claw_token_transactions`, **zero rows with `reason='autonomous_visit'`**. (A naïve `source='simulation'` filter returns 70 rows, but those are all poker-cash house mechanics — the `source` enum value `'simulation'` is overloaded.)
- **VC8 ✅ Events — no in-world building visit has ever scored.** Across all logged events there are **zero `building.visited`** rows, despite `agent.connected => 3` (+ `agent.session.expired => 2`, `agent.session.disconnected => 1`, `portal.hatcher.crossed => 1`). Live confirmation of the Rule E5 parity gap.
- **VC9 ✅ Session lifecycle.** `openclaw_bots` = **3 rows, 0 with a live TTL** — every historical agent session already expired.

### Not live-demonstrated (code-certain; would need a disruptive repro)
- Restart-desync end-to-end (needs connecting a fresh agent + restarting the staging API container; no current live session to demo against).
- Hatcher cognition webhook returning `[ACTION:]` tags (partner-side; `portal.hatcher.crossed=1` shows the path exercised once).

**Verdict:** the autonomous engine has provably never run in staging (0 `autonomous_visit` ledger rows, 0 `building.visited` events, empty autonomous SSE feeds on the live server); the visible toggle is a networkless client script (the NPC sim); the restart-desync is structurally guaranteed.

## 3. Target (supersedes this audit's recommendations)

See **`docs/agent-metaverse-model.md`** — account≡agent metaverse, 4-mode auth matrix, full-scope Autonomous, 3 hosted ElizaOS runtimes on a neutral substrate + Eliza-memory layer, keep-few-NPCs + replace-most-with-a-private-fleet, Codex-reconciled P0–P4 build plan (lifecycle-truth first).
