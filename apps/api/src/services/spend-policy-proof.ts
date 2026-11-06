/**
 * Wallet proof for a spend-rules raise (MCP hub step 2, phase 1b, founder go
 * 2026-11-04).
 *
 * A magic link passes through the agent, so a human Lucia session alone does
 * not prove a human. To RAISE a cap or add a vendor, the human's linked
 * self-custody wallet signs a readable message that names the account, the
 * exact new values and a single-use nonce. The agent does not hold that key.
 *
 * The nonce is bound to the user AND to the exact values, so a signature for
 * one set of values can never save another. Storage is an in-memory Map, like
 * `wallet-link-challenge.ts` (single API node). TTL 120 s.
 */

import { createHash, randomBytes } from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { SpendPolicyValues } from '@clawville/shared';

const NONCE_TTL_MS = 120 * 1000;
const MAX_NONCES = 10_000;
const CLEANUP_INTERVAL_MS = 30 * 1000;

interface SpendProofNonce {
  userId: string;
  message: string;
  expiresAt: number;
}

const nonces = new Map<string, SpendProofNonce>();

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [nonce, entry] of nonces) {
    if (now > entry.expiresAt) nonces.delete(nonce);
  }
  if (nonces.size > MAX_NONCES) {
    const sorted = [...nonces.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [nonce] of sorted.slice(0, nonces.size - MAX_NONCES)) nonces.delete(nonce);
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

function usd(cents: number | null): string {
  return cents === null ? 'not set' : `$${(cents / 100).toFixed(2)}`;
}

/** The EXACT UTF-8 text the linked wallet signs. */
export function buildSpendRulesMessage(userId: string, values: SpendPolicyValues, nonce: string): string {
  const vendors = [...values.allowedVendors].sort();
  return [
    'ClawVille spend rules',
    `account: ${userId}`,
    `daily cap: ${usd(values.dailyCapUsdCents)}`,
    `per-call cap: ${usd(values.perCallCapUsdCents)}`,
    `paid tools: ${vendors.length ? vendors.join(', ') : 'none'}`,
    `Studios images per day with my own key: ${values.studiosKeyImagesPerDay}`,
    `ask me before each payment: ${values.requireApproval ? 'yes' : 'no'}`,
    `nonce: ${nonce}`,
  ].join('\n');
}

export interface SpendProofChallenge {
  nonce: string;
  expiresAt: string;
  messageToSign: string;
}

export function issueSpendProofChallenge(userId: string, values: SpendPolicyValues): SpendProofChallenge {
  const nonce = bs58.encode(randomBytes(32));
  const message = buildSpendRulesMessage(userId, values, nonce);
  const expiresAtMs = Date.now() + NONCE_TTL_MS;
  nonces.set(nonce, { userId, message, expiresAt: expiresAtMs });
  return { nonce, expiresAt: new Date(expiresAtMs).toISOString(), messageToSign: message };
}

export type SpendProofResult = 'ok' | 'invalid_challenge' | 'invalid_signature';

/**
 * Consume the nonce (single use, also on failure) and verify that
 * `walletPubkey` signed the message for THIS user and THESE values.
 */
export function verifySpendProof(input: {
  userId: string;
  values: SpendPolicyValues;
  nonce: string;
  signature: string;
  walletPubkey: string;
}): SpendProofResult {
  return verifyMessage(input.userId, input.nonce, input.signature, input.walletPubkey,
    buildSpendRulesMessage(input.userId, input.values, input.nonce));
}

/**
 * Saving or removing a vendor API key (MCP hub step 2 phase 2b) uses the same
 * proof: the key decides whose account pays, and a magic-link session alone
 * does not prove a human. The message names the account, the vendor, the
 * action, the last 4 characters of the key and the SHA-256 of the whole key
 * (so a signature for one key never saves another); never the key itself.
 */
export type VendorKeyAction = 'save' | 'remove';
export interface VendorKeyRef {
  last4: string;
  /** Lowercase hex SHA-256 of the whole key. */
  sha256: string;
}

/** The reference a save proof names; the browser computes the same value. */
export function vendorKeyRef(key: string): VendorKeyRef {
  return { last4: key.slice(-4), sha256: createHash('sha256').update(key, 'utf8').digest('hex') };
}

export function buildVendorKeyMessage(userId: string, vendor: string, action: VendorKeyAction, key: VendorKeyRef | null, nonce: string): string {
  return [
    'ClawVille paid tool key',
    `account: ${userId}`,
    `tool: ${vendor}`,
    action === 'save'
      ? `action: use my own ${vendor} key ending ${key?.last4 ?? ''}\nkey sha256: ${key?.sha256 ?? ''}`
      : `action: remove my ${vendor} key`,
    `nonce: ${nonce}`,
  ].join('\n');
}

export function issueVendorKeyChallenge(userId: string, vendor: string, action: VendorKeyAction, key: VendorKeyRef | null): SpendProofChallenge {
  const nonce = bs58.encode(randomBytes(32));
  const message = buildVendorKeyMessage(userId, vendor, action, key, nonce);
  const expiresAtMs = Date.now() + NONCE_TTL_MS;
  nonces.set(nonce, { userId, message, expiresAt: expiresAtMs });
  return { nonce, expiresAt: new Date(expiresAtMs).toISOString(), messageToSign: message };
}

/** Consume the nonce and verify the linked wallet signed THIS key action. */
export function verifyVendorKeyProof(input: {
  userId: string;
  vendor: string;
  action: VendorKeyAction;
  key: VendorKeyRef | null;
  nonce: string;
  signature: string;
  walletPubkey: string;
}): SpendProofResult {
  return verifyMessage(input.userId, input.nonce, input.signature, input.walletPubkey,
    buildVendorKeyMessage(input.userId, input.vendor, input.action, input.key, input.nonce));
}

function verifyMessage(userId: string, nonce: string, signature: string, walletPubkey: string, expected: string): SpendProofResult {
  const entry = nonces.get(nonce);
  if (!entry) return 'invalid_challenge';
  nonces.delete(nonce);
  if (entry.userId !== userId || Date.now() > entry.expiresAt) return 'invalid_challenge';
  if (expected !== entry.message) return 'invalid_challenge';
  let sig: Uint8Array;
  let pub: Uint8Array;
  try {
    sig = bs58.decode(signature);
    pub = bs58.decode(walletPubkey);
  } catch {
    return 'invalid_signature';
  }
  if (sig.length !== 64 || pub.length !== 32) return 'invalid_signature';
  return nacl.sign.detached.verify(new TextEncoder().encode(expected), sig, pub) ? 'ok' : 'invalid_signature';
}

/** Test-only helper: wipe the map. */
export function _resetSpendProofNoncesForTest(): void {
  nonces.clear();
}
