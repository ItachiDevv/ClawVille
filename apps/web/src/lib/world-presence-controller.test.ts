import { describe, expect, test } from 'bun:test';
import {
  WORLD_PRESENCE_WS_CLOSE_CODES,
  type PlayerSnapshot,
} from '@clawville/shared';
import {
  WorldPresenceController,
  type PageLifecycleEvent,
  type TimerHandle,
  type WorldPresenceEnvironment,
  type WorldPresenceEventSourceLike,
  type WorldPresenceSocketLike,
  type WorldPresenceStoreCallbacks,
} from './world-presence-controller';
import type { WorldPresencePolicy } from '@/hooks/world-stream-machine';

interface FetchCall {
  url: string;
  init?: RequestInit;
  settled: boolean;
  resolve(status: number, body?: unknown): void;
  reject(error?: unknown): void;
}

class FakeEventSource implements WorldPresenceEventSourceLike {
  readonly listeners = new Map<
    string,
    Array<(event: { data?: string }) => void>
  >();
  onerror: ((event?: unknown) => void) | null = null;
  closed = false;

  addEventListener(
    type: string,
    listener: (event: { data?: string }) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: data === undefined ? undefined : JSON.stringify(data) });
    }
  }
}

class FakeSocket implements WorldPresenceSocketLike {
  readyState = 1;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose:
    | ((event: { code?: number; reason?: string }) => void)
    | null = null;
  readonly sent: string[] = [];
  readonly closeCalls: Array<number | undefined> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closeCalls.push(code);
    this.readyState = 3;
  }

  emitOpen(): void {
    this.onopen?.();
  }

  emitMessage(frame: unknown): void {
    this.onmessage?.({
      data: typeof frame === 'string' ? frame : JSON.stringify(frame),
    });
  }

  emitClose(code?: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

interface TestEnvironmentOptions {
  wsAdvertised?: boolean;
  holdJoins?: boolean;
  holdPositions?: boolean;
}

interface ScheduledTimer {
  id: number;
  at: number;
  intervalMs: number | null;
  fn: () => void;
}

function createTestEnvironment(options: TestEnvironmentOptions = {}) {
  let now = 0;
  let hidden = false;
  let nextTimerId = 1;
  const timers = new Map<number, ScheduledTimer>();
  const visibilityListeners = new Set<() => void>();
  const lifecycleListeners = new Set<
    (event: PageLifecycleEvent) => void
  >();
  const sockets: FakeSocket[] = [];
  const eventSources: FakeEventSource[] = [];
  const fetches: FetchCall[] = [];

  const fetchImpl = ((input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    let resolvePromise!: (response: Response) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<Response>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const call: FetchCall = {
      url,
      init,
      settled: false,
      resolve(status, body) {
        if (call.settled) return;
        call.settled = true;
        resolvePromise(
          new Response(
            body === undefined ? null : JSON.stringify(body),
            {
              status,
              headers:
                body === undefined
                  ? undefined
                  : { 'Content-Type': 'application/json' },
            },
          ),
        );
      },
      reject(error = new Error('fetch rejected')) {
        if (call.settled) return;
        call.settled = true;
        rejectPromise(error);
      },
    };
    fetches.push(call);
    if (url.endsWith('/api/world/join') && !options.holdJoins) {
      queueMicrotask(() =>
        call.resolve(200, {
          roomId: 'AB2C',
          id: 'session-1',
          roomTicket: 'ticket-1',
          ...(options.wsAdvertised === false
            ? {}
            : { transports: { positionWs: true } }),
        }),
      );
    } else if (
      url.endsWith('/api/world/position') &&
      !options.holdPositions
    ) {
      queueMicrotask(() => call.resolve(204));
    } else if (url.endsWith('/api/world/leave')) {
      queueMicrotask(() => call.resolve(204));
    }
    return promise;
  }) as typeof fetch;

  const env: WorldPresenceEnvironment = {
    now: () => now,
    setInterval(fn, ms) {
      const id = nextTimerId++;
      timers.set(id, { id, at: now + ms, intervalMs: ms, fn });
      return id as unknown as TimerHandle;
    },
    clearInterval(handle) {
      timers.delete(handle as unknown as number);
    },
    setTimeout(fn, ms) {
      const id = nextTimerId++;
      timers.set(id, { id, at: now + ms, intervalMs: null, fn });
      return id as unknown as TimerHandle;
    },
    clearTimeout(handle) {
      timers.delete(handle as unknown as number);
    },
    fetch: fetchImpl,
    createAbortController: () => new AbortController(),
    createEventSource() {
      const source = new FakeEventSource();
      eventSources.push(source);
      return source;
    },
    createSocket() {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    isDocumentHidden: () => hidden,
    addVisibilityListener(listener) {
      visibilityListeners.add(listener);
      return () => visibilityListeners.delete(listener);
    },
    addPageLifecycleListener(listener) {
      lifecycleListeners.add(listener);
      return () => lifecycleListeners.delete(listener);
    },
    readLocationSearch: () => '',
    isDev: () => false,
  };

  function advance(ms: number): void {
    const target = now + ms;
    for (;;) {
      const due = [...timers.values()]
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      now = due.at;
      if (!timers.has(due.id)) continue;
      if (due.intervalMs === null) {
        timers.delete(due.id);
      } else {
        due.at += due.intervalMs;
      }
      due.fn();
    }
    now = target;
  }

  return {
    env,
    advance,
    sockets,
    eventSources,
    fetches,
    setHidden(value: boolean) {
      hidden = value;
    },
    fireVisibility() {
      for (const listener of visibilityListeners) listener();
    },
    firePageLifecycle(event: PageLifecycleEvent) {
      for (const listener of lifecycleListeners) listener(event);
    },
  };
}

function createHarness(options: TestEnvironmentOptions = {}) {
  const testEnv = createTestEnvironment(options);
  const avatar = { x: 10, y: 20 };
  let policy: WorldPresencePolicy = 'active';
  let remoteActivity: string | undefined = 'at-cove';
  let controlMode = 'player';
  const toasts: Array<[string, string, number | undefined]> = [];
  const localSessionIds: Array<string | null> = [];
  const roomIds: Array<string | null> = [];
  let clearCount = 0;

  const callbacks: WorldPresenceStoreCallbacks = {
    updateNpcsFromSnapshot: () => undefined,
    setNpcConnected: () => undefined,
    updatePlayersFromSnapshot: (_players: PlayerSnapshot[]) => undefined,
    setLocalSessionId: (id) => localSessionIds.push(id),
    setRoomId: (id) => roomIds.push(id),
    clearPlayers: () => {
      clearCount += 1;
    },
    addCollaborationEntries: () => undefined,
    invalidateLandQuery: () => undefined,
    addToast: (icon, message, durationMs) =>
      toasts.push([icon, message, durationMs]),
    readPolicy: () => policy,
    readRemoteActivity: () => remoteActivity,
    readControlMode: () => controlMode,
    readAvatarPosition: () => avatar,
  };
  const controller = new WorldPresenceController({
    apiBaseUrl: 'http://localhost:4000',
    callbacks,
    environment: testEnv.env,
  });

  return {
    ...testEnv,
    controller,
    avatar,
    toasts,
    localSessionIds,
    roomIds,
    get clearCount() {
      return clearCount;
    },
    setPolicy(value: WorldPresencePolicy) {
      policy = value;
    },
    setRemoteActivity(value: string | undefined) {
      remoteActivity = value;
    },
    setControlMode(value: string) {
      controlMode = value;
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function callsEndingWith(fetches: FetchCall[], suffix: string): FetchCall[] {
  return fetches.filter((call) => call.url.endsWith(suffix));
}

async function startJoined(
  harness: ReturnType<typeof createHarness>,
): Promise<FakeSocket | null> {
  harness.controller.start();
  harness.advance(200);
  await flush();
  harness.advance(200);
  return harness.sockets[0] ?? null;
}

function ready(socket: FakeSocket, roomId = 'AB2C', presenceId = 'session-1') {
  socket.emitMessage({
    type: 'presence.ready',
    roomId,
    presenceId,
    serverTimeMs: 1,
  });
}

describe('world presence controller', () => {
  test('cold cove never joins and never opens a socket', async () => {
    const harness = createHarness();
    harness.setPolicy('remote');
    harness.controller.start();
    harness.advance(30_000);
    await flush();
    expect(callsEndingWith(harness.fetches, '/api/world/join')).toHaveLength(0);
    expect(harness.sockets).toHaveLength(0);
    harness.controller.stop();
  });

  test('no pose frame is sent before presence.ready', async () => {
    const harness = createHarness();
    const socket = await startJoined(harness);
    expect(socket).not.toBeNull();
    harness.avatar.x += 5;
    harness.advance(400);
    expect(socket?.sent).toHaveLength(0);
    ready(socket!);
    expect(socket!.sent.length).toBeGreaterThanOrEqual(1);
    harness.controller.stop();
  });

  test('ready with a mismatched presenceId is membership loss', async () => {
    const harness = createHarness();
    const socket = await startJoined(harness);
    ready(socket!, 'AB2C', 'other');
    harness.advance(200);
    await flush();
    expect(callsEndingWith(harness.fetches, '/api/world/join')).toHaveLength(2);
    harness.controller.stop();
  });

  test('ready with a mismatched roomId is membership loss', async () => {
    const harness = createHarness();
    const socket = await startJoined(harness);
    ready(socket!, 'WRONG', 'session-1');
    harness.advance(200);
    await flush();
    expect(callsEndingWith(harness.fetches, '/api/world/join')).toHaveLength(2);
    harness.controller.stop();
  });

  test('presence.ping is answered with presence.pong', async () => {
    const harness = createHarness();
    const socket = await startJoined(harness);
    ready(socket!);
    harness.setHidden(true);
    harness.fireVisibility();
    socket!.emitMessage({ type: 'presence.ping', serverTimeMs: 99 });
    expect(JSON.parse(socket!.sent.at(-1) ?? '{}')).toEqual({
      type: 'presence.pong',
      serverTimeMs: 99,
    });
    expect(harness.controller.getDiagnostics().pongsSent).toBe(1);
    harness.controller.stop();
  });

  test('the two effectors never overlap', async () => {
    const harness = createHarness();
    let socket = await startJoined(harness);
    ready(socket!);
    for (let index = 0; index < 60; index++) {
      harness.avatar.x += 1;
      harness.advance(200);
    }
    expect(
      callsEndingWith(harness.fetches, '/api/world/position'),
    ).toHaveLength(0);
    for (let drop = 0; drop < 3; drop++) {
      socket!.emitClose(1006);
      harness.advance(2_000);
      socket = harness.sockets.at(-1)!;
      if (drop < 2) ready(socket);
    }
    harness.avatar.x += 1;
    harness.advance(1_200);
    await flush();
    expect(
      callsEndingWith(harness.fetches, '/api/world/position').length,
    ).toBeGreaterThan(0);
    harness.controller.stop();
  });

  test('an in-flight POST held across promotion is discarded as 200 and 409', async () => {
    const harness = createHarness({ holdPositions: true });
    let socket = await startJoined(harness);
    for (let failure = 0; failure < 3; failure++) {
      socket!.emitClose(1006);
      harness.advance(2_000);
      socket = harness.sockets.at(-1)!;
    }
    harness.avatar.x += 1;
    harness.advance(400);
    harness.avatar.x += 1;
    harness.advance(400);
    const held = callsEndingWith(
      harness.fetches,
      '/api/world/position',
    ).slice(0, 2);
    expect(held).toHaveLength(2);
    harness.advance(60_000);
    const probe = harness.sockets.at(-1)!;
    ready(probe);
    held[0]!.resolve(200);
    held[1]!.resolve(409);
    await flush();
    expect(harness.controller.getDiagnostics()).toMatchObject({
      uploadsSuspended: false,
      httpPositionResponsesDiscarded: 2,
    });
    expect(callsEndingWith(harness.fetches, '/api/world/join')).toHaveLength(1);
    harness.controller.stop();
  });

  test('a POST held across RECOVERY_OK is discarded', async () => {
    const harness = createHarness({
      wsAdvertised: false,
      holdPositions: true,
    });
    await startJoined(harness);
    harness.avatar.x += 1;
    harness.advance(400);
    harness.avatar.x += 1;
    harness.advance(400);
    const held = callsEndingWith(harness.fetches, '/api/world/position');
    expect(held.length).toBeGreaterThanOrEqual(2);
    held[0]!.resolve(409);
    await flush();
    harness.advance(200);
    await flush();
    held[1]!.resolve(409);
    await flush();
    expect(harness.controller.getDiagnostics().uploadsSuspended).toBe(false);
    expect(
      harness.controller.getDiagnostics().httpPositionResponsesDiscarded,
    ).toBe(1);
    harness.controller.stop();
  });

  test('no fallback POST is sent while a socket is retiring', async () => {
    const harness = createHarness();
    const socket = await startJoined(harness);
    ready(socket!);
    socket!.emitMessage({
      type: 'presence.error',
      code: 'socket_replaced',
    });
    const before = callsEndingWith(
      harness.fetches,
      '/api/world/position',
    ).length;
    harness.avatar.x += 10;
    harness.advance(500);
    expect(
      callsEndingWith(harness.fetches, '/api/world/position'),
    ).toHaveLength(before);
    harness.advance(700);
    expect(
      callsEndingWith(harness.fetches, '/api/world/position').length,
    ).toBeGreaterThan(before);
    harness.controller.stop();
  });

  test('a generic close bare-reopens without spending a join', async () => {
    const harness = createHarness();
    const socket = await startJoined(harness);
    ready(socket!);
    socket!.emitClose(1006);
    harness.advance(1_200);
    expect(harness.sockets).toHaveLength(2);
    expect(callsEndingWith(harness.fetches, '/api/world/join')).toHaveLength(1);
    harness.controller.stop();
  });

  test('three generic closes fall back to http and never join', async () => {
    const harness = createHarness();
    let socket = await startJoined(harness);
    ready(socket!);
    for (let drop = 0; drop < 3; drop++) {
      socket!.emitClose(1006);
      harness.advance(2_200);
      socket = harness.sockets.at(-1)!;
      if (drop < 2) ready(socket);
    }
    harness.avatar.x += 10;
    harness.advance(1_200);
    await flush();
    expect(callsEndingWith(harness.fetches, '/api/world/join')).toHaveLength(1);
    expect(
      callsEndingWith(harness.fetches, '/api/world/position').length,
    ).toBeGreaterThan(0);
    harness.controller.stop();
  });

  test('a control frame and its close dedupe into one rejoin', async () => {
    const harness = createHarness();
    const socket = await startJoined(harness);
    ready(socket!);
    socket!.emitMessage({
      type: 'presence.error',
      code: 'membership_lost',
    });
    socket!.emitClose(WORLD_PRESENCE_WS_CLOSE_CODES.MEMBERSHIP_LOST);
    harness.advance(200);
    await flush();
    expect(callsEndingWith(harness.fetches, '/api/world/join')).toHaveLength(2);
    const recoveryBody = JSON.parse(
      String(callsEndingWith(harness.fetches, '/api/world/join')[1]!.init?.body),
    );
    expect(recoveryBody.roomTicket).toBe('ticket-1');
    harness.controller.stop();
  });

  test('socket_replaced retires only that socket and never toasts', async () => {
    const harness = createHarness();
    const socket = await startJoined(harness);
    ready(socket!);
    socket!.emitMessage({
      type: 'presence.error',
      code: 'socket_replaced',
    });
    socket!.emitClose(WORLD_PRESENCE_WS_CLOSE_CODES.SOCKET_REPLACED);
    harness.advance(10 * 60_000);
    await flush();
    expect(harness.toasts).toHaveLength(0);
    expect(harness.controller.getDiagnostics().superseded).toBe(false);
    expect(harness.sockets).toHaveLength(1);
    expect(
      callsEndingWith(harness.fetches, '/api/world/position').length,
    ).toBeGreaterThan(0);
    harness.controller.stop();
  });

  test('the fatal close matrix latches without a reconnect loop', async () => {
    for (const code of [
      WORLD_PRESENCE_WS_CLOSE_CODES.BAD_FRAME,
      WORLD_PRESENCE_WS_CLOSE_CODES.FLOOD,
      WORLD_PRESENCE_WS_CLOSE_CODES.TRANSPORT_DISABLED,
    ]) {
      const harness = createHarness();
      const socket = await startJoined(harness);
      ready(socket!);
      socket!.emitClose(code);
      harness.advance(10 * 60_000);
      await flush();
      expect(harness.sockets).toHaveLength(1);
      expect(
        callsEndingWith(harness.fetches, '/api/world/position').length,
      ).toBeGreaterThan(0);
      harness.controller.stop();
    }
  });

  test('4413 uses the bare-reopen path', async () => {
    const harness = createHarness();
    const socket = await startJoined(harness);
    ready(socket!);
    socket!.emitClose(WORLD_PRESENCE_WS_CLOSE_CODES.SERVER_SHUTDOWN);
    harness.advance(1_200);
    expect(harness.sockets).toHaveLength(2);
    expect(callsEndingWith(harness.fetches, '/api/world/join')).toHaveLength(1);
    harness.controller.stop();
  });

  test("a stale socket's late callbacks never touch the current socket", async () => {
    const harness = createHarness();
    const socketA = await startJoined(harness);
    ready(socketA!);
    const staleMessage = socketA!.onmessage;
    const staleClose = socketA!.onclose;
    socketA!.emitClose(WORLD_PRESENCE_WS_CLOSE_CODES.SERVER_SHUTDOWN);
    harness.advance(1_200);
    const socketB = harness.sockets[1]!;
    ready(socketB);
    const pongsBefore = harness.controller.getDiagnostics().pongsSent;
    staleMessage?.({
      data: JSON.stringify({ type: 'presence.ping', serverTimeMs: 7 }),
    });
    staleClose?.({ code: 1006 });
    harness.avatar.x += 1;
    harness.advance(200);
    expect(harness.controller.getDiagnostics().pongsSent).toBe(pongsBefore);
    expect(socketB.sent.length).toBeGreaterThan(0);
    harness.controller.stop();
  });

  test('a locally initiated close is not counted twice', async () => {
    const harness = createHarness();
    const socket = await startJoined(harness);
    expect(socket).not.toBeNull();
    harness.advance(5_000);
    expect(socket!.closeCalls).toEqual([1000]);
    harness.advance(1_000);
    expect(harness.sockets).toHaveLength(2);
    expect(harness.controller.getDiagnostics().httpFallbackTripped).toBe(false);
    harness.controller.stop();
  });

  test('an 8-minute hidden stretch causes no join churn and one foreground recovery', async () => {
    const harness = createHarness();
    const socket = await startJoined(harness);
    ready(socket!);
    harness.setHidden(true);
    harness.fireVisibility();
    socket!.emitMessage({
      type: 'presence.error',
      code: 'membership_lost',
    });
    const joinsBefore = callsEndingWith(
      harness.fetches,
      '/api/world/join',
    ).length;
    harness.advance(8 * 60_000);
    expect(callsEndingWith(harness.fetches, '/api/world/join')).toHaveLength(
      joinsBefore,
    );
    harness.setHidden(false);
    harness.fireVisibility();
    expect(callsEndingWith(harness.fetches, '/api/world/join')).toHaveLength(
      joinsBefore + 1,
    );
    await flush();
    expect(harness.sockets).toHaveLength(2);
    ready(harness.sockets[1]!);
    expect(harness.sockets[1]!.sent.length).toBeGreaterThan(0);
    harness.controller.stop();
  });

  test('stop during an in-flight join aborts and leaves', async () => {
    const harness = createHarness({ holdJoins: true });
    harness.controller.start();
    harness.advance(200);
    const join = callsEndingWith(harness.fetches, '/api/world/join')[0]!;
    harness.controller.stop();
    expect(join.init?.signal?.aborted).toBe(true);
    join.resolve(200, {
      roomId: 'AB2C',
      id: 'late-session',
      roomTicket: 'late-ticket',
      transports: { positionWs: true },
    });
    await flush();
    expect(callsEndingWith(harness.fetches, '/api/world/leave')).toHaveLength(1);
  });

  test('pagehide/pageshow bfcache restores with exactly one rebootstrap', async () => {
    const harness = createHarness();
    const socket = await startJoined(harness);
    ready(socket!);
    harness.firePageLifecycle({ type: 'pagehide', persisted: true });
    expect(callsEndingWith(harness.fetches, '/api/world/leave')).toHaveLength(1);
    expect(socket!.closeCalls).toEqual([1000]);
    harness.firePageLifecycle({ type: 'pageshow', persisted: true });
    expect(callsEndingWith(harness.fetches, '/api/world/join')).toHaveLength(2);
    await flush();
    harness.advance(200);
    expect(harness.sockets).toHaveLength(2);

    const fresh = createHarness();
    await startJoined(fresh);
    fresh.firePageLifecycle({ type: 'pagehide', persisted: false });
    fresh.firePageLifecycle({ type: 'pageshow', persisted: false });
    expect(callsEndingWith(fresh.fetches, '/api/world/join')).toHaveLength(1);
    fresh.controller.stop();
    harness.controller.stop();
  });

  test('policy is read at tick time', async () => {
    const harness = createHarness();
    harness.setPolicy('remote');
    harness.controller.start();
    harness.advance(200);
    expect(callsEndingWith(harness.fetches, '/api/world/join')).toHaveLength(0);
    harness.setPolicy('active');
    harness.advance(200);
    await flush();
    harness.advance(200);
    const socket = harness.sockets[0]!;
    ready(socket);
    const generation = harness.controller.getDiagnostics().socketGeneration;
    harness.setPolicy('remote');
    harness.setRemoteActivity('at-kelp');
    harness.advance(200);
    expect(harness.controller.getDiagnostics().socketGeneration).toBe(
      generation,
    );
    expect(
      socket.sent.some(
        (raw) => JSON.parse(raw).activity === 'at-kelp',
      ),
    ).toBe(true);
    harness.controller.stop();
  });
});
