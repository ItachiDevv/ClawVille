import { afterEach, describe, expect, test } from 'bun:test';
import type {
  BaccaratCoupResponse,
  BaccaratLastCoupSnapshot,
  BaccaratShoeWire,
  SerializedBaccaratCoup,
} from '@clawville/shared';
import {
  advanceBaccaratReveal,
  BACCARAT_FINAL_REVEAL_STAGE_MS,
  buildDealSteps,
  mountBaccaratRuntime,
  type BaccaratRuntimeToken,
  unmountBaccaratRuntime,
  useBaccaratRoomController,
} from '../baccarat-room-controller';

const originalFetch = globalThis.fetch;
let token: BaccaratRuntimeToken | null = null;

function makeShoe(
  id: string,
  overrides: Partial<BaccaratShoeWire> = {},
): BaccaratShoeWire {
  return {
    id,
    userId: 'user-1',
    currency: 'clawtoken',
    serverSeedHash: '0'.repeat(64),
    clientSeed: 'client-seed',
    coupCounter: 0,
    cursorCounter: 0,
    dealtCount: 0,
    startingBalance: '100',
    currentBalance: '100',
    totalBet: '0',
    totalPayout: '0',
    status: 'open',
    coupsPlayed: 0,
    createdAt: '2026-07-23T00:00:00.000Z',
    lastCoupAt: null,
    closedAt: null,
    serverSeed: null,
    ...overrides,
  };
}

function makeOutcome(
  overrides: Partial<SerializedBaccaratCoup> = {},
): SerializedBaccaratCoup {
  return {
    kind: 'baccarat',
    bet: 'player',
    stake: '25',
    player: {
      cards: [
        { suit: 'clubs', rank: '2' },
        { suit: 'diamonds', rank: '3' },
      ],
      total: 5,
      isNatural: false,
    },
    banker: {
      cards: [
        { suit: 'hearts', rank: '4' },
        { suit: 'spades', rank: '2' },
      ],
      total: 6,
      isNatural: false,
    },
    winner: 'banker',
    payout: '0',
    net: '-25',
    commission: '0',
    cursorBefore: 0,
    cursorAfter: 4,
    dealtBefore: 0,
    dealtAfter: 4,
    nonce: 0,
    engineVersion: 'bac-v1',
    ...overrides,
  };
}

function makeResponse(
  shoeId: string,
  overrides: Partial<BaccaratCoupResponse> = {},
): BaccaratCoupResponse {
  return {
    coupId: `coup-${shoeId}`,
    shoeId,
    coupIndex: 0,
    status: 'settled',
    outcome: makeOutcome(),
    balance: 75,
    totalBet: '25',
    totalPayout: '0',
    net: '-25',
    dealtCount: 4,
    reshuffleSuggested: false,
    idempotencyReplay: false,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mount() {
  token = mountBaccaratRuntime(`test-${crypto.randomUUID()}`);
  return token;
}

function requestHeader(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

function installTestWindow(onAssign: (url: string) => void = () => {}) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      clearTimeout,
      setTimeout,
      location: { assign: onAssign },
    },
  });
  return () => {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (token?.valid) unmountBaccaratRuntime(token);
  token = null;
});

describe('baccarat room controller operation generations', () => {
  test('bet and stake setters reject changes while a frozen tuple is pending', () => {
    mount();
    useBaccaratRoomController.setState({
      phase: 'idle',
      pending: {
        shoeId: 'shoe-1',
        bet: 'player',
        stake: 25,
        idempotencyKey: 'frozen-key',
      },
    });
    const state = useBaccaratRoomController.getState();
    state.setBetType('tie');
    state.setStake(100);
    expect(useBaccaratRoomController.getState()).toMatchObject({
      betType: 'player',
      stake: 25,
    });
  });

  test('retry after an ambiguous fetch reuses the frozen tuple and idempotency key', async () => {
    mount();
    useBaccaratRoomController.setState({
      shoe: makeShoe('shoe-1'),
      isDemo: false,
    });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) throw new TypeError('connection reset');
      return jsonResponse(makeResponse('shoe-1'));
    }) as unknown as typeof fetch;

    await useBaccaratRoomController.getState().handleDeal();
    const frozen = useBaccaratRoomController.getState().pending;
    expect(useBaccaratRoomController.getState().phase).toBe('idle');
    expect(frozen).not.toBeNull();

    await useBaccaratRoomController.getState().handleDeal();
    expect(calls).toHaveLength(2);
    expect(requestHeader(calls[0]!.init, 'Idempotency-Key')).toBe(
      frozen!.idempotencyKey,
    );
    expect(requestHeader(calls[1]!.init, 'Idempotency-Key')).toBe(
      frozen!.idempotencyKey,
    );
    expect(useBaccaratRoomController.getState()).toMatchObject({
      phase: 'revealing',
      pending: frozen,
      settled: { coupId: 'coup-shoe-1' },
    });
  });

  test('reset during an open-shoe fetch invalidates the late response', async () => {
    mount();
    const opening = deferred<Response>();
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return await opening.promise;
    }) as unknown as typeof fetch;

    const deal = useBaccaratRoomController.getState().handleDeal();
    const requestingEpoch = useBaccaratRoomController.getState().opEpoch;
    expect(useBaccaratRoomController.getState().phase).toBe('requesting');
    useBaccaratRoomController.getState().reset();
    const resetEpoch = useBaccaratRoomController.getState().opEpoch;
    expect(resetEpoch).toBe(requestingEpoch + 1);

    opening.resolve(jsonResponse({ shoe: makeShoe('stale-shoe'), walletBalance: 100 }));
    await deal;
    expect(calls).toHaveLength(1);
    expect(useBaccaratRoomController.getState()).toMatchObject({
      phase: 'idle',
      opEpoch: resetEpoch,
      shoe: null,
      pending: null,
      settled: null,
    });
  });

  test('hydrate supersedes an in-flight deal and restores the last coup instantly settled', async () => {
    mount();
    const opening = deferred<Response>();
    globalThis.fetch = (async () => await opening.promise) as unknown as typeof fetch;

    const deal = useBaccaratRoomController.getState().handleDeal();
    const outcome = makeOutcome({
      player: {
        cards: [
          { suit: 'clubs', rank: '2' },
          { suit: 'diamonds', rank: '3' },
          { suit: 'hearts', rank: '4' },
        ],
        total: 9,
        isNatural: false,
      },
    });
    const restored: BaccaratLastCoupSnapshot = {
      coupId: 'restored-coup',
      coupIndex: 7,
      outcome,
      dealtCount: 39,
    };
    const hydration = useBaccaratRoomController.getState().hydrate({
      shoe: makeShoe('restored-shoe', { dealtCount: 39 }),
      lastCoup: restored,
      isDemo: false,
      walletBalance: 222,
    });
    await hydration;
    const hydrationEpoch = useBaccaratRoomController.getState().opEpoch;
    expect(useBaccaratRoomController.getState()).toMatchObject({
      phase: 'settled',
      opEpoch: hydrationEpoch,
      walletBalance: 222,
      restored,
      settled: null,
      revealedStep: buildDealSteps(outcome).length,
      correlation: { hand: 'restored-coup' },
      inFlight: false,
    });

    opening.resolve(jsonResponse({ shoe: makeShoe('stale-shoe'), walletBalance: 100 }));
    await deal;
    expect(useBaccaratRoomController.getState()).toMatchObject({
      phase: 'settled',
      opEpoch: hydrationEpoch,
      restored,
      shoe: { id: 'restored-shoe' },
    });
  });

  test('a stale hydrate generation cannot overwrite a newer Deal operation', async () => {
    mount();
    const staleOutcome = makeOutcome({ net: '25', payout: '50', winner: 'player' });
    const staleHydration = useBaccaratRoomController.getState().hydrate({
      shoe: makeShoe('stale-hydration-shoe'),
      lastCoup: {
        coupId: 'stale-hydration-coup',
        coupIndex: 3,
        outcome: staleOutcome,
        dealtCount: 18,
      },
      isDemo: false,
      walletBalance: 999,
    });

    // A newer explicit invalidation lets Deal begin before the hydrate
    // microtask resolves, exactly modeling a late /session/current response.
    useBaccaratRoomController.getState().reset();
    useBaccaratRoomController.setState({
      shoe: makeShoe('deal-shoe'),
      isDemo: false,
    });
    globalThis.fetch = (async () => jsonResponse(
      makeResponse('deal-shoe'),
    )) as unknown as typeof fetch;
    const deal = useBaccaratRoomController.getState().handleDeal();

    await Promise.all([staleHydration, deal]);
    expect(useBaccaratRoomController.getState()).toMatchObject({
      phase: 'revealing',
      walletBalance: 75,
      restored: null,
      settled: { coupId: 'coup-deal-shoe' },
      shoe: { id: 'deal-shoe' },
    });
  });

  test('mount cleanup and remount reject the first hydrate token but accept the second', async () => {
    const firstToken = mount();
    const firstHydration = useBaccaratRoomController.getState().hydrate({
      shoe: makeShoe('first-shoe'),
      lastCoup: null,
      isDemo: false,
      walletBalance: 111,
    });

    unmountBaccaratRuntime(firstToken);
    token = mountBaccaratRuntime('strict-mode-second-setup');
    const secondHydration = useBaccaratRoomController.getState().hydrate({
      shoe: makeShoe('second-shoe'),
      lastCoup: null,
      isDemo: false,
      walletBalance: 222,
    });

    await Promise.all([firstHydration, secondHydration]);
    expect(useBaccaratRoomController.getState()).toMatchObject({
      phase: 'idle',
      shoe: { id: 'second-shoe' },
      walletBalance: 222,
      isDemo: false,
      inFlight: false,
    });
  });

  test('Walk Away is rejected during a fetch without bumping the generation', async () => {
    mount();
    const opening = deferred<Response>();
    globalThis.fetch = (async () => await opening.promise) as unknown as typeof fetch;

    const deal = useBaccaratRoomController.getState().handleDeal();
    const epoch = useBaccaratRoomController.getState().opEpoch;
    await useBaccaratRoomController.getState().handleWalkAway();
    expect(useBaccaratRoomController.getState()).toMatchObject({
      phase: 'requesting',
      opEpoch: epoch,
      walkAwayQueued: false,
    });
    expect(useBaccaratRoomController.getState().toast?.message)
      .toContain('Finishing your deal');

    useBaccaratRoomController.getState().reset();
    opening.resolve(jsonResponse({ shoe: makeShoe('stale-shoe'), walletBalance: 100 }));
    await deal;
  });

  test('multi-step pacing retains one generation and queues Walk Away until settled', async () => {
    const mountedToken = mount();
    const outcome = makeOutcome();
    const steps = buildDealSteps(outcome);
    const epoch = useBaccaratRoomController.getState().opEpoch;
    useBaccaratRoomController.setState({
      phase: 'revealing',
      opEpoch: epoch,
      settled: makeResponse('shoe-1', { outcome }),
      dealSteps: steps,
      revealedStep: 0,
      pending: {
        shoeId: 'shoe-1',
        bet: 'player',
        stake: 25,
        idempotencyKey: 'frozen-key',
      },
    });

    await useBaccaratRoomController.getState().handleWalkAway();
    expect(useBaccaratRoomController.getState()).toMatchObject({
      phase: 'revealing',
      opEpoch: epoch,
      walkAwayQueued: true,
    });

    for (let step = 1; step < steps.length; step += 1) {
      advanceBaccaratReveal(epoch, mountedToken);
      expect(useBaccaratRoomController.getState()).toMatchObject({
        phase: 'revealing',
        opEpoch: epoch,
        revealedStep: step,
      });
    }
    const assigned: string[] = [];
    const restoreWindow = installTestWindow((url) => assigned.push(url));
    try {
      advanceBaccaratReveal(epoch, mountedToken);
      expect(useBaccaratRoomController.getState()).toMatchObject({
        phase: 'revealing',
        opEpoch: epoch,
        revealedStep: steps.length,
        pending: { idempotencyKey: 'frozen-key' },
        walkAwayQueued: true,
      });
      await new Promise((resolve) => {
        setTimeout(resolve, BACCARAT_FINAL_REVEAL_STAGE_MS + 40);
      });
      expect(useBaccaratRoomController.getState()).toMatchObject({
        phase: 'leaving',
        opEpoch: epoch + 1,
        revealedStep: steps.length,
        pending: null,
        walkAwayQueued: true,
      });
      expect(assigned).toEqual(['/cove']);
    } finally {
      restoreWindow();
    }
  });

  test('Next Coup is the explicit settled-to-idle operation boundary', () => {
    mount();
    useBaccaratRoomController.setState({
      phase: 'settled',
      opEpoch: 4,
      correlation: { hand: 'coup-1' },
      bannerText: 'PLAYER WINS',
      revealedStep: 4,
    });
    useBaccaratRoomController.getState().handleNextCoup();
    expect(useBaccaratRoomController.getState()).toMatchObject({
      phase: 'idle',
      opEpoch: 5,
      correlation: null,
      bannerText: null,
      revealedStep: 0,
    });
  });

  test('penetration recovery verifies the old seed and retries with a fresh key', async () => {
    mount();
    const serverSeed = 'retired-server-seed';
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(serverSeed),
    );
    const serverSeedHash = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    useBaccaratRoomController.setState({
      shoe: makeShoe('old-shoe', { serverSeedHash }),
      isDemo: false,
    });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/coup') && calls.filter((call) => call.url.endsWith('/coup')).length === 1) {
        return jsonResponse({
          reshuffled: true,
          message: 'shoe penetration threshold reached',
          dealtCount: 312,
          threshold: 312,
        }, 409);
      }
      if (url.endsWith('/session/close')) {
        return jsonResponse({
          shoeId: 'old-shoe',
          status: 'closed',
          serverSeed,
          serverSeedHash,
          clientSeed: 'client-seed',
          coupsPlayed: 60,
          totalBet: '1500',
          totalPayout: '1400',
          closedAt: '2026-07-23T00:01:00.000Z',
        });
      }
      if (url.endsWith('/session/open')) {
        return jsonResponse({ shoe: makeShoe('fresh-shoe'), walletBalance: 100 });
      }
      if (url.endsWith('/coup')) return jsonResponse(makeResponse('fresh-shoe'));
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const initialEpoch = useBaccaratRoomController.getState().opEpoch;
    await useBaccaratRoomController.getState().handleDeal();
    const coupCalls = calls.filter((call) => call.url.endsWith('/coup'));
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/api/cove/baccarat/coup',
      '/api/cove/baccarat/session/close',
      '/api/cove/baccarat/session/open',
      '/api/cove/baccarat/coup',
    ]);
    expect(requestHeader(coupCalls[0]!.init, 'Idempotency-Key')).not.toBe(
      requestHeader(coupCalls[1]!.init, 'Idempotency-Key'),
    );
    expect(useBaccaratRoomController.getState()).toMatchObject({
      phase: 'revealing',
      opEpoch: initialEpoch + 2,
      shoe: { id: 'fresh-shoe' },
      settled: { coupId: 'coup-fresh-shoe' },
    });
  });

  test('unrecoverable close reveal halts penetration retry and clears pending', async () => {
    mount();
    useBaccaratRoomController.setState({
      shoe: makeShoe('old-shoe'),
      isDemo: false,
    });
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/coup')) {
        return jsonResponse({
          reshuffled: true,
          message: 'shoe penetration threshold reached',
          dealtCount: 312,
          threshold: 312,
        }, 409);
      }
      if (url.endsWith('/session/close')) throw new TypeError('lost close response');
      if (url.includes('/session/old-shoe')) throw new TypeError('detail unavailable');
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    await useBaccaratRoomController.getState().handleDeal();
    expect(calls.map((url) => new URL(url).pathname)).toEqual([
      '/api/cove/baccarat/coup',
      '/api/cove/baccarat/session/close',
      '/api/cove/baccarat/session/old-shoe',
    ]);
    expect(useBaccaratRoomController.getState()).toMatchObject({
      phase: 'idle',
      pending: null,
      inFlight: false,
      shoe: null,
    });
    expect(useBaccaratRoomController.getState().toast?.message).toContain('halted');
  });
});
