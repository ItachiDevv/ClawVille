// Audit: run each of the 7 dashboard queries against prod to confirm
// they execute and return expected shapes. Data is empty/near-empty so
// we're primarily checking for SQL errors, not values.

import 'dotenv/config';
import postgres from '../packages/database/node_modules/postgres/src/index.js';

const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: 'require' });

try {
  console.log('--- Q1: DAU + 7d delta ---');
  const q1 = await sql`
    WITH now_24h AS (
      SELECT COUNT(DISTINCT agent_id)::int AS c
      FROM events
      WHERE event_type = 'agent.connected'
        AND ts > now() - interval '24 hours'
        AND agent_id IS NOT NULL
    ), prev_24h AS (
      SELECT COUNT(DISTINCT agent_id)::int AS c
      FROM events
      WHERE event_type = 'agent.connected'
        AND ts > now() - interval '7 days'
        AND ts <= now() - interval '6 days'
        AND agent_id IS NOT NULL
    )
    SELECT (SELECT c FROM now_24h) AS count,
           (SELECT c FROM prev_24h) AS prev_count
  `;
  console.log('  result:', q1[0]);

  console.log('--- Q2: Milady origin pct ---');
  const q2 = await sql`
    SELECT
      COUNT(DISTINCT agent_id)::int AS total,
      COUNT(DISTINCT agent_id) FILTER (WHERE payload->>'miladyAgentId' IS NOT NULL)::int AS milady
    FROM events
    WHERE event_type = 'agent.connected'
      AND ts > now() - interval '24 hours'
      AND agent_id IS NOT NULL
  `;
  console.log('  result:', q2[0]);

  console.log('--- Q3: Connect → first engagement ---');
  const q3 = await sql`
    WITH connects AS (
      SELECT DISTINCT agent_id FROM events
      WHERE event_type = 'agent.connected'
        AND ts > now() - interval '7 days'
        AND agent_id IS NOT NULL
    ),
    engaged AS (
      SELECT DISTINCT agent_id FROM events
      WHERE event_type IN ('building.visited', 'agent.chat.turn')
        AND ts > now() - interval '7 days'
        AND agent_id IS NOT NULL
    )
    SELECT
      (SELECT COUNT(*)::int FROM connects) AS connects,
      (SELECT COUNT(*)::int FROM connects c JOIN engaged e USING (agent_id)) AS engaged
  `;
  console.log('  result:', q3[0]);

  console.log('--- Q4: Returning-day rate ---');
  const q4 = await sql`
    WITH agent_days AS (
      SELECT agent_id, COUNT(DISTINCT DATE(ts)) AS distinct_days
      FROM events
      WHERE ts > now() - interval '7 days'
        AND agent_id IS NOT NULL
      GROUP BY agent_id
    )
    SELECT
      COUNT(*)::int AS total_agents,
      COUNT(*) FILTER (WHERE distinct_days >= 2)::int AS returning_agents
    FROM agent_days
  `;
  console.log('  result:', q4[0]);

  console.log('--- Q5: Collaborations ---');
  const q5 = await sql`
    SELECT COUNT(*)::int AS count FROM events
    WHERE event_type = 'agent.collaboration.turn'
      AND ts > now() - interval '7 days'
  `;
  console.log('  result:', q5[0]);

  console.log('--- Q6: Teacher chats ---');
  const q6 = await sql`
    SELECT COUNT(*)::int AS count FROM events
    WHERE event_type = 'agent.chat.turn'
      AND ts > now() - interval '7 days'
      AND payload->>'chatType' IN ('building', 'character')
  `;
  console.log('  result:', q6[0]);

  console.log('--- Q7: Buildings by visits ---');
  const q7 = await sql`
    SELECT building_id, COUNT(*)::int AS visits FROM events
    WHERE event_type = 'building.visited'
      AND ts > now() - interval '7 days'
      AND building_id IS NOT NULL
    GROUP BY building_id
    ORDER BY visits DESC
  `;
  console.log(`  result: ${q7.length} buildings:`, q7);

  console.log('\n--- All 7 queries executed OK ---');

  // Audit: list all events so far (should be 1 from the smoke test + recent alerts etc)
  console.log('\n--- All events in table ---');
  const all = await sql`SELECT event_type, agent_id, building_id, ts FROM events ORDER BY ts DESC LIMIT 10`;
  for (const r of all) {
    console.log(`  ${r.ts.toISOString()} ${r.event_type} agent=${r.agent_id} bldg=${r.building_id}`);
  }
} finally {
  await sql.end();
}
