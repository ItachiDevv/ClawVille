/**
 * CI-ONLY drizzle config — full base-schema generation into an EMPTY out dir.
 *
 * The hand-authored migrations in ./migrations are forward-only on top of a
 * base schema that predates them (built via db:push before the migration era),
 * so a truly-fresh database (the gates.yml Postgres service) cannot be
 * bootstrapped by migrate-ci.ts alone. CI generates the CURRENT full schema
 * from src/schema (drizzle-kit generate — pure TS→SQL, NO db introspection,
 * so the known drizzle-kit introspection bug does not apply), applies it to
 * the empty service DB, then runs migrate-ci.ts on top (idempotent no-ops +
 * the hand-authored bits like sequences/backfills).
 *
 * NEVER point this at a real database and NEVER use it with push.
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './.drizzle-ci-bootstrap',
  dialect: 'postgresql',
  verbose: true,
  strict: true,
});
