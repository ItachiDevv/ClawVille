/**
 * Salvage approach gate — friction behaviour.
 *
 * These cases pin what the gate actually promises, which is narrower than it
 * looks. It is NOT anti-cheat: position updates are not authoritative, so a
 * determined client can satisfy every case below by lying about where it is.
 * What is pinned here is that the gate is not FREE — a teleport costs at least
 * as much wall-clock as the swim would have, a token is bound to one avatar and
 * one node, and it expires.
 *
 * Pure and deterministic: every case injects `nowMs` and `secret`, so nothing
 * depends on the wall clock or on environment configuration.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  SALVAGE_APPROACH_DWELL_MS,
  SALVAGE_APPROACH_RANGE_WU,
  SALVAGE_APPROACH_TOKEN_TTL_MS,
  SALVAGE_MAX_SPEED_WU_PER_S,
  getSalvageNode,
} from '@clawville/shared';
import {
  issueApproachToken,
  resetSalvageApproachAnchors,
  verifyApproachToken,
} from '../salvage-approach';

const SECRET = 'approach-suite-secret-0123456789abcdef';
const NODE = getSalvageNode('shelf-01')!;
const SUBJECT = 'avatar-under-test';

/** Walk the happy path and return the issued token. */
function earnToken(startMs: number, subject = SUBJECT): string {
  // Anchor at the node (first probe always refuses and records).
  issueApproachToken({ subject, nodeId: NODE.id, x: NODE.x, z: NODE.z, nowMs: startMs, secret: SECRET });
  // Second probe starts the dwell.
  issueApproachToken({
    subject, nodeId: NODE.id, x: NODE.x, z: NODE.z, nowMs: startMs + 100, secret: SECRET,
  });
  // Third probe, after the dwell has elapsed.
  const verdict = issueApproachToken({
    subject,
    nodeId: NODE.id,
    x: NODE.x,
    z: NODE.z,
    nowMs: startMs + 100 + SALVAGE_APPROACH_DWELL_MS,
    secret: SECRET,
  });
  if (!verdict.ok) throw new Error(`expected a token, got ${verdict.code}`);
  return verdict.token;
}

describe('issueApproachToken', () => {
  beforeEach(resetSalvageApproachAnchors);

  it('refuses the first probe and records an anchor', () => {
    const verdict = issueApproachToken({
      subject: SUBJECT, nodeId: NODE.id, x: NODE.x, z: NODE.z, nowMs: 1_000, secret: SECRET,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    // Documented cost: one dwell period on a fresh anchor. Not a defect.
    expect(verdict.code).toBe('anchor_pending');
  });

  it('refuses an unknown node outright', () => {
    const verdict = issueApproachToken({
      subject: SUBJECT, nodeId: 'not-a-node', x: 0, z: 0, nowMs: 1_000, secret: SECRET,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe('node_unknown');
  });

  it('refuses while out of range, however long you loiter', () => {
    const far = { x: NODE.x + SALVAGE_APPROACH_RANGE_WU + 50, z: NODE.z };
    issueApproachToken({ subject: SUBJECT, nodeId: NODE.id, ...far, nowMs: 0, secret: SECRET });
    for (const t of [1_000, 5_000, 60_000]) {
      const verdict = issueApproachToken({
        subject: SUBJECT, nodeId: NODE.id, ...far, nowMs: t, secret: SECRET,
      });
      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error('unreachable');
      expect(verdict.code).toBe('out_of_range');
    }
  });

  it('refuses until the dwell has actually elapsed', () => {
    issueApproachToken({
      subject: SUBJECT, nodeId: NODE.id, x: NODE.x, z: NODE.z, nowMs: 0, secret: SECRET,
    });
    issueApproachToken({
      subject: SUBJECT, nodeId: NODE.id, x: NODE.x, z: NODE.z, nowMs: 10, secret: SECRET,
    });
    const tooSoon = issueApproachToken({
      subject: SUBJECT,
      nodeId: NODE.id,
      x: NODE.x,
      z: NODE.z,
      nowMs: 10 + SALVAGE_APPROACH_DWELL_MS - 1,
      secret: SECRET,
    });
    expect(tooSoon.ok).toBe(false);
    if (tooSoon.ok) throw new Error('unreachable');
    expect(tooSoon.code).toBe('dwell_pending');
  });

  it('issues a token once the dwell is served in range', () => {
    const token = earnToken(0);
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(2);
  });

  it('restarts the dwell when you switch nodes', () => {
    const other = getSalvageNode('shelf-02')!;
    issueApproachToken({
      subject: SUBJECT, nodeId: NODE.id, x: NODE.x, z: NODE.z, nowMs: 0, secret: SECRET,
    });
    issueApproachToken({
      subject: SUBJECT, nodeId: NODE.id, x: NODE.x, z: NODE.z, nowMs: 10, secret: SECRET,
    });
    // Switching target must not inherit the dwell accrued at the first node,
    // otherwise one wait would arm every node you pass.
    //
    // The travel time is computed, not guessed: these two nodes are ~3,584 wu
    // apart, so anything under ~8.6 s is (correctly) rejected as an impossible
    // jump before the dwell rule is ever reached. An earlier draft of this case
    // used 1 s and failed for exactly that reason.
    const travelMs =
      (Math.hypot(other.x - NODE.x, other.z - NODE.z) / SALVAGE_MAX_SPEED_WU_PER_S) * 1000;
    const switched = issueApproachToken({
      subject: SUBJECT,
      nodeId: other.id,
      x: other.x,
      z: other.z,
      nowMs: 10 + Math.ceil(travelMs) + 1_000,
      secret: SECRET,
    });
    expect(switched.ok).toBe(false);
    if (switched.ok) throw new Error('unreachable');
    expect(switched.code).toBe('dwell_pending');
  });

  describe('teleport poisoning', () => {
    it('refuses an impossible jump and quotes how long the walk would have taken', () => {
      issueApproachToken({
        subject: SUBJECT, nodeId: NODE.id, x: 0, z: 0, nowMs: 0, secret: SECRET,
      });
      // 10,000 wu in 100 ms. At 420 wu/s that is a ~23.7 s walk.
      const verdict = issueApproachToken({
        subject: SUBJECT, nodeId: NODE.id, x: 10_000, z: 0, nowMs: 100, secret: SECRET,
      });
      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error('unreachable');
      expect(verdict.code).toBe('impossible_movement');
      const expectedMs = ((10_000 - SALVAGE_MAX_SPEED_WU_PER_S * 0.1) / SALVAGE_MAX_SPEED_WU_PER_S) * 1000;
      expect(verdict.retryAfterMs).toBeGreaterThan(expectedMs - 50);
      expect(verdict.retryAfterMs).toBeLessThan(expectedMs + 50);
    });

    it('keeps refusing during the poisoned window even while standing on the node', () => {
      issueApproachToken({
        subject: SUBJECT, nodeId: NODE.id, x: 0, z: 0, nowMs: 0, secret: SECRET,
      });
      issueApproachToken({
        subject: SUBJECT, nodeId: NODE.id, x: NODE.x, z: NODE.z, nowMs: 100, secret: SECRET,
      });
      const verdict = issueApproachToken({
        subject: SUBJECT, nodeId: NODE.id, x: NODE.x, z: NODE.z, nowMs: 1_000, secret: SECRET,
      });
      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error('unreachable');
      expect(verdict.code).toBe('movement_poisoned');
    });

    it('accrues NO dwell while poisoned — the penalty is not free waiting time', () => {
      issueApproachToken({
        subject: SUBJECT, nodeId: NODE.id, x: 0, z: 0, nowMs: 0, secret: SECRET,
      });
      // Jump ~4,200 wu instantly => ~10 s of poison.
      issueApproachToken({
        subject: SUBJECT, nodeId: NODE.id, x: NODE.x, z: NODE.z, nowMs: 10, secret: SECRET,
      });
      // Sit on the node for 9 s: still poisoned, and dwell is reset each probe.
      const stillPoisoned = issueApproachToken({
        subject: SUBJECT, nodeId: NODE.id, x: NODE.x, z: NODE.z, nowMs: 9_000, secret: SECRET,
      });
      expect(stillPoisoned.ok).toBe(false);
      // The first probe AFTER the poison clears must start a fresh dwell, not
      // hand out a token for the time spent poisoned.
      const justAfter = issueApproachToken({
        subject: SUBJECT, nodeId: NODE.id, x: NODE.x, z: NODE.z, nowMs: 30_000, secret: SECRET,
      });
      expect(justAfter.ok).toBe(false);
      if (justAfter.ok) throw new Error('unreachable');
      expect(justAfter.code).toBe('dwell_pending');
    });

    it('allows movement that IS possible at the speed cap', () => {
      issueApproachToken({
        subject: SUBJECT, nodeId: NODE.id, x: NODE.x - 400, z: NODE.z, nowMs: 0, secret: SECRET,
      });
      // 400 wu in 2 s is 200 wu/s, well under the 420 cap.
      const walked = issueApproachToken({
        subject: SUBJECT, nodeId: NODE.id, x: NODE.x, z: NODE.z, nowMs: 2_000, secret: SECRET,
      });
      expect(walked.ok).toBe(false);
      if (walked.ok) throw new Error('unreachable');
      // Refused for DWELL, not for movement — the walk itself was accepted.
      expect(walked.code).toBe('dwell_pending');
    });
  });
});

describe('verifyApproachToken', () => {
  beforeEach(resetSalvageApproachAnchors);

  it('accepts a token for the subject and node it was issued to', () => {
    const token = earnToken(0);
    const verdict = verifyApproachToken({
      token,
      subject: SUBJECT,
      nodeId: NODE.id,
      nowMs: SALVAGE_APPROACH_DWELL_MS + 200,
      secret: SECRET,
    });
    expect(verdict.ok).toBe(true);
  });

  it('rejects a token replayed by a DIFFERENT avatar', () => {
    const token = earnToken(0);
    const verdict = verifyApproachToken({
      token,
      subject: 'someone-else',
      nodeId: NODE.id,
      nowMs: SALVAGE_APPROACH_DWELL_MS + 200,
      secret: SECRET,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe('invalid_token');
  });

  it('rejects a token spent at a DIFFERENT node', () => {
    // Otherwise you could dwell once at a convenient node and claim a far one.
    const token = earnToken(0);
    const verdict = verifyApproachToken({
      token,
      subject: SUBJECT,
      nodeId: 'deep-11',
      nowMs: SALVAGE_APPROACH_DWELL_MS + 200,
      secret: SECRET,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe('invalid_token');
  });

  it('rejects a token signed with a different secret', () => {
    const token = earnToken(0);
    const verdict = verifyApproachToken({
      token,
      subject: SUBJECT,
      nodeId: NODE.id,
      nowMs: SALVAGE_APPROACH_DWELL_MS + 200,
      secret: 'a-completely-different-secret',
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe('invalid_token');
  });

  it('expires', () => {
    const token = earnToken(0);
    const issuedAt = SALVAGE_APPROACH_DWELL_MS + 100;
    const verdict = verifyApproachToken({
      token,
      subject: SUBJECT,
      nodeId: NODE.id,
      nowMs: issuedAt + SALVAGE_APPROACH_TOKEN_TTL_MS,
      secret: SECRET,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe('expired_token');
  });

  it('rejects malformed and forged tokens without throwing', () => {
    for (const token of ['', 'garbage', '1.2.3', 'abc.def', `${Date.now()}.notbase64url!!`]) {
      const verdict = verifyApproachToken({
        token, subject: SUBJECT, nodeId: NODE.id, nowMs: Date.now(), secret: SECRET,
      });
      expect(verdict.ok).toBe(false);
    }
  });

  it('rejects a token stamped in the future beyond clock skew', () => {
    const token = earnToken(1_000_000);
    const verdict = verifyApproachToken({
      token,
      subject: SUBJECT,
      nodeId: NODE.id,
      // Claimed issue time is ~1,000,000 ms; "now" is far behind it.
      nowMs: 0,
      secret: SECRET,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe('invalid_token');
  });
});
