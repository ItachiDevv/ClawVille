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
  // Supavisor transaction mode), which our DATABASE_URL uses on both staging+prod.
  // postgres.js defaults to NAMED prepared statements cached per backend connection,
  // but the transaction pooler hands a DIFFERENT backend to each transaction, so a
  // cached named statement isn't available on the next one. Over the pooler this
  // intermittently corrupts multi-statement transactions (db.transaction =
  // BEGIN/INSERT/COMMIT): VERIFIED live, ~1/6 (staging) to ~1/3 (prod) of slot
  // /session/open inserts returned a RETURNING row that was NEVER persisted (direct
  // DB query returned []), causing session_not_found on the next spin and
  // intermittently breaking EVERY cove game + the CT ledger (all settle inside a
  // transaction). `prepare: false` disables named prepared statements — Supabase's
  // documented fix — making transactions durable on the pooler. (node-pg, used by
  // ElizaOS plugin-sql, is unaffected: it uses UNNAMED statements by default.)
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
