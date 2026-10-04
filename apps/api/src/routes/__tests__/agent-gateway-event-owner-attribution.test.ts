/**
 * Security pass 2026-10-04 — owner attribution on the gateway's agent events.
 *
 * The durable agent event history (`agent-event-query.ts`) returns a row only
 * when `events.user_id` equals the agent row's CURRENT owner. The three gateway
 * emit sites of history types (`/chat` and `/building/:id/chat` ->
 * `agent.chat.turn`, `/visit-building` -> `building.visited`) must therefore
 * record the owner THIS session proved (connect-sec C10: config `boundUserId`
 * === row `user_id`), and NULL for a session without that proof:
 *   - proven: ledger-capable owner session (the reward subject proves the owner,
 *     so visit/building chat need no extra owner lookup);
 *   - restored: owner-proven but NOT ledger-capable (restored after a deploy,
 *     the /enter keeper): still the owner, one indexed lookup;
 *   - stray: no `boundUserId` on an owned row: NULL, no lookup;
 *   - other: proven for a different user than the row owner: NULL;
 *   - unbound row: NULL.
 *
 * Sessions are REAL npc-simulation registrations (nanoclaw wire, no network);
 * the DB is a small fake. `logEventFromContext` is captured.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

process.env.FINGERPRINT_SECRET ??= '57'.repeat(32);
process.env.CORS_ORIGIN = 'https://staging.clawville.world';

const OWNER = '61111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '62222222-2222-4222-8222-222222222222';
const AVATAR_ID = '63333333-3333-4333-8333-333333333333';
const BOT_ID = '64444444-4444-4444-8444-444444444444';
const AGENT_ID = 'event-owner-agent';
const BUILDING_ID = 'agent-security';

/** Row owner every `openclaw_bots` read sees. */
let rowOwner: string | null;
/** `openclaw_bots` reads that select only `user_id` (the owner-proof lookup). */
let ownerLookups: number;
/** When true the owner-proof lookup throws (DB failure). */
let ownerLookupThrows: boolean;
/** Captured `logEventFromContext` inputs. */
let logged: Array<Record<string, unknown>>;

const realDatabase = await import('@clawville/database');
const delegateDb = realDatabase.db as unknown as Record<PropertyKey, unknown>;

const dbProxy = new Proxy<Record<PropertyKey, unknown>>({}, {
  get(_target, property) {
    if (property === 'query') {
      return {
        agentBots: {
          findFirst: async (args?: { columns?: Record<string, boolean> }) => {
            if (args?.columns?.userId && Object.keys(args.columns).length === 1) {
              ownerLookups++;
              if (ownerLookupThrows) throw new Error('db down');
            }
            return {
              id: BOT_ID,
              agentId: AGENT_ID,
              identityType: 'custom',
              userId: rowOwner,
              sessionExpiresAt: new Date(Date.now() + 3_600_000),
              sessionKeyHash: null,
              knowledge: [],
              totalMessages: 0,
            };
          },
        },
        avatars: {
          findFirst: async () => ({
            id: AVATAR_ID,
            userId: OWNER,
            name: 'Owner Avatar',
            isActive: true,
            platformAgentId: null,
            characterConfig: {},
          }),
        },
        users: { findFirst: async () => ({ isGuest: false }) },
      };
    }
    if (property === 'update') {
      return () => ({
        set: () => ({
          where: () => {
            const result = Promise.resolve([]) as unknown as Promise<unknown[]> & { returning: () => Promise<unknown[]> };
            result.returning = async () => [];
            return result;
          },
        }),
      });
    }
    return Reflect.get(delegateDb, property, delegateDb);
  },
});

mock.module('@clawville/database', () => ({ ...realDatabase, db: dbProxy }));

const realReward = await import('../../services/building-reward');
mock.module('../../services/building-reward', () => ({
  ...realReward,
  creditBuildingRewardOncePerDay: async () => false,
  creditBuildingChatRewardOncePerDay: async () => false,
}));

const realMemory = await import('../../services/memory-service');
mock.module('../../services/memory-service', () => ({
  ...realMemory,
  memoryService: { createMemory: async () => undefined },
}));

const realSeeder = await import('../../services/system-npc-seeder');
mock.module('../../services/system-npc-seeder', () => ({
  ...realSeeder,
  getSystemNpcAgent: async () => ({
    locationAgent: { platformAgentId: 'teacher-platform-agent', agentName: 'Teacher' },
    systemUserId: 'system-user',
  }),
}));

const realOrchestrator = await import('../../services/agent-orchestrator');
mock.module('../../services/agent-orchestrator', () => ({
  ...realOrchestrator,
  agentOrchestrator: {
    ensureAgentRuntime: async () => ({
      processMessage: async () => ({ content: 'Scope every tool to the least permission.' }),
    }),
    stopAgent: async () => undefined,
  },
}));

const realEarned = await import('../../services/earned-skill-memory');
mock.module('../../services/earned-skill-memory', () => ({
  ...realEarned,
  recordEarnedSkillLesson: async () => undefined,
  readEarnedSkillLessons: async () => [],
}));

const realHostedKnowledge = await import('../../services/hosted-agent-knowledge');
mock.module('../../services/hosted-agent-knowledge', () => ({
  ...realHostedKnowledge,
  syncHostedAgentKnowledge: async () => undefined,
}));

const realInstall = await import('../../services/building-skill-install');
mock.module('../../services/building-skill-install', () => ({
  ...realInstall,
  installBuildingSkillIntoAgent: async () => undefined,
}));

const realEventLogger = await import('../../services/event-logger');
mock.module('../../services/event-logger', () => ({
  ...realEventLogger,
  logEvent: async () => undefined,
  logEventFromContext: async (_c: unknown, input: Record<string, unknown>) => {
    logged.push(input);
  },
}));

const { agentGatewayRoutes } = await import('../agent-gateway');
const { npcSimulation } = await import('../../services/npc-simulation');
const { buildAvatarSessionConfig } = await import('../../services/agent-session-config');
const { resolveBuildingCenter } = await import('../../services/building-center');
const { resolveGatewayEventOwner } = await import('../../services/agent-event-owner');

function buildApp() {
  const app = new Hono<{ Variables: { fpHash: string; ipPrefixHash: string } }>();
  app.use('*', async (c, next) => {
    c.set('fpHash', 'fp-test');
    c.set('ipPrefixHash', 'ip-prefix-test');
    await next();
  });
  app.onError((err, c) => (err instanceof HTTPException
    ? c.json({ error: err.message }, err.status)
    : c.json({ error: String(err) }, 500)));
  app.route('/api/agent', agentGatewayRoutes);
  return app;
}

let sessionCounter = 0;
/** Register a live avatar body standing inside the building footprint. */
function registerSession(proof: { ledgerCapable: boolean; boundUserId: string | null }): string {
  sessionCounter += 1;
  const sessionId = `ag-event-owner-${sessionCounter}`;
  const config = buildAvatarSessionConfig({
    mode: 'avatar',
    agentId: AGENT_ID,
    sessionId,
    identityType: 'custom',
    storedProtocol: 'nanoclaw',
    autonomyMode: 'self-managed',
    name: 'EventOwner',
    species: 'milady_official_1',
    color: 0x123456,
    stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
    homeX: 11264,
    homeY: 11264,
    patrolRadius: 100,
    personality: '',
    ledgerCapable: proof.ledgerCapable,
    boundUserId: proof.boundUserId,
    avatarId: proof.ledgerCapable ? AVATAR_ID : undefined,
  });
  npcSimulation.registerAgentBot(config, { getProtocol: () => 'nanoclaw' } as never);
  const npc = npcSimulation.getNpcById(npcSimulation.getNpcIdForSession(sessionId)!)!;
  const center = resolveBuildingCenter(BUILDING_ID)!;
  npc.x = center.x;
  npc.y = center.y;
  return sessionId;
}

/** identityKey / owned-token / signed-reconnect session: ledger-capable owner. */
const proven = () => registerSession({ ledgerCapable: true, boundUserId: OWNER });
/** Restored after a deploy / the /enter keeper: owner-proven, NOT ledger-capable. */
const restored = () => registerSession({ ledgerCapable: false, boundUserId: OWNER });
/** A live session from the unowned period: no proven owner, row owned now. */
const stray = () => registerSession({ ledgerCapable: false, boundUserId: null });
/** A session proven for a different user than the row owner. */
const other = () => registerSession({ ledgerCapable: false, boundUserId: OTHER_OWNER });

const ROUTES = {
  chat: { path: (s: string) => `/api/agent/${s}/chat`, body: { message: 'hello there' }, eventType: 'agent.chat.turn' },
  visit: { path: (s: string) => `/api/agent/${s}/visit-building`, body: { buildingId: BUILDING_ID }, eventType: 'building.visited' },
  buildingChat: {
    path: (s: string) => `/api/agent/${s}/building/${BUILDING_ID}/chat`,
    body: { message: 'How do I scope tools?' },
    eventType: 'agent.chat.turn',
  },
} as const;

/** POST the route, then wait for the fire-and-forget owner-attributed emit. */
async function emitFor(route: keyof typeof ROUTES, sessionId: string): Promise<Record<string, unknown>> {
  const spec = ROUTES[route];
  const response = await buildApp().request(spec.path(sessionId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec.body),
  });
  expect(response.status).toBe(200);
  for (let i = 0; i < 50 && logged.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
  expect(logged.length).toBe(1);
  const event = logged[0]!;
  expect(event.eventType).toBe(spec.eventType);
  expect(event.agentId).toBe(AGENT_ID);
  return event;
}

beforeEach(() => {
  (npcSimulation as unknown as { stop: () => void }).stop();
  rowOwner = OWNER;
  ownerLookups = 0;
  ownerLookupThrows = false;
  logged = [];
});

afterEach(() => {
  for (const sessionId of npcSimulation.findActiveSessionsByAgentIds([AGENT_ID])) {
    npcSimulation.unregisterAgentBot(sessionId);
  }
});

describe('gateway agent events record the session-proven owner', () => {
  for (const route of ['chat', 'visit', 'buildingChat'] as const) {
    test(`${route}: a ledger-capable owner session records the owner`, async () => {
      const event = await emitFor(route, proven());
      expect(event.userId).toBe(OWNER);
    });

    test(`${route}: an owner-proven NON-ledger session (restored) still records the owner`, async () => {
      const event = await emitFor(route, restored());
      expect(event.userId).toBe(OWNER);
    });

    test(`${route}: a stray session (no boundUserId) on an owned row records NULL with no owner lookup`, async () => {
      const event = await emitFor(route, stray());
      expect(event.userId).toBeNull();
      expect(ownerLookups).toBe(0);
    });

    test(`${route}: a session proven for a different user records NULL`, async () => {
      const event = await emitFor(route, other());
      expect(event.userId).toBeNull();
    });

    test(`${route}: an unbound row records NULL even for a session with a boundUserId`, async () => {
      rowOwner = null;
      const event = await emitFor(route, restored());
      expect(event.userId).toBeNull();
    });
  }

  test('visit + building chat reuse the reward subject: no extra owner lookup for a ledger owner', async () => {
    await emitFor('visit', proven());
    logged = [];
    await emitFor('buildingChat', proven());
    expect(ownerLookups).toBe(0);
  });

  test('a restored session costs exactly ONE owner lookup per event', async () => {
    await emitFor('chat', restored());
    expect(ownerLookups).toBe(1);
  });
});

describe('resolveGatewayEventOwner — unit', () => {
  test('a handler-proven owner is returned without a read', async () => {
    expect(await resolveGatewayEventOwner({ agentId: AGENT_ID, boundUserId: null }, OWNER)).toBe(OWNER);
    expect(ownerLookups).toBe(0);
  });

  test('no config, or no boundUserId, is NULL without a read', async () => {
    expect(await resolveGatewayEventOwner(null)).toBeNull();
    expect(await resolveGatewayEventOwner({ agentId: AGENT_ID })).toBeNull();
    expect(ownerLookups).toBe(0);
  });

  test('boundUserId must equal the live row owner', async () => {
    expect(await resolveGatewayEventOwner({ agentId: AGENT_ID, boundUserId: OWNER })).toBe(OWNER);
    rowOwner = OTHER_OWNER;
    expect(await resolveGatewayEventOwner({ agentId: AGENT_ID, boundUserId: OWNER })).toBeNull();
    expect(ownerLookups).toBe(2);
  });

  test('a failed owner lookup is NULL (fail closed) and the event is still logged', async () => {
    ownerLookupThrows = true;
    expect(await resolveGatewayEventOwner({ agentId: AGENT_ID, boundUserId: OWNER })).toBeNull();
    const event = await emitFor('chat', restored());
    expect(event.userId).toBeNull();
  });
});
