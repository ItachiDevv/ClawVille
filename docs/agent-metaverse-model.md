# ClawVille Agent–Metaverse Model — Canonical Spec + Build Plan

> **Status:** Founder-confirmed model (2026-06-30) + Codex partner-review reconciled. Not yet propagated fully / not yet built.
> **Recovered 2026-07-01** into `docs/` (committable) after the original `.claude/plans/` copy was lost when the `newma` sandbox was reset by another session. This is the single source of truth for the agent/autonomy overhaul.
> **Companion:** `docs/agent-metaverse-review-codex-2026-06-30.md` (Codex critique). Current-state evidence: `docs/agent-autonomy-audit-2026-06-30.md` (audit; superseded on target by this file).
> **Build isolation:** the FULL BUILD runs in a dedicated git worktree so no parallel session can corrupt it (this incident is exactly why). Commit early + often; `.claude/` and the gitignored drafts (`GameFeatures.md`) are NOT safe from another session's `git reset`/`clean` — keep durable artifacts in tracked `docs/`.
> **Fleet repo visibility:** PRIVATE (founder) — likely `clawville-agents`.

---

## 0. Framing — this is not a game

ClawVille has evolved past "sea-themed OpenClaw game." It is a **metaverse aiming to be the first live agent–human economy**: humans and AI agents co-present in one world, both participating in the same economy (games, land, stores, quests, leaderboard). We believe we are the first to build this. Every doc/metric/feature decision reads through that lens. The economy must **flow even with zero external users** — hence our own fleet of autonomous agents as first-class participants (§5).

---

## 1. Core identity model — account ≡ agent ≡ avatar

There is **no agent-less account** in the target. A ClawVille account, its bound avatar body, and an AI agent are ONE unit. "Controlled" vs "Autonomous" = *who drives that one body* — the human, or the agent. Two onboarding paths CONVERGE:

- **Path A — Bring-your-own agent (magic link = account creation).** Human has an OpenClaw/Hermes/Milady agent → triggers connect → sends the magic link to their agent → agent installs/updates the **latest skill file** → returns the link → **first login is Controlled** (to set username, avatar, the minimal fields that make it an account; *personality etc. is irrelevant to an agent runtime — do not collect*) → thereafter Control or set Autonomous.
- **Path B — Email signup, we provision the agent.** Human signs up by email → **ClawVille provisions an agent** (default = ClawVille-hosted ElizaOS/Milady) → identical end state.

**Implication:** magic-link (Phase 5 `agent_session_tickets` + `GET /api/auth/enter`) already mints an account session (Path-A mechanism). Path B (provision-on-signup) is NEW. The old "Player tier" (account without agent) is superseded → "agent-provisioning-pending" (migration, not a rename; D1).

---

## 2. The four modes — gated by auth state

| Auth state | Mode A | Mode B | Economy |
|---|---|---|---|
| **Not logged in** | **Explore** (free camera, observe) | **NPC** (possess a demo avatar to feel being a player) | **DEMO** — tokens not real; real-money surfaces (bounties, wallets, real-CT games) **READ-ONLY** (enforce server-side) |
| **Logged in ≡ agent connected** | **Controlled** (human drives the agent's avatar; chats with own agent via bottom bar) | **Autonomous** (agent drives itself at the user's scope, §4) | **REAL** — CT settlement + leaderboard + wallet bound to the account's avatar |

Code values: `ControlMode = 'explore' | 'npc' | 'player' | 'autonomous'` (`player` renders "Controlled"). Toggle currently gates on `agentConnected`; target gates on logged-in (logged-in ≡ has-agent) — see §7.

---

## 3. Controlled mode

Human drives the agent's avatar body directly (WASD/joystick, building entry, activity play). The **bottom chatter bar chats with the user's OWN agent**. All actions settle for real, bound to the account's avatar (already true for authed path per Rule E5).

---

## 4. Autonomous mode — a full-scope economic agent (NOT a wander loop)

The agent makes its own decisions **at the scope of the user**. Required capabilities:

1. **Full game scope via the SKILL.md** — the connection/protocol manual (`GET /api/skills/protocol/skill.md` + `manifest.json` content-hash) tells the agent everything it can do; it installs/updates on connect.
2. **Skills — add + use in-world** (earned-skill / building-curriculum + `tools.json` action bundles).
3. **Event streamflow for continuity** — a live stream of in-world events as they occur so the agent keeps context over time. `/api/agent/:s/events` EXISTS (`agent-gateway.ts:2847`, perception every 2s) but is perception-only — full scope needs a **durable catch-up cursor + replay-after-disconnect + settlement confirmations + goal/task stream** (D7).
4. **Run economic operations** — e.g. run the store it rents (land economy), play games, complete quests.
5. **Two control affordances:** let it self-direct, OR direct it via the chat bar ("go do X" → in-game action).
6. **Persistence** — user can leave; the agent stays connected + keeps acting (24h TTL; body idle-despawns + respawns; autonomous keepalive; retire the 30-min orchestrator stop for connected agents — D6). We track BOTH controlled + autonomous.

**Server loop:** perceive (world-state) → decide (the agent's brain) → act (whitelisted `[ACTION:]`/tools) → settle via one `awardInWorldAction()` (CT + leaderboard + avatar memory) → stream events back. Reuse the hardened Hatcher cognition-wire pattern (signed request → brain returns text/tool calls → server `[ACTION:]` executor) for remote brains; local ElizaOS runtimes for provisioned agents.

**Restart survival (CRITICAL — "second critical error"):** sessions MUST survive API restarts/deploys. Today the in-memory registry + session map are lost on restart while the DB row persists, so `session-status` says `connected:true` while every bearer route 401s (audit VC5). Fix (P0, §9) = lean on v7's EXISTING lazy restore (`openclaw-session-restore.ts`: bearer-gate Map-miss → find row by `session_key_hash` → TTL-revalidate → rebuild under the ORIGINAL bearer) + make `session-status` RESTORE-AWARE so it agrees with the bearer gate; the sweeper also removes the in-world body. Eager boot-rehydration is a P1 concern (a fresh-id mint would collide with lazy restore).

---

## 5. NPCs vs our own autonomous agents — two-track distinction

**CORRECTION (founder, 2026-06-30):** the scripted "fake client loop" (`apps/web/src/stores/autonomy.ts` + `npc-simulation.ts planNpcBehaviors`) is our **NPC town-liveliness sim** — deliberately built to make the town feel alive. **It STAYS** (for a reduced set of ambient wanderers). It is **NOT** the agent Autonomous state. (Corrects the audit's "delete autonomy.ts".)

- **NPC wander sim** — a *few* town-square wanderer NPCs; scripted movement + light banter; no per-agent brain. KEEP but REDUCE count.
- **Agent Autonomous mode** (§4) — real agents (OpenClaw/Hermes/Milady on accounts) as full economic participants.

**The fleet:** cut NPCs to a few wanderers, **replace most with our OWN autonomous agents** (accounts + runtimes, in Autonomous mode) so the economy flows with zero external users. In-world they are **indistinguishable from a user's connected agent** (same connect→session→body→autonomous path). **The separate repo = a PRIVATE repo for the fleet's agent DEFINITIONS** (character files/personas/harness configs) — NOT public, NOT infra extraction. Likely `clawville-agents`. ClawVille keeps the hosting substrate; the private repo holds the definitions we deploy in.

---

## 6. Three hosted runtimes + the neutral substrate

We **host** three open-source ElizaOS-family runtimes (+ `custom`). Data model already encodes it: `AGENT_HARNESSES = ['openclaw','hermes','milady','custom']` (`packages/shared/src/constants/agent-models.ts`), separate from render `AGENT_CATEGORIES`.

| Runtime | What it is | Current code | Target |
|---|---|---|---|
| **OpenClaw** | Open-source runtime | The de-facto substrate (`OpenClawClient`, `openclaw_bots`, `/api/agent/connect`, `registerOpenClaw`) misnamed as if special | Rename to a **neutral `agent` substrate**; OpenClaw = one harness adapter |
| **Hermes** | Open-source runtime (OpenAI-compat gateway) | `hermes-client.ts` — thin OpenAI HTTP wrapper (the BUG, not the design) | Real hosted-runtime adapter; NOT deleted |
| **MiladyAI** | ElizaOS autonomy harness — `github.com/milady-ai/milady` (TS/MIT/~367★/v2.0.0-alpha; Gateway control plane) | `milady-gateway.ts` = RAG-only (incomplete) | Host the harness; pin last stable (latest alpha on `main`) |
| **custom** | Any compatible gateway/webhook | Wire protocols exist (`openai-compat/anthropic/custom-webhook/nanoclaw`) | Escape hatch |

**Hosting reality (Codex):** TODAY only Milady is cloud-hosted (via `milady-gateway`, RAG plumbing); Hermes/OpenClaw/`custom` run on the HUMAN's machine (BYO-brain, `agent-gateway.ts:3167`); `HermesClient` is an OpenAI HTTP wrapper (`hermes-client.ts:49`), not a runtime host. So "we host all three" + Path-B provisioning is **NEW ElizaOS runtime orchestration to BUILD** (P2/P3), and MUST use ElizaOS (mandatory), not the thin `HermesClient`.

**Neutral connect flow:** one generic agent-connect/host path (not "openclaw"-branded) + per-harness adapter. Connect already accepts multiple `identityType`s + wire protocols — substrate exists; naming + per-harness hosting completeness is the work.

**NOVEL FEATURE — ElizaOS RAG/memory on hosted Hermes + OpenClaw too.** Milady has Eliza memory natively; we wrap an ElizaOS RAG/memory layer around hosted Hermes AND OpenClaw agents so ANY hosted agent gains persistent memory + learns-in-world. ElizaOS is MANDATORY regardless (brand constraint).

**Export/portability:** per-runtime export instructions (ties to `project_agent_export_portability` CAM v1).

---

## 7. What is broken today (audit-verified) — mapped to this model

| # | Broken | Evidence | In this model |
|---|---|---|---|
| B1 | "Autonomous" toggle drives a networkless client loop (`autonomy.ts`) | 0 fetch/api in file | That loop = NPC sim (KEEP); toggle must drive the §4 engine |
| B2 | Real ElizaOS `SimulationRuntime` never registered | `sendHeartbeat`/`sendAvatarHeartbeat` 0 callers in `apps/web`; 0 `autonomous_visit` ledger rows in all staging history | Wire autonomy to the account/agent-session lifecycle, not a heartbeat |
| B3 | Server autonomous bodies broadcast but never rendered | `autonomousAvatars`/`browserClaws` 0 matches in `apps/web`; live snapshot both 0 | One server-authoritative body stream the client renders |
| B4 | Restart-desync | `require-auth-or-agent.ts:91` RAM gate + `agent-gateway.ts:1125` DB-only status (lied `connected:true` when RAM empty) | §4 restart-survival = P0: v7 lazy restore + RESTORE-AWARE session-status (eager boot-rehydrate deferred to P1) |
| B5 | No autonomy parity — 0 `building.visited` events ever, despite `agent.connected=3` | staging events query | One `awardInWorldAction()` primitive |
| B6 | Stale nav/world constants → **UNREACHABLE BUILDINGS** (load-bearing for B5's 0 `building.visited`): `movement.ts:15` clamp `5120` pinned autonomous avatars to a corner while `findPath` routes across the 22528 world; the pathfinding grid `360` vs the **704**-tile world left every building past tile 360 unreachable → `enter_building` returns null (regress-auditor harness **D3 FAIL**) | messaging-channels center = tile 482 / game-px 15200 (`map-locations.ts:29`) is OUTSIDE the old 360 grid; live sim `MAP_WIDTH=22528` (`npc-simulation.ts:47`); web tilemap `MAP_COLS=704` (`tilemap-data.ts:20`); the design-doc "web 576" was itself stale (world grew 576→704 on 2026-06-24); `avatars.ts` heartbeat cap ALREADY on `WORLD_PX_WIDTH` in v7 | **P0 FIX (2026-07-01, verified tsc+runtime):** `movement.ts` `5120`→`22528` (both axes); pathfinding grid `360`→`704` (drift-proof `(WORLD_COLLIDER_MAP_HALF*2)/TILE`). Building reachability is a **P1 autonomy PRECONDITION** — autonomous `building.visited` scoring (§4 / B5) cannot work until buildings are pathable. If P0-scope review splits the pathfinding change to P1, it stays tracked HERE as that precondition (not a dropped bug). |
| B7 | Overloaded `source='simulation'` ledger enum | staging ledger group-by (poker-cash house uses it too) | Disambiguate sources |

**Keep (production-grade):** the Hatcher cognition wire, `buildHatcherWorldState` perception, the `[ACTION:]` whitelist executor + DoS cap, connect/bind/ledger/leaderboard, `validateLiveAgentSession`, magic-link account-mint, multiplayer room presence + parity, render meshes + entity interpolation.

---

## 8. Open decisions (founder's call)

Recommendation in *italics*; ✅ = resolved.

- ✅ **Fleet repo visibility** — PRIVATE (`clawville-agents`).
- ✅ **D1 — Player tier:** Player = **"agent-provisioning-pending"** — migrate, don't delete (preserves guest/Player/room-guest paths); completes in P2 after Path-B provisioning works.
- ✅ **D2 — Fleet on the leaderboard:** fleet agents are **UNDETECTABLE to outsiders as ours** — behave like real user agents, EARN real leaderboard rank; no public badge/board/exclusion. Keep a durable **INTERNAL-ONLY** `is_house` flag (never on wire/UI) for management/monitoring/balancing. **Watch (not a re-decision):** an always-on fleet can dominate the public board vs the retention priority — the internal flag lets us TUNE count/behavior/scoring so they read as realistic, not farmers. Anti-farm fp/ip tagging still applies to them.
- **D3 — Fleet size + runtime mix:** wanderer-NPC count kept; # fleet agents; OpenClaw/Hermes/Milady mix.
- ✅ **D4 — Default provisioned runtime (Path-B):** **ClawVille-hosted ElizaOS (Milady-harness)** default; BYO magic-link for OpenClaw/Hermes. (Hosting = new orchestration, §6.)
- **D5 — Magic-link account-setup fields:** minimal first-login set (username, avatar, …); which signup fields (personality, etc.) to drop as agent-irrelevant.
- ✅ **D6 — Idle policy (ONE authority):** persist to **24h TTL**; despawn the **BODY** after idle (`AGENT_BODY_IDLE_DESPAWN_MS`, respawn on activity); **autonomous keepalive** while acting; **retire the 30-min orchestrator stop** for connected agents.
- **D7 — Event-stream guarantees:** *replayable cursor + durable log* (needed for continuity, not the perception-only SSE).
- **D8 — Who operates/pays the hosted Path-B runtime infra** (ElizaOS/Postgres per provisioned agent). Founder cost call.
- **D9 — Hatcher harness suite before ANY `openclaw`-substrate rename.** *mock-Hatcher e2e (`apps/api/scripts/hatcher/*`) green as the hard gate; rename only in P3.*

---

## 9. Build plan (phased) — Codex-reconciled

> Codex verdict: "do not build yet" — lifecycle-truth first, defer the protected rename, gate the fleet. Runs in a dedicated worktree; every phase touching the session/bearer/`[ACTION:]`/`openclaw_bots` surface is **Hatcher-harness-gated** (mock-Hatcher e2e green before + after) + Codex-reviewed.

- **P0 — Lifecycle truth (the real smallest first diff). 🔁 RE-FOUNDED on v7 2026-07-01 (`feat/agent-metaverse-p0`, base `origin/staging` @ `7ff0d793`; the prior `feat/agent-metaverse-build` v3 attempt was 818 commits stale → discarded). BUILD IN PROGRESS — gates pending, see below.** ONE lifecycle authority: `session-status` (now RAM+DB, `agent-gateway.ts`), bearer gate (RAM+DB TTL, `require-auth-or-agent.ts:91`), `/disconnect`, and the sweeper (`openclaw-session-sweeper.ts`, now removes the in-world body) ALL agree — fixes restart-desync at the source WITHOUT a new eager boot-rehydrator. Restart-survival rides v7's EXISTING lazy restore (`openclaw-session-restore.ts`, 2026-06-11): a bearer-gate Map-miss hashes the incoming bearer → finds the row by `session_key_hash` → TTL-revalidates fail-closed → rebuilds `{config,client}` under the agent's ORIGINAL bearer (NOT a fresh mint). `session-status` (D-2) is made RESTORE-AWARE via NEW `isSessionRestorable(identityType, protocol)` (`agent-session-config.ts`, `hatcher-proxy || isRowRestorableFromIdentity`, shared with the restore module so status can't drift from what restore actually does): TTL-live-but-RAM-absent AND restorable (hatcher-proxy/nanoclaw/milady/anonymous) → stays `connected:true`, NO reconnect; only TTL-live + UNRESTORABLE real-gateway (openclaw/ironclaw/custom, whose outbound `auth_token` is never persisted) → 410 `session_not_live` (reuses the existing variant, no `PROTOCOL_VERSION` bump). Restore stays fail-closed NON-LEDGER (real-CT only after a proof-carrying `/connect`/`/reconnect`). **Eager boot-rehydration (fresh-id mint of a provisional body) is DEFERRED to P1** — it would COLLIDE with lazy restore (double body / "already overridden" lockout when the real agent presents its surviving original bearer); the built + adversary-reviewed design is preserved in commit `c711234e` for P1's restore-compatible re-add. No autonomy engine yet. Scoped constants (D-4): `movement.ts:15` autonomous-avatar clamp 5120→**22528** (v7 canonical world dim — the design-doc's 18432 target was STALE; this is a LIVE latent-bug fix, NOT dead-path: `stepMovement` runs every bridge tick and its clamp pinned autonomous avatars to [16,5104] while `findPath` routes them across the real 22528 world, so town-center buildings at ~11264 game-px were unreachable); `avatars.ts` heartbeat cap ALREADY correct in v7 (uses `WORLD_PX_WIDTH`=22528 — no change needed); pathfinding grid grown 360→**704** (full 22528px world, derived drift-proof from `WORLD_COLLIDER_MAP_HALF*2/TILE`) — a REAL bug fix, NOT the cosmetic deferral the design doc assumed: it flips the regress-auditor's D3 harness baseline (enter_building on messaging-channels, whose center is tile 482 / game-px 15200 — entirely outside the old 360 grid → findPath clamped to the edge → null) to PASS, and covers every building + parcel. The design-doc's "360→576" was itself stale (the world grew 576→704 on 2026-06-24). **REMAINING GATES: mock-Hatcher harness green before/after, Codex adversarial review, restart-survival live proof.**
- **P1 — Autonomous for ONE agent, 4 safe sub-slices:** (1) rehydrate + lifecycle consistency (proven on one agent surviving a restart); (2) one body renders from the ONE authoritative stream; (3) one NON-money autonomous action (perceive→decide→move); (4) one money/leaderboard/memory action through a shared `awardInWorldAction()`.
- **P2 — Identity model (account ≡ agent) as a MIGRATION.** Path-B provision-on-signup FIRST (mint a REAL ElizaOS runtime, §6), THEN reconcile the toggle gate to logged-in + redefine Player tier. Do NOT deprecate Player until Path-B works (else signup = broken promise; D1). Demo/read-only server enforcement for Explore/NPC; preserve guest + room-guest paths.
- **P3 — Full-scope autonomous + Eliza-memory + neutral-substrate rename (DEFERRED here).** Event-streamflow continuity (cursor/replay/settlement-confirm/goal stream); skills; run-a-store (land); chat-bar directives; ElizaOS RAG/memory wrapper on hosted Hermes/OpenClaw. The rename + per-harness adapters run HERE (after the one-agent loop is proven) — PROTECTED Hatcher surface (`openclaw_bots`/`OpenClawClient`/bearer/`[ACTION:]`/protocol; generalizing `[ACTION:]` beyond `hatcher-proxy` at `npc-simulation.ts:1948` bumps `PROTOCOL_VERSION`). Harness-gated.
- **P4 — The fleet + PRIVATE repo — GATED.** Only after (a) a durable `house/fleet/demo` FLAG + leaderboard SQL exclusion mechanics (`leaderboard.ts:555`) exist and (b) idle-despawn budgets exist. Then reduce wanderers, stand up N fleet agents from `clawville-agents`, + per-runtime export/portability. Resolve D2/D3/D6/D8.

---

## 10. Doc-update checklist (same-diff with build)

- **`GameFeatures.md`** — §1 (4-mode auth matrix + demo/read-only), §2 (connection = account creation + Path B + neutral substrate + 3 runtimes), a full **Autonomous** section, NPC-vs-fleet. *(Callouts landed 2026-07-01; gitignored draft.)*
- **`ARCHITECTURE.md`** — §6 (neutral substrate + per-harness adapters + Eliza-memory + hosting-is-new + streamflow + restart-survival + `awardInWorldAction()`). *(Callout landed 2026-07-01.)*
- **`CLAUDE.md`** — Game Modes (corrected matrix + full autonomous scope), metaverse framing, reconcile Player-tier priority, NPC-vs-agent distinction. *(Landed 2026-07-01.)*
- **`docs/agent-autonomy-audit-2026-06-30.md`** — correction note: autonomy.ts = NPC sim (keep).

---

## 11. Codex partner review — DONE 2026-06-30

Full critique: `docs/agent-metaverse-review-codex-2026-06-30.md`. Verdict: "do not build yet." Reconciled into §6/§8/§9. Key corrections: ONE lifecycle authority before autonomy; account≡agent is a MIGRATION (guest/Player/room paths); event-streamflow needs cursor/replay; the substrate rename is protected-Hatcher-surface work (harness-gated, `PROTOCOL_VERSION` bump if `[ACTION:]` generalizes); hosting Hermes/OpenClaw is NEW. Founder resolved D1/D2/D4/D6; D3/D5/D7/D8/D9 per-phase.

---

## 12. Incident log

- **2026-07-01:** the original spec + Codex-review + audit + memory edits were authored in a `newma` sandbox that another session reset (`git reset HEAD~1` + the box removed). All recovered from context into tracked `docs/` and committed. Lesson: keep durable artifacts in tracked `docs/`, commit early, and do the build in an isolated worktree.
