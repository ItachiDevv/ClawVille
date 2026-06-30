/**
 * SAP Option C — verification-provider adversarial tests (BLOCKING #1 fix).
 *
 * These are PURE-COMPUTE (no DB) and run unconditionally. They lock down the
 * forgery-resistance contract of the requester-approval provider that the
 * `settleJob` gate relies on:
 *
 *   - A worker cannot pass verification by claiming SOMEONE ELSE is the approver
 *     (approver !== depositor fails CLOSED with the zero sentinel root).
 *   - An "approved:false" / missing-field signal fails closed.
 *   - A genuine depositor approval passes with a NON-ZERO, deterministic root.
 *
 * The route-level guarantee (the signal is built from the PERSISTED approval row,
 * NEVER from a worker's request body) is enforced in `escrow-gate.settleJob` +
 * the removed `approval` body field; this file proves the provider itself can't
 * be tricked even if a bad signal reached it.
 */

import { describe, it, expect } from 'bun:test';
import {
  RequesterApprovalProvider,
  requesterApprovalAuditRoot,
} from '../sap-verification';

const DEPOSITOR = '11111111-1111-1111-1111-111111111111';
const WORKER = '22222222-2222-2222-2222-222222222222';
const ESCROW = 'EscRoWpDa1111111111111111111111111111111111';
const JOB = 'job-abc';

const provider = new RequesterApprovalProvider();

function ctx(signal: Record<string, unknown> | undefined) {
  return {
    escrowId: ESCROW,
    jobId: JOB,
    depositorAvatarId: DEPOSITOR,
    workerAvatarId: WORKER,
    signal,
  };
}

describe('RequesterApprovalProvider — forgery resistance (BLOCKING #1)', () => {
  it('FAILS CLOSED when the worker forges itself as the approver', async () => {
    // The classic attack: worker (the settle beneficiary) claims it approved.
    const verdict = await provider.verify(
      ctx({ approved: true, approverAvatarId: WORKER, approvedAt: new Date().toISOString() }),
    );
    expect(verdict.passed).toBe(false);
    // Zero sentinel root — the gate refuses to settle on it.
    expect(verdict.auditRoot.every((b) => b === 0)).toBe(true);
  });

  it('FAILS CLOSED when the approver is an unrelated third avatar', async () => {
    const verdict = await provider.verify(
      ctx({
        approved: true,
        approverAvatarId: '33333333-3333-3333-3333-333333333333',
        approvedAt: new Date().toISOString(),
      }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.auditRoot.every((b) => b === 0)).toBe(true);
  });

  it('FAILS CLOSED on approved:false even if the approver IS the depositor', async () => {
    const verdict = await provider.verify(
      ctx({ approved: false, approverAvatarId: DEPOSITOR, approvedAt: new Date().toISOString() }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.auditRoot.every((b) => b === 0)).toBe(true);
  });

  it('FAILS CLOSED on a missing/empty signal', async () => {
    expect((await provider.verify(ctx(undefined))).passed).toBe(false);
    expect((await provider.verify(ctx({}))).passed).toBe(false);
    expect(
      (await provider.verify(ctx({ approved: true, approverAvatarId: DEPOSITOR, approvedAt: '' })))
        .passed,
    ).toBe(false);
  });

  it('PASSES only for a genuine depositor approval, with a non-zero deterministic root', async () => {
    const approvedAt = '2026-06-22T00:00:00.000Z';
    const verdict = await provider.verify(
      ctx({ approved: true, approverAvatarId: DEPOSITOR, approvedAt }),
    );
    expect(verdict.passed).toBe(true);
    expect(verdict.auditRoot.length).toBe(32);
    expect(verdict.auditRoot.every((b) => b === 0)).toBe(false);

    // The root is a deterministic binding of (escrow, job, approver, approvedAt) —
    // the on-chain provenance the release is tied to.
    const expected = requesterApprovalAuditRoot({
      escrowId: ESCROW,
      jobId: JOB,
      approver: DEPOSITOR,
      approvedAt,
    });
    expect(Buffer.from(verdict.auditRoot).equals(Buffer.from(expected))).toBe(true);
  });

  it('audit root is distinct per (escrow, job, approver, approvedAt) tuple', () => {
    const base = { escrowId: ESCROW, jobId: JOB, approver: DEPOSITOR, approvedAt: 't' };
    const a = requesterApprovalAuditRoot(base);
    const b = requesterApprovalAuditRoot({ ...base, jobId: 'job-other' });
    const c = requesterApprovalAuditRoot({ ...base, approver: WORKER });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  });
});
