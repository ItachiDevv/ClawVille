/**
 * Idempotently provision the dedicated land hold-wallet VERIFY wallet (door 2).
 *
 * Run from apps/api:
 *   bun run scripts/land/provision-hold-verify-wallet.ts
 *
 * This is the address a user sends their exact dust amount TO when they prove
 * ownership of a declared hold wallet without connecting a browser wallet, and
 * the address the automatic refund is paid FROM. Until this row exists,
 * `getTransferDoorAvailability()` reports the door unavailable and the API
 * answers `transfer_door_unavailable` (503) — that IS the on/off switch, because
 * CLAUDE.md forbids a dark feature flag in prod.
 *
 * MAINNET (T4). CLV and these wallets live on mainnet, so the balance read here
 * uses the same `HELIUS_API_KEY` seam the service uses. It deliberately does NOT
 * read `loadSapConfig().rpcUrl` — SAP is cluster-gated to devnet, and reporting a
 * devnet balance for a mainnet wallet would hide an unfunded verify wallet.
 *
 * Prints ONLY the public funding address and its current SOL balance. Secret
 * bytes are encrypted immediately under VANITY_ENCRYPTION_KEY and are NEVER
 * logged, echoed, or written anywhere but the encrypted column (T10).
 *
 * FUNDING GUIDANCE: every verification refunds the user's dust and burns about
 * 5000 lamports of our fee, so this wallet needs roughly
 * `LAND_HOLD_VERIFY_DAILY_REFUND_CAP_SOL` of working float plus headroom. The
 * daily cap bounds the worst-case drain; funding below one day of cap means
 * refunds start failing into `reconcile` and paging ops.
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../../../../.env.local') });

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { db, sql } from '@clawville/database';
import { encryptSecretKey } from '../../src/services/keypair-vault';
import { landHoldVerifyRpcUrl } from '../../src/services/land-hold-transfer-verify';

const PURPOSE = 'land-hold-verify';
const PROVISION_LOCK_KEY = 'land:hold-verify:provision';

async function ensurePurposeEnumValue(): Promise<void> {
  // `treasury_purpose` is a Postgres ENUM. The migration should already carry
  // this value, but the script stays self-sufficient on a box that has not taken
  // it yet. It MUST run as its own statement: Postgres refuses to USE a newly
  // added enum value inside the transaction that added it.
  try {
    await db.execute(sql`ALTER TYPE treasury_purpose ADD VALUE IF NOT EXISTS 'land-hold-verify'`);
  } catch (err) {
    console.warn(
      `[${PURPOSE}] could not extend treasury_purpose (continuing; the migration may already own it):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function main(): Promise<void> {
  if (!process.env.VANITY_ENCRYPTION_KEY) {
    throw new Error('VANITY_ENCRYPTION_KEY is required to provision the hold-verify wallet');
  }

  await ensurePurposeEnumValue();

  // Rotation is deliberately opt-in: a bare run must never silently replace the
  // address users are being told to send money to.
  const ROTATE = process.argv.includes('--rotate');
  if (ROTATE) {
    console.log(
      `[${PURPOSE}] --rotate: the current wallet will be RETIRED (kept, not deleted) and replaced.`,
    );
  }

  // Advisory lock so two concurrent operator runs cannot mint two verify
  // wallets (which would split the address users send dust to).
  const publicKey = await db.transaction(async (tx): Promise<string> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${PROVISION_LOCK_KEY}, 0))`);

    // ACTIVE row only. Retired wallets are kept forever (their dust stays
    // recoverable only while we hold the key), so they must never be mistaken
    // for the live one.
    const existing = await tx.execute<{ public_key: string }>(sql`
      SELECT public_key FROM treasury_wallets
      WHERE purpose::text = ${PURPOSE} AND retired_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`);
    if (existing[0]) {
      if (!ROTATE) {
        console.log(`[${PURPOSE}] Existing ACTIVE treasury wallet found.`);
        return existing[0].public_key;
      }
      // ROTATION: mark the live wallet retired so the active-only singleton
      // admits the new one. The row and its encrypted key are RETAINED, never
      // deleted and never re-purposed — that retention is what keeps dust
      // already sent to it recoverable, and what the rotated-destination
      // discovery path reads to record what we still owe.
      await tx.execute(sql`
        UPDATE treasury_wallets SET retired_at = now()
        WHERE purpose::text = ${PURPOSE} AND retired_at IS NULL`);
      console.log(
        `[${PURPOSE}] Retired ${existing[0].public_key} (row and key RETAINED for refunds).`,
      );
    }

    const keypair = Keypair.generate();
    const encrypted = encryptSecretKey(keypair.secretKey);
    const inserted = await tx.execute<{ public_key: string }>(sql`
      INSERT INTO treasury_wallets
        (purpose, public_key, encrypted_secret_key, encryption_iv, encryption_tag, notes)
      VALUES
        (${PURPOSE}::treasury_purpose, ${keypair.publicKey.toBase58()},
         ${encrypted.encryptedSecretKey}, ${encrypted.encryptionIv}, ${encrypted.encryptionTag},
         'Land hold-wallet ownership proof (door 2): receives exact dust, pays the automatic refund')
      RETURNING public_key`);
    if (!inserted[0]) throw new Error('hold-verify wallet insert returned no row');
    console.log(`[${PURPOSE}] Created dedicated treasury wallet.`);
    return inserted[0].public_key;
  });

  const connection = new Connection(landHoldVerifyRpcUrl(), 'confirmed');
  const balanceLamports = await connection.getBalance(new PublicKey(publicKey), 'confirmed');
  console.log(`Public key to fund (MAINNET): ${publicKey}`);
  console.log(`Current balance: ${(balanceLamports / LAMPORTS_PER_SOL).toFixed(9)} SOL`);
  console.log(
    `RPC endpoint: ${process.env.HELIUS_API_KEY?.trim() ? 'helius mainnet' : 'public mainnet-beta'}`,
  );
}

main().catch((err) => {
  console.error(
    `[${PURPOSE}] Provisioning failed:`,
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
