/**
 * Transient character chat — POST /api/chat/transient
 *
 * Stateless one-shot OpenAI chat with a wandering world NPC. Used by
 * the TalkToCharacterBar in NPC mode (controlMode === 'npc'). The user
 * is possessing a transient PLAYER_NPC, talking to a nearby wanderer
 * (Mira, Vivi, Driftwood, Marlin, etc.). Per the architecture rule
 * stated 2026-04-27: "we are not making persistent eliza stores for
 * NPCs" — wandering characters do NOT get Eliza runtimes, rooms, or
 * memories. Each request is independent.
 *
 * Building residents (the 10 SpongeBob-named MiladyAI teachers) are
 * NOT covered here — they go through the existing full-Eliza
 * /api/locations/:id/chat path (their persistent skill-transfer chats
 * are the primary product loop).
 *
 * Request body: { characterName, message, history? }
 *   - characterName: matches NpcDefinition.name (e.g. "Mira", "Vivi")
 *   - message: user's input
 *   - history: optional in-memory transcript provided by the client
 *     so the conversation has short-term context. Server does NOT
 *     persist anything; client owns the history.
 *
 * Response: { message: { role: 'assistant', content, timestamp } }
 *
 * No auth — guests in NPC mode are the primary caller. Rate-limited
 * by IP (60 req/min) to avoid LLM cost runaway.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { NPC_DEFINITIONS } from '@clawville/shared';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import type { AppContext } from '../types';

export const transientChatRoutes = new Hono<AppContext>();

// 60 req/min/IP. NPC chat in mode 2 is one-shot per send, no agent
// loop, so 60/min is generous. Costs are bounded: ~400 tokens out
// per response × 60 ≈ 24k tokens/min/user worst case.
const transientRateLimit = createRateLimiter({
  windowMs: 60_000,
  maxPerWindow: 60,
});

const bodySchema = z.object({
  characterName: z.string().min(1).max(64),
  message: z.string().min(1).max(1000),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(2000),
      }),
    )
    .max(20)
    .optional(),
});

const OPENAI_MODEL = process.env.OPENAI_SMALL_MODEL ?? 'gpt-4o-mini';
const TEMPERATURE = 0.85;
const MAX_OUTPUT_TOKENS = 220;

transientChatRoutes.post('/', async (c) => {
  const ip = getClientIp(c.req.raw.headers);
  if (!transientRateLimit.check(`chat-transient:${ip}`)) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  let parsed;
  try {
    parsed = bodySchema.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: 'Invalid request body', detail: String(err) }, 400);
  }
  const { characterName, message, history = [] } = parsed;

  // Case-insensitive name lookup against the NPC definition list.
  const character = NPC_DEFINITIONS.find(
    (n) => n.name.toLowerCase() === characterName.toLowerCase(),
  );
  if (!character) {
    return c.json({ error: `Unknown character: ${characterName}` }, 404);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'LLM not configured' }, 503);
  }

  // Persona system prompt. Short — gpt-4o-mini handles concise persona
  // direction well. ClawVille world flavor + character's authored
  // personality string + reply length cap.
  const systemPrompt =
    `You are ${character.name}, a wandering character in ClawVille — a sea-themed ` +
    `gamified world where AI agents and humans learn skills together. ` +
    `${character.personality} ` +
    `Stay in character. Keep replies under 2 short sentences. No lists, no markdown, ` +
    `no meta-talk about being an AI. If the user says something off-topic, deflect ` +
    `playfully back to ClawVille.`;

  // Translate persona + history + new message to OpenAI's messages[] format.
  // OpenAI uses 'system' for the persona and keeps 'user'/'assistant' roles
  // verbatim for the transcript.
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
  ];
  for (const turn of history) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: 'user', content: message });

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature: TEMPERATURE,
        max_completion_tokens: MAX_OUTPUT_TOKENS,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[chat-transient] OpenAI ${res.status}: ${errText.slice(0, 200)}`);
      return c.json({ error: 'LLM upstream error' }, 502);
    }

    const data = (await res.json()) as any;
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    if (!text || !text.trim()) {
      return c.json({ error: 'LLM returned empty response' }, 502);
    }

    return c.json({
      message: {
        role: 'assistant',
        content: text.trim(),
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[chat-transient] fetch failed:', err);
    return c.json({ error: 'LLM fetch failed' }, 502);
  }
});
