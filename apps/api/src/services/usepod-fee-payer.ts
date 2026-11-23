/**
 * UsePod fee wallet (founder 2026-11-11). A ClawVille-owned SOL hot wallet,
 * `treasury_wallets` purpose 'usepod-fee-payer', pays the network fee of a
 * UsePod deposit so the avatar wallet needs no SOL. Sponsorship is ON only
 * while one ACTIVE row exists (no env flag; migrations 0121a/0121b). The key is
 * encrypted at rest under VANITY_ENCRYPTION_KEY like every treasury row and is
 * decrypted only to sign one deposit, then wiped. Never log the secret.
 */
import type { Keypair } from '@solana/web3.js';
import { db, sql } from '@clawville/database';
import { decryptSecretKey } from './keypair-vault';

export const USEPOD_FEE_PAYER_PURPOSE = 'usepod-fee-payer';

/**
 * The ACTIVE fee wallet public key, or null when none is provisioned.
 * `purpose::text` so a database without migration 0121a reads "none", never throws.
 * A database error throws: the deposit path then refuses (fail closed).
 */
export async function readUsepodFeePayer(): Promise<string | null> {
  const rows = await db.execute<{ public_key: string }>(sql`
    SELECT public_key FROM treasury_wallets
    WHERE purpose::text = ${USEPOD_FEE_PAYER_PURPOSE} AND retired_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1`);
  return Array.from(rows)[0]?.public_key ?? null;
}

/** Fills the private copy that a web3.js Keypair holds. */
export function wipeKeypair(keypair: Keypair | null | undefined): void {
  (keypair as unknown as { _keypair?: { secretKey?: Uint8Array } } | null | undefined)?._keypair?.secretKey?.fill(0);
}

/**
 * Decrypts the ACTIVE fee wallet whose public key is `publicKey`. Refuses a
 * retired, missing or mismatched row. The caller wipes the result.
 */
export async function loadUsepodFeePayerKeypair(publicKey: string): Promise<Keypair> {
  const rows = await db.execute<{
    public_key: string;
    encrypted_secret_key: string;
    encryption_iv: string;
    encryption_tag: string;
  }>(sql`
    SELECT public_key, encrypted_secret_key, encryption_iv, encryption_tag
    FROM treasury_wallets
    WHERE purpose::text = ${USEPOD_FEE_PAYER_PURPOSE} AND retired_at IS NULL AND public_key = ${publicKey}
    LIMIT 1`);
  const row = Array.from(rows)[0];
  if (!row) throw new Error('fee_wallet_changed');
  const keypair = decryptSecretKey(row.encrypted_secret_key, row.encryption_iv, row.encryption_tag);
  if (keypair.publicKey.toBase58() !== row.public_key) {
    wipeKeypair(keypair);
    // Public keys only.
    throw new Error('fee_wallet_pubkey_mismatch');
  }
  return keypair;
}
