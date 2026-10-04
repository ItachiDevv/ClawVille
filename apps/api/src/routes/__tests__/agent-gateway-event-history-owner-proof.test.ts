import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Hono } from 'hono';

// Protocol 83 (founder: "gate"): the durable event history is owner-private. It
// carries the owner's directive text (`agent.directive.set`), cove settlements
// and store sales. `GET /:sessionId/events/replay` and the SSE reconnect
// catch-up inside `GET /:sessionId/events` used to check only liveness
// (`resolveSession`), so any live session on the agentId (a stray from the
// unowned period, or an anonymous session on a public agentId) read it. Now:
//   - replay: a session without owner proof gets 403 owner_proof_required and
//     the history query never runs; an owner-proven session reads as before;
//   - SSE: a session without owner proof gets NO durable catch-up (skipped,
//     logged once), and the live stream still opens exactly as before.
// Owner proof = `resolveAgentSession` returns the row owner (config
// `boundUserId` equals the row's current `userId`, connect-sec C10/C12).
//
// Owner-period scope (security pass 2026-10-04, Codex BLOCKING): the proof and
// the query scope come from ONE resolution. The route passes the proven
// `{ agentId, ownerUserId }` to the shared query, whose SQL re-checks the row
// owner and returns only events from `openclaw_bots.owner_since` on that are
// attributed to that owner (never another user's row, never a NULL-attributed
// row: Codex round 3). The query mock below mirrors those three SQL
// clauses over an in-memory table (the real SQL is pinned by
// services/__tests__/agent-event-query-scope.test.ts and run on Postgres by
// services/__tests__/agent-owner-since.db.test.ts), so these tests prove the
// ROUTES hand the proven owner to the query and deliver only what it returns.

process.env.FINGERPRINT_SECRET ??= '45'.repeat(32);

const OWNER_ID = '91111111-1111-4111-8111-111111111111';
const OTHER_ID = '92222222-2222-4222-8222-222222222222';
const AVATAR_ID = '93333333-3333-4333-8333-333333333333';
const BOT_ID = '94444444-4444-4444-8444-444444444444';
const PRIOR_ID = '95555555-5555-4555-8555-555555555555';
const DIRECTIVE_TEXT = 'owner directive: farm the reef at dawn';
const PRIOR_DIRECTIVE = 'PRIOR owner directive: dump the wallet at noon';
const OWNER_SINCE_DEFAULT = new Date('2026-10-03T00:00:00Z');
const OWNER_SINCE_AFTER_MOVE = new Date('2026-10-04T00:00:30Z');

interface HistoryQuery {
  scope: { agentId: string; ownerUserId: string };
  afterId: bigint;
  limit: number;
}

interface HistoryRow {
  id: bigint;
  eventType: string;
  ts: Date;
  payload: Record<string, unknown>;
  /** events.user_id (not selected by the real query; drives clause 3 only). */
  userId: string | null;
}

let botRow: Record<string, unknown> | null = null;
let historyQueries: HistoryQuery[] = [];
/** `db.query.agentBots.findFirst` calls in the current test (reset in beforeEach). */
let rowReads = 0;
let moveOwnerAfterRowReads: { reads: number; to: string } | null = null;

const HISTORY_ROWS: HistoryRow[] = [
  { id: 11n, eventType: 'agent.directive.set', ts: new Date('2026-10-04T00:00:00Z'), payload: { directive: DIRECTIVE_TEXT }, userId: OWNER_ID },
  { id: 12n, eventType: 'building.visited', ts: new Date('2026-10-04T00:01:00Z'), payload: { buildingId: 'cron-automation' }, userId: OWNER_ID },
];

/**
 * Ownership-change table: PRIOR owned the row until 00:00:30, then OWNER.
 * 21-22 are PRIOR's period; 23 is a late PRIOR row whose insert landed inside
 * OWNER's period; 24-25 are OWNER's own period; 26 is a NULL-attributed chat
 * turn inside OWNER's period (never returned: Codex round 3).
 */
const MOVED_ROWS: HistoryRow[] = [
  { id: 21n, eventType: 'agent.directive.set', ts: new Date('2026-10-04T00:00:10Z'), payload: { directive: PRIOR_DIRECTIVE }, userId: PRIOR_ID },
  { id: 22n, eventType: 'building.visited', ts: new Date('2026-10-04T00:00:20Z'), payload: { buildingId: 'prior-visit' }, userId: null },
  { id: 23n, eventType: 'cove.blackjack.hand.settled', ts: new Date('2026-10-04T00:00:31Z'), payload: { net: 90, note: PRIOR_DIRECTIVE }, userId: PRIOR_ID },
  { id: 24n, eventType: 'agent.directive.set', ts: new Date('2026-10-04T00:00:40Z'), payload: { directive: DIRECTIVE_TEXT }, userId: OWNER_ID },
  { id: 25n, eventType: 'building.visited', ts: new Date('2026-10-04T00:00:50Z'), payload: { buildingId: 'cron-automation' }, userId: OWNER_ID },
  { id: 26n, eventType: 'agent.chat.turn', ts: new Date('2026-10-04T00:00:55Z'), payload: { chatType: 'character', targetNpcId: 'late-null-chat', messageLength: 12 }, userId: null },
];

let historyTable: HistoryRow[] = HISTORY_ROWS;

const realDatabase = await import('@clawville/database');
const restoreModules: Array<[string, Record<string, unknown>]> = [['@clawville/database', { ...realDatabase }]];
const delegateDb = realDatabase.db as unknown as Record<PropertyKey, unknown>;

const dbProxy = new Proxy<Record<PropertyKey, unknown>>({}, {
  get(_target, property) {
    if (property === 'query') {
      return {
        agentBots: {
          findFirst: async () => {
            rowReads++;
            const copy = botRow ? { ...botRow } : undefined;
            // TOCTOU probe: move the row to another owner right after the Nth read.
            if (botRow && moveOwnerAfterRowReads && rowReads === moveOwnerAfterRowReads.reads) {
              botRow.userId = moveOwnerAfterRowReads.to;
            }
            return copy;
          },
        },
        users: { findFirst: async () => ({ isGuest: false }) },
        avatars: { findFirst: async () => ({ id: AVATAR_ID, userId: OWNER_ID, isActive: true }) },
      };
    }
    if (property === 'update') {
      // The gateway TTL slide (`extendSessionTtl`); never reaches a real DB.
      return () => ({ set: () => ({ where: async () => [] }) });
    }
    return Reflect.get(delegateDb, property, delegateDb);
  },
});

mock.module('@clawville/database', () => ({ ...realDatabase, db: dbProxy }));

const realEventQuery = await import('../../services/agent-event-query');
restoreModules.push(['../../services/agent-event-query', { ...realEventQuery }]);
mock.module('../../services/agent-event-query', () => ({
  ...realEventQuery,
  queryDurableAgentEvents: async (
    scope: { agentId: string; ownerUserId: string },
    afterId: bigint,
    limit: number,
  ) => {
    historyQueries.push({ scope: { ...scope }, afterId, limit });
    // The three scope clauses of the real SQL, read at query time:
    // (1) the row's CURRENT owner is the proven owner, (2) ts >= owner_since,
    // (3) user_id = owner (a NULL user_id is never admitted). Then the SAFE
    // columns only.
    if (!botRow || botRow.agentId !== scope.agentId || botRow.userId !== scope.ownerUserId) return [];
    const ownerSince = botRow.ownerSince as Date;
    return historyTable
      .filter((row) => row.id > afterId)
      .filter((row) => row.ts.getTime() >= ownerSince.getTime())
      .filter((row) => row.userId === botRow!.userId)
      .slice(0, limit)
      .map(({ id, eventType, ts, payload }) => ({ id, eventType, ts, payload }));
  },
}));

const realEventLogger = await import('../../services/event-logger');
restoreModules.push(['../../services/event-logger', { ...realEventLogger }]);
mock.module('../../services/event-logger', () => ({
  ...realEventLogger,
  logEvent: async () => {},
  logEventFromContext: async () => {},
}));

const { agentGatewayRoutes, EVENT_HISTORY_OWNER_PROOF_REQUIRED_BODY } = await import('../agent-gateway');
const { npcSimulation } = await import('../../services/npc-simulation');
const { AgentSubstrateClient } = await import('../../services/agent-substrate-client');
const { buildAvatarSessionConfig } = await import('../../services/agent-session-config');
const { resolvePersistedConnectOwnerProof } = await import('../../services/agent-owner-binding');
const { sha256Hex } = await import('../../services/session-digest');

type Registration = Parameters<typeof npcSimulation.registerAgentBot>[0];

const registered = new Set<string>();
let ipCounter = 0;

function avatarConfig(input: {
  agentId: string;
  sessionId: string;
  ledgerCapable: boolean;
  boundUserId: string | null;
  identityType?: string;
  storedProtocol?: string;
  protocolOverride?: 'hatcher-proxy';
}): Registration {
  return buildAvatarSessionConfig({
    mode: 'avatar',
    agentId: input.agentId,
    sessionId: input.sessionId,
    identityType: (input.identityType ?? 'custom') as never,
    storedProtocol: input.storedProtocol ?? 'nanoclaw',
    ...(input.protocolOverride ? { protocolOverride: input.protocolOverride, autonomyMode: 'server-managed' as const } : {}),
    ledgerCapable: input.ledgerCapable,
    boundUserId: input.boundUserId,
    avatarId: AVATAR_ID,
    name: 'Event History Gate',
    species: null,
    color: null,
    stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
    homeX: 2560,
    homeY: 2560,
    patrolRadius: 100,
    personality: 'event history owner proof test',
  } as Parameters<typeof buildAvatarSessionConfig>[0]);
}

/** Register ONE live session whose bearer hash is the row's current hash. */
function goLive(config: Registration, rowUserId: string | null): string {
  npcSimulation.registerAgentBot(config, new AgentSubstrateClient(config));
  registered.add(config.sessionId);
  botRow = {
    id: BOT_ID,
    agentId: config.agentId,
    identityType: 'custom',
    userId: rowUserId,
    sessionKeyHash: sha256Hex(config.sessionId),
    sessionExpiresAt: new Date(Date.now() + 60 * 60_000),
    ownerSince: OWNER_SINCE_DEFAULT,
  };
  return config.sessionId;
}

/** A live session from the unowned period: no proven owner, row now owned. */
function strayOnOwnedRow(tag: string): string {
  return goLive(
    avatarConfig({ agentId: `p83-stray-${tag}`, sessionId: `ag-p83-stray-${tag}`, ledgerCapable: false, boundUserId: null }),
    OWNER_ID,
  );
}

/** An anonymous session on an unowned row (a public agentId, no owner at all). */
function anonymousOnUnownedRow(tag: string): string {
  return goLive(
    avatarConfig({ agentId: `p83-anon-${tag}`, sessionId: `ag-p83-anon-${tag}`, ledgerCapable: false, boundUserId: null }),
    null,
  );
}

/** The real owner: a /connect identity-key claim of the persisted owner. */
function connectOwner(tag: string): string {
  const proof = resolvePersistedConnectOwnerProof({
    source: 'explicit-identity', candidateUserId: OWNER_ID, persistedUserId: OWNER_ID, avatarId: AVATAR_ID,
  });
  return goLive(avatarConfig({ agentId: `p83-owner-${tag}`, sessionId: `ag-p83-owner-${tag}`, ...proof }), OWNER_ID);
}

/**
 * The row moved from PRIOR to OWNER (owner_since = the move), and OWNER connects
 * with a real owner proof: the history table holds both owners' rows.
 */
function connectNewOwnerAfterMove(tag: string): string {
  const sid = connectOwner(tag);
  botRow!.ownerSince = OWNER_SINCE_AFTER_MOVE;
  historyTable = MOVED_ROWS;
  return sid;
}

function nextIp(): string {
  ipCounter++;
  return `198.51.100.${(ipCounter % 250) + 1}`;
}

async function replay(sessionId: string, query = 'after=0&limit=100') {
  const app = new Hono();
  app.route('/api/agent', agentGatewayRoutes);
  const response = await app.request(`/api/agent/${sessionId}/events/replay?${query}`, {
    headers: { 'x-real-ip': nextIp() },
  });
  return { status: response.status, text: await response.text() };
}

async function openSse(sessionId: string, lastEventId: string | null) {
  const app = new Hono();
  app.route('/api/agent', agentGatewayRoutes);
  const headers: Record<string, string> = { 'x-real-ip': nextIp() };
  if (lastEventId !== null) headers['Last-Event-ID'] = lastEventId;
  return app.request(`/api/agent/${sessionId}/events`, { headers });
}

/** Read stream text until `needle` shows up or `ms` passes, then cancel. */
async function readFor(response: Response, ms: number, needle?: string): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);
      if (chunk === null || chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      if (needle && text.includes(needle)) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

let infoSpy: ReturnType<typeof spyOn>;

function sseSkipLogs(): string[] {
  return infoSpy.mock.calls
    .map((args: unknown[]) => String(args[0]))
    .filter((line: string) => line.includes('[AgentSSE] durable catch-up skipped'));
}

beforeEach(() => {
  botRow = null;
  historyQueries = [];
  historyTable = HISTORY_ROWS;
  rowReads = 0;
  moveOwnerAfterRowReads = null;
  infoSpy = spyOn(console, 'info');
});

afterEach(() => {
  infoSpy.mockRestore();
  for (const sessionId of registered) npcSimulation.unregisterAgentBot(sessionId);
  registered.clear();
});

afterAll(() => {
  for (const [path, real] of restoreModules) mock.module(path, () => real);
});

describe('GET /api/agent/:sessionId/events/replay owner proof (protocol 83)', () => {
  test('a stray session on an owned row gets 403 owner_proof_required and no history read', async () => {
    const sid = strayOnOwnedRow('replay');
    const res = await replay(sid);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.text)).toEqual({ ...EVENT_HISTORY_OWNER_PROOF_REQUIRED_BODY });
    expect(JSON.parse(res.text).code).toBe('owner_proof_required');
    expect(res.text).not.toContain(DIRECTIVE_TEXT);
    expect(historyQueries).toHaveLength(0);
    // Not an eviction: the stray stays alive for perception, chat and movement.
    expect(npcSimulation.isValidAgentSession(sid)).toBe(true);
  });

  test('an anonymous session on an unowned row gets 403 owner_proof_required', async () => {
    const sid = anonymousOnUnownedRow('replay');
    const res = await replay(sid);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.text).code).toBe('owner_proof_required');
    expect(historyQueries).toHaveLength(0);
  });

  test('a session proven for a DIFFERENT user than the row owner gets 403', async () => {
    const sid = goLive(
      avatarConfig({ agentId: 'p83-other', sessionId: 'ag-p83-other', ledgerCapable: false, boundUserId: OTHER_ID }),
      OWNER_ID,
    );
    const res = await replay(sid);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.text).code).toBe('owner_proof_required');
    expect(historyQueries).toHaveLength(0);
  });

  test('the real owner (/connect identity claim) reads its history unchanged (200)', async () => {
    const sid = connectOwner('replay');
    const res = await replay(sid, 'after=0&limit=100');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({
      events: [
        { id: '11', eventType: 'agent.directive.set', ts: '2026-10-04T00:00:00.000Z', payload: { directive: DIRECTIVE_TEXT } },
        { id: '12', eventType: 'building.visited', ts: '2026-10-04T00:01:00.000Z', payload: { buildingId: 'cron-automation' } },
      ],
      nextCursor: '12',
    });
    expect(historyQueries).toEqual([
      { scope: { agentId: 'p83-owner-replay', ownerUserId: OWNER_ID }, afterId: 0n, limit: 100 },
    ]);
  });

  test('an owner-proven NON-ledger session (the /enter keeper) still reads its history (200)', async () => {
    const config = avatarConfig({ agentId: 'p83-keeper', sessionId: 'ag-p83-keeper', ledgerCapable: false, boundUserId: null });
    const sid = goLive(config, OWNER_ID);
    expect(npcSimulation.bindAgentOwner('p83-keeper', OWNER_ID)).toBe(1);
    const res = await replay(sid);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).events).toHaveLength(2);
  });

  test('a Hatcher partner session (boundUserId = persisted row.userId) still reads its history (200)', async () => {
    const sid = goLive(
      avatarConfig({
        agentId: 'hatcher:p83-partner', sessionId: 'oc-p83-partner', identityType: 'hatcher',
        storedProtocol: 'hatcher-proxy', protocolOverride: 'hatcher-proxy',
        ledgerCapable: true, boundUserId: OWNER_ID,
      }),
      OWNER_ID,
    );
    const res = await replay(sid);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).nextCursor).toBe('12');
  });

  test('unchanged: an invalid session is still 404 before the owner check', async () => {
    const res = await replay('ag-p83-no-such-session');
    expect(res.status).toBe(404);
    expect(historyQueries).toHaveLength(0);
  });
});

describe('GET /api/agent/:sessionId/events SSE catch-up owner proof (protocol 83)', () => {
  test('a stray session with Last-Event-ID gets NO catch-up, one skip log, and the live stream still opens', async () => {
    const sid = strayOnOwnedRow('sse');
    const res = await openSse(sid, '0');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    const text = await readFor(res, 150);
    expect(text).not.toContain('event: replay');
    expect(text).not.toContain(DIRECTIVE_TEXT);
    expect(historyQueries).toHaveLength(0);
    const logs = sseSkipLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('owner_proof_required');
    // The raw bearer never reaches a log line (digest only).
    expect(logs[0]).not.toContain(sid);
    expect(npcSimulation.isValidAgentSession(sid)).toBe(true);
  });

  test('an anonymous session with ?after= gets NO catch-up', async () => {
    const sid = anonymousOnUnownedRow('sse');
    const app = new Hono();
    app.route('/api/agent', agentGatewayRoutes);
    const res = await app.request(`/api/agent/${sid}/events?after=0`, { headers: { 'x-real-ip': nextIp() } });
    expect(res.status).toBe(200);
    const text = await readFor(res, 150);
    expect(text).not.toContain('event: replay');
    expect(historyQueries).toHaveLength(0);
    expect(sseSkipLogs()).toHaveLength(1);
  });

  test('a fresh connect with no cursor is unchanged: no owner check log and no history read', async () => {
    const sid = strayOnOwnedRow('fresh');
    const res = await openSse(sid, null);
    expect(res.status).toBe(200);
    await readFor(res, 100);
    expect(historyQueries).toHaveLength(0);
    expect(sseSkipLogs()).toHaveLength(0);
  });

  test('the real owner with Last-Event-ID gets the durable catch-up frames first (unchanged)', async () => {
    const sid = connectOwner('sse');
    const res = await openSse(sid, '10');
    expect(res.status).toBe(200);
    const text = await readFor(res, 1500, 'id: 12');
    expect(text).toContain('event: replay\nid: 11\n');
    expect(text).toContain('event: replay\nid: 12\n');
    expect(text).toContain(DIRECTIVE_TEXT);
    expect(historyQueries[0]).toEqual({
      scope: { agentId: 'p83-owner-sse', ownerUserId: OWNER_ID }, afterId: 10n, limit: 500,
    });
    expect(sseSkipLogs()).toHaveLength(0);
  });
});

describe('owner-period scope after an ownership change (security pass 2026-10-04)', () => {
  test('replay: the NEW owner never sees the prior owner directive, only its own period', async () => {
    const sid = connectNewOwnerAfterMove('moved-replay');
    const res = await replay(sid, 'after=0&limit=100');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text);
    expect(body.events.map((event: { id: string }) => event.id)).toEqual(['24', '25']);
    expect(body.events[0]).toEqual({
      id: '24', eventType: 'agent.directive.set', ts: '2026-10-04T00:00:40.000Z', payload: { directive: DIRECTIVE_TEXT },
    });
    expect(body.nextCursor).toBe('25');
    // Neither the prior period (21, 22), the late prior-owner row (23), nor
    // the NULL-attributed chat turn (26).
    expect(res.text).not.toContain(PRIOR_DIRECTIVE);
    expect(res.text).not.toContain('prior-visit');
    expect(res.text).not.toContain('late-null-chat');
    // One owner-proof resolution feeds the scope: the proven owner, never unscoped.
    expect(historyQueries).toEqual([
      { scope: { agentId: 'p83-owner-moved-replay', ownerUserId: OWNER_ID }, afterId: 0n, limit: 100 },
    ]);
  });

  test('replay: a cursor inside the prior period still returns only the new owner period', async () => {
    const sid = connectNewOwnerAfterMove('moved-cursor');
    const res = await replay(sid, 'after=20&limit=100');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).events.map((event: { id: string }) => event.id)).toEqual(['24', '25']);
    expect(res.text).not.toContain(PRIOR_DIRECTIVE);
  });

  test('SSE catch-up: the NEW owner gets only its own period as replay frames', async () => {
    const sid = connectNewOwnerAfterMove('moved-sse');
    const res = await openSse(sid, '0');
    expect(res.status).toBe(200);
    const text = await readFor(res, 1500, 'id: 25');
    expect(text).toContain('event: replay\nid: 24\n');
    expect(text).toContain('event: replay\nid: 25\n');
    expect(text).toContain(DIRECTIVE_TEXT);
    expect(text).not.toContain('id: 21\n');
    expect(text).not.toContain('id: 22\n');
    expect(text).not.toContain('id: 23\n');
    expect(text).not.toContain('id: 26\n');
    expect(text).not.toContain('late-null-chat');
    expect(text).not.toContain(PRIOR_DIRECTIVE);
    expect(historyQueries[0]).toEqual({
      scope: { agentId: 'p83-owner-moved-sse', ownerUserId: OWNER_ID }, afterId: 0n, limit: 500,
    });
    expect(sseSkipLogs()).toHaveLength(0);
  });

  test('a session still proven for the PRIOR owner is refused on both surfaces after the move', async () => {
    const sid = goLive(
      avatarConfig({ agentId: 'p83-prior', sessionId: 'ag-p83-prior', ledgerCapable: false, boundUserId: PRIOR_ID }),
      OWNER_ID,
    );
    botRow!.ownerSince = OWNER_SINCE_AFTER_MOVE;
    historyTable = MOVED_ROWS;
    const res = await replay(sid);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.text).code).toBe('owner_proof_required');
    const sse = await openSse(sid, '0');
    const text = await readFor(sse, 150);
    expect(text).not.toContain('event: replay');
    expect(historyQueries).toHaveLength(0);
  });

  test('the row moves AFTER the proof: the query scope is the proven owner, so it reads nothing', async () => {
    const sid = connectOwner('toctou');
    // The route reads the row twice: the liveness check (resolveSession) and
    // the ONE owner-proof resolution. Right after that second read the row
    // moves to OTHER (OTHER's own event sits in the table). The scope still
    // names OWNER, the query's owner re-check fails, and nothing leaks.
    historyTable = [
      ...HISTORY_ROWS,
      { id: 13n, eventType: 'agent.directive.set', ts: new Date('2026-10-04T00:02:00Z'), payload: { directive: 'OTHER directive' }, userId: OTHER_ID },
    ];
    moveOwnerAfterRowReads = { reads: 2, to: OTHER_ID };
    const res = await replay(sid);
    expect(rowReads).toBe(2);
    expect(botRow!.userId).toBe(OTHER_ID);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ events: [], nextCursor: null });
    expect(res.text).not.toContain('OTHER directive');
    expect(historyQueries).toEqual([
      { scope: { agentId: 'p83-owner-toctou', ownerUserId: OWNER_ID }, afterId: 0n, limit: 100 },
    ]);
  });

  test('replay resolves owner proof once: one liveness read plus one proof read, then the query', async () => {
    const sid = connectOwner('one-resolution');
    const res = await replay(sid);
    expect(res.status).toBe(200);
    expect(rowReads).toBe(2);
    expect(historyQueries).toHaveLength(1);
  });
});
