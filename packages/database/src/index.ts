import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

if (process.env.NODE_ENV !== 'production') {
  try {
    const { config } = require('dotenv');
    const { resolve } = require('path');
    config({ path: resolve(__dirname, '../../../.env.local') });
  } catch {
    // dotenv not available, env vars should be set externally
  }
}

export * from './schema';
export { eq, and, or, not, sql, desc, asc, lt, gt, lte, gte, isNull, isNotNull, inArray } from 'drizzle-orm';

// Lazy database connection for Next.js build compatibility
let _db: PostgresJsDatabase<typeof schema> | null = null;

function getDb(): PostgresJsDatabase<typeof schema> {
  if (_db) return _db;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  // `prepare: false` is REQUIRED for the Supabase transaction pooler (port :6543,
  // Supavisor transaction mode), which our DATABASE_URL uses. postgres.js defaults
  // to PREPARED statements; over the transaction pooler those break multi-statement
  // transactions: a `db.transaction(BEGIN/INSERT/COMMIT)` returns its RETURNING row
  // but the COMMIT can land on a different pooled backend connection, so the INSERT
  // is silently rolled back and the row is never persisted. Reproduced live: ~1/6
  // slot `/session/open` calls handed back a sessionId for a row that did not exist
  // in the DB → `session_not_found` on the next spin, intermittently breaking EVERY
  // cove game (all settle inside a transaction). Disabling prepared statements is
  // the documented Supabase fix and makes transactions durable on the pooler.
  const client = postgres(connectionString, { prepare: false });
  _db = drizzle(client, { schema });
  return _db;
}

export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_target, prop) {
    return (getDb() as any)[prop];
  },
});

export type Database = PostgresJsDatabase<typeof schema>;
