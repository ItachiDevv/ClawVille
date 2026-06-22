# ClawVille Domain-Subagent Registry — the shared ownership map

> **THE RULE (read before touching any domain):** every file in this repo has **exactly one owning domain agent**. Before you edit, find the owner by matching the path against `Owns` below. Then either **become that agent** (dispatch it) or — if the file is in another agent's domain — treat it as a `Consumes` edge and **defer** (file the change to the owner; never edit a primitive you don't own). One owner per domain = the menu can't drift from the backend, and two concurrent sessions can't fork the same vertical.
>
> Full rationale + the land worked example: `.claude/plans/subagent-structure.md`. The CI enforcement layer (each agent owns the gate that fails CI when its coupling drifts): `.claude/plans/ci-gates-protection.md`. **Set 2026-06-22.**

## Why vertical, not layer

Layer-ownership ("whoever's in `apps/web` this session owns the menu") is the root cause of decoupling — a change to one layer has no owner responsible for force-updating the others. Each agent owns one **vertical**: `menu row → store setter → modal → API route → service → schema → economics constant → operational-knowledge surface` for one thing a player does. Same agent owns both ends of every wire.

## Ownership table (12 agents — full repo coverage, no domain unowned)

| Agent | Status | Lev | Owns (scope) | Key owned paths | Consumes |
|---|---|---|---|---|---|
| **cove-casino** | exists | high | All in-world casino games end-to-end + provably-fair + poker sims | `routes/cove-*`, `services/{slot,blackjack,baccarat,holdem}-engine`, `services/poker/**`, `services/provable-rng`, `services/cove-verify-compat`, `schema/{cove,cove-events,blackjack,baccarat,holdem,poker,special-events}`, `constants/slot-*`, `components/cove/**`, `.claude/agents/cove.md`, `.claude/memory/cove/**` | token-economy, auth-identity-session, agent-protocol-partner (MTT whitelist), 3da/world-presence, knowledge-orientation |
| **land-economy** | other-session | high | Parcel economy + **WORLD↔DB↔UI tri-surface parity** | `routes/land`, `schema/land`, `constants/land-*`, `components/game/land/**`, `lib/three/land-*`, `.claude/agents/land.md` | token-economy, auth-identity-session, 3da/world-presence, agent-protocol-partner, knowledge-orientation |
| **token-economy** | exists | high | The CT ledger primitive + on-ramp/exchange + faucet monitor | `services/claw-token-ledger`, `routes/{exchange,claws,items}`, `services/x402-config`, `schema/{treasury(clawTokenTransactions),exchange,inventory,token-launch}` (NOT `claws` — that's `openclaw_bots`, owned by agent-protocol-partner), `components/game/{exchange,inventory,shop-overlay}-modal` | auth-identity-session |
| **auth-identity-session** | exists | high | Human auth + **{user,agent,guest} resolver** + fingerprint + user/avatar schema | `middleware/{auth,require-auth-or-agent,fingerprint,rate-limit,admin-only}`, `services/{auth-token,session-*,email,keyed-mutex,openclaw-session-restore,session-digest}`, `schema/{users,avatars,auth-tokens}`, `app/{login,verify-email}` | agent-protocol-partner (co-define bearer/TTL) |
| **agent-protocol-partner** | exists | high | **PROTECTED Hatcher surface** + custodial wallet + agent entry + whitelist/PROTOCOL_VERSION | `routes/{agent-gateway,openclaw,partner-hatcher*,portal,agent-*,avatar-manifest}`, `services/{partner-signature,service-issuer,skill-protocol,openclaw-*,keypair-vault,wallet-service,identity-service}`, `scripts/hatcher/**`, `schema/{agents,wallets,partner-api-keys,claws(openclaw_bots)}`, `types/openclaw`, `.hatcher-ref/**` | auth-identity-session, token-economy, knowledge-orientation |
| **knowledge-orientation** | exists | med | **3 operational-knowledge surfaces** + 10 teacher templates + chat | `packages/agent-templates/**`, `services/{system-npc-seeder,skill-*,npc-conversation-engine}`, `routes/{skills,chat,chat-transient,support,locations}`, `constants/{orientation-skill,knowledge-books}`, `.claude/agents/knowledge-orientation.md`, `.claude/memory/knowledge-orientation/**` | agent-protocol-partner (PROTOCOL_VERSION), auth-identity-session, 3da/world-presence, token-economy |
| **activities-arena** | exists | med | Real-time skill games + matchmaking + wager program | `routes/{activity,activities,wager}`, `services/activity/**`, `services/wager-program-client`, `schema/{activit*,wager}`, `contracts/wager/**`, `app/{activity,arena}/**`, `.claude/agents/activities-arena.md`, `.claude/memory/activities-arena/**` | token-economy, auth-identity-session, 3da, leaderboard-progression, agent-protocol-partner |
| **leaderboard-progression** | exists | med | Scoring engine + **event-weight registry** + quests/bounties/daily/XP + /dash | `routes/{leaderboard,quests,bounties,dashboard}`, `services/{event-logger,xp-service}`, `schema/{events,quests,bounties}`, `constants/quest-seeds`, `app/{leaderboard,dash}/**`, `.claude/agents/leaderboard-progression.md`, `.claude/memory/leaderboard-progression/**` | token-economy, auth-identity-session, knowledge-orientation |
| **cosmetics-shop** | exists | low | First-party CT cosmetic carve-out + equip pipeline | `routes/cosmetics`, `schema/cosmetics`, `components/game/{cosmetic-drawer,edit-appearance}`, `lib/three/cosmetic-loader`, `public/cosmetics/**`, `.claude/agents/cosmetics-shop.md`, `.claude/memory/cosmetics-shop/**` | token-economy, auth-identity-session, 3da |
| **marketplace-trade** | exists | low | PAUSED peer-commerce (503-gated) + FEATURE_GATE | `routes/{marketplace,bazaar,auctions}`, `schema/{marketplace,bazaar,auctions}`, `components/game/{marketplace,bazaar,auction}-modal`, `.claude/agents/marketplace-trade.md`, `.claude/memory/marketplace-trade/**` | token-economy, auth-identity-session, 3da |
| **3da** | exists | high | Render substrate + **world-dimensions SSOT** + Iris-Xe budget | `lib/three/**`, `components/three/**`, `public/{models,avatars}/**`, `constants/{world-dimensions,world-colliders-data}`, `.claude/agents/3da.md`, `.claude/memory/threejs/**` | world-dimensions (owns), game.ts state |
| **world-presence** | exists | med | Server world-state + NPC sim + roster constants | `routes/{world,npc-sse}`, `services/{npc-simulation,pathfinding,room-registry,room-ticket,avatar-simulation-bridge}`, `schema/locations`, `constants/{map-locations,building-types,npc-definitions}`, `.claude/agents/world-presence.md`, `.claude/memory/world-presence/**` | auth-identity-session, 3da, agent-protocol-partner ([ACTION:] whitelist), knowledge-orientation |

## The operating model every domain agent runs — three nets, left-shifted

1. **Phase 0 — PRE-READ + TRAP DETECTION (before ANY code).** Retrieve memory, then pre-read the touched files + the vertical's couplings + this domain's **"Known traps"** (every past gotcha/solution/economy-leak), and emit a **TRAP LIST**: edge cases, invariants at risk (conservation/idempotency/parity/world-parity), the couplings that must move together, and prior-bug patterns matching this change. Hand it to implementers as **hard constraints up front.** (cove's `db.transaction` bug was caught in audit *after* it was built; Phase 0 surfaces it as a trap *before* a line exists.)
2. **Phase 1 — Decompose + implement** as a manager: spawn the sub-team in ONE parallel message (`team_name '<domain>-<concern>-<date>'`, implementers given the trap list + an adversarial auditor pre-armed; `3da` for render, `solana-auditor` for `contracts/`, `codex:codex-rescue` for the partner surface).
3. **Phase 2 — Review + verify:** review every diff against the trap list → require the adversarial pass → verify on **staging** → report one consolidated result.
- **RLM memory** at `.claude/memory/<domain>/` (committed, grows every session; `MEMORY.md` leads with a **"Known traps"** section that feeds Phase 0). Precedence: **live code > the 3 canonical docs > memory** — verify `git show origin/master:<f>` vs `origin/staging:<f>` vs working tree before trusting any FIXED/LIVE claim.
- **Invariants:** money domains → CT-only/ledger-only, atomic-settle+idempotency, owner checks, **E5 parity on write AND read**, guest-demo isolation, no-faucet. Spatial domains → **WORLD↔BACKEND↔UI must agree, DB is truth.** All → staging-first; same-diff docs + the 3 knowledge surfaces.
- **Consumes:** only review your *usage* of a shared primitive; never edit it — file the change to its owner.

## Coordination (anti-collision)

The registry IS the shared map; one owner per domain. **Isolated worktree per session** (`git worktree add ../cv-<domain> -b <branch> staging` + `bun install`). **Never prune/remove a worktree you didn't create** (the F4-collision lesson). A domain session needing a shared-primitive *change* files it to the owner, never edits it.

## Creation rollout — COMPLETE (cove recipe: audit-domain → write def from this skeleton → seed memory + Known-traps → commit def+memory together)

All 12 domains now have an owner agent (`exists`). Each carries a Phase-0 pre-read trap gate + audited project-scoped memory under `.claude/memory/<domain>/`. Built via parallel domain audits against staging code.

- **Wave 1 (shared primitives — nothing is safe until these own their seams):** ✅ `auth-identity-session` → `token-economy` → `agent-protocol-partner`.
- **Wave 2 (forcing functions + substrate):** ✅ `knowledge-orientation` → `world-presence`.
- **Wave 3 (remaining verticals):** ✅ `leaderboard-progression` → `activities-arena` → `cosmetics-shop` → `marketplace-trade`.
- `3da` reused as-is; `cove-casino` is the reference; `land-economy` is owned by another session — all aligned to this map.

**Standing rule going forward:** before touching any domain, the owning agent (or whoever edits it) reads `.claude/memory/<domain>/MEMORY.md` Known-traps FIRST, and keeps the vertical coupled (menu/UI ↔ backend ↔ economics ↔ knowledge move together). A change that crosses a seam is filed to / co-signed by the seam's co-owner.
