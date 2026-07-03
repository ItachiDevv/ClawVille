/**
 * Apply the magic-link onboarding `agent_session_tickets.issued_to_agent_id`
 * column (one additive, idempotent nullable text) to a target DB.
 *
 * Run from anywhere:
 *   AGENTS_DATABASE_URL="postgres://…" bun packages/database/scripts/apply-ticket-agent-id.ts
 *
 * ── WHY a bespoke env var, not DATABASE_URL ──────────────────────────────────
 * Bun AUTO-LOADS `<cwd>/.env.local`, and the package's index.ts also loads the
 * repo `.env.local` — either could silently inject a PROD `DATABASE_URL`. To make
 * the target DB an EXPLICIT, deliberate choice, this script reads ONLY
 * `AGENTS_DATABASE_URL` (a name nothing auto-populates, shared with the sibling
 * agent-metaverse migrations `apply-openclaw-is-house.ts` /
 * `apply-platform-agents-openclaw-bot-singleton.ts`) and refuses to run if it is
 * missing. It NEVER hardcodes or auto-loads a connection string. This is the
 * "[No Prod URL in env / Bun auto-load]" lesson made mechanical.
 *
 * The migration SQL is fully idempotent (`ADD COLUMN IF NOT EXISTS`) — re-running
 * is safe. PURELY ADDITIVE: it only ADDs one nullable text column to the EXISTING
 * `agent_session_tickets` table, so it can never drop or rewrite live data. NOT
 * run via `db:push` — that is `drizzle-kit push --force` (silently destructive on
 * a shared/partial-schema branch); this deterministic script is the safe apply
 * path.
 */

import postgres from 'postgres';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// import.meta.dir is Bun-native; fileURLToPath keeps it portable if run via node.
const SCRIPT_DIR =
  (import.meta as unknown as { dir?: string }).dir ??
  dirname(fileURLToPath(import.meta.url));

const TARGET_URL = process.env.AGENTS_DATABASE_URL;
if (!TARGET_URL) {
  console.error(
    '[ticket-agent-id] AGENTS_DATABASE_URL is not set.\n' +
      '                 Set it explicitly to the DB you intend to migrate, e.g.:\n' +
      '                   AGENTS_DATABASE_URL="postgres://…staging…" bun packages/database/scripts/apply-ticket-agent-id.ts\n' +
      '                 (DATABASE_URL is deliberately NOT used — it auto-loads and could be prod.)',
  );
  process.exit(1);
}

const sqlPath = resolve(
  SCRIPT_DIR,
  '../migrations-manual/2026-07-02_ticket_agent_id.sql',
);
const fullSql = readFileSync(sqlPath, 'utf-8');

// max:1 + prepare:false matches the Supabase transaction-pooler discipline used by
// the package's runtime client (named prepared statements break over the pooler).
const client = postgres(TARGET_URL, { max: 1, prepare: false });

try {
  console.log('[ticket-agent-id] Applying agent_session_tickets.issued_to_agent_id column from', sqlPath);
  await client.unsafe(fullSql);

  // Post-apply verification — prove the column landed with the expected shape.
  const cols = await client`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'agent_session_tickets'
      AND column_name = 'issued_to_agent_id'
  `;
  if (cols.length !== 1) {
    throw new Error('[ticket-agent-id] issued_to_agent_id column NOT present after apply');
  }
  const col = cols[0];
  console.log(
    `[ticket-agent-id] agent_session_tickets.issued_to_agent_id: type=${col.data_type} nullable=${col.is_nullable}`,
  );
  if (col.is_nullable !== 'YES') {
    console.warn(
      '[ticket-agent-id] ⚠ issued_to_agent_id is NOT NULL — expected nullable. A ' +
        'pre-existing column may differ from the schema; reconcile before minting tickets.',
    );
  }

  console.log('[ticket-agent-id] ✓ migration applied');
} catch (err) {
  console.error('[ticket-agent-id] FAILED:', err);
  process.exit(1);
} finally {
  await client.end();
}
