/**
 * migrate-ci.ts — CI database migration runner (forward-only, idempotent, gates prod).
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * Staging and prod are now SEPARATE Supabase databases, and Coolify never runs
 * migrations on deploy. A schema change applied to staging therefore does NOT
 * reach prod on merge — prod then crashes querying a table that does not exist.
 * This runner is the CI gate: it APPLIES pending DB migrations and BLOCKS the
 * deploy (non-zero exit) if any migration fails. Because it gates prod (real
 * money soon), correctness here is paramount.
 *
 * DESIGN
 * ------
 * - FORWARD-ONLY: applies *.sql files in lexicographic filename order. There is
 *   no `down` / rollback. To undo a change, author a new forward migration.
 * - IDEMPOTENT: each migration's SQL must be written idempotently (CREATE TABLE
 *   IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, DO $$ ... guards for enums, etc.).
 *   Combined with the tracking table below, a re-run after a partial failure is
 *   safe: already-applied files are skipped; the failed file's idempotent DDL
 *   no-ops the parts that succeeded and completes the rest.
 * - TRACKING TABLE: `_clawville_migrations` records which files have been applied
 *   and the sha256 checksum of their content. We do NOT use drizzle-kit
 *   push/migrate or its journal:
 *     * `drizzle-kit push --force` would see the manually-created
 *       `wager_lobby_id_seq` (absent from Drizzle metadata) and mark it for DROP,
 *       and would DROP the ~20 ElizaOS plugin-sql tables (agents, memories,
 *       entities, rooms, embeddings, ...) that live in the DB but are not in our
 *       Drizzle schema. That has wiped Eliza tables twice historically.
 *     * This runner only executes SQL WE author. Our migrations never reference
 *       the Eliza tables, so those tables are never touched. NEVER author a DROP.
 *
 * IMMUTABLE MIGRATIONS
 * --------------------
 * Once a migration file has been applied (recorded in `_clawville_migrations`),
 * its content is FROZEN. The runner stores a checksum and, on a later run, exits
 * non-zero if an already-applied file's content has changed. If you need to
 * alter a shipped migration, DO NOT edit it — add a NEW migration file with the
 * next lexicographic name. Editing a shipped file is treated as tamper/drift.
 *
 * FUTURE-AUTHOR NOTE — ALTER TYPE ... ADD VALUE
 * ---------------------------------------------
 * postgres.js runs each *.sql file as a SINGLE multi-statement simple query,
 * which Postgres wraps in ONE implicit transaction (atomic per file). But
 * `ALTER TYPE <enum> ADD VALUE ...` CANNOT run inside a transaction block
 * (Postgres restriction). If a migration needs to add an enum value, put that
 * `ALTER TYPE ... ADD VALUE` in its OWN dedicated migration file, ALONE, with no
 * other statements in it, so it executes as a standalone statement and does not
 * get caught inside an implicit txn with neighboring DDL. (Prefer
 * `ADD VALUE IF NOT EXISTS` for idempotency on Postgres 12+.)
 *
 * RUN
 * ---
 *   MIGRATION_DATABASE_URL=<session-pooler-url> bun packages/database/scripts/migrate-ci.ts
 *   MIGRATION_DRY_RUN=1 MIGRATION_DATABASE_URL=... bun packages/database/scripts/migrate-ci.ts
 *
 * Use the Supabase SESSION pooler URL (:5432, DDL-safe) — NOT the transaction
 * pooler (:6543, app runtime). The URL is read ONLY from MIGRATION_DATABASE_URL
 * (no .env.local fallback) so CI can never accidentally hit the wrong database.
 *
 * SECURITY: the DB URL is a secret. This script NEVER logs, echoes, or prints
 * it — not the full URL, not the host, not the credentials.
 */

import postgres from 'postgres';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { resolve } from 'path';
import { createHash } from 'crypto';

const LOG = '[migrate-ci]';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url || url.trim() === '') {
  console.error(
    `${LOG} MIGRATION_DATABASE_URL is not set. Refusing to run. ` +
      `Set it explicitly to the target Supabase SESSION-pooler URL (:5432). ` +
      `This runner does NOT load .env.local — explicit-only, to prevent ever ` +
      `applying migrations to the wrong database in CI.`,
  );
  process.exit(1);
}

const migrationsDir = resolve(__dirname, '../migrations');

// postgres.js connection. max:1 (serial, no pool churn under CI), prepare:false
// (simple-query mode so a multi-statement file runs as one implicit txn),
// short timeouts so a hung CI job fails fast rather than blocking the pipeline.
const client = postgres(url, {
  max: 1,
  prepare: false,
  connect_timeout: 15,
  idle_timeout: 10,
});

const applied: string[] = [];
const skipped: string[] = [];

try {
  // ---------------------------------------------------------------------------
  // Discover migration files FIRST (before touching the DB), so a missing/empty
  // migrations dir is a clean exit-0 no-op.
  // ---------------------------------------------------------------------------
  if (!existsSync(migrationsDir) || !statSync(migrationsDir).isDirectory()) {
    console.log(`${LOG} no migrations directory at ../migrations — nothing to apply.`);
    process.exit(0);
  }

  const files = readdirSync(migrationsDir)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // lexicographic by filename

  if (files.length === 0) {
    console.log(`${LOG} no migrations (../migrations is empty) — nothing to apply.`);
    process.exit(0);
  }

  console.log(`${LOG} discovered ${files.length} migration file(s): ${files.join(', ')}`);

  // ---------------------------------------------------------------------------
  // Tracking table (idempotent).
  // ---------------------------------------------------------------------------
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "_clawville_migrations" (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // Defensive: ensure the manually-created sequence exists so a truly-fresh DB
  // can later create the wager tables that default off it. Harmless where it
  // already exists (both staging + prod already have it).
  await client.unsafe(`CREATE SEQUENCE IF NOT EXISTS "wager_lobby_id_seq";`);

  // ---------------------------------------------------------------------------
  // Compute checksums, classify each file, and detect tamper/drift.
  // ---------------------------------------------------------------------------
  type Pending = { id: string; checksum: string; content: string };
  const pending: Pending[] = [];

  for (const id of files) {
    // Normalize CRLF -> LF before hashing AND applying, so the checksum is
    // platform-independent. Without this, a Windows checkout with
    // core.autocrlf=true would hash different bytes than the LF content CI
    // recorded, and the immutability guard would false-trip with a spurious
    // TAMPER/DRIFT error on a migration nobody edited. (Companion: a
    // packages/database/.gitattributes pins `*.sql text eol=lf`.)
    const content = readFileSync(resolve(migrationsDir, id), 'utf-8').replace(/\r\n/g, '\n');
    const checksum = createHash('sha256').update(content).digest('hex');

    const rows = await client<{ checksum: string }[]>`
      SELECT checksum FROM "_clawville_migrations" WHERE id = ${id} LIMIT 1
    `;

    if (rows.length > 0) {
      if (rows[0].checksum === checksum) {
        skipped.push(id);
        continue;
      }
      // Applied file's content changed — migrations are immutable.
      console.error(
        `${LOG} TAMPER/DRIFT: migration "${id}" has already been applied but its ` +
          `content has CHANGED (checksum mismatch). Migrations are immutable — ` +
          `never edit a shipped migration. Add a NEW migration file instead, and ` +
          `revert "${id}" to its applied content. Aborting without applying anything.`,
      );
      process.exit(1);
    }

    pending.push({ id, checksum, content });
  }

  // ---------------------------------------------------------------------------
  // Dry-run: list pending and exit WITHOUT applying.
  // ---------------------------------------------------------------------------
  if (process.env.MIGRATION_DRY_RUN === '1') {
    if (pending.length === 0) {
      console.log(`${LOG} DRY RUN: no pending migrations. skipped=[${skipped.join(', ')}]`);
    } else {
      console.log(`${LOG} DRY RUN: ${pending.length} pending migration(s) would apply, in order:`);
      for (const p of pending) console.log(`${LOG}   PENDING  ${p.id}`);
      console.log(`${LOG} DRY RUN: skipped (already applied)=[${skipped.join(', ')}]`);
    }
    console.log(`${LOG} DRY RUN complete — no changes made.`);
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // Apply each pending file IN ORDER. Each file is one atomic implicit txn.
  // On ANY failure: log + exit 1 IMMEDIATELY (do not record, do not continue).
  // This non-zero exit is what BLOCKS the deploy.
  // ---------------------------------------------------------------------------
  if (pending.length === 0) {
    console.log(`${LOG} no pending migrations — all ${skipped.length} already applied.`);
  }

  for (const p of pending) {
    console.log(`${LOG} applying ${p.id} ...`);
    try {
      await client.unsafe(p.content);
    } catch (err) {
      console.error(`${LOG} FAILED on ${p.id}`, err);
      process.exit(1);
    }

    // Record success. ON CONFLICT keeps the run resilient if a prior partial run
    // raced an insert; the latest checksum + applied_at win.
    await client`
      INSERT INTO "_clawville_migrations" (id, checksum)
      VALUES (${p.id}, ${p.checksum})
      ON CONFLICT (id) DO UPDATE
        SET checksum = excluded.checksum, applied_at = now()
    `;

    applied.push(p.id);
    console.log(`${LOG} applied ${p.id} ✓`);
  }

  // ---------------------------------------------------------------------------
  // Final summary. NEVER print the URL.
  // ---------------------------------------------------------------------------
  console.log(
    `${LOG} DONE. applied=[${applied.join(', ')}] skipped=[${skipped.join(', ')}]`,
  );
} catch (err) {
  console.error(`${LOG} unexpected top-level error`, err);
  process.exit(1);
} finally {
  await client.end({ timeout: 5 });
}
