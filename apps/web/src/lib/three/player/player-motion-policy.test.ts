import { describe, expect, test } from 'bun:test';
import { KELP_REALM_WALL_AABBS } from '@clawville/shared';
import {
  clampKelpRealmMovement2D,
} from '@/lib/three/kelp-realm-player';
import {
  KELP_POLICY,
  WORLD_GLB_POLICY,
  WORLD_VRM_POLICY,
} from './player-motion-policy';

const TUNNEL_TEST_SPEED = 2_000;
const PLAYER_RADIUS = 34;

function findTwoSidedWall() {
  const occupied = new Set(
    KELP_REALM_WALL_AABBS.map((wall) => `${wall.row}:${wall.col}`),
  );
  const wall = KELP_REALM_WALL_AABBS.find(
    (candidate) =>
      candidate.row > 1 &&
      candidate.row < 19 &&
      candidate.col > 1 &&
      candidate.col < 19 &&
      !occupied.has(`${candidate.row}:${candidate.col - 1}`) &&
      !occupied.has(`${candidate.row}:${candidate.col + 1}`),
  );
  if (!wall) throw new Error('expected a two-sided kelp wall');
  return wall;
}

function moveThroughWall(
  rawDelta: number,
  maxDeltaSeconds: number | undefined,
) {
  const wall = findTwoSidedWall();
  const startX = wall.centerX - wall.halfX - PLAYER_RADIUS - 1;
  const startZ = wall.centerZ;
  const integrationDelta =
    maxDeltaSeconds === undefined
      ? rawDelta
      : Math.min(rawDelta, maxDeltaSeconds);
  const out = { x: 0, z: 0 };
  clampKelpRealmMovement2D(
    startX,
    startZ,
    startX + TUNNEL_TEST_SPEED * integrationDelta,
    startZ,
    out,
  );
  return { out, startX, farEdge: wall.centerX + wall.halfX + PLAYER_RADIUS };
}

describe('player motion policies', () => {
  test('WORLD_VRM_POLICY pins every frozen literal', () => {
    expect(WORLD_VRM_POLICY).toEqual({
      motion: {
        maxDeltaSeconds: undefined,
        facing: { kind: 'fixedFraction', fraction: 0.15 },
        initialFacing: Math.PI,
        resetFacingOnActivation: false,
        chargeDiscrimination: true,
      },
      input: {
        composition: 'storeJoystickPrecedence',
        readsStoreJoystick: true,
        readsSharedTouch: false,
        keyIdentity: 'key',
        keyTargetGuard: 'isEditable',
        preventArrowDefault: false,
        movementEpsilon: 0,
      },
    });
  });

  test('WORLD_GLB_POLICY pins every frozen literal', () => {
    expect(WORLD_GLB_POLICY).toEqual({
      motion: {
        maxDeltaSeconds: undefined,
        facing: { kind: 'fixedFraction', fraction: 0.15 },
        initialFacing: 0,
        resetFacingOnActivation: false,
        chargeDiscrimination: false,
      },
      input: WORLD_VRM_POLICY.input,
    });
  });

  test('KELP_POLICY pins every frozen literal', () => {
    expect(KELP_POLICY).toEqual({
      motion: {
        maxDeltaSeconds: 0.1,
        facing: { kind: 'exponentialRate', rate: 10 },
        initialFacing: Math.PI,
        resetFacingOnActivation: true,
        chargeDiscrimination: false,
      },
      input: {
        composition: 'additive',
        readsStoreJoystick: false,
        readsSharedTouch: true,
        keyIdentity: 'code',
        keyTargetGuard: 'none',
        preventArrowDefault: true,
        movementEpsilon: 0.001,
      },
    });
  });

  test('maxDeltaSeconds 0.1 clamps 0.5 while undefined integrates raw', () => {
    expect(Math.min(0.5, KELP_POLICY.motion.maxDeltaSeconds!)).toBe(0.1);
    expect(WORLD_VRM_POLICY.motion.maxDeltaSeconds ?? 0.5).toBe(0.5);
  });

  test('a clamped 0.5 second move cannot tunnel the kelp wall slab', () => {
    const result = moveThroughWall(0.5, KELP_POLICY.motion.maxDeltaSeconds);
    expect(result.out.x).toBe(result.startX);
  });

  test('a clamped 1.0 second move cannot tunnel the kelp wall slab', () => {
    const result = moveThroughWall(1, KELP_POLICY.motion.maxDeltaSeconds);
    expect(result.out.x).toBe(result.startX);
  });

  test('the same 0.5 second move tunnels when maxDeltaSeconds is undefined', () => {
    const result = moveThroughWall(0.5, undefined);
    expect(result.out.x).toBeGreaterThan(result.farEdge);
  });

  test('fixed fraction reproduces the live formula bit-for-bit', () => {
    for (const [difference, delta] of [[1.234, 0.016], [-5.7, 0.5], [0, 1]]) {
      void delta;
      expect(
        difference * WORLD_VRM_POLICY.motion.facing.fraction,
      ).toBe(difference * 0.15);
    }
  });

  test('exponential rate reproduces the live formula bit-for-bit', () => {
    for (const [difference, delta] of [[1.234, 0.016], [-5.7, 0.5], [0, 1]]) {
      expect(
        difference *
          (1 - Math.exp(-KELP_POLICY.motion.facing.rate * delta)),
      ).toBe(difference * (1 - Math.exp(-10 * delta)));
    }
  });

  test('initialFacing seeds all three initial arms', () => {
    expect([
      WORLD_VRM_POLICY.motion.initialFacing,
      WORLD_GLB_POLICY.motion.initialFacing,
      KELP_POLICY.motion.initialFacing,
    ]).toEqual([Math.PI, 0, Math.PI]);
  });

  test('activation preserves world facing and resets kelp facing', () => {
    const priorFacing = 0.73;
    const worldFacing = WORLD_VRM_POLICY.motion.resetFacingOnActivation
      ? WORLD_VRM_POLICY.motion.initialFacing
      : priorFacing;
    const kelpFacing = KELP_POLICY.motion.resetFacingOnActivation
      ? KELP_POLICY.motion.initialFacing
      : priorFacing;
    expect(worldFacing).toBe(priorFacing);
    expect(kelpFacing).toBe(Math.PI);
  });
});
