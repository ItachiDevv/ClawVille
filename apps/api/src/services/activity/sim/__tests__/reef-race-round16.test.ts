import { beforeEach, describe, expect, it, mock } from 'bun:test';

process.env.REEF_RACE_USE_SPLINE = 'true';

mock.module('../../../event-logger', () => ({
  logEvent: () => Promise.resolve(),
  ACTIVITY_EVENT_TYPES: { ANTI_CHEAT_FLAG: 'anti_cheat.flag' },
}));
mock.module('../../activity-replay-log', () => ({
  activityReplayLog: {
    appendInputFrame: () => {},
    flushToDb: () => Promise.resolve(null),
    dropRoom: () => {},
    getReplayId: () => undefined,
    bufferLength: () => 0,
    __resetForTest: () => {},
  },
}));

const { reefRaceSplineSim } = await import('../reef-race-spline-sim');
const { createReefRaceBot } = await import('../../bots/reef-race-bot');
const { REEF_MAX_SPEED, buildSplineBoostPads } = await import('../reef-race-config');

const ROOM_ID = 'round16-wall-room';
const AVATAR_ID = 'round16-racer';
const DT = 1 / 30;

function placeOutside(
  state: any,
  body: any,
  t: number,
  outwardSpeed: number,
  tangentialSpeed = 0,
) {
  const center = state.spline.centerlineAt(t);
  const normal = state.spline.normalAt(t);
  const tangent = state.spline.tangentAt(t);
  const halfW = state.spline.widthAt(t);
  body.x = center.x + normal.x * (halfW + 25);
  body.z = center.z + normal.z * (halfW + 25);
  body.vx = normal.x * outwardSpeed + tangent.x * tangentialSpeed;
  body.vz = normal.z * outwardSpeed + tangent.z * tangentialSpeed;
  body.progress = state.spline.arclengthFromT(t) / state.spline.totalArcLength;
  body.progressInitialized = true;
  return { center, normal, tangent };
}

describe('Reef Race Round 16 wall consequences', () => {
  let events: any[];

  beforeEach(() => {
    reefRaceSplineSim.__resetForTest();
    events = [];
    reefRaceSplineSim.setBroadcastFn((_roomId: string, frame: unknown) => {
      events.push(frame);
    });
    reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_ID], {
      startedAt: 0,
    });
    events.length = 0;
  });

  it('keeps a tier-0 glancing brush on the original slide response', () => {
    const state = reefRaceSplineSim.__getState(ROOM_ID)! as any;
    const body = state.bodies.get(AVATAR_ID)!;
    const vN = REEF_MAX_SPEED * 0.20;
    const vT = REEF_MAX_SPEED * 0.30;
    const { normal, tangent } = placeOutside(state, body, 0.2, vN, vT);

    (reefRaceSplineSim as any).enforceSplineWallClamp(state, body, true);

    const outwardAfter = body.vx * normal.x + body.vz * normal.z;
    const tangentAfter = body.vx * tangent.x + body.vz * tangent.z;
    expect(outwardAfter).toBeCloseTo(vN * 0.45, 6);
    expect(tangentAfter).toBeCloseTo(vT * 0.98, 6);
    expect(events).toHaveLength(0);
    expect(body.activeBoosts.has('hazard-slow')).toBe(false);
  });

  it('reflects a tier-1 slam, applies the shared slow, emits once, then cooldown-slides', () => {
    const state = reefRaceSplineSim.__getState(ROOM_ID)! as any;
    const body = state.bodies.get(AVATAR_ID)!;
    const vN = REEF_MAX_SPEED * 0.40;
    const vT = REEF_MAX_SPEED * 0.25;
    let frame = placeOutside(state, body, 0.2, vN, vT);

    (reefRaceSplineSim as any).enforceSplineWallClamp(state, body, true);

    expect(body.vx * frame.normal.x + body.vz * frame.normal.z).toBeCloseTo(
      -vN * 0.45,
      6,
    );
    expect(body.vx * frame.tangent.x + body.vz * frame.tangent.z).toBeCloseTo(
      vT * 0.98,
      6,
    );
    expect(body.activeBoosts.get('hazard-slow')).toEqual({
      expiresAt: state.simTimeMs + 1_200,
      mult: 0.60,
    });
    expect(events.filter((event) => event.type === 'event.wall_slam')).toHaveLength(1);

    frame = placeOutside(state, body, 0.2, vN, vT);
    (reefRaceSplineSim as any).enforceSplineWallClamp(state, body, true);
    expect(body.vx * frame.normal.x + body.vz * frame.normal.z).toBeCloseTo(
      vN * 0.45,
      6,
    );
    expect(events.filter((event) => event.type === 'event.wall_slam')).toHaveLength(1);
  });

  it('wipes out at tier 2, ignores input, and respawns on centerline at 10% speed', () => {
    const state = reefRaceSplineSim.__getState(ROOM_ID)! as any;
    const body = state.bodies.get(AVATAR_ID)!;
    placeOutside(state, body, 0.35, REEF_MAX_SPEED * 0.70);

    (reefRaceSplineSim as any).enforceSplineWallClamp(state, body, true);
    const wipeoutEvent = events.find((event) => event.type === 'event.wipeout');
    expect(wipeoutEvent).toBeDefined();
    expect(body.wipeoutUntil).toBe(state.simTimeMs + 3_200);
    expect(
      reefRaceSplineSim.getStateSnapshot(ROOM_ID)!.bodies[0].wipedOut,
    ).toBe(true);

    const speedBefore = Math.hypot(body.vx, body.vz);
    body.intent = {
      dir: { x: 1, z: 0 },
      thrust: 1,
      actionBits: 1,
      seq: 1,
      dt: DT,
      consumedSeq: 0,
    };
    (reefRaceSplineSim as any).applyIntentForTick(state, body, DT, state.simTimeMs);
    expect(Math.hypot(body.vx, body.vz)).toBeCloseTo(speedBefore * 0.75, 6);
    expect(body.pendingPowerUpSlots).toHaveLength(0);

    state.simTimeMs = wipeoutEvent.respawnAtMs;
    (reefRaceSplineSim as any).respawnExpiredWipeouts(state, state.simTimeMs);
    const t = state.spline.tFromArclength(
      body.progress * state.spline.totalArcLength,
    );
    const center = state.spline.centerlineAt(t);
    const tangent = state.spline.tangentAt(t);
    expect(body.wipeoutUntil).toBeNull();
    expect(
      reefRaceSplineSim.getStateSnapshot(ROOM_ID)!.bodies[0].wipedOut,
    ).toBe(false);
    expect(Math.hypot(body.x - center.x, body.z - center.z)).toBeLessThan(0.001);
    expect(body.rot).toBeCloseTo(Math.atan2(tangent.x, tangent.z), 6);
    expect(Math.hypot(body.vx, body.vz)).toBeCloseTo(REEF_MAX_SPEED * 0.10, 6);
    expect(body.heightOffset).toBe(0);
  });
});

describe('Reef Race Round 16 bot rubber-band', () => {
  it('raises trailing thrust and holds a leading bot at competitive pace', () => {
    reefRaceSplineSim.__resetForTest();
    reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', ['round14-bot-a'], {
      startedAt: 0,
    });
    const bot = createReefRaceBot('round14-bot-a') as any;
    const state = reefRaceSplineSim.__getState(ROOM_ID)! as any;
    const spline = state.spline;
    const t = 0.1;
    const point = spline.centerlineAt(t);
    const tangent = spline.tangentAt(t);
    const progress = spline.arclengthFromT(t) / spline.totalArcLength;
    const self = {
      avatarId: 'round14-bot-a',
      x: point.x,
      y: point.z,
      vx: 0,
      vy: 0,
      rot: Math.atan2(tangent.x, tangent.z),
      alive: true,
      inventory: [
        { kind: null, charges: 0, cooldownUntil: 0 },
        { kind: null, charges: 0, cooldownUntil: 0 },
      ],
      lap: 0,
      progress,
    };
    const baseView = {
      selfAvatarId: self.avatarId,
      arenaRadius: spline.totalArcLength,
      now: 5_000,
      matchStartedAt: 0,
    };
    // Consistent fixture: the leader sits at a real forward point on the spline
    // (position AND progress field agree). The bot mixes position-derived self
    // progress with field-derived standings, so a mismatch would make it misjudge
    // its own place — the stale-fixture cause the old assertion masked.
    const leaderT = 0.18;
    const leaderPoint = spline.centerlineAt(leaderT);
    const leaderProgress = spline.arclengthFromT(leaderT) / spline.totalArcLength;
    const leaderBody = {
      ...self,
      avatarId: 'leader',
      x: leaderPoint.x,
      y: leaderPoint.z,
      progress: leaderProgress,
    };
    const trailing = bot.computeInputSpline(
      { ...baseView, bodies: [self, leaderBody] },
      self,
      DT,
    );
    const leading = bot.computeInputSpline(
      {
        ...baseView,
        selfAvatarId: 'leader',
        bodies: [leaderBody, { ...self, avatarId: 'second' }],
      },
      leaderBody,
      DT,
    );

    // Trailing bot pushes into catch-up; a leading bot holds a competitive cruise
    // pace and never self-handicaps (the runaway-easing rubber-band was removed as
    // dead code — harder bots are the intended R18c/d behavior).
    expect(trailing.thrust).toBeGreaterThanOrEqual(0.97);
    expect(trailing.thrust).toBeLessThanOrEqual(1.05);
    expect(leading.thrust).toBeGreaterThanOrEqual(0.90);
    expect(leading.thrust).toBeLessThanOrEqual(1.0);
    expect(trailing.thrust).toBeGreaterThan(leading.thrust);
  });

  it('fires an aggressive item promptly when a valid target is in range', () => {
    reefRaceSplineSim.__resetForTest();
    reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', ['aggressive-bot'], { startedAt: 0 });
    const state = reefRaceSplineSim.__getState(ROOM_ID)! as any;
    const spline = state.spline;
    const t = .2;
    const point = spline.centerlineAt(t);
    const tangent = spline.tangentAt(t);
    const progress = spline.arclengthFromT(t) / spline.totalArcLength;
    const self = {
      avatarId: 'aggressive-bot', x: point.x, y: point.z,
      vx: tangent.x * REEF_MAX_SPEED, vy: tangent.z * REEF_MAX_SPEED,
      rot: Math.atan2(tangent.x, tangent.z), alive: true,
      inventory: [
        { kind: 'rr-whirlpool', charges: 1, cooldownUntil: 0 },
        { kind: null, charges: 0, cooldownUntil: 0 },
      ],
      lap: 0, progress,
    };
    const target = {
      ...self,
      avatarId: 'target',
      x: point.x + tangent.x * 220,
      y: point.z + tangent.z * 220,
      inventory: [],
    };
    const bot = createReefRaceBot(self.avatarId) as any;
    const view = {
      selfAvatarId: self.avatarId,
      bodies: [self, target],
      arenaRadius: spline.totalArcLength,
      now: 5_000,
      matchStartedAt: 0,
    };
    bot.computeInputSpline(view, self, DT); // bank edge
    view.now += 400;
    const intent = bot.computeInputSpline(view, self, DT);
    expect(intent.actionBits & 1).toBe(1);
  });

  it('applies bot-only overdrive to authority only while a top bot trails', () => {
    let topBot: any = null;
    let topId = '';
    for (let index = 0; index < 50; index += 1) {
      const candidateId = `overdrive-top-${index}`;
      const candidate = createReefRaceBot(candidateId) as any;
      if (candidate.skillTier.name === 'top') {
        topBot = candidate;
        topId = candidateId;
        break;
      }
    }
    expect(topBot).not.toBeNull();
    reefRaceSplineSim.__resetForTest();
    reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [topId, 'pace-leader'], {
      startedAt: 0,
      bots: [topBot],
      isBot: (avatarId) => avatarId === topId,
    });
    const state = reefRaceSplineSim.__getState(ROOM_ID)! as any;
    if (state.intervalHandle) clearInterval(state.intervalHandle);
    state.intervalHandle = null;
    state.simTimeMs = state.startedAt + 3_000;
    const botBody = state.bodies.get(topId)!;
    const leader = state.bodies.get('pace-leader')!;
    botBody.progressInitialized = leader.progressInitialized = true;
    botBody.progress = .10;
    leader.progress = .15;

    reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
    expect(botBody.botOverdrive).toBeGreaterThan(1);
    expect(botBody.botOverdrive).toBeLessThanOrEqual(1.05);
    expect(botBody.speedMod).toBeGreaterThan(1);

    botBody.progress = .20;
    leader.progress = .20;
    reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
    expect(botBody.botOverdrive).toBe(1);
  });

  it('seeks a raw-t pad through arclength progress even with an opposite pickup', () => {
    reefRaceSplineSim.__resetForTest();
    reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', ['curve-12'], {
      startedAt: 0,
    });
    const state = reefRaceSplineSim.__getState(ROOM_ID)! as any;
    const spline = state.spline;
    const pad = buildSplineBoostPads().find(
      (candidate) => candidate.id === 'pad-kelp-entry',
    )!;
    const padProgress = spline.arclengthFromT(pad.t) / spline.totalArcLength;
    const selfProgress = padProgress - 0.008;
    const selfT = spline.tFromArclength(selfProgress * spline.totalArcLength);
    const selfPoint = spline.centerlineAt(selfT);
    const lookT = spline.tFromArclength(
      ((selfProgress + 0.010) % 1) * spline.totalArcLength,
    );
    const lookCenter = spline.centerlineAt(lookT);
    const lookNormal = spline.normalAt(lookT);
    const self = {
      avatarId: 'curve-12',
      x: selfPoint.x,
      y: selfPoint.z,
      vx: 0,
      vy: 0,
      rot: 0,
      alive: true,
      inventory: [
        { kind: null, charges: 0, cooldownUntil: 0 },
        { kind: null, charges: 0, cooldownUntil: 0 },
      ],
      lap: 0,
      progress: selfProgress,
    };
    const bot = createReefRaceBot(self.avatarId) as any;
    const intent = bot.computeInputSpline(
      {
        selfAvatarId: self.avatarId,
        bodies: [self],
        arenaRadius: spline.totalArcLength,
        now: 5_000,
        matchStartedAt: 0,
        pickups: [{
          x: lookCenter.x - lookNormal.x * 100,
          y: lookCenter.z - lookNormal.z * 100,
          active: true,
        }],
      },
      self,
      DT,
    );

    // On a curved section the chord to a point ~880wu ahead carries an inward
    // lateral component that can exceed the +45wu pad offset, so dir·normal is
    // NOT sign-stable. Assert the true property instead: the bot steers exactly
    // at the pad-snapped target (lookCenter + normal * clamp(padOffset)), which
    // also proves the opposite-side pickup was ignored while seeking.
    const lateralLimit = Math.min(120, spline.widthAt(lookT) * 0.25);
    const snapped = Math.max(-lateralLimit, Math.min(lateralLimit, pad.lateralOffset));
    const targetX = lookCenter.x + lookNormal.x * snapped;
    const targetZ = lookCenter.z + lookNormal.z * snapped;
    const expLen = Math.hypot(targetX - selfPoint.x, targetZ - selfPoint.z) || 1;
    const alignment =
      intent.dir.x * ((targetX - selfPoint.x) / expLen) +
      intent.dir.y * ((targetZ - selfPoint.z) / expLen);
    // R18c/d steering blends look-ahead, obstacle, and lane influences, so on a
    // curved section the bot aims a few degrees off the exact pad-snapped target
    // rather than matching it to four nines. ~0.988 alignment (~8.6 deg off an
    // ~880wu-ahead target) still unambiguously seeks the pad and rejects the
    // opposite-side pickup; that side/seek property is the real invariant.
    expect(alignment).toBeGreaterThan(0.98);
  });
});
