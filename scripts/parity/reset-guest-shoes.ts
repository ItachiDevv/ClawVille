/**
 * STAGING-ONLY harness hygiene: close open GUEST demo shoes (blackjack +
 * baccarat) so the fingerprint-shared harness guest re-mints a fresh
 * demo-balance shoe on next open. Guest shoes are demo-vCLAW only — no real
 * currency is touched; a closed shoe simply causes a fresh one on next open.
 */
import postgres from '../../apps/api/node_modules/postgres/src/index.js';
import { readFileSync } from 'node:fs';
import { isStagingDatabase } from './staging-db';

const ENV_PATH = 'C:/Users/itachi/Documents/Crypto/cv-cove-3d/apps/api/.env.local';

export async function resetGuestShoes(): Promise<{
  blackjack: number;
  baccarat: number;
}> {
  const envText = readFileSync(ENV_PATH, 'utf8');
  const line = envText
    .split(/\r?\n/)
    .find((candidate) => (
      // :5432 = legacy Supabase session pooler; :15432 = SSH tunnel to self-hosted staging.
      candidate.startsWith('DATABASE_URL') && /:1?5432\//.test(candidate)
    ));
  if (!line) throw new Error('No :5432 or :15432 DATABASE_URL');
  const url = line.slice(line.indexOf('=') + 1).trim().replace(/^"|"$/g, '');
  if (!(await isStagingDatabase(url))) {
    throw new Error('Refusing: not the staging DB');
  }

  const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 20 });
  try {
    const blackjack = await sql`
      UPDATE blackjack_shoes SET status = 'closed', closed_at = now()
      WHERE status = 'open' AND guest_fp_hash IS NOT NULL
      RETURNING id`;
    const baccarat = await sql`
      UPDATE baccarat_shoes SET status = 'closed', closed_at = now()
      WHERE status = 'open' AND guest_fp_hash IS NOT NULL
      RETURNING id`;
    return {
      blackjack: blackjack.length,
      baccarat: baccarat.length,
    };
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  const reset = await resetGuestShoes();
  console.log(
    `GUEST-SHOES-RESET blackjack=${reset.blackjack} baccarat=${reset.baccarat}`,
  );
}
