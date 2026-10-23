import { beforeEach, describe, expect, test } from 'bun:test';
import { ECOSYSTEM_CATALOG, servedEcosystemCatalog } from '@clawville/shared';
import { ecosystemRoutes, resetEcosystemCatalogRateLimit } from '../ecosystem';
import { PROTOCOL_VERSION, resolveApiBase } from '../../services/skill-protocol';

beforeEach(() => {
  resetEcosystemCatalogRateLimit();
});

describe('GET /api/ecosystem/catalog', () => {
  test('returns 200 JSON with the protocol version and only the served rows', async () => {
    const response = await ecosystemRoutes.request('/catalog');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    const body = (await response.json()) as { protocolVersion: number; entries: Array<{ id: string; status: string; mcpUrl?: string }> };
    expect(Object.keys(body).sort()).toEqual(['entries', 'protocolVersion']);
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(body.entries).toEqual(JSON.parse(JSON.stringify(servedEcosystemCatalog(resolveApiBase()))));
    expect(body.entries.map((entry) => entry.id)).toEqual(['clawville', 'studios', 'atelier', 'shinjuku', 'paysh']);
    const bodyText = JSON.stringify(body).toLowerCase();
    for (const term of ['said', 'trader' + ' ralph', 'penguin' + 'xbt', 'hot' + ' bot', 'hot' + 'bot']) {
      expect({ term, found: bodyText.includes(term) }).toEqual({ term, found: false });
    }
    for (const entry of body.entries) expect(entry.status).toBe('available');
    for (const planned of ECOSYSTEM_CATALOG.filter((entry) => entry.status === 'planned')) {
      expect(body.entries.some((entry) => entry.id === planned.id)).toBe(false);
    }
    expect(body.entries[0]!.mcpUrl).toBe(`${resolveApiBase()}/api/agent/mcp`);
  });

  test('applies the public 60 per minute per IP limit', async () => {
    const headers = { 'x-real-ip': '203.0.113.7' };
    for (let i = 0; i < 60; i++) {
      expect((await ecosystemRoutes.request('/catalog', { headers })).status).toBe(200);
    }
    const limited = await ecosystemRoutes.request('/catalog', { headers });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited', message: 'Too many requests. Try again shortly.' });
    // Another IP keeps its own budget.
    expect((await ecosystemRoutes.request('/catalog', { headers: { 'x-real-ip': '203.0.113.8' } })).status).toBe(200);
  });
});
