# P1 — One Live Autonomous Agent (plan, plan-first, awaiting founder sign-off)

> Phase P1 of `docs/agent-metaverse-model.md §9`. Goal: prove the FULL autonomy loop — perceive → **decide (inference)** → act → settle → render — on **ONE** ClawVille-hosted agent, end-to-end, live. Builds ON P0's lifecycle floor. NOT the fleet (P4), NOT identity migration (P2), NOT the streamflow cursor (P3).
>
> Worktree: `cv-agent-p0`, branch `feat/agent-metaverse-p0` (P1 stacks on P0; ship P0+P1 together). Model: `gpt-4o-mini`, swappable backend (fleet → open/self-hosted later). Seam-map source: workflow `wf_ef15b3f3-8cd` (4 read-only readers).

## ★ Headline correction (from the seam-map — changes the whole shape of P1)

**The autonomy loop ALREADY EXISTS and works.** It is NOT a from-scratch build:
- `SimulationRuntime.planAvatarNextAction(userId)` (`packages/agent-runtime/src/simulation/simulation-runtime.ts:215`) = the **decide** phase: composes world-state → `useModel(TEXT_SMALL)` → parses a JSON action choice.
- `SimulationRuntime.dispatchAction()` (`:338`) = the **act** phase.
- `AvatarSimulationBridge.tick()` = the live perceive→decide→act cycle, driven every 200ms from `NpcSimulation` (`npc-simulation.ts:396`, `avatarAutonomyManager.tick()` `:1637`).
- Budget guardrails already exist: `budgetMaxNt` (100 CT/session), `budgetMaxPurchases`, `BehaviorCooldown` (~20s between LLM calls) in `avatar-state-store.ts:36-48`; enforced in `planAvatarNextAction` (`simulation-runtime.ts:252`).

**Why it's "dead" today:** the ONLY missing link is the *activation entry point*. `POST /api/avatars/me/heartbeat` (`avatars.ts:1012`) is what registers an avatar into the bridge — and it has **ZERO callers in `apps/web`**. The engine is built; nothing ever turns it on.

**So P1 = ACTIVATE the existing loop for one hosted "house" agent + adapt cadence/keying + 3 genuinely-new pieces** (proximity gate, `awardInWorldAction`, the render fix). Far smaller than "build the autonomy engine."

## The one agent
A **ClawVille-hosted ElizaOS "house" agent** — internal-only `is_house` flag, avatar-mode body (`ocb-<agentId>`, `avatarBodyId()` `npc-simulation.ts:582`), its ElizaRuntime warmed via `createElizaRuntime` (`eliza-runtime.ts:846`), inference on `gpt-4o-mini`. First member of the eventual fleet. (Hatcher is a partner integration, NOT this path.)

## Slices (with real edit points)

> **BUILD STATUS (2026-07-01) — Slices 1 + 3 BUILT (API, non-money loop).** Branch `feat/agent-metaverse-p0`. Slice 2 (client render) done by another teammate; Slice 4 (settle/leaderboard) DEFERRED — the agent earns NOTHING yet. See "What shipped" at the bottom.

### Slice 1 — lifecycle-consistency (mostly FREE via P0)  ✅ BUILT
Register the house agent's body + warm its runtime at **boot** (a seeder like `ensureSystemAgents`, or `agent-orchestrator.startAgent`), NOT via the dead heartbeat. P0 already guarantees it survives restart (lazy-restore + restore-aware session-status). `reuse` `registerOpenClaw` (`npc-simulation.ts:770`) + `agent-orchestrator` (skip the 30-min inactivity stop for `is_house`, like system agents).

### Slice 2 — render the body (bug B3 fix, ~1 change)
`apps/web/src/stores/npc.ts` `updateFromSnapshot` (`:383`) only processes `snapshot.npcs`, **never** `snapshot.autonomousAvatars` — so autonomous bodies arrive over the wire and are silently dropped. **Fix:** process `autonomousAvatars[]` there (map to `NpcSpriteState` w/ entity-interp `ts/tsDelta`), reusing the existing `VRMNpcMesh`/`GLBNpcMesh` render in `arena-npcs.tsx`. No new renderer. `extend`.

### Slice 3 — autonomous action + THE PROXIMITY GATE  ✅ BUILT
- **NEW `agent-autonomy-driver.ts`** (`build-new`): its own `setInterval` at **~30s** (not the 200ms NPC tick). Iterate active house agents (needs a public iterator over `session-agent-map`/orchestrator), `buildPerception(bodyId)` (`agent-gateway.ts:1931`, `reuse`) → decide via the SimulationRuntime pattern (agent-keyed variant of `planAvatarNextAction`) → dispatch. Fire-and-forget with in-flight tracking + LLM timeout so one slow brain can't block the tick.
- **First behavior:** perceive → decide "which teacher can help me" → `enter_building` (= *walk to* the building, `:1317`) → `talk_to_npc` (the real conversation).
- **NEW PROXIMITY GATE** (`build-new`) in `executeHatcherAction` `talk_to_npc` (`npc-simulation.ts:~1394`, before `injectAgentChat` `:1416`): resolve target pos (npc `this.npcs.get(target)` or `NPC_BUILDING_CENTERS[target]`) → `dist = hypot(dx,dy)` → if `dist > BUILDING_INTERACTION_RADIUS` drop + warn. **`BUILDING_INTERACTION_RADIUS = 1000 wu`** — ONE shared constant, replacing the ad-hoc `VISIT_RADIUS = 2000` on BOTH the authed visit-building path (`agent-gateway.ts:2244`) and this gate (harmonized, single source of truth). Units: **wu = game-space px** (1 tile = 32; world = 22528 wu). 1000 wu ≈ 2 building-widths (building zone = 448 wu) / ~½ the inter-building gap (~2000 wu) — clearly "at this teacher," slack for the 80 wu pathfind stand-off, no overlap with the neighbor. This is the anti-abuse backbone: **no walk/proximity → no interaction → no reward.** Applies to every agent (Hatcher, house, fleet) at the one server-side chokepoint.

### Slice 4 — settle (one economic action)
**NEW `awardInWorldAction(avatarId, actionType, amount, metadata)`** in `claw-token-ledger.ts` (`build-new`): (1) `creditClawTokens` (atomic, txn-locked), (2) post-commit `logEvent('world_teacher_chat', …)` (leaderboard, fire-and-forget), (3) `memoryService.createMemory` (the agent *learned* something). Add `world_teacher_chat` to `AGENT_SCORE_WEIGHTS` (`leaderboard.ts:370`) + a daily cap (fold into the fp/ip squash so it can't be farmed). **Gated on the proximity-passed interaction** — reward only fires for a genuinely-present, conversed turn. (Note: today `injectAgentChat` on the autonomous path fires NO reward — this wires the first real one.)

## Model backend (swappable — per the decision: mini now, open/self-host for the fleet)
- Default `gpt-4o-mini` via `openai-text-provider.ts` (base URL hardcoded `:37`).
- **Fleet swap is already largely supported:** `openclaw-provider.ts` (priority 100, `:102`) routes a per-agent config to ANY OpenAI-compatible gateway (`protocol='openai-compat'`) — point it at a self-hosted endpoint, per-agent, no global change. For a fleet-wide flip, add an `OPENAI_BASE_URL` env knob to `openai-text-provider` (`extend`, 1 line). So the open-model migration is config, not a rebuild — confirmed.

## Guardrails (mostly exist)
Budget (`budgetMaxNt`, exists) · decision cooldown (`BehaviorCooldown`, exists) · `[ACTION:]` DoS cap (`MAX_HATCHER_ACTIONS_PER_REPLY=4`, exists) · **NEW idle-throttle** (slow/pause the 30s tick when no humans are nearby — cost control) · **NEW proximity gate** (slice 3). One agent keeps cost ~$1–2/day.

## Verify (the proof — visible + on-ledger)
On staging, one house agent: boots → registers a body → **renders (you SEE it walk)** → every 30s decides → walks to a teacher (proximity-gated) → has a **real conversation** → the turn settles CT + leaderboard + memory → the first-ever `world_teacher_chat` / `building.visited` rows appear (currently **0** in all history). Browser-verify the walk + conversation; assert the ledger/events/leaderboard/memory rows.

## What shipped — Slices 1 + 3 (API, 2026-07-01)

Non-money perceive→decide→act loop for ONE ClawVille-hosted house agent. No CT, no leaderboard (slice 4 deferred).

- **is_house column** — `openclaw_bots.is_house BOOLEAN NOT NULL DEFAULT false` (`packages/database/src/schema/claws.ts`) + idempotent DDL `packages/database/migrations-manual/2026-07-01_add_openclaw_is_house.sql` (NOT db:push'd — orchestrator applies). Internal-only: NEVER serialized to any snapshot/roster/wire.
- **House-agent seeder** — `apps/api/src/services/house-agent-seeder.ts` (`ensureHouseAgent`), wired at boot in `index.ts` after the system-NPC seeder. Mirrors `ensureSystemAgents`: upserts the `openclaw_bots` row (is_house=true, `session_expires_at=NULL` so the 24h sweeper skips it), the `platform_agents` (openclaw-bot, NO gateway → gpt-4o-mini via openai-text-provider, provider-SWAPPABLE for the fleet) runtime warmed via `agentOrchestrator.startAgent(..., {isHouse:true})`, and the in-world avatar body via `npcSimulation.registerOpenClaw` with **protocol `nanoclaw` (NOT hatcher-proxy)**. Body renders via `snapshot.npcs` (the Hatcher-proven path), NOT autonomousAvatars.
- **Orchestrator exemption** — `RunningAgent.isHouse` + `startAgent(id, userId, {isHouse})`; `stopInactiveAgents` skips `type==='system-agent' || isHouse` (the driver drives via `useModel`, which does not bump `lastActivity`). Body-idle sweeper (`agent-body-idle-sweeper.ts`) also EXEMPTS is_house rows.
- **Autonomy driver** — NEW `apps/api/src/services/agent-autonomy-driver.ts` on its OWN 30s interval (NOT the 200ms tick). Per house agent: `npcSimulation.buildPerception(bodyId)` → `ElizaRuntime.decide` (gpt-4o-mini) → `npcSimulation.dispatchHatcherActions`. Phase machine deciding→walking→arrived→talking. In-flight guard + hard LLM timeout + idle-throttle (backs off when `getActiveHumanCount()===0`) + bounded maps. Wired start/stop into `index.ts` boot/shutdown.
- **Shared perception** — the former module-local `agent-gateway.ts buildPerception` MOVED to `npcSimulation.buildPerception(npcId)` (single source; gateway `/perception` + SSE `/events` + the driver all call it).
- **Proximity gate** — in `executeHatcherAction` `talk_to_npc` (before `injectAgentChat`): non-hatcher-proxy bodies must be within `BUILDING_INTERACTION_RADIUS` of the target or the talk is DROPPED (fail-closed). Hatcher (`hatcher-proxy`) stays exempt (§3a fast-follow). `BUILDING_INTERACTION_RADIUS = 1000` is ONE shared constant (`packages/shared/src/constants/npc-definitions.ts`) that ALSO replaced the ad-hoc `VISIT_RADIUS=2000` on the authed `visit-building` path.
- **decide()** — new `ElizaRuntime.decide(prompt)` (`useModel(TEXT_SMALL)`, provider-swappable) in `packages/agent-runtime/src/eliza-runtime.ts`.
- **Tests** — `apps/api/src/services/__tests__/agent-autonomy-p1.test.ts`: gate DROP-far / PASS-near / hatcher-exempt + driver picks-teacher-emits-enter_building. tsc 0; suite green (0 new failures vs baseline).

## Settled decisions (founder sign-off, 2026-07-01)
1. **Proximity radius = `BUILDING_INTERACTION_RADIUS = 1000 wu`** — ONE shared constant, replaces the ad-hoc `VISIT_RADIUS = 2000` on both the authed visit path AND the new gate. (wu = game-space px; 1000 ≈ 2 building-widths / half the inter-building gap; tunable after watching real arrivals.)
2. **Driver = new standalone `agent-autonomy-driver.ts` service** (clean separation from `agent-orchestrator`).
3. **`is_house` = real `openclaw_bots.is_house` BOOLEAN column** (migration) + filter house agents at the SSE broadcast boundary (`publicAutonomousAvatars`) so they never leak on the public wire.
4. **First action = agent CHOOSES a teacher by need** ("what do I want to learn") → walks there → talks. Shows real inference-driven decision, not just nearest.

## Scope discipline (what P1 is NOT)
ONE agent. No fleet (P4), no identity migration / provisioning (P2), no durable streamflow cursor (P3), no substrate rename (P3). Reuse the existing loop; build only the gate + settle + render + activation. Ship P0+P1 together.

## Gates before "done"
tsc 0 + tests green · the existing money-path discipline on `awardInWorldAction` (ledger-only, idempotent, daily-capped) · adversarial pass on the proximity gate + the settle path (protected/money surface) · **browser-verified** on staging (watch the agent walk + talk + earn) · founder sign-off.
