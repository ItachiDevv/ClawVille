/**
 * CLV SWAP CUSTODY — unit tests (Tokenomics GoLive executors, 2026-07-07).
 *
 * Proves the custody discipline WITHOUT a real Postgres or chain:
 *   1. loadClvSwapKeypair: happy path decrypts the REAL AES-256-GCM envelope
 *      (keypair-vault, env key) and returns the keypair; memoized (one DB read
 *      set); missing row / read-path drift / row-column mismatch all THROW
 *      with pubkey-only messages (NEVER key bytes).
 *   2. loadX402MerchantKeypair: refuses without the env pin (fail closed);
 *      pin mismatch refuses; pinned happy path returns the keypair.
 *   3. getClvMainnetConnection: always mainnet (public fallback URL when no
 *      HELIUS_API_KEY), memoized.
 *
 * DB stub follows the clv-swap-executor.test.ts leak-guard convention: spread
 * real exports, stub only `db`; the executor module (getClvSwapWalletPubkey)
 * is mocked spread-real so its 5-min module cache can't couple test cases.
 */

// Crash-loud module-load env (scoped like clv-swap-executor.test.ts).
const HEX32 = '0'.repeat(64);
function ensureEnv(k: string, v: string) {
  if (!process.env[k]) process.env[k] = v;
}
const DB_URL_WAS_SET = !!process.env.DATABASE_URL;
ensureEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/db');
ensureEnv('VANITY_ENCRYPTION_KEY', HEX32);

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import * as realDatabase from '@clawville/database';
import * as realExecutor from '../clv-swap-executor';
import { encryptSecretKey } from '../keypair-vault';

const REAL_EXECUTOR_EXPORTS = { ...realExecutor };

// ── @clawville/database stub — select-chain over treasury_wallets ───────────
type TreasuryFixture = {
  publicKey: string;
  encryptedSecretKey: string;
  encryptionIv: string;
  encryptionTag: string;
};
let treasuryRows: TreasuryFixture[] = [];
let selectCalls = 0;

const selectChain = {
  from: () => selectChain,
  where: () => selectChain,
  orderBy: () => selectChain,
  limit: async () => treasuryRows,
};
const fakeDb = {
  ...(realDatabase as unknown as { db: Record<string, unknown> }).db,
  select: (_sel: unknown) => {
    selectCalls += 1;
    return selectChain;
  },
};
mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: fakeDb,
}));

// ── executor stub — controllable read-path pubkey (bypasses its 5-min cache) ─
let readPathPubkey: string | null = null;
mock.module('../clv-swap-executor', () => ({
  ...REAL_EXECUTOR_EXPORTS,
  getClvSwapWalletPubkey: async () => readPathPubkey,
}));

delete process.env.CLV_SWAP_EXECUTE; // module-load gate on the import graph
const {
  loadClvSwapKeypair,
  loadX402MerchantKeypair,
  getClvMainnetConnection,
  ClvSwapCustodyError,
  _resetClvSwapCustodyCachesForTest,
} = await import('../clv-swap-custody');

if (!DB_URL_WAS_SET) {
  delete process.env.DATABASE_URL;
}

/** Build a treasury fixture row whose envelope REALLY decrypts to `kp` (the
 *  actual AES-256-GCM path under the test env key), with an overridable
 *  public_key column for mismatch cases. */
function fixtureFor(kp: Keypair, publicKeyOverride?: string): TreasuryFixture {
  const enc = encryptSecretKey(kp.secretKey);
  return {
    publicKey: publicKeyOverride ?? kp.publicKey.toBase58(),
    encryptedSecretKey: enc.encryptedSecretKey,
    encryptionIv: enc.encryptionIv,
    encryptionTag: enc.encryptionTag,
  };
}

const swapKp = Keypair.generate();
const merchantKp = Keypair.generate();
const strangerKp = Keypair.generate();

beforeEach(() => {
  _resetClvSwapCustodyCachesForTest();
  treasuryRows = [];
  selectCalls = 0;
  readPathPubkey = null;
  delete process.env.HELIUS_API_KEY;
  delete process.env.CLAWVILLE_MERCHANT_WALLET_PUBKEY;
  delete process.env.X402_ENABLED;
});

// ─────────────────────────────────────────────────────────────────────────────
describe('loadClvSwapKeypair', () => {
  it('happy path: decrypts the real envelope, pubkey-checks, memoizes', async () => {
    treasuryRows = [fixtureFor(swapKp)];
    readPathPubkey = swapKp.publicKey.toBase58();

    const kp = await loadClvSwapKeypair();
    expect(kp.publicKey.toBase58()).toBe(swapKp.publicKey.toBase58());
    const callsAfterFirst = selectCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Memoized: a second load does zero additional DB reads.
    const again = await loadClvSwapKeypair();
    expect(again.publicKey.toBase58()).toBe(swapKp.publicKey.toBase58());
    expect(selectCalls).toBe(callsAfterFirst);
  });

  it('missing row: throws wallet_missing (never a silent null)', async () => {
    treasuryRows = [];
    await expect(loadClvSwapKeypair()).rejects.toThrow(/purpose='clv-swap' not found/);
  });

  it('unresolvable read path: throws wallet_missing', async () => {
    treasuryRows = [fixtureFor(swapKp)];
    readPathPubkey = null;
    await expect(loadClvSwapKeypair()).rejects.toThrow(/unresolvable read path/);
  });

  it('row-column mismatch: throws pubkey_mismatch; message NEVER carries key bytes', async () => {
    // The envelope decrypts to swapKp but the row CLAIMS a different pubkey.
    treasuryRows = [fixtureFor(swapKp, strangerKp.publicKey.toBase58())];
    readPathPubkey = strangerKp.publicKey.toBase58();
    let thrown: Error | null = null;
    try {
      await loadClvSwapKeypair();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toMatch(/pubkey mismatch/);
    expect((thrown as InstanceType<typeof ClvSwapCustodyError>).code).toBe('pubkey_mismatch');
    // NEVER key bytes: neither the base58 secret nor any 20+ char slice of it.
    const secretB58 = bs58.encode(swapKp.secretKey);
    expect(thrown!.message.includes(secretB58)).toBe(false);
    expect(thrown!.message.includes(secretB58.slice(0, 20))).toBe(false);
  });

  it('read-path drift: row is self-consistent but the read path disagrees → refuse', async () => {
    treasuryRows = [fixtureFor(swapKp)];
    readPathPubkey = strangerKp.publicKey.toBase58(); // rotation drift
    await expect(loadClvSwapKeypair()).rejects.toThrow(/!= expected/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('loadX402MerchantKeypair', () => {
  it('REFUSES without the env pin — fail closed, zero DB reads', async () => {
    treasuryRows = [fixtureFor(merchantKp)];
    await expect(loadX402MerchantKeypair()).rejects.toThrow(
      /CLAWVILLE_MERCHANT_WALLET_PUBKEY is not set/,
    );
    expect(selectCalls).toBe(0);
  });

  it('happy path: pinned pubkey matches the decrypted row', async () => {
    process.env.CLAWVILLE_MERCHANT_WALLET_PUBKEY = merchantKp.publicKey.toBase58();
    treasuryRows = [fixtureFor(merchantKp)];
    const kp = await loadX402MerchantKeypair();
    expect(kp.publicKey.toBase58()).toBe(merchantKp.publicKey.toBase58());
  });

  it('pin mismatch: refuses to sign', async () => {
    process.env.CLAWVILLE_MERCHANT_WALLET_PUBKEY = strangerKp.publicKey.toBase58();
    treasuryRows = [fixtureFor(merchantKp)];
    await expect(loadX402MerchantKeypair()).rejects.toThrow(/pubkey mismatch/);
  });

  it('missing row: throws wallet_missing', async () => {
    process.env.CLAWVILLE_MERCHANT_WALLET_PUBKEY = merchantKp.publicKey.toBase58();
    treasuryRows = [];
    await expect(loadX402MerchantKeypair()).rejects.toThrow(/purpose='x402-merchant' not found/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getClvMainnetConnection', () => {
  it('is ALWAYS mainnet (public fallback without HELIUS_API_KEY) and memoized', () => {
    const conn = getClvMainnetConnection();
    expect(conn.rpcEndpoint).toBe('https://api.mainnet-beta.solana.com');
    expect(getClvMainnetConnection()).toBe(conn); // memoized instance
  });

  it('uses the Helius MAINNET endpoint when HELIUS_API_KEY is set', () => {
    _resetClvSwapCustodyCachesForTest();
    process.env.HELIUS_API_KEY = 'test-key';
    const conn = getClvMainnetConnection();
    expect(conn.rpcEndpoint).toContain('mainnet.helius-rpc.com');
    expect(conn.rpcEndpoint).not.toContain('devnet');
    delete process.env.HELIUS_API_KEY;
  });
});
