import { afterAll, describe, expect, mock, test } from 'bun:test';

// The topic route sits behind the same `agentSessionOrPartnerKey` gate as
// /protocol/skill.md. Stub only the live-session validator so a known bearer
// passes; the real copy is restored in afterAll so a single-process run does
// not leak the stub into later test files.
const realAuth = { ...(await import('../../middleware/require-auth-or-agent')) };
const LIVE_BEARER = 'ag-topic-test-bearer';
mock.module('../../middleware/require-auth-or-agent', () => ({
  ...realAuth,
  validateLiveAgentSession: async (sessionId: string) =>
    sessionId === LIVE_BEARER
      ? { config: { agentId: 'topic-test-agent', ledgerCapable: false, boundUserId: null }, bot: { userId: null } }
      : null,
}));

// The manifest reads building_skills rows; an empty table is enough here.
const realDatabase = { ...(await import('@clawville/database')) };
mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: { select: () => ({ from: async () => [] }) },
}));

const { skillsRoutes } = await import('../skills');
const {
  PROTOCOL_TOPICS,
  PROTOCOL_VERSION,
  buildProtocolTopic,
  contentHashOf,
  resolveApiBase,
} = await import('../../services/skill-protocol');

afterAll(() => {
  mock.module('../../middleware/require-auth-or-agent', () => realAuth);
  mock.module('@clawville/database', () => realDatabase);
});

const AUTH = { 'X-Clawville-Agent-Session': LIVE_BEARER };

describe('GET /api/skills/protocol/:topic.md', () => {
  test('serves every topic page with its own name, version and content hash', async () => {
    for (const { id } of PROTOCOL_TOPICS) {
      const response = await skillsRoutes.request(`/protocol/${id}.md`, { headers: AUTH });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toBe(buildProtocolTopic(resolveApiBase(), id));
      expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      expect(response.headers.get('x-skill-name')).toBe(`clawville-protocol-${id}`);
      expect(response.headers.get('x-skill-version')).toBe(String(PROTOCOL_VERSION));
      expect(response.headers.get('x-skill-content-hash')).toBe(contentHashOf(body));
    }
  });

  test('returns 404 unknown_topic with the topic ids for a bad id', async () => {
    const response = await skillsRoutes.request('/protocol/not-a-topic.md', { headers: AUTH });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'unknown_topic',
      topics: PROTOCOL_TOPICS.map((t) => t.id),
    });
  });

  test('skill.md still serves the full manual, not a topic', async () => {
    const response = await skillsRoutes.request('/protocol/skill.md', { headers: AUTH });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-skill-name')).toBe('clawville-connection-protocol');
  });

  test('manifest lists protocolTopics with the served page hash and keeps the protocol pointer shape', async () => {
    const response = await skillsRoutes.request('/manifest.json', { headers: AUTH });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      protocol: Record<string, unknown>;
      protocolTopics: Array<{ id: string; title: string; summary: string; url: string; contentHash: string }>;
    };
    expect(Object.keys(body.protocol).sort()).toEqual(['contentHash', 'url', 'version']);
    expect(body.protocolTopics.map((t) => t.id)).toEqual(PROTOCOL_TOPICS.map((t) => t.id));
    for (const topic of body.protocolTopics) {
      expect(topic.url).toBe(`/api/skills/protocol/${topic.id}.md`);
      const page = await skillsRoutes.request(`/protocol/${topic.id}.md`, { headers: AUTH });
      expect(topic.contentHash).toBe(page.headers.get('x-skill-content-hash')!);
    }
  });

  test('refuses a caller without a live session or partner key', async () => {
    const response = await skillsRoutes.request('/protocol/core.md');
    expect(response.status).toBe(401);
  });
});
