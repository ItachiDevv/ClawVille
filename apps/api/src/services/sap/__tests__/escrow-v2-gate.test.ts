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
// R4-A — the default readV2VaultPhysicalState result (clamp tests inject deps.readVaultState).
// vaultBalance null ⇒ physical-free clamp fails OPEN (ledger ceiling); escrowPendingAmount 0n
// ⇒ the unowned-pending guard passes (0 ≤ gateLivePending).
let vaultBalanceVar: bigint | null = null;
let escrowPendingVar: bigint | null = 0n;
// R4-C — succeeded direct deposits counted as funding (db.query + in-lock tx.select).
let depositLedgerRows: Array<{ amount: string }> = [];
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
    // R4-C — escrowFundsLedger counts succeeded direct deposits as funding (pre-txn read).
    sapDepositRequests: {
      findMany: async () => depositLedgerRows,
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
      // M1/R4-C — table-aware: the in-lock settle re-read selects sapEscrowSettlements
      // (→ rows), sapEscrowWithdrawals (→ withdrawalLockRows), and sapDepositRequests
      // (→ depositLedgerRows, R4-C succeeded-deposit funding).
      from(table: unknown) {
        return {
          where: async () => {
            if (table === realDatabase.sapEscrowWithdrawals) return withdrawalLockRows;
            if (table === realDatabase.sapDepositRequests) return depositLedgerRows;
            return rows;
          },
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

// R4-D — an updatedAt older than SAP_STALE_CLAIM_MS (10 min); 11 min ago is safely stale.
const staleDate = () => new Date(Date.now() - 11 * 60 * 1000);

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
  // R4-A — default physical-state reader: vaultBalance null ⇒ physical-free clamp fails
  // OPEN (ledger ceiling); escrowPendingAmount 0n ⇒ the unowned-pending guard passes.
  // Clamp/guard tests inject `deps.readVaultState` or set vaultBalanceVar/escrowPendingVar.
  readV2VaultPhysicalState: async () => ({ vaultBalance: vaultBalanceVar, escrowPendingAmount: escrowPendingVar }),
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
  vaultBalanceVar = null;
  escrowPendingVar = 0n;
  depositLedgerRows = [];
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

  // (R4-A item 4) The pre-claim "pending already exists at the CURRENT index" reconcile
  // was REMOVED as dead code — under settle-increment the current index is always the
  // next-free slot. Its decoded-booking coverage now lives in the POST-broadcast replay
  // test and the R4-D stale-claim recovery tests below.

  it('R4-A — clamps the ceiling to physical-free (vault − on-chain pending) below the debit (rejects)', async () => {
    rows = [baseRow()];
    await persistApproval();
    // Settlement ledger says 5_050_000 remaining, but the live vault holds only 100 base
    // units (drained out-of-band), pending_amount 0. physicalFree = 100 − 0 = 100 < debit.
    const result = await gate.settleJobV2(
      { escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n },
      { readVaultState: async () => ({ vaultBalance: 100n, escrowPendingAmount: 0n }) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('over_release');
    expect(rows[0]?.status).toBe('open');
    expect(settleCalls).toBe(0);
  });

  it('R4-A — a null vaultBalance (RPC fail) falls back to the ledger ceiling and proceeds', async () => {
    rows = [baseRow()];
    await persistApproval();
    // vaultBalance null ⇒ physical-free clamp fails OPEN; escrowPendingAmount 0n ⇒ the
    // unowned guard passes. The settle proceeds on the ledger ceiling.
    const result = await gate.settleJobV2(
      { escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n },
      { readVaultState: async () => ({ vaultBalance: null, escrowPendingAmount: 0n }) },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.phase).toBe('pending');
    expect(rows[0]?.status).toBe('pending');
    expect(settleCalls).toBe(1);
  });

  it('R4-A — a physical-free AT OR ABOVE the debit does not block the settle', async () => {
    rows = [baseRow()];
    await persistApproval();
    const result = await gate.settleJobV2(
      { escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n },
      { readVaultState: async () => ({ vaultBalance: 1_005_000n, escrowPendingAmount: 0n }) },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.phase).toBe('pending');
    expect(settleCalls).toBe(1);
  });

  it('M1 — the in-lock ledger re-read subtracts booked withdrawals (the RPC-null fallback stays truthful)', async () => {
    rows = [baseRow()];
    await persistApproval();
    // The PRE-txn ledger sees NO withdrawal (withdrawalRows empty) so the ceiling PASSES;
    // a withdrawal booked AFTER that read is visible only IN-LOCK. With vaultBalance null
    // (fail-open clamp), the in-lock subtraction is the ONLY thing that can catch it.
    withdrawalLockRows = [{ amount: '5000000' }]; // funded 5_050_000 − 5_000_000 = 50_000 remaining
    const result = await gate.settleJobV2(
      { escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n },
      { readVaultState: async () => ({ vaultBalance: null, escrowPendingAmount: 0n }) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('over_release');
    expect(rows[0]?.status).toBe('open');
    expect(settleCalls).toBe(0);
  });

  it('R3-1(a) — a replay-signal FALSE-MATCH with broadcast:true + failed re-probe QUARANTINES (settle_unknown, reservation KEPT)', async () => {
    rows = [baseRow()];
    await persistApproval();
    // A GENUINE confirm-timeout (broadcast:true — the tx MAY still land) whose base58
    // signature coincidentally contains '6138' ⇒ isV2ReplaySignal false-matches. The
    // re-probe fails. R3-1: must NOT restore+release (a retry would settle at the NEXT
    // index → two pendings → double release) — fall through to the settle_unknown
    // quarantine with the reservation KEPT.
    settleOutcome = {
      ok: false,
      code: 'rpc_unreachable',
      message: 'confirmation timeout',
      broadcast: true,
      signature: 'sig6138maybelandedXXXXXXXXXXXXXXXXXXXX',
    };
    reprobeOutcome = { ok: false, code: 'rpc_unreachable', message: 'timeout' };
    const result = await gate.settleJobV2({ escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('settle_unconfirmed');
    expect(rows[0]?.status).toBe('settle_unknown');
    expect(rows[0]?.settleSignature).toBe('sig6138maybelandedXXXXXXXXXXXXXXXXXXXX');
    // Reservation KEPT (pessimistic — the tx may land; a retry must never settle again).
    expect(rows[0]?.reservedPrincipalAmount).toBe('1000000');
    expect(rows[0]?.feeAmount).toBe('5000');
    expect(settleCalls).toBe(1);
  });

  it('R3-1(b) — a replay-signal with broadcast falsy (sim) + failed re-probe RESTORES retryable, then a healthy retry reconciles', async () => {
    rows = [baseRow()];
    await persistApproval();
    // A dry-run SIM surfaces a replay error — provably pre-broadcast (nothing hit the
    // wire), so it is safe to restore + release the reservation and retry.
    settleOutcome = {
      ok: true,
      dryRun: true,
      simulation: { err: 'SettlementReplay 6138', logs: [] },
      accepted: false,
      programReached: 'no',
      accounts: {},
    };
    reprobeOutcome = { ok: false, code: 'rpc_unreachable', message: 'timeout' };
    const first = await gate.settleJobV2({ escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.code).toBe('on_chain_error');
    // Provably pre-broadcast → restored to pre-claim 'open', reservation released.
    expect(rows[0]?.status).toBe('open');
    expect(rows[0]?.reservedPrincipalAmount).toBe('0');
    expect((rows[0]?.metadata as Record<string, unknown>)?.replaySignalUnresolved).toBe(true);
    expect(settleCalls).toBe(1);

    // A healthy retry: the row is back to 'open' (provably nothing landed), so the retry
    // genuinely RE-SETTLES from a clean state (settleCalls increments to 2). A clean
    // dry-run success now books 'pending' with the caller's amounts.
    settleOutcome = dryRunSuccess({ escrow: ESCROW, settlementIndex: '7' });
    reprobeOutcome = null;
    const retry = await gate.settleJobV2({ escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n });
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.phase).toBe('pending');
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.callsSettled).toBe('1');
    expect(rows[0]?.reservedPrincipalAmount).toBe('1000000');
    expect(settleCalls).toBe(2);
  });

  it('A1 — the clamp uses physical-free = vault − on-chain pending (a drain that still covers pending is caught)', async () => {
    // A sibling pending job (gate pending 4_000_000) is physically in the vault. The
    // on-chain pending_amount is 4_000_000 (matches the gate). job-1 settles 1 call
    // (debit 1_005_000). The vault holds 4_500_000 (still ≥ pending), so raw min(remaining,
    // vault) would be INERT; physical-free = 4_500_000 − 4_000_000 = 500_000 < 1_005_000.
    rows = [
      baseRow(),
      baseRow({ id: 'row-2', jobId: 'job-2', status: 'pending', settlementIndex: '6', fundedAmount: '4020000', reservedPrincipalAmount: '4000000', feeAmount: '20000' }),
    ];
    await persistApproval();
    const result = await gate.settleJobV2(
      { escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n },
      { readVaultState: async () => ({ vaultBalance: 4_500_000n, escrowPendingAmount: 4_000_000n }) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('over_release');
    expect(rows[0]?.status).toBe('open');
    expect(settleCalls).toBe(0);
  });

  it('A1 — a vault covering the on-chain pending PLUS the debit does not block', async () => {
    rows = [
      baseRow(),
      baseRow({ id: 'row-2', jobId: 'job-2', status: 'pending', settlementIndex: '6', fundedAmount: '4020000', reservedPrincipalAmount: '4000000', feeAmount: '20000' }),
    ];
    await persistApproval();
    // vault = pending 4_000_000 + debit 1_005_000 exactly → physical-free == debit → proceeds.
    const result = await gate.settleJobV2(
      { escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n },
      { readVaultState: async () => ({ vaultBalance: 5_005_000n, escrowPendingAmount: 4_000_000n }) },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.phase).toBe('pending');
    expect(settleCalls).toBe(1);
  });

  it('A2 — the POST-broadcast reconcile refuses when a SIBLING job already owns the pending index', async () => {
    // job-1 settles at index 7, but job-2 already owns pending_7 → the chain settle
    // replays. The post-broadcast re-probe finds pending_7; the sibling guard must refuse
    // and UN-CLAIM job-1 (never double-book), not book it under job-1's row.
    rows = [
      baseRow(),
      baseRow({ id: 'row-2', jobId: 'job-2', status: 'pending', settlementIndex: '7', fundedAmount: '3015000', reservedPrincipalAmount: '3000000', feeAmount: '15000' }),
    ];
    await persistApproval();
    settleOutcome = {
      ok: false, code: 'on_chain_error', message: 'custom program error: SettlementReplay 6138', broadcast: true, signature: 'replay-sig',
    };
    reprobeOutcome = {
      ok: true, escrowPda: ESCROW, settlementIndex: 7n, pendingExists: true,
      pending: { callsToSettle: 3n, amount: 3_000_000n, isFinalized: false, isDisputed: false },
    };
    const result = await gate.settleJobV2({ escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('settle_in_progress');
    // job-1 un-claimed back to 'open' (never adopted the sibling's pending).
    expect(rows[0]?.status).toBe('open');
    expect(settleCalls).toBe(1);
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

  it('R4-A — refuses (unreconciled_onchain_pending) when on-chain pending_amount exceeds the gate-tracked pending', async () => {
    rows = [baseRow()]; // gateLivePending = 0 (row is 'open')
    await persistApproval();
    const result = await gate.settleJobV2(
      { escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n },
      { readVaultState: async () => ({ vaultBalance: 5_050_000n, escrowPendingAmount: 1n }) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unreconciled_onchain_pending');
    expect(rows[0]?.status).toBe('open');
    expect(settleCalls).toBe(0);
  });

  it('R4-A — refuses (pending_state_unverifiable) when pending_amount cannot be read (fail-CLOSED)', async () => {
    rows = [baseRow()];
    await persistApproval();
    const result = await gate.settleJobV2(
      { escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n },
      { readVaultState: async () => ({ vaultBalance: 5_050_000n, escrowPendingAmount: null }) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('pending_state_unverifiable');
    expect(rows[0]?.status).toBe('open');
    expect(settleCalls).toBe(0);
  });

  it('R4-A — physical-free uses on-chain pending, catching a settle_unknown-landed drain the DB reserved-sum misses (Codex #4)', async () => {
    // A sibling row is settle_unknown with 4M reserved — the DB reserved-sum SKIPS
    // settle_unknown, so the OLD vault−reservedInVault clamp would be inert. But the
    // settle_unknown DID land, so escrow.pending_amount = 4M and the vault holds 4.5M →
    // physical-free = 500_000 < debit 1_005_000 → over_release. gateLivePending counts
    // settle_unknown, so the unowned guard passes (4M ≤ 4M) and the clamp bites.
    rows = [
      baseRow(),
      baseRow({ id: 'row-2', jobId: 'job-2', status: 'settle_unknown', settlementIndex: '6', reservedPrincipalAmount: '4000000', feeAmount: '20000' }),
    ];
    await persistApproval();
    const result = await gate.settleJobV2(
      { escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n },
      { readVaultState: async () => ({ vaultBalance: 4_500_000n, escrowPendingAmount: 4_000_000n }) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('over_release');
    expect(rows[0]?.status).toBe('open');
    expect(settleCalls).toBe(0);
  });

  it('R4-C — a succeeded direct deposit counts as funding, so settle after deposit+withdraw still passes (Codex #5)', async () => {
    // job-1 funded 1_005_000; a direct deposit added 1_005_000 (succeeded); a withdraw
    // removed 1_005_000. Without counting the deposit, remaining = 0 and the settle wrongly
    // rejects; with R4-C, remaining = 1_005_000 and it passes.
    rows = [baseRow({ fundedAmount: '1005000', maxCalls: '1' })];
    await persistApproval(1n);
    depositLedgerRows = [{ amount: '1005000' }];
    withdrawalRows = [{ amount: '1005000' }];
    withdrawalLockRows = [{ amount: '1005000' }];
    const result = await gate.settleJobV2(
      { escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n },
      { readVaultState: async () => ({ vaultBalance: 1_005_000n, escrowPendingAmount: 0n }) },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.phase).toBe('pending');
    expect(settleCalls).toBe(1);
  });

  it('R4-D — a STALE settling claim with a live on-chain pending self-heals to pending (decoded)', async () => {
    rows = [baseRow({ status: 'settling', settlementIndex: '7', reservedPrincipalAmount: '2000000', feeAmount: '10000', updatedAt: staleDate() })];
    reprobeOutcome = { ok: true, escrowPda: ESCROW, settlementIndex: 7n, pendingExists: true, pending: { callsToSettle: 2n, amount: 2_000_000n, isFinalized: false, isDisputed: false } };
    const result = await gate.settleJobV2({ escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.phase).toBe('pending');
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.callsSettled).toBe('2');
    expect(rows[0]?.reservedPrincipalAmount).toBe('2000000');
    expect(settleCalls).toBe(0);
  });

  it('R4-D — a STALE finalizing claim whose pending is already finalized self-heals to settled', async () => {
    rows = [baseRow({ status: 'finalizing', settlementIndex: '7', callsSettled: '2', reservedPrincipalAmount: '2000000', feeAmount: '10000', updatedAt: staleDate() })];
    reprobeOutcome = { ok: true, escrowPda: ESCROW, settlementIndex: 7n, pendingExists: true, pending: { callsToSettle: 2n, amount: 2_000_000n, isFinalized: true, isDisputed: false } };
    const result = await gate.finalizeJobV2({ escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: STRANGER });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.phase).toBe('settled');
    expect(rows[0]?.status).toBe('settled');
    expect(rows[0]?.releasedAmount).toBe('2000000');
    expect(rows[0]?.reservedPrincipalAmount).toBe('0');
    expect(finalizeCalls).toBe(0);
  });

  it('R4-D — a STALE settling claim with a DISPUTED pending refuses, row untouched', async () => {
    rows = [baseRow({ status: 'settling', settlementIndex: '7', reservedPrincipalAmount: '2000000', feeAmount: '10000', updatedAt: staleDate() })];
    reprobeOutcome = { ok: true, escrowPda: ESCROW, settlementIndex: 7n, pendingExists: true, pending: { callsToSettle: 2n, amount: 2_000_000n, isFinalized: false, isDisputed: true } };
    const result = await gate.settleJobV2({ escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('on_chain_error');
    expect(rows[0]?.status).toBe('settling');
    expect(settleCalls).toBe(0);
  });

  it('R4-D — a STALE settling claim whose pending PDA is ABSENT restores to submitted (settle never landed)', async () => {
    rows = [baseRow({ status: 'settling', settlementIndex: '7', reservedPrincipalAmount: '1000000', feeAmount: '5000', updatedAt: staleDate() })];
    reprobeOutcome = { ok: true, escrowPda: ESCROW, settlementIndex: 7n, pendingExists: false };
    const result = await gate.settleJobV2({ escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.phase).toBe('submitted');
    expect(rows[0]?.status).toBe('submitted');
    expect(rows[0]?.reservedPrincipalAmount).toBe('0');
    expect(rows[0]?.feeAmount).toBe('0');
    expect(settleCalls).toBe(0);
  });

  it('R4-D — a STALE finalizing claim whose pending PDA is ABSENT refuses (finalize_unresolvable)', async () => {
    rows = [baseRow({ status: 'finalizing', settlementIndex: '7', callsSettled: '1', reservedPrincipalAmount: '1000000', feeAmount: '5000', updatedAt: staleDate() })];
    reprobeOutcome = { ok: true, escrowPda: ESCROW, settlementIndex: 7n, pendingExists: false };
    const result = await gate.settleJobV2({ escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('finalize_unresolvable');
    expect(rows[0]?.status).toBe('finalizing');
    expect(settleCalls).toBe(0);
  });

  it('R4-D — a STALE claim whose on-chain probe FAILS refuses retryable (never guesses)', async () => {
    rows = [baseRow({ status: 'settling', settlementIndex: '7', reservedPrincipalAmount: '1000000', feeAmount: '5000', updatedAt: staleDate() })];
    reprobeOutcome = { ok: false, code: 'rpc_unreachable', message: 'timeout' };
    const result = await gate.settleJobV2({ escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('rpc_unreachable');
    expect(rows[0]?.status).toBe('settling');
    expect(settleCalls).toBe(0);
  });

  it('R4-D — a NON-stale settling claim keeps the byte-identical settle_in_progress refusal', async () => {
    rows = [baseRow({ status: 'settling', updatedAt: new Date() })];
    const result = await gate.settleJobV2({ escrowPda: ESCROW, jobId: 'job-1', callerAvatarId: WORKER, callsToSettle: 1n });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('settle_in_progress');
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
