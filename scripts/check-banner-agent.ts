import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import { db, sql } from '@clawville/database';

const prefix = process.argv[2] ?? '612bd0be';

console.log(`=== avatars whose platform_agent_id starts with "${prefix}" ===\n`);
const avatarRows = await db.execute<{
  avatar_id: string;
  user_id: string;
  name: string;
  harness: string;
  platform_agent_id: string;
  email: string;
  bot_count: number;
}>(sql`
  SELECT a.id::text AS avatar_id, a.user_id::text AS user_id, a.name, a.harness,
         a.platform_agent_id::text AS platform_agent_id,
         u.email,
         (SELECT count(*)::int FROM openclaw_bots WHERE user_id = a.user_id) AS bot_count
  FROM avatars a
  JOIN users u ON u.id = a.user_id
  WHERE a.platform_agent_id::text LIKE ${prefix + '%'}
  LIMIT 3
`);
console.log(JSON.stringify(avatarRows, null, 2));

if (avatarRows.length > 0) {
  const userId = avatarRows[0].user_id;
  console.log(`\n=== openclaw_bots rows for user ${userId} ===\n`);
  const bots = await db.execute(sql`
    SELECT agent_id, identity_type, last_seen_at, session_expires_at, session_swept_at,
           (session_expires_at < now()) AS is_expired,
           ROUND(EXTRACT(EPOCH FROM (now() - last_seen_at)) / 3600.0, 1) AS hours_since_seen
    FROM openclaw_bots WHERE user_id = ${userId}
    ORDER BY last_seen_at DESC
  `);
  console.log(JSON.stringify(bots, null, 2));
}

process.exit(0);
