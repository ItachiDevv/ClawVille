import postgres from 'postgres';
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(__dirname, '../../../.env.local') });

const client = postgres(process.env.DATABASE_URL!, { max: 1 });

try {
  // Most recent 10 events — confirm fp_hash + ip_prefix_hash are populating.
  const recent = await client`
    SELECT
      event_type,
      ts,
      fp_hash IS NOT NULL AS has_fp,
      ip_prefix_hash IS NOT NULL AS has_ip,
      LENGTH(fp_hash) AS fp_len
    FROM events
    WHERE ts > now() - interval '5 minutes'
    ORDER BY ts DESC
    LIMIT 10
  `;
  console.log('[verify] Recent events:');
  for (const r of recent) {
    console.log(`  ${r.event_type.padEnd(28)} ts=${new Date(r.ts).toISOString()} fp=${r.has_fp ? `len${r.fp_len}` : 'NULL'} ip=${r.has_ip ? 'set' : 'NULL'}`);
  }

  // Count: how many post-deploy events have fp_hash populated
  const totals = await client`
    SELECT
      event_type,
      COUNT(*) FILTER (WHERE fp_hash IS NOT NULL) AS with_fp,
      COUNT(*) AS total
    FROM events
    WHERE ts > now() - interval '5 minutes'
    GROUP BY event_type
    ORDER BY total DESC
  `;
  console.log('\n[verify] fp_hash coverage in last 5 min:');
  for (const r of totals) {
    console.log(`  ${r.event_type.padEnd(28)} ${r.with_fp}/${r.total}`);
  }
} catch (err) {
  console.error('[verify] FAILED:', err);
  process.exit(1);
} finally {
  await client.end();
}
