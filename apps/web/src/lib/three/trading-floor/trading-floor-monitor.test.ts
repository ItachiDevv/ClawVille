import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useGameStore } from '@/stores/game';
import {
  activateTradingFloorSeat,
  activateTradingFloorUse,
  openTradingFloorMonitor,
  readTradingFloorProximity,
  tradingFloorInteractionsFrozen,
} from './trading-floor-interior';
import {
  computeTradingFloorArming,
  createTradingFloorArming,
  resetTradingFloorArming,
  resolveTradingFloorInteraction,
  tradingFloorDistanceSq,
  tradingFloorHitsSolid,
  TRADING_FLOOR_DOOR,
  TRADING_FLOOR_MONITOR,
  TRADING_FLOOR_PLAYER_RADIUS,
  TRADING_FLOOR_PLAYER_SPAWN,
  TRADING_FLOOR_ROOM,
  TRADING_FLOOR_SCREEN,
  TRADING_FLOOR_SEAT_INTERACT_RADIUS,
  TRADING_FLOOR_SEATS,
} from './trading-floor-room';

beforeEach(() => {
  useGameStore.setState({ exchangeOpen: false, exchangeTab: 'browse' });
});

describe('Trading Floor monitor hotspot', () => {
  test('opens the Exchange modal on the Trading Floor tab', () => {
    openTradingFloorMonitor();
    const state = useGameStore.getState();
    expect(state.exchangeOpen).toBe(true);
    expect(state.exchangeTab).toBe('floor');
  });

  // The whole point of the slice: one panel, one data path. If the monitor
  // ever grows its own modal, this stops being true.
  test('lands on exactly the state the sidebar row produces', () => {
    openTradingFloorMonitor();
    const fromMonitor = {
      open: useGameStore.getState().exchangeOpen,
      tab: useGameStore.getState().exchangeTab,
    };
    useGameStore.setState({ exchangeOpen: false, exchangeTab: 'browse' });
    useGameStore.getState().openTradingFloor();
    expect({
      open: useGameStore.getState().exchangeOpen,
      tab: useGameStore.getState().exchangeTab,
    }).toEqual(fromMonitor);
  });

  test('switches an already-open Exchange onto the Trading Floor tab', () => {
    useGameStore.setState({ exchangeOpen: true, exchangeTab: 'my-orders' });
    openTradingFloorMonitor();
    expect(useGameStore.getState().exchangeTab).toBe('floor');
  });

  test('is a no-op when the Floor tab is already showing', () => {
    useGameStore.setState({ exchangeOpen: true, exchangeTab: 'floor' });
    openTradingFloorMonitor();
    expect(useGameStore.getState().exchangeOpen).toBe(true);
    expect(useGameStore.getState().exchangeTab).toBe('floor');
  });

  test('publishes a disarmed proximity snapshot before any frame runs', () => {
    expect(readTradingFloorProximity()).toEqual({
      monitorArmed: false,
      monitorHint: false,
      doorArmed: false,
      doorHint: false,
      seatArmedIndex: -1,
      seatHintIndex: -1,
      seatedIndex: -1,
    });
  });
});

describe('Trading Floor monitor placement (v2)', () => {
  // v2 moved the kiosk off the centre line so it stops hiding the big board.
  // Both of its constraints are geometric, so both are pinned here rather than
  // left to a screenshot.
  test('sits clear of the board centre but still in front of the board', () => {
    // Off the room's centre line, so the board's middle is unobstructed.
    expect(Math.abs(TRADING_FLOOR_MONITOR.x)).toBeGreaterThan(200);
    // Still inside the board's width, so it reads as the board's podium.
    expect(Math.abs(TRADING_FLOOR_MONITOR.x)).toBeLessThan(
      TRADING_FLOOR_SCREEN.width / 2,
    );
    // In front of the board, never through it.
    expect(TRADING_FLOOR_MONITOR.z - TRADING_FLOOR_MONITOR.halfZ).toBeGreaterThan(
      TRADING_FLOOR_SCREEN.z,
    );
  });

  // E must never be ambiguous. `onInteractEdge` resolves ties by priority, but
  // a player who can see two "press E" prompts at once cannot know that.
  test('the monitor band never overlaps a seat band', () => {
    for (const seat of TRADING_FLOOR_SEATS) {
      const separation = Math.hypot(
        seat.x - TRADING_FLOOR_MONITOR.x,
        seat.z - TRADING_FLOOR_MONITOR.z,
      );
      expect(separation).toBeGreaterThan(
        TRADING_FLOOR_MONITOR.interactRadius + TRADING_FLOOR_SEAT_INTERACT_RADIUS,
      );
    }
  });

  // v3 shrank the kiosk to 300 wu and pushed it to z -980, hard against the
  // back wall. The thing that can go wrong with "push it back" is reachability:
  // if the prop plus the player radius runs past the wall clamp, there is no
  // legal square left to stand on and the venue's whole point is unreachable.
  // The approach point is the nearest square a player can occupy head-on.
  test('a player can stand at the kiosk face and arm it', () => {
    const approachZ =
      TRADING_FLOOR_MONITOR.z + TRADING_FLOOR_MONITOR.halfZ + TRADING_FLOOR_PLAYER_RADIUS + 20;
    const approachX = TRADING_FLOOR_MONITOR.x;

    // Inside the walls.
    expect(Math.abs(approachZ)).toBeLessThanOrEqual(
      TRADING_FLOOR_ROOM.halfZ - TRADING_FLOOR_PLAYER_RADIUS,
    );
    // Outside every solid, including the kiosk it is standing at.
    expect(tradingFloorHitsSolid(approachX, approachZ)).toBe(false);
    // And close enough that E fires.
    expect(
      tradingFloorDistanceSq(
        approachX,
        approachZ,
        TRADING_FLOOR_MONITOR.x,
        TRADING_FLOOR_MONITOR.z,
      ),
    ).toBeLessThan(TRADING_FLOOR_MONITOR.interactRadius ** 2);
  });

  test('the door band never overlaps a seat band', () => {
    for (const seat of TRADING_FLOOR_SEATS) {
      const separation = Math.hypot(
        seat.x - TRADING_FLOOR_DOOR.x,
        seat.z - TRADING_FLOOR_DOOR.z,
      );
      expect(separation).toBeGreaterThan(
        TRADING_FLOOR_DOOR.interactRadius + TRADING_FLOOR_SEAT_INTERACT_RADIUS,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Structural guard — Iris Xe rule: NO per-frame allocation.
//
// A source scan rather than a render test: the frame body is a closure inside
// a hook config, so there is no way to invoke it without a live R3F root, and
// a GC-pressure assertion would be flaky. Scanning the exact frame callbacks
// for `new ` catches the regression this rule exists to prevent
// (memory: per-frame `new Vector3()` in useFrame = GC thrash).
// ---------------------------------------------------------------------------

function extractCallbackBody(source: string, header: string): string {
  const start = source.indexOf(header);
  if (start === -1) {
    throw new Error(`[structural] callback header not found: ${header}`);
  }
  let depth = 0;
  let index = source.indexOf('{', start);
  const bodyStart = index;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  throw new Error(`[structural] unbalanced braces after: ${header}`);
}

// ---------------------------------------------------------------------------
// Input parity — keyboard E and the touch USE button MUST run one action.
//
// The regression this pins is real and was caught in adversarial review: the
// v2 pass that added the desk seats left the sit toggle inside the
// keyboard-only `onInteractEdge` while the USE button kept a two-case copy of
// the ladder, so the founder's own request ("computers ... that an agent can go
// up and sit at") was unreachable on every phone and iPad. A source scan is the
// right tool: the ladder is module-scope state with no setter, so a behavioural
// test would need a test-only seam that is itself a liability.
// ---------------------------------------------------------------------------

describe('Trading Floor interact parity — one action, both inputs', () => {
  const scene = readFileSync(
    join(import.meta.dir, 'trading-floor-interior.tsx'),
    'utf8',
  );
  const touch = readFileSync(
    join(
      import.meta.dir,
      '..',
      '..',
      '..',
      'components',
      'trading-floor',
      'TradingFloorMobileControls.tsx',
    ),
    'utf8',
  );

  test('the keyboard E edge delegates to the shared action', () => {
    const body = extractCallbackBody(scene, 'onInteractEdge: () => {');
    expect(body).toContain('activateTradingFloorUse()');
  });

  test('the touch USE button delegates to the same action', () => {
    expect(touch).toContain('activateTradingFloorUse');
  });

  test('the touch button does NOT re-implement the ladder', () => {
    for (const token of [
      'monitorArmed',
      'doorArmed',
      'seatArmedIndex',
      'seatedIndex',
      'openTradingFloorMonitor',
      'requestTradingFloorExit',
    ]) {
      expect({ token, present: touch.includes(token) }).toEqual({
        token,
        present: false,
      });
    }
  });

  // The ladder itself is a pure function, so pin it BEHAVIOURALLY. This
  // replaces a source scan that asserted how the branches were spelled — the
  // scan broke the moment the ladder moved into `trading-floor-room.ts`, which
  // is exactly the wrong reason for a test to fail.
  test('the ladder resolves stand > monitor > door > sit', () => {
    const arming = createTradingFloorArming();

    expect(resolveTradingFloorInteraction(arming, -1, false)).toBe('none');

    arming.seatArmedIndex = 0;
    expect(resolveTradingFloorInteraction(arming, -1, false)).toBe('sit');

    arming.doorArmed = true;
    expect(resolveTradingFloorInteraction(arming, -1, false)).toBe('door');

    arming.monitorArmed = true;
    expect(resolveTradingFloorInteraction(arming, -1, false)).toBe('monitor');

    // Seated outranks all three: while seated they are exactly the ones that
    // must not fire, or E can never stand the player back up.
    expect(resolveTradingFloorInteraction(arming, 3, false)).toBe('stand');
  });

  test('standing wins even when nothing else is armed', () => {
    const arming = createTradingFloorArming();
    expect(resolveTradingFloorInteraction(arming, 0, false)).toBe('stand');
  });

  // Every seat index must be reachable through the ladder, or a desk exists
  // that cannot be sat at.
  test('every seat index can resolve to sit', () => {
    const arming = createTradingFloorArming();
    for (const seat of TRADING_FLOOR_SEATS) {
      resetTradingFloorArming(arming);
      arming.seatArmedIndex = seat.index;
      expect(resolveTradingFloorInteraction(arming, -1, false)).toBe('sit');
    }
  });

  // The arming record is the frame loop's only state, and the scene reuses one
  // across visits. A reset that misses a field leaves a hotspot armed in a room
  // the player has left.
  test('resetTradingFloorArming clears every field', () => {
    const arming = createTradingFloorArming();
    computeTradingFloorArming(
      TRADING_FLOOR_MONITOR.x,
      TRADING_FLOOR_MONITOR.z,
      arming,
    );
    expect(arming.monitorArmed).toBe(true);
    resetTradingFloorArming(arming);
    expect(arming).toEqual(createTradingFloorArming());
  });

  test('walking onto a seat arms that seat and nothing else', () => {
    const arming = createTradingFloorArming();
    for (const seat of TRADING_FLOOR_SEATS) {
      computeTradingFloorArming(seat.x, seat.z, arming);
      expect(arming.seatArmedIndex).toBe(seat.index);
      expect(arming.monitorArmed).toBe(false);
      expect(arming.doorArmed).toBe(false);
      expect(resolveTradingFloorInteraction(arming, -1, false)).toBe('sit');
    }
  });

  test('the spawn arms nothing at all', () => {
    const arming = createTradingFloorArming();
    computeTradingFloorArming(
      TRADING_FLOOR_PLAYER_SPAWN.x,
      TRADING_FLOOR_PLAYER_SPAWN.z,
      arming,
    );
    expect(resolveTradingFloorInteraction(arming, -1, false)).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// The Exchange freeze — every interaction yields to the panel.
//
// The keyboard path was gated upstream by the controller's `isFrozen`, and
// NOTHING ELSE WAS. The touch USE button, the six seat click volumes and the
// door click volume all reach the world without passing the controller, so with
// the panel open USE requested an exit out from under it and, while seated,
// toggled the seat. Found by Codex in adversarial review, not by any suite here
// — the keyboard path was correct and every test drove the keyboard path.
//
// The freeze now lives in the PURE ladder, which is why these can be driven
// exhaustively rather than scanned for.
// ---------------------------------------------------------------------------

describe('Trading Floor interact — the Exchange panel freezes everything', () => {
  test('a frozen door does not request an exit', () => {
    const arming = createTradingFloorArming();
    arming.doorArmed = true;
    expect(resolveTradingFloorInteraction(arming, -1, false)).toBe('door');
    expect(resolveTradingFloorInteraction(arming, -1, true)).toBe('none');
  });

  test('a frozen seated player does not stand up', () => {
    const arming = createTradingFloorArming();
    expect(resolveTradingFloorInteraction(arming, 3, false)).toBe('stand');
    expect(resolveTradingFloorInteraction(arming, 3, true)).toBe('none');
  });

  test('a frozen monitor does not re-open the panel', () => {
    const arming = createTradingFloorArming();
    arming.monitorArmed = true;
    expect(resolveTradingFloorInteraction(arming, -1, false)).toBe('monitor');
    expect(resolveTradingFloorInteraction(arming, -1, true)).toBe('none');
  });

  test('a frozen seat does not sit', () => {
    const arming = createTradingFloorArming();
    arming.seatArmedIndex = 0;
    expect(resolveTradingFloorInteraction(arming, -1, false)).toBe('sit');
    expect(resolveTradingFloorInteraction(arming, -1, true)).toBe('none');
  });

  // The freeze outranks the WHOLE ladder including 'stand', which is the rung
  // that would otherwise fire first. Escape is the only way out, and the
  // controller already routes it to `closeExchange`.
  test('nothing resolves while frozen, whatever is armed', () => {
    const arming = createTradingFloorArming();
    arming.monitorArmed = true;
    arming.doorArmed = true;
    arming.seatArmedIndex = 2;
    for (const seated of [-1, 0, 5]) {
      expect(resolveTradingFloorInteraction(arming, seated, true)).toBe('none');
    }
  });

  test('the freeze predicate tracks the store', () => {
    useGameStore.setState({ exchangeOpen: false });
    expect(tradingFloorInteractionsFrozen()).toBe(false);
    useGameStore.setState({ exchangeOpen: true });
    expect(tradingFloorInteractionsFrozen()).toBe(true);
    useGameStore.setState({ exchangeOpen: false });
  });

  test('the shared action refuses to act while the panel is open', () => {
    useGameStore.setState({ exchangeOpen: true, exchangeTab: 'browse' });
    expect(activateTradingFloorUse()).toBe(false);
    // Nothing was opened, closed, seated or exited.
    expect(useGameStore.getState().exchangeTab).toBe('browse');
    expect(readTradingFloorProximity().seatedIndex).toBe(-1);
    useGameStore.setState({ exchangeOpen: false });
  });

  test('a seat CLICK is refused while the panel is open', () => {
    useGameStore.setState({ exchangeOpen: true });
    for (const seat of TRADING_FLOOR_SEATS) {
      expect(activateTradingFloorSeat(seat.index)).toBe(false);
    }
    expect(readTradingFloorProximity().seatedIndex).toBe(-1);
    useGameStore.setState({ exchangeOpen: false });
  });

  // The door and monitor click volumes called their actions DIRECTLY and so
  // bypassed the freeze the same way. A source scan is the right tool: the
  // handlers are inline JSX props with no seam to drive.
  test('both click volumes consult the freeze before acting', () => {
    const scene = readFileSync(
      join(import.meta.dir, 'trading-floor-interior.tsx'),
      'utf8',
    );
    const start = scene.indexOf('function TradingFloorHotspots(');
    expect(start).toBeGreaterThan(0);
    const body = scene.slice(start, scene.indexOf('\n}', start));
    // Neither action may appear without a freeze check guarding it.
    for (const action of ['openTradingFloorMonitor()', 'requestTradingFloorExit()']) {
      const at = body.indexOf(action);
      expect({ action, present: at > 0 }).toEqual({ action, present: true });
      const guardBefore = body.lastIndexOf('tradingFloorInteractionsFrozen()', at);
      expect({ action, guarded: guardBefore > 0 && guardBefore < at }).toEqual({
        action,
        guarded: true,
      });
    }
  });
});

describe('Trading Floor frame loop allocates nothing', () => {
  const source = readFileSync(
    join(import.meta.dir, 'trading-floor-interior.tsx'),
    'utf8',
  );

  test.each([
    ['onAfterMove: (state) => {'],
    ['onInteractEdge: () => {'],
  ])('%s contains no allocation', (header) => {
    const body = extractCallbackBody(source, header);
    expect(body).not.toContain('new ');
    expect(body).not.toContain('.clone(');
    expect(body).not.toContain('.map(');
    expect(body).not.toContain('.filter(');
  });

  test('every THREE allocation in the file sits at module scope', () => {
    // Module-scope declarations start at column 0. Anything indented is inside
    // a function body — a component factory (useMemo/builder) or, if this ever
    // fails, a frame callback.
    const offenders = source
      .split('\n')
      .filter((line) => line.includes('new THREE.'))
      .filter((line) => /^\s/.test(line))
      // Allowed, all ONE-TIME build work behind useMemo / lazy module init,
      // never a frame callback:
      //   BoxGeometry   — the two invisible hotspot volumes
      //   Object3D      — the three module-scope label anchors
      //   InstancedMesh — `buildInstancedRow`, twice per room mount
      .filter(
        (line) =>
          !line.includes('new THREE.BoxGeometry') &&
          !line.includes('new THREE.Object3D') &&
          !line.includes('new THREE.InstancedMesh'),
      );
    expect(offenders).toEqual([]);
  });
});
