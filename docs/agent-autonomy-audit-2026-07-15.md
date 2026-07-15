# Autonomous Agent Audit — 2026-07-15 (supersedes `agent-autonomy-audit-2026-06-30.md`)

> Audit target: **staging `2281d1bf`** (read-only worktree `cv-autonomy-audit`) + **live staging & prod** (env, logs, DB-adjacent probes) + **live model bench** on johns-pc.
> Method: 4 parallel subsystem auditors (autonomy pipeline / inference wiring / knowledge surfaces / covenant coverage), every load-bearing claim spot-verified against source and live logs by the orchestrator.
> Trigger: founder repro — logged in, flipped agent (`itachisan`) to Autonomous, directive **"go play cards"** → ~50s stall, HUD logged "Heading to Squidward's House" ×10, body walked to the Pineapple House, never the cove, jittery motion.

## 0. Executive summary

The June-30 verdict ("the real engine has never run") is **obsolete** — a real server-side autonomy driver now exists and demonstrably drives bodies (`apps/api/src/services/agent-autonomy-driver.ts`, live decide/dispatch logs on staging AND prod). What remains is **six integration defects** that together produce exactly the founder's repro. None of them is the model: `qwen3:14b` given the building list + directive answers `{"destination": "Cove"}` in 2–4s (live bench, 2026-07-15).

| # | Root cause | Effect the founder saw |
|---|---|---|
| RC1 | Decision prompt is a teacher-only straitjacket | "go play cards" → walks to a teaching house |
| RC2 | Brain routed to a DEAD inference box first | stalls; empty decisions; 96 wasted decides/12h on prod |
| RC3 | Two autonomy engines run at once; HUD wired to the dead one | "Squidward's House" label vs SpongeBob walk; log spam; "0/10" |
| RC4 | 30s tick + no enrollment kick + cold-runtime wasted tick | ~50s to first movement |
| RC5 | All world-knowledge surfaces are INERT in the decide path | agent "doesn't know what it's doing" |
| RC6 | Autonomous body = prediction-less 5Hz snapshot playback | jitter vs. Controlled's smooth local lerp |

Plus one governance finding (§4): the entire in-world agent action surface (`[ACTION:]` verbs, visits, chat, directives) produces **zero covenant records** — the covenant stream covers money/quests/bounties only.

---

## 1. Live evidence (2026-07-15)

- **Staging env** (`yvtwz7snaghxifkjhyxknffu` container): `INFERENCE_ROUTE_HOSTED_USER=local-secondary,local-primary,openai`; local-secondary = `http://100.75.223.14:11434/v1` — **box unreachable** (connect timeout, verified from dev machine and from router logs).
- **Prod env** (`ebnatuxblgp4q0antoca9swk` container): **identical routing**; last 12h: `attempt failed … by=local-secondary 60001ms` ×96 and `[AutonomyDriver] decision timed out after 15000ms` ×96.
- **Staging driver logs**, founder's agent (`5d71e79676b2f557`, body `ocb-ZWJhMmM3NGQ…` = itachisan): decides emit ONLY `enter_building(visual-creation)` / `enter_building(agent-security)`; repeated `decision timed out after 15000ms` → `replyLen=0` → `destinationBuildingId=null`.
- **johns-pc (100.76.57.60)**: up, ~370ms `/api/tags`; `qwen3:14b` pinned in VRAM (`keep_alive=-1`); serving `route=hosted-user by=local-primary` in 1.4–8s when reached.
- **Model bench**: `qwen3:14b`, prompt = building list incl. Cove + directive "go play cards" → `{"destination":"Cove"}` in 4.2s (think) / 2.1s (no-think). **The model is not the problem.**
- **Live rosters**: staging `/api/npc/state` → `autonomousAvatars: 0` + `openclaw/active` shows itachisan + Coralia; prod → `autonomousAvatars: 1` (Coralia). (The explicit-toggle driver routes bodies through `snapshot.npcs`, not `autonomousAvatars` — see §3.)

---

## 2. Root causes (ranked, file:line on `2281d1bf`)

### RC1 — The decision prompt cannot express anything but "pick a teacher" (PRIMARY)
`agent-autonomy-driver.ts:802-850 buildDecisionPrompt`:
- Options = `perception.nearbyBuildings` only → built from `NPC_BUILDING_CENTERS` (`npc-simulation.ts:1436`; `packages/shared/src/constants/npc-definitions.ts:71-73`) = **the 10 teaching buildings. The cove is not in perception at all.**
- Only legal output: `[ACTION: enter_building(buildingId=…)]` (`:846-848`). `enter_cove()` / `enter_poker_room()` / `talk_to_npc` / `move` / `emote` are **fully implemented in the executor** (`npc-simulation.ts:1650-1846`) but never offered.
- The user directive IS fetched and injected top-priority (`agent-autonomy-state.ts:91`, driver `:833-838`) — then immediately narrowed to *"choose the ONE teacher whose focus best serves the directive."* "Go play cards" is **structurally unsatisfiable**; walking to a teaching house is the prompt's correct output.

### RC2 — Dead-box-first inference routing (both envs)
`INFERENCE_ROUTE_HOSTED_USER=local-secondary,local-primary,openai` while `100.75.223.14` is down.
- Router attempt on the dead box runs to the endpoint timeout (60s: `inference-config.ts:105`), but the driver caps each decide at **15s** (`agent-autonomy-driver.ts:150,1026`) → any decide whose first attempt hits local-secondary **cannot succeed**, returns `''`, agent skips the tick, +30s.
- Breaker (3 fails → 30s cooldown, `inference-config.ts:215-216`) keeps **re-closing onto the dead box**, so degradation recurs indefinitely. Prod: 96 killed decisions/12h.
- Immediate ops remediation (env-only, no code): drop `local-secondary` from `HOSTED_USER`/`FLEET`/`DEFAULT` routes until the box is back (or fix the box). Note: Coolify env change requires an api redeploy → in-memory agent sessions reset; schedule accordingly.

### RC3 — Two engines on one toggle; the HUD narrates the dead one
`stores/game.ts` — one toggle starts BOTH: the client scripted loop (`:705-708` → `autonomy.ts startAutonomy`, 500ms tick, random goal scorer) AND the server enrollment (`:716-731` → `POST /api/world/autonomy`).
- The **server** moves the real body (driver → `setNpcPath` → NPC-sim A* → `snapshot.npcs`; camera follows `autonomousBodyId`, `World3DCanvas.tsx:587-606`).
- The **client** loop's movement output is inert — `game.setClickPath()` (`autonomy.ts:191`) has no consumer because `PlayerAvatar` is unmounted outside `player` mode (`World3DCanvas.tsx:1966`) — but it still **paints the AUTONOMOUS HUD** (`autonomy-hud.tsx:24-29` reads `useAutonomyStore` exclusively): "Discovered Squidward's House! Heading there to learn…" (`autonomy.ts:444`) is the client's own random pick, unrelated to the server's `visual-creation` (= Pineapple House, `building-types.ts:48`, `map-locations.ts:42`).
- "Buildings: 0/10" never advances: arrival detection waits on `game.nearLocation` (`autonomy.ts:206`), which only `PlayerAvatar` writes — unmounted → re-plans forever → the ×10 log spam.
- **Verdict:** HUD label = client engine's fiction; body = server engine's choice. That IS the Squidward-vs-SpongeBob mismatch — not a coordinate bug.

### RC4 — ~50s to first move is cadence, not compute
No drive kick on enrollment (`agent-autonomy-activation.ts:191` only registers); driver ticks every **30s** (`TICK_MS`, driver `:143`); first tick with a cold ElizaOS runtime fires a warm and **skips the drive** (`:552-569`); movement waits for the NEXT tick. Budget: ~0–30s wait for tick N + warm (3–15s bg) + 30s to tick N+1 + decide 2–15s ⇒ **~35–60s typical**, exactly the founder's ~50s. RC2 adds +30s per killed decide on top.

### RC5 — Every knowledge surface is inert where decisions happen
- `injectProtocolKnowledge` EXISTS and runs on runtime start (`eliza-runtime.ts:904-978`, wired `agent-orchestrator.ts:225-264`, version-deduped) — but writes to an isolated memory room that **no reader queries**: the only autonomy-path memory read filters to `earned-skill` only (`eliza-runtime.ts:854-856`).
- `decide()` is a **bare `useModel(TEXT_SMALL)`** (`eliza-runtime.ts:1425-1433`) — no providers, no RAG, no character system prompt. Even `CLAWVILLE_ORIENTATION_KNOWLEDGE` (rich: describes the cove + every card game, `orientation-skill.ts:106-181`), which IS in the character file, never reaches the deciding LLM.
- The protocol manual (`skill-protocol.ts:263-953`, PROTOCOL_VERSION 18) already documents all 6 action verbs incl. `enter_cove` + move bounds — a complete "how to play" doc that the autonomous brain never sees.
- Net: the delivery plumbing the founder asked for **mostly exists**; the missing link is **consumption** — nothing connects the canonical world knowledge to `buildDecisionPrompt`/`decide()`.

### RC6 — Jitter is prediction-less snapshot playback
Autonomous body = server-streamed NPC: ~5Hz snapshots, render-one-tick-behind interpolation with `tsDelta` clamped [120,320]ms (`stores/npc.ts:562-611`), no client prediction, new destination only every 30s (stop-start). Controlled click-to-move is smooth because it's a local 60fps lerp in `PlayerAvatar` (`player-avatar.tsx:943-961`). Same-class fix as other NPC smoothness work (entity-interp tuning / local smoothing on the followed body).

### Closed since 2026-06-30 (credit where due)
- Server driver exists and runs (was: unreachable engine).
- `sendHeartbeat` now has a caller (`use-avatar-heartbeat.ts:67`, player-mode body-suppression re-arm).
- `snapshot.autonomousAvatars` is now read by the client (`stores/npc.ts:562`) — that roster is the idle-avatar bridge; the explicit-toggle driver uses `snapshot.npcs` + `autonomousBodyId`.
- Enrollment has capacity/eligibility handling + epoch-guarded revert (Codex-reviewed, `game.ts:716-780`).

---

## 3. Which engine is which (for future sessions)

| Engine | Where | Drives | Status |
|---|---|---|---|
| Server autonomy driver | `agent-autonomy-driver.ts` (30s tick) | REAL bodies (`ocb-*` via `snapshot.npcs`), house + user agents, LLM decide → `[ACTION:]` executor | The real thing; prompt-crippled (RC1), routing-degraded (RC2) |
| Client scripted loop | `apps/web/src/stores/autonomy.ts` (500ms tick) | NPC town-liveliness ONLY (per 2026-06-30 founder correction) | Must be **decoupled from the user toggle + HUD** — it currently cosplays as the user's agent UI (RC3) |
| Idle-avatar bridge | `avatarAutonomyManager` / `snapshot.autonomousAvatars` | Human avatars idle >60s | Separate system; not the toggle path |

---

## 4. Covenant coverage of agent actions (founder directive: "agents' actions should be managed with covenants")

> **Implemented 2026-07-15 (Autonomy Round 2, local diff; not deployed):** the §4 gaps below are closed. Executor attribution resolves once from the in-memory session's internal `config.avatarId`; missing attribution remains action-compatible but recordless. Driver arrival/directive records are deduped at decision/arrival boundaries, never movement ticks. Native claim/learn/visit records share their business transaction. Payloads contain ids/hashes only. The Hatcher wire/whitelist and `PROTOCOL_VERSION 18` are unchanged.

The PR #198 stream fully covers vCLAW money (choke point `applyCreditInTx`/`debitInTx` holds on this sha; wave1-economy merges added **no** off-ledger vCLAW mutations), quests, and bounties. **At audit time, the in-world agent action surface was at zero**; the table now marks the Round 2 implementation:

| Surface | Covenant status | Choke point |
|---|---|---|
| `[ACTION:]` move / emote / enter_building / enter_cove / enter_poker_room / talk_to_npc | ✅ `agent.move` after validated path; `agent.chat` after target/proximity validation; emote deliberately records nothing | `npc-simulation.ts` executor |
| Native `claim-bounty` | ✅ existing `bounty.claim`, same tx as attempt insert + bounty update | `claim-bounty.ts` |
| Native `learn-book-transaction` / `visit-building` | ✅ `agent.action.learn` / `agent.visit`, same tx as business write | `learn-book-transaction.ts`, `visit-building.ts` |
| Native `accept-quest` / `submit-quest` | ✅ records via seam | `accept-quest.ts:209`, `submit-quest.ts:~166` |
| `buy-item`, cove bets/settles, building-visit payouts | ✅ money legs auto-covered (ledger) — no action-verb record | `claw-token-ledger.ts:350,757` |
| Agent chat turns / autonomous decide→move | ✅ `agent.chat`; driver `agent.visit` + deduped `agent.directive.received/acted` | driver + executor |
| SOL wagers (`routes/wager.ts` → `settleSolLobby`) | **NONE** — on-chain SOL, never touches the vCLAW ledger; separate gap category | `wager.ts` |

**Implemented taxonomy (decisions + arrivals, never per-step ticks — chain-bloat rule):** `agent.move` (committed destination after `setNpcPath`) · `agent.visit` (arrival + native visit-building) · `agent.chat` (`talk_to_npc` post-proximity, payload `{target, msgSha256, len}`) · `agent.action.learn` · existing `bounty.claim` for the native claim · `agent.directive.received/acted` (hash-deduped autonomy intake). The actor kind distinguishes native agent claims from human route claims; there is one verb per business action.

---

## 5. World-scope skill file — gap analysis vs the founder's rule

**Founder's ask:** any agent-affecting edit updates the canonical skill file; that file is installed into every runtime agent and refreshed on every login, so agents know the world's scope, navigation, and features.

Already exists: canonical manual (`buildProtocolManual`, versioned + content-hashed) · canonical world facts (`CLAWVILLE_ORIENTATION_KNOWLEDGE`) · working injection into hosted runtimes on start (version-deduped) · full 6-verb executor · connected-agent re-pull pointer on version bump.

Missing (all consumption-side): (1) `decide()` reads none of it (RC5); (2) decision action menu ≠ executor whitelist (RC1); (3) perception excludes non-teaching destinations (RC1); (4) no per-login re-delivery into the decision context (start-time only); (5) no reader for the injected `protocol-knowledge` room; (6) directive not mapped to the full action space.

**New CLAUDE.md rule shipped with this audit** (same diff): agent-affecting edits → manual update + version bump (extends the three-surface rule) + install/refresh on every runtime start & session connect + **the consumption mandate**: any LLM decision path choosing agent actions MUST be fed the current world scope and the FULL executor action menu — a decision prompt narrower than the whitelist is a defect.

---

## 6. Fix plan (Fable plans · Codex implements · Fable reviews — Codex quota returns Jul 19)

- **P0 (env-only, today, founder go needed — requires api redeploy → in-memory sessions reset):** remove `local-secondary` from the three route lists on staging+prod until 100.75.223.14 is healthy; or fix the box (tailscale/ollama down). Kills RC2 instantly.
- **P1 (driver, small diffs):** immediate drive on `registerUserAgent`; drive right after warm resolves instead of skipping the cold tick; raise first-decide cap toward the 60s endpoint budget. Kills RC4.
- **P2 (prompt + perception — the core):** `buildDecisionPrompt` v2 — full action menu (all 6 verbs incl. `enter_cove`/`enter_poker_room`), destination list incl. the cove/poker/land ("places" block alongside teachers), directive mapped to the whole action space, world-scope context sourced from the canonical manual (live retrieval or prompt-embedded). Kills RC1 + RC5. PARITY note required (Rule E5).
- **P3 (client):** decouple the toggle from `autonomy.ts` (NPC-liveliness only); rewire `AutonomyHUD` to the server driver's real state (phase/destination/decide text via body feed or a driver status endpoint); smooth the followed autonomous body (entity-interp tuning). Kills RC3 + RC6.
- **P4 (covenant):** `agent.*` verbs per §4 taxonomy; `agent.directive.*` lands with P2.
- Verification loop per round: live staging repro of the founder's exact scenario — toggle Autonomous, directive "go play cards", assert cove arrival < 15s, HUD text matches the actual destination, covenant rows written.

---

*Method note: the 2026-06-30 doc remains valid as historical evidence; its §2 verification results are superseded by §1–§3 here.*
