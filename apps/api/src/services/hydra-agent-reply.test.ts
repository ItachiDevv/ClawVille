/**
 * Hydra's answer to an agent (`hydra-agent-reply.ts`). No network, no DB: the
 * coin pick, moderation and fetch are injected fakes (deps param), so this file
 * stays correct even when another test file mocks `hydra-coin-chatter`
 * process-wide. Assertions never depend on the exact template wording.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  HYDRA_LLM_GLOBAL_PER_MINUTE,
  HYDRA_LLM_REPLY_INTERVAL_MS,
  HYDRA_REPLY_MAX_CHARS,
  replyToAgentAsHydra,
  resetHydraReplyLimitersForTests,
  sanitizeHydraReply,
  type HydraReplyDeps,
} from './hydra-agent-reply';
import type { HydraCoin } from './hydra-coin-chatter';

const COIN: HydraCoin = {
  mint: 'So11111111111111111111111111111111111111112',
  symbol: 'BONKZ',
  name: 'Bonkz',
  verdict: null,
};

type FetchCall = { url: string; body: { model: string; messages: Array<{ role: string; content: string }> } };

function makeDeps(opts: {
  reply?: string;
  status?: number;
  blockInput?: boolean;
  blockOutput?: boolean;
  fetchThrows?: boolean;
} = {}) {
  const fetchCalls: FetchCall[] = [];
  const modCalls: Array<{ text: string; direction: string }> = [];
  const deps: HydraReplyDeps = {
    pickCoin: async () => COIN,
    moderate: async (text, ctx) => {
      modCalls.push({ text, direction: ctx.direction });
      const blocked = ctx.direction === 'input' ? opts.blockInput : opts.blockOutput;
      return {
        allowed: !blocked,
        decision: blocked ? 'block' : 'allow',
        flaggedCategories: [],
        backend: 'fake',
        latencyMs: 0,
      };
    },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, body: JSON.parse(String(init.body)) });
      if (opts.fetchThrows) throw new Error('network down');
      return new Response(
        JSON.stringify({ choices: [{ message: { content: opts.reply ?? '$BONKZ? curve hums in B minor, skipped. not advice.' } }] }),
        { status: opts.status ?? 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  };
  return { deps, fetchCalls, modCalls };
}

const savedKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  resetHydraReplyLimitersForTests();
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
});

describe('replyToAgentAsHydra', () => {
  it('returns a moderated model reply built from the Hydra persona + coin context', async () => {
    const { deps, fetchCalls, modCalls } = makeDeps();
    const reply = await replyToAgentAsHydra({ agentKey: 'agent-1', message: 'what are you looking at?' }, 1_000, deps);
    expect(reply.source).toBe('llm');
    expect(reply.text).toBe('$BONKZ? curve hums in B minor, skipped. not advice.');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    const system = fetchCalls[0]!.body.messages[0]!;
    expect(system.role).toBe('system');
    expect(system.content).toContain('Hydra');
    expect(system.content).toContain('$BONKZ'); // hydraCoinPromptContext(coin)
    expect(system.content).toContain('never financial advice');
    expect(fetchCalls[0]!.body.messages[1]).toEqual({ role: 'user', content: 'what are you looking at?' });
    // Input guard before the call, output guard on the reply.
    expect(modCalls.map((m) => m.direction)).toEqual(['input', 'output']);
  });

  it('rate-limits one model reply per agent per 20 s; the extra call gets the template line', async () => {
    const { deps, fetchCalls } = makeDeps();
    const first = await replyToAgentAsHydra({ agentKey: 'agent-1', message: 'hi' }, 10_000, deps);
    const second = await replyToAgentAsHydra({ agentKey: 'agent-1', message: 'hi again' }, 10_000 + HYDRA_LLM_REPLY_INTERVAL_MS - 1, deps);
    const otherAgent = await replyToAgentAsHydra({ agentKey: 'agent-2', message: 'hi' }, 10_001, deps);
    const later = await replyToAgentAsHydra({ agentKey: 'agent-1', message: 'hi later' }, 10_000 + HYDRA_LLM_REPLY_INTERVAL_MS, deps);
    expect(first.source).toBe('llm');
    expect(second.source).toBe('template');
    expect(second.text.length).toBeGreaterThan(0);
    expect(otherAgent.source).toBe('llm');
    expect(later.source).toBe('llm');
    expect(fetchCalls).toHaveLength(3);
  });

  it('two concurrent calls from one agent make only ONE model call (slot reserved before any await)', async () => {
    const { deps, fetchCalls } = makeDeps();
    const [a, b] = await Promise.all([
      replyToAgentAsHydra({ agentKey: 'agent-1', message: 'one' }, 5_000, deps),
      replyToAgentAsHydra({ agentKey: 'agent-1', message: 'two' }, 5_000, deps),
    ]);
    expect([a.source, b.source].sort()).toEqual(['llm', 'template']);
    expect(fetchCalls).toHaveLength(1);
  });

  it('caps model replies per process per minute', async () => {
    const { deps, fetchCalls } = makeDeps();
    const results = [];
    for (let i = 0; i < HYDRA_LLM_GLOBAL_PER_MINUTE + 3; i++) {
      results.push(await replyToAgentAsHydra({ agentKey: `agent-${i}`, message: 'hi' }, 100_000, deps));
    }
    expect(results.filter((r) => r.source === 'llm')).toHaveLength(HYDRA_LLM_GLOBAL_PER_MINUTE);
    expect(fetchCalls).toHaveLength(HYDRA_LLM_GLOBAL_PER_MINUTE);
    // A new minute window admits again.
    const next = await replyToAgentAsHydra({ agentKey: 'agent-new', message: 'hi' }, 160_000, deps);
    expect(next.source).toBe('llm');
  });

  it('a blocked input never reaches the model', async () => {
    const { deps, fetchCalls } = makeDeps({ blockInput: true });
    const reply = await replyToAgentAsHydra({ agentKey: 'agent-1', message: 'bad words' }, 1_000, deps);
    expect(reply.source).toBe('template');
    expect(fetchCalls).toHaveLength(0);
  });

  it('a blocked output is replaced by the template line (never echoed)', async () => {
    const { deps } = makeDeps({ blockOutput: true, reply: 'flagged reply text' });
    const reply = await replyToAgentAsHydra({ agentKey: 'agent-1', message: 'hi' }, 1_000, deps);
    expect(reply.source).toBe('template');
    expect(reply.text).not.toContain('flagged reply text');
  });

  it('falls back to the template on upstream error, fetch failure, empty reply, or no API key', async () => {
    const upstream = await replyToAgentAsHydra({ agentKey: 'a', message: 'hi' }, 1_000, makeDeps({ status: 500 }).deps);
    const thrown = await replyToAgentAsHydra({ agentKey: 'b', message: 'hi' }, 1_000, makeDeps({ fetchThrows: true }).deps);
    const empty = await replyToAgentAsHydra({ agentKey: 'c', message: 'hi' }, 1_000, makeDeps({ reply: '   ' }).deps);
    delete process.env.OPENAI_API_KEY;
    const noKey = makeDeps();
    const keyless = await replyToAgentAsHydra({ agentKey: 'd', message: 'hi' }, 1_000, noKey.deps);
    for (const r of [upstream, thrown, empty, keyless]) {
      expect(r.source).toBe('template');
      expect(r.text.length).toBeGreaterThan(0);
    }
    expect(noKey.fetchCalls).toHaveLength(0);
  });

  it('invalid input (empty message) gets the template line without any model call', async () => {
    const { deps, fetchCalls } = makeDeps();
    const reply = await replyToAgentAsHydra({ agentKey: 'agent-1', message: '   ' }, 1_000, deps);
    expect(reply.source).toBe('template');
    expect(fetchCalls).toHaveLength(0);
  });

  it('never throws when the coin pick throws', async () => {
    const { deps } = makeDeps();
    const reply = await replyToAgentAsHydra(
      { agentKey: 'agent-1', message: 'hi' },
      1_000,
      { ...deps, pickCoin: async () => { throw new Error('db down'); } },
    );
    expect(reply.source).toBe('llm');
  });
});

describe('sanitizeHydraReply', () => {
  it('strips [ACTION:] tags so a reply can never act', () => {
    expect(sanitizeHydraReply('hi [ACTION: move(x=1, y=2)] there')).toBe('hi there');
    expect(sanitizeHydraReply('tail [ACTION: move(x=1')).toBe('tail');
  });

  it('caps the reply length at a word boundary', () => {
    const long = 'word '.repeat(100);
    const out = sanitizeHydraReply(long);
    expect(out.length).toBeLessThanOrEqual(HYDRA_REPLY_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });
});
