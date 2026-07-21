import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AlertErrorParams } from '../alert-error';
import {
  dbCanarySeams,
  type DbCanaryFreshClient,
  resolveDbCanaryDriverStallMs,
  resolveDbCanaryExitEnabled,
  resolveDbCanaryExitThreshold,
  resolveDbCanaryIntervalMs,
  runDbCanaryTick,
  startDbCanary,
  stopDbCanary,
} from '../db-canary';

const originalSeams = { ...dbCanarySeams };
const originalEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  DB_CANARY_INTERVAL_MS: process.env.DB_CANARY_INTERVAL_MS,
  DB_CANARY_EXIT_THRESHOLD: process.env.DB_CANARY_EXIT_THRESHOLD,
  DB_CANARY_EXIT: process.env.DB_CANARY_EXIT,
  DB_CANARY_DRIVER_STALL_MS: process.env.DB_CANARY_DRIVER_STALL_MS,
};

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function freshClient(
  probe: () => Promise<void> = async () => {},
  end: (options: { timeout: number }) => Promise<void> = async () => {},
): DbCanaryFreshClient {
  return { probe, end };
}

beforeEach(() => {
  stopDbCanary();
  process.env.DATABASE_URL = 'postgres://canary.invalid/db';
  delete process.env.DB_CANARY_INTERVAL_MS;
  delete process.env.DB_CANARY_EXIT_THRESHOLD;
  delete process.env.DB_CANARY_EXIT;
  delete process.env.DB_CANARY_DRIVER_STALL_MS;

  dbCanarySeams.probeShared = async () => {};
  dbCanarySeams.openFreshClient = () => freshClient();
  dbCanarySeams.deadline = async (promise) => promise;
  dbCanarySeams.alert = async () => {};
  dbCanarySeams.driverLiveness = () => ({ enrolledCount: 0, lastTickAt: null });
  dbCanarySeams.now = () => 1_000_000;
  dbCanarySeams.sleep = async () => {};
  dbCanarySeams.exit = () => {};
  dbCanarySeams.setInterval = originalSeams.setInterval;
  dbCanarySeams.clearInterval = originalSeams.clearInterval;
});

afterEach(() => {
  stopDbCanary();
  Object.assign(dbCanarySeams, originalSeams);
  restoreEnv('DATABASE_URL');
  restoreEnv('DB_CANARY_INTERVAL_MS');
  restoreEnv('DB_CANARY_EXIT_THRESHOLD');
  restoreEnv('DB_CANARY_EXIT');
  restoreEnv('DB_CANARY_DRIVER_STALL_MS');
});

describe('DB canary configuration', () => {
  it('applies defaults, floors, and the normalized exit kill switch', () => {
    expect(resolveDbCanaryIntervalMs(undefined)).toBe(30_000);
    expect(resolveDbCanaryIntervalMs('1')).toBe(10_000);
    expect(resolveDbCanaryIntervalMs('45000')).toBe(45_000);
    expect(resolveDbCanaryIntervalMs('invalid')).toBe(30_000);
    expect(resolveDbCanaryIntervalMs('12000junk')).toBe(30_000);

    expect(resolveDbCanaryExitThreshold(undefined)).toBe(8);
    expect(resolveDbCanaryExitThreshold('1')).toBe(1);
    expect(resolveDbCanaryExitThreshold('0')).toBe(8);
    expect(resolveDbCanaryExitThreshold('1.5')).toBe(8);
    expect(resolveDbCanaryExitThreshold('1junk')).toBe(8);
    expect(resolveDbCanaryDriverStallMs(undefined)).toBe(300_000);
    expect(resolveDbCanaryDriverStallMs('90000')).toBe(90_000);
    expect(resolveDbCanaryDriverStallMs('0.5')).toBe(300_000);

    expect(resolveDbCanaryExitEnabled(undefined)).toBe(true);
    expect(resolveDbCanaryExitEnabled(' FALSE ')).toBe(false);
    expect(resolveDbCanaryExitEnabled('0')).toBe(true);
  });
});

describe('DB canary classification and recovery', () => {
  it('skips the fresh client on shared success and resets a prior wedge streak', async () => {
    let sharedFails = true;
    const openFresh = mock(() => freshClient());
    dbCanarySeams.probeShared = async () => {
      if (sharedFails) throw new Error('shared failed');
    };
    dbCanarySeams.openFreshClient = openFresh;

    expect(await runDbCanaryTick()).toEqual({
      outcome: 'pool-wedge',
      consecutivePoolWedges: 1,
    });
    sharedFails = false;
    expect(await runDbCanaryTick()).toEqual({
      outcome: 'healthy',
      consecutivePoolWedges: 0,
    });
    expect(openFresh).toHaveBeenCalledTimes(1);
  });

  it('reuses one unresolved shared probe across deadline failures', async () => {
    const shared = mock(() => new Promise<void>(() => {}));
    let deadlineCall = 0;
    dbCanarySeams.probeShared = shared;
    dbCanarySeams.deadline = async (promise) => {
      const isSharedProbe = deadlineCall++ % 2 === 0;
      if (isSharedProbe) throw new Error('deadline');
      return promise;
    };

    expect((await runDbCanaryTick()).outcome).toBe('pool-wedge');
    expect((await runDbCanaryTick()).outcome).toBe('pool-wedge');
    expect(shared).toHaveBeenCalledTimes(1);
  });

  it('alerts, grants one second, and exits only at the configured wedge threshold', async () => {
    process.env.DB_CANARY_EXIT_THRESHOLD = '2';
    const alerts: AlertErrorParams[] = [];
    const sleep = mock(async (_ms: number) => {});
    const exit = mock((_code: number) => {});
    dbCanarySeams.probeShared = async () => {
      throw new Error('shared failed');
    };
    dbCanarySeams.alert = async (alert) => {
      alerts.push(alert);
    };
    dbCanarySeams.sleep = sleep;
    dbCanarySeams.exit = exit;

    expect((await runDbCanaryTick()).consecutivePoolWedges).toBe(1);
    expect(alerts).toHaveLength(0);
    expect(exit).not.toHaveBeenCalled();

    expect((await runDbCanaryTick()).consecutivePoolWedges).toBe(2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'critical',
      source: 'db-canary',
      message: 'DB pool wedged — restarting api',
    });
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('keeps alerting but never sleeps or exits when DB_CANARY_EXIT=false', async () => {
    process.env.DB_CANARY_EXIT_THRESHOLD = '1';
    process.env.DB_CANARY_EXIT = 'false';
    const alert = mock(async (_params: AlertErrorParams) => {});
    const sleep = mock(async (_ms: number) => {});
    const exit = mock((_code: number) => {});
    dbCanarySeams.probeShared = async () => {
      throw new Error('shared failed');
    };
    dbCanarySeams.alert = alert;
    dbCanarySeams.sleep = sleep;
    dbCanarySeams.exit = exit;

    expect((await runDbCanaryTick()).outcome).toBe('pool-wedge');
    await Promise.resolve();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('classifies both probes failing as DB-down, never exits above threshold, and breaks the wedge streak', async () => {
    process.env.DB_CANARY_EXIT_THRESHOLD = '2';
    process.env.DB_CANARY_EXIT = 'false';
    const alerts: AlertErrorParams[] = [];
    const exit = mock((_code: number) => {});
    let freshAttempt = 0;
    dbCanarySeams.probeShared = async () => {
      throw new Error('shared failed');
    };
    dbCanarySeams.openFreshClient = () =>
      freshClient(async () => {
        freshAttempt += 1;
        if (freshAttempt === 4) throw new Error('database down');
      });
    dbCanarySeams.alert = async (alert) => {
      alerts.push(alert);
    };
    dbCanarySeams.exit = exit;

    expect(await runDbCanaryTick()).toEqual({
      outcome: 'pool-wedge',
      consecutivePoolWedges: 1,
    });
    expect(await runDbCanaryTick()).toEqual({
      outcome: 'pool-wedge',
      consecutivePoolWedges: 2,
    });
    expect(await runDbCanaryTick()).toEqual({
      outcome: 'pool-wedge',
      consecutivePoolWedges: 3,
    });
    expect(exit).not.toHaveBeenCalled();

    process.env.DB_CANARY_EXIT = 'true';
    expect(await runDbCanaryTick()).toEqual({
      outcome: 'db-down',
      consecutivePoolWedges: 0,
    });
    expect(await runDbCanaryTick()).toEqual({
      outcome: 'pool-wedge',
      consecutivePoolWedges: 1,
    });
    await Promise.resolve();

    expect(exit).not.toHaveBeenCalled();
    expect(alerts).toContainEqual({
      severity: 'critical',
      source: 'db-canary',
      message: 'Database unavailable — fresh connection probe failed',
    });
  });
});

describe('fresh-client cleanup', () => {
  it('ends a successful fresh client with a one-second timeout', async () => {
    const end = mock(async (_options: { timeout: number }) => {});
    dbCanarySeams.probeShared = async () => {
      throw new Error('shared failed');
    };
    dbCanarySeams.openFreshClient = () => freshClient(async () => {}, end);

    expect((await runDbCanaryTick()).outcome).toBe('pool-wedge');
    expect(end).toHaveBeenCalledWith({ timeout: 1 });
  });

  it('ends a fresh client whose probe errors or exceeds its deadline', async () => {
    const errorEnd = mock(async (_options: { timeout: number }) => {});
    dbCanarySeams.probeShared = async () => {
      throw new Error('shared failed');
    };
    dbCanarySeams.openFreshClient = () =>
      freshClient(async () => {
        throw new Error('fresh failed');
      }, errorEnd);
    expect((await runDbCanaryTick()).outcome).toBe('db-down');
    expect(errorEnd).toHaveBeenCalledWith({ timeout: 1 });

    stopDbCanary();
    const timeoutEnd = mock(async (_options: { timeout: number }) => {});
    let deadlineCall = 0;
    dbCanarySeams.openFreshClient = () => freshClient(async () => {}, timeoutEnd);
    dbCanarySeams.deadline = async (promise) => {
      if (deadlineCall++ === 0) {
        try {
          await promise;
        } catch {
          // The shared rejection is the expected first failure.
        }
        throw new Error('shared failed');
      }
      throw new Error('fresh deadline');
    };
    expect((await runDbCanaryTick()).outcome).toBe('db-down');
    expect(timeoutEnd).toHaveBeenCalledWith({ timeout: 1 });
  });

  it('does not let cleanup failure change a successful fresh-probe classification', async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    dbCanarySeams.probeShared = async () => {
      throw new Error('shared failed');
    };
    dbCanarySeams.openFreshClient = () =>
      freshClient(async () => {}, async () => {
        throw new Error('cleanup failed');
      });
    try {
      expect((await runDbCanaryTick()).outcome).toBe('pool-wedge');
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('driver liveness and worker lifecycle', () => {
  it('warns only for an enrolled driver whose heartbeat is stale', async () => {
    const alerts: AlertErrorParams[] = [];
    dbCanarySeams.alert = async (alert) => {
      alerts.push(alert);
    };
    dbCanarySeams.now = () => 1_000_000;
    dbCanarySeams.driverLiveness = () => ({
      enrolledCount: 2,
      lastTickAt: 600_000,
    });

    await runDbCanaryTick();
    expect(alerts).toContainEqual({
      severity: 'warning',
      source: 'db-canary',
      message: 'Agent autonomy driver stalled',
      context: { enrolledCount: 2, lastTickAt: 600_000 },
    });

    alerts.length = 0;
    dbCanarySeams.driverLiveness = () => ({ enrolledCount: 0, lastTickAt: 0 });
    await runDbCanaryTick();
    dbCanarySeams.driverLiveness = () => ({
      enrolledCount: 1,
      lastTickAt: 999_999,
    });
    await runDbCanaryTick();
    expect(alerts).toHaveLength(0);
  });

  it('absorbs failures from optional seams and never rejects the tick', async () => {
    dbCanarySeams.driverLiveness = () => {
      throw new Error('liveness failed');
    };
    dbCanarySeams.probeShared = async () => {
      throw new Error('shared failed');
    };
    dbCanarySeams.openFreshClient = () => {
      throw new Error('fresh open failed');
    };
    dbCanarySeams.alert = async () => {
      throw new Error('alert failed');
    };

    await expect(runDbCanaryTick()).resolves.toEqual({
      outcome: 'db-down',
      consecutivePoolWedges: 0,
    });
  });

  it('starts/stops idempotently and skips overlapping scheduled ticks', async () => {
    let callback: (() => void) | null = null;
    const setIntervalSeam = mock((next: () => void, _ms: number) => {
      callback = next;
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalSeam = mock((_handle: ReturnType<typeof setInterval>) => {});
    let releaseShared!: () => void;
    const sharedGate = new Promise<void>((resolve) => {
      releaseShared = resolve;
    });
    const shared = mock(() => sharedGate);
    dbCanarySeams.setInterval = setIntervalSeam;
    dbCanarySeams.clearInterval = clearIntervalSeam;
    dbCanarySeams.probeShared = shared;

    startDbCanary();
    startDbCanary();
    expect(setIntervalSeam).toHaveBeenCalledTimes(1);
    expect(setIntervalSeam.mock.calls[0][1]).toBe(30_000);

    callback!();
    await Promise.resolve();
    callback!();
    expect(shared).toHaveBeenCalledTimes(1);
    releaseShared();
    await sharedGate;
    await Promise.resolve();
    await Promise.resolve();

    stopDbCanary();
    stopDbCanary();
    expect(clearIntervalSeam).toHaveBeenCalledTimes(1);
  });
});
