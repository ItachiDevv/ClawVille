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
let _postgresClient: ReturnType<typeof postgres> | null = null;

function getDb(): PostgresJsDatabase<typeof schema> {
  if (_db) return _db;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  // Historical Supabase transaction-pooler rationale for `prepare: false` follows.
  // Staging and production now use their separate self-hosted PostgreSQL servers.
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
  // Historical pool-sizing rationale: local dev used the Supavisor SESSION pooler (:5432),
  // which hard-caps CLIENT connections at pool_size (15). postgres.js defaults to
  // max:10 per process with NO idle timeout, and both apps/api AND apps/web opened a
  // pool — so a few concurrent/leaked local dev servers exhaust the whole session
  // pool (EMAXCONNSESSION on every query, 2026-07-18). Cap via DB_POOL_MAX in
  // .env.local (dev boxes set 4) and release idle connections after 30s so stray
  // processes can't pin slots. Staging and production retain the default max:10.
  // These existing settings also apply to self-hosted PostgreSQL.
  // Fail new connections after 10s, and probe established TCP flows after 30s,
  // so a dead pooler cannot leave the shared postgres.js pool silent forever.
  const poolMax = Number(process.env.DB_POOL_MAX) > 0 ? Number(process.env.DB_POOL_MAX) : 10;
  const client = postgres(connectionString, {
    prepare: false,
    max: poolMax,
    idle_timeout: 30,
    connect_timeout: 10,
    keep_alive: 30,
    max_lifetime: 60 * 60,
  });
  _postgresClient = client;
  _db = drizzle(client, { schema });
  return _db;
}

export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_target, prop) {
    return (getDb() as any)[prop];
  },
});

/** The existing lazy pool. Its serializers follow the installed Drizzle adapter contract. */
export function getPostgresClient(): ReturnType<typeof postgres> {
  getDb();
  if (!_postgresClient) throw new Error('Database client is unavailable');
  return _postgresClient;
}

export type Database = PostgresJsDatabase<typeof schema>;
