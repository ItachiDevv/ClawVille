import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FLOOR_ARENA_TEMPLATES } from '@clawville/shared';

/**
 * Real-SQL checks for the arena money paths (audit-money + Codex r17). They
 * WRITE rows, so they need DATABASE_URL AND an explicit opt-in: CI === 'true'
 * (the CI migrate job's Postgres service, after migration 0070) or
 * ARENA_DB_TEST=1 for a local database. A DATABASE_URL alone (a developer's
 * .env.local) never runs them. Every row uses fresh ids and is removed
 * afterwards (users ON DELETE CASCADE removes the arena rows).
 */
const optedIn = process.env.CI === 'true' || process.env.ARENA_DB_TEST === '1';
const describeIfDb = process.env.DATABASE_URL && optedIn ? describe : describe.skip;
/** Two real connections are needed for the BUSY case (PGlite has one): a postgres:// URL only. */
const testIfServerDb = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? '') ? test : test.skip;

describeIfDb('floor arena money SQL on Postgres', () => {
  const ids = {
    user1: crypto.randomUUID(),
    user2: crypto.randomUUID(),
    user3: crypto.randomUUID(),
    user4: crypto.randomUUID(),
    user5: crypto.randomUUID(),
    seated: crypto.randomUUID(),
    standing: crypto.randomUUID(),
    offReady: crypto.randomUUID(),
    offFailed: crypto.randomUUID(),
    offPending: crypto.randomUUID(),
    cp1: crypto.randomUUID(),
    cp2: crypto.randomUUID(),
    cp3: crypto.randomUUID(),
    cp4: crypto.randomUUID(),
    cp5: crypto.randomUUID(),
  };
  const users = ['user1', 'user2', 'user3', 'user4', 'user5'] as const;
  const addons = JSON.stringify([{ id: 'nansen-token-screener-sol', enabled: true, dailyCapUsd: 2 }]);
  const addonsOff = JSON.stringify([{ id: 'nansen-token-screener-sol', enabled: false, dailyCapUsd: 2 }]);

  beforeAll(async () => {
    const { db, sql } = await import('@clawville/database');
    const params = JSON.stringify(FLOOR_ARENA_TEMPLATES[0]!.params);
    // users_has_auth_method needs email + password_hash (the CI schema restores that CHECK).
    for (const key of users) {
      await db.execute(sql`
        INSERT INTO users (id, email, password_hash, name)
        VALUES (${ids[key]}::uuid, ${`arena-${ids[key]}@clawville-test.invalid`}, ${`disabled-${ids[key]}`}, 'Arena DB Test')
      `);
    }
    await db.execute(sql`
      INSERT INTO floor_arena_agents (id, kind, owner_user_id, name, template_id, params, provision_state, clawpump_agent_id, addons, seated)
      VALUES
        (${ids.seated}, 'user', ${ids.user1}::uuid, 'Sat', 'genesis', ${params}::jsonb, 'ready', ${ids.cp1}, ${addons}::jsonb, true),
        (${ids.standing}, 'user', ${ids.user2}::uuid, 'Stood', 'genesis', ${params}::jsonb, 'ready', ${ids.cp2}, ${addons}::jsonb, false),
        (${ids.offReady}, 'user', ${ids.user3}::uuid, 'Off', 'genesis', ${params}::jsonb, 'ready', ${ids.cp3}, ${addonsOff}::jsonb, true),
        (${ids.offFailed}, 'user', ${ids.user4}::uuid, 'OffF', 'genesis', ${params}::jsonb, 'failed', ${ids.cp4}, '[]'::jsonb, false),
        (${ids.offPending}, 'user', ${ids.user5}::uuid, 'OffP', 'genesis', ${params}::jsonb, 'pending', ${ids.cp5}, '[]'::jsonb, false)
    `);
  });

  afterAll(async () => {
    const { db, sql } = await import('@clawville/database');
    for (const key of users) await db.execute(sql`DELETE FROM users WHERE id = ${ids[key]}::uuid`);
  });

  test('M1: only SEATED agents are on the add-on work list', async () => {
    const q = await import('../floor-arena/queries');
    const listed = (await q.readArenaAddonAgents()).map((agent) => agent.id);
    expect(listed).toContain(ids.seated);
    expect(listed).not.toContain(ids.standing);
  });

  test('Codex r17 #4: ownership proof is row-specific', async () => {
    const q = await import('../floor-arena/queries');
    expect(await q.isArenaClawPumpOwnedBy(ids.cp1, ids.seated)).toBe(true);
    expect(await q.isArenaClawPumpOwnedBy(ids.cp1, ids.standing)).toBe(false);
    expect(await q.isArenaClawPumpOwnedBy(crypto.randomUUID(), ids.seated)).toBe(false);
  });

  test('Codex r17 #2: a stand-up after the reservation releases it before any payment', async () => {
    const q = await import('../floor-arena/queries');
    const at = new Date();
    const dayStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    const reservation = await q.reserveArenaAddonCall({
      agentId: ids.seated, addonId: 'nansen-token-screener-sol', clawpumpAgentId: ids.cp1,
      at, priceUsd: 0.01, dayStart, check: () => ({ ok: true }),
    });
    expect(reservation.reserved).toBe(true);
    const id = (reservation as { id: number }).id;
    // The standing agent cannot reserve at all.
    const refused = await q.reserveArenaAddonCall({
      agentId: ids.standing, addonId: 'nansen-token-screener-sol', clawpumpAgentId: ids.cp2,
      at, priceUsd: 0.01, dayStart, check: () => ({ ok: true }),
    });
    expect(refused).toMatchObject({ reserved: false, check: { reason: 'agent_changed' } });
    // A pause releases; then (after a fresh reservation) a stand-up releases.
    expect(await q.confirmArenaAddonDispatch({
      reservationId: id, agentId: ids.seated, addonId: 'nansen-token-screener-sol', clawpumpAgentId: ids.cp1, paused: () => true,
    })).toEqual({ ok: false, reason: 'paused' });
    const { db, sql } = await import('@clawville/database');
    const released = q.rowsOf<{ state: string; price_usd: string; error: string }>(await db.execute(sql`
      SELECT state, price_usd, error FROM floor_arena_addon_calls WHERE id = ${id}
    `));
    expect(released[0]).toMatchObject({ state: 'done', error: 'released_before_pay' });
    expect(Number(released[0]!.price_usd)).toBe(0);
    const second = await q.reserveArenaAddonCall({
      agentId: ids.seated, addonId: 'nansen-token-screener-sol', clawpumpAgentId: ids.cp1,
      at, priceUsd: 0.01, dayStart, check: () => ({ ok: true }),
    });
    const secondId = (second as { id: number }).id;
    await q.setArenaAgentSeat(ids.seated, false, null, 'Stood up');
    expect(await q.confirmArenaAddonDispatch({
      reservationId: secondId, agentId: ids.seated, addonId: 'nansen-token-screener-sol', clawpumpAgentId: ids.cp1, paused: () => false,
    })).toEqual({ ok: false, reason: 'agent_changed' });
    await q.setArenaAgentSeat(ids.seated, true, 0, 'Sat down');
    const third = await q.reserveArenaAddonCall({
      agentId: ids.seated, addonId: 'nansen-token-screener-sol', clawpumpAgentId: ids.cp1,
      at, priceUsd: 0.01, dayStart, check: () => ({ ok: true }),
    });
    const thirdId = (third as { id: number }).id;
    expect(await q.confirmArenaAddonDispatch({
      reservationId: thirdId, agentId: ids.seated, addonId: 'nansen-token-screener-sol', clawpumpAgentId: ids.cp1, paused: () => false,
    })).toEqual({ ok: true });
    // Codex r17 #5: a booked settlement tx is recognised for that agent only.
    await q.finalizeArenaAddonCall(thirdId, { priceUsd: 0.01, ok: true, error: null, mints: 3, responseRef: `tx-${ids.cp1}` });
    expect(await q.arenaAddonChargeRefSeen(ids.seated, `tx-${ids.cp1}`)).toBe(true);
    expect(await q.arenaAddonChargeRefSeen(ids.standing, `tx-${ids.cp1}`)).toBe(false);
    expect(await q.arenaAddonChargeRefSeen(ids.seated, 'tx-other')).toBe(false);
  });

  test('audit-money S4: the no-cap OFF list (recent, add-on free) and the sweep page (cursor)', async () => {
    const q = await import('../floor-arena/queries');
    const recent = await q.readArenaX402RecentOff(new Date(Date.now() - 60 * 60_000), '', 100_000);
    expect(recent).toContain(ids.offReady);
    expect(recent).toContain(ids.offFailed);
    expect(recent).not.toContain(ids.seated);
    expect(recent).not.toContain(ids.offPending);
    // Older than `since`: not listed.
    expect(await q.readArenaX402RecentOff(new Date(Date.now() + 60 * 60_000), '', 100_000)).not.toContain(ids.offReady);
    // null = a full pass (a new leader term): every add-on-free agent, keyset-paged.
    const full = await q.readArenaX402RecentOff(null, '', 100_000);
    expect(full).toContain(ids.offReady);
    expect(full).toContain(ids.offFailed);
    expect(full).not.toContain(ids.seated);
    const firstOfMine = full.filter((id) => id === ids.offReady || id === ids.offFailed)[0]!;
    expect(await q.readArenaX402RecentOff(null, firstOfMine, 100_000)).not.toContain(firstOfMine);
    // The watermark clock is the database's.
    const dbNow = await q.readDbNow();
    expect(Math.abs(dbNow.getTime() - Date.now())).toBeLessThan(60_000);
    // The sweep lists every ready/failed user agent with a ClawPump agent, from a cursor, in id order.
    const page = await q.readArenaX402SweepAgents('', 100_000);
    for (const id of [ids.seated, ids.offReady, ids.offFailed]) expect(page).toContain(id);
    expect(page).not.toContain(ids.offPending);
    const mine = page.filter((id) => id === ids.offReady || id === ids.offFailed);
    const after = await q.readArenaX402SweepAgents(mine[0]!, 100_000);
    expect(after).not.toContain(mine[0]);
    expect(after).toContain(mine[1]);
    expect(await q.readArenaX402SweepAgents('', 1)).toHaveLength(1);
  });

  test('Codex r20 (2): tryWithArenaX402Lock runs the call inside the lock and releases it at the end', async () => {
    const q = await import('../floor-arena/queries');
    expect(await q.tryWithArenaX402Lock(ids.offReady, async () => 'first')).toEqual({ acquired: true, value: 'first' });
    // Released at commit: the same key is free again.
    expect(await q.tryWithArenaX402Lock(ids.offReady, async () => 'second')).toEqual({ acquired: true, value: 'second' });
    // try/catch, not expect().rejects: under bun test, rejects stalled this transaction's promise on a real
    // Postgres after two earlier sections (try/catch, as the production callers use, never does).
    let message = '';
    try {
      await q.tryWithArenaX402Lock(ids.offReady, async () => { throw new Error('boom'); });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('boom');
    expect(await q.tryWithArenaX402Lock(ids.offReady, async () => 'after error')).toEqual({ acquired: true, value: 'after error' });
  });

  testIfServerDb('Codex r21 / lead: TWO connections: while A holds the x402 lock, B is refused at once and a route write commits', async () => {
    const q = await import('../floor-arena/queries');
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    // Connection A: an x402 section that stays open until we release it.
    const a = q.tryWithArenaX402Lock(ids.offReady, async () => { entered(); await hold; return 'A'; });
    await inside;
    try {
      // Connection B, same agent: refused at once (try-lock), never waiting on A.
      const startedB = Date.now();
      expect(await q.tryWithArenaX402Lock(ids.offReady, async () => 'B')).toEqual({ acquired: false });
      expect(Date.now() - startedB).toBeLessThan(2_000);
      // Another agent's x402 lock is free.
      expect(await q.tryWithArenaX402Lock(ids.offFailed, async () => 'C')).toEqual({ acquired: true, value: 'C' });
      // A route-style write (it takes the add-on lock first) and the short locked read commit while A is open.
      const startedW = Date.now();
      await q.setArenaAgentSeat(ids.offReady, true, 1, 'Sat down while the x402 lock is held');
      expect((await q.readArenaAgentLocked(ids.offReady))!.seated).toBe(true);
      expect(Date.now() - startedW).toBeLessThan(2_000);
    } finally {
      release();
    }
    expect(await a).toEqual({ acquired: true, value: 'A' });
    // Released at commit: B gets it now.
    expect(await q.tryWithArenaX402Lock(ids.offReady, async () => 'B')).toEqual({ acquired: true, value: 'B' });
  });

  test('Codex r20 (1): the fair removal cursor pages add-on-free agents by id', async () => {
    const q = await import('../floor-arena/queries');
    const page = await q.readArenaX402OffAgents('', 100_000);
    expect(page).toContain(ids.offReady);
    expect(page).toContain(ids.offFailed);
    expect(page).not.toContain(ids.seated);
    expect(page).not.toContain(ids.offPending);
    const mine = page.filter((id) => id === ids.offReady || id === ids.offFailed);
    const after = await q.readArenaX402OffAgents(mine[0]!, 100_000);
    expect(after).not.toContain(mine[0]);
    expect(after).toContain(mine[1]);
    expect(await q.readArenaX402OffAgents('', 1)).toHaveLength(1);
  });

  test('Codex r19: readArenaAgentLocked reads the current row under the advisory lock', async () => {
    const q = await import('../floor-arena/queries');
    expect(await q.readArenaAgentLocked(ids.offReady)).toMatchObject({ id: ids.offReady, provisionState: 'ready', clawpumpAgentId: ids.cp3 });
    await q.setArenaAgentAddons(ids.offReady, [{ id: 'nansen-token-screener-sol', enabled: true, dailyCapUsd: 2 }], 'on');
    expect((await q.readArenaAgentLocked(ids.offReady))!.addons).toEqual([{ id: 'nansen-token-screener-sol', enabled: true, dailyCapUsd: 2 }]);
    expect(await q.readArenaAgentLocked(crypto.randomUUID())).toBeNull();
  });

  test('N4: resetArenaProvision resets only a FAILED user row, with a fresh attempt budget', async () => {
    const q = await import('../floor-arena/queries');
    expect(await q.resetArenaProvision(ids.seated)).toBe(false);
    const { db, sql } = await import('@clawville/database');
    await db.execute(sql`
      UPDATE floor_arena_agents SET provision_state = 'failed', provision_attempts = 5, provision_error = 'clawpump_timeout'
      WHERE id = ${ids.standing}
    `);
    expect(await q.resetArenaProvision(ids.standing)).toBe(true);
    expect(await q.readArenaAgent(ids.standing)).toMatchObject({
      provisionState: 'pending', provisionAttempts: 0, provisionError: null, provisionNextAt: null,
    });
  });

  test('O1 (2026-10-01): a row whose pay POST never left the process does not advance the dedupe rotation', async () => {
    const q = await import('../floor-arena/queries');
    const { db, sql } = await import('@clawville/database');
    const addonId = 'o1-rotation-test';
    const now = new Date();
    // Any window start before the six rows (a UTC-midnight start could fall between them).
    const dayStart = new Date(now.getTime() - 3_600_000);
    const book = (error: string | null, ok: boolean, priceUsd: number, secondsAgo: number) => db.execute(sql`
      INSERT INTO floor_arena_addon_calls (agent_id, addon_id, at, price_usd, ok, error, mints, response_ref, state)
      VALUES (${ids.offFailed}, ${addonId}, ${new Date(now.getTime() - secondsAgo * 1000).toISOString()}::timestamptz,
        ${priceUsd}, ${ok}, ${error}, 0, NULL, 'done')
    `);
    await book(null, true, 0.01, 60);                          // sent, paid
    await book('vendor_500', false, 0.01, 50);                 // sent, vendor failure: counts
    await book('released_before_pay', false, 0, 40);           // confirmDispatch release: not sent
    await book('clawpump_budget_exhausted', false, 0, 30);     // our own budget: not sent
    await book('clawpump_agent_running', false, 0, 20);        // writer guard refusal: not sent
    await book('clawpump_timeout', false, 0.01, 10);           // may have been sent: counts
    const stat = (await q.readArenaAddonStats(ids.offFailed, dayStart)).find((row) => row.addonId === addonId)!;
    // The old COUNT(*) gave 6: three unsent rows moved the 2-value rotation.
    expect(stat.callsTotal).toBe(3);
    // Money and display fields are unchanged: every row's price, the newest row of any kind.
    expect(stat.spentTodayUsd).toBeCloseTo(0.03, 9);
    expect(stat.lastError).toBe('clawpump_timeout');
    expect(stat.lastOk).toBe(false);
  });
});
