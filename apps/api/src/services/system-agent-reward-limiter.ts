/**
 * In-memory rate limiter for system-agent chat rewards.
 *
 * System agents (Town Guide et al.) reward +1 ClawToken + XP per chat turn,
 * same as a building teacher. Without a rate limit, a user can spam the
 * guide endpoint and mint tokens unbounded.
 *
 * This limiter applies a 60-second cooldown per (userId, slug) pair:
 * `tryConsume()` returns true if the reward is allowed (and records the
 * timestamp), false if the user is still within the cooldown window.
 *
 * Design:
 *   - **In-memory only** — state is per-API-pod. If we ever multi-pod the
 *     API, this needs promoting to Redis. Today's single-pod Coolify
 *     deployment makes in-memory fine; the cost of a user spamming across
 *     pod restarts is one extra token per restart.
 *   - **10-minute sweep** removes entries older than `COOLDOWN_MS * 2` so
 *     the Map doesn't grow unbounded with one-time visitors.
 *   - **LRU cap of 1000 entries** — insertion order in `Map` is preserved,
 *     so when size exceeds the cap we delete the oldest half until back to
 *     500. Trades some precision at the tail for a hard memory ceiling.
 *
 * This is intentionally light — the heavier ledger (`claw-token-ledger.ts`)
 * still records every transaction with balanceAfter, so if two rewards do
 * slip through a pod restart the audit trail shows them.
 */

const COOLDOWN_MS = 60_000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 1000;
const TRIM_TO = 500;

class SystemAgentRewardLimiter {
  /**
   * Map key: `${userId}:${slug}`. Value: epoch-ms of last allowed reward.
   * Insertion order is preserved by V8's Map (spec guarantee), so we can
   * use it for a cheap LRU trim.
   */
  private lastRewardAt: Map<string, number> = new Map();
  private sweepInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.sweepInterval = setInterval(() => {
      this.sweepExpired();
    }, SWEEP_INTERVAL_MS);
    // Don't block process exit on our timer — lets Bun shut down cleanly.
    if (typeof this.sweepInterval === 'object' && this.sweepInterval && 'unref' in this.sweepInterval) {
      (this.sweepInterval as unknown as { unref: () => void }).unref();
    }
  }

  /**
   * Returns true if the reward is allowed for `(userId, slug)` right now +
   * records the timestamp. Returns false if still within cooldown window.
   */
  tryConsume(userId: string, slug: string): boolean {
    const key = `${userId}:${slug}`;
    const now = Date.now();
    const last = this.lastRewardAt.get(key);

    if (last !== undefined && now - last < COOLDOWN_MS) {
      return false;
    }

    // Re-insert so this key moves to the end (most-recently-used) for LRU.
    this.lastRewardAt.delete(key);
    this.lastRewardAt.set(key, now);

    if (this.lastRewardAt.size > MAX_ENTRIES) {
      this.trimLru();
    }

    return true;
  }

  /** Remove entries older than 2× the cooldown. */
  private sweepExpired(): void {
    const cutoff = Date.now() - COOLDOWN_MS * 2;
    for (const [key, ts] of this.lastRewardAt) {
      if (ts < cutoff) {
        this.lastRewardAt.delete(key);
      }
    }
  }

  /** Trim oldest entries (insertion order) until size hits TRIM_TO. */
  private trimLru(): void {
    const toDelete = this.lastRewardAt.size - TRIM_TO;
    if (toDelete <= 0) return;
    let deleted = 0;
    for (const key of this.lastRewardAt.keys()) {
      this.lastRewardAt.delete(key);
      if (++deleted >= toDelete) break;
    }
  }

  /** Test hook — resets internal state. Not used in prod. */
  _resetForTests(): void {
    this.lastRewardAt.clear();
  }

  /** Test/ops hook — current map size. */
  size(): number {
    return this.lastRewardAt.size;
  }
}

export const systemAgentRewardLimiter = new SystemAgentRewardLimiter();
