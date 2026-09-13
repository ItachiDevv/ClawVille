# Codex partner-review — Agent–Metaverse Model spec (2026-06-30)

> Adversarial review by Codex of the model spec (`docs/agent-metaverse-model.md`). Completed 21:22 (2.1M input tokens, ~20 files read). **Verdict: do not build from this spec yet — narrow P0/P1, lifecycle-truth first, defer the protected-surface rename, gate the fleet.** Recovered 2026-07-01 into `docs/` after the `newma` sandbox was reset.

**Review Verdict** — Do not build from this spec yet. The direction is plausible, but the spec still has blocking ambiguity around identity, persistence, fleet scoring, and the protected Hatcher/session surface.

**1. Factual Errors**
- Fleet repo visibility was internally inconsistent (PRIVATE vs a "public repo" P4 title). RESOLVED: PRIVATE (`clawville-agents`).
- "Logged-in ≡ agent connected" is not current code: toggle gates on `agentConnected` (`control-mode-toggle.tsx:20`), `agentConnected` is its own store field (`game.ts:226`); docs still define Players as avatar-only rows distinct from Trainers (`GameFeatures.md:313`). It's the TARGET; treat as a migration.
- Current "Path B" is NOT provisioning a hosted OpenClaw/Hermes runtime: the manual says ClawVille cloud-hosts Milady, but Hermes/OpenClaw/custom run on the human's machine (`agent-gateway.ts:3167`); `HermesClient` is an OpenAI HTTP wrapper (`hermes-client.ts:49`); `milady-gateway.ts` is knowledge/search plumbing (`:60`).
- `/api/agent/:sessionId/events` DOES exist (`agent-gateway.ts:2847`, perception 2s :2882, `knowledge_added` :2911, ping :2919) — under-built, not absent.
- "5120 constants" only partly current: heartbeat cap 5120 (`avatars.ts:955`, dead) + movement clamp 5120 (`movement.ts:15`), but `npc-simulation.ts` already 18432 (`:40`); pathfinding 360×360 (`pathfinding.ts:29`) vs web 576×576 (`tilemap-data.ts:16`).

**2. Gaps**
- Persistence underspecified: bearer needs RAM-map + DB TTL (`require-auth-or-agent.ts:91`) but `session-status` answers from DB TTL alone (`agent-gateway.ts:1125`) → restart reports connected while bearer fails; sweeper stops Eliza runtimes but not sim bodies (`openclaw-session-sweeper.ts:111,188`); orchestrator stops non-system runtimes after 30 min (`agent-orchestrator.ts:24,212`). **Define ONE lifecycle authority.**
- `AGENT_BODY_IDLE_DESPAWN_MS` NOT implemented for connected bodies (`docs/agent-autonomy-audit-2026-06-30.md:493`); the heartbeat-avatar cleanup (`avatar-simulation-bridge.ts:48`) is a different thing.
- Fleet leaderboard: board scores every non-null `agent_id` event (`leaderboard.ts:555`), caps at `:408` — caps don't distinguish house/fleet. **Need a durable `house/fleet/demo` flag + SQL exclusion mechanics**, not "lean excluded."
- Path-B provisioning must say WHICH harness is minted; if OpenClaw/Hermes provisioned in ClawVille infra, it's NEW runtime orchestration that MUST use ElizaOS, not the thin `HermesClient`.
- Event streamflow too thin: perception + skill events, no durable cursor, no settlement confirmations, no goal/task stream, no replay after disconnect. Liveness feed, not continuity memory.

**3. Contradictions / Risks**
- **Hatcher risk HIGH.** The "neutral substrate rename" touches the protected surface: `openclaw_bots`, `OpenClawClient`, bearer validation, Hatcher proxy cognition, `[ACTION:]`, protocol orientation. Hatcher proxy body registers via `partner-hatcher.ts:795` into `registerOpenClaw`; cognition uses signed outbound proxy state (`openclaw-client.ts:217`). Rename needs contract + harness gating.
- Generalizing `[ACTION:]` beyond Hatcher isn't just a refactor: executor documents Hatcher-only parsing + no DB rewards (`npc-simulation.ts:855`); dispatch gated to `hatcher-proxy` (`:1948`). Expanding changes the protocol manual + `PROTOCOL_VERSION`.
- "No agent-less account" risks breaking guest/demo + Player-tier: guest auth route (`auth.ts:917`), guest users/avatars (`ARCHITECTURE.md:571`), avatar-but-no-agent UI (`GameFeatures.md:431`). Treat as MIGRATION.

**4. Phasing Critique**
- P0 too broad; first diff should be **lifecycle truth** (session-status/bearer/rehydrate/registry/disconnect/sweeper agree) before any autonomy engine.
- P1 too large; split: (1) rehydrate + lifecycle; (2) one body renders from authoritative stream; (3) one non-money autonomous action; (4) one money/leaderboard/memory action via shared `awardInWorldAction`.
- P2 should NOT deprecate Player until Path-B provisioning is real (else broken promise).
- P3 substrate rename should move LATER — protected surface; after the one-agent loop is proven.
- P4 fleet must wait until leaderboard exclusion + idle/despawn budgets exist.

**5. Additional Decisions Needed** — fleet repo visibility (RESOLVED private); fleet board treatment; default Path-B runtime + who pays/operates it; authoritative idle policy; Player-tier fate; event-stream guarantees; Hatcher harness suite required before rename.

Would not approve for implementation until those are resolved and P0/P1 narrowed.
