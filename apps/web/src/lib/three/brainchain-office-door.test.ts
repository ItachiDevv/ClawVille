import { getAllColliders, clampMovement2D } from './collision/world-colliders';
import { getServerColliders, buildingEdgeDistanceGamePx } from '@clawville/shared';
import { describe, expect, test } from 'bun:test';
import { OFFICE_CENTER, OFFICE_NORMAL, OFFICE_EXIT_WORLD, OFFICE_VORTEX_WORLD, isInsideOfficeVortex,
  stepOfficeDoorEdge, recordOfficeLocomotion, consumeOfficeLocomotion, setOfficeReturnFacing, consumeOfficeReturnFacing, OFFICE_YAW, type OfficeDoorEdge } from './brainchain-office-door';
const point = (depth: number, side = 0) => ({
  x: OFFICE_CENTER.x + OFFICE_NORMAL.x * depth + OFFICE_NORMAL.z * side,
  z: OFFICE_CENTER.z + OFFICE_NORMAL.z * depth - OFFICE_NORMAL.x * side,
});
const fresh = (): OfficeDoorEdge => ({ initialized: false, inside: false, allowed: false, x: 0, z: 0 });
const sample = (edge: OfficeDoorEdge, depth: number, allowed = true, walked = true) => {
  const p = point(depth); return stepOfficeDoorEdge(edge, p.x, p.z, allowed, walked);
};
describe('BrainChain vortex door', () => {
  test('front approach is in the volume; side, rear and exit points are outside', () => {
    const front = point(470), side = point(470, 200), rear = point(-470);
    expect(isInsideOfficeVortex(front.x, front.z)).toBe(true);
    expect(isInsideOfficeVortex(side.x, side.z)).toBe(false);
    expect(isInsideOfficeVortex(rear.x, rear.z)).toBe(false);
    expect(isInsideOfficeVortex(OFFICE_EXIT_WORLD.x, OFFICE_EXIT_WORLD.z)).toBe(false);

    expect(OFFICE_VORTEX_WORLD.radius).toBeCloseTo(269.097, 2);
  });
  test('fires once on a continuous entry and re-arms only after exit', () => {
    const edge = fresh();
    expect(sample(edge, 530)).toBe(false);
    expect(sample(edge, 490)).toBe(true);
    expect(sample(edge, 470)).toBe(false);
    expect(sample(edge, 530)).toBe(false);
    expect(sample(edge, 490)).toBe(true);
  });
  test('starting inside does not fire', () => {
    const edge = fresh(); expect(sample(edge, 470)).toBe(false); expect(sample(edge, 460)).toBe(false);
  });
  test('blocked crossings do not fire when input resumes', () => {
    const edge = fresh(); sample(edge, 530);
    expect(sample(edge, 490, false)).toBe(false); expect(sample(edge, 470)).toBe(false);
  });
  test('a placement jump does not fire', () => {
    const edge = fresh(); sample(edge, 1200); expect(sample(edge, 470)).toBe(false);
    expect(sample(edge, 460)).toBe(false);
  });
  test('a short placement cannot enter without a matching local movement segment', () => {
    const edge = fresh(); sample(edge, 530);
    const from = point(530), placed = point(490);
    expect(consumeOfficeLocomotion(from.x, from.z, placed.x, placed.z)).toBe(false);
    expect(sample(edge, 490, true, false)).toBe(false);
    recordOfficeLocomotion(placed.x, placed.z, point(470).x, point(470).z);
    expect(consumeOfficeLocomotion(from.x, from.z, point(470).x, point(470).z)).toBe(false);
    recordOfficeLocomotion(from.x, from.z, placed.x, placed.z);
    expect(consumeOfficeLocomotion(from.x, from.z, placed.x, placed.z)).toBe(true);
    expect(consumeOfficeLocomotion(from.x, from.z, placed.x, placed.z)).toBe(false);
  });
  test('mode switch into the volume does not fire', () => {
    const edge = fresh(); sample(edge, 530, false);
    expect(sample(edge, 490)).toBe(false); expect(sample(edge, 470)).toBe(false);
  });
  test('the Office retains its full interaction footprint for human and agent gates', () => {
    // Office game-pixel centre is 14880,13344. Original extent includes 28 wu padding.
    expect(buildingEdgeDistanceGamePx(14880, 13344 - 1100, 'api-integrations')).toBe(337);
    expect(buildingEdgeDistanceGamePx(14880 - 1000, 13344, 'api-integrations')).toBe(293);
    expect(buildingEdgeDistanceGamePx(14880, 13344, 'api-integrations')).toBe(0);
  });
  test('client and server use the same corridor walls', () => {
    const client = getAllColliders().filter(c => c.id.startsWith('api-integrations')).map(({ kind, ...c }) => c);
    const server = getServerColliders().filter(c => c.id.startsWith('api-integrations'));
    expect(client).toEqual(server);
  });
  test('real collision admits entry and stops repeated movement before the facade', () => {
    for (const radius of [45, 50]) {
      let previous = point(1000), reached = false, stopped = false;
      for (let frame = 0; frame < 300; frame++) {
        const next = { x: previous.x - OFFICE_NORMAL.x * 5, z: previous.z - OFFICE_NORMAL.z * 5 };
        const result = clampMovement2D(previous.x, previous.z, next.x, next.z, radius);
        if (isInsideOfficeVortex(result.x, result.z)) reached = true;
        const depth = (result.x - OFFICE_CENTER.x) * OFFICE_NORMAL.x + (result.z - OFFICE_CENTER.z) * OFFICE_NORMAL.z;
        expect(depth).toBeGreaterThan(350);
        if (result.hit) stopped = true;
        previous = { x: result.x, z: result.z };
      }
      expect(reached).toBe(true); expect(stopped).toBe(true);
    }
  });
  test('every straight walk up the corridor crosses the trigger, not only the centre line', () => {
    for (let side = -150; side <= 150; side += 25) {
      let previous = point(1000, side), reached = false, deepest = Infinity;
      for (let frame = 0; frame < 300; frame++) {
        const next = { x: previous.x - OFFICE_NORMAL.x * 5, z: previous.z - OFFICE_NORMAL.z * 5 };
        const result = clampMovement2D(previous.x, previous.z, next.x, next.z, 45);
        if (isInsideOfficeVortex(result.x, result.z)) reached = true;
        deepest = Math.min(deepest, (result.x - OFFICE_CENTER.x) * OFFICE_NORMAL.x + (result.z - OFFICE_CENTER.z) * OFFICE_NORMAL.z);
        previous = { x: result.x, z: result.z };
      }
      // A path that gets past the trigger's near edge must have crossed the trigger.
      if (deepest < 420) expect(reached).toBe(true);
    }
  });
  test('exit facing overrides the controller once', () => {
    setOfficeReturnFacing(); expect(consumeOfficeReturnFacing()).toBe(OFFICE_YAW);
    expect(consumeOfficeReturnFacing()).toBeNull();
  });
});
