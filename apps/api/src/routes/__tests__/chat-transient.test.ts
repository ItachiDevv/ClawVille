/**
 * POST /api/chat/transient: the Hydra coin addendum.
 *
 * Drives the REAL route with the coin chatter mocked (`mock.module`, so no DB), the moderation
 * backend set through its test seam, and `fetch` stubbed to capture the OpenAI request body.
 * Proves: Hydra's system prompt gets the coin context (one pick per request); every other NPC's
 * system prompt is byte-identical to the pre-Hydra template and never triggers a pick.
 * Runs in its own process under `bun run test:ci` (mock.module is process-global).
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { NPC_DEFINITIONS } from '@clawville/shared';
import { __setModerationBackendForTests } from '../../services/moderation-service';

type Coin = { mint: string; symbol: string; name: string | null; verdict: string | null };

let nextCoin: Coin | null = null;
const pickHydraCoin = mock(async () => nextCoin);

mock.module('../../services/hydra-coin-chatter', () => ({
  HYDRA_NPC_ID: 'hydra-analyst',
  pickHydraCoin,
  hydraCoinPromptContext: (coin: Coin | null) => `CTX:${coin ? coin.symbol : 'none'}`,
  // npc-simulation (reached through the shared agent-session middleware) imports this template.
  hydraAmbientLine: () => 'ambient',
}));

const { transientChatRoutes } = await import('../chat-transient');

const realFetch = globalThis.fetch;
const sentBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
const OLD_KEY = process.env.OPENAI_API_KEY;

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  __setModerationBackendForTests({ name: 'test', moderate: async () => ({ flagged: false, categories: [] }) });
  pickHydraCoin.mockClear();
  sentBodies.length = 0;
  nextCoin = null;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    sentBodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'beep. skipped it.' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  __setModerationBackendForTests(null);
  if (OLD_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = OLD_KEY;
});

async function talk(characterName: string) {
  const res = await transientChatRoutes.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': '203.0.113.7' },
    body: JSON.stringify({ characterName, message: 'what are you looking at?' }),
  });
  return res;
}

/** The pre-Hydra template, verbatim from chat-transient.ts. */
function baseSystemPrompt(name: string, personality: string): string {
  return (
    `You are ${name}, a wandering character in ClawVille — a sea-themed ` +
    `gamified world where AI agents and humans learn skills together. ` +
    `${personality} ` +
    `Stay in character. Keep replies under 2 short sentences. No lists, no markdown, ` +
    `no meta-talk about being an AI. If the user says something off-topic, deflect ` +
    `playfully back to ClawVille.`
  );
}

describe('chat-transient Hydra coin context', () => {
  const hydra = NPC_DEFINITIONS.find((n) => n.id === 'hydra-analyst')!;

  it('Hydra exists as a free roamer named Hydra', () => {
    expect(hydra).toBeDefined();
    expect(hydra.name).toBe('Hydra');
    expect(hydra.buildingId).toBe('');
  });

  it('appends the coin context to Hydra\'s system prompt (one pick per request)', async () => {
    nextCoin = { mint: 'M', symbol: 'BONKZ', name: null, verdict: null };
    const res = await talk('hydra');
    expect(res.status).toBe(200);
    expect(pickHydraCoin).toHaveBeenCalledTimes(1);
    expect(sentBodies[0]!.messages[0]).toEqual({
      role: 'system',
      content: `${baseSystemPrompt(hydra.name, hydra.personality)} CTX:BONKZ`,
    });
  });

  it('passes a null coin through to the generic tape context', async () => {
    nextCoin = null;
    const res = await talk('Hydra');
    expect(res.status).toBe(200);
    expect(sentBodies[0]!.messages[0]!.content.endsWith(' CTX:none')).toBe(true);
  });

  it('leaves every other NPC byte-identical and never picks a coin for them', async () => {
    const others = NPC_DEFINITIONS.filter((n) => n.id !== 'hydra-analyst');
    expect(others.length).toBeGreaterThan(0);
    for (const npc of others) {
      sentBodies.length = 0;
      const res = await talk(npc.name);
      expect(res.status).toBe(200);
      expect(sentBodies[0]!.messages[0]!.content).toBe(baseSystemPrompt(npc.name, npc.personality));
    }
    expect(pickHydraCoin).not.toHaveBeenCalled();
  });
});
