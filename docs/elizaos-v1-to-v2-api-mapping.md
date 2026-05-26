# ElizaOS 1.7.1 → 2.0.0 API Migration Reference

**Target file**: `packages/agent-runtime/src/eliza-runtime.ts`
**Source of truth**: `elizaOS/eliza` repo, `v2.0.0` branch (tag: `v2.0.0-alpha.118` on `develop`; `v2.0.0-alpha.2` tagged on `v2.0.0` branch at time of writing)
**Core package still published as**: `@elizaos/core` (source moved from `packages/core/` → `packages/typescript/`)

---

## 0. Repo layout changes (context for the migration)

| Aspect                     | 1.7.1                              | 2.0.0                                                                                    |
| -------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| Core source location       | `packages/core/src/`               | `packages/typescript/src/`                                                               |
| Core npm package name      | `@elizaos/core`                    | `@elizaos/core` (unchanged)                                                              |
| Plugin directory           | `packages/plugin-*`                | `plugins/plugin-*` (root-level), plus `plugin-sql/` at root                              |
| `plugin-bootstrap` package | `@elizaos/plugin-bootstrap` on npm | **GONE** — integrated into `@elizaos/core`; auto-registered by `AgentRuntime.initialize` |

Source-tree evidence:
- Core types: `packages/typescript/src/types/{primitives,memory,model,plugin,runtime,database,environment,agent}.ts`
- Runtime class: `packages/typescript/src/runtime.ts`
- Bootstrap (now internal): `packages/typescript/src/bootstrap/index.ts`

---

## 1. Class import

**1.7.1**
```ts
import { AgentRuntime as ElizaAgentRuntime } from '@elizaos/core';
```

**2.0.0**
```ts
import { AgentRuntime } from '@elizaos/core';
```

**Notes**
- Class name is unchanged. The `as ElizaAgentRuntime` alias is still optional.
- Package name is unchanged. Only the monorepo source path moved.

---

## 2. Constructor signature

**1.7.1**
```ts
new ElizaAgentRuntime({
  agentId,
  character,
  plugins,
  settings: {
    ANTHROPIC_API_KEY: ...,
    OPENAI_API_KEY: ...,
    POSTGRES_URL: ...,
  },
});
```

**2.0.0** — from `packages/typescript/src/runtime.ts`:
```ts
constructor(opts: {
  conversationLength?: number;
  agentId?: UUID;
  character?: Character;
  plugins?: Plugin[];
  fetch?: typeof fetch;
  adapter: IDatabaseAdapter;           // REQUIRED — new
  settings?: RuntimeSettings;
  allAvailablePlugins?: Plugin[];
  logLevel?: 'trace'|'debug'|'info'|'warn'|'error'|'fatal';
  disableBasicCapabilities?: boolean;
  enableExtendedCapabilities?: boolean;
  advancedCapabilities?: boolean;
  actionPlanning?: boolean;
  llmMode?: LLMModeType;
  checkShouldRespond?: boolean;
  enableAutonomy?: boolean;
  serverless?: boolean;
  companionUrl?: string;
} = {})
```

**Migration notes**
- **`adapter: IDatabaseAdapter` is now REQUIRED** on the constructor. In 1.7.1 this was lazily loaded via `@elizaos/plugin-sql`. In 2.0.0 you must construct and pass an adapter explicitly — e.g. `new PgliteDatabaseAdapter(...)` or `new DrizzleDatabaseAdapter(...)` from the SQL store modules. **UNCLEAR — would need to inspect source** for the exact PG adapter class name in v2 (the `plugin-sql/typescript/stores` directory at root only contains `participant.store.ts`, suggesting the adapter has been absorbed elsewhere; check `packages/typescript/src/database/`).
- `settings` is still accepted, but **API keys should now go on `character.secrets`**, not runtime `settings`. See #15.
- New flags you may want to set deliberately: `disableBasicCapabilities`, `enableExtendedCapabilities`, `advancedCapabilities`, `enableAutonomy`, `serverless`. Default (all undefined) = basic capabilities on, everything else off.
- `agentId` is now optional (was required). If omitted the runtime derives it from `character.id`.

---

## 3. `initialize()`

**1.7.1**
```ts
await this.runtime.initialize();
```

**2.0.0**
```ts
await this.runtime.initialize();
```

**Migration notes**
- Same signature: `initialize(): Promise<void>`.
- **Behavioral change**: v2 `initialize()` auto-registers the bootstrap plugin from `packages/typescript/src/bootstrap/index.ts`. The inline comment in the source states:
  > "Bootstrap plugin is now built into core and auto-registered during runtime initialization. External code should NOT import or use bootstrapPlugin directly."
- This means removing `@elizaos/plugin-bootstrap` from your plugin list in 2.0.0 is not just optional — it's required. See #14.

---

## 4. `stop()`

**1.7.1 and 2.0.0** — identical.
```ts
stop(): Promise<void>;
```

No migration needed.

---

## 5. `ensureWorldExists`

**1.7.1**
```ts
await this.runtime.ensureWorldExists({
  id: worldId,
  name: `agent-${this.config.agentId}`,
  agentId: worldId,
});
```

**2.0.0** — from `IAgentRuntime` in `types/runtime.ts`:
```ts
ensureWorldExists(world: World): Promise<void>;
```

where `World` extends the proto-generated `ProtoWorld` and includes `messageServerId` as a new field (based on runtime.ts constructor internals that reference `ensureWorldExists({ id, name, messageServerId, metadata })`).

**Migration notes**
- Method name unchanged.
- The `World` object shape is now proto-derived. You likely need to add `messageServerId?: UUID` and `metadata?: WorldMetadata`. **UNCLEAR — would need to inspect `types/environment.ts` proto imports** to get the exact required vs optional field list.
- `ensureConnection()` is an alternative **one-shot** that creates entity + room + world in a single call (see #6/#7/#8). For a clean migration it's cleaner to replace your 3-step `ensureWorld` + `ensureRoom` + `ensureEntity` dance with a single `ensureConnection()`.

---

## 6. `createRoom` + `ChannelType.API`

**1.7.1**
```ts
await this.runtime.createRoom({
  id: roomId,
  name: `chat-${userId}`,
  source: 'api',
  type: ChannelType.API,
  channelId: roomId,
  worldId,
});
```

**2.0.0** — from `IAgentRuntime`:
```ts
createRoom({
  id,
  name,
  source,
  type,
  channelId,
  messageServerId,   // NEW
  worldId,
}: Room): Promise<UUID>;
```

**`ChannelType` in 2.0.0** — from `packages/typescript/src/types/primitives.ts`:
```ts
export const ChannelType = {
  SELF: 'SELF',
  DM: 'DM',
  GROUP: 'GROUP',
  VOICE_DM: 'VOICE_DM',
  VOICE_GROUP: 'VOICE_GROUP',
  FEED: 'FEED',
  THREAD: 'THREAD',
  WORLD: 'WORLD',
  FORUM: 'FORUM',
  API: 'API',
} as const;
export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType];
```

**Migration notes**
- **`ChannelType.API` is NOT deprecated in the v2.0.0 branch source.** It is still a valid member. Your earlier notes were incorrect on this point, or the deprecation only lives on `develop`/alpha.118. On the `v2.0.0` branch at `v2.0.0-alpha.2`, `API` is present with no deprecation annotation.
- **Structural change**: `ChannelType` is now a `const` object, not a TypeScript `enum`. The import statement (`import { ChannelType } from '@elizaos/core'`) still works, but downstream tooling that relied on enum reflection will behave slightly differently.
- **New field**: `createRoom` accepts `messageServerId?: UUID`. Required-ness depends on proto defaults — **UNCLEAR — inspect `types/environment.ts` for Room proto**.
- Internally the v2 runtime calls `this.adapter.createRooms([...])` (plural, batched). `createRoom` on the runtime is a convenience wrapper.
- Recommended: replace manual `createRoom` + `createEntity` + `ensureWorldExists` with a single `ensureConnection()` call (see #5).

---

## 7. `getRoom(roomId)`

**1.7.1 and 2.0.0** — identical.
```ts
getRoom(roomId: UUID): Promise<Room | null>;
```

No migration needed, but note that the returned `Room` object in v2 extends proto types and may have additional fields.

---

## 8. `createEntity`

**1.7.1**
```ts
await this.runtime.createEntity({
  id: entityId,
  agentId,
  names: ['user'],
  metadata: { source: 'api' },
});
```

**2.0.0** — from `IAgentRuntime`:
```ts
createEntity(entity: Entity): Promise<boolean>;
```

where `Entity` is:
```ts
export interface Entity extends Omit<ProtoEntity, '$typeName'|'$unknown'|'metadata'|'components'> {
  metadata?: Metadata;
  components?: Component[];
}
```

**Migration notes**
- Return type changed from `void` → `Promise<boolean>`. You may want to check the return value for idempotent create semantics.
- Field shape `{ id, agentId, names, metadata }` still works (fields come from `ProtoEntity`).
- **New optional field**: `components?: Component[]`.

---

## 9. `getEntityById(entityId)`

**1.7.1 and 2.0.0** — identical.
```ts
getEntityById(entityId: UUID): Promise<Entity | null>;
```

No migration needed.

---

## 10. `getMemories`

**1.7.1**
```ts
await this.runtime.getMemories({
  roomId,
  count: limit,
  tableName: 'messages',
});
```

**2.0.0** — from `IDatabaseAdapter` in `types/database.ts`:
```ts
getMemories(params: {
  entityId?: UUID;
  agentId?: UUID;
  /** @deprecated use limit */
  count?: number;
  limit?: number;                 // NEW — preferred
  offset?: number;                // NEW
  unique?: boolean;
  tableName: string;              // still required
  start?: number;
  end?: number;
  roomId?: UUID;
  worldId?: UUID;                 // NEW
  metadata?: Record<string, unknown>;  // NEW
  orderBy?: 'createdAt';          // NEW
  orderDirection?: 'asc' | 'desc'; // NEW
}): Promise<Memory[]>;
```

**Migration notes**
- `tableName: 'messages'` is **still required** and still accepted. Your v2 notes about filtering by `MemoryType.MESSAGE` via a `type` field are **incorrect** for `getMemories` — that filtering would need to happen client-side via `memory.metadata.type`.
- Rename `count` → `limit` (count still works but emits a deprecation warning).
- New sort/pagination options: `offset`, `orderBy`, `orderDirection`.
- `MemoryType` still exists (`document|fragment|message|description|custom`) but it's used to TAG memories inside `memory.metadata.type`, not to filter at the adapter level.

---

## 11. `createMemory`

**1.7.1**
```ts
await this.runtime.createMemory(
  {
    id: userMemoryId,
    agentId, entityId, roomId,
    content: { text, source: 'api' },
    createdAt: Date.now(),
    metadata: { type: 'message', source: 'api' },
  },
  'messages'  // second arg: tableName
);
```

**2.0.0** — from `IAgentRuntime`:
```ts
createMemory(memory: Memory, tableName: string, unique?: boolean): Promise<UUID>;
```

**Memory shape in 2.0.0** (`packages/typescript/src/types/memory.ts`):
```ts
export interface Memory extends Omit<ProtoMemory,
  '$typeName'|'$unknown'|'id'|'createdAt'|'embedding'|'metadata'|'content'
> {
  id?: UUID;
  createdAt?: number;
  embedding?: number[];
  metadata?: MemoryMetadata;
  content: Content;
  sessionId?: string;   // NEW
  sessionKey?: string;  // NEW
}
```

**Migration notes**
- **Second arg `tableName: string` is RETAINED** in v2. Your notes suggested this was replaced by `MemoryType` — that's **incorrect**. `tableName` still exists; `MemoryType` is a metadata field for categorizing what's inside the memory (document vs fragment vs message etc).
- New optional third arg: `unique?: boolean` — when true, dedupes by embedding similarity.
- Return type changed from `void` (or unknown) → `Promise<UUID>` — returns the created memory ID.
- New fields: `sessionId`, `sessionKey` for session-scoped memories.
- Fields `entityId`, `agentId`, `roomId`, `worldId` come from `ProtoMemory` and still work identically.
- **MemoryMetadata is now a discriminated union** of `DocumentMetadata | FragmentMetadata | MessageMetadata | DescriptionMetadata | CustomMetadata`. Your current literal `metadata: { type: 'message', source: 'api' }` should still type-check under `MessageMetadata` but may need a cast — **UNCLEAR — would need to inspect `types/memory.ts` for the exact MessageMetadata shape**.

---

## 12. Text generation (`generateText` → `useModel`)

**1.7.1**
```ts
const result = await this.runtime.generateText(promptWithHistory, { maxTokens: 1000 });
// result.text
```

**2.0.0** — both APIs exist, both are on `IAgentRuntime`:

```ts
// Option A: keep using generateText (still supported)
generateText(input: string, options?: GenerateTextOptions): Promise<GenerateTextResult>;

// Option B: useModel (preferred for plugin-level control)
useModel(
  modelType: TextGenerationModelType,   // e.g. ModelType.TEXT_LARGE
  params: GenerateTextParams,
  provider?: string,
): Promise<string>;

useModel<T extends keyof ModelParamsMap, R = ModelResultMap[T]>(
  modelType: T,
  params: ModelParamsMap[T],
  provider?: string,
): Promise<R>;
```

**`GenerateTextParams`** (`types/model.ts`):
```ts
export interface GenerateTextParams extends Omit<ProtoGenerateTextParams,
  '$typeName'|'$unknown'|'responseFormat'|'stopSequences'
> {
  responseFormat?: { type: 'json_object' | 'text' } | string;
  stopSequences?: string[];
  onStreamChunk?: (chunk: string, messageId?: string) => void | Promise<void>;
  user?: string;
  promptSegments?: PromptSegment[];
}
```
Plus whatever `ProtoGenerateTextParams` contributes: `prompt`, `maxTokens`, `temperature`, `modelClass`, etc. **UNCLEAR — would need to inspect the .proto file in `schemas/eliza/v1/*.proto`** for the full field list.

**`ModelType`** (`types/model.ts`):
```ts
export const ModelType = {
  SMALL: 'TEXT_SMALL',
  MEDIUM: 'TEXT_LARGE',
  LARGE: 'TEXT_LARGE',
  TEXT_SMALL: 'TEXT_SMALL',
  TEXT_LARGE: 'TEXT_LARGE',
  TEXT_EMBEDDING: 'TEXT_EMBEDDING',
  TEXT_REASONING_SMALL: 'REASONING_SMALL',
  TEXT_REASONING_LARGE: 'REASONING_LARGE',
  TEXT_COMPLETION: 'TEXT_COMPLETION',
  IMAGE: 'IMAGE',
  IMAGE_DESCRIPTION: 'IMAGE_DESCRIPTION',
  TRANSCRIPTION: 'TRANSCRIPTION',
  TEXT_TO_SPEECH: 'TEXT_TO_SPEECH',
  AUDIO: 'AUDIO',
  VIDEO: 'VIDEO',
  OBJECT_SMALL: 'OBJECT_SMALL',
  OBJECT_LARGE: 'OBJECT_LARGE',
  RESEARCH: 'RESEARCH',
  // ... plus TEXT_TOKENIZER_ENCODE / DECODE
} as const;
```

**`useModel` return type**:
- For text models (`TEXT_SMALL`, `TEXT_LARGE`, etc.) → **`Promise<string>`** — returns the text directly, NOT an object. This is the answer to your question: `useModel` returns `string`, not `{ text: string }`.
- For embeddings → `Promise<number[]>`.
- For object gen → `Promise<Record<string, JsonValue>>`.

**Migration notes**
- **Minimum-diff migration**: keep `generateText(prompt, { maxTokens })` — it's still on `IAgentRuntime`. Your current `result.text` access pattern depends on what `GenerateTextResult` looks like in v2. **UNCLEAR — would need to inspect the GenerateTextResult type definition** (likely `{ text: string; usage?: ...; toolCalls?: ... }`).
- **Cleaner migration**: switch to `useModel(ModelType.TEXT_LARGE, { prompt, maxTokens: 1000 })`. The result is a plain string:
  ```ts
  const text = await this.runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: promptWithHistory,
    maxTokens: 1000,
    temperature: 0.7,  // optional
  });
  // text is a string, not { text }
  ```
- `useModel` takes an optional third `provider?: string` to pin a specific plugin (e.g. `'anthropic'`) when multiple plugins register handlers for the same model type. This replaces the 1.7.1 `priority` hack.

---

## 13. Plugin interface — `models` field shape

**Your notes said**: "v2 Plugin says `models?: Record<string, ModelHandler[]>` (array of handlers)."

**Actual v2.0.0 source** (`packages/typescript/src/types/plugin.ts`):
```ts
export interface Plugin {
  name: string;
  description: string;
  init?: (config: Record<string, string>, runtime: IAgentRuntime) => Promise<void>;
  config?: Record<string, string | number | boolean | null>;
  services?: ServiceClass[];
  componentTypes?: ComponentTypeDefinition[];
  actions?: Action[];
  providers?: Provider[];
  evaluators?: Evaluator[];
  adapter?: AdapterFactory;
  models?: {
    [K in keyof ModelParamsMap]?: (
      runtime: IAgentRuntime,
      params: ModelParamsMap[K],
    ) => Promise<PluginModelResult<K>>;
  };
  events?: PluginEvents;
  routes?: Route[];
  tests?: TestSuite[];
  dependencies?: string[];
  testDependencies?: string[];
  priority?: number;        // still exists
  schema?: Record<string, JsonValue | object>;
}
```

**Answer**: `models` is a **single function per key**, NOT an array. Your notes were **incorrect** on this.

**Also note** — `ModelHandler` as a type DOES exist in v2 but it's a richer object (not the function that plugins register):
```ts
export interface ModelHandler<TParams = ..., TResult = ...> {
  handler: (runtime: IAgentRuntime, params: TParams) => Promise<TResult>;
  provider: string;
  priority?: number;
  registrationOrder?: number;
}
```
This is the internal representation the runtime wraps your plugin's bare function in, stored in a registry keyed by model type. Multiple plugins can each register a function for the same key; the runtime sorts them by `priority` (then `registrationOrder`) and uses the winner — or you can override per-call with `useModel(type, params, 'provider-name')`.

**Migration notes for your Ultrathink / OpenClaw custom providers**
- Your existing pattern of exporting a `Plugin` with `models: { [ModelType.TEXT_LARGE]: handler }` and `priority: 90` **still works unchanged in v2**. The runtime internally upgrades each bare function into a `ModelHandler{ handler, provider: plugin.name, priority: plugin.priority }`.
- Your OpenClaw provider that "wins by priority 100 > 90" still works — priorities are compared across all plugins registered for the same model type.

---

## 14. Plugin package names + `plugin-bootstrap` removal

| Plugin                         | 1.7.1 npm package               | 2.0.0 npm package                          |
| ------------------------------ | ------------------------------- | ------------------------------------------ |
| Anthropic                      | `@elizaos/plugin-anthropic`     | `@elizaos/plugin-anthropic` (unchanged)    |
| OpenAI                         | `@elizaos/plugin-openai`        | `@elizaos/plugin-openai` (unchanged)       |
| Solana                         | `@elizaos/plugin-solana`        | `@elizaos/plugin-solana` (unchanged)       |
| SQL / DB                       | `@elizaos/plugin-sql`           | **UNCLEAR — likely absorbed into `@elizaos/core` as an adapter; inspect `packages/typescript/src/database/`** |
| Bootstrap                      | `@elizaos/plugin-bootstrap`     | **REMOVED** — integrated into `@elizaos/core`, auto-registered by `runtime.initialize()` |

Verified package names:
- `plugins/plugin-anthropic/typescript/package.json` → `"name": "@elizaos/plugin-anthropic"`, `"version": "2.0.0-alpha.2"`
- `plugins/plugin-openai/typescript/package.json` → `"name": "@elizaos/plugin-openai"`, `"version": "2.0.0-alpha.2"`
- `plugins/plugin-solana/typescript/package.json` → `"name": "@elizaos/plugin-solana"`, `"version": "2.0.0-alpha.2"`

**Bootstrap replacement** (`packages/typescript/src/bootstrap/index.ts`):
```ts
export function createBootstrapPlugin(config: CapabilityConfig = {}): Plugin
```
Comment from the source file:
> "Bootstrap plugin is now built into core and auto-registered during runtime initialization. External code should NOT import or use bootstrapPlugin directly."

**Migration steps for your `character.plugins` list**:
1. **Remove** `'@elizaos/plugin-bootstrap'` from the string list — it will fail to `import()` and isn't needed anyway (the runtime auto-registers it).
2. **Remove** `'@elizaos/plugin-sql'` from the string list — v2 requires you to pass an adapter instance directly to the runtime constructor (see #2). Dynamic plugin loading won't work for the SQL layer anymore.
3. Keep `'@elizaos/plugin-anthropic'`, `'@elizaos/plugin-openai'`, `'@elizaos/plugin-solana'` — these still work and still dynamic-`import()` cleanly.
4. Also remove the corresponding entries from `pluginMap` in `loadPlugins()`: drop `bootstrapPlugin` and `sqlPlugin`.

---

## 15. `UUID`, `Memory`, `Content`, `IAgentRuntime`, `GenerateTextParams` types

All still exported from `@elizaos/core`. Import paths are unchanged:
```ts
import type {
  UUID, Memory, Content, IAgentRuntime, GenerateTextParams, Character, Plugin, Entity, Room, World,
} from '@elizaos/core';
```

**Source location changes** (only matters if you're reading upstream source):
- `types/primitives.ts` — `UUID`, `Content`, `ChannelType`
- `types/memory.ts` — `Memory`, `MemoryType`, `MemoryMetadata`, `MemoryScope`
- `types/model.ts` — `ModelType`, `GenerateTextParams`, `ModelHandler`, `ModelParamsMap`, `ModelResultMap`
- `types/plugin.ts` — `Plugin`
- `types/runtime.ts` — `IAgentRuntime`
- `types/environment.ts` — `Room`, `World`, `Entity`, `Component`, `Relationship`
- `types/agent.ts` — `Character`, `CharacterSettings`, `MessageExampleGroup`
- `types/database.ts` — `IDatabaseAdapter`

**Signature changes you'll hit**:

### `UUID`
```ts
// v1.7.1: branded type or template literal
// v2.0.0: export type UUID = string;  // plain string alias for protobuf interop
```
Any `as UUID` casts in your code still work.

### `Content`
```ts
export interface Content extends Omit<ProtoContent, /* various */> {
  thought?: string;           // NEW
  text?: string;
  actions?: string[];         // NEW — for action dispatch
  providers?: string[];       // NEW
  source?: string;
  target?: string;
  url?: string;
  inReplyTo?: UUID;
  attachments?: Media[];
  channelType?: ChannelType;
  mentionContext?: MentionContext;
  responseMessageId?: UUID;
  responseId?: UUID;
  simple?: boolean;
  actionCallbacks?: Content;
  evalCallbacks?: Content;
  type?: string;
  [key: string]: /* union */;
}
```
Your existing `{ text: string, source: 'api' }` shape still works. New optional `thought` field enables chain-of-thought / reasoning workflows.

### `Memory`
See #11. Main change: added `sessionId`, `sessionKey`; `metadata` is now a discriminated union `MemoryMetadata`.

### `Character` — **important for API key handling**
```ts
export type Character = Partial<
  Omit<ProtoCharacter, '$typeName'|'$unknown'|'settings'|'messageExamples'|'knowledge'|'secrets'>
> & {
  settings?: CharacterSettings;
  secrets?: Record<string, string | number | boolean>;   // NEW, separate from settings
  messageExamples?: MessageExampleGroup[];
  knowledge?: KnowledgeSourceItem[];
  advancedPlanning?: boolean;   // NEW
  advancedMemory?: boolean;     // NEW
};
```

**Migration note**: In 1.7.1 your code puts `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `POSTGRES_URL` on the **runtime constructor's `settings`**. In 2.0.0 these belong on **`character.secrets`**. `settings` is now reserved for non-sensitive agent config (voice model, embedding model, etc. — see `CharacterSettings`). You'll want:
```ts
this.character = {
  ...this.character,
  secrets: {
    ANTHROPIC_API_KEY: this.config.apiKeys?.anthropic ?? process.env.ANTHROPIC_API_KEY ?? '',
    OPENAI_API_KEY: this.config.apiKeys?.openai ?? process.env.OPENAI_API_KEY ?? '',
  },
};
// Don't pass POSTGRES_URL to the runtime — instead construct the adapter yourself and pass it:
new AgentRuntime({
  agentId, character: this.character, plugins: this.loadedPlugins,
  adapter: new YourPgAdapter({ connectionString: this.config.databaseUrl }),
  // settings now only for non-secret config
});
```

### `IAgentRuntime`
All the methods you use are still there. The one you should double-check in your code is whether `IAgentRuntime` now *extends* `IDatabaseAdapter` (some docs suggest this, meaning `runtime.createMemory`, `runtime.getMemories` etc. are delegated through directly). In `v2.0.0` branch source, the interface in `types/runtime.ts` defines `createMemory`, `getMemoryById`, `createRoom`, `getRoom`, `createEntity`, `getEntityById`, `ensureWorldExists`, `ensureConnection` directly, and `getMemories` comes in via the `IDatabaseAdapter` that's either extended or composed. **UNCLEAR — would need to inspect whether IAgentRuntime extends IDatabaseAdapter or delegates via `runtime.adapter.getMemories`** in the v2.0.0 source. If the former, your existing `this.runtime.getMemories(...)` call still works unchanged. If the latter, you may need `this.runtime.adapter.getMemories(...)`. Based on how 1.7.1 runtime dispatched these calls, the "runtime extends adapter" pattern is most likely preserved.

### `GenerateTextParams`
See #12. Still takes `prompt`, `maxTokens`, `temperature`, etc. from the proto base; adds `onStreamChunk`, `user`, `promptSegments`.

---

## Summary of forced code changes (by line)

Your current `eliza-runtime.ts` will need edits in these specific places:

| Line(s)     | Change                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------ |
| 132, 226    | Remove `'@elizaos/plugin-bootstrap'` from the `plugins` arrays                                    |
| 134, 227    | Remove `'@elizaos/plugin-sql'` from the `plugins` arrays                                          |
| 279–288     | Add required `adapter: IDatabaseAdapter` to constructor; move API keys from `settings` → `character.secrets`; drop `POSTGRES_URL` from settings |
| 305–311     | Drop `bootstrapPlugin` and `sqlPlugin` from `pluginMap`                                            |
| 371–375     | `ensureWorldExists` — keep call, optionally add `messageServerId`, OR replace entire `ensureWorld/ensureRoom/ensureEntity` sequence with single `ensureConnection()` call |
| 427         | `getMemories({ roomId, count, tableName: 'messages' })` — rename `count` → `limit` (optional, count still works with deprecation warning) |
| 472–483     | `createMemory(memory, 'messages')` — no change needed; signature is unchanged                      |
| 496–498     | `generateText(prompt, { maxTokens })` — **still works**, OR replace with `useModel(ModelType.TEXT_LARGE, { prompt, maxTokens })`. If switching to `useModel`, change line 517 from `result.text` → `result` (it returns a raw string) |
| 502–513     | Second `createMemory(memory, 'messages')` — no change needed                                       |

---

## Open questions (require source inspection before writing the migration)

1. **What is the exact v2 DB adapter class to pass to `new AgentRuntime({ adapter })`?** `plugin-sql` is gone as a dynamic plugin; it's now a required construction-time dependency. Check `packages/typescript/src/database/` and `plugin-sql/typescript/stores/` on the `v2.0.0` branch.
2. **Does `IAgentRuntime` in v2 extend `IDatabaseAdapter`, or does it delegate via `runtime.adapter.*`?** This determines whether `this.runtime.getMemories(...)` remains a direct call or needs to change to `this.runtime.adapter.getMemories(...)`.
3. **Is `messageServerId` required or optional on `World` / `Room`?** The runtime.ts internal reference implies it's used, but optionality depends on the proto file in `schemas/eliza/v1/*.proto`.
4. **What's the exact shape of `GenerateTextResult`?** If you keep using `runtime.generateText()`, confirm whether `result.text` still works or if it's been renamed. The safer path is switching to `useModel` which returns a plain string.
5. **Is there a v2 equivalent of the `priority` hack for `@elizaos/plugin-anthropic` override?** Likely yes — `useModel(type, params, provider)` third arg, plus `Plugin.priority` still in the interface. Your OpenClaw / Ultrathink providers should work unchanged.
