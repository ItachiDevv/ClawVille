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
import { existsSync, readFileSync } from 'fs';
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
