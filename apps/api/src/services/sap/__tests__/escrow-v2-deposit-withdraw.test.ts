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
let withdrawThrows = false; // R4-B — force the withdraw executor to THROW
let depositCalls = 0;
let withdrawCalls = 0;
let withdrawPrepareCalls = 0;
let preparedSignaturesSent: string[] = [];
let depositRows: Array<Record<string, unknown>>;
let withdrawRows: Array<Record<string, unknown>>;
let captureInjectedAtTakeover: Record<string, unknown> | null = null;
let captureSaveBarrierWinner: Record<string, unknown> | null = null;

const liveSuccess = (signature: string, accounts: Record<string, string> = { escrow: ESCROW }) => ({
  ok: true as const,
  dryRun: false as const,
  signature,
  accounts,
});

/** Single-row update builder over a given idempotency-rows array. */
function rowUpdateBuilder(arr: () => Array<Record<string, unknown>>, set: Record<string, unknown>) {
  let applied = false;
  const leaseTakeover =
    'claimId' in set &&
    set.claimId != null &&
    'claimedAt' in set &&
    !('status' in set);
  const eligible = () => {
    const row = arr()[0];
    if (!leaseTakeover) return true;
    const claimedAt = row?.claimedAt;
    return !(claimedAt instanceof Date) || Date.now() - claimedAt.getTime() >= 10 * 60 * 1000;
  };
  const apply = () => {
    const r = arr()[0];
    if (!r || !eligible()) return null;
    if (leaseTakeover && captureInjectedAtTakeover) {
      // Deterministic barrier: the prior owner commits capture immediately before
      // the takeover UPDATE obtains the row lock. UPDATE ... RETURNING must see it.
      Object.assign(r, captureInjectedAtTakeover);
      captureInjectedAtTakeover = null;
    }
    if (
      captureSaveBarrierWinner &&
      typeof set.signature === 'string' &&
      typeof set.serializedTransaction === 'string'
    ) {
      // Deterministic CAS-loss barrier: a takeover winner replaces ownership just
      // before the old owner's capture-save. The old save affects zero rows.
      Object.assign(r, captureSaveBarrierWinner);
      captureSaveBarrierWinner = null;
      applied = true;
      return null;
    }
    if (!applied) Object.assign(r, set);
    applied = true;
    return r;
  };
  const chain = {
    where() {
      return chain;
    },
    returning() {
      const row = apply();
      return Promise.resolve(row ? [row] : []);
    },
    then(resolve: (value: unknown) => unknown) {
      apply();
      return Promise.resolve(resolve(undefined));
    },
  };
  return chain;
}

// R4-B — deposit and withdraw idempotency now use the SAME claim-first pattern on
// sap_deposit_requests / sap_escrow_withdrawals respectively. The fakeDb routes by table.
function rowsFor(table: unknown): 'deposit' | 'withdraw' | null {
  if (table === realDatabase.sapDepositRequests) return 'deposit';
  if (table === realDatabase.sapEscrowWithdrawals) return 'withdraw';
  return null;
}

const fakeDb = {
  query: {
    wallets: { findFirst: async () => ({ publicKey: DEPOSITOR_WALLET }) },
    sapDepositRequests: { findFirst: async () => depositRows[0] ?? null },
    sapEscrowWithdrawals: {
      findFirst: async () => withdrawRows[0] ? { ...withdrawRows[0] } : null,
    },
  },
  insert(table: unknown) {
    const which = rowsFor(table);
    return {
      values(values: Record<string, unknown>) {
        const arr = which === 'deposit' ? depositRows : withdrawRows;
        // The UNIQUE (subject_avatar_id, request_id) claim lock.
        const duplicate = arr.some(
          (r) => r.subjectAvatarId === values.subjectAvatarId && r.requestId === values.requestId,
        );
        if (duplicate) {
          const error = Object.assign(new Error('duplicate'), { code: '23505' });
          return { returning: async () => Promise.reject(error) };
        }
        const row = {
          id: `${which === 'deposit' ? 'dep' : 'wd'}-${arr.length + 1}`,
          signature: null,
          outcomeAccounts: null,
          failureCode: null,
          ...values,
        };
        arr.push(row);
        return { returning: async () => [row] };
      },
    };
  },
  update(table: unknown) {
    const which = rowsFor(table);
    return { set: (values: Record<string, unknown>) => rowUpdateBuilder(() => (which === 'deposit' ? depositRows : withdrawRows), values) };
  },
  delete(table: unknown) {
    const which = rowsFor(table);
    let deleted: Record<string, unknown> | null = null;
    const apply = () => {
      if (deleted) return deleted;
      const arr = which === 'deposit' ? depositRows : withdrawRows;
      deleted = arr[0] ?? null;
      if (which === 'deposit') depositRows = [];
      else withdrawRows = [];
      return deleted;
    };
    const chain = {
      where() { return chain; },
      returning: async () => {
        const row = apply();
        return row ? [row] : [];
      },
      then(resolve: (value: unknown) => unknown) {
        apply();
        return Promise.resolve(resolve(undefined));
      },
    };
    return {
      where() { return chain; },
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
    if (withdrawThrows) throw new Error('unexpected withdraw executor throw');
    return withdrawOutcome;
  },
  prepareWithdrawEscrowV2Usdc: async () => {
    withdrawPrepareCalls += 1;
    const signature =
      typeof withdrawOutcome.signature === 'string'
        ? withdrawOutcome.signature
        : 'withdraw-prepared-signature';
    return {
      ok: true,
      prepared: {
        signature,
        serializedTransaction: 'captured-withdraw-bytes',
        blockhash: 'captured-blockhash',
        lastValidBlockHeight: 123,
        accounts: { escrow: ESCROW },
      },
    };
  },
  sendPreparedSapTransaction: async (_label: string, prepared: { signature: string }) => {
    withdrawCalls += 1;
    preparedSignaturesSent.push(prepared.signature);
    if (withdrawThrows) throw new Error('unexpected withdraw executor throw');
    return withdrawOutcome;
  },
  // Imports escrow-gate pulls from sap-client but that deposit/withdraw never
  // reach — present so the gate module loads cleanly.
  readV2VaultPhysicalState: async () => ({ vaultBalance: null, escrowPendingAmount: 0n, escrowAbsent: false }),
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
  withdrawThrows = false;
  depositCalls = 0;
  withdrawCalls = 0;
  withdrawPrepareCalls = 0;
  preparedSignaturesSent = [];
  depositRows = [];
  withdrawRows = [];
  captureInjectedAtTakeover = null;
  captureSaveBarrierWinner = null;
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
      claimId: 'live-owner',
      claimedAt: new Date(),
      signature: null,
      serializedTransaction: null,
      blockhash: null,
      lastValidBlockHeight: null,
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

  it('a confirmed-reverted deposit restores the requestId and preserves the typed chain error', async () => {
    depositOutcome = {
      ok: false,
      code: 'escrow_expired',
      message: 'deposit confirmed reverted: escrow expired',
      broadcast: true,
      landed: 'confirmed_reverted',
      signature: 'deposit-revert-sig',
    };
    const result = await gate.depositEscrowV2Idempotent({
      depositorAvatarId: DEPOSITOR,
      workerWalletPubkey: WORKER_WALLET,
      escrowNonce: 9n,
      amount: 1_000_000n,
      requestId: REQ,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chain).toMatchObject({
        ok: false,
        code: 'escrow_expired',
        landed: 'confirmed_reverted',
      });
    }
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

function seedWithdrawRow(overrides: Record<string, unknown> = {}) {
  withdrawRows = [
    {
      id: 'wd-existing',
      subjectAvatarId: DEPOSITOR,
      requestId: REQ,
      escrowPda: ESCROW,
      amount: '500000',
      status: 'in_flight',
      claimId: 'live-owner',
      claimedAt: new Date(),
      signature: null,
      serializedTransaction: null,
      blockhash: null,
      lastValidBlockHeight: null,
      outcomeAccounts: null,
      failureCode: null,
      ...overrides,
    },
  ];
}

const wd = (extra: Record<string, unknown> = {}) => ({
  depositorAvatarId: DEPOSITOR,
  workerWalletPubkey: WORKER_WALLET,
  escrowNonce: 9n,
  amount: 500_000n,
  requestId: REQ,
  ...extra,
});

describe('R4-B — V2 withdraw idempotency (claim-first, mirrors deposit)', () => {
  it('a fresh live withdraw claims, sends, and records the succeeded outcome', async () => {
    withdrawOutcome = liveSuccess('withdraw-sig-9');
    const result = await gate.withdrawEscrowV2Idempotent(wd());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.replayed).toBe(false);
      expect(result.chain.ok).toBe(true);
    }
    expect(withdrawCalls).toBe(1);
    expect(withdrawRows).toHaveLength(1);
    expect(withdrawRows[0]?.status).toBe('succeeded');
    expect(withdrawRows[0]?.amount).toBe('500000');
    expect(withdrawRows[0]?.signature).toBe('withdraw-sig-9');
  });

  it('a concurrent in-flight duplicate is refused WITHOUT re-sending', async () => {
    seedWithdrawRow({ status: 'in_flight' });
    const result = await gate.withdrawEscrowV2Idempotent(wd());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('withdraw_in_flight');
    expect(withdrawCalls).toBe(0);
  });

  it('a stale in-flight lease takes over by resending the captured signature, never preparing a second withdrawal', async () => {
    seedWithdrawRow({
      claimId: 'stale-owner',
      claimedAt: new Date(Date.now() - 11 * 60 * 1000),
      signature: 'captured-original-signature',
      serializedTransaction: 'captured-original-bytes',
      blockhash: 'captured-original-blockhash',
      lastValidBlockHeight: 123n,
      outcomeAccounts: { escrow: ESCROW },
    });
    withdrawOutcome = liveSuccess('captured-original-signature');

    const result = await gate.withdrawEscrowV2Idempotent(wd());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.replayed).toBe(true);
    expect(withdrawPrepareCalls).toBe(0);
    expect(preparedSignaturesSent).toEqual(['captured-original-signature']);
    expect(withdrawCalls).toBe(1);
    expect(withdrawRows[0]?.status).toBe('succeeded');
  });

  it('B2 — takeover atomically returns a capture saved at the row-lock barrier', async () => {
    seedWithdrawRow({
      claimId: 'stale-owner',
      claimedAt: new Date(Date.now() - 11 * 60 * 1000),
    });
    captureInjectedAtTakeover = {
      signature: 'barrier-captured-signature',
      serializedTransaction: 'barrier-captured-bytes',
      blockhash: 'barrier-captured-blockhash',
      lastValidBlockHeight: 456n,
      outcomeAccounts: { escrow: ESCROW },
    };
    withdrawOutcome = liveSuccess('barrier-captured-signature');

    const result = await gate.withdrawEscrowV2Idempotent(wd());

    expect(result.ok).toBe(true);
    expect(withdrawPrepareCalls).toBe(0);
    expect(preparedSignaturesSent).toEqual(['barrier-captured-signature']);
  });

  it('B2 — an old owner that loses capture-save CAS stops and replays the winner', async () => {
    withdrawOutcome = liveSuccess('losing-owner-signature');
    captureSaveBarrierWinner = {
      status: 'succeeded',
      signature: 'takeover-winner-signature',
      serializedTransaction: 'takeover-winner-bytes',
      blockhash: 'takeover-winner-blockhash',
      lastValidBlockHeight: 789n,
      outcomeAccounts: { escrow: ESCROW },
      claimId: null,
      claimedAt: null,
    };

    const result = await gate.withdrawEscrowV2Idempotent(wd());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.replayed).toBe(true);
      expect(result.chain.ok).toBe(true);
      if (result.chain.ok && !result.chain.dryRun) {
        expect(result.chain.signature).toBe('takeover-winner-signature');
      }
    }
    expect(withdrawPrepareCalls).toBe(1);
    expect(preparedSignaturesSent).toEqual([]);
    expect(withdrawCalls).toBe(0);
  });

  it('B4 — a legacy terminal row without capture material is accepted read-only', async () => {
    seedWithdrawRow({ status: 'succeeded', signature: 'prior-withdraw-sig', outcomeAccounts: { escrow: ESCROW } });
    const result = await gate.withdrawEscrowV2Idempotent(wd());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.replayed).toBe(true);
      if (result.chain.ok && !result.chain.dryRun) expect(result.chain.signature).toBe('prior-withdraw-sig');
    }
    expect(withdrawCalls).toBe(0);
  });

  it('the SAME key with a DIFFERENT fingerprint (amount) is 409 key reuse', async () => {
    seedWithdrawRow({ status: 'succeeded', amount: '500000', signature: 'prior' });
    const result = await gate.withdrawEscrowV2Idempotent(wd({ amount: 999_999n }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('withdraw_request_mismatch');
    expect(withdrawCalls).toBe(0);
  });

  it('a pre-broadcast failure DELETES the claim so the same requestId retries cleanly', async () => {
    withdrawOutcome = { ok: false, code: 'on_chain_error', message: 'sim rejected', broadcast: false };
    const result = await gate.withdrawEscrowV2Idempotent(wd());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.chain.ok).toBe(false);
    expect(withdrawCalls).toBe(1);
    expect(withdrawRows).toHaveLength(0);
  });

  it('a broadcast-unknown withdraw is held terminal and a replay never re-sends', async () => {
    withdrawOutcome = { ok: false, code: 'rpc_unreachable', message: 'timeout', broadcast: true, signature: 'wd-broadcast-sig' };
    const first = await gate.withdrawEscrowV2Idempotent(wd());
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.chain.ok).toBe(false);
    expect(withdrawRows[0]?.status).toBe('broadcast_unknown');
    expect(withdrawRows[0]?.signature).toBe('wd-broadcast-sig');

    withdrawOutcome = liveSuccess('should-not-be-used');
    const replay = await gate.withdrawEscrowV2Idempotent(wd());
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.replayed).toBe(true);
      expect(replay.chain.ok).toBe(false);
      if (!replay.chain.ok) expect(replay.chain.broadcast).toBe(true);
    }
    expect(withdrawCalls).toBe(1);
  });

  it('a THROW after the claim parks broadcast_unknown + failureCode internal', async () => {
    withdrawThrows = true;
    const first = await gate.withdrawEscrowV2Idempotent(wd());
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.code).toBe('internal');
    expect(withdrawRows).toHaveLength(1);
    expect(withdrawRows[0]?.status).toBe('broadcast_unknown');
    expect(withdrawRows[0]?.failureCode).toBe('internal');
    expect(withdrawCalls).toBe(1);
  });

  it('DRY-RUN is a full passthrough with zero persistence', async () => {
    configDryRun = true;
    withdrawOutcome = { ok: true, dryRun: true, simulation: { err: null, logs: [] }, accepted: true, programReached: 'yes', accounts: {} };
    const result = await gate.withdrawEscrowV2Idempotent(wd());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.replayed).toBe(false);
    expect(withdrawCalls).toBe(1);
    expect(withdrawRows).toHaveLength(0);
  });
});
