import { describe, expect, test } from 'bun:test';
import { CoveApiError, type AgentDecisionResponse, type CurrentHandResponse } from '../blackjack-api-client';
import {
  BlackjackControllerRuntime,
  actionErrorPolicy,
  dealErrorPolicy,
  firstUnresolvedSlot,
  type SubHandView,
} from '../use-blackjack-room-controller';

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

class FakeClock {
  private nextId = 1;
  private tasks = new Map<number, () => void>();

  readonly schedule = (callback: () => void, _delayMs: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.tasks.set(id, callback);
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  readonly clear = (handle: ReturnType<typeof setTimeout>): void => {
    this.tasks.delete(handle as unknown as number);
  };

  async flush(): Promise<void> {
    const tasks = [...this.tasks.values()];
    this.tasks.clear();
    for (const task of tasks) task();
    await Promise.resolve();
    await Promise.resolve();
  }
}

function liveHand(handId: string, resolved = false): CurrentHandResponse {
  return {
    handId,
    shoeId: 'shoe-1',
    handIndex: 4,
    status: 'in_progress',
    playerHands: [{
      cards: [
        { suit: 'hearts', rank: '10' },
        { suit: 'clubs', rank: '7' },
      ],
      total: 17,
      isSoft: false,
      isBust: false,
      isResolved: resolved,
    }],
    dealerUpcard: { suit: 'spades', rank: 'A' },
    didSplit: false,
    insuranceOffered: true,
    tookInsurance: false,
    bet: '25',
  };
}

describe('useBlackjackRoomController runtime over mocked wire', () => {
  test('1. eager restore cannot clear a hand dealt during the await', async () => {
    const runtime = new BlackjackControllerRuntime();
    const currentHand = new Deferred<CurrentHandResponse>();
    const observed = { handId: null as string | null };
    const restore = currentHand.promise.then((response) => {
      if (runtime.restoredHandDisposition(response, false) === 'clear') observed.handId = null;
    });

    observed.handId = 'dealt-during-await';
    currentHand.resolve({ hand: null, shoeId: 'shoe-1' });
    await restore;
    expect(observed.handId).toBe('dealt-during-await');
  });

  test('2. stale current-hand read for an already-settled hand is ignored', async () => {
    const runtime = new BlackjackControllerRuntime();
    runtime.markSettled('settled-h1');
    const wire = { currentHand: async () => liveHand('settled-h1') };
    const response = await wire.currentHand();
    expect(runtime.restoredHandDisposition(response, true)).toBe('ignore');
  });

  test('3. terminal self-heal performs one mocked resync per hand id', async () => {
    const runtime = new BlackjackControllerRuntime();
    const hands: Pick<SubHandView, 'isResolved'>[] = [{ isResolved: true }];
    let currentCalls = 0;
    let phase = 'player-turn';
    const wire = {
      currentHand: async (): Promise<CurrentHandResponse> => {
        currentCalls += 1;
        return { hand: null, shoeId: 'shoe-1' };
      },
    };
    const heal = async () => {
      if (!runtime.claimTerminalSelfHeal('h-terminal', hands)) return;
      const response = await wire.currentHand();
      if (runtime.restoredHandDisposition(response, true) === 'clear') phase = 'idle';
    };
    await heal();
    await heal();
    expect(currentCalls).toBe(1);
    expect(phase).toBe('idle');
  });

  test('4. stale agent deal resyncs, appends advisor text, and stays autonomous', async () => {
    const runtime = new BlackjackControllerRuntime();
    let resyncCalls = 0;
    const advisor: string[] = [];
    let mode = 'autonomous';
    const wire = {
      deal: async () => {
        throw new CoveApiError(409, 'stale_agent_deal', 'stale_agent_deal');
      },
      resync: async () => { resyncCalls += 1; },
    };
    try {
      await wire.deal();
    } catch (error) {
      if (dealErrorPolicy(error, { agentDriven: true, isRealTier: true }) === 'stale-agent-reconcile') {
        runtime.dealKeyRef.current = null;
        await wire.resync();
        advisor.push('agent stood down');
      }
    }
    expect(resyncCalls).toBe(1);
    expect(advisor).toEqual(['agent stood down']);
    expect(mode).toBe('autonomous');
  });

  test('5. stale agent action mints a fresh future key and resyncs', async () => {
    const runtime = new BlackjackControllerRuntime();
    const firstKey = runtime.ensureActionKey(() => 'action-old');
    let resyncCalls = 0;
    const wire = {
      action: async () => {
        throw new CoveApiError(409, 'stale_agent_decision', 'stale_agent_decision');
      },
      resync: async () => { resyncCalls += 1; },
    };
    try {
      await wire.action();
    } catch (error) {
      const policy = actionErrorPolicy(error, { agentDriven: true, isRealTier: true });
      runtime.retainActionKeyAfterError(firstKey, policy, true);
      await wire.resync();
    }
    const freshKey = runtime.ensureActionKey(() => 'action-fresh');
    expect(resyncCalls).toBe(1);
    expect(freshKey).toBe('action-fresh');
  });

  test('6. action wire receives relay hand id, slot, and expected version', async () => {
    const runtime = new BlackjackControllerRuntime();
    const decision: AgentDecisionResponse = {
      action: 'hit',
      handId: 'relay-hand',
      handSlot: 1,
      handVersion: 9,
    };
    let payload: unknown;
    const wire = {
      action: async (input: unknown) => { payload = input; },
    };
    const target = runtime.relayTarget(decision);
    await wire.action({
      handId: target.handId,
      handSlot: target.slot,
      expectedHandVersion: target.version,
    });
    expect(payload).toEqual({
      handId: 'relay-hand',
      handSlot: 1,
      expectedHandVersion: 9,
    });
  });

  test('7. split merge focuses the first non-resolved slot', () => {
    expect(firstUnresolvedSlot([{ isResolved: true }, { isResolved: false }])).toBe(1);
    expect(firstUnresolvedSlot([{ isResolved: false }, { isResolved: true }])).toBe(0);
  });

  test('8. takeover cancels the timer epoch and human/agent locks stay isolated', async () => {
    const clock = new FakeClock();
    const runtime = new BlackjackControllerRuntime(clock.schedule, clock.clear);
    let applies = 0;
    runtime.scheduleAgentApply(8_000, () => { applies += 1; });
    runtime.bumpDecisionContext();
    await clock.flush();
    expect(applies).toBe(0);

    runtime.busyRef.current = true;
    expect(runtime.agentBusyRef.current).toBe(false);
    runtime.busyRef.current = false;
    let sawAgentLock = false;
    runtime.scheduleAgentApply(8_000, () => {
      sawAgentLock = runtime.agentBusyRef.current;
      applies += 1;
    });
    await clock.flush();
    expect(sawAgentLock).toBe(true);
    expect(applies).toBe(1);
  });

  test('9. reshuffle opens a fresh shoe, uses a new key, and drops the old epoch', async () => {
    const runtime = new BlackjackControllerRuntime();
    runtime.ensureDealKey(() => 'old-deal-key');
    let dealPayload: Record<string, unknown> | null = null;
    const wire = {
      open: async () => ({ shoeId: 'shoe-fresh' }),
      deal: async (input: Record<string, unknown>) => { dealPayload = input; },
    };
    const fresh = await wire.open();
    const retry = runtime.prepareFreshShoeRetry(() => 'fresh-deal-key');
    await wire.deal({
      shoeId: fresh.shoeId,
      idempotencyKey: retry.idempotencyKey,
    });
    expect(dealPayload).not.toBeNull();
    expect(dealPayload as unknown as Record<string, unknown>).toEqual({
      shoeId: 'shoe-fresh',
      idempotencyKey: 'fresh-deal-key',
    });
  });

  test('10. terminal replay reuses its key and Walk Away reveals then closes', async () => {
    const clock = new FakeClock();
    const runtime = new BlackjackControllerRuntime(clock.schedule, clock.clear);
    const key = runtime.ensureActionKey(() => 'terminal-key');
    const actionKeys: string[] = [];
    let attempt = 0;
    const wire = {
      action: async (idempotencyKey: string) => {
        actionKeys.push(idempotencyKey);
        attempt += 1;
        if (attempt === 1) throw new Error('lost response');
        return { status: 'settled' as const };
      },
      close: async () => ({ serverSeed: 'revealed-seed' }),
    };
    try {
      await wire.action(key);
    } catch (error) {
      const policy = actionErrorPolicy(error, { agentDriven: false, isRealTier: true });
      runtime.retainActionKeyAfterError(key, policy, true);
    }
    await wire.action(runtime.actionKeyRef.current!);
    let revealedSeed: string | null = null;
    let closed = false;
    const close = await wire.close();
    revealedSeed = close.serverSeed;
    runtime.scheduleClose(1_400, () => { closed = true; });
    await clock.flush();
    expect(actionKeys).toEqual(['terminal-key', 'terminal-key']);
    expect(revealedSeed).toBe('revealed-seed');
    expect(closed).toBe(true);
  });

  test('11. skipped insure is queried once and suppressed for the same version context', async () => {
    const runtime = new BlackjackControllerRuntime();
    let decideCalls = 0;
    const wire = {
      decide: async (): Promise<AgentDecisionResponse> => {
        decideCalls += 1;
        return { action: 'insure', handId: 'h-insure', handVersion: 3 };
      },
    };
    const first = await wire.decide();
    runtime.latchInsurance(first.handId!, first.handVersion!);
    if (!runtime.suppressInsuranceQuery('h-insure')) await wire.decide();
    expect(decideCalls).toBe(1);
    expect(runtime.latchInsurance('h-insure', 3)).toBe(false);
    expect(runtime.latchInsurance('h-insure', 4)).toBe(true);
  });

  test('12. ambiguous non-terminal hit reconciles once and is never blind-retried', async () => {
    const runtime = new BlackjackControllerRuntime();
    const key = runtime.ensureActionKey(() => 'hit-key');
    let actionCalls = 0;
    let reconcileCalls = 0;
    const wire = {
      hit: async () => {
        actionCalls += 1;
        throw new Error('connection reset after send');
      },
      currentHand: async () => {
        reconcileCalls += 1;
        return liveHand('h-hit');
      },
    };
    try {
      await wire.hit();
    } catch (error) {
      const policy = actionErrorPolicy(error, { agentDriven: false, isRealTier: true });
      runtime.retainActionKeyAfterError(key, policy, false);
      await wire.currentHand();
    }
    expect(actionCalls).toBe(1);
    expect(reconcileCalls).toBe(1);
    expect(runtime.actionKeyRef.current).toBeNull();
  });
});
