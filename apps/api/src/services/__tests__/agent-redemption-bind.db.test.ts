import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { AgentSubstrateClient } from '../agent-substrate-client';

/**
 * Real-PostgreSQL checks for the GET /api/auth/enter bind-at-redemption SQL
 * (connect-sec round 4, audit S3 + Codex r3 C3). The unit test
 * (`agent-redemption-bind.test.ts`) mocks the DB and only renders the CASE, so
 * a later edit to the CASE, the burn value or the UTC TTL could ship green.
 * These tests run the real UPDATE on Postgres and read the row back the way
 * the app does (Drizzle `timestamp` = UTC wall time):
 *   - keep: the row still names the ticket's session, so hash + TTL stay;
 *   - burn: the row names another session, so a random 64-hex hash is written
 *     and the TTL ends now;
 *   - a NULL-hash row and a ticket with no session digest also burn, never NULL;
 *   - the same SQL under the session time zone America/New_York;
 *   - C3: an eviction that throws is retried; one that keeps throwing burns
 *     the row (owner kept) and throws, so no bearer stays live.
 *
 * WRITES rows, so it needs DATABASE_URL on a LOCAL host AND an opt-in:
 * CI === 'true' (the gates.yml Postgres service) or CONNECT_SEC_DB_TEST=1.
 * Run it in its own process: it pins the pool to ONE connection
 * (DB_POOL_MAX=1) so a session SET reaches the bind's own queries.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const optedIn = process.env.CI === 'true' || process.env.CONNECT_SEC_DB_TEST === '1';
const localDatabase = /^postgres(ql)?:\/\/[^/]*@(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(databaseUrl);
const runDb = optedIn && localDatabase;
const describeIfDb = runDb ? describe : describe.skip;
if (runDb) process.env.DB_POOL_MAX = '1';

const suffix = randomUUID().slice(0, 8);
const REDEEMER = randomUUID();
const agentIds: string[] = [];
const liveSessions = new Set<string>();
/** Allowed gap between the stored burn TTL and this process's clock. */
const CLOCK_SLACK_MS = 60_000;

describeIfDb('redemption bind SQL on PostgreSQL (GET /api/auth/enter)', () => {
  let mod: {
    database: typeof import('@clawville/database');
    bind: typeof import('../agent-redemption-bind');
    sim: typeof import('../npc-simulation')['npcSimulation'];
    config: typeof import('../agent-session-config');
    digest: typeof import('../session-digest');
    gate: typeof import('../../middleware/require-auth-or-agent');
  };

  beforeAll(async () => {
    mod = {
      database: await import('@clawville/database'),
      bind: await import('../agent-redemption-bind'),
      sim: (await import('../npc-simulation')).npcSimulation,
      config: await import('../agent-session-config'),
      digest: await import('../session-digest'),
      gate: await import('../../middleware/require-auth-or-agent'),
    };
    const { db, sql } = mod.database;
    // users_has_auth_method needs email + password_hash (the CI schema restores that CHECK).
    await db.execute(sql`
      INSERT INTO users (id, email, password_hash, name)
      VALUES (${REDEEMER}::uuid, ${`redeem-${REDEEMER}@clawville-test.invalid`}, ${`disabled-${REDEEMER}`}, 'Redemption DB Test')
    `);
  }, 60_000);

  afterEach(() => {
    for (const sid of liveSessions) mod.sim.unregisterAgentBot(sid);
    liveSessions.clear();
  });

  afterAll(async () => {
    if (!mod) return;
    const { db, sql, agentBots, inArray } = mod.database;
    await db.execute(sql`RESET timezone`);
    if (agentIds.length > 0) await db.delete(agentBots).where(inArray(agentBots.agentId, agentIds));
    await db.execute(sql`DELETE FROM users WHERE id = ${REDEEMER}::uuid`);
  }, 60_000);

  function newAgentId(label: string): string {
    const agentId = `c7-${label}-${suffix}-${agentIds.length}`;
    agentIds.push(agentId);
    return agentId;
  }

  async function seedRow(agentId: string, sessionKeyHash: string | null, sessionExpiresAt: Date) {
    const { db, agentBots } = mod.database;
    await db.insert(agentBots).values({ agentId, mode: 'avatar', userId: null, sessionKeyHash, sessionExpiresAt });
  }

  async function readRow(agentId: string) {
    const { db, agentBots, eq } = mod.database;
    const [row] = await db
      .select({
        userId: agentBots.userId,
        sessionKeyHash: agentBots.sessionKeyHash,
        sessionExpiresAt: agentBots.sessionExpiresAt,
      })
      .from(agentBots)
      .where(eq(agentBots.agentId, agentId));
    return row;
  }

  async function sessionTimeZone(): Promise<string> {
    const { db, sql } = mod.database;
    const rows = (await db.execute(sql`SELECT current_setting('TimeZone') AS tz`)) as unknown as Array<{ tz: string }>;
    return rows[0].tz;
  }

  function expectBurned(row: Awaited<ReturnType<typeof readRow>>, hashBefore: string | null) {
    expect(row.userId).toBe(REDEEMER);
    expect(row.sessionKeyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.sessionKeyHash).not.toBe(hashBefore);
    // The TTL ended now, in UTC wall time (Drizzle reads `timestamp` as UTC).
    const expiresAt = row.sessionExpiresAt!.getTime();
    expect(Math.abs(expiresAt - Date.now())).toBeLessThan(CLOCK_SLACK_MS);
  }

  function register(agentId: string, sessionId: string) {
    const config = mod.config.buildAvatarSessionConfig({
      mode: 'avatar',
      agentId,
      sessionId,
      identityType: 'custom',
      storedProtocol: 'nanoclaw',
      autonomyMode: 'self-managed',
      name: 'Redemption DB',
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
    mod.sim.registerAgentBot(config, client);
    liveSessions.add(sessionId);
    return config;
  }

  test('keep: the row still names the ticket session, so hash and TTL stay and the owner binds', async () => {
    const agentId = newAgentId('keep');
    const keeperSid = `ag-c7-keep-${randomUUID()}`;
    const hash = mod.digest.sha256Hex(keeperSid);
    const expiresAt = new Date(Date.now() + 3_600_000);
    await seedRow(agentId, hash, expiresAt);

    const outcome = await mod.bind.bindAgentOwnerAtRedemption({
      agentId,
      redeemerUserId: REDEEMER,
      issuedSessionDigest: mod.digest.sessionDigest(keeperSid),
    });

    expect(outcome).toBe('first-bind');
    const row = await readRow(agentId);
    expect(row.userId).toBe(REDEEMER);
    expect(row.sessionKeyHash).toBe(hash);
    expect(row.sessionExpiresAt!.getTime()).toBe(expiresAt.getTime());
  });

  test('burn: the row names another session, so the hash is a fresh 64-hex value and the TTL ends now', async () => {
    const agentId = newAgentId('burn');
    const hashBefore = mod.digest.sha256Hex(`ag-c7-other-${randomUUID()}`);
    const ticketSid = `ag-c7-ticket-${randomUUID()}`;
    await seedRow(agentId, hashBefore, new Date(Date.now() + 3_600_000));

    const outcome = await mod.bind.bindAgentOwnerAtRedemption({
      agentId,
      redeemerUserId: REDEEMER,
      issuedSessionDigest: mod.digest.sessionDigest(ticketSid),
    });

    expect(outcome).toBe('first-bind');
    const row = await readRow(agentId);
    expectBurned(row, hashBefore);
    expect(row.sessionKeyHash).not.toBe(mod.digest.sha256Hex(ticketSid));
  });

  test('a NULL-hash row burns to a 64-hex value, never NULL', async () => {
    const agentId = newAgentId('null');
    await seedRow(agentId, null, new Date(Date.now() + 3_600_000));

    const outcome = await mod.bind.bindAgentOwnerAtRedemption({
      agentId,
      redeemerUserId: REDEEMER,
      issuedSessionDigest: mod.digest.sessionDigest(`ag-c7-ticket-${randomUUID()}`),
    });

    expect(outcome).toBe('first-bind');
    expectBurned(await readRow(agentId), null);
  });

  test('a ticket with no session digest burns the row', async () => {
    const agentId = newAgentId('nodigest');
    const hashBefore = mod.digest.sha256Hex(`ag-c7-live-${randomUUID()}`);
    await seedRow(agentId, hashBefore, new Date(Date.now() + 3_600_000));

    const outcome = await mod.bind.bindAgentOwnerAtRedemption({
      agentId,
      redeemerUserId: REDEEMER,
      issuedSessionDigest: null,
    });

    expect(outcome).toBe('first-bind');
    expectBurned(await readRow(agentId), hashBefore);
  });

  test('time zone America/New_York: the burn TTL is still UTC now and a keep is unchanged', async () => {
    const { db, sql } = mod.database;
    await db.execute(sql`SET timezone TO 'America/New_York'`);
    try {
      expect(await sessionTimeZone()).toBe('America/New_York');
      // Sanity: in this session a naive cast is NOT UTC wall time, so a CASE
      // that dropped AT TIME ZONE 'UTC' would fail the burn check below.
      const [skew] = (await db.execute(sql`
        SELECT extract(epoch FROM (now() AT TIME ZONE 'UTC') - now()::timestamp)::int AS seconds
      `)) as unknown as Array<{ seconds: number }>;
      expect(Math.abs(skew.seconds)).toBeGreaterThanOrEqual(3600 * 4);

      const burnId = newAgentId('tz-burn');
      const burnBefore = mod.digest.sha256Hex(`ag-c7-tz-other-${randomUUID()}`);
      await seedRow(burnId, burnBefore, new Date(Date.now() + 3_600_000));
      expect(await mod.bind.bindAgentOwnerAtRedemption({
        agentId: burnId,
        redeemerUserId: REDEEMER,
        issuedSessionDigest: mod.digest.sessionDigest(`ag-c7-tz-ticket-${randomUUID()}`),
      })).toBe('first-bind');
      expectBurned(await readRow(burnId), burnBefore);

      const keepId = newAgentId('tz-keep');
      const keeperSid = `ag-c7-tz-keep-${randomUUID()}`;
      const keepExpiry = new Date(Date.now() + 3_600_000);
      await seedRow(keepId, mod.digest.sha256Hex(keeperSid), keepExpiry);
      expect(await mod.bind.bindAgentOwnerAtRedemption({
        agentId: keepId,
        redeemerUserId: REDEEMER,
        issuedSessionDigest: mod.digest.sessionDigest(keeperSid),
      })).toBe('first-bind');
      const kept = await readRow(keepId);
      expect(kept.sessionKeyHash).toBe(mod.digest.sha256Hex(keeperSid));
      expect(kept.sessionExpiresAt!.getTime()).toBe(keepExpiry.getTime());

      // Same pooled connection the whole time (DB_POOL_MAX=1).
      expect(await sessionTimeZone()).toBe('America/New_York');
    } finally {
      await db.execute(sql`RESET timezone`);
    }
  });

  test('C3: an eviction that throws once is retried, so the stray is gone and the keeper is kept', async () => {
    const agentId = newAgentId('retry');
    const keeperSid = `ag-c7-retry-keeper-${randomUUID()}`;
    const straySid = `ag-c7-retry-stray-${randomUUID()}`;
    const keeperHash = mod.digest.sha256Hex(keeperSid);
    const expiresAt = new Date(Date.now() + 3_600_000);
    await seedRow(agentId, keeperHash, expiresAt);
    const keeper = register(agentId, keeperSid);
    register(agentId, straySid);

    const realUnregister = mod.sim.unregisterAgentBot.bind(mod.sim);
    let strayCalls = 0;
    const spy = spyOn(mod.sim, 'unregisterAgentBot').mockImplementation((sid: string) => {
      if (sid === straySid && ++strayCalls === 1) throw new Error('simulated eviction fault');
      return realUnregister(sid);
    });
    let outcome: string;
    try {
      outcome = await mod.bind.bindAgentOwnerAtRedemption({
        agentId,
        redeemerUserId: REDEEMER,
        issuedSessionDigest: mod.digest.sessionDigest(keeperSid),
      });
    } finally {
      spy.mockRestore();
    }

    expect(outcome).toBe('first-bind');
    expect(strayCalls).toBe(2);
    expect(mod.sim.findActiveSessionsByAgentIds([agentId])).toEqual([keeperSid]);
    expect(keeper.boundUserId).toBe(REDEEMER);
    const row = await readRow(agentId);
    expect(row.userId).toBe(REDEEMER);
    expect(row.sessionKeyHash).toBe(keeperHash);
    expect(row.sessionExpiresAt!.getTime()).toBe(expiresAt.getTime());
  });

  test('C3: an eviction that keeps throwing burns the row, keeps the owner, throws, and no bearer stays live', async () => {
    const agentId = newAgentId('fail');
    const keeperSid = `ag-c7-fail-keeper-${randomUUID()}`;
    const straySid = `ag-c7-fail-stray-${randomUUID()}`;
    const keeperHash = mod.digest.sha256Hex(keeperSid);
    await seedRow(agentId, keeperHash, new Date(Date.now() + 3_600_000));
    const keeper = register(agentId, keeperSid);
    register(agentId, straySid);

    const realUnregister = mod.sim.unregisterAgentBot.bind(mod.sim);
    let strayCalls = 0;
    const spy = spyOn(mod.sim, 'unregisterAgentBot').mockImplementation((sid: string) => {
      if (sid === straySid) {
        strayCalls++;
        throw new Error('simulated eviction fault');
      }
      return realUnregister(sid);
    });
    let thrown: unknown = null;
    try {
      await mod.bind.bindAgentOwnerAtRedemption({
        agentId,
        redeemerUserId: REDEEMER,
        issuedSessionDigest: mod.digest.sessionDigest(keeperSid),
      });
    } catch (err) {
      thrown = err;
    } finally {
      spy.mockRestore();
    }

    expect(thrown).toBeInstanceOf(mod.bind.RedemptionEvictionIncompleteError);
    expect(strayCalls).toBe(2);
    // No owner stamp on a failed bind.
    expect(keeper.boundUserId).toBeNull();
    // The row keeps the owner (never bound to nobody) and every bearer hash is dead.
    expectBurned(await readRow(agentId), keeperHash);
    // Use-time gate: neither the stray nor the keeper resolves any more.
    expect(await mod.gate.validateLiveAgentSession(straySid)).toBeNull();
    expect(await mod.gate.validateLiveAgentSession(keeperSid)).toBeNull();
    expect(mod.sim.findActiveSessionsByAgentIds([agentId])).toEqual([]);
  });
});
