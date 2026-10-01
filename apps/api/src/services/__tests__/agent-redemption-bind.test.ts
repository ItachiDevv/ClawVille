import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SQL } from 'drizzle-orm';
import type { AgentSubstrateClient } from '../agent-substrate-client';

// Security 2026-09-30 (round 2): GET /api/auth/enter bind-at-redemption used one
// guarded UPDATE, evicted nothing, and stamped the redeemer on EVERY live
// session for the agent, so a session that displaced the agent while the row
// was unbound resolved as the owner. These tests pin the rule in
// `bindAgentOwnerAtRedemption`: a first bind keeps only the session the row
// AND the ticket both name, else it burns the row hash (never NULL), ends the
// TTL and evicts every live session; it marks the owner fence before the
// eviction (round 2b); a re-affirm and a skip change nothing else. DB-free: the
// db is a proxy that evaluates the CASE like Postgres, the simulation is the
// real singleton. Uses mock.module, so CI runs it in its own process
// (gates.yml isolates every mock.module file).

type UpdateCall = {
  table: unknown;
  values: Record<string, unknown>;
  where: unknown;
  returningKeys: string[];
};

let updateCalls: UpdateCall[] = [];
let updateReturns: (index: number, call: UpdateCall) => unknown[] = () => [];

const realDatabase = await import('@clawville/database');
// Copies taken BEFORE the mocks, restored in afterAll, so a single-process run
// does not leak this file's stubs into later test files.
const restoreModules: Array<[string, Record<string, unknown>]> = [['@clawville/database', { ...realDatabase }]];
afterAll(() => {
  for (const [path, real] of restoreModules) mock.module(path, () => real);
});
const delegateDb = realDatabase.db as unknown as Record<PropertyKey, unknown>;

const dbProxy = new Proxy<Record<PropertyKey, unknown>>({}, {
  get(_target, property) {
    if (property === 'update') {
      return (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: (where: unknown) => ({
            returning: async (columns?: Record<string, unknown>) => {
              const call = { table, values, where, returningKeys: Object.keys(columns ?? {}) };
              updateCalls.push(call);
              return updateReturns(updateCalls.length, call);
            },
          }),
        }),
      });
    }
    return Reflect.get(delegateDb, property, delegateDb);
  },
});

mock.module('@clawville/database', () => ({ ...realDatabase, db: dbProxy }));

const { bindAgentOwnerAtRedemption } = await import('../agent-redemption-bind');
const { consumeTicket } = await import('../session-ticket-service');
const { npcSimulation } = await import('../npc-simulation');
const { buildAvatarSessionConfig } = await import('../agent-session-config');
const { sessionDigest, sha256Hex } = await import('../session-digest');
const { agentOwnerBoundSince, ownerBindSnapshot, __resetAgentOwnerFenceForTests } = await import('../agent-owner-fence');

const REDEEMER = '61111111-1111-4111-8111-111111111111';
const BOT_ID = '62222222-2222-4222-8222-222222222222';
const KEEP_HASH_SQL =
  'CASE WHEN left("openclaw_bots"."session_key_hash", 16) = $1 THEN "openclaw_bots"."session_key_hash" ELSE $2 END';
const KEEP_EXPIRY_SQL =
  'CASE WHEN left("openclaw_bots"."session_key_hash", 16) = $1 THEN "openclaw_bots"."session_expires_at" ELSE (now() AT TIME ZONE \'UTC\') END';
const dialect = new PgDialect();
const liveSessions = new Set<string>();

function register(agentId: string, sessionId: string) {
  const config = buildAvatarSessionConfig({
    mode: 'avatar',
    agentId,
    sessionId,
    identityType: 'custom',
    storedProtocol: 'nanoclaw',
    autonomyMode: 'self-managed',
    name: 'Redemption Bind',
    species: 'milady_official_1',
    color: 0x123456,
    stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
    homeX: 2560,
    homeY: 2560,
    patrolRadius: 100,
    personality: '',
    // A session minted on an unowned row: no owner proof.
    ledgerCapable: false,
    boundUserId: null,
  });
  // Stub client: nanoclaw bodies never POST anywhere; the sim only stores it.
  const client = { getProtocol: () => 'nanoclaw' } as unknown as AgentSubstrateClient;
  npcSimulation.registerAgentBot(config, client);
  liveSessions.add(sessionId);
  return { config, client };
}

function bodyIdFor(agentId: string): string {
  return `ocb-${Buffer.from(agentId, 'utf8').toString('base64url')}`;
}

function render(value: unknown) {
  return dialect.sqlToQuery(value as SQL);
}

function expectFirstBindWhere(call: UpdateCall, agentId: string) {
  const where = render(call.where);
  expect(where.sql).toBe('("openclaw_bots"."agent_id" = $1 and "openclaw_bots"."user_id" is null)');
  expect(where.params).toEqual([agentId]);
}

/**
 * The `session_key_hash` Postgres would RETURN for the first-bind UPDATE, given
 * the row hash BEFORE it: the CASE keeps the old hash when its 16-hex prefix is
 * the CASE digest, else it writes the ELSE value. A plain string is written as is.
 */
function returnedHash(call: UpdateCall, rowHashBefore: string | null): string {
  const value = call.values.sessionKeyHash;
  if (typeof value === 'string') return value;
  const [digest, elseHash] = render(value).params as [string, string];
  return rowHashBefore !== null && rowHashBefore.slice(0, 16) === digest ? rowHashBefore : elseHash;
}

/** First UPDATE binds the row whose hash before the bind is `rowHashBefore`. */
function firstBindOn(rowHashBefore: string | null) {
  updateReturns = (index, call) =>
    index === 1 ? [{ id: BOT_ID, sessionKeyHash: returnedHash(call, rowHashBefore) }] : [];
}

beforeEach(() => {
  updateCalls = [];
  updateReturns = () => [];
  __resetAgentOwnerFenceForTests();
});

afterEach(() => {
  for (const sid of liveSessions) npcSimulation.unregisterAgentBot(sid);
  liveSessions.clear();
});

describe('bindAgentOwnerAtRedemption (GET /api/auth/enter)', () => {
  test('first bind keeps the issued session the row still names, evicts the stray, and respawns the body', async () => {
    const agentId = 'redeem-keeper-and-stray';
    const keeperSid = 'ag-redeem-keeper-1';
    const straySid = 'ag-redeem-stray-1';
    const keeper = register(agentId, keeperSid);
    const stray = register(agentId, straySid);
    const bodyId = bodyIdFor(agentId);
    // The stray registered last, so it owns the shared avatar body.
    expect(npcSimulation.getAgentBotClient(bodyId)).toBe(stray.client);
    const bodyBefore = npcSimulation.getNpcById(bodyId)!;
    const issuedDigest = sessionDigest(keeperSid);
    firstBindOn(sha256Hex(keeperSid));

    const outcome = await bindAgentOwnerAtRedemption({
      agentId,
      redeemerUserId: REDEEMER,
      issuedSessionDigest: issuedDigest,
    });

    expect(outcome).toBe('first-bind');
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([keeperSid]);
    expect(npcSimulation.isValidAgentSession(straySid)).toBe(false);
    // The owner stamp lands on the keeper only; ledger capability is unchanged.
    expect(keeper.config.boundUserId).toBe(REDEEMER);
    expect(keeper.config.ledgerCapable).toBe(false);
    expect(stray.config.boundUserId).toBeNull();
    // The shared body the stray took down is back, owned by the keeper, same spot.
    const bodyAfter = npcSimulation.getNpcById(bodyId);
    expect(bodyAfter).toBeTruthy();
    expect(npcSimulation.getAgentBotClient(bodyId)).toBe(keeper.client);
    expect(bodyAfter!.x).toBe(bodyBefore.x);
    expect(bodyAfter!.y).toBe(bodyBefore.y);

    // One UPDATE: first-bind WHERE; owner, hash and TTL in the SAME statement.
    expect(updateCalls).toHaveLength(1);
    const [call] = updateCalls;
    expect(call.table).toBe(realDatabase.agentBots);
    expectFirstBindWhere(call, agentId);
    expect(call.returningKeys).toEqual(['id', 'sessionKeyHash']);
    expect(call.values.userId).toBe(REDEEMER);
    const hash = render(call.values.sessionKeyHash);
    expect(hash.sql).toBe(KEEP_HASH_SQL);
    expect(hash.params[0]).toBe(issuedDigest);
    // The ELSE value is a burned hash, never a session's hash and never NULL.
    expect(hash.params[1]).toMatch(/^[0-9a-f]{64}$/);
    for (const sid of [keeperSid, straySid]) expect(hash.params).not.toContain(sha256Hex(sid));
    const expiry = render(call.values.sessionExpiresAt);
    expect(expiry.sql).toBe(KEEP_EXPIRY_SQL);
    expect(expiry.params).toEqual([issuedDigest]);
  });

  test('a keeper whose hash a later connect rotated away stays dead (rotation-stale rule)', async () => {
    const agentId = 'redeem-rotated-keeper';
    const keeperSid = 'ag-redeem-rotated-keeper';
    const straySid = 'ag-redeem-rotated-stray';
    const keeper = register(agentId, keeperSid);
    const stray = register(agentId, straySid);
    // The stray's connect rotated the row hash after the ticket was minted.
    firstBindOn(sha256Hex(straySid));

    const outcome = await bindAgentOwnerAtRedemption({
      agentId,
      redeemerUserId: REDEEMER,
      issuedSessionDigest: sessionDigest(keeperSid),
    });

    expect(outcome).toBe('first-bind');
    // Every bearer is dead: the row hash is burned, so nothing is kept.
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([]);
    expect(npcSimulation.isValidAgentSession(keeperSid)).toBe(false);
    expect(npcSimulation.isValidAgentSession(straySid)).toBe(false);
    expect(npcSimulation.getNpcById(bodyIdFor(agentId))).toBeNull();
    expect(keeper.config.boundUserId).toBeNull();
    expect(stray.config.boundUserId).toBeNull();
    // The UPDATE never writes the keeper's (or the stray's) hash back.
    const hash = render(updateCalls[0].values.sessionKeyHash);
    expect(hash.sql).toBe(KEEP_HASH_SQL);
    expect(hash.params).not.toContain(sha256Hex(keeperSid));
    expect(hash.params).not.toContain(sha256Hex(straySid));
    expect(hash.params[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(render(updateCalls[0].values.sessionExpiresAt).sql).toBe(KEEP_EXPIRY_SQL);
  });

  test('first bind with the keeper already on the body leaves that body in place', async () => {
    const agentId = 'redeem-keeper-owns-body';
    const straySid = 'ag-redeem-stray-2';
    const keeperSid = 'ag-redeem-keeper-2';
    register(agentId, straySid);
    const keeper = register(agentId, keeperSid);
    const bodyId = bodyIdFor(agentId);
    const bodyBefore = npcSimulation.getNpcById(bodyId);
    firstBindOn(sha256Hex(keeperSid));

    const outcome = await bindAgentOwnerAtRedemption({
      agentId,
      redeemerUserId: REDEEMER,
      issuedSessionDigest: sessionDigest(keeperSid),
    });

    expect(outcome).toBe('first-bind');
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([keeperSid]);
    expect(npcSimulation.getNpcById(bodyId)).toBe(bodyBefore);
    expect(npcSimulation.getAgentBotClient(bodyId)).toBe(keeper.client);
  });

  test('the row names the issued session but it is not live here: every live session is evicted', async () => {
    const agentId = 'redeem-no-keeper';
    const strayA = 'ag-redeem-stray-a';
    const strayB = 'ag-redeem-stray-b';
    const goneKeeper = 'ag-redeem-keeper-gone';
    const a = register(agentId, strayA);
    const b = register(agentId, strayB);
    // A keeper not live in this process keeps its hash and can still restore.
    firstBindOn(sha256Hex(goneKeeper));

    const outcome = await bindAgentOwnerAtRedemption({
      agentId,
      redeemerUserId: REDEEMER,
      issuedSessionDigest: sessionDigest(goneKeeper),
    });

    expect(outcome).toBe('first-bind');
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([]);
    expect(npcSimulation.getNpcById(bodyIdFor(agentId))).toBeNull();
    expect(a.config.boundUserId).toBeNull();
    expect(b.config.boundUserId).toBeNull();
    expect(updateCalls).toHaveLength(1);
    expectFirstBindWhere(updateCalls[0], agentId);
    const hash = render(updateCalls[0].values.sessionKeyHash);
    expect(hash.params[0]).toBe(sessionDigest(goneKeeper));
    for (const sid of [strayA, strayB, goneKeeper]) expect(hash.params).not.toContain(sha256Hex(sid));
  });

  test('a null issued digest burns the hash, ends the TTL, and evicts every live session', async () => {
    const agentId = 'redeem-null-digest';
    const strayA = 'ag-redeem-null-a';
    const strayB = 'ag-redeem-null-b';
    register(agentId, strayA);
    register(agentId, strayB);
    firstBindOn(sha256Hex(strayB));

    const outcome = await bindAgentOwnerAtRedemption({
      agentId,
      redeemerUserId: REDEEMER,
      issuedSessionDigest: null,
    });

    expect(outcome).toBe('first-bind');
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([]);
    expect(updateCalls).toHaveLength(1);
    expectFirstBindWhere(updateCalls[0], agentId);
    const hash = updateCalls[0].values.sessionKeyHash;
    expect(typeof hash).toBe('string');
    expect(hash as string).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(sha256Hex(strayA));
    expect(hash).not.toBe(sha256Hex(strayB));
    const expiry = render(updateCalls[0].values.sessionExpiresAt);
    expect(expiry.sql).toBe('(now() AT TIME ZONE \'UTC\')');
    expect(expiry.params).toEqual([]);
  });

  test('a first bind marks the owner fence before the eviction scan', async () => {
    const agentId = 'redeem-fence-order';
    const keeperSid = 'ag-redeem-fence-keeper';
    const straySid = 'ag-redeem-fence-stray';
    register(agentId, keeperSid);
    register(agentId, straySid);
    firstBindOn(sha256Hex(keeperSid));
    const fencedAtEviction: boolean[] = [];
    // Taken before the bind, so only a mark made by this bind counts.
    const fenceSnapshot = ownerBindSnapshot();
    const realUnregister = npcSimulation.unregisterAgentBot.bind(npcSimulation);
    npcSimulation.unregisterAgentBot = ((sid: string) => {
      fencedAtEviction.push(agentOwnerBoundSince(agentId, fenceSnapshot));
      return realUnregister(sid);
    }) as typeof npcSimulation.unregisterAgentBot;
    try {
      expect(agentOwnerBoundSince(agentId, fenceSnapshot)).toBe(false);
      const outcome = await bindAgentOwnerAtRedemption({
        agentId,
        redeemerUserId: REDEEMER,
        issuedSessionDigest: sessionDigest(keeperSid),
      });
      expect(outcome).toBe('first-bind');
    } finally {
      delete (npcSimulation as unknown as Record<string, unknown>).unregisterAgentBot;
    }
    expect(fencedAtEviction).toEqual([true]);
    expect(agentOwnerBoundSince(agentId, fenceSnapshot)).toBe(true);
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([keeperSid]);
  });

  test('re-affirm for the same owner evicts nothing, changes no hash, and marks no fence', async () => {
    const agentId = 'redeem-reaffirm';
    const keeperSid = 'ag-redeem-reaffirm-1';
    const otherSid = 'ag-redeem-reaffirm-2';
    const keeper = register(agentId, keeperSid);
    const other = register(agentId, otherSid);
    updateReturns = (index) => (index === 2 ? [{ id: BOT_ID }] : []);
    const fenceSnapshot = ownerBindSnapshot();

    const outcome = await bindAgentOwnerAtRedemption({
      agentId,
      redeemerUserId: REDEEMER,
      issuedSessionDigest: sessionDigest(keeperSid),
    });

    expect(outcome).toBe('reaffirm');
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId]).sort()).toEqual([keeperSid, otherSid].sort());
    // Unchanged behavior: the stamp reaches every live config.
    expect(keeper.config.boundUserId).toBe(REDEEMER);
    expect(other.config.boundUserId).toBe(REDEEMER);
    expect(agentOwnerBoundSince(agentId, fenceSnapshot)).toBe(false);
    expect(updateCalls).toHaveLength(2);
    expectFirstBindWhere(updateCalls[0], agentId);
    const reaffirm = updateCalls[1];
    expect(Object.keys(reaffirm.values)).toEqual(['updatedAt']);
    const where = render(reaffirm.where);
    expect(where.sql).toBe('("openclaw_bots"."agent_id" = $1 and "openclaw_bots"."user_id" = $2)');
    expect(where.params).toEqual([agentId, REDEEMER]);
  });

  test('a row owned by another user (or no row) is skipped with no eviction and no fence', async () => {
    const agentId = 'redeem-skipped';
    const sid = 'ag-redeem-skipped-1';
    const session = register(agentId, sid);
    updateReturns = () => [];
    const fenceSnapshot = ownerBindSnapshot();

    const outcome = await bindAgentOwnerAtRedemption({
      agentId,
      redeemerUserId: REDEEMER,
      issuedSessionDigest: sessionDigest(sid),
    });

    expect(outcome).toBe('skipped');
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([sid]);
    expect(session.config.boundUserId).toBeNull();
    expect(agentOwnerBoundSince(agentId, fenceSnapshot)).toBe(false);
    expect(updateCalls).toHaveLength(2);
  });
});

describe('consumeTicket', () => {
  test('returns the stored session digest the ticket was issued to', async () => {
    updateReturns = () => [{
      userId: REDEEMER,
      avatarId: null,
      ticket: 'sess-consume-digest',
      identityType: 'custom',
      issuedToAgentId: 'agent-consume',
      issuedToAgentSession: '0123456789abcdef',
    }];
    const consumed = await consumeTicket('sess-consume-digest');
    expect(consumed?.issuedToAgentSession).toBe('0123456789abcdef');
    expect(consumed?.issuedToAgentId).toBe('agent-consume');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].table).toBe(realDatabase.agentSessionTickets);
    expect(updateCalls[0].returningKeys).toContain('issuedToAgentSession');
  });

  test('maps a missing digest to null', async () => {
    updateReturns = () => [{
      userId: REDEEMER,
      avatarId: null,
      ticket: 'sess-consume-null',
      identityType: 'custom',
      issuedToAgentId: null,
      issuedToAgentSession: null,
    }];
    const consumed = await consumeTicket('sess-consume-null');
    expect(consumed).not.toBeNull();
    expect(consumed!.issuedToAgentSession).toBeNull();
  });
});
