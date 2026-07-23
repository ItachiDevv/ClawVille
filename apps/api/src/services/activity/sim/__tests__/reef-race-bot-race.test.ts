import { beforeEach, describe, expect, it, mock } from 'bun:test';

// This file owns the spline-bot integration gate, so set the feature flag
// before dynamically importing config/controller modules that read it once.
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
const { REEF_MAX_SPEED, REEF_TICK_MS } = await import('../reef-race-config');

const ROOM_ID = 'round-14-bot-room';
const BOT_IDS = ['round14-bot-a', 'round14-bot-b', 'round14-bot-c', 'round14-bot-d'];

function wrappedProgressDelta(current: number, previous: number): number {
  const raw = current - previous;
  if (raw < -0.5) return raw + 1;
  if (raw > 0.5) return raw - 1;
  return raw;
}

describe('Reef Race Round 14 bot race', () => {
  beforeEach(() => {
    reefRaceSplineSim.__resetForTest();
  });

  it('recovers a bot stalled for four seconds using arclength progress and track heading', () => {
    const stalledController = {
      activityId: 'reef-race',
      avatarId: BOT_IDS[0],
      computeInput: () => ({ dir: { x: 0, y: 0 }, thrust: 0, actionBits: 0 }),
    };
    reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [BOT_IDS[0]], {
      bots: [stalledController],
      isBot: () => true,
      startedAt: 0,
    });
    const state = reefRaceSplineSim.__getState(ROOM_ID)!;
    const body = state.bodies.get(BOT_IDS[0])!;

    reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
    const t = state.spline.tFromArclength(body.progress * state.spline.totalArcLength);
    const center = state.spline.centerlineAt(t);
    const normal = state.spline.normalAt(t);
    body.x = center.x + normal.x * state.spline.widthAt(t);
    body.z = center.z + normal.z * state.spline.widthAt(t);
    body.vx = 0;
    body.vz = 0;
    body.heightOffset = 20;
    body.vyAxis = 50;
    body.airborneTicks = 5;

    for (let i = 0; i < 120; i += 1) {
      reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
    }

    const recoveredT = state.spline.tFromArclength(
      body.progress * state.spline.totalArcLength,
    );
    const recoveredCenter = state.spline.centerlineAt(recoveredT);
    const recoveredTangent = state.spline.tangentAt(recoveredT);
    expect(Math.hypot(body.x - recoveredCenter.x, body.z - recoveredCenter.z)).toBeLessThan(10);
    expect(body.rot).toBeCloseTo(Math.atan2(recoveredTangent.x, recoveredTangent.z), 6);
    expect(Math.hypot(body.vx, body.vz)).toBeCloseTo(REEF_MAX_SPEED * 0.12, 4);
    expect(body.heightOffset).toBe(0);
    expect(body.vyAxis).toBe(0);
    expect(body.airborneTicks).toBe(0);
  });

  it('uses and consumes a banked turbo after the deterministic delay', () => {
    const originalRandom = Math.random;
    Math.random = () => 0; // always falls inside the placement-weighted chance
    try {
      const bot = createReefRaceBot(BOT_IDS[0]);
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [BOT_IDS[0]], {
        bots: [bot],
        isBot: () => true,
        startedAt: 0,
      });
      const state = reefRaceSplineSim.__getState(ROOM_ID)!;
      const body = state.bodies.get(BOT_IDS[0])!;
      body.inventory[0] = {
        kind: 'rr-turbo-bubble',
        charges: 1,
        cooldownUntil: 0,
      };
      for (const pickup of state.pickups) {
        pickup.active = false;
        pickup.respawnAt = Number.POSITIVE_INFINITY;
      }

      let usedAtTick: number | null = null;
      for (let tick = 1; tick <= 120; tick += 1) {
        reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
        if (body.activeEffects.has('rr-turbo-bubble')) {
          usedAtTick = tick;
          break;
        }
        if (tick === 45) {
          expect(body.inventory[0]?.kind).toBe('rr-turbo-bubble');
        }
      }

      expect(usedAtTick).not.toBeNull();
      expect(usedAtTick!).toBeGreaterThanOrEqual(60); // never before 2.0s
      expect(usedAtTick!).toBeLessThanOrEqual(105);   // hashed delay max 3.44s
      expect(body.inventory[0]?.kind).toBeNull();
      expect(body.activeEffects.has('rr-turbo-bubble')).toBe(true);
    } finally {
      Math.random = originalRandom;
    }
  });

  it('sequentially consumes both double-box items through repeated bit-zero promotion', () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const bot = createReefRaceBot(BOT_IDS[0]);
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [BOT_IDS[0]], {
        bots: [bot],
        isBot: () => true,
        startedAt: 0,
      });
      const state = reefRaceSplineSim.__getState(ROOM_ID)!;
      const body = state.bodies.get(BOT_IDS[0])!;
      const doubleBox = state.pickups[0]!;
      doubleBox.variant = 'double';
      doubleBox.position = { x: body.x, z: body.z };
      reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
      expect(body.inventory.every((slot) => slot.kind !== null)).toBe(true);
      for (const pickup of state.pickups) {
        pickup.active = false;
        pickup.respawnAt = Number.POSITIVE_INFINITY;
      }

      for (let tick = 1; tick <= 300; tick += 1) {
        reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
        if (body.inventory.every((slot) => slot.kind === null)) break;
      }

      expect(body.inventory[0]?.kind).toBeNull();
      expect(body.inventory[1]?.kind).toBeNull();
    } finally {
      Math.random = originalRandom;
    }
  });

  it('does not reach around a blocked slot-zero Remora to consume slot one', () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const bot = createReefRaceBot(BOT_IDS[0]);
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', BOT_IDS, {
        bots: [bot],
        isBot: (avatarId) => avatarId === BOT_IDS[0],
        startedAt: 0,
      });
      const state = reefRaceSplineSim.__getState(ROOM_ID)!;
      const progresses = [0.20, 0.40, 0.10, 0.05];
      for (let index = 0; index < BOT_IDS.length; index += 1) {
        const racer = state.bodies.get(BOT_IDS[index]!)!;
        const progress = progresses[index]!;
        const t = state.spline.tFromArclength(progress * state.spline.totalArcLength);
        const center = state.spline.centerlineAt(t);
        const tangent = state.spline.tangentAt(t);
        racer.x = center.x;
        racer.z = center.z;
        racer.rot = Math.atan2(tangent.x, tangent.z);
        racer.vx = 0;
        racer.vz = 0;
        racer.progress = progress;
        racer.prevProgress = progress;
      }
      const body = state.bodies.get(BOT_IDS[0])!;
      body.inventory[0] = { kind: 'rr-remora-rocket', charges: 1, cooldownUntil: 0 };
      body.inventory[1] = { kind: 'rr-turbo-bubble', charges: 1, cooldownUntil: 0 };
      for (const pickup of state.pickups) {
        pickup.active = false;
        pickup.respawnAt = Number.POSITIVE_INFINITY;
      }

      for (let tick = 0; tick < 120; tick += 1) {
        reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
      }

      expect(body.remoraUntilMs).toBe(0);
      expect(body.inventory[0]?.kind).toBe('rr-remora-rocket');
      expect(body.inventory[1]?.kind).toBe('rr-turbo-bubble');
      expect(body.activeEffects.has('rr-turbo-bubble')).toBe(false);
    } finally {
      Math.random = originalRandom;
    }
  });

  it('runs 5400 bot-only ticks: every bot laps, pads fire, and progress does not stall', () => {
    const originalRandom = Math.random;
    let randomState = 0x18d5_cafe;
    Math.random = () => {
      randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
      return randomState / 0x1_0000_0000;
    };
    let creatureNowMs = 0;
    reefRaceSplineSim.__setCreatureClockForTest(() => creatureNowMs);

    try {
      const events: Array<{
        type: string;
        avatarId?: string;
        phase?: string;
        attackerAvatarId?: string;
        victimAvatarId?: string;
      }> = [];
      const swapTeleports = new Set<string>();
      reefRaceSplineSim.setBroadcastFn((_roomId, frame) => {
        const event = frame as (typeof events)[number];
        events.push(event);
        if (event.type === 'event.current_swap' && event.phase === 'resolved') {
          if (event.attackerAvatarId) swapTeleports.add(event.attackerAvatarId);
          if (event.victimAvatarId) swapTeleports.add(event.victimAvatarId);
        }
      });
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', BOT_IDS, {
        bots: BOT_IDS.map((id) => createReefRaceBot(id)),
        isBot: () => true,
        startedAt: 0,
      });
      const state = reefRaceSplineSim.__getState(ROOM_ID)!;
      const last = new Map<string, number>();
      const accumulated = new Map<string, number>();
      const lastAdvanceTick = new Map<string, number>();
      const maxStagnantTicks = new Map<string, number>();
      const maxLap = new Map<string, number>();

      for (let tick = 0; tick < 5_400; tick += 1) {
        creatureNowMs += REEF_TICK_MS;
        reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
        for (const id of BOT_IDS) {
          const body = state.bodies.get(id)!;
          maxLap.set(id, Math.max(maxLap.get(id) ?? 0, body.lap));
          if (body.finishedAt !== null || body.dnf || !body.alive) continue;
          if (swapTeleports.delete(id)) {
            // A current-swap hard-seeds a different race position. Reset only the
            // watchdog baseline; the unchanged <=122 limit still catches a real
            // post-teleport movement wedge.
            last.set(id, body.progress);
            accumulated.set(`${id}:mark`, accumulated.get(id) ?? 0);
            lastAdvanceTick.set(id, tick);
            continue;
          }
          const previous = last.get(id);
          if (previous !== undefined) {
            const total = (accumulated.get(id) ?? 0) +
              wrappedProgressDelta(body.progress, previous);
            accumulated.set(id, total);
            if (total - (accumulated.get(`${id}:mark`) ?? 0) >= 0.002) {
              accumulated.set(`${id}:mark`, total);
              lastAdvanceTick.set(id, tick);
            }
            maxStagnantTicks.set(
              id,
              Math.max(maxStagnantTicks.get(id) ?? 0, tick - (lastAdvanceTick.get(id) ?? tick)),
            );
          } else {
            accumulated.set(id, 0);
            accumulated.set(`${id}:mark`, 0);
            lastAdvanceTick.set(id, tick);
          }
          last.set(id, body.progress);
        }
        if (state.ended) break;
      }

      for (const id of BOT_IDS) {
        expect(maxLap.get(id) ?? 0).toBeGreaterThanOrEqual(1);
        expect(accumulated.get(id) ?? 0).toBeGreaterThan(1);
        expect(maxStagnantTicks.get(id) ?? 0).toBeLessThanOrEqual(122);
      }
      expect(events.some((event) => event.type === 'event.boost_pad')).toBe(true);
      expect(events.some((event) => event.type === 'event.power_up_collected')).toBe(true);
      expect(
        events.some((event) => event.type === 'event.wave_sweep' && event.phase === 'active'),
      ).toBe(true);
    } finally {
      Math.random = originalRandom;
      reefRaceSplineSim.__setCreatureClockForTest();
    }
  }, 45_000);
});
