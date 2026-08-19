// boot-core-compile.test.ts — rung-4 slice E rev 2 serial-queue contract
// (spec §2a/§4.3): exactly-once serial dispatch, abort-on-failure,
// cancellation, empty inventory, observer-throw non-fatal.
import { describe, expect, test } from 'bun:test';
import { runBootCoreCompileQueue } from '../boot-core-compile';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('runBootCoreCompileQueue', () => {
  test('compiles every group exactly once, in order, strictly serially', async () => {
    const groups = Array.from({ length: 9 }, (_, i) => ({ id: i }));
    const compiled: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const result = await runBootCoreCompileQueue({
      groups,
      compile: async (g) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        compiled.push(g.id);
        await tick();
        inFlight -= 1;
      },
      isCancelled: () => false,
    });
    expect(result).toEqual({ requested: 9, dispatched: 9, settled: 9, failed: 0, aborted: false });
    expect(compiled).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(peak).toBe(1); // width is structurally 1
  });

  test('abort-on-failure: first rejection stops further dispatch (R1-4)', async () => {
    const groups = ['a', 'b', 'c', 'd'];
    const compiled: string[] = [];
    const settled: Array<{ group: string; failed: boolean; error?: unknown }> = [];
    const boom = new Error('front exploded');
    const result = await runBootCoreCompileQueue({
      groups,
      compile: async (g) => {
        if (g === 'b') throw boom;
        compiled.push(g);
      },
      isCancelled: () => false,
      onGroupSettled: (group, failed, error) => {
        settled.push({ group, failed, error });
      },
    });
    expect(result).toEqual({ requested: 4, dispatched: 2, settled: 2, failed: 1, aborted: true });
    expect(compiled).toEqual(['a']); // c and d never dispatched
    expect(settled.length).toBe(2);
    expect(settled[1]).toEqual({ group: 'b', failed: true, error: boom });
  });

  test('stopOnFailure: false keeps compiling later groups', async () => {
    const groups = ['a', 'b', 'c'];
    const compiled: string[] = [];
    const result = await runBootCoreCompileQueue({
      groups,
      stopOnFailure: false,
      compile: async (g) => {
        if (g === 'b') throw new Error('x');
        compiled.push(g);
      },
      isCancelled: () => false,
    });
    expect(result).toEqual({ requested: 3, dispatched: 3, settled: 3, failed: 1, aborted: false });
    expect(compiled).toEqual(['a', 'c']);
  });

  test('cancellation stops dispatch exactly at the flag flip', async () => {
    const groups = [0, 1, 2, 3, 4];
    let cancelled = false;
    const compiled: number[] = [];
    const result = await runBootCoreCompileQueue({
      groups,
      compile: async (g) => {
        compiled.push(g);
        if (g === 1) cancelled = true;
      },
      isCancelled: () => cancelled,
    });
    // Serial ⇒ deterministic: 0 and 1 compile, 2..4 never dispatch.
    expect(compiled).toEqual([0, 1]);
    expect(result).toEqual({ requested: 5, dispatched: 2, settled: 2, failed: 0, aborted: true });
  });

  test('cancelled before start dispatches nothing', async () => {
    const result = await runBootCoreCompileQueue({
      groups: [1, 2, 3],
      compile: async () => {
        throw new Error('must not be called');
      },
      isCancelled: () => true,
    });
    expect(result).toEqual({ requested: 3, dispatched: 0, settled: 0, failed: 0, aborted: true });
  });

  test('empty inventory returns zeros without aborting (R1-12)', async () => {
    const result = await runBootCoreCompileQueue({
      groups: [],
      compile: async () => {},
      isCancelled: () => false,
    });
    expect(result).toEqual({ requested: 0, dispatched: 0, settled: 0, failed: 0, aborted: false });
  });

  test('an observer throw is swallowed and the queue continues (R1-12)', async () => {
    const groups = ['a', 'b', 'c'];
    const compiled: string[] = [];
    const result = await runBootCoreCompileQueue({
      groups,
      compile: async (g) => {
        compiled.push(g);
      },
      isCancelled: () => false,
      onGroupSettled: () => {
        throw new Error('observer bug');
      },
    });
    expect(result).toEqual({ requested: 3, dispatched: 3, settled: 3, failed: 0, aborted: false });
    expect(compiled).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// chainBootCompile [R2-1] — renderer-wide FIFO across warmup generations.
// ---------------------------------------------------------------------------
import {
  __resetBootCompileChainForTests,
  awaitBootCompileIdle,
  chainBootCompile,
  isBootCompileIdle,
} from '../boot-core-compile';

describe('chainBootCompile', () => {
  test('a successor generation task waits for the in-flight predecessor', async () => {
    __resetBootCompileChainForTests();
    const events: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const genA = chainBootCompile(async () => {
      events.push('A-start');
      await gateA; // generation A's uncancellable in-flight compile
      events.push('A-end');
    });
    const genB = chainBootCompile(async () => {
      events.push('B-start');
    });
    await tick();
    expect(events).toEqual(['A-start']); // B must NOT have started
    expect(isBootCompileIdle()).toBe(false);
    releaseA();
    await Promise.all([genA, genB]);
    expect(events).toEqual(['A-start', 'A-end', 'B-start']);
    await awaitBootCompileIdle();
    expect(isBootCompileIdle()).toBe(true);
  });

  test('a rejected predecessor still releases the chain', async () => {
    __resetBootCompileChainForTests();
    const first = chainBootCompile(async () => {
      throw new Error('front exploded');
    });
    await first.catch(() => {});
    const ran: string[] = [];
    await chainBootCompile(async () => {
      ran.push('second');
    });
    expect(ran).toEqual(['second']);
    expect(isBootCompileIdle()).toBe(true);
  });

  test('awaitBootCompileIdle covers tasks chained while awaiting', async () => {
    __resetBootCompileChainForTests();
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    void chainBootCompile(async () => {
      await gateA;
    });
    // Chain a SECOND task while the first is in flight, then release both.
    const second = chainBootCompile(async () => {
      await tick();
    });
    const idle = awaitBootCompileIdle();
    releaseA();
    await second;
    await idle;
    expect(isBootCompileIdle()).toBe(true);
  });
});
