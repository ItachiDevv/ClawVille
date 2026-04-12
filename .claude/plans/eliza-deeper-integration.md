# ElizaOS Deeper Integration — Actions + Providers + Knowledge/RAG + Autonomy

Created: 2026-04-12
Status: Phase 1 in progress

## Problem

ClawVille uses ~20% of ElizaOS's surface area. Every processMessage call is a
raw `runtime.generateText()` — the agents can only TALK, never DO. Context is
injected as a manually-concatenated `dynamicContext` string, knowledge is
prompt-stuffed from a flat JSONB array, and autonomous mode is a thin
custom stub.

## Solution — 4 phases

### Phase 1: Actions + Providers (this sprint)

**Actions** — wrap top game operations as ElizaOS Actions registered on the
ClawVille plugin. The LLM can pick from available actions mid-conversation,
execute the operation server-side, and report the result.

Actions to implement:
- `VISIT_BUILDING` — enter a building by name
- `BUY_ITEM` — purchase a knowledge book from a building's shop
- `LEARN_SKILL` — read a skill from inventory → merge knowledge into character
- `CHECK_BALANCE` — report NeoToken balance + inventory summary
- `LIST_BUILDINGS` — list all 10 buildings with current distance
- `BUY_BAZAAR_LISTING` — purchase a skill listing from the bazaar
- `ACCEPT_QUEST` — accept an available quest
- `CLAIM_BOUNTY` — claim a bounty

Each action wraps existing service-layer code — NO new API routes needed.
The action handler calls the same DB queries the HTTP route does.

**Providers** — replace manual dynamicContext string concatenation with
composable ElizaOS Providers. Each provider returns a focused slice of
context, and the runtime composes them automatically.

Providers to implement:
- `PetStateProvider` — name, species, level, NeoTokens, HP, stats, streak
- `WorldStateProvider` — current building, nearby buildings + distance, pet
  position, time of day
- `InventoryProvider` — owned items grouped by type (books, skills)
- `QuestProvider` — active quests, progress, available quests at location
- `KnowledgeProvider` — summary of learned skills (count + last 5 names)

**Runtime modifications** — modify ElizaRuntime.processMessage to:
1. Call all Providers to assemble context (replaces dynamicContext param)
2. Include action descriptions in the system prompt so the LLM can invoke them
3. Parse the LLM response for action invocations (using a `[ACTION: name(params)]` format)
4. Execute the action handler if invoked
5. Re-generate final response incorporating the action result

**Route cleanup** — remove manual dynamicContext building from:
- `apps/api/src/routes/chat.ts` (location chat)
- `apps/api/src/routes/pets.ts` (pet chat)
- `apps/api/src/routes/agent-gateway.ts` (external agents)
- `apps/api/src/routes/openclaw.ts` (openclaw agents)

### Phase 2: Knowledge/RAG (follow-up sprint)

**Problem:** Learned skills go into `characterConfig.knowledge[]` (plain
string array in JSONB). The entire array is prompt-stuffed into every turn.
This works for 5-10 skills but breaks at 30+ as context window fills up.

**Solution:** Embed knowledge entries via our existing Gemini embedding
provider (`text-embedding-004`), store in ElizaOS's memory table
(`memories` with `tableName: 'knowledge'`), and at query time retrieve
only the top-K relevant entries via vector similarity.

Changes needed:
- `apps/api/src/routes/items.ts` POST /learn — instead of appending to
  JSONB, embed the knowledge text and write to the memories table
- `KnowledgeProvider` (from Phase 1) — queries memories table by vector
  similarity instead of reading from characterConfig
- `packages/agent-runtime/src/eliza-runtime.ts` — no longer dumps
  `knowledge[]` into the prompt; the KnowledgeProvider handles retrieval
- Schema: no migration needed — `memories` table already exists via
  `@elizaos/plugin-sql`

Dependencies: Phase 1 Providers must exist first (KnowledgeProvider)

### Phase 3: Autonomy Loop (follow-up sprint)

**Problem:** Pet autonomous mode (`control-mode-toggle.tsx` →
`useAutonomyStore`) is a thin stub. The pet wanders randomly with no
goal planning. The `SimulationRuntime` in `agent-runtime` has actions/
and providers/ subdirectories but they're mostly placeholder.

**Solution:** Use ElizaOS's built-in autonomy self-loop to periodically
wake the pet, evaluate its state via Providers, and pick an Action:

```
Wake (every 60s) → Providers inject context → LLM evaluates:
  "I have 200 NT, 4 skills, haven't visited Salvage Workshop"
→ Picks ACTION: VISIT_BUILDING(salvage-workshop)
→ Handler moves pet + enters building
→ Next wake: "I'm in Salvage Workshop, 2 books available"
→ Picks ACTION: BUY_ITEM(tool-building-basics)
→ Handler deducts tokens + adds to inventory
→ Next wake: "I have tool-building-basics in inventory"
→ Picks ACTION: LEARN_SKILL(tool-building-basics)
→ Knowledge embedded via Phase 2 RAG
```

Changes needed:
- Enable the ElizaOS autonomy loop timer on the pet runtime
- Configure loop interval (60s default, configurable via pet settings)
- Filter available Actions to the "autonomous-safe" subset (no bazaar
  trading in auto mode unless the user explicitly opts in)
- Wire autonomy state back to the frontend via the heartbeat/SSE channel
  so the 3D world shows the pet moving + acting in real time
- Add an "autonomy budget" (max tokens per session, max purchases) to
  prevent runaway spending

Dependencies: Phase 1 Actions must exist first

### Phase 4: Cross-agent action sharing (speculative)

Agents connected via the gateway (Milady/OpenClaw/Hermes) get access to
the same Action set as pets. Combined with SKILL.md knowledge from
`/api/skills/*`, an external agent could autonomously:
1. Connect via `/api/agent/connect`
2. Navigate buildings via VISIT_BUILDING
3. Learn skills via BUY_ITEM + LEARN_SKILL
4. List skills on the bazaar via BUY_BAZAAR_LISTING
5. Accept quests and claim bounties

This turns ClawVille from "a game agents can chat in" into "an economy
agents can transact in" — directly advancing P2 and P3.

Dependencies: Phase 1 Actions + Phase 2 Knowledge/RAG

## File layout

```
packages/agent-runtime/src/
  eliza-runtime.ts           ← MODIFIED (processMessage action+provider loop)
  plugins/
    gemini-text-provider.ts  ← EXISTING (unchanged)
    gemini-embedding-provider.ts ← EXISTING (unchanged)
    openclaw-provider.ts     ← EXISTING (unchanged)
    clawville-plugin.ts      ← NEW (Plugin export aggregating actions+providers)
  actions/
    visit-building.ts        ← NEW
    buy-item.ts              ← NEW
    learn-skill.ts           ← NEW
    check-balance.ts         ← NEW
    list-buildings.ts        ← NEW
    buy-bazaar-listing.ts    ← NEW
    accept-quest.ts          ← NEW
    claim-bounty.ts          ← NEW
    index.ts                 ← NEW (barrel export)
  providers/
    pet-state.ts             ← NEW
    world-state.ts           ← NEW
    inventory.ts             ← NEW
    quest.ts                 ← NEW
    knowledge.ts             ← NEW
    index.ts                 ← NEW (barrel export)
```

## Contracts

### Action contract (from ElizaOS v2 @elizaos/core)

```typescript
interface Action {
  name: string;
  description: string;
  similes?: string[];
  examples?: ActionExample[][];
  handler: Handler;
  validate: Validator;
  parameters?: ActionParameter[];
  suppressPostActionContinuation?: boolean;
}
```

### Provider contract (from ElizaOS v2 @elizaos/core)

```typescript
interface Provider {
  name: string;
  description?: string;
  position?: number;  // ordering in the context string
  get(runtime, message, state): Promise<ProviderResult>;
}

interface ProviderResult {
  text?: string;       // human-readable, goes into prompt
  values?: Record<string, ProviderValue>;  // template vars
  data?: ProviderDataRecord;  // structured data
}
```

### Action dispatch pattern (our implementation)

Since our processMessage bypasses ElizaOS's internal message handler, we
implement a lightweight action dispatch within our wrapper:

1. All registered Providers run → produce context strings
2. All registered Actions' `validate()` runs → filters candidates
3. Context + action descriptions + user message → sent to LLM
4. If LLM response contains `[ACTION: name(params)]`, parse and execute
5. Action result text appended to response
6. Final text returned to caller

This avoids rewiring into ElizaOS's complex message.ts pipeline while
still getting the full benefit of Actions and Providers.
