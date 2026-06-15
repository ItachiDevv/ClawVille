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
 *   - Soft-cap flexible fill: auto-fill packs into the fullest room under the
 *     soft cap of 12 (deterministic lowest-id tie-break), the 13th auto-join
 *     mints a fresh room, auto-fill never seeds the 12-to-20 invite headroom
 *     band, an invite code STILL fills that band up to the hard cap of 20, an
 *     invite into a room at 20 is rejected, and 29 sequential auto-joins
 *     distribute 12 / 12 / 5.
 *   - Hard-cap overflow: an invite-filled room at 20 spills the 21st joiner
 *     to a fresh room (auto-fill alone no longer reaches 20).
 *   - Invite-code join: existing room with capacity, capacity full fallback,
 *     never-before-seen code mints the requested ID (authenticated only — B2).
 *   - Leave + 5 s restore.
 *   - Stale-player GC at 30 s no position update.
 *   - Empty-room GC at 5 min.
 */

import { describe, expect, it } from 'bun:test';
import {
  RoomRegistry,
  ROOM_MAX_PLAYERS,
  ROOM_SOFT_CAP_PLAYERS,
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
  it('21st invite join is rejected at the hard cap and spills to a fresh room', () => {
    const { registry } = makeRegistry();
    // Fill one room to the HARD cap via an invite code (auto-fill alone would
    // stop at the soft cap of 12 — see the soft-cap suite below). Auth'd so the
    // first call can mint the requested ID.
    for (let i = 0; i < ROOM_MAX_PLAYERS; i++) {
      const r = registry.joinPlayer(`s${i}`, makeAvatar({ species: 'no_such_species' }), {
        requestedRoomId: 'FULL',
        isAuthenticated: true,
      });
      expect(r.room.id).toBe('FULL');
    }
    expect(registry.getRoom('FULL')?.players.size).toBe(ROOM_MAX_PLAYERS);
    // Hard cap hit — the 21st invite join cannot enter 'FULL' and spills.
    const spill = registry.joinPlayer(`overflow`, makeAvatar({ species: 'no_such_species' }), {
      requestedRoomId: 'FULL',
      isAuthenticated: true,
    });
    expect(spill.room.id).not.toBe('FULL');
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

  it('mints the requested code when the room doesn\'t exist yet (auth\'d only — see B2)', () => {
    const { registry } = makeRegistry();
    const r = registry.joinPlayer('host', makeAvatar({ species: 'no_such_species' }), {
      requestedRoomId: 'XYZW',
      isAuthenticated: true,
    });
    expect(r.room.id).toBe('XYZW');
  });

  it('falls back to auto-fill when the requested room is full', () => {
    const { registry } = makeRegistry();
    // Fill an explicit invite code as an auth'd host so the mint goes
    // through (B2 — only authenticated callers can mint a never-before-
    // seen invite ID). The remaining 19 fillers can be guests joining the
    // now-existing room.
    for (let i = 0; i < ROOM_MAX_PLAYERS; i++) {
      registry.joinPlayer(`s${i}`, makeAvatar({ species: 'no_such_species' }), {
        requestedRoomId: 'AAAA',
        isAuthenticated: true,
      });
    }
    const overflow = registry.joinPlayer('late', makeAvatar({ species: 'no_such_species' }), {
      requestedRoomId: 'AAAA',
      isAuthenticated: true,
    });
    expect(overflow.room.id).not.toBe('AAAA');
    expect(overflow.room.players.size).toBe(1);
  });
});

describe('RoomRegistry — soft-cap flexible fill', () => {
  it('auto-fill packs into the FULLEST room still under the soft cap', () => {
    const { registry } = makeRegistry();
    // Seed two rooms with explicit invite codes so we control their sizes:
    //   room AAAA → 5 players, room BBBB → 3 players (both under soft cap 12).
    for (let i = 0; i < 5; i++) {
      registry.joinPlayer(`a${i}`, makeAvatar({ species: 'no_such_species' }), {
        requestedRoomId: 'AAAA',
        isAuthenticated: true,
      });
    }
    for (let i = 0; i < 3; i++) {
      registry.joinPlayer(`b${i}`, makeAvatar({ species: 'no_such_species' }), {
        requestedRoomId: 'BBBB',
        isAuthenticated: true,
      });
    }
    // A fresh auto-fill joiner (no invite code) should pick AAAA — the fullest
    // room still under the soft cap — NOT the emptier BBBB and NOT a new room.
    const join = registry.joinPlayer('auto', makeAvatar({ species: 'no_such_species' }));
    expect(join.room.id).toBe('AAAA');
    expect(join.room.players.size).toBe(6);
  });

  it('tie-breaks on lowest id when two rooms are equally full', () => {
    const { registry } = makeRegistry();
    // Two rooms each with 4 players, ids AAAA and BBBB.
    for (const code of ['BBBB', 'AAAA']) {
      for (let i = 0; i < 4; i++) {
        registry.joinPlayer(`${code}-${i}`, makeAvatar({ species: 'no_such_species' }), {
          requestedRoomId: code,
          isAuthenticated: true,
        });
      }
    }
    // Tie at size 4 → deterministic lowest-id pick = AAAA.
    const join = registry.joinPlayer('auto', makeAvatar({ species: 'no_such_species' }));
    expect(join.room.id).toBe('AAAA');
  });

  it('the 13th auto-join mints a fresh room (soft boundary)', () => {
    const { registry } = makeRegistry();
    // 12 sequential auto-joins all pack into ONE room (each lands in the
    // fullest-under-soft room, which is the same growing room).
    let firstRoomId = '';
    for (let i = 0; i < ROOM_SOFT_CAP_PLAYERS; i++) {
      const r = registry.joinPlayer(`s${i}`, makeAvatar({ species: 'no_such_species' }));
      if (!firstRoomId) firstRoomId = r.room.id;
      expect(r.room.id).toBe(firstRoomId);
    }
    expect(registry.getRoom(firstRoomId)?.players.size).toBe(ROOM_SOFT_CAP_PLAYERS);
    // Room is now AT the soft cap (12). The 13th auto-joiner must mint room B —
    // auto-fill refuses to seed the 12-to-20 invite headroom band.
    const thirteenth = registry.joinPlayer('s13', makeAvatar({ species: 'no_such_species' }));
    expect(thirteenth.room.id).not.toBe(firstRoomId);
    expect(registry.listRooms().length).toBe(2);
    expect(registry.getRoom(firstRoomId)?.players.size).toBe(ROOM_SOFT_CAP_PLAYERS);
  });

  it('auto-fill never seeds a room already in the 12-to-20 headroom band', () => {
    const { registry } = makeRegistry();
    // Push room AAAA into the headroom band (15 players) via invite codes.
    for (let i = 0; i < 15; i++) {
      registry.joinPlayer(`a${i}`, makeAvatar({ species: 'no_such_species' }), {
        requestedRoomId: 'AAAA',
        isAuthenticated: true,
      });
    }
    expect(registry.getRoom('AAAA')?.players.size).toBe(15);
    // An auto-fill joiner must NOT land in AAAA (it is past the soft cap); it
    // mints a fresh room instead.
    const join = registry.joinPlayer('auto', makeAvatar({ species: 'no_such_species' }));
    expect(join.room.id).not.toBe('AAAA');
    expect(registry.getRoom('AAAA')?.players.size).toBe(15);
  });

  it('an invite code STILL fills the 12-to-20 headroom band (friend group join)', () => {
    const { registry } = makeRegistry();
    // Fill AAAA to the soft cap (12) — auto-fill would stop here.
    for (let i = 0; i < ROOM_SOFT_CAP_PLAYERS; i++) {
      registry.joinPlayer(`a${i}`, makeAvatar({ species: 'no_such_species' }), {
        requestedRoomId: 'AAAA',
        isAuthenticated: true,
      });
    }
    // A friend with the AAAA invite code joins the headroom band (13th seat).
    const friend = registry.joinPlayer('friend', makeAvatar({ species: 'no_such_species' }), {
      requestedRoomId: 'AAAA',
      isAuthenticated: true,
    });
    expect(friend.room.id).toBe('AAAA');
    expect(friend.room.players.size).toBe(ROOM_SOFT_CAP_PLAYERS + 1);
  });

  it('an invite code into a room AT the hard cap (20) is rejected and spills', () => {
    const { registry } = makeRegistry();
    for (let i = 0; i < ROOM_MAX_PLAYERS; i++) {
      registry.joinPlayer(`a${i}`, makeAvatar({ species: 'no_such_species' }), {
        requestedRoomId: 'AAAA',
        isAuthenticated: true,
      });
    }
    expect(registry.getRoom('AAAA')?.players.size).toBe(ROOM_MAX_PLAYERS);
    const late = registry.joinPlayer('late', makeAvatar({ species: 'no_such_species' }), {
      requestedRoomId: 'AAAA',
      isAuthenticated: true,
    });
    expect(late.room.id).not.toBe('AAAA');
    expect(registry.getRoom('AAAA')?.players.size).toBe(ROOM_MAX_PLAYERS);
  });

  it('distribution: 29 sequential auto-joins settle into 12 / 12 / 5', () => {
    const { registry } = makeRegistry();
    for (let i = 0; i < 29; i++) {
      registry.joinPlayer(`s${i}`, makeAvatar({ species: 'no_such_species' }));
    }
    const sizes = registry
      .listRooms()
      .map((r) => r.players.size)
      .sort((a, b) => b - a);
    expect(sizes).toEqual([12, 12, 5]);
    // The 29th joiner specifically lands in the 5-room (the only room still
    // under the soft cap, hence the fullest-under-soft pick).
    const last = registry.getRoomForSession('s28');
    expect(last?.players.size).toBe(5);
  });
});

describe('RoomRegistry — rejoin cancels pending restore (B1 punch list)', () => {
  it('a fast rejoin within the grace window restores the original NPC and does NOT permanently lose a slot', () => {
    const { registry, clock } = makeRegistry();
    const join1 = registry.joinPlayer('s1', makeAvatar({ species: 'milady_official_1' }));
    expect(join1.swappedOutNpcId).toBe('milady-aria');
    const roomId = join1.room.id;

    // Player leaves.
    clock.advance(1_000);
    const leave = registry.leavePlayer('s1');
    expect(leave?.pendingRestoreNpcId).toBe('milady-aria');

    // Player rage-rejoins 2 s later — well inside the 5 s grace window.
    clock.advance(2_000);
    const join2 = registry.joinPlayer('s1', makeAvatar({ species: 'milady_official_1' }), roomId);
    // The rejoin should:
    //   (a) reseat milady-aria (cancel the pending restore)
    //   (b) THEN run the species-match swap, picking milady-aria again
    // Net result: room.npcs still has 13 wanderers (one slot for the
    // player), removedNpcs has milady-aria swapped on the new session.
    expect(join2.room.id).toBe(roomId);
    expect(join2.swappedOutNpcId).toBe('milady-aria');
    expect(join2.room.removedNpcs.size).toBe(1);
    expect(join2.room.npcs.size).toBe(FREE_ROAMER_NPC_IDS.size - 1);

    // Advance past the original grace window — tick must NOT restore
    // because the player is back in the room.
    clock.advance(RESTORE_GRACE_MS + 1_000);
    const tick = registry.tick();
    expect(tick.restoredNpcs.length).toBe(0);
    expect(registry.getRoom(roomId)?.npcs.has('milady-aria')).toBe(false);

    // When the player finally leaves for good and the grace elapses,
    // milady-aria reappears exactly once.
    registry.leavePlayer('s1');
    clock.advance(RESTORE_GRACE_MS + 100);
    const finalTick = registry.tick();
    expect(finalTick.restoredNpcs).toEqual([{ roomId, npcId: 'milady-aria' }]);
    expect(registry.getRoom(roomId)?.npcs.size).toBe(FREE_ROAMER_NPC_IDS.size);
  });

  it('regression: three rage-rejoin cycles leak ZERO NPC slots (without B1 fix each cycle leaked one)', () => {
    const { registry, clock } = makeRegistry();
    const SPECIES = 'no_such_species'; // forces lex-first fallback every time
    registry.joinPlayer('s1', makeAvatar({ species: SPECIES }));
    for (let i = 0; i < 3; i++) {
      clock.advance(500);
      registry.leavePlayer('s1');
      clock.advance(500);
      registry.joinPlayer('s1', makeAvatar({ species: SPECIES }));
    }
    const rooms = registry.listRooms();
    expect(rooms.length).toBe(1);
    expect(rooms[0]!.removedNpcs.size).toBe(1);
    expect(rooms[0]!.npcs.size).toBe(FREE_ROAMER_NPC_IDS.size - 1);
  });
});

describe('RoomRegistry — sticky-room recovery (2026-06-12)', () => {
  it('recreates the named room after a restart and re-lands the session there', () => {
    // Simulate a deploy/restart: the original registry placed s1 in a room,
    // then a FRESH registry (in-memory state wiped) gets a recovery rejoin
    // carrying that roomId. The room must be recreated with the SAME id.
    const { registry: r1 } = makeRegistry();
    const join1 = r1.joinPlayer('s1', makeAvatar({ species: 'no_such_species' }));
    const originalRoomId = join1.room.id;

    // Restart → brand-new registry, no rooms.
    const { registry: r2 } = makeRegistry();
    expect(r2.getRoom(originalRoomId)).toBeNull();
    const rejoin = r2.joinPlayer('s1', makeAvatar({ species: 'no_such_species' }), {
      recoveryRoomId: originalRoomId,
    });
    expect(rejoin.room.id).toBe(originalRoomId);
    expect(r2.getRoom(originalRoomId)?.players.has('s1')).toBe(true);
  });

  it('re-converges a group of three into the same recreated room', () => {
    // Three friends were together in room G before the restart; each recovers
    // with the same recoveryRoomId and must land back together.
    const { registry: r1 } = makeRegistry();
    const seed = r1.joinPlayer('host', makeAvatar({ species: 'no_such_species' }), {
      requestedRoomId: 'GRPA',
      isAuthenticated: true,
    });
    const groupRoomId = seed.room.id;
    expect(groupRoomId).toBe('GRPA');

    const { registry: r2 } = makeRegistry();
    for (const sid of ['host', 'pal1', 'pal2']) {
      r2.joinPlayer(sid, makeAvatar({ species: 'no_such_species' }), {
        recoveryRoomId: groupRoomId,
      });
    }
    const room = r2.getRoom(groupRoomId);
    expect(room?.players.size).toBe(3);
    expect(r2.listRooms().length).toBe(1);
  });

  it('recovery works for GUESTS (no auth) — the ticket, not auth, is the proof', () => {
    // A guest recovery rejoin into a non-existent room recreates it. This is
    // the deliberate difference from requestedRoomId, which drops a guest's
    // unknown code to auto-fill (B2). The route only sets recoveryRoomId after
    // verifying a publicId-bound ticket, so this can't be abused.
    const { registry } = makeRegistry();
    const rejoin = registry.joinPlayer('guest1', makeAvatar({ species: 'no_such_species' }), {
      recoveryRoomId: 'GST1',
      isAuthenticated: false,
    });
    expect(rejoin.room.id).toBe('GST1');
  });

  it('recovery into an existing room with capacity lands there (re-converge survivors)', () => {
    const { registry } = makeRegistry();
    // Room AAAA survived with 3 players still in it.
    for (let i = 0; i < 3; i++) {
      registry.joinPlayer(`survivor${i}`, makeAvatar({ species: 'no_such_species' }), {
        requestedRoomId: 'AAAA',
        isAuthenticated: true,
      });
    }
    const rejoin = registry.joinPlayer('reconnect', makeAvatar({ species: 'no_such_species' }), {
      recoveryRoomId: 'AAAA',
    });
    expect(rejoin.room.id).toBe('AAAA');
    expect(registry.getRoom('AAAA')?.players.size).toBe(4);
  });

  it('recovery may exceed the SOFT cap (the whole point — reconverge up to 20)', () => {
    const { registry } = makeRegistry();
    // Fill AAAA to the soft cap (12) with survivors.
    for (let i = 0; i < ROOM_SOFT_CAP_PLAYERS; i++) {
      registry.joinPlayer(`s${i}`, makeAvatar({ species: 'no_such_species' }), {
        requestedRoomId: 'AAAA',
        isAuthenticated: true,
      });
    }
    expect(registry.getRoom('AAAA')?.players.size).toBe(ROOM_SOFT_CAP_PLAYERS);
    // A 13th member recovers into AAAA — past the soft cap but within the hard
    // cap. Recovery bypasses the soft cap (auto-fill would have minted a new
    // room here).
    const rejoin = registry.joinPlayer('late', makeAvatar({ species: 'no_such_species' }), {
      recoveryRoomId: 'AAAA',
    });
    expect(rejoin.room.id).toBe('AAAA');
    expect(registry.getRoom('AAAA')?.players.size).toBe(ROOM_SOFT_CAP_PLAYERS + 1);
  });

  it('recovery into a room at the HARD cap (20) spills to auto-fill, never breaching 20', () => {
    const { registry } = makeRegistry();
    for (let i = 0; i < ROOM_MAX_PLAYERS; i++) {
      registry.joinPlayer(`s${i}`, makeAvatar({ species: 'no_such_species' }), {
        requestedRoomId: 'AAAA',
        isAuthenticated: true,
      });
    }
    expect(registry.getRoom('AAAA')?.players.size).toBe(ROOM_MAX_PLAYERS);
    const spill = registry.joinPlayer('overflow', makeAvatar({ species: 'no_such_species' }), {
      recoveryRoomId: 'AAAA',
    });
    expect(spill.room.id).not.toBe('AAAA');
    expect(registry.getRoom('AAAA')?.players.size).toBe(ROOM_MAX_PLAYERS);
    expect(registry.listRooms().length).toBe(2);
  });

  it('recoveryRoomId takes precedence over requestedRoomId when both are present', () => {
    const { registry } = makeRegistry();
    const rejoin = registry.joinPlayer('s1', makeAvatar({ species: 'no_such_species' }), {
      recoveryRoomId: 'RECV',
      requestedRoomId: 'REQQ',
      isAuthenticated: true,
    });
    expect(rejoin.room.id).toBe('RECV');
    expect(registry.getRoom('REQQ')).toBeNull();
  });

  it('an already-seated session ignores recoveryRoomId (idempotent refresh wins)', () => {
    // If the session is somehow still mapped to a room, a recovery rejoin must
    // not yank it elsewhere — the in-place refresh path runs first.
    const { registry } = makeRegistry();
    const first = registry.joinPlayer('s1', makeAvatar({ species: 'no_such_species' }));
    const seatedRoomId = first.room.id;
    const rejoin = registry.joinPlayer('s1', makeAvatar({ species: 'no_such_species' }), {
      recoveryRoomId: 'ELSE',
    });
    expect(rejoin.room.id).toBe(seatedRoomId);
    expect(rejoin.swappedOutNpcId).toBeNull();
    expect(registry.getRoom('ELSE')).toBeNull();
  });
});

describe('RoomRegistry — guests cannot mint invite IDs (B2 punch list)', () => {
  it('an unauthenticated caller requesting an unknown 4-char ID falls through to auto-fill', () => {
    const { registry } = makeRegistry();
    const r = registry.joinPlayer('guest1', makeAvatar({ species: 'no_such_species' }), {
      requestedRoomId: 'WXYZ',
      isAuthenticated: false,
    });
    // Guest did NOT mint WXYZ — they landed in an auto-filled room with
    // a server-generated ID (NOT 'WXYZ').
    expect(r.room.id).not.toBe('WXYZ');
    expect(registry.getRoom('WXYZ')).toBeNull();
  });

  it('an authenticated caller CAN mint a never-before-seen ID (back-compat with the deeplink-host flow)', () => {
    const { registry } = makeRegistry();
    const r = registry.joinPlayer('user1', makeAvatar({ species: 'no_such_species' }), {
      requestedRoomId: 'WXYZ',
      isAuthenticated: true,
    });
    expect(r.room.id).toBe('WXYZ');
  });

  it('a guest joining an EXISTING valid invite code still lands in that room', () => {
    const { registry } = makeRegistry();
    const host = registry.joinPlayer('user1', makeAvatar({ species: 'no_such_species' }), {
      requestedRoomId: 'JOIN',
      isAuthenticated: true,
    });
    const guest = registry.joinPlayer('guest1', makeAvatar({ species: 'no_such_species' }), {
      requestedRoomId: 'JOIN',
      isAuthenticated: false,
    });
    expect(guest.room.id).toBe(host.room.id);
  });

  it('legacy plain-string requestedRoomId still works (back-compat — treated as un-authed)', () => {
    const { registry } = makeRegistry();
    // Legacy call signature passed a string. Should be treated as a
    // guest (un-auth'd) request for safety.
    const r = registry.joinPlayer('s1', makeAvatar({ species: 'no_such_species' }), 'NEWW');
    expect(r.room.id).not.toBe('NEWW');
  });
});

describe('RoomRegistry — tick subscriber fanout (B3 punch list)', () => {
  it('subscribers receive the kicked-session list — used by world.ts to purge positionLastSeen', () => {
    const { registry, clock } = makeRegistry();
    const fakeThrottle = new Map<string, number>();
    fakeThrottle.set('s1', 123);
    registry.subscribeTick((result) => {
      for (const sid of result.staleSessionsRemoved) fakeThrottle.delete(sid);
    });

    registry.joinPlayer('s1', makeAvatar({ species: 'no_such_species' }));
    clock.advance(STALE_PLAYER_MS + 1);
    registry.tick();
    expect(fakeThrottle.has('s1')).toBe(false);
  });

  it('subscribe returns an unsubscribe handle', () => {
    const { registry } = makeRegistry();
    let calls = 0;
    const unsub = registry.subscribeTick(() => { calls++; });
    registry.tick();
    expect(calls).toBe(1);
    unsub();
    registry.tick();
    expect(calls).toBe(1);
  });

  it('a throwing subscriber does NOT abort the tick or other subscribers', () => {
    const { registry } = makeRegistry();
    let goodCalls = 0;
    registry.subscribeTick(() => { throw new Error('boom'); });
    registry.subscribeTick(() => { goodCalls++; });
    expect(() => registry.tick()).not.toThrow();
    expect(goodCalls).toBe(1);
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
