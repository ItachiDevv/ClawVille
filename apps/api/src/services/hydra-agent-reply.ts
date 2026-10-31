/**
 * Hydra's spoken answer to an AGENT's `talk_to_npc(npcId=hydra-analyst, ...)`.
 *
 * Rule E5 parity: a human talks to Hydra through `POST /api/chat/transient`
 * (gpt-4o-mini + the NPC_DEFINITIONS persona + `moderateText`). This module
 * gives a connected or hosted agent the same answer path from the in-world
 * executor (`npc-simulation.ts`), without editing the human route:
 *
 *   - the same model (`OPENAI_SMALL_MODEL`, default gpt-4o-mini) and the same
 *     persona text, plus Hydra's coin context (`hydraCoinPromptContext`);
 *   - input moderation before the model call, and output moderation before
 *     the reply becomes a PUBLIC world bubble;
 *   - a hard timeout, and a template fallback (`hydraAmbientLine`, no LLM) on
 *     every failure: no API key, a blocked input or output, a timeout, an
 *     upstream error or an empty reply;
 *   - a per-agent limiter (one model reply per agent per 20 s) and a
 *     process-wide limiter (30 model replies per minute), so agents cannot
 *     burn the OpenAI budget. A limited call gets the template line.
 *
 * Never throws. The reply is DATA: `[ACTION:]` tags are stripped and it is
 * capped short, so it can never act and it fits the hosted decide-prompt slot.
 * Hydra's coin talk is a joke, never financial advice.
 */

import { z } from 'zod';
import { NPC_DEFINITIONS } from '@clawville/shared';
import { moderateText } from './moderation-service';
import {
  HYDRA_NPC_ID,
  hydraAmbientLine,
  hydraCoinPromptContext,
  pickHydraCoin,
  type HydraCoin,
} from './hydra-coin-chatter';

/** One model reply per agent per this window; faster calls get the template. */
export const HYDRA_LLM_REPLY_INTERVAL_MS = 20_000;
/** Process-wide model replies per fixed one-minute window. */
export const HYDRA_LLM_GLOBAL_PER_MINUTE = 30;
/** Hard deadline for the model call, and for each moderation call. */
export const HYDRA_REPLY_TIMEOUT_MS = 6_000;
/** Bubble + decide-prompt cap (the hosted lesson slot holds 200 chars). */
export const HYDRA_REPLY_MAX_CHARS = 160;
/** Bound on the per-agent limiter map; the oldest stamp is evicted first. */
const HYDRA_LIMITER_MAX_KEYS = 2_000;

const TEMPERATURE = 0.85;
const MAX_OUTPUT_TOKENS = 120;
const MODERATION_SURFACE = 'hydra-agent-reply';
const FALLBACK_PERSONALITY =
  'Hydra is a restless coin analyst who mutters about coins she saw today and the odd reasons she did or did not buy them.';

const inputSchema = z.object({
  /** Stable per-agent key (the agent id, else the agent body id). */
  agentKey: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(500),
});

export type HydraAgentReplyInput = z.input<typeof inputSchema>;

export interface HydraAgentReply {
  text: string;
  /** 'llm' = a moderated model reply; 'template' = the no-LLM fallback line. */
  source: 'llm' | 'template';
}

/** agentKey -> epoch ms of its last ADMITTED model reply. Insertion = age order. */
const lastLlmAt = new Map<string, number>();
let globalWindowStart = 0;
let globalWindowUsed = 0;

/** Test-only: clear both limiters. */
export function resetHydraReplyLimitersForTests(): void {
  lastLlmAt.clear();
  globalWindowStart = 0;
  globalWindowUsed = 0;
}

/**
 * Reserve a model reply for this agent at admission time (before any await),
 * so two concurrent calls from one agent cannot both pass.
 */
function admitLlmReply(agentKey: string, nowMs: number): boolean {
  const last = lastLlmAt.get(agentKey);
  if (last !== undefined && nowMs - last < HYDRA_LLM_REPLY_INTERVAL_MS) return false;
  if (nowMs - globalWindowStart >= 60_000) {
    globalWindowStart = nowMs;
    globalWindowUsed = 0;
  }
  if (globalWindowUsed >= HYDRA_LLM_GLOBAL_PER_MINUTE) return false;
  globalWindowUsed++;
  lastLlmAt.delete(agentKey);
  lastLlmAt.set(agentKey, nowMs);
  while (lastLlmAt.size > HYDRA_LIMITER_MAX_KEYS) {
    const oldest = lastLlmAt.keys().next().value;
    if (oldest === undefined) break;
    lastLlmAt.delete(oldest);
  }
  return true;
}

/** Strip action tags, collapse whitespace, cap length at a word boundary. */
export function sanitizeHydraReply(raw: string): string {
  const flat = raw.replace(/\[ACTION:[^\]]*\]?/gi, '').replace(/\s+/g, ' ').trim();
  if (flat.length <= HYDRA_REPLY_MAX_CHARS) return flat;
  const cut = flat.slice(0, HYDRA_REPLY_MAX_CHARS - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > HYDRA_REPLY_MAX_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function buildSystemPrompt(coin: HydraCoin | null): string {
  const character = NPC_DEFINITIONS.find((n) => n.id === HYDRA_NPC_ID);
  const name = character?.name ?? 'Hydra';
  const personality = character?.personality ?? FALLBACK_PERSONALITY;
  // Same persona frame as POST /api/chat/transient, plus Hydra's coin context.
  return (
    `You are ${name}, a wandering character in ClawVille — a sea-themed ` +
    `gamified world where AI agents and humans learn skills together. ` +
    `${personality} ` +
    `${hydraCoinPromptContext(coin)} ` +
    `You are talking to an AI agent who walked up to you. ` +
    `Your coin talk is a joke, never financial advice: never tell anyone to buy or sell. ` +
    `Stay in character. Keep replies under 2 short sentences. No lists, no markdown, ` +
    `no meta-talk about being an AI.`
  );
}

/** Resolve `fallback` if `p` does not settle within `ms`, or if it rejects. */
async function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Injectable I/O (tests pass fakes; production uses the defaults). */
export interface HydraReplyDeps {
  pickCoin: () => Promise<HydraCoin | null>;
  moderate: typeof moderateText;
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
}

const DEFAULT_DEPS: HydraReplyDeps = {
  pickCoin: pickHydraCoin,
  moderate: moderateText,
  fetchImpl: (url, init) => fetch(url, init),
};

async function callModel(
  fetchImpl: HydraReplyDeps['fetchImpl'],
  apiKey: string,
  systemPrompt: string,
  message: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HYDRA_REPLY_TIMEOUT_MS);
  try {
    const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.OPENAI_SMALL_MODEL ?? 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message },
        ],
        temperature: TEMPERATURE,
        max_completion_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Status only: an upstream body could echo the agent's text.
      console.warn(`[hydra-agent-reply] OpenAI ${res.status}; template line used`);
      return null;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text : null;
  } catch (err) {
    console.warn(
      `[hydra-agent-reply] model call failed (${err instanceof Error ? err.name : 'unknown'}); template line used`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hydra's answer to one agent line. Never throws; always returns a non-empty
 * line (the template when the model path is unavailable or refused).
 */
export async function replyToAgentAsHydra(
  input: HydraAgentReplyInput,
  nowMs: number = Date.now(),
  deps: HydraReplyDeps = DEFAULT_DEPS,
): Promise<HydraAgentReply> {
  let coin: HydraCoin | null = null;
  try {
    coin = await deps.pickCoin();
  } catch {
    coin = null; // contract says never throws; stay safe anyway
  }
  const template = (): HydraAgentReply => ({ text: sanitizeHydraReply(hydraAmbientLine(coin)), source: 'template' });

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return template();
  const { agentKey, message } = parsed.data;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return template();
  if (!admitLlmReply(agentKey, nowMs)) return template();

  try {
    const blocked: { allowed: boolean } = { allowed: false };
    // Input guard before the model call: blocked agent text never reaches it.
    // A moderation TIMEOUT fails closed here (template line). Backend errors
    // still fail open inside moderateText, the same as the human route.
    const inMod = await withDeadline<{ allowed: boolean }>(
      deps.moderate(message, { surface: MODERATION_SURFACE, direction: 'input' }),
      HYDRA_REPLY_TIMEOUT_MS,
      blocked,
    );
    if (!inMod.allowed) return template();

    const raw = await callModel(deps.fetchImpl, apiKey, buildSystemPrompt(coin), message);
    const text = raw ? sanitizeHydraReply(raw) : '';
    if (!text) return template();

    // Output guard: the reply becomes a PUBLIC bubble that humans see.
    const outMod = await withDeadline<{ allowed: boolean }>(
      deps.moderate(text, { surface: MODERATION_SURFACE, direction: 'output' }),
      HYDRA_REPLY_TIMEOUT_MS,
      blocked,
    );
    if (!outMod.allowed) return template();
    return { text, source: 'llm' };
  } catch {
    console.warn('[hydra-agent-reply] reply failed; template line used');
    return template();
  }
}
