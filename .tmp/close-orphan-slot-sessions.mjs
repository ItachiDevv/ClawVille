import { Client } from 'pg';
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
try {
  // Show open sessions before
  const before = await c.query(`
    SELECT id, user_id, paytable_id, created_at, server_seed_hash
    FROM slot_sessions WHERE status='open'
    ORDER BY created_at DESC
  `);
  console.log('OPEN BEFORE:', JSON.stringify(before.rows, null, 2));

  // Force-close all open sessions (test residue) — reveals serverSeed, sets closedAt
  const closed = await c.query(`
    UPDATE slot_sessions
    SET status='closed', closed_at=NOW()
    WHERE status='open'
    RETURNING id, user_id, paytable_id
  `);
  console.log('CLOSED:', closed.rowCount, JSON.stringify(closed.rows, null, 2));

  // Sanity check
  const after = await c.query(`SELECT COUNT(*)::int as n FROM slot_sessions WHERE status='open'`);
  console.log('OPEN AFTER:', after.rows[0]);
} catch (e) {
  console.error('ERR:', e.message);
} finally {
  await c.end();
}
