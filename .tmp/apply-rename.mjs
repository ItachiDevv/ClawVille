import { Client } from 'pg';
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
try {
  await c.query('ALTER TABLE slot_spins RENAME COLUMN bet TO predict');
  console.log('renamed');
} catch (e) {
  console.error('ERR:', e.message);
}
const v = await c.query(
  "SELECT column_name FROM information_schema.columns WHERE table_name='slot_spins' AND column_name IN ('bet','predict')"
);
console.log('columns now:', JSON.stringify(v.rows));
await c.end();
