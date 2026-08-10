/**
 * Self prediction/control lock ordering for server-authoritative spinouts
 * (Codex R19 rounds 2-3, 2026-08-09) — regression tests for the shared
 * `selfObstacleControlLockedUntil` deadline:
 *
 *   - an item spinout (`event.hit` with `spinoutDurationMs` — whirlpool /
 *     puffer) engages the SAME lock as an obstacle spinout;
 *   - a later `event.obstacle_hit` BUMP must PRESERVE a live lock (the old
 *     `: 0` reset let a driftwood bump prematurely clear a whirlpool lock);
 *   - overlapping spinout deadlines resolve to the LATEST (Math.max in both
 *     handlers — a new lock never shortens an existing one);
 *   - a hit for a DIFFERENT avatar, or without `spinoutDurationMs`, leaves
 *     the self lock untouched.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { useActivityStore } from '../activity';

const SELF = 'self-avatar';

const hitFrame = (over: Record<string, unknown> = {}) => ({
  type: 'event.hit',
  srcAvatarId: 'attacker-1',
  attackerAvatarId: 'attacker-1',
  dstAvatarId: SELF,
  itemKind: 'rr-whirlpool',
  position: { x: 0, y: 0 },
  power: 0.8,
  ...over,
});

const obstacleFrame = (impact: 'spinout' | 'bump', durationMs: number) => ({
  type: 'event.obstacle_hit',
  avatarId: SELF,
  obstacleId: 'obs-1',
  kind: impact === 'spinout' ? 'urchin' : 'driftwood',
  impact,
  durationMs,
  position: { x: 0, y: 0 },
});

describe('activity store — spinout control-lock ordering', () => {
  beforeEach(() => {
    useActivityStore.setState({
      selfAvatarId: SELF,
      selfObstacleControlLockedUntil: 0,
    });
  });

  it('an item hit with spinoutDurationMs engages the lock for self', () => {
    const before = Date.now();
    useActivityStore.getState().applyServerFrame(
      hitFrame({ spinoutDurationMs: 900 }) as never,
    );
    const lock = useActivityStore.getState().selfObstacleControlLockedUntil;
    expect(lock).toBeGreaterThanOrEqual(before + 900);
  });

  it('a hit WITHOUT spinoutDurationMs (pure VFX) leaves the lock at 0', () => {
    useActivityStore.getState().applyServerFrame(
      hitFrame({ itemKind: 'rr-ink-slick' }) as never,
    );
    expect(useActivityStore.getState().selfObstacleControlLockedUntil).toBe(0);
  });

  it('a hit on ANOTHER avatar never touches the self lock', () => {
    useActivityStore.getState().applyServerFrame(
      hitFrame({ dstAvatarId: 'someone-else', spinoutDurationMs: 900 }) as never,
    );
    expect(useActivityStore.getState().selfObstacleControlLockedUntil).toBe(0);
  });

  it('a later obstacle BUMP preserves a live item-spinout lock (round-2 blocker)', () => {
    useActivityStore.getState().applyServerFrame(
      hitFrame({ spinoutDurationMs: 1_900 }) as never,
    );
    const locked = useActivityStore.getState().selfObstacleControlLockedUntil;
    expect(locked).toBeGreaterThan(0);
    useActivityStore.getState().applyServerFrame(
      obstacleFrame('bump', 0) as never,
    );
    expect(useActivityStore.getState().selfObstacleControlLockedUntil).toBe(locked);
  });

  it('overlapping spinouts keep the LATEST deadline in either order', () => {
    // Long item spinout, then a shorter obstacle spinout: keeps the long one.
    useActivityStore.getState().applyServerFrame(
      hitFrame({ spinoutDurationMs: 5_000 }) as never,
    );
    const longLock = useActivityStore.getState().selfObstacleControlLockedUntil;
    useActivityStore.getState().applyServerFrame(
      obstacleFrame('spinout', 900) as never,
    );
    expect(
      useActivityStore.getState().selfObstacleControlLockedUntil,
    ).toBeGreaterThanOrEqual(longLock);

    // Short item hit while a longer obstacle lock is live: never shortens.
    useActivityStore.setState({ selfObstacleControlLockedUntil: 0 });
    useActivityStore.getState().applyServerFrame(
      obstacleFrame('spinout', 5_000) as never,
    );
    const obstacleLock =
      useActivityStore.getState().selfObstacleControlLockedUntil;
    useActivityStore.getState().applyServerFrame(
      hitFrame({ spinoutDurationMs: 100 }) as never,
    );
    expect(
      useActivityStore.getState().selfObstacleControlLockedUntil,
    ).toBeGreaterThanOrEqual(obstacleLock);
  });
});
