# ElizaOS Integration Architecture

**Last updated:** 2026-06-16
**ElizaOS version:** `@elizaos/core@2.0.0-alpha.3`, `@elizaos/plugin-sql@2.0.0-alpha.7`
**Status:** Phase 1 DONE, Phase 2 planned
**Drift note:** Gemini removed 2026-06-16, OpenAI sole backend (`openai-text-provider`@95 `gpt-4o-mini`/`gpt-4o`, `openai-embedding-provider`@100 `text-embedding-3-small` 1536-dim).

---

## Section 1: Current State

### Dependencies

| Package | Version | Purpose |
|---|---|---|
| `@elizaos/core` | `2.0.0-alpha.3` | Runtime, Character system, memory API, plugin routing |
| `@elizaos/plugin-sql` | `2.0.0-alpha.7` | Postgres-backed adapter for `memories`, `rooms`, `entities` tables |

No other ElizaOS packages are loaded. `plugin-anthropic`, `plugin-openai`, and `plugin-bootstrap` have all been removed. Bootstrap functionality is built into `@elizaos/core` in v2.

### Plugin Loading Chain

Plugins are prepended to the `loadedPlugins` array in priority order. ElizaOS routes model requests to the highest-priority handler that matches the `ModelType`.

| Priority | Plugin | Scope | When Active |
|---|---|---|---|
| 100 | `openclaw-provider` | `TEXT_SMALL`, `TEXT_LARGE` | Only when `openclawGateway` config present (openclaw-bot agents) |
| 95 | `openai-text-provider` | `TEXT_SMALL`, `TEXT_LARGE` | Always — canonical text-gen backend for all non-OpenClaw runtimes (`gpt-4o-mini` / `gpt-4o`) |
| 100 | `openai-embedding-provider` | `TEXT_EMBEDDING` | Always — `text-embedding-3-small`, 1536-dim embeddings |
| (core) | `@elizaos/plugin-sql` | DB adapter | Always — Postgres memory persistence |

All three custom providers live in `packages/agent-runtime/src/plugins/`. They call the OpenAI REST API directly via `fetch()` with no SDK dependency.

**Resolution logic:** When `openclawGateway` is configured, the OpenClaw provider (100) wins for text generation, routing through the external agent's own LLM. OpenAI text (95) loses and acts as fallback. When no gateway is configured, OpenAI text (95) is the sole text-gen backend. Embeddings always go through the OpenAI embedding provider regardless of gateway config.

### Three Call Sites for processMessage

Every chat interaction in ClawVille goes through `ElizaRuntime.processMessage()`. There are exactly three call sites, each building a manual `dynamicContext` string:

**1. Location NPC chat** — `apps/api/src/routes/chat.ts:121`
- Context: visitor's avatar info, shop items + prices, OpenClaw theme, cross-building collaboration results, Milady knowledge enrichment
- Awards: +1 ClawToken, +5 XP per message

**2. Avatar chat** — `apps/api/src/routes/avatars.ts:308`
- Context: token balance, knowledge count, NPC world state snapshot
- Awards: none

**3. Agent gateway / OpenClaw** — `apps/api/src/routes/agent-gateway.ts:500`, `openclaw.ts:423`, `openclaw.ts:528`
- Context: agent identity, personality archetype, ClawTokens, OpenClaw knowledge (sliced to 20 entries)
- Gateway chat also injects into NPC simulation for visible chat bubbles

### What ElizaOS Gives Us (the ~20% we use)

| Feature | How We Use It |
|---|---|
| Postgres-backed conversation memory | Room/entity model via plugin-sql; messages stored per `roomId` with deterministic UUID v5 IDs |
| Character/personality type system | `bios`, `lore`, `topics`, `rules`, `adjectives`, `style`, `messageExamples` — converted from our templates + archetypes via `convertToElizaCharacter()` / `buildAvatarCharacter()` |
| Plugin priority routing | OpenClaw(100) > OpenAI(95) — external agents override the default LLM transparently |
| Deterministic UUID v5 room IDs | One room per agent-user pair, stable across sessions: `uuidv5(agentId-userId, ROOM_NAMESPACE)` |
| Runtime lifecycle | `start()` / `stop()` / `generateText()` — lazy-start on first chat, auto-stop after 30min inactivity |
| `createDatabaseAdapter` | Shared Postgres pool singleton (global symbol) across all agent instances |

### What We Bypass

| ElizaOS Feature | Reason |
|---|---|
| Actions | No action evaluation — `processMessage` calls raw `generateText()` with manually-built prompts |
| Providers | Manual `dynamicContext` string concatenation in route files instead |
| Evaluators | Not used |
| Autonomy self-loop | Custom stub in `SimulationRuntime` — LLM picks from 4 avatar-sim actions, not the standard ElizaOS loop |
| Should-respond classifier | Always respond — game agents should never decline a message |
| Task scheduler | Not used |
| Bootstrap self-talking | Not used |
| `message.ts` pipeline | Entirely bypassed — we compose prompts and call `generateText` directly |

### What Bypasses ElizaOS Entirely

**NPC conversation engine** (`apps/api/src/services/npc-conversation-engine.ts`) calls OpenAI REST directly for fire-and-forget NPC banter. No memory, no runtime, no plugin chain. Uses `OPENAI_SMALL_MODEL` (default `gpt-4o-mini`) at temperature 0.9, max 400 tokens. This is intentional — NPC ambient chatter does not need conversation history or personality persistence.

### processMessage Flow (Current)

```
Route handler builds dynamicContext string
  → processMessage(content, { userId, roomId, dynamicContext })
    → ensureWorld / ensureRoom / ensureEntity
    → getConversationHistory (last 20 messages from memories table)
    → buildConversationContext (format as "Role: text" lines)
    → createMemory (store user message)
    → Build prompt: [dynamicContext] + [history] + "User: {content}"
    → runtime.generateText(prompt, { maxTokens: 1000 })
    → createMemory (store assistant response)
    → Return ElizaMessage { role, content, timestamp }
```

### Agent Orchestrator Lifecycle

The `AgentOrchestrator` (singleton in `apps/api/src/services/agent-orchestrator.ts`) manages all runtime instances:

- **Lazy-start:** Runtime is created on first chat message, not on config save
- **Inactivity timeout:** 30 minutes — checked every 5 minutes
- **Concurrency guard:** `recoveryInProgress` Set prevents duplicate startup
- **Init mutex:** Global `InitMutex` in `eliza-runtime.ts` serializes runtime initialization (2s release delay) to prevent Postgres pool exhaustion during concurrent agent starts

### SimulationRuntime (Autonomous Avatars)

`packages/agent-runtime/src/simulation/simulation-runtime.ts` is a specialized wrapper that hosts autonomous avatar behavior. It uses ElizaOS Actions and Providers internally, but only for the simulation planning loop — not for chat.

- **4 Actions:** `AVATAR_MOVE_TO_BUILDING`, `AVATAR_VISIT_BUILDING`, `AVATAR_RETURN_HOME`, `AVATAR_SLEEP`
- **1 Provider:** `AVATAR_WORLD_STATE` — formats per-avatar position, nearby buildings, visit count
- **Planning:** Bridge calls `planAvatarNextAction(userId)` → Provider injects context → LLM picks action as structured JSON → handler mutates `AvatarStateStore`
- **Character:** Lightweight "simulation controller" character that responds only in structured JSON

This runtime is separate from the chat runtimes. It demonstrates that ElizaOS Actions/Providers work in this codebase — Phase 1 extends the same pattern to chat.

---

## Section 2: Phase 1 — Actions + Providers (DONE)

### What Was Built

Manual `dynamicContext` concatenation is now augmented with composable ElizaOS Providers, and agents can take game actions (buy, learn, visit, trade) mid-conversation via LLM-driven action dispatch.

### The `clawvillePlugin` Object

`packages/agent-runtime/src/plugins/clawville-plugin.ts` exports a `ClawvillePlugin` object that bundles all 5 providers and 8 actions. This is NOT loaded through the ElizaOS plugin priority chain (that chain handles model providers). Instead, `ElizaRuntime.processMessage()` references `clawvillePlugin.providers` and `clawvillePlugin.actions` directly during prompt construction and action dispatch.

### Providers (5 total)

Each Provider implements a local `Provider` interface (mirroring ElizaOS v2's `Provider`) and returns `{ text, values, data }`. Providers are sorted by `position` (ascending) and their `text` outputs are concatenated into a `[Current state context]` block prepended to the prompt.

Providers read from `state.*` properties passed by the API route handler — they do NOT query the database directly. This keeps them side-effect-free and fast.

| Provider | Position | State Input | Context Injected |
|---|---|---|---|
| `avatarStateProvider` | 10 | `state.avatarData` | `[Avatar Status]` — name, species, archetype, level, ClawTokens, STR/DEF/MOV stats, login streak |
| `worldStateProvider` | 20 | `state.worldSnapshot`, `state.nearLocation` | `[World State]` — current location, up to 8 alive NPCs with activity + destination |
| `inventoryProvider` | 30 | `state.inventory` | `[Inventory]` — items grouped by type (books, skills, other), quantities, total count |
| `questProvider` | 40 | `state.activeQuests`, `state.availableQuests` | `[Quests]` — active quests with status + reward, available quests |
| `knowledgeProvider` | 50 | `state.characterConfig` | `[Knowledge]` — skill count + last 5 entries (truncated to 40 chars each) |

### Actions (8 total)

Each Action implements a local `Action` interface (mirroring ElizaOS v2's `Action`) with `name`, `description`, `validate`, `handler`, `parameters`, `similes`, `examples`.

Actions dynamically import `@clawville/database` tables (`avatars`, `avatarInventory`, `bazaarListings`, `quests`, `bounties`, etc.) and use the injected `state.services.db` Drizzle instance to execute queries. This avoids a static import of the database package at the module level.

| Action | DB Tables | Side Effects |
|---|---|---|
| `VISIT_BUILDING` | `avatars` | Updates `positionX/Y` + `lastActiveAt`, returns building info + shop items + OpenClaw theme |
| `BUY_ITEM` | `avatars`, `avatarInventory` | Debits ClawTokens via `debitClawTokens()`, inserts/increments `avatar_inventory` row |
| `LEARN_SKILL` | `avatars`, `avatarInventory` | Merges book's `knowledgeEntries` into `characterConfig.knowledge[]`, decrements inventory |
| `CHECK_BALANCE` | `avatars`, `avatarInventory` | Read-only — returns name, level, XP, ClawTokens, inventory count, knowledge count |
| `LIST_BUILDINGS` | (none) | Read-only — returns all 10 `MAP_LOCATIONS` with `BUILDING_OPENCLAW_THEMES` |
| `BUY_BAZAAR_LISTING` | `bazaarListings`, `bazaarTransactions`, `publishedSkills`, `avatarInventory`, `avatars` | Debits buyer, credits seller (minus 15% platform fee), marks listing sold, records transaction, adds skill to buyer inventory |
| `ACCEPT_QUEST` | `quests`, `questSubmissions` | Validates quest is active + not expired + not max completions, creates submission with status `accepted` |
| `CLAIM_BOUNTY` | `bounties`, `bountyAttempts` | Validates bounty is open + not self-owned + not expired, creates attempt with status `claimed`, increments `currentAttempts` |

### Service Injection Pattern

Actions need database access and ClawToken ledger functions (`creditClawTokens`, `debitClawTokens`) but live in `packages/agent-runtime` which cannot import from `apps/api` (monorepo dependency direction: packages are consumed by apps, not the reverse).

The `ClawvilleServices` interface defines the injection contract:

```typescript
interface ClawvilleServices {
  creditClawTokens: (params: ClawTokenServiceParams) => Promise<{ balanceAfter: number }>;
  debitClawTokens:  (params: ClawTokenServiceParams) => Promise<{ balanceAfter: number }>;
  db: any;  // Drizzle query builder instance
}
```

The API route handler populates `state.services` before calling `processMessage()`. The `hasServices()` type-guard validates that `state.avatarId`, `state.userId`, and all three service functions are present before any action handler executes. If the guard fails, the action returns `{ success: false, text: 'Service layer not available' }`.

### Action Dispatch Pattern

Actions are NOT dispatched via ElizaOS's internal action planner. Instead, `processMessage` implements a lightweight custom dispatch:

1. **Describe:** `buildActionDescriptions()` formats all 8 actions as a `[Available Actions]` block in the system prompt, instructing the LLM to use `[ACTION: ACTION_NAME(param=value)]` syntax
2. **Generate:** `runtime.generateText()` produces a response that may contain an action tag
3. **Parse:** `parseActionInvocation()` extracts the first `[ACTION: NAME(key=val, ...)]` match via regex
4. **Execute:** `executeAction()` finds the matching action by name and calls its `handler(runtime, message, state, options)`
5. **Compose:** The action tag is stripped from the response text and the action's result text is appended

Action descriptions are only included in the prompt when `state.services` is present — if no services are injected, the agent responds conversationally without action capability.

### Modified processMessage Flow

```
Route handler calls processMessage(content, { userId, roomId, state })
  → ensureWorld / ensureRoom / ensureEntity
  → getConversationHistory (last 20 messages)
  → buildConversationContext (format as "Role: text" lines)
  → createMemory (store user message)
  → Build prompt:
      1. runProviders(state) → [Current state context] block
      2. dynamicContext (backward compat, if still passed)
      3. buildActionDescriptions(state) → [Available Actions] block (only if state.services exists)
      4. Conversation history
      5. "User: {content}\n\nRespond to the user's latest message."
  → runtime.generateText(prompt, { maxTokens: 1000 })
  → parseActionInvocation(response) → if match:
      → executeAction(name, params, state)
      → Strip [ACTION:...] tag from response
      → Append action result text
  → createMemory (store assistant response, with action metadata if executed)
  → Return ElizaMessage { role, content, timestamp, metadata }
```

### Backward Compatibility

- The `dynamicContext` parameter on `processMessage` is marked `@deprecated` but still works. If passed alongside `state`, both are included in the prompt (provider context first, then dynamicContext).
- Existing call sites in `chat.ts`, `avatars.ts`, `agent-gateway.ts`, and `openclaw.ts` continue to pass `dynamicContext` and work unchanged. They will be migrated to pass `state` objects in a follow-up cleanup.

### Route Cleanup (Pending)

The following manual `dynamicContext` building blocks can be removed once call sites pass `state` objects:

| File | Lines to Remove | Replaced By |
|---|---|---|
| `apps/api/src/routes/chat.ts` | ~30 lines (visitor avatar, shop items, theme, collab) | `AvatarStateProvider`, `WorldStateProvider`, `InventoryProvider` |
| `apps/api/src/routes/avatars.ts` | ~25 lines (token balance, knowledge count, NPC state) | `AvatarStateProvider`, `KnowledgeProvider`, `WorldStateProvider` |
| `apps/api/src/routes/agent-gateway.ts` | ~5 lines (identity context) | `AvatarStateProvider` |
| `apps/api/src/routes/openclaw.ts` | ~15 lines (archetype, tokens, knowledge) | `AvatarStateProvider`, `KnowledgeProvider` |

### What Phase 1 Unlocks

- **P2:** External agents (Milady/OpenClaw/Hermes) can autonomously navigate, buy items, learn skills — not just chat
- **P3:** Agents can browse and purchase bazaar listings conversationally ("buy the cheapest cron-job skill")
- **P4:** All actions land on the leaderboard — actions generate XP + activity feed entries
- Agents become transactors, not just talkers

---

## Section 3: Phase 2 — Knowledge/RAG (Planned)

### Problem

Learned skills go into `characterConfig.knowledge[]` — a flat string array in a JSONB column on the `avatars` table. The entire array is prompt-stuffed into every turn via `convertToElizaCharacter()`. This works for 5-10 skills but degrades at 30+ as the context window fills with irrelevant knowledge entries.

### Solution

Embed knowledge entries via the OpenAI embedding provider (`text-embedding-3-small`, 1536 dimensions) and store them in the ElizaOS `memories` table with `tableName: 'knowledge'`. At query time, retrieve only the top-K relevant entries via vector similarity.

### Changes Required

| File | Change |
|---|---|
| `apps/api/src/routes/items.ts` POST /learn | Instead of appending to JSONB array, embed the knowledge text and write to `memories` table via runtime |
| `packages/agent-runtime/src/providers/knowledge.ts` | Upgrade from "count + last 5 names" to vector similarity query against `memories` table |
| `packages/agent-runtime/src/eliza-runtime.ts` | Stop dumping `knowledge[]` into the prompt; `KnowledgeProvider` handles retrieval |

No schema migration is needed — the `memories` table already exists via `@elizaos/plugin-sql` with vector column support.

### What Phase 2 Unlocks

- **P3:** Skills bought on the bazaar become genuinely useful — the avatar applies relevant knowledge per-conversation-turn instead of dumping everything
- **P2:** Agents with 100+ skills respond just as fast as those with 3
- Scaling: knowledge storage is limited only by Postgres capacity, not context window

### Dependencies

Phase 1 `KnowledgeProvider` must exist first.

---

## Section 4: Phase 3 — Autonomy Loop (Planned)

### Problem

Avatar autonomous mode is a thin custom stub. The `SimulationRuntime` handles movement/sleep via 4 hardcoded actions, but the avatar's goals are random. There is no goal planning, no spending strategy, no learning progression.

### Solution

Enable ElizaOS's built-in autonomy self-loop on the avatar runtime. The loop wakes the avatar on a configurable interval and uses the full Provider + Action stack from Phase 1.

### Autonomy Cycle

```
Wake (every 60s, configurable per avatar)
  → Providers inject context (AvatarState, WorldState, Inventory, Quest, Knowledge)
  → LLM evaluates available Actions
  → Picks one: VISIT_BUILDING(salvage-workshop)
  → Handler executes: avatar moves to building, enters
  → Next wake: "I'm at Salvage Workshop, 2 books available"
  → Picks: BUY_ITEM(tool-building-basics) → deducts tokens, adds to inventory
  → Next wake: "tool-building-basics in inventory, unread"
  → Picks: LEARN_SKILL(tool-building-basics) → knowledge embedded via Phase 2 RAG
```

### Safety Controls

- **Autonomy budget:** Max ClawToken spend per session, max purchases per hour
- **Action filtering:** Only "autonomous-safe" actions in auto mode (no bazaar trading unless user opts in)
- **User override:** Heartbeat reports user activity → avatar snaps back to user control immediately
- **Frontend sync:** Autonomy state pushed via heartbeat/SSE so 3D world shows avatar moving + acting in real time

### What Phase 3 Unlocks

- **P4:** Gamified loop where avatars autonomously explore, learn, earn, trade — visible in the 3D world
- **P2:** External agents run autonomously without human direction — connect, explore, learn, disconnect
- **P3:** Autonomous agents can discover and purchase skills on the bazaar without human prompting

### Dependencies

Phase 1 Actions, Phase 2 Knowledge/RAG.

---

## Section 5: Phase 4 — Cross-Agent Action Sharing (Speculative)

External agents connecting via `/api/agent/connect` will get the same Action set as avatars. Combined with SKILL.md knowledge from `/api/skills/*` (11 buildings, served from the `building_skills` table), a Milady agent could run this sequence autonomously:

1. `POST /api/agent/connect` → get NPC slot + avatar + wallet
2. `VISIT_BUILDING(code-development)` → enter Hydrothermal Forge
3. `BUY_ITEM(hydrothermal-guide)` → purchase book (debits ClawTokens)
4. `LEARN_SKILL(hydrothermal-guide)` → knowledge embedded via RAG
5. `LIST_BUILDINGS` → see all 10 buildings with distances
6. `BUY_BAZAAR_LISTING(cheap-cron-skill)` → purchase from another agent
7. Navigate the entire world autonomously via the autonomy loop

This turns ClawVille from "a game agents can chat in" into "an economy agents can transact in." The public agent gateway supports exactly four identities: Milady, Hermes, OpenClaw, and the general `custom` OpenAI-compatible-gateway path. Hatcher remains available only through its partner-signed registration surface. Identity names and wire protocols are separate: routing follows the per-agent gateway/hosting facts.

### Dependencies

Phase 1 Actions, Phase 2 Knowledge/RAG, Phase 3 Autonomy.

---

## Section 6: File Map

### Existing Files (ElizaOS integration)

| File | Purpose |
|---|---|
| `packages/agent-runtime/src/eliza-runtime.ts` | Core wrapper: `ElizaRuntime` class, `processMessage`, character building, plugin loading, init mutex |
| `packages/agent-runtime/src/index.ts` | Barrel exports for the package |
| `packages/agent-runtime/src/character-loader.ts` | Loads location templates, merges customizations |
| `packages/agent-runtime/src/plugins/openai-text-provider.ts` | TEXT_SMALL/TEXT_LARGE via OpenAI REST — `gpt-4o-mini`/`gpt-4o` (priority 95) |
| `packages/agent-runtime/src/plugins/openai-embedding-provider.ts` | TEXT_EMBEDDING via OpenAI REST — `text-embedding-3-small`, 1536-dim (priority 100) |
| `packages/agent-runtime/src/plugins/openclaw-provider.ts` | TEXT_SMALL/TEXT_LARGE via external OpenClaw gateway (priority 100) |
| `packages/agent-runtime/src/simulation/simulation-runtime.ts` | Autonomous avatar simulation wrapper with 4 actions + 1 provider |
| `packages/agent-runtime/src/simulation/avatar-state-store.ts` | In-memory avatar state for simulation |
| `packages/agent-runtime/src/simulation/movement.ts` | Pure movement/pathfinding helpers |
| `packages/agent-runtime/src/simulation/actions/avatar-move-to-building.ts` | Simulation action: compute path to building |
| `packages/agent-runtime/src/simulation/actions/avatar-visit-building.ts` | Simulation action: enter building, set activity |
| `packages/agent-runtime/src/simulation/actions/avatar-return-home.ts` | Simulation action: return to spawn |
| `packages/agent-runtime/src/simulation/actions/avatar-sleep.ts` | Simulation action: enter sleep state |
| `packages/agent-runtime/src/simulation/providers/avatar-world-state.ts` | Simulation provider: per-avatar context for LLM planner |
| `packages/agent-runtime/src/collaboration/collaboration-broker.ts` | Cross-building consultation broker |
| `packages/agent-runtime/src/collaboration/building-runtime-registry.ts` | Maps building IDs to runtime instances |
| `apps/api/src/services/agent-orchestrator.ts` | Singleton managing runtime lifecycle (lazy-start, 30min timeout) |
| `apps/api/src/services/npc-conversation-engine.ts` | Direct OpenAI REST for NPC banter (no ElizaOS) |
| `apps/api/src/services/memory-service.ts` | Keyword-based NPC memory (separate from ElizaOS memories) |
| `apps/api/src/routes/chat.ts` | Location NPC chat (processMessage call site 1) |
| `apps/api/src/routes/avatars.ts` | Avatar chat (processMessage call site 2) |
| `apps/api/src/routes/agent-gateway.ts` | Agent gateway chat (processMessage call site 3a) |
| `apps/api/src/routes/openclaw.ts` | OpenClaw chat (processMessage call site 3b, 3c) |
| `apps/api/src/routes/items.ts` | Shop/buy/learn routes (knowledge → JSONB) |
| `apps/api/src/routes/bazaar.ts` | Skill marketplace listings |
| `apps/api/src/routes/quests.ts` | Quest accept/progress/complete |
| `apps/api/src/routes/bounties.ts` | Bounty claim/reward |
| `apps/api/src/routes/skills.ts` | Public SKILL.md serving for external agents |
| `apps/api/src/services/claw-token-ledger.ts` | Atomic ClawToken credit/debit with audit trail |

### Phase 1 New Files

| File | Purpose |
|---|---|
| `packages/agent-runtime/src/plugins/clawville-plugin.ts` | Plugin export aggregating all actions + providers |
| `packages/agent-runtime/src/actions/visit-building.ts` | Action: enter a building by name |
| `packages/agent-runtime/src/actions/buy-item.ts` | Action: purchase a knowledge book |
| `packages/agent-runtime/src/actions/learn-skill.ts` | Action: read book → merge knowledge |
| `packages/agent-runtime/src/actions/check-balance.ts` | Action: report ClawToken balance + inventory summary |
| `packages/agent-runtime/src/actions/list-buildings.ts` | Action: list all 10 buildings with distance |
| `packages/agent-runtime/src/actions/buy-bazaar-listing.ts` | Action: purchase a bazaar skill listing |
| `packages/agent-runtime/src/actions/accept-quest.ts` | Action: accept an available quest |
| `packages/agent-runtime/src/actions/claim-bounty.ts` | Action: claim a bounty |
| `packages/agent-runtime/src/actions/types.ts` | `Action`, `ActionResult`, `ClawvilleServices`, `ClawvilleActionState` interfaces + `hasServices()` guard |
| `packages/agent-runtime/src/actions/index.ts` | Barrel export for all 8 actions |
| `packages/agent-runtime/src/providers/avatar-state.ts` | Provider: avatar name, species, level, tokens, stats |
| `packages/agent-runtime/src/providers/world-state.ts` | Provider: current building, nearby buildings, NPC activity |
| `packages/agent-runtime/src/providers/inventory.ts` | Provider: owned items grouped by type |
| `packages/agent-runtime/src/providers/quest.ts` | Provider: active quests, available quests |
| `packages/agent-runtime/src/providers/knowledge.ts` | Provider: learned skills summary |
| `packages/agent-runtime/src/providers/types.ts` | `Provider`, `ProviderResult` interfaces (local mirror of ElizaOS v2 types) |
| `packages/agent-runtime/src/providers/index.ts` | Barrel export for all 5 providers |

### Phase 2 Changes

| File | Change |
|---|---|
| `apps/api/src/routes/items.ts` | POST /learn writes to `memories` table instead of JSONB |
| `packages/agent-runtime/src/providers/knowledge.ts` | Vector similarity query replaces array dump |
| `packages/agent-runtime/src/eliza-runtime.ts` | Remove `knowledge[]` from prompt construction |

### Phase 3 Changes

| File | Change |
|---|---|
| `packages/agent-runtime/src/eliza-runtime.ts` | Enable autonomy self-loop timer, add budget config |
| `packages/agent-runtime/src/simulation/simulation-runtime.ts` | Merge with chat actions — single unified action set |
| `apps/api/src/routes/avatars.ts` | Autonomy state endpoint, budget config |
| `apps/web/src/stores/autonomy-store.ts` | Frontend state for autonomy toggle + budget |

---

## Section 7: Priority Matrix

Each cell indicates how the Phase relates to the project's 4 equal-weight priorities.

| Phase | P1: Milady App Store | P2: Open Agent Onboarding | P3: Skill Marketplace | P4: Gamified UI + Leaderboard |
|---|---|---|---|---|
| **Phase 1: Actions + Providers** | enables | direct | direct | direct |
| **Phase 2: Knowledge/RAG** | neutral | enables | direct | enables |
| **Phase 3: Autonomy Loop** | enables | direct | enables | direct |
| **Phase 4: Cross-Agent Actions** | direct | direct | direct | direct |

**Legend:**
- `direct` — directly advances this priority
- `enables` — unblocks downstream work that advances this priority
- `neutral` — no significant impact

**Reading the matrix:**
- Phase 1 is the critical path — it `direct`ly advances P2/P3/P4 and `enables` P1 (Milady agents need actions to be useful in ClawVille)
- Phase 4 is the only phase that `direct`ly advances all four priorities simultaneously
- No phase harms any priority — the integration is additive

---

## Decision Log

### D1: Why we bypass ElizaOS's `message.ts` pipeline

ElizaOS v2's `message.ts` pipeline includes should-respond classification, evaluators, action planning with LLM-driven selection, and autonomous continuation. For a game where agents should always respond and action selection needs to be deterministic (price checks, token balance queries), this pipeline adds latency and unpredictability. Our lightweight dispatch (`[ACTION: name(params)]` parsing) gives us action capability without the overhead of the full pipeline.

**Trade-off:** We lose the sophisticated multi-action planning and evaluator feedback loops. This is acceptable because game actions are discrete operations, not complex multi-step reasoning tasks.

### D2: Why custom Providers instead of ElizaOS's built-in provider system

ElizaOS v2 Providers are registered on the runtime and called during `composeState()`. Since we bypass `message.ts`, `composeState()` is never called in our flow. Rather than wiring back into the full pipeline (which would require accepting D1's trade-offs), we run providers manually in `processMessage` and inject their output as context strings. The Provider interface (`get() → { text, values, data }`) is still used for compatibility — we just call it ourselves.

### D3: Why service injection instead of direct imports

Actions in `packages/agent-runtime` cannot import from `apps/api` (monorepo dependency direction: packages are consumed by apps, not the reverse). Rather than moving service code into the package (which would pull in database imports and break the clean layering), we inject service functions via `state.services` at call time. The `ClawvilleServices` interface defines the contract (`db`, `creditClawTokens`, `debitClawTokens`), and the `hasServices()` type-guard validates all three before any mutating action runs. Actions DO import `@clawville/database` dynamically (for table references and query helpers like `eq`, `and`, `sql`), but the actual Drizzle query builder instance comes from the injected `db` — this avoids creating a second database connection pool.

### D4: Why NPC banter bypasses ElizaOS entirely

NPC ambient conversation (`npc-conversation-engine.ts`) is fire-and-forget chat with no memory, no personality persistence, and no action capability needed. Running it through ElizaOS would mean: creating a runtime per NPC pair (resource cost), storing memories that are never queried (storage cost), and accepting 2-3x latency from the plugin chain. Direct OpenAI REST at temperature 0.9 with 400 max tokens is the right tool for throwaway banter.

### D5: Why Phase 2 uses ElizaOS memories table instead of a separate vector store

The `memories` table created by `@elizaos/plugin-sql` already has vector column support and is managed by the same Postgres instance we use for everything else. Adding a separate vector store (Pinecone, Weaviate, LanceDB) would introduce an operational dependency, a new failure mode, and a sync problem between the vector store and the relational data. Using the existing table means zero new infrastructure.

### D6: Why `actionPlanning: false` on all game runtimes

ElizaOS v2 supports `actionPlanning: true` for multi-action-per-response workflows. The source code comment notes this is a "performance optimization useful for game situations where state updates with every action." Single-action-per-response is correct for ClawVille because each game action mutates state (token balance, inventory, position) and subsequent actions need to see the updated state. Multi-action planning would execute on stale state.

### D7: Why `[ACTION: NAME(params)]` text-tag dispatch instead of structured tool-calling

The LLM signals action invocation by embedding `[ACTION: VISIT_BUILDING(buildingId=code-development)]` in its natural-language response. We parse this with a single regex (`/\[ACTION:\s*(\w+)\(([^)]*)\)\]/`). Alternatives considered:

- **Function calling / tool-use (OpenAI native):** Would require a second LLM call to re-generate the conversational response after the tool result, doubling latency and cost. The text-tag approach generates conversation + action in one shot.
- **JSON response format:** Would force the entire response into structured JSON, losing natural conversational flow. Game agents need to sound like characters, not APIs.
- **ElizaOS's built-in action selector:** Would require un-bypassing `message.ts` (see D1).

The text-tag format is stripped from the final user-visible response and the action result is appended, so the user sees a clean conversational message followed by the action outcome.

### D8: Why providers are state-readers, not DB-queriers

All 5 providers read from pre-populated `state.*` properties (e.g., `state.avatarData`, `state.worldSnapshot`, `state.inventory`) rather than querying the database directly. The API route handler fetches this data before calling `processMessage()`. This keeps providers pure data formatters with no side effects, makes them trivially testable, avoids N+1 query problems (one DB round-trip in the route vs. 5 separate queries in providers), and prevents providers from needing the Drizzle `db` instance.
