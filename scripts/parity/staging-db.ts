import postgres from '../../apps/api/node_modules/postgres/src/index.js';
import {
  DATABASE_ENV_MARKER_SQL,
  namesSupabaseProject,
  resolveDatabaseEnvMarker,
  type DatabaseEnvMarkerRow,
} from '../../apps/api/scripts/db-env-marker';

/** Legacy staging Supabase project (frozen since the 2026-09-25 self-hosted cutover). */
const LEGACY_STAGING_REF = 'mtpixvtclsjqjguouxes';

/** Exact identity: pooler user on a Supabase pooler host, or the direct host (db-env-marker.ts). */
function namesLegacyStaging(databaseUrl: string): boolean {
  return namesSupabaseProject(databaseUrl, LEGACY_STAGING_REF);
}

/**
 * Pure staging decision for the harness's direct database access. `marker` is the target's
 * database-level `clawville.env` marker (db-env-marker.ts): accept exactly 'staging', or the
 * legacy staging Supabase identity when the database carries no marker.
 */
export function acceptsStagingTarget(marker: string | null, databaseUrl: string): boolean {
  return marker === 'staging' || (!marker && namesLegacyStaging(databaseUrl));
}

/** Decision from the raw marker row: a spoofed or ambiguous marker always refuses. */
export function acceptsStagingMarkerRow(row: DatabaseEnvMarkerRow | undefined, databaseUrl: string): boolean {
  let marker: string | null;
  try {
    marker = resolveDatabaseEnvMarker(row);
  } catch {
    return false;
  }
  return acceptsStagingTarget(marker, databaseUrl);
}

/**
 * Self-hosted staging is reached through a loopback SSH tunnel (`127.0.0.1:15432`), so the
 * URL no longer names it. Read the database's own marker (scripts/deploy/db) from the catalog
 * before any query; a URL option or role setting cannot fake it.
 */
export async function isStagingDatabase(databaseUrl: string): Promise<boolean> {
  const sql = postgres(databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 20 });
  try {
    const rows = await sql.unsafe(DATABASE_ENV_MARKER_SQL);
    return acceptsStagingMarkerRow(rows[0] as DatabaseEnvMarkerRow | undefined, databaseUrl);
  } finally {
    await sql.end();
  }
}
