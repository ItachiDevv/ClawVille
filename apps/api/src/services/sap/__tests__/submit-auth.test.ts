/**
 * SAP Option C — submitJob caller-auth tests (FIX 1).
 *
 * Proves the SEV-1 fix: only the recorded WORKER may flip an escrow job to
 * `submitted`. Before the fix, submitJob took no caller identity, so ANY authed
 * party (or a connected agent acting as a different avatar) could advance someone
 * else's escrow. Now the route forwards `identity.avatarId` as `callerAvatarId`
 * and submitJob asserts it equals the row's `workerAvatarId`, else
 * `unauthorized_caller`.
 *
 * The `@clawville/database` `db` is stubbed so NO live DB is touched — we only
 * exercise the auth branch (the row is loaded, the caller is checked BEFORE any
 * mutation). The SAP config is forced enabled so `gateOpen()` passes.
 */

import { describe, it, expect, mock } from 'bun:test';
import * as realDatabase from '@clawville/database';

const WORKER_AVATAR = 'worker-avatar-uuid';
const DEPOSITOR_AVATAR = 'depositor-avatar-uuid';
const STRANGER_AVATAR = 'stranger-avatar-uuid';

// The single settlement row submitJob will "find". Worker is WORKER_AVATAR.
const settlementRow = {
  id: 'settlement-uuid',
  escrowPda: 'EscrowPda1111111111111111111111111111111111',
  jobId: 'job-1',
  depositorAvatarId: DEPOSITOR_AVATAR,
  workerAvatarId: WORKER_AVATAR,
  status: 'open' as const,
};

// Track whether any UPDATE was attempted — an unauthorized submit must NEVER
// reach a mutation.
let updateCalled = false;

const fakeDb = {
  query: {
    sapEscrowSettlements: {
      findFirst: async () => settlementRow,
    },
  },
  update() {
    updateCalled = true;
    // Return a faithful-enough chainable that resolves to no-op.
    const chain = {
      set: () => chain,
      where: async () => undefined,
    };
    return chain;
  },
};

mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: fakeDb,
}));

// Force the SAP Option C gate ON so `gateOpen()` (which reads sapConfigSnapshot)
// lets the handler reach the auth check. We only need the gate to pass.
mock.module('../sap-client', () => ({
  sapConfigSnapshot: () => ({
    enabled: true,
    escrowEnabled: true,
    usdcEscrowEnabled: true,
    dryRun: true,
    cluster: 'devnet',
    programId: 'SAPpUhsWLJG1FfkGRcXagEDMrMsWGjbky7AyhGpFETZ',
    rpcUrl: 'https://api.devnet.solana.com',
  }),
  // Unused on this path, but exported so the module shape stays valid.
  createEscrowUsdc: async () => ({ ok: false, code: 'internal', message: 'unused' }),
  depositEscrowUsdc: async () => ({ ok: false, code: 'internal', message: 'unused' }),
  settleCallsUsdc: async () => ({ ok: false, code: 'internal', message: 'unused' }),
  withdrawEscrowUsdc: async () => ({ ok: false, code: 'internal', message: 'unused' }),
  resolveUsdcEscrowAddresses: () => ({ ok: false, code: 'internal', message: 'unused' }),
}));

// Import AFTER the mocks are registered.
const { submitJob } = await import('../escrow-gate');

describe('submitJob — caller must be the worker (FIX 1)', () => {
  it('rejects a NON-worker caller with unauthorized_caller (403) and never mutates', async () => {
    updateCalled = false;
    const res = await submitJob({
      escrowPda: settlementRow.escrowPda,
      jobId: settlementRow.jobId,
      callerAvatarId: STRANGER_AVATAR, // not the worker, not the depositor
    });
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      expect(res.code).toBe('unauthorized_caller');
    }
    // The unauthorized caller must be rejected BEFORE any status mutation.
    expect(updateCalled).toBe(false);
  });

  it('rejects the DEPOSITOR trying to submit (only the worker may submit)', async () => {
    updateCalled = false;
    const res = await submitJob({
      escrowPda: settlementRow.escrowPda,
      jobId: settlementRow.jobId,
      callerAvatarId: DEPOSITOR_AVATAR,
    });
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      expect(res.code).toBe('unauthorized_caller');
    }
    expect(updateCalled).toBe(false);
  });

  it('ALLOWS the recorded worker to submit (advances the row)', async () => {
    updateCalled = false;
    const res = await submitJob({
      escrowPda: settlementRow.escrowPda,
      jobId: settlementRow.jobId,
      callerAvatarId: WORKER_AVATAR,
    });
    expect(res.ok).toBe(true);
    if (res.ok === true) {
      expect(res.phase).toBe('submitted');
    }
    // The worker path DOES reach the status UPDATE.
    expect(updateCalled).toBe(true);
  });
});
