import { describe, expect, it } from 'bun:test';
import {
  buildReefRaceFurniture,
  REEF_RACE_DEFAULT_TRACK,
  REEF_RACE_RAMP_AFTER_CLEAN_WU,
  ReefSpline,
} from '@clawville/shared';
import { buildSplineRamps } from '../reef-race-config';

const spline = new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true });

describe('Reef Race R18c seeded furniture', () => {
  it('is stable for one seed and varies across two seeds', () => {
    const first = buildReefRaceFurniture(18_001);
    const repeated = buildReefRaceFurniture(18_001);
    const second = buildReefRaceFurniture(18_002);

    expect(repeated).toEqual(first);
    expect(second.obstacles.map((obstacle) => obstacle.id)).not.toEqual(
      first.obstacles.map((obstacle) => obstacle.id),
    );
    expect(first.obstacles.length).toBeGreaterThanOrEqual(10);
    expect(first.obstacles.length).toBeLessThanOrEqual(14);
    expect(first.ripCurrents.length).toBeGreaterThanOrEqual(2);
    expect(first.ripCurrents.length).toBeLessThanOrEqual(3);
  });

  it('keeps the start straight and 300wu after every ramp clean', () => {
    for (const seed of [1, 42, 18_001, 18_002, 0xffff_fffe]) {
      const layout = buildReefRaceFurniture(seed);
      const obstacleArcs = layout.obstacles.map(
        (obstacle) => obstacle.progress * spline.totalArcLength,
      );
      for (const obstacleArc of obstacleArcs) {
        expect(obstacleArc).toBeGreaterThanOrEqual(1_800);
      }
      for (const ramp of buildSplineRamps()) {
        const rampArc = spline.arclengthFromT(ramp.t);
        for (const obstacleArc of obstacleArcs) {
          const forward = (
            (obstacleArc - rampArc) % spline.totalArcLength +
            spline.totalArcLength
          ) % spline.totalArcLength;
          expect(forward).toBeGreaterThan(REEF_RACE_RAMP_AFTER_CLEAN_WU);
        }
      }
    }
  });

  it('pins the server ramp anchors to the shared exclusion list', async () => {
    expect(buildSplineRamps().map((ramp) => ramp.t)).toEqual([
      .070, .135, .360, .450, .775, .900,
    ]);
  });

  it('sweeps 100 seeds without count/exclusion failures and spans sectors', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const layout = buildReefRaceFurniture(seed);
      expect(layout.obstacles.length).toBeGreaterThanOrEqual(10);
      expect(layout.obstacles.length).toBeLessThanOrEqual(14);
      const sectors = new Set(
        layout.obstacles.map((obstacle) => Math.floor(obstacle.progress * 5) % 5),
      );
      expect(sectors.size).toBeGreaterThanOrEqual(3);
    }
  });
});
