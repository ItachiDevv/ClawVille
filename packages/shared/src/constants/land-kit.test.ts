import { describe, expect, it } from 'bun:test';
import {
  KIT_CATALOG,
  KIT_LEVEL_RULES,
  KIT_PIECE_FEE_CT,
  isCellPlaceable,
  isPiecePlacementAllowed,
  isRotationAllowed,
  type KitPieceSize,
  type KitStructureLevel,
} from './land-kit';

describe('land kit catalog', () => {
  it('contains the frozen render-agnostic v1 keys and sizes', () => {
    expect(Object.keys(KIT_CATALOG)).toEqual([
      'fence-picket',
      'fence-rope',
      'deck-plank',
      'planter-box',
      'planter-coral',
      'lantern-post',
      'arch-driftwood',
      'bench-wood',
      'path-stone',
      'statue-anchor',
      'statue-shell',
      'banner-pole',
    ]);
    expect(
      Object.entries(KIT_CATALOG)
        .filter(([, entry]) => entry.size === 'large')
        .map(([key]) => key),
    ).toEqual(['arch-driftwood', 'statue-anchor', 'statue-shell']);
    for (const entry of Object.values(KIT_CATALOG)) {
      expect(entry).not.toHaveProperty('assetPath');
      expect(entry).not.toHaveProperty('glb');
    }
  });

  it('locks D5 fees exactly', () => {
    expect(KIT_PIECE_FEE_CT).toEqual({ small: 15, large: 60 });
  });
});

describe('isPiecePlacementAllowed', () => {
  const caps: Readonly<Record<KitStructureLevel, Record<KitPieceSize, number>>> = {
    1: { small: 6, large: 0 },
    2: { small: 16, large: 0 },
    3: { small: 28, large: 2 },
    4: { small: 28, large: 2 },
    5: { small: 28, large: 2 },
  };

  for (const level of [1, 2, 3, 4, 5] as const) {
    for (const size of ['small', 'large'] as const) {
      it(`pins Lv${level} ${size} cap`, () => {
        const cap = caps[level][size];
        const currentSmall = size === 'small' ? Math.max(0, cap - 1) : 0;
        const currentLarge = size === 'large' ? Math.max(0, cap - 1) : 0;
        expect(isPiecePlacementAllowed(level, currentSmall, currentLarge, size)).toBe(cap > 0);
        expect(
          isPiecePlacementAllowed(
            level,
            size === 'small' ? cap : currentSmall,
            size === 'large' ? cap : currentLarge,
            size,
          ),
        ).toBe(false);
      });
    }
  }

  it('fails closed on invalid levels and counts', () => {
    expect(isPiecePlacementAllowed(0, 0, 0, 'small')).toBe(false);
    expect(isPiecePlacementAllowed(6, 0, 0, 'small')).toBe(false);
    expect(isPiecePlacementAllowed(1, -1, 0, 'small')).toBe(false);
    expect(isPiecePlacementAllowed(1, 0.5, 0, 'small')).toBe(false);
  });
});

describe('kit placement geometry rules', () => {
  it('pins stack and rotation rules for every structure level', () => {
    expect(Object.values(KIT_LEVEL_RULES).map((rule) => rule.maxStackHeight)).toEqual([
      1, 2, 2, 3, 3,
    ]);
    expect(Object.values(KIT_LEVEL_RULES).map((rule) => rule.rotationDegrees)).toEqual([
      90, 90, 45, 45, 45,
    ]);
    for (const level of [1, 2]) {
      expect(isRotationAllowed(level, 0)).toBe(true);
      expect(isRotationAllowed(level, 2)).toBe(true);
      expect(isRotationAllowed(level, 1)).toBe(false);
      expect(isRotationAllowed(level, 7)).toBe(false);
    }
    for (const level of [3, 4, 5]) {
      for (let step = 0; step <= 7; step += 1) {
        expect(isRotationAllowed(level, step)).toBe(true);
      }
    }
    expect(isRotationAllowed(3, -1)).toBe(false);
    expect(isRotationAllowed(3, 8)).toBe(false);
  });

  it('accepts the perimeter and rejects bounds plus the center 10×10', () => {
    expect(isCellPlaceable(0, 0)).toBe(true);
    expect(isCellPlaceable(15, 15)).toBe(true);
    expect(isCellPlaceable(3, 2)).toBe(true);
    expect(isCellPlaceable(2, 3)).toBe(true);
    expect(isCellPlaceable(3, 3)).toBe(false);
    expect(isCellPlaceable(12, 12)).toBe(false);
    expect(isCellPlaceable(13, 12)).toBe(true);
    expect(isCellPlaceable(-1, 0)).toBe(false);
    expect(isCellPlaceable(0, 16)).toBe(false);
    expect(isCellPlaceable(1.5, 0)).toBe(false);
  });
});
