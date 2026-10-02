import { beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { TRADE_MINTS } from '@clawville/shared';
import type { AlertErrorParams } from '../alert-error';
import {
  ClawPumpWriterError,
  type ArenaTransferInput,
  type ArenaTransferOutcome,
  type ClawPumpArenaWalletLive,
} from '../clawpump-writer';
import { ArenaWithdrawTxReusedError, type ArenaWithdrawalRecord } from '../floor-arena/queries';
import {
  _resetArenaWithdrawForTest,
  ARENA_WITHDRAW_CALLS_PER_DISPATCH,
  ARENA_WITHDRAW_DISPATCH_PER_TICK,
  ARENA_WITHDRAW_DISPATCH_STALE_MS,
  ARENA_WITHDRAW_HISTORY_LIMIT,
  ARENA_WITHDRAW_RECONCILE_PER_TICK,
  ARENA_WITHDRAW_REMOTE_TIMEOUT_MS,
  ARENA_WITHDRAW_SENT_GIVE_UP_MS,
  ARENA_WITHDRAW_TICK_MS,
  ARENA_WITHDRAW_UNKNOWN_GIVE_UP_MS,
  dispatchArenaWithdrawal,
  matchWithdrawTransfer,
  reconcileArenaWithdrawal,
  runArenaWithdrawTick,
  type ArenaWithdrawChainTx,
  type ArenaWithdrawDeps,
  type ArenaWithdrawSignatureStatus,
} from '../floor-arena/withdraw';

/**
 * P5 T4 engine tests (contract ops/house-traders/arena-review/P5_CONTRACT_2026-10-02.md §4 + §10 T4).
 * REAL MONEY rules: the fake store below has the SAME compare-and-set semantics as the T3 queries
 * (admit dispatches only from 'requested', finalize moves only from the listed states and obeys the
 * 0074 trigger's forward-only map, attach sets a signature only on an 'unknown' row without one and
 * throws ArenaWithdrawTxReusedError on reuse). Every transfer call is counted.
 */

const USDC = TRADE_MINTS.USDC;
const NOW = new Date('2026-10-02T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const CP_ID = '99999999-8888-4777-8666-555555555555';
const SOURCE = '7HJkSiAAnptjPh9kxmc8qbQbDQyWkpgmxuonzC3gEM6E';
const DEST = 'CQMkzDuaftQ1mW6ZkdEd3uGWdMaqio39VsY2TmyugRmz';
const OTHER = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const NEW_DEST = '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump';
const SYSTEM = '11111111111111111111111111111111';
const at = (ms: number): Date => new Date(NOW.getTime() + ms);
const unix = (date: Date): number => Math.floor(date.getTime() / 1000);

/** The 0074 guard trigger's forward-only state map. */
const NEXT: Record<string, readonly string[]> = {
  requested: ['dispatching', 'cancelled', 'refused'],
  dispatching: ['sent', 'unknown', 'failed', 'failed_no_send', 'needs_review'],
  sent: ['confirmed', 'failed', 'failed_no_send', 'needs_review'],
  unknown: ['confirmed', 'failed', 'failed_no_send', 'needs_review'],
};

function withdrawal(over: Partial<ArenaWithdrawalRecord> = {}): ArenaWithdrawalRecord {
  return {
    id: randomUUID(), agentId: 'agent-1', ownerUserId: 'owner-1', subjectKind: 'human', subjectAgentId: null,
    idempotencyKey: 'idem-key-0001', asset: 'USDC', amountMode: 'exact', requestedAtomic: 100_000n, amountAtomic: null,
    sourceClawpumpAgentId: CP_ID, sourceWallet: SOURCE, destination: DEST, addressId: 'addr-1', state: 'requested',
    errorCode: null, preBalanceAtomic: null, preSolLamports: null, postBalanceAtomic: null, txSignature: null,
    recipientAccountCreated: null, reviewNote: null, requestedAt: at(-30 * MIN), dispatchedAt: null, sentAt: null,
    finalizedAt: null, lastCheckedAt: null, checkCount: 0, ...over,
  };
}

/** An admitted row as reconcile sees it (dispatched at `dispatchedAt`, pre balance 5 USDC). */
function dispatched(over: Partial<ArenaWithdrawalRecord> = {}): ArenaWithdrawalRecord {
  return withdrawal({
    state: 'unknown', amountAtomic: 100_000n, preBalanceAtomic: 5_000_000n, preSolLamports: 10_000_000n,
    dispatchedAt: at(-20 * MIN), errorCode: 'timeout', ...over,
  });
}

/** A finalized USDC transfer: owner-keyed pre/post token balances (missing dest pre = new token account). */
function usdcTx(input: {
  amount?: bigint; source?: string; dest?: string; destPre?: bigint | null; sourceDelta?: bigint;
  blockTime?: number; err?: unknown; mint?: string;
} = {}): ArenaWithdrawChainTx {
  const amount = input.amount ?? 100_000n;
  const source = input.source ?? SOURCE;
  const dest = input.dest ?? DEST;
  const mint = input.mint ?? USDC;
  const sourcePre = 5_000_000n;
  const destPre = input.destPre === undefined ? 0n : input.destPre;
  const pre = [{ mint, owner: source, amount: String(sourcePre) }];
  if (destPre !== null) pre.push({ mint, owner: dest, amount: String(destPre) });
  return {
    blockTime: input.blockTime ?? unix(at(-19 * MIN)),
    accountKeys: [source, 'SrcTokenAcct1111111111111111111111111111111', 'DstTokenAcct1111111111111111111111111111111', dest],
    meta: {
      err: input.err ?? null, fee: 5_000,
      preBalances: [10_000_000, 2_039_280, 2_039_280, 1_000_000], postBalances: [9_995_000, 2_039_280, 2_039_280, 1_000_000],
      preTokenBalances: pre,
      postTokenBalances: [
        { mint, owner: source, amount: String(sourcePre - (input.sourceDelta ?? amount)) },
        { mint, owner: dest, amount: String((destPre ?? 0n) + amount) },
      ],
    },
  };
}

function solTx(input: { amount?: bigint; dest?: string; fee?: number; sourceDelta?: bigint; blockTime?: number } = {}): ArenaWithdrawChainTx {
  const amount = input.amount ?? 2_000_000n;
  const fee = input.fee ?? 5_000;
  const dest = input.dest ?? DEST;
  const sourceDelta = input.sourceDelta ?? amount + BigInt(fee);
  return {
    blockTime: input.blockTime ?? unix(at(-19 * MIN)),
    accountKeys: [SOURCE, dest, SYSTEM],
    meta: {
      err: null, fee,
      preBalances: [10_000_000, 1_000_000, 1], postBalances: [10_000_000 - Number(sourceDelta), 1_000_000 + Number(amount), 1],
      preTokenBalances: [], postTokenBalances: [],
    },
  };
}

class World {
  now = NOW;
  rows = new Map<string, ArenaWithdrawalRecord>();
  currentAddress = new Map<string, { id: string; address: string }>();
  live: ClawPumpArenaWalletLive = { address: SOURCE, solLamports: 10_000_000n, usdcAtomic: 5_000_000n, readAt: NOW, transactions: [] };
  liveError: Error | null = null;
  ata: boolean | null = true;
  paused = false;
  budget = true;
  accountCap = false;
  busy = new Set<string>();
  exclusiveLocks = true;
  held = new Set<string>();
  transfers: Array<{ clawpumpAgentId: string; input: ArenaTransferInput; arenaAgentId: string }> = [];
  transferImpl: (input: ArenaTransferInput) => Promise<ArenaTransferOutcome> = async () => (
    { kind: 'sent', txSignature: 'SIG_SENT', recipientAccountCreated: false });
  statuses = new Map<string, ArenaWithdrawSignatureStatus>();
  txs = new Map<string, ArenaWithdrawChainTx>();
  alerts: AlertErrorParams[] = [];
  events: string[] = [];
  addonSpentUsd = 0;
  calls = { readWalletLive: 0, ata: 0, admit: 0, getTransaction: 0, touch: 0, listDue: [] as number[] };
  admitInputs: Array<{ withdrawalId: string; destinationHasUsdcAccount: boolean }> = [];

  add(row: ArenaWithdrawalRecord): ArenaWithdrawalRecord {
    this.rows.set(row.id, { ...row });
    if (!this.currentAddress.has(row.agentId)) this.currentAddress.set(row.agentId, { id: row.addressId, address: row.destination });
    return row;
  }

  get(id: string): ArenaWithdrawalRecord {
    const row = this.rows.get(id);
    if (!row) throw new Error('no row');
    return { ...row };
  }

  causes(prefix: string): AlertErrorParams[] {
    return this.alerts.filter((alert) => String(alert.context?.cause ?? '').startsWith(prefix));
  }

  private refuse(row: ArenaWithdrawalRecord, code: 'source_mismatch' | 'address_revoked' | 'needs_sol') {
    const next: ArenaWithdrawalRecord = { ...row, state: 'refused', errorCode: code, finalizedAt: this.now };
    this.rows.set(row.id, next);
    return { kind: 'refused' as const, code, withdrawal: { ...next } };
  }

  deps(): ArenaWithdrawDeps {
    return {
      paused: () => this.paused,
      clock: () => this.now,
      budgetOk: () => this.budget,
      listDue: async (limit) => {
        this.calls.listDue.push(limit);
        return [...this.rows.values()].filter((row) => row.state === 'requested')
          .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime()).slice(0, limit).map((row) => ({ ...row }));
      },
      listReconcile: async (now, limit) => [...this.rows.values()]
        .filter((row) => (row.state === 'dispatching' && (row.dispatchedAt?.getTime() ?? 0) < now.getTime() - 120_000)
          || row.state === 'sent' || row.state === 'unknown')
        .sort((a, b) => (a.lastCheckedAt?.getTime() ?? -1) - (b.lastCheckedAt?.getTime() ?? -1))
        .slice(0, limit).map((row) => ({ ...row })),
      tryLock: async <T>(agentId: string, fn: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> => {
        if (this.busy.has(agentId) || (this.exclusiveLocks && this.held.has(agentId))) return { acquired: false };
        this.held.add(agentId);
        try {
          return { acquired: true, value: await fn() };
        } finally {
          this.held.delete(agentId);
        }
      },
      readWalletLive: async () => {
        this.calls.readWalletLive += 1;
        if (this.liveError) throw this.liveError;
        return { ...this.live, transactions: [...this.live.transactions] };
      },
      transfer: async (clawpumpAgentId, input, arenaAgentId) => {
        this.transfers.push({ clawpumpAgentId, input: { ...input }, arenaAgentId });
        return this.transferImpl(input);
      },
      destinationHasUsdcAccount: async () => {
        this.calls.ata += 1;
        return this.ata;
      },
      getSignatureStatus: async (signature) => this.statuses.get(signature) ?? null,
      getTransaction: async (signature) => {
        this.calls.getTransaction += 1;
        return this.txs.get(signature) ?? null;
      },
      admit: async ({ withdrawalId, live, destinationHasUsdcAccount, paused }) => {
        this.calls.admit += 1;
        this.admitInputs.push({ withdrawalId, destinationHasUsdcAccount });
        const row = this.rows.get(withdrawalId);
        if (!row || row.state !== 'requested') return { kind: 'gone' };
        if (paused()) return { kind: 'wait', reason: 'paused' };
        if (live.address !== row.sourceWallet) return this.refuse(row, 'source_mismatch');
        const address = this.currentAddress.get(row.agentId);
        if (!address || address.id !== row.addressId || address.address !== row.destination) return this.refuse(row, 'address_revoked');
        const need = 5_000_000n + (row.asset === 'USDC' && !destinationHasUsdcAccount ? 2_040_000n : 0n);
        if (live.solLamports < need) return this.refuse(row, 'needs_sol');
        if (this.accountCap) return { kind: 'wait', reason: 'account_cap' };
        const usdc = row.asset === 'USDC';
        const amount = row.requestedAtomic ?? (usdc ? live.usdcAtomic : live.solLamports - 900_000n);
        const next: ArenaWithdrawalRecord = {
          ...row, state: 'dispatching', amountAtomic: amount, preBalanceAtomic: usdc ? live.usdcAtomic : live.solLamports,
          preSolLamports: live.solLamports, dispatchedAt: this.now,
        };
        this.rows.set(row.id, next);
        return { kind: 'dispatched', withdrawal: { ...next } };
      },
      finalize: async (id, from, patch, event) => {
        const row = this.rows.get(id);
        if (!row || !from.includes(row.state)) return null;
        if (!(NEXT[row.state] ?? []).includes(patch.state)) throw new Error(`trigger: ${row.state} -> ${patch.state}`);
        if (patch.txSignature !== undefined && row.txSignature !== null && patch.txSignature !== row.txSignature) {
          throw new Error('trigger: tx_signature changed');
        }
        if (patch.txSignature && [...this.rows.values()].some((other) => other.id !== id && other.txSignature === patch.txSignature)) {
          throw new ArenaWithdrawTxReusedError();
        }
        const next: ArenaWithdrawalRecord = { ...row, state: patch.state };
        if (patch.errorCode !== undefined) next.errorCode = patch.errorCode;
        if (patch.txSignature !== undefined) next.txSignature = patch.txSignature;
        if (patch.recipientAccountCreated !== undefined) next.recipientAccountCreated = patch.recipientAccountCreated;
        if (patch.postBalanceAtomic !== undefined) next.postBalanceAtomic = patch.postBalanceAtomic;
        if (patch.sentAt !== undefined) next.sentAt = patch.sentAt;
        this.rows.set(id, next);
        this.events.push(event.summary);
        return { ...next };
      },
      attachSignature: async (id, signature) => {
        const row = this.rows.get(id);
        if (!row || row.state !== 'unknown' || row.txSignature !== null) return false;
        if ([...this.rows.values()].some((other) => other.id !== id && other.txSignature === signature)) {
          throw new ArenaWithdrawTxReusedError();
        }
        this.rows.set(id, { ...row, txSignature: signature });
        return true;
      },
      touch: async (id, now) => {
        this.calls.touch += 1;
        const row = this.rows.get(id);
        if (row) this.rows.set(id, { ...row, lastCheckedAt: now, checkCount: row.checkCount + 1 });
      },
      signatureUsed: async (signature) => [...this.rows.values()].some((row) => row.txSignature === signature),
      addonSpentSince: async () => this.addonSpentUsd,
      alert: async (params) => {
        this.alerts.push(params);
      },
    };
  }
}

async function tick(world: World, offsetMs = 0): Promise<{ dispatched: number; reconciled: number }> {
  world.now = at(offsetMs);
  return runArenaWithdrawTick(world.now, world.deps());
}

/** Every fake is promise-based, so one timer turn drains all pending microtasks. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

let world: World;

beforeEach(() => {
  _resetArenaWithdrawForTest();
  world = new World();
});

describe('constants (contract §4)', () => {
  test('pins every loop constant; the stale time equals the private T3 query constant (120 s)', () => {
    expect(ARENA_WITHDRAW_TICK_MS).toBe(30_000);
    expect(ARENA_WITHDRAW_DISPATCH_PER_TICK).toBe(2);
    expect(ARENA_WITHDRAW_RECONCILE_PER_TICK).toBe(10);
    expect(ARENA_WITHDRAW_CALLS_PER_DISPATCH).toBe(3);
    expect(ARENA_WITHDRAW_DISPATCH_STALE_MS).toBe(120_000);
    expect(ARENA_WITHDRAW_UNKNOWN_GIVE_UP_MS).toBe(15 * MIN);
    expect(ARENA_WITHDRAW_SENT_GIVE_UP_MS).toBe(30 * MIN);
    expect(ARENA_WITHDRAW_HISTORY_LIMIT).toBe(50);
  });
});

describe('dispatch', () => {
  test('happy path: one transfer to the row destination, state sent; the next tick confirms by signature', async () => {
    const row = world.add(withdrawal());
    const first = await tick(world);
    expect(first.dispatched).toBe(1);
    expect(world.transfers).toHaveLength(1);
    expect(world.transfers[0]).toEqual({
      clawpumpAgentId: CP_ID, arenaAgentId: 'agent-1',
      input: { to: DEST, asset: 'USDC', amountAtomic: 100_000n, expectedSource: SOURCE },
    });
    const sent = world.get(row.id);
    expect(sent.state).toBe('sent');
    expect(sent.txSignature).toBe('SIG_SENT');
    expect(sent.sentAt?.getTime()).toBe(NOW.getTime());
    expect(sent.recipientAccountCreated).toBe(false);

    world.statuses.set('SIG_SENT', { finalized: true, err: null });
    world.txs.set('SIG_SENT', usdcTx({ blockTime: unix(NOW) }));
    await tick(world, 30_000);
    const done = world.get(row.id);
    expect(done.state).toBe('confirmed');
    expect(done.postBalanceAtomic).toBe(4_900_000n);
    expect(world.transfers).toHaveLength(1);
  });

  test('a writer throw books failed_no_send with the code only (status suffix dropped)', async () => {
    const row = world.add(withdrawal());
    world.transferImpl = async () => { throw new ClawPumpWriterError('http_error', 500); };
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'failed_no_send', errorCode: 'clawpump_http_error' });
    expect(world.transfers).toHaveLength(1);
  });

  test('a transfer that resolves with no known outcome books unknown, never failed_no_send', async () => {
    const row = world.add(withdrawal());
    world.transferImpl = async () => undefined as unknown as ArenaTransferOutcome;
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'unknown', errorCode: 'reply_unparsed' });
    expect(world.transfers).toHaveLength(1);
  });

  test('an unknown outcome books unknown; 5 more ticks never transfer again', async () => {
    const row = world.add(withdrawal());
    world.transferImpl = async () => ({ kind: 'unknown', code: 'timeout', txSignature: null });
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'unknown', errorCode: 'timeout', txSignature: null });
    for (let i = 1; i <= 5; i += 1) await tick(world, i * 30_000);
    expect(world.transfers).toHaveLength(1);
    expect(world.get(row.id).state).toBe('unknown');
  });

  test('a sent row waiting for the chain never transfers again over many ticks', async () => {
    const row = world.add(withdrawal());
    world.statuses.set('SIG_SENT', { finalized: false, err: null });
    for (let i = 0; i < 8; i += 1) await tick(world, i * 30_000);
    expect(world.transfers).toHaveLength(1);
    expect(world.get(row.id).state).toBe('sent');
    expect(world.get(row.id).checkCount).toBeGreaterThan(0);
  });

  test('an unknown outcome with a signature keeps it; reconcile uses it', async () => {
    const row = world.add(withdrawal());
    world.transferImpl = async () => ({ kind: 'unknown', code: 'http_502', txSignature: 'SIG_U' });
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'unknown', errorCode: 'http_502', txSignature: 'SIG_U' });
    world.statuses.set('SIG_U', { finalized: true, err: null });
    world.txs.set('SIG_U', usdcTx({ blockTime: unix(NOW) }));
    await tick(world, 30_000);
    expect(world.get(row.id).state).toBe('confirmed');
    expect(world.transfers).toHaveLength(1);
  });

  test('a rejected outcome books failed with the writer code', async () => {
    const row = world.add(withdrawal());
    world.transferImpl = async () => ({ kind: 'rejected', code: 'vendor_insufficient_fee_balance' });
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'failed', errorCode: 'vendor_insufficient_fee_balance' });
  });

  test('a mismatch outcome books needs_review reply_mismatch with the signature and alerts critical', async () => {
    const row = world.add(withdrawal());
    world.transferImpl = async () => ({ kind: 'mismatch', code: 'reply_mismatch', txSignature: 'SIG_MM' });
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'needs_review', errorCode: 'reply_mismatch', txSignature: 'SIG_MM' });
    const alerts = world.causes('withdraw:reply_mismatch');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe('critical');
  });

  test('a sent signature that another row holds books needs_review tx_reused and alerts critical', async () => {
    world.add(dispatched({ state: 'confirmed', txSignature: 'SIG_SENT', agentId: 'agent-old', finalizedAt: at(-HOUR) }));
    const row = world.add(withdrawal());
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'needs_review', errorCode: 'tx_reused', txSignature: null });
    expect(world.causes('withdraw:tx_reused')[0]?.severity).toBe('critical');
    expect(world.transfers).toHaveLength(1);
  });

  test('stale dispatching moves to unknown dispatch_interrupted after 2 min and never transfers', async () => {
    const row = world.add(dispatched({ state: 'dispatching', errorCode: null, dispatchedAt: at(-60_000) }));
    await tick(world);
    expect(world.get(row.id).state).toBe('dispatching');
    await tick(world, 61_001);
    expect(world.get(row.id)).toMatchObject({ state: 'unknown', errorCode: 'dispatch_interrupted' });
    expect(world.transfers).toHaveLength(0);
    expect(world.causes('withdraw:dispatch_interrupted')).toHaveLength(1);
  });

  test('reconcile itself refuses to move a dispatching row that is not stale yet', async () => {
    const row = world.add(dispatched({ state: 'dispatching', errorCode: null, dispatchedAt: at(-60_000) }));
    await reconcileArenaWithdrawal(world.deps(), world.get(row.id), NOW);
    expect(world.get(row.id).state).toBe('dispatching');
  });

  test('USDC destination check: null keeps the row requested and alerts once; false reaches admission', async () => {
    const row = world.add(withdrawal());
    world.ata = null;
    for (let i = 0; i < 3; i += 1) await tick(world, i * 30_000);
    expect(world.get(row.id).state).toBe('requested');
    expect(world.calls.admit).toBe(0);
    expect(world.causes('withdraw:rpc_unavailable')).toHaveLength(1);
    world.ata = false;
    await tick(world, 120_000);
    expect(world.admitInputs.at(-1)).toEqual({ withdrawalId: row.id, destinationHasUsdcAccount: false });
  });

  test('SOL rows skip the token-account check and admit with destinationHasUsdcAccount true', async () => {
    const row = world.add(withdrawal({ asset: 'SOL', requestedAtomic: 2_000_000n }));
    world.transferImpl = async () => ({ kind: 'sent', txSignature: 'SIG_SOL', recipientAccountCreated: null });
    await tick(world);
    expect(world.calls.ata).toBe(0);
    expect(world.admitInputs[0]).toEqual({ withdrawalId: row.id, destinationHasUsdcAccount: true });
    expect(world.transfers[0]!.input).toEqual({ to: DEST, asset: 'SOL', amountAtomic: 2_000_000n, expectedSource: SOURCE });
  });

  test('a live-read failure keeps the row requested; alerts once per cause over 3 ticks', async () => {
    const row = world.add(withdrawal());
    world.liveError = new ClawPumpWriterError('timeout');
    for (let i = 0; i < 3; i += 1) await tick(world, i * 30_000);
    expect(world.get(row.id).state).toBe('requested');
    expect(world.transfers).toHaveLength(0);
    const alerts = world.causes('withdraw:balance_unavailable');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe('warning');
  });

  test('account cap: the row waits requested; one alert per UTC day over 3 ticks', async () => {
    const row = world.add(withdrawal());
    world.accountCap = true;
    for (let i = 0; i < 3; i += 1) await tick(world, i * 30_000);
    expect(world.get(row.id).state).toBe('requested');
    expect(world.transfers).toHaveLength(0);
    expect(world.causes('withdraw:account_cap:2026-10-02')).toHaveLength(1);
  });

  test('source mismatch: admission refuses and the tick alerts critical once per row', async () => {
    const row = world.add(withdrawal());
    world.live = { ...world.live, address: OTHER };
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'refused', errorCode: 'source_mismatch' });
    expect(world.transfers).toHaveLength(0);
    const alerts = world.causes('withdraw:source_mismatch');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe('critical');
  });

  test('an address changed after the request: admission refuses address_revoked; transfer never sees the new address', async () => {
    const row = world.add(withdrawal());
    world.currentAddress.set('agent-1', { id: 'addr-2', address: NEW_DEST });
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'refused', errorCode: 'address_revoked' });
    expect(world.transfers).toHaveLength(0);
  });

  test('I3: the transfer `to` comes only from the admitted row, never from the listed copy', async () => {
    const row = world.add(withdrawal());
    const listed = { ...world.get(row.id), destination: NEW_DEST, sourceWallet: OTHER, requestedAtomic: 999_000_000n };
    await dispatchArenaWithdrawal(world.deps(), listed);
    expect(world.transfers).toHaveLength(1);
    expect(world.transfers[0]!.input).toEqual({ to: DEST, asset: 'USDC', amountAtomic: 100_000n, expectedSource: SOURCE });
  });

  test('at most 2 dispatches per tick; listDue asks for 6', async () => {
    for (let i = 0; i < 3; i += 1) {
      world.add(withdrawal({ agentId: `agent-${i}`, addressId: `addr-${i}`, requestedAt: at(-(10 - i) * MIN) }));
    }
    let n = 0;
    world.transferImpl = async () => ({ kind: 'sent', txSignature: `SIG_${(n += 1)}`, recipientAccountCreated: false });
    const result = await tick(world);
    expect(result.dispatched).toBe(2);
    expect(world.transfers).toHaveLength(2);
    expect(world.calls.listDue).toEqual([6]);
    expect([...world.rows.values()].filter((row) => row.state === 'requested')).toHaveLength(1);
  });
});

describe('tick gates', () => {
  test('paused: no admission, reconcile still runs', async () => {
    const due = world.add(withdrawal({ agentId: 'agent-a', addressId: 'addr-a' }));
    const stale = world.add(dispatched({ agentId: 'agent-b', addressId: 'addr-b', state: 'dispatching', errorCode: null, dispatchedAt: at(-5 * MIN) }));
    world.paused = true;
    await tick(world);
    expect(world.calls.admit).toBe(0);
    expect(world.calls.readWalletLive).toBe(0);
    expect(world.get(due.id).state).toBe('requested');
    expect(world.get(stale.id)).toMatchObject({ state: 'unknown', errorCode: 'dispatch_interrupted' });
  });

  test('budget short: no admission and no live read', async () => {
    const row = world.add(withdrawal());
    world.budget = false;
    await tick(world);
    expect(world.calls.readWalletLive).toBe(0);
    expect(world.calls.admit).toBe(0);
    expect(world.get(row.id).state).toBe('requested');
  });

  test('busy lock: skip the row (dispatch and reconcile)', async () => {
    const due = world.add(withdrawal({ agentId: 'agent-a', addressId: 'addr-a' }));
    const stale = world.add(dispatched({ agentId: 'agent-b', addressId: 'addr-b', state: 'dispatching', errorCode: null, dispatchedAt: at(-5 * MIN) }));
    world.busy.add('agent-a');
    world.busy.add('agent-b');
    const result = await tick(world);
    expect(result).toEqual({ dispatched: 0, reconciled: 0 });
    expect(world.calls.readWalletLive).toBe(0);
    expect(world.get(due.id).state).toBe('requested');
    expect(world.get(stale.id).state).toBe('dispatching');
  });

  test('two tick instances on one store at the same time: one transfer', async () => {
    world.add(withdrawal());
    let release!: (outcome: ArenaTransferOutcome) => void;
    world.transferImpl = () => new Promise((resolve) => { release = resolve; });
    const a = runArenaWithdrawTick(NOW, world.deps());
    const b = runArenaWithdrawTick(NOW, world.deps());
    await flush();
    release({ kind: 'sent', txSignature: 'SIG_ONE', recipientAccountCreated: false });
    await Promise.all([a, b]);
    expect(world.transfers).toHaveLength(1);
  });

  test('two leaders dispatching one row at once (no shared lock): the admission CAS lets one transfer through', async () => {
    const row = world.add(withdrawal());
    world.exclusiveLocks = false;
    const results = await Promise.all([
      dispatchArenaWithdrawal(world.deps(), world.get(row.id)),
      dispatchArenaWithdrawal(world.deps(), world.get(row.id)),
    ]);
    expect(world.transfers).toHaveLength(1);
    expect(results).toContain('gone');
  });

  test('the tick never throws, even when both lists fail', async () => {
    const deps = world.deps();
    deps.listReconcile = async () => { throw new Error('db down https://secret.example/?api-key=abc'); };
    deps.listDue = async () => { throw new Error('db down'); };
    await expect(runArenaWithdrawTick(NOW, deps)).resolves.toEqual({ dispatched: 0, reconciled: 0 });
    expect(JSON.stringify(world.alerts)).not.toContain('api-key');
  });
});

describe('late old-leader result', () => {
  async function slowDispatch(): Promise<{ row: ArenaWithdrawalRecord; done: Promise<unknown>; release: (o: ArenaTransferOutcome) => void }> {
    const row = world.add(withdrawal());
    let release!: (outcome: ArenaTransferOutcome) => void;
    world.transferImpl = () => new Promise((resolve) => { release = resolve; });
    const done = dispatchArenaWithdrawal(world.deps(), world.get(row.id));
    await flush();
    expect(world.transfers).toHaveLength(1);
    // A new leader 3 min later moves the stale 'dispatching' row to 'unknown'.
    world.now = at(3 * MIN);
    await reconcileArenaWithdrawal(world.deps(), world.get(row.id), world.now);
    expect(world.get(row.id)).toMatchObject({ state: 'unknown', errorCode: 'dispatch_interrupted' });
    return { row, done, release };
  }

  test('attachSignature on the unknown row, then confirmed by signature', async () => {
    const { row, done, release } = await slowDispatch();
    release({ kind: 'sent', txSignature: 'SIG_LATE', recipientAccountCreated: false });
    expect(await done).toBe('cas_lost');
    expect(world.get(row.id)).toMatchObject({ state: 'unknown', txSignature: 'SIG_LATE' });
    world.statuses.set('SIG_LATE', { finalized: true, err: null });
    world.txs.set('SIG_LATE', usdcTx({ blockTime: unix(NOW) }));
    await tick(world, 4 * MIN);
    expect(world.get(row.id).state).toBe('confirmed');
    expect(world.transfers).toHaveLength(1);
  });

  test('attach reuse error books needs_review tx_reused with a critical alert', async () => {
    world.add(dispatched({ state: 'confirmed', txSignature: 'SIG_LATE', agentId: 'agent-old', finalizedAt: at(-HOUR) }));
    const { row, done, release } = await slowDispatch();
    release({ kind: 'sent', txSignature: 'SIG_LATE', recipientAccountCreated: false });
    await done;
    expect(world.get(row.id)).toMatchObject({ state: 'needs_review', errorCode: 'tx_reused', txSignature: null });
    expect(world.causes('withdraw:tx_reused')[0]?.severity).toBe('critical');
  });
});

describe('matchWithdrawTransfer (I7: amount alone never matches)', () => {
  const usdcRow = dispatched();
  const solRow = dispatched({ asset: 'SOL', amountAtomic: 2_000_000n });

  test('USDC exact owner, mint and amount deltas match; a missing destination pre entry counts as 0', () => {
    expect(matchWithdrawTransfer(usdcTx(), usdcRow)).toBe('match');
    expect(matchWithdrawTransfer(usdcTx({ destPre: null }), usdcRow)).toBe('match');
    expect(matchWithdrawTransfer(usdcTx({ destPre: 7_000_000n }), usdcRow)).toBe('match');
  });

  test('same amount to another destination owner, another mint, another amount, or another payer: no match', () => {
    expect(matchWithdrawTransfer(usdcTx({ dest: OTHER }), usdcRow)).toBe('no_match');
    expect(matchWithdrawTransfer(usdcTx({ mint: OTHER }), usdcRow)).toBe('no_match');
    expect(matchWithdrawTransfer(usdcTx({ amount: 100_001n }), usdcRow)).toBe('no_match');
    expect(matchWithdrawTransfer(usdcTx({ source: OTHER }), usdcRow)).toBe('no_match');
    expect(matchWithdrawTransfer(usdcTx({ sourceDelta: 0n }), usdcRow)).toBe('no_match');
  });

  test('a chain error is chain_error; a transaction without meta never matches', () => {
    expect(matchWithdrawTransfer(usdcTx({ err: { InstructionError: [0, 'Custom'] } }), usdcRow)).toBe('chain_error');
    expect(matchWithdrawTransfer({ ...usdcTx(), meta: null }, usdcRow)).toBe('no_match');
  });

  test('SOL: destination +amount and source -(amount + fee) match; a source delta without the fee does not', () => {
    expect(matchWithdrawTransfer(solTx(), solRow)).toBe('match');
    expect(matchWithdrawTransfer(solTx({ sourceDelta: 2_000_000n }), solRow)).toBe('no_match');
    expect(matchWithdrawTransfer(solTx({ dest: OTHER }), solRow)).toBe('no_match');
    expect(matchWithdrawTransfer(solTx({ amount: 1_999_999n }), solRow)).toBe('no_match');
  });
});

describe('reconcile by signature', () => {
  test('exact match -> confirmed with the source post balance', async () => {
    const row = world.add(dispatched({ state: 'sent', txSignature: 'SIG_A', errorCode: null }));
    world.statuses.set('SIG_A', { finalized: true, err: null });
    world.txs.set('SIG_A', usdcTx());
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'confirmed', postBalanceAtomic: 4_900_000n });
  });

  test('false confirm blocked: same amount, another destination owner -> needs_review chain_mismatch, critical', async () => {
    const row = world.add(dispatched({ state: 'sent', txSignature: 'SIG_A', errorCode: null }));
    world.statuses.set('SIG_A', { finalized: true, err: null });
    world.txs.set('SIG_A', usdcTx({ dest: OTHER }));
    for (let i = 0; i < 3; i += 1) await tick(world, i * 30_000);
    expect(world.get(row.id)).toMatchObject({ state: 'needs_review', errorCode: 'chain_mismatch' });
    const alerts = world.causes('withdraw:needs_review:chain_mismatch');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe('critical');
  });

  test('finalized with err -> failed chain_error', async () => {
    const row = world.add(dispatched({ state: 'sent', txSignature: 'SIG_A', errorCode: null }));
    world.statuses.set('SIG_A', { finalized: true, err: { InstructionError: [0, 'Custom'] } });
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'failed', errorCode: 'chain_error' });
  });

  test('not finalized -> touched; finalized but no transaction body yet -> touched', async () => {
    const row = world.add(dispatched({ state: 'sent', txSignature: 'SIG_A', errorCode: null }));
    world.statuses.set('SIG_A', { finalized: false, err: null });
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'sent', checkCount: 1 });
    world.statuses.set('SIG_A', { finalized: true, err: null });
    await tick(world, 30_000);
    expect(world.get(row.id)).toMatchObject({ state: 'sent', checkCount: 2 });
  });

  test('not found: touched before the sent give-up; after it a covered, resolved history + the balance rule decide', async () => {
    const row = world.add(dispatched({ state: 'sent', txSignature: 'SIG_GONE', errorCode: null, dispatchedAt: at(-20 * MIN) }));
    world.live = { ...world.live, transactions: [{ signature: 'SIG_OLD_DEPOSIT', status: 'success' }] };
    world.txs.set('SIG_OLD_DEPOSIT', usdcTx({ source: OTHER, dest: SOURCE, amount: 5_000_000n, blockTime: unix(at(-2 * HOUR)) }));
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'sent', checkCount: 1 });
    await tick(world, 11 * MIN);
    expect(world.get(row.id)).toMatchObject({ state: 'failed_no_send', errorCode: 'not_found_no_drop' });
    expect(world.transfers).toHaveLength(0);
  });
});

describe('reconcile an unknown row without a signature (history + exact match)', () => {
  /** History: the given items plus an old deposit that proves the window is covered. */
  function history(items: Array<{ signature: string; status?: string; tx?: ArenaWithdrawChainTx }>, covered = true): void {
    const list = [...items];
    if (covered) list.push({ signature: 'SIG_OLD_DEPOSIT', tx: usdcTx({ source: OTHER, dest: SOURCE, amount: 5_000_000n, blockTime: unix(at(-2 * HOUR)) }) });
    world.live = { ...world.live, transactions: list.map((item) => ({ signature: item.signature, status: item.status ?? 'success' })) };
    for (const item of list) if (item.tx) world.txs.set(item.signature, item.tx);
  }

  test('one history match -> confirmed with that signature', async () => {
    const row = world.add(dispatched());
    history([{ signature: 'SIG_M', tx: usdcTx() }, { signature: 'SIG_X', tx: usdcTx({ dest: OTHER }) }]);
    world.live = { ...world.live, usdcAtomic: 4_900_000n };
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'confirmed', txSignature: 'SIG_M', postBalanceAtomic: 4_900_000n });
    expect(world.transfers).toHaveLength(0);
  });

  test('two matches -> needs_review ambiguous_match, critical', async () => {
    const row = world.add(dispatched());
    history([{ signature: 'SIG_M1', tx: usdcTx() }, { signature: 'SIG_M2', tx: usdcTx() }]);
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'needs_review', errorCode: 'ambiguous_match', txSignature: null });
    expect(world.causes('withdraw:needs_review:ambiguous_match')[0]?.severity).toBe('critical');
  });

  test('a signature used by another row is skipped (never fetched, never matched)', async () => {
    world.add(dispatched({ state: 'confirmed', txSignature: 'SIG_USED', agentId: 'agent-old', finalizedAt: at(-HOUR) }));
    const row = world.add(dispatched({ dispatchedAt: at(-5 * MIN) }));
    history([{ signature: 'SIG_USED', tx: usdcTx({ blockTime: unix(at(-4 * MIN)) }) }]);
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'unknown', txSignature: null, checkCount: 1 });
  });

  test('a failed history item and a match from before the window are not candidates', async () => {
    const row = world.add(dispatched({ dispatchedAt: at(-20 * MIN) }));
    history([
      { signature: 'SIG_FAILED', status: 'failed', tx: usdcTx() },
      { signature: 'SIG_EARLY', tx: usdcTx({ blockTime: unix(at(-22 * MIN)) }) },
    ]);
    await tick(world);
    expect(world.get(row.id).state).not.toBe('confirmed');
    expect(world.get(row.id).txSignature).toBeNull();
  });

  test('no match under 15 min -> stays unknown (touched)', async () => {
    const row = world.add(dispatched({ dispatchedAt: at(-5 * MIN) }));
    history([{ signature: 'SIG_X', tx: usdcTx({ dest: OTHER, blockTime: unix(at(-4 * MIN)) }) }]);
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'unknown', checkCount: 1 });
  });

  test('window not covered -> stays unknown even after 15 min with no drop', async () => {
    const row = world.add(dispatched({ dispatchedAt: at(-20 * MIN) }));
    history([{ signature: 'SIG_X', tx: usdcTx({ dest: OTHER, blockTime: unix(at(-10 * MIN)) }) }], false);
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'unknown', checkCount: 1 });
  });

  test('window still not covered after 24 h -> needs_review not_found_balance_drop, critical', async () => {
    const row = world.add(dispatched({ dispatchedAt: at(-25 * HOUR) }));
    history([{ signature: 'SIG_X', tx: usdcTx({ dest: OTHER, blockTime: unix(at(-HOUR)) }) }], false);
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'needs_review', errorCode: 'not_found_balance_drop' });
    expect(world.causes('withdraw:needs_review:not_found_balance_drop')[0]?.severity).toBe('critical');
  });

  test('no match after 15 min with no balance drop -> failed_no_send not_found_no_drop', async () => {
    const row = world.add(dispatched({ dispatchedAt: at(-20 * MIN) }));
    history([{ signature: 'SIG_X', tx: usdcTx({ dest: OTHER }) }]);
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'failed_no_send', errorCode: 'not_found_no_drop' });
    expect(world.transfers).toHaveLength(0);
  });

  test('no match after 15 min with a drop >= amount -> needs_review not_found_balance_drop', async () => {
    const row = world.add(dispatched({ dispatchedAt: at(-20 * MIN) }));
    history([{ signature: 'SIG_X', tx: usdcTx({ dest: OTHER }) }]);
    world.live = { ...world.live, usdcAtomic: 4_900_000n };
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'needs_review', errorCode: 'not_found_balance_drop' });
  });

  test('add-on spend since dispatch is added to the drop (contract §4 step 4): never a false failed_no_send', async () => {
    const row = world.add(dispatched({ dispatchedAt: at(-20 * MIN) }));
    history([{ signature: 'SIG_X', tx: usdcTx({ dest: OTHER }) }]);
    world.live = { ...world.live, usdcAtomic: 4_950_000n };
    world.addonSpentUsd = 0.05;
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'needs_review', errorCode: 'not_found_balance_drop' });
  });

  test('a live wallet that is not the row source never decides', async () => {
    const row = world.add(dispatched({ dispatchedAt: at(-20 * MIN) }));
    history([{ signature: 'SIG_X', tx: usdcTx({ dest: OTHER }) }]);
    world.live = { ...world.live, address: OTHER };
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'unknown', checkCount: 1 });
  });

  test('budget short: the history read is skipped', async () => {
    const row = world.add(dispatched());
    world.budget = false;
    await tick(world);
    expect(world.calls.readWalletLive).toBe(0);
    expect(world.get(row.id).state).toBe('unknown');
  });
});

describe('Codex money review blockers (B2, B3, B4)', () => {
  const OLD_DEPOSIT = (): ArenaWithdrawChainTx => usdcTx({ source: OTHER, dest: SOURCE, amount: 5_000_000n, blockTime: unix(at(-2 * HOUR)) });

  function listHistory(items: Array<{ signature: string; status?: string | null; tx?: ArenaWithdrawChainTx }>): void {
    world.live = {
      ...world.live,
      transactions: items.map((item) => ({ signature: item.signature, status: item.status === undefined ? 'success' : item.status })),
    };
    for (const item of items) if (item.tx) world.txs.set(item.signature, item.tx);
  }

  test('B2: a sent signature not found + a deposit that hides the drop + an uncovered window -> never failed_no_send', async () => {
    const row = world.add(dispatched({ state: 'sent', txSignature: 'SIG_GONE', errorCode: null, dispatchedAt: at(-40 * MIN) }));
    listHistory([{ signature: 'SIG_NEW_DEPOSIT', tx: usdcTx({ source: OTHER, dest: SOURCE, amount: 100_000n, blockTime: unix(at(-10 * MIN)) }) }]);
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'sent', checkCount: 1 });
  });

  test('B2: the signature is listed in the ClawPump history -> no decision (touched)', async () => {
    const row = world.add(dispatched({ state: 'sent', txSignature: 'SIG_GONE', errorCode: null, dispatchedAt: at(-40 * MIN) }));
    listHistory([{ signature: 'SIG_GONE' }, { signature: 'SIG_OLD_DEPOSIT', tx: OLD_DEPOSIT() }]);
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'sent', checkCount: 1 });
  });

  test('B2: an unresolved in-window history item -> no decision (touched)', async () => {
    const row = world.add(dispatched({ state: 'sent', txSignature: 'SIG_GONE', errorCode: null, dispatchedAt: at(-40 * MIN) }));
    listHistory([{ signature: 'SIG_PENDING' }, { signature: 'SIG_OLD_DEPOSIT', tx: OLD_DEPOSIT() }]);
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'sent', checkCount: 1 });
  });

  test('B2: a history read error never decides; after 24 h it goes to an operator', async () => {
    const row = world.add(dispatched({ state: 'sent', txSignature: 'SIG_GONE', errorCode: null, dispatchedAt: at(-25 * HOUR) }));
    world.liveError = new ClawPumpWriterError('timeout');
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'needs_review', errorCode: 'not_found_balance_drop' });
  });

  test('B3: one match + an unresolved other candidate -> not confirmed until it resolves', async () => {
    const row = world.add(dispatched());
    listHistory([{ signature: 'SIG_M', tx: usdcTx() }, { signature: 'SIG_PENDING' }, { signature: 'SIG_OLD_DEPOSIT', tx: OLD_DEPOSIT() }]);
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'unknown', txSignature: null, checkCount: 1 });
    world.txs.set('SIG_PENDING', usdcTx({ dest: OTHER, blockTime: unix(at(-19 * MIN)) }));
    await tick(world, 30_000);
    expect(world.get(row.id)).toMatchObject({ state: 'confirmed', txSignature: 'SIG_M' });
  });

  test('B3: an unresolved in-window candidate blocks a no-match decision (no failed_no_send)', async () => {
    const row = world.add(dispatched({ dispatchedAt: at(-20 * MIN) }));
    listHistory([{ signature: 'SIG_PENDING' }, { signature: 'SIG_OLD_DEPOSIT', tx: OLD_DEPOSIT() }]);
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'unknown', checkCount: 1 });
  });

  test('B3: a history item with an unknown status breaks coverage (one match is not confirmed)', async () => {
    const row = world.add(dispatched());
    listHistory([
      { signature: 'SIG_M', tx: usdcTx() },
      { signature: 'SIG_Q', status: null, tx: usdcTx({ dest: OTHER }) },
      { signature: 'SIG_OLD_DEPOSIT', tx: OLD_DEPOSIT() },
    ]);
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'unknown', txSignature: null });
  });

  test('B3: a getTransaction throw is unresolved, not a decision; after 24 h it goes to an operator', async () => {
    const row = world.add(dispatched({ dispatchedAt: at(-25 * HOUR) }));
    listHistory([{ signature: 'SIG_X', tx: usdcTx({ dest: OTHER, blockTime: unix(at(-24 * HOUR)) }) }, { signature: 'SIG_OLD_DEPOSIT', tx: OLD_DEPOSIT() }]);
    const deps = world.deps();
    deps.getTransaction = async () => { throw new Error('rpc 503'); };
    await runArenaWithdrawTick(NOW, deps);
    expect(world.get(row.id)).toMatchObject({ state: 'needs_review', errorCode: 'not_found_balance_drop' });
  });

  test('B3: history listed oldest-first cannot prove a contiguous window', async () => {
    const row = world.add(dispatched({ dispatchedAt: at(-20 * MIN) }));
    listHistory([{ signature: 'SIG_OLD_DEPOSIT', tx: OLD_DEPOSIT() }, { signature: 'SIG_X', tx: usdcTx({ dest: OTHER }) }]);
    await tick(world);
    expect(world.get(row.id)).toMatchObject({ state: 'unknown', checkCount: 1 });
  });

  test('B4: a never-resolving remote read does not block the next tick', async () => {
    const row = world.add(withdrawal());
    const deps = world.deps();
    deps.remoteTimeoutMs = 20;
    let reads = 0;
    deps.readWalletLive = () => {
      reads += 1;
      return new Promise<ClawPumpArenaWalletLive>(() => undefined);
    };
    await runArenaWithdrawTick(NOW, deps);
    await runArenaWithdrawTick(at(30_000), deps);
    expect(reads).toBe(2);
    expect(world.get(row.id).state).toBe('requested');
    expect(world.transfers).toHaveLength(0);
    expect(world.causes('withdraw:balance_unavailable')).toHaveLength(1);
  }, 3_000);

  test('B4: a never-resolving signature status is a read error: touched, alerted once', async () => {
    const row = world.add(dispatched({ state: 'sent', txSignature: 'SIG_A', errorCode: null }));
    const deps = world.deps();
    deps.remoteTimeoutMs = 20;
    deps.getSignatureStatus = () => new Promise<ArenaWithdrawSignatureStatus | null>(() => undefined);
    await runArenaWithdrawTick(NOW, deps);
    await runArenaWithdrawTick(at(30_000), deps);
    expect(world.get(row.id)).toMatchObject({ state: 'sent', checkCount: 2 });
    expect(world.causes('withdraw:read_error:deadline')).toHaveLength(1);
  }, 3_000);

  test('B4: the remote deadline constant is 20 s', () => {
    expect(ARENA_WITHDRAW_REMOTE_TIMEOUT_MS).toBe(20_000);
  });
});
