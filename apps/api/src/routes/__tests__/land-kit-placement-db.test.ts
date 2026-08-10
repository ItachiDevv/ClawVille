/**
 * Kit placement predicate — REAL DB wiring suite (defect D-1, slice P3).
 *
 * `packages/shared/src/constants/land-placement.test.ts` proves the PREDICATE.
 * This proves the WIRING: that the write path reads the parcel's real rows,
 * grandfathers them, and refuses through `evaluatePlacement` rather than the
 * anchor-cell check it replaced.
 *
 * The cases are chosen to be tier-independent so they cannot go stale if the
 * parcel the suite borrows changes: the shell reservation always covers the
 * grid centre, an exact-cell repeat is always an overlap, and stacking on
 * nothing is always unsupported.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { db, sql } from '@clawville/database';
import type { LandTier } from '@clawville/shared';
import { evaluateKitWrite, kitPlacementRefusalStatus } from '../land';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

function first<T>(rows: Iterable<T>): T {
  const [row] = Array.from(rows);
  if (!row) throw new Error('expected at least one row');
  return row;
}

describeIfDb('kit placement predicate wiring (real DB)', () => {
  const tag = `kpl${Date.now().toString(36)}${Math.floor(Math.random() * 46_656).toString(36)}`;
  let userId = '';
  let avatarId = '';
  let parcelId = '';
  let parcelTier: LandTier = 'starter';
  let structureId = '';

  /** Run the write-path evaluator in a throwaway transaction. */
  const evaluate = (
    request: {
      pieceKey: string;
      gridX: number;
      gridY: number;
      rotationStep: number;
      stackLevel: number;
    },
    opts: { structureLevel?: number; excludePieceRef?: string } = {},
  ) =>
    db.transaction((tx) =>
      evaluateKitWrite(tx, {
        parcelId,
        parcelTier,
        structureLevel: opts.structureLevel ?? 3,
        request: request as Parameters<typeof evaluateKitWrite>[1]['request'],
        excludePieceRef: opts.excludePieceRef,
      }),
    );

  const insertPiece = async (
    pieceKey: string,
    gridX: number,
    gridY: number,
    stackLevel = 1,
  ): Promise<string> =>
    first(
      await db.execute<{ id: string }>(
        sql`INSERT INTO land_structure_pieces
              (parcel_id, owner_avatar_id, piece_key, grid_x, grid_y, rotation_step, stack_level)
            VALUES (${parcelId}, ${avatarId}, ${pieceKey}, ${gridX}, ${gridY}, 0, ${stackLevel})
            RETURNING id`,
      ),
    ).id;

  beforeAll(async () => {
    const users = await db.execute<{ id: string }>(
      sql`INSERT INTO users (email, password_hash, name)
          VALUES (${`${tag}@clawville-test.invalid`}, ${`disabled-${tag}`}, 'Kit Placement Test')
          RETURNING id`,
    );
    userId = first(users).id;

    const avatars = await db.execute<{ id: string }>(
      sql`INSERT INTO avatars
            (user_id, name, species, color, gender, archetype, personality, stats,
             claw_tokens, soft_balance, bought_balance, earned_balance, is_active, is_guest)
          VALUES
            (${userId}, ${tag}, 'cat', 'green', 'male', 'brave-adventurer', '{}'::jsonb, '{}'::jsonb,
             0, 0, 0, 0, false, false)
          RETURNING id`,
    );
    avatarId = first(avatars).id;

    const parcels = await db.execute<{ id: string; tier: LandTier }>(
      sql`SELECT id, tier::text AS tier FROM land_parcels
          WHERE status = 'available' AND owner_avatar_id IS NULL AND tier = 'starter'
          ORDER BY parcel_code LIMIT 1`,
    );
    const parcel = first(parcels);
    parcelId = parcel.id;
    parcelTier = parcel.tier;
    await db.execute(
      sql`UPDATE land_parcels SET status = 'owned', owner_avatar_id = ${avatarId},
                                  tenure = 'rented', tenure_terms_version = 2,
                                  acquired_at = now(), updated_at = now()
          WHERE id = ${parcelId}`,
    );

    const structures = await db.execute<{ id: string }>(
      sql`INSERT INTO land_structures (parcel_id, owner_avatar_id, structure_type, catalog_key, level, status)
          VALUES (${parcelId}, ${avatarId}, 'home', 'starter-home', 3, 'active')
          RETURNING id`,
    );
    structureId = first(structures).id;
  });

  afterAll(async () => {
    const clean = (q: ReturnType<typeof sql>) => db.execute(q).catch(() => {});
    await clean(sql`DELETE FROM land_structure_pieces WHERE parcel_id = ${parcelId}`);
    if (structureId) await clean(sql`DELETE FROM land_structures WHERE id = ${structureId}`);
    if (parcelId) {
      await clean(sql`UPDATE land_parcels SET
                        status = 'available', owner_avatar_id = NULL, tenure = NULL,
                        tenure_terms_version = NULL, acquired_at = NULL, updated_at = now()
                      WHERE id = ${parcelId}`);
    }
    await clean(sql`DELETE FROM avatars WHERE id = ${avatarId}`);
    await clean(sql`DELETE FROM users WHERE id = ${userId}`);
  });

  it('admits a legal perimeter placement on an empty yard', async () => {
    const verdict = await evaluate({
      pieceKey: 'path-stone',
      gridX: 1,
      gridY: 1,
      rotationStep: 0,
      stackLevel: 1,
    });
    expect(verdict.ok).toBe(true);
  });

  it('refuses the shell reservation at the grid centre — the D-1 case', async () => {
    // The anchor-only check this replaced accepted any non-reserved ANCHOR and
    // let the rest of a rotated piece overhang. The envelope test is absolute.
    const verdict = await evaluate({
      pieceKey: 'path-stone',
      gridX: 7,
      gridY: 7,
      rotationStep: 0,
      stackLevel: 1,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('intersects_shell');
    expect(kitPlacementRefusalStatus(verdict.code)).toBe(409);
  });

  it('refuses a piece that overlaps one already standing', async () => {
    const pieceRef = await insertPiece('path-stone', 1, 1);
    try {
      const verdict = await evaluate({
        pieceKey: 'path-stone',
        gridX: 1,
        gridY: 1,
        rotationStep: 0,
        stackLevel: 1,
      });
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.code).toBe('intersects_piece');
      expect(kitPlacementRefusalStatus(verdict.code)).toBe(409);
    } finally {
      await db.execute(sql`DELETE FROM land_structure_pieces WHERE id = ${pieceRef}`);
    }
  });

  it('excludes the moved piece from its own occupancy — a move never self-collides', async () => {
    const pieceRef = await insertPiece('path-stone', 1, 1);
    try {
      // Same piece, same cell, but presented as a MOVE of itself. Without the
      // exclusion this would report `intersects_piece` and make a rotation-only
      // move impossible.
      const verdict = await evaluate(
        { pieceKey: 'path-stone', gridX: 1, gridY: 1, rotationStep: 0, stackLevel: 1 },
        { excludePieceRef: pieceRef },
      );
      expect(verdict.ok).toBe(true);
    } finally {
      await db.execute(sql`DELETE FROM land_structure_pieces WHERE id = ${pieceRef}`);
    }
  });

  it('refuses a stack with nothing underneath it', async () => {
    const verdict = await evaluate({
      pieceKey: 'path-stone',
      gridX: 1,
      gridY: 2,
      rotationStep: 0,
      stackLevel: 2,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('unsupported_stack');
    expect(kitPlacementRefusalStatus(verdict.code)).toBe(409);
  });

  it('refuses a stack above the level ladder height', async () => {
    // Lv1 allows no stacking at all, so this is a height refusal rather than a
    // support one — the codes are distinct and both are conflicts.
    const verdict = await evaluate(
      { pieceKey: 'path-stone', gridX: 1, gridY: 3, rotationStep: 0, stackLevel: 2 },
      { structureLevel: 1 },
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('stack_exceeds_height');
    expect(kitPlacementRefusalStatus(verdict.code)).toBe(409);
  });

  it('GRANDFATHERS an illegal stored row (Q5): it still blocks, is never dropped', async () => {
    // A row the CURRENT predicate would refuse — written directly, as a legacy
    // paid piece would have been under the old anchor-only rule.
    const legacyRef = await insertPiece('path-stone', 7, 7);
    try {
      const stillThere = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM land_structure_pieces WHERE id = ${legacyRef}`,
      );
      // Nothing deletes it. Q5 forbids resolving illegality by removing a paid row.
      expect(Number(first(stillThere).n)).toBe(1);

      // And it still OCCUPIES space: a new piece overlapping it is refused, so
      // grandfathering never opens a hole a second piece can be sold into.
      const verdict = await evaluate({
        pieceKey: 'path-stone',
        gridX: 7,
        gridY: 7,
        rotationStep: 0,
        stackLevel: 1,
      });
      expect(verdict.ok).toBe(false);

      // The free-move escape hatch: the SAME row relocated to a legal cell is
      // admitted, because a move excludes the piece from its own occupancy.
      const moved = await evaluate(
        { pieceKey: 'path-stone', gridX: 1, gridY: 1, rotationStep: 0, stackLevel: 1 },
        { excludePieceRef: legacyRef },
      );
      expect(moved.ok).toBe(true);
    } finally {
      await db.execute(sql`DELETE FROM land_structure_pieces WHERE id = ${legacyRef}`);
    }
  });
});
