---
name: llm-provider-openai-only
description: "OpenAI sole text+embedding backend (2026-06-05, Gemini unused, Anthropic removed); Eliza chat through runtime; transient/banter stateless non-Eliza; embeddings pinned; key never logged"
category: constraint
confidence: high
date: 2026-06-22
---

---
name: llm-provider-openai-only
description: OpenAI is the sole text+embedding backend (2026-06-05); Eliza chat through the runtime; transient/banter stateless non-Eliza; embeddings PINNED in code; key never logged.
category: constraint
confidence: 0.92
date: 2026-06-22
---

# LLM provider = OpenAI ONLY (2026-06-05)

## Text generation

`npc-conversation-engine.ts` (`OPENAI_SMALL_MODEL` default `gpt-4o-mini`, `:8`; key `:41`) + `chat-transient.ts` call OpenAI chat completions. Gemini is fully UNUSED (billing dunning-blocked / 403); Anthropic removed. No secondary provider / backoff in npc-conversation-engine.

## Embeddings — HARD-PINNED in code

`packages/agent-runtime/src/plugins/embed-text.ts:26-28`: `text-embedding-3-small` / 1536-dim are literal constants, 'Never read from env/options'. Stored vectors must match query vectors → pgvector `dim_1536` column. Changing the dimension routes embeddings to a different column + requires a re-embed migration — a deliberate code edit to BOTH the embed plugin AND the boot dimension-probe, NOT an env tweak.

## Runtime vs stateless

- Eliza teacher/system chat MUST go through the ElizaOS runtime (MANDATORY — never a direct LLM call bypassing it).
- Transient NPC chat + NPC-to-NPC banter are DELIBERATELY non-Eliza, stateless, no rooms/memory (architecture: 'no persistent eliza stores for wandering NPCs').

## Key safety

Never log `OPENAI_API_KEY`; a missing key degrades gracefully (canned fallback / `chat-transient.ts:86` 503), never throws.

## Status: LIVE.

Related: [[teacher-persona-customization-driven]] · [[chat-reward-and-metric-discipline]]
