# Ultrathink Migration Decision

> **DECISION TAKEN: Option A — Removed entirely (2026-04-10).**
>
> Ultrathink leaked into the codebase from an early prompt where Claude was
> asked to "use ultra think" while building a feature and interpreted that
> as "build an ultrathink feature into the product." It was never
> measured, never had an A/B test, and the priority-chain analysis in §1
> suggested it was dead code behind `gemini-text-provider` (priority 95).
> This doc is retained for historical context explaining the alternative
> paths and why Option A was chosen. If you want to add first-class
> extended-reasoning support back later, start from §5 Option B
> (port to Gemini 2.5 thinking mode).
>
> **SUPERSEDED note (2026-06-16):** this doc predates the OpenAI migration —
> every "Gemini" reference below is historical. OpenAI (`openai-text-provider`
> p95 + `openai-embedding-provider` p100) is now ClawVille's sole LLM backend;
> both `gemini-*-provider` files were deleted. Future extended-reasoning work
> should target OpenAI, not Gemini 2.5.
>
> **What was removed:**
> - `packages/agent-runtime/src/plugins/ultrathink-provider.ts` (deleted)
> - `ThinkingEffort`, `THINKING_BUDGET`, `AgentThinkingConfig`, `AGENT_THINKING_DEFAULTS` from `packages/shared/src/types/collaboration.ts`
> - `thinkingConfig` field from `ElizaRuntimeConfig` and all `thinkingConfig: {...}` call sites in `building-runtime-registry.ts` and `simulation-runtime.ts`
> - `apiKeys.anthropic` field from `ElizaRuntimeConfig` and all passthrough sites (`agent-orchestrator.ts`, `avatar-simulation-bridge.ts`, `collaboration-broker.ts`)
> - `@anthropic-ai/sdk` from `packages/agent-runtime/package.json` and `apps/api/package.json`
> - `@elizaos/plugin-anthropic` from `packages/agent-runtime/package.json` and all plugin lists
> - `@anthropic-ai/sdk` + `@elizaos/plugin-anthropic` from `apps/web/next.config.mjs` `serverExternalPackages`
> - `ANTHROPIC_API_KEY` env var from Coolify api app
> - `ANTHROPIC_API_KEY` documentation in `CLAUDE.md`

**Original status:** Open decision, awaiting product call.
**Context:** Phase of the Anthropic → Gemini migration. The "ultrathink" provider is the last Anthropic-locked piece of the ElizaOS runtime stack inside ClawVille and needs a decision before we can fully drop the Anthropic dependency.
**Blocker for:** fully removing `@anthropic-ai/sdk` from `packages/agent-runtime/package.json` and removing `ANTHROPIC_API_KEY` from Coolify.

---

## TL;DR

ClawVille's `ultrathink-provider` wraps Anthropic's **extended thinking** feature and registers at ElizaOS plugin priority 90 to intercept `TEXT_SMALL` / `TEXT_LARGE` calls for location-agents, avatar-agents, and OpenClaw bots. Gemini has a comparable "thinking mode" on Gemini 2.5 / 3.0 Flash and Pro — but the two systems differ in three ways that actually matter for ClawVille:

1. **Tool-integrated thinking loops** — Anthropic allows the model to interleave thinking blocks with tool calls mid-turn (`think → tool_use → think → tool_result → think → final answer`). Gemini's thinking is largely "think first, respond once."
2. **Think-tool pattern** — Our `ultrathink-provider.ts` uses a custom `think` tool with a 5-iteration loop (`MAX_THINK_ITERATIONS`) that explicitly relies on Anthropic's `stop_reason: 'tool_use'` + recursive message injection. This specific pattern does not port 1:1 to Gemini.
3. **Budget semantics** — Anthropic exposes a hard `budget_tokens` cap (2048–20000 per effort level in our code). Gemini exposes `thinkingBudget` but its interpretation varies by model (Gemini 3 Pro removes the explicit budget and uses internal reasoning; Gemini 2.5 Flash honors it as an upper bound).

The decision is **not** "does Gemini have thinking?" — it does. The decision is **"does ClawVille's use of the think-tool loop + interleaved thinking actually matter, or was it added speculatively and never observed to change outputs?"**

---

## §1 — What ultrathink does in ClawVille today

Source: `packages/agent-runtime/src/plugins/ultrathink-provider.ts`

### Architecture
- Exports `createUltrathinkProviderPlugin(config)` returning an ElizaOS `Plugin` with `name: 'ultrathink-provider'` and `priority: 90`.
- Intercepts `ModelType.TEXT_SMALL` and `ModelType.TEXT_LARGE` calls routed through any ElizaRuntime that has it loaded.
- Registered below OpenClaw gateway (100) and below our new Gemini text provider (95 — added in Phase 3), above the default `plugin-anthropic` fallback.
- **Observation:** since `gemini-text-provider` sits at 95 and ultrathink sits at 90, ultrathink **only fires if the Gemini provider explicitly declines a call** (returns null/throws). In the current code path, Gemini never declines, so ultrathink is effectively dormant for most runtimes. Worth double-checking how ElizaOS resolves plugin priorities when both return handlers — it's possible ultrathink is dead code already.

### Configuration knobs (from `UltrathinkConfig`)
- `effort: 'low' | 'medium' | 'high' | 'max'` — maps to `THINKING_BUDGET` in `packages/shared/src/types/collaboration.ts`:
  - low = 2048 thinking tokens
  - medium = 5000
  - high = 10000
  - max = 20000
- `enableThinkTool: boolean` — toggles the 5-iteration think-tool loop
- `model: string` — defaults to `claude-haiku-4-5-20251001`
- `maxTokens: number` — separate response-token cap (500/1000/1500/2000 per effort level)

### Presets (from `ULTRATHINK_PRESETS`)
- `buildingAgent` — high effort (10k thinking tokens) + think tool enabled
- `avatarAgent` — medium effort (5k) + no think tool
- `npcAmbient` — low effort (2k) + no think tool
- `deepReasoning` — max effort (20k) + think tool enabled

### Agent defaults (from `AGENT_THINKING_DEFAULTS` in collaboration.ts)
- `location-agent` → high + think tool (building NPCs)
- `avatar-agent` → medium + no think tool (user avatars)
- `openclaw-bot` → medium + no think tool (connected external agents)
- `npc-ambient` → low + no think tool (background NPCs)

### The think-tool loop — the one genuinely Anthropic-specific part
Lines 110-150 of `ultrathink-provider.ts`:

```ts
while (response.stop_reason === 'tool_use' && iteration < MAX_THINK_ITERATIONS) {
  const toolUseBlock = response.content.find(b => b.type === 'tool_use' && b.name === 'think');
  messages = [
    ...messages,
    { role: 'assistant', content: response.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: 'Thinking noted. Continue with your response.' }] }
  ];
  response = await client.messages.create({ model, max_tokens: maxTokens, thinking: {...}, messages, tools: [THINK_TOOL] });
}
```

This pattern lets the model:
1. Think privately (thinking block, not shown to the caller)
2. Call the `think` tool with a visible reasoning string (shown in logs)
3. Receive a "noted, continue" message from us
4. Think again
5. Eventually emit a regular text response (stop_reason = 'end_turn')

It's essentially chain-of-thought with explicit checkpointing. The assumption is that the explicit `think` tool call forces the model to externalize intermediate reasoning steps that wouldn't otherwise surface.

**Is this actually useful in ClawVille?** Unknown. Nobody has measured whether NPC responses are meaningfully better with the think-tool loop enabled vs disabled. There's no A/B test, no quality metric, no evaluator. It's plausibly cargo-culted from someone's blog post about Claude prompting tricks.

---

## §2 — What Anthropic extended thinking actually gives you

### Public behavior
- Sent as `thinking: { type: 'enabled', budget_tokens: N }` on `messages.create`
- Model emits `content` blocks of `type: 'thinking'` containing private reasoning
- Thinking content can be marked "redacted" for safety (still billed)
- Thinking blocks are returned in the response and can be **cached** and replayed in subsequent turns to preserve reasoning context
- Available on Claude Opus 4, Sonnet 4/4.5, Haiku 4.5
- Token budgets are hard caps — model can stop thinking early if done; if it hits the cap mid-thought, the cap is the cap

### The interleaved-thinking claim
Extended thinking **interleaves with tool use**. A single turn can look like:
```
thinking → tool_use → tool_result → thinking → tool_use → tool_result → thinking → text
```
This is meaningfully different from "think → answer". It lets the model reason about tool outputs as they come in, correcting mid-flight.

For ClawVille specifically, the only "tool" ultrathink uses is the custom `think` tool. Real tool use (fetching data, calling APIs) doesn't happen in this code path. So the interleaving benefit is theoretical — ClawVille's use is **think → think-tool-loop → final answer**, which is just chain-of-thought dressed up.

### Caching
Anthropic extended thinking plays well with prompt caching — you can cache thinking blocks from previous turns as part of the conversation history, letting the model build on earlier reasoning. Cache discounts (90% off) apply to cached thinking tokens.

ClawVille does not currently use prompt caching for any of these code paths. So caching benefits are zero for the status quo.

### Cost
Thinking tokens are billed at the **full output token rate** for the model. Claude Haiku 4.5 output tokens are $4/M. A 10,000-token thinking budget is up to $0.04 per call, on top of the regular response cost. At ClawVille's current scale (a few hundred NPC ticks per day, most hitting low/medium effort) that's maybe $1-3/day if all traffic went through ultrathink.

---

## §3 — What Gemini's thinking mode actually gives you

### Gemini 2.5 Flash / Pro
- Sent as `generationConfig: { thinkingConfig: { thinkingBudget: N, includeThoughts: true/false } }` on `generateContent`
- Returns content parts with `thought: true` flag (when `includeThoughts: true`)
- `thinkingBudget` is a soft target; Gemini 2.5 Flash honors values 0-24576, Gemini 2.5 Pro 128-32768
- `thinkingBudget: 0` disables thinking entirely
- `thinkingBudget: -1` (dynamic thinking) lets the model choose its own budget based on complexity

### Gemini 3 Flash / Pro
- Same `thinkingConfig` shape but Pro removes explicit budget control for simpler UX
- Internal reasoning is always on; you can't turn it off below a certain level
- Dynamic thinking is default

### Tool interleaving
Gemini's function calling supports multiple tool calls in one turn, similar to Anthropic. The interleave pattern works but is **less document-ed** as a design goal — Gemini's guidance is "think → tool_use → think → final answer" whereas Anthropic leans into "thinking_block → tool_use → thinking_block → tool_use → ... → final answer" as a first-class pattern.

For ClawVille's current ultrathink use (single custom think-tool, no real APIs), Gemini's interleaving works fine.

### Cost
Gemini 2.5 Flash output: $0.30/M thinking + $2.50/M output. Thinking tokens are billed separately and cheaper than output tokens. A 10k thinking budget costs ~$0.003 — **~13x cheaper than Anthropic's equivalent**.

Gemini 3 Flash: similar ballpark, possibly cheaper.

---

## §4 — Key differences that matter for ClawVille

| | Anthropic extended thinking | Gemini thinking mode | Matters for ClawVille? |
|:--|:--|:--|:--|
| **Tool interleaving** | First-class, documented pattern | Works but less emphasized | No — ClawVille doesn't use real tools in the ultrathink path |
| **Custom think-tool loop** | Our existing 5-iteration pattern relies on `stop_reason: 'tool_use'` semantics | Gemini has `finish_reason: 'TOOL_CALL'` which works but message-back pattern differs | Yes — requires ~40 LOC rewrite of the loop |
| **Budget granularity** | Hard cap, tokens billed at output rate | Soft cap + dynamic mode, separate cheaper thinking price | No — performance is comparable, Gemini is cheaper |
| **Thinking block caching** | Integrates with prompt caching | No equivalent for thinking caching | No — ClawVille doesn't use caching here |
| **Redacted thinking for safety** | Yes | No equivalent | No — not a ClawVille requirement |
| **Effort level semantics** | We map to `budget_tokens` directly | Map to `thinkingBudget` (0/low/medium/high or explicit N) | Straightforward |
| **Model availability** | Haiku 4.5, Sonnet 4.5, Opus 4 | 2.5 Flash/Pro, 3 Flash/Pro | Both have fast + smart tiers |
| **Cost per 10k thinking tokens** | ~$0.04 on Haiku 4.5 | ~$0.003 on 2.5 Flash | Gemini wins 13x on cost |

**The two things that actually create migration work:**
1. The think-tool loop has to be rewritten to match Gemini's function-calling return shape.
2. The assumption that thinking is invisible to the caller (Anthropic hides it by default) differs from Gemini where `includeThoughts: true` returns them as part of content.

Everything else is cosmetic.

---

## §5 — The four migration paths

### Option A — Remove ultrathink entirely

**What it is:** Delete `ultrathink-provider.ts`. Remove `AGENT_THINKING_DEFAULTS`, `ULTRATHINK_PRESETS`, `THINKING_BUDGET`, `ThinkingEffort` from `collaboration.ts`. Remove all references in `eliza-runtime.ts` and `collaboration-broker.ts`. Let `gemini-text-provider` at priority 95 handle all text generation.

**Pros:**
- Smallest code footprint — deletes ~250 LOC
- Completes the Anthropic removal (apart from `agent-runtime` package.json)
- No functional regression *if* ultrathink is already dead code (which it may be, per §1's priority chain note)
- Zero maintenance burden going forward

**Cons:**
- Loses the think-tool loop entirely. If it was ever doing something useful (unmeasured), we lose that.
- Loses `AGENT_THINKING_DEFAULTS` which may be consumed by other code paths I haven't audited.
- If we later decide we DO want thinking, we have to rebuild from scratch.

**LOC:** ~10 lines of removal + ~50 lines of reference cleanup. Half a session.

**When to pick:** if you believe ultrathink was speculative and has never meaningfully affected output quality.

### Option B — Port to Gemini (`ultrathink-gemini-provider.ts`)

**What it is:** Rewrite the provider to call Gemini 2.5 Flash with `thinkingConfig.thinkingBudget: N`. Map our 4 effort levels (low/med/high/max) to Gemini budgets (2k/5k/10k/20k). Rewrite the think-tool loop to use Gemini's function calling shape. Keep the same `priority: 90` plugin registration. Preserve the public API (`createUltrathinkProviderPlugin(config)`) so callers don't change.

**Pros:**
- Preserves semantic intent (deep reasoning for building agents, medium for avatars, etc.)
- Keeps a Gemini-only stack — no Anthropic dep anywhere in production
- Cost savings (~13x cheaper than Anthropic)
- If ultrathink WAS doing something, we don't lose it — just re-implement against Gemini

**Cons:**
- ~150 LOC of careful porting. The think-tool loop rewrite is the hard part — Gemini's function calling returns a different shape.
- Unverified whether Gemini's thinking is behaviorally equivalent. The think-tool pattern depends on the model "wanting" to call the think tool; we don't know if Gemini 2.5 Flash will honor a soft "please use this tool for reasoning" instruction the same way Claude does.
- Requires follow-up verification (smoke test + eyeball NPC response quality) to confirm the port actually works.

**LOC:** ~150 lines + ~30 lines of test + ~1 hour of eyeballing output quality.

**When to pick:** if you want feature parity without an Anthropic dependency.

### Option C — Keep ultrathink Anthropic but make it optional

**What it is:** Guard the ultrathink plugin loader behind an `ENABLE_ULTRATHINK` env var. Default off. If unset or false, the provider isn't loaded and Gemini handles everything. If set to true (and `ANTHROPIC_API_KEY` exists), the provider loads with its current behavior.

**Pros:**
- Zero functional regression — existing behavior preserved under the flag
- Lets you AB-test: run production on Gemini-only, occasionally flip the flag to compare outputs
- Fastest to ship (~30 LOC in eliza-runtime.ts + docs)
- Lets you defer the "is ultrathink actually useful" question indefinitely

**Cons:**
- Anthropic dependency stays in the codebase (plugin-anthropic still loaded, `@anthropic-ai/sdk` still in package.json)
- Anthropic API key stays in prod env vars — production outage still possible if the key lapses
- Doesn't finish the migration, just papers over it
- Dual-path code is more surface area to debug

**LOC:** ~30 lines + env var in Coolify.

**When to pick:** if you're unsure about B and want to defer; or if you're actively planning to A/B test ultrathink quality in the near future.

### Option D — Multi-provider thinking (`thinking-provider.ts`)

**What it is:** Rewrite the provider to be provider-agnostic. Internally it checks which providers are configured (Gemini and/or Anthropic) and picks the best available. Think-tool loop is abstracted over both SDKs. Same public API, pluggable backends.

**Pros:**
- Most future-proof — adding a 3rd provider (DeepSeek R1? Llama?) is a small extension
- Can gracefully degrade: Gemini primary, Anthropic secondary if Gemini is down
- Keeps both SDK deps but only one is load-bearing at a time

**Cons:**
- ~200 LOC + the most design decisions (how to abstract the think-tool loop across SDKs?)
- More surface area than any other option
- Probably overkill for a feature that's maybe dead code already
- Delays the Anthropic removal further

**LOC:** ~200 lines + ~40 lines of tests + dependency choreography.

**When to pick:** if you want ClawVille to be a template for "agent runtime that can flex across providers" — which is philosophically aligned with P2 ("any OpenClaw/Hermes agent can connect") but operationally expensive.

---

## §6 — Cost comparison at ClawVille's scale

Rough estimate — 500 NPC conversation ticks per day, mix of effort levels:

| Effort | Calls/day | Avg thinking budget | Anthropic cost | Gemini 2.5 cost |
|:--|:--:|:--:|:--:|:--:|
| low | 300 | 2k | $0.024 | $0.0018 |
| medium | 150 | 5k | $0.030 | $0.0022 |
| high | 50 | 10k | $0.020 | $0.0015 |
| **total/day** | 500 | — | **$0.074** | **$0.0055** |
| **total/month** | — | — | **~$2.25** | **~$0.17** |

Numbers assume *thinking tokens only*, not response tokens. Add ~$1-2/month for response tokens on either provider. Gemini wins by a factor of ~13x on thinking tokens but both are rounding error at current scale.

**The cost argument is not load-bearing here.** The real decision drivers are operational risk (key lapsing takes down prod) and code surface area.

---

## §7 — Recommendation

**Pick Option A (remove entirely) unless you have evidence ultrathink is doing something useful.**

Rationale:
1. The priority chain analysis in §1 strongly suggests ultrathink is **already dead code** — gemini-text-provider at 95 sits above it at 90, and ElizaOS plugin priority resolution means the higher-priority provider wins when both can handle a call. Gemini never returns "can't handle this" for `TEXT_SMALL`/`TEXT_LARGE`, so ultrathink's handler probably never runs in production today. **This is the single most important fact and it should be verified before anything else.**
2. If ultrathink is dead code, removing it is a pure cleanup with zero risk and fully completes the Anthropic migration.
3. If ultrathink is *not* dead code (because the priority resolution works differently than I think), then we'd see it in the Coolify logs — check for `[Ultrathink]` prefixed logs in the last 7 days. If there are none, it's confirmed dead.
4. The think-tool pattern is technically interesting but unmeasured. Adding complexity for a feature with no quality metric is premature optimization.
5. We can always bring it back later via Option B if a specific NPC quality issue points to "this NPC needs chain-of-thought reasoning." It's a ~2-hour rebuild against Gemini.

### Verification steps before picking A

1. SSH into the api container and run:
   ```bash
   docker logs <api-container> 2>&1 | grep -c '\[Ultrathink\]'
   ```
   If zero, ultrathink never fires → Option A is confirmed safe.

2. If non-zero, count how often and look at what it's generating. That tells you whether it's noise or load-bearing.

3. If it IS firing frequently, pick **Option B** (port to Gemini) instead of A.

### What Option C is actually for

Option C (feature flag) makes sense *only* if you want to do formal A/B testing of NPC output quality with and without thinking, measured against a rubric (interesting? in-character? useful to the player?). That's a research project, not a migration. Don't pick C unless you're ready to build evaluators.

### What Option D is actually for

Option D (multi-provider) makes sense only if you're building a platform for *other developers* to run their own agents on. That's a much bigger product decision than "finish the Anthropic migration." Defer indefinitely.

---

## §8 — What I need from you to proceed

**One of these answers unblocks the rest of the migration:**

1. **"Remove it, I trust the priority chain analysis"** → Option A. I delete the plugin + references, confirm typechecks, ship it. ~30 min.

2. **"Check the logs first, then decide"** → I SSH into Coolify, grep for `[Ultrathink]` in the last 7 days, report count, then you pick A or B based on what we see. ~15 min + decision time.

3. **"Port to Gemini — I want to keep the option"** → Option B. I write `ultrathink-gemini-provider.ts`, re-implement the think-tool loop with Gemini's function calling, smoke-test against a live NPC, ship. ~2-3 hours including quality eyeballing.

4. **"Make it optional with a flag"** → Option C. 30 min to wire the flag, default off, leave Anthropic code in place but dormant.

Until one of these is picked, `@anthropic-ai/sdk` stays in `packages/agent-runtime/package.json` and the Anthropic migration is ~95% done but not 100%.
