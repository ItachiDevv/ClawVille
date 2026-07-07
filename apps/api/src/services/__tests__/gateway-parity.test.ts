/**
 * P3 slice 3 — gateway-parity proof (config-path, NO new orchestration).
 *
 * Proves the "Eliza-memory wrapper" claim's cognition half: a hosted agent with
 * `customization.gateway` set routes its TEXT generation through the
 * `openclaw-provider` (an ElizaOS TEXT provider) to an external OpenAI-compat
 * endpoint — while ElizaOS keeps ownership of memory persist + RAG (the provider
 * registers NO embedding/memory handler, so those stay on the SQL adapter no
 * matter which TEXT provider answers). Config-path only: NO HermesClient (deleted
 * this slice), NO bespoke orchestration — just the plugin the orchestrator
 * already installs when `customization.gateway` is present.
 *
 * Driven in-process against a mock OpenAI-compat server (Bun.serve), mirroring
 * scripts/agent-connect/mock-hermes-server.ts, so it is deterministic + DB-free.
 */

import { describe, expect, it } from 'bun:test';
import { createOpenClawProviderPlugin } from '@clawville/agent-runtime';
// NB: @elizaos/core is not directly resolvable from the apps/api test cwd, so we
// assert against the plugin's own `models` map (keyed by ModelType.TEXT_*) rather
// than importing ModelType — the provider builds the keys, we verify the shape.

describe('P3 slice 3 — gateway-parity (config-path proof)', () => {
  it('routes TEXT cognition through openclaw-provider to a customization.gateway endpoint', async () => {
    const received: { path?: string; method?: string; auth?: string; model?: string; prompt?: string } = {};
    const server = Bun.serve({
      port: 0, // ephemeral free port
      async fetch(req) {
        const url = new URL(req.url);
        received.path = url.pathname;
        received.method = req.method;
        received.auth = req.headers.get('authorization') ?? undefined;
        const body = (await req.json()) as { model?: string; messages?: Array<{ content?: string }> };
        received.model = body.model;
        received.prompt = body.messages?.[0]?.content;
        return Response.json({ choices: [{ message: { content: 'ROUTED_VIA_GATEWAY' } }] });
      },
    });

    try {
      const plugin = createOpenClawProviderPlugin({
        gatewayUrl: `http://localhost:${server.port}`,
        authToken: 'test-token-123',
        agentId: 'agent-xyz',
        protocol: 'openai-compat',
      });

      // Priority 100 > the OpenAI text provider's 95 → the gateway WINS
      // TEXT_SMALL/TEXT_LARGE routing whenever customization.gateway is set.
      expect(plugin.priority).toBe(100);

      // The provider registers EXACTLY the two TEXT model types (TEXT_SMALL +
      // TEXT_LARGE) and nothing else — critically NO embedding/memory handler, so
      // memory persist + RAG stay on the SQL adapter regardless of which TEXT
      // provider answered (the "ElizaOS still persists + retrieves memory" half of
      // the wrapper proof).
      const models = plugin.models ?? {};
      const modelKeys = Object.keys(models).sort();
      expect(modelKeys).toEqual(['TEXT_LARGE', 'TEXT_SMALL']);
      expect(modelKeys.some((k) => /embed/i.test(k))).toBe(false);

      // Both text model types route through the SAME gateway handler.
      const handlers = Object.values(models) as Array<(rt: unknown, params: unknown) => Promise<string>>;
      expect(handlers.length).toBe(2);
      expect(handlers[0]).toBe(handlers[1]);

      const out = await handlers[0]({}, { prompt: 'hello wrapper', maxTokens: 32 });
      expect(out).toBe('ROUTED_VIA_GATEWAY');

      // The cognition really hit the external gateway with the agent's prompt +
      // bearer + the openclaw:<agentId> model tag — proving config-path routing.
      expect(received.method).toBe('POST');
      expect(received.path).toBe('/v1/chat/completions');
      expect(received.auth).toBe('Bearer test-token-123');
      expect(received.model).toBe('openclaw:agent-xyz');
      expect(received.prompt).toBe('hello wrapper');
    } finally {
      server.stop(true);
    }
  });
});
