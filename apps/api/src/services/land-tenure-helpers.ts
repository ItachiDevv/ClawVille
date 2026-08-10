import { db, sql } from '@clawville/database';

export type LandTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function reconcileArchivedStructureOnAcquire(
  tx: LandTx,
  parcelId: string,
  acquirerAvatarId: string,
): Promise<void> {
  const rows = await tx.execute<{
    id: string;
    owner_avatar_id: string;
    status: string;
  }>(
    sql`SELECT id, owner_avatar_id, status FROM land_structures
        WHERE parcel_id = ${parcelId}
        FOR UPDATE`,
  );
  const structure = rows[0];
  if (!structure || structure.status !== 'archived') return;
  if (structure.owner_avatar_id === acquirerAvatarId) {
    await tx.execute(
      sql`UPDATE land_structures SET status = 'active', updated_at = now() WHERE id = ${structure.id}`,
    );
    return;
  }
  await tx.execute(sql`DELETE FROM land_structure_pieces WHERE parcel_id = ${parcelId}`);
  await tx.execute(sql`DELETE FROM land_structures WHERE id = ${structure.id}`);
}

/**
 * Shared marketplace deed-lock guard. Callers hold the parcel row and owner
 * advisory locks; a missing market schema means no lock, while other failures
 * remain fatal.
 */
export async function parcelHasLiveDeedLock(tx: LandTx, parcelId: string): Promise<boolean> {
  try {
    const rows = await tx.execute<{ hit: number }>(
      sql`SELECT 1 AS hit
          WHERE EXISTS (SELECT 1 FROM market_deed_locks WHERE parcel_id = ${parcelId})
             OR EXISTS (
               SELECT 1 FROM market_listings
               WHERE item_kind = 'land_deed'
                 AND item_ref = ${parcelId}
                 AND status IN ('active', 'pending_settlement')
             )`,
    );
    return Array.from(rows as Iterable<unknown>).length > 0;
  } catch (err) {
    const error = err as
      | {
          code?: string;
          message?: string;
          cause?: { code?: string; message?: string };
        }
      | undefined;
    const undefinedTable =
      error?.code === '42P01' ||
      error?.cause?.code === '42P01' ||
      (typeof error?.message === 'string' &&
        /relation "[^"]+" does not exist/.test(error.message)) ||
      (typeof error?.cause?.message === 'string' &&
        /relation "[^"]+" does not exist/.test(error.cause.message));
    if (undefinedTable) return false;
    throw err;
  }
}
