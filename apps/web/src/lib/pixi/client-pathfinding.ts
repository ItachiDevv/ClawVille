/**
 * Client-side A* pathfinding for click-to-move.
 * Ported from apps/api/src/services/pathfinding.ts for instant responsiveness.
 */

import { WORLD_PX_WIDTH, WORLD_PX_HEIGHT, WORLD_CENTER_PX } from '@clawville/shared';
import { getAllColliders } from '@/lib/three/collision/world-colliders';

const TILE = 32;
const COLS = WORLD_PX_WIDTH / TILE;
const ROWS = WORLD_PX_HEIGHT / TILE;
const COLLIDER_SAFETY_TILES = 4;

export interface PathNode {
  x: number;
  y: number;
}

/** Full-world grid built once. Includes real building and prop footprints. */
function buildWalkabilityGrid(): Uint8Array[] {
  const grid = Array.from({ length: ROWS }, () => new Uint8Array(COLS).fill(1));
  for (const collider of getAllColliders()) {
    if (collider.walkable) continue;
    if (collider.pathfindingRaster?.mode === 'cell-center-expanded-aabb') {
      const pad = collider.pathfindingRaster.paddingWu;
      const minX = Math.ceil((collider.centerX - collider.halfX - pad + WORLD_CENTER_PX.x - TILE / 2) / TILE);
      const maxX = Math.floor((collider.centerX + collider.halfX + pad + WORLD_CENTER_PX.x - TILE / 2) / TILE);
      const minY = Math.ceil((collider.centerZ - collider.halfZ - pad + WORLD_CENTER_PX.y - TILE / 2) / TILE);
      const maxY = Math.floor((collider.centerZ + collider.halfZ + pad + WORLD_CENTER_PX.y - TILE / 2) / TILE);
      for (let row = Math.max(0, minY); row <= Math.min(ROWS - 1, maxY); row++) {
        grid[row].fill(0, Math.max(0, minX), Math.min(COLS, maxX + 1));
      }
      continue;
    }
    const cx = Math.floor((collider.centerX + WORLD_CENTER_PX.x) / TILE);
    const cy = Math.floor((collider.centerZ + WORLD_CENTER_PX.y) / TILE);
    const hx = Math.ceil(collider.halfX / TILE) + COLLIDER_SAFETY_TILES;
    const hy = Math.ceil(collider.halfZ / TILE) + COLLIDER_SAFETY_TILES;
    for (let row = Math.max(0, cy - hy); row <= Math.min(ROWS - 1, cy + hy); row++) {
      grid[row].fill(0, Math.max(0, cx - hx), Math.min(COLS, cx + hx + 1));
    }
  }
  return grid;
}

let cachedGrid: Uint8Array[] | null = null;
let components: Uint32Array | null = null;
let search: { closed: Uint32Array; seen: Uint32Array; scores: Float64Array; generation: number } | null = null;
function labelComponents(grid: Uint8Array[]): Uint32Array {
  const labels = new Uint32Array(COLS * ROWS), queue = new Uint32Array(COLS * ROWS);
  let component = 0;
  for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++) {
    const cell = row * COLS + col;
    if (!grid[row][col] || labels[cell]) continue;
    let head = 0, tail = 0; labels[cell] = ++component; queue[tail++] = cell;
    while (head < tail) {
      const current = queue[head++], r = Math.floor(current / COLS), c = current % COLS;
      for (let direction = 0; direction < 4; direction++) {
        const nc = c + (direction === 0 ? -1 : direction === 1 ? 1 : 0);
        const nr = r + (direction === 2 ? -1 : direction === 3 ? 1 : 0);
        if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS || !grid[nr][nc]) continue;
        const next = nr * COLS + nc;
        if (!labels[next]) { labels[next] = component; queue[tail++] = next; }
      }
    }
  }
  return labels;
}
function getGrid(): Uint8Array[] {
  if (!cachedGrid) { cachedGrid = buildWalkabilityGrid(); components = labelComponents(cachedGrid); }
  return cachedGrid;
}

interface AStarNode {
  col: number;
  row: number;
  g: number;
  h: number;
  f: number;
  parent: AStarNode | null;
}

function heuristic(c1: number, r1: number, c2: number, r2: number): number {
  return Math.abs(c1 - c2) + Math.abs(r1 - r2);
}

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

const DIRS = [
  [0, -1], [0, 1], [-1, 0], [1, 0],
  [-1, -1], [-1, 1], [1, -1], [1, 1],
];

export function findPath(startX: number, startY: number, endX: number, endY: number): PathNode[] {
  const grid = getGrid();

  const sc = Math.floor(startX / TILE);
  const sr = Math.floor(startY / TILE);
  const ec = Math.floor(endX / TILE);
  const er = Math.floor(endY / TILE);

  let startCol = Math.max(0, Math.min(COLS - 1, sc));
  let startRow = Math.max(0, Math.min(ROWS - 1, sr));
  let endCol = Math.max(0, Math.min(COLS - 1, ec));
  let endRow = Math.max(0, Math.min(ROWS - 1, er));

  if (!grid[startRow][startCol]) {
    const nearest = findNearestWalkable(startCol, startRow, grid);
    if (!nearest) return [];
    startCol = nearest.col;
    startRow = nearest.row;
  }

  // A snapped endpoint must never append the original point inside a collider.
  let targetX = Math.max(TILE / 2, Math.min(WORLD_PX_WIDTH - TILE / 2, endX));
  let targetY = Math.max(TILE / 2, Math.min(WORLD_PX_HEIGHT - TILE / 2, endY));
  if (!grid[endRow][endCol]) {
    const nearest = findNearestWalkable(endCol, endRow, grid);
    if (!nearest) return [];
    endCol = nearest.col;
    endRow = nearest.row;
    targetX = endCol * TILE + TILE / 2;
    targetY = endRow * TILE + TILE / 2;
  }

  if (startCol === endCol && startRow === endRow) {
    return [{ x: targetX, y: targetY }];
  }

  if (components![startRow * COLS + startCol] !== components![endRow * COLS + endCol]) return [];
  if (!search) search = { closed: new Uint32Array(COLS * ROWS), seen: new Uint32Array(COLS * ROWS), scores: new Float64Array(COLS * ROWS), generation: 0 };
  if (++search.generation === 0xffffffff) { search.closed.fill(0); search.seen.fill(0); search.generation = 1; }
  const generation = search.generation, closed = search.closed, seen = search.seen;
  const open = new MinHeap();
  const key = (c: number, r: number) => r * COLS + c;

  const startNode: AStarNode = {
    col: startCol, row: startRow,
    g: 0, h: heuristic(startCol, startRow, endCol, endRow),
    f: heuristic(startCol, startRow, endCol, endRow),
    parent: null,
  };
  open.push(startNode);

  const gScores = search.scores;
  gScores[key(startCol, startRow)] = 0; seen[key(startCol, startRow)] = generation;

  let iterations = 0;
  const maxIterations = 80_000; // same bounded town-route ceiling as the server planner

  while (open.size > 0 && iterations < maxIterations) {
    iterations++;
    const current = open.pop()!;
    const ck = key(current.col, current.row);

    if (current.col === endCol && current.row === endRow) {
      return reconstructPath(current, targetX, targetY);
    }

    if (closed[ck] === generation) continue;
    closed[ck] = generation;

    for (const [dc, dr] of DIRS) {
      const nc = current.col + dc;
      const nr = current.row + dr;

      if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
      if (!grid[nr][nc]) continue;
      if (closed[key(nc, nr)] === generation) continue;

      if (dc !== 0 && dr !== 0) {
        if (!grid[current.row + dr][current.col] || !grid[current.row][current.col + dc]) continue;
      }

      const moveCost = (dc !== 0 && dr !== 0) ? 1.41 : 1;
      const tentG = current.g + moveCost;
      const nk = key(nc, nr);
      const existingG = seen[nk] === generation ? gScores[nk] : Number.POSITIVE_INFINITY;

      if (tentG >= existingG) continue;

      gScores[nk] = tentG; seen[nk] = generation;
      const h = heuristic(nc, nr, endCol, endRow);
      open.push({
        col: nc, row: nr,
        g: tentG, h, f: tentG + h,
        parent: current,
      });
    }
  }

  return [];
}

function reconstructPath(end: AStarNode, targetX: number, targetY: number): PathNode[] {
  const tilePath: AStarNode[] = [];
  let node: AStarNode | null = end;
  while (node) {
    tilePath.unshift(node);
    node = node.parent;
  }

  const pixelPath: PathNode[] = tilePath.map((n) => ({
    x: n.col * TILE + TILE / 2,
    y: n.row * TILE + TILE / 2,
  }));

  if (pixelPath.length > 0) {
    pixelPath[pixelPath.length - 1] = { x: targetX, y: targetY };
  }

  // Remove collinear nodes only. Every retained segment crosses the original grid cells.
  return pixelPath.filter((point, index) => {
    if (index === 0 || index === pixelPath.length - 1) return true;
    const before = pixelPath[index - 1], after = pixelPath[index + 1];
    const ax = point.x - before.x, ay = point.y - before.y;
    const bx = after.x - point.x, by = after.y - point.y;
    return ax * by !== ay * bx || ax * bx + ay * by <= 0;
  });
}

function findNearestWalkable(col: number, row: number, grid: Uint8Array[]): { col: number; row: number } | null {
  // Real building footprints plus the server safety halo can exceed 30 tiles.
  const maxRadius = 48;
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
