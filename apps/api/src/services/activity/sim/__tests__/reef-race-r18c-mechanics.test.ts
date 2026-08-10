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

  it('restores the pre-contact heading when a spinout expires (founder 2026-08-09)', () => {
    const { state, body } = start();
    const entryRot = 1.234;
    body.rot = entryRot;
    state.furniture.obstacles = [{
      id: 'test-urchin', kind: 'urchin',
      position: { x: body.x, y: body.z }, rot: 0, progress: 0, phase: 0,
      params: { radius: 52, clearanceHeight: 72 },
    }];
    state.furniture.ripCurrents = [];
    (reefRaceSplineSim as any).resolveTrackFurniture(state, 10_000);
    expect(body.spinoutUntil).toBe(10_900);
    expect(body.spinoutEntryRot).toBe(entryRot);

    // Mid-spin ticks visibly rotate the authoritative heading (the theater).
    (reefRaceSplineSim as any).applyIntentForTick(state, body, 1 / 30, 10_100);
    (reefRaceSplineSim as any).applyIntentForTick(state, body, 1 / 30, 10_200);
    expect(body.rot).not.toBeCloseTo(entryRot, 3);

    // First tick past expiry: heading restored EXACTLY to the entry heading.
    (reefRaceSplineSim as any).applyIntentForTick(state, body, 1 / 30, 10_901);
    expect(body.spinoutUntil).toBe(0);
    expect(body.rot).toBeCloseTo(entryRot, 6);
  });

  it('keeps the ORIGINAL entry heading when a second contact re-triggers mid-spin', () => {
    const { state, body } = start();
    const entryRot = -0.5;
    body.rot = entryRot;
    state.furniture.obstacles = [{
      id: 'test-urchin-a', kind: 'urchin',
      position: { x: body.x, y: body.z }, rot: 0, progress: 0, phase: 0,
      params: { radius: 52, clearanceHeight: 72 },
    }];
    state.furniture.ripCurrents = [];
    (reefRaceSplineSim as any).resolveTrackFurniture(state, 10_000);
    expect(body.spinoutEntryRot).toBe(entryRot);

    // Spin a few ticks, then hit a DIFFERENT obstacle while still spinning.
    (reefRaceSplineSim as any).applyIntentForTick(state, body, 1 / 30, 10_100);
    state.furniture.obstacles = [{
      id: 'test-urchin-b', kind: 'urchin',
      position: { x: body.x, y: body.z }, rot: 0, progress: 0, phase: 0,
      params: { radius: 52, clearanceHeight: 72 },
    }];
    (reefRaceSplineSim as any).resolveTrackFurniture(state, 10_400);
    expect(body.spinoutUntil).toBe(11_300);
    expect(body.spinoutEntryRot).toBe(entryRot); // NOT re-captured mid-spin

    (reefRaceSplineSim as any).applyIntentForTick(state, body, 1 / 30, 11_301);
    expect(body.rot).toBeCloseTo(entryRot, 6);
  });

  it('whirlpool spins + slows in the wide ring; pulls only inside the tight core', () => {
    const roomId = 'r18c-whirlpool';
    reefRaceSplineSim.startRoom(
      roomId, 'reef-race', [AVATAR_ID, 'rival-far', 'rival-near'], {
        seed: 18_004,
        startedAt: 0,
      },
    );
    const state = reefRaceSplineSim.__getState(roomId)! as any;
    if (state.intervalHandle) clearInterval(state.intervalHandle);
    state.intervalHandle = null;
    const src = state.bodies.get(AVATAR_ID)!;
    const far = state.bodies.get('rival-far')!;
    const near = state.bodies.get('rival-near')!;
    // 800 wu: dead under the old 300 radius, inside the 900 spin ring but
    // OUTSIDE the 300 pull core. 200 wu: inside both.
    far.x = src.x + 800;
    far.z = src.z;
    near.x = src.x + 200;
    near.z = src.z;
    const farEntryRot = far.rot;
    const impulses: Array<{ id: string; dvx: number; dvz: number }> = [];
    (reefRaceSplineSim as any).collectWhirlpool(
      state, src, 10_000,
      (id: string, dvx: number, dvz: number) => impulses.push({ id, dvx, dvz }),
    );
    // Wide ring: BOTH rivals get the advertised spinout + slow.
    expect(far.spinoutUntil).toBe(10_900);
    expect(far.spinoutEntryRot).toBe(farEntryRot);
    expect(far.activeBoosts.get('hazard-slow')?.mult).toBeCloseTo(0.65, 6);
    expect(near.spinoutUntil).toBe(10_900);
    // Tight core: only the near rival is pulled (anti-cheat progress
    // tolerance bounds the pull's reach — see WHIRLPOOL_PULL_RADIUS).
    expect(impulses).toHaveLength(1);
    expect(impulses[0]!.id).toBe('rival-near');
    expect(impulses[0]!.dvx).toBeLessThan(0); // pulled toward the user
    expect(events.some(
      (event) => event.type === 'event.hit' && event.itemKind === 'rr-whirlpool',
    )).toBe(true);
    // The hit carries the spinout deadline so the victim's client enters the
    // obstacle-spinout prediction lock (Codex R19 finding 2).
    expect(events.some(
      (event) => event.type === 'event.hit' &&
        event.itemKind === 'rr-whirlpool' && event.spinoutDurationMs === 900,
    )).toBe(true);
  });

  it('whirlpool skips a remora-rocketing rival (remora owns rot)', () => {
    const roomId = 'r18c-whirlpool-remora';
    reefRaceSplineSim.startRoom(
      roomId, 'reef-race', [AVATAR_ID, 'rival-remora'], {
        seed: 18_005,
        startedAt: 0,
      },
    );
    const state = reefRaceSplineSim.__getState(roomId)! as any;
    if (state.intervalHandle) clearInterval(state.intervalHandle);
    state.intervalHandle = null;
    const src = state.bodies.get(AVATAR_ID)!;
    const rival = state.bodies.get('rival-remora')!;
    rival.x = src.x + 200;
    rival.z = src.z;
    rival.remoraUntilMs = 14_000; // active rocket at now=10_000
    (reefRaceSplineSim as any).collectWhirlpool(
      state, src, 10_000, () => {},
    );
    expect(rival.spinoutUntil).toBe(0);
    expect(rival.activeBoosts.has('hazard-slow')).toBe(false);
  });

  it('remora activation clears an in-flight spinout (no stale deferred restore)', () => {
    const { state, body } = start();
    body.rot = 0.7;
    state.furniture.obstacles = [{
      id: 'test-urchin', kind: 'urchin',
      position: { x: body.x, y: body.z }, rot: 0, progress: 0, phase: 0,
      params: { radius: 52, clearanceHeight: 72 },
    }];
    state.furniture.ripCurrents = [];
    (reefRaceSplineSim as any).resolveTrackFurniture(state, 10_000);
    expect(body.spinoutUntil).toBe(10_900);
    // Rocket starts mid-spin: remora owns rot from here on.
    body.remoraUntilMs = 14_000;
    (reefRaceSplineSim as any).applyIntentForTick(state, body, 1 / 30, 10_100);
    expect(body.spinoutUntil).toBe(0); // cleared by the remora branch
    // After the rocket ends, NO stale restore fires — rot stays autopilot-owned.
    body.remoraUntilMs = 0;
    const rotAfterRocket = body.rot;
    (reefRaceSplineSim as any).applyIntentForTick(state, body, 1 / 30, 14_100);
    expect(body.rot).toBe(rotAfterRocket);
  });

  it('same-tick whirlpools from different-length sources agree on spin state', () => {
    const mk = (roomId: string, order: readonly string[]) => {
      reefRaceSplineSim.startRoom(roomId, 'reef-race', [...order, 'victim-x'], {
        seed: 18_006,
        startedAt: 0,
      });
      const state = reefRaceSplineSim.__getState(roomId)! as any;
      if (state.intervalHandle) clearInterval(state.intervalHandle);
      state.intervalHandle = null;
      const victim = state.bodies.get('victim-x')!;
      const a = state.bodies.get(order[0]!)!;
      const b = state.bodies.get(order[1]!)!;
      victim.x = 0; victim.z = 0; victim.rot = 0.4;
      a.x = 300; a.z = 0;
      b.x = -300; b.z = 0;
      // Resolve both sources in the given order at the same tick.
      for (const id of order) {
        (reefRaceSplineSim as any).collectWhirlpool(
          state, state.bodies.get(id)!, 10_000, () => {},
        );
      }
      return victim;
    };
    // 'ab' (len 2) vs 'long-src-id' (len 11): parity differs — the old
    // src+target formula gave order-dependent directions here.
    const v1 = mk('r18c-wp-order-1', ['ab', 'long-src-id']);
    const v2 = mk('r18c-wp-order-2', ['long-src-id', 'ab']);
    expect(v1.spinoutUntil).toBe(10_900);
    expect(v2.spinoutUntil).toBe(10_900);
    expect(v1.spinoutDirection).toBe(v2.spinoutDirection);
    expect(v1.spinoutEntryRot).toBe(0.4);
    expect(v2.spinoutEntryRot).toBe(0.4);
  });

  it('a resolved current-swap carries spinout state with the pose', () => {
    const roomId = 'r18c-swap-spin';
    reefRaceSplineSim.startRoom(
      roomId, 'reef-race', ['swap-attacker', 'swap-victim'], {
        seed: 18_007,
        startedAt: 0,
      },
    );
    const state = reefRaceSplineSim.__getState(roomId)! as any;
    if (state.intervalHandle) clearInterval(state.intervalHandle);
    state.intervalHandle = null;
    const attacker = state.bodies.get('swap-attacker')!;
    const victim = state.bodies.get('swap-victim')!;
    // Victim is mid-spin with a known entry heading; attacker is clean.
    victim.rot = 2.2;
    victim.spinoutUntil = 10_600;
    victim.spinoutDirection = -1;
    victim.spinoutEntryRot = 1.9;
    const attackerRot = attacker.rot;
    state.pendingSwaps.set('swap-attacker', {
      attackerAvatarId: 'swap-attacker',
      victimAvatarId: 'swap-victim',
      startedAtMs: 9_000,
      resolvesAtMs: 10_000,
    });
    (reefRaceSplineSim as any).resolvePendingCurrentSwaps(state, 10_000);
    // The spin (and its entry heading) moved WITH the pose: the attacker now
    // owns the spinning pose and will restore 1.9 at expiry; the victim's new
    // pose is clean.
    expect(attacker.spinoutUntil).toBe(10_600);
    expect(attacker.spinoutDirection).toBe(-1);
    expect(attacker.spinoutEntryRot).toBe(1.9);
    expect(attacker.rot).toBe(2.2);
    expect(victim.spinoutUntil).toBe(0);
    expect(victim.rot).toBe(attackerRot);
  });
});
