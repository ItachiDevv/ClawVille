/**
 * ElizaOS schema pre-migrator
 * ---------------------------
 * Runs once at API boot to ensure `@elizaos/plugin-sql`'s ~20-table schema
 * (agents, memories, rooms, entities, components, embeddings, tasks, etc.)
 * exists in Postgres BEFORE any user triggers a chat.
 *
 * Why: ElizaOS's AgentRuntime.initialize() normally runs migrations lazily on
 * first chat, but that can take 15-30s on a cold Supabase pooler — longer than
 * Bun.serve's 10s idleTimeout — which kills the user's first request. We
 * front-load the migration at boot so every user's first chat hits a warm
 * adapter.
 *
 * Also guards against a real incident (2026-04-16, recurred 2026-04-23): a
 * stale row in `migrations._migrations` once convinced plugin-sql its schema
 * was applied when the tables were actually missing, silently breaking every
 * location chat. The 2026-04-23 recurrence was caused by `drizzle-kit push`
 * with ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true dropping the ElizaOS tables
 * because they weren't in our own Drizzle schema. Fix lives in the
 * tablesFilter negation list in `packages/database/drizzle.config.ts`, plus
 * the hard assertAgentsTableExists() below that refuses to keep running if
 * the guard ever slips.
 *
 * See also: scripts/recover-eliza-schema.mjs for the recovery playbook.
 */

import { platformAgents } from '@clawville/database';

/** Bootstrap agent UUID — used only so createDatabaseAdapter has something to
 *  scope its adapter against. Never written to the `agents` table; this is
 *  just a key for the per-agent adapter map inside plugin-sql. */
const BOOTSTRAP_AGENT_ID = '00000000-0000-0000-0000-000000000001';

export async function ensureElizaMigrated(): Promise<{
  ok: boolean;
  skipped?: boolean;
  error?: string;
}> {
  const postgresUrl = process.env.DATABASE_URL;
  if (!postgresUrl) {
    return { ok: false, error: 'DATABASE_URL not set' };
  }

  try {
    const sqlMod: any = await import('@elizaos/plugin-sql');
    const createDatabaseAdapter =
      sqlMod.createDatabaseAdapter || sqlMod.default?.createDatabaseAdapter;
    const pluginSql = sqlMod.plugin || sqlMod.default;

    if (typeof createDatabaseAdapter !== 'function' || !pluginSql?.schema) {
      return {
        ok: false,
        error:
          '@elizaos/plugin-sql did not expose createDatabaseAdapter + plugin.schema',
      };
    }

    const adapter: any = createDatabaseAdapter(
      { postgresUrl },
      BOOTSTRAP_AGENT_ID,
    );

    // adapter.init() connects to Postgres and readies the drizzle instance.
    // It returns a promise that resolves when the pool is up.
    await adapter.init();

    // Force=true respects ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS but also ensures
    // we don't silently skip when the meta-table state disagrees with reality.
    // Passing a single plugin (plugin-sql) is enough — it's the only one with
    // a schema; our custom OpenAI providers are schema-less.
    const forceDestructive =
      process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS === 'true';

    if (typeof adapter.runPluginMigrations !== 'function') {
      return {
        ok: false,
        error: 'adapter.runPluginMigrations is not a function',
      };
    }

    await adapter.runPluginMigrations(
      [{ name: pluginSql.name, schema: pluginSql.schema }],
      { verbose: false, force: forceDestructive, dryRun: false },
    );

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Suppress unused-import warning — the import is a type-safety tether to the
 *  table we care about existing after this runs. */
void platformAgents;

/**
 * Loud post-migration assertion: if plugin-sql's `agents` table doesn't exist
 * after we just ran its migrator, something has gone silently wrong (stale
 * `_migrations` row, tables dropped by an unrelated `db:push`, snapshot-diff
 * short-circuit). Throwing here refuses to seed system agents, keeps the
 * container restart-looping, and puts the error front-and-center in logs.
 *
 * This is the last line of defense. Layer 1 is the tablesFilter in
 * drizzle.config.ts; layer 3 is the scripts/recover-eliza-schema.mjs runbook.
 */
export async function assertAgentsTableExists(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const postgresUrl = process.env.DATABASE_URL;
  if (!postgresUrl) {
    return { ok: false, error: 'DATABASE_URL not set' };
  }

  try {
    const { default: postgres } = await import('postgres');
    const sql = postgres(postgresUrl, { max: 1, prepare: false });
    try {
      // Any query against the `agents` table will throw
      //   "relation \"agents\" does not exist"
      // if plugin-sql's schema is gone. A COUNT(*) is cheap and doesn't depend
      // on any specific row or column layout.
      await sql`SELECT COUNT(*)::int FROM agents`;
      await sql.end();
      return { ok: true };
    } catch (err) {
      await sql.end();
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
