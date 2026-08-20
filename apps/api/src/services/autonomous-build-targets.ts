import { db, sql } from '@clawville/database';
import {
  KIT_CATALOG,
  KIT_GRID_SIZE,
  evaluatePlacement,
  kitPieceFeeMaterials,
  resolveParcelPlacements,
  type KitPieceKey,
  type LandTier,
  type StoredPlacement,
} from '@clawville/shared';

const PARCEL_LIMIT = 2;
const PLACEMENT_LIMIT = 3;

interface BuildHomeRow extends Record<string, unknown> {
  id: string;
  parcel_code: string;
  tier: LandTier;
  level: number | string;
}

interface BuildPieceRow extends Record<string, unknown> {
  id: string;
  piece_key: string;
  grid_x: number | string;
  grid_y: number | string;
  rotation_step: number | string;
  stack_level: number | string;
}

export interface AutonomousBuildPlacement {
  readonly parcelCode: string;
  readonly pieceKey: KitPieceKey;
  readonly gridX: number;
  readonly gridY: number;
  readonly costMaterials: number;
  readonly call: string;
}

export interface AutonomousBuildParcelTarget {
  readonly parcelCode: string;
  readonly structureLevel: number;
  readonly placements: readonly AutonomousBuildPlacement[];
}

export interface AutonomousBuildTargets {
  readonly materialBalance: number;
  readonly costs: {
    readonly small: number;
    readonly large: number;
  };
  readonly parcels: readonly AutonomousBuildParcelTarget[];
}

export const EMPTY_AUTONOMOUS_BUILD_TARGETS: AutonomousBuildTargets = {
  materialBalance: 0,
  costs: {
    small: kitPieceFeeMaterials('small'),
    large: kitPieceFeeMaterials('large'),
  },
  parcels: [],
};

export interface AutonomousBuildTargetReader {
  readHomes(avatarId: string): Promise<readonly BuildHomeRow[]>;
  readPieces(parcelId: string): Promise<readonly BuildPieceRow[]>;
  readMaterialBalance(avatarId: string): Promise<number>;
}

const databaseReader: AutonomousBuildTargetReader = {
  async readHomes(avatarId) {
    const rows = await db.execute<BuildHomeRow>(
      sql`SELECT p.id, p.parcel_code, p.tier, s.level
          FROM land_parcels p
          INNER JOIN land_structures s ON s.parcel_id = p.id
          WHERE p.owner_avatar_id = ${avatarId}
            AND p.status = 'owned'
            AND s.owner_avatar_id = ${avatarId}
            AND s.status = 'active'
            AND s.structure_type = 'home'
          ORDER BY p.parcel_code ASC
          LIMIT ${PARCEL_LIMIT}`,
    );
    return Array.from(rows);
  },
  async readPieces(parcelId) {
    const rows = await db.execute<BuildPieceRow>(
      sql`SELECT id, piece_key, grid_x, grid_y, rotation_step, stack_level
          FROM land_structure_pieces
          WHERE parcel_id = ${parcelId}
          ORDER BY created_at ASC, id ASC`,
    );
    return Array.from(rows);
  },
  async readMaterialBalance(avatarId) {
    const rows = await db.execute<{ quantity: number | string }>(
      sql`SELECT quantity FROM avatar_material_balances WHERE avatar_id = ${avatarId}`,
    );
    return Number(rows[0]?.quantity ?? 0);
  },
};

function isKitPieceKey(pieceKey: string): pieceKey is KitPieceKey {
  return Object.prototype.hasOwnProperty.call(KIT_CATALOG, pieceKey);
}

function projectParcel(
  home: BuildHomeRow,
  rows: readonly BuildPieceRow[],
): AutonomousBuildParcelTarget {
  const stored: StoredPlacement[] = [];
  let currentSmall = 0;
  let currentLarge = 0;
  for (const row of rows) {
    if (!isKitPieceKey(row.piece_key)) continue;
    if (KIT_CATALOG[row.piece_key].size === 'small') currentSmall += 1;
    else currentLarge += 1;
    stored.push({
      pieceRef: row.id,
      pieceKey: row.piece_key,
      gridX: Number(row.grid_x),
      gridY: Number(row.grid_y),
      rotationStep: Number(row.rotation_step),
      stackLevel: Number(row.stack_level),
    });
  }

  const structureLevel = Number(home.level);
  const occupied = resolveParcelPlacements(stored, home.tier).map((row) => row.footprint);
  const placements: AutonomousBuildPlacement[] = [];
  const pieceKeys = Object.keys(KIT_CATALOG).sort() as KitPieceKey[];

  // One suggestion PER PIECE KEY (first legal cell, deterministic scan): a
  // greedy fill would offer the alphabetically-first piece three times, and an
  // agent that only ever copies listed calls would then build monoculture
  // yards. Accepted suggestions join `occupied`/the counts so the offered
  // calls can never collide with each other.
  for (const pieceKey of pieceKeys) {
    if (placements.length >= PLACEMENT_LIMIT) break;
    let placed = false;
    for (let gridY = 0; gridY < KIT_GRID_SIZE && !placed; gridY += 1) {
      for (let gridX = 0; gridX < KIT_GRID_SIZE && !placed; gridX += 1) {
        const verdict = evaluatePlacement(
          { pieceKey, gridX, gridY, rotationStep: 0, stackLevel: 1 },
          {
            parcelTier: home.tier,
            structureLevel,
            currentSmall,
            currentLarge,
            occupied,
          },
        );
        if (!verdict.ok) continue;
        const costMaterials = kitPieceFeeMaterials(KIT_CATALOG[pieceKey].size);
        placements.push({
          parcelCode: home.parcel_code,
          pieceKey,
          gridX,
          gridY,
          costMaterials,
          call: `place_kit_piece(parcelCode=${home.parcel_code}, pieceKey=${pieceKey}, gridX=${gridX}, gridY=${gridY})`,
        });
        occupied.push(verdict.footprint);
        if (KIT_CATALOG[pieceKey].size === 'small') currentSmall += 1;
        else currentLarge += 1;
        placed = true;
      }
    }
  }

  return {
    parcelCode: home.parcel_code,
    structureLevel,
    placements,
  };
}

export async function readAutonomousBuildTargets(
  input: { readonly avatarId: string },
  reader: AutonomousBuildTargetReader = databaseReader,
): Promise<AutonomousBuildTargets> {
  try {
    const homes = await reader.readHomes(input.avatarId);
    const [materialBalance, pieceRows] = await Promise.all([
      reader.readMaterialBalance(input.avatarId),
      Promise.all(homes.slice(0, PARCEL_LIMIT).map((home) => reader.readPieces(home.id))),
    ]);
    return {
      materialBalance,
      costs: EMPTY_AUTONOMOUS_BUILD_TARGETS.costs,
      parcels: homes.slice(0, PARCEL_LIMIT).map((home, index) => projectParcel(home, pieceRows[index] ?? [])),
    };
  } catch {
    return EMPTY_AUTONOMOUS_BUILD_TARGETS;
  }
}
