/**
 * Visibility-gated one-shot fuse (rung-4 task 6, founder decision (a)) —
 * deterministic fake-clock tests for every edge the Codex decisions-review
 * demanded: initially-hidden full-budget resume, pause/resume banking, rapid
 * flips (no double-arm / double-subtract), at-most-once firing, terminal
 * dispose from external dismissal paths, and listener/timer cleanup.
 */

import { describe, it, expect } from 'bun:test';
import { createVisibilityFuse } from './visibility-fuse';

/** Deterministic clock + timer + document harness. */
function harness(initialVisibility: 'visible' | 'hidden' = 'visible') {
  let nowMs = 0;
  let visibility: 'visible' | 'hidden' = initialVisibility;
  const listeners = new Set<() => void>();
  type Pending = { fn: () => void; at: number };
  const timers = new Map<number, Pending>();
  let timerSeq = 0;

  return {
    deps: {
      now: () => nowMs,
      setTimeoutFn: (fn: () => void, ms: number) => {
        const id = ++timerSeq;
        timers.set(id, { fn, at: nowMs + ms });
        return id;
      },
      clearTimeoutFn: (h: unknown) => void timers.delete(h as number),
      doc: {
        get visibilityState() {
          return visibility;
        },
        addEventListener: (_t: string, l: EventListener) =>
          void listeners.add(l as unknown as () => void),
        removeEventListener: (_t: string, l: EventListener) =>
          void listeners.delete(l as unknown as () => void),
      } as unknown as Document,
    },
    /** Advance the clock, firing any timer whose deadline passes. */
    advance(ms: number) {
      const target = nowMs + ms;
      // Fire in deadline order; a fired timer may schedule nothing new here.
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        nowMs = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      nowMs = target;
    },
    setVisibility(v: 'visible' | 'hidden') {
      visibility = v;
      for (const l of [...listeners]) l();
    },
    pendingTimerCount: () => timers.size,
    listenerCount: () => listeners.size,
  };
}

describe('createVisibilityFuse', () => {
  it('fires exactly once after the budget of VISIBLE time, then is done', () => {
    const h = harness('visible');
    let fired = 0;
    const fuse = createVisibilityFuse(1_000, () => void fired++, h.deps);
    h.advance(999);
    expect(fired).toBe(0);
    h.advance(1);
    expect(fired).toBe(1);
    expect(fuse.done()).toBe(true);
    expect(h.pendingTimerCount()).toBe(0);
    expect(h.listenerCount()).toBe(0); // firing disposed the listener
    h.advance(10_000);
    expect(fired).toBe(1);
  });

  it('constructed hidden: never runs until shown, then arms with the FULL budget', () => {
    const h = harness('hidden');
    let fired = 0;
    createVisibilityFuse(1_000, () => void fired++, h.deps);
    expect(h.pendingTimerCount()).toBe(0);
    h.advance(60_000); // parked in a background tab far past the budget
    expect(fired).toBe(0);
    h.setVisibility('visible');
    h.advance(999);
    expect(fired).toBe(0);
    h.advance(1); // full 1000ms of VISIBLE time only now elapses
    expect(fired).toBe(1);
  });

  it('banks the remainder across pause/resume', () => {
    const h = harness('visible');
    let fired = 0;
    const fuse = createVisibilityFuse(1_000, () => void fired++, h.deps);
    h.advance(600);
    h.setVisibility('hidden');
    expect(fuse.remainingMs()).toBe(400);
    h.advance(100_000); // hidden time is free
    expect(fired).toBe(0);
    h.setVisibility('visible');
    h.advance(399);
    expect(fired).toBe(0);
    h.advance(1);
    expect(fired).toBe(1);
  });

  it('rapid visibility flips neither double-arm nor double-subtract', () => {
    const h = harness('visible');
    let fired = 0;
    const fuse = createVisibilityFuse(1_000, () => void fired++, h.deps);
    for (let i = 0; i < 10; i++) {
      h.setVisibility('hidden');
      h.setVisibility('visible');
      // Redundant repeat notifications in the same state must be no-ops.
      h.setVisibility('visible');
    }
    expect(h.pendingTimerCount()).toBe(1); // exactly one armed timer
    expect(fuse.remainingMs()).toBe(1_000); // zero elapsed → zero subtracted
    h.advance(1_000);
    expect(fired).toBe(1);
  });

  it('dispose() from an external dismissal path is terminal and idempotent', () => {
    const h = harness('visible');
    let fired = 0;
    const fuse = createVisibilityFuse(1_000, () => void fired++, h.deps);
    h.advance(500);
    fuse.dispose(); // e.g. __W3D_READY dismissed the overlay normally
    fuse.dispose(); // idempotent
    expect(fuse.done()).toBe(true);
    expect(h.pendingTimerCount()).toBe(0);
    expect(h.listenerCount()).toBe(0);
    // A later visibility flip must NOT re-arm a disposed fuse.
    h.setVisibility('hidden');
    h.setVisibility('visible');
    expect(h.pendingTimerCount()).toBe(0);
    h.advance(100_000);
    expect(fired).toBe(0);
  });
});
