/**
 * CLV SWAP CUSTODY (Tokenomics GoLive executors, 2026-07-07) — the SHARED
 * treasury-keypair custody helper for the on-chain economy executors.
 *
 * ONE audited place that turns an encrypted `treasury_wallets` row into a
 * signing `Keypair`, with the wager-program-client defense-in-depth discipline
 * (load row → decryptSecretKey → verify the decrypted pubkey against BOTH the
 * row's own public_key column AND the independent expected value → refuse to
 * sign on any mismatch). Consumers:
 *
 *   - the CLV swap executor live path (`clv-swap-live.ts`) — sweeps merchant
 *     USDC and signs USDC→CLV swap clips;
 *   - the LATER payout + deed executors (they import `loadClvSwapKeypair` +
 *     `getClvMainnetConnection` — these two signatures are PINNED; do not
 *     change them without migrating those callers).
 *
 * PINNED EXPORT SIGNATURES (downstream executors depend on these EXACTLY):
 *   loadClvSwapKeypair(): Promise<Keypair>
 *   loadX402MerchantKeypair(): Promise<Keypair>
 *   getClvMainnetConnection(): Connection
 *
 * SECURITY CONTRACT (bank-grade — every caller depends on these):
 *   1. Key material is NEVER logged, echoed, serialized, or persisted by this
 *      module. Error messages carry PUBLIC keys only.
 *   2. Decrypt happens ONLY here (via the audited `keypair-vault`
 *      `decryptSecretKey`) and only on explicit caller demand — importing this
 *      module decrypts nothing.
 *   3. Pubkey match is mandatory before a keypair is ever returned:
 *        - clv-swap: decrypted pubkey MUST equal the row's `public_key` AND
 *          the read-path `getClvSwapWalletPubkey()` (the pubkey the dry-run
 *          planner/reporting surfaces — a rotation that drifted the two is a
 *          refuse-to-sign, not a silent wrong-wallet sign).
 *        - x402-merchant: decrypted pubkey MUST equal the row's `public_key`
 *          AND the env-pinned `CLAWVILLE_MERCHANT_WALLET_PUBKEY` (the exact
 *          wallet every checkout/topup 402 quote paid into). No pin ⇒ REFUSE
 *          (fail closed — we never guess which wallet holds customer USDC).
 *   4. CLV is a MAINNET Token-2022 mint. `getClvMainnetConnection()` always
 *      builds a MAINNET connection (Helius when `HELIUS_API_KEY` is set, the
 *      public mainnet-beta RPC as fallback) — it can never be pointed at
 *      devnet by env. The devnet wager RPC (`SOLANA_RPC_URL`) is deliberately
 *      NOT consulted here.
 *
 * Caching: decrypted keypairs are memoized per purpose (the
 * wager-program-client pattern) — the row is immutable until a manual
 * rotation, and a rotation REQUIRES a process restart to be picked up (same
 * operational contract as the wager settlement authority).
 *
 * This module does NO on-chain sends, NO DB writes, and never touches
 * `avatars.clawTokens` or the CT ledger.
 */

import { Connection, Keypair } from '@solana/web3.js';
import { db, desc, eq, treasuryWallets } from '@clawville/database';
import { decryptSecretKey } from './keypair-vault';
import { getClvSwapWalletPubkey } from './clv-swap-executor';
import { loadX402Config } from './x402-config';

// ─── module-scope memoization (rotation requires restart — see header) ──────

let clvSwapKeypairCache: Keypair | null = null;
let merchantKeypairCache: Keypair | null = null;
let mainnetConnectionCache: Connection | null = null;

/** Tagged error so executor callers can pattern-match without string-parsing. */
export class ClvSwapCustodyError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'wallet_missing'
      | 'pubkey_mismatch'
      | 'merchant_pubkey_unpinned',
  ) {
    super(message);
    this.name = 'ClvSwapCustodyError';
  }
}

/** Newest `treasury_wallets` row for a purpose (newest-wins mirrors
 *  `getClvSwapWalletPubkey()` so read path and custody path can never pick
 *  different rows of a rotated purpose). */
async function loadNewestTreasuryRow(purpose: 'clv-swap' | 'x402-merchant') {
  const [row] = await db
    .select({
      publicKey: treasuryWallets.publicKey,
      encryptedSecretKey: treasuryWallets.encryptedSecretKey,
      encryptionIv: treasuryWallets.encryptionIv,
      encryptionTag: treasuryWallets.encryptionTag,
    })
    .from(treasuryWallets)
    .where(eq(treasuryWallets.purpose, purpose))
    .orderBy(desc(treasuryWallets.createdAt))
    .limit(1);
  return row ?? null;
}

/** Decrypt a treasury row and enforce the pubkey-match discipline. NEVER logs
 *  or embeds key bytes — messages carry public keys only. */
function decryptAndVerify(
  purpose: string,
  row: {
    publicKey: string;
    encryptedSecretKey: string;
    encryptionIv: string;
    encryptionTag: string;
  },
  expectedPubkey: string,
): Keypair {
  const keypair = decryptSecretKey(row.encryptedSecretKey, row.encryptionIv, row.encryptionTag);
  const actual = keypair.publicKey.toBase58();
  // Defense-in-depth 1: the decrypted secret must reproduce the row's OWN
  // public_key column (catches a corrupted/mismatched row).
  if (actual !== row.publicKey) {
    throw new ClvSwapCustodyError(
      `[clv-swap-custody] '${purpose}' pubkey mismatch: decrypted ${actual} != row public_key ` +
        `${row.publicKey}. Refusing to sign — re-provision the wallet row.`,
      'pubkey_mismatch',
    );
  }
  // Defense-in-depth 2: it must ALSO match the independent expected value
  // (read-path lookup for clv-swap; env pin for the merchant wallet).
  if (actual !== expectedPubkey) {
    throw new ClvSwapCustodyError(
      `[clv-swap-custody] '${purpose}' pubkey mismatch: decrypted ${actual} != expected ` +
        `${expectedPubkey}. Refusing to sign — fix the rotation/pin before any send.`,
      'pubkey_mismatch',
    );
  }
  return keypair;
}

/**
 * The decrypted 'clv-swap' treasury keypair (the dedicated CLV buy-side swap
 * wallet provisioned by `scripts/generate-clv-swap-wallet.ts`).
 *
 * PINNED SIGNATURE — the later payout executor imports this exactly.
 *
 * Verifies the decrypted pubkey against BOTH the row's `public_key` and the
 * read-path `getClvSwapWalletPubkey()`; throws `ClvSwapCustodyError` on any
 * mismatch or when the wallet is not provisioned. Memoized (rotation requires
 * restart). Never logs key material.
 */
export async function loadClvSwapKeypair(): Promise<Keypair> {
  if (clvSwapKeypairCache) return clvSwapKeypairCache;

  const row = await loadNewestTreasuryRow('clv-swap');
  if (!row) {
    throw new ClvSwapCustodyError(
      `[clv-swap-custody] treasury_wallets row with purpose='clv-swap' not found. ` +
        `Run bun run scripts/generate-clv-swap-wallet.ts first.`,
      'wallet_missing',
    );
  }
  const readPathPubkey = await getClvSwapWalletPubkey();
  if (!readPathPubkey) {
    throw new ClvSwapCustodyError(
      `[clv-swap-custody] getClvSwapWalletPubkey() resolved no 'clv-swap' wallet — ` +
        `refusing to decrypt against an unresolvable read path.`,
      'wallet_missing',
    );
  }
  const keypair = decryptAndVerify('clv-swap', row, readPathPubkey);
  clvSwapKeypairCache = keypair;
  return keypair;
}

/**
 * The decrypted 'x402-merchant' treasury keypair — the wallet every x402
 * checkout / ct-topup 402 quote paid USDC into. Used ONLY by the funding
 * sweep (merchant → clv-swap wallet transfer of a SETTLED checkout's USDC).
 *
 * The independent expected value is the env pin `CLAWVILLE_MERCHANT_WALLET_
 * PUBKEY` (via `loadX402Config()`), i.e. the exact `payTo` the facilitator
 * settled against. No pin ⇒ REFUSE (fail closed): without it we cannot prove
 * the row we decrypted is the wallet that actually holds customer USDC.
 * Memoized (rotation requires restart). Never logs key material.
 */
export async function loadX402MerchantKeypair(): Promise<Keypair> {
  if (merchantKeypairCache) return merchantKeypairCache;

  const pinned = loadX402Config().merchantWalletPubkey?.trim();
  if (!pinned) {
    throw new ClvSwapCustodyError(
      `[clv-swap-custody] CLAWVILLE_MERCHANT_WALLET_PUBKEY is not set — refusing to load the ` +
        `x402-merchant keypair without the env pin (fail closed; the pin is the wallet every ` +
        `checkout paid into).`,
      'merchant_pubkey_unpinned',
    );
  }
  const row = await loadNewestTreasuryRow('x402-merchant');
  if (!row) {
    throw new ClvSwapCustodyError(
      `[clv-swap-custody] treasury_wallets row with purpose='x402-merchant' not found. ` +
        `Run bun run scripts/import-treasury-wallet.ts (or generate-treasury-keypair.ts) first.`,
      'wallet_missing',
    );
  }
  const keypair = decryptAndVerify('x402-merchant', row, pinned);
  merchantKeypairCache = keypair;
  return keypair;
}

/**
 * The MAINNET Solana connection for CLV-side reads/sends (CLV is a mainnet
 * Token-2022 mint — see `clv-price-oracle.ts` CLV_MINT). Helius mainnet when
 * `HELIUS_API_KEY` is set (the oracle's endpoint), else the public
 * mainnet-beta RPC as a rate-limited fallback. Deliberately does NOT read
 * `SOLANA_RPC_URL` (that is the DEVNET wager default) — this connection can
 * never be env-pointed at devnet.
 *
 * PINNED SIGNATURE — the later payout executor imports this exactly.
 */
export function getClvMainnetConnection(): Connection {
  if (!mainnetConnectionCache) {
    const key = process.env.HELIUS_API_KEY?.trim();
    const url = key
      ? `https://mainnet.helius-rpc.com/?api-key=${key}`
      : 'https://api.mainnet-beta.solana.com';
    mainnetConnectionCache = new Connection(url, 'confirmed');
  }
  return mainnetConnectionCache;
}

/** Test-only — drop the memoized keypairs/connection so a suite can exercise
 *  fresh loads. NEVER call from production code paths. */
export function _resetClvSwapCustodyCachesForTest(): void {
  clvSwapKeypairCache = null;
  merchantKeypairCache = null;
  mainnetConnectionCache = null;
}
