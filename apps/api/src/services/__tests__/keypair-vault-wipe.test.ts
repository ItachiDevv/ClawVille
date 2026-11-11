/**
 * keypair-vault plaintext wipe (UsePod fee wallet review, 2026-11-11).
 * The key is passed explicitly (no process env). A throwaway key and keypair only.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createCipheriv, randomBytes } from 'crypto';
import { Keypair } from '@solana/web3.js';
import { decryptKeypairWithKey } from '../keypair-vault';

function seal(key: Buffer, plaintext: Uint8Array) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ct: ct.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

/** Records the exact array handed to Keypair.fromSecretKey (the vault's own copy). */
function captureHandedArray(): Uint8Array[] {
  const handed: Uint8Array[] = [];
  const original = Keypair.fromSecretKey.bind(Keypair);
  const spy = spyOn(Keypair, 'fromSecretKey').mockImplementation((secretKey: Uint8Array, options?: { skipValidation?: boolean }) => {
    handed.push(secretKey);
    return original(secretKey, options);
  });
  spies.push(spy);
  return handed;
}

describe('decryptKeypairWithKey', () => {
  test('valid key: the Keypair holds the vault copy (not wiped); the round trip matches', () => {
    const key = randomBytes(32);
    const kp = Keypair.generate();
    const sealed = seal(key, kp.secretKey);
    const handed = captureHandedArray();
    const back = decryptKeypairWithKey(key, sealed.ct, sealed.iv, sealed.tag);
    expect(back.publicKey.equals(kp.publicKey)).toBe(true);
    expect(handed).toHaveLength(1);
    expect(handed[0]!.some((b) => b !== 0)).toBe(true);
  });

  test('invalid key material behind a valid tag: fromSecretKey throws and the vault copy is wiped', () => {
    const key = randomBytes(32);
    // 64 bytes whose public half does not match the private half.
    const bad = new Uint8Array(randomBytes(64));
    const sealed = seal(key, bad);
    const handed = captureHandedArray();
    expect(() => decryptKeypairWithKey(key, sealed.ct, sealed.iv, sealed.tag)).toThrow();
    expect(handed).toHaveLength(1);
    expect(handed[0]!.length).toBe(64);
    expect(handed[0]!.every((b) => b === 0)).toBe(true);
  });

  test('a tampered tag is refused before any Keypair is built', () => {
    const key = randomBytes(32);
    const sealed = seal(key, Keypair.generate().secretKey);
    const tag = Buffer.from(sealed.tag, 'base64');
    tag[0] ^= 1;
    const handed = captureHandedArray();
    expect(() => decryptKeypairWithKey(key, sealed.ct, sealed.iv, tag.toString('base64'))).toThrow();
    expect(handed).toHaveLength(0);
  });
});
