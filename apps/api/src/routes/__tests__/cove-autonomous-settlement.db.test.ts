/**
 * Real-Postgres money-path coverage for autonomous Cove play.
 *
 * This suite deliberately bypasses HTTP avatar creation: the fixture user,
 * avatar, and agent row are direct inserts, so no KEK/Cloudflare wallet worker
 * is needed. The settlement itself is not mocked; slots and blackjack execute
 * their production transactions, advisory locks, FOR UPDATE checks, cap SQL,
 * ledger writes, and idempotency lookups against DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { AgentSubstrateClient } from '../../services/agent-substrate-client';
import {
  __resetSpinRateLimit,
  playAutonomousCoveSlots,
} from '../cove-slots';
import {
  __resetBlackjackRateLimits,
  playAutonomousCoveBlackjack,
} from '../cove-blackjack';
import { autonomousCoveDailyUsageQuery } from '../../services/autonomous-cove-wager-cap';
import { buildHostedAvatarAgentConfig } from '../../services/hosted-avatar-agent-session-plan';
import { npcSimulation } from '../../services/npc-simulation';
import { houseTreasurySeeder } from '../../services/house-treasury-seeder';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const dbMod = process.env.DATABASE_URL ? ((await import('@clawville/database')) as any) : null;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeIfDb('autonomous Cove settlement — real PostgreSQL money path', () => {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const email = `cove-autonomous-db-${suffix}@clawville-test.invalid`;
  const avatarName = `CoveDb${Date.now().toString(36)}${Math.floor(Math.random() * 10_000)}`;
  const agentId = `cove-db-agent-${suffix}`;
  const bearer = `cove-db-bearer-${suffix}`;
  const originalCap = process.env.AGENT_COVE_PLAY_DAILY_WAGER_VCLAW;

  let userId = '';
  let avatarId = '';
  let botId = '';
  let treasuryAvatarId = '';
  const freshSlotSpinIds = new Set<string>();
  const freshBlackjackHandIds = new Set<string>();
  const blackjackActionIds = new Set<string>();

  const boundResolution = () => Promise.resolve({
    userId,
    avatarId,
    agentId,
    ledgerCapable: true,
  });

  const slotsInput = (actionId: string, wager = 20) => ({
    agentSessionId: bearer,
    expectedAgentId: agentId,
    expectedAvatarId: avatarId,
    expectedUserId: userId,
    actionId,
    wager,
  });

  const blackjackInput = (actionId: string, wager = 20) => ({
    agentSessionId: bearer,
    expectedAgentId: agentId,
    expectedAvatarId: avatarId,
    actionId,
    wager,
  });

  async function playSlots(
    input: ReturnType<typeof slotsInput>,
    dependencies: Parameters<typeof playAutonomousCoveSlots>[1] = { resolveAgent: boundResolution },
  ) {
    const result = await playAutonomousCoveSlots(input, dependencies);
    if (!result.idempotencyReplay) freshSlotSpinIds.add(result.spinId);
    return result;
  }

  async function playBlackjack(
    input: ReturnType<typeof blackjackInput>,
    resolver: Parameters<typeof playAutonomousCoveBlackjack>[1] = boundResolution,
  ) {
    const result = await playAutonomousCoveBlackjack(input, resolver);
    if (!result.idempotencyReplay) {
      freshBlackjackHandIds.add(result.handId);
      blackjackActionIds.add(input.actionId);
    }
    return result;
  }

  async function rowsForAction(actionId: string) {
    return dbMod.db
      .select()
      .from(dbMod.clawTokenTransactions)
      .where(sql`${dbMod.clawTokenTransactions.metadata} ->> 'autonomousActionId' = ${actionId}`);
  }

  async function avatarBalance(id = avatarId) {
    const row = await dbMod.db.query.avatars.findFirst({ where: eq(dbMod.avatars.id, id) });
    expect(row).toBeTruthy();
    return row;
  }

  async function blackjackSnapshot() {
    const rows = await dbMod.db.execute(sql`
      SELECT
        (SELECT count(*) FROM blackjack_shoes s WHERE s.user_id = ${userId})::int AS shoes,
        (SELECT count(*) FROM blackjack_hands h
          JOIN blackjack_shoes s ON s.id = h.shoe_id
          WHERE s.user_id = ${userId})::int AS hands,
        (SELECT count(*) FROM cove_game_events e
          WHERE e.user_id = ${userId} AND e.game_type = 'blackjack')::int AS cove_events,
        (SELECT count(*) FROM claw_token_transactions t
          WHERE t.avatar_id = ${avatarId})::int AS ledger_rows
    `);
    const row = rows[0] ?? {};
    return {
      shoes: Number(row.shoes ?? 0),
      hands: Number(row.hands ?? 0),
      coveEvents: Number(row.cove_events ?? 0),
      ledgerRows: Number(row.ledger_rows ?? 0),
    };
  }

  async function waitForBlackjackEvent(handId: string, required = true) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await dbMod.db.execute(sql`
        SELECT id FROM events
        WHERE user_id = ${userId}
          AND event_type = 'cove.blackjack.hand.settled'
          AND payload ->> 'handId' = ${handId}
        LIMIT 1
      `);
      if (rows[0]) return rows[0].id;
      await delay(25);
    }
    if (required) throw new Error(`timed out waiting for durable blackjack settle event ${handId}`);
    return null;
  }

  async function drainPostCommitSideEffects() {
    // Row-driven drain for every known fresh result. The final bounded fallback
    // handles a deliberately non-fatal observability/memory write failure while
    // still keeping cleanup deterministic on a normally functioning full schema.
    for (const spinId of freshSlotSpinIds) {
      for (let attempt = 0; attempt < 200; attempt++) {
        const rows = await dbMod.db.execute(sql`
          SELECT id FROM events
          WHERE user_id = ${userId}
            AND event_type = 'cove.slots.spin.executed'
            AND payload ->> 'spinId' = ${spinId}
          LIMIT 1
        `);
        if (rows[0]) break;
        await delay(25);
      }
    }
    for (const handId of freshBlackjackHandIds) {
      await waitForBlackjackEvent(handId, false);
      for (let attempt = 0; attempt < 200; attempt++) {
        const rows = await dbMod.db.execute(sql`
          SELECT id FROM npc_memories
          WHERE entity_id = ${avatarId}
            AND metadata ->> 'handId' = ${handId}
          LIMIT 1
        `);
        if (rows[0]) break;
        await delay(25);
      }
    }
  }

  async function removeTrackedTreasuryCredits() {
    if (!treasuryAvatarId || blackjackActionIds.size === 0) return;
    await dbMod.db.transaction(async (tx: any) => {
      const locked = await tx.execute(sql`
        SELECT claw_tokens, soft_balance, bought_balance, earned_balance
        FROM avatars WHERE id = ${treasuryAvatarId} FOR UPDATE
      `);
      const treasury = locked[0];
      if (!treasury) throw new Error('test treasury avatar disappeared during cleanup');
      const ids: string[] = [];
      let soft = 0;
      let bought = 0;
      let earned = 0;
      for (const actionId of blackjackActionIds) {
        const rows = await tx.execute(sql`
          SELECT id, amount, provenance
          FROM claw_token_transactions
          WHERE avatar_id = ${treasuryAvatarId}
            AND amount > 0
            AND metadata ->> 'autonomousGame' = 'blackjack'
            AND metadata ->> 'autonomousActionId' = ${actionId}
        `);
        for (const row of rows) {
          ids.push(row.id);
          if (row.provenance === 'bought') bought += Number(row.amount);
          else if (row.provenance === 'earned') earned += Number(row.amount);
          else soft += Number(row.amount);
        }
      }
      const total = soft + bought + earned;
      if (total === 0) return;
      if (
        Number(treasury.claw_tokens) < total
        || Number(treasury.soft_balance) < soft
        || Number(treasury.bought_balance) < bought
        || Number(treasury.earned_balance) < earned
      ) {
        throw new Error('test treasury cleanup would underflow a provenance balance');
      }
      await tx.update(dbMod.avatars).set({
        clawTokens: Number(treasury.claw_tokens) - total,
        softBalance: Number(treasury.soft_balance) - soft,
        boughtBalance: Number(treasury.bought_balance) - bought,
        earnedBalance: Number(treasury.earned_balance) - earned,
      }).where(eq(dbMod.avatars.id, treasuryAvatarId));
      for (const id of ids) {
        await tx.delete(dbMod.clawTokenTransactions).where(eq(dbMod.clawTokenTransactions.id, id));
      }
    });
    blackjackActionIds.clear();
  }

  async function clearPlayerMoneyPathRows() {
    if (!userId) return;
    // Post-commit blackjack observability/memory writes are best-effort. Give
    // them a chance to land before removing their non-FK memory rows.
    await delay(25);
    await dbMod.db.delete(dbMod.npcMemories).where(eq(dbMod.npcMemories.entityId, avatarId));
    await dbMod.db.delete(dbMod.events).where(eq(dbMod.events.userId, userId));
    await dbMod.db.delete(dbMod.coveGameEvents).where(eq(dbMod.coveGameEvents.userId, userId));

    const slotRows = await dbMod.db
      .select({ id: dbMod.slotSessions.id })
      .from(dbMod.slotSessions)
      .where(eq(dbMod.slotSessions.userId, userId));
    for (const row of slotRows) {
      await dbMod.db.delete(dbMod.slotSpins).where(eq(dbMod.slotSpins.sessionId, row.id));
    }
    await dbMod.db.delete(dbMod.slotSessions).where(eq(dbMod.slotSessions.userId, userId));

    const shoeRows = await dbMod.db
      .select({ id: dbMod.blackjackShoes.id })
      .from(dbMod.blackjackShoes)
      .where(eq(dbMod.blackjackShoes.userId, userId));
    for (const row of shoeRows) {
      await dbMod.db.delete(dbMod.blackjackHands).where(eq(dbMod.blackjackHands.shoeId, row.id));
    }
    await dbMod.db.delete(dbMod.blackjackShoes).where(eq(dbMod.blackjackShoes.userId, userId));
    await dbMod.db
      .delete(dbMod.clawTokenTransactions)
      .where(eq(dbMod.clawTokenTransactions.avatarId, avatarId));
    await dbMod.db
      .update(dbMod.avatars)
      .set({
        clawTokens: 100_000,
        softBalance: 100_000,
        boughtBalance: 0,
        earnedBalance: 0,
        isActive: true,
      })
      .where(eq(dbMod.avatars.id, avatarId));
  }

  async function expectCode(promise: Promise<unknown>, code: string, status?: number) {
    try {
      await promise;
      throw new Error(`expected ${code}`);
    } catch (error) {
      expect((error as { code?: string }).code).toBe(code);
      if (status !== undefined) expect((error as { status?: number }).status).toBe(status);
    }
  }

  beforeAll(async () => {
    const [user] = await dbMod.db
      .insert(dbMod.users)
      .values({
        email,
        passwordHash: `$test$disabled$${suffix}`,
        emailVerified: true,
        name: 'Autonomous Cove DB Test',
        isGuest: false,
      })
      .returning({ id: dbMod.users.id });
    userId = user.id;

    const [avatar] = await dbMod.db
      .insert(dbMod.avatars)
      .values({
        userId,
        name: avatarName,
        species: 'cat',
        color: 'green',
        gender: 'male',
        archetype: 'curious-scholar',
        personality: { habitat: 'reef', hobby: 'testing', greeting: 'hello' },
        stats: { strength: 5, defence: 5, movement: 5 },
        clawTokens: 100_000,
        softBalance: 100_000,
        boughtBalance: 0,
        earnedBalance: 0,
        isActive: true,
        isGuest: false,
      })
      .returning({ id: dbMod.avatars.id });
    avatarId = avatar.id;

    const [bot] = await dbMod.db
      .insert(dbMod.agentBots)
      .values({
        agentId,
        identityType: 'custom',
        protocol: 'nanoclaw',
        mode: 'avatar',
        name: avatarName,
        species: 'lobster',
        userId,
        sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        sessionKeyHash: createHash('sha256').update(bearer).digest('hex'),
      })
      .returning({ id: dbMod.agentBots.id });
    botId = bot.id;

    const config = buildHostedAvatarAgentConfig({
      agentId,
      sessionId: bearer,
      ownerUserId: userId,
      avatarId,
      modelKey: 'lobster',
      name: avatarName,
    });
    npcSimulation.registerAgentBot(
      config,
      { getProtocol: () => 'nanoclaw' } as unknown as AgentSubstrateClient,
    );

    // Blackjack rake is routed through the production singleton. Provision it
    // using the production direct-DB seeder (never the avatar HTTP route).
    await houseTreasurySeeder.ensure();
    treasuryAvatarId = houseTreasurySeeder.houseTreasuryAvatarId();
  });

  beforeEach(async () => {
    process.env.AGENT_COVE_PLAY_DAILY_WAGER_VCLAW = '1000000';
    __resetSpinRateLimit();
    __resetBlackjackRateLimits();
    await drainPostCommitSideEffects();
    await removeTrackedTreasuryCredits();
    await clearPlayerMoneyPathRows();
    freshSlotSpinIds.clear();
    freshBlackjackHandIds.clear();
  });

  afterAll(async () => {
    if (originalCap === undefined) delete process.env.AGENT_COVE_PLAY_DAILY_WAGER_VCLAW;
    else process.env.AGENT_COVE_PLAY_DAILY_WAGER_VCLAW = originalCap;
    npcSimulation.unregisterAgentBot(bearer);
    await drainPostCommitSideEffects();
    await removeTrackedTreasuryCredits();
    await clearPlayerMoneyPathRows();
    // covenant_action_records are intentionally append-only; full-schema
    // migration 0029 forbids DELETE. The reviewer disposes this throwaway DB,
    // while every mutable fixture/ledger/balance row is reversed above.
    if (botId) await dbMod.db.delete(dbMod.agentBots).where(eq(dbMod.agentBots.id, botId));
    if (avatarId) await dbMod.db.delete(dbMod.avatars).where(eq(dbMod.avatars.id, avatarId));
    if (userId) await dbMod.db.delete(dbMod.users).where(eq(dbMod.users.id, userId));
  });

  it('slots: one autonomous spin writes the gross stake debit and exact net avatar delta', async () => {
    const before = await avatarBalance();
    const actionId = randomUUID();
    const result = await playSlots(slotsInput(actionId), {
      resolveAgent: boundResolution,
    });

    const rows = await dbMod.db
      .select()
      .from(dbMod.clawTokenTransactions)
      .where(eq(dbMod.clawTokenTransactions.avatarId, avatarId));
    const debits = rows.filter((row: any) => row.amount < 0);
    const credits = rows.filter((row: any) => row.amount > 0);
    expect(debits).toHaveLength(1);
    expect(debits[0].amount).toBe(-20);
    expect(debits[0].metadata?.autonomousCove).toBe(true);
    expect(debits[0].metadata?.autonomousActionId).toBe(actionId);
    expect(credits.reduce((sum: number, row: any) => sum + row.amount, 0)).toBe(Number(result.winAmount));

    const after = await avatarBalance();
    expect(after.clawTokens - before.clawTokens).toBe(Number(result.winAmount) - 20);
    expect(after.clawTokens).toBe(after.softBalance + after.boughtBalance + after.earnedBalance);
  });

  it('slots: daily cap consumes gross tagged debits and a refused second play writes no debit', async () => {
    process.env.AGENT_COVE_PLAY_DAILY_WAGER_VCLAW = '40';
    await playSlots(slotsInput(randomUUID(), 20), { resolveAgent: boundResolution });
    const debitsBefore = (await dbMod.db
      .select()
      .from(dbMod.clawTokenTransactions)
      .where(and(
        eq(dbMod.clawTokenTransactions.avatarId, avatarId),
        sql`${dbMod.clawTokenTransactions.amount} < 0`,
        sql`${dbMod.clawTokenTransactions.metadata} ->> 'autonomousCove' = 'true'`,
      ))).length;

    const refusedAction = randomUUID();
    await expectCode(
      playSlots(slotsInput(refusedAction, 40), { resolveAgent: boundResolution }),
      'daily_cap_exceeded',
      429,
    );
    expect(await rowsForAction(refusedAction)).toHaveLength(0);
    const debitsAfter = (await dbMod.db
      .select()
      .from(dbMod.clawTokenTransactions)
      .where(and(
        eq(dbMod.clawTokenTransactions.avatarId, avatarId),
        sql`${dbMod.clawTokenTransactions.amount} < 0`,
        sql`${dbMod.clawTokenTransactions.metadata} ->> 'autonomousCove' = 'true'`,
      ))).length;
    expect(debitsAfter).toBe(debitsBefore);
  });

  it('slots: changed live binding is rejected before any ledger write', async () => {
    const actionId = randomUUID();
    await expectCode(
      playSlots(slotsInput(actionId), {
        resolveAgent: async () => ({
          userId: randomUUID(),
          avatarId: randomUUID(),
          agentId: `${agentId}-changed`,
          ledgerCapable: true,
        }),
      }),
      'live_agent_avatar_binding_changed',
      403,
    );
    expect(await rowsForAction(actionId)).toHaveLength(0);
  });

  it('slots: an avatar deactivated after inner resolution is rejected by the transaction binding lock', async () => {
    const [session] = await dbMod.db.insert(dbMod.slotSessions).values({
      userId,
      guestFpHash: null,
      paytableId: 'classic-3x5',
      currency: 'clawtokens',
      serverSeed: 'a'.repeat(64),
      serverSeedHash: createHash('sha256').update('a'.repeat(64)).digest('hex'),
      clientSeed: '0123456789abcdef',
      startingBalance: '20',
      currentBalance: '0',
    }).returning({ id: dbMod.slotSessions.id });

    let release!: () => void;
    let locked!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
    const locker = dbMod.db.transaction(async (tx: any) => {
      await tx.execute(sql`SELECT id FROM slot_sessions WHERE id = ${session.id} FOR UPDATE`);
      locked();
      await releasePromise;
    });
    await lockedPromise;

    const actionId = randomUUID();
    const play = playSlots(slotsInput(actionId), { resolveAgent: boundResolution });
    try {
      let observedWait = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await dbMod.db.execute(sql`
          SELECT count(*)::int AS waiting
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND query ILIKE '%slot_sessions%'
        `);
        if (Number(waiting[0]?.waiting ?? 0) > 0) {
          observedWait = true;
          break;
        }
        await delay(10);
      }
      expect(observedWait).toBe(true);
      await dbMod.db.update(dbMod.avatars).set({ isActive: false }).where(eq(dbMod.avatars.id, avatarId));
    } finally {
      release();
      await locker;
    }
    await expectCode(play, 'active_avatar_binding_changed', 403);
    expect(await rowsForAction(actionId)).toHaveLength(0);
  });

  it('slots: owner-scoped action replay survives session rotation and mismatched args return 409', async () => {
    const actionId = randomUUID();
    const first = await playSlots(slotsInput(actionId), { resolveAgent: boundResolution });
    const [spin] = await dbMod.db
      .select({ sessionId: dbMod.slotSpins.sessionId })
      .from(dbMod.slotSpins)
      .where(eq(dbMod.slotSpins.id, first.spinId));
    await dbMod.db
      .update(dbMod.slotSessions)
      .set({ status: 'closed', closedAt: new Date() })
      .where(eq(dbMod.slotSessions.id, spin.sessionId));
    await dbMod.db.insert(dbMod.slotSessions).values({
      userId,
      guestFpHash: null,
      paytableId: 'classic-3x5',
      currency: 'clawtokens',
      serverSeed: 'b'.repeat(64),
      serverSeedHash: createHash('sha256').update('b'.repeat(64)).digest('hex'),
      clientSeed: 'fedcba9876543210',
      startingBalance: '20',
      currentBalance: '0',
    });
    const debitCount = (await rowsForAction(actionId)).filter((row: any) => row.amount < 0).length;

    const replay = await playSlots(slotsInput(actionId), { resolveAgent: boundResolution });
    expect(replay.spinId).toBe(first.spinId);
    expect(replay.idempotencyReplay).toBe(true);
    expect((await rowsForAction(actionId)).filter((row: any) => row.amount < 0)).toHaveLength(debitCount);
    await expectCode(
      playSlots(slotsInput(actionId, 40), { resolveAgent: boundResolution }),
      'idempotency_key_reused_with_different_args',
      409,
    );
    expect((await rowsForAction(actionId)).filter((row: any) => row.amount < 0)).toHaveLength(debitCount);
  });

  it('slots: invalid, non-ledger, and unbound resolution never reaches settlement', async () => {
    for (const resolution of [
      null,
      { userId, avatarId, agentId, ledgerCapable: false },
      { userId: null, avatarId: null, agentId, ledgerCapable: true },
    ]) {
      const actionId = randomUUID();
      const promise = playSlots(slotsInput(actionId), {
        resolveAgent: async () => resolution as any,
      });
      const code = resolution === null
        ? 'invalid_or_expired_agent_session'
        : resolution.ledgerCapable === false
          ? 'agent_session_not_ledger_authorized'
          : 'agent_session_has_no_active_avatar';
      await expectCode(promise, code);
      expect(await rowsForAction(actionId)).toHaveLength(0);
    }
  });

  it('slots: the real internal spin rate gate refuses play 61 with no settlement write', async () => {
    process.env.AGENT_COVE_PLAY_DAILY_WAGER_VCLAW = '1000000';
    for (let spin = 0; spin < 60; spin++) {
      await playSlots(slotsInput(randomUUID(), 20), { resolveAgent: boundResolution });
    }
    const refusedAction = randomUUID();
    await expectCode(
      playSlots(slotsInput(refusedAction, 20), { resolveAgent: boundResolution }),
      'cove_slots_rate_limit',
      429,
    );
    expect(await rowsForAction(refusedAction)).toHaveLength(0);
  });

  it('blackjack: a raked autonomous hand settles stake, payout, treasury, history, and balance invariants', async () => {
    let selected: any = null;
    let actionId = '';
    let before: any = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      actionId = randomUUID();
      before = await avatarBalance();
      const result = await playBlackjack(
        blackjackInput(actionId, 100),
        boundResolution,
      );
      if (Number(result.rake) > 0) {
        selected = result;
        break;
      }
    }
    expect(selected).toBeTruthy();

    const rows = await rowsForAction(actionId);
    const playerRows = rows.filter((row: any) => row.avatarId === avatarId);
    const treasuryRows = rows.filter((row: any) => row.avatarId === treasuryAvatarId);
    const stakeRows = playerRows.filter((row: any) => row.amount < 0);
    const payoutRows = playerRows.filter((row: any) => row.amount > 0);
    expect(stakeRows.length).toBeGreaterThan(0);
    expect(stakeRows.every((row: any) => row.reason === 'cove_blackjack_autonomous_stake')).toBe(true);
    expect(payoutRows.length).toBeGreaterThan(0);
    expect(payoutRows.every((row: any) => row.reason === 'cove_blackjack_payout')).toBe(true);
    expect(treasuryRows.length).toBeGreaterThan(0);
    expect(treasuryRows.every((row: any) => row.reason === 'house_fee_blackjack_rake')).toBe(true);
    for (const row of [...stakeRows, ...payoutRows, ...treasuryRows]) {
      expect(row.metadata?.autonomousCove).toBe(true);
      expect(row.metadata?.autonomousGame).toBe('blackjack');
      expect(row.metadata?.autonomousActionId).toBe(actionId);
      expect(row.metadata?.handId).toBe(selected.handId);
    }
    const debit = -stakeRows
      .reduce((sum: number, row: any) => sum + row.amount, 0);
    const payoutCredit = payoutRows
      .reduce((sum: number, row: any) => sum + row.amount, 0);
    const rakeCredit = treasuryRows.reduce((sum: number, row: any) => sum + row.amount, 0);
    expect(debit).toBe(Number(selected.totalBet));
    expect(rakeCredit).toBe(Number(selected.rake));
    // The ledger is burn/mint (no house-bank stake row): gross payout is split
    // exactly between the player's raked credit and the named treasury rake.
    expect(payoutCredit + rakeCredit).toBe(Number(selected.totalPayout));

    const after = await avatarBalance();
    expect(after.clawTokens - before.clawTokens).toBe(payoutCredit - debit);
    expect(after.clawTokens).toBe(after.softBalance + after.boughtBalance + after.earnedBalance);
    const hand = await dbMod.db.query.blackjackHands.findFirst({
      where: eq(dbMod.blackjackHands.id, selected.handId),
    });
    expect(hand?.status).toBe('settled');
    const event = await dbMod.db.query.coveGameEvents.findFirst({
      where: and(
        eq(dbMod.coveGameEvents.sessionId, selected.shoeId),
        eq(dbMod.coveGameEvents.gameType, 'blackjack'),
        eq(dbMod.coveGameEvents.nonce, selected.handIndex),
        sql`${dbMod.coveGameEvents.outcomeJson} ->> 'autonomousActionId' = ${actionId}`,
      ),
    });
    expect(event?.betAmount).toBe(selected.totalBet);
    expect(event?.payout).toBe(String(payoutCredit));
  });

  it('blackjack: 4x worst-case cap rejects before shoe, cards, history, or ledger mutation', async () => {
    process.env.AGENT_COVE_PLAY_DAILY_WAGER_VCLAW = '40';
    await dbMod.db.transaction(async (tx: any) => {
      await tx.update(dbMod.avatars)
        .set({ clawTokens: 99_980, softBalance: 99_980 })
        .where(eq(dbMod.avatars.id, avatarId));
      await tx.insert(dbMod.clawTokenTransactions).values({
        avatarId,
        userId,
        amount: -20,
        balanceAfter: 99_980,
        reason: 'db_test_prior_autonomous_wager',
        source: 'system',
        provenance: 'soft',
        metadata: { autonomousCove: true, autonomousGame: 'slots', dbTest: true },
      });
    });
    const before = await blackjackSnapshot();
    const actionId = randomUUID();
    await expectCode(
      playBlackjack(blackjackInput(actionId, 20), boundResolution),
      'daily_cap_exceeded',
      429,
    );
    expect(await blackjackSnapshot()).toEqual(before);
    expect(await rowsForAction(actionId)).toHaveLength(0);
  });

  it('blackjack: action replay is owner-scoped across shoe rotation and never settles twice', async () => {
    const actionId = randomUUID();
    const first = await playBlackjack(blackjackInput(actionId), boundResolution);
    await waitForBlackjackEvent(first.handId);
    const fixtureSnapshot = await blackjackSnapshot();
    const before = {
      rows: (await rowsForAction(actionId)).length,
      publishedEvents: (await dbMod.db
        .select()
        .from(dbMod.events)
        .where(and(
          eq(dbMod.events.userId, userId),
          eq(dbMod.events.eventType, 'cove.blackjack.hand.settled'),
          sql`${dbMod.events.payload} ->> 'handId' = ${first.handId}`,
        ))).length,
    };
    await dbMod.db.update(dbMod.blackjackShoes)
      .set({ status: 'closed', closedAt: new Date() })
      .where(eq(dbMod.blackjackShoes.id, first.shoeId));
    await dbMod.db.insert(dbMod.blackjackShoes).values({
      userId,
      guestFpHash: null,
      currency: 'clawtoken',
      serverSeed: 'c'.repeat(64),
      serverSeedHash: createHash('sha256').update('c'.repeat(64)).digest('hex'),
      clientSeed: '0011223344556677',
      startingBalance: '0',
    });

    const replay = await playBlackjack(blackjackInput(actionId), boundResolution);
    expect(replay.handId).toBe(first.handId);
    expect(replay.shoeId).toBe(first.shoeId);
    expect(replay.idempotencyReplay).toBe(true);
    expect((await rowsForAction(actionId)).length).toBe(before.rows);
    // The manually-created replacement shoe is the only intended snapshot delta.
    const afterReplaySnapshot = await blackjackSnapshot();
    expect(afterReplaySnapshot.hands).toBe(fixtureSnapshot.hands);
    expect(afterReplaySnapshot.coveEvents).toBe(fixtureSnapshot.coveEvents);
    expect(afterReplaySnapshot.ledgerRows).toBe(fixtureSnapshot.ledgerRows);
    expect(afterReplaySnapshot.shoes).toBe(fixtureSnapshot.shoes + 1);
    // A replay must not start another fire-and-forget durable settle event.
    // Observe a bounded quiescence window so an async duplicate cannot land
    // just after a single immediate count and produce a false green.
    for (let attempt = 0; attempt < 40; attempt++) {
      const durableRows = await dbMod.db
        .select()
        .from(dbMod.events)
        .where(and(
          eq(dbMod.events.userId, userId),
          eq(dbMod.events.eventType, 'cove.blackjack.hand.settled'),
          sql`${dbMod.events.payload} ->> 'handId' = ${first.handId}`,
        ));
      expect(durableRows).toHaveLength(before.publishedEvents);
      await delay(25);
    }
  });

  it('blackjack: daily usage is counted by DB UTC date_trunc(now()), including midnight and excluding the prior second', async () => {
    await dbMod.db.transaction(async (tx: any) => {
      // PostgreSQL now() is transaction-start scoped: both fixture timestamps
      // and admission window therefore use the identical DB clock, even if the
      // wall clock crosses UTC midnight while this test is running.
      await tx.execute(sql`
        INSERT INTO claw_token_transactions
          (avatar_id, user_id, amount, balance_after, reason, source, provenance, metadata, created_at)
        VALUES
          (${avatarId}, ${userId}, -7, 99993, 'db_test_utc_old', 'system', 'soft',
           '{"autonomousCove":true,"dbTest":"utc-old"}'::jsonb,
           (date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc') - interval '1 second'),
          (${avatarId}, ${userId}, -11, 99982, 'db_test_utc_boundary', 'system', 'soft',
           '{"autonomousCove":true,"dbTest":"utc-boundary"}'::jsonb,
           date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'),
          (${avatarId}, ${userId}, -13, 99969, 'db_test_utc_now', 'system', 'soft',
           '{"autonomousCove":true,"dbTest":"utc-now"}'::jsonb, now())
      `);
      const usage = await tx.execute(autonomousCoveDailyUsageQuery(avatarId));
      expect(Number(usage[0]?.used_vclaw)).toBe(24);
      await tx.update(dbMod.avatars)
        .set({ clawTokens: 99_969, softBalance: 99_969 })
        .where(eq(dbMod.avatars.id, avatarId));
    });
  });

  it('blackjack: binding, active-avatar, non-ledger, and unbound failures write no hand or debit', async () => {
    const cases: Array<{ code: string; resolution: any; deactivate?: boolean }> = [
      {
        code: 'live_agent_avatar_binding_changed',
        resolution: { userId: randomUUID(), avatarId: randomUUID(), agentId: `${agentId}-changed`, ledgerCapable: true },
      },
      {
        code: 'active_avatar_binding_changed',
        resolution: { userId, avatarId, agentId, ledgerCapable: true },
        deactivate: true,
      },
      {
        code: 'agent_session_not_ledger_authorized',
        resolution: { userId, avatarId, agentId, ledgerCapable: false },
      },
      {
        code: 'agent_session_has_no_active_avatar',
        resolution: { userId: null, avatarId: null, agentId, ledgerCapable: true },
      },
    ];
    for (const entry of cases) {
      if (entry.deactivate) {
        await dbMod.db.update(dbMod.avatars).set({ isActive: false }).where(eq(dbMod.avatars.id, avatarId));
      }
      const actionId = randomUUID();
      const before = await blackjackSnapshot();
      await expectCode(
        playBlackjack(
          blackjackInput(actionId),
          async () => entry.resolution,
        ),
        entry.code,
      );
      expect((await blackjackSnapshot()).hands).toBe(before.hands);
      expect(await rowsForAction(actionId)).toHaveLength(0);
      if (entry.deactivate) {
        await dbMod.db.update(dbMod.avatars).set({ isActive: true }).where(eq(dbMod.avatars.id, avatarId));
      }
    }
  });
});
