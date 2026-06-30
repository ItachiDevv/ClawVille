/**
 * SAP Option C — pluggable verification provider.
 *
 * Option C's property: OOBE holds + releases (escrow), a verifier produces the
 * pass/fail verdict, and ClawVille's backend ENFORCES the coupling (settle ONLY
 * on a `passed` verdict). This module is the verifier seam.
 *
 * The interface is intentionally minimal so a future `CovenantVerificationProvider`
 * (run `covenantd` co-located with our hosted worker agents, `POST /escrow/prove`,
 * map its `audit_root_hex` → our `auditRoot`) DROPS IN with NO interface change.
 *
 * v1 provider = `RequesterApprovalProvider`: the escrow depositor (the requester
 * who funded the work) must EXPLICITLY approve the job before a settle can fire.
 * That is the simplest trustworthy gate for the first use case and needs no
 * external runtime. The `auditRoot` it returns is the sha256 of a CANONICAL
 * encoding of (escrowId, jobId, approver, approvedAt) so the on-chain release is
 * bound to a specific, reproducible approval record.
 */

import { createHash } from 'crypto';

/**
 * Context describing the job a provider must verify. Deliberately generic — a
 * provider reads only what it needs.
 */
export interface VerificationJobContext {
  /** The on-chain escrow PDA (base58) the settle would release from. */
  escrowId: string;
  /** Off-chain job id (the (escrow, job) idempotency key's job half). */
  jobId: string;
  /** Depositor (requester) avatar id — for the approval provider, the approver. */
  depositorAvatarId: string;
  /** Worker (service) avatar id — the settle beneficiary. */
  workerAvatarId: string;
  /**
   * Provider-specific signal. For RequesterApproval: `{ approved: boolean;
   * approverAvatarId: string; approvedAt: string }`. For a future Covenant
   * provider: the work/result handle to prove. Opaque to the gate.
   */
  signal?: Record<string, unknown>;
}

/**
 * A verification verdict. `auditRoot` is a 32-byte digest bound into the
 * on-chain `service_hash` so the release is provably tied to THIS verdict.
 */
export interface VerificationResult {
  /** true authorizes a settle; false NEVER settles. */
  passed: boolean;
  /** 32-byte audit root → the on-chain `service_hash`. */
  auditRoot: Uint8Array;
  /** Optional human-readable detail (why it passed / failed). */
  detail?: string;
}

/**
 * The single-method abstraction. A provider takes a job context and resolves to
 * a verdict. Stateless from the gate's perspective — the gate persists the
 * outcome.
 */
export interface VerificationProvider {
  /** Stable provider id, persisted on the settlement row for provenance. */
  readonly id: string;
  verify(ctx: VerificationJobContext): Promise<VerificationResult>;
}

/** A 32 zero-byte audit root — the "no verdict / fail" sentinel. */
const ZERO_AUDIT_ROOT = new Uint8Array(32);

/**
 * Canonical sha256 over (escrowId, jobId, approver, approvedAt). NUL-separated so
 * distinct tuples can never collide. Deterministic + reproducible: the same
 * approval always yields the same root, which is exactly what an on-chain
 * provenance binding needs.
 */
export function requesterApprovalAuditRoot(parts: {
  escrowId: string;
  jobId: string;
  approver: string;
  approvedAt: string;
}): Uint8Array {
  const h = createHash('sha256');
  h.update(Buffer.from(parts.escrowId, 'utf8'));
  h.update(Buffer.from([0]));
  h.update(Buffer.from(parts.jobId, 'utf8'));
  h.update(Buffer.from([0]));
  h.update(Buffer.from(parts.approver, 'utf8'));
  h.update(Buffer.from([0]));
  h.update(Buffer.from(parts.approvedAt, 'utf8'));
  return new Uint8Array(h.digest());
}

/**
 * v1 provider — the escrow depositor (requester) must explicitly approve the
 * job. The approval is carried in `ctx.signal` (set by the route from a
 * persisted, authenticated approval action — NOT trusted from an arbitrary
 * request body for live money; see the escrow-gate FEATURE_GATE).
 *
 * passed = true ONLY when:
 *   - `signal.approved === true`, AND
 *   - the approver is the depositor (`signal.approverAvatarId === depositorAvatarId`).
 * Anything else fails CLOSED with a zero audit root (which the gate refuses to
 * settle on).
 */
export class RequesterApprovalProvider implements VerificationProvider {
  readonly id = 'requester-approval';

  async verify(ctx: VerificationJobContext): Promise<VerificationResult> {
    const signal = ctx.signal ?? {};
    const approved = signal.approved === true;
    const approver = typeof signal.approverAvatarId === 'string' ? signal.approverAvatarId : null;
    const approvedAt =
      typeof signal.approvedAt === 'string' && signal.approvedAt.length > 0
        ? signal.approvedAt
        : null;

    if (!approved || !approver || !approvedAt) {
      return {
        passed: false,
        auditRoot: ZERO_AUDIT_ROOT,
        detail: 'requester has not approved this job',
      };
    }
    if (approver !== ctx.depositorAvatarId) {
      // Only the depositor (the one whose funds are at stake) may approve.
      return {
        passed: false,
        auditRoot: ZERO_AUDIT_ROOT,
        detail: 'approver is not the escrow depositor (requester)',
      };
    }

    const auditRoot = requesterApprovalAuditRoot({
      escrowId: ctx.escrowId,
      jobId: ctx.jobId,
      approver,
      approvedAt,
    });
    return { passed: true, auditRoot, detail: 'requester approved' };
  }
}

/**
 * FUTURE (drop-in, NOT wired in v1): a CovenantVerificationProvider would
 * implement the SAME interface — `verify()` POSTs to a co-located `covenantd`'s
 * `/escrow/prove`, verifies the ed25519 proof against the daemon pubkey, and maps
 * `audit_root_hex` → `auditRoot`. No interface change, no gate change: swap the
 * provider instance passed to `runEscrowGate`. See PLAN.md "ADJUSTED OPTION C".
 *
 * Example shape (left as documentation, not code, so v1 has no dead Covenant dep):
 *   class CovenantVerificationProvider implements VerificationProvider {
 *     readonly id = 'covenant';
 *     async verify(ctx) {
 *       const proof = await ssrfGuardedPost(covenantUrl + '/escrow/prove', {...});
 *       assertEd25519(proof.signature_b58, proof.signer_pubkey_b58, daemonPubkey);
 *       return { passed: proof.validation_passed,
 *                auditRoot: hexToBytes(proof.audit_root_hex) };
 *     }
 *   }
 */

/** The default v1 provider singleton (requester-approval). */
export const defaultVerificationProvider: VerificationProvider = new RequesterApprovalProvider();
