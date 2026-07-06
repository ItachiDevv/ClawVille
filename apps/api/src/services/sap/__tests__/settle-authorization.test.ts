/**
 * evaluateSettleAuthorization — the verdict→settle gate (money invariant).
 *
 * Codex audit advisory (2026-07-06): on the payai rail the Covenant audit root is
 * bound only OFF-CHAIN (x402 `extra`), so "a settle fires ONLY on a passing verdict
 * carrying a valid 32-byte non-zero audit root" is enforced purely by OUR code, not
 * by the chain/protocol. This test LOCKS that invariant as a named unit so a future
 * refactor can't silently let an unauthorized settle (either rail) through. Both
 * `settleJobLocked` rails (on-chain vault + payai facilitator) reach prepare/claim/
 * release ONLY when this returns `{authorized:true}`.
 */

import { describe, it, expect } from 'bun:test';
import { evaluateSettleAuthorization } from '../escrow-gate';

const validRoot = () => {
  const r = new Uint8Array(32);
  r[0] = 1; // non-zero, exactly 32 bytes
  return r;
};

describe('evaluateSettleAuthorization — no settle without a passing verdict + valid root', () => {
  it('a FAILING verdict is never authorized (no settle) — even with a valid root', () => {
    const auth = evaluateSettleAuthorization({ passed: false, detail: 'work rejected', auditRoot: validRoot() });
    expect(auth.authorized).toBe(false);
    if (!auth.authorized) expect(auth.reason).toBe('work rejected');
  });

  it('a failing verdict with no detail falls back to the canonical reason', () => {
    const auth = evaluateSettleAuthorization({ passed: false, auditRoot: validRoot() });
    expect(auth.authorized).toBe(false);
    if (!auth.authorized) expect(auth.reason).toBe('verification did not pass; no settle.');
  });

  it('a PASSING verdict with an all-zero root is refused (integrity guard)', () => {
    const auth = evaluateSettleAuthorization({ passed: true, auditRoot: new Uint8Array(32) });
    expect(auth.authorized).toBe(false);
    if (!auth.authorized) {
      expect(auth.reason).toBe('verification passed but produced no valid audit root; refusing to settle.');
    }
  });

  it('a PASSING verdict with a wrong-length root is refused', () => {
    for (const len of [0, 16, 31, 33, 64]) {
      const r = new Uint8Array(len).fill(7);
      const auth = evaluateSettleAuthorization({ passed: true, auditRoot: r });
      expect(auth.authorized).toBe(false);
    }
  });

  it('ONLY a passing verdict + valid 32-byte non-zero root authorizes, with the hex root', () => {
    const auth = evaluateSettleAuthorization({ passed: true, auditRoot: validRoot() });
    expect(auth.authorized).toBe(true);
    if (auth.authorized) {
      expect(auth.auditRootHex).toBe('01' + '00'.repeat(31));
      expect(auth.auditRootHex.length).toBe(64);
    }
  });
});
