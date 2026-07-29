import { describe, expect, it } from 'bun:test';
import {
  baccaratLastCoupSnapshot,
  baccaratPenetrationBody,
  guestDemoBalance,
  provisionalCoupRateKey,
  readCurrentBaccaratSnapshot,
  rotateGuestBaccaratShoe,
  runBaccaratCoupPreflight,
  runBaccaratLockedReplayGate,
  settledBaccaratReplay,
} from '../cove-baccarat';

const incoming = { bet: 'player' as const, stake: 25 };
const settled = { status: 'settled', bet: 'player', stake: '25' };

function injectedPreflight(args: {
  status?: 'open' | 'closed';
  dealtCount?: number;
  balance?: number;
  replay?: typeof settled | null;
  calls: string[];
}) {
  const shoe = {
    status: args.status ?? 'open',
    dealtCount: args.dealtCount ?? 0,
    balance: args.balance ?? 100,
  };
  return runBaccaratCoupPreflight({
    checkRate: () => args.calls.push('rate'),
    loadShoe: async () => {
      args.calls.push('load');
      return shoe;
    },
    assertOwnership: () => args.calls.push('ownership'),
    loadSettledReplay: async () => {
      args.calls.push('replay');
      return args.replay ?? null;
    },
    incoming,
    assertOpen: (row) => {
      args.calls.push('status');
      if (row.status !== 'open') throw new Error('closed');
    },
    assertAffordable: async (row) => {
      args.calls.push('affordability');
      if (row.balance < incoming.stake) throw new Error('insufficient');
    },
  });
}

describe('Cove Baccarat Wave W-D route contract (DB-free injected gates)', () => {
  it('derives a literal-first provisional bucket without retaining an agent bearer', () => {
    const bearer = 'agent-session-super-secret';
    function context(fpHash: string) {
      function get(key: 'user'): { id: string } | null;
      function get(key: 'fpHash'): string;
      function get(key: 'user' | 'fpHash'): { id: string } | string | null {
        return key === 'user' ? null : fpHash;
      }
      return { get, req: { header: () => bearer } };
    }
    const key = provisionalCoupRateKey(context('guest-fingerprint-hash'));

    expect(key).toStartWith('pre:a:');
    expect(key).not.toContain(bearer);
    expect(key).toBe(provisionalCoupRateKey(context('different-fingerprint')));
  });

  it('builds a settled-coup recovery DTO with no balance or replay marker', () => {
    const outcome = { kind: 'baccarat', bet: 'player' } as never;
    const snapshot = baccaratLastCoupSnapshot(
      { id: 'coup-1', coupIndex: 7, outcomeJson: outcome, dealtAfter: 41 },
      40,
    );

    expect(snapshot).toEqual({
      coupId: 'coup-1',
      coupIndex: 7,
      outcome,
      dealtCount: 41,
    });
    expect(Object.keys(snapshot).sort()).toEqual(
      ['coupId', 'coupIndex', 'dealtCount', 'outcome'].sort(),
    );
    expect('balance' in snapshot).toBe(false);
    expect('idempotencyReplay' in snapshot).toBe(false);
  });

  it('replays after shoe close before the status gate', async () => {
    const calls: string[] = [];
    const result = await injectedPreflight({
      status: 'closed',
      replay: settled,
      calls,
    });

    expect(result.replay).toBe(settled);
    expect(calls).toEqual(['rate', 'load', 'ownership', 'replay']);
  });

  it('replays after balance falls below stake before affordability', async () => {
    const calls: string[] = [];
    const result = await injectedPreflight({
      balance: 0,
      replay: settled,
      calls,
    });

    expect(result.replay).toBe(settled);
    expect(calls).toEqual(['rate', 'load', 'ownership', 'replay']);
  });

  it('rechecks replay when a concurrent settle drains affordability after the first miss', async () => {
    const calls: string[] = [];
    let lookup = 0;
    const result = await runBaccaratCoupPreflight({
      checkRate: () => calls.push('rate'),
      loadShoe: async () => {
        calls.push('load');
        return { status: 'open' as const, balance: 0 };
      },
      assertOwnership: () => calls.push('ownership'),
      loadSettledReplay: async () => {
        lookup += 1;
        calls.push(`replay-${lookup}`);
        return lookup === 1 ? null : settled;
      },
      incoming,
      assertOpen: () => calls.push('status'),
      assertAffordable: async () => {
        calls.push('affordability');
        throw new Error('insufficient');
      },
    });

    expect(result.replay).toBe(settled);
    expect(calls).toEqual([
      'rate',
      'load',
      'ownership',
      'replay-1',
      'status',
      'affordability',
      'replay-2',
    ]);

    await expect(runBaccaratCoupPreflight({
      checkRate: () => {},
      loadShoe: async () => ({ status: 'open' as const, balance: 0 }),
      assertOwnership: () => {},
      loadSettledReplay: async () => null,
      incoming,
      assertOpen: () => {},
      assertAffordable: async () => {
        throw new Error('fresh-insufficient');
      },
    })).rejects.toThrow('fresh-insufficient');
  });

  it('replays a threshold-crossing lost response while a fresh coup is gated', async () => {
    const replayCalls: string[] = [];
    const replay = await runBaccaratLockedReplayGate({
      loadSettledReplay: async () => {
        replayCalls.push('replay');
        return settled;
      },
      incoming,
      assertOpen: () => replayCalls.push('status'),
      assertPenetration: () => {
        replayCalls.push('penetration');
        throw new Error('threshold');
      },
    });
    expect(replay).toBe(settled);
    expect(replayCalls).toEqual(['replay']);

    const freshCalls: string[] = [];
    await expect(
      runBaccaratLockedReplayGate({
        loadSettledReplay: async () => {
          freshCalls.push('replay');
          return null;
        },
        incoming,
        assertOpen: () => freshCalls.push('status'),
        assertPenetration: () => {
          freshCalls.push('penetration');
          throw new Error('threshold');
        },
      }),
    ).rejects.toThrow('threshold');
    expect(freshCalls).toEqual(['replay', 'status', 'penetration']);
    expect(baccaratPenetrationBody(312)).toEqual({
      reshuffled: true,
      message: 'shoe_penetration_exceeded: open a new shoe (75% reached)',
      dealtCount: 312,
      threshold: 312,
    });
  });

  it('returns 409 for a settled key reused with a different tuple', () => {
    expect(() =>
      settledBaccaratReplay(
        { status: 'settled', bet: 'banker', stake: '25' },
        incoming,
      ),
    ).toThrow('idempotency_key_payload_mismatch');

    try {
      settledBaccaratReplay(
        { status: 'settled', bet: 'player', stake: '30' },
        incoming,
      );
      throw new Error('expected mismatch');
    } catch (error) {
      expect((error as { status?: number }).status).toBe(409);
    }
  });

  it('serializes two concurrent first requests into one settle plus one replay', async () => {
    let stored: typeof settled | null = null;
    let settleCount = 0;
    let tail = Promise.resolve();
    let arrivals = 0;
    let releaseOuter!: () => void;
    const bothAtOuterReplay = new Promise<void>((resolve) => {
      releaseOuter = resolve;
    });

    async function withLock<T>(fn: () => Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await fn();
      } finally {
        release();
      }
    }

    async function request(): Promise<'fresh' | 'replay'> {
      const preflight = await runBaccaratCoupPreflight({
        checkRate: () => {},
        loadShoe: async () => ({ status: 'open' as const, balance: 100 }),
        assertOwnership: () => {},
        loadSettledReplay: async () => {
          arrivals += 1;
          if (arrivals === 2) releaseOuter();
          await bothAtOuterReplay;
          return null;
        },
        incoming,
        assertOpen: () => {},
        assertAffordable: async () => {},
      });
      expect(preflight.replay).toBeNull();

      return withLock(async () => {
        const replay = await runBaccaratLockedReplayGate({
          loadSettledReplay: async () => stored,
          incoming,
          assertOpen: () => {},
          assertPenetration: () => {},
        });
        if (replay) return 'replay';
        settleCount += 1;
        stored = settled;
        return 'fresh';
      });
    }

    const results = await Promise.all([request(), request()]);
    expect(results.sort()).toEqual(['fresh', 'replay']);
    expect(settleCount).toBe(1);
  });

  it('reads shoe, newest coup, and current balance coherently under the shoe lock', async () => {
    const outcome1 = { kind: 'baccarat', bet: 'player', nonce: 1 } as never;
    const outcome2 = { kind: 'baccarat', bet: 'banker', nonce: 2 } as never;
    const state = {
      shoe: { id: 'shoe-1', dealtCount: 4, coupCounter: 1 },
      walletBalance: 80,
      last: {
        id: 'coup-1',
        coupIndex: 1,
        outcomeJson: outcome1,
        dealtAfter: 4,
      },
    };
    let tail = Promise.resolve();

    async function withLock<T>(fn: () => Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await fn();
      } finally {
        release();
      }
    }

    function snapshot() {
      return readCurrentBaccaratSnapshot<
        typeof state,
        typeof state.shoe,
        typeof state.last,
        typeof state.shoe
      >({
        withShoeLock: (read) => withLock(() => read(state, state.shoe.id)),
        loadShoe: async (context) => ({ ...context.shoe }),
        loadWalletBalance: async (context) => context.walletBalance,
        loadLastCoup: async (context) => ({ ...context.last }),
        publicShoe: (shoe) => ({ ...shoe }),
      });
    }

    const beforeSettle = snapshot();
    const concurrentSettle = withLock(async () => {
      state.shoe = { id: 'shoe-1', dealtCount: 9, coupCounter: 2 };
      state.walletBalance = 110;
      state.last = {
        id: 'coup-2',
        coupIndex: 2,
        outcomeJson: outcome2,
        dealtAfter: 9,
      };
    });
    const oldSnapshot = await beforeSettle;
    await concurrentSettle;
    const newSnapshot = await snapshot();

    expect(oldSnapshot).toEqual({
      shoe: { id: 'shoe-1', dealtCount: 4, coupCounter: 1 },
      walletBalance: 80,
      lastCoup: {
        coupId: 'coup-1',
        coupIndex: 1,
        outcome: outcome1,
        dealtCount: 4,
      },
    });
    expect(newSnapshot).toEqual({
      shoe: { id: 'shoe-1', dealtCount: 9, coupCounter: 2 },
      walletBalance: 110,
      lastCoup: {
        coupId: 'coup-2',
        coupIndex: 2,
        outcome: outcome2,
        dealtCount: 9,
      },
    });
  });

  it('guest rotation reveals only the closed seed and conserves demo balance', async () => {
    const calls: string[] = [];
    let revealedSeed = '';
    const inserted: { value: Record<string, string> | null } = { value: null };
    const old = {
      startingBalance: '100',
      totalPayout: '135',
      totalBet: '170',
      serverSeed: 'old-server-seed',
      serverSeedHash: 'old-server-hash',
      clientSeed: 'old-client-seed',
    };

    const response = await rotateGuestBaccaratShoe({
      oldShoe: old,
      closeOld: async () => {
        calls.push('close');
        return old;
      },
      revealOldEvents: async (serverSeed) => {
        calls.push('reveal-events');
        revealedSeed = serverSeed;
      },
      createFreshSeedPair: () => {
        calls.push('fresh-commit');
        return {
          serverSeed: 'fresh-server-seed',
          serverSeedHash: 'fresh-server-hash',
          clientSeed: 'fresh-client-seed',
        };
      },
      insertFresh: async (input) => {
        calls.push('insert');
        inserted.value = input;
        return {
          id: 'fresh-shoe',
          serverSeed: null,
          serverSeedHash: input.serverSeedHash,
          clientSeed: input.clientSeed,
          startingBalance: input.startingBalance,
          totalBet: '0',
          totalPayout: '0',
        };
      },
    });

    expect(calls).toEqual(['close', 'reveal-events', 'fresh-commit', 'insert']);
    expect(revealedSeed).toBe(old.serverSeed);
    expect(inserted.value).toEqual({
      startingBalance: '65',
      serverSeed: 'fresh-server-seed',
      serverSeedHash: 'fresh-server-hash',
      clientSeed: 'fresh-client-seed',
    });
    expect(response.walletBalance).toBe(65);
    expect(response.rotatedFrom).toEqual({
      serverSeed: old.serverSeed,
      serverSeedHash: old.serverSeedHash,
      clientSeed: old.clientSeed,
    });
    expect(response.shoe.serverSeed).toBeNull();
    expect(response.shoe.serverSeedHash).toBe('fresh-server-hash');
    expect(response.shoe.serverSeedHash).not.toBe(response.rotatedFrom.serverSeedHash);
    expect(guestDemoBalance(response.shoe)).toBe(65n);
  });
});
