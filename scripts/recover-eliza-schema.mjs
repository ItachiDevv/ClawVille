/**
 * Emergency recovery: recreate @elizaos/plugin-sql's ~20 internal tables when
 * the plugin's own migrator short-circuits with "No changes detected" but the
 * tables are actually missing from the DB.
 *
 * Why you're reading this: if the boot-time assertAgentsTableExists() guard
 * in apps/api/src/services/eliza-migrator.ts trips, the API container will
 * refuse to start and print a FATAL log citing this script.
 *
 * Root cause (two known recurrences — 2026-04-16 and 2026-04-23):
 *   1. `drizzle-kit push` with ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true drops
 *      any table not in our Drizzle schema. Plugin-sql's tables are managed
 *      externally, so push used to nuke them silently.
 *   2. Plugin-sql then boots and sees an empty migrations._snapshots table +
 *      an empty DB → its schema-diff engine concludes "nothing to do" and
 *      leaves the tables absent, while tagging "Migration completed" in logs.
 *
 * Permanent fix (landed same commit as this script):
 *   - `packages/database/drizzle.config.ts` tablesFilter hides ElizaOS tables
 *     from drizzle-kit push (layer 1).
 *   - `assertAgentsTableExists()` in eliza-migrator.ts throws at boot if the
 *     tables are gone (layer 2).
 *
 * Running the script (emergency only):
 *   scp scripts/recover-eliza-schema.mjs root@<host>:/tmp/recover.mjs
 *   ssh root@<host> 'docker cp /tmp/recover.mjs <api-container>:/app/apps/api/recover.mjs'
 *   ssh root@<host> 'docker exec -w /app/apps/api <api-container> bun run /app/apps/api/recover.mjs'
 *   ssh root@<host> 'docker restart <api-container>'
 *
 * Idempotent — safe to re-run. CREATE TABLE IF NOT EXISTS throughout.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { getTableName } from 'drizzle-orm';
import postgres from 'postgres';
import pkgRaw from '@elizaos/plugin-sql';

const plugin = pkgRaw.default || pkgRaw;
const schema = plugin.schema;

const pg = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

// Collect tables only (schema contains enums, relations, etc. too)
const tables = [];
for (const [exportName, v] of Object.entries(schema)) {
  try {
    const cfg = getTableConfig(v);
    tables.push({ exportName, cfg });
  } catch { /* not a table */ }
}
console.log('[recover] tables found:', tables.length);

function pgTypeFromColumn(col) {
  // drizzle-orm columns expose getSQLType()
  if (typeof col.getSQLType === 'function') return col.getSQLType();
  return col.columnType || 'text';
}

function colDdl(col) {
  const parts = [`"${col.name}"`, pgTypeFromColumn(col)];
  if (col.primary) parts.push('PRIMARY KEY');
  if (col.notNull && !col.primary) parts.push('NOT NULL');
  if (col.hasDefault && col.default !== undefined && col.default !== null) {
    const def = col.default;
    if (typeof def === 'object' && def?.queryChunks) {
      // sql`...` default
      const raw = def.queryChunks.map(c => (typeof c === 'string' ? c : c.value ?? '')).join('');
      if (raw) parts.push(`DEFAULT ${raw}`);
    } else if (typeof def === 'string') {
      parts.push(`DEFAULT '${def.replace(/'/g, "''")}'`);
    } else if (typeof def === 'number' || typeof def === 'boolean') {
      parts.push(`DEFAULT ${def}`);
    }
  }
  return parts.join(' ');
}

// First pass: CREATE TABLEs without FKs
const createStmts = [];
for (const { exportName, cfg } of tables) {
  const schemaPrefix = cfg.schema ? `"${cfg.schema}".` : '';
  const colLines = cfg.columns.map(colDdl);
  const pkCols = cfg.columns.filter(c => c.primary);
  // composite PK? some tables use compound primary key via primaryKey helper — defer for second pass
  const composite = cfg.primaryKeys?.[0];
  if (composite && pkCols.length === 0) {
    const names = composite.columns.map(c => `"${c.name}"`).join(', ');
    colLines.push(`PRIMARY KEY (${names})`);
  }
  const ddl = `CREATE TABLE IF NOT EXISTS ${schemaPrefix}"${cfg.name}" (\n  ${colLines.join(',\n  ')}\n);`;
  createStmts.push({ exportName, table: cfg.name, ddl, cfg });
}

// Execute CREATE TABLEs
for (const { exportName, table, ddl } of createStmts) {
  try {
    await pg.unsafe(ddl);
    console.log('[recover] ✓ created', table, `(export ${exportName})`);
  } catch (e) {
    console.error('[recover] ✗ FAILED', table, ':', e.message);
    console.error('  DDL was:\n' + ddl);
  }
}

// Second pass: indexes + FKs (skip FK creation if it already exists)
for (const { cfg } of createStmts) {
  // Unique indexes via column.isUnique
  for (const col of cfg.columns) {
    if (col.isUnique && !col.primary) {
      const idxName = `${cfg.name}_${col.name}_unique`;
      const stmt = `CREATE UNIQUE INDEX IF NOT EXISTS "${idxName}" ON "${cfg.name}" ("${col.name}");`;
      try { await pg.unsafe(stmt); } catch (e) { console.error('[recover] idx err', idxName, e.message); }
    }
  }
  // Extra indexes from cfg.indexes
  for (const idx of cfg.indexes || []) {
    try {
      const cols = idx.config.columns.map(c => `"${c.name}"`).join(', ');
      const unique = idx.config.unique ? 'UNIQUE' : '';
      const stmt = `CREATE ${unique} INDEX IF NOT EXISTS "${idx.config.name}" ON "${cfg.name}" (${cols});`;
      await pg.unsafe(stmt);
    } catch (e) { console.error('[recover] idx2 err', e.message); }
  }
  // FKs
  for (const fk of cfg.foreignKeys || []) {
    try {
      const ref = fk.reference();
      const fromCols = ref.columns.map(c => `"${c.name}"`).join(', ');
      const toTable = getTableName(ref.foreignTable);
      const toCols = ref.foreignColumns.map(c => `"${c.name}"`).join(', ');
      const onDelete = fk.onDelete ? ` ON DELETE ${fk.onDelete}` : '';
      const onUpdate = fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : '';
      const fkName = `${cfg.name}_${ref.columns.map(c => c.name).join('_')}_fkey`;
      const stmt = `ALTER TABLE "${cfg.name}" ADD CONSTRAINT "${fkName}" FOREIGN KEY (${fromCols}) REFERENCES "${toTable}" (${toCols})${onDelete}${onUpdate};`;
      await pg.unsafe(stmt);
    } catch (e) {
      if (!/already exists/.test(e.message)) console.error('[recover] fk err:', e.message);
    }
  }
}

// Verify
const verify = await pg`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('agents','memories','entities','rooms','components','participants','embeddings','logs','cache','tasks','worlds','relationships','servers','channels','message_servers','message_server_agents','channel_participants','pairing_allowlist','pairing_requests','messages') ORDER BY 1`;
console.log('[recover] tables now present:', verify.map(r => r.table_name).join(', '));
console.log('[recover] count:', verify.length);

await pg.end();
console.log('[recover] done.');
