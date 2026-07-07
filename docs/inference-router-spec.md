# Inference Router — spec (implementation-ready)

**Status:** SCOPED, not built. Replaces the interim `OPENAI_BASE_URL` global-env hack (commit `e95de207`) which must be removed as part of this work.
**Owner branch:** `feat/agent-metaverse-p0` (== `origin/staging`). Ship to staging first; prod config pre-staged, activates on master merge.
**Verified integration facts (2026-07-06):** the ElizaOS text handler receives `runtime: IAgentRuntime` (`openai-text-provider.ts:196`, currently ignored as `_runtime`) → it can read the agent's route off the runtime. `agentOrchestrator.ensureAgentRuntime(..., opts?: {isHouse?})` already knows `agent.type` (`avatar-agent | openclaw-bot | system-agent`) + `isHouse` → it assigns the route. Provider is already per-runtime model-preset-configured (`makeHandler(model)`), so per-agent endpoint selection is natural.

---

## 1. Why the current wiring is wrong (what we're fixing)
`OPENAI_BASE_URL` is a single global process env read by `openai-text-provider.ts`. Consequences:
- **Misnamed + one-destination:** named "OpenAI" but points at johns-pc; ALL text inference (10 teachers + fleet + system agents like Nori) goes to that ONE URL. Cannot keep teachers on OpenAI while the fleet uses local.
- **No failover:** if the box is down, every agent's inference fails. "OpenAI is the fallback" is impossible with one URL.
- **Two boxes, one URL:** cannot use johns-pc (16 GB, qwen3:14b) AND `.223.14` (24 GB, qwen3.6:27b).

## 2. Target architecture — ONE `InferenceRouter` class managing N named endpoints + per-consumer routing + health-based fallback

### 2a. Endpoints (named, each its own URL/model/auth — config-driven, per box)
```
type Endpoint = {
  id: string;              // 'openai' | 'local-primary' | 'local-secondary'
  baseUrl: string;         // e.g. https://api.openai.com/v1  |  http://100.76.57.60:11434/v1
  apiKey?: string;         // OpenAI key; local Ollama = none (or Caddy bearer later)
  smallModel: string;      // gpt-4o-mini | qwen3:14b
  largeModel: string;      // gpt-4o     | qwen3:14b | qwen3.6:27b
  kind: 'cloud' | 'local';
  timeoutMs: number;       // local may be slower; cloud tighter
};
```
Baseline set:
- `openai` — `https://api.openai.com/v1`, gpt-4o-mini / gpt-4o, cloud.
- `local-primary` — johns-pc `http://100.76.57.60:11434/v1`, qwen3:14b / qwen3:14b, local.
- `local-secondary` — `.223.14` `http://100.75.223.14:11434/v1`, qwen3.6:27b / qwen3.6:27b, local. **Optional** — omitted when the box is offline/unset.

### 2b. Routes (consumer class → ORDERED endpoint preference; failover walks the list)
| Route | Ordered endpoints | Who |
|---|---|---|
| `teacher` | `[openai]` | the 10 building residents + system-agents (Nori). **Stay on OpenAI.** |
| `fleet` | `[local-primary, local-secondary, openai]` | our `is_house` autonomous agents. Local first, cross-box failover, OpenAI last-resort. |
| `hosted-user` | `[local-primary, local-secondary, openai]` | provisioned (non-BYO) user agents. |
| `default` | `[openai]` | anything unclassified. |
Each route's list is env-overridable per box.

### 2c. The router (`generateText`)
```
InferenceRouter.generateText({ route, size: 'small'|'large', messages, temperature?, maxTokens? }): Promise<{text, endpointId}>
```
1. `endpoints = routeTable[route]` (ordered).
2. For each `ep` in order:
   - if circuit OPEN for `ep` (recent failures, `now < openUntil`) → skip.
   - POST `${ep.baseUrl}/chat/completions` with `model = ep[size+'Model']`, `Authorization` if `ep.apiKey`, `AbortSignal.timeout(ep.timeoutMs)`.
   - success → record OK (reset breaker), meter++, return `{text, endpointId: ep.id}`.
   - failure/timeout/non-2xx → record failure (increment; open breaker after K consecutive), meter fail++, continue.
3. all failed → throw the last error (caller logs; the agent turn fails loudly, not silently OpenAI-swapped mid-route unless OpenAI is in the route list).

### 2d. Health / circuit breaker (THIS is the "thorough fallback")
Per-endpoint state `{ consecutiveFailures, openUntil }`. Config `{ failThreshold: 3, cooldownMs: 30_000 }`.
- On K consecutive failures → `openUntil = now + cooldownMs`; skip while open.
- Half-open: after cooldown, allow ONE probe; success closes, failure re-opens.
- Prevents hammering a dead box every request; makes local→OpenAI fallback fast + self-healing when the box returns.

### 2e. Metering (cost/capacity visibility)
Per-endpoint counters `{ requests, successes, failures, lastLatencyMs }`. Local ≈ free, cloud = $. Expose via a `router.stats()` for `/dash` later (not blocking).

## 3. Integration points (files)
- **NEW `packages/agent-runtime/src/inference/inference-router.ts`** — the class (endpoints, routes, breaker, meter, `generateText`). Framework-agnostic; no ElizaOS import.
- **NEW `packages/agent-runtime/src/inference/inference-config.ts`** — parse endpoints + route table from env (§4), with baked defaults. One shared router singleton.
- **EDIT `packages/agent-runtime/src/plugins/openai-text-provider.ts`** — `makeHandler` stops reading the global URL/`OPENAI_API_URL`. Instead: resolve `route = runtime.character?.settings?.inferenceRoute ?? 'default'`, `size` from the handler's ModelType, then `return inferenceRouter.generateText({route, size, messages, ...})`. **Remove the `OPENAI_BASE_URL` global (revert e95de207's edit).**
- **EDIT `apps/api/src/services/agent-orchestrator.ts` `ensureAgentRuntime`** — after building the character, set `character.settings.inferenceRoute`:
  - `agent.type === 'system-agent'` → `'teacher'`
  - `agent.type === 'avatar-agent'` (the 10 location teachers) → `'teacher'`
  - `agent.type === 'openclaw-bot'` && `opts.isHouse` → `'fleet'`
  - `agent.type === 'openclaw-bot'` (user, non-house) → `'hosted-user'`
  - else → `'default'`
  (Confirm the exact type→teacher mapping against the 10 residents' seeding — `avatar-agent` vs `system-agent` — during impl.)
- **EDIT `apps/api/src/services/npc-conversation-engine.ts`** — if it makes its own OpenAI call (NPC banter / transient chat), route it through `inferenceRouter.generateText({route:'default'|'teacher', ...})` too. Audit + include (do NOT leave a second un-routed inference path).
- **UNCHANGED:** embeddings (`openai-embedding-provider.ts`) stay OpenAI, pinned `text-embedding-3-small`/1536 (per CLAUDE.md). The router is TEXT-gen only.
- **DOC same-diff:** `ARCHITECTURE.md` new "Inference routing" section; `CLAUDE.md` env-var block (replace the `OPENAI_BASE_URL` line with §4 vars).

## 4. Config (structured, per box — replaces the single OPENAI_BASE_URL)
```
# endpoints
OPENAI_API_KEY=...                                            # existing → 'openai' endpoint
INFERENCE_LOCAL_PRIMARY_URL=http://100.76.57.60:11434/v1
INFERENCE_LOCAL_PRIMARY_MODEL=qwen3:14b
INFERENCE_LOCAL_SECONDARY_URL=http://100.75.223.14:11434/v1   # optional; unset ⇒ endpoint absent
INFERENCE_LOCAL_SECONDARY_MODEL=qwen3.6:27b
# route overrides (optional; CSV of endpoint ids; defaults in code)
INFERENCE_ROUTE_TEACHER=openai
INFERENCE_ROUTE_FLEET=local-primary,local-secondary,openai
INFERENCE_ROUTE_HOSTED_USER=local-primary,local-secondary,openai
# breaker (optional)
INFERENCE_FAIL_THRESHOLD=3
INFERENCE_COOLDOWN_MS=30000
```
- **Same code, per-env config.** Staging today: `local-primary`=johns-pc only (no secondary yet) → `fleet=[local-primary, openai]`. Prod: same, activates on master merge.
- **Unset everything ⇒ pure OpenAI** (safe default; matches pre-hack behavior).

## 5. Migration / cleanup (undo the lazy hack — REQUIRED, same PR)
1. Revert the global-URL read in `openai-text-provider.ts` (from `e95de207`).
2. **Delete the 3 interim env vars** I set on the staging AND prod Coolify apps (`OPENAI_BASE_URL`, `OPENAI_SMALL_MODEL`, `OPENAI_LARGE_MODEL` on app 3 staging + app 2 prod) via tinker (`$e->delete()`), and set the §4 structured vars instead.
   - Staging box `87.99.142.34` key `~/.ssh/clawville_deploy`, prod `5.78.129.176` key `~/.ssh/clawville_ci_prod`, Coolify container `coolify`, `docker exec -i coolify php artisan tinker < script`. **Encryption gotcha:** create/update via the model (`$app->environment_variables()->create([...])` / `$e->value=..;$e->save()`), NEVER raw `DB::update`.
3. Deploy staging (push branch → Coolify build) + browser/live-verify (§6).

## 6. Verification (must pass before "done")
- **Route correctness on live staging:** (a) a `teacher` chat (Nori `/api/chat/system/town-guide`, authed as `landtest1@staging.clawville.test / LandTest!2026`) → hits **OpenAI**, NOT johns-pc → johns-pc `/api/ps` model-use timestamp does **NOT** advance. (b) A `fleet`-route agent decision → johns-pc timestamp **advances**.
- **Failover:** stop johns-pc Ollama (`schtasks /end /tn CVOllama` on johns-pc) → a `fleet` request falls back (to `local-secondary` if present, else `openai`) and still returns; restart → breaker half-opens and local resumes. (Observe endpoint via `router.stats()` log or the returned `endpointId`.)
- **Teacher isolation confirmed** (the whole reason): with johns-pc up, teachers still show OpenAI usage, only fleet shows johns-pc usage.
- Both staging + prod config parse without error on boot (prod stays OpenAI-only until its local route is intentionally enabled).

## 7. Observed capacity (context for route tuning)
johns-pc RTX 5070 Ti / qwen3:14b: **35 tok/s solo, ~4 concurrent (6.7 tok/s each)** → comfortably covers the planned 3–4 live agents per env. 27B doesn't fit 16 GB (2.9 tok/s) — it's the `local-secondary`/24 GB-box model only.
