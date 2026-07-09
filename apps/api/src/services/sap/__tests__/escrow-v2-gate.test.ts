/**
 * SAP V2 release-gate lifecycle tests.
 *
 * The database and every chain executor are in-memory fakes: these tests exercise
 * authorization, accounting, lifecycle, and broadcast-unknown posture without an
 * RPC connection or a real custodial signer.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as realDatabase from '@clawville/database';

type TestRow = Record<string, unknown> & {
  id: string;
  escrowPda: string;
  jobId: string;
  depositorAvatarId: string;
  workerAvatarId: string;
  status: string;
};

const DEPOSITOR = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const DEPOSITOR_WALLET = 'DepositorWallet111111111111111111111111111';
const WORKER_WALLET = 'WorkerWallet111111111111111111111111111111';
const ESCROW = 'V2Escrow11111111111111111111111111111111111';

let rows: TestRow[] = [];
let approval: Record<string, unknown> | null = null;
let walletRead = 0;
let inspectPending = false;
let inspectIndex = 7n;
let settleCalls = 0;
let finalizeCalls = 0;
let createCalls = 0;
let settleOutcome: Record<string, unknown>;
let finalizeOutcome: Record<string, unknown>;

function thenable(value: unknown) {
  return {
    then(resolve: (v: unknown) => unknown) {
      return Promise.resolve(resolve(value));
    },
  };
}

function updateBuilder(set: Record<string, unknown>) {
  const apply = () => {
    const row = rows[0];
    if (row) Object.assign(row, set);
    return row;
  };
  const chain = {
    where() {
      apply();
      return chain;
    },
    returning() {
      const row = apply();
      return Promise.resolve(row ? [row] : []);
    },
    then(resolve: (v: unknown) => unknown) {
      apply();
      return Promise.resolve(resolve(undefined));
    },
  };
  return chain;
}

const fakeDb = {
  query: {
    wallets: {
      findFirst: async () => ({ publicKey: walletRead++ === 0 ? WORKER_WALLET : DEPOSITOR_WALLET }),
    },
    sapEscrowSettlements: {
      findFirst: async () => rows[0],
      findMany: async () => rows,
    },
    sapEscrowApprovals: {
      findFirst: async () => approval,
    },
  },
  insert(table: unknown) {
    return {
      values(values: Record<string, unknown>) {
        if (table === realDatabase.sapEscrowSettlements) {
          const duplicate = rows.some(
            (r) => r.escrowPda === values.escrowPda && r.jobId === values.jobId,
          );
          if (duplicate) {
            const error = Object.assign(new Error('duplicate'), { code: '23505' });
            return { returning: async () => Promise.reject(error) };
          }
          const row = {
            id: `row-${rows.length + 1}`,
            callsSettled: null,
            releasedAmount: null,
            reservedPrincipalAmount: null,
            feeAmount: null,
            refundedAmount: null,
            settleSignature: null,
            settlementIndex: null,
            finalizeSignature: null,
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date(),
            settledAt: null,
            ...values,
          } as unknown as TestRow;
          rows.push(row);
          return { returning: async () => [row] };
        }

        approval = {
          ...values,
          approvedAt: new Date('2026-07-09T12:00:00.000Z'),
        };
        return {
          onConflictDoUpdate(args: { set: Record<string, unknown> }) {
            approval = { ...approval, ...args.set };
            return thenable(undefined);
          },
        };
      },
    };
  },
  update() {
    return { set: (values: Record<string, unknown>) => updateBuilder(values) };
  },
  delete() {
    return {
      where: async () => {
        rows = [];
      },
    };
  },
  select() {
    return {
      from() {
        return { where: async () => rows };
      },
    };
  },
  async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const tx = {
      execute: async () => undefined,
      select: fakeDb.select,
      update: fakeDb.update,
    };
    return fn(tx);
  },
};

mock.module('@clawville/database', () => ({ ...realDatabase, db: fakeDb }));

const dryRunSuccess = (accounts: Record<string, string> = {}) => ({
  ok: true as const,
  dryRun: true as const,
  simulation: { err: null, logs: [], accounts: null, unitsConsumed: 1, returnData: null },
  accepted: true,
  programReached: 'yes' as const,
  accounts,
});

mock.module('../sap-client', () => ({
  sapConfigSnapshot: () => ({
    enabled: true,
    escrowEnabled: true,
    usdcEscrowEnabled: true,
    payaiSettlementEnabled: true,
    dryRun: true,
    cluster: 'devnet',
  }),
  resolveV2UsdcEscrowAddress: () => ({
    ok: true,
    escrowPda: { toBase58: () => ESCROW },
    mint: { toBase58: () => 'USDCMint111111111111111111111111111111111' },
  }),
  inspectV2SettlementState: async () => ({
    ok: true,
    escrowPda: ESCROW,
    settlementIndex: inspectIndex,
    pendingExists: inspectPending,
  }),
  createEscrowV2Usdc: async () => {
    createCalls += 1;
    return dryRunSuccess({ escrow: ESCROW });
  },
  depositEscrowV2Usdc: async () => dryRunSuccess({ escrow: ESCROW }),
  settleCallsV2Usdc: async () => {
    settleCalls += 1;
    return settleOutcome;
  },
  finalizeSettlementUsdc: async () => {
    finalizeCalls += 1;
    return finalizeOutcome;
  },
  loadAvatarWalletForSigning: async () => ({
    ok: false,
    code: 'internal',
    message: 'unused',
  }),
  // V1 imports remain present so the gate module can load; no V1 executor is
  // reached by this file.
  resolveUsdcEscrowAddresses: () => ({ ok: false, code: 'internal', message: 'unused' }),
  createEscrowUsdc: async () => ({ ok: false, code: 'internal', message: 'unused' }),
  depositEscrowUsdc: async () => ({ ok: false, code: 'internal', message: 'unused' }),
  settleCallsUsdc: async () => ({ ok: false, code: 'internal', message: 'unused' }),
  withdrawEscrowUsdc: async () => ({ ok: false, code: 'internal', message: 'unused' }),
}));

const gate = await import('../escrow-gate');

function baseRow(overrides: Record<string, unknown> = {}): TestRow {
  return {
    id: 'row-1',
    escrowPda: ESCROW,
    escrowVersion: 'v2',
    escrowNonce: '9',
    jobId: 'job-1',
    depositorAvatarId: DEPOSITOR,
    workerAvatarId: WORKER,
    workerWalletPubkey: WORKER_WALLET,
    depositorWalletPubkey: DEPOSITOR_WALLET,
    tokenMint: 'USDCMint111111111111111111111111111111111',
    pricePerCall: '1000000',
    maxCalls: '5',
    fundedAmount: '5050000',
    callsSettled: null,
    releasedAmount: null,
    reservedPrincipalAmount: null,
    feeAmount: null,
    refundedAmount: null,
    status: 'open',
    dryRun: true,
    metadata: { rail: 'onchain', funded: true },
    createdAt: new Date(),
    updatedAt: new Date(),
    settledAt: null,
    ...overrides,
  } as TestRow;
}

async function persistApproval(approvedCalls = 5n) {
  const result = await gate.approveJob({
    escrowPda: ESCROW,
    jobId: 'job-1',
    callerAvatarId: DEPOSITOR,
    approvedCalls,
  });
  if (!result.ok) throw new Error(`approval setup failed: ${result.code}: ${result.message}; row=${JSON.stringify(rows[0])}`);
  expect(result.ok).toBe(true);
}

beforeEach(() => {
  rows = [];
  approval = null;
  walletRead = 0;
  inspectPending = false;
  inspectIndex = 7n;
  settleCalls = 0;
  finalizeCalls = 0;
  createCalls = 0;
  settleOutcome = dryRunSuccess({ escrow: ESCROW, settlementIndex: '7' });
  finalizeOutcome = dryRunSuccess({ escrow: ESCROW });
});

describe('SAP V2 gate — two-phase USDC release', () => {
  it('opens, approves, settles to pending, then permissionlessly finalizes principal', async () => {
    const opened = await gate.openEscrowV2({
      depositorAvatarId: DEPOSITOR,
      workerAvatarId: WORKER,
      jobId: 'job-1',
      escrowNonce: 9n,
      pricePerCall: 1_000_000n,
      maxCalls: 5n,
      initialDeposit: 5_050_000n,
      expiresAt: 0n,
    });
    expect(opened.ok).toBe(true);
    expect(createCalls).toBe(1);
    expect(rows[0]?.escrowVersion).toBe('v2');
    expect(rows[0]?.escrowNonce).toBe('9');

    await persistApproval(2n);
    const settled = await gate.settleJobV2({
      escrowPda: ESCROW,
      jobId: 'job-1',
      callerAvatarId: WORKER,
      callsToSettle: 2n,
    });
    expect(settled.ok).toBe(true);
    if (settled.ok) expect(settled.phase).toBe('pending');
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.settlementIndex).toBe('7');
    expect(rows[0]?.callsSettled).toBe('2');
    expect(rows[0]?.reservedPrincipalAmount).toBe('2000000');
    expect(rows[0]?.releasedAmount ?? null).toBeNull();
    expect(rows[0]?.feeAmount).toBe('10000');

    const finalized = await gate.finalizeJobV2({
      escrowPda: ESCROW,
      jobId: 'job-1',
      callerAvatarId: STRANGER,
    });
    expect(finalized.ok).toBe(true);
    if (finalized.ok) expect(finalized.phase).toBe('settled');
    expect(rows[0]?.status).toBe('settled');
    expect(rows[0]?.releasedAmount).toBe('2000000');
    expect(rows[0]?.reservedPrincipalAmount).toBe('0');
    expect(finalizeCalls).toBe(1);
  });

  it('returns finalize guidance for pending and settled replay without re-sending settle', async () => {
    rows = [baseRow({ status: 'pending', settlementIndex: '7', callsSettled: '1' })];
    const pendingReplay = await gate.settleJobV2({
      escrowPda: ESCROW,
      jobId: 'job-1',
      callerAvatarId: WORKER,
      callsToSettle: 1n,
    });
    expect(pendingReplay.ok).toBe(true);
    if (pendingReplay.ok && pendingReplay.phase === 'pending') {
      expect(pendingReplay.phase).toBe('pending');
      expect(pendingReplay.replay).toBe(true);
    }
    expect(settleCalls).toBe(0);

    rows[0]!.status = 'settled';
    const settledReplay = await gate.settleJobV2({
      escrowPda: ESCROW,
      jobId: 'job-1',
      callerAvatarId: WORKER,
      callsToSettle: 1n,
    });
    expect(settledReplay.ok).toBe(true);
    if (settledReplay.ok) expect(settledReplay.phase).toBe('settled');
    expect(settleCalls).toBe(0);
  });

  it('reconciles an authoritative existing pending PDA and never sends settle', async () => {
    rows = [baseRow()];
    await persistApproval();
    inspectPending = true;
    const result = await gate.settleJobV2({
      escrowPda: ESCROW,
      jobId: 'job-1',
      callerAvatarId: WORKER,
      callsToSettle: 1n,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.phase).toBe('pending');
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.settlementIndex).toBe('7');
    expect(settleCalls).toBe(0);
  });

  it('rejects an over-release at the persisted approval ceiling before claiming', async () => {
    rows = [baseRow()];
    await persistApproval(1n);
    const result = await gate.settleJobV2({
      escrowPda: ESCROW,
      jobId: 'job-1',
      callerAvatarId: WORKER,
      callsToSettle: 2n,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('over_release');
    expect(rows[0]?.status).toBe('open');
    expect(settleCalls).toBe(0);
  });

  it('rejects non-worker settle and non-depositor approval', async () => {
    rows = [baseRow()];
    const settle = await gate.settleJobV2({
      escrowPda: ESCROW,
      jobId: 'job-1',
      callerAvatarId: STRANGER,
      callsToSettle: 1n,
    });
    expect(settle.ok).toBe(false);
    if (!settle.ok) expect(settle.code).toBe('unauthorized_caller');

    const approve = await gate.approveJob({
      escrowPda: ESCROW,
      jobId: 'job-1',
      callerAvatarId: STRANGER,
    });
    expect(approve.ok).toBe(false);
    if (!approve.ok) expect(approve.code).toBe('approver_mismatch');
    expect(settleCalls).toBe(0);
  });

  it('restores pending after a clean pre-broadcast early-finalize refusal', async () => {
    rows = [baseRow({
      status: 'pending',
      settlementIndex: '7',
      reservedPrincipalAmount: '1000000',
      callsSettled: '1',
    })];
    finalizeOutcome = {
      ok: false,
      code: 'on_chain_error',
      message: 'dispute window has not elapsed',
      broadcast: false,
    };
    const result = await gate.finalizeJobV2({
      escrowPda: ESCROW,
      jobId: 'job-1',
      callerAvatarId: STRANGER,
    });
    expect(result.ok).toBe(false);
    expect(rows[0]?.status).toBe('pending');
    expect(finalizeCalls).toBe(1);
  });

  it('holds broadcast-unknown settle and finalize attempts for reconciliation', async () => {
    rows = [baseRow()];
    await persistApproval();
    settleOutcome = {
      ok: false,
      code: 'rpc_unreachable',
      message: 'confirmation timeout',
      broadcast: true,
      signature: 'settle-broadcast-signature',
    };
    const settle = await gate.settleJobV2({
      escrowPda: ESCROW,
      jobId: 'job-1',
      callerAvatarId: WORKER,
      callsToSettle: 1n,
    });
    expect(settle.ok).toBe(false);
    expect(rows[0]?.status).toBe('settle_unknown');
    expect(rows[0]?.settleSignature).toBe('settle-broadcast-signature');

    await gate.settleJobV2({
      escrowPda: ESCROW,
      jobId: 'job-1',
      callerAvatarId: WORKER,
      callsToSettle: 1n,
    });
    expect(settleCalls).toBe(1);

    rows = [baseRow({
      status: 'pending',
      settlementIndex: '7',
      reservedPrincipalAmount: '1000000',
    })];
    finalizeOutcome = {
      ok: false,
      code: 'rpc_unreachable',
      message: 'confirmation timeout',
      broadcast: true,
      signature: 'finalize-broadcast-signature',
    };
    const finalize = await gate.finalizeJobV2({
      escrowPda: ESCROW,
      jobId: 'job-1',
      callerAvatarId: STRANGER,
    });
    expect(finalize.ok).toBe(false);
    expect(rows[0]?.status).toBe('finalize_unknown');
    expect(rows[0]?.finalizeSignature).toBe('finalize-broadcast-signature');

    await gate.finalizeJobV2({ escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: STRANGER });
    expect(finalizeCalls).toBe(1);
  });

  it('refuses a payai row on the V2 release executors', async () => {
    rows = [baseRow({ metadata: { rail: 'payai' } })];
    const settle = await gate.settleJobV2({
      escrowPda: ESCROW,
      jobId: 'job-1',
      callerAvatarId: WORKER,
      callsToSettle: 1n,
    });
    expect(settle.ok).toBe(false);
    if (!settle.ok) expect(settle.code).toBe('release_rail_forbidden');
    expect(settleCalls).toBe(0);

    rows[0]!.status = 'pending';
    rows[0]!.settlementIndex = '7';
    const finalize = await gate.finalizeJobV2({
      escrowPda: ESCROW,
      jobId: 'job-1',
      callerAvatarId: STRANGER,
    });
    expect(finalize.ok).toBe(false);
    if (!finalize.ok) expect(finalize.code).toBe('release_rail_forbidden');
    expect(finalizeCalls).toBe(0);
  });
});
