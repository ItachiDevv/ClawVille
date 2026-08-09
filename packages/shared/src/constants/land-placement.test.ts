import { describe, expect, it } from 'bun:test';
import {
  KIT_CATALOG,
  KIT_GRID_SIZE,
  KIT_LEVEL_RULES,
  KIT_MAX_STACK_HEIGHT_WU,
  KIT_PIECE_RENDER,
  advertisedRotationSteps,
  evaluatePlacement,
  getParcelFootprintWu,
  getTierMaxLevel,
  kitCellCentreWu,
  legalAnchors,
  legalPlacements,
  maxStackHeightWu,
  resolveFootprint,
  shellEnvelopeHalfWu,
  structureLevelScale,
  type KitPieceKey,
  type LandTier,
  type PlacedFootprint,
  type PlacementContext,
} from '../index';

/** The three tiers that actually generate parcels. */
const LIVE_TIERS: readonly LandTier[] = ['starter', 'founder', 'c'];

const PIECE_KEYS = Object.keys(KIT_CATALOG) as KitPieceKey[];

function emptyContext(tier: LandTier, structureLevel = getTierMaxLevel(tier)): PlacementContext {
  return {
    parcelTier: tier,
    structureLevel,
    currentSmall: 0,
    currentLarge: 0,
    occupied: [],
  };
}

describe('frozen world-scale constants (§5.6, Q7)', () => {
  it('pins the flat 2.5%-per-level ramp', () => {
    const expected = [0.94, 0.965, 0.99, 1.015, 1.04];
    for (let level = 1; level <= 5; level++) {
      expect(structureLevelScale(level)).toBeCloseTo(expected[level - 1]!, 10);
    }
    // Clamped, never extrapolated.
    expect(structureLevelScale(0)).toBeCloseTo(0.94, 10);
    expect(structureLevelScale(99)).toBeCloseTo(1.04, 10);
  });

  it('pins the grown tier footprints (starter 38 t, founder 38 t, c 52 t)', () => {
    expect(getParcelFootprintWu('starter')).toBe(1216);
    expect(getParcelFootprintWu('founder')).toBe(1216);
    expect(getParcelFootprintWu('c')).toBe(1664);
  });

  it('reproduces the §5.3 envelope table', () => {
    expect(shellEnvelopeHalfWu('starter')).toBeCloseTo(385.2, 1);
    expect(shellEnvelopeHalfWu('founder')).toBeCloseTo(404.7, 1);
    expect(shellEnvelopeHalfWu('c')).toBeCloseTo(540.5, 1);
  });

  it('keeps the shell envelope level-independent by type signature (D-1)', () => {
    // A level argument would let a Lv5 shell grow into pieces already sold as
    // legal at Lv1. Arity is the mechanical guard.
    expect(shellEnvelopeHalfWu.length).toBe(1);
  });

  it('leaves every tier a positive placement band outside the shell', () => {
    for (const tier of LIVE_TIERS) {
      const band = getParcelFootprintWu(tier) / 2 - shellEnvelopeHalfWu(tier);
      expect(band).toBeGreaterThan(0);
    }
  });
});

describe('kit manifest (§5.3)', () => {
  it('covers every catalog key and nothing else', () => {
    expect(Object.keys(KIT_PIECE_RENDER).sort()).toEqual([...PIECE_KEYS].sort());
  });

  it('derives extents from the measured GLB aspect ratio at the authored height', () => {
    for (const pieceKey of PIECE_KEYS) {
      const render = KIT_PIECE_RENDER[pieceKey];
      const scale = render.targetHeightWu / render.sourceExtent.y;
      expect(render.extentXWu).toBeCloseTo(render.sourceExtent.x * scale, 6);
      expect(render.extentZWu).toBeCloseTo(render.sourceExtent.z * scale, 6);
      expect(render.extentYWu).toBe(render.targetHeightWu);
      expect(render.maxHeightWu).toBe(render.targetHeightWu);
    }
  });

  it('pins the §5.3 authored heights', () => {
    const heights = Object.fromEntries(
      PIECE_KEYS.map((key) => [key, KIT_PIECE_RENDER[key].targetHeightWu]),
    );
    expect(heights).toEqual({
      'path-stone': 8,
      'deck-plank': 40,
      'fence-picket': 105,
      'fence-rope': 88,
      'bench-wood': 85,
      'planter-box': 87,
      'planter-coral': 93,
      'banner-pole': 232,
      'lantern-post': 250,
      'statue-shell': 217,
      'statue-anchor': 292,
      'arch-driftwood': 197,
    });
  });

  it('gives a support surface ONLY to the two floor pieces (Q8)', () => {
    const supporters = PIECE_KEYS.filter(
      (key) => KIT_PIECE_RENDER[key].supportSurfaceYWu !== null,
    ).sort();
    expect(supporters).toEqual(['deck-plank', 'path-stone']);
    expect(KIT_PIECE_RENDER['path-stone'].supportSurfaceYWu).toBe(8);
    expect(KIT_PIECE_RENDER['deck-plank'].supportSurfaceYWu).toBe(40);
  });

  it('restricts rotation ONLY where a step is zero-legal on some tier', () => {
    const orthogonal = PIECE_KEYS.filter(
      (key) => KIT_PIECE_RENDER[key].rotations === 'orthogonal',
    ).sort();
    expect(orthogonal).toEqual(['arch-driftwood', 'path-stone']);

    // The justification, re-derived rather than asserted: each restricted piece
    // has a 45° step with zero legal anchors on at least one tier, and each
    // unrestricted piece has none.
    for (const pieceKey of PIECE_KEYS) {
      const oddStepDead = LIVE_TIERS.some((tier) =>
        [1, 3, 5, 7].some(
          (step) => legalAnchorsUnrestricted(pieceKey, tier, step) === 0,
        ),
      );
      expect(oddStepDead).toBe(KIT_PIECE_RENDER[pieceKey].rotations === 'orthogonal');
    }
  });

  it('bounds the tallest legal stack at 372 wu (§4.4 budget e)', () => {
    // deck-plank (40) → deck-plank (40) → statue-anchor (292).
    expect(KIT_MAX_STACK_HEIGHT_WU).toBe(372);
    expect(maxStackHeightWu(1)).toBe(292);
    expect(maxStackHeightWu(2)).toBe(332);
    // The pre-manifest bound was KIT_STACK_UNIT_WU*2 + cell*1.5 = 235.2 wu,
    // which is exactly why two stacked lanterns overlapped by 216 wu (N-3).
    expect(KIT_MAX_STACK_HEIGHT_WU).toBeGreaterThan(235.2);
  });
});

/** Legal anchors for a step the piece may not advertise — restriction evidence. */
function legalAnchorsUnrestricted(
  pieceKey: KitPieceKey,
  tier: LandTier,
  rotationStep: number,
): number {
  const render = KIT_PIECE_RENDER[pieceKey];
  const sideWu = getParcelFootprintWu(tier);
  const parcelHalf = sideWu / 2;
  const shellHalf = shellEnvelopeHalfWu(tier);
  const angle = (rotationStep * Math.PI) / 4;
  const halfX = (render.extentXWu * Math.abs(Math.cos(angle)) + render.extentZWu * Math.abs(Math.sin(angle))) / 2;
  const halfZ = (render.extentXWu * Math.abs(Math.sin(angle)) + render.extentZWu * Math.abs(Math.cos(angle))) / 2;
  let count = 0;
  for (let gridX = 0; gridX < KIT_GRID_SIZE; gridX++) {
    for (let gridY = 0; gridY < KIT_GRID_SIZE; gridY++) {
      const cx = kitCellCentreWu(gridX, sideWu);
      const cz = kitCellCentreWu(gridY, sideWu);
      if (cx - halfX < -parcelHalf || cx + halfX > parcelHalf) continue;
      if (cz - halfZ < -parcelHalf || cz + halfZ > parcelHalf) continue;
      const clears =
        cx + halfX <= -shellHalf
        || cx - halfX >= shellHalf
        || cz + halfZ <= -shellHalf
        || cz - halfZ >= shellHalf;
      if (clears) count++;
    }
  }
  return count;
}

describe('G-H placement feasibility gate (§7.2)', () => {
  it('reproduces the §5.3 per-tier legal-placement counts exactly', () => {
    const measured: Record<string, number[]> = {};
    for (const pieceKey of PIECE_KEYS) {
      measured[pieceKey] = LIVE_TIERS.map(
        (tier) => legalPlacements(pieceKey, tier, getTierMaxLevel(tier)).length,
      );
    }
    // [starter, founder, c] — the §5.3 table, column for column.
    expect(measured).toEqual({
      'path-stone': [208, 208, 208],
      'deck-plank': [1248, 992, 1248],
      'fence-picket': [624, 432, 624],
      'fence-rope': [624, 432, 624],
      'bench-wood': [528, 528, 528],
      'planter-box': [416, 416, 528],
      'planter-coral': [416, 416, 528],
      'banner-pole': [624, 528, 864],
      'lantern-post': [1072, 896, 1072],
      'statue-shell': [416, 416, 528],
      'statue-anchor': [416, 416, 528],
      'arch-driftwood': [208, 112, 208],
    });
  });

  it('gives every piece × tier at least 8 placements (and in fact ≥ 112)', () => {
    for (const pieceKey of PIECE_KEYS) {
      for (const tier of LIVE_TIERS) {
        const total = legalPlacements(pieceKey, tier, getTierMaxLevel(tier)).length;
        expect(total).toBeGreaterThanOrEqual(8);
        expect(total).toBeGreaterThanOrEqual(112);
      }
    }
  });

  it('gives every ADVERTISED rotation at least 1 anchor (and in fact ≥ 28)', () => {
    for (const pieceKey of PIECE_KEYS) {
      for (const tier of LIVE_TIERS) {
        for (const step of advertisedRotationSteps(KIT_PIECE_RENDER[pieceKey].rotations)) {
          const anchors = legalAnchors(pieceKey, tier, getTierMaxLevel(tier), step);
          expect(anchors).toBeGreaterThanOrEqual(1);
          expect(anchors).toBeGreaterThanOrEqual(28);
        }
      }
    }
  });

  it('keeps every small piece smaller in volume than every large piece', () => {
    const volume = (key: KitPieceKey) => {
      const r = KIT_PIECE_RENDER[key];
      return r.extentXWu * r.extentYWu * r.extentZWu;
    };
    const small = PIECE_KEYS.filter((k) => KIT_CATALOG[k].size === 'small').map(volume);
    const large = PIECE_KEYS.filter((k) => KIT_CATALOG[k].size === 'large').map(volume);
    expect(Math.max(...small)).toBeLessThan(Math.min(...large));
  });

  it('admits at least one legal stacked placement for every support piece, per tier (Q8)', () => {
    for (const pieceKey of PIECE_KEYS) {
      if (KIT_PIECE_RENDER[pieceKey].supportSurfaceYWu === null) continue;
      for (const tier of LIVE_TIERS) {
        const level = getTierMaxLevel(tier);
        if (KIT_LEVEL_RULES[level as 1 | 2 | 3 | 4 | 5].maxStackHeight < 2) continue;
        const ground = legalPlacements(pieceKey, tier, level)[0];
        expect(ground).toBeDefined();
        const supporter = resolveFootprint(ground!, tier, [], 'support-1')!;
        const stacked = evaluatePlacement(
          { ...ground!, stackLevel: 2 },
          { ...emptyContext(tier, level), currentSmall: 1, occupied: [supporter] },
        );
        expect(stacked.ok).toBe(true);
      }
    }
  });
});

describe('evaluatePlacement refusal codes', () => {
  const tier: LandTier = 'starter';
  const level = 3;

  it('refuses an unknown piece', () => {
    const verdict = evaluatePlacement(
      { pieceKey: 'not-a-piece' as KitPieceKey, gridX: 0, gridY: 0, rotationStep: 0, stackLevel: 1 },
      emptyContext(tier, level),
    );
    expect(verdict).toEqual({ ok: false, code: 'piece_unknown' });
  });

  it('refuses an off-grid anchor', () => {
    for (const anchor of [-1, KIT_GRID_SIZE, 1.5]) {
      const verdict = evaluatePlacement(
        { pieceKey: 'path-stone', gridX: anchor, gridY: 0, rotationStep: 0, stackLevel: 1 },
        emptyContext(tier, level),
      );
      expect(verdict).toEqual({ ok: false, code: 'cell_out_of_bounds' });
    }
  });

  it('refuses a 45° step on an orthogonal-only piece even when the level allows 45°', () => {
    const verdict = evaluatePlacement(
      { pieceKey: 'arch-driftwood', gridX: 0, gridY: 0, rotationStep: 1, stackLevel: 1 },
      emptyContext(tier, level),
    );
    expect(verdict).toEqual({ ok: false, code: 'rotation_not_allowed' });
  });

  it('refuses a 45° step at Lv1/Lv2 where the level rule is 90° only', () => {
    const verdict = evaluatePlacement(
      { pieceKey: 'fence-picket', gridX: 0, gridY: 0, rotationStep: 1, stackLevel: 1 },
      emptyContext(tier, 2),
    );
    expect(verdict).toEqual({ ok: false, code: 'rotation_not_allowed' });
  });

  it('refuses once the level piece cap is full', () => {
    const legal = legalPlacements('fence-picket', tier, level)[0]!;
    const verdict = evaluatePlacement(legal, {
      ...emptyContext(tier, level),
      currentSmall: KIT_LEVEL_RULES[3].smallPieceCap,
    });
    expect(verdict).toEqual({ ok: false, code: 'level_cap_exceeded' });
  });

  it('refuses a stack level above the level rule (stack_exceeds_height)', () => {
    const legal = legalPlacements('fence-picket', tier, level)[0]!;
    const verdict = evaluatePlacement(
      { ...legal, stackLevel: KIT_LEVEL_RULES[3].maxStackHeight + 1 },
      emptyContext(tier, level),
    );
    expect(verdict).toEqual({ ok: false, code: 'stack_exceeds_height' });
  });

  it('refuses a stack on a piece with no support surface (unsupported_stack)', () => {
    const ground = legalPlacements('lantern-post', tier, level)[0]!;
    const supporter = resolveFootprint(ground, tier, [], 'lantern-1')!;
    expect(supporter.supportSurfaceY).toBeNull();
    const verdict = evaluatePlacement(
      { ...ground, stackLevel: 2 },
      { ...emptyContext(tier, level), currentSmall: 1, occupied: [supporter] },
    );
    expect(verdict).toEqual({ ok: false, code: 'unsupported_stack' });
  });

  it('refuses a stack with nothing at all beneath it', () => {
    const ground = legalPlacements('deck-plank', tier, level)[0]!;
    const verdict = evaluatePlacement({ ...ground, stackLevel: 2 }, emptyContext(tier, level));
    expect(verdict).toEqual({ ok: false, code: 'unsupported_stack' });
  });

  it('refuses a stack whose centre is outside the supporter (edge balancing)', () => {
    // A deck-plank supports a piece only where it actually covers the centre.
    const support = legalPlacements('deck-plank', tier, level).find((p) => p.rotationStep === 0)!;
    const supporter = resolveFootprint(support, tier, [], 'deck-1')!;
    const offset = { ...support, gridX: support.gridX + 2, stackLevel: 2 };
    const verdict = evaluatePlacement(offset, {
      ...emptyContext(tier, level),
      currentSmall: 1,
      occupied: [supporter],
    });
    expect(verdict).toEqual({ ok: false, code: 'unsupported_stack' });
  });

  it('refuses a piece that overhangs the parcel edge (outside_parcel)', () => {
    // fence-picket spans 190 wu; a 76 wu cell means the corner column cannot
    // hold it at step 0 even though the ANCHOR CELL itself is on the parcel.
    // This is exactly the class of placement anchor-only validation admitted.
    const verdict = evaluatePlacement(
      { pieceKey: 'fence-picket', gridX: 0, gridY: 0, rotationStep: 0, stackLevel: 1 },
      emptyContext(tier, level),
    );
    expect(verdict).toEqual({ ok: false, code: 'outside_parcel' });
  });

  it('refuses a piece overlapping the shell reservation (intersects_shell)', () => {
    // Dead centre of the parcel is the middle of the shell.
    const verdict = evaluatePlacement(
      { pieceKey: 'path-stone', gridX: 8, gridY: 8, rotationStep: 0, stackLevel: 1 },
      emptyContext(tier, level),
    );
    expect(verdict).toEqual({ ok: false, code: 'intersects_shell' });
  });

  it('refuses a second piece on the same ground (intersects_piece)', () => {
    const legal = legalPlacements('bench-wood', tier, level)[0]!;
    const occupied = resolveFootprint(legal, tier, [], 'bench-1')!;
    const verdict = evaluatePlacement(legal, {
      ...emptyContext(tier, level),
      currentSmall: 1,
      occupied: [occupied],
    });
    expect(verdict).toEqual({ ok: false, code: 'intersects_piece' });
  });
});

describe('cross-level 3D occupancy (Q8, §7.3)', () => {
  const tier: LandTier = 'starter';
  const level = 3;

  /** An anchor + step legal on the ground for BOTH pieces on this tier. */
  function sharedGroundAnchor(a: KitPieceKey, b: KitPieceKey) {
    const bLegal = new Set(
      legalPlacements(b, tier, level).map((p) => `${p.gridX}:${p.gridY}:${p.rotationStep}`),
    );
    return legalPlacements(a, tier, level).find((p) =>
      bLegal.has(`${p.gridX}:${p.gridY}:${p.rotationStep}`),
    );
  }

  it('admits two pieces at one anchor on levels 1 and 2 with disjoint Y', () => {
    // The wider planter needs a spot the plank also fits, so the only thing
    // under test is the cross-level rule rather than an unrelated overhang.
    const ground = sharedGroundAnchor('deck-plank', 'planter-box')!;
    expect(ground).toBeDefined();
    const supporter = resolveFootprint(ground, tier, [], 'deck-1')!;
    const verdict = evaluatePlacement(
      { ...ground, pieceKey: 'planter-box', stackLevel: 2 },
      { ...emptyContext(tier, level), currentSmall: 1, occupied: [supporter] },
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    // Overlapping in XZ is the whole point; disjointness must come from Y.
    expect(verdict.footprint.minX).toBeLessThan(supporter.maxX);
    expect(verdict.footprint.maxX).toBeGreaterThan(supporter.minX);
    expect(verdict.footprint.minY).toBe(supporter.supportSurfaceY!);
    expect(verdict.footprint.minY).toBeGreaterThanOrEqual(supporter.maxY);
  });

  it('stacks a plank on a plank at the same anchor (§7.3 case)', () => {
    const ground = legalPlacements('deck-plank', tier, level).find((p) => p.rotationStep === 0)!;
    const supporter = resolveFootprint(ground, tier, [], 'deck-1')!;
    const verdict = evaluatePlacement(
      { ...ground, stackLevel: 2 },
      { ...emptyContext(tier, level), currentSmall: 1, occupied: [supporter] },
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.footprint.minY).toBe(40);
    expect(verdict.footprint.maxY).toBe(80);
  });

  it('places a stacked piece at the supporter surface, not floorY + (n−1) × 34', () => {
    const ground = legalPlacements('deck-plank', tier, level).find((p) => p.rotationStep === 0)!;
    const supporter = resolveFootprint(ground, tier, [], 'deck-1')!;
    const stacked = resolveFootprint(
      { ...ground, pieceKey: 'lantern-post', stackLevel: 2 },
      tier,
      [supporter],
      'lantern-1',
    )!;
    expect(stacked.minY).toBe(40);
    expect(stacked.maxY).toBe(40 + 250);
    // The retired model would have put it at 34 wu — 6 wu INSIDE the plank.
    expect(stacked.minY).not.toBe(34);
  });

  it('never lets two stacked pieces of the same height share a level', () => {
    const ground = legalPlacements('path-stone', tier, level).find((p) => p.rotationStep === 0)!;
    const first = resolveFootprint(ground, tier, [], 'stone-1')!;
    const second = evaluatePlacement(
      { ...ground, pieceKey: 'path-stone', stackLevel: 1 },
      { ...emptyContext(tier, level), currentSmall: 1, occupied: [first] },
    );
    expect(second).toEqual({ ok: false, code: 'intersects_piece' });
  });
});

describe('grandfathering (Q5)', () => {
  it('still resolves a footprint for a row the predicate now refuses', () => {
    // A legacy row anchored in the shell reservation: illegal to WRITE, but the
    // renderer must still know where to draw it. Nothing is deleted or moved.
    const req = {
      pieceKey: 'path-stone' as KitPieceKey,
      gridX: 8,
      gridY: 8,
      rotationStep: 0,
      stackLevel: 1,
    };
    expect(evaluatePlacement(req, emptyContext('starter', 3))).toEqual({
      ok: false,
      code: 'intersects_shell',
    });
    const footprint = resolveFootprint(req, 'starter', [], 'legacy-1');
    expect(footprint).not.toBeNull();
    expect(footprint!.minY).toBe(0);
  });

  it('returns null for a legacy stacked row with no supporter, so the caller can ground it', () => {
    const orphan: PlacedFootprint | null = resolveFootprint(
      { pieceKey: 'lantern-post', gridX: 0, gridY: 8, rotationStep: 0, stackLevel: 3 },
      'starter',
      [],
      'legacy-2',
    );
    expect(orphan).toBeNull();
  });
});
