import { beforeEach, describe, expect, it } from 'bun:test';
import {
  EMPTY_DROP_SET,
  KIT_SUBMITTED_TRIANGLE_BUDGET,
  KIT_VISIBLE_DRAW_BUDGET,
  __resetSourcePricingForTest,
  admitsChunk,
  computeChunkDrop,
  getSourcePricingRevision,
  priceKitSource,
  residualCost,
  sameMembers,
  subscribeSourcePricing,
  triangleCostOf,
  type ParcelCost,
} from './land-kit-admission';

/**
 * A chunk of `count` parcels, each `triangles` heavy, ordered so parcel 0 is
 * nearest the camera and the last is farthest.
 */
function chunk(count: number, triangles: number, keysPerParcel = 4): ParcelCost[] {
  return Array.from({ length: count }, (_, index) => ({
    parcelCode: `parcel-starter-${String(index).padStart(2, '0')}`,
    triangles,
    pieceKeys: Array.from({ length: keysPerParcel }, (_, k) => `key-${k}`),
    distanceSq: (index + 1) * 1_000_000,
  }));
}

/**
 * Drive the decision the way the render loop does: feed each result back in as
 * the next call's `previousDropped`, with `basisChanged` false because only the
 * camera moved.
 */
function settle(
  parcels: readonly ParcelCost[],
  nearestParcelCode: string | null,
  iterations: number,
): { readonly history: ReadonlySet<string>[]; readonly writes: number } {
  const history: ReadonlySet<string>[] = [];
  let current: ReadonlySet<string> = EMPTY_DROP_SET;
  let writes = 0;
  for (let i = 0; i < iterations; i++) {
    const next = computeChunkDrop({
      parcels,
      nearestParcelCode,
      previousDropped: current,
      // Only the first evaluation sees new data; the rest are camera drift.
      basisChanged: i === 0,
    });
    if (!sameMembers(next, current)) writes++;
    current = next;
    history.push(current);
  }
  return { history, writes };
}

describe('chunk admission', () => {
  it('admits the nearest chunk unconditionally, whatever it costs', () => {
    const monstrous = { draws: 999, triangles: 10_000_000 };
    expect(admitsChunk(0, monstrous, { draws: 0, triangles: 0 })).toBe(true);
  });

  it('refuses a further chunk that would break either budget', () => {
    const admitted = { draws: 50, triangles: 200_000 };
    expect(admitsChunk(1, { draws: 11, triangles: 1_000 }, admitted)).toBe(false);
    expect(admitsChunk(1, { draws: 1, triangles: 60_000 }, admitted)).toBe(false);
    expect(admitsChunk(1, { draws: 10, triangles: 50_000 }, admitted)).toBe(true);
  });

  it('accepts the phone profile ceilings without changing desktop defaults', () => {
    const admitted = { draws: 10, triangles: 20_000 };
    expect(
      admitsChunk(
        1,
        { draws: 20, triangles: 100_000 },
        admitted,
        30,
        120_000,
      ),
    ).toBe(true);
    expect(
      admitsChunk(
        1,
        { draws: 21, triangles: 100_000 },
        admitted,
        30,
        120_000,
      ),
    ).toBe(false);
  });
});

describe('residualCost', () => {
  it('counts distinct keys across parcels, not per-parcel keys', () => {
    const parcels: ParcelCost[] = [
      { parcelCode: 'a', triangles: 10, pieceKeys: ['x', 'y'], distanceSq: 1 },
      { parcelCode: 'b', triangles: 20, pieceKeys: ['y', 'z'], distanceSq: 2 },
    ];
    expect(residualCost(parcels, EMPTY_DROP_SET)).toEqual({ triangles: 30, distinctKeys: 3 });
    expect(residualCost(parcels, new Set(['b']))).toEqual({ triangles: 10, distinctKeys: 2 });
  });
});

describe('farthest-first parcel drop', () => {
  it('drops nothing when the chunk already fits', () => {
    const parcels = chunk(8, 10_000);
    expect(computeChunkDrop({
      parcels,
      nearestParcelCode: parcels[0]!.parcelCode,
      previousDropped: EMPTY_DROP_SET,
      basisChanged: true,
    })).toBe(EMPTY_DROP_SET);
  });

  it('drops farthest-first until the chunk fits the triangle budget', () => {
    // 8 x 40,000 = 320,000 against a 250,000 ceiling: two must go.
    const parcels = chunk(8, 40_000);
    const dropped = computeChunkDrop({
      parcels,
      nearestParcelCode: parcels[0]!.parcelCode,
      previousDropped: EMPTY_DROP_SET,
      basisChanged: true,
    });
    expect([...dropped].sort()).toEqual(['parcel-starter-06', 'parcel-starter-07']);
    expect(residualCost(parcels, dropped).triangles).toBeLessThanOrEqual(
      KIT_SUBMITTED_TRIANGLE_BUDGET,
    );
  });

  it('uses the supplied phone triangle ceiling for parcel drops', () => {
    const parcels = chunk(4, 40_000);
    const dropped = computeChunkDrop({
      parcels,
      nearestParcelCode: parcels[0]!.parcelCode,
      previousDropped: EMPTY_DROP_SET,
      basisChanged: true,
      drawBudget: 30,
      triangleBudget: 120_000,
    });
    expect([...dropped]).toEqual(['parcel-starter-03']);
    expect(residualCost(parcels, dropped).triangles).toBe(120_000);
  });

  it('drops on the draw budget too, not only triangles', () => {
    // Cheap triangles, but every parcel brings its own distinct keys.
    const parcels: ParcelCost[] = Array.from({ length: 10 }, (_, index) => ({
      parcelCode: `parcel-starter-${String(index).padStart(2, '0')}`,
      triangles: 100,
      pieceKeys: Array.from({ length: 8 }, (_, k) => `p${index}-key-${k}`),
      distanceSq: (index + 1) * 1_000_000,
    }));
    expect(residualCost(parcels, EMPTY_DROP_SET).distinctKeys).toBe(80);
    const dropped = computeChunkDrop({
      parcels,
      nearestParcelCode: parcels[0]!.parcelCode,
      previousDropped: EMPTY_DROP_SET,
      basisChanged: true,
    });
    expect(dropped.size).toBeGreaterThan(0);
    expect(residualCost(parcels, dropped).distinctKeys).toBeLessThanOrEqual(
      KIT_VISIBLE_DRAW_BUDGET,
    );
  });

  it('NEVER drops the nearest parcel, even when the budget cannot be met without it', () => {
    // One parcel alone busts the ceiling; the retention floor still holds.
    const parcels = chunk(3, 300_000);
    const nearest = parcels[0]!.parcelCode;
    const dropped = computeChunkDrop({
      parcels,
      nearestParcelCode: nearest,
      previousDropped: EMPTY_DROP_SET,
      basisChanged: true,
    });
    expect(dropped.has(nearest)).toBe(false);
    expect(residualCost(parcels, dropped).triangles).toBe(300_000);
  });
});

describe('oscillation — the B2 regression', () => {
  it('is STABLE across repeated evaluations once the valve fires', () => {
    const parcels = chunk(8, 40_000);
    const { history, writes } = settle(parcels, parcels[0]!.parcelCode, 25);

    // Exactly one state write: the initial drop. Every later evaluation must
    // return the SAME REFERENCE so the caller skips the write entirely.
    expect(writes).toBe(1);
    expect(history[0]!.size).toBe(2);
    for (let i = 1; i < history.length; i++) {
      expect(history[i]).toBe(history[0]);
    }
  });

  it('does not un-drop when the post-drop chunk reads as in-budget', () => {
    // The precise B2 trace: after a successful drop the FILTERED chunk fits, so
    // an implementation reading the filtered snapshot would return empty here.
    const parcels = chunk(8, 40_000);
    const dropped = computeChunkDrop({
      parcels,
      nearestParcelCode: parcels[0]!.parcelCode,
      previousDropped: EMPTY_DROP_SET,
      basisChanged: true,
    });
    expect(residualCost(parcels, dropped).triangles).toBeLessThanOrEqual(
      KIT_SUBMITTED_TRIANGLE_BUDGET,
    );

    const next = computeChunkDrop({
      parcels,
      nearestParcelCode: parcels[0]!.parcelCode,
      previousDropped: dropped,
      basisChanged: false,
    });
    expect(next).toBe(dropped);
  });

  it('stays stable while the camera reorders parcels, since membership is held', () => {
    const parcels = chunk(8, 40_000);
    let current = computeChunkDrop({
      parcels,
      nearestParcelCode: parcels[0]!.parcelCode,
      previousDropped: EMPTY_DROP_SET,
      basisChanged: true,
    });
    const settled = current;

    // Reverse the distance ordering, as walking to the far side of the chunk
    // would. Membership must not churn: only the data revision may re-derive it.
    const reordered = parcels.map((parcel, index) => ({
      ...parcel,
      distanceSq: (parcels.length - index) * 1_000_000,
    }));
    for (let i = 0; i < 10; i++) {
      current = computeChunkDrop({
        parcels: reordered,
        nearestParcelCode: parcels[0]!.parcelCode,
        previousDropped: current,
        basisChanged: false,
      });
    }
    expect(current).toBe(settled);
  });

  it('re-derives when the data revision changes, and settles again', () => {
    const parcels = chunk(8, 40_000);
    const first = computeChunkDrop({
      parcels,
      nearestParcelCode: parcels[0]!.parcelCode,
      previousDropped: EMPTY_DROP_SET,
      basisChanged: true,
    });
    expect(first.size).toBe(2);

    // Pieces removed: the chunk now fits, so the valve must release.
    const lighter = parcels.map((parcel) => ({ ...parcel, triangles: 1_000 }));
    const released = computeChunkDrop({
      parcels: lighter,
      nearestParcelCode: parcels[0]!.parcelCode,
      previousDropped: first,
      basisChanged: true,
    });
    expect(released).toBe(EMPTY_DROP_SET);

    const { writes } = settle(lighter, parcels[0]!.parcelCode, 10);
    expect(writes).toBe(0);
  });

  it('re-admits a dropped parcel the moment the player walks onto it', () => {
    const parcels = chunk(8, 40_000);
    const dropped = computeChunkDrop({
      parcels,
      nearestParcelCode: parcels[0]!.parcelCode,
      previousDropped: EMPTY_DROP_SET,
      basisChanged: true,
    });
    const walkedTo = 'parcel-starter-07';
    expect(dropped.has(walkedTo)).toBe(true);

    // The retention floor overrides the hold even without a data change.
    const readmitted = computeChunkDrop({
      parcels,
      nearestParcelCode: walkedTo,
      previousDropped: dropped,
      basisChanged: false,
    });
    expect(readmitted.has(walkedTo)).toBe(false);

    // And it settles again rather than flip-flopping.
    let current = readmitted;
    for (let i = 0; i < 10; i++) {
      current = computeChunkDrop({
        parcels,
        nearestParcelCode: walkedTo,
        previousDropped: current,
        basisChanged: false,
      });
    }
    expect(current).toBe(readmitted);
  });
});

describe('source pricing — the B1 regression', () => {
  beforeEach(() => {
    __resetSourcePricingForTest();
  });

  it('reports 0 for a key whose GLB has not resolved yet', () => {
    // This is the cold-load state the budget used to be stuck in forever.
    expect(triangleCostOf('lantern-post')).toBe(0);
    expect(getSourcePricingRevision()).toBe(0);
  });

  it('bumps the revision when a price first arrives, so consumers recompute', () => {
    const seen: number[] = [];
    const unsubscribe = subscribeSourcePricing(() => seen.push(getSourcePricingRevision()));

    priceKitSource('lantern-post', 1_559);
    expect(triangleCostOf('lantern-post')).toBe(1_559);
    expect(seen).toEqual([1]);

    priceKitSource('statue-anchor', 2_018);
    expect(seen).toEqual([1, 2]);

    unsubscribe();
    priceKitSource('bench-wood', 1_273);
    expect(seen).toEqual([1, 2]);
    expect(triangleCostOf('bench-wood')).toBe(1_273);
  });

  it('does NOT bump on a repeated identical price', () => {
    // Every re-render of a resolved source re-prices it; that must be inert or
    // the snapshot memo would invalidate on every render.
    priceKitSource('deck-plank', 613);
    const revision = getSourcePricingRevision();
    priceKitSource('deck-plank', 613);
    priceKitSource('deck-plank', 613);
    expect(getSourcePricingRevision()).toBe(revision);
  });

  it('changes a chunk from apparently-free to over-budget once priced', () => {
    // The whole point: an unpriced chunk looks free and admits everything.
    const parcelsOf = (): ParcelCost[] =>
      Array.from({ length: 8 }, (_, index) => ({
        parcelCode: `parcel-starter-${String(index).padStart(2, '0')}`,
        triangles: 30 * triangleCostOf('statue-shell'),
        pieceKeys: ['statue-shell'],
        distanceSq: (index + 1) * 1_000_000,
      }));

    const cold = parcelsOf();
    expect(residualCost(cold, EMPTY_DROP_SET).triangles).toBe(0);
    expect(computeChunkDrop({
      parcels: cold,
      nearestParcelCode: cold[0]!.parcelCode,
      previousDropped: EMPTY_DROP_SET,
      basisChanged: true,
    })).toBe(EMPTY_DROP_SET);

    // The GLB resolves. 8 parcels x 30 pieces x 2,079 tri = 498,960.
    priceKitSource('statue-shell', 2_079);
    const priced = parcelsOf();
    expect(residualCost(priced, EMPTY_DROP_SET).triangles).toBeGreaterThan(
      KIT_SUBMITTED_TRIANGLE_BUDGET,
    );
    const dropped = computeChunkDrop({
      parcels: priced,
      nearestParcelCode: priced[0]!.parcelCode,
      previousDropped: EMPTY_DROP_SET,
      basisChanged: true,
    });
    expect(dropped.size).toBeGreaterThan(0);
    expect(residualCost(priced, dropped).triangles).toBeLessThanOrEqual(
      KIT_SUBMITTED_TRIANGLE_BUDGET,
    );
  });
});
