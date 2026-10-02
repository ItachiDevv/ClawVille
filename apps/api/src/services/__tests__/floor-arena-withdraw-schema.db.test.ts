import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FLOOR_ARENA_EVENT_TYPES,
  FLOOR_ARENA_TEMPLATES,
  FLOOR_ARENA_WITHDRAW_ADDRESS_PROOFS,
  FLOOR_ARENA_WITHDRAW_AMOUNT_MODES,
  FLOOR_ARENA_WITHDRAW_ASSETS,
  FLOOR_ARENA_WITHDRAW_OPEN_STATES,
  FLOOR_ARENA_WITHDRAW_REVOKE_REASONS,
  FLOOR_ARENA_WITHDRAW_STATES,
  FLOOR_ARENA_WITHDRAW_SUBJECT_KINDS,
} from '@clawville/shared';

/**
 * Real-PostgreSQL checks for migration 0074 (P5 arena wallet withdraw, D34).
 * Contract: ops/house-traders/arena-review/P5_CONTRACT_2026-10-02.md §2 + §10 T1.
 * The SQL is read from the migration file, so an edit to 0074 is tested as
 * written. The file runs twice with no error (idempotent), every CHECK value
 * set equals its `@clawville/shared` array, the guard trigger refuses every
 * way back (I1/I2), and the partial unique indexes refuse duplicates (I6).
 *
 * The file runs DDL and writes rows, so it needs DATABASE_URL on a LOCAL host
 * AND an opt-in: CI === 'true' (the gates.yml Postgres service) or
 * ARENA_DB_TEST=1. A local postgres:// server also gives the two connections
 * that the concurrent one-open case needs. Rows use fresh ids; deleting the
 * test users removes them (ON DELETE CASCADE through floor_arena_agents).
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const optedIn = process.env.CI === 'true' || process.env.ARENA_DB_TEST === '1';
const localDatabase = /^postgres(ql)?:\/\/[^/]*@(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(databaseUrl);
const describeIfDb = optedIn && localDatabase ? describe : describe.skip;

const MIGRATION_PATH = resolve(
  import.meta.dir,
  '../../../../../packages/database/migrations/0074_floor_arena_withdraw.sql',
);

const WITHDRAW_TABLES = ['floor_arena_withdraw_addresses', 'floor_arena_withdraw_challenges', 'floor_arena_withdrawals'] as const;

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** A string in the base58 address shape (the database checks the shape only). */
function fakeBase58(length: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => BASE58[byte % 58]).join('');
}

type PgFailure = { code: string | undefined; constraint: string | undefined; message: string };
type PgErrorLike = { code?: string; constraint_name?: string; message?: string; cause?: PgErrorLike };

/** Runs a statement that must fail and returns the Postgres error fields. */
async function failure(run: () => Promise<unknown>): Promise<PgFailure> {
  try {
    await run();
  } catch (error) {
    const raw = error as PgErrorLike;
    const source = raw.code ? raw : (raw.cause ?? raw);
    return { code: source.code, constraint: source.constraint_name, message: String(source.message ?? '') };
  }
  throw new Error('expected the statement to fail');
}

/** The quoted values inside the first ARRAY[...] of a Postgres definition (how `col IN (...)` prints). */
function arrayValues(definition: string): string[] {
  const array = /ARRAY\[([^\]]*)\]/.exec(definition);
  if (!array) throw new Error(`no ARRAY in: ${definition}`);
  return [...array[1]!.matchAll(/'([^']*)'::text/g)].map((match) => match[1]!);
}

/** The values compared with `column = '<value>'` in a definition. */
function equalityValues(definition: string, column: string): string[] {
  return [...definition.matchAll(new RegExp(`\\b${column} = '([^']*)'::text`, 'g'))].map((match) => match[1]!);
}

describeIfDb('migration 0074 floor arena withdraw on PostgreSQL', () => {
  let database: typeof import('@clawville/database');
  const ids = {
    user1: randomUUID(),
    user2: randomUUID(),
    agent1: randomUUID(),
    agent2: randomUUID(),
    cp1: randomUUID(),
    cp2: randomUUID(),
  };
  const wallet1 = fakeBase58(44);
  const wallet2 = fakeBase58(44);
  const destination1 = fakeBase58(44);
  const destination2 = fakeBase58(44);
  let address1 = '';
  let address2 = '';

  async function runMigration(): Promise<void> {
    const { db, sql } = database;
    await db.execute(sql.raw(readFileSync(MIGRATION_PATH, 'utf8')));
  }

  async function insertWithdrawal(input: {
    agentId: string;
    ownerUserId: string;
    addressId: string;
    sourceClawpumpAgentId: string;
    sourceWallet: string;
    destination: string;
    idempotencyKey?: string;
    asset?: string;
  }): Promise<string> {
    const { db, sql } = database;
    const rows = await db.execute<{ id: string }>(sql`
      INSERT INTO floor_arena_withdrawals
        (agent_id, owner_user_id, subject_kind, idempotency_key, asset, amount_mode, requested_atomic,
         source_clawpump_agent_id, source_wallet, destination, address_id)
      VALUES (${input.agentId}, ${input.ownerUserId}::uuid, 'human', ${input.idempotencyKey ?? `idem-${randomUUID()}`},
        ${input.asset ?? 'USDC'}, 'exact', 100000, ${input.sourceClawpumpAgentId}, ${input.sourceWallet},
        ${input.destination}, ${input.addressId}::uuid)
      RETURNING id
    `);
    return Array.from(rows)[0]!.id;
  }

  function withdrawal1(extra: { idempotencyKey?: string; asset?: string } = {}): Promise<string> {
    return insertWithdrawal({
      agentId: ids.agent1,
      ownerUserId: ids.user1,
      addressId: address1,
      sourceClawpumpAgentId: ids.cp1,
      sourceWallet: wallet1,
      destination: destination1,
      ...extra,
    });
  }

  function withdrawal2(extra: { idempotencyKey?: string; asset?: string } = {}): Promise<string> {
    return insertWithdrawal({
      agentId: ids.agent2,
      ownerUserId: ids.user2,
      addressId: address2,
      sourceClawpumpAgentId: ids.cp2,
      sourceWallet: wallet2,
      destination: destination2,
      ...extra,
    });
  }

  async function stateOf(id: string): Promise<Record<string, unknown>> {
    const { db, sql } = database;
    const rows = await db.execute<Record<string, unknown>>(sql`
      SELECT state, destination, amount_atomic::text AS amount_atomic, tx_signature, dispatched_at
      FROM floor_arena_withdrawals WHERE id = ${id}::uuid
    `);
    return Array.from(rows)[0]!;
  }

  beforeAll(async () => {
    database = await import('@clawville/database');
    const { db, sql } = database;
    await runMigration();
    const params = JSON.stringify(FLOOR_ARENA_TEMPLATES[0]!.params);
    for (const key of ['user1', 'user2'] as const) {
      await db.execute(sql`
        INSERT INTO users (id, email, password_hash, name)
        VALUES (${ids[key]}::uuid, ${`arena-withdraw-${ids[key]}@clawville-test.invalid`}, ${`disabled-${ids[key]}`}, 'Arena Withdraw DB Test')
      `);
    }
    await db.execute(sql`
      INSERT INTO floor_arena_agents (id, kind, owner_user_id, name, template_id, params, provision_state, clawpump_agent_id, clawpump_wallet)
      VALUES
        (${ids.agent1}, 'user', ${ids.user1}::uuid, 'Withdraw One', 'genesis', ${params}::jsonb, 'ready', ${ids.cp1}, ${wallet1}),
        (${ids.agent2}, 'user', ${ids.user2}::uuid, 'Withdraw Two', 'genesis', ${params}::jsonb, 'ready', ${ids.cp2}, ${wallet2})
    `);
    const addresses = await db.execute<{ id: string; agent_id: string }>(sql`
      INSERT INTO floor_arena_withdraw_addresses (agent_id, owner_user_id, address, proof_kind, set_by, active_at)
      VALUES
        (${ids.agent1}, ${ids.user1}::uuid, ${destination1}, 'linked_wallet', 'human', now()),
        (${ids.agent2}, ${ids.user2}::uuid, ${destination2}, 'linked_wallet', 'human', now())
      RETURNING id, agent_id
    `);
    for (const row of Array.from(addresses)) {
      if (row.agent_id === ids.agent1) address1 = row.id;
      else address2 = row.id;
    }
  }, 60_000);

  afterAll(async () => {
    if (!database) return;
    const { db, sql } = database;
    for (const key of ['user1', 'user2'] as const) {
      await db.execute(sql`DELETE FROM users WHERE id = ${ids[key]}::uuid`);
    }
    const left = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM floor_arena_withdrawals WHERE agent_id IN (${ids.agent1}, ${ids.agent2})
    `);
    expect(Array.from(left)[0]!.n).toBe(0);
  });

  test('the migration applies a second time with no error and keeps every object', async () => {
    const { db, sql } = database;
    await runMigration();
    for (const table of WITHDRAW_TABLES) {
      const rows = await db.execute<{ found: string | null }>(sql`SELECT to_regclass(${`public.${table}`})::text AS found`);
      expect(Array.from(rows)[0]!.found).toBe(table);
    }
    const triggers = await db.execute<{ tgname: string }>(sql`
      SELECT tgname FROM pg_trigger WHERE tgrelid = 'floor_arena_withdrawals'::regclass AND NOT tgisinternal
    `);
    expect(Array.from(triggers).map((row) => row.tgname)).toEqual(['floor_arena_withdrawals_guard']);
    const indexes = await db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename IN ('floor_arena_withdraw_addresses', 'floor_arena_withdraw_challenges', 'floor_arena_withdrawals')
    `);
    const indexNames = Array.from(indexes).map((row) => row.indexname);
    for (const name of [
      'floor_arena_withdraw_addresses_one_current_uq',
      'floor_arena_withdraw_addresses_nonce_uq',
      'floor_arena_withdraw_addresses_agent_created_idx',
      'floor_arena_withdraw_challenges_agent_idx',
      'floor_arena_withdraw_challenges_expires_idx',
      'floor_arena_withdrawals_agent_idem_uq',
      'floor_arena_withdrawals_one_open_uq',
      'floor_arena_withdrawals_tx_uq',
      'floor_arena_withdrawals_state_idx',
      'floor_arena_withdrawals_agent_requested_idx',
      'floor_arena_withdrawals_dispatched_idx',
    ]) {
      expect(indexNames).toContain(name);
    }
    // One events CHECK only: the second run neither drops it again nor adds a twin.
    const events = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = 'floor_arena_events'::regclass AND contype = 'c' AND conname = 'floor_arena_events_type_valid'
    `);
    expect(Array.from(events)[0]!.n).toBe(1);
  });

  test('every CHECK value set equals its shared array, and every CHECK is validated', async () => {
    const { db, sql } = database;
    const rows = await db.execute<{ conname: string; def: string; validated: boolean }>(sql`
      SELECT c.conname, pg_get_constraintdef(c.oid, true) AS def, c.convalidated AS validated
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE c.contype = 'c' AND t.relname IN ('floor_arena_withdraw_addresses', 'floor_arena_withdraw_challenges', 'floor_arena_withdrawals', 'floor_arena_events')
    `);
    const defs = new Map(Array.from(rows).map((row) => [row.conname, row.def]));
    for (const row of Array.from(rows)) expect(row.validated).toBe(true);
    const def = (name: string): string => {
      const found = defs.get(name);
      if (!found) throw new Error(`missing CHECK ${name}`);
      return found;
    };
    expect(equalityValues(def('floor_arena_withdraw_addresses_proof_valid'), 'proof_kind')).toEqual([...FLOOR_ARENA_WITHDRAW_ADDRESS_PROOFS]);
    expect(arrayValues(def('floor_arena_withdraw_addresses_set_by_valid'))).toEqual([...FLOOR_ARENA_WITHDRAW_SUBJECT_KINDS]);
    expect(arrayValues(def('floor_arena_withdraw_addresses_revoke_valid'))).toEqual([...FLOOR_ARENA_WITHDRAW_REVOKE_REASONS]);
    expect(arrayValues(def('floor_arena_withdrawals_subject_valid'))).toEqual([...FLOOR_ARENA_WITHDRAW_SUBJECT_KINDS]);
    expect(arrayValues(def('floor_arena_withdrawals_asset_valid'))).toEqual([...FLOOR_ARENA_WITHDRAW_ASSETS]);
    expect(equalityValues(def('floor_arena_withdrawals_amount_valid'), 'amount_mode')).toEqual([...FLOOR_ARENA_WITHDRAW_AMOUNT_MODES]);
    expect(arrayValues(def('floor_arena_withdrawals_state_valid'))).toEqual([...FLOOR_ARENA_WITHDRAW_STATES]);
    expect(arrayValues(def('floor_arena_events_type_valid'))).toEqual([...FLOOR_ARENA_EVENT_TYPES]);
    for (const name of [
      'floor_arena_withdraw_addresses_shape',
      'floor_arena_withdraw_challenges_expiry',
      'floor_arena_withdrawals_dispatch_stamp',
      'floor_arena_withdrawals_sent_signature',
      'floor_arena_withdrawals_codes_shape',
    ]) {
      expect(def(name).length).toBeGreaterThan(0);
    }

    const openIndex = await db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'floor_arena_withdrawals_one_open_uq'
    `);
    const openDef = Array.from(openIndex)[0]!.indexdef;
    expect(openDef).toStartWith('CREATE UNIQUE INDEX');
    expect(arrayValues(openDef)).toEqual([...FLOOR_ARENA_WITHDRAW_OPEN_STATES]);

    // The CHECKs are enforced, not only declared. The bogus-state row carries the dispatch stamp,
    // so floor_arena_withdrawals_dispatch_stamp passes and state_valid is the one that refuses.
    const bogusState = await failure(() => db.execute(sql`
      INSERT INTO floor_arena_withdrawals
        (agent_id, owner_user_id, subject_kind, idempotency_key, asset, amount_mode, requested_atomic, amount_atomic,
         source_clawpump_agent_id, source_wallet, destination, address_id, state, dispatched_at)
      VALUES (${ids.agent1}, ${ids.user1}::uuid, 'human', ${`idem-${randomUUID()}`}, 'USDC', 'exact', 100000, 100000,
        ${ids.cp1}, ${wallet1}, ${destination1}, ${address1}::uuid, 'bogus', now())
    `));
    expect(bogusState.constraint).toBe('floor_arena_withdrawals_state_valid');
    expect((await failure(() => withdrawal1({ asset: 'BTC' }))).constraint).toBe('floor_arena_withdrawals_asset_valid');
    expect((await failure(() => withdrawal1({ idempotencyKey: 'short' }))).constraint).toBe('floor_arena_withdrawals_codes_shape');
    const badAddress = await failure(() => db.execute(sql`
      INSERT INTO floor_arena_withdraw_addresses (agent_id, owner_user_id, address, proof_kind, set_by, active_at, revoked_at, revoke_reason)
      VALUES (${ids.agent1}, ${ids.user1}::uuid, ${destination1}, 'signed', 'human', now(), now(), 'admin')
    `));
    expect(badAddress.constraint).toBe('floor_arena_withdraw_addresses_proof_valid');
    const badChallenge = await failure(() => db.execute(sql`
      INSERT INTO floor_arena_withdraw_challenges (nonce, agent_id, owner_user_id, address, message, expires_at)
      VALUES (${`nonce-${randomUUID()}`}, ${ids.agent1}, ${ids.user1}::uuid, ${destination1}, 'm', now())
    `));
    expect(badChallenge.constraint).toBe('floor_arena_withdraw_challenges_expiry');
  });

  test('the guard trigger refuses every way back and every money-field change', async () => {
    const { db, sql } = database;
    const id = await withdrawal1();
    const signature = fakeBase58(88);
    const update = (patch: ReturnType<typeof sql>) =>
      db.execute(sql`UPDATE floor_arena_withdrawals SET ${patch} WHERE id = ${id}::uuid`);
    const refused = async (patch: ReturnType<typeof sql>, message: RegExp): Promise<void> => {
      const before = await stateOf(id);
      const error = await failure(() => update(patch));
      expect(error.code).toBe('23514');
      expect(error.message).toMatch(message);
      expect(await stateOf(id)).toEqual(before);
    };
    const notAllowed = /floor_arena_withdrawals: state \w+ -> \w+ is not allowed/;
    const immutable = /floor_arena_withdrawals: immutable field changed/;

    // requested -> dispatching is the CAS door (amount and dispatch stamp in the same write).
    await update(sql`state = 'dispatching', amount_atomic = 100000, dispatched_at = now()`);
    await refused(sql`state = 'requested'`, notAllowed);
    await refused(sql`amount_atomic = 200000`, immutable);
    await refused(sql`destination = ${destination2}`, immutable);
    await refused(sql`dispatched_at = now() + interval '1 minute'`, immutable);

    await update(sql`state = 'unknown', error_code = 'dispatch_interrupted'`);
    await refused(sql`state = 'requested'`, notAllowed);
    await refused(sql`state = 'dispatching'`, notAllowed);

    // attachSignature: an unknown row with no signature may get one, once.
    await update(sql`tx_signature = ${signature}`);
    await refused(sql`tx_signature = ${fakeBase58(88)}`, immutable);
    await refused(sql`tx_signature = NULL`, immutable);

    await update(sql`state = 'confirmed', error_code = NULL, finalized_at = now()`);
    await refused(sql`state = 'failed'`, notAllowed);
    await refused(sql`state = 'requested'`, notAllowed);
    expect((await stateOf(id)).state).toBe('confirmed');
  });

  test('the forward path requested -> dispatching -> sent -> confirmed is allowed', async () => {
    const { db, sql } = database;
    const id = await withdrawal2({ asset: 'SOL' });
    const signature = fakeBase58(88);
    await db.execute(sql`UPDATE floor_arena_withdrawals SET state = 'dispatching', amount_atomic = 100000, dispatched_at = now() WHERE id = ${id}::uuid`);
    // sent needs a signature (floor_arena_withdrawals_sent_signature).
    const unsigned = await failure(() => db.execute(sql`UPDATE floor_arena_withdrawals SET state = 'sent' WHERE id = ${id}::uuid`));
    expect(unsigned.constraint).toBe('floor_arena_withdrawals_sent_signature');
    await db.execute(sql`UPDATE floor_arena_withdrawals SET state = 'sent', tx_signature = ${signature}, sent_at = now() WHERE id = ${id}::uuid`);
    await db.execute(sql`UPDATE floor_arena_withdrawals SET state = 'confirmed', finalized_at = now(), last_checked_at = now(), check_count = check_count + 1 WHERE id = ${id}::uuid`);
    expect(await stateOf(id)).toMatchObject({ state: 'confirmed', tx_signature: signature, amount_atomic: '100000' });
    // A dispatching row without the dispatch stamp is refused (floor_arena_withdrawals_dispatch_stamp).
    const unstamped = await withdrawal2();
    const noStamp = await failure(() => db.execute(sql`UPDATE floor_arena_withdrawals SET state = 'dispatching' WHERE id = ${unstamped}::uuid`));
    expect(noStamp.constraint).toBe('floor_arena_withdrawals_dispatch_stamp');
    await db.execute(sql`UPDATE floor_arena_withdrawals SET state = 'cancelled', finalized_at = now() WHERE id = ${unstamped}::uuid`);
  });

  test('the one-open, idempotency and tx_signature unique indexes refuse duplicates', async () => {
    const { db, sql } = database;
    const key = `idem-${randomUUID()}`;
    const open = await withdrawal2({ idempotencyKey: key });
    // One open row per agent.
    expect((await failure(() => withdrawal2())).constraint).toBe('floor_arena_withdrawals_one_open_uq');
    await db.execute(sql`UPDATE floor_arena_withdrawals SET state = 'cancelled', finalized_at = now() WHERE id = ${open}::uuid`);
    // The same key stays taken after the row closes.
    expect((await failure(() => withdrawal2({ idempotencyKey: key }))).constraint).toBe('floor_arena_withdrawals_agent_idem_uq');
    // The same key on ANOTHER agent is a different request.
    const otherAgent = await withdrawal1({ idempotencyKey: key });
    await db.execute(sql`UPDATE floor_arena_withdrawals SET state = 'cancelled', finalized_at = now() WHERE id = ${otherAgent}::uuid`);

    // One signature belongs to one row, across agents.
    const signature = fakeBase58(88);
    const first = await withdrawal1();
    await db.execute(sql`UPDATE floor_arena_withdrawals SET state = 'dispatching', amount_atomic = 100000, dispatched_at = now() WHERE id = ${first}::uuid`);
    await db.execute(sql`UPDATE floor_arena_withdrawals SET state = 'sent', tx_signature = ${signature}, sent_at = now() WHERE id = ${first}::uuid`);
    const second = await withdrawal2();
    await db.execute(sql`UPDATE floor_arena_withdrawals SET state = 'dispatching', amount_atomic = 100000, dispatched_at = now() WHERE id = ${second}::uuid`);
    const reused = await failure(() => db.execute(sql`UPDATE floor_arena_withdrawals SET state = 'sent', tx_signature = ${signature} WHERE id = ${second}::uuid`));
    expect(reused.code).toBe('23505');
    expect(reused.constraint).toBe('floor_arena_withdrawals_tx_uq');
    await db.execute(sql`UPDATE floor_arena_withdrawals SET state = 'needs_review', error_code = 'tx_reused', finalized_at = now() WHERE id = ${second}::uuid`);
    await db.execute(sql`UPDATE floor_arena_withdrawals SET state = 'confirmed', finalized_at = now() WHERE id = ${first}::uuid`);
  });

  test('two concurrent requests on two connections leave exactly one open row', async () => {
    const results = await Promise.allSettled([withdrawal2(), withdrawal2()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined;
    const reason = (rejected?.reason ?? {}) as PgErrorLike;
    expect((reason.constraint_name ?? reason.cause?.constraint_name)).toBe('floor_arena_withdrawals_one_open_uq');
    const { db, sql } = database;
    await db.execute(sql`
      UPDATE floor_arena_withdrawals SET state = 'cancelled', finalized_at = now()
      WHERE agent_id = ${ids.agent2} AND state = 'requested'
    `);
  });

  test('one current address per agent and one use per challenge nonce', async () => {
    const { db, sql } = database;
    const secondCurrent = await failure(() => db.execute(sql`
      INSERT INTO floor_arena_withdraw_addresses (agent_id, owner_user_id, address, proof_kind, set_by, active_at)
      VALUES (${ids.agent1}, ${ids.user1}::uuid, ${fakeBase58(44)}, 'linked_wallet', 'human', now())
    `));
    expect(secondCurrent.constraint).toBe('floor_arena_withdraw_addresses_one_current_uq');
    // A revoked address and a signed one may share the agent; a nonce proves one address only.
    const nonce = `nonce-${randomUUID()}`;
    await db.execute(sql`
      INSERT INTO floor_arena_withdraw_addresses
        (agent_id, owner_user_id, address, proof_kind, message, signature, challenge_nonce, set_by, set_by_agent_id, active_at, revoked_at, revoke_reason)
      VALUES (${ids.agent1}, ${ids.user1}::uuid, ${fakeBase58(44)}, 'signed', 'm', ${fakeBase58(88)}, ${nonce}, 'agent', ${'agent-session'}, now(), now(), 'owner')
    `);
    const reusedNonce = await failure(() => db.execute(sql`
      INSERT INTO floor_arena_withdraw_addresses
        (agent_id, owner_user_id, address, proof_kind, message, signature, challenge_nonce, set_by, active_at, revoked_at, revoke_reason)
      VALUES (${ids.agent2}, ${ids.user2}::uuid, ${fakeBase58(44)}, 'signed', 'm', ${fakeBase58(88)}, ${nonce}, 'human', now(), now(), 'replaced')
    `));
    expect(reusedNonce.constraint).toBe('floor_arena_withdraw_addresses_nonce_uq');
  });

  test("the events CHECK accepts 'withdraw' and still refuses an unknown type", async () => {
    const { db, sql } = database;
    await db.execute(sql`
      INSERT INTO floor_arena_events (agent_id, type, summary, data)
      VALUES (${ids.agent1}, 'withdraw', 'Withdrawal requested.', '{"asset":"USDC"}'::jsonb)
    `);
    const bogus = await failure(() => db.execute(sql`
      INSERT INTO floor_arena_events (agent_id, type, summary) VALUES (${ids.agent1}, 'bogus', 'x')
    `));
    expect(bogus.constraint).toBe('floor_arena_events_type_valid');
  });
});
