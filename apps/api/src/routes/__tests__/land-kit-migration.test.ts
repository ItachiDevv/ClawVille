import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('0049 land structure pieces migration', () => {
  const sql = readFileSync(
    join(
      import.meta.dir,
      '..',
      '..',
      '..',
      '..',
      '..',
      'packages',
      'database',
      'migrations',
      '0049_land_structure_pieces.sql',
    ),
    'utf8',
  );

  it('creates only the additive idempotent piece table and parcel index', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "land_structure_pieces"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "land_structure_pieces_parcel_idx"');
    expect(sql).not.toMatch(/\b(DROP|TRUNCATE)\b/i);
    expect(sql).not.toMatch(/ALTER\s+TYPE/i);
  });

  it('pins cascade ownership, bounds, rotation, stacking, and occupancy', () => {
    expect(sql).toMatch(
      /FOREIGN KEY \("parcel_id"\) REFERENCES "land_parcels"\("id"\) ON DELETE CASCADE/,
    );
    expect(sql).toMatch(/FOREIGN KEY \("owner_avatar_id"\) REFERENCES "avatars"\("id"\)/);
    expect(sql).toContain('CHECK ("grid_x" BETWEEN 0 AND 15)');
    expect(sql).toContain('CHECK ("grid_y" BETWEEN 0 AND 15)');
    expect(sql).toContain('CHECK ("rotation_step" BETWEEN 0 AND 7)');
    expect(sql).toContain('CHECK ("stack_level" BETWEEN 1 AND 3)');
    expect(sql).toContain('UNIQUE ("parcel_id", "grid_x", "grid_y", "stack_level")');
  });

  it('contains no renderer, asset, collider, or pathfinding columns', () => {
    expect(sql).not.toMatch(/asset|\.glb|collider|pathfinding/i);
  });
});
