/**
 * In-process keyed async mutex (Codex pass-4 P4-1, 2026-06-12).
 *
 * Serializes async critical sections by string key WITHIN a single Node/Bun
 * process. Two `withKeyedMutex(k, fn)` calls for the SAME key run strictly one
 * after the other (FIFO); calls for DIFFERENT keys run concurrently.
 *
 * WHY: the Hatcher register/PATCH handlers have an in-memory critical section
 * (npc-simulation stale-session cleanup + spawn) that a Postgres advisory lock
 * alone does NOT cover - the advisory lock serializes the DB transaction across
 * processes, but the `registerAgentBot` Map mutation happens AFTER the tx commits
 * and is process-local. Two concurrent same-process requests for one agentId
 * could both clean stale sessions, both mint a bearer, and both spawn a body
 * (duplicate avatars keyed by distinct sessionIds) even while the DB tx is
 * serialized. This mutex closes that intra-process window; the advisory lock
 * closes the cross-process one. Both are required for full serialization.
 *
 * The lock is a per-key Promise chain: each caller appends its work to the tail
 * of the key's chain and awaits the previous tail. The map entry is deleted when
 * the chain drains to avoid unbounded growth (one entry per DISTINCT in-flight
 * key, not per call). The deletion is guarded against a race where a new waiter
 * appended after we captured the tail.
 *
 * This is intentionally NOT reentrant: calling `withKeyedMutex(k, ...)` for the
 * same key from inside a holder of `k` would self-deadlock. No handler does that
 * (the critical sections are flat).
 */

/** Per-key tail of the in-flight promise chain. Absent key = not locked. */
const chains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` while holding the mutex for `key`. Resolves/rejects with `fn`'s
 * result. The lock is released (the chain advances) whether `fn` resolves or
 * throws, so a throwing critical section never wedges the key.
 */
export async function withKeyedMutex<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  // The work this caller will run once the prior tail settles. We chain off the
  // CURRENT tail (or an already-resolved promise if the key is free).
  const prior = chains.get(key) ?? Promise.resolve();

  let release!: () => void;
  // The "next tail" is a promise that resolves when THIS caller's critical
  // section finishes - the next waiter chains off it.
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  chains.set(key, gate);

  try {
    // Wait for everyone ahead of us. We swallow the prior's rejection - each
    // caller already gets its OWN result/rejection from its own `fn`; a prior
    // caller's failure must not reject a later caller's acquire.
    await prior.catch(() => {});
    return await fn();
  } finally {
    // Advance the chain: let the next waiter proceed.
    release();
    // GC the key when WE are still the tail (no later waiter replaced `gate`).
    // If a newer caller appended after us, `chains.get(key) !== gate`, so we
    // leave their entry intact.
    if (chains.get(key) === gate) {
      chains.delete(key);
    }
  }
}

/** Test-only: number of keys currently tracked (0 when fully drained). */
export function _keyedMutexSize(): number {
  return chains.size;
}
