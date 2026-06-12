/**
 * In-process keyed async mutex tests (Codex pass-4 P4-1, 2026-06-12).
 *
 * Proves the primitive the Hatcher register/PATCH critical section relies on:
 * same-key calls run strictly serially (no interleave), different-key calls run
 * concurrently, a throwing section releases the lock, and the key map drains.
 */

import { describe, it, expect } from 'bun:test';
import { withKeyedMutex, _keyedMutexSize } from '../keyed-mutex';

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

describe('withKeyedMutex', () => {
  it('serializes same-key sections (no interleave)', async () => {
    const order: string[] = [];
    const make = (id: string) =>
      withKeyedMutex('agent-A', async () => {
        order.push(`${id}:enter`);
        // Yield to the event loop mid-section. If the lock did NOT hold, a second
        // caller would slip its `enter` in here.
        await tick(5);
        order.push(`${id}:exit`);
      });

    // Fire two same-key sections concurrently.
    await Promise.all([make('1'), make('2')]);

    // The first to acquire must fully finish (enter+exit) before the second
    // enters - the two sections never interleave.
    expect(order).toEqual(['1:enter', '1:exit', '2:enter', '2:exit']);
  });

  it('runs different-key sections concurrently', async () => {
    const events: string[] = [];
    const a = withKeyedMutex('agent-A', async () => {
      events.push('A:enter');
      await tick(10);
      events.push('A:exit');
    });
    const b = withKeyedMutex('agent-B', async () => {
      events.push('B:enter');
      await tick(1);
      events.push('B:exit');
    });
    await Promise.all([a, b]);

    // B (different key, shorter section) must enter while A is still running -
    // proving the locks are independent. B:enter precedes A:exit.
    expect(events.indexOf('B:enter')).toBeLessThan(events.indexOf('A:exit'));
    // Both ran their full section.
    expect(events).toContain('A:exit');
    expect(events).toContain('B:exit');
  });

  it('returns the section result and propagates per-caller', async () => {
    const r = await withKeyedMutex('k', async () => 42);
    expect(r).toBe(42);
  });

  it('releases the lock when a section throws (no wedge) and a later waiter still runs', async () => {
    const order: string[] = [];
    const failing = withKeyedMutex('agent-X', async () => {
      order.push('fail:enter');
      await tick(2);
      throw new Error('boom');
    });
    const after = withKeyedMutex('agent-X', async () => {
      order.push('after:enter');
      return 'ok';
    });

    // The throwing caller rejects with its OWN error...
    await expect(failing).rejects.toThrow('boom');
    // ...but the next same-key waiter is NOT rejected by the prior failure and
    // runs after it (lock was released in `finally`).
    await expect(after).resolves.toBe('ok');
    expect(order).toEqual(['fail:enter', 'after:enter']);
  });

  it('drains the key map after all sections settle (no unbounded growth)', async () => {
    await Promise.all([
      withKeyedMutex('g1', async () => tick(1)),
      withKeyedMutex('g1', async () => tick(1)),
      withKeyedMutex('g2', async () => tick(1)),
    ]);
    // Let the finally-blocks of the last holders run.
    await tick(5);
    expect(_keyedMutexSize()).toBe(0);
  });

  it('a prior caller failing does not reject a queued caller acquire', async () => {
    // The queued caller awaits `prior.catch(() => {})`, so a rejected prior must
    // never surface as the queued caller's rejection.
    const p1 = withKeyedMutex('q', async () => {
      throw new Error('first');
    });
    const p2 = withKeyedMutex('q', async () => 'second');
    await expect(p1).rejects.toThrow('first');
    await expect(p2).resolves.toBe('second');
  });
});
