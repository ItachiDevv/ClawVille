import {
  TILE_SIZE,
  MAP_COLS,
  MAP_ROWS,
  groundLayer,
  pathLayer,
  decorationLayer,
  buildingLayer,
} from './tilemap-data';

export interface TileLayerData {
  name: string;
  tiles: number[];
  cols: number;
  rows: number;
  tileSize: number;
}

/**
 * Returns all four tile layers in render order (bottom to top).
 * Each layer is a flat array of tile indices where -1 means transparent.
 */
export function getTileLayers(): TileLayerData[] {
  return [
    { name: 'ground', tiles: groundLayer, cols: MAP_COLS, rows: MAP_ROWS, tileSize: TILE_SIZE },
    { name: 'paths', tiles: pathLayer, cols: MAP_COLS, rows: MAP_ROWS, tileSize: TILE_SIZE },
    { name: 'decorations', tiles: decorationLayer, cols: MAP_COLS, rows: MAP_ROWS, tileSize: TILE_SIZE },
    { name: 'buildings', tiles: buildingLayer, cols: MAP_COLS, rows: MAP_ROWS, tileSize: TILE_SIZE },
  ];
}

/**
 * Get the tile index at a specific grid position within a layer.
 * Returns -1 (EMPTY) if out of bounds.
 */
export function getTileAt(layer: number[], col: number, row: number): number {
  if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) return -1;
  return layer[row * MAP_COLS + col];
}

/**
 * Convert pixel coordinates to tile grid coordinates.
 */
export function pixelToTile(px: number, py: number): { col: number; row: number } {
  return {
    col: Math.floor(px / TILE_SIZE),
    row: Math.floor(py / TILE_SIZE),
  };
}

/**
 * Convert tile grid coordinates to pixel coordinates (top-left of the tile).
 */
export function tileToPixel(col: number, row: number): { x: number; y: number } {
  return {
    x: col * TILE_SIZE,
    y: row * TILE_SIZE,
  };
}
