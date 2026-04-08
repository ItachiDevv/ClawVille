import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { Keypair } from '@solana/web3.js';
import { db, eq, and, vanityKeypairs } from '@legacyapp/database';
import type { vanitySuffixEnum } from '@legacyapp/database';

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
