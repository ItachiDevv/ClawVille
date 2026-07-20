import { afterAll, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';

process.env.FINGERPRINT_SECRET ??= '11'.repeat(32);

type FindFirstStub = (args?: unknown) => Promise<unknown>;
type UpdateStub = (...args: unknown[]) => unknown;
let agentBotFindFirstStub: FindFirstStub | null = null;
let updateStub: UpdateStub | null = null;

// Keep the real schema/operators but replace only the two DB calls exercised by
// the live-session route test. Every other property delegates lazily to the real
// client, and the two overrides are active only inside that test's try/finally.
const realDatabase = await import('@clawville/database');
const delegateDb = realDatabase.db as unknown as Record<PropertyKey, unknown>;
const agentBotsQuery = new Proxy<Record<PropertyKey, unknown>>({}, {
  get(_target, property) {
    if (property === 'findFirst' && agentBotFindFirstStub) return agentBotFindFirstStub;
    const query = Reflect.get(delegateDb, 'query', delegateDb) as Record<PropertyKey, unknown>;
    const agentBots = Reflect.get(query, 'agentBots', query) as Record<PropertyKey, unknown>;
    return Reflect.get(agentBots, property, agentBots);
  },
});
const queryProxy = new Proxy<Record<PropertyKey, unknown>>({}, {
  get(_target, property) {
    if (property === 'agentBots') return agentBotsQuery;
    const query = Reflect.get(delegateDb, 'query', delegateDb) as Record<PropertyKey, unknown>;
    return Reflect.get(query, property, query);
  },
});
const dbProxy = new Proxy<Record<PropertyKey, unknown>>({}, {
  get(_target, property) {
    if (property === 'query') return queryProxy;
    if (property === 'update' && updateStub) return updateStub;
    return Reflect.get(delegateDb, property, delegateDb);
  },
});
mock.module('@clawville/database', () => ({ ...realDatabase, db: dbProxy }));

afterAll(() => {
  agentBotFindFirstStub = null;
  updateStub = null;
});

const {
  buildAvatarSessionConfig,
  canonicalizePublicAgentIdentityType,
} = await import('../../services/agent-session-config');
const { isReservedPartnerIdentityType } = await import('../../services/reserved-agent-namespaces');
const { AgentSubstrateClient } = await import('../../services/agent-substrate-client');
const { npcSimulation } = await import('../../services/npc-simulation');
const {
  connectSchema,
  joinSchema,
  agentGatewayRoutes,
  pendingConnections,
  presentedIdentityTypeSchema,
  resolvePresentedPublicIdentityType,
} = await import('../agent-gateway');

function buildAgentApp(): Hono {
  const app = new Hono();
  app.route('/api/agent', agentGatewayRoutes);
  return app;
}

function collectWhereFacts(
  node: unknown,
  columns: Set<string>,
  values: unknown[],
): void {
  const candidate = node as {
    queryChunks?: unknown[];
    name?: string;
    columnType?: string;
    value?: unknown;
    constructor?: { name?: string };
  } | null;
  if (!candidate || typeof candidate !== 'object') return;
  if (Array.isArray(candidate.queryChunks)) {
    for (const chunk of candidate.queryChunks) collectWhereFacts(chunk, columns, values);
    return;
  }
  if (candidate.columnType && typeof candidate.name === 'string') columns.add(candidate.name);
  if (candidate.constructor?.name === 'Param' && 'value' in candidate) values.push(candidate.value);
}

function inspectWhere(args: unknown): { columns: Set<string>; values: unknown[] } {
  const columns = new Set<string>();
  const values: unknown[] = [];
  collectWhereFacts((args as { where?: unknown } | undefined)?.where, columns, values);
  return { columns, values };
}

describe('public agent identity input', () => {
  test('trims, lowercases, and accepts bounded framework labels', () => {
    expect(presentedIdentityTypeSchema.parse('  Future_Claw-V2  ')).toBe('future_claw-v2');
    expect(presentedIdentityTypeSchema.safeParse('a'.repeat(32)).success).toBe(true);
    expect(presentedIdentityTypeSchema.safeParse('a'.repeat(33)).success).toBe(false);
    expect(presentedIdentityTypeSchema.safeParse('bad framework').success).toBe(false);
    expect(presentedIdentityTypeSchema.safeParse('framework.example').success).toBe(false);
    expect(presentedIdentityTypeSchema.safeParse('   ').success).toBe(false);
  });

  test('/connect and /join accept novel labels which share the canonical custom value', () => {
    const connect = connectSchema.parse({
      agentId: 'novel-connect-agent',
      identityType: 'FutureClaw',
      identityKey: 'same-secret',
    });
    const join = joinSchema.parse({
      identityType: 'Another_Framework',
      identityKey: 'same-secret',
    });

    expect(connect.identityType).toBe('futureclaw');
    expect(join.identityType).toBe('another_framework');
    expect(canonicalizePublicAgentIdentityType(connect.identityType!)).toBe('custom');
    expect(canonicalizePublicAgentIdentityType(join.identityType)).toBe('custom');
  });

  test('presented nanoclaw is schema-valid and canonicalizes to custom for PV23 healing', () => {
    const parsed = connectSchema.parse({
      agentId: 'legacy-agent',
      identityType: 'nanoclaw',
      identityKey: 'legacy-key',
    });
    expect(resolvePresentedPublicIdentityType(parsed.identityType!)).toEqual({
      status: 200,
      identityType: 'custom',
    });
  });

  test('presented Hatcher stays reserved before catch-all canonicalization', () => {
    const connect = connectSchema.parse({ agentId: 'public-agent', identityType: 'HATCHER' });
    const join = joinSchema.parse({ identityType: 'hatcher', identityKey: 'partner-key' });
    expect(isReservedPartnerIdentityType(connect.identityType)).toBe(true);
    expect(isReservedPartnerIdentityType(join.identityType)).toBe(true);
    expect(resolvePresentedPublicIdentityType(connect.identityType!)).toEqual({ status: 400 });
    expect(resolvePresentedPublicIdentityType(join.identityType)).toEqual({ status: 400 });
  });

  test('actual /connect rejects public Hatcher without reserving its pending token', async () => {
    const token = 'ct-test-hatcher-reservation';
    pendingConnections.set(token, {
      token,
      avatarId: 'avatar-test-hatcher',
      avatarName: 'Reserved Test',
      userId: 'user-test-hatcher',
      expiresAt: Date.now() + 60_000,
      connected: false,
    });
    try {
      const response = await buildAgentApp().request('/api/agent/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionToken: token,
          agentId: 'unsigned-public-agent',
          identityType: 'HATCHER',
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid request' });
      const pending = pendingConnections.get(token);
      expect(pending?.connected).toBe(false);
      expect(pending?.sessionId).toBeUndefined();
      expect(pending?.agentId).toBeUndefined();
    } finally {
      pendingConnections.delete(token);
    }
  });

  test('actual /connect missing-signal 400 keeps its envelope and adds machine guidance', async () => {
    const response = await buildAgentApp().request('/api/agent/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identityType: 'custom' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Invalid request',
      code: 'identity_signal_required',
      detail: 'Add agentId, miladyAgentId, or connectionToken.',
      details: expect.any(Object),
    });
  });

  test('gateway-less custom client is no-fetch fail-soft and its live session can move', async () => {
    const agentId = 'custom-pull-wire-test';
    const sessionId = 'ag-custom-pull-wire-test';
    const config = buildAvatarSessionConfig({
      mode: 'avatar',
      agentId,
      sessionId,
      identityType: 'custom',
      storedProtocol: 'openai-compat',
      ledgerCapable: false,
      boundUserId: null,
      name: 'Pull Wire Test',
      species: null,
      color: null,
      stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
      homeX: 2560,
      homeY: 2560,
      patrolRadius: 100,
      personality: 'self-managed pull test',
    });
    const client = new AgentSubstrateClient(config);

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error('gateway-less custom must not fetch');
    }) as unknown as typeof fetch;

    const sessionKeyHash = createHash('sha256').update(sessionId).digest('hex');

    agentBotFindFirstStub = async (args?: unknown) => {
      const { columns, values } = inspectWhere(args);
      if (columns.has('agent_id') && values.includes(agentId)) {
        return {
          id: 'bot-custom-pull-wire-test',
          agentId,
          identityType: 'custom',
          userId: null,
          sessionExpiresAt: new Date(Date.now() + 60_000),
          sessionKeyHash,
        };
      }
      return undefined;
    };
    updateStub = () => ({
      set: () => ({ where: () => Promise.resolve([]) }),
    });

    npcSimulation.unregisterAgentBot(sessionId);
    try {
      expect(config.protocol).toBe('nanoclaw');
      expect(config.autonomyMode).toBe('self-managed');
      expect(await client.chat([{ role: 'user', content: 'hello' }])).toBe('');
      expect(fetchCalls).toBe(0);

      npcSimulation.registerAgentBot(config, client);
      const npcId = npcSimulation.getNpcIdForSession(sessionId);
      expect(npcId).toBeTruthy();
      const npc = npcId ? npcSimulation.getNpcById(npcId) : null;
      expect(npc).toBeTruthy();

      const response = await buildAgentApp().request(`/api/agent/${sessionId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetX: npc!.x, targetY: npc!.y }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        pathLength: 1,
        destination: { x: npc!.x, y: npc!.y },
      });
    } finally {
      npcSimulation.unregisterAgentBot(sessionId);
      agentBotFindFirstStub = null;
      updateStub = null;
      globalThis.fetch = originalFetch;
    }
  });
});
