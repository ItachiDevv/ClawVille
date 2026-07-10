/**
 * SAP V2 flip-gate fixes — deposit IDEMPOTENCY (doc line 591) + withdraw
 * gate-LEDGER booking (doc line 623), exercised in LIVE mode (dryRun=false) where
 * the durable idempotency/booking logic actually engages. The DB and every chain
 * executor are in-memory fakes: no RPC, no custodial signer.
 *
 * DRY-RUN (the currently-reachable, flags-OFF path) is a straight passthrough and
 * is asserted here too — it must NEVER write the new tables.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as realDatabase from '@clawville/database';

const DEPOSITOR = '11111111-1111-4111-8111-111111111111';
const DEPOSITOR_WALLET = 'DepositorWallet111111111111111111111111111';
const WORKER_WALLET = 'WorkerWallet111111111111111111111111111111';
const ESCROW = 'V2Escrow11111111111111111111111111111111111';
const REQ = 'req-abcdef1234';

let configDryRun = false;
let depositOutcome: Record<string, unknown>;
let withdrawOutcome: Record<string, unknown>;
let depositThrows = false; // M2 — force the executor to THROW (not return a failure)
let depositCalls = 0;
let withdrawCalls = 0;
let depositRows: Array<Record<string, unknown>>;
let withdrawRows: Array<Record<string, unknown>>;

const liveSuccess = (signature: string, accounts: Record<string, string> = { escrow: ESCROW }) => ({
  ok: true as const,
  dryRun: false as const,
  signature,
  accounts,
});

/** Naive single-row update builder (mirrors escrow-v2-gate.test.ts's pattern). */
function depositUpdateBuilder(set: Record<string, unknown>) {
  const apply = () => {
    const r = depositRows[0];
    if (r) Object.assign(r, set);
  };
  return {
    where() {
      apply();
      return Promise.resolve(undefined);
    },
  };
}

const fakeDb = {
  query: {
    wallets: { findFirst: async () => ({ publicKey: DEPOSITOR_WALLET }) },
    sapDepositRequests: { findFirst: async () => depositRows[0] ?? null },
  },
  insert(table: unknown) {
    return {
      values(values: Record<string, unknown>) {
        if (table === realDatabase.sapDepositRequests) {
          // The UNIQUE (subject_avatar_id, request_id) claim lock.
          const duplicate = depositRows.some(
            (r) => r.subjectAvatarId === values.subjectAvatarId && r.requestId === values.requestId,
          );
          if (duplicate) {
            const error = Object.assign(new Error('duplicate'), { code: '23505' });
            return { returning: async () => Promise.reject(error) };
          }
          const row = {
            id: `dep-${depositRows.length + 1}`,
            signature: null,
            outcomeAccounts: null,
            failureCode: null,
            ...values,
          };
          depositRows.push(row);
          return { returning: async () => [row] };
        }
        // sapEscrowWithdrawals — inserted without .returning() (awaited directly).
        const row = { id: `wd-${withdrawRows.length + 1}`, ...values };
        withdrawRows.push(row);
        return {
          then(resolve: (v: unknown) => unknown) {
            return Promise.resolve(resolve(undefined));
          },
        };
      },
    };
  },
  update() {
    return { set: (values: Record<string, unknown>) => depositUpdateBuilder(values) };
  },
  delete() {
    return {
      where: async () => {
        depositRows = [];
      },
    };
  },
};

mock.module('@clawville/database', () => ({ ...realDatabase, db: fakeDb }));

mock.module('../sap-client', () => ({
  sapConfigSnapshot: () => ({
    enabled: true,
    escrowEnabled: true,
    usdcEscrowEnabled: true,
    payaiSettlementEnabled: true,
    dryRun: configDryRun,
    cluster: 'devnet',
  }),
  resolveV2UsdcEscrowAddress: () => ({
    ok: true,
    escrowPda: { toBase58: () => ESCROW },
    mint: { toBase58: () => 'USDCMint111111111111111111111111111111111' },
  }),
  depositEscrowV2Usdc: async () => {
    depositCalls += 1;
    if (depositThrows) throw new Error('unexpected executor throw');
    return depositOutcome;
  },
  withdrawEscrowV2Usdc: async () => {
    withdrawCalls += 1;
    return withdrawOutcome;
  },
  // Imports escrow-gate pulls from sap-client but that deposit/withdraw never
  // reach — present so the gate module loads cleanly.
  readV2VaultBalanceBaseUnits: async () => null,
  inspectV2SettlementState: async () => ({ ok: false, code: 'internal', message: 'unused' }),
  createEscrowV2Usdc: async () => ({ ok: false, code: 'internal', message: 'unused' }),
  finalizeSettlementUsdc: async () => ({ ok: false, code: 'internal', message: 'unused' }),
  settleCallsV2Usdc: async () => ({ ok: false, code: 'internal', message: 'unused' }),
  preflightCreateEscrowV2Coverage: async () => null,
  preflightDepositEscrowV2Coverage: async () => null,
  loadAvatarWalletForSigning: async () => ({ ok: false, code: 'internal', message: 'unused' }),
  resolveUsdcEscrowAddresses: () => ({ ok: false, code: 'internal', message: 'unused' }),
  createEscrowUsdc: async () => ({ ok: false, code: 'internal', message: 'unused' }),
  depositEscrowUsdc: async () => ({ ok: false, code: 'internal', message: 'unused' }),
  settleCallsUsdc: async () => ({ ok: false, code: 'internal', message: 'unused' }),
  withdrawEscrowUsdc: async () => ({ ok: false, code: 'internal', message: 'unused' }),
}));

const gate = await import('../escrow-gate');

beforeEach(() => {
  configDryRun = false;
  depositThrows = false;
  depositCalls = 0;
  withdrawCalls = 0;
  depositRows = [];
  withdrawRows = [];
  depositOutcome = liveSuccess('deposit-sig-1');
  withdrawOutcome = liveSuccess('withdraw-sig-1');
});

function seedDepositRow(overrides: Record<string, unknown> = {}) {
  depositRows = [
    {
      id: 'dep-existing',
      subjectAvatarId: DEPOSITOR,
      requestId: REQ,
      escrowPda: ESCROW,
      amount: '1000000',
      status: 'in_flight',
      signature: null,
      outcomeAccounts: null,
      failureCode: null,
      ...overrides,
    },
  ];
}

describe('FIX 1 — V2 deposit idempotency', () => {
  it('a fresh live deposit claims, funds, and records the succeeded outcome', async () => {
    const result = await gate.depositEscrowV2Idempotent({
      depositorAvatarId: DEPOSITOR,
      workerWalletPubkey: WORKER_WALLET,
      escrowNonce: 9n,
      amount: 1_000_000n,
      requestId: REQ,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.replayed).toBe(false);
      expect(result.chain.ok).toBe(true);
    }
    expect(depositCalls).toBe(1);
    expect(depositRows).toHaveLength(1);
    expect(depositRows[0]?.status).toBe('succeeded');
    expect(depositRows[0]?.signature).toBe('deposit-sig-1');
  });

  it('a concurrent in-flight duplicate is refused WITHOUT re-funding', async () => {
    seedDepositRow({ status: 'in_flight' });
    const result = await gate.depositEscrowV2Idempotent({
      depositorAvatarId: DEPOSITOR,
      workerWalletPubkey: WORKER_WALLET,
      escrowNonce: 9n,
      amount: 1_000_000n,
      requestId: REQ,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('deposit_in_flight');
    // CRITICAL: the on-chain deposit executor must NOT be re-invoked.
    expect(depositCalls).toBe(0);
  });

  it('a replay after terminal success returns the recorded outcome and NEVER re-funds', async () => {
    seedDepositRow({
      status: 'succeeded',
      signature: 'prior-deposit-sig',
      outcomeAccounts: { escrow: ESCROW },
    });
    const result = await gate.depositEscrowV2Idempotent({
      depositorAvatarId: DEPOSITOR,
      workerWalletPubkey: WORKER_WALLET,
      escrowNonce: 9n,
      amount: 1_000_000n,
      requestId: REQ,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.replayed).toBe(true);
      expect(result.chain.ok).toBe(true);
      if (result.chain.ok && !result.chain.dryRun) {
        expect(result.chain.signature).toBe('prior-deposit-sig');
      }
    }
    expect(depositCalls).toBe(0);
  });

  it('the SAME key with a DIFFERENT fingerprint (amount) is 409 key reuse', async () => {
    seedDepositRow({ status: 'succeeded', amount: '1000000', signature: 'prior' });
    const result = await gate.depositEscrowV2Idempotent({
      depositorAvatarId: DEPOSITOR,
      workerWalletPubkey: WORKER_WALLET,
      escrowNonce: 9n,
      amount: 2_000_000n, // differs from the recorded fingerprint (1_000_000)
      requestId: REQ,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('deposit_request_mismatch');
    expect(depositCalls).toBe(0);
  });

  it('a pre-broadcast failure DELETES the claim so the same requestId retries cleanly', async () => {
    depositOutcome = { ok: false, code: 'on_chain_error', message: 'sim rejected', broadcast: false };
    const result = await gate.depositEscrowV2Idempotent({
      depositorAvatarId: DEPOSITOR,
      workerWalletPubkey: WORKER_WALLET,
      escrowNonce: 9n,
      amount: 1_000_000n,
      requestId: REQ,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.chain.ok).toBe(false);
    expect(depositCalls).toBe(1);
    // Claim deleted → a retry with the same requestId is not bricked.
    expect(depositRows).toHaveLength(0);
  });

  it('a broadcast-unknown deposit is held terminal and a replay never re-sends', async () => {
    depositOutcome = {
      ok: false,
      code: 'rpc_unreachable',
      message: 'confirmation timeout',
      broadcast: true,
      signature: 'deposit-broadcast-sig',
    };
    const first = await gate.depositEscrowV2Idempotent({
      depositorAvatarId: DEPOSITOR,
      workerWalletPubkey: WORKER_WALLET,
      escrowNonce: 9n,
      amount: 1_000_000n,
      requestId: REQ,
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.chain.ok).toBe(false);
    expect(depositRows[0]?.status).toBe('broadcast_unknown');
    expect(depositRows[0]?.signature).toBe('deposit-broadcast-sig');

    // Replay — MUST NOT re-send; returns the recorded broadcast-unknown signal.
    const replay = await gate.depositEscrowV2Idempotent({
      depositorAvatarId: DEPOSITOR,
      workerWalletPubkey: WORKER_WALLET,
      escrowNonce: 9n,
      amount: 1_000_000n,
      requestId: REQ,
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.replayed).toBe(true);
      expect(replay.chain.ok).toBe(false);
      if (!replay.chain.ok) expect(replay.chain.broadcast).toBe(true);
    }
    // Only the FIRST attempt reached the chain.
    expect(depositCalls).toBe(1);
  });

  it('DRY-RUN skips the idempotency table entirely (passthrough, no rows)', async () => {
    configDryRun = true;
    const result = await gate.depositEscrowV2Idempotent({
      depositorAvatarId: DEPOSITOR,
      workerWalletPubkey: WORKER_WALLET,
      escrowNonce: 9n,
      amount: 1_000_000n,
      requestId: REQ,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.replayed).toBe(false);
    expect(depositCalls).toBe(1);
    expect(depositRows).toHaveLength(0);
  });

  it('M2 — a THROW after the claim holds it broadcast_unknown (never in_flight), and a replay never re-sends', async () => {
    depositThrows = true;
    const first = await gate.depositEscrowV2Idempotent({
      depositorAvatarId: DEPOSITOR,
      workerWalletPubkey: WORKER_WALLET,
      escrowNonce: 9n,
      amount: 1_000_000n,
      requestId: REQ,
    });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.code).toBe('internal');
    // Held broadcast_unknown (pessimistic) — NOT deleted, NOT stranded in_flight.
    expect(depositRows).toHaveLength(1);
    expect(depositRows[0]?.status).toBe('broadcast_unknown');
    expect(depositRows[0]?.failureCode).toBe('internal'); // R3-4 — canonical code
    expect(depositCalls).toBe(1);

    // Replay with the same key — returns the recorded unconfirmed signal, NO re-send.
    depositThrows = false;
    const replay = await gate.depositEscrowV2Idempotent({
      depositorAvatarId: DEPOSITOR,
      workerWalletPubkey: WORKER_WALLET,
      escrowNonce: 9n,
      amount: 1_000_000n,
      requestId: REQ,
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.replayed).toBe(true);
      expect(replay.chain.ok).toBe(false);
      if (!replay.chain.ok) expect(replay.chain.broadcast).toBe(true);
    }
    expect(depositCalls).toBe(1);
  });
});

describe('FIX 2b — V2 withdraw books the gate ledger', () => {
  it('a confirmed live withdraw books a succeeded ledger row', async () => {
    withdrawOutcome = liveSuccess('withdraw-sig-9');
    const result = await gate.withdrawEscrowV2Booked({
      depositorAvatarId: DEPOSITOR,
      workerWalletPubkey: WORKER_WALLET,
      escrowNonce: 9n,
      amount: 500_000n,
    });
    expect(result.ok).toBe(true);
    expect(withdrawCalls).toBe(1);
    expect(withdrawRows).toHaveLength(1);
    expect(withdrawRows[0]?.status).toBe('succeeded');
    expect(withdrawRows[0]?.amount).toBe('500000');
    expect(withdrawRows[0]?.escrowPda).toBe(ESCROW);
    expect(withdrawRows[0]?.signature).toBe('withdraw-sig-9');
  });

  it('a broadcast-unknown withdraw books PESSIMISTICALLY (subtracted from remaining)', async () => {
    withdrawOutcome = {
      ok: false,
      code: 'rpc_unreachable',
      message: 'confirmation timeout',
      broadcast: true,
      signature: 'withdraw-broadcast-sig',
    };
    const result = await gate.withdrawEscrowV2Booked({
      depositorAvatarId: DEPOSITOR,
      workerWalletPubkey: WORKER_WALLET,
      escrowNonce: 9n,
      amount: 500_000n,
    });
    expect(result.ok).toBe(false);
    expect(withdrawRows).toHaveLength(1);
    expect(withdrawRows[0]?.status).toBe('broadcast_unknown');
    expect(withdrawRows[0]?.signature).toBe('withdraw-broadcast-sig');
  });

  it('a pre-broadcast withdraw failure books NOTHING (nothing left the vault)', async () => {
    withdrawOutcome = { ok: false, code: 'on_chain_error', message: 'sim rejected', broadcast: false };
    const result = await gate.withdrawEscrowV2Booked({
      depositorAvatarId: DEPOSITOR,
      workerWalletPubkey: WORKER_WALLET,
      escrowNonce: 9n,
      amount: 500_000n,
    });
    expect(result.ok).toBe(false);
    expect(withdrawRows).toHaveLength(0);
  });

  it('DRY-RUN books nothing (passthrough)', async () => {
    configDryRun = true;
    withdrawOutcome = { ok: true, dryRun: true, simulation: { err: null, logs: [] }, accepted: true, programReached: 'yes', accounts: {} };
    const result = await gate.withdrawEscrowV2Booked({
      depositorAvatarId: DEPOSITOR,
      workerWalletPubkey: WORKER_WALLET,
      escrowNonce: 9n,
      amount: 500_000n,
    });
    expect(result.ok).toBe(true);
    expect(withdrawCalls).toBe(1);
    expect(withdrawRows).toHaveLength(0);
  });
});
