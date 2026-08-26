import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import {
  EMPTY_AUTONOMOUS_BUILD_TARGETS,
  readAutonomousBuildTargets,
  type AutonomousBuildTargetReader,
} from '../autonomous-build-targets';

const AVATAR_ID = '11111111-1111-4111-8111-111111111111';

function reader(overrides: Partial<AutonomousBuildTargetReader> = {}): AutonomousBuildTargetReader {
  return {
    readHomes: async () => [{
      id: '22222222-2222-4222-8222-222222222222',
      parcel_code: 'parcel-starter-01',
      tier: 'starter',
      level: 3,
    }],
    readPieces: async () => [],
    readMaterialBalance: async () => 38,
    ...overrides,
  };
}

describe('autonomous build targets', () => {
  it('fails soft to the frozen empty projection on a database error', async () => {
    const result = await readAutonomousBuildTargets(
      { avatarId: AVATAR_ID },
      reader({ readHomes: async () => { throw new Error('db unavailable'); } }),
    );
    expect(result).toEqual(EMPTY_AUTONOMOUS_BUILD_TARGETS);
  });

  it('filters to owned active HOME structures in the production query', () => {
    const source = readFileSync(
      new URL('../autonomous-build-targets.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("p.owner_avatar_id = ${avatarId}");
    expect(source).toContain("p.status = 'owned'");
    expect(source).toContain("s.owner_avatar_id = ${avatarId}");
    expect(source).toContain("s.status = 'active'");
    expect(source).toContain("s.structure_type = 'home'");
  });

  it('bounds parcels and valid placements and renders exact material costs', async () => {
    let pieceReads = 0;
    const homes = Array.from({ length: 4 }, (_, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      parcel_code: `parcel-starter-0${index + 1}`,
      tier: 'starter' as const,
      level: 3,
    }));
    const result = await readAutonomousBuildTargets(
      { avatarId: AVATAR_ID },
      reader({
        readHomes: async () => homes,
        readPieces: async () => {
          pieceReads += 1;
          return [];
        },
      }),
    );

    expect(result.materialBalance).toBe(38);
    expect(result.costs).toEqual({ small: 8, large: 30 });
    expect(result.parcels).toHaveLength(2);
    expect(pieceReads).toBe(2);
    for (const parcel of result.parcels) {
      expect(parcel.placements.length).toBeGreaterThan(0);
      expect(parcel.placements.length).toBeLessThanOrEqual(3);
      for (const placement of parcel.placements) {
        expect(placement.call).toBe(
          `place_kit_piece(parcelCode=${parcel.parcelCode}, pieceKey=${placement.pieceKey}, gridX=${placement.gridX}, gridY=${placement.gridY})`,
        );
        expect([8, 30]).toContain(placement.costMaterials);
      }
    }
  });
});
