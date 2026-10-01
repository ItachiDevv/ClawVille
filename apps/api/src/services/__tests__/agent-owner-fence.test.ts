import { beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetAgentOwnerFenceForTests,
  agentOwnerBoundSince,
  markAgentOwnedNow,
  ownerBindSnapshot,
} from '../agent-owner-fence';

// Security 2026-09-30 (round 2b): the in-process owner fence. An owner bind
// marks the agentId; a credentialless connect that resolves later is refused.
// connect-sec round 4 (2026-10-01, Codex C2): the check has no clock. A request
// takes `ownerBindSnapshot()` before it touches the row; a bind marked after
// that refuses it however long the request stalls. The five-minute clock
// reader (`agentOwnedRecently`) is deleted.

const FIVE_MINUTES = 5 * 60_000;

beforeEach(() => {
  __resetAgentOwnerFenceForTests();
});

describe('agent owner fence: bind sequence (no expiry)', () => {
  test('an unmarked agentId is not fenced', () => {
    expect(agentOwnerBoundSince('seq-unmarked', ownerBindSnapshot())).toBe(false);
    expect(agentOwnerBoundSince('seq-unmarked', 0)).toBe(false);
  });

  test('a mark after the snapshot fences its own agentId only', () => {
    const snapshot = ownerBindSnapshot();
    markAgentOwnedNow('seq-a');
    expect(agentOwnerBoundSince('seq-a', snapshot)).toBe(true);
    expect(agentOwnerBoundSince('seq-b', snapshot)).toBe(false);
  });

  test('a mark before the snapshot does not fence a later request', () => {
    markAgentOwnedNow('seq-earlier');
    const snapshot = ownerBindSnapshot();
    expect(agentOwnerBoundSince('seq-earlier', snapshot)).toBe(false);
  });

  test('a later mark fences a request that started between the two marks', () => {
    markAgentOwnedNow('seq-twice');
    const snapshot = ownerBindSnapshot();
    expect(agentOwnerBoundSince('seq-twice', snapshot)).toBe(false);
    markAgentOwnedNow('seq-twice');
    expect(agentOwnerBoundSince('seq-twice', snapshot)).toBe(true);
  });

  test('a mark stamped with a clock far in the past still fences', () => {
    const snapshot = ownerBindSnapshot();
    markAgentOwnedNow('seq-stalled', Date.now() - FIVE_MINUTES - 1_000);
    expect(agentOwnerBoundSince('seq-stalled', snapshot)).toBe(true);
  });

  test('the test reset clears marks but keeps the sequence monotonic', () => {
    const snapshot = ownerBindSnapshot();
    markAgentOwnedNow('seq-reset');
    __resetAgentOwnerFenceForTests();
    expect(agentOwnerBoundSince('seq-reset', snapshot)).toBe(false);
    markAgentOwnedNow('seq-reset');
    expect(agentOwnerBoundSince('seq-reset', snapshot)).toBe(true);
    expect(ownerBindSnapshot()).toBeGreaterThan(snapshot);
  });
});
