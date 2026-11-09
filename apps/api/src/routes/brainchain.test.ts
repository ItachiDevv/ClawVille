import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { Hono } from 'hono';
import { jsonBodyGuard } from '../middleware/json-body-guard';
import { buildBrainchainOfficeManual } from '@clawville/shared';
import { createBrainChainRoutes } from './brainchain';
import { createBrainChainPublicClient } from '../services/brainchain/public-client';
import { createBrainChainStatusService } from '../services/brainchain/status';

describe('BrainChain public routes', () => {
  test('rejects oversized chunked requests before the global JSON parser', async () => {
    let emitted = 0;
    let parserVisited = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += 1024;
        controller.enqueue(new Uint8Array(1024).fill(32));
        if (emitted === 64 * 1024) controller.close();
      },
    });
    const app = new Hono();
    app.route('/api/brainchain', createBrainChainRoutes());
    app.use('*', async (c, next) => { parserVisited = true; return jsonBodyGuard(c, next); });
    const response = await app.request('/api/brainchain/workers/challenge', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body });
    expect(response.status).toBe(413);
    expect(parserVisited).toBe(false);
    expect(emitted).toBeLessThan(64 * 1024);
    const index = await Bun.file(new URL('../index.ts', import.meta.url)).text();
    expect(index.indexOf("app.route('/api/brainchain', brainchainRoutes)")).toBeLessThan(index.indexOf("app.use('*', jsonBodyGuard)"));
  });
  test('human and agent callers receive exact canonical manual bytes and hash', async () => {
    const routes = createBrainChainRoutes();
    const human = await routes.request('/knowledge');
    const agent = await routes.request('/knowledge', { headers: { 'X-Clawville-Agent-Session': 'public-read-does-not-authorize-writes' } });
    expect(human.status).toBe(200);
    const raw = await human.json();
    expect(raw).toEqual(await agent.json());
    const body = z.object({ manual: z.string(), contentHash: z.string() }).parse(raw);
    expect(body.manual).toBe(buildBrainchainOfficeManual());
    expect(body.contentHash).toBe(createHash('sha256').update(body.manual).digest('hex'));
    expect(human.headers.get('cache-control')).toBe('public, max-age=300');
  });

  test('rate limits public callers', async () => {
    const routes = createBrainChainRoutes();
    for (let index = 0; index < 60; index++) expect((await routes.request('/knowledge')).status).toBe(200);
    const rejected = await routes.request('/knowledge');
    expect(rejected.status).toBe(429);
    expect(z.object({ error: z.string() }).parse(await rejected.json()).error).toBe('rate_limited');
  });

  test('returns sanitized live failure observations without enabling execution', async () => {
    const client = createBrainChainPublicClient({
      validateUrl: async (url) => ({ ok: true as const, url }),
      fetch: (async () => { throw new Error('private upstream detail'); }) as unknown as typeof fetch,
    });
    const routes = createBrainChainRoutes(createBrainChainStatusService(client));
    const response = await routes.request('/status');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = z.object({ observation: z.object({
      executionEnabled: z.boolean(), payment: z.object({ reason: z.string() }),
      exits: z.object({ testnet: z.object({ state: z.string() }) }),
    }) }).passthrough().parse(await response.json());
    expect(body.observation.executionEnabled).toBe(false);
    expect(body.observation.payment.reason).toBe('request_failed');
    expect(body.observation.exits.testnet.state).toBe('unavailable');
    expect(JSON.stringify(body)).not.toContain('private upstream detail');
  });
});
