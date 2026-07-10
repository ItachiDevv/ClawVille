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
// FIX 3 — the DECODED on-chain pending the reconcile must book (NOT the caller's
// numbers). Defaults DIFFER from the tests' requested calls so a test that books
// these values proves it read the chain, not the request.
let inspectPendingDecoded: {
  callsToSettle: bigint;
  amount: bigint;
  isFinalized: boolean;
  isDisputed: boolean;
} = { callsToSettle: 3n, amount: 3_000_000n, isFinalized: false, isDisputed: false };
// M1 — booked withdrawal rows. `withdrawalRows` feeds the PRE-txn escrowFundsLedger
// (db.query); `withdrawalLockRows` feeds the IN-LOCK tx.select. Keeping them separate
// lets a test prove the in-lock subtraction in ISOLATION (pre-txn sees none, in-lock
// sees one — the concurrent-withdraw-between-reads race the in-lock guard closes).
let withdrawalRows: Array<{ amount: string }> = [];
let withdrawalLockRows: Array<{ amount: string }> = [];
// M3 — override for the settle-replay RE-PROBE (inspect called WITH a settlementIndex).
let reprobeOutcome: Record<string, unknown> | null = null;
let inspectIndex = 7n;
let settleCalls = 0;
let finalizeCalls = 0;
let createCalls = 0;
let createCoverageCalls = 0;
let depositCoverageCalls = 0;
let createCoverageOutcome: Record<string, unknown> | null = null;
let depositCoverageOutcome: Record<string, unknown> | null = null;
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
    // FIX 2b / M1 — escrowFundsLedger sums booked V2 withdrawals (pre-txn read).
    sapEscrowWithdrawals: {
      findMany: async () => withdrawalRows,
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
      // M1 — table-aware: the in-lock settle re-read selects BOTH sapEscrowSettlements
      // (→ rows) and sapEscrowWithdrawals (→ withdrawalLockRows).
      from(table: unknown) {
        return {
          where: async () =>
            table === realDatabase.sapEscrowWithdrawals ? withdrawalLockRows : rows,
        };
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
  inspectV2SettlementState: async (input: { settlementIndex?: bigint } = {}) => {
    // M3 — the settle-replay RE-PROBE passes an explicit settlementIndex; let a test
    // override just that call (e.g. an RPC failure) without touching the pre-claim probe.
    if (input.settlementIndex !== undefined && reprobeOutcome) return reprobeOutcome;
    return {
      ok: true,
      escrowPda: ESCROW,
      settlementIndex: inspectIndex,
      pendingExists: inspectPending,
      // FIX 3 — the decoded pending is present iff the PDA exists (mirrors the real
      // client, which decodes the account on a non-null fetch).
      pending: inspectPending ? inspectPendingDecoded : undefined,
    };
  },
  // FIX 2a — default vault reader returns null so the settle claim falls back to
  // the ledger ceiling (the prior behavior); clamp tests inject `deps.readVaultBalance`.
  readV2VaultBalanceBaseUnits: async () => null,
  preflightCreateEscrowV2Coverage: async () => {
    createCoverageCalls += 1;
    return createCoverageOutcome;
  },
  preflightDepositEscrowV2Coverage: async () => {
    depositCoverageCalls += 1;
    return depositCoverageOutcome;
  },
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
  inspectPendingDecoded = { callsToSettle: 3n, amount: 3_000_000n, isFinalized: false, isDisputed: false };
  withdrawalRows = [];
  withdrawalLockRows = [];
  reprobeOutcome = null;
  inspectIndex = 7n;
  settleCalls = 0;
  finalizeCalls = 0;
  createCalls = 0;
  createCoverageCalls = 0;
  depositCoverageCalls = 0;
  createCoverageOutcome = null;
  depositCoverageOutcome = null;
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
    expect(createCoverageCalls).toBe(1);
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

  it('runs a definite create coverage refusal before the ledger claim or chain executor', async () => {
    createCoverageOutcome = {
      ok: false,
      code: 'stake_below_coverage',
      message: 'top up 50000000 more lamports before opening',
    };

    const result = await gate.openEscrowV2({
      depositorAvatarId: DEPOSITOR,
      workerAvatarId: WORKER,
      jobId: 'job-coverage-refused',
      escrowNonce: 10n,
      pricePerCall: 300_000_000n,
      maxCalls: 2n,
      initialDeposit: 606_000_000n,
      expiresAt: 0n,
    });

    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.code).toBe('stake_below_coverage');
    expect(createCoverageCalls).toBe(1);
    expect(rows).toHaveLength(0);
    expect(createCalls).toBe(0);
  });

  it('runs a definite top-up cap refusal before adding a sibling ledger job', async () => {
    rows = [baseRow({ jobId: 'existing-job' })];
    depositCoverageOutcome = {
      ok: false,
      code: 'escrow_coverage_exceeded',
      message: 'projected balance 200000 exceeds max_obligation 100000',
    };

    const result = await gate.openEscrowV2({
      depositorAvatarId: DEPOSITOR,
      workerAvatarId: WORKER,
      jobId: 'top-up-refused',
      escrowNonce: 9n,
      pricePerCall: 10_000n,
      maxCalls: 10n,
      initialDeposit: 150_000n,
      expiresAt: 0n,
    });

    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.code).toBe('escrow_coverage_exceeded');
    expect(depositCoverageCalls).toBe(1);
    expect(rows).toHaveLength(1);
    expect(createCalls).toBe(0);
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

  it('reconciles an authoritative existing pending PDA by booking the DECODED chain amount, never the caller request', async () => {
    rows = [baseRow()];
    await persistApproval();
    inspectPending = true;
    // The on-chain pending reserves 3 calls / 3_000_000 principal; the caller asks
    // for 1. FIX 3: the reconcile MUST book the decoded 3 / 3_000_000 (+ the derived
    // fee), never the caller's 1 / 1_000_000.
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
    expect(rows[0]?.callsSettled).toBe('3');
    expect(rows[0]?.reservedPrincipalAmount).toBe('3000000');
    // computeV2ProtocolFee(3_000_000) = 3_000_000 * 50 / 10_000 = 15_000.
    expect(rows[0]?.feeAmount).toBe('15000');
    expect(settleCalls).toBe(0);
  });

  it('reconciles the DECODED amount even when it is SMALLER than the caller request', async () => {
    rows = [baseRow()];
    await persistApproval();
    inspectPending = true;
    // On-chain pending is only 2 calls / 2_000_000 — the caller (dishonestly or
    // stale) asks for 4. The reconcile books the chain truth (2), never the 4.
    inspectPendingDecoded = { callsToSettle: 2n, amount: 2_000_000n, isFinalized: false, isDisputed: false };
    const result = await gate.settleJobV2({
      escrowPda: ESCROW,
      jobId: 'job-1',
      callerAvatarId: WORKER,
      callsToSettle: 4n,
    });
    expect(result.ok).toBe(true);
    expect(rows[0]?.callsSettled).toBe('2');
    expect(rows[0]?.reservedPrincipalAmount).toBe('2000000');
    expect(rows[0]?.feeAmount).toBe('10000');
    expect(settleCalls).toBe(0);
  });

  it('FIX 2a — clamps the settle ceiling to a LIVE vault read below the debit (rejects, never claims)', async () => {
    rows = [baseRow()];
    await persistApproval();
    // The settlement ledger says 5_050_000 remaining, but the live vault holds only
    // 100 base units (drained out-of-band). The clamp must reject BEFORE claiming.
    const result = await gate.settleJobV2(
      { escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n },
      { readVaultBalance: async () => 100n },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('over_release');
    expect(rows[0]?.status).toBe('open');
    expect(settleCalls).toBe(0);
  });

  it('FIX 2a — a null vault read (RPC failure) falls back to the ledger ceiling and proceeds', async () => {
    rows = [baseRow()];
    await persistApproval();
    const result = await gate.settleJobV2(
      { escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n },
      { readVaultBalance: async () => null },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.phase).toBe('pending');
    expect(rows[0]?.status).toBe('pending');
    expect(settleCalls).toBe(1);
  });

  it('FIX 2a — a live vault read AT OR ABOVE the debit does not block the settle', async () => {
    rows = [baseRow()];
    await persistApproval();
    // Vault holds exactly the total debit (principal 1_000_000 + fee 5_000).
    const result = await gate.settleJobV2(
      { escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n },
      { readVaultBalance: async () => 1_005_000n },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.phase).toBe('pending');
    expect(settleCalls).toBe(1);
  });

  it('M1 — the in-lock ledger re-read subtracts booked withdrawals (the RPC-null fallback stays truthful)', async () => {
    rows = [baseRow()];
    await persistApproval();
    // The PRE-txn ledger sees NO withdrawal (withdrawalRows empty) so the ceiling
    // PASSES; a withdrawal booked AFTER that read is visible only IN-LOCK. With the
    // vault read null, the in-lock subtraction is the ONLY thing that can catch it.
    withdrawalLockRows = [{ amount: '5000000' }]; // funded 5_050_000 − 5_000_000 = 50_000 remaining
    const result = await gate.settleJobV2(
      { escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n },
      { readVaultBalance: async () => null },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('over_release');
    expect(rows[0]?.status).toBe('open');
    expect(settleCalls).toBe(0);
  });

  it('M3 — a settle replay-signal with a FAILED re-probe restores the row (retryable), then a healthy retry reconciles', async () => {
    rows = [baseRow()];
    await persistApproval();
    // Pre-claim probe: no pending → proceeds to claim + chain settle. The chain
    // returns a replay signal; the RE-PROBE (called with a settlementIndex) fails.
    settleOutcome = {
      ok: false,
      code: 'on_chain_error',
      message: 'custom program error: SettlementReplay 6138',
      broadcast: true,
      signature: 'replay-sig',
    };
    reprobeOutcome = { ok: false, code: 'rpc_unreachable', message: 'confirmation timeout' };
    const first = await gate.settleJobV2({ escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.code).toBe('on_chain_error');
    // NOT terminal 'failed' — restored to pre-claim 'open', reservation released.
    expect(rows[0]?.status).toBe('open');
    expect(rows[0]?.reservedPrincipalAmount).toBe('0');
    expect((rows[0]?.metadata as Record<string, unknown>)?.replaySignalUnresolved).toBe(true);
    expect(settleCalls).toBe(1);

    // A healthy retry: the pre-claim probe now decodes the pending → reconciles, no re-send.
    reprobeOutcome = null;
    inspectPending = true;
    inspectPendingDecoded = { callsToSettle: 1n, amount: 1_000_000n, isFinalized: false, isDisputed: false };
    const retry = await gate.settleJobV2({ escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n });
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.phase).toBe('pending');
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.callsSettled).toBe('1');
    expect(rows[0]?.reservedPrincipalAmount).toBe('1000000');
    expect(settleCalls).toBe(1);
  });

  it('M4 — a DISPUTED on-chain pending books NOTHING and leaves the row retryable', async () => {
    rows = [baseRow()];
    await persistApproval();
    inspectPending = true;
    inspectPendingDecoded = { callsToSettle: 2n, amount: 2_000_000n, isFinalized: false, isDisputed: true };
    const result = await gate.settleJobV2({ escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('on_chain_error');
    expect(rows[0]?.status).toBe('open');
    expect(rows[0]?.callsSettled ?? null).toBeNull();
    expect(settleCalls).toBe(0);
  });

  it('M4 — an already-FINALIZED on-chain pending reconciles TERMINAL settled (released, not reserved)', async () => {
    rows = [baseRow()];
    await persistApproval();
    inspectPending = true;
    inspectPendingDecoded = { callsToSettle: 3n, amount: 3_000_000n, isFinalized: true, isDisputed: false };
    const result = await gate.settleJobV2({ escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.phase).toBe('settled');
    expect(rows[0]?.status).toBe('settled');
    expect(rows[0]?.callsSettled).toBe('3');
    // The principal was RELEASED on-chain — booked as released, NOT reserved.
    expect(rows[0]?.releasedAmount).toBe('3000000');
    expect(rows[0]?.reservedPrincipalAmount).toBe('0');
    expect(rows[0]?.feeAmount).toBe('15000');
    expect(settleCalls).toBe(0);
  });

  it('A1 — the vault clamp compares against vault MINUS reserved (a drain that still covers reserved is caught)', async () => {
    // A sibling pending job has 4_000_000 principal reserved — physically in the vault
    // until finalize. job-1 settles 1 call (debit 1_005_000). The vault holds 4_500_000
    // (still ≥ reserved), so the OLD min(remaining, vault) would be INERT; physical-free
    // = 4_500_000 − 4_000_000 = 500_000 < 1_005_000 → over_release.
    rows = [
      baseRow(),
      baseRow({ id: 'row-2', jobId: 'job-2', status: 'pending', settlementIndex: '6', fundedAmount: '4020000', reservedPrincipalAmount: '4000000', feeAmount: '20000' }),
    ];
    await persistApproval();
    const result = await gate.settleJobV2(
      { escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n },
      { readVaultBalance: async () => 4_500_000n },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('over_release');
    expect(rows[0]?.status).toBe('open');
    expect(settleCalls).toBe(0);
  });

  it('A1 — a vault covering reserved PLUS the debit does not block', async () => {
    rows = [
      baseRow(),
      baseRow({ id: 'row-2', jobId: 'job-2', status: 'pending', settlementIndex: '6', fundedAmount: '4020000', reservedPrincipalAmount: '4000000', feeAmount: '20000' }),
    ];
    await persistApproval();
    // vault = reserved 4_000_000 + debit 1_005_000 exactly → physical-free == debit → proceeds.
    const result = await gate.settleJobV2(
      { escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n },
      { readVaultBalance: async () => 5_005_000n },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.phase).toBe('pending');
    expect(settleCalls).toBe(1);
  });

  it('A2 — the pre-claim reconcile refuses when a SIBLING job already owns the on-chain pending index', async () => {
    // job-2 already owns the pending at settlementIndex 7 (status pending). job-1's
    // pre-claim reconcile sees the same on-chain pending and MUST NOT book it again.
    rows = [
      baseRow(),
      baseRow({ id: 'row-2', jobId: 'job-2', status: 'pending', settlementIndex: '7', reservedPrincipalAmount: '3000000', feeAmount: '15000' }),
    ];
    await persistApproval();
    inspectPending = true; // inspectIndex default 7 ⇒ the pending is at index 7
    const result = await gate.settleJobV2({ escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('settle_in_progress');
    // job-1's row is untouched (never double-booked the sibling's pending).
    expect(rows[0]?.status).toBe('open');
    expect(rows[0]?.callsSettled ?? null).toBeNull();
    expect(settleCalls).toBe(0);
  });

  it('A2 — the post-broadcast replay reconcile books the decoded pending under the lock (no sibling)', async () => {
    rows = [baseRow()];
    await persistApproval();
    // The chain settle broadcasts and returns a replay signal; the re-probe finds the
    // pending (index 7). No sibling owns it → book the decoded 2 / 2_000_000.
    settleOutcome = {
      ok: false,
      code: 'on_chain_error',
      message: 'custom program error: SettlementReplay 6138',
      broadcast: true,
      signature: 'replay-sig',
    };
    reprobeOutcome = {
      ok: true,
      escrowPda: ESCROW,
      settlementIndex: 7n,
      pendingExists: true,
      pending: { callsToSettle: 2n, amount: 2_000_000n, isFinalized: false, isDisputed: false },
    };
    const result = await gate.settleJobV2({ escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.phase).toBe('pending');
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.callsSettled).toBe('2');
    expect(rows[0]?.reservedPrincipalAmount).toBe('2000000');
    expect(settleCalls).toBe(1);
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
