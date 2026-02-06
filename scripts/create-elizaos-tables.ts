/**
 * Creates ElizaOS plugin-sql core tables in the database.
 * Run: bun run scripts/create-elizaos-tables.ts
 */
import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

const client = new Client(process.env.DATABASE_URL);

async function run() {
  await client.connect();
  console.log('Connected to database');

  // Enable pgvector extension
  await client.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
  console.log('pgvector extension enabled');

  // Create migrations schema and tables
  await client.query(`CREATE SCHEMA IF NOT EXISTS migrations;`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS migrations._migrations (
      id SERIAL PRIMARY KEY,
      plugin_name TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS migrations._journal (
      plugin_name TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      dialect TEXT NOT NULL DEFAULT 'postgresql',
      entries JSONB NOT NULL DEFAULT '[]'
    );
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS migrations._snapshots (
      id SERIAL PRIMARY KEY,
      plugin_name TEXT NOT NULL,
      idx INTEGER NOT NULL,
      snapshot JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(plugin_name, idx)
    );
  `);
  console.log('Migration tables created');

  // Core tables
  await client.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      enabled BOOLEAN NOT NULL DEFAULT true,
      server_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      name TEXT NOT NULL,
      username TEXT,
      system TEXT DEFAULT '',
      bio JSONB DEFAULT '[]'::jsonb,
      message_examples JSONB NOT NULL DEFAULT '[]'::jsonb,
      post_examples JSONB NOT NULL DEFAULT '[]'::jsonb,
      topics JSONB NOT NULL DEFAULT '[]'::jsonb,
      adjectives JSONB NOT NULL DEFAULT '[]'::jsonb,
      knowledge JSONB NOT NULL DEFAULT '[]'::jsonb,
      plugins JSONB NOT NULL DEFAULT '[]'::jsonb,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      style JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  console.log('agents table created');

  await client.query(`
    CREATE TABLE IF NOT EXISTS servers (
      id UUID PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('servers table created');

  await client.query(`
    CREATE TABLE IF NOT EXISTS entities (
      id UUID PRIMARY KEY NOT NULL,
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      names TEXT[] NOT NULL DEFAULT '{}'::text[],
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  console.log('entities table created');

  await client.query(`
    CREATE TABLE IF NOT EXISTS worlds (
      id UUID PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      metadata JSONB,
      message_server_id UUID,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);
  console.log('worlds table created');

  await client.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id UUID PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
      agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      message_server_id UUID,
      world_id UUID,
      name TEXT,
      metadata JSONB,
      channel_id TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);
  console.log('rooms table created');

  await client.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id UUID PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      content JSONB NOT NULL,
      entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
      world_id UUID,
      "unique" BOOLEAN NOT NULL DEFAULT true,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  // Indexes for memories
  await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_type_room ON memories(type, room_id);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_world_id ON memories(world_id);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_metadata_type ON memories((metadata->>'type'));`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_document_id ON memories((metadata->>'documentId'));`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_fragments_order ON memories((metadata->>'documentId'), (metadata->>'position'));`);
  console.log('memories table created');

  await client.query(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id UUID PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
      memory_id UUID REFERENCES memories(id) ON DELETE CASCADE,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      dim_384 vector(384),
      dim_512 vector(512),
      dim_768 vector(768),
      dim_1024 vector(1024),
      dim_1536 vector(1536),
      dim_3072 vector(3072)
    );
  `);
  console.log('embeddings table created');

  await client.query(`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT NOT NULL,
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      value JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ,
      PRIMARY KEY (key, agent_id)
    );
  `);
  console.log('cache table created');

  await client.query(`
    CREATE TABLE IF NOT EXISTS components (
      id UUID PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
      entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      world_id UUID REFERENCES worlds(id) ON DELETE CASCADE,
      source_entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      data JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);
  console.log('components table created');

  await client.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      body JSONB NOT NULL,
      type TEXT NOT NULL,
      room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE
    );
  `);
  console.log('logs table created');

  await client.query(`
    CREATE TABLE IF NOT EXISTS participants (
      id UUID PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
      room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
      agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
      room_state TEXT
    );
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_participants_user ON participants(entity_id);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_participants_room ON participants(room_id);`);
  console.log('participants table created');

  await client.query(`
    CREATE TABLE IF NOT EXISTS relationships (
      id UUID PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      source_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      target_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      tags TEXT[],
      metadata JSONB,
      UNIQUE(source_entity_id, target_entity_id, agent_id)
    );
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_relationships_users ON relationships(source_entity_id, target_entity_id);`);
  console.log('relationships table created');

  await client.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      description TEXT,
      room_id UUID,
      world_id UUID,
      entity_id UUID,
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      tags TEXT[] DEFAULT '{}'::text[],
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('tasks table created');

  await client.query(`
    CREATE TABLE IF NOT EXISTS message_servers (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT,
      metadata JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('message_servers table created');

  await client.query(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      message_server_id UUID NOT NULL REFERENCES message_servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      source_type TEXT,
      source_id TEXT,
      topic TEXT,
      metadata JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('channels table created');

  await client.query(`
    CREATE TABLE IF NOT EXISTS central_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      raw_message JSONB,
      in_reply_to_root_message_id TEXT REFERENCES central_messages(id) ON DELETE SET NULL,
      source_type TEXT,
      source_id TEXT,
      metadata JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('central_messages table created');

  await client.query(`
    CREATE TABLE IF NOT EXISTS channel_participants (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL,
      PRIMARY KEY (channel_id, entity_id)
    );
  `);
  console.log('channel_participants table created');

  await client.query(`
    CREATE TABLE IF NOT EXISTS message_server_agents (
      message_server_id UUID NOT NULL REFERENCES message_servers(id) ON DELETE CASCADE,
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      PRIMARY KEY (message_server_id, agent_id)
    );
  `);
  console.log('message_server_agents table created');

  await client.end();
  console.log('\nAll ElizaOS tables created successfully!');
}

run().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
