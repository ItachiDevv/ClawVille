import { afterEach, describe, expect, it } from 'bun:test';
import { AgentSubstrateClient } from '../agent-substrate-client';

// Security fix D3 (2026-09-30): the hosted local runtimes (hermes-local / openclaw-local) are
// tool-capable. With no gateway key configured the client must send NOTHING — before this fix it
// sent a bare, unauthenticated POST. The keys are read once at module load, so this suite runs only
// when the test environment leaves them unset (the normal case).
const keysUnset = !process.env.HERMES_LOCAL_GATEWAY_KEY && !process.env.OPENCLAW_LOCAL_GATEWAY_KEY;

function client(protocol: 'hermes-local' | 'openclaw-local'): AgentSubstrateClient {
  return new AgentSubstrateClient({
    agentId: `fail-closed-${protocol}`,
    sessionId: 'fail-closed-session',
    gatewayUrl: 'http://localhost:0',
    authToken: '',
    protocol,
    species: 'milady_official_1',
    color: 0x888888,
  } as never);
}

describe.skipIf(!keysUnset)('local runtime clients fail closed without a gateway key (D3)', () => {
  const realFetch = globalThis.fetch;
  let calls = 0;

  afterEach(() => {
    globalThis.fetch = realFetch;
    calls = 0;
  });

  function stubFetch(): void {
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'should not be reached' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
  }

  for (const protocol of ['hermes-local', 'openclaw-local'] as const) {
    it(`${protocol}: chat returns '' and never calls fetch`, async () => {
      stubFetch();
      const reply = await client(protocol).chat([{ role: 'user', content: 'hello' }]);
      expect(reply).toBe('');
      expect(calls).toBe(0);
    });

    it(`${protocol}: prewarm never calls fetch`, async () => {
      stubFetch();
      await client(protocol).prewarmLocalGateway(1_000);
      expect(calls).toBe(0);
    });
  }
});
