/**
 * Seed (or update) the `wager-settlement-authority` row in `treasury_wallets`.
 *
 * The settlement-authority keypair is the one private key the API host needs
 * in order to call `lock_lobby`, `settle_lobby_sol`, authority-cancel, and
 * cleanup instructions on the deployed `clawville_wager` Anchor program
 * (`HgQhHVYV2C5Mw8K81kEnADkqsuS5YQRmGJDUR5wnZVuG`).
 *
 * On devnet the settlement-authority pubkey is the deployer:
 *   `G5WgvGYK5mLxQbVUmNhFKeWwEhT235p2HjKmkbpMbMWy`
 * whose secret key lives at `~/.config/solana/id.json`.
 *
 * Encryption rationale (v1 AES-256-GCM under VANITY_ENCRYPTION_KEY):
 *   The brief suggests envelope encryption via the Cloudflare Worker, but
 *   that pipeline currently only writes into the `wallets` table (per-subject
 *   custodial). `treasury_wallets` is the authoritative store for treasury
 *   keypairs (see wallets.ts header note "the existing treasury_wallets
 *   table is the authoritative store for treasury keypairs. This enum value
 *   is reserved for future unification but not used yet."). To stay
 *   consistent with the existing x402-merchant / fee-collector keypairs
 *   we use v1 encryption keyed by VANITY_ENCRYPTION_KEY — the same secret
 *   that already protects every treasury row. Migrating treasury_wallets
 *   to envelope encryption is a separate Phase 5.1 follow-up.
 *
 *   FEATURE_GATE: treasury-envelope-encryption
 *   Status: scoped, not implemented
 *   Metric to graduate: at least one $10+ on-chain payout settled successfully
 *   Current reading: 0 settlements on chain
 *   Review deadline: 2026-07-01
 *   On deadline: implement envelope-encryption for treasury_wallets OR
 *                document why staying on VANITY_ENCRYPTION_KEY is acceptable
 *   Reference: CLAUDE.md "Feature Gates" section, this script's header
 *
 * Usage:
 *   bun run scripts/seed-wager-settlement-authority.ts [keypair-json-path]
 *
 *   keypair-json-path defaults to:
 *     - $WAGER_SETTLEMENT_AUTHORITY_KEYPAIR_PATH, OR
 *     - $HOME/.config/solana/id.json
 *
 * Idempotent: if a `wager-settlement-authority` row already exists with the
 * correct pubkey, prints the existing row id and exits 0. If the pubkey
 * mismatches the expected, REFUSES to overwrite — operator must manually
 * delete the stale row before re-running.
 *
 * Verification gates:
 *   - the loaded keypair's pubkey MUST equal
 *     `WAGER_SETTLEMENT_AUTHORITY_PUBKEY` env (when set), else the devnet
 *     default `G5WgvGYK5mLxQbVUmNhFKeWwEhT235p2HjKmkbpMbMWy`. Mismatch ⇒
 *     hard exit with a clear error.
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';

config({ path: resolve(__dirname, '../.env.local') });

import { Keypair } from '@solana/web3.js';
import { db, treasuryWallets, eq } from '@clawville/database';
import { encryptSecretKey } from '../apps/api/src/services/keypair-vault';
import { DEVNET_DEFAULT_SETTLEMENT_AUTHORITY } from '@clawville/wager-program';

const TREASURY_PURPOSE = 'wager-settlement-authority' as const;

function resolveKeypairPath(): string {
  const argPath = process.argv[2];
  if (argPath) return argPath;
  if (process.env.WAGER_SETTLEMENT_AUTHORITY_KEYPAIR_PATH) {
    return process.env.WAGER_SETTLEMENT_AUTHORITY_KEYPAIR_PATH;
  }
  return resolve(homedir(), '.config', 'solana', 'id.json');
}

function loadKeypairFromFile(path: string): Keypair {
  if (!existsSync(path)) {
    throw new Error(`Keypair file not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error(
      `Keypair file ${path} must be a 64-element JSON array (Solana CLI format), got ${
        Array.isArray(parsed) ? `length ${parsed.length}` : typeof parsed
      }`,
    );
  }
  return Keypair.fromSecretKey(new Uint8Array(parsed));
}

function expectedPubkeyBase58(): string {
  const env = process.env.WAGER_SETTLEMENT_AUTHORITY_PUBKEY;
  if (env && env.trim().length > 0) return env.trim();
  return DEVNET_DEFAULT_SETTLEMENT_AUTHORITY.toBase58();
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[seed-wager-auth] DATABASE_URL is not set in .env.local');
    process.exit(1);
  }
  if (!process.env.VANITY_ENCRYPTION_KEY) {
    console.error('[seed-wager-auth] VANITY_ENCRYPTION_KEY is not set in .env.local');
    process.exit(1);
  }

  const keypairPath = resolveKeypairPath();
  console.log(`[seed-wager-auth] Loading keypair from ${keypairPath}`);

  const keypair = loadKeypairFromFile(keypairPath);
  const actualPubkey = keypair.publicKey.toBase58();
  const expectedPubkey = expectedPubkeyBase58();

  if (actualPubkey !== expectedPubkey) {
    console.error(
      `[seed-wager-auth] Pubkey mismatch.\n` +
        `  Loaded pubkey  : ${actualPubkey}\n` +
        `  Expected pubkey: ${expectedPubkey}\n` +
        `Set WAGER_SETTLEMENT_AUTHORITY_PUBKEY to override the default, or supply a different keypair file.`,
    );
    process.exit(1);
  }

  // Check for an existing row.
  const existing = await db.query.treasuryWallets.findFirst({
    where: eq(treasuryWallets.purpose, TREASURY_PURPOSE),
  });

  if (existing) {
    if (existing.publicKey !== actualPubkey) {
      console.error(
        `[seed-wager-auth] An existing wager-settlement-authority row has pubkey\n` +
          `  ${existing.publicKey}\n` +
          `which does NOT match the loaded keypair pubkey\n` +
          `  ${actualPubkey}.\n` +
          `Refusing to overwrite. Manually DELETE FROM treasury_wallets WHERE id = '${existing.id}' if you really want to rotate.`,
      );
      process.exit(1);
    }
    console.log(
      `[seed-wager-auth] ✓ Already seeded.\n` +
        `  treasury_wallets.id : ${existing.id}\n` +
        `  pubkey              : ${existing.publicKey}\n` +
        `  purpose             : ${existing.purpose}`,
    );
    return;
  }

  // Encrypt the secret immediately — the plaintext never persists past this scope.
  const encrypted = encryptSecretKey(keypair.secretKey);

  const [row] = await db
    .insert(treasuryWallets)
    .values({
      purpose: TREASURY_PURPOSE,
      publicKey: actualPubkey,
      encryptedSecretKey: encrypted.encryptedSecretKey,
      encryptionIv: encrypted.encryptionIv,
      encryptionTag: encrypted.encryptionTag,
      notes:
        `Settlement authority for clawville_wager on devnet. Loaded from ` +
        `${keypairPath}. Rotate by calling update_config on chain THEN re-running this seed.`,
    })
    .returning({
      id: treasuryWallets.id,
      publicKey: treasuryWallets.publicKey,
      purpose: treasuryWallets.purpose,
    });

  console.log(
    `[seed-wager-auth] ✓ Seeded wager-settlement-authority row.\n` +
      `  treasury_wallets.id : ${row.id}\n` +
      `  pubkey              : ${row.publicKey}\n` +
      `  purpose             : ${row.purpose}\n` +
      `Remember to set WAGER_SETTLEMENT_AUTHORITY_PUBKEY on the Hetzner API (matches ${actualPubkey}).`,
  );
}

main()
  .catch((err) => {
    console.error('[seed-wager-auth] FATAL:', err);
    process.exit(1);
  })
  .finally(() => {
    // The Drizzle/postgres client keeps the pool open; force-exit so the
    // script terminates cleanly under `bun run`.
    setTimeout(() => process.exit(0), 100).unref();
  });
