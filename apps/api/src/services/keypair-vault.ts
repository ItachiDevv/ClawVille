import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { Keypair } from '@solana/web3.js';
import { db, eq, and, vanityKeypairs } from '@clawville/database';
import type { vanitySuffixEnum, Wallet } from '@clawville/database';

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey(): Buffer {
  const key = process.env.VANITY_ENCRYPTION_KEY;
  if (!key) throw new Error('VANITY_ENCRYPTION_KEY env var is not set');
  // Expect a 64-char hex string (32 bytes)
  if (key.length !== 64) throw new Error('VANITY_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  return Buffer.from(key, 'hex');
}

/** Encrypt raw secret key bytes (64-byte Uint8Array) → base64 ciphertext + iv + tag */
export function encryptSecretKey(secretKey: Uint8Array): {
  encryptedSecretKey: string;
  encryptionIv: string;
  encryptionTag: string;
} {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    encryptedSecretKey: encrypted.toString('base64'),
    encryptionIv: iv.toString('base64'),
    encryptionTag: tag.toString('base64'),
  };
}

/** Decrypt base64 ciphertext → Solana Keypair */
export function decryptSecretKey(
  encryptedSecretKey: string,
  encryptionIv: string,
  encryptionTag: string,
): Keypair {
  const key = getEncryptionKey();
  const iv = Buffer.from(encryptionIv, 'base64');
  const tag = Buffer.from(encryptionTag, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedSecretKey, 'base64')),
    decipher.final(),
  ]);

  return Keypair.fromSecretKey(new Uint8Array(decrypted));
}

/**
 * Encrypt an arbitrary UTF-8 secret string (e.g. a partner-issued scoped
 * bearer token) under VANITY_ENCRYPTION_KEY with AES-256-GCM. Mirrors the
 * `encryptSecretKey` envelope shape used for identity/treasury secrets —
 * three base64 fields (ciphertext + iv + auth tag) the caller persists on
 * its row. Used for the Hatcher proxy token (openclaw_bots.proxy_token_*).
 *
 * NEVER store the plaintext token; NEVER log the return of decryptToken().
 */
export function encryptToken(plaintext: string): {
  enc: string;
  iv: string;
  tag: string;
} {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    enc: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/** Decrypt a token encrypted by `encryptToken` back to its UTF-8 string. */
export function decryptToken(enc: string, iv: string, tag: string): string {
  const key = getEncryptionKey();
  const ivBuf = Buffer.from(iv, 'base64');
  const tagBuf = Buffer.from(tag, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, ivBuf);
  decipher.setAuthTag(tagBuf);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(enc, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

type VanitySuffix = (typeof vanitySuffixEnum.enumValues)[number];

/** Import a vanity keypair from raw JSON bytes or base58 private key */
export async function importVanityKeypair(
  secretKeyBytes: Uint8Array,
  suffix: VanitySuffix,
): Promise<{ publicKey: string; id: string }> {
  const keypair = Keypair.fromSecretKey(secretKeyBytes);
  const publicKey = keypair.publicKey.toBase58();

  // Verify the suffix
  if (!publicKey.endsWith(suffix)) {
    throw new Error(`Public key ${publicKey} does not end with ${suffix}`);
  }

  const encrypted = encryptSecretKey(secretKeyBytes);

  const [row] = await db
    .insert(vanityKeypairs)
    .values({
      suffix,
      publicKey,
      ...encrypted,
      status: 'available',
    })
    .returning({ id: vanityKeypairs.id, publicKey: vanityKeypairs.publicKey });

  return row;
}

/** Reserve an available vanity keypair for a user */
export async function reserveVanityKeypair(
  userId: string,
  suffix: VanitySuffix,
): Promise<{ id: string; publicKey: string } | null> {
  // Find first available keypair with this suffix
  const available = await db.query.vanityKeypairs.findFirst({
    where: and(
      eq(vanityKeypairs.suffix, suffix),
      eq(vanityKeypairs.status, 'available'),
    ),
    columns: { id: true, publicKey: true },
  });

  if (!available) return null;

  // Reserve it
  await db
    .update(vanityKeypairs)
    .set({
      status: 'reserved',
      reservedBy: userId,
      reservedAt: new Date(),
    })
    .where(
      and(
        eq(vanityKeypairs.id, available.id),
        eq(vanityKeypairs.status, 'available'), // CAS guard
      ),
    );

  return available;
}

/** Load the decrypted Keypair for a reserved/used vanity keypair */
export async function loadVanityKeypair(keypairId: string): Promise<Keypair> {
  const row = await db.query.vanityKeypairs.findFirst({
    where: eq(vanityKeypairs.id, keypairId),
  });

  if (!row) throw new Error(`Vanity keypair ${keypairId} not found`);

  return decryptSecretKey(
    row.encryptedSecretKey,
    row.encryptionIv,
    row.encryptionTag,
  );
}

/** Mark a vanity keypair as used after successful token creation */
export async function markKeypairUsed(
  keypairId: string,
  tokenMint: string,
): Promise<void> {
  await db
    .update(vanityKeypairs)
    .set({
      status: 'used',
      usedAt: new Date(),
      tokenMint,
    })
    .where(eq(vanityKeypairs.id, keypairId));
}

/** Release a reserved keypair back to available (e.g. on launch failure) */
export async function releaseKeypair(keypairId: string): Promise<void> {
  await db
    .update(vanityKeypairs)
    .set({
      status: 'available',
      reservedBy: null,
      reservedAt: null,
    })
    .where(eq(vanityKeypairs.id, keypairId));
}

// ---------------------------------------------------------------------------
// Phase 5.1 — envelope encryption via Cloudflare Secrets Store Worker
// ---------------------------------------------------------------------------
// Version 2 of the encryption pipeline. Each secret is encrypted under a
// fresh 32-byte per-row DEK (AES-256-GCM). The DEK itself is wrapped
// (AES-KW, RFC 3394) by a master KEK that lives exclusively inside
// Cloudflare Secrets Store, accessed via a tiny Worker exposing
// POST /wrap and POST /unwrap.
//
// See:
//   - Plan §4.3 (envelope storage summary)
//   - Plan §5.1 (first-connect keypair generation)
//   - infra/cf-secrets-worker/ (Worker source + deploy instructions)
//
// Threat-model note: a VPS-only dump yields ciphertexts + wrapped DEKs
// but NOT the KEK — attacker would need a second compromise (Cloudflare)
// to unwrap anything.
// ---------------------------------------------------------------------------

const WORKER_MISSING_MSG =
  'Envelope encryption requires CLOUDFLARE_WORKER_URL and CLOUDFLARE_WORKER_BEARER. '
  + 'Deploy the Worker first (see infra/cf-secrets-worker/README.md) and set both '
  + 'env vars on the Hetzner API. Until this is done, only version-1 (legacy) '
  + 'encryption works; any new-row write path will reject.';

function requireWorkerEnv(): { url: string; bearer: string } {
  const url = process.env.CLOUDFLARE_WORKER_URL?.trim();
  const bearer = process.env.CLOUDFLARE_WORKER_BEARER?.trim();
  if (!url || !bearer) throw new Error(WORKER_MISSING_MSG);
  // Strip trailing slash so `${url}/wrap` doesn't become `.../ /wrap`
  return { url: url.replace(/\/+$/, ''), bearer };
}

async function callWorker(
  pathname: '/wrap' | '/unwrap',
  body: Record<string, string>,
): Promise<Record<string, string>> {
  const { url, bearer } = requireWorkerEnv();
  const res = await fetch(`${url}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<unreadable body>');
    throw new Error(`CF secrets Worker ${pathname} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as Record<string, string>;
}

/**
 * Envelope-encrypt a 64-byte Solana secret key. Generates a fresh DEK,
 * encrypts the secret with it, wraps the DEK via the Cloudflare Worker,
 * returns the 5 values the caller persists on its row.
 */
export async function encryptSecretKeyEnveloped(secretKey: Uint8Array): Promise<{
  encryptedSecretKey: string;
  encryptionIv: string;
  encryptionTag: string;
  dekWrapped: string;
  encryptionVersion: 2;
}> {
  // 1. Fresh per-row DEK.
  const dek = randomBytes(32);

  // 2. AES-GCM encrypt the secret under the DEK.
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, dek, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
  const tag = cipher.getAuthTag();

  // 3. Wrap the DEK via the Cloudflare Worker.
  const { wrappedDek } = await callWorker('/wrap', {
    plaintextDek: dek.toString('base64'),
  });
  if (!wrappedDek) throw new Error('CF secrets Worker /wrap returned no wrappedDek');

  return {
    encryptedSecretKey: encrypted.toString('base64'),
    encryptionIv: iv.toString('base64'),
    encryptionTag: tag.toString('base64'),
    dekWrapped: wrappedDek,
    encryptionVersion: 2,
  };
}

/**
 * Decrypt an envelope-encrypted Solana secret key. Unwraps the DEK via
 * the Cloudflare Worker, then AES-GCM decrypts the secret under the DEK.
 */
export async function decryptSecretKeyEnveloped(row: {
  encryptedSecretKey: string;
  encryptionIv: string;
  encryptionTag: string;
  dekWrapped: string;
}): Promise<Keypair> {
  const { plaintextDek } = await callWorker('/unwrap', {
    wrappedDek: row.dekWrapped,
  });
  if (!plaintextDek) throw new Error('CF secrets Worker /unwrap returned no plaintextDek');

  const dek = Buffer.from(plaintextDek, 'base64');
  if (dek.length !== 32) {
    throw new Error(`Unwrapped DEK has wrong length: got ${dek.length}, expected 32`);
  }
  const iv = Buffer.from(row.encryptionIv, 'base64');
  const tag = Buffer.from(row.encryptionTag, 'base64');
  const decipher = createDecipheriv(ALGORITHM, dek, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(row.encryptedSecretKey, 'base64')),
    decipher.final(),
  ]);

  return Keypair.fromSecretKey(new Uint8Array(decrypted));
}

/**
 * Version-dispatching decrypt for a `wallets` row. Callers don't care
 * whether the row was encrypted under the legacy VANITY_ENCRYPTION_KEY
 * or via Cloudflare envelope — just pass the row and get back a Keypair.
 *
 * Throws if:
 *   - encryptionVersion is 2 but dekWrapped is NULL (data corruption).
 *   - encryptionVersion is an unknown value.
 */
export async function decryptWalletRow(row: Wallet): Promise<Keypair> {
  if (row.encryptionVersion === 2) {
    if (!row.dekWrapped) {
      throw new Error(
        `[wallet] row ${row.id} has encryption_version=2 but dek_wrapped IS NULL`,
      );
    }
    return decryptSecretKeyEnveloped({
      encryptedSecretKey: row.encryptedSecretKey,
      encryptionIv: row.encryptionIv,
      encryptionTag: row.encryptionTag,
      dekWrapped: row.dekWrapped,
    });
  }
  if (row.encryptionVersion === 1 || row.encryptionVersion == null) {
    return decryptSecretKey(row.encryptedSecretKey, row.encryptionIv, row.encryptionTag);
  }
  throw new Error(
    `[wallet] row ${row.id} has unsupported encryption_version=${row.encryptionVersion}`,
  );
}

/** Get pool stats for monitoring */
export async function getPoolStats(): Promise<{
  claw: { available: number; reserved: number; used: number };
  hrms: { available: number; reserved: number; used: number };
}> {
  const all = await db.query.vanityKeypairs.findMany({
    columns: { suffix: true, status: true },
  });

  const count = (s: VanitySuffix, st: string) =>
    all.filter((r) => r.suffix === s && r.status === st).length;

  return {
    claw: { available: count('CLAW', 'available'), reserved: count('CLAW', 'reserved'), used: count('CLAW', 'used') },
    hrms: { available: count('HRMS', 'available'), reserved: count('HRMS', 'reserved'), used: count('HRMS', 'used') },
  };
}
