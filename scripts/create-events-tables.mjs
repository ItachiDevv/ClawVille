// One-shot schema creation for events + event_write_failures.
// Idempotent (uses IF NOT EXISTS). Run once, delete afterwards.
// Bypasses drizzle-kit's interactive rename-detection prompt that fires when
// there are unrelated tables in the DB it doesn't know about (ElizaOS tables).

import 'dotenv/config';
import postgres from '../packages/database/node_modules/postgres/src/index.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(url, { max: 1, ssl: 'require' });

try {
  console.log('Creating events table...');
  await sql`
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      event_type TEXT NOT NULL,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      agent_id TEXT,
      pet_id UUID REFERENCES pets(id) ON DELETE SET NULL,
      building_id TEXT,
      session_id TEXT,
      payload JSONB
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events (event_type, ts DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_agent_ts ON events (agent_id, ts DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_pet_ts ON events (pet_id, ts DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_building_ts ON events (building_id, ts DESC)`;
  console.log('✓ events table + 4 indexes ready');

  console.log('Creating event_write_failures table...');
  await sql`
    CREATE TABLE IF NOT EXISTS event_write_failures (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempted_event_type TEXT,
      attempted_row JSONB,
      error_message TEXT,
      error_stack TEXT,
      retried_at TIMESTAMPTZ,
      retry_succeeded BOOLEAN
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_event_write_failures_ts ON event_write_failures (ts DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_event_write_failures_unretried ON event_write_failures (ts DESC) WHERE retried_at IS NULL`;
  console.log('✓ event_write_failures table + 2 indexes ready');

  // Sanity check — select 0 rows, confirm tables exist and have the expected columns
  const eventsCheck = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'events' ORDER BY ordinal_position
  `;
  const failuresCheck = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'event_write_failures' ORDER BY ordinal_position
  `;
  console.log(`events columns: ${eventsCheck.map((r) => r.column_name).join(', ')}`);
  console.log(`event_write_failures columns: ${failuresCheck.map((r) => r.column_name).join(', ')}`);
  console.log('\nAll schema objects created successfully.');
} finally {
  await sql.end();
}
