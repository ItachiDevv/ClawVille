import { db } from '@clawville/database';
import { sql } from 'drizzle-orm';

const cols = await db.execute(sql`
  SELECT column_name, data_type, character_maximum_length, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'users' AND column_name = 'username'
`);
console.log('COLUMN:', JSON.stringify(cols, null, 2));

const cs = await db.execute(sql`
  SELECT conname, pg_get_constraintdef(oid) AS def
  FROM pg_constraint
  WHERE conrelid = 'users'::regclass AND conname LIKE 'users_username%'
`);
console.log('CONSTRAINTS:', JSON.stringify(cs, null, 2));

const filled = await db.execute(sql`
  SELECT
    COUNT(*) FILTER (WHERE username IS NOT NULL) AS with_username,
    COUNT(*) AS total
  FROM users
`);
console.log('BACKFILL COUNTS:', JSON.stringify(filled, null, 2));

process.exit(0);
