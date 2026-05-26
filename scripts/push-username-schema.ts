/**
 * scripts/push-username-schema.ts — one-shot manual schema push for the
 * `users.username` column added 2026-05-19. Used because drizzle-kit
 * 0.24.2 blows up on the partial unique index `platform_agents_system_singleton`
 * (Zod parse: "expression: Expected string, received null") so the
 * project-canonical `bun run db:push` is unusable until that's resolved.
 *
 * Idempotent: uses `ADD COLUMN IF NOT EXISTS` + DO-blocks that guard on
 * pg_constraint. Safe to re-run.
 *
 * Run inside the prod api container (which has DATABASE_URL injected):
 *   docker cp scripts/push-username-schema.ts <api-container>:/tmp/
 *   docker exec <api-container> sh -c 'cd /app && bun run /tmp/push-username-schema.ts'
 */

import { db } from '@clawville/database';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('[push-username-schema] adding column…');
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(20)`);

  console.log('[push-username-schema] adding UNIQUE constraint…');
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_username_unique'
      ) THEN
        ALTER TABLE users ADD CONSTRAINT users_username_unique UNIQUE (username);
      END IF;
    END
    $$;
  `);

  console.log('[push-username-schema] adding CHECK format constraint…');
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_username_format'
      ) THEN
        ALTER TABLE users
          ADD CONSTRAINT users_username_format
          CHECK (username IS NULL OR username ~ '^[a-zA-Z0-9_]{3,20}$');
      END IF;
    END
    $$;
  `);

  const cols = await db.execute(sql`
    SELECT column_name, data_type, character_maximum_length
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'username'
  `);
  console.log('[push-username-schema] verify column:', cols);

  const constraints = await db.execute(sql`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'users'::regclass
      AND conname IN ('users_username_unique', 'users_username_format')
    ORDER BY conname
  `);
  console.log('[push-username-schema] verify constraints:', constraints);

  console.log('[push-username-schema] done');
  process.exit(0);
}

main().catch((err) => {
  console.error('[push-username-schema] fatal:', err);
  process.exit(1);
});
