import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FLOOR_ARENA_TEMPLATES, buildFloorArenaWithdrawAddressMessage } from '@clawville/shared';
import type { ClawPumpArenaWalletLive } from '../clawpump-writer';

/**
 * Real-PostgreSQL checks for the P5 withdraw queries (contract
 * ops/house-traders/arena-review/P5_CONTRACT_2026-10-02.md §5 + §10 T3): the
 * request steps, the admission checks and the compare-and-set that is the only
 * door to the transfer, the add-on conservation rule, challenges, addresses and
 * the finalize CAS. REAL MONEY rules, so every case runs on real SQL.
 *
 * Same opt-in as floor-arena-queries.db.test.ts: DATABASE_URL AND (CI === 'true'
 * OR ARENA_DB_TEST=1). The two-connection cases need a postgres:// server.
 * Every row hangs off fresh test users; deleting them removes everything
 * (users -> floor_arena_agents -> withdrawals, addresses, challenges, events,
 * add-on calls, all ON DELETE CASCADE).
 */
const optedIn = process.env.CI === 'true' || process.env.ARENA_DB_TEST === '1';
const describeIfDb = process.env.DATABASE_URL && optedIn ? describe : describe.skip;
const testIfServerDb = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? '') ? test : test.skip;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ADDON_ID = 'nansen-token-screener-sol';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function fakeBase58(length = 44): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => BASE58[byte % 58]).join('');
}

function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

const at = (base: Date, ms: number): Date => new Date(base.getTime() + ms);
/**
 * Request times sit 3 UTC days back at 01:00, so the agent-day sums (requested_at
 * day) of these rows never touch TODAY's account-wide cap (dispatched_at day).
 */
const BASE = at(utcDay(new Date()), -3 * DAY + HOUR);

describeIfDb('floor arena withdraw queries on Postgres (P5 T3)', () => {
  let database: typeof import('@clawville/database');
  let q: typeof import('../floor-arena/queries');
  const userIds: string[] = [];
  const params = JSON.stringify(FLOOR_ARENA_TEMPLATES[0]!.params);
  const addons = JSON.stringify([{ id: ADDON_ID, enabled: true, dailyCapUsd: 2 }]);

  interface TestAgent { userId: string; agentId: string; cpId: string; wallet: string }

  async function makeAgent(provision: 'ready' | 'pending' = 'ready'): Promise<TestAgent> {
    const { db, sql } = database;
    const agent = { userId: randomUUID(), agentId: randomUUID(), cpId: randomUUID(), wallet: fakeBase58() };
    userIds.push(agent.userId);
    await db.execute(sql`
      INSERT INTO users (id, email, password_hash, name)
      VALUES (${agent.userId}::uuid, ${`arena-wq-${agent.userId}@clawville-test.invalid`}, ${`disabled-${agent.userId}`}, 'Arena Withdraw Q')
    `);
    await db.execute(sql`
      INSERT INTO floor_arena_agents (id, kind, owner_user_id, name, template_id, params, provision_state, clawpump_agent_id,
        clawpump_wallet, addons, seated)
      VALUES (${agent.agentId}, 'user', ${agent.userId}::uuid, 'Withdraw Q', 'genesis', ${params}::jsonb, ${provision},
        ${agent.cpId}, ${agent.wallet}, ${addons}::jsonb, true)
    `);
    return agent;
  }

  /** An address that has been active since a day before BASE (created two days before). */
  async function addActiveAddress(agent: TestAgent, activeAt: Date = at(BASE, -DAY)): Promise<{ id: string; address: string }> {
    const { db, sql } = database;
    const address = fakeBase58();
    const created = new Date(Math.min(activeAt.getTime(), BASE.getTime()) - DAY);
    const list = q.rowsOf<{ id: string }>(await db.execute(sql`
      INSERT INTO floor_arena_withdraw_addresses (agent_id, owner_user_id, address, proof_kind, set_by, created_at, active_at)
      VALUES (${agent.agentId}, ${agent.userId}::uuid, ${address}, 'linked_wallet', 'human',
        ${created.toISOString()}::timestamptz, ${activeAt.toISOString()}::timestamptz)
      RETURNING id
    `));
    return { id: list[0]!.id, address };
  }

  type RequestInput = Parameters<typeof q.requestArenaWithdrawal>[0];
  function request(agent: TestAgent, over: Partial<RequestInput> = {}) {
    return q.requestArenaWithdrawal({
      agentId: agent.agentId, ownerUserId: agent.userId, subjectKind: 'human', subjectAgentId: null,
      idempotencyKey: `key-${randomUUID()}`, asset: 'USDC', amountMode: 'exact', requestedAtomic: 1_000_000n, now: BASE, ...over,
    });
  }

  async function created(agent: TestAgent, over: Partial<RequestInput> = {}): Promise<string> {
    const result = await request(agent, over);
    if (result.kind !== 'created') throw new Error(`expected created, got ${JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}`);
    return result.withdrawal.id;
  }

  /** Moves a requested row to the COUNTED final state needs_review (dispatched on the row's request day, not today). */
  async function closeCounted(id: string, amount: bigint | null = null): Promise<void> {
    const { db, sql } = database;
    await db.execute(sql`
      UPDATE floor_arena_withdrawals
      SET state = 'dispatching', amount_atomic = COALESCE(${amount === null ? null : amount.toString()}::bigint, requested_atomic, 1000000),
          dispatched_at = requested_at + interval '1 minute'
      WHERE id = ${id}::uuid AND state = 'requested'
    `);
    await db.execute(sql`UPDATE floor_arena_withdrawals SET state = 'needs_review', finalized_at = now() WHERE id = ${id}::uuid`);
  }

  function live(agent: TestAgent, over: Partial<ClawPumpArenaWalletLive> = {}): ClawPumpArenaWalletLive {
    return { address: agent.wallet, solLamports: 10_000_000n, usdcAtomic: 10_000_000n, readAt: new Date(), transactions: [], ...over };
  }

  type AdmitInput = Parameters<typeof q.admitArenaWithdrawal>[0];
  function admit(withdrawalId: string, wallet: ClawPumpArenaWalletLive, over: Partial<AdmitInput> = {}) {
    return q.admitArenaWithdrawal({
      withdrawalId, live: wallet, destinationHasUsdcAccount: true, paused: () => false, now: new Date(), ...over,
    });
  }

  async function rowState(id: string): Promise<string> {
    const { db, sql } = database;
    return q.rowsOf<{ state: string }>(await db.execute(sql`SELECT state FROM floor_arena_withdrawals WHERE id = ${id}::uuid`))[0]!.state;
  }

  async function withdrawEvents(agentId: string): Promise<number> {
    const { db, sql } = database;
    return Number(q.rowsOf<{ n: number }>(await db.execute(sql`
      SELECT count(*)::int AS n FROM floor_arena_events WHERE agent_id = ${agentId} AND type = 'withdraw'
    `))[0]!.n);
  }

  function reserve(agent: TestAgent, walletUsdc: number) {
    const now = new Date();
    return q.reserveArenaAddonCall({
      agentId: agent.agentId, addonId: ADDON_ID, clawpumpAgentId: agent.cpId, at: now, priceUsd: 0.1,
      dayStart: utcDay(now), walletUsdc, check: () => ({ ok: true }),
    });
  }

  beforeAll(async () => {
    database = await import('@clawville/database');
    q = await import('../floor-arena/queries');
  });

  afterAll(async () => {
    if (!database) return;
    const { db, sql } = database;
    for (const id of userIds) await db.execute(sql`DELETE FROM users WHERE id = ${id}::uuid`);
  });

  // ── Request (§5 requestArenaWithdrawal, steps 1-8) ───────────────────────

  test('request: created copies the source and destination; same key + body = replay, other body = idempotency_conflict', async () => {
    const agent = await makeAgent();
    const address = await addActiveAddress(agent);
    const key = `key-${randomUUID()}`;
    const first = await request(agent, { idempotencyKey: key });
    expect(first.kind).toBe('created');
    const row = (first as { withdrawal: Awaited<ReturnType<typeof q.readArenaWithdrawals>>[number] }).withdrawal;
    expect(row).toMatchObject({
      agentId: agent.agentId, ownerUserId: agent.userId, subjectKind: 'human', subjectAgentId: null, idempotencyKey: key,
      asset: 'USDC', amountMode: 'exact', requestedAtomic: 1_000_000n, amountAtomic: null, state: 'requested',
      sourceClawpumpAgentId: agent.cpId, sourceWallet: agent.wallet, destination: address.address, addressId: address.id,
      errorCode: null, txSignature: null, dispatchedAt: null, finalizedAt: null, checkCount: 0,
    });
    expect(row.requestedAt.getTime()).toBe(BASE.getTime());
    const replay = await request(agent, { idempotencyKey: key, now: at(BASE, MIN) });
    expect(replay).toMatchObject({ kind: 'replay', withdrawal: { id: row.id } });
    expect(await request(agent, { idempotencyKey: key, requestedAtomic: 2_000_000n })).toEqual({
      kind: 'refused', code: 'idempotency_conflict', withdrawalId: row.id,
    });
    expect(await request(agent, { idempotencyKey: key, asset: 'SOL' })).toMatchObject({ code: 'idempotency_conflict' });
    expect(await request(agent, { idempotencyKey: key, amountMode: 'max', requestedAtomic: null })).toMatchObject({ code: 'idempotency_conflict' });
    // An agent-session request records its subject.
    const other = await makeAgent();
    await addActiveAddress(other);
    const byAgent = await request(other, { subjectKind: 'agent', subjectAgentId: 'agent-session-1' });
    expect(byAgent).toMatchObject({ kind: 'created', withdrawal: { subjectKind: 'agent', subjectAgentId: 'agent-session-1' } });
    expect(await withdrawEvents(agent.agentId)).toBe(1);
  });

  test('request: two keys at once -> one created, one withdrawal_open', async () => {
    const agent = await makeAgent();
    await addActiveAddress(agent);
    const results = await Promise.all([request(agent), request(agent)]);
    expect(results.map((result) => result.kind).sort()).toEqual(['created', 'refused']);
    const refused = results.find((result) => result.kind === 'refused')!;
    const made = results.find((result) => result.kind === 'created')! as { withdrawal: { id: string } };
    expect(refused).toEqual({ kind: 'refused', code: 'withdrawal_open', withdrawalId: made.withdrawal.id });
  });

  test('request: cooldown (10 min after the latest COUNTED row), then the 4th request of the UTC day -> daily_count_cap', async () => {
    const agent = await makeAgent();
    await addActiveAddress(agent);
    await closeCounted(await created(agent, { now: BASE }));
    expect(await request(agent, { now: at(BASE, 5 * MIN) })).toEqual({ kind: 'refused', code: 'cooldown', retryAt: at(BASE, 10 * MIN) });
    await closeCounted(await created(agent, { now: at(BASE, 11 * MIN) }));
    await closeCounted(await created(agent, { now: at(BASE, 22 * MIN) }));
    expect(await request(agent, { now: at(BASE, 33 * MIN) })).toEqual({
      kind: 'refused', code: 'daily_count_cap', retryAt: at(utcDay(BASE), DAY),
    });
    // The next UTC day starts a new count.
    expect((await request(agent, { now: at(utcDay(BASE), DAY + HOUR) })).kind).toBe('created');
  });

  test('request: a cancelled row neither blocks (cooldown) nor counts', async () => {
    const agent = await makeAgent();
    await addActiveAddress(agent);
    const id = await created(agent);
    expect(await q.cancelArenaWithdrawal(agent.agentId, id)).toMatchObject({ ok: true, withdrawal: { id, state: 'cancelled' } });
    expect((await request(agent, { now: at(BASE, MIN) })).kind).toBe('created');
  });

  test('request: exact USDC over 500 USDC in the agent UTC day -> agent_daily_cap; exactly 500 passes', async () => {
    const agent = await makeAgent();
    await addActiveAddress(agent);
    await closeCounted(await created(agent, { requestedAtomic: 400_000_000n }));
    expect(await request(agent, { requestedAtomic: 100_000_001n, now: at(BASE, 11 * MIN) })).toEqual({
      kind: 'refused', code: 'agent_daily_cap',
    });
    // SOL never counts toward the USDC cap.
    const sol = await request(agent, { asset: 'SOL', requestedAtomic: 1_000_000_000_000n, now: at(BASE, 11 * MIN) });
    expect(sol.kind).toBe('created');
    await q.cancelArenaWithdrawal(agent.agentId, (sol as { withdrawal: { id: string } }).withdrawal.id);
    expect((await request(agent, { requestedAtomic: 100_000_000n, now: at(BASE, 12 * MIN) })).kind).toBe('created');
  });

  test('request: no_withdraw_address, address_pending (with activeAt), wallet_not_ready, invalid_amount', async () => {
    const none = await makeAgent();
    expect(await request(none)).toEqual({ kind: 'refused', code: 'no_withdraw_address' });
    const pending = await makeAgent();
    const activeAt = at(BASE, 23 * HOUR);
    await addActiveAddress(pending, activeAt);
    expect(await request(pending)).toEqual({ kind: 'refused', code: 'address_pending', activeAt });
    const notReady = await makeAgent('pending');
    await addActiveAddress(notReady);
    expect(await request(notReady)).toEqual({ kind: 'refused', code: 'wallet_not_ready' });
    // The arena row of ANOTHER account is never usable.
    const owner = await makeAgent();
    await addActiveAddress(owner);
    expect(await request(owner, { ownerUserId: none.userId })).toEqual({ kind: 'refused', code: 'wallet_not_ready' });
    // Shapes the table refuses come back as a code, not a database error.
    expect(await request(owner, { requestedAtomic: null })).toEqual({ kind: 'refused', code: 'invalid_amount' });
    expect(await request(owner, { requestedAtomic: 0n })).toEqual({ kind: 'refused', code: 'invalid_amount' });
    expect(await request(owner, { amountMode: 'max', requestedAtomic: 5n })).toEqual({ kind: 'refused', code: 'invalid_amount' });
    expect(await request(owner, { requestedAtomic: 2n ** 63n })).toEqual({ kind: 'refused', code: 'invalid_amount' });
  });

  // ── Admission (§5 admitArenaWithdrawal, checks a-j) ──────────────────────

  test('admission: needs_sol below 5,000,000 lamports (USDC, ATA exists); 5,000,000 dispatches with the pre balances', async () => {
    const agent = await makeAgent();
    await addActiveAddress(agent);
    const first = await created(agent);
    const refused = await admit(first, live(agent, { solLamports: 4_999_999n }));
    expect(refused).toMatchObject({ kind: 'refused', code: 'needs_sol', withdrawal: { id: first, state: 'refused', errorCode: 'needs_sol', amountAtomic: null } });
    expect((refused as { withdrawal: { finalizedAt: Date | null } }).withdrawal.finalizedAt).toBeInstanceOf(Date);
    // 'refused' is not COUNTED: no cooldown.
    const second = await created(agent, { now: at(BASE, MIN) });
    const sent = await admit(second, live(agent, { solLamports: 5_000_000n, usdcAtomic: 3_000_000n }));
    expect(sent).toMatchObject({
      kind: 'dispatched',
      withdrawal: { id: second, state: 'dispatching', amountAtomic: 1_000_000n, preBalanceAtomic: 3_000_000n, preSolLamports: 5_000_000n },
    });
    expect((sent as { withdrawal: { dispatchedAt: Date | null } }).withdrawal.dispatchedAt).toBeInstanceOf(Date);
    // request + refusal + request + dispatch.
    expect(await withdrawEvents(agent.agentId)).toBe(4);
  });

  test('admission: USDC to an address with no token account needs 7,040,000 lamports', async () => {
    const agent = await makeAgent();
    await addActiveAddress(agent);
    const first = await created(agent);
    expect(await admit(first, live(agent, { solLamports: 7_039_999n }), { destinationHasUsdcAccount: false }))
      .toMatchObject({ kind: 'refused', code: 'needs_sol' });
    const second = await created(agent, { now: at(BASE, MIN) });
    expect(await admit(second, live(agent, { solLamports: 7_040_000n }), { destinationHasUsdcAccount: false }))
      .toMatchObject({ kind: 'dispatched' });
  });

  test('admission: USDC max = live - reserved add-ons - add-on calls since readAt - 5 s (rounded UP to the atomic unit)', async () => {
    const agent = await makeAgent();
    const bystander = await makeAgent();
    await addActiveAddress(agent);
    const id = await created(agent, { amountMode: 'max', requestedAtomic: null });
    const readAt = new Date(Date.now() - MIN);
    const { db, sql } = database;
    const book = (agentId: string, state: 'reserved' | 'done', priceUsd: string, when: Date) => db.execute(sql`
      INSERT INTO floor_arena_addon_calls (agent_id, addon_id, at, price_usd, ok, error, mints, response_ref, state)
      VALUES (${agentId}, ${ADDON_ID}, ${when.toISOString()}::timestamptz, ${priceUsd}::numeric, false, NULL, 0, NULL, ${state})
    `);
    await book(agent.agentId, 'reserved', '0.0200005', at(readAt, -HOUR)); // open reservation: always counts
    await book(agent.agentId, 'done', '0.03', at(readAt, -1_000));        // inside readAt - 5 s
    await book(agent.agentId, 'done', '0.07', at(readAt, 1_000));         // after the read
    await book(agent.agentId, 'done', '0.05', at(readAt, -10_000));       // before readAt - 5 s: in the live balance
    await book(bystander.agentId, 'reserved', '0.5', readAt);             // another agent's
    const result = await admit(id, live(agent, { usdcAtomic: 1_000_000n, readAt }));
    // 1_000_000 - ceil(1e6 * 0.1200005) = 1_000_000 - 120_001.
    expect(result).toMatchObject({ kind: 'dispatched', withdrawal: { amountMode: 'max', requestedAtomic: null, amountAtomic: 879_999n } });
  });

  test('admission: USDC max is clamped to the rest of the agent day (requested_at day, this row excluded)', async () => {
    const agent = await makeAgent();
    await addActiveAddress(agent);
    await closeCounted(await created(agent, { requestedAtomic: 499_500_000n }));
    const id = await created(agent, { amountMode: 'max', requestedAtomic: null, now: at(BASE, 11 * MIN) });
    expect(await admit(id, live(agent, { usdcAtomic: 10_000_000n }))).toMatchObject({
      kind: 'dispatched', withdrawal: { amountAtomic: 500_000n },
    });
  });

  test('admission: exact USDC over the agent day cap -> agent_daily_cap (a row booked past the request check)', async () => {
    const agent = await makeAgent();
    const address = await addActiveAddress(agent);
    const id = await created(agent);
    const { db, sql } = database;
    await db.execute(sql`
      INSERT INTO floor_arena_withdrawals (agent_id, owner_user_id, subject_kind, idempotency_key, asset, amount_mode,
        requested_atomic, amount_atomic, source_clawpump_agent_id, source_wallet, destination, address_id, state,
        requested_at, dispatched_at, finalized_at)
      VALUES (${agent.agentId}, ${agent.userId}::uuid, 'human', ${`key-${randomUUID()}`}, 'USDC', 'exact', 499500000, 499500000,
        ${agent.cpId}, ${agent.wallet}, ${address.address}, ${address.id}::uuid, 'needs_review',
        ${at(BASE, -MIN).toISOString()}::timestamptz, ${BASE.toISOString()}::timestamptz, now())
    `);
    expect(await admit(id, live(agent))).toMatchObject({ kind: 'refused', code: 'agent_daily_cap', withdrawal: { state: 'refused' } });
  });

  test('admission: SOL max = live - 900,000 lamports', async () => {
    const agent = await makeAgent();
    await addActiveAddress(agent);
    const id = await created(agent, { asset: 'SOL', amountMode: 'max', requestedAtomic: null });
    expect(await admit(id, live(agent, { solLamports: 10_000_000n, usdcAtomic: 0n }))).toMatchObject({
      kind: 'dispatched', withdrawal: { amountAtomic: 9_100_000n, preBalanceAtomic: 10_000_000n, preSolLamports: 10_000_000n },
    });
  });

  test('admission: below_minimum and insufficient_balance', async () => {
    const agent = await makeAgent();
    await addActiveAddress(agent);
    const max = await created(agent, { amountMode: 'max', requestedAtomic: null });
    expect(await admit(max, live(agent, { usdcAtomic: 99_999n }))).toMatchObject({ kind: 'refused', code: 'below_minimum' });
    const big = await created(agent, { requestedAtomic: 2_000_000n, now: at(BASE, MIN) });
    expect(await admit(big, live(agent, { usdcAtomic: 1_999_999n }))).toMatchObject({ kind: 'refused', code: 'insufficient_balance' });
    const tinySol = await created(agent, { asset: 'SOL', requestedAtomic: 999_999n, now: at(BASE, 2 * MIN) });
    expect(await admit(tinySol, live(agent))).toMatchObject({ kind: 'refused', code: 'below_minimum' });
    // SOL exact must leave the 900,000 keep: live 10,000,000 allows 9,100,000, not one lamport more.
    const solOver = await created(agent, { asset: 'SOL', requestedAtomic: 9_100_001n, now: at(BASE, 3 * MIN) });
    expect(await admit(solOver, live(agent))).toMatchObject({ kind: 'refused', code: 'insufficient_balance' });
    const solOk = await created(agent, { asset: 'SOL', requestedAtomic: 9_100_000n, now: at(BASE, 4 * MIN) });
    expect(await admit(solOk, live(agent))).toMatchObject({ kind: 'dispatched', withdrawal: { amountAtomic: 9_100_000n } });
  });

  test('admission: a replaced or revoked address -> address_revoked; source and agent changes are refused', async () => {
    const replaced = await makeAgent();
    await addActiveAddress(replaced);
    const first = await created(replaced);
    const set = await q.setArenaWithdrawAddress({
      agentId: replaced.agentId, ownerUserId: replaced.userId, address: fakeBase58(), proofKind: 'linked_wallet',
      message: null, signature: null, challengeNonce: null, setBy: 'human', setByAgentId: null, activeAt: new Date(),
    });
    expect(set.ok).toBe(true);
    expect(await admit(first, live(replaced))).toMatchObject({ kind: 'refused', code: 'address_revoked' });

    const revoked = await makeAgent();
    const address = await addActiveAddress(revoked);
    const second = await created(revoked);
    expect(await q.revokeArenaWithdrawAddress({ agentId: revoked.agentId, addressId: address.id, reason: 'owner' })).toEqual({ ok: true });
    expect(await admit(second, live(revoked))).toMatchObject({ kind: 'refused', code: 'address_revoked' });

    const moved = await makeAgent();
    await addActiveAddress(moved);
    const third = await created(moved);
    expect(await admit(third, live(moved, { address: fakeBase58() }))).toMatchObject({ kind: 'refused', code: 'source_mismatch' });
    const fourth = await created(moved, { now: at(BASE, MIN) });
    const { db, sql } = database;
    await db.execute(sql`UPDATE floor_arena_agents SET clawpump_wallet = ${fakeBase58()} WHERE id = ${moved.agentId}`);
    expect(await admit(fourth, live(moved))).toMatchObject({ kind: 'refused', code: 'agent_changed' });
  });

  test('admission: paused and the account-wide 2,000 USDC cap WAIT (row stays requested); a missing or moved row is gone', async () => {
    const agent = await makeAgent();
    await addActiveAddress(agent);
    const id = await created(agent);
    expect(await admit(id, live(agent), { paused: () => true })).toEqual({ kind: 'wait', reason: 'paused' });
    expect(await rowState(id)).toBe('requested');

    // Fill today's account-wide total (dispatched_at day, all agents) to 0.999999 USDC under the cap.
    const { db, sql } = database;
    const today = q.rowsOf<{ sum: string }>(await db.execute(sql`
      SELECT COALESCE(SUM(amount_atomic), 0)::text AS sum FROM floor_arena_withdrawals
      WHERE asset = 'USDC' AND state IN ('requested','dispatching','sent','confirmed','unknown','needs_review')
        AND dispatched_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    `))[0]!.sum;
    const filler = 2_000_000_000n - BigInt(today) - 999_999n;
    expect(filler > 0n).toBe(true);
    const other = await makeAgent();
    const otherAddress = await addActiveAddress(other);
    const fillerRow = q.rowsOf<{ id: string }>(await db.execute(sql`
      INSERT INTO floor_arena_withdrawals (agent_id, owner_user_id, subject_kind, idempotency_key, asset, amount_mode,
        requested_atomic, amount_atomic, source_clawpump_agent_id, source_wallet, destination, address_id, state,
        dispatched_at, finalized_at)
      VALUES (${other.agentId}, ${other.userId}::uuid, 'human', ${`key-${randomUUID()}`}, 'USDC', 'exact', ${filler.toString()}::bigint,
        ${filler.toString()}::bigint, ${other.cpId}, ${other.wallet}, ${otherAddress.address}, ${otherAddress.id}::uuid,
        'needs_review', now(), now())
      RETURNING id
    `))[0]!.id;
    try {
      expect(await admit(id, live(agent))).toEqual({ kind: 'wait', reason: 'account_cap' });
      expect(await rowState(id)).toBe('requested');
    } finally {
      await db.execute(sql`DELETE FROM floor_arena_withdrawals WHERE id = ${fillerRow}::uuid`);
    }
    expect(await admit(id, live(agent))).toMatchObject({ kind: 'dispatched' });
    expect(await admit(id, live(agent))).toEqual({ kind: 'gone' });
    expect(await admit(randomUUID(), live(agent))).toEqual({ kind: 'gone' });
  });

  testIfServerDb('two leaders: two concurrent admissions of one row -> exactly one dispatched', async () => {
    const agent = await makeAgent();
    await addActiveAddress(agent);
    const id = await created(agent);
    const results = await Promise.all([admit(id, live(agent)), admit(id, live(agent))]);
    expect(results.map((result) => result.kind).sort()).toEqual(['dispatched', 'gone']);
    expect(await rowState(id)).toBe('dispatching');
  });

  // ── Conservation with add-ons (D34-i, I5) ─────────────────────────────────

  test('conservation: an open exact USDC withdrawal makes the add-on reservation refuse underfunded', async () => {
    const agent = await makeAgent();
    await addActiveAddress(agent);
    await created(agent, { requestedAtomic: 1_000_000n });
    expect(await reserve(agent, 1.05)).toEqual({
      reserved: false, check: { ok: false, reason: 'underfunded', spentUsd: 0, capUsd: 0 },
    });
    expect(await reserve(agent, 1.1)).toMatchObject({ reserved: true });
    // The reservation just made is subtracted too: 1.15 - 1 - 0.1 < 0.1.
    expect(await reserve(agent, 1.15)).toMatchObject({ reserved: false, check: { reason: 'underfunded' } });
    expect(await q.readArenaOpenWithdrawHold(agent.agentId)).toEqual({ usdcAtomic: 1_000_000n, solLamports: 0n, usdcMaxPending: false });
  });

  test('conservation: an open USDC max row -> withdraw_pending; once admitted its amount is the hold', async () => {
    const agent = await makeAgent();
    await addActiveAddress(agent);
    const id = await created(agent, { amountMode: 'max', requestedAtomic: null });
    expect(await q.readArenaOpenWithdrawHold(agent.agentId)).toEqual({ usdcAtomic: 0n, solLamports: 0n, usdcMaxPending: true });
    expect(await reserve(agent, 100)).toEqual({
      reserved: false, check: { ok: false, reason: 'withdraw_pending', spentUsd: 0, capUsd: 0 },
    });
    expect(await admit(id, live(agent, { usdcAtomic: 2_000_000n }))).toMatchObject({ kind: 'dispatched', withdrawal: { amountAtomic: 2_000_000n } });
    expect(await q.readArenaOpenWithdrawHold(agent.agentId)).toEqual({ usdcAtomic: 2_000_000n, solLamports: 0n, usdcMaxPending: false });
    expect(await reserve(agent, 2.05)).toMatchObject({ reserved: false, check: { reason: 'underfunded' } });
    expect(await reserve(agent, 2.15)).toMatchObject({ reserved: true });
  });

  testIfServerDb('conservation: a reservation holding floor-arena-addon:<id> blocks admission until commit; admission then subtracts it', async () => {
    const agent = await makeAgent();
    await addActiveAddress(agent);
    const id = await created(agent, { amountMode: 'max', requestedAtomic: null });
    const { db, sql } = database;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    // The same lock and row reserveArenaAddonCall takes and writes, held open.
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`floor-arena-addon:${agent.agentId}`}, 0))`);
      await tx.execute(sql`
        INSERT INTO floor_arena_addon_calls (agent_id, addon_id, at, price_usd, ok, error, mints, response_ref, state)
        VALUES (${agent.agentId}, ${ADDON_ID}, ${new Date(Date.now() - HOUR).toISOString()}::timestamptz, 0.25, false, NULL, 0, NULL, 'reserved')
      `);
      entered();
      await hold;
    });
    await inside;
    let settled = false;
    const admission = admit(id, live(agent, { usdcAtomic: 1_000_000n })).then((value) => { settled = true; return value; });
    try {
      await Bun.sleep(500);
      expect(settled).toBe(false);
    } finally {
      release();
    }
    await holder;
    expect(await admission).toMatchObject({ kind: 'dispatched', withdrawal: { amountAtomic: 750_000n } });
  });

  // ── Challenges ────────────────────────────────────────────────────────────

  test('challenge: single use, bound to user + agent + address, expires, at most 5 live per agent', async () => {
    const agent = await makeAgent();
    const stranger = await makeAgent();
    const address = fakeBase58();
    const nonce = () => `n${randomUUID().replace(/-/g, '')}`;
    const now = new Date();
    const n1 = nonce();
    const issued = await q.issueArenaWithdrawChallenge({ agentId: agent.agentId, ownerUserId: agent.userId, address, nonce: n1, now });
    const expiresAt = at(now, 10 * MIN);
    expect(issued).toEqual({
      ok: true, nonce: n1, expiresAt,
      message: buildFloorArenaWithdrawAddressMessage({
        agentId: agent.agentId, userId: agent.userId, address, nonce: n1, expiresAt: expiresAt.toISOString(),
      }),
    });
    const consume = (over: Partial<Parameters<typeof q.consumeArenaWithdrawChallenge>[0]> = {}) =>
      q.consumeArenaWithdrawChallenge({ nonce: n1, agentId: agent.agentId, ownerUserId: agent.userId, address, ...over });
    expect(await consume({ ownerUserId: stranger.userId })).toBeNull();
    expect(await consume({ agentId: stranger.agentId })).toBeNull();
    expect(await consume({ address: fakeBase58() })).toBeNull();
    expect(await consume()).toEqual({ message: (issued as { message: string }).message });
    expect(await consume()).toBeNull();
    // Expired (issued 11 minutes ago): never consumable.
    const old = nonce();
    await q.issueArenaWithdrawChallenge({ agentId: stranger.agentId, ownerUserId: stranger.userId, address, nonce: old, now: at(now, -11 * MIN) });
    expect(await q.consumeArenaWithdrawChallenge({ nonce: old, agentId: stranger.agentId, ownerUserId: stranger.userId, address })).toBeNull();

    const busy = await makeAgent();
    for (let i = 0; i < 5; i += 1) {
      expect((await q.issueArenaWithdrawChallenge({ agentId: busy.agentId, ownerUserId: busy.userId, address, nonce: nonce(), now })).ok).toBe(true);
    }
    expect(await q.issueArenaWithdrawChallenge({ agentId: busy.agentId, ownerUserId: busy.userId, address, nonce: nonce(), now }))
      .toEqual({ ok: false, reason: 'too_many_challenges' });
    // Expired rows are deleted on issue and stop counting: 11 minutes later the agent may ask again.
    expect((await q.issueArenaWithdrawChallenge({ agentId: busy.agentId, ownerUserId: busy.userId, address, nonce: nonce(), now: at(now, 11 * MIN) })).ok).toBe(true);
    const { db, sql } = database;
    expect(Number(q.rowsOf<{ n: number }>(await db.execute(sql`
      SELECT count(*)::int AS n FROM floor_arena_withdraw_challenges WHERE agent_id = ${busy.agentId}
    `))[0]!.n)).toBe(1);
  });

  test('challenge helpers: isArenaClawPumpWallet and readArenaLinkedWallet', async () => {
    const agent = await makeAgent();
    expect(await q.isArenaClawPumpWallet(agent.wallet)).toBe(true);
    expect(await q.isArenaClawPumpWallet(fakeBase58())).toBe(false);
    expect(await q.readArenaLinkedWallet(agent.userId)).toBeNull();
    const { db, sql } = database;
    const linked = fakeBase58();
    const linkedAt = new Date(Date.now() - 2 * DAY);
    await db.execute(sql`
      UPDATE users SET linked_wallet_pubkey = ${linked}, linked_wallet_at = ${linkedAt.toISOString()}::timestamptz WHERE id = ${agent.userId}::uuid
    `);
    expect(await q.readArenaLinkedWallet(agent.userId)).toEqual({ address: linked, linkedAt });
  });

  // ── Addresses ─────────────────────────────────────────────────────────────

  test('address: a new address replaces the old one; same address, revoke, not ready', async () => {
    const agent = await makeAgent();
    const first = fakeBase58();
    const set1 = await q.setArenaWithdrawAddress({
      agentId: agent.agentId, ownerUserId: agent.userId, address: first, proofKind: 'signed', message: 'signed text',
      signature: fakeBase58(88), challengeNonce: `n${randomUUID().replace(/-/g, '')}`, setBy: 'agent', setByAgentId: 'agent-x',
      activeAt: new Date(Date.now() + DAY),
    });
    expect(set1).toMatchObject({ ok: true, address: { agentId: agent.agentId, address: first, proofKind: 'signed', setBy: 'agent', setByAgentId: 'agent-x', revokedAt: null } });
    const firstId = (set1 as { address: { id: string } }).address.id;
    expect(await q.setArenaWithdrawAddress({
      agentId: agent.agentId, ownerUserId: agent.userId, address: first, proofKind: 'linked_wallet', message: null,
      signature: null, challengeNonce: null, setBy: 'human', setByAgentId: null, activeAt: new Date(),
    })).toEqual({ ok: false, reason: 'same_address' });
    const second = fakeBase58();
    const before = Date.now();
    const set2 = await q.setArenaWithdrawAddress({
      agentId: agent.agentId, ownerUserId: agent.userId, address: second, proofKind: 'linked_wallet', message: null,
      signature: null, challengeNonce: null, setBy: 'human', setByAgentId: null, activeAt: new Date(before - DAY),
    });
    expect(set2.ok).toBe(true);
    const record = (set2 as { address: { id: string; activeAt: Date; createdAt: Date } }).address;
    // active_at is never before created_at (CHECK): a past activeAt means "active now".
    expect(record.activeAt.getTime()).toBeGreaterThanOrEqual(record.createdAt.getTime());
    expect(record.activeAt.getTime()).toBeLessThan(before + MIN);
    expect(await q.readArenaWithdrawAddress(agent.agentId)).toMatchObject({ id: record.id, address: second });
    const { db, sql } = database;
    const old = q.rowsOf<{ revoked_at: unknown; revoke_reason: string }>(await db.execute(sql`
      SELECT revoked_at, revoke_reason FROM floor_arena_withdraw_addresses WHERE id = ${firstId}::uuid
    `))[0]!;
    expect(old.revoke_reason).toBe('replaced');
    expect(old.revoked_at).not.toBeNull();
    expect(await q.revokeArenaWithdrawAddress({ agentId: agent.agentId, addressId: record.id, reason: 'owner' })).toEqual({ ok: true });
    expect(await q.revokeArenaWithdrawAddress({ agentId: agent.agentId, addressId: record.id, reason: 'owner' })).toEqual({ ok: false, reason: 'already_revoked' });
    expect(await q.revokeArenaWithdrawAddress({ agentId: agent.agentId, addressId: randomUUID(), reason: 'admin' })).toEqual({ ok: false, reason: 'not_found' });
    expect(await q.readArenaWithdrawAddress(agent.agentId)).toBeNull();
    // set + set (replace) + revoke = 3 events, none public.
    expect(await withdrawEvents(agent.agentId)).toBe(3);
    expect(q.ARENA_PUBLIC_USER_EVENT_TYPES).not.toContain('withdraw');
    const notReady = await makeAgent('pending');
    expect(await q.setArenaWithdrawAddress({
      agentId: notReady.agentId, ownerUserId: notReady.userId, address: fakeBase58(), proofKind: 'linked_wallet', message: null,
      signature: null, challengeNonce: null, setBy: 'human', setByAgentId: null, activeAt: new Date(),
    })).toEqual({ ok: false, reason: 'wallet_not_ready' });
  });

  // ── Finalize, signatures, lists ───────────────────────────────────────────

  test('finalize: CAS lost -> null; a reused signature -> ArenaWithdrawTxReusedError; attach only on unknown without a signature', async () => {
    const one = await makeAgent();
    await addActiveAddress(one);
    const first = await created(one);
    expect(await admit(first, live(one))).toMatchObject({ kind: 'dispatched' });
    expect(await q.finalizeArenaWithdrawal(first, ['sent'], { state: 'confirmed' }, { summary: 'lost' })).toBeNull();
    const sig = fakeBase58(88);
    const sentAt = new Date();
    const sent = await q.finalizeArenaWithdrawal(first, ['dispatching'],
      { state: 'sent', txSignature: sig, sentAt, recipientAccountCreated: false }, { summary: 'sent', data: { ok: true } });
    expect(sent).toMatchObject({ id: first, state: 'sent', txSignature: sig, recipientAccountCreated: false, finalizedAt: null });
    expect(sent!.sentAt!.getTime()).toBe(sentAt.getTime());
    expect(await q.arenaWithdrawSignatureUsed(sig)).toBe(true);
    expect(await q.arenaWithdrawSignatureUsed(fakeBase58(88))).toBe(false);

    const two = await makeAgent();
    await addActiveAddress(two);
    const second = await created(two);
    expect(await admit(second, live(two))).toMatchObject({ kind: 'dispatched' });
    let reused: unknown = null;
    try {
      await q.finalizeArenaWithdrawal(second, ['dispatching'], { state: 'sent', txSignature: sig }, { summary: 'sent' });
    } catch (error) {
      reused = error;
    }
    expect(reused).toBeInstanceOf(q.ArenaWithdrawTxReusedError);
    expect(await rowState(second)).toBe('dispatching');
    expect(await q.finalizeArenaWithdrawal(second, ['dispatching'], { state: 'unknown', errorCode: 'timeout' }, { summary: 'unknown' }))
      .toMatchObject({ state: 'unknown', errorCode: 'timeout', finalizedAt: null });
    let attachReused: unknown = null;
    try {
      await q.attachArenaWithdrawalSignature(second, sig);
    } catch (error) {
      attachReused = error;
    }
    expect(attachReused).toBeInstanceOf(q.ArenaWithdrawTxReusedError);
    const sig2 = fakeBase58(88);
    expect(await q.attachArenaWithdrawalSignature(second, sig2)).toBe(true);
    expect(await q.attachArenaWithdrawalSignature(second, fakeBase58(88))).toBe(false);
    expect(await q.attachArenaWithdrawalSignature(first, fakeBase58(88))).toBe(false);
    const confirmed = await q.finalizeArenaWithdrawal(first, ['sent', 'unknown'],
      { state: 'confirmed', postBalanceAtomic: 9_000_000n }, { summary: 'confirmed' });
    expect(confirmed).toMatchObject({ state: 'confirmed', postBalanceAtomic: 9_000_000n, txSignature: sig, errorCode: null });
    expect(confirmed!.finalizedAt).toBeInstanceOf(Date);
  });

  test('lists, touch, needs_review, cancel, summary and add-on spend', async () => {
    const agent = await makeAgent();
    const address = await addActiveAddress(agent);
    const first = await created(agent);
    expect(await q.readArenaWithdrawSummary(agent.agentId)).toMatchObject({ address: { id: address.id }, open: { id: first } });
    expect((await q.readArenaWithdrawalsDue(100_000)).map((row) => row.id)).toContain(first);
    expect(await q.cancelArenaWithdrawal(agent.agentId, 'not-a-uuid')).toEqual({ ok: false, reason: 'not_found' });
    expect(await q.cancelArenaWithdrawal(agent.agentId, randomUUID())).toEqual({ ok: false, reason: 'not_found' });
    const stranger = await makeAgent();
    expect(await q.cancelArenaWithdrawal(stranger.agentId, first)).toEqual({ ok: false, reason: 'not_found' });
    expect(await request(agent, { now: at(BASE, MIN) })).toEqual({ kind: 'refused', code: 'withdrawal_open', withdrawalId: first });
    expect(await admit(first, live(agent))).toMatchObject({ kind: 'dispatched' });
    expect(await q.cancelArenaWithdrawal(agent.agentId, first)).toEqual({ ok: false, reason: 'not_cancellable' });
    expect((await q.readArenaWithdrawalsDue(100_000)).map((row) => row.id)).not.toContain(first);
    // A dispatching row is due for reconcile only after 2 minutes.
    expect((await q.readArenaWithdrawalsToReconcile(new Date(), 100_000)).map((row) => row.id)).not.toContain(first);
    expect((await q.readArenaWithdrawalsToReconcile(at(new Date(), 3 * MIN), 100_000)).map((row) => row.id)).toContain(first);
    expect(await q.markArenaWithdrawalNeedsReview(first, 'operator note')).toBe(false); // dispatching: not allowed
    await q.finalizeArenaWithdrawal(first, ['dispatching'], { state: 'unknown', errorCode: 'timeout' }, { summary: 'unknown' });
    expect((await q.readArenaWithdrawalsToReconcile(new Date(), 100_000)).map((row) => row.id)).toContain(first);
    const checkedAt = new Date();
    await q.touchArenaWithdrawalCheck(first, checkedAt);
    await q.touchArenaWithdrawalCheck(first, checkedAt);
    const [touched] = await q.readArenaWithdrawals(agent.agentId, 10);
    expect(touched).toMatchObject({ id: first, checkCount: 2 });
    expect(touched!.lastCheckedAt!.getTime()).toBe(checkedAt.getTime());
    expect(await q.markArenaWithdrawalNeedsReview(first, 'operator note')).toBe(true);
    expect(await q.markArenaWithdrawalNeedsReview(first, 'again')).toBe(false);
    const reviewed = (await q.readArenaWithdrawalsAdmin({ state: 'needs_review', limit: 200 })).find((row) => row.id === first);
    expect(reviewed).toMatchObject({ state: 'needs_review', reviewNote: 'operator note' });
    expect(reviewed!.finalizedAt).toBeInstanceOf(Date);
    expect((await q.readArenaWithdrawalsAdmin({ state: null, limit: 200 })).length).toBeGreaterThan(0);
    // needs_review is COUNTED: the cooldown runs from its requested_at.
    expect(await request(agent, { now: at(BASE, 5 * MIN) })).toMatchObject({ kind: 'refused', code: 'cooldown' });
    const third = await created(agent, { now: at(BASE, 11 * MIN) });
    expect(await q.cancelArenaWithdrawal(agent.agentId, third)).toMatchObject({ ok: true, withdrawal: { state: 'cancelled' } });
    expect((await q.readArenaWithdrawals(agent.agentId, 10)).map((row) => row.id)).toEqual([third, first]);
    expect(await q.readArenaWithdrawSummary(agent.agentId)).toMatchObject({ open: null });
    // Add-on spend since a time: every state, price as booked.
    const { db, sql } = database;
    const since = new Date(Date.now() - MIN);
    await db.execute(sql`
      INSERT INTO floor_arena_addon_calls (agent_id, addon_id, at, price_usd, ok, error, mints, response_ref, state)
      VALUES (${agent.agentId}, ${ADDON_ID}, ${new Date().toISOString()}::timestamptz, 0.25, false, NULL, 0, NULL, 'reserved'),
             (${agent.agentId}, ${ADDON_ID}, ${new Date().toISOString()}::timestamptz, 0.5, true, NULL, 0, NULL, 'done'),
             (${agent.agentId}, ${ADDON_ID}, ${at(since, -MIN).toISOString()}::timestamptz, 1, true, NULL, 0, NULL, 'done')
    `);
    expect(await q.readArenaAddonSpentSince(agent.agentId, since)).toBeCloseTo(0.75, 9);
  });

  test('tryWithArenaWithdrawLock: runs inside the lock and releases it at the end', async () => {
    const agent = await makeAgent();
    expect(await q.tryWithArenaWithdrawLock(agent.agentId, async () => 'first')).toEqual({ acquired: true, value: 'first' });
    expect(await q.tryWithArenaWithdrawLock(agent.agentId, async () => 'second')).toEqual({ acquired: true, value: 'second' });
  });

  testIfServerDb('tryWithArenaWithdrawLock: TWO connections: a second caller is refused at once, another agent is free', async () => {
    const agent = await makeAgent();
    const other = await makeAgent();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const a = q.tryWithArenaWithdrawLock(agent.agentId, async () => { entered(); await hold; return 'A'; });
    await inside;
    try {
      const started = Date.now();
      expect(await q.tryWithArenaWithdrawLock(agent.agentId, async () => 'B')).toEqual({ acquired: false });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(await q.tryWithArenaWithdrawLock(other.agentId, async () => 'C')).toEqual({ acquired: true, value: 'C' });
      // The x402 lock of the same agent is a different key.
      expect(await q.tryWithArenaX402Lock(agent.agentId, async () => 'D')).toEqual({ acquired: true, value: 'D' });
    } finally {
      release();
    }
    expect(await a).toEqual({ acquired: true, value: 'A' });
  });
});
