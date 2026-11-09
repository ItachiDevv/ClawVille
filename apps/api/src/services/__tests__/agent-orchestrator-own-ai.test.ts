/**
 * Own AI (2026-11-09) — orchestrator wiring.
 *
 * Drives `buildOwnAiPluginConfig` with injected service deps (no DB, no env)
 * and the singleton's own-AI state helpers with a monkey-patched running map
 * (same pattern as earned-skill-memory.test.ts). No process env is set.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  agentOrchestrator,
  buildOwnAiPluginConfig,
  type OwnAiLiveState,
  type OwnAiServiceDeps,
} from '../agent-orchestrator';
import type { OwnAiRuntimeConfig } from '../own-ai';

const KEY = 'sk-or-TESTSECRETKEY0123456789abcdef';

function cfg(over: Partial<OwnAiRuntimeConfig> = {}): OwnAiRuntimeConfig {
  return {
    avatarId: 'av-1',
    provider: 'openrouter',
    protocol: 'openai-compat',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: KEY,
    model: 'deepseek/deepseek-chat-v3.1',
    reasoning: false,
    maxTokensFloor: 0,
    timeoutMs: 20_000,
    speedSeconds: 10,
    ...over,
  };
}

function freshState(): OwnAiLiveState {
  return { avatarId: 'av-1', speedSeconds: 10, timeoutMs: 20_000, fallbackReason: null, gateFailure: false };
}

const RES = { microUsd: 1234, day: '2026-11-09' };
const EST = { inputTokens: 100, outputTokens: 200 };

function deps(over: Partial<OwnAiServiceDeps> = {}) {
  const usage: unknown[][] = [];
  const fallbacks: unknown[][] = [];
  const gates: unknown[][] = [];
  const released: unknown[][] = [];
  const d: OwnAiServiceDeps = {
    mayCall: async (...a) => {
      gates.push(a);
      return RES;
    },
    recordUsage: async (...a) => {
      usage.push(a);
    },
    release: async (...a) => {
      released.push(a);
    },
    recordFallback: async (...a) => {
      fallbacks.push(a);
    },
    ...over,
  };
  return { d, usage, fallbacks, gates, released };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('buildOwnAiPluginConfig', () => {
  it('passes the runtime config through and adds OpenRouter headers only for openrouter', () => {
    const s = freshState();
    const c = buildOwnAiPluginConfig(cfg(), s, deps().d);
    expect(c.protocol).toBe('openai-compat');
    expect(c.apiKey).toBe(KEY);
    expect(c.timeoutMs).toBe(20_000);
    expect(c.extraHeaders).toEqual({ 'HTTP-Referer': 'https://clawville.world', 'X-Title': 'ClawVille' });
    const a = buildOwnAiPluginConfig(cfg({ provider: 'anthropic', protocol: 'anthropic' }), s, deps().d);
    expect(a.extraHeaders).toBeUndefined();
  });

  it('mayCall: passes the avatar, the configured model and the estimate; returns the reservation or null', async () => {
    const s = freshState();
    const t = deps();
    expect(await buildOwnAiPluginConfig(cfg(), s, t.d).mayCall(EST)).toEqual(RES);
    expect(t.gates).toEqual([['av-1', 'deepseek/deepseek-chat-v3.1', EST]]);
    expect(await buildOwnAiPluginConfig(cfg(), s, deps({ mayCall: async () => null }).d).mayCall(EST)).toBeNull();
    expect(s.gateFailure).toBe(false);
  });

  it('mayCall: a slow gate fails CLOSED after the timeout and releases the late reservation', async () => {
    const s = freshState();
    const slow = deps({ mayCall: () => new Promise((r) => setTimeout(() => r(RES), 60)) });
    const t0 = Date.now();
    const ok = await buildOwnAiPluginConfig(cfg(), s, slow.d, 20).mayCall(EST);
    expect(ok).toBeNull();
    expect(Date.now() - t0).toBeLessThan(400);
    expect(s.gateFailure).toBe(true);
    expect(slow.released).toEqual([]);
    await new Promise((r) => setTimeout(r, 120));
    expect(slow.released).toEqual([['av-1', RES]]);
  });

  it('mayCall: a synchronous throw fails CLOSED', async () => {
    const s = freshState();
    const bad = deps({
      mayCall: (() => {
        throw new Error('sync');
      }) as OwnAiServiceDeps['mayCall'],
    });
    expect(await buildOwnAiPluginConfig(cfg(), s, bad.d).mayCall(EST)).toBeNull();
    expect(s.gateFailure).toBe(true);
  });

  it('onUsage settles THE reservation; onRelease gives it back', async () => {
    const s = freshState();
    const t = deps();
    const c = buildOwnAiPluginConfig(cfg(), s, t.d);
    c.onUsage({ model: 'm', inputTokens: 5, outputTokens: 6 }, RES);
    c.onRelease(RES);
    await flush();
    expect(t.usage).toEqual([['av-1', 'm', 5, 6, RES]]);
    expect(t.released).toEqual([['av-1', RES]]);
  });

  it('mayCall: a throwing gate fails CLOSED', async () => {
    const s = freshState();
    const bad = deps({
      mayCall: async () => {
        throw new Error(`db down ${KEY}`);
      },
    });
    expect(await buildOwnAiPluginConfig(cfg(), s, bad.d).mayCall(EST)).toBeNull();
    expect(s.gateFailure).toBe(true);
  });

  it('onFallback after a gate timeout -> provider_error in memory, nothing persisted', async () => {
    const s = freshState();
    const t = deps();
    const c = buildOwnAiPluginConfig(cfg(), s, t.d);
    s.gateFailure = true;
    c.onFallback('daily_limit');
    await flush();
    expect(s.fallbackReason).toBe('provider_error');
    expect(t.fallbacks).toEqual([]);
  });

  it('onFallback daily_limit (real limit) -> in memory only (ownAiMayCall already persisted it)', async () => {
    const s = freshState();
    const t = deps();
    buildOwnAiPluginConfig(cfg(), s, t.d).onFallback('daily_limit');
    await flush();
    expect(s.fallbackReason).toBe('daily_limit');
    expect(t.fallbacks).toEqual([]);
  });

  it('onFallback persists other reasons once per change; onUsage clears the reason and meters', async () => {
    const s = freshState();
    const t = deps();
    const c = buildOwnAiPluginConfig(cfg(), s, t.d);
    c.onFallback('key_rejected');
    c.onFallback('key_rejected');
    c.onFallback('provider_error');
    await flush();
    expect(t.fallbacks).toEqual([
      ['av-1', 'key_rejected'],
      ['av-1', 'provider_error'],
    ]);
    expect(s.fallbackReason).toBe('provider_error');
    c.onUsage({ model: 'deepseek/deepseek-chat-v3.1', inputTokens: 3000, outputTokens: 200 }, RES);
    await flush();
    expect(s.fallbackReason).toBeNull();
    expect(t.usage).toEqual([['av-1', 'deepseek/deepseek-chat-v3.1', 3000, 200, RES]]);
  });

  it('a failing usage write never throws into the call', async () => {
    const s = freshState();
    const t = deps({
      recordUsage: async () => {
        throw new Error('db down');
      },
    });
    const c = buildOwnAiPluginConfig(cfg(), s, t.d);
    expect(() => c.onUsage({ model: 'm', inputTokens: 1, outputTokens: 1 }, RES)).not.toThrow();
    const r = deps({
      release: async () => {
        throw new Error('db down');
      },
    });
    expect(() => buildOwnAiPluginConfig(cfg(), s, r.d).onRelease(RES)).not.toThrow();
    await flush();
  });
});

describe('orchestrator own-AI state helpers', () => {
  type Running = Map<string, { avatarId?: string; ownAi?: OwnAiLiveState; runtime?: unknown }>;
  const orch = agentOrchestrator as unknown as {
    runningAgents: Running;
    stopAgent: (id: string) => Promise<void>;
  };
  const origStop = orch.stopAgent;
  const added: string[] = [];

  afterEach(() => {
    for (const id of added) orch.runningAgents.delete(id);
    added.length = 0;
    orch.stopAgent = origStop;
  });

  it('speed + timeout: value while own AI works, null when in fallback or no own AI', () => {
    const own = freshState();
    orch.runningAgents.set('agent-own', { avatarId: 'av-1', ownAi: own });
    orch.runningAgents.set('agent-plain', { avatarId: 'av-2' });
    added.push('agent-own', 'agent-plain');
    expect(agentOrchestrator.getOwnAiSpeedSeconds('agent-own')).toBe(10);
    expect(agentOrchestrator.getOwnAiTimeoutMs('agent-own')).toBe(20_000);
    expect(agentOrchestrator.getOwnAiSpeedSeconds('agent-plain')).toBeNull();
    expect(agentOrchestrator.getOwnAiSpeedSeconds('agent-missing')).toBeNull();
    own.fallbackReason = 'daily_limit';
    expect(agentOrchestrator.getOwnAiSpeedSeconds('agent-own')).toBeNull();
    expect(agentOrchestrator.getOwnAiTimeoutMs('agent-own')).toBeNull();
  });

  it('a settings change stops only that avatar runtimes', async () => {
    const stopped: string[] = [];
    orch.stopAgent = async (id: string) => {
      stopped.push(id);
      orch.runningAgents.delete(id);
    };
    orch.runningAgents.set('agent-a', { avatarId: 'av-a' });
    orch.runningAgents.set('agent-b', { avatarId: 'av-b' });
    added.push('agent-a', 'agent-b');
    await agentOrchestrator.handleOwnAiSettingsChanged('av-a');
    expect(stopped).toEqual(['agent-a']);
    expect(orch.runningAgents.has('agent-b')).toBe(true);
  });
});
