import { beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetAgentOwnerFenceForTests,
  agentOwnedRecently,
  markAgentOwnedNow,
} from '../agent-owner-fence';

// Security 2026-09-30 (round 2b): the in-process owner fence. An owner bind
// marks the agentId; a credentialless connect that resolves later is refused
// while the mark lives (five minutes).

const FIVE_MINUTES = 5 * 60_000;

beforeEach(() => {
  __resetAgentOwnerFenceForTests();
});

describe('agent owner fence', () => {
  test('an unmarked agentId is not fenced', () => {
    expect(agentOwnedRecently('fence-unmarked', 1_000)).toBe(false);
  });

  test('a mark fences only its own agentId until it expires', () => {
    const t0 = 1_000_000;
    markAgentOwnedNow('fence-a', t0);
    expect(agentOwnedRecently('fence-a', t0)).toBe(true);
    expect(agentOwnedRecently('fence-a', t0 + FIVE_MINUTES - 1)).toBe(true);
    expect(agentOwnedRecently('fence-b', t0)).toBe(false);
    // Expiry is exclusive: at exactly five minutes the mark is gone.
    expect(agentOwnedRecently('fence-a', t0 + FIVE_MINUTES)).toBe(false);
    // A read of an expired mark removes it; it stays gone.
    expect(agentOwnedRecently('fence-a', t0)).toBe(false);
  });

  test('a new mark extends the window', () => {
    const t0 = 2_000_000;
    markAgentOwnedNow('fence-extend', t0);
    markAgentOwnedNow('fence-extend', t0 + 60_000);
    expect(agentOwnedRecently('fence-extend', t0 + FIVE_MINUTES + 30_000)).toBe(true);
    expect(agentOwnedRecently('fence-extend', t0 + 60_000 + FIVE_MINUTES)).toBe(false);
  });

  test('marking prunes other expired marks', () => {
    const t0 = 3_000_000;
    markAgentOwnedNow('fence-old', t0);
    markAgentOwnedNow('fence-new', t0 + FIVE_MINUTES);
    // The prune removed the expired mark, so even a read at t0 sees nothing.
    expect(agentOwnedRecently('fence-old', t0)).toBe(false);
    expect(agentOwnedRecently('fence-new', t0 + FIVE_MINUTES)).toBe(true);
  });

  test('the test reset clears every mark', () => {
    markAgentOwnedNow('fence-reset-a', 10);
    markAgentOwnedNow('fence-reset-b', 10);
    __resetAgentOwnerFenceForTests();
    expect(agentOwnedRecently('fence-reset-a', 10)).toBe(false);
    expect(agentOwnedRecently('fence-reset-b', 10)).toBe(false);
  });

  test('the default clock is Date.now()', () => {
    markAgentOwnedNow('fence-default-clock');
    expect(agentOwnedRecently('fence-default-clock')).toBe(true);
    expect(agentOwnedRecently('fence-default-clock', Date.now() + FIVE_MINUTES + 1)).toBe(false);
  });
});
