/**
 * One-off: create the ClawVille UsePod fee wallet (founder 2026-11-11).
 *
 * Run from apps/api on the target box (staging first, then production), after
 * migrations 0121a and 0121b:
 *   bun run scripts/create-usepod-fee-payer.ts
 *
 * It generates a new Solana keypair, encrypts the secret key under
 * VANITY_ENCRYPTION_KEY (AES-256-GCM, `encryptSecretKey`, the same storage as
 * every `treasury_wallets` row) and inserts ONE row with purpose
 * 'usepod-fee-payer'. That row IS the on switch: while it exists the fee wallet
 * pays the network fee of UsePod deposits (no env flag). It REFUSES when any
 * usepod-fee-payer row already exists, active or retired: it never replaces or
 * rotates a wallet.
 *
 * Output: ONLY the public key to fund. The secret key is never printed, logged
 * or written anywhere but the encrypted columns. The founder funds the printed
 * address with less than 0.05 SOL. The wallet sponsors only while it holds at
 * least USEPOD_FEE_WALLET_MIN_LAMPORTS (it stays rent exempt); below 0.01 SOL
 * the API logs a refill warning.
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../../../.env.local') });

import { Keypair } from '@solana/web3.js';
import { db, sql } from '@clawville/database';
import { encryptSecretKey } from '../src/services/keypair-vault';
import { USEPOD_FEE_PAYER_PURPOSE } from '../src/services/usepod-fee-payer';

const CREATE_LOCK_KEY = 'usepod:fee-payer:create';

async function main(): Promise<void> {
  if (!process.env.VANITY_ENCRYPTION_KEY) throw new Error('VANITY_ENCRYPTION_KEY is required');
  const publicKey = await db.transaction(async (tx): Promise<string> => {
    // Two concurrent runs cannot both create a wallet.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${CREATE_LOCK_KEY}, 0))`);
    const existing = await tx.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM treasury_wallets WHERE purpose::text = ${USEPOD_FEE_PAYER_PURPOSE}`);
    if ((Array.from(existing)[0]?.n ?? 0) > 0) {
      throw new Error('a usepod-fee-payer treasury wallet already exists; this script never replaces one');
    }
    const keypair = Keypair.generate();
    try {
      const encrypted = encryptSecretKey(keypair.secretKey);
      const inserted = await tx.execute<{ public_key: string }>(sql`
        INSERT INTO treasury_wallets
          (purpose, public_key, encrypted_secret_key, encryption_iv, encryption_tag, notes)
        VALUES
          (${USEPOD_FEE_PAYER_PURPOSE}::treasury_purpose, ${keypair.publicKey.toBase58()},
           ${encrypted.encryptedSecretKey}, ${encrypted.encryptionIv}, ${encrypted.encryptionTag},
           'UsePod deposit network fee payer (founder 2026-11-11); fund with less than 0.05 SOL')
        RETURNING public_key`);
      const row = Array.from(inserted)[0];
      if (!row) throw new Error('insert returned no row');
      return row.public_key;
    } finally {
      (keypair as unknown as { _keypair?: { secretKey?: Uint8Array } })._keypair?.secretKey?.fill(0);
    }
  });
  console.log(`UsePod fee wallet public key (fund on MAINNET with less than 0.05 SOL): ${publicKey}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // The message only; never an object that could hold key material.
    console.error(`[${USEPOD_FEE_PAYER_PURPOSE}] create failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
