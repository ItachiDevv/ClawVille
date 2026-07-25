/**
 * STAGING-ONLY harness hygiene: close open GUEST demo shoes (blackjack +
 * baccarat) so the fingerprint-shared harness guest re-mints a fresh
 * demo-balance shoe on next open. Guest shoes are demo-vCLAW only — no real
 * currency is touched; a closed shoe simply causes a fresh one on next open.
 */
import postgres from 'postgres';
import { readFileSync } from 'fs';

const ENV_PATH = 'C:/Users/itachi/Documents/Crypto/cv-cove-3d/apps/api/.env.local';
const envText = readFileSync(ENV_PATH, 'utf8');
const line = envText.split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL') && l.includes(':5432'));
if (!line) throw new Error('No :5432 DATABASE_URL');
const url = line.slice(line.indexOf('=') + 1).trim().replace(/^"|"$/g, '');
if (!/postgres\.mtpixvtclsjqjguouxes:/.test(url)) throw new Error('Refusing: not the staging DB');

const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 20 });
try {
  const bj = await sql`
    UPDATE blackjack_shoes SET status = 'closed', closed_at = now()
    WHERE status = 'open' AND guest_fp_hash IS NOT NULL
    RETURNING id`;
  const bac = await sql`
    UPDATE baccarat_shoes SET status = 'closed', closed_at = now()
    WHERE status = 'open' AND guest_fp_hash IS NOT NULL
    RETURNING id`;
  console.log(`GUEST-SHOES-RESET blackjack=${bj.length} baccarat=${bac.length}`);
} finally {
  await sql.end();
}
