/**
 * CI-only base-schema bootstrap for fresh service databases.
 *
 * The hand-authored migrations are forward-only on top of a base schema that
 * predates them. CI first uses drizzle-kit generate (pure TS-to-SQL, no database
 * introspection) with an empty output directory to generate the full schema.
 * This script applies that artifact before migrate-ci.ts runs the migrations.
 * The CI-only guard refuses any database that already has public.avatars.
 * The URL comes ONLY from MIGRATION_DATABASE_URL and is NEVER logged.
 */

import postgres from 'postgres';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const LOG = '[ci-bootstrap]';
const REFUSAL = 'refusing: database already has the app schema — this bootstrap is for ' +
  'EMPTY CI service databases only, never staging/prod';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url || url.trim() === '') {
  console.error(`${LOG} MIGRATION_DATABASE_URL is not set. Refusing to run.`);
  process.exit(1);
}

const schemaPath = resolve(__dirname, '../.drizzle-ci-bootstrap/0000_base_schema.sql');
if (!existsSync(schemaPath)) {
  console.error(
    `${LOG} generated base schema is missing. Run the generate step first: ` +
      `cd packages/database && bunx drizzle-kit generate ` +
      `--config drizzle.ci-bootstrap.config.ts --name base_schema`,
  );
  process.exit(1);
}

let client: ReturnType<typeof postgres> | undefined;

try {
  // Match migrate-ci.ts: serial connections, simple queries, and short timeouts.
  client = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 15,
    idle_timeout: 10,
  });
  const rows = await client<{ avatars: string | null }[]>`
    SELECT to_regclass('public.avatars') AS avatars
  `;
  if (rows[0]?.avatars !== null) {
    throw new Error(REFUSAL);
  }

  const content = readFileSync(schemaPath, 'utf-8').replace(/\r\n/g, '\n');
  await client.unsafe('CREATE SEQUENCE IF NOT EXISTS "wager_lobby_id_seq";');
  console.log(`${LOG} applying generated base schema ...`);
  // Statement-breakpoint markers are comments. One simple query applies the
  // multi-statement file as one implicit transaction.
  await client.unsafe(content);
  console.log(`${LOG} applied generated base schema.`);

  // Migrations OWN some tables: where a migration's authored CREATE TABLE
  // carries CHECK constraints the Drizzle TS schema does not declare, the
  // bootstrap's bare pre-creation makes the migration's CREATE TABLE IF NOT
  // EXISTS no-op and the CHECKs never materialize (run 35058427761: door-2
  // challenge invariants got undefined instead of 23514). Those tables are
  // dropped here so migrate-ci.ts recreates them from the authored SQL with
  // full fidelity.
  //
  // The drop set is deliberately NARROW — only CREATE-with-CHECK tables, and
  // never one referenced by packages/database/migrations-manual/*.sql. The
  // migrations dir alone is NOT a complete DDL history: early-era columns
  // also arrived via migrations-manual + bespoke apply scripts (e.g.
  // land_parcels.tenure via apps/api/scripts/migrate-land-tenure.ts), so
  // rebuilding such a table from migrations/*.sql alone loses those columns
  // (run 35059050630: 0013 failed on missing "tenure" after a blanket drop).
  // Tables kept bootstrap-owned get the CURRENT TS-schema shape, which is
  // complete on columns. drizzle-kit 0.24 also omits declared CHECKs, and
  // CASCADE removes incoming FKs from retained tables. After migrate-ci.ts,
  // ci-restore-schema-invariants.ts MUST restore the verified live CHECKs
  // and FKs; its catalog test pins the empirical staging gaps. CASCADE cannot lose
  // application data here: the database is empty and the guard above refused
  // any DB that already had the app schema. It does not preserve constraints.
  const migrationsDir = resolve(__dirname, '../migrations');
  const manualDir = resolve(__dirname, '../migrations-manual');
  const readSqlFiles = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((file) => file.toLowerCase().endsWith('.sql'))
          .sort()
          .map((file) => readFileSync(resolve(dir, file), 'utf-8'))
      : [];
  const manualSql = readSqlFiles(manualDir).join('\n');
  const migrationTables = new Set<string>();
  for (const sql of readSqlFiles(migrationsDir)) {
    const createTable = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))\s*\(/gi;
    let match: RegExpExecArray | null;
    while ((match = createTable.exec(sql)) !== null) {
      // Walk to the CREATE block's matching close-paren; only a block that
      // itself declares CHECK constraints qualifies for the drop set.
      let i = createTable.lastIndex;
      let depth = 1;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '(') depth += 1;
        else if (sql[i] === ')') depth -= 1;
        i += 1;
      }
      const block = sql.slice(createTable.lastIndex, i);
      const name = match[1] ?? match[2];
      if (/CHECK\s*\(/i.test(block) && !manualSql.includes(name)) {
        migrationTables.add(name);
      }
    }
  }
  const dropped = [...migrationTables].sort();
  for (const name of dropped) {
    await client.unsafe(`DROP TABLE IF EXISTS "${name}" CASCADE;`);
  }
  console.log(`${LOG} dropped migration-owned tables: ${dropped.join(', ')}`);
} catch (err) {
  if (err instanceof Error && err.message === REFUSAL) {
    console.error(`${LOG} ${REFUSAL}`);
  } else {
    // Same discipline as migrate-ci.ts: print the driver error (postgres.js
    // errors never include the connection URL) — CI needs the diagnostic.
    console.error(`${LOG} base-schema bootstrap FAILED`, err);
  }
  process.exitCode = 1;
} finally {
  try {
    await client?.end({ timeout: 5 });
  } catch {
    console.error(`${LOG} failed to close the database connection.`);
    process.exitCode = 1;
  }
}
