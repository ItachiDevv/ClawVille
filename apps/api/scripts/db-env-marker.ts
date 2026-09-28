/**
 * The `clawville.env` environment marker (scripts/deploy/db), read from the CATALOG.
 *
 * `current_setting('clawville.env', true)` alone returns the SESSION value, which a URL
 * option (`options=-c clawville.env=staging`), PGOPTIONS, or an `ALTER ROLE ... SET` can
 * fake. The marker that counts is the database-level one (`ALTER DATABASE clawville SET
 * clawville.env = ...`, stored in pg_db_role_setting with setrole = 0). A session value that
 * differs from it is refused as a spoof. Every catalog name is schema-qualified, so a
 * `search_path` option cannot shadow it.
 *
 * SCOPE: the marker prevents ACCIDENTAL targeting (a wrong URL or tunnel port, a stale env
 * file, a session or role override). It is NOT a security boundary: any role that owns the
 * database (the app role `clawville` does) can `ALTER DATABASE ... SET clawville.env` itself.
 *
 * Also used by scripts/parity/staging-db.ts. packages/database/scripts/grant-test-tokens.ts
 * keeps its own copy (a package must not import from an app); keep the two in sync.
 */

export const DATABASE_ENV_MARKER_SQL = `
select
  (select pg_catalog.array_agg(u.v)
     from pg_catalog.pg_db_role_setting s
     cross join lateral pg_catalog.unnest(s.setconfig) as u(v)
    where s.setdatabase = (select d.oid from pg_catalog.pg_database d
                            where d.datname = pg_catalog.current_database())
      and s.setrole = 0
      and pg_catalog.starts_with(u.v, 'clawville.env=')) as database_markers,
  pg_catalog.current_setting('clawville.env', true) as session_marker`;

export interface DatabaseEnvMarkerRow {
  database_markers: string[] | null;
  session_marker: string | null;
}

/** A refused marker state. The message names no URL, host, or credential. */
export class DatabaseEnvMarkerError extends Error {}

/**
 * Returns the database-level marker, or null when the database carries none ('' counts as
 * none, as before). Throws DatabaseEnvMarkerError when the database carries more than one
 * marker, or when the session value differs from the database value.
 */
export function resolveDatabaseEnvMarker(row: DatabaseEnvMarkerRow | undefined): string | null {
  if (!row) throw new DatabaseEnvMarkerError('the clawville.env marker query returned no row');
  const values = (row.database_markers ?? []).map((entry) => entry.slice('clawville.env='.length));
  if (values.length > 1) {
    throw new DatabaseEnvMarkerError('the database carries more than one clawville.env marker');
  }
  const database = values[0] || null;
  const session = row.session_marker || null;
  if (session !== database) {
    throw new DatabaseEnvMarkerError(
      'the session clawville.env differs from the database-level marker (URL, PGOPTIONS, or role setting); refusing',
    );
  }
  return database;
}

/**
 * Re-reads the marker as the FIRST statement of a write transaction and throws (the caller's
 * transaction rolls back) unless it equals the value the pre-check accepted. `readRows` runs
 * the query on that transaction, e.g. `(query) => tx.execute(sql.raw(query))`.
 */
export async function assertWriteTargetMarker(
  readRows: (query: string) => Promise<ArrayLike<unknown>>,
  preCheck: string | null,
): Promise<void> {
  const rows = await readRows(DATABASE_ENV_MARKER_SQL);
  const current = resolveDatabaseEnvMarker(rows[0] as DatabaseEnvMarkerRow | undefined);
  if (current !== preCheck) {
    throw new DatabaseEnvMarkerError(
      `the write connection's clawville.env marker (${current ?? 'none'}) differs from the pre-check (${preCheck ?? 'none'}); rolled back`,
    );
  }
}

/** One Supavisor label, e.g. `aws-0-us-east-1.pooler.supabase.com`. */
const SUPABASE_POOLER_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.pooler\.supabase\.com$/;

/**
 * Exact legacy Supabase identity: the pooler user `postgres.<ref>` ON a Supabase pooler host,
 * or the direct host `db.<ref>.supabase.co`. The ref anywhere else in the URL (password, path,
 * query) does not count. `postgres:` URLs keep the host's case, so it is lowercased here; a
 * trailing dot, an empty label, or any extra suffix fails both forms.
 */
export function namesSupabaseProject(databaseUrl: string, ref: string): boolean {
  try {
    const url = new URL(databaseUrl);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return false;
    const host = url.hostname.toLowerCase();
    return (decodeURIComponent(url.username) === `postgres.${ref}` && SUPABASE_POOLER_HOST.test(host))
      || host === `db.${ref}.supabase.co`;
  } catch {
    return false;
  }
}
