/**
 * Security pass 2026-10-04, Codex round 4 (BLOCKING x2): the owner of an
 * agent-scoped history event must be resolved in the SAME statement as the
 * event INSERT, under a row lock, not checked before it.
 *
 * Pins `logOwnedAgentEvent` in `event-logger.ts`:
 *   - SQL shape: `user_id` is a scalar subquery on the agent's openclaw_bots row
 *     with the agent id, the claimed owner (::uuid) and the action instant
 *     (`owner_since <= actedAt::timestamptz`, an ISO string param, never a JS
 *     Date), ending in FOR SHARE; every other column keeps its value and `ts`
 *     keeps the column default;
 *   - routing: a claim takes the owned INSERT (no separate owner read); no
 *     claim takes the plain INSERT with NULL user_id (no subquery, no lock);
 *   - the never-throws contract and the event_write_failures fallback (the
 *     unresolved owner is recorded as NULL plus the claim);
 *   - sanitize() + bearer redaction still apply, and the subquery matches the
 *     same (redacted) agent_id the row stores.
 * The same statement runs on PostgreSQL in agent-owner-since.db.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { is, SQL } from 'drizzle-orm';

// `||=`, not `??=`: the isolated runner passes DATABASE_URL='' (empty string).
process.env.DATABASE_URL ||= 'postgres://unit:unit@127.0.0.1:1/unit_no_connect';

const AGENT_ID = 'owned-insert-agent';
const OWNER = '81111111-1111-4111-8111-111111111111';
const ACTED_AT = '2026-10-04T12:00:00.000Z';

const realDatabase = await import('@clawville/database');
const realDb = realDatabase.db as unknown as Record<PropertyKey, unknown>;

type Insert = { table: unknown; values: Record<string, unknown>; returning: boolean };
/** 'record' = fake inserts are captured; 'real' = delegate (for `.toSQL()`). */
let mode: 'record' | 'real' = 'real';
let inserts: Insert[];
/** Throw on the next N `events` inserts. */
let failEventsInserts: number;
/** Every `db.query.*` / `db.select` call (an owner read must not happen). */
let reads: number;

const dbProxy = new Proxy<Record<PropertyKey, unknown>>({}, {
  get(_target, property) {
    if (mode === 'record') {
      if (property === 'insert') {
        return (table: unknown) => ({
          values: (values: Record<string, unknown>) => {
            const entry: Insert = { table, values, returning: false };
            inserts.push(entry);
            const fail = table === realDatabase.events && failEventsInserts > 0;
            if (fail) failEventsInserts--;
            const settle = () => (fail ? Promise.reject(new Error('events insert failed')) : Promise.resolve([{ id: 7n }]));
            return {
              returning: () => {
                entry.returning = true;
                return settle();
              },
              then: (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) => settle().then(onOk, onErr),
            };
          },
        });
      }
      // Guest resolution runs in a transaction: fail it (resolves to NULL, caught).
      if (property === 'transaction') return async () => { throw new Error('no db in unit test'); };
      if (property === 'query' || property === 'select') {
        reads++;
        throw new Error('unexpected read');
      }
    }
    return Reflect.get(realDb, property, realDb);
  },
});

mock.module('@clawville/database', () => ({ ...realDatabase, db: dbProxy }));
const realAlert = await import('../alert-error');
mock.module('../alert-error', () => ({ ...realAlert, alertError: async () => undefined }));

const {
  buildOwnedAgentEventInsert,
  logOwnedAgentEvent,
  logOwnedAgentEventFromContext,
  ownedEventUserIdSql,
} = await import('../event-logger');
const { sessionDigest } = await import('../session-digest');

const dialect = new PgDialect();
const CLAIM = { claimedOwnerUserId: OWNER, actedAt: ACTED_AT };
const SUBQUERY =
  '(SELECT b.user_id FROM openclaw_bots b WHERE b.agent_id = $1 AND b.user_id = $2::uuid AND b.owner_since <= $3::timestamptz FOR SHARE)';

function renderSql(value: unknown): { sql: string; params: unknown[] } {
  expect(is(value, SQL)).toBe(true);
  return dialect.sqlToQuery(value as SQL);
}

const baseRow = {
  eventType: 'agent.chat.turn',
  userId: OWNER,
  agentId: AGENT_ID,
  avatarId: null,
  buildingId: 'agent-security',
  sessionId: 'digest-1',
  payload: { chatType: 'character' },
  subjectWasGuest: null,
  fpHash: 'fp',
  ipPrefixHash: 'ip',
};

beforeEach(() => {
  mode = 'real';
  inserts = [];
  failEventsInserts = 0;
  reads = 0;
});

describe('owned event INSERT: SQL shape', () => {
  test('the user_id subquery: agent id, claimed owner, owner_since <= actedAt, FOR SHARE', () => {
    const { sql, params } = renderSql(ownedEventUserIdSql(AGENT_ID, CLAIM));
    expect(sql).toBe(SUBQUERY);
    expect(params).toEqual([AGENT_ID, OWNER, ACTED_AT]);
    // Raw SQL params are strings, never a JS Date.
    for (const p of params) expect(p instanceof Date).toBe(false);
  });

  test('the full INSERT resolves user_id with the subquery in the same statement', () => {
    const { sql, params } = buildOwnedAgentEventInsert(baseRow, AGENT_ID, CLAIM).toSQL();
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat.startsWith('insert into "events" (')).toBe(true);
    expect(flat).toContain('"user_id"');
    // ts keeps the column default now(); id is the bigserial default.
    expect(flat).toMatch(/values \(default, default, \$1, \(SELECT b\.user_id FROM openclaw_bots b WHERE b\.agent_id = \$2 AND b\.user_id = \$3::uuid AND b\.owner_since <= \$4::timestamptz FOR SHARE\), \$5,/);
    expect(flat.endsWith('returning "id"')).toBe(true);
    expect(flat.match(/FOR SHARE/g)?.length).toBe(1);
    expect(params.slice(0, 5)).toEqual(['agent.chat.turn', AGENT_ID, OWNER, ACTED_AT, AGENT_ID]);
    // The row's own user_id value is NOT bound anywhere: only the subquery decides.
    expect(params.filter((p) => p === OWNER)).toEqual([OWNER]);
    // Every other column keeps its value (fp/ip included).
    expect(params).toContain('agent-security');
    expect(params).toContain('digest-1');
    expect(params).toContain('fp');
    expect(params).toContain('ip');
  });
});

describe('logOwnedAgentEvent: routing, columns, never throws', () => {
  test('a claim takes the owned INSERT: user_id is the subquery, no owner read', async () => {
    mode = 'record';
    await logOwnedAgentEvent({
      eventType: 'building.visited',
      agentId: AGENT_ID,
      avatarId: '82222222-2222-4222-8222-222222222222',
      buildingId: 'agent-security',
      sessionId: 'digest-2',
      claimedOwnerUserId: OWNER,
      actedAt: ACTED_AT,
      payload: { activity: 'x', apiKey: 'leak-me' },
    });
    expect(reads).toBe(0);
    expect(inserts.length).toBe(1);
    const [insert] = inserts;
    expect(insert!.table).toBe(realDatabase.events);
    expect(insert!.returning).toBe(true);
    const { sql, params } = renderSql(insert!.values.userId);
    expect(sql).toBe(SUBQUERY);
    expect(params).toEqual([AGENT_ID, OWNER, ACTED_AT]);
    expect(insert!.values).toMatchObject({
      eventType: 'building.visited',
      agentId: AGENT_ID,
      avatarId: '82222222-2222-4222-8222-222222222222',
      buildingId: 'agent-security',
      sessionId: 'digest-2',
      fpHash: null,
      ipPrefixHash: null,
      // Guest lookup failed in this unit test: indeterminate, as in logEvent.
      subjectWasGuest: null,
    });
    // sanitize() still runs.
    expect(insert!.values.payload).toEqual({ activity: 'x', apiKey: '[REDACTED]' });
    expect('ts' in insert!.values).toBe(false);
  });

  test('no claim: the plain INSERT with NULL user_id (no subquery, no lock)', async () => {
    mode = 'record';
    await logOwnedAgentEvent({
      eventType: 'agent.chat.turn',
      agentId: AGENT_ID,
      claimedOwnerUserId: null,
      actedAt: ACTED_AT,
    });
    expect(inserts.length).toBe(1);
    expect(inserts[0]!.values.userId).toBeNull();
    expect(reads).toBe(0);
  });

  test('the subquery matches the SAME redacted agent_id the row stores', async () => {
    mode = 'record';
    const bearer = 'ag-' + 'A'.repeat(32);
    await logOwnedAgentEvent({ eventType: 'agent.chat.turn', agentId: bearer, claimedOwnerUserId: OWNER, actedAt: ACTED_AT });
    const values = inserts[0]!.values;
    expect(values.agentId).toBe(sessionDigest(bearer));
    expect(renderSql(values.userId).params[0]).toBe(sessionDigest(bearer));
  });

  test('fp/ip come from the request context in the FromContext variant', async () => {
    mode = 'record';
    const c = { get: (key: string) => (key === 'fpHash' ? 'ctx-fp' : key === 'ipPrefixHash' ? 'ctx-ip' : undefined) };
    await logOwnedAgentEventFromContext(c, { eventType: 'agent.chat.turn', agentId: AGENT_ID, claimedOwnerUserId: OWNER, actedAt: ACTED_AT });
    expect(inserts[0]!.values).toMatchObject({ fpHash: 'ctx-fp', ipPrefixHash: 'ctx-ip' });
    expect(is(inserts[0]!.values.userId, SQL)).toBe(true);
  });

  test('an INSERT failure never throws; the failure row records NULL user_id plus the claim', async () => {
    mode = 'record';
    failEventsInserts = 1;
    await expect(
      logOwnedAgentEvent({ eventType: 'agent.chat.turn', agentId: AGENT_ID, claimedOwnerUserId: OWNER, actedAt: ACTED_AT }),
    ).resolves.toBeUndefined();
    expect(inserts.length).toBe(2);
    expect(inserts[1]!.table).toBe(realDatabase.eventWriteFailures);
    const attempted = inserts[1]!.values.attemptedRow as Record<string, unknown>;
    expect(attempted.userId).toBeNull();
    expect(attempted.ownerClaim).toEqual(CLAIM);
    expect(attempted.agentId).toBe(AGENT_ID);
  });
});
