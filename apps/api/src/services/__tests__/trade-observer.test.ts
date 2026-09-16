import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  avatars,
  db,
  eq,
  events,
  inArray,
  tradingWallets,
  users,
  verifiedTrades,
} from '@clawville/database';
import { TRADE_DEX_PROGRAMS, TRADE_MINTS } from '@clawville/shared';
import * as alertModule from '../alert-error';
import * as eventLoggerModule from '../event-logger';
import * as worldModule from '../../routes/world';
import {
  _clearTradeVerifiedCallbackForTest,
  ingestTradeSignature,
  lookupVerifiedTrade,
  registerTradeVerifiedCallback,
  runTradeObserverTick,
} from '../trade-observer';
import type { BoundTradingWallet } from '../trading-wallets';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const userIds: string[] = [];
const signatures: string[] = [];

function recordedPumpSwap(wallet: string): unknown {
  return {
    slot: 200,
    blockTime: 1_750_000_000,
    transaction: { message: {
      accountKeys: [{ pubkey: wallet, signer: true, writable: true }, TRADE_DEX_PROGRAMS.pumpswap,
        TRADE_MINTS.CLAWVILLE, TRADE_MINTS.WSOL],
      instructions: [{
        programId: TRADE_DEX_PROGRAMS.pumpswap,
        accounts: [wallet, TRADE_MINTS.CLAWVILLE, TRADE_MINTS.WSOL],
        data: bs58.encode(Uint8Array.from([102, 6, 61, 18, 1, 218, 235, 234])),
      }],
    } },
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [1_000_000_000, 0],
      postBalances: [999_995_000, 0],
      preTokenBalances: [
        { accountIndex: 2, mint: TRADE_MINTS.ANSEM, owner: wallet,
          programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: '1000000', decimals: 6 } },
        { accountIndex: 3, mint: TRADE_MINTS.USDC, owner: wallet,
          programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: '0', decimals: 6 } },
      ],
      postTokenBalances: [
        { accountIndex: 2, mint: TRADE_MINTS.ANSEM, owner: wallet,
          programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: '500000', decimals: 6 } },
        { accountIndex: 3, mint: TRADE_MINTS.USDC, owner: wallet,
          programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: '900000', decimals: 6 } },
      ],
      innerInstructions: [],
      loadedAddresses: { writable: [], readonly: [] },
      logMessages: [],
    },
  };
}

async function createWalletFixture(input: { boundSlot?: number } = {}): Promise<{
  wallet: BoundTradingWallet;
  signature: string;
  raw: unknown;
}> {
  const fingerprint = randomBytes(32).toString('hex');
  const [user] = await db.insert(users).values({
    identityFingerprint: fingerprint,
    name: 'Trade observer delta test',
  }).returning({ id: users.id });
  userIds.push(user.id);
  const [avatar] = await db.insert(avatars).values({
    userId: user.id,
    name: `Floor${randomUUID().replaceAll('-', '').slice(0, 24)}`,
    species: 'cat',
    color: 'green',
    gender: 'female',
    archetype: 'brave-adventurer',
    personality: { habitat: 'town', hobby: 'trading', greeting: 'hello' },
    stats: { strength: 10, defence: 10, movement: 10 },
  }).returning({ id: avatars.id });
  const pubkey = bs58.encode(nacl.sign.keyPair().publicKey);
  const [row] = await db.insert(tradingWallets).values({
    subjectKind: 'avatar',
    userId: user.id,
    avatarId: avatar.id,
    agentId: null,
    pubkey,
    source: 'signed',
    boundAt: new Date(1_750_000_000_000),
    boundSlot: input.boundSlot ?? 199,
    operatedByClawville: false,
  }).returning();
  const signature = bs58.encode(randomBytes(64));
  signatures.push(signature);
  return {
    signature,
    raw: recordedPumpSwap(pubkey),
    wallet: {
      id: row.id,
      pubkey: row.pubkey,
      source: 'signed',
      subjectKind: 'avatar',
      userId: row.userId,
      avatarId: row.avatarId,
      agentId: null,
      boundAt: row.boundAt,
      boundSlot: row.boundSlot,
      cursorSignature: row.cursorSignature,
      cursorBlockTime: row.cursorBlockTime,
      lastPolledAt: row.lastPolledAt,
      operatedByClawville: row.operatedByClawville,
    },
  };
}

async function ingestFixture(
  fixture: Awaited<ReturnType<typeof createWalletFixture>>,
  source: 'observer' | 'report' | 'prime' = 'observer',
  decisionId?: string,
) {
  return ingestTradeSignature({
    wallet: fixture.wallet,
    signature: fixture.signature,
    source,
    decisionId,
    parsedTransaction: fixture.raw,
    deps: {
      getSignaturesForAddress: async () => [],
      getParsedTransaction: async () => fixture.raw,
      now: () => 1_750_000_000_000,
    },
  });
}

afterEach(() => {
  _clearTradeVerifiedCallbackForTest();
});

afterAll(async () => {
  if (signatures.length > 0) {
    const rows = await db.select({ eventId: verifiedTrades.eventId })
      .from(verifiedTrades).where(inArray(verifiedTrades.signature, signatures));
    const eventIds = rows.flatMap((row) => row.eventId === null ? [] : [row.eventId]);
    await db.delete(verifiedTrades).where(inArray(verifiedTrades.signature, signatures));
    if (eventIds.length > 0) await db.delete(events).where(inArray(events.id, eventIds));
  }
  if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
});

describe('trade-verified callback registration', () => {
  test('replaces and warns on double registration without stale unregister damage', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    const first = registerTradeVerifiedCallback(async () => undefined);
    const secondCallback = async () => undefined;
    const second = registerTradeVerifiedCallback(secondCallback);
    first();
    expect(warn).toHaveBeenCalledTimes(1);
    second();
    warn.mockRestore();
  });
});

describe('trade observer wallet isolation', () => {
  test('alerts a strict failure and continues with the next wallet', async () => {
    const wallet = (id: string): BoundTradingWallet => ({
      id, pubkey: `pubkey-${id}`, source: 'signed', subjectKind: 'avatar',
      userId: `user-${id}`, avatarId: `avatar-${id}`, agentId: null,
      boundAt: new Date(0), boundSlot: 0, cursorSignature: null,
      cursorBlockTime: null, lastPolledAt: null, operatedByClawville: false,
    });
    const first = wallet('first');
    const second = wallet('second');
    const ingested: string[] = [];
    const alerts: unknown[] = [];
    const advanced: string[] = [];
    const primary = new Error('strict event insert failed');
    const result = await runTradeObserverTick({
      getSignaturesForAddress: async (address) => [{
        signature: address === first.pubkey ? 'sig-first' : 'sig-second', slot: 1, blockTime: 1,
      }],
      getParsedTransaction: async () => null,
      now: () => 1_000,
    }, {
      resolveWallets: async () => [first, second],
      withLease: (async (_walletId: string, task: () => Promise<unknown>) => task()) as any,
      ingest: (async ({ wallet: current }: { wallet: BoundTradingWallet }) => {
        ingested.push(current.id);
        if (current.id === first.id) throw primary;
        return { signature: 'sig-second', inserted: true, scored: false, reason: 'below_min_notional', trade: null };
      }) as any,
      advanceCursor: (async ({ walletId }: { walletId: string }) => { advanced.push(walletId); return true; }) as any,
      alert: (async (payload: unknown) => { alerts.push(payload); }) as any,
    });
    expect(ingested).toEqual([first.id, second.id]);
    expect(result).toEqual({ walletsPolled: 2, signaturesExamined: 2, inserted: 1, scored: 0, errors: 1 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'warning', source: 'trade-observer',
      context: { walletId: first.id, signature: 'sig-first', error: primary.message },
    });
    expect(advanced).toEqual([second.id]);
  });
});

describeIfDb('trade observer delta integration (requires DATABASE_URL)', () => {
  test('stores a trade at the binding slot as pre_bind without a leaderboard event', async () => {
    const fixture = await createWalletFixture({ boundSlot: 200 });
    const outcome = await ingestFixture(fixture);
    const [row] = await db.select().from(verifiedTrades)
      .where(eq(verifiedTrades.signature, fixture.signature)).limit(1);
    expect(outcome).toMatchObject({ inserted: true, scored: false, reason: 'pre_bind' });
    expect(row).toMatchObject({ slot: 200, scored: false, unscoredReason: 'pre_bind', eventId: null });
  });

  test('scores a same-second trade when its slot is greater than the binding slot', async () => {
    const fixture = await createWalletFixture({ boundSlot: 199 });
    const outcome = await ingestFixture(fixture);
    expect(fixture.wallet.boundAt.getTime()).toBe(1_750_000_000_000);
    expect((fixture.raw as { blockTime: number }).blockTime).toBe(1_750_000_000);
    expect(outcome).toMatchObject({ inserted: true, scored: true, reason: null });
  });

  test('invokes the callback once for a fresh verified signature', async () => {
    const fixture = await createWalletFixture();
    const notices: unknown[] = [];
    registerTradeVerifiedCallback(async (notice) => { notices.push(notice); });
    await ingestFixture(fixture);
    await ingestFixture(fixture);
    expect(notices).toEqual([{
      signature: fixture.signature,
      decisionId: null,
      avatarId: fixture.wallet.avatarId,
      tradingWalletId: fixture.wallet.id,
    }]);
  });

  test('keeps an unregistered callback as a silent no-op', async () => {
    const fixture = await createWalletFixture();
    const alert = spyOn(alertModule, 'alertError').mockResolvedValue(undefined);
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    const outcome = await ingestFixture(fixture);
    expect(outcome.inserted).toBe(true);
    expect(outcome.scored).toBe(true);
    expect(alert).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    alert.mockRestore();
    warn.mockRestore();
  });

  test('awaits the callback before broadcasting the verified frame', async () => {
    const fixture = await createWalletFixture();
    const order: string[] = [];
    const broadcast = spyOn(worldModule, 'broadcastTradeEvent').mockImplementation(() => { order.push('broadcast'); });
    registerTradeVerifiedCallback(async () => { order.push('callback'); });
    await ingestFixture(fixture);
    expect(order).toEqual(['callback', 'broadcast']);
    broadcast.mockRestore();
  });

  test('contains a throwing callback after scoring and alerts exactly once', async () => {
    const fixture = await createWalletFixture();
    const alert = spyOn(alertModule, 'alertError').mockResolvedValue(undefined);
    const broadcast = spyOn(worldModule, 'broadcastTradeEvent').mockImplementation(() => undefined);
    registerTradeVerifiedCallback(async () => { throw new Error('promotion failed'); });
    const outcome = await ingestFixture(fixture);
    const [row] = await db.select().from(verifiedTrades).where(eq(verifiedTrades.signature, fixture.signature)).limit(1);
    const eventRows = row?.eventId === null || row?.eventId === undefined
      ? []
      : await db.select({ id: events.id }).from(events).where(eq(events.id, row.eventId)).limit(1);
    expect(outcome.scored).toBe(true);
    expect(row?.scored).toBe(true);
    expect(eventRows).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0]?.[0]).toMatchObject({
      severity: 'warning',
      source: 'trade-observer',
      context: { signature: fixture.signature, decisionId: null },
    });
    alert.mockRestore();
    broadcast.mockRestore();
  });

  test('rolls back and returns a retryable report error when strict event insertion fails', async () => {
    const fixture = await createWalletFixture();
    const primary = new Error('forced strict event failure');
    const eventWrite = spyOn(eventLoggerModule, 'logVerifiedTradeEventTx').mockRejectedValue(primary);
    const failureRecord = spyOn(eventLoggerModule, 'recordVerifiedTradeEventFailure').mockResolvedValue(undefined);
    const broadcast = spyOn(worldModule, 'broadcastTradeEvent').mockImplementation(() => undefined);
    await expect(ingestFixture(fixture, 'report')).rejects.toMatchObject({
      code: 'settlement_write_failed',
      status: 503,
    });
    expect(await db.select().from(verifiedTrades).where(eq(verifiedTrades.signature, fixture.signature))).toHaveLength(0);
    expect(failureRecord).toHaveBeenCalledTimes(1);
    expect(failureRecord.mock.calls[0]?.[1]).toBe(primary);
    expect(broadcast).not.toHaveBeenCalled();
    eventWrite.mockRestore();
    failureRecord.mockRestore();
    broadcast.mockRestore();
  });

  test('rolls back and rethrows the strict event failure to the observer caller', async () => {
    const fixture = await createWalletFixture();
    const primary = new Error('forced observer strict event failure');
    const eventWrite = spyOn(eventLoggerModule, 'logVerifiedTradeEventTx').mockRejectedValue(primary);
    const failureRecord = spyOn(eventLoggerModule, 'recordVerifiedTradeEventFailure').mockResolvedValue(undefined);
    const broadcast = spyOn(worldModule, 'broadcastTradeEvent').mockImplementation(() => undefined);
    await expect(ingestFixture(fixture, 'observer')).rejects.toBe(primary);
    expect(await db.select().from(verifiedTrades).where(eq(verifiedTrades.signature, fixture.signature))).toHaveLength(0);
    expect(failureRecord).toHaveBeenCalledTimes(1);
    expect(failureRecord.mock.calls[0]?.[1]).toBe(primary);
    expect(broadcast).not.toHaveBeenCalled();
    eventWrite.mockRestore();
    failureRecord.mockRestore();
    broadcast.mockRestore();
  });

  test('notifies with the enriched decision before the enrichment frame', async () => {
    const fixture = await createWalletFixture();
    await ingestFixture(fixture);
    const decisionId = randomUUID();
    const order: string[] = [];
    const notices: unknown[] = [];
    const broadcast = spyOn(worldModule, 'broadcastTradeEvent').mockImplementation(() => { order.push('broadcast'); });
    registerTradeVerifiedCallback(async (notice) => { notices.push(notice); order.push('callback'); });
    const outcome = await ingestFixture(fixture, 'prime', decisionId);
    expect(outcome.inserted).toBe(false);
    expect(outcome.trade?.decisionId).toBe(decisionId);
    expect(notices).toEqual([{
      signature: fixture.signature,
      decisionId,
      avatarId: fixture.wallet.avatarId,
      tradingWalletId: fixture.wallet.id,
    }]);
    expect(order).toEqual(['callback', 'broadcast']);
    broadcast.mockRestore();
  });

  test('lets prime win the insert race without observer overwrite or duplicate effects', async () => {
    const fixture = await createWalletFixture();
    const decisionId = randomUUID();
    const notices: unknown[] = [];
    const broadcast = spyOn(worldModule, 'broadcastTradeEvent').mockImplementation(() => undefined);
    registerTradeVerifiedCallback(async (notice) => { notices.push(notice); });
    await ingestFixture(fixture, 'prime', decisionId);
    await ingestFixture(fixture, 'observer');
    const [row] = await db.select().from(verifiedTrades).where(eq(verifiedTrades.signature, fixture.signature)).limit(1);
    const eventRows = row?.eventId === null || row?.eventId === undefined
      ? []
      : await db.select({ id: events.id }).from(events).where(eq(events.id, row.eventId));
    expect(row?.source).toBe('prime');
    expect(row?.decisionId).toBe(decisionId);
    expect(eventRows).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    broadcast.mockRestore();
  });

  test('looks up a verified signature without returning its wallet address', async () => {
    const fixture = await createWalletFixture();
    await ingestFixture(fixture);
    const result = await lookupVerifiedTrade(fixture.signature);
    expect(result).toEqual({
      verified: true,
      avatarId: fixture.wallet.avatarId,
      tradingWalletId: fixture.wallet.id,
      decisionId: null,
      slot: 200,
    });
    expect(JSON.stringify(result)).not.toContain(fixture.wallet.pubkey);
  });

  test('returns verified false for an unknown signature', async () => {
    expect(await lookupVerifiedTrade(bs58.encode(randomBytes(64)))).toEqual({ verified: false });
  });
});
