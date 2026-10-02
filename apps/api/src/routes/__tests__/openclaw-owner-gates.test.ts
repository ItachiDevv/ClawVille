/**
 * Security batch 2 (ported from the 2026-09-30 pass) — legacy `/api/openclaw/*`
 * owner gates.
 *
 *   C4: POST /location-chat writes the bot-row knowledge of an owned row only
 *       from a session that proved ownership.
 *   C7: GET /knowledge-export/:avatarId and /memory-export/:avatarId are
 *       owner-only (Lucia owner or a ledger-capable agent bound to the avatar).
 *
 * POST /register on a bound row is connect-sec's rule (409
 * owner_credential_required), pinned in `openclaw-register-owner-credential.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

process.env.FINGERPRINT_SECRET ??= '31'.repeat(32);

const OWNER = '44444444-4444-4444-8444-444444444444';
const OTHER = '66666666-6666-4666-8666-666666666666';
const AVATAR_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_AVATAR_ID = '77777777-7777-4777-8777-777777777777';
const BOT_ID = '33333333-3333-4333-8333-333333333333';
const AGENT_ID = 'legacy-openclaw-agent';
const LOCATION_ID = 'agent-security';

/** Row owner seen by the findFirst snapshot (undefined = no row). */
let snapshotOwner: string | null | undefined;
/** Row owner at UPDATE time (differs from the snapshot to model a race). */
let liveOwner: string | null;
let botUpdates: Array<{ values: Record<string, unknown>; sql: string; applied: boolean }>;
let knowledgeWrites: string[][];

const dialect = new PgDialect();
const realDatabase = await import('@clawville/database');
const delegateDb = realDatabase.db as unknown as Record<PropertyKey, unknown>;

const ALT_AVATAR_ID = '88888888-8888-4888-8888-888888888888';
/** avatars.id -> avatars.user_id (ownership, independent of which avatar is active). */
const avatarOwner: Record<string, string> = {
  [AVATAR_ID]: OWNER,
  [OTHER_AVATAR_ID]: OTHER,
  [ALT_AVATAR_ID]: OWNER,
};
/** The avatar each user's active-avatar lookup returns. */
let activeAvatarByUser: Record<string, string>;

function paramsOf(where: unknown): unknown[] {
  return where ? dialect.sqlToQuery(where as SQL).params : [];
}

/** Evaluate the owner predicate of an `openclaw_bots` UPDATE against the live owner. */
function ownerPredicateHolds(where: SQL, owner: string | null): boolean {
  const { sql: text, params } = dialect.sqlToQuery(where);
  const either = /"user_id" IS NULL OR "openclaw_bots"\."user_id" = \$(\d+)/.exec(text);
  if (either) return owner === null || owner === params[Number(either[1]) - 1];
  const equals = /"openclaw_bots"\."user_id" = \$(\d+)/.exec(text);
  if (equals) return owner === params[Number(equals[1]) - 1];
  if (text.includes('"openclaw_bots"."user_id" is null')) return owner === null;
  return true;
}

function avatarRow(id: string) {
  return {
    id,
    userId: avatarOwner[id],
    name: 'Owner Avatar',
    species: 'turtle',
    archetype: 'curious-scholar',
    clawTokens: 55,
    isActive: true,
    characterConfig: { knowledge: ['owner knowledge'], topics: [], lore: [], bio: [] },
  };
}

const dbProxy = new Proxy<Record<PropertyKey, unknown>>({}, {
  get(_target, property) {
    if (property === 'query') {
      return {
        agentBots: {
          findFirst: async () => snapshotOwner === undefined ? undefined : {
            id: BOT_ID,
            agentId: AGENT_ID,
            identityType: 'openclaw',
            userId: snapshotOwner,
            name: 'Legacy',
            species: 'crab',
            color: 1,
            totalSessions: 1,
            knowledge: [],
            metadata: null,
            sessionExpiresAt: new Date(Date.now() + 3_600_000),
            sessionKeyHash: null,
          },
        },
        avatars: {
          findFirst: async (args?: { where?: unknown }) => {
            const params = paramsOf(args?.where);
            const userId = params.find((p) => typeof p === 'string' && p in activeAvatarByUser) as string | undefined;
            const avatarId = params.find((p) => typeof p === 'string' && p in avatarOwner) as string | undefined;
            // Ownership lookup (avatars.id AND avatars.user_id) vs active-avatar lookup.
            if (avatarId) return avatarOwner[avatarId] === userId ? { id: avatarId } : undefined;
            return userId ? avatarRow(activeAvatarByUser[userId]) : undefined;
          },
        },
        users: { findFirst: async () => ({ isGuest: false }) },
      };
    }
    if (property === 'select') {
      return () => ({
        from: (table: unknown) => {
          const rows = async () => (table === realDatabase.avatars ? [avatarRow(AVATAR_ID)] : []);
          return {
            where: () => Object.assign(rows(), {
              limit: rows,
              orderBy: () => ({ limit: rows }),
            }),
          };
        },
      });
    }
    if (property === 'update') {
      return (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: (where: SQL) => {
            const perform = async () => {
              if (table !== realDatabase.agentBots) return [];
              const applied = ownerPredicateHolds(where, liveOwner);
              botUpdates.push({ values, sql: dialect.sqlToQuery(where).sql, applied });
              if (applied && 'knowledge' in values) {
                // Record the entries the atomic jsonb append carries.
                const append = dialect.sqlToQuery(values.knowledge as SQL);
                knowledgeWrites.push(JSON.parse(append.params[0] as string) as string[]);
              }
              return applied ? [{ id: BOT_ID }] : [];
            };
            const result = perform() as Promise<unknown[]> & { returning: () => Promise<unknown[]> };
            result.returning = () => result;
            return result;
          },
        }),
      });
    }
    return Reflect.get(delegateDb, property, delegateDb);
  },
});

mock.module('@clawville/database', () => ({ ...realDatabase, db: dbProxy }));

const SESSIONS: Record<string, string> = { 'owner-session': OWNER, 'other-session': OTHER };
const realAuth = await import('../../lib/auth');
mock.module('../../lib/auth', () => ({
  ...realAuth,
  lucia: {
    readSessionCookie: (header: string) => /auth_session=([^;]+)/.exec(header)?.[1] ?? null,
    validateSession: async (id: string) => SESSIONS[id]
      ? { session: { id, fresh: false }, user: { id: SESSIONS[id] } }
      : { session: null, user: null },
    createSessionCookie: () => ({ serialize: () => '' }),
    createBlankSessionCookie: () => ({ serialize: () => '' }),
  },
}));

const { openclawRoutes } = await import('../openclaw');
const { npcSimulation } = await import('../../services/npc-simulation');
const { buildAvatarSessionConfig } = await import('../../services/agent-session-config');

function buildApp() {
  const app = new Hono();
  app.onError((err, c) => (err instanceof HTTPException
    ? c.json({ error: err.message }, err.status)
    : c.json({ error: String(err) }, 500)));
  app.route('/api/openclaw', openclawRoutes);
  return app;
}

let requestCounter = 0;
async function call(method: 'GET' | 'POST', path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) {
  requestCounter += 1;
  const response = await buildApp().request(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'cf-connecting-ip': `203.0.113.${requestCounter}`,
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

let sessionCounter = 0;
function registerSession(proof: { ledgerCapable: boolean; boundUserId: string | null }): string {
  sessionCounter += 1;
  const sessionId = `ag-openclaw-gate-${sessionCounter}`;
  const config = buildAvatarSessionConfig({
    mode: 'avatar',
    agentId: AGENT_ID,
    sessionId,
    identityType: 'custom',
    storedProtocol: 'nanoclaw',
    autonomyMode: 'self-managed',
    name: 'Legacy',
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
  const client = {
    getProtocol: () => 'nanoclaw',
    chat: async () => 'An openclaw agent runtime scopes every tool.',
  };
  npcSimulation.registerAgentBot(config, client as never);
  return sessionId;
}

beforeEach(() => {
  (npcSimulation as unknown as { stop: () => void }).stop();
  snapshotOwner = undefined;
  liveOwner = null;
  botUpdates = [];
  knowledgeWrites = [];
  activeAvatarByUser = { [OWNER]: AVATAR_ID, [OTHER]: OTHER_AVATAR_ID };
});

afterEach(() => {
  for (const sessionId of npcSimulation.findActiveSessionsByAgentIds([AGENT_ID])) {
    npcSimulation.unregisterAgentBot(sessionId);
  }
});

describe('security C4 — location-chat bot knowledge on an owned row', () => {
  async function locationChat(sessionId: string) {
    const result = await call('POST', '/api/openclaw/location-chat', {
      body: { sessionId, locationId: LOCATION_ID, content: 'teach me' },
    });
    // The bot-row write is fire-and-forget; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 25));
    return result;
  }

  const knowledgeUpdates = () => botUpdates.filter((update) => 'knowledge' in update.values);

  test('an unproven session gets the reply but writes nothing into the owner row', async () => {
    snapshotOwner = OWNER;
    liveOwner = OWNER;
    const result = await locationChat(registerSession({ ledgerCapable: false, boundUserId: OWNER }));
    expect(result.status).toBe(200);
    expect((result.body.knowledgeLearned as string[]).length).toBe(1);
    expect(knowledgeWrites).toEqual([]);
  });

  test('a proven session still persists the learned line', async () => {
    snapshotOwner = OWNER;
    liveOwner = OWNER;
    const result = await locationChat(registerSession({ ledgerCapable: true, boundUserId: OWNER }));
    expect(result.status).toBe(200);
    expect(knowledgeWrites).toEqual([result.body.knowledgeLearned as string[]]);
    // An atomic jsonb append of the new entries, never a read-then-write array.
    expect(dialect.sqlToQuery(knowledgeUpdates()[0].values.knowledge as SQL).sql)
      .toBe(`coalesce("openclaw_bots"."knowledge", '[]'::jsonb) || $1::jsonb`);
  });

  test('an unbound row keeps its continuity write', async () => {
    snapshotOwner = null;
    await locationChat(registerSession({ ledgerCapable: false, boundUserId: null }));
    expect(knowledgeWrites).toHaveLength(1);
    expect(knowledgeUpdates()[0].sql).toContain('"openclaw_bots"."user_id" is null');
  });

  test('an owner bind landing after the unbound snapshot blocks the unproven write', async () => {
    snapshotOwner = null; // the handler reads an unbound row...
    liveOwner = OWNER; // ...but the owner binds it before the UPDATE runs
    await locationChat(registerSession({ ledgerCapable: false, boundUserId: null }));
    expect(knowledgeUpdates().map((update) => update.applied)).toEqual([false]);
    expect(knowledgeWrites).toEqual([]);
  });
});

describe('security C7 — knowledge and memory exports are owner-only', () => {
  const routes = [
    `/api/openclaw/knowledge-export/${AVATAR_ID}`,
    `/api/openclaw/memory-export/${AVATAR_ID}`,
  ];

  test('no credential returns 401', async () => {
    for (const path of routes) {
      expect((await call('GET', path)).status).toBe(401);
    }
  });

  test('another human gets 403 avatar_not_owned', async () => {
    for (const path of routes) {
      expect(await call('GET', path, { headers: { Cookie: 'auth_session=other-session' } })).toEqual({
        status: 403,
        body: { error: 'Not your avatar', code: 'avatar_not_owned' },
      });
    }
  });

  test('the owning human exports as before', async () => {
    const knowledge = await call('GET', routes[0], { headers: { Cookie: 'auth_session=owner-session' } });
    expect(knowledge.status).toBe(200);
    expect(knowledge.body).toMatchObject({ avatarId: AVATAR_ID, knowledge: ['owner knowledge'] });
    const memory = await call('GET', routes[1], { headers: { Cookie: 'auth_session=owner-session' } });
    expect(memory.status).toBe(200);
    expect(memory.body).toMatchObject({ avatarId: AVATAR_ID, totalMemories: 0 });
  });

  test('a ledger-capable agent bound to the avatar exports; an unproven one is refused', async () => {
    snapshotOwner = OWNER;
    const provenSession = registerSession({ ledgerCapable: true, boundUserId: OWNER });
    const exported = await call('GET', routes[0], { headers: { 'X-Clawville-Agent-Session': provenSession } });
    expect(exported.status).toBe(200);

    const unprovenSession = registerSession({ ledgerCapable: false, boundUserId: OWNER });
    for (const path of routes) {
      const refused = await call('GET', path, { headers: { 'X-Clawville-Agent-Session': unprovenSession } });
      expect(refused.status).toBe(403);
      expect(String(refused.body.error)).toStartWith('agent_session_not_ledger_authorized');
    }
  });

  test('the owning human exports by avatar ownership, not by which avatar is active', async () => {
    activeAvatarByUser[OWNER] = ALT_AVATAR_ID; // AVATAR_ID is still OWNER's row
    for (const path of routes) {
      const exported = await call('GET', path, { headers: { Cookie: 'auth_session=owner-session' } });
      expect(exported.status).toBe(200);
    }
  });

  test("an unknown agent session is 401; an agent bound to a different avatar is 403", async () => {
    // No bot row exists, so neither the live map nor restore can resolve it.
    const unknown = await call('GET', routes[1], { headers: { 'X-Clawville-Agent-Session': 'ag-no-such-session' } });
    expect(unknown.status).toBe(401);

    snapshotOwner = OWNER;
    const provenSession = registerSession({ ledgerCapable: true, boundUserId: OWNER });
    expect(await call('GET', `/api/openclaw/knowledge-export/${OTHER_AVATAR_ID}`, {
      headers: { 'X-Clawville-Agent-Session': provenSession },
    })).toEqual({ status: 403, body: { error: 'Not your avatar', code: 'avatar_not_owned' } });
  });

  test('a stray agent session (no proven owner, row owned now) is refused both exports', async () => {
    snapshotOwner = OWNER;
    const straySession = registerSession({ ledgerCapable: false, boundUserId: null });
    for (const path of routes) {
      expect(await call('GET', path, { headers: { 'X-Clawville-Agent-Session': straySession } })).toEqual({
        status: 403,
        body: { error: 'agent_session_not_ledger_authorized', code: 'agent_session_not_ledger_authorized' },
      });
    }
  });

  test('an anonymous agent on an unbound row cannot export any avatar', async () => {
    snapshotOwner = null;
    const anonymous = registerSession({ ledgerCapable: false, boundUserId: null });
    const refused = await call('GET', routes[0], { headers: { 'X-Clawville-Agent-Session': anonymous } });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('agent_session_not_ledger_authorized');
  });

  test('a human with a malformed avatar id gets 403 avatar_not_owned before any export work', async () => {
    for (const path of ['/api/openclaw/knowledge-export/not-a-uuid', '/api/openclaw/memory-export/not-a-uuid']) {
      expect(await call('GET', path, { headers: { Cookie: 'auth_session=owner-session' } })).toEqual({
        status: 403,
        body: { error: 'Not your avatar', code: 'avatar_not_owned' },
      });
    }
  });

  test('a human cookie wins over an agent header (owner human exports even with a foreign agent header)', async () => {
    snapshotOwner = OWNER;
    const straySession = registerSession({ ledgerCapable: false, boundUserId: null });
    const exported = await call('GET', routes[0], {
      headers: { Cookie: 'auth_session=owner-session', 'X-Clawville-Agent-Session': straySession },
    });
    expect(exported.status).toBe(200);
    expect(exported.body).toMatchObject({ avatarId: AVATAR_ID });
  });
});
