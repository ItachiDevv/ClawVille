import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import {
  advanceWorldStageRoute,
  installWorldStageNavigationHandler,
  markWorldStageMounted,
  markWorldStageUnmounted,
  requestWorldStageNavigation,
  resetWorldStageNavigationForTests,
} from './stage-navigation';

const originalDateNow = Date.now;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

let now = 1_000;
let nextTimerId = 1;
let timers = new Map<number, { at: number; callback: () => void }>();

function advanceTime(ms: number) {
  now += ms;
  for (;;) {
    const due = [...timers.entries()]
      .filter(([, timer]) => timer.at <= now)
      .sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) return;
    timers.delete(due[0]);
    due[1].callback();
  }
}

beforeEach(() => {
  resetWorldStageNavigationForTests();
  now = 1_000;
  nextTimerId = 1;
  timers = new Map();
  Date.now = () => now;
  globalThis.setTimeout = ((callback: TimerHandler, delay = 0) => {
    const id = nextTimerId++;
    if (typeof callback !== 'function') {
      throw new TypeError('stage navigation tests require function timers');
    }
    timers.set(id, { at: now + delay, callback: callback as () => void });
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number | undefined) => {
    if (id !== undefined) timers.delete(id);
  }) as unknown as typeof clearTimeout;
  spyOn(console, 'warn').mockImplementation(() => {});
  markWorldStageMounted();
  advanceWorldStageRoute('/game');
});

afterEach(() => {
  resetWorldStageNavigationForTests();
  Date.now = originalDateNow;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

describe('world stage navigation bridge', () => {
  test('buffers while the handler is null and flushes after install', async () => {
    const received: string[] = [];
    expect(requestWorldStageNavigation({ to: '/cove' })).toBe(true);
    installWorldStageNavigationHandler((request) => {
      received.push(request.to);
      return true;
    });

    await Promise.resolve();
    expect(received).toEqual(['/cove']);
  });

  test('discards a buffer when browser route generation moved', async () => {
    const received: string[] = [];
    expect(requestWorldStageNavigation({ to: '/cove' })).toBe(true);
    advanceWorldStageRoute('/arena');
    installWorldStageNavigationHandler((request) => {
      received.push(request.to);
      return true;
    });

    await Promise.resolve();
    expect(received).toEqual([]);
  });

  test('survives strict-mode install cleanup install ordering', async () => {
    const first: string[] = [];
    const second: string[] = [];
    expect(requestWorldStageNavigation({ to: '/cove' })).toBe(true);
    const cleanup = installWorldStageNavigationHandler((request) => {
      first.push(request.to);
      return true;
    });
    cleanup();
    installWorldStageNavigationHandler((request) => {
      second.push(request.to);
      return true;
    });

    await Promise.resolve();
    expect(first).toEqual([]);
    expect(second).toEqual(['/cove']);
  });

  test('expiry fires its fallback when the route stayed put', () => {
    let expired = 0;
    expect(
      requestWorldStageNavigation({
        to: '/cove',
        onExpired: () => {
          expired += 1;
        },
      }),
    ).toBe(true);

    advanceTime(5_000);
    expect(expired).toBe(1);
  });

  test('expiry discards silently after browser route movement', () => {
    let expired = 0;
    expect(
      requestWorldStageNavigation({
        to: '/cove',
        onExpired: () => {
          expired += 1;
        },
      }),
    ).toBe(true);
    advanceWorldStageRoute('/arena');

    advanceTime(5_000);
    expect(expired).toBe(0);
  });

  test('the single slot is latest-wins', async () => {
    const received: string[] = [];
    expect(requestWorldStageNavigation({ to: '/cove' })).toBe(true);
    expect(requestWorldStageNavigation({ to: '/game' })).toBe(true);
    installWorldStageNavigationHandler((request) => {
      received.push(request.to);
      return true;
    });

    await Promise.resolve();
    expect(received).toEqual(['/game']);
  });

  test('returns false once the stage is unmounted', () => {
    markWorldStageUnmounted();
    expect(requestWorldStageNavigation({ to: '/cove' })).toBe(false);
  });
});
