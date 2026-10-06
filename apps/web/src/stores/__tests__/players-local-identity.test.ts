import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { usePlayerStore } from '../players';

// Founder R5 (2026-09-18): leaving a Reef Race left a copy of your own avatar
// trailing you. The downlink pause must drop other bodies, never who you are.

const body = (id: string, x: number) => ({
  id, kind: 'player', userId: 'u1', name: 'me', species: 'lobster', color: 0, activity: 'idle', x, y: 0, z: 0,
});

describe('players store keeps the local identity across a downlink pause', () => {
  beforeEach(() => usePlayerStore.getState().clear());

  test('clearRemote drops bodies but keeps localSessionId and former selves', () => {
    const s = usePlayerStore.getState();
    s.setLocalSessionId('me-0'); // a former self (earlier reconnect)
    s.setLocalSessionId('me-1');
    s.setRoomId('AB2C');
    s.updateFromSnapshot([body('me-1', 0) as never, body('other', 5) as never]);
    expect(usePlayerStore.getState().players.find((p) => p.id === 'me-1')?.isLocal).toBe(true);

    usePlayerStore.getState().clearRemote();
    const after = usePlayerStore.getState();
    expect(after.players).toEqual([]);
    expect(after.localSessionId).toBe('me-1');
    expect([...after.localSessionIds].sort()).toEqual(['me-0', 'me-1']);
    expect(after.roomId).toBe('AB2C');

    // The reopened stream's first snapshot: neither of our bodies renders as
    // remote; another player's body does.
    after.updateFromSnapshot([body('me-1', 3) as never, body('me-0', 3) as never, body('other', 9) as never]);
    const byId = new Map(usePlayerStore.getState().players.map((p) => [p.id, p.isLocal]));
    expect(byId.get('me-1')).toBe(true);
    expect(byId.get('me-0')).toBe(true);
    expect(byId.get('other')).toBe(false);
  });

  test('clear() is still the full reset used when the session ends', () => {
    const s = usePlayerStore.getState();
    s.setLocalSessionId('me-1');
    s.clear();
    expect(usePlayerStore.getState().localSessionId).toBeNull();
    expect(usePlayerStore.getState().localSessionIds.size).toBe(0);
  });
});

// web-load T3 (Codex E3 BLOCKER): a moving remote player made RemotePlayers
// commit on every 5 Hz snapshot (new object per move). Position-only snapshots
// now mutate in place (the NPC store pattern); identity changes only on a
// structural change (join, leave, reorder, or a field the render uses).

type Snap = {
  id: string; kind: 'human' | 'guest' | 'agent'; userId: string | null; name: string;
  species: string; color: number; activity: string; x: number; y: number; dirZ: number;
};
const snap = (id: string, x: number, over: Partial<Snap> = {}): Snap => ({
  id, kind: 'guest', userId: null, name: id, species: 'milady_official_5', color: 0xffffff,
  activity: 'walking', x, y: 100, dirZ: 0, ...over,
});

describe('players store: position-only snapshots keep identity (web-load T3)', () => {
  const realNow = Date.now;
  let now = 1_000_000;
  beforeEach(() => {
    usePlayerStore.getState().clear();
    now = 1_000_000;
    Date.now = () => now;
  });
  afterEach(() => {
    Date.now = realNow;
  });

  const ingest = (snaps: Snap[]) => usePlayerStore.getState().updateFromSnapshot(snaps as never);

  test('a position-only snapshot mutates the SAME objects in the SAME array and notifies nobody', () => {
    ingest([snap('a', 100), snap('b', 500)]);
    const arrayBefore = usePlayerStore.getState().players;
    const [a, b] = arrayBefore;
    let notified = 0;
    const unsub = usePlayerStore.subscribe(() => {
      notified += 1;
    });
    try {
      now += 200;
      ingest([snap('a', 130, { dirZ: 1.2 }), snap('b', 500)]);
      now += 200;
      ingest([snap('a', 160, { dirZ: 1.3, activity: 'running' }), snap('b', 520)]);
    } finally {
      unsub();
    }
    const after = usePlayerStore.getState().players;
    expect(after).toBe(arrayBefore);
    expect(after[0]).toBe(a);
    expect(after[1]).toBe(b);
    expect(notified).toBe(0);
    // The live fields the frame loop reads were written in place.
    expect({ x: a.x, prevX: a.prevX, ts: a.ts, tsDelta: a.tsDelta, dirZ: a.dirZ, activity: a.activity }).toEqual({
      x: 160, prevX: 130, ts: now, tsDelta: 200, dirZ: 1.3, activity: 'running',
    });
    expect({ x: b.x, prevX: b.prevX, ts: b.ts }).toEqual({ x: 520, prevX: 500, ts: now });
  });

  test('tsDelta is the receipt gap clamped to [120, 320] ms (same rule as the NPC store)', () => {
    ingest([snap('a', 100)]);
    const a = usePlayerStore.getState().players[0];
    expect(a.tsDelta).toBe(200); // first sight: nominal tick
    now += 5;
    ingest([snap('a', 110)]); // coalesced flush
    expect(a.tsDelta).toBe(120);
    now += 2_000;
    ingest([snap('a', 120)]); // stalled stream
    expect(a.tsDelta).toBe(320);
    now += 180;
    ingest([snap('a', 130)]);
    expect(a.tsDelta).toBe(180);
  });

  test('a still player keeps identity and its ts stays current (no stale tsDelta on the next move)', () => {
    ingest([snap('a', 100, { activity: 'idle' })]);
    const a = usePlayerStore.getState().players[0];
    for (let i = 0; i < 10; i += 1) {
      now += 200;
      ingest([snap('a', 100, { activity: 'idle' })]);
    }
    expect(usePlayerStore.getState().players[0]).toBe(a);
    expect(a.ts).toBe(now);
    expect({ x: a.x, prevX: a.prevX }).toEqual({ x: 100, prevX: 100 });
    now += 200;
    ingest([snap('a', 130)]);
    expect(a.tsDelta).toBe(200);
    expect({ x: a.x, prevX: a.prevX }).toEqual({ x: 130, prevX: 100 });
  });

  test('join and leave change the array but keep the untouched objects', () => {
    ingest([snap('a', 100)]);
    const first = usePlayerStore.getState().players;
    const a = first[0];
    now += 200;
    ingest([snap('a', 130), snap('b', 900)]);
    const joined = usePlayerStore.getState().players;
    expect(joined).not.toBe(first);
    expect(joined[0]).toBe(a);
    expect(joined[1].id).toBe('b');
    expect(a.x).toBe(130);
    now += 200;
    ingest([snap('b', 900)]);
    const left = usePlayerStore.getState().players;
    expect(left).not.toBe(joined);
    expect(left).toHaveLength(1);
    expect(left[0]).toBe(joined[1]);
  });

  test('each field the render uses is structural: new object, interpolation endpoints carried over', () => {
    const changes: Array<[string, Partial<Snap>]> = [
      ['name', { name: 'renamed' }],
      ['species', { species: 'hermes_female' }],
      ['color', { color: 0x123456 }],
      ['kind', { kind: 'agent' }],
      ['userId', { userId: 'u-9' }],
      ['activity -> at-cove (label)', { activity: 'at-cove' }],
      ['activity -> at-kelp (label)', { activity: 'at-kelp' }],
      ['activity -> at-activity (label)', { activity: 'at-activity' }],
      ['activity -> unknown verb', { activity: 'dancing' }],
    ];
    for (const [what, over] of changes) {
      usePlayerStore.getState().clear();
      ingest([snap('a', 100)]);
      const before = usePlayerStore.getState().players;
      now += 200;
      ingest([snap('a', 130, over)]);
      const after = usePlayerStore.getState().players;
      expect({ what, sameArray: after === before, sameObject: after[0] === before[0] }).toEqual({
        what, sameArray: false, sameObject: false,
      });
      expect({ what, x: after[0].x, prevX: after[0].prevX, tsDelta: after[0].tsDelta }).toEqual({
        what, x: 130, prevX: 100, tsDelta: 200,
      });
    }
  });

  test('back from a labelled activity to walking is structural; idle/walking/running flips are not', () => {
    ingest([snap('a', 100, { activity: 'at-cove' })]);
    const atCove = usePlayerStore.getState().players[0];
    now += 200;
    ingest([snap('a', 100, { activity: 'walking' })]);
    const walking = usePlayerStore.getState().players[0];
    expect(walking).not.toBe(atCove);
    for (const activity of ['idle', 'running', 'walking', 'idle']) {
      now += 200;
      ingest([snap('a', 100, { activity })]);
      expect(usePlayerStore.getState().players[0]).toBe(walking);
      expect(walking.activity).toBe(activity);
    }
  });

  test('isLocal flips (our own id arriving) and a reorder are structural', () => {
    ingest([snap('a', 100), snap('b', 200)]);
    const before = usePlayerStore.getState().players;
    now += 200;
    ingest([snap('b', 200), snap('a', 100)]);
    const reordered = usePlayerStore.getState().players;
    expect(reordered).not.toBe(before);
    expect(reordered[0]).toBe(before[1]);
    expect(reordered[1]).toBe(before[0]);

    usePlayerStore.getState().setLocalSessionId('a');
    const restamped = usePlayerStore.getState().players;
    const a = restamped.find((p) => p.id === 'a')!;
    expect(a.isLocal).toBe(true);
    expect(a).not.toBe(before[0]);
    now += 200;
    ingest([snap('b', 230), snap('a', 130)]);
    expect(usePlayerStore.getState().players).toBe(restamped);
    expect(a.x).toBe(130);
  });
});

// Codex re-check (web-load T3): position-only snapshots now notify NOBODY,
// also for the LOCAL player's own entry. That is safe only while no consumer
// reads player position/activity reactively from this store. The local
// player's position source is `avatarPositionRef` / the game store
// (player-avatar.tsx, minimap, heartbeat, world-stream uplink). This scan
// pins every reader of the players store: a new reader fails here and must
// show that it reads live fields (frame loop) or only structural state.
describe('players store readers (web-load T3): nobody reads position or activity reactively', () => {
  const SRC = resolve(import.meta.dir, '../..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== 'node_modules' && name !== '__tests__') walk(full);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
        files.push(full);
      }
    }
  };
  walk(SRC);
  const rel = (f: string) => relative(SRC, f).split('\\').join('/');
  const readers = new Map<string, string>();
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (/stores\/players['"]/.test(text) && rel(f) !== 'stores/players.ts') readers.set(rel(f), text);
  }

  test('the reader set is exactly the audited one', () => {
    expect([...readers.keys()].sort()).toEqual([
      'components/game/sidebar-menu.tsx',
      'hooks/use-world-stream.ts',
      'lib/clear-identity-state.ts',
      'lib/three/remote-players.tsx',
    ]);
  });

  test('every reactive selector reads a structural field or an action, never position/activity', () => {
    const allowed: Record<string, string[]> = {
      'components/game/sidebar-menu.tsx': ['roomId'],
      'hooks/use-world-stream.ts': ['clear', 'clearRemote', 'setLocalSessionId', 'setRoomId', 'updateFromSnapshot'],
      'lib/clear-identity-state.ts': [],
      // The structural array: RemotePlayers renders only on a structural
      // change, skips isLocal entries, and its bodies read positions live.
      'lib/three/remote-players.tsx': ['players'],
    };
    const selector = /usePlayerStore\(\s*(?:useShallow\(\s*)?\(\s*(\w+)\s*\)\s*=>\s*\1\.(\w+)/g;
    for (const [file, text] of readers) {
      const selected = [...text.matchAll(selector)].map((m) => m[2]);
      const calls = (text.match(/usePlayerStore\(/g) ?? []).length;
      // Every hook call is a recognised `(s) => s.field` selector: no bare
      // usePlayerStore() that subscribes to the whole state.
      expect({ file, recognised: selected.length }).toEqual({ file, recognised: calls });
      expect({ file, selected: [...new Set(selected)].sort() }).toEqual({ file, selected: allowed[file] });
      // No imperative subscription and no getState() read of players.
      expect({
        file,
        subscribe: /usePlayerStore\.subscribe/.test(text),
        getStatePlayers: /usePlayerStore\.getState\(\)\.players/.test(text),
      }).toEqual({ file, subscribe: false, getStatePlayers: false });
    }
  });

  test('the local body is player-avatar.tsx fed by avatarPositionRef; RemotePlayers skips the local entry', () => {
    expect(readers.get('lib/three/remote-players.tsx')).toMatch(/if \(p\.isLocal\) return null;/);
    const avatar = readFileSync(join(SRC, 'lib/three/player-avatar.tsx'), 'utf8');
    expect(avatar).toMatch(/avatarPositionRef/);
    expect(avatar).not.toMatch(/stores\/players/);
  });
});
