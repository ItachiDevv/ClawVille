/**
 * perf-tracker.ts — lightweight named-spike tracker for diagnosing
 * main-thread stutters.
 *
 * Wrap any synchronous hot path with `measureSpike('name', () => ...)`.
 * The tracker records the duration via `performance.mark` + `performance.measure`,
 * which means:
 *   1. It shows up in Chrome DevTools' Performance tab (free profiling)
 *   2. The PerformanceObserver below captures every entry and tracks the
 *      max duration per name in a rolling 1s window
 *   3. PerfHud calls `getTopSpikes()` to display the worst offenders
 *
 * Designed for ZERO overhead when not actively diagnosing — the wrap is just
 * mark + fn + measure, and the observer only fires on entries we explicitly
 * mark (no scene-wide scan).
 *
 * Production-safe: stays out of the way if PerformanceObserver isn't available.
 */

interface SpikeEntry {
  name: string;
  maxMs: number;
  lastMs: number;
  count: number;
  windowResetAt: number;
  /** Sum of ms accumulated since last cumulative flush. */
  sumMs: number;
  /** Highest sum-per-frame seen in the rolling window. */
  maxSumMs: number;
  /** Marker for whether this entry is sum-accumulating (vs single-event). */
  isCumulative: boolean;
}

const WINDOW_MS = 1000;
const _spikes = new Map<string, SpikeEntry>();
let _observer: PerformanceObserver | null = null;
let _started = false;

function recordEntry(name: string, ms: number) {
  const now = performance.now();
  let e = _spikes.get(name);
  if (!e) {
    e = {
      name,
      maxMs: 0,
      lastMs: 0,
      count: 0,
      windowResetAt: now,
      sumMs: 0,
      maxSumMs: 0,
      isCumulative: false,
    };
    _spikes.set(name, e);
  }
  // Reset the rolling window every WINDOW_MS so stale spikes don't dominate.
  if (now - e.windowResetAt > WINDOW_MS) {
    e.maxMs = 0;
    e.maxSumMs = 0;
    e.count = 0;
    e.windowResetAt = now;
  }
  e.lastMs = ms;
  if (ms > e.maxMs) e.maxMs = ms;
  e.count++;
}

function start() {
  if (_started) return;
  if (typeof window === 'undefined') return;
  if (typeof PerformanceObserver === 'undefined') return;
  _started = true;
  try {
    _observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        recordEntry(entry.name, entry.duration);
      }
    });
    _observer.observe({ entryTypes: ['measure'] });
  } catch {
    // Some browsers don't support 'measure' — fail open, recordEntry can still
    // be called manually by measureSpike().
  }
}

/**
 * Sync wrapper. Marks + measures around fn. The measure entry is delivered to
 * the PerformanceObserver which updates the spike map. Returns whatever fn
 * returns.
 *
 *   measureSpike('npc-sse-update', () => updateFromSnapshot(snapshot));
 */
export function measureSpike<T>(name: string, fn: () => T): T {
  start();
  if (typeof performance === 'undefined') return fn();

  const startMark = `${name}:s`;
  const endMark = `${name}:e`;
  try {
    performance.mark(startMark);
    const result = fn();
    performance.mark(endMark);
    performance.measure(name, startMark, endMark);
    return result;
  } finally {
    // Clean up marks so the buffer doesn't grow unboundedly.
    try {
      performance.clearMarks(startMark);
      performance.clearMarks(endMark);
      performance.clearMeasures(name);
    } catch {
      // some perf implementations don't expose clear* — ignore
    }
  }
}

/**
 * Returns the top N spike entries by current-window max, in descending order.
 * PerfHud uses this to render the worst offenders inline.
 */
export function getTopSpikes(n = 3): readonly SpikeEntry[] {
  // Filter out stale entries (no activity in the window).
  const now = performance.now();
  const live: SpikeEntry[] = [];
  for (const e of _spikes.values()) {
    if (now - e.windowResetAt > WINDOW_MS * 2) continue;
    const m = e.isCumulative ? e.maxSumMs : e.maxMs;
    if (m <= 0) continue;
    live.push(e);
  }
  live.sort((a, b) => {
    const am = a.isCumulative ? a.maxSumMs : a.maxMs;
    const bm = b.isCumulative ? b.maxSumMs : b.maxMs;
    return bm - am;
  });
  return live.slice(0, n);
}

/**
 * Accumulating variant. Each call adds to a running sum for the current frame.
 * Call `flushCumulative(name)` once per frame (e.g. at end of useFrame chain)
 * to record the frame's total and reset the accumulator.
 *
 * Example — wrap each NPC's per-frame work in `accumulate('npcs', dur)`, then
 * call `flushCumulative('npcs')` after rendering the last NPC. The PerfHud
 * will show "<total-ms> npcs" capturing the SUM across all NPCs that frame,
 * not the max of one.
 */
export function measureCumulative<T>(name: string, fn: () => T): T {
  if (typeof performance === 'undefined') return fn();
  start();
  const t0 = performance.now();
  const result = fn();
  const t1 = performance.now();
  // Mutate or create the entry. Cumulative entries don't use mark/measure
  // (no need to send to PerformanceObserver — sum is internal).
  const now = performance.now();
  let e = _spikes.get(name);
  if (!e) {
    e = {
      name,
      maxMs: 0,
      lastMs: 0,
      count: 0,
      windowResetAt: now,
      sumMs: 0,
      maxSumMs: 0,
      isCumulative: true,
    };
    _spikes.set(name, e);
  }
  if (now - e.windowResetAt > WINDOW_MS) {
    e.maxMs = 0;
    e.maxSumMs = 0;
    e.count = 0;
    e.windowResetAt = now;
  }
  e.sumMs += t1 - t0;
  return result;
}

/**
 * Flush the accumulated sum for `name` as one frame's worth, then reset the
 * accumulator. Call at end of frame (e.g. via a one-line useFrame at low
 * priority, or after the last NPC's useFrame runs).
 */
export function flushCumulative(name: string): void {
  const e = _spikes.get(name);
  if (!e) return;
  if (e.sumMs > e.maxSumMs) e.maxSumMs = e.sumMs;
  e.lastMs = e.sumMs;
  e.sumMs = 0;
}
