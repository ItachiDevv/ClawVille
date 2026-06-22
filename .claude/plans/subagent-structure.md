# ClawVille Domain-Subagent Structure

> **Purpose:** kill the decoupling problem — the founder's pain where the LAND sidebar menu drifted from land's backend/economics ("a disconnect that should never happen"). The fix generalizes the cove-agent pattern: ONE manager+reviewer specialist agent per VERTICAL FEATURE DOMAIN (menu↔store→modal↔route↔service↔schema↔economics↔knowledge-surface), plus shared PRIMITIVES each owned by exactly one agent and consumed (never duplicated) by the rest. Verified against `origin/master` (the working tree is the stale `feat/poker-mtt-tournament` branch — only `3da.md` exists on master; cove/land agents are session-local).
>
> **Status set:** 2026-06-22.

---

## 1. The partition (why vertical, not layer)

Layer-ownership ("whoever's in `apps/web` this session owns the menu") is the root cause: a change to one layer has no owner responsible for force-updating the others. The fix is to carve by VERTICAL FEATURE DOMAIN — one agent owns the entire `menu row → store setter → modal → API route → service → schema → economics constant → operational-knowledge surface` chain for one thing a player does. The same agent owns both ends of every wire, so the menu cannot silently drift from the backend.

**12 agents, three classes:**

- **Vertical feature domains:** `cove-casino` (exists), `land-economy` (in-progress-other-session), `activities-arena`, `cosmetics-shop`, `marketplace-trade` (paused surface), `leaderboard-progression`.
- **Shared primitives (one owner, consumed by the rest):** `token-economy` (CT ledger), `auth-identity-session` ({user,agent,guest} resolver), `agent-protocol-partner` (Hatcher protected surface + custodial wallet), `knowledge-orientation` (3 knowledge surfaces + teachers).
- **Render/world substrate:** `3da` (exists — render + Iris-Xe budget), `world-presence` (server world-state + sim).

**Granularity:** 12 is the disciplined middle. One "economy" agent can't hold four different money contracts (provably-fair vs world-parity vs SKU-equip vs 503-pause) without diluting cove's bank-grade discipline. One-agent-per-route reintroduces the un-ownable-seam problem. Each of the 12 is a coherent owner of either one vertical or one primitive; seams are named `consumes` edges, never shared ownership.

---

## 2. Agent registry (canonical ownership table)

| Agent | Status | Leverage | Owns (scope) | Key owned paths | Consumes |
|---|---|---|---|---|---|
| **cove-casino** | exists | high | All in-world casino games end-to-end + provably-fair + poker sims + special-event parent | `routes/cove-*`, `services/{slot,blackjack,baccarat,holdem}-engine`, `services/poker/**`, `services/provable-rng`, `schema/{cove,blackjack,baccarat,holdem,poker,special-events}`, `constants/slot-*`, `components/cove/**`, `stores/{cove,poker}`, `.claude/agents/cove.md`, `.claude/memory/cove/**` | token-economy, auth-identity-session, agent-protocol-partner (MTT whitelist), 3da/world-presence, knowledge-orientation |
| **land-economy** | in-progress-other-session | high | Parcel economy + WORLD↔DB↔UI tri-surface parity | `routes/land`, `schema/land`, `constants/land-*`, `components/game/land/**`, `stores/land`, `lib/three/land-*`, `.claude/agents/land.md` | token-economy (burn-sink), auth-identity-session, 3da/world-presence, agent-protocol-partner, knowledge-orientation |
| **token-economy** | to-create | high | The CT ledger primitive + on-ramp/exchange + faucet monitor | `services/claw-token-ledger`, `routes/{exchange,claws,items}`, `services/x402-config`, `schema/{claws,exchange,inventory,token-launch}`, `types/claw`, `components/game/{exchange,inventory,shop-overlay}-modal` | auth-identity-session |
| **auth-identity-session** | to-create | high | Human auth + {user,agent,guest} resolver + fingerprint + user/avatar schema | `middleware/{auth,require-auth-or-agent,fingerprint,rate-limit,admin-only}`, `services/{auth-token,session-agent-map,session-digest,email,keyed-mutex,...}`, `schema/{users,avatars,auth-tokens}`, `lib/{auth,fingerprint,user-tier}`, `app/{login,verify-email,...}` | agent-protocol-partner (co-define bearer/TTL) |
| **agent-protocol-partner** | to-create | high | PROTECTED Hatcher surface + custodial wallet + agent entry + whitelist/PROTOCOL_VERSION | `routes/{agent-gateway,openclaw,partner-hatcher*,portal,admin-identity,agent-*,avatar-manifest}`, `services/{partner-signature,service-issuer,skill-protocol,openclaw-*,keypair-vault,wallet-service,identity-service,...}`, `scripts/hatcher/**`, `schema/{agents,wallets,partner-api-keys,...}`, `types/openclaw`, `.hatcher-ref/**` | auth-identity-session, token-economy, knowledge-orientation |
| **knowledge-orientation** | to-create | medium | 3 operational-knowledge surfaces + 10 teacher templates + chat | `packages/agent-templates/**`, `services/{system-npc-seeder,skill-*,npc-conversation-engine,memory-service,research-service}`, `routes/{skills,chat,chat-transient,i18n,support,research,locations}`, `constants/{orientation-skill,knowledge-books,milady-skills,article-seeds}`, `schema/{building-skills,memories,research}` | agent-protocol-partner (PROTOCOL_VERSION), auth-identity-session, 3da/world-presence, token-economy |
| **activities-arena** | to-create | medium | Real-time skill games + matchmaking + wager-lobby + wager program | `routes/{activity,activities,wager}`, `services/activity/**`, `services/wager-program-client`, `schema/{activit*,reef-race-personal-bests,wager}`, `contracts/wager/**`, `app/{activity,arena}/**`, `components/game/activity/**` | token-economy, auth-identity-session, 3da, leaderboard-progression, agent-protocol-partner |
| **leaderboard-progression** | to-create | medium | Scoring engine + event-weight registry + quests/bounties/daily/XP + /dash | `routes/{leaderboard,quests,bounties,dashboard,dash-auth}`, `services/{event-logger,xp-service,alert-error}`, `schema/{events,quests,bounties,tutorial-quest-claims,dashboard-phases}`, `constants/quest-seeds`, `app/{leaderboard,dash}/**` | token-economy, auth-identity-session, knowledge-orientation |
| **cosmetics-shop** | to-create | low | First-party CT cosmetic carve-out + equip pipeline | `routes/cosmetics`, `schema/cosmetics`, `components/game/{cosmetic-drawer,edit-appearance-section}`, `lib/three/cosmetic-loader`, `public/cosmetics/**` | token-economy, auth-identity-session, 3da |
| **marketplace-trade** | to-create | low | PAUSED peer-commerce surface (503-gated) + FEATURE_GATE | `routes/{marketplace,bazaar,auctions}`, `schema/{marketplace,bazaar,auctions}`, `components/game/{marketplace,bazaar,auction}-modal`, `lib/three/{marketplace-stall,bazaar-stall,auction-podium}` | token-economy, auth-identity-session, 3da |
| **3da** | exists | high | Render substrate + world-dimensions SSOT + Iris-Xe budget (#1 constraint) | `lib/three/**`, `components/three/**`, `public/models/**`, `public/avatars/**`, `app/preview/**`, `constants/{world-dimensions,world-colliders-data}`, `.claude/agents/3da.md`, `.claude/memory/threejs/**` | world-dimensions (owns), game.ts state |
| **world-presence** | to-create | medium | Server world-state + NPC sim + roster constants | `routes/{world,npc-sse}`, `services/{npc-simulation,pathfinding,room-registry,room-ticket,avatar-simulation-bridge,agent-body-idle-sweeper}`, `schema/locations`, `constants/{map-locations,building-types,npc-definitions,npc-activities}`, `stores/{players,npc}` | auth-identity-session, 3da, agent-protocol-partner ([ACTION:] whitelist), knowledge-orientation |

**Coverage check:** every route in `index.ts` (55 mounts), every schema file (48), every shared constant (25) maps to exactly one owner. No domain unowned ⇒ no decoupling gap.

---

## 3. The reusable agent-def skeleton (manager+reviewer + RLM + invariants)

Distilled from `cove.md` + `3da.md`. Every domain agent instantiates this:

1. **Front-matter:** `name`, `description` (domain + "spawns its own sub-team and reviews every change; persistent project-scoped memory"), `tools: [Bash, Read, Write, Edit, Glob, Grep, Agent, WebFetch, WebSearch]`.
2. **OPERATING MODEL — manager+reviewer with a PRE-READ gate (mandatory).** Three nets, left-shifted: catch the trap *before* coding, catch the slip *in audit*, catch the ignore *at the CI gate*.
   - **Phase 0 — PRE-READ + TRAP DETECTION (before ANY code is written).** Retrieve memory first, then PRE-READ the exact files the feature touches + the full vertical's couplings + this domain's memory (its **"known traps"** — every past gotcha/solution/economy-leak entry), and emit a **TRAP LIST**: the edge cases, the invariants at risk (conservation / idempotency / parity / world-parity), the coupling points that MUST move together (menu↔store↔modal↔route↔service↔schema↔economics↔knowledge-surface), and the prior-bug patterns from memory that match *this* change. Spawn a dedicated pre-reader specialist for a large feature. **The trap list is handed to the implementers as HARD CONSTRAINTS up front** — an edge-case regression is designed *out* before it is written, not discovered in audit (or prod). *Proof it matters: cove's no-`db.transaction` cash-settle bug was caught in the AUDIT phase, after the code was built (a build-then-fix cycle); with Phase 0 it surfaces as a trap — "cash settle must be atomic, mirror `registerEntrant` `FOR UPDATE`" — before a line exists.* This converts domain memory from a passive reference into an **active pre-flight check on every new feature.**
   - **Phase 1 — DECOMPOSE + IMPLEMENT.** Decompose across the full vertical → spawn the sub-team in ONE parallel message sharing `team_name '<domain>-<concern>-<date>'` (1–2 `general-purpose` implementers split by subsystem when the contract is frozen, **each given the Phase-0 trap list**; + an adversarial auditor pre-armed via task deps so it fires the moment the diff lands; add `3da` manager for any in-world render, `solana-auditor` for `contracts/`, `codex:codex-rescue` for the protected partner surface). Implementers/auditors may spawn their own helpers (exploration/test/fixture).
   - **Phase 2 — REVIEW + VERIFY.** Personally REVIEW every diff *against the trap list* → require the adversarial pass → verify on STAGING not localhost → report ONE consolidated result. Solo only for trivial single-line edits.
3. **RLM memory at `.claude/memory/<domain>/`** (committed, grows every session): **Retrieve-before-acting** (read `MEMORY.md` index + grep `gotcha`/`pattern`/`solution`/`economy`); **memory-is-advisory** (live code > 3 canonical docs > memory; before trusting any FIXED/LIVE claim verify `git show origin/master:<file>` vs `origin/staging:<file>` vs working tree — the working-tree-staleness trap); **Learn-after-acting** (file-anchored entries marking FIXED vs OPEN + deployment state + `[[slug]]` links, one index line; update don't duplicate, delete-when-wrong). **Known-traps surface (feeds Phase 0):** `MEMORY.md` carries a top **"Known traps"** section — the distilled list of every recurring failure mode in this domain (the `gotcha`/`solution`/`economy`-leak entries, one line each, with the trigger condition). Phase 0's TRAP LIST is built by checking the new feature against this section, so every bug the domain has ever paid for becomes a pre-flight check the next feature can't silently re-introduce. A new gotcha is added to "Known traps" the same turn it's learned. (cove already has this in substance — `cash-poker-no-transaction`, `subject-keying-keystone`, `e5-parity-write-vs-read-gap`, the faucet entries *are* its trap list.)
4. **PRECEDENCE block:** source code > the 3 canonical docs (`ARCHITECTURE.md`/`GameFeatures.md`/`3dStructure.md`) > memory.
5. **DOMAIN INVARIANTS block:**
   - *Money contract* (economy domains): CT-only/ledger-only (never write `avatars.clawTokens`), atomic-settle + idempotency, owner checks, **E5 parity on BOTH write AND read AND the agent path**, guest-demo isolation, conservation/no-faucet.
   - *World-parity contract* (spatial domains): WORLD↔BACKEND↔UI must agree, DB is source of truth.
   - *Cross-cutting*: staging-first push flow; same-diff docs across `ARCHITECTURE.md`/`GameFeatures.md`/`3dStructure.md` + the 3 operational-knowledge surfaces (Nori `knowledge[]`, connection SKILL.md, hosted-runtime).
6. **CONSUMES block:** the named shared-primitive owners this agent defers to (it reviews only its own usage, never edits the primitive).

---

## 4. Land — the worked example (BUILT ELSEWHERE)

The canonical decoupling slice. Seven layers that must move together: `'Land Office' SidebarRow` (sidebar ~916) → `openLandOffice()` (game.ts ~621) → `land-office-modal.tsx` → `useLandStore` → `@clawville/shared {LAND_TIERS, getTierStructureRules, PARCEL_TIER_COUNTS}` → `/api/land` → `schema/land.ts` — PLUS the third surface, the in-world 3D parcels. Same-diff mandate: **DB == modal == 3D world.** A buy updates all three or it's the canonical land bug. CONSUMES token-economy (CT burn-sink), auth-identity-session, 3da/world-presence (576-unit world-dimensions SSOT), agent-protocol-partner (Phase-3 verbs), knowledge-orientation. **Status: in-progress-other-session — do NOT build here; align to this map.** (Full spec in the landAgentSpec section above.)

---

## 5. Coordination model (anti-collision)

The registry IS the shared map: before touching a file, a session finds the owner by `ownedPaths` glob and either becomes that agent or treats the file as a `consumes` edge and defers. One owner per domain ⇒ two sessions can't fork the same vertical. Disjoint `ownedPaths` keep concurrent domain sessions clear; the only contention (shared primitives) has a single owner too — a domain session needing a primitive *change* files it to the owner, never edits it. **Isolated worktree per session** (`git worktree add ../cv-<domain> -b <branch> staging` + `bun install`); **never prune a worktree you didn't create** (the F4 lesson). Before trusting any FIXED/LIVE memory claim, verify master vs staging vs working tree (the current `feat/poker-mtt-tournament` tree is exactly such a stale tree).

---

## 6. Gate alignment (subagents author, gates enforce — one partition, two views)

`.claude/gates` is to-create. Each agent owns the gate that fails CI when ITS coupling drifts: `cove-casino`→`casino-parity`, `land-economy`→`land-coupling`, `token-economy`→`ledger-conservation`, `auth-identity-session`→`e5-parity`, `agent-protocol-partner`→`protocol-whitelist` (harness-gated), `knowledge-orientation`→`nori-knowledge` (the same-diff forcing function), `activities-arena`→`activity-reward-parity`, `leaderboard-progression`→`event-weight-registry`, `cosmetics-shop`→`cosmetic-sku`, `marketplace-trade`→`marketplace-pause`, `3da`→`iris-xe-budget`, `world-presence`→`world-dimensions-ssot`. Each gate's failure condition IS the owning agent's `verticalCoupling` mandate — authoring and enforcement are the same line drawn twice. (Full table in gateAlignment above.)

---

## 7. Creation rollout (by leverage — each via the cove recipe: audit-domain → write agent def → seed memory)

Reuse `3da` as-is. `cove-casino` exists (reference). `land-economy` is owned elsewhere. Stand up the rest in this order:

**Wave 1 — the shared primitives every domain consumes (highest leverage; nothing is safe until these own their seams):**
1. `auth-identity-session` — the `{user,agent,guest}` resolver gates EVERY economy parity. Seed from `require-auth-or-agent.ts` + cove memory (`agent-session-resolver`, `subject-keying-keystone`, `guest-demo-isolation`) + project memory (`agent_session_map_row_race`, `per_subject_serialization_mutex`).
2. `token-economy` — the CT ledger gates EVERY settlement. Seed from `claw-token-ledger.ts` + cove memory (`conservation-and-idempotency-patterns`, `atomic-settle-under-lock`, faucet notes) + `.claude/plans/cove-casino-economy.md`.
3. `agent-protocol-partner` — the protected surface; a silent break hits a LIVE partner. Seed from `docs/hatcher-integration-spec.md` + `.hatcher-ref/` + `scripts/hatcher/*` + the Hatcher project memories.

**Wave 2 — the cross-domain forcing functions + the world substrate:**
4. `knowledge-orientation` — the 3-surface propagation auditor (the same-diff knowledge rule). Seed from `town-guide.ts knowledge[]` + `system-npc-seeder.ts` + the CLAUDE.md propagation rule.
5. `world-presence` — server world-state + the world-dimensions seam. Seed from `npc-simulation.ts`/`room-registry.ts` + multiplayer-phase1 plan + spawn/ghost project memories.

**Wave 3 — the remaining player verticals:**
6. `leaderboard-progression` — owns the event-weight registry every emitter couples to. Seed from `event-logger.ts` + the CLAUDE.md weight table.
7. `activities-arena` — real-time games + wager program. Seed from `services/activity/**` + the ~20 activity tests + reef-race/wager project memories.
8. `cosmetics-shop` — the CT carve-out. Seed from `routes/cosmetics.ts` + cosmetic-swap/applyBoneTransform memories.
9. `marketplace-trade` — the paused boundary. Seed from the 503 handlers + the marketplace-pause + FEATURE_GATE rules.

Each new agent ships as: (1) audit the domain against `origin/master`, (2) write `.claude/agents/<domain>.md` from the skeleton in §3, (3) seed `.claude/memory/<domain>/MEMORY.md` + initial gotcha/pattern/economy files from the sources above, (4) commit (agent def + memory committed together).