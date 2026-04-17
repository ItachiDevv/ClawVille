/**
 * A* pathfinding for NPC navigation on the 160x160 tile grid.
 * Buildings are blocked tiles; NPCs navigate around them.
 */

import { BUILDING_TILE_ZONES } from '@clawville/shared';

const COLS = 160;
const ROWS = 160;
const TILE = 32;

export interface PathNode {
  x: number; // pixel coord
  y: number; // pixel coord
}

/** Compute walkability grid: true = walkable, false = blocked.
 *  BUILDING_TILE_ZONES is authoritative tile zone (14×14) but the rendered
 *  building footprint can reach MAX_FOOTPRINT = 1000 wu = 31.25 tiles.
 *  BUILDING_EXCLUSION_PAD expands the zone by 9 tiles in each direction so
 *  pathfinding blocks the visual footprint and NPCs stop walking through
 *  the rendered geometry. Effective half-extent = 7+9 = 16 tiles = 512 wu. */
const BUILDING_EXCLUSION_PAD = 9;

function buildWalkabilityGrid(): boolean[][] {
  const grid: boolean[][] = [];
  for (let r = 0; r < ROWS; r++) {
    grid[r] = [];
    for (let c = 0; c < COLS; c++) {
      grid[r][c] = true;
    }
  }

  // Mark building tiles as blocked — expanded by BUILDING_EXCLUSION_PAD
  for (const zone of Object.values(BUILDING_TILE_ZONES) as { x: number; y: number; w: number; h: number }[]) {
    const r0 = zone.y - BUILDING_EXCLUSION_PAD;
    const r1 = zone.y + zone.h + BUILDING_EXCLUSION_PAD;
    const c0 = zone.x - BUILDING_EXCLUSION_PAD;
    const c1 = zone.x + zone.w + BUILDING_EXCLUSION_PAD;
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        if (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
          grid[r][c] = false;
        }
      }
    }
  }

  return grid;
}

// Cache the grid since it never changes
let cachedGrid: boolean[][] | null = null;
function getGrid(): boolean[][] {
  if (!cachedGrid) cachedGrid = buildWalkabilityGrid();
  return cachedGrid;
}

interface AStarNode {
  col: number;
  row: number;
  g: number; // cost from start
  h: number; // heuristic to end
  f: number; // g + h
  parent: AStarNode | null;
}

/** Manhattan distance heuristic */
function heuristic(c1: number, r1: number, c2: number, r2: number): number {
  return Math.abs(c1 - c2) + Math.abs(r1 - r2);
}

/** Min-heap priority queue for A* */
class MinHeap {
  private items: AStarNode[] = [];

  get size() { return this.items.length; }

  push(node: AStarNode) {
    this.items.push(node);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): AStarNode | undefined {
    if (this.items.length === 0) return undefined;
    const min = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.sinkDown(0);
    }
    return min;
  }

  private bubbleUp(i: number) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[i].f >= this.items[parent].f) break;
      [this.items[i], this.items[parent]] = [this.items[parent], this.items[i]];
      i = parent;
    }
  }

  private sinkDown(i: number) {
    const len = this.items.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < len && this.items[left].f < this.items[smallest].f) smallest = left;
      if (right < len && this.items[right].f < this.items[smallest].f) smallest = right;
      if (smallest === i) break;
      [this.items[i], this.items[smallest]] = [this.items[smallest], this.items[i]];
      i = smallest;
    }
  }
}

// 4-directional neighbors
const DIRS = [
  [0, -1], [0, 1], [-1, 0], [1, 0],
  // diagonals (optional — cost sqrt(2))
  [-1, -1], [-1, 1], [1, -1], [1, 1],
];

/**
 * Find a path from pixel (startX, startY) to pixel (endX, endY).
 * Returns pixel-coord waypoints, or empty array if no path found.
 */
export function findPath(startX: number, startY: number, endX: number, endY: number): PathNode[] {
  const grid = getGrid();

  // Convert pixel to tile coords
  const sc = Math.floor(startX / TILE);
  const sr = Math.floor(startY / TILE);
  const ec = Math.floor(endX / TILE);
  const er = Math.floor(endY / TILE);

  // Clamp to grid
  const startCol = Math.max(0, Math.min(COLS - 1, sc));
  const startRow = Math.max(0, Math.min(ROWS - 1, sr));
  let endCol = Math.max(0, Math.min(COLS - 1, ec));
  let endRow = Math.max(0, Math.min(ROWS - 1, er));

  // If end is blocked, find nearest walkable tile
  if (!grid[endRow][endCol]) {
    const nearest = findNearestWalkable(endCol, endRow, grid);
    if (!nearest) return [];
    endCol = nearest.col;
    endRow = nearest.row;
  }

  if (startCol === endCol && startRow === endRow) {
    return [{ x: endX, y: endY }];
  }

  const open = new MinHeap();
  const closed = new Set<string>();
  const key = (c: number, r: number) => `${c},${r}`;

  const startNode: AStarNode = {
    col: startCol, row: startRow,
    g: 0, h: heuristic(startCol, startRow, endCol, endRow),
    f: heuristic(startCol, startRow, endCol, endRow),
    parent: null,
  };
  open.push(startNode);

  const gScores = new Map<string, number>();
  gScores.set(key(startCol, startRow), 0);

  let iterations = 0;
  const maxIterations = 6000; // safety limit

  while (open.size > 0 && iterations < maxIterations) {
    iterations++;
    const current = open.pop()!;
    const ck = key(current.col, current.row);

    if (current.col === endCol && current.row === endRow) {
      // Reconstruct path
      return reconstructPath(current, endX, endY);
    }

    if (closed.has(ck)) continue;
    closed.add(ck);

    for (const [dc, dr] of DIRS) {
      const nc = current.col + dc;
      const nr = current.row + dr;

      if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
      if (!grid[nr][nc]) continue;
      if (closed.has(key(nc, nr))) continue;

      // Diagonal movement: check that both adjacent cardinal tiles are walkable
      if (dc !== 0 && dr !== 0) {
        if (!grid[current.row + dr][current.col] || !grid[current.row][current.col + dc]) continue;
      }

      const moveCost = (dc !== 0 && dr !== 0) ? 1.41 : 1;
      const tentG = current.g + moveCost;
      const nk = key(nc, nr);
      const existingG = gScores.get(nk);

      if (existingG !== undefined && tentG >= existingG) continue;

      gScores.set(nk, tentG);
      const h = heuristic(nc, nr, endCol, endRow);
      open.push({
        col: nc, row: nr,
        g: tentG, h, f: tentG + h,
        parent: current,
      });
    }
  }

  return []; // no path found
}

function reconstructPath(end: AStarNode, targetX: number, targetY: number): PathNode[] {
  const tilePath: AStarNode[] = [];
  let node: AStarNode | null = end;
  while (node) {
    tilePath.unshift(node);
    node = node.parent;
  }

  // Convert to pixel coords (tile center), then smooth
  const pixelPath: PathNode[] = tilePath.map((n) => ({
    x: n.col * TILE + TILE / 2,
    y: n.row * TILE + TILE / 2,
  }));

  // Replace final waypoint with exact target position
  if (pixelPath.length > 0) {
    pixelPath[pixelPath.length - 1] = { x: targetX, y: targetY };
  }

  // Path smoothing: skip intermediate waypoints when direction doesn't change
  return smoothPath(pixelPath);
}

function smoothPath(path: PathNode[]): PathNode[] {
  if (path.length <= 2) return path;

  const smoothed: PathNode[] = [path[0]];
  let lastDir = { x: 0, y: 0 };

  for (let i = 1; i < path.length; i++) {
    const prev = smoothed[smoothed.length - 1];
    const dx = Math.sign(path[i].x - prev.x);
    const dy = Math.sign(path[i].y - prev.y);

    if (dx !== lastDir.x || dy !== lastDir.y) {
      // Direction changed — keep the previous point
      if (i > 1) smoothed.push(path[i - 1]);
      lastDir = { x: dx, y: dy };
    }
  }

  smoothed.push(path[path.length - 1]);
  return smoothed;
}

function findNearestWalkable(col: number, row: number, grid: boolean[][]): { col: number; row: number } | null {
  // A building's center tile is half_w (7) tiles from the zone edge, plus
  // BUILDING_EXCLUSION_PAD (9) more tiles of blocked margin — minimum
  // Chebyshev distance from center to a walkable tile is 16. The old
  // ceiling of 10 guaranteed failure on every building target, so the
  // autonomy engine looped "can't find a path" forever. 20 = safe margin.
  const maxRadius = 20;
  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue;
        const nc = col + dc;
        const nr = row + dr;
        if (nc >= 0 && nc < COLS && nr >= 0 && nr < ROWS && grid[nr][nc]) {
          return { col: nc, row: nr };
        }
      }
    }
  }
  return null;
}
