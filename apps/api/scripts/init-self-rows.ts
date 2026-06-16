/**
 * init-self-rows.ts — one-off: create ElizaOS self-rows for avatar-agents that
 * have learned-skill knowledge but whose runtime has never initialised (so the
 * agents/rooms/entities/worlds FK parents the `memories` table needs don't exist
 * yet, and the embedding backfill skips them).
 *
 * Uses the PROVEN production path — agentOrchestrator.startAgent (which runs
 * createElizaRuntime + runtime.initialize, creating every self-row ElizaOS needs
 * the correct way) then stopAgent. We never hand-fabricate ElizaOS rows.
 *
 * After this runs, re-run scripts/backfill-learned-skill-embeddings.mjs to embed.
 *
 * Run: DATABASE_URL=... OPENAI_API_KEY=<working> bun apps/api/scripts/init-self-rows.ts
 */
import pg from 'pg';
import { agentOrchestrator } from '../src/services/agent-orchestrator';

const { Client } = pg;
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');

const c = new Client({
  connectionString: url,
  ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
});
await c.connect();

const r = await c.query(`
  SELECT pa.id AS agent_id, pa.user_id
    FROM platform_agents pa
   WHERE pa.type IN ('avatar-agent', 'openclaw-bot')
     AND pa.user_id IS NOT NULL
     AND (
       -- avatar-agent: knowledge in customization
       (pa.type = 'avatar-agent'
         AND jsonb_typeof(pa.customization->'knowledge') = 'array'
         AND jsonb_array_length(pa.customization->'knowledge') > 0)
       OR
       -- openclaw-bot: knowledge in the linked openclaw_bots row
       (pa.type = 'openclaw-bot'
         AND EXISTS (SELECT 1 FROM openclaw_bots o
                      WHERE o.id = (pa.config->>'openclawBotId')::uuid
                        AND jsonb_typeof(o.knowledge) = 'array'
                        AND jsonb_array_length(o.knowledge) > 0))
     )
     AND NOT (
       EXISTS (SELECT 1 FROM agents a   WHERE a.id = pa.id) AND
       EXISTS (SELECT 1 FROM rooms r    WHERE r.id = pa.id) AND
       EXISTS (SELECT 1 FROM entities e WHERE e.id = pa.id)
     )
   ORDER BY pa.id`);
await c.end();

const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : r.rows.length;
const rows = r.rows.slice(0, LIMIT);
console.log(`[init-self-rows] ${r.rowCount} need self-rows; processing ${rows.length}`);
let ok = 0, fail = 0;
for (const row of rows) {
  try {
    await agentOrchestrator.startAgent(row.agent_id, row.user_id);
    await agentOrchestrator.stopAgent(row.agent_id);
    ok++;
    if (ok % 5 === 0) console.log(`[init-self-rows] ${ok}/${r.rowCount} initialised`);
  } catch (e: any) {
    fail++;
    console.warn(`[init-self-rows] FAIL ${row.agent_id}: ${e?.message || e}`);
  }
}
console.log(`[init-self-rows] DONE ok=${ok} fail=${fail} of ${r.rowCount}`);
process.exit(0);
