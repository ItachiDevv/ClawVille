/**
 * Multiplayer Phase 1 — RoomRegistry unit tests.
 *
 * Every case wires an injected clock so we can advance time without
 * touching `setTimeout` / `Date.now()`. Tests are deterministic and
 * don't need real sleep.
 *
 * Coverage matrix (from the team spec):
 *   - NPC swap: species-match priority, fallback to lex-first NPC, no swap
 *     when room.npcs is empty.
 *   - Room overflow: 21st player → fresh room.
 *   - Invite-code join: existing room with capacity, capacity full fallback,
 *     never-before-seen code mints the requested ID.
 *   - Leave + 5 s restore.
 *   - Stale-player GC at 30 s no position update.
 *   - Empty-room GC at 5 min.
 */

import { describe, expect, it } from 'bun:test';
import {
  RoomRegistry,
  ROOM_MAX_PLAYERS,
  RESTORE_GRACE_MS,
  STALE_PLAYER_MS,
  EMPTY_ROOM_MS,
  FREE_ROAMER_NPC_IDS,
  type JoinAvatarMeta,
} from '../room-registry';
import { NPC_DEFINITIONS } from '@clawville/shared';

function makeClock(initial = 1_700_000_000_000) {
  const state = { now: initial };
  return {
    now: () => state.now,
    advance(ms: number) {
      state.now += ms;
    },
    set(ms: number) {
      state.now = ms;
    },
  };
}

function makeAvatar(over: Partial<JoinAvatarMeta> = {}): JoinAvatarMeta {
  return {
    userId: null,
    name: 'Tester',
    species: 'milady_official_1',
    color: 0xff00ff,
    x: 5760,
    y: 5760,
    ...over,
  };
}

/**
 * Deterministic 4-char ID generator for tests. Cycles through a small
 * alphabet so collision handling is exercised when needed.
 */
function makeRegistry(opts?: { clock?: ReturnType<typeof makeClock>; idAlphabet?: string }) {
  const clock = opts?.clock ?? makeClock();
  const alphabet = opts?.idAlphabet ?? 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let i = 0;
  const randomChar = () => {
    const c = alphabet[i % alphabet.length]!;
    i++;
    return c;
  };
  const registry = new RoomRegistry({ now: clock.now, randomChar });
  return { registry, clock };
}

describe('RoomRegistry — NPC swap', () => {
  it('removes a species-matching NPC when one exists', () => {
    const { registry } = makeRegistry();
    // 'milady-aria' has species 'milady_official_1' per npc-definitions.ts.
    const { room, swappedOutNpcId } = registry.joinPlayer(
      's1',
      makeAvatar({ species: 'milady_official_1' }),
    );
    expect(swappedOutNpcId).toBe('milady-aria');
    expect(room.npcs.has('milady-aria')).toBe(false);
    expect(room.removedNpcs.has('milady-aria')).toBe(true);
  });

  it('falls back to lex-first NPC when no species match', () => {
    const { registry } = makeRegistry();
    const { swappedOutNpcId } = registry.joinPlayer(
      's1',
      makeAvatar({ species: 'no_such_species' }),
    );
    expect(swappedOutNpcId).not.toBeNull();
    // The fallback path lex-sorts; verify it pulled one of the actual
    // free-roamer NPC IDs.
    expect(FREE_ROAMER_NPC_IDS.has(swappedOutNpcId!)).toBe(true);
  });

  it('returns null when room.npcs is already exhausted', () => {
    const { registry } = makeRegistry();
    // Drain the room: a fresh room starts with FREE_ROAMER_NPC_IDS.size
    // NPCs (currently 14). Fill it by joining that many sessions.
    const npcCount = FREE_ROAMER_NPC_IDS.size;
    let roomId = '';
    for (let i = 0; i < npcCount; i++) {
      const r = registry.joinPlayer(`s${i}`, makeAvatar({ species: 'no_such_species' }), roomId || undefined);
      roomId = r.room.id;
    }
    // The (npcCount+1)th joiner — still within 20-player cap — gets no swap.
    expect(npcCount).toBeLessThan(ROOM_MAX_PLAYERS);
    const overflow = registry.joinPlayer(
      `s-extra`,
      makeAvatar({ species: 'no_such_species' }),
      roomId,
    );
    expect(overflow.swappedOutNpcId).toBeNull();
    expect(overflow.room.id).toBe(roomId);
    expect(overflow.room.players.size).toBe(npcCount + 1);
  });

  it('a rejoining session does NOT re-swap (idempotent)', () => {
    const { registry } = makeRegistry();
    const first = registry.joinPlayer('s1', makeAvatar({ species: 'milady_official_1' }));
    expect(first.swappedOutNpcId).toBe('milady-aria');
    const second = registry.joinPlayer('s1', makeAvatar({ species: 'milady_official_1' }));
    expect(second.swappedOutNpcId).toBeNull();
    expect(second.room.id).toBe(first.room.id);
    expect(second.room.players.size).toBe(1);
  });
});

describe('RoomRegistry — overflow + invite codes', () => {
  it('21st player spills into a fresh room', () => {
    const { registry } = makeRegistry();
    let firstRoomId = '';
    for (let i = 0; i < ROOM_MAX_PLAYERS; i++) {
      const r = registry.joinPlayer(`s${i}`, makeAvatar({ species: 'no_such_species' }));
      if (!firstRoomId) firstRoomId = r.room.id;
      expect(r.room.id).toBe(firstRoomId);
    }
    // Cap hit — the 21st joiner spills.
    const spill = registry.joinPlayer(`overflow`, makeAvatar({ species: 'no_such_species' }));
    expect(spill.room.id).not.toBe(firstRoomId);
    expect(registry.listRooms().length).toBe(2);
  });

  it('honors an invite code when the room exists and has capacity', () => {
    const { registry } = makeRegistry();
    const seed = registry.joinPlayer('host', makeAvatar({ species: 'no_such_species' }));
    const code = seed.room.id;
    const guest = registry.joinPlayer('guest', makeAvatar({ species: 'no_such_species' }), code);
    expect(guest.room.id).toBe(code);
    expect(guest.room.players.size).toBe(2);
  });

  it('mints the requested code when the room doesn\'t exist yet', () => {
    const { registry } = makeRegistry();
    const r = registry.joinPlayer('host', makeAvatar({ species: 'no_such_species' }), 'XYZW');
    expect(r.room.id).toBe('XYZW');
  });

  it('falls back to auto-fill when the requested room is full', () => {
    const { registry } = makeRegistry();
    // Fill an explicit invite code.
    for (let i = 0; i < ROOM_MAX_PLAYERS; i++) {
      registry.joinPlayer(`s${i}`, makeAvatar({ species: 'no_such_species' }), 'AAAA');
    }
    const overflow = registry.joinPlayer(
      'late',
      makeAvatar({ species: 'no_such_species' }),
      'AAAA',
    );
    expect(overflow.room.id).not.toBe('AAAA');
    expect(overflow.room.players.size).toBe(1);
  });
});

describe('RoomRegistry — leave + restore', () => {
  it('schedules an NPC restore exactly RESTORE_GRACE_MS after leave', () => {
    const { registry, clock } = makeRegistry();
    const join = registry.joinPlayer('s1', makeAvatar({ species: 'milady_official_1' }));
    expect(join.swappedOutNpcId).toBe('milady-aria');
    const roomId = join.room.id;

    clock.advance(1_000);
    const leave = registry.leavePlayer('s1');
    expect(leave?.pendingRestoreNpcId).toBe('milady-aria');
    // Still within grace window — tick must NOT restore yet.
    clock.advance(RESTORE_GRACE_MS - 1);
    let tick = registry.tick();
    expect(tick.restoredNpcs.length).toBe(0);
    expect(registry.getRoom(roomId)?.npcs.has('milady-aria')).toBe(false);

    // Cross the grace boundary.
    clock.advance(2);
    tick = registry.tick();
    expect(tick.restoredNpcs).toEqual([{ roomId, npcId: 'milady-aria' }]);
    expect(registry.getRoom(roomId)?.npcs.has('milady-aria')).toBe(true);
  });

  it('does NOT restore while the swap-owning player is still in the room', () => {
    const { registry, clock } = makeRegistry();
    const join = registry.joinPlayer('s1', makeAvatar({ species: 'milady_official_1' }));
    // Advance well past the grace timer without ever calling leavePlayer.
    clock.advance(RESTORE_GRACE_MS + 1000);
    const tick = registry.tick();
    expect(tick.restoredNpcs.length).toBe(0);
    expect(join.room.npcs.has('milady-aria')).toBe(false);
  });
});

describe('RoomRegistry — GC', () => {
  it('kicks players idle for more than STALE_PLAYER_MS', () => {
    const { registry, clock } = makeRegistry();
    const join = registry.joinPlayer('s1', makeAvatar({ species: 'no_such_species' }));
    const roomId = join.room.id;
    clock.advance(STALE_PLAYER_MS + 1);
    const tick = registry.tick();
    expect(tick.staleSessionsRemoved).toEqual(['s1']);
    expect(registry.getRoom(roomId)?.players.size).toBe(0);
    expect(registry.getRoomForSession('s1')).toBeNull();
  });

  it('refreshes lastPositionUpdateAt on updatePosition so an active player is NOT kicked', () => {
    const { registry, clock } = makeRegistry();
    registry.joinPlayer('s1', makeAvatar({ species: 'no_such_species' }));
    clock.advance(STALE_PLAYER_MS - 100);
    const ok = registry.updatePosition('s1', { x: 1, y: 2, dirZ: 0.5, activity: 'walking' });
    expect(ok).not.toBeNull();
    clock.advance(200);
    const tick = registry.tick();
    expect(tick.staleSessionsRemoved.length).toBe(0);
  });

  it('GCs an empty room after EMPTY_ROOM_MS', () => {
    const { registry, clock } = makeRegistry();
    const join = registry.joinPlayer('s1', makeAvatar({ species: 'no_such_species' }));
    const roomId = join.room.id;
    registry.leavePlayer('s1');
    // Within window — keep it.
    clock.advance(EMPTY_ROOM_MS - 100);
    registry.tick();
    expect(registry.getRoom(roomId)).not.toBeNull();
    // Cross the window.
    clock.advance(200);
    const tick = registry.tick();
    expect(tick.removedRoomIds).toContain(roomId);
    expect(registry.getRoom(roomId)).toBeNull();
  });
});

describe('RoomRegistry — concurrency invariants', () => {
  it('two joiners with the same species must swap two different NPCs', () => {
    const { registry } = makeRegistry();
    const a = registry.joinPlayer('sA', makeAvatar({ species: 'milady_official_1' }));
    const b = registry.joinPlayer('sB', makeAvatar({ species: 'milady_official_1' }));
    expect(a.swappedOutNpcId).not.toBeNull();
    expect(b.swappedOutNpcId).not.toBeNull();
    expect(a.swappedOutNpcId).not.toBe(b.swappedOutNpcId);
    expect(a.room.id).toBe(b.room.id);
  });

  it('FREE_ROAMER_NPC_IDS matches the source NPC_DEFINITIONS roster', () => {
    const expected = new Set(
      NPC_DEFINITIONS.filter((d) => d.buildingId === '').map((d) => d.id),
    );
    expect(FREE_ROAMER_NPC_IDS.size).toBe(expected.size);
    for (const id of expected) {
      expect(FREE_ROAMER_NPC_IDS.has(id)).toBe(true);
    }
  });
});
