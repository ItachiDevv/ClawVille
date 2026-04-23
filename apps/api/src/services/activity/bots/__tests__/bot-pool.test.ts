/**
 * Bot pool reservation tests (chunk #10).
 *
 * Mocks @clawville/database so the pool can be exercised without a real
 * Supabase connection. Validates per-room uniqueness, recycle-across-
 * rooms, and the rebind helper used by the matcher to swap the
 * placeholder room id for the actual one once createRoom succeeds.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

mock.module('@clawville/database', () => ({
  db: {},
  avatars: {},
  users: {},
}));

const { botPool } = await import('../bot-pool');

beforeEach(() => {
  // Pre-load 4 fake slots so we don't hit the (mocked) DB.
  botPool.__resetForTest([
    { index: 1, slotId: 'bot-001', avatarId: 'uuid-1' },
    { index: 2, slotId: 'bot-002', avatarId: 'uuid-2' },
    { index: 3, slotId: 'bot-003', avatarId: 'uuid-3' },
    { index: 4, slotId: 'bot-004', avatarId: 'uuid-4' },
  ]);
});

describe('botPool.reserve', () => {
  it('returns N distinct avatarIds bound to the room', () => {
    const got = botPool.reserve('room-A', 3);
    expect(got).toHaveLength(3);
    expect(new Set(got).size).toBe(3);
    expect(botPool.inUseCount()).toBe(3);
  });

  it('returns empty when not enough free slots are available', () => {
    botPool.reserve('room-A', 3);
    const got = botPool.reserve('room-B', 2); // only 1 free
    expect(got).toEqual([]);
    expect(botPool.inUseCount()).toBe(3);
  });

  it('respects per-room uniqueness — the same avatarId is never double-reserved', () => {
    const a = botPool.reserve('room-A', 2);
    const b = botPool.reserve('room-B', 2);
    const intersection = a.filter((id) => b.includes(id));
    expect(intersection).toHaveLength(0);
  });

  it('recycles slots after the room releases', () => {
    const first = botPool.reserve('room-A', 4);
    expect(first).toHaveLength(4);
    expect(botPool.reserve('room-B', 1)).toEqual([]);
    botPool.releaseRoom('room-A');
    expect(botPool.inUseCount()).toBe(0);
    const second = botPool.reserve('room-B', 4);
    expect(second).toHaveLength(4);
  });
});

describe('botPool.rebindReservation', () => {
  it('swaps the binding from one room id to another atomically', () => {
    const ids = botPool.reserve('pending-room', 2);
    expect(ids).toHaveLength(2);
    botPool.rebindReservation(ids, 'pending-room', 'real-room-id');
    // Releasing under the OLD id should be a no-op now.
    botPool.releaseRoom('pending-room');
    expect(botPool.inUseCount()).toBe(2);
    botPool.releaseRoom('real-room-id');
    expect(botPool.inUseCount()).toBe(0);
  });

  it('throws when the avatarId is not currently bound to fromRoomId', () => {
    const ids = botPool.reserve('room-A', 1);
    expect(() => botPool.rebindReservation(ids, 'pending-room', 'real-room')).toThrow();
  });
});

describe('botPool.isBot', () => {
  it('returns true for seeded avatarIds and false for arbitrary ones', () => {
    expect(botPool.isBot('uuid-1')).toBe(true);
    expect(botPool.isBot('uuid-99')).toBe(false);
  });
});
