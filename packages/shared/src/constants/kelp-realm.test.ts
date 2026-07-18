import { describe, expect, test } from 'bun:test';
import {
  KELP_REALM_BEACON_GRAPH,
  KELP_REALM_CELL_WU,
  KELP_REALM_CENTER_CELL,
  KELP_REALM_COLS,
  KELP_REALM_CORRIDOR_WIDTH_WU,
  KELP_REALM_ENTRY_CELL,
  KELP_REALM_LAYOUT,
  KELP_REALM_LAYOUT_INVARIANTS,
  KELP_REALM_MAX_AUTHORED_BEND_WU,
  KELP_REALM_MAX_BLADE_HALF_WIDTH_WU,
  KELP_REALM_MAX_CORRIDOR_INTRUSION_WU,
  KELP_REALM_MAX_STATIC_TIP_OFFSET_WU,
  KELP_REALM_MAX_SWAY_WU,
  KELP_REALM_ONE_SIDED_SWAY_WU,
  KELP_REALM_SWAY_HEIGHT_FRACTION,
  KELP_REALM_VISIBLE_CORRIDOR_MIN_WU,
  KELP_REALM_WALL_HEIGHT_WU,
  KELP_REALM_WALL_ROOT_SETBACK_WU,
  KELP_REALM_PLAYER_SPAWN,
  KELP_REALM_PLAYER_SPEED_WU_PER_SEC,
  KELP_REALM_ROWS,
  KELP_REALM_BEACON_VISIT_RADIUS_WU,
  kelpRealmCellCenterX,
  kelpRealmCellCenterZ,
  isKelpRealmCorridorCell,
} from './kelp-realm';

const DIRECTIONS = [
  [-1, 0],
  [0, 1],
  [1, 0],
  [0, -1],
] as const;

function key(row: number, col: number): string {
  return `${row}:${col}`;
}

function corridorNeighbors(row: number, col: number): Array<readonly [number, number]> {
  return DIRECTIONS
    .map(([dr, dc]) => [row + dr, col + dc] as const)
    .filter(([nextRow, nextCol]) => isKelpRealmCorridorCell(nextRow, nextCol));
}

describe('Kelp Forest realm layout invariants', () => {
  test('is a 13x13 origin-centered maze with one outer entry gap', () => {
    expect(KELP_REALM_ROWS).toBe(13);
    expect(KELP_REALM_COLS).toBe(13);
    expect(KELP_REALM_LAYOUT.every((row) => row.length === KELP_REALM_COLS)).toBe(true);

    const boundaryOpenings: Array<{ row: number; col: number; cell: string }> = [];
    for (let row = 0; row < KELP_REALM_ROWS; row++) {
      for (let col = 0; col < KELP_REALM_COLS; col++) {
        if (row !== 0 && row !== KELP_REALM_ROWS - 1 && col !== 0 && col !== KELP_REALM_COLS - 1) continue;
        const cell = KELP_REALM_LAYOUT[row]![col]!;
        if (cell !== '#') boundaryOpenings.push({ row, col, cell });
      }
    }
    expect(boundaryOpenings).toEqual([
      { row: KELP_REALM_ENTRY_CELL.row, col: KELP_REALM_ENTRY_CELL.col, cell: 'E' },
    ]);
  });

  test('keeps at least 60wu visible between opposing 100wu sways', () => {
    expect(KELP_REALM_CORRIDOR_WIDTH_WU).toBe(KELP_REALM_CELL_WU);
    expect(KELP_REALM_CORRIDOR_WIDTH_WU).toBe(200);
    expect(KELP_REALM_ONE_SIDED_SWAY_WU).toBe(100);
    expect(KELP_REALM_SWAY_HEIGHT_FRACTION).toBe(
      KELP_REALM_ONE_SIDED_SWAY_WU / KELP_REALM_WALL_HEIGHT_WU,
    );
    expect(KELP_REALM_MAX_SWAY_WU).toBe(KELP_REALM_ONE_SIDED_SWAY_WU * 2);
    expect(KELP_REALM_MAX_STATIC_TIP_OFFSET_WU).toBe(
      Math.hypot(KELP_REALM_MAX_BLADE_HALF_WIDTH_WU, KELP_REALM_MAX_AUTHORED_BEND_WU),
    );
    expect(KELP_REALM_MAX_CORRIDOR_INTRUSION_WU).toBeCloseTo(
      KELP_REALM_ONE_SIDED_SWAY_WU
        + KELP_REALM_MAX_STATIC_TIP_OFFSET_WU
        - KELP_REALM_WALL_ROOT_SETBACK_WU,
    );
    expect(
      KELP_REALM_CORRIDOR_WIDTH_WU - KELP_REALM_MAX_CORRIDOR_INTRUSION_WU * 2,
    ).toBeGreaterThanOrEqual(60);
    expect(KELP_REALM_VISIBLE_CORRIDOR_MIN_WU).toBeCloseTo(66.925, 3);
    expect(KELP_REALM_LAYOUT_INVARIANTS.visibleCorridorMinWu).toBeCloseTo(66.925, 3);
  });

  test('shares the real movement speed, proximity radius, and entry spawn with the server', () => {
    expect(KELP_REALM_PLAYER_SPEED_WU_PER_SEC).toBe(430);
    expect(KELP_REALM_BEACON_VISIT_RADIUS_WU).toBe(72);
    expect(KELP_REALM_BEACON_VISIT_RADIUS_WU).toBeLessThan(KELP_REALM_CELL_WU / 2);
    expect(KELP_REALM_PLAYER_SPAWN).toEqual({
      x: kelpRealmCellCenterX(KELP_REALM_ENTRY_CELL.col),
      z: kelpRealmCellCenterZ(KELP_REALM_ENTRY_CELL.row),
    });
  });

  test('has one unique entry-to-center route and six substantial dead ends', () => {
    const corridors: Array<readonly [number, number]> = [];
    let undirectedEdges = 0;
    for (let row = 0; row < KELP_REALM_ROWS; row++) {
      for (let col = 0; col < KELP_REALM_COLS; col++) {
        if (!isKelpRealmCorridorCell(row, col)) continue;
        corridors.push([row, col]);
        undirectedEdges += corridorNeighbors(row, col).length;
      }
    }
    undirectedEdges /= 2;

    const seen = new Set<string>([key(KELP_REALM_ENTRY_CELL.row, KELP_REALM_ENTRY_CELL.col)]);
    const queue: Array<readonly [number, number]> = [[KELP_REALM_ENTRY_CELL.row, KELP_REALM_ENTRY_CELL.col]];
    while (queue.length > 0) {
      const [row, col] = queue.shift()!;
      for (const [nextRow, nextCol] of corridorNeighbors(row, col)) {
        const nextKey = key(nextRow, nextCol);
        if (seen.has(nextKey)) continue;
        seen.add(nextKey);
        queue.push([nextRow, nextCol]);
      }
    }

    expect(seen.has(key(KELP_REALM_CENTER_CELL.row, KELP_REALM_CENTER_CELL.col))).toBe(true);
    expect(seen.size).toBe(corridors.length);
    expect(undirectedEdges).toBe(corridors.length - 1);

    const deadEnds = KELP_REALM_BEACON_GRAPH.nodes.filter((node) => node.kind === 'dead-end');
    expect(deadEnds).toHaveLength(6);
    for (const deadEnd of deadEnds) {
      const branchEdge = KELP_REALM_BEACON_GRAPH.edges.find(
        (edge) => edge.from === deadEnd.id || edge.to === deadEnd.id,
      );
      expect(branchEdge?.distanceWu).toBeGreaterThanOrEqual(KELP_REALM_CELL_WU * 2);
    }
  });

  test('derives a connected beacon graph whose every edge is a traversable corridor', () => {
    const nodes = new Map(KELP_REALM_BEACON_GRAPH.nodes.map((node) => [node.id, node]));
    expect(nodes.has('entry')).toBe(true);
    expect(nodes.has('center')).toBe(true);

    for (const edge of KELP_REALM_BEACON_GRAPH.edges) {
      expect(nodes.has(edge.from)).toBe(true);
      expect(nodes.has(edge.to)).toBe(true);
      expect(edge.distanceWu).toBe((edge.path.length - 1) * KELP_REALM_CELL_WU);
      for (let index = 0; index < edge.path.length; index++) {
        const cell = edge.path[index]!;
        expect(isKelpRealmCorridorCell(cell.row, cell.col)).toBe(true);
        if (index === 0) continue;
        const previous = edge.path[index - 1]!;
        expect(Math.abs(cell.row - previous.row) + Math.abs(cell.col - previous.col)).toBe(1);
      }
    }

    const adjacency = new Map<string, string[]>();
    for (const id of nodes.keys()) adjacency.set(id, []);
    for (const edge of KELP_REALM_BEACON_GRAPH.edges) {
      adjacency.get(edge.from)!.push(edge.to);
      adjacency.get(edge.to)!.push(edge.from);
    }
    const seen = new Set<string>(['entry']);
    const queue = ['entry'];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const next of adjacency.get(id) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    expect(seen.size).toBe(nodes.size);
  });
});
