/**
 * One-shot STAGING-only helper to credit an avatar with SOFT vCLAW for testing.
 * The mutation goes through the production `creditClawTokens` ledger chokepoint,
 * so the balance, provenance ledger, and covenant action record commit atomically.
 *
 * Run (staging only):
 *   CLAWVILLE_ENV=staging \
 *   TEST_GRANT_DB_URL="<staging database url>" \
 *   bun packages/database/scripts/grant-test-tokens.ts \
 *     --i-understand-this-is-a-test-db <avatarId> <amount>
 *
 * The self-hosted staging database (2026-09-25) is reached through a loopback SSH
 * tunnel (`127.0.0.1:15432`), so its URL names no project; it is accepted only when
 * the database itself is marked `clawville.env = 'staging'` (scripts/deploy/db). The
 * marker is read before anything loads, and again as the first statement of the ledger
 * transaction; the grant rolls back if the two differ.
 */

import postgres from 'postgres';

const ACKNOWLEDGEMENT = '--i-understand-this-is-a-test-db';
const STAGING_PROJECT_REF = 'mtpixvtclsjqjguouxes';
const PROD_PROJECT_REF = 'wheuidgiyyccqyoppxoa';

/** Pure guard exported for security regression tests. */
export function isDedicatedStagingDatabaseUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) return false;

  const username = decodeURIComponent(parsed.username);
  const directIdentity =
    parsed.hostname === `db.${STAGING_PROJECT_REF}.supabase.co`
    && username === 'postgres';
  const poolerIdentity =
    parsed.hostname.endsWith('.pooler.supabase.com')
    && username === `postgres.${STAGING_PROJECT_REF}`;

  // The explicit prod check is defense-in-depth and makes the refusal invariant
  // obvious if a future identity form is added without exact matching.
  const isKnownProd =
    parsed.hostname === `db.${PROD_PROJECT_REF}.supabase.co`
    || username === `postgres.${PROD_PROJECT_REF}`;
  return !isKnownProd && (directIdentity || poolerIdentity);
}

function isPostgresUrl(rawUrl: string): boolean {
  try {
    return ['postgres:', 'postgresql:'].includes(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

/**
 * The database-level `clawville.env` marker from the catalog, plus the session value.
 * `current_setting` alone is the SESSION value, which a URL option, PGOPTIONS, or a role
 * setting can fake. Copy of apps/api/scripts/db-env-marker.ts (a package must not import
 * from an app); keep the two in sync. The marker prevents ACCIDENTAL targeting (a wrong URL
 * or tunnel, a session or role override); it is NOT a security boundary: a role that owns the
 * database can `ALTER DATABASE ... SET clawville.env` itself.
 */
export const GRANT_TARGET_MARKER_SQL = `
select
  (select pg_catalog.array_agg(u.v)
     from pg_catalog.pg_db_role_setting s
     cross join lateral pg_catalog.unnest(s.setconfig) as u(v)
    where s.setdatabase = (select d.oid from pg_catalog.pg_database d
                            where d.datname = pg_catalog.current_database())
      and s.setrole = 0
      and pg_catalog.starts_with(u.v, 'clawville.env=')) as database_markers,
  pg_catalog.current_setting('clawville.env', true) as session_marker`;

/**
 * Pure marker resolution exported for security regression tests. Returns the database-level
 * marker ('' and absence are both null), or undefined when the marker must refuse: no row,
 * more than one database-level marker, or a session value that differs from it.
 */
export function resolveGrantTargetMarker(
  row: { database_markers: string[] | null; session_marker: string | null } | undefined,
): string | null | undefined {
  if (!row) return undefined;
  const values = (row.database_markers ?? []).map((entry) => entry.slice('clawville.env='.length));
  if (values.length > 1) return undefined;
  const database = values[0] || null;
  return (row.session_marker || null) === database ? database : undefined;
}

/**
 * Pure write-time decision exported for security regression tests: the marker read as the
 * first statement of the ledger transaction must resolve and equal the pre-check value.
 */
export function writeTargetMatchesPreCheck(
  preCheck: string | null,
  row: { database_markers: string[] | null; session_marker: string | null } | undefined,
): boolean {
  const current = resolveGrantTargetMarker(row);
  return current !== undefined && current === preCheck;
}

class GrantTargetChangedError extends Error {}

/**
 * Pure staging decision exported for security regression tests. `marker` is the target's
 * database-level marker (resolveGrantTargetMarker). The known prod project and a production
 * marker always refuse. Otherwise accept a database marked exactly 'staging', or the legacy
 * staging Supabase identity when the database carries no marker.
 */
export function isStagingGrantTarget(rawUrl: string, marker: string | null): boolean {
  if (!isPostgresUrl(rawUrl) || rawUrl.includes(PROD_PROJECT_REF) || marker === 'production') {
    return false;
  }
  if (marker === 'staging') return true;
  return !marker && isDedicatedStagingDatabaseUrl(rawUrl);
}

async function main(): Promise<void> {
  if (process.env.CLAWVILLE_ENV !== 'staging') {
    console.error('REFUSING: CLAWVILLE_ENV must be exactly "staging".');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  if (!args.includes(ACKNOWLEDGEMENT)) {
    console.error(`REFUSING: explicit ${ACKNOWLEDGEMENT} acknowledgement is required.`);
    process.exit(1);
  }

  const targetUrl = process.env.TEST_GRANT_DB_URL;
  if (!targetUrl) {
    console.error('REFUSING: TEST_GRANT_DB_URL is required; DATABASE_URL is never used as input.');
    process.exit(1);
  }

  // No connection at all to a known production URL.
  if (!isPostgresUrl(targetUrl) || targetUrl.includes(PROD_PROJECT_REF)) {
    console.error('REFUSING: TEST_GRANT_DB_URL is not the dedicated staging database.');
    process.exit(1);
  }

  const positional = args.filter((arg) => arg !== ACKNOWLEDGEMENT);
  const avatarId = positional[0];
  if (!avatarId) {
    console.error('REFUSING: an explicit avatarId is required; there is no default recipient.');
    process.exit(1);
  }

  const amount = Number(positional[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    console.error('REFUSING: amount must be a positive safe integer.');
    process.exit(1);
  }

  // Read the target's own environment marker on a throwaway connection before anything writes.
  let marker: string | null | undefined;
  try {
    const probe = postgres(targetUrl, { max: 1, prepare: false, connect_timeout: 15 });
    try {
      const [row] = await probe.unsafe<{ database_markers: string[] | null; session_marker: string | null }[]>(
        GRANT_TARGET_MARKER_SQL,
      );
      marker = resolveGrantTargetMarker(row);
    } finally {
      await probe.end({ timeout: 1 });
    }
  } catch {
    // Driver errors can embed connection details; never echo them.
    console.error('REFUSING: could not read the target database marker.');
    process.exit(1);
  }
  if (marker === undefined) {
    console.error('REFUSING: the session clawville.env differs from the database-level marker, or the marker is ambiguous.');
    process.exit(1);
  }

  if (!isStagingGrantTarget(targetUrl, marker)) {
    console.error('REFUSING: TEST_GRANT_DB_URL is not the dedicated staging database.');
    process.exit(1);
  }

  // Install the already-validated explicit target before importing any app/database
  // module. The database proxy binds lazily to this value on the first ledger call.
  process.env.DATABASE_URL = targetUrl;

  const preCheck: string | null = marker;
  try {
    const { db, sql } = await import('@clawville/database');
    const { creditClawTokens } = await import(
      '../../../apps/api/src/services/claw-token-ledger'
    );
    // The pre-check used a throwaway connection. Re-read the marker as the FIRST statement of
    // the ledger transaction, on the connection that writes, and roll back if it changed.
    const result = await db.transaction(async (tx) => {
      const rows = await tx.execute(sql.raw(GRANT_TARGET_MARKER_SQL));
      const row = rows[0] as { database_markers: string[] | null; session_marker: string | null } | undefined;
      if (!writeTargetMatchesPreCheck(preCheck, row)) throw new GrantTargetChangedError();
      return creditClawTokens({
        avatarId,
        amount,
        reason: 'admin_test_grant',
        source: 'admin',
        provenance: 'soft',
        actorKind: 'admin',
        metadata: { note: 'staging-only test grant' },
      }, tx);
    });
    const balanceBefore = result.balanceAfter - amount;
    console.log(
      `Granted ${amount} SOFT vCLAW to avatar ${avatarId.slice(0, 8)}… ` +
        `(${balanceBefore} -> ${result.balanceAfter}); ledger=${result.ledgerId}`,
    );
    process.exit(0);
  } catch (error) {
    if (error instanceof GrantTargetChangedError) {
      console.error("REFUSING: the write connection's clawville.env marker differs from the pre-check; nothing was written.");
      process.exit(1);
    }
    // Database/client errors can embed connection details. Keep the failure
    // crash-loud without echoing the URL, credentials, or raw driver error.
    console.error('FAILED: staging ledger grant did not complete.');
    process.exit(1);
  }
}

if (import.meta.main) await main();
