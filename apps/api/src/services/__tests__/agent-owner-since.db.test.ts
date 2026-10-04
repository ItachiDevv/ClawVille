import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

/**
 * Real-PostgreSQL checks for migration 0079_agent_owner_since.sql and the
 * owner-period scope of `services/agent-event-query.ts` (security pass
 * 2026-10-04, Codex BLOCKING on protocol 83: after an ownership change the new
 * owner read the prior owner's directive events).
 *
 *   - the `openclaw_bots_owner_since` trigger stamps `owner_since` on INSERT and
 *     on every `user_id` change (NULL -> owner through the real redemption bind,
 *     owner -> other, owner -> NULL, an upsert that rewrites user_id, and the
 *     users FK ON DELETE SET NULL), keeps it on every other write (same-owner
 *     rewrite, unrelated column, upsert without user_id), and ignores a direct
 *     write to it;
 *   - the shared history query (replay, SSE catch-up and the driver wake-seed
 *     all call it) returns only the proven current owner's period, hides a late
 *     prior-owner row, hides EVERY NULL-attributed row whatever its type (Codex
 *     round 3 BLOCKING, founder rule: event history is owner-only) while it
 *     returns the owner-attributed rows of every type, and returns nothing for
 *     a stale owner proof (the owner re-check runs in the same statement as
 *     the scope);
 *   - Codex round 4: the owned event insert (`event-logger.ts`
 *     `logOwnedAgentEvent`) resolves `user_id` inside the INSERT under FOR
 *     SHARE: the claimed owner only while it owns the row and has owned it
 *     since `actedAt` (else NULL, the row is still written); a concurrent owner
 *     change WAITS for the event insert to commit and stamps owner_since after
 *     the event ts; an owner change in flight makes the event insert wait and
 *     then yield NULL (or the owner, when the change rolls back). The
 *     concurrency cases need a pool of 3+ connections (the default is 10).
 *
 * WRITES rows, so it needs DATABASE_URL on a LOCAL host AND an opt-in:
 * CI === 'true' (the gates.yml Postgres service, after migrate-ci applied 0079)
 * or OWNER_SINCE_DB_TEST=1. Every row uses fresh ids and is removed afterwards.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const optedIn = process.env.CI === 'true' || process.env.OWNER_SINCE_DB_TEST === '1';
const localDatabase = /^postgres(ql)?:\/\/[^/]*@(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(databaseUrl);
const describeIfDb = optedIn && localDatabase ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const PRIOR = randomUUID();
const NEXT = randomUUID();
const DOOMED = randomUUID();
const PRIOR_DIRECTIVE = `prior owner directive ${suffix}: sell everything at dawn`;
const NEXT_DIRECTIVE = `new owner directive ${suffix}: learn at the cron tower`;
const agentIds: string[] = [];

/** JSON text of query rows (bigint ids as strings). */
function asJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
}

describeIfDb('openclaw_bots.owner_since trigger + owner-period history scope (PostgreSQL)', () => {
  let mod: {
    database: typeof import('@clawville/database');
    query: typeof import('../agent-event-query');
    bind: typeof import('../agent-redemption-bind');
    logger: typeof import('../event-logger');
  };

  beforeAll(async () => {
    mod = {
      database: await import('@clawville/database'),
      query: await import('../agent-event-query'),
      bind: await import('../agent-redemption-bind'),
      logger: await import('../event-logger'),
    };
    const { db, sql } = mod.database;
    // users_has_auth_method needs email + password_hash (the CI schema restores that CHECK).
    for (const id of [PRIOR, NEXT, DOOMED]) {
      await db.execute(sql`
        INSERT INTO users (id, email, password_hash, name)
        VALUES (${id}::uuid, ${`owner-since-${id}@clawville-test.invalid`}, ${`disabled-${id}`}, 'Owner Since DB Test')
      `);
    }
  }, 60_000);

  afterAll(async () => {
    if (!mod) return;
    const { db, sql, agentBots, events, inArray } = mod.database;
    if (agentIds.length > 0) {
      await db.delete(events).where(inArray(events.agentId, agentIds));
      await db.delete(agentBots).where(inArray(agentBots.agentId, agentIds));
    }
    for (const id of [PRIOR, NEXT, DOOMED]) await db.execute(sql`DELETE FROM users WHERE id = ${id}::uuid`);
  }, 60_000);

  function newAgentId(label: string): string {
    const agentId = `os-${label}-${suffix}-${agentIds.length}`;
    agentIds.push(agentId);
    return agentId;
  }

  async function insertRow(agentId: string, userId: string | null): Promise<void> {
    const { db, agentBots } = mod.database;
    await db.insert(agentBots).values({ agentId, mode: 'avatar', userId });
  }

  /** owner_since as exact text (microseconds), plus the row owner. */
  async function readStamp(agentId: string): Promise<{ stamp: string; userId: string | null }> {
    const { db, sql, agentBots, eq } = mod.database;
    const [row] = await db
      .select({ stamp: sql<string>`${agentBots.ownerSince}::text`, userId: agentBots.userId })
      .from(agentBots)
      .where(eq(agentBots.agentId, agentId));
    return row!;
  }

  /** Compare the stored stamp with an earlier one IN SQL (no JS Date rounding). */
  async function stampVs(agentId: string, before: string): Promise<'advanced' | 'same' | 'earlier'> {
    const { db, sql, agentBots, eq } = mod.database;
    const [row] = await db
      .select({
        advanced: sql<boolean>`${agentBots.ownerSince} > ${before}::timestamptz`,
        same: sql<boolean>`${agentBots.ownerSince} = ${before}::timestamptz`,
      })
      .from(agentBots)
      .where(eq(agentBots.agentId, agentId));
    if (row!.advanced) return 'advanced';
    return row!.same ? 'same' : 'earlier';
  }

  /**
   * Insert one event stamped at insert time, like `event-logger.ts` (whose
   * rows take the column default). clock_timestamp() so every row in this
   * test gets its own instant, in insert order.
   */
  async function insertEvent(input: {
    agentId: string;
    eventType: string;
    userId: string | null;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const { db, sql } = mod.database;
    await db.execute(sql`
      INSERT INTO events (ts, event_type, user_id, agent_id, payload)
      VALUES (clock_timestamp(), ${input.eventType}, ${input.userId}::uuid, ${input.agentId}, ${JSON.stringify(input.payload)}::jsonb)
    `);
  }

  /** Real time passes between phases, so phase boundaries are distinct instants. */
  async function pause(): Promise<void> {
    const { db, sql } = mod.database;
    await db.execute(sql`SELECT pg_sleep(0.02)`);
  }

  describe('trigger: every owner change stamps owner_since, nothing else does', () => {
    test('INSERT stamps now and ignores a supplied value (owned and unowned rows)', async () => {
      const { db, sql, agentBots } = mod.database;
      const owned = newAgentId('ins-owned');
      await db.insert(agentBots).values({ agentId: owned, mode: 'avatar', userId: PRIOR, ownerSince: new Date('2001-01-01T00:00:00Z') });
      const unowned = newAgentId('ins-unowned');
      await insertRow(unowned, null);
      for (const agentId of [owned, unowned]) {
        const [row] = await db
          .select({ recent: sql<boolean>`${agentBots.ownerSince} > clock_timestamp() - interval '1 minute'` })
          .from(agentBots)
          .where(sql`${agentBots.agentId} = ${agentId}`);
        expect(row!.recent).toBe(true);
      }
    });

    test('writes that keep the owner keep owner_since: unrelated column, same-owner rewrite, direct write', async () => {
      const { db, agentBots, eq } = mod.database;
      const agentId = newAgentId('keep');
      await insertRow(agentId, PRIOR);
      const { stamp } = await readStamp(agentId);
      await db.update(agentBots).set({ name: 'renamed', updatedAt: new Date() }).where(eq(agentBots.agentId, agentId));
      expect(await stampVs(agentId, stamp)).toBe('same');
      // partner-hatcher patch shape: `userId: existing.userId`.
      await db.update(agentBots).set({ userId: PRIOR }).where(eq(agentBots.agentId, agentId));
      expect(await stampVs(agentId, stamp)).toBe('same');
      // An application write to owner_since is ignored by the trigger.
      await db.update(agentBots).set({ ownerSince: new Date('2001-01-01T00:00:00Z') }).where(eq(agentBots.agentId, agentId));
      expect(await stampVs(agentId, stamp)).toBe('same');
    });

    test('NULL -> owner through the real redemption bind (GET /api/auth/enter) advances owner_since', async () => {
      const agentId = newAgentId('redeem');
      await insertRow(agentId, null);
      const { stamp } = await readStamp(agentId);
      await pause();
      const outcome = await mod.bind.bindAgentOwnerAtRedemption({ agentId, redeemerUserId: NEXT, issuedSessionDigest: null });
      expect(outcome).toBe('first-bind');
      expect((await readStamp(agentId)).userId).toBe(NEXT);
      expect(await stampVs(agentId, stamp)).toBe('advanced');
    });

    test('owner -> other owner, then owner -> NULL, each advance owner_since', async () => {
      const { db, agentBots, eq } = mod.database;
      const agentId = newAgentId('move');
      await insertRow(agentId, PRIOR);
      const first = (await readStamp(agentId)).stamp;
      await pause();
      await db.update(agentBots).set({ userId: NEXT, updatedAt: new Date() }).where(eq(agentBots.agentId, agentId));
      expect(await stampVs(agentId, first)).toBe('advanced');
      const second = (await readStamp(agentId)).stamp;
      await pause();
      await db.update(agentBots).set({ userId: null }).where(eq(agentBots.agentId, agentId));
      expect(await stampVs(agentId, second)).toBe('advanced');
    });

    test('upsert: ON CONFLICT DO UPDATE of user_id advances, ON CONFLICT DO UPDATE without it keeps', async () => {
      const { db, agentBots } = mod.database;
      const agentId = newAgentId('upsert');
      await insertRow(agentId, PRIOR);
      const first = (await readStamp(agentId)).stamp;
      await db.insert(agentBots).values({ agentId, mode: 'avatar', userId: PRIOR })
        .onConflictDoUpdate({ target: agentBots.agentId, set: { name: 'upserted' } });
      expect(await stampVs(agentId, first)).toBe('same');
      await pause();
      await db.insert(agentBots).values({ agentId, mode: 'avatar', userId: NEXT })
        .onConflictDoUpdate({ target: agentBots.agentId, set: { userId: NEXT } });
      expect((await readStamp(agentId)).userId).toBe(NEXT);
      expect(await stampVs(agentId, first)).toBe('advanced');
    });

    test('users FK ON DELETE SET NULL (account deletion) advances owner_since', async () => {
      const { db, sql } = mod.database;
      const agentId = newAgentId('fk');
      await insertRow(agentId, DOOMED);
      const { stamp } = await readStamp(agentId);
      await pause();
      await db.execute(sql`DELETE FROM users WHERE id = ${DOOMED}::uuid`);
      expect((await readStamp(agentId)).userId).toBeNull();
      expect(await stampVs(agentId, stamp)).toBe('advanced');
    });
  });

  describe('history query: only the proven current owner period', () => {
    test('a new owner never reads the prior owner events; the prior owner read them while it owned the row', async () => {
      const { db, agentBots, eq } = mod.database;
      const { queryDurableAgentEvents, queryDurableAgentEventsNewest } = mod.query;
      const agentId = newAgentId('history');
      const other = newAgentId('history-other');
      await insertRow(agentId, PRIOR);
      await insertRow(other, PRIOR);

      // Prior owner's period.
      await pause();
      await insertEvent({ agentId, eventType: 'agent.directive.set', userId: PRIOR, payload: { directive: PRIOR_DIRECTIVE } });
      await insertEvent({ agentId, eventType: 'cove.blackjack.hand.settled', userId: PRIOR, payload: { net: 40 } });
      await insertEvent({ agentId, eventType: 'building.visited', userId: PRIOR, payload: { buildingId: 'prior-visit' } });
      // NULL-attributed rows of ANY type are hidden even inside the owner's own
      // period (Codex round 3): only owner-attributed rows are returned.
      await insertEvent({ agentId, eventType: 'building.visited', userId: null, payload: { buildingId: 'prior-null-visit' } });
      await insertEvent({ agentId, eventType: 'land.service.sold', userId: null, payload: { priceCt: 7 } });
      // Not whitelisted, and another agent's directive: never returned.
      await insertEvent({ agentId, eventType: 'agent.connected', userId: PRIOR, payload: {} });
      await insertEvent({ agentId: other, eventType: 'agent.directive.set', userId: PRIOR, payload: { directive: 'other agent' } });

      const priorView = await queryDurableAgentEvents({ agentId, ownerUserId: PRIOR }, 0n, 100);
      expect(priorView.map((row) => row.eventType)).toEqual([
        'agent.directive.set', 'cove.blackjack.hand.settled', 'building.visited',
      ]);
      expect(asJson(priorView)).toContain(PRIOR_DIRECTIVE);
      expect(asJson(priorView)).toContain('prior-visit');
      expect(asJson(priorView)).not.toContain('prior-null-visit');

      // Ownership moves to NEXT (owner_since advances to now).
      await pause();
      await db.update(agentBots).set({ userId: NEXT, updatedAt: new Date() }).where(eq(agentBots.agentId, agentId));
      await pause();

      // A late prior-owner row: its fire-and-forget insert landed AFTER the
      // change (ts inside the new period) but it carries the prior owner's id.
      await insertEvent({ agentId, eventType: 'agent.directive.set', userId: PRIOR, payload: { directive: `${PRIOR_DIRECTIVE} (late)` } });
      // Codex rounds 2 + 3: NULL-attributed rows inside the new period, of
      // EVERY type. owner_since cannot prove who owned them (a late prior-owner
      // insert looks the same), so none is returned: directive text, a cove
      // settlement, a gateway chat turn (target + message length) and an
      // autonomous arrival.
      await insertEvent({ agentId, eventType: 'agent.directive.set', userId: null, payload: { directive: `${PRIOR_DIRECTIVE} (null-attributed)` } });
      await insertEvent({ agentId, eventType: 'cove.slots.spin.executed', userId: null, payload: { winAmount: '999' } });
      await insertEvent({ agentId, eventType: 'agent.chat.turn', userId: null, payload: { chatType: 'character', targetNpcId: 'null-chat-target', messageLength: 42 } });
      await insertEvent({ agentId, eventType: 'building.visited', userId: null, payload: { buildingId: 'null-arrival' } });
      // The new owner's own period: owner-attributed rows of both kinds.
      await insertEvent({ agentId, eventType: 'agent.directive.set', userId: NEXT, payload: { directive: NEXT_DIRECTIVE } });
      await insertEvent({ agentId, eventType: 'agent.chat.turn', userId: NEXT, payload: { chatType: 'system-agent' } });

      const nextView = await queryDurableAgentEvents({ agentId, ownerUserId: NEXT }, 0n, 100);
      // Only the two NEXT-attributed rows; no NULL-attributed row of any type.
      expect(nextView.map((row) => [row.eventType, row.payload])).toEqual([
        ['agent.directive.set', { directive: NEXT_DIRECTIVE }],
        ['agent.chat.turn', { chatType: 'system-agent' }],
      ]);
      expect(asJson(nextView)).not.toContain(PRIOR_DIRECTIVE);
      expect(asJson(nextView)).not.toContain('null-chat-target');
      expect(asJson(nextView)).not.toContain('null-arrival');
      expect(asJson(nextView)).not.toContain('winAmount');
      // SAFE COLUMNS ONLY: exactly id/eventType/ts/payload.
      expect(Object.keys(nextView[0]!).sort()).toEqual(['eventType', 'id', 'payload', 'ts']);
      expect(typeof nextView[0]!.id).toBe('bigint');
      expect(nextView[0]!.ts).toBeInstanceOf(Date);

      // The driver wake-seed's newest-first read has the same scope.
      const newest = await queryDurableAgentEventsNewest({ agentId, ownerUserId: NEXT }, 0n, 20);
      expect(newest.map((row) => row.id)).toEqual(nextView.map((row) => row.id).reverse());

      // The cursor still pages inside the period.
      const afterFirst = await queryDurableAgentEvents({ agentId, ownerUserId: NEXT }, nextView[0]!.id, 100);
      expect(afterFirst.map((row) => row.eventType)).toEqual(['agent.chat.turn']);

      // Stale proof: a caller that proved PRIOR before the move gets NOTHING,
      // because the owner re-check runs in the same statement as the scope.
      expect(await queryDurableAgentEvents({ agentId, ownerUserId: PRIOR }, 0n, 100)).toEqual([]);
      expect(await queryDurableAgentEventsNewest({ agentId, ownerUserId: PRIOR }, 0n, 20)).toEqual([]);

      // Owner -> NULL: no owner proof can match an unowned row.
      await pause();
      await db.update(agentBots).set({ userId: null }).where(eq(agentBots.agentId, agentId));
      expect(await queryDurableAgentEvents({ agentId, ownerUserId: NEXT }, 0n, 100)).toEqual([]);
      await pause();

      // NULL -> PRIOR again: a returning owner starts a NEW period; neither its
      // own old rows nor NEXT's period come back.
      await db.update(agentBots).set({ userId: PRIOR }).where(eq(agentBots.agentId, agentId));
      expect(await queryDurableAgentEvents({ agentId, ownerUserId: PRIOR }, 0n, 100)).toEqual([]);
    });
  });

  describe('owned event insert: the owner is resolved inside the INSERT under FOR SHARE (Codex round 4)', () => {
    const poolMax = Number(process.env.DB_POOL_MAX) > 0 ? Number(process.env.DB_POOL_MAX) : 10;
    // holder/changer transaction + the other statement + the pg_stat_activity poll.
    const testIfPool = poolMax >= 3 ? test : test.skip;

    /** The real fire-and-forget writer, awaited (it resolves after the INSERT). */
    function owned(agentId: string, claimedOwnerUserId: string | null, actedAt: string, tag: string): Promise<void> {
      return mod.logger.logOwnedAgentEvent({ eventType: 'agent.chat.turn', agentId, claimedOwnerUserId, actedAt, payload: { tag } });
    }

    /** tag -> user_id of every event row of the agent, in insert order. */
    async function ownersByTag(agentId: string): Promise<Array<[unknown, string | null]>> {
      const { db, events, eq } = mod.database;
      const rows = await db
        .select({ payload: events.payload, userId: events.userId })
        .from(events)
        .where(eq(events.agentId, agentId))
        .orderBy(events.id);
      return rows.map((row) => [(row.payload as { tag?: string } | null)?.tag ?? null, row.userId]);
    }

    /** True once another backend of this database waits on a lock running `fragment`. */
    async function waitUntilLockWait(fragment: string): Promise<boolean> {
      const { db, sql } = mod.database;
      for (let i = 0; i < 250; i++) {
        const rows = (await db.execute(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query LIKE ${`%${fragment}%`}
        `)) as unknown as Array<{ n: number }>;
        if (Number(rows[0]?.n ?? 0) > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    }

    /** A promise plus its resolver. */
    function signal(): { promise: Promise<void>; fire: () => void } {
      let fire!: () => void;
      const promise = new Promise<void>((resolve) => { fire = resolve; });
      return { promise, fire };
    }

    test('sequential: the claim is recorded only while it owns the row and has owned it since actedAt', async () => {
      const { db, agentBots, eq } = mod.database;
      const agentId = newAgentId('owned-seq');
      await insertRow(agentId, PRIOR);
      await pause();
      const t1 = new Date().toISOString();
      await owned(agentId, PRIOR, t1, 'match');
      await owned(agentId, null, t1, 'no-claim');
      await owned(agentId, NEXT, t1, 'not-owner');
      await owned(agentId, PRIOR, '2001-01-01T00:00:00.000Z', 'acted-before-period');
      // PRIOR -> NEXT committed before the insert: a late PRIOR claim is NULL.
      await pause();
      await db.update(agentBots).set({ userId: NEXT }).where(eq(agentBots.agentId, agentId));
      await pause();
      await owned(agentId, PRIOR, t1, 'late-prior');
      // NEXT -> PRIOR: a complete A -> B -> A round trip after t1. The row
      // names PRIOR again, but owner_since is after t1, so still NULL; an
      // action that began in the new period is recorded.
      await db.update(agentBots).set({ userId: PRIOR }).where(eq(agentBots.agentId, agentId));
      await pause();
      await owned(agentId, PRIOR, t1, 'round-trip');
      const t2 = new Date().toISOString();
      await owned(agentId, PRIOR, t2, 'new-period');

      expect(await ownersByTag(agentId)).toEqual([
        ['match', PRIOR],
        ['no-claim', null],
        ['not-owner', null],
        ['acted-before-period', null],
        ['late-prior', null],
        ['round-trip', null],
        ['new-period', PRIOR],
      ]);
      // History in PRIOR's new period: only the row of an action that began in it.
      const view = await mod.query.queryDurableAgentEvents({ agentId, ownerUserId: PRIOR }, 0n, 100);
      expect(view.map((row) => row.payload)).toEqual([{ tag: 'new-period' }]);
    }, 30_000);

    testIfPool('a concurrent owner change WAITS for the owned insert to commit; its owner_since follows the event ts', async () => {
      const { db, sql, events, agentBots, eq } = mod.database;
      const agentId = newAgentId('owned-hold');
      await insertRow(agentId, PRIOR);
      await pause();
      const actedAt = new Date().toISOString();
      const inserted = signal();
      const release = signal();
      // The owned INSERT (same user_id expression as logOwnedAgentEvent), held
      // open so its FOR SHARE row lock is held.
      const holder = db.transaction(async (tx) => {
        await tx.insert(events).values({
          eventType: 'agent.chat.turn',
          agentId,
          userId: mod.logger.ownedEventUserIdSql(agentId, { claimedOwnerUserId: PRIOR, actedAt }),
          payload: { tag: 'held' },
        });
        inserted.fire();
        await release.promise;
      });
      await inserted.promise;
      let moved = false;
      const mover = db.update(agentBots).set({ userId: NEXT }).where(eq(agentBots.agentId, agentId))
        .then(() => { moved = true; });
      try {
        expect(await waitUntilLockWait('update "openclaw_bots"')).toBe(true);
        expect(moved).toBe(false);
      } finally {
        release.fire();
      }
      await holder;
      await mover;
      expect(moved).toBe(true);

      const rows = await db
        .select({ userId: events.userId, beforePeriod: sql<boolean>`${events.ts} < ${agentBots.ownerSince}` })
        .from(events)
        .innerJoin(agentBots, eq(agentBots.agentId, events.agentId))
        .where(eq(events.agentId, agentId));
      expect(rows).toEqual([{ userId: PRIOR, beforePeriod: true }]);
      expect((await readStamp(agentId)).userId).toBe(NEXT);
      // NEXT never sees it; PRIOR no longer owns the row.
      expect(await mod.query.queryDurableAgentEvents({ agentId, ownerUserId: NEXT }, 0n, 100)).toEqual([]);
      expect(await mod.query.queryDurableAgentEvents({ agentId, ownerUserId: PRIOR }, 0n, 100)).toEqual([]);
    }, 30_000);

    for (const outcome of ['commit', 'rollback'] as const) {
      testIfPool(`an owner change in flight makes the owned insert WAIT, then ${outcome === 'commit' ? 'NULL' : 'the owner'} (${outcome})`, async () => {
        const { db, agentBots, eq } = mod.database;
        const agentId = newAgentId(`owned-inflight-${outcome}`);
        await insertRow(agentId, PRIOR);
        await pause();
        const actedAt = new Date().toISOString();
        const updated = signal();
        const release = signal();
        const changer = db.transaction(async (tx) => {
          await tx.update(agentBots).set({ userId: NEXT }).where(eq(agentBots.agentId, agentId));
          updated.fire();
          await release.promise;
          if (outcome === 'rollback') throw new Error('roll back the owner change');
        }).catch((err: unknown) => {
          if (outcome !== 'rollback') throw err;
        });
        await updated.promise;
        let logged = false;
        const logging = owned(agentId, PRIOR, actedAt, 'in-flight').then(() => { logged = true; });
        try {
          expect(await waitUntilLockWait('FOR SHARE')).toBe(true);
          expect(logged).toBe(false);
        } finally {
          release.fire();
        }
        await changer;
        await logging;
        expect(await ownersByTag(agentId)).toEqual([['in-flight', outcome === 'commit' ? null : PRIOR]]);
        expect((await readStamp(agentId)).userId).toBe(outcome === 'commit' ? NEXT : PRIOR);
      }, 30_000);
    }
  });
});
