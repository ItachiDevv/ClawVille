/** CI-only repair after migration replay. Never a production migration runner. */
import postgres from 'postgres';
import { is } from 'drizzle-orm';
import { getTableConfig, PgDialect, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../src/schema';
import expected from './ci-schema-invariants.expected.json';

const identifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const dialect = new PgDialect();
type Client = ReturnType<typeof postgres>;
type Existing = {
  table_name: string; name: string; kind: string; validated: boolean;
  columns: string[]; foreign_table: string | null; foreign_schema: string | null;
  foreign_columns: string[]; update_action: string; delete_action: string;
};
const actionCode: Record<string, string> = {
  'no action': 'a', restrict: 'r', cascade: 'c', 'set null': 'n', 'set default': 'd',
};

export function assertDisposableCiDatabase(url: string): void {
  const parsed = new URL(url);
  if (process.env.CI !== 'true' || process.env.CLAWVILLE_ENV
    || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    || parsed.pathname !== '/clawville_test') {
    throw new Error('CI schema repair requires CI=true, unset CLAWVILLE_ENV, and local clawville_test');
  }
}

export async function restoreCiSchemaInvariants(client: Client): Promise<string[]> {
  const existing = await client<Existing[]>`
    SELECT t.relname AS table_name, c.conname AS name, c.contype::text AS kind,
      c.convalidated AS validated,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY ord) AS columns,
      ft.relname AS foreign_table, fn.nspname AS foreign_schema,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY ord) AS foreign_columns,
      c.confupdtype::text AS update_action, c.confdeltype::text AS delete_action
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    LEFT JOIN pg_class ft ON ft.oid=c.confrelid
    LEFT JOIN pg_namespace fn ON fn.oid=ft.relnamespace
    WHERE n.nspname='public' AND c.contype IN ('c','f')
  `;
  const restored: string[] = [];
  const seen = new Set<string>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const table = getTableConfig(value);
    if ((table.schema && table.schema !== 'public') || seen.has(table.name)) continue;
    seen.add(table.name);
    const relation = `public.${identifier(table.name)}`;
    for (const check of table.checks) {
      // Only repair empirically verified live invariants. Eighteen other
      // declared CHECKs are absent on staging too; enabling them here would
      // create unrelated CI/live behavior drift across auth and wagering.
      if (!expected.some((artifact) => artifact.artifact_type === 'c'
        && artifact.table_name === table.name && artifact.artifact_name === check.name)) continue;
      const found = existing.find((c) => c.table_name === table.name && c.name === check.name);
      if (found) {
        if (found.kind !== 'c' || !found.validated) throw new Error(`Invalid CHECK ${table.name}.${check.name}`);
        continue;
      }
      const expression = dialect.sqlToQuery(check.value);
      if (expression.params.length) throw new Error(`Parameterized CHECK ${table.name}.${check.name}`);
      await client.unsafe(`ALTER TABLE ${relation} ADD CONSTRAINT ${identifier(check.name)} CHECK (${expression.sql})`);
      restored.push(`${table.name}.${check.name}`);
    }
    for (const fk of table.foreignKeys) {
      const reference = fk.reference();
      const target = getTableConfig(reference.foreignTable);
      const columns = reference.columns.map((column) => column.name);
      const foreignColumns = reference.foreignColumns.map((column) => column.name);
      const onUpdate = fk.onUpdate ?? 'no action';
      const onDelete = fk.onDelete ?? 'no action';
      const definition = `FOREIGN KEY (${columns.join(', ')}) REFERENCES ${target.name}(${foreignColumns.join(', ')})`
        + (onUpdate === 'no action' ? '' : ` ON UPDATE ${onUpdate.toUpperCase()}`)
        + (onDelete === 'no action' ? '' : ` ON DELETE ${onDelete.toUpperCase()}`);
      if (!expected.some((artifact) => artifact.artifact_type === 'f'
        && artifact.table_name === table.name && artifact.definition === definition)) continue;
      const equivalent = existing.find((c) => c.table_name === table.name && c.kind === 'f'
        && c.foreign_table === target.name && c.foreign_schema === (target.schema ?? 'public')
        && JSON.stringify(c.columns) === JSON.stringify(columns)
        && JSON.stringify(c.foreign_columns) === JSON.stringify(foreignColumns)
        && c.update_action === actionCode[onUpdate] && c.delete_action === actionCode[onDelete]);
      if (equivalent) {
        if (!equivalent.validated) throw new Error(`Unvalidated FK ${table.name}.${equivalent.name}`);
        continue;
      }
      const name = fk.getName();
      if (existing.some((c) => c.table_name === table.name && c.name === name)) {
        throw new Error(`Conflicting FK ${table.name}.${name}`);
      }
      await client.unsafe(`ALTER TABLE ${relation} ADD CONSTRAINT ${identifier(name)} `
        + `FOREIGN KEY (${columns.map(identifier).join(', ')}) `
        + `REFERENCES ${identifier(target.schema ?? 'public')}.${identifier(target.name)} `
        + `(${foreignColumns.map(identifier).join(', ')}) ON UPDATE ${onUpdate} ON DELETE ${onDelete}`);
      restored.push(`${table.name}.${name}`);
    }
  }
  return restored;
}

if (import.meta.main) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
  assertDisposableCiDatabase(url);
  const client = postgres(url, { max: 1, prepare: false, connect_timeout: 15 });
  try {
    const restored = await restoreCiSchemaInvariants(client);
    console.log(`[ci-schema-invariants] restored ${restored.length}: ${restored.join(', ')}`);
  } finally { await client.end({ timeout: 5 }); }
}
