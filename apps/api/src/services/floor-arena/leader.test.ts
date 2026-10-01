import { describe, expect, test } from 'bun:test';
import { LeaderElector, type LeaderLock } from './leader';

/** One shared "database": at most one holder, like pg_try_advisory_lock on one key. */
class FakeLockServer {
  holder: string | null = null;
  lock(id: string, opts: { failAcquire?: () => boolean } = {}): LeaderLock & { drop(): void } {
    return {
      tryAcquire: async () => {
        if (opts.failAcquire?.()) throw new Error('connection refused');
        if (this.holder === null) this.holder = id;
        return this.holder === id;
      },
      stillHeld: async () => this.holder === id,
      release: async () => { if (this.holder === id) this.holder = null; },
      close: async () => undefined,
      // Simulates the lock's backend dying (postgres releases the session lock).
      drop: () => { if (this.holder === id) this.holder = null; },
    };
  }
}

function elector(lock: LeaderLock, log: string[]) {
  return new LeaderElector({
    lock,
    onElected: () => { log.push('elected'); },
    onDemoted: () => { log.push('demoted'); },
    setTimer: () => 0,
    clearTimer: () => undefined,
    log: () => undefined,
  });
}

describe('LeaderElector', () => {
  test('two containers (deploy flip): only one runs the loops', async () => {
    const server = new FakeLockServer();
    const logA: string[] = [];
    const logB: string[] = [];
    const a = elector(server.lock('a'), logA);
    const b = elector(server.lock('b'), logB);
    a.start();
    b.start();
    await a.checkNow();
    await b.checkNow();
    expect(a.isLeader).toBe(true);
    expect(b.isLeader).toBe(false);
    expect(logA).toEqual(['elected']);
    expect(logB).toEqual([]);
    // Repeated rounds keep the same single leader and never re-run onElected.
    await a.checkNow();
    await b.checkNow();
    expect(logA).toEqual(['elected']);
    expect(logB).toEqual([]);
  });

  test('the old container stops cleanly and the new one takes over on its next round', async () => {
    const server = new FakeLockServer();
    const logA: string[] = [];
    const logB: string[] = [];
    const a = elector(server.lock('a'), logA);
    const b = elector(server.lock('b'), logB);
    a.start();
    await a.checkNow();
    b.start();
    await b.checkNow();
    await a.stop();
    expect(logA).toEqual(['elected', 'demoted']);
    expect(server.holder).toBeNull();
    await b.checkNow();
    expect(b.isLeader).toBe(true);
    expect(logB).toEqual(['elected']);
  });

  test('a lost lock demotes BEFORE re-competing; loops never run on two containers', async () => {
    const server = new FakeLockServer();
    const logA: string[] = [];
    const logB: string[] = [];
    const lockA = server.lock('a');
    const a = elector(lockA, logA);
    const b = elector(server.lock('b'), logB);
    a.start();
    await a.checkNow();
    lockA.drop();
    b.start();
    await b.checkNow();
    expect(b.isLeader).toBe(true);
    await a.checkNow();
    expect(a.isLeader).toBe(false);
    expect(logA).toEqual(['elected', 'demoted']);
    expect(logB).toEqual(['elected']);
  });

  test('a database error on acquire leaves the process a follower; it retries next round', async () => {
    const server = new FakeLockServer();
    let failing = true;
    const log: string[] = [];
    const a = elector(server.lock('a', { failAcquire: () => failing }), log);
    a.start();
    await a.checkNow();
    expect(a.isLeader).toBe(false);
    failing = false;
    await a.checkNow();
    expect(a.isLeader).toBe(true);
    expect(log).toEqual(['elected']);
  });

  test('a stopped elector never re-acquires', async () => {
    const server = new FakeLockServer();
    const log: string[] = [];
    const a = elector(server.lock('a'), log);
    await a.stop();
    await a.checkNow();
    expect(a.isLeader).toBe(false);
    expect(server.holder).toBeNull();
  });

  test('concurrent rounds do not overlap', async () => {
    const server = new FakeLockServer();
    const log: string[] = [];
    const a = elector(server.lock('a'), log);
    a.start();
    await Promise.all([a.checkNow(), a.checkNow(), a.checkNow()]);
    expect(log).toEqual(['elected']);
  });
});
