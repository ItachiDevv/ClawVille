/**
 * Import vanity keypairs from JSON files into the database (encrypted).
 *
 * Usage:
 *   bun run scripts/import-vanity-keypairs.ts --dir ./vanity-keys/CLAW --suffix CLAW
 *   bun run scripts/import-vanity-keypairs.ts --dir ./vanity-keys/HRMS --suffix HRMS
 *   bun run scripts/import-vanity-keypairs.ts --file ./my-key.json --suffix CLAW
 *
 * Expects:
 *   - Each .json file contains a JSON array of 64 numbers (Solana keypair secret key bytes)
 *     e.g. [12, 45, 200, ... 64 numbers total]
 *   - VANITY_ENCRYPTION_KEY env var set (64 hex chars = 32 bytes)
 *   - DATABASE_URL env var set
 */

import { resolve } from 'path';
import { readdirSync, readFileSync } from 'fs';
import { Keypair } from '@solana/web3.js';

// Load env
import { config } from 'dotenv';
config({ path: resolve(__dirname, '../.env.local') });

import { importVanityKeypair } from '../apps/api/src/services/keypair-vault';

const args = process.argv.slice(2);
const suffixIdx = args.indexOf('--suffix');
const dirIdx = args.indexOf('--dir');
const fileIdx = args.indexOf('--file');

if (suffixIdx === -1) {
  console.error('Usage: --suffix CLAW|HRMS  --dir <path> | --file <path>');
  process.exit(1);
}

const suffix = args[suffixIdx + 1] as 'CLAW' | 'HRMS';
if (suffix !== 'CLAW' && suffix !== 'HRMS') {
  console.error('Suffix must be CLAW or HRMS');
  process.exit(1);
}

async function importFile(filePath: string) {
  const raw = readFileSync(filePath, 'utf8');
  const bytes = new Uint8Array(JSON.parse(raw));

  if (bytes.length !== 64) {
    console.error(`  SKIP ${filePath}: expected 64 bytes, got ${bytes.length}`);
    return false;
  }

  const keypair = Keypair.fromSecretKey(bytes);
  const pubkey = keypair.publicKey.toBase58();

  if (!pubkey.endsWith(suffix)) {
    console.error(`  SKIP ${filePath}: ${pubkey} does not end with ${suffix}`);
    return false;
  }

  try {
    const result = await importVanityKeypair(bytes, suffix);
    console.log(`  OK ${result.publicKey}`);
    return true;
  } catch (err: any) {
    if (err.message?.includes('unique') || err.code === '23505') {
      console.log(`  SKIP ${pubkey} (already imported)`);
      return false;
    }
    throw err;
  }
}

async function main() {
  let files: string[] = [];

  if (fileIdx !== -1) {
    files = [resolve(args[fileIdx + 1])];
  } else if (dirIdx !== -1) {
    const dir = resolve(args[dirIdx + 1]);
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => resolve(dir, f));
  } else {
    console.error('Provide --dir <path> or --file <path>');
    process.exit(1);
  }

  console.log(`Importing ${files.length} keypair(s) with suffix ${suffix}...\n`);

  let imported = 0;
  for (const f of files) {
    const ok = await importFile(f);
    if (ok) imported++;
  }

  console.log(`\nDone: ${imported} imported, ${files.length - imported} skipped.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
