import { WORLD_CENTER_PX } from './world-dimensions';
import { KELP_FOREST_PORTAL_WORLD_CENTER } from './world-colliders-data';

export const KELP_REALM_CELL_WU = 600;
export const KELP_REALM_WALL_HEIGHT_WU = 420;
export const KELP_REALM_PLAYER_SPEED_WU_PER_SEC = 430;
export const KELP_REALM_BEACON_VISIT_RADIUS_WU = 72;
export const KELP_REALM_TOKEN_TTL_MS = 30 * 60 * 1000;
export const KELP_REALM_SPEED_GRACE_MULTIPLIER = 1.2;
/** Stable claim-time lookup key. Reveal this collectible by updating this SKU row in place. */
export const KELP_MAZE_COLLECTIBLE_SLUG = 'kelp-maze-collectible';
export const REWARD_ONLY_COSMETIC_CURRENCY = 'REWARD_ONLY';

/** The rejected corner maze is gone, but its northeast kelp grove stays scenery. */
export const KELP_FOREST_GROVE_WORLD_CENTER = Object.freeze({ x: 7808, z: -9900 });
export const KELP_FOREST_PORTAL_APPROACH_WORLD = Object.freeze({
  x: KELP_FOREST_PORTAL_WORLD_CENTER.x,
  z: KELP_FOREST_PORTAL_WORLD_CENTER.z + 240,
});
export const KELP_FOREST_PORTAL_APPROACH_GAME = Object.freeze({
  x: KELP_FOREST_PORTAL_APPROACH_WORLD.x + WORLD_CENTER_PX.x,
  y: KELP_FOREST_PORTAL_APPROACH_WORLD.z + WORLD_CENTER_PX.y,
});
export const KELP_FOREST_PORTAL_PROMPT_RADIUS_WU = 360;
/** Maximum animated tip displacement from a realm blade's authored position. */
export const KELP_REALM_ONE_SIDED_SWAY_WU = 100;
/** Tallest realm blades establish the shared world/realm sway fraction. */
export const KELP_REALM_SWAY_HEIGHT_FRACTION =
  KELP_REALM_ONE_SIDED_SWAY_WU / KELP_REALM_WALL_HEIGHT_WU;
/** Realm blade roots stay this far behind a corridor-facing wall edge. */
export const KELP_REALM_WALL_ROOT_SETBACK_WU = 96;
export const KELP_REALM_MAX_BLADE_HALF_WIDTH_WU = 28;
export const KELP_REALM_MAX_AUTHORED_BEND_WU = 26;
/** Conservative transverse radius of the widest, most-bent authored blade. */
export const KELP_REALM_MAX_STATIC_TIP_OFFSET_WU = Math.hypot(
  KELP_REALM_MAX_BLADE_HALF_WIDTH_WU,
  KELP_REALM_MAX_AUTHORED_BEND_WU,
);
/** Worst animated tip intrusion beyond a corridor-facing wall edge. */
export const KELP_REALM_MAX_CORRIDOR_INTRUSION_WU = Math.max(
  0,
  KELP_REALM_ONE_SIDED_SWAY_WU
  + KELP_REALM_MAX_STATIC_TIP_OFFSET_WU
  - KELP_REALM_WALL_ROOT_SETBACK_WU,
);
/** Complete visible-width loss between two opposing animated walls. */
export const KELP_REALM_MAX_SWAY_WU = KELP_REALM_ONE_SIDED_SWAY_WU * 2;
export const KELP_REALM_CORRIDOR_WIDTH_WU = KELP_REALM_CELL_WU;
export const KELP_REALM_VISIBLE_CORRIDOR_MIN_WU =
  KELP_REALM_CORRIDOR_WIDTH_WU - KELP_REALM_MAX_CORRIDOR_INTRUSION_WU * 2;

export type KelpRealmCell = '#' | '.' | 'E' | 'C';

/**
 * The sole authored maze source. `#` is kelp wall, `.` is corridor, `E` is
 * the only outer-boundary entry gap, and `C` is the center Pearl landmark.
 * The corridor graph is a tree: one entry-to-center route plus nine meaningful
 * dead-end branches. Everything spatial below is derived from these rows.
 */
export const KELP_REALM_LAYOUT = Object.freeze([
  '#####################',
  '#####################',
  '##.................##',
  '##.###.#######.######',
  '##...#.#.....#.#...##',
  '####.#.#.###.###.#.##',
  '##...#.#...#.....#.##',
  '##.###.###.#######.##',
  '##.#.#.....#.....#.##',
  '##.#.#######.###.#.##',
  '##.....#..C#...#.#.##',
  '######.#.###.#.###.##',
  '##...#.#.....#.#...##',
  '##.###.#.#####.#.####',
  '##.....#.#.....#...##',
  '##.#######.###.###.##',
  '##.#.......#.....#.##',
  '##.#.###.#########.##',
  '##...#...#.........##',
  '##########.##########',
  '##########E##########',
] as const);

export const KELP_REALM_ROWS = KELP_REALM_LAYOUT.length;
export const KELP_REALM_COLS = KELP_REALM_LAYOUT[0]!.length;
export const KELP_REALM_FOOTPRINT_WU = KELP_REALM_COLS * KELP_REALM_CELL_WU;

export interface KelpRealmCellCoord {
  readonly row: number;
  readonly col: number;
}

export interface KelpRealmWallAabb {
  readonly id: string;
  readonly row: number;
  readonly col: number;
  readonly centerX: number;
  readonly centerZ: number;
  readonly halfX: number;
  readonly halfZ: number;
}

export type KelpRealmBeaconKind = 'entry' | 'junction' | 'dead-end' | 'center';

export interface KelpRealmBeaconNode {
  readonly id: string;
  readonly kind: KelpRealmBeaconKind;
  readonly row: number;
  readonly col: number;
  readonly x: number;
  readonly z: number;
}

export interface KelpRealmBeaconEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly distanceWu: number;
  readonly path: readonly KelpRealmCellCoord[];
}

export interface KelpRealmBeaconGraph {
  readonly nodes: readonly KelpRealmBeaconNode[];
  readonly edges: readonly KelpRealmBeaconEdge[];
}

export type KelpRealmDiscoveryType = 'jellyfish' | 'anemone' | 'clam';

export interface KelpRealmDeadEndDiscovery {
  readonly beaconId: string;
  readonly type: KelpRealmDiscoveryType;
  readonly x: number;
  readonly z: number;
  readonly seed: number;
}

export const KELP_REALM_DISCOVERY_TYPES = Object.freeze([
  'jellyfish',
  'anemone',
  'clam',
] as const satisfies readonly KelpRealmDiscoveryType[]);

const DIRECTIONS = Object.freeze([
  Object.freeze({ row: -1, col: 0 }),
  Object.freeze({ row: 0, col: 1 }),
  Object.freeze({ row: 1, col: 0 }),
  Object.freeze({ row: 0, col: -1 }),
] as const);

function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

function isInBounds(row: number, col: number): boolean {
  return row >= 0 && row < KELP_REALM_ROWS && col >= 0 && col < KELP_REALM_COLS;
}

export function kelpRealmCellAt(row: number, col: number): KelpRealmCell | null {
  if (!isInBounds(row, col)) return null;
  return KELP_REALM_LAYOUT[row]![col] as KelpRealmCell;
}

export function isKelpRealmCorridorCell(row: number, col: number): boolean {
  const cell = kelpRealmCellAt(row, col);
  return cell !== null && cell !== '#';
}

export function kelpRealmCellCenterX(col: number): number {
  return (col - (KELP_REALM_COLS - 1) / 2) * KELP_REALM_CELL_WU;
}

export function kelpRealmCellCenterZ(row: number): number {
  return (row - (KELP_REALM_ROWS - 1) / 2) * KELP_REALM_CELL_WU;
}

function corridorNeighbors(row: number, col: number): KelpRealmCellCoord[] {
  const neighbors: KelpRealmCellCoord[] = [];
  for (const direction of DIRECTIONS) {
    const nextRow = row + direction.row;
    const nextCol = col + direction.col;
    if (isKelpRealmCorridorCell(nextRow, nextCol)) {
      neighbors.push({ row: nextRow, col: nextCol });
    }
  }
  return neighbors;
}

function buildWallAabbs(): readonly KelpRealmWallAabb[] {
  const walls: KelpRealmWallAabb[] = [];
  const half = KELP_REALM_CELL_WU / 2;
  for (let row = 0; row < KELP_REALM_ROWS; row++) {
    for (let col = 0; col < KELP_REALM_COLS; col++) {
      if (kelpRealmCellAt(row, col) !== '#') continue;
      walls.push(Object.freeze({
        id: `wall-${row}-${col}`,
        row,
        col,
        centerX: kelpRealmCellCenterX(col),
        centerZ: kelpRealmCellCenterZ(row),
        halfX: half,
        halfZ: half,
      }));
    }
  }
  return Object.freeze(walls);
}

function beaconId(cell: KelpRealmCell, row: number, col: number, degree: number): string {
  if (cell === 'E') return 'entry';
  if (cell === 'C') return 'center';
  return degree <= 1 ? `dead-end-${row}-${col}` : `junction-${row}-${col}`;
}

function buildBeaconGraph(): KelpRealmBeaconGraph {
  const nodes: KelpRealmBeaconNode[] = [];
  const nodeByCell = new Map<string, KelpRealmBeaconNode>();

  for (let row = 0; row < KELP_REALM_ROWS; row++) {
    for (let col = 0; col < KELP_REALM_COLS; col++) {
      const cell = kelpRealmCellAt(row, col);
      if (cell === null || cell === '#') continue;
      const degree = corridorNeighbors(row, col).length;
      if (cell !== 'E' && cell !== 'C' && degree === 2) continue;
      const kind: KelpRealmBeaconKind = cell === 'E'
        ? 'entry'
        : cell === 'C'
          ? 'center'
          : degree <= 1
            ? 'dead-end'
            : 'junction';
      const node = Object.freeze({
        id: beaconId(cell, row, col, degree),
        kind,
        row,
        col,
        x: kelpRealmCellCenterX(col),
        z: kelpRealmCellCenterZ(row),
      });
      nodes.push(node);
      nodeByCell.set(cellKey(row, col), node);
    }
  }

  const edgeById = new Map<string, KelpRealmBeaconEdge>();
  for (const node of nodes) {
    for (const first of corridorNeighbors(node.row, node.col)) {
      const path: KelpRealmCellCoord[] = [
        Object.freeze({ row: node.row, col: node.col }),
        Object.freeze({ row: first.row, col: first.col }),
      ];
      let previousRow = node.row;
      let previousCol = node.col;
      let row = first.row;
      let col = first.col;

      while (!nodeByCell.has(cellKey(row, col))) {
        const next = corridorNeighbors(row, col).find(
          (candidate) => candidate.row !== previousRow || candidate.col !== previousCol,
        );
        if (!next) throw new Error(`Kelp realm corridor terminated without beacon at ${row}:${col}`);
        previousRow = row;
        previousCol = col;
        row = next.row;
        col = next.col;
        path.push(Object.freeze({ row, col }));
      }

      const target = nodeByCell.get(cellKey(row, col))!;
      if (target.id === node.id) continue;
      const pair = node.id < target.id
        ? `${node.id}--${target.id}`
        : `${target.id}--${node.id}`;
      if (edgeById.has(pair)) continue;
      edgeById.set(pair, Object.freeze({
        id: pair,
        from: node.id,
        to: target.id,
        distanceWu: (path.length - 1) * KELP_REALM_CELL_WU,
        path: Object.freeze(path),
      }));
    }
  }

  return Object.freeze({
    nodes: Object.freeze(nodes),
    edges: Object.freeze([...edgeById.values()]),
  });
}

function findCell(marker: 'E' | 'C'): KelpRealmCellCoord {
  for (let row = 0; row < KELP_REALM_ROWS; row++) {
    const col = KELP_REALM_LAYOUT[row]!.indexOf(marker);
    if (col >= 0) return Object.freeze({ row, col });
  }
  throw new Error(`Kelp realm marker ${marker} is missing`);
}

function derivePlayerSpawn(entry: KelpRealmCellCoord): Readonly<{ x: number; z: number }> {
  const inside = corridorNeighbors(entry.row, entry.col).some(
    (cell) => cell.row > 0 && cell.row < KELP_REALM_ROWS - 1 && cell.col > 0 && cell.col < KELP_REALM_COLS - 1,
  );
  if (!inside) throw new Error('Kelp realm entry has no interior corridor neighbor');
  return Object.freeze({
    x: kelpRealmCellCenterX(entry.col),
    z: kelpRealmCellCenterZ(entry.row),
  });
}

function deriveSporeBeaconIds(graph: KelpRealmBeaconGraph): readonly string[] {
  const distances = new Map<string, number>([['entry', 0]]);
  const unvisited = new Set(graph.nodes.map((node) => node.id));

  while (unvisited.size > 0) {
    let currentId: string | null = null;
    let currentDistance = Number.POSITIVE_INFINITY;
    for (const id of unvisited) {
      const distance = distances.get(id) ?? Number.POSITIVE_INFINITY;
      if (distance < currentDistance) {
        currentId = id;
        currentDistance = distance;
      }
    }
    if (currentId === null) break;
    unvisited.delete(currentId);

    for (const edge of graph.edges) {
      const adjacentId = edge.from === currentId
        ? edge.to
        : edge.to === currentId
          ? edge.from
          : null;
      if (adjacentId === null || !unvisited.has(adjacentId)) continue;
      const candidateDistance = currentDistance + edge.distanceWu;
      if (candidateDistance < (distances.get(adjacentId) ?? Number.POSITIVE_INFINITY)) {
        distances.set(adjacentId, candidateDistance);
      }
    }
  }

  const deepest = graph.nodes
    .filter((node) => node.kind === 'dead-end')
    .map((node) => ({ id: node.id, distanceWu: distances.get(node.id) ?? -1 }))
    .sort((a, b) => b.distanceWu - a.distanceWu || a.id.localeCompare(b.id))
    .slice(0, KELP_REALM_SPORE_COUNT)
    .map(({ id }) => id);
  if (deepest.length !== KELP_REALM_SPORE_COUNT) {
    throw new Error(`Kelp realm needs ${KELP_REALM_SPORE_COUNT} spore dead ends`);
  }
  return Object.freeze(deepest);
}

export const KELP_REALM_ENTRY_CELL = findCell('E');
export const KELP_REALM_CENTER_CELL = findCell('C');
export const KELP_REALM_PLAYER_SPAWN = derivePlayerSpawn(KELP_REALM_ENTRY_CELL);
export const KELP_REALM_CENTER = Object.freeze({
  x: kelpRealmCellCenterX(KELP_REALM_CENTER_CELL.col),
  z: kelpRealmCellCenterZ(KELP_REALM_CENTER_CELL.row),
});
export const KELP_REALM_WALL_AABBS = buildWallAabbs();
export const KELP_REALM_BEACON_GRAPH = buildBeaconGraph();
export const KELP_REALM_SPORE_COUNT = 3;
export const KELP_REALM_SPORE_FULL_MASK = (1 << KELP_REALM_SPORE_COUNT) - 1;
export const KELP_REALM_SPORE_BEACON_IDS = deriveSporeBeaconIds(KELP_REALM_BEACON_GRAPH);
export const KELP_REALM_DEAD_END_DISCOVERIES = Object.freeze(
  KELP_REALM_BEACON_GRAPH.nodes
    .filter((node) => node.kind === 'dead-end')
    .map((node, index) => Object.freeze({
      beaconId: node.id,
      type: KELP_REALM_DISCOVERY_TYPES[index % KELP_REALM_DISCOVERY_TYPES.length]!,
      x: node.x,
      z: node.z,
      seed: 0x4b444500 + index * 977,
    })),
);

export const KELP_REALM_LAYOUT_INVARIANTS = Object.freeze({
  rows: KELP_REALM_ROWS,
  cols: KELP_REALM_COLS,
  footprintWu: KELP_REALM_FOOTPRINT_WU,
  corridorWidthWu: KELP_REALM_CORRIDOR_WIDTH_WU,
  visibleCorridorMinWu: KELP_REALM_VISIBLE_CORRIDOR_MIN_WU,
  wallHeightWu: KELP_REALM_WALL_HEIGHT_WU,
  maxSwayWu: KELP_REALM_MAX_SWAY_WU,
  oneSidedSwayWu: KELP_REALM_ONE_SIDED_SWAY_WU,
  deadEndBranches: KELP_REALM_BEACON_GRAPH.nodes.filter((node) => node.kind === 'dead-end').length,
});
