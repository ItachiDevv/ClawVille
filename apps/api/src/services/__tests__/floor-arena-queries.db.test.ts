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
      at, priceUsd: 0.01, dayStart, walletUsdc: 10, check: () => ({ ok: true }),
    });
    expect(reservation.reserved).toBe(true);
    const id = (reservation as { id: number }).id;
    // The standing agent cannot reserve at all.
    const refused = await q.reserveArenaAddonCall({
      agentId: ids.standing, addonId: 'nansen-token-screener-sol', clawpumpAgentId: ids.cp2,
      at, priceUsd: 0.01, dayStart, walletUsdc: 10, check: () => ({ ok: true }),
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
      at, priceUsd: 0.01, dayStart, walletUsdc: 10, check: () => ({ ok: true }),
    });
    const secondId = (second as { id: number }).id;
    await q.setArenaAgentSeat(ids.seated, false, null, 'Stood up');
    expect(await q.confirmArenaAddonDispatch({
      reservationId: secondId, agentId: ids.seated, addonId: 'nansen-token-screener-sol', clawpumpAgentId: ids.cp1, paused: () => false,
    })).toEqual({ ok: false, reason: 'agent_changed' });
    await q.setArenaAgentSeat(ids.seated, true, 0, 'Sat down');
    const third = await q.reserveArenaAddonCall({
      agentId: ids.seated, addonId: 'nansen-token-screener-sol', clawpumpAgentId: ids.cp1,
      at, priceUsd: 0.01, dayStart, walletUsdc: 10, check: () => ({ ok: true }),
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

  test('privacy repair: the sweep page lists every ready/failed user agent with a ClawPump agent, from a cursor, in id order', async () => {
    const q = await import('../floor-arena/queries');
    const page = await q.readArenaClawPumpSweepAgents('', 100_000);
    for (const id of [ids.seated, ids.offReady, ids.offFailed]) expect(page).toContain(id);
    expect(page).not.toContain(ids.offPending);
    const mine = page.filter((id) => id === ids.offReady || id === ids.offFailed);
    const after = await q.readArenaClawPumpSweepAgents(mine[0]!, 100_000);
    expect(after).not.toContain(mine[0]);
    expect(after).toContain(mine[1]);
    expect(await q.readArenaClawPumpSweepAgents('', 1)).toHaveLength(1);
    // The x402 reconcile queries and lock were removed with the skill sync (founder 2026-11-19).
    for (const gone of ['readArenaX402RecentOff', 'readArenaX402OffAgents', 'readArenaX402SweepAgents', 'tryWithArenaX402Lock', 'readArenaAgentLocked', 'readDbNow']) {
      expect(gone in q).toBe(false);
    }
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

  test('Codex r2 B2 follow-up: countArenaCreateAttempt counts only for the live claim and below the cap', async () => {
    const q = await import('../floor-arena/queries');
    const { db, sql } = await import('@clawville/database');
    // offPending: a 'pending' user row with no attempts yet.
    const now = new Date();
    const claimed = await q.claimArenaProvision(ids.offPending, now, 5, 10 * 60_000);
    expect(claimed).not.toBeNull();
    const lease = claimed!.provisionNextAt!;
    expect(await q.countArenaCreateAttempt(ids.offPending, lease, 5)).toBe(1);
    expect(await q.countArenaCreateAttempt(ids.offPending, lease, 5)).toBe(2);
    // A stale lease (the claim was lost) counts nothing.
    expect(await q.countArenaCreateAttempt(ids.offPending, new Date(lease.getTime() - 1000), 5)).toBeNull();
    // At the cap it counts nothing.
    await db.execute(sql`UPDATE floor_arena_agents SET provision_attempts = 5 WHERE id = ${ids.offPending}`);
    expect(await q.countArenaCreateAttempt(ids.offPending, lease, 5)).toBeNull();
    expect((await q.readArenaAgent(ids.offPending))!.provisionAttempts).toBe(5);
    // A row that is not 'creating' (released by markFailed) counts nothing.
    await db.execute(sql`UPDATE floor_arena_agents SET provision_attempts = 1 WHERE id = ${ids.offPending}`);
    expect(await q.markArenaProvisionFailed(ids.offPending, 'test', 1, null, lease)).toBe(true);
    expect(await q.countArenaCreateAttempt(ids.offPending, lease, 5)).toBeNull();
    expect(await q.readArenaAgent(ids.offPending)).toMatchObject({ provisionState: 'failed', provisionAttempts: 1 });
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
