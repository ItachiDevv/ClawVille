import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  agentBots,
  avatars,
  db,
  eq,
  events,
  inArray,
  tradingWallets,
  users,
} from '@clawville/database';
import {
  TRADE_DAILY_SCORED_CAP,
  TRADE_EVENT_TYPE,
  TRADE_TIER_MULTIPLIER,
  TRADE_TIER_WEIGHTS,
  type TradeMultiplierTier,
} from '@clawville/shared';
import { buildAgentSnapshot } from '../leaderboard';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const leaderboardSource = await Bun.file(new URL('../leaderboard.ts', import.meta.url)).text();

describe('Trading Floor leaderboard drift guards', () => {
  test('pins the three tier weights', () => {
    expect(TRADE_TIER_WEIGHTS).toEqual({ base: 20, clv: 30, ansem: 40 });
  });

  test('pins the tier multiplier ratios against base', () => {
    expect(TRADE_TIER_MULTIPLIER.base / TRADE_TIER_MULTIPLIER.base).toBe(1);
    expect(TRADE_TIER_MULTIPLIER.clv / TRADE_TIER_MULTIPLIER.base).toBe(1.5);
    expect(TRADE_TIER_MULTIPLIER.ansem / TRADE_TIER_MULTIPLIER.base).toBe(2);
  });

  test('pins the shared daily scored cap', () => {
    expect(TRADE_DAILY_SCORED_CAP).toBe(20);
  });

  test('keeps agent and avatar UTC trade-day CTEs', () => {
    expect(leaderboardSource).toContain('agent_trade_daily AS');
    expect(leaderboardSource).toContain('avatar_trade_daily AS');
    expect(leaderboardSource.match(/\(ts AT TIME ZONE 'UTC'\)::date/g)?.length).toBeGreaterThanOrEqual(4);
  });

  test('caps both subject legs before score projection', () => {
    expect(leaderboardSource).toContain('agent_trade_scores AS');
    expect(leaderboardSource).toContain('avatar_trade_scores AS');
    expect(leaderboardSource.match(/LEAST\(trade_total_c,/g)?.length).toBe(4);
  });

  test('never casts multiplierTier in a FILTER predicate', () => {
    expect(leaderboardSource).not.toContain("payload->>'multiplierTier')::");
  });
});

describeIfDb('Trading Floor leaderboard scoring (requires DATABASE_URL)', () => {
  const eventIds: bigint[] = [];
  const botIds: string[] = [];
  const userIds: string[] = [];

  type Subject = {
    kind: 'agent' | 'avatar';
    userId: string;
    avatarId: string;
    agentId: string | null;
  };

  async function createSubject(input: {
    kind: 'agent' | 'avatar';
    isGuest?: boolean;
    isHouse?: boolean;
    leaderboardEligible?: boolean;
    withUser?: boolean;
  }): Promise<Subject> {
    if (input.withUser === false) {
      const agentId = `floor-orphan-${randomUUID()}`;
      const [bot] = await db.insert(agentBots).values({
        agentId,
        mode: 'autonomous',
        isHouse: input.isHouse ?? false,
        leaderboardEligible: input.leaderboardEligible ?? true,
      }).returning({ id: agentBots.id });
      botIds.push(bot.id);
      return { kind: 'agent', userId: '', avatarId: '', agentId };
    }

    const fingerprint = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    const [user] = await db.insert(users).values({
      identityFingerprint: fingerprint,
      name: 'Trading Floor scoring test',
      isGuest: input.isGuest ?? false,
    }).returning({ id: users.id });
    userIds.push(user.id);
    const [avatar] = await db.insert(avatars).values({
      userId: user.id,
      name: `Floor${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      species: 'cat',
      color: 'green',
      gender: 'female',
      archetype: 'brave-adventurer',
      personality: { habitat: 'town', hobby: 'trading', greeting: 'hello' },
      stats: { strength: 10, defence: 10, movement: 10 },
      isGuest: input.isGuest ?? false,
    }).returning({ id: avatars.id });

    let agentId: string | null = null;
    if (input.kind === 'agent') {
      agentId = `floor-agent-${randomUUID()}`;
      const [bot] = await db.insert(agentBots).values({
        agentId,
        userId: user.id,
        mode: 'autonomous',
        isHouse: input.isHouse ?? false,
        leaderboardEligible: input.leaderboardEligible ?? true,
      }).returning({ id: agentBots.id });
      botIds.push(bot.id);
    }
    return { kind: input.kind, userId: user.id, avatarId: avatar.id, agentId };
  }

  async function emitTrades(subject: Subject, tiers: TradeMultiplierTier[]): Promise<void> {
    const rows = await db.insert(events).values(tiers.map((multiplierTier) => ({
      eventType: TRADE_EVENT_TYPE,
      userId: subject.userId || null,
      avatarId: subject.avatarId || null,
      agentId: subject.kind === 'agent' ? subject.agentId : null,
      payload: { multiplierTier },
      subjectWasGuest: false,
    }))).returning({ id: events.id });
    eventIds.push(...rows.map((row) => row.id));
  }

  async function rowFor(subject: Subject) {
    const snapshot = await buildAgentSnapshot('all', 1_000_000);
    return snapshot.agents.find((row) => subject.kind === 'agent'
      ? row.subjectType === 'agent' && row.agentId === subject.agentId
      : row.subjectType === 'avatar' && row.avatarId === subject.avatarId);
  }

  async function addWallet(subject: Subject, input: {
    operatedByClawville: boolean;
    revoked?: boolean;
  }): Promise<void> {
    await db.insert(tradingWallets).values({
      subjectKind: subject.kind,
      userId: subject.userId,
      avatarId: subject.avatarId,
      agentId: subject.kind === 'agent' ? subject.agentId : null,
      pubkey: bs58.encode(nacl.sign.keyPair().publicKey),
      source: 'signed',
      boundSlot: 1,
      operatedByClawville: input.operatedByClawville,
      revokedAt: input.revoked ? new Date() : null,
    });
  }

  afterAll(async () => {
    if (eventIds.length > 0) await db.delete(events).where(inArray(events.id, eventIds));
    if (botIds.length > 0) await db.delete(agentBots).where(inArray(agentBots.id, botIds));
    if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  });

  test('scores one base trade as 20 points on the agent leg', async () => {
    const subject = await createSubject({ kind: 'agent' });
    await emitTrades(subject, ['base']);
    const row = await rowFor(subject);
    expect(row?.score).toBe(20);
    expect(row?.breakdown.trades_verified).toBe(1);
  });

  test('scores one ANSEM trade as 40 points', async () => {
    const subject = await createSubject({ kind: 'agent' });
    await emitTrades(subject, ['ansem']);
    expect((await rowFor(subject))?.score).toBe(40);
  });

  test('scores one CLAWVILLE trade as 30 points', async () => {
    const subject = await createSubject({ kind: 'agent' });
    await emitTrades(subject, ['clv']);
    expect((await rowFor(subject))?.score).toBe(30);
  });

  test('caps 30 base trades at 20 scored trades and 400 points', async () => {
    const subject = await createSubject({ kind: 'agent' });
    await emitTrades(subject, Array<TradeMultiplierTier>(30).fill('base'));
    const row = await rowFor(subject);
    expect(row?.score).toBe(400);
    expect(row?.breakdown.trades_verified).toBe(20);
  });

  test('preserves the tier gradient under the proportional cap', async () => {
    const subject = await createSubject({ kind: 'agent' });
    await emitTrades(subject, [
      ...Array<TradeMultiplierTier>(10).fill('ansem'),
      ...Array<TradeMultiplierTier>(20).fill('base'),
    ]);
    const row = await rowFor(subject);
    expect(row?.score).toBe(533);
    expect(row?.breakdown.trades_verified).toBe(20);
  });

  test('scores the avatar leg identically to the agent leg', async () => {
    const agent = await createSubject({ kind: 'agent' });
    const avatar = await createSubject({ kind: 'avatar' });
    const tiers: TradeMultiplierTier[] = ['ansem', 'clv', 'base'];
    await emitTrades(agent, tiers);
    await emitTrades(avatar, tiers);
    const agentRow = await rowFor(agent);
    const avatarRow = await rowFor(avatar);
    expect(agentRow?.score).toBe(avatarRow?.score);
    expect(agentRow?.breakdown.trades_verified).toBe(avatarRow?.breakdown.trades_verified);
  });

  test('excludes house agents', async () => {
    const subject = await createSubject({ kind: 'agent', isHouse: true });
    await emitTrades(subject, ['ansem']);
    expect(await rowFor(subject)).toBeUndefined();
  });

  test('excludes guest-owned subjects', async () => {
    const subject = await createSubject({ kind: 'avatar', isGuest: true });
    const rows = await db.insert(events).values({
      eventType: TRADE_EVENT_TYPE,
      userId: subject.userId,
      avatarId: subject.avatarId,
      agentId: null,
      payload: { multiplierTier: 'ansem' },
      subjectWasGuest: true,
    }).returning({ id: events.id });
    eventIds.push(rows[0].id);
    expect(await rowFor(subject)).toBeUndefined();
  });

  test('labels only active ClawVille-operated wallets and handles null avatars', async () => {
    const active = await createSubject({ kind: 'avatar' });
    const ordinary = await createSubject({ kind: 'avatar' });
    const revoked = await createSubject({ kind: 'avatar' });
    const orphan = await createSubject({ kind: 'agent', withUser: false });
    await addWallet(active, { operatedByClawville: true });
    await addWallet(ordinary, { operatedByClawville: false });
    await addWallet(revoked, { operatedByClawville: true, revoked: true });
    for (const subject of [active, ordinary, revoked, orphan]) await emitTrades(subject, ['base']);
    expect((await rowFor(active))?.operatedByClawville).toBe(true);
    expect((await rowFor(ordinary))?.operatedByClawville).toBe(false);
    expect((await rowFor(revoked))?.operatedByClawville).toBe(false);
    const orphanRow = await rowFor(orphan);
    expect(orphanRow?.avatarId).toBeNull();
    expect(orphanRow?.operatedByClawville).toBe(false);
  });

  test('keeps the fleet label outside scoring', async () => {
    const labelled = await createSubject({ kind: 'avatar' });
    const ordinary = await createSubject({ kind: 'avatar' });
    await addWallet(labelled, { operatedByClawville: true });
    await emitTrades(labelled, ['ansem', 'base']);
    await emitTrades(ordinary, ['ansem', 'base']);
    const labelledRow = await rowFor(labelled);
    const ordinaryRow = await rowFor(ordinary);
    expect(labelledRow?.operatedByClawville).toBe(true);
    expect(ordinaryRow?.operatedByClawville).toBe(false);
    expect(labelledRow?.score).toBe(ordinaryRow?.score);
    expect(labelledRow?.breakdown).toEqual(ordinaryRow?.breakdown);
  });
});
