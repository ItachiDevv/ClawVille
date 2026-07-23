import { beforeEach, describe, expect, it, mock } from 'bun:test';

process.env.REEF_RACE_USE_SPLINE = 'true';

mock.module('../../../event-logger', () => ({
  logEvent: () => Promise.resolve(),
  ACTIVITY_EVENT_TYPES: { ANTI_CHEAT_FLAG: 'anti_cheat.flag' },
}));
mock.module('../../activity-replay-log', () => ({
  activityReplayLog: {
    appendInputFrame: () => {}, flushToDb: () => Promise.resolve(null),
    dropRoom: () => {}, getReplayId: () => undefined,
    bufferLength: () => 0, __resetForTest: () => {},
  },
}));

const { reefRaceSplineSim } = await import('../reef-race-spline-sim');

const ROOM_ID = 'r18c-mechanics';
const AVATAR_ID = 'r18c-racer';

function start() {
  reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_ID], {
    seed: 18_003,
    startedAt: 0,
  });
  const state = reefRaceSplineSim.__getState(ROOM_ID)! as any;
  if (state.intervalHandle) clearInterval(state.intervalHandle);
  state.intervalHandle = null;
  const body = state.bodies.get(AVATAR_ID)!;
  return { state, body };
}

describe('Reef Race R18c obstacle authority', () => {
  const events: any[] = [];

  beforeEach(() => {
    reefRaceSplineSim.__resetForTest();
    events.length = 0;
    reefRaceSplineSim.setBroadcastFn((_roomId, frame) => events.push(frame));
  });

  it('uses the identical room-id layout for countdown init and live sim', () => {
    const roomId = 'r18c-layout-parity';
    reefRaceSplineSim.startRoom(roomId, 'reef-race', [AVATAR_ID], { startedAt: 0 });
    const state = reefRaceSplineSim.__getState(roomId)! as any;
    if (state.intervalHandle) clearInterval(state.intervalHandle);
    state.intervalHandle = null;
    const initZones = reefRaceSplineSim.getSplineStaticZones(roomId);
    expect(initZones.obstacles).toEqual(state.furniture.obstacles);
    expect(initZones.ripCurrents).toEqual(state.furniture.ripCurrents);
  });

  it('spin-outs grounded urchin contacts but lets airborne racers clear it', () => {
    const { state, body } = start();
    state.furniture.obstacles = [{
      id: 'test-urchin', kind: 'urchin',
      position: { x: body.x, y: body.z }, rot: 0, progress: 0, phase: 0,
      params: { radius: 52, clearanceHeight: 72 },
    }];
    state.furniture.ripCurrents = [];
    (reefRaceSplineSim as any).resolveTrackFurniture(state, 10_000);
    expect(body.spinoutUntil).toBe(10_900);
    expect(body.activeBoosts.get('hazard-slow')?.mult).toBeCloseTo(.60, 6);
    expect(events.some((event) => event.type === 'event.obstacle_hit')).toBe(true);
    const firstContactCount = events.filter((event) => event.type === 'event.obstacle_hit').length;
    (reefRaceSplineSim as any).resolveTrackFurniture(state, 10_100);
    expect(events.filter((event) => event.type === 'event.obstacle_hit')).toHaveLength(firstContactCount);

    body.spinoutUntil = 0;
    body.activeBoosts.clear();
    body.heightOffset = 100;
    state.obstacleCooldowns.clear();
    events.length = 0;
    (reefRaceSplineSim as any).resolveTrackFurniture(state, 12_000);
    expect(body.spinoutUntil).toBe(0);
    expect(events.some((event) => event.type === 'event.obstacle_hit')).toBe(false);
  });

  it('driftwood dampens velocity and applies a small stagger hop', () => {
    const { state, body } = start();
    body.vx = 1_000;
    state.furniture.obstacles = [{
      id: 'test-log', kind: 'driftwood',
      position: { x: body.x, y: body.z }, rot: 0, progress: 0, phase: 0,
      params: { halfLength: 190, halfWidth: 38, clearanceHeight: 68 },
    }];
    state.furniture.ripCurrents = [];
    (reefRaceSplineSim as any).resolveTrackFurniture(state, 10_000);
    expect(body.vx).toBeCloseTo(580, 6);
    expect(body.vyAxis).toBe(320);
    expect(body.airborneTicks).toBe(1);
    expect(events.some((event) => event.impact === 'bump')).toBe(true);
  });

  it('refreshes kelp slow and bounded rip-current bonus while inside', () => {
    const { state, body } = start();
    state.furniture.obstacles = [{
      id: 'test-kelp', kind: 'kelp',
      position: { x: body.x, y: body.z }, rot: 0, progress: 0, phase: 0,
      params: { radius: 125 },
    }];
    state.furniture.ripCurrents = [{
      id: 'test-rip', progress: 0, lateralOffset: 0, speedBonus: .24,
      segments: [{
        position: { x: body.x, y: body.z }, rot: 0,
        halfLength: 380, halfWidth: 135,
      }],
    }];
    (reefRaceSplineSim as any).resolveTrackFurniture(state, 10_000);
    expect(body.activeBoosts.get('hazard-slow')?.mult).toBeCloseTo(.60, 6);
    expect(body.activeBoosts.get('rip-current')?.mult).toBeCloseTo(.24, 6);
    expect(events.some((event) => event.type === 'event.hazard_hit')).toBe(true);

    body.activeBoosts.delete('hazard-slow');
    body.activeBoosts.set('launch-boost', { expiresAt: 20_000, mult: .30 });
    body.activeBoosts.set('slipstream-boost', { expiresAt: 20_000, mult: .20 });
    body.activeBoosts.set('pad-boost', { expiresAt: 20_000, mult: .45 });
    body.activeBoosts.set('trick-surge', { expiresAt: 20_000, mult: .25 });
    body.activeEffects.set('rr-turbo-bubble', 20_000);
    (reefRaceSplineSim as any).applyIntentForTick(state, body, 1 / 30, 10_001);
    expect(body.speedMod).toBeCloseTo(1.85, 6);

    state.furniture.ripCurrents = [];
    state.simTimeMs = 10_199;
    reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
    expect(body.activeBoosts.has('rip-current')).toBe(false);
  });

  it('collides with a creature only during the shared-clock crossing window', () => {
    const { state, body } = start();
    state.furniture.obstacles = [{
      id: 'test-creature', kind: 'creature',
      position: { x: body.x, y: body.z }, rot: 0, progress: 0, phase: 0,
      params: {
        radius: 82, clearanceHeight: 95, lateralSpan: 600,
        periodMs: 20_000, telegraphMs: 2_000, crossingMs: 4_000,
        direction: 1,
      },
    }];
    state.furniture.ripCurrents = [];

    // Dormant [0,14s) and telegraph [14s,16s) never have collision authority.
    (reefRaceSplineSim as any).resolveTrackFurniture(state, 10_000, 10_000);
    (reefRaceSplineSim as any).resolveTrackFurniture(state, 15_000, 15_000);
    expect(body.spinoutUntil).toBe(0);
    expect(events.some((event) => event.type === 'event.obstacle_hit')).toBe(false);

    // Crossing midpoint at 18s is exactly the base track center.
    (reefRaceSplineSim as any).resolveTrackFurniture(state, 18_000, 18_000);
    expect(body.spinoutUntil).toBe(18_900);
    expect(events.some((event) => event.kind === 'creature')).toBe(true);
  });
});
